"""/api/coverage tests (task C-05). No network: the scripted fake IRSA from test_irsa answers TAP."""
import json
import random

import pytest
from fastapi.testclient import TestClient

from backend import coverage, irsa
from backend.app import create_app
from backend.tests.test_irsa import FakeIrsa

BARNARD = dict(ra=269.4464, dec=4.7666)
VISITS = [60914.0, 60993.0, 61100.0, 61280.0]  # four visits months apart


def tap_csv(counts):
    """TAP CSV with counts[band] images per detector, spread over VISITS (a few hours apart within a visit)."""
    lines = ["uri,band,mjd"]
    for band, n in counts.items():
        for i in range(n):
            mjd = VISITS[i % len(VISITS)] + 0.01 * (i // len(VISITS))
            lines.append(f"ibe/data/spherex/dr1/x/level2_{band}_{i:04d}.fits,SPHEREx-{band},{mjd:.6f}")
    return "\n".join(lines) + "\n"


COUNTS = {"D1": 60, "D2": 61, "D3": 0, "D4": 7, "D5": 3, "D6": 45}


@pytest.fixture
def make(tmp_path):
    def make(script, **kw):
        fake = FakeIrsa(script)
        client = irsa.IrsaClient(tmp_path / "cache", session_factory=fake.factory, sleep=lambda s: None, **kw)
        return TestClient(create_app(client=client, cubes_dir=tmp_path / "cubes")), fake, client
    return make


def test_all_six_detectors_from_one_query(make):
    http, fake, _ = make([(200, tap_csv(COUNTS))])
    r = http.get("/api/coverage", params=BARNARD)
    assert r.status_code == 200
    body = r.json()
    assert [b["band"] for b in body["bands"]] == ["D1", "D2", "D3", "D4", "D5", "D6"]
    got = {b["band"]: (b["n_images"], b["n_epochs"]) for b in body["bands"]}
    assert got == {"D1": (60, 4), "D2": (61, 4), "D3": (0, 0), "D4": (7, 4), "D5": (3, 3), "D6": (45, 4)}
    d3 = body["bands"][2]
    assert d3["mjd_min"] is None and d3["mjd_max"] is None and d3["epochs"] == []
    assert body["n_images"] == 176 and body["source"]["stale"] is False
    # one TAP request, and it has no band filter
    assert len(fake.calls) == 1
    assert "energy_bandpassname =" not in fake.calls[0][2]["data"]["QUERY"]


def test_cached_for_a_day(make):
    http, fake, _ = make([(200, tap_csv(COUNTS))])
    first = http.get("/api/coverage", params=BARNARD).json()
    again = http.get("/api/coverage", params=dict(ra=269.44641, dec=4.76661)).json()  # same within 0.36"
    assert again == first and len(fake.calls) == 1


def test_irsa_down_returns_saved_answer_marked_stale(make, tmp_path):
    http, _, _ = make([(200, tap_csv(COUNTS))])
    live = http.get("/api/coverage", params=BARNARD).json()
    # a later instance, TTL expired, IRSA answering 503 only
    http2, fake2, _ = make([503] * 10, tap_ttl=0)
    r = http2.get("/api/coverage", params=BARNARD)
    assert r.status_code == 200
    body = r.json()
    assert body["bands"] == live["bands"]
    assert body["source"]["stale"] is True and body["source"]["saved_utc"] == live["source"]["saved_utc"]
    assert "503" in body["source"]["error"] and len(fake2.calls) == 4


def test_irsa_down_and_nothing_saved_is_502(make):
    # listing=None: no saved image list either (data/listings covers Barnard's Star since A-17; C-13 tests that path)
    http, _, _ = make([503] * 10, listing=None)
    r = http.get("/api/coverage", params=BARNARD)
    assert r.status_code == 502 and r.json()["status"] == "error"


@pytest.mark.parametrize("params", [dict(ra=-1, dec=0), dict(ra=10, dec=91), {"ra": 10}])
def test_bad_coordinates_are_422(make, params):
    http, _, _ = make([])
    assert http.get("/api/coverage", params=params).status_code == 422


def test_epoch_rule_matches_the_cubes():
    """Visits must be counted exactly as data/cube.py groups frames into epochs."""
    from data import cube
    assert coverage.EPOCH_GAP_DAYS == cube.EPOCH_GAP_DAYS
    rng = random.Random(1)
    for _ in range(50):
        mjds = sorted(60800 + rng.uniform(0, 500) for _ in range(rng.randint(1, 40)))
        idx = cube.epoch_index(mjds)
        ep = coverage.epochs_of(mjds)
        assert len(ep) == idx[-1] + 1
        assert [e["n"] for e in ep] == [idx.count(k) for k in range(len(ep))]


# ---------- static files for the 5 demo objects ----------

class FakeCoverageClient:
    def __init__(self, stale=False):
        self.stale, self.asked = stale, []

    def query_images_meta(self, ra, dec, band=None):
        self.asked.append((ra, dec, band))
        rows = [dict(uri="u", band="SPHEREx-D1", mjd=60914.0 + i) for i in range(3)]
        return rows, {"saved_utc": "2026-11-14T04:00:00Z", "stale": self.stale}


def _cube(tmp_path, obj, band, ra, dec):
    d = tmp_path / obj / band
    d.mkdir(parents=True)
    (d / "cube.json").write_text(json.dumps({"center": {"ra": ra, "dec": dec}}))


def test_write_static_uses_each_cube_centre(tmp_path):
    _cube(tmp_path, "barnard", "D1", 269.4462864, 4.7680655)
    _cube(tmp_path, "wise0855", "D6", 133.7951, -7.2452)
    (tmp_path / "README.md").write_text("not an object")
    client = FakeCoverageClient()
    paths = coverage.write_static(tmp_path, client)
    assert [p.parent.name for p in paths] == ["barnard", "wise0855"]
    cov = json.loads((tmp_path / "barnard" / "coverage.json").read_text())
    assert cov["object"] == "barnard" and cov["center"] == {"ra": 269.4463, "dec": 4.7681}
    assert cov["bands"][0]["n_images"] == 3 and client.asked[0][2] is None


def test_write_static_refuses_a_stale_answer(tmp_path):
    _cube(tmp_path, "barnard", "D1", 269.4463, 4.7681)
    with pytest.raises(RuntimeError):
        coverage.write_static(tmp_path, FakeCoverageClient(stale=True))
    assert not (tmp_path / "barnard" / "coverage.json").exists()
