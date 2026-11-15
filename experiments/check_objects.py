"""Pre-hackathon data check #2 (2026-11-10): are the other required test objects usable in SPHEREx?

For each object: how many images exist per detector and epoch, is the source detected,
does it sit where the catalog proper motion predicts, how bright is it, and at which
wavelength was each exposure taken (SPHEREx uses a linear variable filter, so every
exposure sees a source at a different wavelength).

Usage:  python experiments/check_objects.py [object-key ...]
"""
import concurrent.futures as cf
import logging
import sys
import warnings

import astropy.units as u
import numpy as np
from astropy.coordinates import SkyCoord
from astropy.io import fits
from astropy.utils.data import conf
from astropy.wcs import WCS
from astroquery.ipac.irsa import Irsa

warnings.filterwarnings("ignore")
logging.getLogger("astropy").setLevel(logging.ERROR)
conf.remote_timeout = 120

PIX = 6.16  # arcsec, measured from cutout WCS on 2026-11-10

# Reference positions and proper motions (arcsec/yr; pmra includes cos(dec)).
# Sources: CatWISE2020 and Gaia DR3 queried through IRSA on 2026-11-10, except eps Ind B,
# whose position is that of 2MASS J22041052-5646577 (2MASS Point Source Catalog through IRSA:
# 331.043836, -56.782707, observed 1999-11-08 = MJD 51490.1; the object: Scholz et al. 2003,
# A&A 398, L29, arXiv:astro-ph/0212487) moved with eps Ind A's Gaia DR3 proper motion (common
# proper motion pair) -- approximate. Corrected on 2026-11-15: this comment used to cite
# arXiv:astro-ph/0309256, which is McCaughrean et al. 2004 on the Ba/Bb pair. mjd0 below (51430)
# is 60 days before the real observation, which puts the predicted position 0.8" off; left as
# it was, because the results of 2026-11-10 were made with it.
OBJECTS = {
    "barnard": dict(name="Barnard's Star", ra=269.4464, dec=4.7666, mjd0=60914.0, pmra=-0.80, pmdec=10.36,
                    bands=["SPHEREx-D1"], search_px=3),
    "wise0855": dict(name="WISE 0855-0714", ra=133.7847613, dec=-7.2442498, mjd0=57104.76, pmra=None, pmdec=0.806,
                     bands=["SPHEREx-D6"], search_px=1.5),
    "epsindb": dict(name="Epsilon Indi B", ra=331.04383, dec=-56.78269, mjd0=51430.0, pmra=3.967, pmdec=-2.536,
                    bands=["SPHEREx-D2"], search_px=4),
    "rwaur": dict(name="RW Aurigae", ra=76.95608, dec=30.40120, mjd0=57388.0, pmra=0.003, pmdec=-0.027,
                  bands=["SPHEREx-D1"], search_px=2),
    "rdra": dict(name="R Draconis", ra=248.16738, dec=66.75501, mjd0=57388.0, pmra=-0.021, pmdec=0.006,
                 bands=["SPHEREx-D1"], search_px=2),
}
OBJECTS["wise0855"]["pmra"] = -7.965  # CatWISE2020: total 8.006"/yr with pmdec +0.806"/yr, moving west


def predict(o, mjd):
    dt = (mjd - o["mjd0"]) / 365.25
    dec = o["dec"] + o["pmdec"] * dt / 3600
    ra = o["ra"] + o["pmra"] * dt / 3600 / np.cos(np.radians(o["dec"]))
    return ra, dec


def query_all(ra, dec):
    q = f"""
    SELECT a.uri, p.energy_bandpassname AS band, p.time_bounds_lower AS mjd
    FROM spherex.artifact a JOIN spherex.plane p ON a.planeid = p.planeid
    WHERE 1 = CONTAINS(POINT('ICRS', {ra}, {dec}), p.poly)
    ORDER BY p.time_bounds_lower
    """
    return Irsa.query_tap(q).to_table()


def epochs(mjds, gap=20):
    groups, cur = [], [mjds[0]]
    for m in mjds[1:]:
        if m - cur[-1] > gap:
            groups.append(cur)
            cur = []
        cur.append(m)
    groups.append(cur)
    return groups


