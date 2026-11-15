"""Parallax in the motion fit (task A-14). Runs offline and without the image cache.

Outside answers used:
  * astropy's ICRS -> GCRS transformation (ERFA, the IAU SOFA routines) for the direction in which
    the Earth's orbit displaces a nearby star.
  * Gaia DR3 for Barnard's Star, source 4472832130942575872 (through IRSA, data/cubes/barnard/catalog.json):
    proper motion (-0.80155, +10.36239) arcsec/yr, parallax 0.54698 arcsec.
  * Gaia DR3 for Epsilon Indi B, source 6412596012146801152 (data/cubes/epsindb/catalog.json): parallax
    0.27066 arcsec. Its own Gaia motion (+3.982, -2.467) is that of one of the two brown dwarfs, which circle
    each other in 11 years; the pair as a whole follows Epsilon Indi A, Gaia DR3 6412595290592307840:
    (+3.96666, -2.53619) arcsec/yr, parallax 0.27484 arcsec (ESA Gaia archive, gaiadr3.gaia_source, 2026-11-15).
The measured values are read from the committed data/cubes/*/measure.json and motion.json.
"""
import json
import math
from pathlib import Path

import numpy as np
import pytest
from astropy import units as u
from astropy.coordinates import GCRS, SkyCoord
from astropy.time import Time

from data import catalog, measure_static, motion

CUBES = Path(__file__).resolve().parents[1] / "data" / "cubes"
BARNARD_GAIA = dict(id="4472832130942575872", pm_ra=-0.80155, pm_dec=10.36239, parallax=0.54698)
EPSINDB_GAIA_ID = "6412596012146801152"
EPSIND_A_GAIA = dict(pm_ra=3.96666, pm_dec=-2.53619, parallax=0.27484)


def load(*parts):
    return json.loads(CUBES.joinpath(*parts).read_text(encoding="utf-8"))


# ---------------------------------------------------------------- the direction of the parallax shift

@pytest.mark.parametrize("ra, dec", [(269.4463, 4.7681), (331.0971, -56.8013), (133.7604, -7.2418), (10.0, 80.0)])
@pytest.mark.parametrize("mjd", [60913.7, 61000.0, 61116.4, 61273.6])
def test_parallax_factors_agree_with_astropy(ra, dec, mjd):
    parallax = 0.5  # arcsec
    when = Time(mjd, format="mjd")
    # the same direction seen from the Earth for a star at 2 pc and for one very far away: both are
    # shifted alike by aberration and light bending, only the near one by parallax
    near = SkyCoord(ra * u.deg, dec * u.deg, distance=(1.0 / parallax) * u.pc, frame="icrs").transform_to(GCRS(obstime=when))
    far = SkyCoord(ra * u.deg, dec * u.deg, distance=1e9 * u.pc, frame="icrs").transform_to(GCRS(obstime=when))
    east, north = far.spherical_offsets_to(near)
    fe, fn = motion.parallax_factors(ra, dec, mjd)
    assert parallax * fe == pytest.approx(east.to_value(u.arcsec), abs=0.002)
    assert parallax * fn == pytest.approx(north.to_value(u.arcsec), abs=0.002)
    assert math.hypot(fe, fn) <= 1.02  # never further than the parallax itself (the Earth is at most 1.017 au out)


def test_barnard_swings_one_arcsec_between_march_and_august():
    # why three visits (August, March, August) fake a motion: Gaia parallax 0.547", module docstring
    march, _ = motion.parallax_factors(269.4463, 4.7681, 61116.4)
    august, _ = motion.parallax_factors(269.4463, 4.7681, 61273.6)
    assert BARNARD_GAIA["parallax"] * (march - august) == pytest.approx(1.0, abs=0.05)


# ---------------------------------------------------------------- a source with a known motion and parallax

def synthetic_epochs(ra, dec, mjds, pm_ra, pm_dec, parallax, err=0.05, noise=None):
    out = []
    for i, mjd in enumerate(mjds):
        t = (mjd - mjds[0]) / 365.25
        fe, fn = motion.parallax_factors(ra, dec, mjd)
        dra, ddec = 0.3 + pm_ra * t + parallax * fe, -0.2 + pm_dec * t + parallax * fn
        if noise is not None:
            dra, ddec = dra + noise[i][0], ddec + noise[i][1]
        out.append(dict(epoch=i, mjd=mjd, n=10, dra_arcsec=dra, ddec_arcsec=ddec, err_ra=err, err_dec=err))
    return out


VISITS = [60913.7, 61000.0, 61116.4, 61200.0, 61273.6]  # August, November, March, June, August


