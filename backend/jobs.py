"""Background cube jobs for `/api/cube` at an arbitrary sky position.

One job = TAP search -> cutout downloads -> cube build. It takes ~1 minute on Render, so the
endpoint answers at once with {status, progress} and the frontend polls the same URL until the
finished cube comes back (docs/ARCHITECTURE.md "Интерфейс").

The build step itself belongs to role A (data/cube.py). The backend calls
    data.cube.build_cube_from_files(files, center_ra, center_dec, band, out_dir) -> dict
which must write out_dir/cube.json + out_dir/cube.f32 in the ARCHITECTURE cube format and return
the cube.json content. Until that function exists, jobs end with status "unavailable" -- the
backend never invents cube data (CLAUDE.md rule 5).
"""
from __future__ import annotations

import importlib.util
import inspect
import json
import logging
import os
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable

import numpy as np

from backend import irsa

log = logging.getLogger("osu.jobs")

CUTOUT_SIZE_DEG = 0.05   # same as the prefetched cache: 29x29 SPHEREx px of 6.16" covers the 61x61 @ 3" grid
# Field of view, arcmin (docs/ARCHITECTURE.md "Интерфейсийн нэмэлт", O4): grid fov*20+1 px of 3".
FOVS = (3, 6, 10)
DEFAULT_FOV = 3
# Cutout side per fov, used only until data.cube.cutout_size_deg exists (A-10). Values from tasks/A.md A-10.
FOV_CUTOUT_FALLBACK = {3: 0.05, 6: 0.11, 10: 0.18}
MAX_FRAMES_BY_FOV = {10: 60}  # a 10' cube is 201x201 per frame: cap it (tasks/C.md C-08)
MAX_FRAMES = 120         # deep fields have ~600 images per detector; an even subsample keeps a job ~1 min
MAX_JOBS = 2             # cube builds in parallel; IRSA requests stay capped at 8 by IrsaClient
ERROR_TTL_S = 60         # a failed job is reported for this long, then the next request retries
COORD_DECIMALS = 4       # 1e-4 deg = 0.36": positions closer than that share one cube

# progress fractions at the end of each stage
P_SEARCH, P_PREVIEW, P_DOWNLOAD = 0.05, 0.20, 0.90
# Preview (task C-09, only when a caller asks with preview=1): a few images from EVERY visit, so the
# first and the last visit -- the pair that shows motion -- are both in the first look. The first N
# images in time order would all come from visit 1 and show nothing moving.
PREVIEW_PER_VISIT = 2
PREVIEW_MAX = 8
# Cutouts IRSA did not deliver are asked for once more after a short wait (task C-12, issue #99):
# the 8 of 60 missing in issue #65 all came on a second request a few minutes later (A-15).
REFETCH_WAIT_S = 5.0
# A cube that still misses images is served as it is, but a request this long after it was built
# starts a background job that fetches the missing images (the others come from the disk cache).
REFILL_AFTER_S = 180.0
# One retry (after ~1 s) per preview cutout, not the default three with 1+2+4 s backoff: the preview
# waits for all of its images, so one cutout that IRSA keeps refusing would hold it back (Render,
# 11/14 16:19: 34 s with 1 of 8 failing). No retry at all was too few: IRSA often answers a first
# request with 503 and the next one works (11/10), and with 0 retries the preview kept only 2-4 of
# 8 images (Render 16:36-16:38: D3 2 images in 32 s, D4 4 in 19 s). A cutout that still fails is
# left out of the preview; the full pass asks for it again with all retries.
PREVIEW_RETRIES = 1
EPOCH_GAP_DAYS = 20  # same visit rule as data/cube.py and backend/coverage.py

Builder = Callable[[list, float, float, str, Path], dict]


def default_builder() -> Builder | None:
    """Role A's cube builder, or None while data/cube.py does not provide it yet."""
    try:
        from data import cube  # noqa: PLC0415  (optional dependency, imported lazily)
    except ImportError:
        return None
    return getattr(cube, "build_cube_from_files", None)


def check_fov(fov) -> int:
    try:
        f = int(fov)
    except (TypeError, ValueError):
        f = None
    if f not in FOVS or str(fov).strip() not in {str(x) for x in FOVS}:
        raise ValueError(f"fov must be one of {', '.join(map(str, FOVS))} (arcmin), got {fov!r}")
    return f


