"""Measure how a source moves between SPHEREx visits (level L3 in docs/ARCHITECTURE.md).

Positions are measured on the RAW cutouts, never on the display cube: resampling smooths the
pixels and would bias a centroid. For every image a pixel-integrated Gaussian is fitted to the
valid pixels around the source, the fitted pixel position goes to the sky through that image's
own WCS (TAN-SIP), and the per-image offsets are combined per epoch (visit) with a median.

Why a fit and not a flux-weighted centroid: the SPHEREx pixel is 6.16" and the cores of bright
stars are masked (NaN) or flagged as overflowed in most images of Barnard's Star. A moment
centroid is pulled away from every missing pixel; a model fitted to the remaining pixels is not.

    measure_shift(ra, dec, band="SPHEREx-D1")            files from the local cache, else IRSA
    measure_shift_from_files(files, ra, dec, band=None)  files supplied by the caller (backend)
    apply_parallax(result, parallax_arcsec, source)      refit the motion with a known parallax

Both return a dict (JSON-safe):
    epochs:  [{epoch, mjd, n, ra, dec, dra_arcsec, ddec_arcsec, err_ra, err_dec, err_arcsec}]
    motion:  {pm_ra, pm_dec, err_ra, err_dec, err,   arcsec/yr, pm_ra includes cos(dec); or null
              sys_ra, sys_dec, n_epochs,
              parallax_arcsec, parallax_source,      the parallax that was held fixed in the fit (0: none)
              no_parallax: {pm_ra, pm_dec, err_ra, err_dec},      the same fit with parallax = 0
              parallax_fit: null | {parallax_arcsec, err, pm_ra, pm_dec, err_ra, err_dec, chi2, dof}}
    dra_arcsec, ddec_arcsec, years                   last epoch minus first epoch, as measured
    frames:  per-image offsets and fit quality
Offsets are relative to the (ra, dec) passed in; dra is on the sky (multiplied by cos(dec)).

Limits, measured on the cache on 2026-11-14 (docs/progress/A.md):
  * An unsaturated star is good to about 0.1" per epoch (static Gaia star next to Barnard's Star).
  * A saturated star is not: with the core pixel masked, the position along one axis rests on
    the two flanking pixels only. Barnard's Star scatters by 2" from image to image in RA in
    its first epoch and the epoch medians disagree by more than their formal errors. Fitting the
    pipeline's own PSF/EPSF instead of a Gaussian, fitting the wings only, and using the DR1
    reprocessing all gave the same answer, so this is in the data, not in the model.
    Such sources get `saturated: true`; the scatter of the epochs about a straight line is
    reported as `sys_ra`/`sys_dec` and is included in the errors of the first-to-last shift.
  * The damage is along detector ROWS. Measured 2026-11-14: for Barnard's Star and R Dra the
    image-to-image scatter along rows is up to three times that along columns (1.8" against
    0.5"), and epoch medians along rows disagree by 2.6" at the same detector orientation; for
    the unsaturated RW Aur rows are no worse than columns. So for a saturated source the row
    component of an epoch position is not allowed to average down: the per-image row scatter
    (`row_scatter_arcsec`) is added, in quadrature, to the epoch errors in proportion to how
    much each sky axis lies along the rows of that epoch's images. With the detector aligned
    to the sky (Barnard's Star) this leaves declination precise and right ascension uncertain;
    in a field that rotates (R Dra, near the ecliptic pole) both axes are affected.

Parallax (task A-14, measured 2026-11-15). A nearby star is also displaced by the Earth's orbit,
by up to its parallax (Barnard's Star 0.547", Gaia DR3) in a yearly ellipse. SPHEREx visits a field
about every six months, at opposite sides of the orbit, so with a year of data the ellipse is
not averaged out: a line through visits of August, March and August turns the 1.0" swing between
March and August into 2 arcsec/yr of false motion. Barnard's Star in D5 gave pm_ra = -2.83 +- 0.19
without parallax (Gaia: -0.80; the three points happened to lie on a line, hence the small error)
and -0.78 +- 0.86 with the Gaia parallax held fixed; in D6 -3.04 +- 0.44 and -0.97 +- 0.56.
So the model is  offset(t) = start + pm * t + parallax * factor(t),  factor from the position of
the Earth (parallax_factors). The parallax is an INPUT: a catalogue value held fixed, 0 if none
is given. `parallax_fit` is the same model with the parallax free, for sources with 3+ visits:
on Epsilon Indi B it returns 0.17-0.37" in five detectors (Gaia: 0.271"). It is reported, never
used for `pm_ra`, `pm_dec`.
  * It fails on Barnard's Star (0.0 +- 0.3" over six detectors) and the reason is in the images.
    In the visit of 2025-08 the fitted position depends on which of the four exposures of a
    pointing it is: -1.7", +0.6", +1.9", +2.6" along detector rows, the same in D1, D5 and D6
    and in every pointing of that visit; a fainter star in the same cutouts, 77" away, stays
    within 0.2", so the WCS is not at fault. The star was then near the upper edge of the
    detector (rows 1500-1850 of 2040) and its core pixel carries the OVERFLOW flag in D5 and D6
    too, although it is not masked (`saturated` is false there). That visit therefore has a
    large error (0.47" in D5) and little weight in a fit with the parallax fixed; a free
    parallax depends on exactly that visit. Cause not established.
"""
import argparse
import json
import math
import sys
from pathlib import Path