def test_known_motion_and_parallax_are_both_recovered():
    ra, dec = 269.4463, 4.7681
    epochs = synthetic_epochs(ra, dec, VISITS, -0.80, 10.36, 0.547)
    # parallax known and held fixed: the motion comes back
    m, _, _ = motion.fit_motion(epochs, ra, dec, parallax_arcsec=0.547, parallax_source="test")
    assert (m["pm_ra"], m["pm_dec"]) == (pytest.approx(-0.80, abs=0.002), pytest.approx(10.36, abs=0.002))
    assert m["parallax_arcsec"] == 0.547 and m["parallax_source"] == "test"
    assert m["sys_ra"] == 0.0 and m["sys_dec"] == 0.0  # nothing left over
    # parallax left free: motion and parallax both come back
    p = m["parallax_fit"]
    assert p["parallax_arcsec"] == pytest.approx(0.547, abs=0.002)
    assert (p["pm_ra"], p["pm_dec"]) == (pytest.approx(-0.80, abs=0.002), pytest.approx(10.36, abs=0.002))
    assert p["dof"] == 2 * len(VISITS) - 5


def test_with_noise_the_truth_is_inside_the_error_bars():
    ra, dec = 331.0971, -56.8013
    rng = np.random.default_rng(14)
    misses = 0
    for _ in range(200):
        epochs = synthetic_epochs(ra, dec, VISITS, 3.98, -2.47, 0.275, err=0.08, noise=rng.normal(0, 0.08, (len(VISITS), 2)))
        p = motion.fit_motion(epochs, ra, dec)[0]["parallax_fit"]
        misses += abs(p["parallax_arcsec"] - 0.275) > 2 * p["err"]
    assert misses <= 0.15 * 200  # 2 sigma: about 5% expected (the errors are only ever scaled up)


def test_leaving_parallax_out_fakes_a_motion_and_the_result_says_so():
    ra, dec = 269.4463, 4.7681
    three = [60913.7, 61116.4, 61273.6]  # the visits of Barnard's Star in D2 and D5
    # the first visit poorly measured, as in the real data: the line then rests on March and August
    epochs = synthetic_epochs(ra, dec, three, -0.80, 10.36, 0.547)
    epochs[0]["err_ra"] = 0.5
    plain, _, _ = motion.fit_motion(epochs, ra, dec)
    assert plain["parallax_arcsec"] == 0.0 and plain["parallax_source"] is None
    assert plain["pm_ra"] < -2.5  # the real D5 measurement without parallax: -2.83
    fixed, _, _ = motion.fit_motion(epochs, ra, dec, 0.547, "test")
    assert fixed["pm_ra"] == pytest.approx(-0.80, abs=0.002)
    assert fixed["no_parallax"]["pm_ra"] == plain["pm_ra"] and fixed["no_parallax"]["pm_dec"] == plain["pm_dec"]
    assert plain["no_parallax"]["pm_ra"] == plain["pm_ra"]


def test_parallax_is_not_fitted_when_the_visits_cannot_show_it():
    ra, dec = 269.4463, 4.7681
    two = synthetic_epochs(ra, dec, [60913.7, 61116.4], -0.80, 10.36, 0.547)
    assert motion.fit_motion(two, ra, dec)[0]["parallax_fit"] is None  # too few visits
    # three visits exactly a year apart: the Earth is at the same place each time
    same_season = synthetic_epochs(ra, dec, [60913.7, 60913.7 + 365.25, 60913.7 + 730.5], -0.80, 10.36, 0.547)
    m, _, _ = motion.fit_motion(same_season, ra, dec)
    assert m["parallax_fit"] is None
    assert m["pm_ra"] == pytest.approx(-0.80, abs=0.01)  # and then it does no harm either


def test_apply_parallax_refits_a_result_in_place_and_keeps_the_verdict():
    ra, dec = 269.4463, 4.7681
    epochs = synthetic_epochs(ra, dec, VISITS, -0.80, 10.36, 0.547)
    m, _, _ = motion.fit_motion(epochs, ra, dec)
    result = dict(ra=ra, dec=dec, epochs=epochs, motion=dict(m, status="ok", note=""))
    motion.apply_parallax(result, 0.547, "Gaia DR3 test")
    assert result["motion"]["status"] == "ok" and result["motion"]["parallax_source"] == "Gaia DR3 test"
    assert result["motion"]["pm_ra"] == pytest.approx(-0.80, abs=0.002)
    # the first-to-last shift stays what was measured, parallax and all
    assert result["ddec_arcsec"] == pytest.approx(epochs[-1]["ddec_arcsec"] - epochs[0]["ddec_arcsec"], abs=0.001)
    json.dumps(result, allow_nan=False)


