"""Precomputed measurements next to every static cube: data/cubes/<obj>/<band>/measure.json (task A-07).

The backend serves these files as /cubes/<obj>/<band>/measure.json, so the demo objects have
their motion (and, once data/photometry.py is available, their light curves) without a live
IRSA query. The content is what data.motion.measure_shift_from_files returns, unchanged, plus:

    object, band        which cube this belongs to
    photometry          [] until data/photometry.py is on this branch, then its full output
    motion.status       "ok" or "unverified", with motion.note saying why (see `judge`):
                        faint in single images, too few epochs, or strongly variable
    motion.parallax_arcsec, motion.parallax_source
                        the catalogue parallax of the target, held fixed in the motion fit
                        (data/motion.py, "Parallax"): the Gaia DR3 source of catalog.json that is
                        at the cube centre at the time of the images; 0 and null if there is none
                        (WISE 0855 is not in Gaia). Not applied when the source found is not the
                        target. no_parallax and parallax_fit keep the errors of their own fit.
    motion.detector_agreement
                        null, or how the detectors of this object with status "ok" agree with
                        each other (chi-square about their weighted mean). If they disagree by
                        more than their errors allow, the errors of all of them are scaled up
                        (scale_ra, scale_dec) and the unscaled ones are kept in err_ra_fit,
                        err_dec_fit.
    source              which cache the raw cutouts came from and their IRSA releases

The measurement is made on the same raw cutouts the cube was built from: the cache whose
manifest holds every frame id of cube.json is used (the quick-release cache of 2026-11-10 or the
DR1 download of 2026-11-14). The position measured is the cube centre.

Every detector of one object is measured with the same photometry method: "wing" if the source
saturates in any detector, "aperture" otherwise, so that the points can share one axis. They are
then collected in data/cubes/<obj>/spectrum.json (docs/ARCHITECTURE.md, "Зургаан детектор"):

    { object, method, unit, note,
      neighbour: null | { east_arcsec, north_arcsec, sep_arcsec, bands },
      bands:  [{ band, n_images, n_ok, lam_min, lam_max, median_flux, median_snr, n_found, offset_arcsec,
                 detected, why_not }],
      points: [{ band, mjd, epoch, lam_um, flux, err, ok, why }] }     sorted by wavelength

data/cubes/<obj>/motion.json puts the detectors side by side (task A-14):

    { object, parallax_arcsec, parallax_source, note,
      detectors: [{ band, status, n_epochs, pm_ra, err_ra, pm_dec, err_dec, no_parallax, parallax_fit }],
      combined:  null | { bands, pm_ra, err_ra, pm_dec, err_dec, chi2_ra, chi2_dec },
      parallax_measured: null | { bands, parallax_arcsec, err, scatter, n_independent, sigma, distance_pc } }

`combined` is the weighted mean of the detectors with status "ok" (3 or more), its error scaled up
if they disagree. `parallax_measured` is the mean of their `parallax_fit` values (parallax as a free
parameter); its error is their scatter divided by the square root of the number of independent
pointings, not the formal errors, which are too small (see data/motion.py).

`detected` says whether the TARGET is seen in that detector: there is light (the median brightness
stands out from zero, DETECTED_SNR, or the source is found in at least half of the single images)
and the source found in the images is at the requested position, within one native pixel
(ON_TARGET_ARCSEC). The aperture is 15 arcsec in radius, so it also collects the light
of a neighbour: WISE 0855 has a Gaia star (G = 16.3) 8 arcsec away, which is all there is to see at
1-3.5 um. Such a detector gets detected = false with the reason in `why_not`, the neighbour is
described in `neighbour` and in `note`, and its motion is not reported as the target's
(motion.status = "unverified"). A point with ok = false keeps its reason in `why`.

Usage:  python -m data.measure_static [object ...] [--cubes DIR]     (default: every object)
"""
import argparse
import csv
import json
import sys
from pathlib import Path

import numpy as np

from data import catalog, cube, motion

try:  # arrives with PR #20; until then the files carry an empty photometry list
    from data import photometry
except ImportError:
    photometry = None

CUBES = cube.REPO / "data" / "cubes"

