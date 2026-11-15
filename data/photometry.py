"""Brightness of a source in every SPHEREx image: light curves and a spectrum (level L3).

Measured on the RAW cutouts. Two methods, chosen once per source so that all points of a light
curve are comparable (docs/DECISIONS.md, 2026-11-10):

  aperture  sum of the background-subtracted pixels within 2.5 px, in mJy. For ordinary stars.
  wing      mean surface brightness in the ring 3.5-6.5 px, in MJy/sr. For saturated stars,
            whose core pixels the pipeline masks (NaN): the wings of the PSF are still valid
            and scale with the star's flux. Tested on R Dra in experiments/saturated_check.py.
            Not usable for faint stars (the ring is then mostly noise) and not a calibrated flux.

The background is the clipped median in a ring around the source: 7-11 px for the aperture,
10-15 px for the wing method (it must lie outside the wings that are being measured).

SPHEREx uses a linear variable filter: every image sees the source at its own wavelength
(`lam_um`). A change of flux between two images is only a change in time if the two wavelengths
agree; otherwise it is the star's spectrum. `light_curves` therefore groups the points into
wavelength bins of 0.02 um (about one resolution element in detectors 1-4) and gives one value
per visit and bin; a visit is a run of images with no gap longer than 3 days (deep fields such as
R Dra are observed for months on end, so the 20-day epochs of the motion code are too coarse). The raw `photometry` list (flux against lam_um) is the spectrum.

    measure(ra, dec, band)                    files from the cache, else IRSA; motion + photometry
    measure_from_files(files, ra, dec, band)  same for files supplied by the caller (backend)

The result is the dict of data.motion.measure_shift_from_files plus
    photometry:        [{id, mjd, epoch, lam_um, flux, err, ok, why}]
    photometry_method: "aperture" | "wing",  photometry_unit: "mJy" | "MJy/sr"
    light_curves:      [{lam_min, lam_max, points: [{mjd, flux, err, n}]}]
"""
import argparse
import json
import math
import sys
from pathlib import Path

import numpy as np
from astropy.io import fits
from astropy.wcs.utils import proj_plane_pixel_area

from data import cube, motion

R_APERTURE = 2.5                 # px
R_WING_IN, R_WING_OUT = 3.5, 6.5  # px
R_BG_WING = (10.0, 15.0)          # px, background ring of the wing method (experiments/saturated_check.py)
R_BG_APERTURE = (7.0, 11.0)       # px, closer in: also fits for sources away from the cutout centre
VISIT_GAP_DAYS = 3.0
MIN_RING_FRAC = 0.5              # of the ring pixels must be valid
SATURATED_FRAC = 0.2             # wing method if more than this share of images has a masked pixel in the aperture
# A point is dropped as hit by a cosmic ray or a passing artifact only if ALL THREE hold (GitHub issue #42):
#   1. the pipeline flagged a pixel of the measured region with one of ARTIFACT_FLAGS;
#   2. the point lies more than OUTLIER_SIGMA robust sigma from the median of the other points of its visit;
#   3. it lies as far from the straight line through the K_NEAR points nearest to it in
#      wavelength, taken from all visits.
# Flags alone are not enough: bright stars carry TRANSIENT on most of their pixels and measure fine.
# The visit alone is not enough either: every image of a visit is at another wavelength, so a real
# spectral feature stands out from its visit. Seen on 2026-11-14: Epsilon Indi B at 1.2147 um gave
# 28.5 mJy against 13.9 for the rest of its visit and carried TRANSIENT, but four other visits
# measured 24-32 mJy within 0.02 um of it: the rise to the J-band peak of a T dwarf, not an artifact.
# The nearest points, not a fixed window: a detector gives 40-150 points over 0.35-1.3 um, so a
# window narrow enough for a steep spectrum is empty where the sampling is sparse (D4). A line,
# not a median: where the spectrum climbs (Epsilon Indi B, 3.4-3.7 um: 12 -> 41 mJy) the median of
# the neighbours is far from every one of them. The scatter about the line widens at a peak or a
# band edge and with real variability between visits, which makes the rule more cautious exactly
# there. Neighbours farther than LAM_NEAR_FRAC in wavelength do not count; with fewer than
# MIN_NEAR of them, or with all of them on one side (the line would be extrapolated: R Dra at the
# red end of D6, where the wing brightness triples within 0.05 um), a point cannot be checked and
# is kept.
# The rule is applied to aperture photometry only. The wing method is for saturated stars, and
# their own image sets TRANSIENT in the ring in nearly every exposure (R Dra: 99% of the points,
# Barnard's Star: 47-97% per detector, against 4-27% for the faint Epsilon Indi B and WISE 0855), so
# there the flag singles nothing out and the rule would be a plain outlier cut on a variable star.
ARTIFACT_FLAGS = ("TRANSIENT", "OUTLIER", "SNOWBALL", "STREAK")
OUTLIER_SIGMA = 5.0
K_NEAR = 6
LAM_NEAR_FRAC = 0.05
MIN_NEAR = 4
LAM_BIN_UM = 0.02
SR_PER_DEG2 = (math.pi / 180.0) ** 2


