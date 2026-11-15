"""Tests for data/cube.py (task A-01): the aligned display cube built from the local cache.

They need the pre-fetched cache (`python experiments/prefetch_cache.py`, 3 GB, not in git) and are
skipped on machines without it. No network access is needed.

Known answers used here come from outside the code under test:
  * Barnard's Star proper motion: -0.80, +10.36 arcsec/yr (Gaia DR3 via IRSA, see
    experiments/check_objects.py). First to last SPHEREx epoch is ~1.02 yr -> ~10.5" north.
  * A static Gaia DR3 star 1.28' from Barnard's Star at RA 269.43868, Dec 4.78653 (G = 13.6,
    proper motion 6 mas/yr; same star as in tests/test_known_motion.py). Its place in the cube
    checks the orientation (north up, east left) and the 3"/px scale.
"""
import csv
import json
import math

import warnings

import numpy as np
import pytest
from astropy.io import fits
from astropy.wcs import WCS

from data import cube

CACHE = cube.cache_dir()
pytestmark = pytest.mark.skipif(
    not (CACHE / "manifest.csv").exists(),
    reason=f"no SPHEREx cache at {CACHE} (run experiments/prefetch_cache.py or set OSU_CACHE_DIR)")

REQUIRED_FRAME_KEYS = {"id", "band", "mjd", "lam_um", "noise", "nan_frac"}


def manifest_rows(obj, band):
    with open(CACHE / "manifest.csv", newline="", encoding="utf-8") as f:
        return [r for r in csv.DictReader(f) if r["object"] == obj and r["band"] == f"SPHEREx-{band}"]


def load(out_dir):
    meta = json.loads((out_dir / "cube.json").read_text(encoding="utf-8"))
    data = np.fromfile(out_dir / meta["data_url"], dtype="<f4").reshape(meta["shape"])
    return meta, data


def median_image(frames):
    """Pixel-wise median; grid corners that no cutout covers stay NaN (numpy warns about those)."""
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", RuntimeWarning)
        return np.nanmedian(frames, axis=0)


def centroid(img, x0, y0, search=8, half=4):
    """Flux-weighted centroid around the brightest pixel within `search` px of (x0, y0)."""
    yy, xx = np.indices(img.shape)
    near = (np.hypot(xx - x0, yy - y0) <= search) & np.isfinite(img)
    y, x = np.unravel_index(np.argmax(np.where(near, img, -np.inf)), img.shape)
    stamp = np.clip(np.nan_to_num(img[y - half:y + half + 1, x - half:x + half + 1]), 0, None)
    off = np.arange(-half, half + 1)
    return (x + (stamp * off[None, :]).sum() / stamp.sum(),
            y + (stamp * off[:, None]).sum() / stamp.sum())


@pytest.fixture(scope="module")
def barnard(tmp_path_factory):
    out = tmp_path_factory.mktemp("barnard_D1")
    cube.main(["barnard", "SPHEREx-D1", "--out", str(out)])
    return load(out)


@pytest.fixture(scope="module")
def rdra(tmp_path_factory):
    out = tmp_path_factory.mktemp("rdra_D1")
    cube.main(["rdra", "D1", "--out", str(out)])
    return load(out)


def test_frame_count_and_format(barnard):
    meta, data = barnard
    rows = manifest_rows("barnard", "D1")
    assert len(rows) > 0
    assert len(meta["frames"]) == len(rows)
    assert meta["shape"] == [len(rows), 61, 61]
    assert data.shape == (len(rows), 61, 61)  # reshape above already proves the byte count
    assert meta["pixscale_arcsec"] == 3.0
    assert meta["center"]["ra"] == pytest.approx(float(rows[0]["center_ra"]))
    assert meta["center"]["dec"] == pytest.approx(float(rows[0]["center_dec"]))
    mjds = [f["mjd"] for f in meta["frames"]]
    assert mjds == sorted(mjds)
    assert len({f["id"] for f in meta["frames"]}) == len(rows)
    for f in meta["frames"]:
        assert REQUIRED_FRAME_KEYS <= set(f)
        assert f["band"] == "D1"
        # SPHEREx covers 0.75-5.0 um in total (https://irsa.ipac.caltech.edu/data/SPHEREx/docs/overview_qr.html)
        # and D1 is its shortest-wavelength detector; our cached D1 frames span 0.73-1.11 um (2026-11-14).
        # Loose limits: this only guards against a wrong wavelength lookup (e.g. another detector's range).
        assert 0.70 < f["lam_um"] < 1.15
        assert 0.0 <= f["nan_frac"] < 0.6
        assert f["noise"] > 0


