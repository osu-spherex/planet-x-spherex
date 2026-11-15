"""Acceptance tests: answers known from outside sources.

These define what the data pipeline must get right. They are skipped until `data/motion.py`
exists (it is written during the hackathon). Humans own these tests: if one fails, fix the code,
not the test.

Expected interface (to implement in data/motion.py):
    measure_shift(ra_deg, dec_deg, band="SPHEREx-D1") -> dict with keys
        "dra_arcsec", "ddec_arcsec", "years"   (first vs last observation)
"""
import pytest

motion = pytest.importorskip("data.motion", reason="data/motion.py not written yet")

pytestmark = pytest.mark.network  # needs IRSA


def test_barnard_star_moves_north():
    # Barnard's Star proper motion ~ +10.3"/yr in Dec (SIMBAD).
    # Measured 2026-11-10 with experiments/barnard_check.py: +10.71" over ~1.02 yr.
    r = motion.measure_shift(269.4464, 4.7666)
    expected = 10.33 * r["years"]
    assert r["years"] > 0.5
    assert r["ddec_arcsec"] == pytest.approx(expected, abs=2.0)


def test_static_field_star_does_not_move():
    # A star with negligible proper motion must show ~0 shift. Guards against fake motion
    # from bad WCS alignment.
    # Gaia DR3 star 1.28' from Barnard's Star: RA 269.43868, Dec 4.78653, G = 13.6,
    # total proper motion 6.1 mas/yr (= 0.006"/yr, i.e. static for us). Source: Gaia DR3 via IRSA.
    # Measured 2026-11-10 with the experiments/barnard_check.py centroid: dRA +0.16", dDec -1.39"
    # over ~1 yr, so ~1.5" is the current measurement noise.
    r = motion.measure_shift(269.43868, 4.78653)
    assert abs(r["dra_arcsec"]) < 2.0
    assert abs(r["ddec_arcsec"]) < 2.0