def _ring_area(r_in, r_out):
    return math.pi * (r_out ** 2 - r_in ** 2)  # pixels in a full ring, whatever the sub-pixel centre


def _background(img, r, fin, ring):
    """Clipped median, its squared error and the pixel scatter in a ring; None if too little of it is on the cutout."""
    pix = img[(r >= ring[0]) & (r <= ring[1]) & fin]
    if pix.size < MIN_RING_FRAC * _ring_area(*ring):
        return None
    bg, sig = cube.clipped_median_sigma(pix)
    return bg, sig ** 2 / pix.size, sig


def measure_frame(path, ra, dec):
    """Aperture and wing brightness of one cutout at the sky position (ra, dec)."""
    path = Path(path)
    img, wcs, lam = cube.read_cutout(path, ra, dec)
    with cube.quiet_astropy(), fits.open(path) as h:
        var = h["VARIANCE"].data.astype(np.float64) if "VARIANCE" in h else np.full(img.shape, np.nan)
        mjd = float(h["IMAGE"].header["MJD-OBS"])
        x0, y0 = (float(v) for v in wcs.world_to_pixel_values(ra, dec))
        omega = float(proj_plane_pixel_area(wcs)) * SR_PER_DEG2  # sr per pixel
    out = dict(id=path.name[:-len(".fits")], mjd=round(mjd, 6),
               lam_um=round(lam, 5) if lam is not None and math.isfinite(lam) else None)
    yy, xx = np.indices(img.shape)
    r = np.hypot(xx - x0, yy - y0)
    flags, table = cube.read_flags(path)

    def flag_names_in(region):
        if flags.shape != img.shape:
            return []
        bits = {b for v in flags[region] for b in range(32) if v >> b & 1}
        return sorted(table[b][0] if b in table else f"bit{b}" for b in bits
                      if table.get(b, ("",))[0] not in cube.INFORMATIONAL_FLAGS)
    fin = np.isfinite(img)
    ap = r <= R_APERTURE
    ny, nx = img.shape
    on_cutout = min(x0, y0, nx - 1 - x0, ny - 1 - y0) >= R_APERTURE + 0.5
    out["core_masked"] = int((ap & ~fin).sum()) if on_cutout else None
    out["flags_aperture"] = flag_names_in(ap)
    out["flags_wing"] = flag_names_in((r >= R_WING_IN) & (r <= R_WING_OUT))
    out.update(ok_aperture=False, ok_wing=False)

    b = _background(img, r, fin, R_BG_APERTURE)
    if b and on_cutout and out["core_masked"] == 0:
        bg, bg_err2, sig = b
        n = int(ap.sum())
        v = var[ap]
        photon = float(v.sum()) if np.isfinite(v).all() else n * sig ** 2
        out.update(ok_aperture=True, aperture=float((img[ap] - bg).sum() * omega * 1e9),  # MJy -> mJy
                   aperture_err=float(math.sqrt(photon + n ** 2 * bg_err2) * omega * 1e9))

    b = _background(img, r, fin, R_BG_WING)
    good = (r >= R_WING_IN) & (r <= R_WING_OUT) & fin
    if b and good.sum() >= MIN_RING_FRAC * _ring_area(R_WING_IN, R_WING_OUT):
        bg, bg_err2, sig = b
        n = int(good.sum())
        v = var[good]
        photon = float(v.sum()) / n ** 2 if np.isfinite(v).all() else sig ** 2 / n
        out.update(ok_wing=True, wing=float(img[good].mean() - bg), wing_err=float(math.sqrt(photon + bg_err2)))
    out["why"] = "" if (out["ok_aperture"] or out["ok_wing"]) else "masked or too close to the cutout edge"
    return out


