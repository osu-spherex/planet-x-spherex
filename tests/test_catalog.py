"""Tests for data/catalog.py (task A-11). None of them touches the network.

Three kinds:
  * conversion rules on hand-written rows (units, when a CatWISE motion is passed on);
  * parsing of two answers saved from IRSA on 2026-11-14 (tests/fixtures/irsa_*_barnard_45arcsec.csv);
  * the catalog.json files committed next to the cubes, against answers known from elsewhere:
    Barnard's Star proper motion -0.80, +10.36 arcsec/yr (Gaia DR3, experiments/check_objects.py);
    WISE 0855 motion -7.965, +0.806 arcsec/yr (CatWISE2020, same file); the blank control field
    described in data/control_cube.py and PR #43.
"""
import json
import math
import re
from pathlib import Path

import pytest

from data import catalog

REPO = Path(__file__).resolve().parents[1]
CUBES = REPO / "data" / "cubes"
FIXTURES = Path(__file__).resolve().parent / "fixtures"
OBJECTS = ["barnard", "wise0855", "epsindb", "rwaur", "rdra"]
KEYS = {"cat", "id", "ra", "dec", "epoch", "pm_ra", "pm_dec", "mag", "mag_band"}  # docs/ARCHITECTURE.md

GAIA_HEAD = "source_id,ra,dec,ref_epoch,pmra,pmdec,phot_g_mean_mag\n"
CATWISE_HEAD = "source_name,ra,dec,meanobsmjd,ra_pm,dec_pm,pmra,pmdec,sigpmra,sigpmdec,w1mpro,w2mpro,rchi2,rchi2_pm\n"


def strict_load(path):
    def refuse(token):
        raise ValueError(f"{path}: {token} is not valid JSON")
    return json.loads(Path(path).read_text(encoding="utf-8"), parse_constant=refuse)


def at_year(s, year):
    """Position of a catalogue source in `year`, by the rule in the module docstring."""
    if s["pm_ra"] is None:
        return s["ra"], s["dec"]
    dt = year - s["epoch"]
    return (s["ra"] + s["pm_ra"] * dt / 3600 / math.cos(math.radians(s["dec"])), s["dec"] + s["pm_dec"] * dt / 3600)


# ---- conversion rules -------------------------------------------------------------------------

def test_gaia_motion_is_converted_from_mas_to_arcsec_per_year():
    # Barnard's Star in Gaia DR3: pmra -801.551, pmdec 10362.394 mas/yr
    row = "4472832130942575872,269.44850,4.73980,2016.0,-801.551,10362.394,8.1940\n"
    (s,) = catalog.parse_gaia(GAIA_HEAD + row)
    assert s == dict(cat="gaia_dr3", id="4472832130942575872", ra=269.4485, dec=4.7398, epoch=2016.0,
                     pm_ra=-0.80155, pm_dec=10.36239, mag=8.194, mag_band="G")
    assert isinstance(s["id"], str)  # a 64-bit id does not survive as a JavaScript number


def test_gaia_source_without_a_motion_solution_gets_null():
    (s,) = catalog.parse_gaia(GAIA_HEAD + "123,10.5,-3.25,2016.0,,,20.9\n")
    assert s["pm_ra"] is None and s["pm_dec"] is None and s["mag"] == 20.9


def test_catwise_passes_on_only_motion_its_own_fit_supports():
    # Rows with the numbers CatWISE2020 really lists (IRSA, 2026-11-14) for: WISE 0855; a faint
    # still source; a fragment of Barnard's Star's image (J175747.84+044521.6) and another one
    # whose fit with motion looks fine but is hardly better than without (J175755.89+044615.4).
    mover = "J085508.34-071439.2,133.7848,-7.2442,57170.2,133.7847613,-7.2442498,-7.965,0.806,0.19,0.19,18.51,15.72,5.16,1.00\n"
    noisy = "J085500.00-071500.0,133.7500,-7.2500,57171.0,133.7501,-7.2501,0.25,-0.18,0.15,0.16,17.9,17.6,0.86,0.84\n"
    fragment = "J175747.84+044521.6,269.4493,4.7560,57170.0,269.4494,4.7559,3.251,-8.927,0.051,0.051,14.47,14.15,175.1,151.7\n"
    plausible = "J175755.89+044615.4,269.4829,4.7709,57170.0,269.4830,4.7708,-4.082,5.794,0.239,0.239,18.42,16.79,2.45,1.39\n"
    slow = "J085501.00-071501.0,133.7510,-7.2510,57171.0,133.7511,-7.2511,0.04,-0.03,0.004,0.004,12.0,12.1,3.0,1.0\n"
    m, n, f, q, s = catalog.parse_catwise(CATWISE_HEAD + mover + noisy + fragment + plausible + slow)
    # the mover: motion-fit position at its epoch, motion kept
    assert (m["ra"], m["dec"], m["epoch"]) == (133.7847613, -7.2442498, 2015.405)
    assert (m["pm_ra"], m["pm_dec"]) == (-7.965, 0.806)
    assert (m["mag"], m["mag_band"]) == (15.72, "W2")
    # 0.3 arcsec/yr at 2 sigma is noise: no motion, the plain position at its mean epoch
    assert n["pm_ra"] is None and n["pm_dec"] is None
    assert (n["ra"], n["dec"]) == (133.75, -7.25)
    assert n["epoch"] == pytest.approx(2015.4, abs=0.05)
    # 9.5 arcsec/yr at 180 sigma, but the fit is terrible with or without motion: not believed
    assert f["pm_ra"] is None and (f["ra"], f["dec"]) == (269.4493, 4.756)
    # a decent fit with motion that is not clearly better than the fit without: not believed
    assert q["pm_ra"] is None
    # precise but tiny (0.05 arcsec/yr is 0.5" in ten years, a sixth of a cube pixel): not passed on
    assert s["pm_ra"] is None


