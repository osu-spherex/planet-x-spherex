"""Build the aligned display cube (level L1 in docs/ARCHITECTURE.md) for one object and detector.

Reads the cutouts listed in the local cache manifest (written by experiments/prefetch_cache.py),
reprojects every image onto one common grid, subtracts a constant background per frame and writes

    <out>/cube.json   metadata, one entry per frame
    <out>/cube.f32    little-endian float32, shape N x H x W, MJy/sr, NaN = no valid data
    <out>/flags.u8    uint8, shape N x H x W: 1 where the SPHEREx pipeline flagged the pixel (see FLAGS below)

Grid: square, 3 arcsec pixels, tangent projection centred on the requested position. The field
of view is 3, 6 or 10 arcmin (`fov_arcmin`, default 3), which gives H = W = fov * 20 + 1 pixels:
61, 121 or 201. A wider field costs little more to download (most of a cutout file is the PSF
extension, not the image) and keeps a fast mover inside the picture when only an old catalogue
position is known. In a 6' or 10' cube every frame also carries `center_cover`: the share of the
middle 61 x 61 pixels (the 3' field, where the stack and the velocity search work) that holds
data. No frame is left out for an empty rim: a cutout cut off at a detector edge, or a narrower
cutout, gives a frame with a high `nan_frac` and a `center_cover` near 1 (GitHub issue #65).
Row 0 is the NORTH edge and column 0 the EAST edge, so drawing the array top-down on a canvas
gives the usual sky view (north up, east left). For 0-based pixel (x, y) and c = (W - 1) / 2:
    east offset  = (c - x) * 3 arcsec        north offset = (c - y) * 3 arcsec

The cube is for display only. Positions and fluxes are measured on the raw cutouts
(docs/ARCHITECTURE.md, level L3): the bilinear resampling used here smooths the pixels.
NaN marks cube pixels outside the cutout and pixels the SPHEREx pipeline masked, which
includes the saturated cores of bright stars (Barnard's Star, R Dra) -- expect a small hole there.

FLAGS. Every SPHEREx image comes with a FLAGS plane: one bit per reason a pixel may be unsafe
(cosmic-ray hit, overflow, hot pixel, ...). The meaning of each bit is written in the file itself:
keywords MSKNnnnn / MSKDnnnn (name and description of bit nnnn) in l2b-v27 files, MP_<NAME> = bit
in l2b-v20..v25 (https://caltech-ipac.github.io/irsa-tutorials/spherex-intro/). cube.json carries
that table (`flag_names`, `flag_descriptions`) and, per frame, `flags.any_frac` (share of raw
pixels within 15 arcsec of the centre with a flag) and `flags.center_bits` (the bits set there).
Two bits are information, not defects, and are left out of `any_frac` and flags.u8: SOURCE
("Pixel mapped to a known source") and FULLSAMPLE ("Pixel full sample history is available");
they are listed in `flags_informational` and still appear in `center_bits`.

Usage:  python -m data.cube barnard SPHEREx-D1 [--out DIR] [--cache-dir DIR] [--fov 3|6|10]
"""
import argparse
import csv
import json
import os
import subprocess
import sys
import warnings
from contextlib import contextmanager
from pathlib import Path

import astropy.units as u
import numpy as np
from astropy import log as astropy_log
from astropy.io import fits
from astropy.wcs import WCS
from astropy.wcs.utils import proj_plane_pixel_scales
from reproject import reproject_interp