import numpy as np
from astropy.io import fits
from astropy.wcs import WCS
from scipy.optimize import least_squares
from scipy.special import erf

from data import cube

SEARCH_PX = 2.5      # look for the source within this many native pixels (15") of the given position
FIT_RADIUS_PX = 3.5  # pixels within this radius of the peak enter the fit
MIN_VALID_FRAC = 0.6  # of the fit window must be usable pixels
MIN_SNR = 5.0
MIN_FRAMES_PER_EPOCH = 3
CACHE_MAX_SEP_ARCSEC = 75.0  # cached 0.05 deg cutouts are used if the target is this close to their centre

CORE_RADIUS_PX = 1.5  # masked pixels this close to the fitted centre mean "saturated core"


def read_raw(path):
    """IMAGE (NaN where the pipeline masked a pixel), its WCS and the exposure start (MJD).

    The FLAGS plane is deliberately not used to reject more pixels. Tried on 2026-11-14: around
    Barnard's Star the TRANSIENT and SUR_ERROR bits are set on about two thirds of the pixels
    within 3.5 px (the bright star itself triggers them), so masking them leaves nothing to fit,
    and masking only OVERFLOW changed the positions by less than their scatter. (The bit
    names are in every file: MP_<NAME> keywords up to l2b-v25, MSKNnnnn / MSKDnnnn in l2b-v27;
    data/cube.py flag_table reads both.)
    """
    with cube.quiet_astropy(), fits.open(path) as h:
        hdr = h["IMAGE"].header
        return h["IMAGE"].data.astype(np.float64), WCS(hdr), float(hdr["MJD-OBS"])


def _gauss_pixels(p, xx, yy):
    """Circular Gaussian integrated over each square pixel, plus a constant background."""
    x0, y0, flux, sigma, bg = p
    s = math.sqrt(2.0) * sigma
    gx = 0.5 * (erf((xx + 0.5 - x0) / s) - erf((xx - 0.5 - x0) / s))
    gy = 0.5 * (erf((yy + 0.5 - y0) / s) - erf((yy - 0.5 - y0) / s))
    return bg + flux * gx * gy