def test_catwise_lists_one_moving_object_several_times_and_we_keep_one():
    # The four entries CatWISE2020 has for WISE 0855, with the numbers IRSA returned on 2026-11-14
    # (SELECT * within 45" of 133.7818, -7.2440). a and b pass the motion test and differ by less
    # than their uncertainties; c and d fit badly with motion (rchi2_pm 3.6 and 1.7).
    # Kept: a, whose rchi2_pm is nearest to 1 (tasks/A.md A-09 addendum; docs/DECISIONS.md
    # 2026-11-14 19:00). Until then the smallest rchi2_pm won, which kept b.
    a = "J085508.34-071439.2,133.7847613,-7.2442498,57104.762546,133.7839831,-7.2441961,-7.96500,0.80620,0.1903,0.2646,18.507,15.721,5.160,1.005\n"
    b = "J085506.91-071437.5,133.7788255,-7.2437546,57853.135215,133.7835555,-7.2440520,-7.91990,0.49390,0.1520,0.2353,19.456,15.541,5.272,0.7765\n"
    c = "J085507.45-071437.8,133.7810440,-7.2438511,57444.593259,133.7814426,-7.2422677,-4.25156,-3.61000,0.2217,0.2210,19.774,16.150,5.412,3.649\n"
    d = "J085507.96-071439.3,133.7831722,-7.2442516,57338.571065,133.7839240,-7.2443404,-8.02120,1.03570,0.0892,0.1412,19.577,15.787,5.546,1.726\n"
    far = "J085600.00-071500.0,134.0000,-7.2500,57170.2,134.0000000,-7.2500000,-2.000,0.100,0.05,0.05,15.0,14.0,6.0,1.1\n"
    for rows in (b + a + c + d + far, a + d + c + b + far):  # the order of the answer must not matter
        out = catalog.parse_catwise(CATWISE_HEAD + rows)
        assert "J085506.91-071437.5" not in [s["id"] for s in out]  # the duplicate is dropped
        moving = {s["id"]: s for s in out if s["pm_ra"] is not None}
        assert sorted(moving) == ["J085508.34-071439.2", "J085600.00-071500.0"]
        kept = moving["J085508.34-071439.2"]
        assert (kept["pm_ra"], kept["pm_dec"], kept["epoch"]) == (-7.965, 0.8062, 2015.405)
        assert (kept["ra"], kept["dec"]) == (133.7839831, -7.2441961)
        # the two bad fits stay as plain entries without motion
        assert {s["id"] for s in out if s["pm_ra"] is None} == {"J085507.45-071437.8", "J085507.96-071439.3"}


def test_catwise_falls_back_to_w1_when_there_is_no_w2():
    row = "J000000.00+000000.0,10.0,5.0,57170.0,10.0,5.0,0.0,0.0,0.1,0.1,16.2,,1.0,1.0\n"
    (s,) = catalog.parse_catwise(CATWISE_HEAD + row)
    assert (s["mag"], s["mag_band"]) == (16.2, "W1")