PIXSCALE = 3.0       # arcsec per cube pixel; the native SPHEREx pixel is 6.16 arcsec
DEFAULT_FOV = 3      # arcmin; the five demo cubes and the original interface
# Field of view (arcmin) -> cutout size (deg) to ask IRSA for (docs/ARCHITECTURE.md, "Интерфейсийн
# нэмэлт"). Each cutout is a little wider than the grid (3.0, 6.6, 10.8 arcmin), so the grid is
# covered along the image axes. Cutouts come in detector orientation, which is rotated against
# north by any angle; at 45 deg the grid corners stick out (they stay NaN, as in the 3' cubes).
CUTOUT_SIZE_DEG = {3: 0.05, 6: 0.11, 10: 0.18}
GRID = 61            # pixels per side at the default field of view (kept for older callers)
EPOCH_GAP_DAYS = 20  # images further apart than this belong to different epochs (visits)
# Half-size of the box around the centre that the stack and the velocity search work in
# (frontend/viewer/stackView.ts STACK_BOX_ARCSEC = 90). On a 3' cube that box is the whole grid.
CENTRE_BOX_ARCSEC = 90.0
INFORMATIONAL_FLAGS = ("SOURCE", "FULLSAMPLE")  # set on good pixels too; see the module docstring
FLAG_RADIUS_ARCSEC = 15.0  # docs/ARCHITECTURE.md, "Flag (O7)"

REPO = Path(__file__).resolve().parents[1]


def cache_dir():
    """Where the pre-fetched cutouts live. The cache is not in git, so inside a git worktree it
    is found in the main checkout (CLAUDE.md, "Session эхлэх")."""
    env = os.environ.get("OSU_CACHE_DIR")
    if env:
        return Path(env)
    local = REPO / "data" / "cache"
    if (local / "manifest.csv").exists():
        return local
    try:
        common = subprocess.run(["git", "rev-parse", "--path-format=absolute", "--git-common-dir"],
                                cwd=REPO, capture_output=True, text=True, check=True).stdout.strip()
        return Path(common).parent / "data" / "cache"
    except (OSError, subprocess.CalledProcessError):
        return local


def short_band(band):
    """'SPHEREx-D1', 'D1' or 'd1' -> 'D1'."""
    b = band.upper().replace("SPHEREX-", "")
    if b not in {f"D{i}" for i in range(1, 7)}:
        raise ValueError(f"unknown detector {band!r}; use D1..D6 or SPHEREx-D1..SPHEREx-D6")
    return b


def manifest_rows(obj, band, cache):
    path = cache / "manifest.csv"
    if not path.exists():
        raise FileNotFoundError(f"{path} not found. Run `python experiments/prefetch_cache.py` "
                                f"or point OSU_CACHE_DIR at an existing cache.")
    with open(path, newline="", encoding="utf-8") as f:
        rows = [r for r in csv.DictReader(f) if r["object"] == obj and r["band"] == f"SPHEREx-{band}"]
    if not rows:
        raise ValueError(f"no cached images for object {obj!r}, detector {band} in {path}")
    centres = {(r["center_ra"], r["center_dec"]) for r in rows}
    if len(centres) != 1:
        raise ValueError(f"{obj} {band}: cutouts have different centres {sorted(centres)}")
    return sorted(rows, key=lambda r: float(r["mjd"]))


def check_fov(fov_arcmin):
    """3, 6 or 10 as an int; anything else is an error (the backend passes user input here)."""
    if isinstance(fov_arcmin, bool) or fov_arcmin not in CUTOUT_SIZE_DEG:
        raise ValueError(f"unsupported field of view {fov_arcmin!r} arcmin; use one of {sorted(CUTOUT_SIZE_DEG)}")
    return int(fov_arcmin)


def grid_size(fov_arcmin=DEFAULT_FOV):
    """Pixels per side: 20 pixels of 3 arcsec per arcmin, plus the centre pixel (61, 121, 201)."""
    return check_fov(fov_arcmin) * 20 + 1


def cutout_size_deg(fov_arcmin=DEFAULT_FOV):
    """Cutout size to request from IRSA so that it covers the grid of this field of view."""
    return CUTOUT_SIZE_DEG[check_fov(fov_arcmin)]


def target_wcs(ra, dec, n=GRID):
    """North-up tangent-plane grid of n x n pixels. Both CDELT are negative: x grows to the west
    and y to the south, which puts north in row 0 and east in column 0."""
    w = WCS(naxis=2)
    w.wcs.ctype = ["RA---TAN", "DEC--TAN"]
    w.wcs.crval = [ra, dec]
    w.wcs.crpix = [(n + 1) / 2, (n + 1) / 2]  # the middle pixel (FITS 31 = index 30 for n = 61)
    w.wcs.cdelt = [-PIXSCALE / 3600, -PIXSCALE / 3600]
    return w