# ---------------------------------------------------------------- which parallax belongs to the target

def write_catalog(folder, sources):
    folder.mkdir(parents=True, exist_ok=True)
    (folder / "catalog.json").write_text(json.dumps(dict(sources=sources)), encoding="utf-8")


def test_target_parallax_follows_the_star_to_the_time_of_the_images(tmp_path):
    mjd = 61100.0  # 2026.16
    years = 2000.0 + (mjd - 51544.5) / 365.25 - 2016.0
    ra, dec = 269.4463, 4.7681
    mover = dict(cat="gaia_dr3", id="1", ra=ra, dec=dec - 10.36 * years / 3600, epoch=2016.0, pm_ra=0.0, pm_dec=10.36, parallax=0.547)
    faint = dict(cat="gaia_dr3", id="2", ra=ra, dec=dec + 2.5 / 3600, epoch=2016.0, pm_ra=None, pm_dec=None, parallax=None)
    still = dict(cat="gaia_dr3", id="3", ra=ra, dec=dec - 2.9 / 3600, epoch=2016.0, pm_ra=0.001, pm_dec=0.001, parallax=0.002)
    wise = dict(cat="catwise2020", id="J", ra=ra, dec=dec, epoch=2015.4, pm_ra=None, pm_dec=None)
    write_catalog(tmp_path / "star", [faint, still, mover, wise])
    assert measure_static.target_parallax(tmp_path / "star", ra, dec, mjd) == (0.547, "Gaia DR3 1")
    # nothing within half a pixel: no parallax, and the fit stays a straight line
    write_catalog(tmp_path / "empty", [dict(mover, pm_dec=0.0)])
    assert measure_static.target_parallax(tmp_path / "empty", ra, dec, mjd) == (0.0, None)
    assert measure_static.target_parallax(tmp_path / "no_catalogue", ra, dec, mjd) == (0.0, None)


def test_parallax_from_the_esa_archive_is_added_only_if_it_holds_the_same_rows(tmp_path):
    # IRSA's TAP service was down on 2026-11-15; the ESA Gaia Archive is the origin of the same table
    star = dict(cat="gaia_dr3", id="1", ra=269.4485, dec=4.7394, epoch=2016.0, pm_ra=-0.80155, pm_dec=10.36239, mag=8.194, mag_band="G", sep_arcsec=103.4)
    faint = dict(cat="gaia_dr3", id="2", ra=269.4467, dec=4.7674, epoch=2016.0, pm_ra=None, pm_dec=None, mag=20.9, mag_band="G", sep_arcsec=2.8)
    wise = dict(cat="catwise2020", id="J", ra=269.44, dec=4.76, epoch=2015.4, pm_ra=None, pm_dec=None, mag=15.0, mag_band="W2", sep_arcsec=30.0)
    folder = tmp_path / "star"
    folder.mkdir()
    path = folder / "catalog.json"
    original = json.dumps(dict(center=dict(ra=269.4463, dec=4.7681), radius_arcsec=150.0, sources=[faint, wise, star],
                               source=dict(archive="IRSA", queried_utc="2026-11-14T06:58:45Z")))
    path.write_text(original, encoding="utf-8")
    asked = []

    def esa(query, pmra="-801.5509783684709"):
        asked.append(query)
        return f"source_id,parallax,pmra,pmdec\n1,546.975939730948,{pmra},10362.394206546573\n2,,,\n"

    # a different star under the same number: refuse, and leave the file as it was
    with pytest.raises(catalog.CatalogError):
        catalog.add_gaia_parallax(folder, fetch=lambda q: esa(q, pmra="-700.0"))
    assert path.read_text(encoding="utf-8") == original

    result, _ = catalog.add_gaia_parallax(folder, fetch=esa)
    assert "gaiadr3.gaia_source" in asked[-1] and "IN (2, 1)" in asked[-1]
    saved = json.loads(path.read_text(encoding="utf-8"))
    assert saved == result
    by_id = {s["id"]: s for s in saved["sources"]}
    assert by_id["1"]["parallax"] == 0.54698   # mas -> arcsec
    assert by_id["2"]["parallax"] is None      # Gaia has no parallax for it
    assert "parallax" not in by_id["J"]        # not a Gaia source
    assert saved["source"]["archive"] == "IRSA" and saved["source"]["parallax"]["archive"].startswith("ESA Gaia Archive")
    # the last kept digit may differ between the archives (0.01 mas/yr): still the same row
    catalog.add_gaia_parallax(folder, fetch=lambda q: esa(q, pmra="-801.56"))


