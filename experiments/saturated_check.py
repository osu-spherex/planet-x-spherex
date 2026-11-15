"""Pre-hackathon data check #3 (2026-11-10): can we measure a saturated star (R Draconis)?

Idea: the core pixels of a very bright star are masked (NaN), but the wings of its PSF are not.
Measure the mean surface brightness in an annulus around the star ("wing flux"). For a stable
PSF this is proportional to the star's total flux, so it can stand in for normal photometry.
Because the PSF and the star's spectrum both change with wavelength, only compare exposures
taken at (nearly) the same wavelength.

Validation: on an unsaturated star (RW Aurigae) wing flux must track ordinary aperture flux.

Usage:  python experiments/saturated_check.py rdra SPHEREx-D1 60
        python experiments/saturated_check.py rwaur SPHEREx-D1 30
"""
import concurrent.futures as cf
import sys

import astropy.units as u
import numpy as np
from astropy.coordinates import SkyCoord
from astropy.io import fits
from astropy.wcs import WCS

from check_objects import OBJECTS, predict, query_all

R_CORE, R_IN, R_OUT, R_BG0, R_BG1 = 2.5, 3.5, 6.5, 10.0, 15.0  # pixels


def wing(uri, o, mjd, size=0.07):
    ra, dec = predict(o, mjd)
    url = f"https://irsa.ipac.caltech.edu/{uri}?center={ra},{dec}d&size={size}"
    for attempt in range(2):
        try:
            with fits.open(url, cache=False) as h:
                img = h["IMAGE"].data.astype(float)
                hdr = h["IMAGE"].header
                w = WCS(hdr)
                wave = WCS(hdr, h, key="W")
                break
        except Exception as e:
            if attempt == 1:
                return dict(mjd=mjd, err=repr(e)[:60])
    x0, y0 = [float(v) for v in w.world_to_pixel(SkyCoord(ra * u.deg, dec * u.deg))]
    ny, nx = img.shape
    if not (R_BG1 <= x0 < nx - R_BG1 and R_BG1 <= y0 < ny - R_BG1):
        return dict(mjd=mjd, err="too close to image edge")
    yy, xx = np.indices(img.shape)
    r = np.hypot(xx - x0, yy - y0)
    fin = np.isfinite(img)
    bg = np.nanmedian(img[(r >= R_BG0) & (r <= R_BG1)])
    core, ann = r <= R_CORE, (r >= R_IN) & (r <= R_OUT)
    lam = wave.pixel_to_world(x0, y0)[0].to_value(u.um)
    ap = img[core & fin] - bg
    return dict(mjd=mjd, lam=lam,
                nan_core=int((core & ~fin).sum()), n_core=int(core.sum()),
                nan_ann=int((ann & ~fin).sum()), n_ann=int(ann.sum()),
                wing=float(np.nanmean(img[ann & fin]) - bg) if (ann & fin).any() else np.nan,
                core_sum=float(ap.sum()) if (core & ~fin).sum() == 0 else np.nan)


def run(key, band, n):
    o = OBJECTS[key]
    print(f"=== {o['name']} / {band} ===")
    rows = query_all(*predict(o, 61100.0))
    sel = rows[rows["band"] == band]
    idx = np.unique(np.linspace(0, len(sel) - 1, min(n, len(sel))).astype(int))
    jobs = [(sel["uri"][i], sel["mjd"][i]) for i in idx]
    with cf.ThreadPoolExecutor(8) as ex:
        res = list(ex.map(lambda j: wing(j[0], o, j[1]), jobs))
    ok = [r for r in res if "err" not in r]
    print(f"measured {len(ok)}/{len(res)};",
          f"core fully valid in {sum(r['nan_core'] == 0 for r in ok)},",
          f"annulus fully valid in {sum(r['nan_ann'] == 0 for r in ok)}")
    lams = np.array([r["lam"] for r in ok])
    edges = np.arange(np.floor(lams.min() * 20) / 20, lams.max() + 0.05, 0.05)
    for lo in edges:
        grp = sorted([r for r in ok if lo <= r["lam"] < lo + 0.05], key=lambda r: r["mjd"])
        if len(grp) < 2:
            continue
        print(f"-- wavelength {lo:.2f}-{lo + 0.05:.2f} um")
        for r in grp:
            ratio = r["core_sum"] / r["wing"] if np.isfinite(r["core_sum"]) else float("nan")
            print(f"   MJD {r['mjd']:.1f}  lam {r['lam']:.3f}  wing {r['wing']:9.3f}  "
                  f"NaN core {r['nan_core']:2d}/{r['n_core']}  NaN ann {r['nan_ann']:2d}/{r['n_ann']}  "
                  f"core/wing {ratio:8.1f}")
    return ok


if __name__ == "__main__":
    key = sys.argv[1] if len(sys.argv) > 1 else "rdra"
    band = sys.argv[2] if len(sys.argv) > 2 else "SPHEREx-D1"
    n = int(sys.argv[3]) if len(sys.argv) > 3 else 60
    run(key, band, n)
