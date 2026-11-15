"""Tests for the pipeline flags in the cubes and in the photometry (task A-09, done with A-08).

The flag table is read from each SPHEREx file's own FLAGS header, so nothing here states what a
bit means on its own authority: the names asserted below (OVERFLOW = bit 1, SOURCE = bit 21, ...)
are the ones printed by the files in the cache (l2b-v20 .. l2b-v27, checked 2026-11-14).

All tests read committed files or build headers and points by hand; none needs the cache.
"""
import json
from pathlib import Path

import numpy as np
import pytest
from astropy.io import fits

from data import cube, photometry

CUBES = Path(__file__).resolve().parents[1] / "data" / "cubes"


def load(obj, band, name):
    return json.loads((CUBES / obj / band / name).read_text(encoding="utf-8"))


# ---- the bit table, in both header styles --------------------------------------------------------

def test_flag_table_from_an_l2b_v27_header():
    h = fits.Header()
    h["MSKN0001"] = "OVERFLOW"
    h["MSKD0001"] = "Overflow detected during SUR"
    h["MSKN0021"] = "SOURCE"
    h["MSKD0021"] = "Pixel mapped to a known source"
    assert cube.flag_table(h) == {1: ("OVERFLOW", "Overflow detected during SUR"),
                                  21: ("SOURCE", "Pixel mapped to a known source")}


def test_flag_table_from_an_l2b_v20_header():
    h = fits.Header()
    h["MP_OVERFLOW"] = (1, "Overflow detected during SUR")
    h["MP_SOURCE"] = (21, "Pixel mapped to a known source")
    h["BITPIX"] = 32
    assert cube.flag_table(h) == {1: ("OVERFLOW", "Overflow detected during SUR"),
                                  21: ("SOURCE", "Pixel mapped to a known source")}


def test_informational_bits_are_not_defects():
    table = {1: ("OVERFLOW", ""), 12: ("FULLSAMPLE", ""), 21: ("SOURCE", "")}
    flags = np.array([[0, 1 << 21], [1 << 12, (1 << 21) | (1 << 1)]], dtype=np.int64)
    assert cube.defect_mask(flags, table).tolist() == [[False, False], [False, True]]
    # a file that explains none of its bits: any bit counts
    assert cube.defect_mask(flags, {}).tolist() == [[False, True], [True, True]]


# ---- the committed cubes -------------------------------------------------------------------------

@pytest.mark.parametrize("obj,band", [("barnard", "D1"), ("wise0855", "D6"), ("epsindb", "D2"), ("rwaur", "D1"), ("rdra", "D1")])
def test_cube_carries_the_flag_table_and_a_flag_plane(obj, band):
    meta = load(obj, band, "cube.json")
    names = meta["flag_names"]
    assert names["1"] == "OVERFLOW" and names["0"] == "TRANSIENT" and names["21"] == "SOURCE"
    assert set(meta["flag_descriptions"]) == set(names)
    assert meta["flags_informational"] == [12, 21]
    assert meta["flags_url"] == "flags.u8"
    n, h, w = meta["shape"]
    plane = np.fromfile(CUBES / obj / band / "flags.u8", dtype=np.uint8)
    assert plane.size == n * h * w  # tasks/A.md A-09
    assert set(np.unique(plane)) <= {0, 1}
    for f in meta["frames"]:
        assert set(f["flags"]) == {"any_frac", "center_bits"}
        assert 0.0 <= f["flags"]["any_frac"] <= 1.0
        assert all(str(b) in names for b in f["flags"]["center_bits"])
        assert 21 in f["flags"]["center_bits"]  # every demo object is a catalogued source


def test_barnard_core_is_flagged_as_overflowed():
    meta = load("barnard", "D1", "cube.json")
    n, h, w = meta["shape"]
    overflow = [1 in f["flags"]["center_bits"] for f in meta["frames"]]
    print(f"Barnard D1: OVERFLOW at the centre in {sum(overflow)} of {n} frames")
    assert sum(overflow) >= 0.9 * n
    plane = np.fromfile(CUBES / "barnard" / "D1" / "flags.u8", dtype=np.uint8).reshape(n, h, w)
    # the star is within 6" of the centre in every frame: the 5 x 5 pixels there are flagged
    assert plane[:, 28:33, 28:33].mean() > 0.9
    # and the flags are about the star, not the whole picture
    assert plane.mean() < 0.3


