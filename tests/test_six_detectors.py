"""Tests for task A-08: every demo object in all six detectors, and its spectrum.json.

They read only files committed under data/cubes, so they run on every machine without a cache.

Outside answers:
  * SPHEREx covers 0.75-5.0 um with six detectors in order of wavelength
    (https://irsa.ipac.caltech.edu/data/SPHEREx/docs/overview_qr.html).
  * Epsilon Indi B is a pair of T dwarfs; T dwarfs have a deep water absorption band between the
    J and H windows, around 1.4 um. Seen in our own pre-hackathon check at 1.35-1.40 um (CLAUDE.md).
  * WISE 0855 is a 250 K brown dwarf (NASA/JPL 2014 release, frontend/content/stories.ts): it emits
    almost nothing at short wavelengths. In CatWISE2020 it is W1 = 18.5 (3.4 um) and W2 = 15.7 (4.6 um).
"""
import json
from pathlib import Path

import numpy as np
import pytest

CUBES = Path(__file__).resolve().parents[1] / "data" / "cubes"
OBJECTS = ["barnard", "wise0855", "epsindb", "rwaur", "rdra"]
BANDS = ["D1", "D2", "D3", "D4", "D5", "D6"]
UNITS = {"aperture": "mJy", "wing": "MJy/sr"}


def strict_load(path):
    def refuse(token):
        raise ValueError(f"{path}: {token} is not valid JSON")
    return json.loads(Path(path).read_text(encoding="utf-8"), parse_constant=refuse)


@pytest.fixture(scope="module")
def cubes():
    return {(o, b): strict_load(CUBES / o / b / "cube.json") for o in OBJECTS for b in BANDS}


@pytest.fixture(scope="module")
def measures():
    return {(o, b): strict_load(CUBES / o / b / "measure.json") for o in OBJECTS for b in BANDS}


@pytest.fixture(scope="module")
def spectra():
    return {o: strict_load(CUBES / o / "spectrum.json") for o in OBJECTS}


def test_thirty_cubes_on_one_grid_per_object(cubes):
    for o in OBJECTS:
        centre = cubes[(o, "D1")]["center"]
        for b in BANDS:
            c = cubes[(o, b)]
            assert (c["object"], c["band"]) == (o, b)
            assert c["center"] == centre, f"{o} {b}"
            n, h, w = c["shape"]
            assert (h, w) == (61, 61) and c["fov_arcmin"] == 3 and c["pixscale_arcsec"] == 3.0
            assert 1 <= n <= 150 and len(c["frames"]) == n  # deep fields are subsampled to 150
            assert (CUBES / o / b / "cube.f32").stat().st_size == n * h * w * 4
            assert c["source"]["from_cache"] is True and sum(c["source"]["releases"].values()) == n


def test_the_thirty_cubes_stay_under_forty_megabytes():
    total = sum((CUBES / o / b / "cube.f32").stat().st_size for o in OBJECTS for b in BANDS)
    print(f"30 cubes: {total / 1e6:.1f} MB")
    assert total <= 40e6  # tasks/A.md A-08


def test_detectors_are_in_wavelength_order_and_cover_the_spherex_range(cubes):
    for o in OBJECTS:
        lo = [min(f["lam_um"] for f in cubes[(o, b)]["frames"]) for b in BANDS]
        hi = [max(f["lam_um"] for f in cubes[(o, b)]["frames"]) for b in BANDS]
        assert lo == sorted(lo) and hi == sorted(hi), o
        assert lo[0] < 0.80 and hi[-1] > 4.90, o
        for i in range(5):  # neighbours touch: no gap wider than 0.15 um between detectors
            assert lo[i + 1] - hi[i] < 0.15, f"{o}: gap between {BANDS[i]} and {BANDS[i + 1]}"


def test_every_cube_has_its_measurement_with_one_method_per_object(cubes, measures):
    for o in OBJECTS:
        methods = {measures[(o, b)]["photometry_method"] for b in BANDS}
        assert len(methods) == 1, f"{o}: {methods}"
        for b in BANDS:
            m, c = measures[(o, b)], cubes[(o, b)]
            assert (m["object"], m["band"]) == (o, b)
            assert [f["id"] for f in m["frames"]] == [f["id"] for f in c["frames"]]
            assert len(m["photometry"]) == c["shape"][0]
            assert m["photometry_unit"] == UNITS[m["photometry_method"]]
            if m["motion"] is not None:
                assert m["motion"]["status"] in ("ok", "unverified")
    # a source that saturates in any detector is measured by its wings everywhere
    assert measures[("rdra", "D1")]["photometry_method"] == "wing"
    assert measures[("barnard", "D1")]["photometry_method"] == "wing"
    assert measures[("wise0855", "D6")]["photometry_method"] == "aperture"