def fit_position(img, x0, y0, search_px=SEARCH_PX, fit_radius=FIT_RADIUS_PX):
    """Fit the source nearest to pixel (x0, y0). Returns a dict with ok=True/False and why."""
    ny, nx = img.shape
    yy, xx = np.indices(img.shape)
    bg0, noise = cube.clipped_median_sigma(img)
    near = (np.hypot(xx - x0, yy - y0) <= search_px) & np.isfinite(img)
    if not near.any() or not np.isfinite(noise) or noise <= 0:
        return dict(ok=False, why="no valid pixels at the position")
    py, px = np.unravel_index(np.argmax(np.where(near, img, -np.inf)), img.shape)
    # the brightest valid pixel can sit beside a masked core: start from the flux-weighted mean around it
    r = np.hypot(xx - px, yy - py)
    win = (r <= fit_radius) & np.isfinite(img)
    n_full = int((np.hypot(*np.meshgrid(np.arange(-5, 6), np.arange(-5, 6))) <= fit_radius).sum())
    if win.sum() < MIN_VALID_FRAC * n_full:
        return dict(ok=False, why=f"only {int(win.sum())} of {n_full} pixels usable")
    w = np.clip(img[win] - bg0, 0, None)
    if w.sum() <= 0:
        return dict(ok=False, why="no flux above the background")
    sx, sy = float((w * xx[win]).sum() / w.sum()), float((w * yy[win]).sum() / w.sum())
    start = [sx, sy, max(float(w.sum()), noise), 0.8, bg0]
    lo = [px - 2.0, py - 2.0, 0.0, 0.3, -np.inf]
    hi = [px + 2.0, py + 2.0, np.inf, 2.5, np.inf]
    start[0], start[1] = float(np.clip(start[0], lo[0] + 1e-3, hi[0] - 1e-3)), float(np.clip(start[1], lo[1] + 1e-3, hi[1] - 1e-3))
    try:
        res = least_squares(lambda p: _gauss_pixels(p, xx[win], yy[win]) - img[win], start, bounds=(lo, hi),
                            x_scale=[1, 1, max(start[2], 1e-6), 1, max(noise, 1e-6)])
    except ValueError as e:
        return dict(ok=False, why=f"fit failed: {e}")
    x, y, flux, sigma, bg = (float(v) for v in res.x)
    snr = flux / (noise * math.sqrt(4 * math.pi * sigma ** 2 + 1.0))  # matched-filter estimate
    core = np.hypot(xx - x, yy - y) <= CORE_RADIUS_PX
    out = dict(x=x, y=y, flux=flux, sigma_px=sigma, snr=snr, n_pix=int(win.sum()),
               core_masked=int((~np.isfinite(img[core])).sum()))
    if not res.success:
        return dict(out, ok=False, why="fit did not converge")
    if snr < MIN_SNR:
        return dict(out, ok=False, why=f"too faint (SNR {snr:.1f})")
    if min(x, y, nx - 1 - x, ny - 1 - y) < 2.0:
        return dict(out, ok=False, why="too close to the cutout edge")
    if abs(x - lo[0]) < 1e-2 or abs(x - hi[0]) < 1e-2 or abs(y - lo[1]) < 1e-2 or abs(y - hi[1]) < 1e-2:
        return dict(out, ok=False, why="fit ran into its position limit")
    return dict(out, ok=True, why="")


def measure_frame(path, ra, dec):
    """Offset of the fitted source from (ra, dec) in one cutout, in arcsec on the sky."""
    path = Path(path)
    img, wcs, mjd = read_raw(path)
    out = dict(id=path.name[:-len(".fits")], mjd=round(mjd, 6))
    with cube.quiet_astropy():
        x0, y0 = (float(v) for v in wcs.world_to_pixel_values(ra, dec))
        fit = fit_position(img, x0, y0)
        # position angle of the detector +y axis (columns), east of north; rows are perpendicular
        r1, d1 = wcs.pixel_to_world_values(x0, y0)
        r2, d2 = wcs.pixel_to_world_values(x0, y0 + 1.0)
        out["pa_deg"] = round(math.degrees(math.atan2(
            ((float(r2) - float(r1) + 180.0) % 360.0 - 180.0) * math.cos(math.radians(dec)), float(d2) - float(d1))), 2)
        if fit["ok"]:
            fra, fdec = (float(v) for v in wcs.pixel_to_world_values(fit["x"], fit["y"]))
            dra = ((fra - ra + 180.0) % 360.0 - 180.0) * math.cos(math.radians(dec)) * 3600.0
            out.update(dra_arcsec=round(dra, 3), ddec_arcsec=round((fdec - dec) * 3600.0, 3))
    out.update(ok=fit["ok"], why=fit["why"])
    for k in ("snr", "sigma_px", "core_masked"):
        if k in fit:
            out[k] = round(fit[k], 3) if isinstance(fit[k], float) else fit[k]
    return out


def _robust_mean(v):
    """Median, and its standard error from the MAD, after one 3-sigma clip."""
    v = np.asarray(v, dtype=float)
    med = np.median(v)
    sig = 1.4826 * np.median(np.abs(v - med))
    if sig > 0:
        v = v[np.abs(v - med) <= 3 * sig]
        med = np.median(v)
        sig = 1.4826 * np.median(np.abs(v - med))
    # 1.2533 = sqrt(pi/2): the median is that much noisier than the mean for Gaussian errors
    return float(med), float(1.2533 * sig / math.sqrt(len(v))), int(len(v))


