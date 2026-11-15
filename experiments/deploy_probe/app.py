"""Deployment probe (pre-hackathon, 2026-11-10). NOT project code.

Answers one question: can a free-tier host run our Python stack and reach IRSA?
GET /        -> liveness + memory
GET /probe   -> times a TAP query, 3 cutout downloads and one reprojection; reports peak memory.
Delete the hosted service after reading the numbers.
"""
import os
import resource
import shutil
import tempfile
import time

from fastapi import FastAPI

app = FastAPI()


def rss_mb():
    return round(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024, 1)  # Linux: KB


@app.get("/")
def root():
    return {"ok": True, "peak_rss_mb": rss_mb(), "cpu_count": os.cpu_count()}


@app.get("/probe")
def probe(ra: float = 269.4464, dec: float = 4.7666, band: str = "SPHEREx-D1", n: int = 3):
    out = {"rss_start_mb": rss_mb()}
    t = time.time()
    import numpy as np
    from astropy.io import fits
    from astropy.wcs import WCS
    from astroquery.ipac.irsa import Irsa
    from reproject import reproject_interp
    out["import_s"] = round(time.time() - t, 2)
    out["rss_after_import_mb"] = rss_mb()

    q = f"""SELECT a.uri, p.time_bounds_lower AS mjd
            FROM spherex.artifact a JOIN spherex.plane p ON a.planeid = p.planeid
            WHERE 1 = CONTAINS(POINT('ICRS', {ra}, {dec}), p.poly) AND p.energy_bandpassname = '{band}'
            ORDER BY p.time_bounds_lower"""
    t = time.time()
    try:
        rows = Irsa.query_tap(q).to_table()
        out["tap_s"] = round(time.time() - t, 2)
        out["tap_rows"] = len(rows)
    except Exception as e:
        out["tap_error"] = repr(e)[:300]
        return out

    times, imgs = [], []
    for r in rows[: max(1, min(n, 5))]:
        url = f"https://irsa.ipac.caltech.edu/{r['uri']}?center={ra},{dec}d&size=0.05"
        t = time.time()
        try:
            with fits.open(url, cache=False) as h:
                imgs.append((h["IMAGE"].data.astype("float32"), WCS(h["IMAGE"].header)))
            times.append(round(time.time() - t, 2))
        except Exception as e:
            out.setdefault("cutout_errors", []).append(repr(e)[:200])
    out["cutout_s"] = times
    if len(imgs) >= 2:
        t = time.time()
        arr, _ = reproject_interp(imgs[1], imgs[0][1], shape_out=imgs[0][0].shape)
        out["reproject_s"] = round(time.time() - t, 3)
        out["reproject_finite_frac"] = round(float(np.isfinite(arr).mean()), 3)
    tmp = tempfile.gettempdir()
    out["tmp_free_gb"] = round(shutil.disk_usage(tmp).free / 1e9, 2)
    out["peak_rss_mb"] = rss_mb()
    return out