def test_cone_query_and_separation():
    q = catalog.cone_query("gaia_dr3_source", "ra, dec", 269.4462864, 4.7680655, 150)
    assert q == ("SELECT ra, dec FROM gaia_dr3_source WHERE 1=CONTAINS(POINT('ICRS', ra, dec), "
                 "CIRCLE('ICRS', 269.4462864, 4.7680655, 0.0416667))")
    assert catalog.separation_arcsec(10.0, 60.0 + 30 / 3600, 10.0, 60.0) == pytest.approx(30.0, abs=1e-6)
    assert catalog.separation_arcsec(10.0 + 60 / 3600, 60.0, 10.0, 60.0) == pytest.approx(30.0, abs=1e-3)  # cos 60
    assert catalog.separation_arcsec(0.001, 0.0, 359.999, 0.0) == pytest.approx(7.2, abs=1e-6)  # across RA = 0


# ---- answers saved from IRSA ------------------------------------------------------------------

@pytest.fixture(scope="module")
def saved():
    return {name: (FIXTURES / f"irsa_{name}_barnard_45arcsec.csv").read_text(encoding="utf-8") for name in ("gaia", "catwise")}


def test_saved_answers_parse(saved):
    gaia, catwise = catalog.parse_gaia(saved["gaia"]), catalog.parse_catwise(saved["catwise"])
    assert len(gaia) == len(saved["gaia"].strip().splitlines()) - 1 > 0
    assert len(catwise) == len(saved["catwise"].strip().splitlines()) - 1 > 0
    for s in gaia + catwise:
        assert set(s) == KEYS
        assert 269.4 < s["ra"] < 269.5 and 4.7 < s["dec"] < 4.8
        assert (s["pm_ra"] is None) == (s["pm_dec"] is None)
    for s in gaia:
        assert s["cat"] == "gaia_dr3" and s["id"].isdigit() and s["epoch"] == 2016.0 and s["mag_band"] == "G"
        if s["pm_ra"] is not None:
            assert abs(s["pm_ra"]) < 15 and abs(s["pm_dec"]) < 15  # arcsec/yr, not mas/yr
    for s in catwise:
        assert s["cat"] == "catwise2020" and s["id"].startswith("J") and s["mag_band"] in ("W1", "W2")
        assert 2010 < s["epoch"] < 2021  # WISE and NEOWISE observations behind CatWISE2020


def test_sources_near_with_saved_answers(saved):
    calls = []

    def fetch(query):
        calls.append(query)
        return saved["gaia"] if "gaia_dr3_source" in query else saved["catwise"]

    r = catalog.sources_near(269.4462864, 4.7680655, 45.0, fetch=fetch)
    assert len(calls) == 2 and "catwise_2020" in calls[1]
    assert r["center"] == {"ra": 269.4462864, "dec": 4.7680655} and r["radius_arcsec"] == 45.0
    assert r["source"]["archive"].startswith("NASA/IPAC IRSA") and r["source"]["queried_utc"].endswith("Z")
    seps = [s["sep_arcsec"] for s in r["sources"]]
    assert seps == sorted(seps) and seps[-1] <= 45.5
    assert {s["cat"] for s in r["sources"]} == {"gaia_dr3", "catwise2020"}
    json.dumps(r, allow_nan=False)


def test_impossible_requests_are_refused_before_asking_irsa():
    def fetch(query):
        raise AssertionError("must not be called")
    for ra, dec, radius in ((360.0, 0, 60), (-1, 0, 60), (10, 91, 60), (10, 0, 0), (10, 0, 5000)):
        with pytest.raises(ValueError):
            catalog.sources_near(ra, dec, radius, fetch=fetch)


# ---- IRSA down --------------------------------------------------------------------------------

class Answer:
    def __init__(self, status_code, text):
        self.status_code, self.text = status_code, text


def test_irsa_down_gives_one_clear_error_after_retrying():
    calls, waits = [], []

    def get(url, params, timeout):
        calls.append(params["QUERY"])
        raise ConnectionError("connection reset by peer")

    with pytest.raises(catalog.CatalogError) as e:
        catalog.tap_csv("SELECT 1", tries=3, get=get, sleep=waits.append)
    assert len(calls) == 3 and len(waits) == 2
    assert "did not answer after 3 attempts" in str(e.value) and "connection reset" in str(e.value)


def test_503_is_retried_and_a_later_good_answer_is_used():
    answers = [Answer(503, "Service Unavailable"), Answer(200, "<html>busy</html>"), Answer(200, "ra,dec\n1,2\n")]
    text = catalog.tap_csv("SELECT 1", get=lambda url, params, timeout: answers.pop(0), sleep=lambda s: None)
    assert text == "ra,dec\n1,2\n" and answers == []


def test_a_rejected_query_is_not_asked_again():
    calls = []

    def get(url, params, timeout):
        calls.append(1)
        return Answer(400, "<VOTABLE>ERROR: unknown column</VOTABLE>")

    with pytest.raises(catalog.CatalogError):
        catalog.tap_csv("SELECT nope", get=get, sleep=lambda s: None)
    assert len(calls) == 1