def clipped_median_sigma(a, nsigma=3.0, iters=5):
    """Median and robust sigma (1.4826 * MAD) of the finite values after iterative clipping,
    so stars do not pull the background level up."""
    v = a[np.isfinite(a)]
    if v.size == 0:
        return float("nan"), float("nan")
    for _ in range(iters):
        med = np.median(v)
        sig = 1.4826 * np.median(np.abs(v - med))
        keep = np.abs(v - med) <= nsigma * sig
        if sig == 0 or keep.all():
            break
        v = v[keep]
    med = np.median(v)
    return float(med), float(1.4826 * np.median(np.abs(v - med)))


@contextmanager
def quiet_astropy():
    """The SPHEREx headers carry SIP terms plus a tabular wavelength WCS (key 'W'); astropy
    prints a long INFO note for every file. Silence it only while reading."""
    level = astropy_log.level
    astropy_log.setLevel("ERROR")
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            yield
    finally:
        astropy_log.setLevel(level)


def read_cutout(path, ra, dec):
    """IMAGE plane, its celestial WCS and the wavelength (um) seen at (ra, dec).

    Only IMAGE and WCS-WAVE are touched, so the PSF image (l2b-v20..v25) versus EPSF table
    (l2b-v27) difference between pipeline versions does not matter here.
    SPHEREx uses a linear variable filter: the wavelength depends on where the source falls on
    the detector, so every frame has its own value. Method from the IRSA tutorial
    https://caltech-ipac.github.io/irsa-tutorials/spherex-cutouts (spectral WCS, key "W").
    """
    with quiet_astropy(), fits.open(path) as h:
        hdr = h["IMAGE"].header
        img = h["IMAGE"].data.astype(np.float64)
        wcs = WCS(hdr)
        ny, nx = img.shape
        x, y = wcs.world_to_pixel_values(ra, dec)
        # cutouts truncated at a detector edge can leave the centre just outside the image
        x, y = float(np.clip(x, 0, nx - 1)), float(np.clip(y, 0, ny - 1))
        lam = WCS(hdr, h, key="W").pixel_to_world(x, y)[0].to_value(u.um)
    return img, wcs, float(lam)


def flag_table(header):
    """{bit: (name, description)} from a FLAGS header, whichever way the pipeline version writes it."""
    table = {}
    for key in header:
        if key.startswith("MSKN") and key[4:].isdigit():       # l2b-v27: MSKN0001 = 'OVERFLOW'
            table[int(key[4:])] = (str(header[key]).strip(), str(header.get("MSKD" + key[4:], "")).strip())
        elif key.startswith("MP_"):                             # l2b-v20..v25: MP_OVERFLOW = 1 / comment
            table[int(header[key])] = (key[3:], str(header.comments[key]).strip())
    return table


def read_flags(path):
    """FLAGS plane (int64) and its bit table."""
    with quiet_astropy(), fits.open(path) as h:
        return h["FLAGS"].data.astype(np.int64), flag_table(h["FLAGS"].header)


def defect_mask(flags, table):
    """True where a pixel has any flag that is not merely informational."""
    keep = 0
    for bit, (name, _) in table.items():
        if name not in INFORMATIONAL_FLAGS:
            keep |= 1 << bit
    return (flags & keep) != 0 if table else flags != 0