# A motion is called "ok" only if the source is clearly seen in single images. Otherwise the line
# through the epochs can come from noise peaks; WISE 0855 is the case in point: about 60% of its
# single images pass the SNR cut and the fitted motion changed from +0.9 to +5.2 arcsec/yr in
# declination between two processing versions of the same exposures (docs/DR1_VS_QR.md).
MIN_USED_FRACTION = 0.8
MIN_EPOCHS = 3
MIN_MEDIAN_SNR = 10.0
# A detector counts as a detection of the source if the median of its photometry points is this
# many (robust) standard errors above zero, with at least MIN_POINTS usable points.
DETECTED_SNR = 5.0
MIN_POINTS = 5
# ... or if the source is found (data/motion.py: a fit with SNR >= 5) in at least this share of the
# single images. The median test alone is blind to a source whose spectrum is far from flat: the
# scatter of the points is then the spectrum, not noise (Epsilon Indi B in D1: nothing at 0.75 um,
# 20 mJy at 1.05 um, found in 29 of 40 images at a median SNR of 68, yet the median is only 3.4
# standard errors from zero). On blank sky the fit finds a noise peak in 7 of 45 images (16%).
FOUND_FRACTION = 0.5
# The source found in the images counts as the target if its median position is within one native
# SPHEREx pixel (6.16 arcsec) of the requested one. On 2026-11-14 the five demo objects were at
# 0.6-2.9 arcsec in their well-measured detectors and WISE 0855 in D5, D6 (a moving, faint source)
# at 3.8 and 4.4; the Gaia star next to WISE 0855 was at 8.1-8.3 in D1-D4.
ON_TARGET_ARCSEC = 6.16
APERTURE_ARCSEC = 2.5 * 6.16  # photometry.R_APERTURE in arcsec
SPECTRUM_NOTE = {
    "aperture": "Brightness summed within 2.5 pixels (15 arcsec) of the source in every image, in mJy. "
                "No aperture correction is applied and the image of a star is wider at longer wavelengths, so "
                "the level can step at the boundaries between detectors; such steps are not corrected.",
    "wing": "The source saturates the detector, so each point is the mean surface brightness of the ring of light "
            "around it (3.5-6.5 pixels), in MJy/sr. This follows the brightness at a fixed wavelength but is not a "
            "calibrated flux: the ring holds a different share of the light at every wavelength, so the shape of "
            "this curve is not the spectrum of the star, and the level steps between detectors.",
}
# A source whose brightness changes this much between visits cannot be given a proper motion from
# its image centre alone. Inside one 6.16" pixel an unresolved neighbour moves the centre of light
# whenever one of the two changes brightness ("variability-induced motion", a known effect in
# Hipparcos and Gaia astrometry). Seen here on RW Aur, measured 2026-11-14: Gaia DR3 (through IRSA)
# lists two stars 1.49" apart at position angle 74 deg, 0.85 mag apart; our image centre sits 0.49"
# from the brighter one towards the other in 2025-08 and 0.27" further along the same line in
# 2026-08, after the system brightened 2.5-fold. That is 0.2 arcsec/yr of apparent motion with no
# star moving. The limit is far above what calibration can fake (about 4%, docs/DR1_VS_QR.md).
VARIABLE_FACTOR = 1.5
# The catalogue source that is the target: the Gaia source closest to the cube centre once it is
# moved to the time of the images, within half a native pixel.
PARALLAX_MATCH_ARCSEC = 3.0
# No parallax is typed in by hand: an object that Gaia does not have is fitted with a straight
# line. That is WISE 0855 (parallax 0.439", Kirkpatrick et al. 2021, ApJS 253, 7, Table 5). Tried on
# 2026-11-15 with that value held fixed: D5 gives pm_ra -7.20 +- 1.50 instead of -7.85 +- 0.75
# (Spitzer: -8.12), i.e. the visits fit the parallax swing worse than a straight line, and the free
# fit prefers -0.27 +- 0.27". Its positions are pulled by a Gaia star 8" away (see `neighbour`
# below), so they cannot carry a 0.4" correction; the motion stays "unverified" either way.
# Detectors 1 and 4, 2 and 5, 3 and 6 look at the same field at the same moment (in every object
# of data/cubes their visit dates coincide in these pairs), so six detectors are three independent
# sets of pointings, not six.
MIN_DETECTORS = 3