def test_spectrum_json_format(spectra, measures):
    for o, s in spectra.items():
        assert set(s) == {"object", "method", "unit", "note", "neighbour", "bands", "points"}
        assert s["object"] == o and s["unit"] == UNITS[s["method"]] and len(s["note"]) > 80
        assert s["method"] == measures[(o, "D1")]["photometry_method"]
        assert [b["band"] for b in s["bands"]] == BANDS
        assert len(s["points"]) == sum(len(measures[(o, b)]["photometry"]) for b in BANDS)
        lam = [p["lam_um"] for p in s["points"]]
        assert lam == sorted(lam)
        for p in s["points"]:
            assert set(p) == {"band", "mjd", "epoch", "lam_um", "flux", "err", "ok", "why"}  # docs/ARCHITECTURE.md
            assert p["band"] in BANDS
            assert (p["flux"] is None) == (not p["ok"]) and (p["why"] != "") == (not p["ok"])
        for b in s["bands"]:
            assert b["n_images"] == len(measures[(o, b["band"])]["photometry"])
            assert b["n_ok"] == sum(p["ok"] for p in s["points"] if p["band"] == b["band"])


def median_flux(spectrum, lo, hi):
    f = [p["flux"] for p in spectrum["points"] if p["ok"] and lo <= p["lam_um"] < hi]
    assert len(f) >= 3, f"only {len(f)} points between {lo} and {hi} um"
    return float(np.median(f))


def test_epsilon_indi_b_shows_the_water_band(spectra):
    s = spectra["epsindb"]
    assert s["method"] == "aperture"
    detected = {b["band"]: b["detected"] for b in s["bands"]}
    for b in ("D2", "D3", "D4", "D5", "D6"):  # tasks/A.md: the spectrum comes out in D2-D6
        assert detected[b], b
    j_peak, band, h_peak = median_flux(s, 1.25, 1.30), median_flux(s, 1.35, 1.40), median_flux(s, 1.55, 1.60)
    print(f"eps Ind B: 1.25-1.30 um {j_peak:.2f}, 1.35-1.40 um {band:.2f}, 1.55-1.60 um {h_peak:.2f} mJy")
    assert band < 0.7 * j_peak and band < 0.7 * h_peak


def test_wise0855_is_seen_only_at_the_longest_wavelengths(spectra):
    bands = {b["band"]: b for b in spectra["wise0855"]["bands"]}
    print("WISE 0855 per detector:", {k: (v["median_snr"], v["offset_arcsec"], v["detected"]) for k, v in bands.items()})
    assert bands["D6"]["detected"]
    for b in ("D1", "D2", "D3", "D4"):
        assert not bands[b]["detected"] and bands[b]["why_not"], b


def test_the_light_at_wise0855_below_4_um_is_the_gaia_star_next_to_it(spectra, cubes, measures):
    """There IS light in the aperture at 0.75-3.8 um, and it is not WISE 0855: Gaia DR3
    5756956644387831296 (G = 16.3, proper motion 6 mas/yr) is 8 arcsec away, inside the 15 arcsec
    aperture. Position from IRSA TAP, gaia_dr3_source, queried 2026-11-14 07:05 UTC (data/catalog.py,
    PR #63): RA 133.7581825, Dec -7.2411559 at epoch 2016.0. CatWISE2020 has it as
    J085501.95-071428.2 with W2 = 15.20."""
    s = spectra["wise0855"]
    c = cubes[("wise0855", "D2")]["center"]
    east = (133.7581825 - c["ra"]) * np.cos(np.radians(c["dec"])) * 3600
    north = (-7.2411559 - c["dec"]) * 3600
    n = s["neighbour"]
    print(f"Gaia star: {east:+.2f} east, {north:+.2f} north; found: {n}")
    assert n is not None and set(n["bands"]) >= {"D1", "D2", "D3", "D4"}
    assert np.hypot(n["east_arcsec"] - east, n["north_arcsec"] - north) < 1.5  # a quarter of a pixel
    assert "Another source" in s["note"] and "include its light" in s["note"]
    for b in ("D1", "D2", "D3", "D4"):
        m = measures[("wise0855", b)]
        assert "another source" in next(x for x in s["bands"] if x["band"] == b)["why_not"]
        # a star does not move; reporting its zero motion as that of WISE 0855 would be wrong
        assert m["motion"] is None or m["motion"]["status"] == "unverified"
    for o in ("barnard", "epsindb", "rwaur", "rdra"):
        assert spectra[o]["neighbour"] is None, o


def test_the_five_objects_are_found_where_they_should_be(measures):
    best = {"barnard": "D1", "epsindb": "D2", "rwaur": "D1", "rdra": "D1", "wise0855": "D6"}
    for o, b in best.items():
        off = measures[(o, b)]["source_offset_arcsec"]
        assert off is not None and off["sep"] < 6.16, f"{o} {b}: {off}"