def measure(uri, o, mjd, size=0.04):
    ra, dec = predict(o, mjd)
    url = f"https://irsa.ipac.caltech.edu/{uri}?center={ra},{dec}d&size={size}"
    for attempt in range(2):
        try:
            with fits.open(url, cache=False) as h:
                img = h["IMAGE"].data.astype(float)
                flg = h["FLAGS"].data
                hdr = h["IMAGE"].header
                w = WCS(hdr)
                wave = WCS(hdr, h, key="W")
                break
        except Exception as e:  # transient network errors
            if attempt == 1:
                return dict(mjd=mjd, err=repr(e)[:80])
    x0, y0 = [float(v) for v in w.world_to_pixel(SkyCoord(ra * u.deg, dec * u.deg))]
    ny, nx = img.shape
    if not (3 <= x0 < nx - 3 and 3 <= y0 < ny - 3):
        return dict(mjd=mjd, err="off-image")
    bg = np.nanmedian(img)
    noise = 1.4826 * np.nanmedian(np.abs(img - bg))
    yy, xx = np.indices(img.shape)
    core = np.hypot(xx - x0, yy - y0) <= o["search_px"]
    near = core & np.isfinite(img)
    if near.sum() < 0.5 * core.sum():
        # most pixels at the source position are NaN: masked, usually a saturated star
        return dict(mjd=mjd, err=f"masked core ({int(core.sum() - near.sum())}/{int(core.sum())} px NaN, "
                                 f"flag {int(flg[int(round(y0)), int(round(x0))])})")
    y, x = np.unravel_index(np.argmax(np.where(near, img, -np.inf)), img.shape)
    st = np.nan_to_num(img[y - 2:y + 3, x - 2:x + 3] - bg)
    off = np.arange(-2, 3)
    cx = (st * off[None, :]).sum() / st.sum() + x
    cy = (st * off[:, None]).sum() / st.sum() + y
    c = w.pixel_to_world(cx, cy)
    lam = wave.pixel_to_world(x, y)[0].to_value(u.um)
    # forced 3x3 aperture at the predicted position (for faint sources)
    xi, yi = int(round(x0)), int(round(y0))
    ap = np.nansum(img[yi - 1:yi + 2, xi - 1:xi + 2] - bg)
    return dict(mjd=mjd, lam=lam, peak=img[y, x] - bg, snr_peak=(img[y, x] - bg) / noise,
                ap3=ap, snr_ap3=ap / (3 * noise), flux5=st.sum(), flag=int(flg[y, x]),
                dra=((c.ra.deg - ra) * np.cos(np.radians(dec))) * 3600, ddec=(c.dec.deg - dec) * 3600,
                ra=c.ra.deg, dec=c.dec.deg, stamp=img[yi - 4:yi + 5, xi - 4:xi + 5] - bg)


def run(key, per_epoch=6):
    o = OBJECTS[key]
    print(f"\n=== {o['name']} ===")
    ra, dec = predict(o, 61100.0)
    rows = query_all(ra, dec)
    bands = sorted(set(rows["band"]))
    print("images per detector:", {b[-2:]: int((rows["band"] == b).sum()) for b in bands})
    for band in o["bands"]:
        sel = rows[rows["band"] == band]
        if len(sel) == 0:
            print(band, "no images")
            continue
        groups = epochs(list(sel["mjd"]))
        print(f"{band}: {len(sel)} images in {len(groups)} epochs:",
              [f"MJD {g[0]:.0f}-{g[-1]:.0f} (n={len(g)})" for g in groups])
        picks = []
        for g in groups:
            idx = np.unique(np.linspace(0, len(g) - 1, min(per_epoch, len(g))).astype(int))
            picks += [g[i] for i in idx]
        jobs = [(r["uri"], r["mjd"]) for r in sel if r["mjd"] in picks]
        with cf.ThreadPoolExecutor(8) as ex:
            res = list(ex.map(lambda j: measure(j[0], o, j[1]), jobs))
        ok = [r for r in res if "err" not in r]
        print(f"  measured {len(ok)}/{len(res)} cutouts")
        for e in sorted(set(r["err"] for r in res if "err" in r)):
            print(f"  failed ({sum(1 for r in res if r.get('err') == e)}x): {e}")
        print("  MJD       lambda  peak[MJy/sr] SNRpk  SNRap3  flux5    dRA\"   dDec\"  flag")
        for r in ok:
            print(f"  {r['mjd']:.2f} {r['lam']:.3f}  {r['peak']:10.2f} {r['snr_peak']:6.1f} {r['snr_ap3']:6.1f} "
                  f"{r['flux5']:8.1f} {r['dra']:+6.1f} {r['ddec']:+6.1f}  {r['flag']}")
        stamps = [r["stamp"] for r in ok if r["stamp"].shape == (9, 9)]
        if stamps:
            stack = np.nanmedian(stamps, axis=0)
            edge = np.concatenate([stack[0], stack[-1], stack[1:-1, 0], stack[1:-1, -1]])
            s = np.nanstd(edge)
            print(f"  median stack of {len(stamps)} at predicted position: centre 3x3 sum = {np.nansum(stack[3:6, 3:6]):.2f}, "
                  f"edge sigma = {s:.3f} -> SNR ~ {np.nansum(stack[3:6, 3:6]) / (3 * s):.1f}")
    return rows


if __name__ == "__main__":
    for k in (sys.argv[1:] or ["wise0855", "epsindb", "rwaur", "rdra"]):
        run(k)
