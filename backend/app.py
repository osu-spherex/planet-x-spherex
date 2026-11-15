"""OSU SPHEREx backend (FastAPI).

Run locally from the repo root:
    .venv/Scripts/python -m uvicorn backend.app:app --reload --port 8000
Then open http://127.0.0.1:8000/health

Endpoints (docs/ARCHITECTURE.md "Интерфейс"):
    GET /health                       liveness; also used to wake the free Render instance before a demo
    GET /cubes/<obj>/<band>/cube.json static cubes of the 5 demo objects (data/cubes/, role A), as files
    GET /api/cube?ra=&dec=&band=D1    202 {status, progress, ...} while building; 200 cube.json when done
    GET /api/cubes/<key>/cube.f32     pixel data of a cube built by /api/cube (its data_url points here)
    GET /api/measure?ra=&dec=&band=D1 same polling as /api/cube; 200 {epochs, motion, photometry, ...} (data/photometry.py)
    GET /cubes/<obj>/<band>/measure.json  precomputed measurement of the 5 demo objects (role A, A-07)
    GET /api/coverage?ra=&dec=        images / visits per detector D1..D6 (one TAP query, kept 24 h)
    GET /api/catalog?ra=&dec=&radius= Gaia DR3 + CatWISE2020 sources around a position (data/catalog.py, kept 24 h)
    /api/cube and /api/measure take fov=3|6|10 (arcmin, default 3); cube answers carry fov_arcmin
    /api/cube?...&preview=1  while the job runs, 200 {status: "preview", complete: false, progress, ...first-look
                             cube from 2 images per visit} as soon as it exists; keep polling for status "done"
                             (complete: true). Without preview=1 the answers are exactly as before.
    GET /cubes/<obj>/coverage.json    the same for the 5 demo objects, precomputed (python -m backend.coverage)

Environment:
    OSU_CUBES_DIR       static cubes (default: <repo>/data/cubes)
    OSU_BACKEND_CACHE   downloads and built cubes (default: backend/.cache)
    OSU_CORS_ORIGINS    comma-separated frontend origins (default: http://localhost:3000)
    OSU_CORS_ORIGIN_REGEX  extra origins as a regex, e.g. the Vercel preview URLs (default: none)
    OSU_LIMIT_RUNNING      jobs one visitor may have running at once (default 2)      backend/limits.py
    OSU_LIMIT_NEW_PER_MIN  new positions one visitor may start per minute (default 3)
    OSU_WARMUP             1 = import the data pipeline in the background at start (default: on when RENDER
                           is set, which Render does for every service; off locally and in tests)

Over a limit the API answers 429 {status: "limited", message, retry_after} with a Retry-After header.
Every job answer carries server_started_utc: if it changes between two polls, the server restarted
(e.g. a deploy) and the job was started again from the beginning.

Deployed on Render from render.yaml (deploy/README.md).
"""
from __future__ import annotations

import os
import re
import threading
import time
from pathlib import Path

from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from backend import catalog as catalog_mod
from backend import coverage as coverage_mod
from backend import irsa
from backend.jobs import DEFAULT_FOV, CubeJobs, MeasureJobs, check_fov, job_key
from backend.limits import Limiter, RateLimited, client_address

REPO = Path(__file__).resolve().parents[1]
KEY_RE = re.compile(r"^D[1-6]_\d{1,3}\.\d{4}_[+-]\d{1,2}\.\d{4}(_f(6|10))?(\.preview)?$")

# HTTP status for a job that is not done. 202 = "keep polling"; the others end the poll.
JOB_HTTP = {"queued": 202, "searching": 202, "downloading": 202, "building": 202, "measuring": 202,
            "empty": 404, "unavailable": 503, "error": 502}


