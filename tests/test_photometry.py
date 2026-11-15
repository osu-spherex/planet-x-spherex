"""Tests for data/photometry.py: light curves of the two required variable stars, from the cache.

Skipped on machines without the pre-fetched cache. No network access is needed.

Answers that do not come from the code under test:
  * R Draconis, 0.90-0.95 um wing brightness 34.8 MJy/sr at MJD 60832, 8.6 at MJD 60926: measured on
    2026-11-10 with experiments/saturated_check.py on cutouts downloaded separately (CLAUDE.md).
  * RW Aurigae about twice as bright in 2026-08 as in 2025-08 at 0.75-0.83 um: measured on
    2026-11-10 with experiments/check_objects.py (CLAUDE.md).
  * The Gaia DR3 star at RA 269.43868, Dec 4.78653 (tests/test_known_motion.py) is used as a
    comparison star. Assumption, not a catalogue fact: it is not a variable star. If photometry
    invents variability (wrong background, wrong wavelength matching), this star shows it.
"""
import json

import numpy as np
import pytest

from data import cube, photometry

CACHE = cube.cache_dir()
pytestmark = pytest.mark.skipif(
    not (CACHE / "manifest.csv").exists(),
    reason=f"no SPHEREx cache at {CACHE} (run experiments/prefetch_cache.py or set OSU_CACHE_DIR)")


@pytest.fixture(scope="module")
def rdra():
    return photometry.measure(248.16723, 66.75503, "D1")


@pytest.fixture(scope="module")
def rwaur():
    return photometry.measure(76.95609, 30.40112, "D1")


@pytest.fixture(scope="module")
def static():
    return photometry.measure(269.43868, 4.78653, "D1")


def curve(result, lam):
    for c in result["light_curves"]:
        if c["lam_min"] <= lam < c["lam_max"]:
            return c["points"]
    raise AssertionError(f"no light curve covers {lam} um")


def test_output_shape(rwaur):
    json.dumps(rwaur, allow_nan=False)
    assert {"epochs", "motion", "photometry", "light_curves"} <= set(rwaur)  # /api/measure, docs/ARCHITECTURE.md
    p = rwaur["photometry"][0]
    assert {"mjd", "lam_um", "flux", "err", "ok"} <= set(p)
    assert len(rwaur["photometry"]) == rwaur["n_frames"] == 56
    assert [q["mjd"] for q in rwaur["photometry"]] == sorted(q["mjd"] for q in rwaur["photometry"])


def test_r_dra_is_saturated_and_measured_by_its_wings(rdra):
    assert rdra["photometry_method"] == "wing" and rdra["photometry_unit"] == "MJy/sr"
    assert sum(p["ok"] for p in rdra["photometry"]) == 150


def test_r_dra_light_curve_matches_the_pre_hackathon_measurement(rdra):
    pts = curve(rdra, 0.95)
    first = min(pts, key=lambda p: p["mjd"])
    assert first["mjd"] == pytest.approx(60832.5, abs=1.0)
    assert first["flux"] == pytest.approx(34.8, rel=0.05)
    faint = min(pts, key=lambda p: p["flux"])
    assert faint["mjd"] == pytest.approx(60926, abs=5)
    assert faint["flux"] == pytest.approx(8.6, rel=0.10)
    assert first["flux"] / faint["flux"] > 3  # a Mira variable: large amplitude


def test_rw_aur_brightened_about_twofold(rwaur):
    assert rwaur["photometry_method"] == "aperture" and rwaur["photometry_unit"] == "mJy"
    assert all(p["ok"] for p in rwaur["photometry"])
    ratios = []
    for c in rwaur["light_curves"]:
        if not (0.74 <= c["lam_min"] and c["lam_max"] <= 0.84):
            continue
        early = [p["flux"] for p in c["points"] if p["mjd"] < 61000]   # 2025-08
        late = [p["flux"] for p in c["points"] if p["mjd"] > 61250]    # 2026-08
        if early and late:
            ratios.append(np.median(late) / np.median(early))
    assert len(ratios) >= 3
    assert 1.5 < np.median(ratios) < 3.0


def test_comparison_star_is_constant(static):
    assert static["photometry_method"] == "aperture"
    assert len(static["light_curves"]) >= 5
    swings = [max(p["flux"] for p in c["points"]) / min(p["flux"] for p in c["points"]) for c in static["light_curves"]]
    assert max(swings) < 1.15
    assert np.median(swings) < 1.07


def test_light_curve_grouping_by_wavelength_and_visit():
    def pt(mjd, lam, flux):
        return dict(mjd=mjd, lam_um=lam, flux=flux, err=0.1, ok=True)
    pts = [pt(100.0, 0.905, 10.0), pt(101.0, 0.915, 12.0),    # same bin 0.90-0.92, one visit
           pt(300.0, 0.910, 20.0),                            # same bin, a later visit
           pt(100.5, 0.950, 99.0),                            # another bin, a single visit: no curve
           dict(mjd=300.5, lam_um=0.911, flux=None, err=None, ok=False)]
    curves = photometry.light_curves(pts)
    assert len(curves) == 1
    c = curves[0]
    assert (c["lam_min"], c["lam_max"]) == (0.9, 0.92)
    assert [(p["n"], p["flux"]) for p in c["points"]] == [(2, 11.0), (1, 20.0)]
    assert c["points"][0]["err"] == pytest.approx(1.0)  # scatter of 10 and 12 beats the formal 0.07