def test_blank_sky_is_mostly_unflagged():
    meta = load("wise0855_control", "D6", "cube.json")
    assert np.median([f["flags"]["any_frac"] for f in meta["frames"]]) < 0.2


# ---- photometry: a flagged point far off its visit is dropped ------------------------------------

def pt(flux, flags=(), epoch=0, err=0.2, lam=4.5):
    return dict(mjd=60000.0, epoch=epoch, lam_um=lam, flux=flux, err=err, ok=True, why="", flags=list(flags))


def test_flagged_and_far_off_is_rejected_with_a_reason():
    pts = [pt(0.5), pt(0.6), pt(0.4), pt(0.7), pt(0.5), pt(522.7, ["OUTLIER", "TRANSIENT"], err=8.6)]
    photometry.reject_artifacts(pts, "mJy")
    assert [p["ok"] for p in pts] == [True] * 5 + [False]
    bad = pts[-1]
    assert bad["flux"] is None and bad["err"] is None
    assert "cosmic ray or artifact" in bad["why"] and "OUTLIER, TRANSIENT" in bad["why"] and "522.7 mJy" in bad["why"]


def test_a_flag_alone_or_a_deviation_alone_is_not_enough():
    # bright stars carry TRANSIENT on most pixels; a real spectral feature deviates without any flag
    flagged_but_normal = [pt(100.0, ["TRANSIENT"]), pt(101.0, ["TRANSIENT"]), pt(99.0), pt(100.5), pt(100.2)]
    photometry.reject_artifacts(flagged_but_normal)
    assert all(p["ok"] for p in flagged_but_normal)
    deviant_but_clean = [pt(0.5), pt(0.6), pt(0.4), pt(0.7), pt(0.5), pt(30.0)]
    photometry.reject_artifacts(deviant_but_clean)
    assert all(p["ok"] for p in deviant_but_clean)
    other_flags_do_not_count = [pt(0.5), pt(0.6), pt(0.4), pt(0.7), pt(0.5), pt(30.0, ["OVERFLOW", "NONFUNC", "SUR_ERROR"])]
    photometry.reject_artifacts(other_flags_do_not_count)
    assert all(p["ok"] for p in other_flags_do_not_count)


def test_points_are_compared_only_within_their_visit_and_small_visits_are_left_alone():
    two_visits = [pt(0.5, epoch=0), pt(0.6, epoch=0), pt(0.4, epoch=0), pt(0.7, epoch=0), pt(0.5, epoch=0),
                  pt(50.0, ["TRANSIENT"], epoch=1), pt(51.0, epoch=1), pt(49.0, epoch=1), pt(50.5, epoch=1), pt(50.2, epoch=1)]
    photometry.reject_artifacts(two_visits)
    assert all(p["ok"] for p in two_visits)  # 50 is normal for visit 1
    tiny = [pt(0.5), pt(0.6), pt(500.0, ["TRANSIENT"])]
    photometry.reject_artifacts(tiny)
    assert all(p["ok"] for p in tiny)  # two other points cannot say what is normal


def test_two_bad_points_in_one_visit_are_both_judged_against_the_visit_as_measured():
    pts = [pt(0.5), pt(0.6), pt(0.4), pt(0.7), pt(0.5), pt(0.55), pt(400.0, ["TRANSIENT"]), pt(900.0, ["SNOWBALL"])]
    photometry.reject_artifacts(pts)
    assert [p["ok"] for p in pts] == [True] * 6 + [False, False]