def resample(img, wcs, grid, n=GRID):
    """Bilinear resampling of `img` onto the n x n cube grid that does not let NaN pixels spread.

    Bright stars (Barnard's Star, R Dra) have 1-20 saturated core pixels that the SPHEREx
    pipeline delivers as NaN. Plain bilinear interpolation turns every NaN pixel into a 2x2
    native-pixel hole (4x4 cube pixels). Here a cube pixel is NaN only if the raw pixel directly
    under it is NaN or it lies outside the cutout; everywhere else the value is the bilinear
    mix of the VALID neighbours only, renormalised by their weights. No value is invented
    inside an invalid pixel.
    """
    valid = np.isfinite(img)
    kw = dict(shape_out=(n, n))
    num, _ = reproject_interp((np.where(valid, img, 0.0), wcs), grid, order="bilinear", **kw)
    wgt, _ = reproject_interp((valid.astype(np.float64), wcs), grid, order="bilinear", **kw)
    under, _ = reproject_interp((valid.astype(np.float64), wcs), grid, order="nearest-neighbor", **kw)
    ok = (under > 0.5) & (wgt > 0)  # NaN comparisons are False, so off-image pixels drop out
    out = np.full((n, n), np.nan)
    out[ok] = num[ok] / wgt[ok]
    return out


def epoch_index(mjds, gap=EPOCH_GAP_DAYS):
    idx, cur = [], 0
    for i, m in enumerate(mjds):
        if i and m - mjds[i - 1] > gap:
            cur += 1
        idx.append(cur)
    return idx


def _num(x, digits):
    """JSON has no NaN: round finite numbers, turn the rest into null."""
    return round(float(x), digits) if np.isfinite(x) else None