def candidate_caches():
    old = cube.cache_dir()
    # cache_control: cutouts of the blank-sky control cube (data/control_cube.py)
    return [old, old.parent / "cache_dr1", old.parent / "cache_control"]


def cutout_files(meta, caches=None):
    """Raw cutouts of the cube's frames, from the cache that has all of them. Returns (files, cache)."""
    ids = [f["id"] for f in meta["frames"]]
    for cache in caches or candidate_caches():
        manifest = Path(cache) / "manifest.csv"
        if not manifest.exists():
            continue
        with open(manifest, newline="", encoding="utf-8") as f:
            by_id = {Path(r["file"]).name[:-len(".fits")]: Path(cache) / r["file"] for r in csv.DictReader(f)
                     if r["object"] == meta["object"] and r["band"] == f"SPHEREx-{meta['band']}"}
        if all(i in by_id and by_id[i].exists() for i in ids):
            return [by_id[i] for i in ids], Path(cache)
    raise FileNotFoundError(f"no cache holds all {len(ids)} cutouts of cube {meta['object']} {meta['band']}; "
                            f"looked in {[str(c) for c in caches or candidate_caches()]}")


def variability(result):
    """Typical brightest/faintest ratio between visits at fixed wavelength (median over the bins); 1.0 if unknown."""
    ratios = []
    for c in result.get("light_curves", []):
        f = [p["flux"] for p in c["points"] if p["flux"] is not None and p["flux"] > 0]
        if len(f) >= 2:
            ratios.append(max(f) / min(f))
    return float(np.median(ratios)) if ratios else 1.0


def source_offset(result):
    """Median offset of the fitted source from the requested position: dict(east, north, sep) in
    arcsec, or None if no image gave a position."""
    good = [f for f in result["frames"] if f["ok"] and f.get("dra_arcsec") is not None]
    if not good:
        return None
    east = float(np.median([f["dra_arcsec"] for f in good]))
    north = float(np.median([f["ddec_arcsec"] for f in good]))
    return dict(east=round(east, 2), north=round(north, 2), sep=round(float(np.hypot(east, north)), 2))


def target_parallax(object_dir, ra, dec, mjd):
    """(parallax in arcsec, where it comes from) of the source at (ra, dec) at time `mjd`; (0.0, None) if unknown."""
    path = Path(object_dir) / "catalog.json"
    if path.exists():
        year = catalog.mjd_to_year(mjd)
        best = None
        for s in json.loads(path.read_text(encoding="utf-8"))["sources"]:
            if s["cat"] != "gaia_dr3" or s.get("parallax") is None or s["parallax"] <= 0:
                continue
            dt = year - s["epoch"]
            s_dec = s["dec"] + (s["pm_dec"] or 0.0) * dt / 3600.0
            s_ra = s["ra"] + (s["pm_ra"] or 0.0) * dt / 3600.0 / np.cos(np.radians(s["dec"]))
            sep = catalog.separation_arcsec(s_ra, s_dec, ra, dec)
            if sep <= PARALLAX_MATCH_ARCSEC and (best is None or sep < best[0]):
                best = (sep, s)
        if best:
            return float(best[1]["parallax"]), f"Gaia DR3 {best[1]['id']}"
    return 0.0, None