def test_a_real_spectral_feature_is_kept_when_other_visits_agree_at_its_wavelength():
    # Epsilon Indi B, D2, as measured on 2026-11-14 (mJy, rounded): every image of a visit is at
    # another wavelength, and at 1.21 um the spectrum of a T dwarf climbs to its J-band peak.
    visit = [pt(13.6, lam=1.10, epoch=2), pt(14.1, lam=1.12, epoch=2), pt(13.9, lam=1.14, epoch=2),
             pt(14.0, lam=1.16, epoch=2), pt(17.0, lam=1.186, epoch=2), pt(13.2, lam=1.09, epoch=2)]
    flagged = pt(28.52, ["HALO", "SUR_ERROR", "TRANSIENT"], lam=1.2147, epoch=2)
    others = [pt(24.13, lam=1.2011, epoch=4), pt(27.03, lam=1.2121, epoch=1), pt(28.80, lam=1.2130, epoch=0),
              pt(27.88, lam=1.2146, epoch=4), pt(32.47, lam=1.2300, epoch=4), pt(28.47, lam=1.2148, epoch=3)]
    pts = visit + [flagged] + others
    photometry.reject_artifacts(pts, "mJy")
    assert all(p["ok"] for p in pts)
    # the same point without the other visits is still kept: it cannot be checked
    alone = [dict(p, ok=True) for p in visit] + [dict(flagged)]
    photometry.reject_artifacts(alone, "mJy")
    assert all(p["ok"] for p in alone)


def test_on_a_slope_a_point_is_judged_against_the_line_through_its_neighbours():
    # a spectrum climbing from 12 to 41 mJy over 0.4 um, sampled by two visits
    def slope(lam):
        return 12.0 + (lam - 3.35) * 72.5
    lams = [3.35, 3.40, 3.45, 3.52, 3.56, 3.60, 3.64, 3.70, 3.75]
    base = [pt(round(slope(x), 2), lam=x, epoch=i % 2) for i, x in enumerate(lams)]
    flat = [pt(12.0, lam=2.5 + 0.1 * i, epoch=e) for i in range(5) for e in (0, 1)]  # the rest of both visits
    hit = pt(71.0, ["TRANSIENT"], lam=3.49, epoch=1)
    on_the_line = pt(round(slope(3.67), 2), ["TRANSIENT"], lam=3.67, epoch=1)  # 35 mJy: far from its visit, not from the line
    pts = base + flat + [hit, on_the_line]
    photometry.reject_artifacts(pts, "mJy")
    assert not hit["ok"] and "71 mJy" in hit["why"]
    assert on_the_line["ok"]
    assert all(p["ok"] for p in base + flat)


def test_a_point_beyond_all_its_neighbours_in_wavelength_is_not_judged():
    # the line through the neighbours would be extrapolated; at the end of a detector that is a guess
    rising = [pt(40.0 + 400.0 * (x - 4.90), lam=x, epoch=i % 2) for i, x in enumerate([4.90, 4.92, 4.94, 4.96, 4.98, 4.99])]
    flat = [pt(40.0, lam=4.5 + 0.02 * i, epoch=e) for i in range(6) for e in (0, 1)]
    last = pt(110.0, ["TRANSIENT"], lam=5.006, epoch=0)  # R Dra, D6, 2026-11-14
    pts = rising + flat + [last]
    photometry.reject_artifacts(pts)
    assert last["ok"]


def test_wing_photometry_is_not_cut_by_the_artifact_rule():
    # saturated stars set TRANSIENT on their own image in nearly every exposure (data/photometry.py)
    for obj in ("barnard", "rdra"):
        for band in ("D1", "D2", "D3", "D4", "D5", "D6"):
            m = load(obj, band, "measure.json")
            assert m["photometry_method"] == "wing"
            assert not [p for p in m["photometry"] if "artifact" in p["why"]], f"{obj} {band}"


def test_wise0855_cosmic_ray_point_is_dropped_by_the_rule():
    m = load("wise0855", "D6", "measure.json")
    bad = [p for p in m["photometry"] if not p["ok"]]
    assert len(m["photometry"]) == 45 and len(bad) == 1  # GitHub issue #42: 44 points remain
    assert "cosmic ray or artifact" in bad[0]["why"] and "522.7" in bad[0]["why"]
    usable = [p["flux"] for p in m["photometry"] if p["ok"]]
    assert max(usable) < 10  # mJy; the chart is no longer flattened by one point
    assert m["photometry_flags"].get("TRANSIENT", 0) >= 2  # other flagged points were kept


def test_rw_aur_overflow_is_reported_not_hidden():
    m = load("rwaur", "D1", "measure.json")
    assert m["photometry_method"] == "aperture" and all(p["ok"] for p in m["photometry"])
    assert m["photometry_flags"]["OVERFLOW"] > 0
    assert "overflowed" in m["photometry_note"]