def _line(t, y, e):
    """Weighted straight-line slope, its error, and the extra scatter of the points.

    With 3+ points the slope error is scaled up when the points scatter more than their own
    errors allow (parallax, saturation, WCS systematics), and `extra` is the scatter left after
    removing what those errors explain: sqrt(max(0, sum(resid^2)/(n-2) - mean(e^2))).
    """
    t, y, e = (np.asarray(a, dtype=float) for a in (t, y, e))
    w = 1.0 / e ** 2
    tm = (w * t).sum() / w.sum()
    sxx = (w * (t - tm) ** 2).sum()
    slope = (w * (t - tm) * y).sum() / sxx
    err, extra = math.sqrt(1.0 / sxx), 0.0
    if len(t) > 2:
        resid = y - (w * y).sum() / w.sum() - slope * (t - tm)
        err *= max(1.0, math.sqrt((w * resid ** 2).sum() / (len(t) - 2)))
        extra = math.sqrt(max(0.0, (resid ** 2).sum() / (len(t) - 2) - (e ** 2).mean()))
    return float(slope), float(err), float(extra)


def parallax_factors(ra, dec, mjd):
    """(east, north) displacement of a source at (ra, dec) in degrees, per unit of its parallax,
    seen from the Earth at `mjd`.

    With (X, Y, Z) the barycentric position of the Earth in au (ICRS axes):
        east  = X sin(ra) - Y cos(ra)
        north = X cos(ra) sin(dec) + Y sin(ra) sin(dec) - Z cos(dec)
    (Explanatory Supplement to the Astronomical Almanac, 3rd ed., sect. 7.2.2.3; the same
    expression as eq. 3.2 of the Hipparcos catalogue, vol. 1, with the sign of the observer's
    position.) tests/test_parallax.py checks it against astropy's own ICRS -> GCRS transformation.
    SPHEREx is in low Earth orbit: 7000 km is 5e-5 au, so the centre of the Earth is close enough.
    """
    from astropy.coordinates import get_body_barycentric  # imported here: slow to import
    from astropy.time import Time
    x, y, z = (float(v) for v in get_body_barycentric("earth", Time(mjd, format="mjd", scale="utc")).xyz.to_value("au"))
    a, d = math.radians(ra), math.radians(dec)
    return (x * math.sin(a) - y * math.cos(a),
            x * math.cos(a) * math.sin(d) + y * math.sin(a) * math.sin(d) - z * math.cos(d))


def fit_parallax(t, x, ex, y, ey, fe, fn):
    """Offset, motion and parallax fitted to both axes together (weighted least squares):
        x = x0 + pm_ra * t + parallax * fe,    y = y0 + pm_dec * t + parallax * fn.
    Needs 3+ epochs. Errors are scaled up when the points scatter more than their own errors
    allow, as in _line. None if the parallax cannot be told from a straight line (all visits
    at the same time of year)."""
    t, x, ex, y, ey, fe, fn = (np.asarray(a, dtype=float) for a in (t, x, ex, y, ey, fe, fn))
    n = len(t)
    if n < 3:
        return None
    a = np.zeros((2 * n, 5))
    a[:n, 0], a[:n, 2], a[:n, 4] = 1.0, t, fe
    a[n:, 1], a[n:, 3], a[n:, 4] = 1.0, t, fn
    b, e = np.concatenate([x, y]), np.concatenate([ex, ey])
    aw, bw = a / e[:, None], b / e
    if np.linalg.cond(aw) > 1e6:
        return None
    cov = np.linalg.inv(aw.T @ aw)
    # no star has a parallax above 0.77" (Proxima Centauri): a fit that cannot tell 1" from zero
    # says nothing, e.g. visits all at the same time of year
    if not cov[4, 4] > 0 or math.sqrt(cov[4, 4]) > 1.0:
        return None
    sol = cov @ aw.T @ bw
    chi2, dof = float(((aw @ sol - bw) ** 2).sum()), 2 * n - 5
    err = np.sqrt(np.diag(cov)) * max(1.0, math.sqrt(chi2 / dof))
    return dict(parallax_arcsec=round(float(sol[4]), 3), err=round(float(err[4]), 3),
                pm_ra=round(float(sol[2]), 3), pm_dec=round(float(sol[3]), 3),
                err_ra=round(float(err[2]), 3), err_dec=round(float(err[3]), 3),
                chi2=round(chi2, 2), dof=dof)