def judge(result):
    """("ok" | "unverified", note). Looks at how well the source is detected, whether it is where
    the target should be and whether its brightness is steady, never at the measured motion itself."""
    good = [f for f in result["frames"] if f["ok"]]
    reasons = []
    off = source_offset(result)
    if off and off["sep"] > ON_TARGET_ARCSEC:
        reasons.append(f"the source found in the images is {off['sep']:.1f} arcsec from the requested position, "
                       f"more than one pixel: probably another object, so this is not the motion of the target")
    if result["n_used"] < MIN_USED_FRACTION * result["n_frames"]:
        reasons.append(f"the source is found in only {result['n_used']} of {result['n_frames']} images")
    if len(result["epochs"]) < MIN_EPOCHS:
        reasons.append(f"only {len(result['epochs'])} epochs with a position")
    snr = float(np.median([f["snr"] for f in good])) if good else 0.0
    if snr < MIN_MEDIAN_SNR:
        reasons.append(f"median single-image SNR {snr:.1f}")
    factor = variability(result)
    if factor >= VARIABLE_FACTOR and snr >= MIN_MEDIAN_SNR:  # for a faint source the ratio is only noise
        # `factor` is the median over the wavelength bins of brightest / faintest visit; the page also
        # quotes the largest change in one bin (RW Aur: 2.5 times at 0.74-0.76 um against 1.6 here),
        # so the note has to say which of the two it is (issue #88)
        reasons.append(f"the brightness changes {factor:.1f}-fold between visits at a typical wavelength (the median over "
                       f"all wavelength bins of this detector; in a single bin the change can be larger), so the image "
                       f"centre can shift without any real motion if the source is an unresolved pair")
    if not reasons:
        return "ok", ""
    advice = ""
    if snr < MIN_MEDIAN_SNR:
        advice = " Too faint for single images; use shift-and-stack to show this object."
    elif result["saturated"]:
        advice = " The star saturates the detector; positions come from the wings of its image."
    return "unverified", "Not a confirmed measurement: " + "; ".join(reasons) + "." + advice


def measure_one(cube_dir, caches=None, method=None):
    """One detector measured by itself. `method` forces the photometry method. This is not yet
    the content of measure.json: see measure_object."""
    meta = json.loads((Path(cube_dir) / "cube.json").read_text(encoding="utf-8"))
    files, cache = cutout_files(meta, caches)
    ra, dec = meta["center"]["ra"], meta["center"]["dec"]
    source = dict(from_cache=True, cache=cache.name, position="cube centre")
    if "releases" in meta.get("source", {}):
        source["releases"] = meta["source"]["releases"]
    if photometry is not None:
        result = photometry.measure_from_files(files, ra, dec, meta["band"], source, method=method)
    else:
        result = motion.measure_shift_from_files(files, ra, dec, meta["band"], source)
        result["photometry"] = []
    result["source_offset_arcsec"] = off = source_offset(result)
    if result["motion"] is not None:
        # the parallax of the target, unless what the images show is another object
        if off is None or off["sep"] <= ON_TARGET_ARCSEC:
            parallax, where = target_parallax(Path(cube_dir).parent, ra, dec, float(np.mean([f["mjd"] for f in result["frames"]])))
            if parallax:
                motion.apply_parallax(result, parallax, where)
        result["motion"]["status"], result["motion"]["note"] = judge(result)
        result["motion"]["detector_agreement"] = None
    return dict(object=meta["object"], **result)


def write(cube_dir, caches=None):
    out = measure_cube(cube_dir, caches)
    path = Path(cube_dir) / "measure.json"
    _dump(out, path)
    return out, path


def _dump(obj, path):
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        json.dump(obj, f, indent=1, allow_nan=False)
        f.write("\n")