def cube_from_cutouts(cutouts, ra, dec, band, obj=None, source=None, fov_arcmin=DEFAULT_FOV, with_flags=False):
    """Build a cube centred on (ra, dec) from cutout files that cover that position.

    `cutouts`: dicts with `path` (FITS cutout as served by IRSA) and `mjd`, optionally `id`.
    This is the entry point for the backend (/api/cube): it needs no cache manifest and works
    for cutouts of any pipeline version (cached qr2/qr3 or live DR1, GitHub issue #7).
    `fov_arcmin`: 3, 6 or 10. The cutouts should be at least `cutout_size_deg(fov_arcmin)` wide;
    smaller ones are accepted and leave the outer part of the grid NaN.
    Returns (metadata dict, float32 array N x n x n with n = grid_size(fov_arcmin)), in time order;
    with `with_flags=True` a third item, the uint8 flag plane of the same shape.
    """
    band = short_band(band)
    n = grid_size(fov_arcmin)
    cutouts = sorted(cutouts, key=lambda c: float(c["mjd"]))
    if not cutouts:
        raise ValueError("no cutouts given")
    grid = target_wcs(ra, dec, n)
    box = int(round(CENTRE_BOX_ARCSEC / PIXSCALE))  # 30 pixels each side of the middle one

    data = np.full((len(cutouts), n, n), np.nan, dtype=np.float32)
    planes = np.zeros((len(cutouts), n, n), dtype=np.uint8) if with_flags else None
    names = {}
    frames, keep, skipped = [], [], []
    for i, c in enumerate(cutouts):
        path = Path(c["path"])
        if not path.exists():
            raise FileNotFoundError(f"cutout {path} is not on disk")
        img, wcs, lam = read_cutout(path, ra, dec)
        if lam is None or not np.isfinite(lam):
            # e.g. the position falls on the edge of the filter (flag DICHROIC): the image cannot be
            # placed in a spectrum or compared with another one, and the viewer prints lam_um
            skipped.append(dict(id=c.get("id") or path.name[:-len(".fits")], mjd=round(float(c["mjd"]), 6),
                                why="no wavelength is defined at the centre of this image"))
            continue
        keep.append(i)
        bg, _ = clipped_median_sigma(img)
        with quiet_astropy():
            out = resample(img - bg, wcs, grid, n)
        data[i] = out
        _, noise = clipped_median_sigma(out)
        flags, table = read_flags(path)
        for bit, entry in table.items():
            if names.setdefault(bit, entry)[0] != entry[0]:
                raise ValueError(f"{path.name}: flag bit {bit} is {entry[0]!r}, other files call it {names[bit][0]!r}")
        bad = defect_mask(flags, table) if flags.shape == img.shape else np.zeros(img.shape, dtype=bool)
        with quiet_astropy():
            x0, y0 = (float(v) for v in wcs.world_to_pixel_values(ra, dec))
            scale = float(np.mean(proj_plane_pixel_scales(wcs))) * 3600.0  # arcsec per raw pixel
            if planes is not None:
                near, _ = reproject_interp((bad.astype(np.float64), wcs), grid, shape_out=(n, n), order="nearest-neighbor")
                planes[i] = (near > 0.5).astype(np.uint8)  # NaN (off the cutout) compares False -> 0
        yy, xx = np.indices(img.shape)
        middle = np.hypot(xx - x0, yy - y0) <= FLAG_RADIUS_ARCSEC / scale
        centre_bits = sorted({b for v in (flags[middle] if flags.shape == img.shape else []) for b in range(32) if v >> b & 1})
        frames.append(dict(
            id=c.get("id") or path.name[:-len(".fits")], band=band, mjd=round(float(c["mjd"]), 6),
            lam_um=_num(lam, 5), noise=_num(noise, 5), nan_frac=round(float(np.isnan(out).mean()), 4),
            epoch=0, bg=_num(bg, 5),
            flags=dict(any_frac=round(float(bad[middle].mean()), 3) if middle.any() else None, center_bits=centre_bits)))
        if n > 2 * box + 1:
            # Wide field only (a 3' cube.json stays as it was: there the box is the whole grid and
            # 1 - nan_frac says the same). A cutout cut off at a detector edge, or a narrower one,
            # leaves the rim of a wide grid empty; what the search needs is the middle.
            mid = (n - 1) // 2
            frames[-1]["center_cover"] = round(float(np.isfinite(out[mid - box:mid + box + 1, mid - box:mid + box + 1]).mean()), 4)
    if not frames:
        raise ValueError("no usable cutouts: " + "; ".join(s["why"] for s in skipped[:1]))
    data = data[keep]
    planes = planes[keep] if planes is not None else None
    epochs = epoch_index([f["mjd"] for f in frames])
    for f, e in zip(frames, epochs):
        f["epoch"] = e

    meta = dict(
        object=obj, band=band,
        center=dict(ra=ra, dec=dec),
        pixscale_arcsec=PIXSCALE,
        fov_arcmin=check_fov(fov_arcmin),
        shape=[len(frames), n, n],
        orientation="row 0 = north, column 0 = east (north up, east left when drawn top-down)",
        bunit="MJy/sr",
        dtype="float32, little-endian, NaN = no valid data",
        background="per-frame sigma-clipped median subtracted (value in frames[].bg)",
        source=dict(archive="NASA/IPAC IRSA, SPHEREx Level 2 spectral image cutouts", **(source or {})),
        epochs=[dict(epoch=e, n=epochs.count(e),
                     mjd_min=min(f["mjd"] for f in frames if f["epoch"] == e),
                     mjd_max=max(f["mjd"] for f in frames if f["epoch"] == e))
                for e in sorted(set(epochs))],
        flag_names={str(b): names[b][0] for b in sorted(names)},
        flag_descriptions={str(b): names[b][1] for b in sorted(names)},
        flags_informational=sorted(b for b in names if names[b][0] in INFORMATIONAL_FLAGS),
        frames=frames,
        skipped=skipped,  # images left out, each with the reason
        data_url="cube.f32",
    )
    if with_flags:
        meta["flags_url"] = "flags.u8"
        return meta, data, planes
    return meta, data