def job_key(ra: float, dec: float, band: str, fov: int = DEFAULT_FOV) -> tuple[str, float, float, str]:
    """Cache key of a cube/measure job. The field of view is part of it: a 6' cube is a different
    file from a 3' one, built from bigger cutouts. fov=3 keeps the key it always had, so cubes built
    before fov existed are still found."""
    ra, dec = irsa.check_coords(ra, dec)
    band = irsa.normalize_band(band)
    fov = check_fov(fov)
    ra, dec = round(ra, COORD_DECIMALS), round(dec, COORD_DECIMALS)
    short = band.split("-")[1]
    key = f"{short}_{ra:.{COORD_DECIMALS}f}_{dec:+.{COORD_DECIMALS}f}"
    return (key if fov == DEFAULT_FOV else f"{key}_f{fov}"), ra, dec, band


def cutout_size_deg(fov: int) -> float:
    """Cutout side that covers the grid of `fov`: role A's rule (data.cube.cutout_size_deg, A-10) when
    it exists, else the same numbers from the task. Imported lazily (astropy) -- called in job threads only."""
    try:
        from data import cube  # noqa: PLC0415
        fn = getattr(cube, "cutout_size_deg", None)
    except ImportError:
        fn = None
    return float(fn(fov)) if fn is not None else FOV_CUTOUT_FALLBACK[fov]


def accepts_fov(fn) -> bool:
    try:
        params = inspect.signature(fn).parameters
    except (TypeError, ValueError):
        return False
    return "fov_arcmin" in params or any(p.kind is p.VAR_KEYWORD for p in params.values())


def subsample(rows: list[dict], limit: int) -> list[dict]:
    """Even subsample of a time-ordered list (same rule as experiments/prefetch_cache.py)."""
    if len(rows) <= limit:
        return rows
    idx = np.unique(np.round(np.linspace(0, len(rows) - 1, limit)).astype(int))
    return [rows[i] for i in idx]


def preview_subset(rows: list[dict], per_visit: int = PREVIEW_PER_VISIT, limit: int = PREVIEW_MAX) -> list[dict]:
    """`per_visit` images spread over each visit (first and last of it), at most `limit` in all,
    evenly thinned over time if there are more visits -- the first and the last visit always stay."""
    visits: list[list[dict]] = []
    for r in sorted(rows, key=lambda r: r["mjd"]):
        if visits and r["mjd"] - visits[-1][-1]["mjd"] <= EPOCH_GAP_DAYS:
            visits[-1].append(r)
        else:
            visits.append([r])
    picked = []
    for v in visits:
        idx = np.unique(np.round(np.linspace(0, len(v) - 1, min(per_visit, len(v)))).astype(int))
        picked += [v[i] for i in idx]
    return subsample(picked, limit)


@dataclass
class Job:
    key: str
    ra: float
    dec: float
    band: str
    status: str = "queued"   # queued | searching | downloading | building/measuring | done | empty | unavailable | error
    progress: float = 0.0
    message: str = ""
    n_images: int = 0        # images IRSA has at this position (this detector)
    n_frames: int = 0        # images used (after subsampling)
    n_failed: int = 0        # cutouts that could not be downloaded
    finished_at: float | None = None
    started_at: float = field(default_factory=time.time)
    fov: int = DEFAULT_FOV
    want_preview: bool = False
    preview_ready: bool = False
    # seconds since started_at at each stage, so a slow first look can be explained (C-10 follow-up)
    timings: dict = field(default_factory=dict)
    listing: dict | None = None   # set when the image list came from role A's saved list (C-13)
    reason: str | None = None     # machine-readable cause of an error, e.g. "search_down"
    lock: threading.Lock = field(default_factory=threading.Lock, repr=False)

    def update(self, **kw):
        with self.lock:
            for k, v in kw.items():
                setattr(self, k, v)

    def mark(self, stage: str):
        with self.lock:
            self.timings.setdefault(stage, round(time.time() - self.started_at, 1))

    def public(self) -> dict:
        with self.lock:
            return dict(status=self.status, progress=round(self.progress, 3), message=self.message,
                        center=dict(ra=self.ra, dec=self.dec), band=self.band, n_images=self.n_images,
                        n_frames=self.n_frames, n_failed=self.n_failed, fov_arcmin=self.fov,
                        job_started_utc=_utc(self.started_at), timings=dict(self.timings),
                        **(self.listing or {}), **({"reason": self.reason} if self.reason else {}))