# ---- the committed catalog.json files ---------------------------------------------------------

@pytest.fixture(scope="module")
def committed():
    return {o: strict_load(CUBES / o / "catalog.json") for o in OBJECTS + ["wise0855_control"]}


def test_committed_files_have_the_documented_format(committed):
    for name, c in committed.items():
        assert set(c) == {"center", "radius_arcsec", "sources", "source"}, name
        assert c["radius_arcsec"] == 150
        assert c["center"] == catalog.cube_centre(CUBES / name)
        assert len(c["sources"]) > 5, name
        for s in c["sources"]:
            assert KEYS <= set(s), name
            assert s["cat"] in ("gaia_dr3", "catwise2020") and isinstance(s["id"], str)
            assert s["sep_arcsec"] <= 151
            assert (s["pm_ra"] is None) == (s["pm_dec"] is None)
        cats = {s["cat"] for s in c["sources"]}
        assert "gaia_dr3" in cats, name
        # R Dra is so bright in the infrared that CatWISE2020 lists nothing within 150" of it
        # (the IRSA query returned no rows, twice, on 2026-11-14); every other field has both.
        assert ("catwise2020" in cats) == (name != "rdra"), name


def test_barnard_is_there_with_its_catalogue_motion(committed):
    c = committed["barnard"]
    fast = [s for s in c["sources"] if s["cat"] == "gaia_dr3" and s["pm_dec"] is not None and s["pm_dec"] > 5]
    assert len(fast) == 1
    star = fast[0]
    assert star["pm_ra"] == pytest.approx(-0.80, abs=0.01) and star["pm_dec"] == pytest.approx(10.36, abs=0.01)
    assert star["epoch"] == 2016.0
    # In 2016 it was about 105" south of where the cube is centred (its place at MJD 61100 = 2026.16).
    assert star["sep_arcsec"] == pytest.approx(105, abs=5)
    # The cube centre is only an approximate prediction for MJD 61100 (experiments/check_objects.py
    # starts from a rounded mid-2025 position): Gaia, moved to that date, lands 2.2" north of it.
    ra, dec = at_year(star, catalog.mjd_to_year(61100.0))
    assert catalog.separation_arcsec(ra, dec, c["center"]["ra"], c["center"]["dec"]) < 5.0
    # The real check: where Gaia says the star is at each SPHEREx visit against where we measured
    # it on the raw images (data/cubes/barnard/D1/measure.json). North-south, the axis that is
    # not hurt by the saturated core, must agree within 1" (parallax, 0.55", is not modelled).
    measured = strict_load(CUBES / "barnard" / "D1" / "measure.json")
    assert len(measured["epochs"]) == 4
    for e in measured["epochs"]:
        _, gaia_dec = at_year(star, catalog.mjd_to_year(e["mjd"]))
        assert (e["dec"] - gaia_dec) * 3600 == pytest.approx(0.0, abs=1.0), e["mjd"]


def test_wise0855_is_the_one_fast_catwise_mover(committed):
    c = committed["wise0855"]
    fast = [s for s in c["sources"] if s["pm_ra"] is not None and math.hypot(s["pm_ra"], s["pm_dec"]) > 5]
    assert len(fast) == 1 and fast[0]["cat"] == "catwise2020"  # Gaia cannot see a 250 K brown dwarf
    m = fast[0]
    # CatWISE2020 lists this object more than once, with motions that differ by 0.3 arcsec/yr in
    # declination (-7.965, +0.806 and -7.920, +0.494); that spread is the catalogue's own accuracy.
    # One of them is used in the whole product (tasks/A.md, A-09 addendum): the first.
    assert m["id"] == "J085508.34-071439.2"
    assert (m["pm_ra"], m["pm_dec"]) == (-7.965, 0.8062)
    assert m["epoch"] == 2015.405
    ra, dec = at_year(m, catalog.mjd_to_year(61100.0))
    assert catalog.separation_arcsec(ra, dec, c["center"]["ra"], c["center"]["dec"]) < 6.0  # one SPHEREx pixel


def wise0855_mover(committed):
    (m,) = [s for s in committed["wise0855"]["sources"] if s["pm_ra"] is not None and math.hypot(s["pm_ra"], s["pm_dec"]) > 5]
    return m