def light_curves(points, width=LAM_BIN_UM, gap=VISIT_GAP_DAYS):
    """Medians per visit in wavelength bins; only bins with at least two visits."""
    pts = sorted((p for p in points if p["ok"]), key=lambda p: p["mjd"])
    if not pts:
        return []
    curves = []
    first = math.floor(min(p["lam_um"] for p in pts) / width)
    last = math.floor(max(p["lam_um"] for p in pts) / width)
    for k in range(first, last + 1):
        sel = [p for p in pts if math.floor(p["lam_um"] / width) == k]
        visits = []
        for p in sel:
            if visits and p["mjd"] - visits[-1][-1]["mjd"] <= gap:
                visits[-1].append(p)
            else:
                visits.append([p])
        out = []
        for g in visits:
            f = np.array([p["flux"] for p in g])
            # error of the point: the larger of the formal error and the scatter within the visit
            formal = math.sqrt(sum(p["err"] ** 2 for p in g)) / len(g)
            scatter = float(f.std(ddof=1) / math.sqrt(len(g))) if len(g) > 1 else 0.0
            out.append(dict(mjd=round(float(np.mean([p["mjd"] for p in g])), 4),
                            flux=round(float(np.median(f)), 5), err=round(max(formal, scatter), 5), n=len(g)))
        if len(out) >= 2:
            curves.append(dict(lam_min=round(k * width, 4), lam_max=round((k + 1) * width, 4), points=out))
    return curves


METHODS = {"aperture": "mJy", "wing": "MJy/sr"}


def _robust(values, floor):
    """Median and robust sigma (1.4826 MAD, not below `floor`) of a list of fluxes."""
    v = np.asarray(values, dtype=float)
    med = float(np.median(v))
    return med, max(1.4826 * float(np.median(np.abs(v - med))), floor)


def _local(near, lam, floor):
    """Expected flux at `lam` and robust sigma from neighbours [(lam, flux)]: a least-squares line
    if they span a range of wavelengths, their median if they are all at one wavelength."""
    x = np.array([n[0] for n in near], dtype=float)
    y = np.array([n[1] for n in near], dtype=float)
    if np.ptp(x) <= 0:
        return _robust(y, floor)
    slope, const = np.polyfit(x - lam, y, 1)
    resid = y - (const + slope * (x - lam))
    return float(const), max(1.4826 * float(np.median(np.abs(resid - np.median(resid)))), floor)


def reject_artifacts(points, unit=""):
    """Mark points hit by a cosmic ray or a passing artifact as not usable (in place).

    All three conditions listed at ARTIFACT_FLAGS must hold. The first comparison is with the other
    usable points of the same visit (epoch), at least four of them; the second with the K_NEAR
    usable points of any visit nearest in wavelength (ties at the last place all count), through
    which a straight line is drawn. All
    points are judged against the data as measured, then the verdicts are applied together.
    """
    usable = [p for p in points if p["ok"]]
    verdicts = []
    for p in usable:
        hit = [f for f in p.get("flags", []) if f in ARTIFACT_FLAGS]
        if not hit:
            continue
        visit = [q["flux"] for q in usable if q is not p and q["epoch"] == p["epoch"]]
        cand = sorted((abs(q["lam_um"] - p["lam_um"]), q["lam_um"], q["flux"]) for q in usable
                      if q is not p and abs(q["lam_um"] - p["lam_um"]) <= LAM_NEAR_FRAC * p["lam_um"])
        reach = cand[min(K_NEAR, len(cand)) - 1][0] if cand else 0.0
        near = [(lam, f) for d, lam, f in cand if d <= reach]
        if len(visit) < 4 or len(near) < MIN_NEAR:
            continue
        if not min(n[0] for n in near) <= p["lam_um"] <= max(n[0] for n in near):
            continue  # all neighbours on one side: no extrapolation
        v_med, v_sig = _robust(visit, p["err"])
        n_med, n_sig = _local(near, p["lam_um"], p["err"])
        if v_sig > 0 and abs(p["flux"] - v_med) > OUTLIER_SIGMA * v_sig and abs(p["flux"] - n_med) > OUTLIER_SIGMA * n_sig:
            verdicts.append((p, f"cosmic ray or artifact in the measured pixels ({', '.join(hit)}): "
                                f"{p['flux']:.4g} {unit} against {n_med:.3g} at the nearest wavelengths in all visits "
                                f"and {v_med:.3g} for the rest of the visit"))
    for p, why in verdicts:
        p["ok"], p["flux"], p["err"], p["why"] = False, None, None, why


