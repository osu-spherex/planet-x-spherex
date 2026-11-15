"""Pre-hackathon data check (2026-11-10): can we see Barnard's Star move in SPHEREx images?

Result on 2026-11-10: Dec shift +10.71" between MJD 60914 (2025-08) and 61285 (2026-08),
expected ~+10.5" from Barnard's Star proper motion (~10.3"/yr north).

Method follows IRSA's SPHEREx cutouts tutorial:
https://caltech-ipac.github.io/irsa-tutorials/spherex-cutouts
"""
import logging
import time

import astropy.units as u
import numpy as np
from astropy.coordinates import SkyCoord
from astropy.io import fits
from astropy.utils.data import conf
from astropy.wcs import WCS
from astroquery.ipac.irsa import Irsa

logging.getLogger("astropy").setLevel(logging.ERROR)
conf.remote_timeout = 120

# Barnard's Star, approximate position in mid-2025 (J2000 position + proper motion).
RA, DEC = 269.4464, 4.7666
BAND = "SPHEREx-D1"
SIZE_DEG = 0.05  # 3 arcmin cutout


def query(ra, dec, band, size_deg):
    q = f"""
    SELECT 'https://irsa.ipac.caltech.edu/' || a.uri || '?center={ra},{dec}d&size={size_deg}' AS uri,
           p.time_bounds_lower
    FROM spherex.artifact a JOIN spherex.plane p ON a.planeid = p.planeid
    WHERE 1 = CONTAINS(POINT('ICRS', {ra}, {dec}), p.poly)
      AND p.energy_bandpassname = '{band}'
    ORDER BY p.time_bounds_lower
    """
    t = time.time()
    rows = Irsa.query_tap(q).to_table()
    print(f"{band}: {len(rows)} images, query {time.time() - t:.1f}s")
    return rows


def centroid(url, ra, dec, search_px=8):
    """Flux-weighted centroid of the brightest source near (ra, dec). Returns SkyCoord."""
    with fits.open(url, cache=False) as h:
        img = h["IMAGE"].data.astype(float)
        w = WCS(h["IMAGE"].header)
    x0, y0 = w.world_to_pixel(SkyCoord(ra * u.deg, dec * u.deg))
    yy, xx = np.indices(img.shape)
    near = (np.hypot(xx - x0, yy - y0) < search_px) & np.isfinite(img)
    y, x = np.unravel_index(np.argmax(np.where(near, img, -np.inf)), img.shape)
    stamp = np.nan_to_num(img[y - 2:y + 3, x - 2:x + 3] - np.nanmedian(img))
    off = np.arange(-2, 3)
    cy = (stamp * off[:, None]).sum() / stamp.sum() + y
    cx = (stamp * off[None, :]).sum() / stamp.sum() + x
    return w.pixel_to_world(cx, cy)


if __name__ == "__main__":
    rows = query(RA, DEC, BAND, SIZE_DEG)
    first, last = rows[0], rows[-1]
    c0 = centroid(first["uri"], RA, DEC)
    c1 = centroid(last["uri"], RA, DEC)
    years = (last["time_bounds_lower"] - first["time_bounds_lower"]) / 365.25
    dra = ((c1.ra - c0.ra) * np.cos(c0.dec)).to(u.arcsec).value
    ddec = (c1.dec - c0.dec).to(u.arcsec).value
    print(f"MJD {first['time_bounds_lower']:.1f} -> {last['time_bounds_lower']:.1f} ({years:.2f} yr)")
    print(f"Shift: dRA {dra:+.2f}\"  dDec {ddec:+.2f}\"  (expected dDec ~ {10.33 * years:+.2f}\")")