def test_wise0855_catalogue_motion_agrees_with_the_spitzer_astrometry(committed):
    """Outside answer, far more precise than CatWISE: Kirkpatrick et al. 2021, ApJS 253, 7, Table 5
    (arXiv:2011.11616), from Spitzer: position 133.780984, -7.243932 at MJD 57633.39, motion
    (-8123.7 +- 1.3, +673.2 +- 1.3) mas/yr, parallax 439.0 mas. Luhman & Esplin 2016, AJ 152, 78,
    Table 4 (arXiv:1605.06655) have (-8.118 +- 0.008, +0.680 +- 0.007) arcsec/yr.
    The CatWISE entry we keep is 0.21 arcsec/yr from it (its own errors are 0.19 and 0.26); the
    entry we drop is 0.27 away."""
    m = wise0855_mover(committed)
    assert math.hypot(m["pm_ra"] - (-8.1237), m["pm_dec"] - 0.6732) < 0.25
    assert math.hypot(m["pm_ra"] - (-8.118), m["pm_dec"] - 0.680) < 0.25
    assert math.hypot(-7.9199 - (-8.1237), 0.4939 - 0.6732) > 0.25  # the dropped entry
    # the two also agree on where it was in 2016.67 (parallax, 0.44", is in neither number)
    ra, dec = at_year(m, catalog.mjd_to_year(57633.39))
    assert catalog.separation_arcsec(ra, dec, 133.780984, -7.243932) < 1.0


def test_the_app_and_the_catalogue_layer_give_wise0855_one_motion(committed):
    """tasks/A.md, A-09 addendum: the "catalogue" button of the app (frontend/lib/objects.ts) and
    the catalogue layer (catalog.json) showed two different CatWISE2020 entries."""
    path = REPO / "frontend" / "lib" / "objects.ts"
    if not path.exists():
        pytest.skip("no frontend in this checkout")
    found = re.search(r'id:\s*"wise0855".*?catalogueMotion:\s*\{\s*pmRa:\s*(-?[\d.]+),\s*pmDec:\s*(-?[\d.]+)',
                      path.read_text(encoding="utf-8"), re.S)
    if found is None:
        pytest.skip("frontend/lib/objects.ts no longer lists the motion in this form")
    pm_ra, pm_dec = float(found.group(1)), float(found.group(2))
    m = wise0855_mover(committed)
    print(f"app: ({pm_ra}, {pm_dec}); catalog.json: ({m['pm_ra']}, {m['pm_dec']})")
    # the app shows two decimals
    assert pm_ra == pytest.approx(m["pm_ra"], abs=0.006) and pm_dec == pytest.approx(m["pm_dec"], abs=0.006)


def test_only_motions_that_can_be_trusted_are_passed_on(committed):
    # No CatWISE motion survives around Barnard's Star, Epsilon Indi B or RW Aur, where the
    # catalogue lists image fragments with large motions; Gaia carries the real ones.
    for name in ("barnard", "epsindb", "rwaur", "rdra", "wise0855_control"):
        assert [s["id"] for s in committed[name]["sources"] if s["cat"] == "catwise2020" and s["pm_ra"] is not None] == [], name
    eps = [s for s in committed["epsindb"]["sources"]
           if s["cat"] == "gaia_dr3" and s["pm_ra"] is not None and math.hypot(s["pm_ra"], s["pm_dec"]) > 1]
    assert len(eps) == 1
    # Gaia DR3 for Epsilon Indi A: +3.967, -2.536 arcsec/yr; B follows it, plus a slow orbit around it
    assert eps[0]["pm_ra"] == pytest.approx(3.967, abs=0.1) and eps[0]["pm_dec"] == pytest.approx(-2.536, abs=0.1)


def test_control_field_is_blank_in_the_middle(committed):
    # data/control_cube.py, PR #43: nearest CatWISE source with W2 < 16.5 is 46" away; within 30"
    # three CatWISE sources of W2 = 16.57, 16.91, 17.02; within 45" two Gaia stars, G = 19.2 and 20.6.
    c = committed["wise0855_control"]
    assert c["center"] == {"ra": 133.72167, "dec": -7.28755}
    cw = [s for s in c["sources"] if s["cat"] == "catwise2020"]
    gaia = [s for s in c["sources"] if s["cat"] == "gaia_dr3"]
    bright = [s["sep_arcsec"] for s in cw if s["mag_band"] == "W2" and s["mag"] < 16.5]
    assert min(bright) == pytest.approx(46, abs=1.5)
    assert sorted(s["mag"] for s in cw if s["sep_arcsec"] <= 30) == pytest.approx([16.57, 16.91, 17.02], abs=0.01)
    assert sorted(round(s["mag"], 1) for s in gaia if s["sep_arcsec"] <= 45) == [19.2, 20.6]