def band_summary(band, points, offset=None, n_found=0):
    """How one detector saw the target: counts, wavelength range and whether it is detected.

    Median and MAD, not mean and standard deviation: one cosmic-ray hit in an aperture (WISE 0855
    D6 has a 523 mJy point among points of 0.5 mJy, GitHub issue #42) would otherwise decide it.
    `offset` is source_offset() of that detector's measurement, `n_found` the number of images
    in which the source was found.
    """
    ok = [p for p in points if p["ok"]]
    out = dict(band=band, n_images=len(points), n_ok=len(ok),
               lam_min=round(min(p["lam_um"] for p in points), 4), lam_max=round(max(p["lam_um"] for p in points), 4),
               median_flux=None, median_snr=None, n_found=n_found, offset_arcsec=offset["sep"] if offset else None,
               detected=False, why_not="")
    snr = None
    if len(ok) >= 2:
        f = np.array([p["flux"] for p in ok])
        med = float(np.median(f))
        # standard error of a median for Gaussian scatter: 1.2533 * sigma / sqrt(n), sigma = 1.4826 * MAD
        sem = 1.2533 * 1.4826 * float(np.median(np.abs(f - med))) / np.sqrt(len(f))
        out["median_flux"] = round(med, 5)
        if sem > 0:
            snr = med / sem
            out["median_snr"] = round(snr, 1)
    light = (snr is not None and len(ok) >= MIN_POINTS and snr >= DETECTED_SNR) or             (len(points) >= MIN_POINTS and n_found >= FOUND_FRACTION * len(points))
    if not light:
        out["why_not"] = ("no significant light at the position: "
                          + (f"the median of {len(ok)} points is {snr:.1f} standard errors from zero"
                             if snr is not None else f"only {len(ok)} usable points")
                          + f" and a source is found in {n_found} of {len(points)} images")
    elif offset and offset["sep"] > ON_TARGET_ARCSEC:
        out["why_not"] = (f"the light in the aperture comes from another source, {offset['sep']:.1f} arcsec "
                          f"from the position ({_compass(offset)})")
    else:
        out["detected"] = True
    return out


def _compass(offset):
    ew = f"{abs(offset['east']):.1f} arcsec {'east' if offset['east'] >= 0 else 'west'}"
    ns = f"{abs(offset['north']):.1f} arcsec {'north' if offset['north'] >= 0 else 'south'}"
    return f"{ew}, {ns}"


def neighbour(results, bands):
    """The other source inside the aperture, if some detectors see one instead of the target:
    its median offset over those detectors, or None."""
    off = [(b["band"], r["source_offset_arcsec"]) for r, b in zip(results, bands)
           if b["why_not"].startswith("the light in the aperture comes from another source")]
    if not off:
        return None
    east = float(np.median([o["east"] for _, o in off]))
    north = float(np.median([o["north"] for _, o in off]))
    return dict(east_arcsec=round(east, 2), north_arcsec=round(north, 2),
                sep_arcsec=round(float(np.hypot(east, north)), 2), bands=[b for b, _ in off])


def spectrum(obj, results):
    """spectrum.json from the measure.json contents of all detectors of one object."""
    methods = {r["photometry_method"] for r in results}
    if len(methods) != 1:
        raise ValueError(f"{obj}: detectors were measured with different methods {sorted(methods)}")
    method = methods.pop()
    results = sorted(results, key=lambda r: r["band"])
    points, bands = [], []
    for r in results:
        pts = [dict(band=r["band"], mjd=p["mjd"], epoch=p["epoch"], lam_um=p["lam_um"], flux=p["flux"], err=p["err"],
                    ok=p["ok"], why=p["why"]) for p in r["photometry"]]
        points += pts
        bands.append(band_summary(r["band"], pts, r.get("source_offset_arcsec"), r["n_used"]))
    points.sort(key=lambda p: (p["lam_um"], p["mjd"]))
    note = SPECTRUM_NOTE[method]
    other = neighbour(results, bands)
    if other:
        where = _compass(dict(east=other["east_arcsec"], north=other["north_arcsec"]))
        inside = other["sep_arcsec"] <= APERTURE_ARCSEC
        note += (f" Another source lies {other['sep_arcsec']:.1f} arcsec from the position ({where}); in "
                 f"{', '.join(other['bands'])} it is what the images show, not the target."
                 + (" It is inside the 15 arcsec aperture, so the values in every detector include its light."
                    if inside else ""))
    return dict(object=obj, method=method, unit=results[0]["photometry_unit"], note=note, neighbour=other,
                bands=bands, points=points)


def _weighted(values, errors):
    """Weighted mean, its formal error and the chi-square of the values about it."""
    v, e = np.asarray(values, dtype=float), np.asarray(errors, dtype=float)
    w = 1.0 / e ** 2
    mean = float((w * v).sum() / w.sum())
    return mean, float(1.0 / np.sqrt(w.sum())), float((w * (v - mean) ** 2).sum())