def test_frames_are_background_subtracted(barnard):
    meta, data = barnard
    for f, img in zip(meta["frames"], data):
        assert abs(np.nanmedian(img)) < 3 * f["noise"]


def test_barnard_moves_north_between_first_and_last_epoch(barnard):
    meta, data = barnard
    epoch = np.array([f["epoch"] for f in meta["frames"]])
    mjd = np.array([f["mjd"] for f in meta["frames"]])
    first, last = epoch == epoch.min(), epoch == epoch.max()
    years = (mjd[last].mean() - mjd[first].mean()) / 365.25
    assert years > 0.5
    c = (meta["shape"][2] - 1) / 2
    x0, y0 = centroid(median_image(data[first]), c, c)
    x1, y1 = centroid(median_image(data[last]), c, c)
    north = (y0 - y1) * meta["pixscale_arcsec"]  # row 0 is north
    east = (x0 - x1) * meta["pixscale_arcsec"]   # column 0 is east
    print(f"Barnard shift over {years:.2f} yr: north {north:+.2f}\", east {east:+.2f}\"")
    assert 7.0 <= north <= 14.0


def test_orientation_and_scale_from_static_gaia_star(barnard):
    meta, data = barnard
    star_ra, star_dec = 269.43868, 4.78653
    c = (meta["shape"][2] - 1) / 2
    east = (star_ra - meta["center"]["ra"]) * math.cos(math.radians(meta["center"]["dec"])) * 3600
    north = (star_dec - meta["center"]["dec"]) * 3600
    ex, ey = c - east / meta["pixscale_arcsec"], c - north / meta["pixscale_arcsec"]
    med = median_image(data)
    x, y = centroid(med, ex, ey, search=5, half=3)
    peak = med[int(round(y)), int(round(x))]
    sigma = 1.4826 * np.nanmedian(np.abs(med - np.nanmedian(med)))
    print(f"static star: expected ({ex:.2f}, {ey:.2f}), found ({x:.2f}, {y:.2f}), peak {peak / sigma:.0f} sigma")
    assert peak > 5 * sigma
    assert math.hypot(x - ex, y - ey) < 1.5  # px, i.e. 4.5"


def test_both_psf_formats_are_read(barnard):
    # l2b-v20..v25 files carry a `PSF` image HDU, l2b-v27 an `EPSF` table (CLAUDE.md). The cube
    # must not care; make sure this cube really was built from both kinds.
    kinds = set()
    for r in manifest_rows("barnard", "D1"):
        with fits.open(CACHE / r["file"]) as h:
            kinds |= {hdu.name for hdu in h} & {"PSF", "EPSF"}
    assert kinds == {"PSF", "EPSF"}
    meta, data = barnard
    assert all(np.isfinite(img).any() for img in data)