class CubeJobs:
    """Background jobs that download the cutouts around a position and turn them into a cube.
    MeasureJobs below reuses everything but the last stage."""

    kind = "cube"
    module = "data.cube"          # what pipeline_present() looks for
    result_file = "cube.json"

    def __init__(self, client: irsa.IrsaClient, work_dir: Path, builder: Builder | None | str = "auto",
                 max_frames: int = MAX_FRAMES, max_jobs: int = MAX_JOBS):
        self.client = client
        self.work_dir = Path(work_dir)
        self._builder = builder
        self.max_frames = max_frames
        self._pool = ThreadPoolExecutor(max_workers=max_jobs, thread_name_prefix=self.kind)
        self._jobs: dict[str, Job] = {}
        self._guard = threading.Lock()

    def builder(self) -> Builder | None:
        return self.default_builder() if self._builder == "auto" else self._builder

    def default_builder(self):
        return default_builder()

    def pipeline_present(self) -> bool:
        """Cheap check for /health: finds data/cube.py without importing it. Importing pulls in
        astropy + reproject (~19 s on a cold Render instance, docs/ARCHITECTURE.md), which would
        make the deploy health check and the pre-demo wake-up call slow."""
        if self._builder != "auto":
            return self._builder is not None
        try:
            return importlib.util.find_spec(self.module) is not None
        except (ImportError, ValueError):
            return False

    def cube_dir(self, key: str) -> Path:
        return self.work_dir / key

    def preview_dir(self, key: str) -> Path:
        return self.work_dir / f"{key}.preview"

    def preview(self, key: str) -> dict | None:
        d = self.preview_dir(key)
        if not (d / "cube.f32").is_file():
            return None
        try:
            return json.loads((d / "cube.json").read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return None

    def finished(self, key: str) -> dict | None:
        """Result of a job finished earlier (also survives a restart while the disk lasts)."""
        d = self.cube_dir(key)
        if self.kind == "cube" and not (d / "cube.f32").is_file():
            return None
        try:
            return json.loads((d / self.result_file).read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return None

    finished_cube = finished

    def get_or_start(self, ra: float, dec: float, band: str,
                     admit: Callable[[Job], None] | None = None,
                     fov: int = DEFAULT_FOV, want_preview: bool = False) -> tuple[Job | None, dict | None]:
        """(None, result) if it is ready; otherwise (job, None) with the job running or failed.
        `admit(job)` is called only when a NEW job would start; it may raise (e.g. RateLimited,
        backend/limits.py) and then nothing is started."""
        key, ra, dec, band = job_key(ra, dec, band, fov)
        cube = self.finished(key)
        if cube is not None:
            if (cube.get("n_failed") or 0) > 0:
                self._maybe_refill(key, ra, dec, band, fov)
            return None, cube
        with self._guard:
            job = self._jobs.get(key)
            expired = job is not None and job.finished_at is not None and job.status != "done" \
                and time.time() - job.finished_at > ERROR_TTL_S
            if job is None or expired:
                job = Job(key, ra, dec, band, fov=check_fov(fov))
                if admit is not None:
                    admit(job)
                self._jobs[key] = job
                if want_preview:
                    job.want_preview = True  # set before the worker starts, so the search sees it
                self._pool.submit(self._run, job)
            elif want_preview:
                job.update(want_preview=True)  # honoured if the job has not started downloading yet
        return job, None

    def _maybe_refill(self, key: str, ra: float, dec: float, band: str, fov: int):
        """Start a background job for an incomplete result once it is REFILL_AFTER_S old, at most one
        at a time and not more often than that per position. Visitors keep getting the result they
        have; when the job finishes it replaces the result."""
        try:
            age = time.time() - (self.cube_dir(key) / self.result_file).stat().st_mtime
        except OSError:
            return
        if age < REFILL_AFTER_S:
            return
        with self._guard:
            job = self._jobs.get(key)
            if job is not None and (job.finished_at is None or time.time() - job.finished_at < REFILL_AFTER_S):
                return
            job = Job(key, ra, dec, band, fov=check_fov(fov))
            self._jobs[key] = job
            self._pool.submit(self._run, job)
        log.info("%s %s missed images; refilling in the background", self.kind, key)

    # ---------- the job itself ----------

    def _run(self, job: Job):
        try:
            self._run_stages(job)
        except Exception as e:  # report, never kill the worker thread
            log.exception("%s job %s failed", self.kind, job.key)
            job.update(status="error", message=f"{type(e).__name__}: {e}"[:300])
        finally:
            job.update(finished_at=time.time())

    def _run_stages(self, job: Job):
        builder = self.builder()
        job.mark("pipeline_loaded")  # the first job of a cold process pays the astropy import here
        if builder is None:
            job.update(status="unavailable",
                       message=f"{self.kind} pipeline ({self.module}) is not available yet")
            return
        if self.kind == "cube" and job.fov != DEFAULT_FOV and not accepts_fov(builder):
            job.update(status="unavailable",
                       message=f"a {job.fov}' field needs fov support in data/cube.py (task A-10); 3' works now")
            return
        files = self._download(job, builder)
        if files:
            self._finish(job, builder, files)

    def _download(self, job: Job, builder=None) -> list[Path] | None:
        """TAP search + cutouts. The centre and size are the same for cube and measure jobs, so
        IrsaClient's disk cache lets one job reuse the other's downloads."""

        job.update(status="searching", message="searching IRSA for SPHEREx images")
        try:
            if hasattr(self.client, "query_images_meta"):
                rows, meta = self.client.query_images_meta(job.ra, job.dec, job.band)
            else:  # simple clients (tests) have only query_images
                rows, meta = self.client.query_images(job.ra, job.dec, job.band), {}
        except irsa.IrsaError as e:
            log.warning("%s job %s: IRSA search failed: %s", self.kind, job.key, e)
            job.update(status="error", reason="search_down", message=irsa.SEARCH_DOWN_MESSAGE)
            return None
        if meta.get("listing"):
            job.update(listing={k: meta[k] for k in ("listing", "listed", "listing_object", "listing_sep_arcmin")})
        job.mark("searched")
        if not rows:
            job.update(status="empty", progress=1.0, message="no SPHEREx images cover this position in this band")
            return None
        n_total = len(rows)
        rows = subsample(rows, min(self.max_frames, MAX_FRAMES_BY_FOV.get(job.fov, self.max_frames)))
        job.update(status="downloading", progress=P_SEARCH, n_images=n_total, n_frames=len(rows),
                   message=f"downloading {len(rows)} cutouts")
        size = CUTOUT_SIZE_DEG if job.fov == DEFAULT_FOV else cutout_size_deg(job.fov)
        start = P_SEARCH
        if self.kind == "cube" and job.want_preview and builder is not None:
            self._preview(job, builder, rows, size)
            start = P_PREVIEW

        def progress(done, total):
            job.update(progress=start + (P_DOWNLOAD - start) * done / total,
                       message=f"downloaded {done}/{total} cutouts")

        uris = [r["uri"] for r in rows]
        results = self.client.fetch_cutouts(uris, job.ra, job.dec, size, progress=progress)
        missing = [i for i, p in enumerate(results) if not isinstance(p, Path)]
        if missing and len(missing) < len(results):
            # IRSA refuses some cutouts now and then and gives them a little later (#99)
            job.update(message=f"{len(missing)} images did not come; asking the archive again")
            time.sleep(REFETCH_WAIT_S)
            again = self.client.fetch_cutouts([uris[i] for i in missing], job.ra, job.dec, size)
            for i, p in zip(missing, again):
                results[i] = p
        files = [p for p in results if isinstance(p, Path)]
        failed = len(results) - len(files)
        job.update(n_failed=failed)
        if not files:
            job.update(status="error", message=f"all {failed} cutout downloads failed (IRSA unavailable?)")
            return None
        return files

    def _preview(self, job: Job, builder, rows: list[dict], size: float):
        """Download and build the first look. Any failure here only costs the preview: the full
        cube goes on (its downloads reuse these cutouts from the disk cache)."""
        pick = preview_subset(rows)
        job.update(message=f"downloading a first look: {len(pick)} images from every visit")

        def progress(done, total):
            job.update(progress=P_SEARCH + (P_PREVIEW - P_SEARCH) * done / total,
                       message=f"first look: downloaded {done}/{total} images")
        try:
            got = self.client.fetch_cutouts([r["uri"] for r in pick], job.ra, job.dec, size, progress=progress,
                                            retries=PREVIEW_RETRIES)
            files = [p for p in got if isinstance(p, Path)]
            job.mark("first_look_downloaded")
            if len(files) < 2:
                return
            self._build(job, builder, files, self.preview_dir(job.key))
            job.mark("first_look")
            job.update(preview_ready=True, message=f"first look ready ({len(files)} images); downloading the rest")
        except Exception:  # noqa: BLE001
            log.exception("preview of %s failed; the full cube goes on", job.key)

    def _build(self, job: Job, builder, files: list[Path], out: Path, stamp: dict | None = None):
        tmp = out.with_name(out.name + f".tmp{threading.get_ident()}")
        tmp.mkdir(parents=True, exist_ok=True)
        if job.fov == DEFAULT_FOV:
            builder(files, job.ra, job.dec, job.band, tmp)  # exactly the call made before fov existed
        else:
            builder(files, job.ra, job.dec, job.band, tmp, fov_arcmin=job.fov)
        if not ((tmp / "cube.json").is_file() and (tmp / "cube.f32").is_file()):
            raise RuntimeError("builder did not write cube.json and cube.f32")
        extra = {**(job.listing or {}), **(stamp or {})}
        if extra:  # e.g. where the image list came from, how many images are missing: for every later visitor
            meta = json.loads((tmp / "cube.json").read_text(encoding="utf-8"))
            meta.update(extra)
            (tmp / "cube.json").write_text(json.dumps(meta), encoding="utf-8")
        if out.exists():  # a previous run left one behind; the new one wins
            _rmtree(out)
        os.replace(tmp, out)

    def _finish(self, job: Job, builder, files: list[Path]):
        job.mark("downloaded")
        job.update(status="building", progress=P_DOWNLOAD, message=f"aligning {len(files)} frames")
        self._build(job, builder, files, self.cube_dir(job.key), stamp=self._counts(job))
        job.mark("done")
        job.update(status="done", progress=1.0, message="cube ready")

    @staticmethod
    def _counts(job: Job) -> dict:
        """n_images: images IRSA has here; n_frames: images asked for; n_failed: of those, not delivered."""
        return {"n_images": job.n_images, "n_frames": job.n_frames, "n_failed": job.n_failed}


def default_measurer():
    """Role A's measurement: motion + photometry (data/photometry.py), or motion only."""
    try:
        from data import photometry  # noqa: PLC0415
        return photometry.measure_from_files
    except ImportError:
        pass
    try:
        from data import motion  # noqa: PLC0415
    except ImportError:
        return None

    def motion_only(files, ra, dec, band):
        return {**motion.measure_shift_from_files(files, ra, dec, band), "photometry": []}
    return motion_only


class MeasureJobs(CubeJobs):
    """`/api/measure` at an arbitrary position (task C-04): same downloads as /api/cube, then
    role A's measurement on the RAW cutouts (docs/ARCHITECTURE.md level L3 -- never on the cube).
    The result is passed on unchanged: `motion: null`, empty `epochs` and `saturated: true` are
    answers, not errors (the frontend shows a warning for them)."""

    kind = "measure"
    module = "data.motion"
    result_file = "measure.json"

    def default_builder(self):
        return default_measurer()

    def _finish(self, job: Job, measurer, files: list[Path]):
        job.update(status="measuring", progress=P_DOWNLOAD, message=f"measuring the source in {len(files)} images")
        result = measurer(files, job.ra, job.dec, job.band)
        result = {**result, **(job.listing or {}), **self._counts(job)}
        out = self.cube_dir(job.key)
        out.mkdir(parents=True, exist_ok=True)
        tmp = out / f"{self.result_file}.{threading.get_ident()}.tmp"
        tmp.write_text(json.dumps(result, allow_nan=False), encoding="utf-8")  # NaN would break JSON.parse
        os.replace(tmp, out / self.result_file)
        job.mark("done")
        job.update(status="done", progress=1.0, message="measurement ready")


def _utc(t: float) -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(t))


def _rmtree(path: Path):
    for p in sorted(path.rglob("*"), reverse=True):
        p.rmdir() if p.is_dir() else p.unlink()
    path.rmdir()