def agree(results):
    """Make the detectors of one object answer for each other (task A-14, item 3).

    The detectors with status "ok" measure the same motion. If they differ by more than their
    error bars allow (chi-square about the weighted mean above its degrees of freedom), every
    one of those error bars is too small, and all are scaled up by sqrt(chi2 / dof), per axis.
    Nothing outside our own data is consulted. Changes the results in place; returns the
    `combined` entry of motion.json, or None with fewer than MIN_DETECTORS such detectors."""
    ok = [r for r in sorted(results, key=lambda r: r["band"]) if r["motion"] and r["motion"]["status"] == "ok"]
    if len(ok) < MIN_DETECTORS:
        return None
    dof = len(ok) - 1
    out = dict(bands=[r["band"] for r in ok])
    scale = {}
    for axis in ("ra", "dec"):
        mean, err, chi2 = _weighted([r["motion"][f"pm_{axis}"] for r in ok], [r["motion"][f"err_{axis}"] for r in ok])
        scale[axis] = max(1.0, float(np.sqrt(chi2 / dof)))
        out[f"pm_{axis}"], out[f"err_{axis}"], out[f"chi2_{axis}"] = round(mean, 3), round(err * scale[axis], 3), round(chi2, 2)
    for r in ok:
        m = r["motion"]
        m["detector_agreement"] = dict(n=len(ok), chi2_ra=out["chi2_ra"], chi2_dec=out["chi2_dec"], dof=dof,
                                       scale_ra=round(scale["ra"], 2), scale_dec=round(scale["dec"], 2))
        for axis in ("ra", "dec"):
            if scale[axis] > 1.0:
                m[f"err_{axis}_fit"] = m[f"err_{axis}"]
                m[f"err_{axis}"] = round(m[f"err_{axis}"] * scale[axis], 3)
        m["err"] = max(m["err_ra"], m["err_dec"])
    return dict(bands=out["bands"], pm_ra=out["pm_ra"], err_ra=out["err_ra"], pm_dec=out["pm_dec"], err_dec=out["err_dec"],
                chi2_ra=out["chi2_ra"], chi2_dec=out["chi2_dec"])


def parallax_measured(results):
    """The parallax of the object from our own images: the mean of the free-parallax fits of the
    detectors with status "ok", or None with fewer than MIN_DETECTORS of them.

    The error is the scatter of the detectors divided by sqrt(number of independent pointing
    sets), not their formal errors: on Epsilon Indi B those are 0.03-0.04" while the detectors
    differ by 0.08"."""
    ok = [r for r in sorted(results, key=lambda r: r["band"])
          if r["motion"] and r["motion"]["status"] == "ok" and r["motion"]["parallax_fit"]]
    if len(ok) < MIN_DETECTORS:
        return None
    v = np.array([r["motion"]["parallax_fit"]["parallax_arcsec"] for r in ok])
    n_ind = len({int(r["band"][1:]) % 3 for r in ok})
    scatter = float(v.std(ddof=1))
    mean, err = float(v.mean()), scatter / np.sqrt(n_ind)
    sigma = mean / err if err > 0 else 0.0
    return dict(bands=[r["band"] for r in ok], parallax_arcsec=round(mean, 3), err=round(err, 3), scatter=round(scatter, 3),
                n_independent=n_ind, sigma=round(sigma, 1),
                # a distance only if the parallax stands out from zero; 1 pc = 1 / parallax in arcsec
                distance_pc=round(1.0 / mean, 2) if sigma >= 3.0 else None)


MOTION_NOTE = ("Proper motion from the positions of the source in each visit, in arcsec per year (pm_ra is on the sky, "
               "times cos(dec)). The yearly parallax swing of the catalogue parallax is taken out before the line is "
               "fitted; no_parallax is the same fit without that. parallax_fit leaves the parallax free. Detectors "
               "1 and 4, 2 and 5, 3 and 6 share their pointings.")