# ---------------------------------------------------------------- detectors answer for each other

def detector(band, pm_ra, err_ra, pm_dec=10.36, err_dec=0.2, status="ok", parallax_fit=None):
    return dict(band=band, epochs=[{}] * 4, motion=dict(
        pm_ra=pm_ra, err_ra=err_ra, pm_dec=pm_dec, err_dec=err_dec, err=max(err_ra, err_dec), n_epochs=4, status=status,
        parallax_arcsec=0.5, parallax_source="test", no_parallax=None, parallax_fit=parallax_fit, detector_agreement=None))


def test_detectors_that_agree_keep_their_error_bars():
    results = [detector("D1", -0.9, 0.3), detector("D2", -0.6, 0.3), detector("D3", -0.8, 0.2), detector("D4", -3.0, 0.1, status="unverified")]
    combined = measure_static.agree(results)
    assert combined["bands"] == ["D1", "D2", "D3"]  # the unverified one has no say
    assert combined["pm_ra"] == pytest.approx(-0.776, abs=0.001)
    assert [r["motion"]["err_ra"] for r in results] == [0.3, 0.3, 0.2, 0.1]
    assert results[0]["motion"]["detector_agreement"]["scale_ra"] == 1.0
    assert results[3]["motion"]["detector_agreement"] is None
    assert "err_ra_fit" not in results[0]["motion"]


def test_detectors_that_disagree_get_wider_error_bars():
    # three "precise" detectors that cannot all be right: -0.8, -2.0, -3.0, each claiming +-0.1
    results = [detector("D1", -0.8, 0.1), detector("D2", -2.0, 0.1), detector("D3", -3.0, 0.1)]
    combined = measure_static.agree(results)
    for r in results:
        m = r["motion"]
        assert m["err_ra_fit"] == 0.1 and m["err_ra"] > 1.0  # scaled by sqrt(chi2 / 2) = 11
        assert abs(m["pm_ra"] - combined["pm_ra"]) < 2 * m["err_ra"]
        assert m["err_dec"] == 0.2 and "err_dec_fit" not in m  # the other axis agreed
        assert m["err"] == m["err_ra"]
    assert combined["err_ra"] == pytest.approx(0.1 / math.sqrt(3) * math.sqrt(combined["chi2_ra"] / 2), abs=0.002)


def test_fewer_than_three_good_detectors_are_left_alone():
    results = [detector("D1", -0.8, 0.1), detector("D2", -3.0, 0.1)]
    assert measure_static.agree(results) is None
    assert measure_static.parallax_measured(results) is None
    assert results[0]["motion"]["err_ra"] == 0.1


def test_measured_parallax_uses_the_scatter_between_detectors():
    fits = [0.37, 0.17, 0.34, 0.34, 0.31]
    results = [detector(f"D{i + 2}", 4.0, 0.1, parallax_fit=dict(parallax_arcsec=v, err=0.03)) for i, v in enumerate(fits)]
    p = measure_static.parallax_measured(results)
    assert p["bands"] == ["D2", "D3", "D4", "D5", "D6"] and p["n_independent"] == 3
    assert p["parallax_arcsec"] == pytest.approx(0.306, abs=0.001)
    assert p["err"] == pytest.approx(np.std(fits, ddof=1) / math.sqrt(3), abs=0.001)  # 0.046, not 0.03 / sqrt(5)
    assert p["distance_pc"] == pytest.approx(1 / 0.306, abs=0.01)
    # no distance from a parallax that does not stand out from zero
    weak = [detector(f"D{i + 1}", 4.0, 0.1, parallax_fit=dict(parallax_arcsec=v, err=0.1)) for i, v in enumerate([0.6, -0.8, -0.1, 0.2])]
    assert measure_static.parallax_measured(weak)["distance_pc"] is None


# ---------------------------------------------------------------- the committed measurements

BANDS = ["D1", "D2", "D3", "D4", "D5", "D6"]


def test_catalogue_gives_barnard_its_gaia_parallax():
    star = [s for s in load("barnard", "catalog.json")["sources"] if s["id"] == BARNARD_GAIA["id"]][0]
    assert star["parallax"] == BARNARD_GAIA["parallax"]
    assert (star["pm_ra"], star["pm_dec"]) == (BARNARD_GAIA["pm_ra"], BARNARD_GAIA["pm_dec"])
    for band in BANDS:
        m = load("barnard", band, "measure.json")["motion"]
        assert m["parallax_arcsec"] == BARNARD_GAIA["parallax"]
        assert m["parallax_source"] == f"Gaia DR3 {BARNARD_GAIA['id']}"