def fit_motion(epochs, ra, dec, parallax_arcsec=0.0, parallax_source=None):
    """Proper motion from the epoch positions, with the given parallax held fixed.

    Returns (motion dict, extra scatter in RA, extra scatter in Dec); see the module docstring."""
    t = [(e["mjd"] - epochs[0]["mjd"]) / 365.25 for e in epochs]
    x, ex = np.array([e["dra_arcsec"] for e in epochs]), [e["err_ra"] for e in epochs]
    y, ey = np.array([e["ddec_arcsec"] for e in epochs]), [e["err_dec"] for e in epochs]
    fac = np.array([parallax_factors(ra, dec, e["mjd"]) for e in epochs])
    fe, fn = fac[:, 0], fac[:, 1]
    pm_ra, e_ra, s_ra = _line(t, x - parallax_arcsec * fe, ex)
    pm_dec, e_dec, s_dec = _line(t, y - parallax_arcsec * fn, ey)
    plain = (pm_ra, e_ra, pm_dec, e_dec)
    if parallax_arcsec:
        plain = _line(t, x, ex)[:2] + _line(t, y, ey)[:2]
    motion = dict(pm_ra=round(pm_ra, 3), pm_dec=round(pm_dec, 3), err_ra=round(e_ra, 3),
                  err_dec=round(e_dec, 3), err=round(max(e_ra, e_dec), 3),
                  sys_ra=round(s_ra, 3), sys_dec=round(s_dec, 3), n_epochs=len(epochs),
                  parallax_arcsec=round(float(parallax_arcsec), 5), parallax_source=parallax_source,
                  no_parallax=dict(pm_ra=round(plain[0], 3), pm_dec=round(plain[2], 3),
                                   err_ra=round(plain[1], 3), err_dec=round(plain[3], 3)),
                  parallax_fit=fit_parallax(t, x, ex, y, ey, fe, fn))
    return motion, s_ra, s_dec


def _set_motion(out, parallax_arcsec, parallax_source):
    """Fill motion and the first-to-last shift of a result from its epochs."""
    epochs = out["epochs"]
    if len(epochs) < 2:
        return out
    first, last = epochs[0], epochs[-1]
    kept = {k: out["motion"][k] for k in ("status", "note") if out.get("motion") and k in out["motion"]}
    motion, s_ra, s_dec = fit_motion(epochs, out["ra"], out["dec"], parallax_arcsec, parallax_source)
    out["motion"] = dict(motion, **kept)
    # the shift is what was measured (parallax included); each of the two epochs carries the
    # epoch-to-epoch scatter as well as its own error
    out.update(dra_arcsec=round(last["dra_arcsec"] - first["dra_arcsec"], 3),
               ddec_arcsec=round(last["ddec_arcsec"] - first["ddec_arcsec"], 3),
               years=round((last["mjd"] - first["mjd"]) / 365.25, 4),
               err_dra=round(math.sqrt(first["err_ra"] ** 2 + last["err_ra"] ** 2 + 2 * s_ra ** 2), 3),
               err_ddec=round(math.sqrt(first["err_dec"] ** 2 + last["err_dec"] ** 2 + 2 * s_dec ** 2), 3))
    return out


def apply_parallax(result, parallax_arcsec, parallax_source):
    """Refit the motion of a result of measure_shift_from_files with a known parallax (arcsec),
    in place. `parallax_source` says where the value comes from."""
    return _set_motion(result, parallax_arcsec, parallax_source)