def measure_from_files(files, ra, dec, band=None, source=None, method=None):
    """Motion and photometry of the source near (ra, dec) from raw cutout files.

    `method`: None picks "wing" for a saturated source and "aperture" otherwise, from these
    images alone. Pass "aperture" or "wing" to force it, e.g. to measure every detector of one
    object the same way. `photometry_auto_method` in the result always says what None would pick.
    """
    if method is not None and method not in METHODS:
        raise ValueError(f"unknown photometry method {method!r}; use one of {sorted(METHODS)}")
    files = [Path(f) for f in files]
    result = motion.measure_shift_from_files(files, ra, dec, band, source)
    # follow the source: measure each image at the position found for its epoch
    centre = {e["epoch"]: (e["ra"], e["dec"]) for e in result["epochs"]}
    epoch_of = {f["id"]: f["epoch"] for f in result["frames"]}
    frames = []
    for f in files:
        e = epoch_of[f.name[:-len(".fits")]]
        m = measure_frame(f, *centre.get(e, (ra, dec)))
        m["epoch"] = e
        frames.append(m)
    frames.sort(key=lambda m: m["mjd"])

    known = [m for m in frames if m["core_masked"] is not None]
    saturated = bool(known) and np.mean([m["core_masked"] > 0 for m in known]) > SATURATED_FRAC
    auto = "wing" if saturated else "aperture"
    method = method or auto
    unit = METHODS[method]
    points = []
    for m in frames:
        ok = bool(m[f"ok_{method}"]) and m["lam_um"] is not None
        why = "" if ok else ("no wavelength is defined at this position in this image" if m["lam_um"] is None else
                             m["why"] or ("masked pixel in the aperture" if method == "aperture" else "wing ring not usable"))
        points.append(dict(
            id=m["id"], mjd=m["mjd"], epoch=m["epoch"], lam_um=m["lam_um"],
            flux=round(m[method], 5) if ok else None, err=round(m[f"{method}_err"], 5) if ok else None,
            ok=ok, why=why,
            flags=m.get(f"flags_{method}", [])))
    if method == "aperture":  # see the comment at ARTIFACT_FLAGS
        reject_artifacts(points, unit)
    result.update(photometry=points, photometry_method=method, photometry_auto_method=auto, photometry_unit=unit,
                  photometry_note=("mean surface brightness of the PSF wings (ring 3.5-6.5 px); proportional to the "
                                   "flux at a fixed wavelength, not a calibrated flux" if method == "wing" else
                                   "sum within 2.5 px, no aperture correction"),
                  light_curves=light_curves(points))
    # how many images have each pipeline flag inside the measured pixels (informational bits left out)
    counts = {}
    for q in points:
        for name in q["flags"]:
            counts[name] = counts.get(name, 0) + 1
    result["photometry_flags"] = dict(sorted(counts.items()))
    if method == "aperture" and counts.get("OVERFLOW"):
        result["photometry_note"] += (
            f"; in {counts['OVERFLOW']} of {len(points)} images the pipeline marks a pixel of the aperture as "
            "overflowed (the source is near saturation there), so those values may be too low")
    return result


def measure(ra_deg, dec_deg, band="SPHEREx-D1", cache=None):
    """Cache if the position lies inside cached cutouts, otherwise IRSA (see data.motion.measure_shift)."""
    band = cube.short_band(band)
    files = motion.cached_files(ra_deg, dec_deg, band, cache)
    from_cache = bool(files)
    if not files:
        files = motion.live_files(ra_deg, dec_deg, band)
    if not files:
        raise ValueError(f"no SPHEREx {band} images cover RA {ra_deg}, Dec {dec_deg}")
    return measure_from_files(files, ra_deg, dec_deg, band, source=dict(from_cache=from_cache))


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("ra", type=float)
    ap.add_argument("dec", type=float)
    ap.add_argument("band", nargs="?", default="SPHEREx-D1")
    ap.add_argument("--json", action="store_true", help="print the full result as JSON")
    args = ap.parse_args(argv)
    r = measure(args.ra, args.dec, args.band)
    if args.json:
        print(json.dumps(r, indent=1, allow_nan=False))
        return 0
    ok = [p for p in r["photometry"] if p["ok"]]
    print(f"RA {r['ra']} Dec {r['dec']} {r['band']}: method {r['photometry_method']} [{r['photometry_unit']}], "
          f"{len(ok)} of {len(r['photometry'])} images ({'cache' if r['source'].get('from_cache') else 'IRSA'})")
    for c in r["light_curves"]:
        pts = "  ".join(f"{p['mjd']:.0f}: {p['flux']:.2f}+-{p['err']:.2f}" + (f" (n={p['n']})" if p["n"] > 1 else "")
                        for p in c["points"])
        print(f"  {c['lam_min']:.2f}-{c['lam_max']:.2f} um  {pts}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