def motion_summary(obj, results, combined):
    """motion.json: the motion of one object in all its detectors."""
    results = sorted(results, key=lambda r: r["band"])
    used = [r["motion"] for r in results if r["motion"] and r["motion"]["parallax_arcsec"]]
    dets = []
    for r in results:
        m = r["motion"]
        if m is None:
            dets.append(dict(band=r["band"], status=None, n_epochs=len(r["epochs"]), pm_ra=None, err_ra=None,
                             pm_dec=None, err_dec=None, no_parallax=None, parallax_fit=None))
            continue
        dets.append(dict(band=r["band"], status=m["status"], n_epochs=m["n_epochs"], pm_ra=m["pm_ra"], err_ra=m["err_ra"],
                         pm_dec=m["pm_dec"], err_dec=m["err_dec"], no_parallax=m["no_parallax"], parallax_fit=m["parallax_fit"]))
    return dict(object=obj, parallax_arcsec=used[0]["parallax_arcsec"] if used else 0.0,
                parallax_source=used[0]["parallax_source"] if used else None, note=MOTION_NOTE,
                detectors=dets, combined=combined, parallax_measured=parallax_measured(results))


def measure_object(object_dir, caches=None):
    """Every detector of one object: ({cube folder: content of its measure.json}, `combined` of motion.json).

    The detectors are not independent files. All are measured with one photometry method, and
    the error bars of their motions are checked against each other (`agree`)."""
    dirs = sorted(p.parent for p in Path(object_dir).glob("*/cube.json"))
    results = {d: measure_one(d, caches) for d in dirs}
    if photometry is not None:
        method = "wing" if any(r["photometry_auto_method"] == "wing" for r in results.values()) else "aperture"
        for d in dirs:
            if results[d]["photometry_method"] != method:
                results[d] = measure_one(d, caches, method)
    return results, agree(list(results.values()))


def measure_cube(cube_dir, caches=None):
    """The content of measure.json for one cube folder. The other detectors of the object are
    measured as well, because the result depends on them (measure_object)."""
    results, _ = measure_object(Path(cube_dir).parent, caches)
    return {d.name: r for d, r in results.items()}[Path(cube_dir).name]


def write_object(object_dir, caches=None):
    """measure.json for every detector of one object, its spectrum.json and its motion.json."""
    if photometry is None:
        raise RuntimeError("data/photometry.py is needed for the spectrum")
    results, combined = measure_object(object_dir, caches)
    dirs = sorted(results)
    for d in dirs:
        _dump(results[d], d / "measure.json")
    spec = spectrum(Path(object_dir).name, list(results.values()))
    _dump(spec, Path(object_dir) / "spectrum.json")
    _dump(motion_summary(Path(object_dir).name, list(results.values()), combined), Path(object_dir) / "motion.json")
    return list(results.values()), spec


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("objects", nargs="*", help="folders under data/cubes (default: all)")
    ap.add_argument("--cubes", type=Path, default=CUBES, help="folder with <object>/<band>/cube.json")
    args = ap.parse_args(argv)
    names = args.objects or sorted(p.name for p in args.cubes.iterdir() if p.is_dir() and any(p.glob("*/cube.json")))
    print("object            band used/all epochs  pm_ra            pm_dec           status      detected  med. SNR  cache")
    for name in names:
        results, spec = write_object(args.cubes / name)
        seen = {b["band"]: b for b in spec["bands"]}
        for r in sorted(results, key=lambda r: r["band"]):
            m = r["motion"]
            pm = "-                -               " if m is None else \
                f"{m['pm_ra']:+6.2f} +- {m['err_ra']:4.2f}  {m['pm_dec']:+6.2f} +- {m['err_dec']:4.2f}"
            b = seen[r["band"]]
            print(f"{r['object']:17s} {r['band']:4s} {r['n_used']:3d}/{r['n_frames']:<3d}  {len(r['epochs'])}      {pm}  "
                  f"{(m or {}).get('status', '-'):10s}  {'yes' if b['detected'] else 'no ':3s}       "
                  f"{b['median_snr'] if b['median_snr'] is not None else '-':>7}   {r['source']['cache']}"
                  + ("  [saturated]" if r["saturated"] else ""))
        print(f"{name}: spectrum.json, method {spec['method']} [{spec['unit']}], {len(spec['points'])} points, "
              f"{sum(p['ok'] for p in spec['points'])} usable")
    return 0


if __name__ == "__main__":
    sys.exit(main())