def test_truncated_cutouts_are_kept(rdra):
    meta, data = rdra
    rows = manifest_rows("rdra", "D1")
    assert len(meta["frames"]) == len(rows)
    shapes = {}
    for r in rows:
        hdr = fits.getheader(CACHE / r["file"], "IMAGE")
        shapes[r["file"].rsplit("/", 1)[-1][:-len(".fits")]] = (hdr["NAXIS2"], hdr["NAXIS1"])
    usual = max(set(shapes.values()), key=list(shapes.values()).count)
    odd = [i for i, s in shapes.items() if s[0] < usual[0] or s[1] < usual[1]]
    assert odd, "expected at least one cutout truncated at a detector edge in rdra D1"
    by_id = {f["id"]: (f, img) for f, img in zip(meta["frames"], data)}
    files = {r["file"].rsplit("/", 1)[-1][:-len(".fits")]: CACHE / r["file"] for r in rows}

    # Sky position of every cube pixel from the documented convention (row 0 north, column 0
    # east, 3"/px), then its place in the raw cutout from that file's own WCS. Cube pixels that
    # fall off the truncated cutout must be NaN, pixels well inside it must hold data
    # (a few are NaN anyway: R Dra saturates, its core is masked in the raw image).
    c = (meta["shape"][2] - 1) / 2
    yy, xx = np.indices(meta["shape"][1:])
    dec = meta["center"]["dec"] + (c - yy) * meta["pixscale_arcsec"] / 3600
    ra = meta["center"]["ra"] + (c - xx) * meta["pixscale_arcsec"] / 3600 / math.cos(math.radians(meta["center"]["dec"]))
    n_outside = 0
    for i in odd:
        f, img = by_id[i]
        with cube.quiet_astropy(), fits.open(files[i]) as h:
            px, py = WCS(h["IMAGE"].header).world_to_pixel_values(ra, dec)
        ny, nx = shapes[i]
        outside = (px < -1.5) | (px > nx + 0.5) | (py < -1.5) | (py > ny + 0.5)  # >1 px beyond the edge
        inside = (px > 1.5) & (px < nx - 2.5) & (py > 1.5) & (py < ny - 2.5)
        n_outside += int(outside.sum())
        assert np.isnan(img[outside]).all()
        assert np.isfinite(img[inside]).mean() > 0.9
        assert f["nan_frac"] == pytest.approx(float(np.isnan(img).mean()), abs=1e-3)
    assert n_outside > 0, "no truncated cutout leaves part of the grid uncovered; the check above is empty"


def test_cube_from_cutouts_needs_no_manifest():
    # The backend (/api/cube) calls this with files it downloaded itself, centred anywhere.
    # Centre the grid on the static Gaia star instead of Barnard's Star: it must sit in the middle.
    rows = manifest_rows("barnard", "D1")[:5]
    star_ra, star_dec = 269.43868, 4.78653
    meta, data = cube.cube_from_cutouts(
        [dict(path=CACHE / r["file"], mjd=float(r["mjd"])) for r in reversed(rows)],
        star_ra, star_dec, "SPHEREx-D1")
    assert meta["shape"] == [5, 61, 61] and data.shape == (5, 61, 61)
    assert meta["center"] == {"ra": star_ra, "dec": star_dec}
    assert [f["mjd"] for f in meta["frames"]] == pytest.approx(sorted(float(r["mjd"]) for r in rows))
    json.dumps(meta, allow_nan=False)  # must be valid JSON for the API
    c = (meta["shape"][2] - 1) / 2
    x, y = centroid(median_image(data), c, c, search=3, half=3)
    assert math.hypot(x - c, y - c) < 1.5  # px