@pytest.mark.parametrize("band", BANDS)
def test_barnard_error_bar_covers_the_catalogue_motion_or_the_result_is_not_called_ok(band):
    """tasks/A.md A-14, "Дууссан". Before: D5 said pm_ra = -2.83 +- 0.19 with status ok; Gaia has -0.80."""
    m = load("barnard", band, "measure.json")["motion"]
    print(band, m["status"], f"pm_ra {m['pm_ra']} +- {m['err_ra']}", f"pm_dec {m['pm_dec']} +- {m['err_dec']}",
          "without parallax:", m["no_parallax"]["pm_ra"])
    if m["status"] == "ok":
        assert abs(m["pm_ra"] - BARNARD_GAIA["pm_ra"]) <= 2 * m["err_ra"]
        assert abs(m["pm_dec"] - BARNARD_GAIA["pm_dec"]) <= 2 * m["err_dec"]


def test_barnard_unsaturated_detectors_are_precise_once_parallax_is_in():
    for band in ("D5", "D6"):
        m = load("barnard", band, "measure.json")["motion"]
        assert m["status"] == "ok"
        assert m["pm_ra"] == pytest.approx(BARNARD_GAIA["pm_ra"], abs=0.5) and m["err_ra"] < 1.0
        # and the straight line alone was off by more than its error bar
        assert abs(m["no_parallax"]["pm_ra"] - BARNARD_GAIA["pm_ra"]) > 3 * m["no_parallax"]["err_ra"]


def test_barnard_all_detectors_together():
    c = load("barnard", "motion.json")["combined"]
    assert len(c["bands"]) >= 3
    assert abs(c["pm_ra"] - BARNARD_GAIA["pm_ra"]) <= 2 * c["err_ra"]
    assert abs(c["pm_dec"] - BARNARD_GAIA["pm_dec"]) <= 2 * c["err_dec"]
    assert c["err_ra"] < 0.5 and c["err_dec"] < 0.5


def test_epsilon_indi_b_motion_and_distance_from_spherex_alone():
    gaia = [s for s in load("epsindb", "catalog.json")["sources"] if s["id"] == EPSINDB_GAIA_ID][0]
    summary = load("epsindb", "motion.json")
    assert summary["parallax_source"] == f"Gaia DR3 {EPSINDB_GAIA_ID}" and summary["parallax_arcsec"] == gaia["parallax"]
    assert gaia["parallax"] == pytest.approx(0.27066, abs=1e-5)
    c = summary["combined"]
    print("combined", c, "measured parallax", summary["parallax_measured"])
    assert len(c["bands"]) >= 3
    assert abs(c["pm_ra"] - EPSIND_A_GAIA["pm_ra"]) <= 2 * c["err_ra"] and abs(c["pm_dec"] - EPSIND_A_GAIA["pm_dec"]) <= 2 * c["err_dec"]
    assert c["err_ra"] < 0.2 and c["err_dec"] < 0.2
    # with the parallax left free, the images alone give it, and so the distance (Gaia: 3.7 pc)
    p = summary["parallax_measured"]
    assert p["sigma"] >= 3.0
    assert abs(p["parallax_arcsec"] - gaia["parallax"]) <= 2 * p["err"]
    assert p["distance_pc"] == pytest.approx(1.0 / gaia["parallax"], rel=0.35)


def test_wise0855_has_no_catalogue_parallax_and_is_fitted_with_a_straight_line():
    # not in Gaia DR3; in D1-D4 the light is a Gaia star 8 arcsec away (data/measure_static.py), whose
    # parallax must not be given to the target either
    assert load("wise0855", "motion.json")["parallax_arcsec"] == 0.0
    for band in BANDS:
        m = load("wise0855", band, "measure.json")["motion"]
        assert m["parallax_arcsec"] == 0.0 and m["parallax_source"] is None and m["status"] == "unverified"


@pytest.mark.parametrize("obj", ["barnard", "epsindb", "rdra", "rwaur", "wise0855"])
def test_every_motion_says_which_parallax_it_used(obj):
    summary = load(obj, "motion.json")
    assert [d["band"] for d in summary["detectors"]] == BANDS
    for band in BANDS:
        m = load(obj, band, "measure.json")["motion"]
        if m is None:
            continue
        assert {"parallax_arcsec", "parallax_source", "no_parallax", "parallax_fit", "detector_agreement"} <= set(m)
        assert (m["parallax_arcsec"] == 0.0) == (m["parallax_source"] is None)
        if m["parallax_arcsec"] == 0.0:
            assert (m["no_parallax"]["pm_ra"], m["no_parallax"]["pm_dec"]) == (m["pm_ra"], m["pm_dec"])