def _row_scatter(frames):
    """Robust image-to-image scatter (arcsec) of the offsets along detector rows, about each
    epoch's median, pooled over the epochs."""
    resid = []
    for e in {f["epoch"] for f in frames}:
        good = [f for f in frames if f["epoch"] == e and f["ok"]]
        if len(good) < MIN_FRAMES_PER_EPOCH:
            continue
        # unit vector along rows on the sky is (cos pa, -sin pa) in (east, north), up to sign
        rows = np.array([f["dra_arcsec"] * math.cos(math.radians(f["pa_deg"]))
                         - f["ddec_arcsec"] * math.sin(math.radians(f["pa_deg"])) for f in good])
        # images of one epoch can be taken with the detector turned by 180 deg, which flips the sign
        # of a row offset; take the scatter about the median separately for each orientation
        up = np.array([math.cos(math.radians(f["pa_deg"])) >= 0 for f in good])
        for sel in (up, ~up):
            if sel.sum() >= 2:
                resid.extend(rows[sel] - np.median(rows[sel]))
    resid = np.asarray(resid)
    return float(1.4826 * np.median(np.abs(resid - np.median(resid)))) if resid.size >= 3 else 0.0


def measure_shift_from_files(files, ra, dec, band=None, source=None, parallax_arcsec=0.0, parallax_source=None):
    """Positions per epoch and the motion of the source near (ra, dec), from raw cutout files.

    `parallax_arcsec` is held fixed in the motion fit; without one (0) the fit is a straight line."""
    frames = sorted((measure_frame(f, ra, dec) for f in files), key=lambda f: f["mjd"])
    if not frames:
        raise ValueError("no cutouts given")
    for f, e in zip(frames, cube.epoch_index([f["mjd"] for f in frames])):
        f["epoch"] = e
    cosd = math.cos(math.radians(dec))
    saturated = bool(np.median([f.get("core_masked", 0) for f in frames if f["ok"]] or [0]) >= 1)
    row_scatter = _row_scatter(frames) if saturated else 0.0
    epochs = []
    for e in sorted({f["epoch"] for f in frames}):
        good = [f for f in frames if f["epoch"] == e and f["ok"]]
        if len(good) < MIN_FRAMES_PER_EPOCH:
            continue
        dra, era, _ = _robust_mean([f["dra_arcsec"] for f in good])
        ddec, edec, _ = _robust_mean([f["ddec_arcsec"] for f in good])
        # a floor keeps one lucky epoch from dominating the line fit: 0.05" is 1/120 of a pixel
        era, edec = max(era, 0.05), max(edec, 0.05)
        if saturated:  # the row component does not average down (module docstring)
            pa = np.radians([f["pa_deg"] for f in good])
            era = math.sqrt(era ** 2 + row_scatter ** 2 * float(np.mean(np.cos(pa) ** 2)))
            edec = math.sqrt(edec ** 2 + row_scatter ** 2 * float(np.mean(np.sin(pa) ** 2)))
        epochs.append(dict(
            epoch=e, mjd=round(float(np.mean([f["mjd"] for f in good])), 4), n=len(good),
            ra=round(ra + dra / 3600.0 / cosd, 7), dec=round(dec + ddec / 3600.0, 7),
            dra_arcsec=round(dra, 3), ddec_arcsec=round(ddec, 3),
            err_ra=round(era, 3), err_dec=round(edec, 3), err_arcsec=round(math.sqrt((era ** 2 + edec ** 2) / 2), 3)))

    out = dict(ra=ra, dec=dec, band=cube.short_band(band) if band else None,
               n_frames=len(frames), n_used=sum(f["ok"] for f in frames),
               saturated=saturated, row_scatter_arcsec=round(row_scatter, 3),
               epochs=epochs, motion=None, dra_arcsec=None, ddec_arcsec=None, years=None,
               method="pixel-integrated Gaussian fit on raw cutouts, median per epoch",
               source=dict(archive="NASA/IPAC IRSA, SPHEREx Level 2 spectral image cutouts", **(source or {})),
               frames=frames)
    return _set_motion(out, parallax_arcsec, parallax_source)


def cached_files(ra, dec, band, cache=None):
    """Cached cutouts of `band` whose centre is within CACHE_MAX_SEP_ARCSEC of (ra, dec)."""
    import csv
    cache = Path(cache) if cache else cube.cache_dir()
    path = cache / "manifest.csv"
    if not path.exists():
        return []
    cosd = math.cos(math.radians(dec))
    files = []
    with open(path, newline="", encoding="utf-8") as f:
        for r in csv.DictReader(f):
            if r["band"] != f"SPHEREx-{band}":
                continue
            dx = ((float(r["center_ra"]) - ra + 180.0) % 360.0 - 180.0) * cosd * 3600.0
            dy = (float(r["center_dec"]) - dec) * 3600.0
            if math.hypot(dx, dy) <= CACHE_MAX_SEP_ARCSEC and (cache / r["file"]).exists():
                files.append(cache / r["file"])
    return files