def create_app(client: irsa.IrsaClient | None = None, cubes_dir: Path | None = None,
               builder="auto", max_frames: int | None = None, measurer="auto",
               limiter: Limiter | None = None, catalog_fetch="auto") -> FastAPI:
    started = time.time()
    server_started_utc = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(started))
    limiter = limiter or Limiter()
    warm = {"state": "off", "seconds": None}
    client = client or irsa.IrsaClient()
    cubes_dir = Path(cubes_dir or os.environ.get("OSU_CUBES_DIR") or REPO / "data" / "cubes")
    jobs_kw = {} if max_frames is None else {"max_frames": max_frames}
    jobs = CubeJobs(client, client.cache_dir / "cubes", builder=builder, **jobs_kw)
    measures = MeasureJobs(client, client.cache_dir / "measure", builder=measurer, **jobs_kw)
    catalogs = catalog_mod.CatalogCache(client.cache_dir / "catalog", fetch=catalog_fetch)

    app = FastAPI(title="OSU SPHEREx backend", version="0.2.0")
    origins = [o.strip() for o in os.environ.get("OSU_CORS_ORIGINS", "http://localhost:3000").split(",") if o.strip()]
    origin_regex = os.environ.get("OSU_CORS_ORIGIN_REGEX") or None
    app.add_middleware(CORSMiddleware, allow_origins=origins, allow_origin_regex=origin_regex,
                       allow_methods=["GET"], allow_headers=["*"])
    app.add_middleware(GZipMiddleware, minimum_size=1000)  # cube.f32 ~1 MB; NaN-heavy frames compress well
    app.state.jobs = jobs

    @app.get("/health")
    def health():
        return {
            "status": "ok",
            "uptime_s": round(time.time() - started, 1),
            "irsa": {"max_concurrent": client.max_concurrent, "retries": client.retries},
            "static_cubes": cubes_dir.is_dir(),
            "cube_pipeline": jobs.pipeline_present(),
            "measure_pipeline": measures.pipeline_present(),
            "catalog_pipeline": catalogs.present(),
            "warmup": dict(warm),
        }

    def position(ra: float, dec: float) -> str:
        return job_key(ra, dec, "D1")[0].split("_", 1)[1]  # rounded ra_dec, any detector

    def address_of(request: Request) -> str:
        return client_address(request.headers, request.client.host if request.client else None)

    def admit_for(request: Request):
        address = address_of(request)
        return lambda job: limiter.admit(address, position(job.ra, job.dec), job)

    def limited(e: RateLimited) -> JSONResponse:
        return JSONResponse({**e.body(), "server_started_utc": server_started_utc}, status_code=429,
                            headers={"Retry-After": str(e.retry_after)})

    def job_answer(job) -> JSONResponse:
        body = {**job.public(), "server_started_utc": server_started_utc}
        return JSONResponse(body, status_code=JOB_HTTP.get(body["status"], 500))

    @app.get("/api/cube")
    def api_cube(request: Request, ra: float = Query(..., ge=0, lt=360), dec: float = Query(..., ge=-90, le=90),
                 band: str = Query("D1"), fov: str = Query(str(DEFAULT_FOV)), preview: str = Query("0")):
        if preview not in ("0", "1"):
            raise HTTPException(422, "preview must be 0 or 1")
        want = preview == "1"
        try:
            job, cube = jobs.get_or_start(ra, dec, band, admit=admit_for(request), fov=check_fov(fov),
                                          want_preview=want)
        except ValueError as e:
            raise HTTPException(422, str(e)) from e
        except RateLimited as e:
            return limited(e)
        if cube is not None:
            # /api/cube?... is not a directory, so a relative data_url ("cube.f32") would resolve to the
            # wrong place: point at the file by absolute path instead.
            key = job_key(ra, dec, band, int(fov))[0]
            done = {"fov_arcmin": int(fov), **cube, "status": "done", "data_url": f"/api/cubes/{key}/cube.f32"}
            return {**done, "complete": True} if want else done
        if want and job.preview_ready and job.finished_at is None:
            first = jobs.preview(job.key)
            if first is not None:
                body = job.public()
                return {"fov_arcmin": int(fov), **first, "status": "preview", "complete": False,
                        "progress": body["progress"], "message": body["message"], "n_images": body["n_images"],
                        "server_started_utc": server_started_utc,
                        "data_url": f"/api/cubes/{job.key}.preview/cube.f32"}
        return job_answer(job)

    @app.get("/api/coverage")
    def api_coverage(request: Request, ra: float = Query(..., ge=0, lt=360), dec: float = Query(..., ge=-90, le=90)):
        """Synchronous: 8-30 s the first time (one TAP query), then instant for 24 h.
        `source.stale: true` means IRSA failed just now and the saved answer of `source.saved_utc` is shown."""
        try:
            r, d = round(ra, coverage_mod.COORD_DECIMALS), round(dec, coverage_mod.COORD_DECIMALS)
            if not client.tap_is_fresh(r, d, None):  # only a real IRSA query counts as a new position
                limiter.admit(address_of(request), position(ra, dec))
            return coverage_mod.coverage(client, ra, dec)
        except RateLimited as e:
            return limited(e)
        except ValueError as e:
            raise HTTPException(422, str(e)) from e
        except irsa.IrsaError as e:
            return JSONResponse({"status": "error", "reason": "search_down", "message": irsa.SEARCH_DOWN_MESSAGE},
                                status_code=502)

    @app.get("/api/catalog")
    def api_catalog(request: Request, ra: float = Query(..., ge=0, lt=360), dec: float = Query(..., ge=-90, le=90),
                    radius: float = Query(catalog_mod.DEFAULT_RADIUS, gt=0, le=catalog_mod.MAX_RADIUS)):
        """Catalogue sources (Gaia DR3, CatWISE2020) for the overlay. Synchronous; kept 24 h; when IRSA
        fails a saved answer is returned with source.stale = true. Static copies: /cubes/<obj>/catalog.json."""
        try:
            if not catalogs.is_fresh(ra, dec, radius):
                limiter.admit(address_of(request), position(ra, dec))
            return catalogs.get(ra, dec, radius)
        except RateLimited as e:
            return limited(e)
        except catalog_mod.CatalogUnavailable as e:
            return JSONResponse({"status": "unavailable", "message": str(e)}, status_code=503)
        except catalog_mod.CatalogError as e:
            return JSONResponse({"status": "error", "message": str(e)}, status_code=502)

    @app.get("/api/measure")
    def api_measure(request: Request, ra: float = Query(..., ge=0, lt=360), dec: float = Query(..., ge=-90, le=90),
                    band: str = Query("D1"), fov: str = Query(str(DEFAULT_FOV))):
        """Motion and photometry of the source at (ra, dec), measured on the raw cutouts.
        For the 5 demo objects the frontend reads the static /cubes/<obj>/<band>/measure.json instead."""
        try:
            job, result = measures.get_or_start(ra, dec, band, admit=admit_for(request), fov=check_fov(fov))
        except ValueError as e:
            raise HTTPException(422, str(e)) from e
        except RateLimited as e:
            return limited(e)
        if result is not None:
            return {**result, "status": "done"}
        return job_answer(job)

    @app.get("/api/cubes/{key}/{name}")
    def api_cube_file(key: str, name: str):
        if not KEY_RE.match(key) or name not in ("cube.json", "cube.f32"):
            raise HTTPException(404)
        path = jobs.cube_dir(key) / name
        if not path.is_file():
            raise HTTPException(404)
        media = "application/json" if name.endswith(".json") else "application/octet-stream"
        return FileResponse(path, media_type=media, headers={"Cache-Control": "public, max-age=86400"})

    if should_warm_up():
        # A cold free instance needs ~19 s to import astropy + reproject (docs/ARCHITECTURE.md, 11/10).
        # Without this the first visitor's job paid it in the middle of the first look (backup site,
        # 11/14 17:05: 39 s right after a deploy). /health stays import-free and answers meanwhile.
        def warm_up():
            t = time.time()
            warm["state"] = "running"
            try:
                jobs.builder()
                measures.builder()
                catalogs.fetcher()
                warm.update(state="done", seconds=round(time.time() - t, 1))
            except Exception as e:  # noqa: BLE001  a failed warm-up only means the first job imports itself
                warm.update(state=f"failed: {type(e).__name__}", seconds=round(time.time() - t, 1))
        threading.Thread(target=warm_up, name="warmup", daemon=True).start()

    # Static cubes are plain files: the frontend loads /cubes/barnard/D1/cube.json and resolves its
    # data_url ("cube.f32") relative to it, exactly as for a live cube.
    app.mount("/cubes", OptionalStaticFiles(directory=cubes_dir, check_dir=False), name="cubes")
    return app



def should_warm_up() -> bool:
    flag = os.environ.get("OSU_WARMUP")
    if flag is not None:
        return flag.strip() == "1"
    return bool(os.environ.get("RENDER"))  # set by Render on every service (render.com/docs/environment-variables)


class OptionalStaticFiles(StaticFiles):
    """StaticFiles that answers 404 while its folder does not exist yet (data/cubes/ arrives with
    A-02), instead of raising on every request."""

    async def check_config(self) -> None:
        if self.directory is not None and Path(self.directory).is_dir():
            await super().check_config()


app = create_app()