def test_build_cube_from_files_is_the_backend_entry_point(tmp_path):
    # Signature requested by role C in GitHub issue #9: files only, times come from the headers.
    rows = manifest_rows("barnard", "D1")
    picked = [rows[0], rows[len(rows) // 2], rows[-1]]
    ra, dec = float(rows[0]["center_ra"]), float(rows[0]["center_dec"])
    meta = cube.build_cube_from_files([CACHE / r["file"] for r in picked], ra, dec, "SPHEREx-D1", tmp_path)
    on_disk, data = load(tmp_path)
    assert on_disk == meta
    assert meta["data_url"] == "cube.f32" and data.shape == (3, 61, 61)
    assert meta["source"]["from_cache"] is False
    # MJD-OBS in the header is the same instant as the TAP time in the manifest
    assert [f["mjd"] for f in meta["frames"]] == pytest.approx([float(r["mjd"]) for r in picked], abs=1e-5)
    assert REQUIRED_FRAME_KEYS <= set(meta["frames"][0])


def test_cache_dir_honours_env(monkeypatch, tmp_path):
    monkeypatch.setenv("OSU_CACHE_DIR", str(tmp_path))
    assert cube.cache_dir() == tmp_path


# ---------------------------------------------------------------------------------------------
# Field of view (task A-10): 3, 6 or 10 arcmin -> 61, 121 or 201 pixels of 3 arcsec.
# ---------------------------------------------------------------------------------------------

REPO_CUBES = cube.REPO / "data"


def test_fov_choices_map_to_grid_and_cutout_sizes():
    # docs/ARCHITECTURE.md, "Интерфейсийн нэмэлт": H = W = fov * 20 + 1; tasks/A.md A-10: cutout sizes
    assert [cube.grid_size(f) for f in (3, 6, 10)] == [61, 121, 201]
    assert [cube.cutout_size_deg(f) for f in (3, 6, 10)] == [0.05, 0.11, 0.18]
    assert cube.grid_size() == 61 and cube.cutout_size_deg() == 0.05
    for fov in (3, 6, 10):  # the cutout is wider than the grid it has to cover
        assert cube.cutout_size_deg(fov) * 60 >= fov
    for bad in (0, 5, 12, 3.5, "6", None, True):
        with pytest.raises(ValueError):
            cube.grid_size(bad)


def test_default_cube_says_three_arcmin(barnard):
    meta, _ = barnard
    assert meta["fov_arcmin"] == 3


def test_three_arcmin_cube_is_byte_for_byte_what_it_was(tmp_path):
    # data/cubes_qr/barnard/D1/cube.f32 was committed in PR #23, before the grid size became a
    # parameter, and is built from the same quick-release cache this test uses.
    committed = REPO_CUBES / "cubes_qr" / "barnard" / "D1" / "cube.f32"
    if not committed.exists():
        pytest.skip("data/cubes_qr/barnard/D1/cube.f32 is not in this checkout")
    cube.main(["barnard", "D1", "--out", str(tmp_path)])
    assert (tmp_path / "cube.f32").read_bytes() == committed.read_bytes()


def test_six_arcmin_grid_agrees_with_three_arcmin_in_the_middle():
    rows = manifest_rows("barnard", "D1")[:6]
    cutouts = [dict(path=CACHE / r["file"], mjd=float(r["mjd"])) for r in rows]
    ra, dec = float(rows[0]["center_ra"]), float(rows[0]["center_dec"])
    m3, d3 = cube.cube_from_cutouts(cutouts, ra, dec, "D1")
    m6, d6 = cube.cube_from_cutouts(cutouts, ra, dec, "D1", fov_arcmin=6)
    assert m6["fov_arcmin"] == 6 and m6["shape"] == [6, 121, 121] and d6.shape == (6, 121, 121)
    assert m6["pixscale_arcsec"] == m3["pixscale_arcsec"] == 3.0
    assert m6["center"] == m3["center"]
    # same centre, same pixel size: the middle 61 x 61 of the wide grid is the narrow grid
    middle = d6[:, 30:91, 30:91]
    assert np.array_equal(np.isnan(middle), np.isnan(d3))
    np.testing.assert_allclose(middle, d3, rtol=1e-5, atol=1e-6, equal_nan=True)
    # these cutouts are only 3' wide, so the added border has no data: nothing is extrapolated
    border = np.ones((121, 121), dtype=bool)
    border[25:96, 25:96] = False
    assert np.isnan(d6[:, border]).all()
    for f3, f6 in zip(m3["frames"], m6["frames"]):
        assert (f3["id"], f3["mjd"], f3["lam_um"], f3["bg"]) == (f6["id"], f6["mjd"], f6["lam_um"], f6["bg"])


def test_backend_entry_point_takes_a_field_of_view(tmp_path):
    rows = manifest_rows("barnard", "D1")[:3]
    ra, dec = float(rows[0]["center_ra"]), float(rows[0]["center_dec"])
    meta = cube.build_cube_from_files([CACHE / r["file"] for r in rows], ra, dec, "D1", tmp_path, fov_arcmin=10)
    on_disk, data = load(tmp_path)
    assert on_disk == meta and meta["fov_arcmin"] == 10
    assert data.shape == (3, 201, 201)
    with pytest.raises(ValueError):
        cube.build_cube_from_files([CACHE / rows[0]["file"]], ra, dec, "D1", tmp_path, fov_arcmin=4)


def test_wise0855_is_inside_the_six_arcmin_field_at_the_challenge_coordinates():
    """The challenge gives WISE 0855 as RA 08h55m10.831s, Dec -07d14m42.53s (133.79513, -7.24515):
    where it was around 2010. It moves 8 arcsec/yr west, so in the SPHEREx images it sits about
    124" west of that point: outside a 3' field (half width 91"), inside a 6' field (181").
    Needs the wide cutouts: `python -m data.fetch_field wise0855_2010 133.79513 -7.24515 D6 --fov 6`.
    """
    from data import fetch_field
    wide = fetch_field.default_cache()
    if not (wide / "manifest.csv").exists() or "wise0855_2010" not in (wide / "manifest.csv").read_text(encoding="utf-8"):
        pytest.skip(f"no wide-field cutouts in {wide}")
    meta, data = cube.build_cube("wise0855_2010", "D6", wide, fov_arcmin=6)
    n, h, w = meta["shape"]
    assert (h, w) == (121, 121) and meta["fov_arcmin"] == 6
    assert meta["center"]["ra"] == pytest.approx(133.79513) and meta["center"]["dec"] == pytest.approx(-7.24515)

    # Where the catalogue puts the object at MJD 61100: the centre of our demo cube, which comes
    # from its CatWISE2020 position and motion (experiments/check_objects.py).
    demo = json.loads((REPO_CUBES / "cubes" / "wise0855" / "D6" / "cube.json").read_text(encoding="utf-8"))["center"]
    cosd = math.cos(math.radians(meta["center"]["dec"]))
    east0 = (demo["ra"] - meta["center"]["ra"]) * cosd * 3600
    north0 = (demo["dec"] - meta["center"]["dec"]) * 3600
    assert east0 == pytest.approx(-124, abs=3)  # 124" west
    assert abs(east0) > 91.5 and abs(east0) < 181.5  # outside 3', inside 6'

    # Follow the catalogue motion (CatWISE2020: -7.965, +0.806 arcsec/yr) and stack: the object is
    # too faint for one image, in the median of all of them it must stand out where predicted.
    c, half, px = (w - 1) / 2, 10, meta["pixscale_arcsec"]
    stamps = []
    for f, img in zip(meta["frames"], data):
        dt = (f["mjd"] - 61100.0) / 365.25
        x = int(round(c - (east0 - 7.965 * dt) / px))
        y = int(round(c - (north0 + 0.806 * dt) / px))
        assert half <= x < w - half and half <= y < h - half  # the track stays inside the field
        stamps.append(img[y - half:y + half + 1, x - half:x + half + 1])
    stack = median_image(np.array(stamps))
    sigma = 1.4826 * np.nanmedian(np.abs(stack - np.nanmedian(stack)))
    yy, xx = np.indices(stack.shape)
    near = np.hypot(xx - half, yy - half) <= 3  # within 9" of the predicted place
    peak = np.nanmax(stack[near])
    py, pxl = np.unravel_index(np.nanargmax(np.where(near, stack, -np.inf)), stack.shape)
    print(f"WISE 0855 in the 6' field: {n} frames, east {east0:+.1f}\", north {north0:+.1f}\" at MJD 61100; "
          f"stack peak {peak / sigma:.1f} sigma at ({(half - pxl) * px:+.0f}\", {(half - py) * px:+.0f}\") from the prediction")
    assert peak > 5 * sigma
    assert peak == np.nanmax(stack[np.hypot(xx - half, yy - half) <= 8])  # the brightest thing around is at the track


# ---------------------------------------------------------------------------------------------
# Wide cubes keep every frame (task A-15, GitHub issue #65).
# ---------------------------------------------------------------------------------------------

def test_wide_cube_keeps_frames_with_an_empty_rim_and_reports_centre_coverage():
    # Cutouts that do not fill a 6' grid (here: the cached 3' ones; at a detector edge: cut-off ones)
    # must stay in the cube: the middle 3', where the stack and the velocity search work, is covered.
    rows = manifest_rows("barnard", "D1")[:6]
    cutouts = [dict(path=CACHE / r["file"], mjd=float(r["mjd"])) for r in rows]
    ra, dec = float(rows[0]["center_ra"]), float(rows[0]["center_dec"])
    m3, d3 = cube.cube_from_cutouts(cutouts, ra, dec, "D1")
    m6, d6 = cube.cube_from_cutouts(cutouts, ra, dec, "D1", fov_arcmin=6)
    assert len(m6["frames"]) == len(rows) and m6["skipped"] == []
    for f3, f6, img3 in zip(m3["frames"], m6["frames"], d3):
        assert f6["nan_frac"] > 0.7                      # three quarters of the wide grid are empty ...
        assert f6["center_cover"] == pytest.approx(float(np.isfinite(img3).mean()), abs=1e-4)  # ... the middle is not
        assert f6["center_cover"] == pytest.approx(1 - f3["nan_frac"], abs=2e-4)
        assert f6["center_cover"] > 0.9
        # a 3' frame has no such entry: there the box is the whole grid, and the committed cube.json stay as they are
        assert "center_cover" not in f3


def test_barnard_six_arcmin_field_keeps_all_sixty_frames():
    """Issue #65: the live 6' cube of Barnard's Star had 52 of 60 frames. Built from the 60 cutouts
    of 0.11 deg, the cube must hold every one of them, each with its middle 3' covered.
    Needs the wide cutouts (not in git):
    `python -m data.fetch_field barnard_fov6 269.4462864 4.7680655 D1 --fov 6`."""
    from data import fetch_field
    wide = fetch_field.default_cache()
    if not (wide / "manifest.csv").exists() or "barnard_fov6" not in (wide / "manifest.csv").read_text(encoding="utf-8"):
        pytest.skip(f"no wide-field cutouts of Barnard's Star in {wide}")
    with open(wide / "manifest.csv", newline="", encoding="utf-8") as f:
        n_files = sum(r["object"] == "barnard_fov6" for r in csv.DictReader(f))
    assert n_files >= 58  # IRSA lists 60 D1 images of this position (same list as the 3' demo cube)
    meta, data = cube.build_cube("barnard_fov6", "D1", wide, fov_arcmin=6)
    assert meta["shape"] == [n_files, 121, 121] and meta["skipped"] == []
    covers = [f["center_cover"] for f in meta["frames"]]
    print(f"Barnard 6': {n_files} frames, center_cover {min(covers):.3f}-{max(covers):.3f}, "
          f"nan_frac {min(f['nan_frac'] for f in meta['frames']):.3f}-{max(f['nan_frac'] for f in meta['frames']):.3f}")
    # the saturated core of the star is masked (a few native pixels), nothing else may be missing in the middle
    assert min(covers) > 0.9

    # Same exposures, same centre, same pixel grid as the 3' demo cube: away from the rim of the 3'
    # cutouts the two must show the same sky. The background level is a median over a different
    # area (Barnard's halo fills more of a 3' cutout than of a 6' one: the levels differ by 0.11 to
    # 0.36 MJy/sr, measured 2026-11-15), so each frame may differ by a constant: compare after
    # removing the median difference.
    demo_dir = REPO_CUBES / "cubes" / "barnard" / "D1"
    demo = json.loads((demo_dir / "cube.json").read_text(encoding="utf-8"))
    d3 = np.fromfile(demo_dir / demo["data_url"], dtype="<f4").reshape(demo["shape"])
    by_id = {f["id"]: img for f, img in zip(demo["frames"], d3)}
    common = [(by_id[f["id"]], img[30:91, 30:91], f) for f, img in zip(meta["frames"], data) if f["id"] in by_id]
    assert len(common) >= 58
    levels = []
    for narrow, middle, f in common:
        inner = (slice(10, 51), slice(10, 51))  # the middle 2': clear of the cutout edges in both
        diff = (middle - narrow)[inner]
        both = np.isfinite(diff)
        assert both.mean() > 0.9
        levels.append(float(np.median(diff[both])))
        assert np.nanmax(np.abs(diff[both] - levels[-1])) < 1e-3 * np.nanmax(narrow[inner][both])
    print(f"background level, 6' minus 3' cube: {min(levels):+.3f} to {max(levels):+.3f} MJy/sr")


def test_fetch_field_can_take_its_image_list_from_another_manifest(tmp_path):
    # `--list-from`: when IRSA's TAP service is down but cutouts are served (2026-11-14 18:43 UTC),
    # the images of a position already in a cache are known from that cache's manifest.
    from data import fetch_field
    rows = manifest_rows("barnard", "D1")
    got = fetch_field.listed_images(CACHE, "barnard", "D1")
    assert [g["uri"] for g in got] == [r["uri"] for r in sorted(rows, key=lambda r: float(r["mjd"]))]
    assert [g["mjd"] for g in got] == sorted(float(r["mjd"]) for r in rows)
    with pytest.raises(ValueError):
        fetch_field.listed_images(CACHE, "no_such_object", "D1")