def live_files(ra, dec, band):
    """Cutouts centred on (ra, dec) straight from IRSA, through the backend's client (retry,
    disk cache, at most 8 requests at a time: backend/irsa.py)."""
    from backend import irsa  # imported here: only needed off-cache, and backend imports data
    client = irsa.IrsaClient()
    rows = client.query_images(ra, dec, f"SPHEREx-{band}")
    got = client.fetch_cutouts([r["uri"] for r in rows], ra, dec)
    return [p for p in got if isinstance(p, Path)]


def measure_shift(ra_deg, dec_deg, band="SPHEREx-D1", cache=None, parallax_arcsec=0.0, parallax_source=None):
    """Motion of the source near (ra_deg, dec_deg) in one detector.

    Uses the pre-fetched cache when the position lies inside cached cutouts (the five demo
    objects and their surroundings), otherwise downloads cutouts from IRSA.
    """
    band = cube.short_band(band)
    files = cached_files(ra_deg, dec_deg, band, cache)
    from_cache = bool(files)
    if not files:
        files = live_files(ra_deg, dec_deg, band)
    if not files:
        raise ValueError(f"no SPHEREx {band} images cover RA {ra_deg}, Dec {dec_deg}")
    return measure_shift_from_files(files, ra_deg, dec_deg, band, source=dict(from_cache=from_cache),
                                    parallax_arcsec=parallax_arcsec, parallax_source=parallax_source)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("ra", type=float)
    ap.add_argument("dec", type=float)
    ap.add_argument("band", nargs="?", default="SPHEREx-D1")
    ap.add_argument("--parallax", type=float, default=0.0, help="known parallax in arcsec, held fixed in the fit")
    ap.add_argument("--json", action="store_true", help="print the full result as JSON")
    args = ap.parse_args(argv)
    r = measure_shift(args.ra, args.dec, args.band, parallax_arcsec=args.parallax,
                      parallax_source="command line" if args.parallax else None)
    if args.json:
        print(json.dumps(r, indent=1, allow_nan=False))
        return 0
    print(f"RA {r['ra']} Dec {r['dec']} {r['band']}: {r['n_used']} of {r['n_frames']} images measured"
          f" ({'cache' if r['source'].get('from_cache') else 'IRSA'})")
    for e in r["epochs"]:
        print(f"  epoch {e['epoch']}: MJD {e['mjd']:.1f}  n={e['n']:2d}  dRA {e['dra_arcsec']:+7.2f} +- {e['err_ra']:.2f}\""
              f"   dDec {e['ddec_arcsec']:+7.2f} +- {e['err_dec']:.2f}\"")
    if r["motion"]:
        m = r["motion"]
        print(f"  first -> last epoch: dRA {r['dra_arcsec']:+.2f} +- {r['err_dra']:.2f}\"  dDec {r['ddec_arcsec']:+.2f}"
              f" +- {r['err_ddec']:.2f}\"  over {r['years']:.2f} yr"
              + ("   [saturated core: one axis is unreliable]" if r["saturated"] else ""))
        print(f"  motion: pm_ra {m['pm_ra']:+.2f} +- {m['err_ra']:.2f}  pm_dec {m['pm_dec']:+.2f} +- {m['err_dec']:.2f}  arcsec/yr"
              f"   (parallax held at {m['parallax_arcsec']:.3f}\")")
        if m["parallax_arcsec"]:
            n = m["no_parallax"]
            print(f"  without parallax: pm_ra {n['pm_ra']:+.2f} +- {n['err_ra']:.2f}  pm_dec {n['pm_dec']:+.2f} +- {n['err_dec']:.2f}")
        if m["parallax_fit"]:
            p = m["parallax_fit"]
            print(f"  parallax left free: {p['parallax_arcsec']:+.2f} +- {p['err']:.2f}\"  pm_ra {p['pm_ra']:+.2f} +- {p['err_ra']:.2f}"
                  f"  pm_dec {p['pm_dec']:+.2f} +- {p['err_dec']:.2f}  (chi2 {p['chi2']:.1f} for {p['dof']})")
    else:
        print("  fewer than two usable epochs: no motion")
    return 0


if __name__ == "__main__":
    sys.exit(main())
