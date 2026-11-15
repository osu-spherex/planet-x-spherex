"""IRSA client for SPHEREx: TAP image search and cutout download, with retry and a disk cache.

Why this exists (measured 2026-11-10, docs/ARCHITECTURE.md "Гадны үйлчилгээний найдвартай байдал"):
- IRSA answers 503 often: from Render (Oregon) the first attempt gave 503 on 4/4 cutouts and every
  retry succeeded. So every request is retried with exponential backoff.
- A TAP query takes 8-30 s and a cutout 1.5-5 s / 4-5 MB, so results are kept on disk and a repeat
  request for the same thing never goes back to IRSA.
- IRSA's request limit is unknown; the architecture caps us at 8 concurrent requests. One
  semaphore guards every HTTP call made by this module, from any thread.

The download logic (atomic .part -> final rename, FITS completeness check, thread-local sessions)
is ported from experiments/prefetch_cache.py, which fetched the 660-file demo cache with it.
"""
from __future__ import annotations

import csv
import hashlib
import io
import json
import logging
import os
import random
import re
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Callable, Iterable

import requests

log = logging.getLogger("osu.irsa")

IRSA = "https://irsa.ipac.caltech.edu/"
TAP_SYNC = IRSA + "TAP/sync"
FITS_BLOCK = 2880  # a FITS file is always a whole number of 2880-byte blocks

MAX_CONCURRENT = 8      # docs/ARCHITECTURE.md: "8-аас их зэрэгцээ хүсэлт бүү явуул"
RETRIES = 3             # retries after the first attempt (tasks/C.md C-01)
BACKOFF_BASE_S = 1.0    # waits 1, 2, 4 s (+ up to 25% jitter) before retries 1..3
TAP_TTL_S = 24 * 3600   # SPHEREx keeps releasing data; re-ask IRSA once a day at most
# A healthy TAP query takes 8-32 s (docs/ARCHITECTURE.md, measured 11/10-11/14). 60 s per attempt keeps the
# worst case (IRSA hanging, 4 attempts + 1-2-4 s backoff) near 4 min, inside the frontend's 6 min budget,
# so the visitor gets a clear "IRSA search failed" instead of a timeout (C-07; IRSA hung >150 s on 11/14 14:05).
TAP_TIMEOUT = (15, 60)
CUTOUT_TIMEOUT = (15, 180)
RETRY_STATUS = {429, 500, 502, 503, 504}

BAND_RE = re.compile(r"^(?:SPHEREx-)?(D[1-6])$")
URI_RE = re.compile(r"^ibe/data/spherex/[A-Za-z0-9_./-]+\.fits$")


class IrsaError(RuntimeError):
    """IRSA refused or failed the request (after retries, if it was retryable)."""

    def __init__(self, message: str, status: int | None = None):
        super().__init__(message)
        self.status = status


# What a visitor reads when IRSA's image search is down and no saved list covers the position
# (task C-13). No status codes or URLs: those go to the log.
SEARCH_DOWN_MESSAGE = ("NASA's archive search is not answering, so new positions cannot be looked up right now. "
                       "The five example objects above still work.")


def saved_listing(ra: float, dec: float, band: str | None):
    """Role A's saved image list for the five demo objects (data.listing.saved_images, task A-17):
    (rows, {object, sep_arcmin, listed}) or None. Imported lazily; any problem means "no list"."""
    try:
        from data import listing  # noqa: PLC0415
    except ImportError:
        return None
    fn = getattr(listing, "saved_images", None)
    if fn is None:
        return None
    try:
        return fn(ra, dec, band)
    except Exception:  # noqa: BLE001
        log.exception("saved image list failed for %s %s %s", ra, dec, band)
        return None


def normalize_band(band: str) -> str:
    """'D1' or 'SPHEREx-D1' -> 'SPHEREx-D1'. Anything else is rejected (it goes into ADQL)."""
    m = BAND_RE.match(str(band).strip())
    if not m:
        raise ValueError(f"band must be D1..D6, got {band!r}")
    return f"SPHEREx-{m.group(1)}"


def check_coords(ra: float, dec: float) -> tuple[float, float]:
    ra, dec = float(ra), float(dec)
    if not (0.0 <= ra < 360.0) or not (-90.0 <= dec <= 90.0):
        raise ValueError(f"need 0 <= ra < 360 and -90 <= dec <= 90, got ra={ra}, dec={dec}")
    return ra, dec


