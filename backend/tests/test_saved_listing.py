"""Task C-13: when IRSA's image search (TAP) is down, positions near the five demo objects still get
cubes from role A's saved image list (data.listing.saved_images, A-17); the images themselves are
downloaded from IRSA's cutout service as usual. Elsewhere the visitor gets a plain sentence."""
import json
import math
import time

import pytest
from fastapi.testclient import TestClient

from backend import irsa
from backend.app import create_app
from backend.limits import Limiter
from backend.tests.test_cube_api import fake_builder
from backend.tests.test_irsa import FITS, FakeIrsa
from backend.tests.test_measure_api import fake_measurer

# The challenge's WISE 0855 coordinate (RA 08h55m10.831s, Dec -07d14m42.53s), detector D6
WISE = dict(ra=133.79513, dec=-7.24515, band="D6")
WISE_CENTRE = (133.7951, -7.2452)
URI = "ibe/data/spherex/dr1/level2/2025W19_1A/l2b-v27-2026-230/6/level2_2025W19_1A_{:04d}_6D6_spx_l2b-v27-2026-230.fits"
LISTED = "2026-11-14"


def tiny_listing(ra, dec, band=None, max_sep_arcmin=15.0):
    """Stands in for data.listing.saved_images (A-17): a small saved list around WISE 0855."""
    sep = math.hypot((ra - WISE_CENTRE[0]) * math.cos(math.radians(dec)), dec - WISE_CENTRE[1]) * 60
    if sep > max_sep_arcmin:
        return None
    rows = [dict(uri=URI.format(i), band="SPHEREx-D6", mjd=60800.7 + 40 * (i // 3) + 0.1 * (i % 3)) for i in range(9)]
    rows += [dict(uri=URI.format(100 + i).replace("6D6", "5D5"), band="SPHEREx-D5", mjd=60801.0 + i) for i in range(3)]
    if band is not None:
        rows = [r for r in rows if r["band"] == irsa.normalize_band(band)]
    return rows, dict(object="wise0855", sep_arcmin=round(sep, 2), listed=LISTED)


def tap_down_then_cutouts():
    """IRSA as on 11/15: every TAP request 502, every cutout request fine."""
    class Fake(FakeIrsa):
        def handle(self, method, url, kw):
            if "TAP/sync" in url:
                with self.lock:
                    self.calls.append((method, url, kw))
                from backend.tests.test_irsa import response
                return response(502, b"Proxy Error for url https://irsa.ipac.caltech.edu/TAP/sync", url=url)
            return super().handle(method, url, kw)
    return Fake([], default=(200, FITS))


@pytest.fixture
def make(tmp_path):
    def make(listing=tiny_listing, fake=None):
        fake = fake or tap_down_then_cutouts()
        client = irsa.IrsaClient(tmp_path / "cache", session_factory=fake.factory, sleep=lambda s: None,
                                 listing=listing)
        app = create_app(client=client, cubes_dir=tmp_path / "cubes", builder=fake_builder,
                         measurer=fake_measurer, limiter=Limiter(10, 100), catalog_fetch=None)
        return TestClient(app), fake
    return make


def poll(http, path, params, timeout=5):
    t = time.time()
    while True:
        r = http.get(path, params=params)
        if r.status_code != 202 or time.time() - t > timeout:
            return r
        time.sleep(0.02)


def test_challenge_wise_coordinate_builds_from_the_saved_list(make):
    http, fake = make()
    r = http.get("/api/cube", params=WISE)
    first = r.json()
    r = poll(http, "/api/cube", WISE)
    assert r.status_code == 200
    cube = r.json()
    assert cube["shape"][0] == 9                      # only the D6 rows of the list
    assert cube["listing"] == "saved" and cube["listed"] == LISTED and cube["listing_object"] == "wise0855"
    cutouts = [c for c in fake.calls if "TAP/sync" not in c[1]]
    assert len(cutouts) == 9 and all("center=133.7951000,-7.2451000d" in c[1] for c in cutouts)  # fetched live (centre rounded to 0.36" as always)
    # the next visitor gets the same note from the stored cube
    again = http.get("/api/cube", params=WISE).json()
    assert again["listing"] == "saved"


def test_job_answers_say_saved_list_while_running(make, monkeypatch):
    import threading
    gate = threading.Event()
    real = irsa.IrsaClient.fetch_cutouts

    def slow(self, *a, **kw):
        gate.wait(5)
        return real(self, *a, **kw)
    monkeypatch.setattr(irsa.IrsaClient, "fetch_cutouts", slow)
    http, _ = make()
    http.get("/api/cube", params=WISE)
    t = time.time()
    while time.time() - t < 5:
        body = http.get("/api/cube", params=WISE).json()
        if body.get("status") == "downloading":
            break
        time.sleep(0.02)
    assert body["listing"] == "saved" and body["listed"] == LISTED
    gate.set()


def test_preview_and_measure_use_the_saved_list_too(make):
    http, _ = make()
    first = poll(http, "/api/cube", dict(WISE, preview=1))
    assert first.status_code == 200 and first.json()["listing"] == "saved"
    m = poll(http, "/api/measure", WISE)
    assert m.status_code == 200 and m.json()["listing"] == "saved" and m.json()["motion"]


def test_far_from_the_five_objects_is_a_plain_sentence(make):
    http, _ = make()
    far = dict(ra=134.79513, dec=-7.24515, band="D6")  # 1 degree east
    r = poll(http, "/api/cube", far)
    assert r.status_code == 502
    body = r.json()
    text = json.dumps(body).lower()
    assert body["reason"] == "search_down" and "five example objects" in body["message"]
    assert "502" not in text and "url" not in text and "proxy" not in text


def test_coverage_uses_the_saved_list_and_otherwise_says_so_plainly(make):
    http, _ = make()
    r = http.get("/api/coverage", params=dict(ra=WISE["ra"], dec=WISE["dec"]))
    assert r.status_code == 200
    body = r.json()
    assert body["source"]["listing"] == "saved"
    assert {b["band"]: b["n_images"] for b in body["bands"]}["D6"] == 9
    r = http.get("/api/coverage", params=dict(ra=10.0, dec=20.0))
    assert r.status_code == 502 and "502" not in r.json()["message"] and r.json()["reason"] == "search_down"


def test_search_working_means_no_saved_list(tmp_path):
    """TAP answering -> the live answer, never the list (behaviour unchanged)."""
    from backend.tests.test_coverage import COUNTS, tap_csv
    asked = []

    def listing(*a, **kw):
        asked.append(a)
        return tiny_listing(*a, **kw)
    fake = FakeIrsa([(200, tap_csv(COUNTS))])
    c = irsa.IrsaClient(tmp_path, session_factory=fake.factory, sleep=lambda s: None, listing=listing)
    rows, meta = c.query_images_meta(WISE["ra"], WISE["dec"], "D6")
    assert rows and "listing" not in meta and asked == []  # (the fake TAP ignores the band filter)


def test_saved_list_answers_are_not_cached(make, tmp_path):
    http, fake = make()
    poll(http, "/api/cube", WISE)
    assert not list((tmp_path / "cache" / "tap").glob("*.json"))  # next time the live search is tried first


def test_missing_data_listing_module_is_no_list(monkeypatch):
    import sys
    monkeypatch.setitem(sys.modules, "data.listing", None)
    import data
    monkeypatch.delattr(data, "listing", raising=False)
    assert irsa.saved_listing(*WISE_CENTRE, "D6") is None


# ---------- C-14: one search attempt where a saved list exists ----------

def test_listed_position_asks_the_search_once(make):
    http, fake = make()
    r = poll(http, "/api/cube", WISE)
    assert r.status_code == 200 and r.json()["listing"] == "saved"
    taps = [c for c in fake.calls if "TAP/sync" in c[1]]
    assert len(taps) == 1


def test_unlisted_position_still_gets_all_attempts(make):
    http, fake = make()
    r = poll(http, "/api/cube", dict(ra=134.79513, dec=-7.24515, band="D6"))
    assert r.status_code == 502 and r.json()["reason"] == "search_down"
    taps = [c for c in fake.calls if "TAP/sync" in c[1]]
    assert len(taps) == 1 + irsa.RETRIES  # 4, as before C-14


def test_search_answering_on_the_second_try_is_used_without_a_list(tmp_path):
    from backend.tests.test_coverage import COUNTS, tap_csv
    fake = FakeIrsa([502, (200, tap_csv(COUNTS))])
    c = irsa.IrsaClient(tmp_path, session_factory=fake.factory, sleep=lambda s: None, listing=lambda *a, **k: None)
    rows, meta = c.query_images_meta(10.0, 20.0, "D6")
    assert rows and "listing" not in meta and len(fake.calls) == 2