def build_cube(obj, band, cache=None, fov_arcmin=DEFAULT_FOV, with_flags=False):
    """Cube of one pre-fetched object and detector (the static demo cubes), via the cache manifest."""
    cache = Path(cache) if cache else cache_dir()
    band = short_band(band)
    rows = manifest_rows(obj, band, cache)
    for r in rows:
        if not (cache / r["file"]).exists():
            raise FileNotFoundError(f"{cache / r['file']} is in the manifest but not on disk; "
                                    f"re-run experiments/prefetch_cache.py")
    stamps = sorted(r["downloaded_utc"] for r in rows)
    # IRSA path: ibe/data/spherex/<release>/level2/...; one field can mix releases (the newest
    # observations are still quick releases after DR1 came out, GitHub issue #7)
    release = {Path(r["file"]).name[:-len(".fits")]: r["uri"].split("/")[3] for r in rows}
    out = cube_from_cutouts(
        [dict(path=cache / r["file"], mjd=r["mjd"]) for r in rows],
        float(rows[0]["center_ra"]), float(rows[0]["center_dec"]), band, obj=obj,
        source=dict(from_cache=True, downloaded_utc=[stamps[0], stamps[-1]], releases={}),
        fov_arcmin=fov_arcmin, with_flags=with_flags)
    names = [release[f["id"]] for f in out[0]["frames"]]  # of the frames in the cube, not of skipped images
    out[0]["source"]["releases"] = {k: names.count(k) for k in sorted(set(names))}
    return out


def write_cube(meta, data, out_dir, flags=None):
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    data.astype("<f4").tofile(out_dir / meta["data_url"])
    if flags is not None:
        flags.astype(np.uint8).tofile(out_dir / meta["flags_url"])
    with open(out_dir / "cube.json", "w", encoding="utf-8", newline="\n") as f:
        json.dump(meta, f, indent=1, allow_nan=False)
        f.write("\n")
    return out_dir


def header_mjd(path):
    """Start of the exposure (MJD) from the IMAGE header. Equals the TAP `time_bounds_lower`
    stored in the cache manifest: max difference 5e-7 d over all 660 cached files (2026-11-14)."""
    with quiet_astropy():
        return float(fits.getheader(path, "IMAGE")["MJD-OBS"])


def build_cube_from_files(files, center_ra, center_dec, band, out_dir, fov_arcmin=DEFAULT_FOV):
    """Backend entry point (/api/cube, GitHub issue #9): cube from freshly downloaded cutouts.

    `files`: SPHEREx cutout MEFs of any processing version that cover (center_ra, center_dec),
    downloaded with size `cutout_size_deg(fov_arcmin)`.
    Writes out_dir/cube.json + out_dir/cube.f32 and returns the cube.json content.
    """
    cutouts = [dict(path=Path(f), mjd=header_mjd(f)) for f in files]
    meta, data = cube_from_cutouts(cutouts, center_ra, center_dec, band, source=dict(from_cache=False),
                                   fov_arcmin=fov_arcmin)
    write_cube(meta, data, out_dir)
    return meta


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("object", help="object key in the cache manifest, e.g. barnard")
    ap.add_argument("band", help="detector: D1..D6 or SPHEREx-D1..SPHEREx-D6")
    ap.add_argument("--out", type=Path, help="output folder (default: data/cubes/<object>/<D#>)")
    ap.add_argument("--cache-dir", type=Path, help="cache folder (default: OSU_CACHE_DIR or the main repo)")
    ap.add_argument("--fov", type=int, default=DEFAULT_FOV, choices=sorted(CUTOUT_SIZE_DEG),
                    help="field of view in arcmin (default 3); the cached cutouts must be wide enough")
    args = ap.parse_args(argv)

    band = short_band(args.band)
    meta, data, flags = build_cube(args.object, band, args.cache_dir, args.fov, with_flags=True)
    out = write_cube(meta, data, args.out or REPO / "data" / "cubes" / args.object / band, flags)
    lams = [f["lam_um"] for f in meta["frames"] if f["lam_um"] is not None]
    print(f"{args.object} {band}: {meta['shape'][0]} frames in {len(meta['epochs'])} epochs, "
          f"{min(lams):.3f}-{max(lams):.3f} um, mean NaN fraction "
          f"{np.mean([f['nan_frac'] for f in meta['frames']]):.3f}")
    for e in meta["epochs"]:
        print(f"  epoch {e['epoch']}: MJD {e['mjd_min']:.1f}-{e['mjd_max']:.1f}, {e['n']} frames")
    size = (out / meta["data_url"]).stat().st_size + (out / "cube.json").stat().st_size
    print(f"wrote {out / 'cube.json'} and {meta['data_url']} ({size / 1e6:.2f} MB)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