def is_fits(path: Path) -> bool:
    """Cheap completeness check: starts like FITS and has a whole number of 2880-byte blocks."""
    try:
        size = path.stat().st_size
        if size == 0 or size % FITS_BLOCK:
            return False
        with open(path, "rb") as f:
            return f.read(9) == b"SIMPLE  ="
    except OSError:
        return False


def default_cache_dir() -> Path:
    """Where the backend keeps what it downloads: $OSU_BACKEND_CACHE, else backend/.cache."""
    env = os.environ.get("OSU_BACKEND_CACHE")
    return Path(env) if env else Path(__file__).resolve().parent / ".cache"


class IrsaClient:
    """Thread-safe. One instance per process is enough; all instances share nothing but IRSA."""

    def __init__(self, cache_dir: Path | None = None, *, retries: int = RETRIES,
                 backoff_base: float = BACKOFF_BASE_S, max_concurrent: int = MAX_CONCURRENT,
                 session_factory: Callable[[], requests.Session] = requests.Session,
                 sleep: Callable[[float], None] = time.sleep, tap_ttl: float = TAP_TTL_S,
                 listing: Callable | None = saved_listing):
        self.cache_dir = Path(cache_dir) if cache_dir else default_cache_dir()
        self._listing = listing
        self.retries = retries
        self.backoff_base = backoff_base
        self.max_concurrent = max_concurrent
        self.tap_ttl = tap_ttl
        self._session_factory = session_factory
        self._sleep = sleep
        self._slots = threading.BoundedSemaphore(max_concurrent)
        self._local = threading.local()
        self._locks: dict[str, threading.Lock] = {}
        self._locks_guard = threading.Lock()

    # ---------- HTTP with retry ----------

    def _session(self) -> requests.Session:
        if not hasattr(self._local, "s"):
            self._local.s = self._session_factory()
        return self._local.s

    def _drop_session(self):
        s = self._local.__dict__.pop("s", None)
        if s is not None and hasattr(s, "close"):
            s.close()

    def _delay(self, attempt: int) -> float:
        d = self.backoff_base * 2 ** (attempt - 1)
        return d * (1 + 0.25 * random.random())

    def _with_retry(self, what: str, call: Callable[[requests.Session], object], retries: int | None = None):
        """Run `call(session)`; retry 5xx/429, timeouts and dropped connections. 4xx fails at once."""
        err: Exception | None = None
        retries = self.retries if retries is None else retries
        for attempt in range(retries + 1):
            if attempt:
                wait = self._delay(attempt)
                log.warning("%s failed (%s); retry %d/%d in %.1fs", what, err, attempt, retries, wait)
                self._sleep(wait)
            try:
                with self._slots:
                    return call(self._session())
            except requests.HTTPError as e:
                status = e.response.status_code if e.response is not None else None
                if status not in RETRY_STATUS:
                    raise IrsaError(f"{what}: HTTP {status}", status) from e
                err = e
            except (requests.ConnectionError, requests.Timeout, requests.exceptions.ChunkedEncodingError,
                    IncompleteDownload) as e:
                err = e
            self._drop_session()  # next attempt on a fresh connection
        status = getattr(getattr(err, "response", None), "status_code", None)
        raise IrsaError(f"{what}: gave up after {retries + 1} attempts ({err})", status) from err

    def _lock_for(self, key: str) -> threading.Lock:
        """Two requests for the same file wait for one download instead of fetching it twice."""
        with self._locks_guard:
            return self._locks.setdefault(key, threading.Lock())

    # ---------- TAP: which images cover a position ----------

    def query_images(self, ra: float, dec: float, band: str | None = None) -> list[dict]:
        """Every SPHEREx image covering (ra, dec), time-ordered: [{uri, band, mjd}].

        Cached on disk for `tap_ttl` seconds. If IRSA is down and an older answer exists, that
        answer is returned (and logged) rather than failing.
        """
        return self.query_images_meta(ra, dec, band)[0]

    def tap_is_fresh(self, ra: float, dec: float, band: str | None = None) -> bool:
        """True if query_images would answer from disk without asking IRSA."""
        ra, dec = check_coords(ra, dec)
        band = normalize_band(band) if band is not None else None
        saved = _read_json(self.cache_dir / "tap" / f"{ra:.6f}_{dec:+.6f}_{band or 'all'}.json")
        return saved is not None and time.time() - saved["saved_at"] < self.tap_ttl

    def query_images_meta(self, ra: float, dec: float, band: str | None = None) -> tuple[list[dict], dict]:
        """query_images plus where the answer came from:
        {"saved_utc": ISO time IRSA gave this answer, "stale": True if IRSA failed just now and an
        older saved answer was used}. /api/coverage shows this so a stale count is never passed off as live.

        When the search fails and nothing was saved on this disk, role A's saved list of the five demo
        objects' images is used if the position is near one of them (task C-13): meta then has
        listing="saved", listed=<date of that list>, listing_object, listing_sep_arcmin. The images
        themselves are still downloaded from IRSA. Such answers are not cached: as soon as the search
        works again it is used."""
        ra, dec = check_coords(ra, dec)
        band = normalize_band(band) if band is not None else None  # None = all detectors
        key = f"{ra:.6f}_{dec:+.6f}_{band or 'all'}"
        path = self.cache_dir / "tap" / f"{key}.json"
        with self._lock_for("tap:" + key):
            saved = _read_json(path)
            if saved is not None and time.time() - saved["saved_at"] < self.tap_ttl:
                return saved["rows"], _tap_meta(saved, stale=False)
            if band is not None:  # a fresh all-detector answer (/api/coverage) already has these rows
                every = _read_json(self.cache_dir / "tap" / f"{ra:.6f}_{dec:+.6f}_all.json")
                if every is not None and time.time() - every["saved_at"] < self.tap_ttl:
                    return [r for r in every["rows"] if r["band"] == band], _tap_meta(every, stale=False)
            try:
                if saved is not None:  # an older answer exists: the full retry budget, then that answer
                    rows = self._query_tap(ra, dec, band)
                else:
                    rows = self._query_tap_or_listing(ra, dec, band)
                    if isinstance(rows, tuple):  # (rows, meta) from the saved list
                        return rows
            except IrsaError as e:
                if saved is not None:
                    log.warning("TAP failed; using saved answer from %s", path)
                    return saved["rows"], {**_tap_meta(saved, stale=True), "error": str(e)[:200]}
                raise
            saved = {"saved_at": time.time(), "ra": ra, "dec": dec, "band": band, "rows": rows}
            _write_json(path, saved)
            return rows, _tap_meta(saved, stale=False)

    def _query_tap_or_listing(self, ra: float, dec: float, band: str | None):
        """One TAP attempt; if it fails and role A's saved list covers the position, that list at once
        (task C-14: on 11/15 the search answered in ~114 s, so 4 attempts of 60 s kept the challenge
        coordinate "searching" for 4 of 5 minutes). Elsewhere the remaining retries as before, so the
        number of TAP requests is unchanged (1 + RETRIES). The list is only read after a failure."""
        try:
            return self._query_tap(ra, dec, band, retries=0)
        except IrsaError as first:
            found = self._listing(ra, dec, band) if self._listing is not None else None
            if found:
                rows, info = found
                rows = [dict(uri=r["uri"], band=normalize_band(r["band"]), mjd=float(r["mjd"])) for r in rows]
                rows = [r for r in rows if band is None or r["band"] == band]
                rows.sort(key=lambda r: r["mjd"])
                log.warning("TAP failed (%s); using the saved image list of %s (%s rows)", first, info.get("object"), len(rows))
                return rows, {"saved_utc": None, "stale": False, "listing": "saved", "listed": info.get("listed"),
                              "listing_object": info.get("object"), "listing_sep_arcmin": info.get("sep_arcmin")}
            if self.retries < 1:
                raise
            self._sleep(self._delay(1))  # the backoff the first retry always had
            return self._query_tap(ra, dec, band, retries=self.retries - 1)

    def _query_tap(self, ra: float, dec: float, band: str | None, retries: int | None = None) -> list[dict]:
        where = f"1 = CONTAINS(POINT('ICRS', {ra!r}, {dec!r}), p.poly)"
        if band:
            where += f" AND p.energy_bandpassname = '{band}'"
        adql = ("SELECT a.uri, p.energy_bandpassname AS band, p.time_bounds_lower AS mjd "
                "FROM spherex.artifact a JOIN spherex.plane p ON a.planeid = p.planeid "
                f"WHERE {where} ORDER BY p.time_bounds_lower")

        def call(s):
            r = s.post(TAP_SYNC, data={"QUERY": adql, "LANG": "ADQL", "FORMAT": "csv"}, timeout=TAP_TIMEOUT)
            r.raise_for_status()
            return r.text

        text = self._with_retry("TAP query", call, retries)
        reader = csv.DictReader(io.StringIO(text))
        if reader.fieldnames is None or not {"uri", "band", "mjd"} <= set(reader.fieldnames):
            # IRSA reports ADQL errors as a VOTable with HTTP 200
            raise IrsaError(f"TAP query: unexpected response {text[:200]!r}")
        return [dict(uri=r["uri"], band=r["band"], mjd=float(r["mjd"])) for r in reader]

    # ---------- cutouts ----------

    def cutout_url(self, uri: str, ra: float, dec: float, size_deg: float) -> str:
        return f"{IRSA}{uri}?center={ra:.7f},{dec:.7f}d&size={size_deg:g}"

    def cutout_path(self, uri: str, ra: float, dec: float, size_deg: float) -> Path:
        """Cache file for one cutout. Same image + centre + size -> same file."""
        name = os.path.basename(uri)
        tag = hashlib.sha1(f"{uri}|{ra:.7f}|{dec:.7f}|{size_deg:g}".encode()).hexdigest()[:12]
        return self.cache_dir / "cutouts" / f"{name[:-5]}__{tag}.fits"

    def fetch_cutout(self, uri: str, ra: float, dec: float, size_deg: float = 0.05,
                     retries: int | None = None) -> Path:
        """Path to the cutout on disk, downloading it if needed. FITS bytes are saved unmodified."""
        if not URI_RE.match(uri):
            raise ValueError(f"not a SPHEREx image uri: {uri!r}")
        ra, dec = check_coords(ra, dec)
        if not 0 < size_deg <= 0.5:
            raise ValueError(f"size_deg must be in (0, 0.5], got {size_deg}")
        dest = self.cutout_path(uri, ra, dec, size_deg)
        if is_fits(dest):
            return dest
        with self._lock_for(str(dest)):
            if is_fits(dest):  # another thread finished it while we waited
                return dest
            dest.parent.mkdir(parents=True, exist_ok=True)
            tmp = dest.with_name(f"{dest.name}.{threading.get_ident()}.part")
            url = self.cutout_url(uri, ra, dec, size_deg)

            def call(s):
                with s.get(url, stream=True, timeout=CUTOUT_TIMEOUT) as r:
                    r.raise_for_status()
                    with open(tmp, "wb") as f:
                        for chunk in r.iter_content(1 << 20):
                            f.write(chunk)
                    expected = r.headers.get("Content-Length")
                    got = tmp.stat().st_size
                    if expected and not r.headers.get("Content-Encoding") and int(expected) != got:
                        raise IncompleteDownload(f"truncated: {got} of {expected} bytes")
                if not is_fits(tmp):
                    raise IncompleteDownload(f"not a complete FITS file ({tmp.stat().st_size} bytes)")

            try:
                self._with_retry(f"cutout {os.path.basename(uri)}", call, retries)
                os.replace(tmp, dest)  # only complete files ever get the final name
            finally:
                tmp.unlink(missing_ok=True)
            return dest

    def fetch_cutouts(self, uris: Iterable[str], ra: float, dec: float, size_deg: float = 0.05, *,
                      retries: int | None = None,
                      progress: Callable[[int, int], None] | None = None) -> list[Path | IrsaError]:
        """Download many cutouts with at most `max_concurrent` in flight.

        Returns one entry per uri, in input order: the Path, or the IrsaError if that one failed
        (one bad image must not sink a 60-image cube). `progress(done, total)` is called as they finish.
        """
        uris = list(uris)
        out: list[Path | IrsaError] = [None] * len(uris)  # type: ignore[list-item]
        done = 0
        done_lock = threading.Lock()

        def one(i):
            nonlocal done
            try:
                out[i] = self.fetch_cutout(uris[i], ra, dec, size_deg, retries)
            except IrsaError as e:
                out[i] = e
            with done_lock:
                done += 1
                if progress:
                    progress(done, len(uris))

        with ThreadPoolExecutor(max_workers=self.max_concurrent) as ex:
            list(ex.map(one, range(len(uris))))
        return out


class IncompleteDownload(IOError):
    """The response ended early or was not a FITS file (IRSA sometimes sends an HTML error page)."""


def _tap_meta(saved: dict, stale: bool) -> dict:
    t = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(saved["saved_at"]))
    return {"saved_utc": t, "stale": stale}


def _read_json(path: Path):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


def _write_json(path: Path, obj):
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f"{path.name}.{threading.get_ident()}.tmp")
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(obj, f)
    os.replace(tmp, path)
