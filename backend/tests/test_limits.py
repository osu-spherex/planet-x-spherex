"""Per-visitor limits (task C-07): unit tests of Limiter and the 429 answers of the API."""
import threading

import pytest
from fastapi.testclient import TestClient

from backend.app import create_app
from backend.limits import Limiter, RateLimited, client_address
from backend.tests.test_cube_api import BARNARD, FakeClient, fake_builder, poll
from backend.tests.test_measure_api import fake_measurer


class FakeJob:
    finished_at = None


class Clock:
    def __init__(self):
        self.t = 1000.0

    def __call__(self):
        return self.t


# ---------- Limiter ----------

def test_third_running_job_is_refused_until_one_finishes():
    lim = Limiter(max_running=2, max_new_per_min=10)
    a, b = FakeJob(), FakeJob()
    lim.admit("1.2.3.4", "p1", a)
    lim.admit("1.2.3.4", "p2", b)
    with pytest.raises(RateLimited) as e:
        lim.admit("1.2.3.4", "p3", FakeJob())
    assert "2 searches running" in e.value.message and e.value.retry_after > 0
    a.finished_at = 1.0
    lim.admit("1.2.3.4", "p3", FakeJob())  # a slot is free again


def test_fourth_new_position_in_a_minute_is_refused():
    clock = Clock()
    lim = Limiter(max_running=10, max_new_per_min=3, clock=clock)
    for p in ("p1", "p2", "p3"):
        lim.admit("ip", p)
        clock.t += 5
    lim.admit("ip", "p2")  # a position already counted costs nothing
    with pytest.raises(RateLimited) as e:
        lim.admit("ip", "p4")
    assert e.value.retry_after == 45  # p1 (seen at t=0) leaves the window at t=60; now t=15
    assert "3 per minute" in e.value.message
    clock.t += 44
    with pytest.raises(RateLimited):
        lim.admit("ip", "p4")
    clock.t += 1
    lim.admit("ip", "p4")


def test_visitors_are_counted_separately():
    lim = Limiter(max_running=1, max_new_per_min=1)
    lim.admit("a", "p1", FakeJob())
    lim.admit("b", "p2", FakeJob())
    with pytest.raises(RateLimited):
        lim.admit("a", "p3", FakeJob())


def test_refused_request_is_not_counted():
    lim = Limiter(max_running=1, max_new_per_min=2)
    lim.admit("ip", "p1", FakeJob())
    with pytest.raises(RateLimited):
        lim.admit("ip", "p2", FakeJob())  # refused for concurrency ...
    lim.admit("ip", "p2")                 # ... so p2 was not used up: still 1 of 2 positions


@pytest.mark.parametrize("headers,peer,expected", [
    ({"cf-connecting-ip": "9.9.9.9", "x-forwarded-for": "1.1.1.1"}, "10.0.0.1", "9.9.9.9"),
    ({"true-client-ip": "8.8.8.8"}, "10.0.0.1", "8.8.8.8"),
    ({"x-forwarded-for": "5.6.7.8, 10.1.1.1, 10.2.2.2"}, "10.0.0.1", "5.6.7.8"),
    ({}, "10.0.0.1", "10.0.0.1"),
    ({}, None, "unknown"),
])
def test_client_address(headers, peer, expected):
    assert client_address(headers, peer) == expected


# ---------- API ----------

def positions(n):
    return [dict(ra=round(10.0 + i, 4), dec=20.0, band="D1") for i in range(n)]


@pytest.fixture
def make(tmp_path):
    def make(limiter=None, **client_kw):
        client = FakeClient(tmp_path / "cache", **client_kw)
        app = create_app(client=client, cubes_dir=tmp_path / "cubes", builder=fake_builder,
                         measurer=fake_measurer, max_frames=120, limiter=limiter or Limiter(2, 3))
        return TestClient(app), client
    return make


def test_third_concurrent_job_gets_429(make):
    gate = threading.Event()
    http, _ = make(gate=gate)
    p1, p2, p3 = positions(3)
    assert http.get("/api/cube", params=p1).status_code == 202
    assert http.get("/api/measure", params=p2).status_code == 202
    r = http.get("/api/cube", params=p3)
    assert r.status_code == 429
    body = r.json()
    assert body["status"] == "limited" and body["retry_after"] > 0 and "wait" in body["message"]
    assert r.headers["Retry-After"] == str(body["retry_after"])
    # polling the running jobs is never limited, and they finish normally
    assert http.get("/api/cube", params=p1).status_code == 202
    gate.set()
    assert poll(http, p1).status_code == 200


def test_new_positions_per_minute(make):
    http, _ = make(limiter=Limiter(max_running=10, max_new_per_min=3))
    for p in positions(3):
        assert poll(http, p).status_code == 200
    r = http.get("/api/cube", params=positions(4)[3])
    assert r.status_code == 429 and "per minute" in r.json()["message"]


def test_results_polls_and_static_files_are_never_limited(make, tmp_path):
    (tmp_path / "cubes" / "barnard" / "D1").mkdir(parents=True)
    (tmp_path / "cubes" / "barnard" / "D1" / "cube.json").write_text("{}")
    http, _ = make(limiter=Limiter(max_running=1, max_new_per_min=1))
    assert poll(http, BARNARD).status_code == 200
    for _ in range(10):
        assert http.get("/api/cube", params=BARNARD).status_code == 200      # finished result
        assert http.get("/cubes/barnard/D1/cube.json").status_code == 200   # static demo object
    # the measurement of the same position is the same position: not a new one
    assert poll(http, dict(BARNARD)).status_code == 200
    from backend.tests.test_measure_api import poll_measure
    assert poll_measure(http, BARNARD).status_code == 200


def test_another_visitor_is_not_blocked(make):
    gate = threading.Event()
    http, _ = make(gate=gate, limiter=Limiter(max_running=1, max_new_per_min=5))
    p1, p2 = positions(2)
    assert http.get("/api/cube", params=p1).status_code == 202
    assert http.get("/api/cube", params=p2).status_code == 429
    r = http.get("/api/cube", params=p2, headers={"X-Forwarded-For": "203.0.113.7"})
    assert r.status_code == 202
    gate.set()


def test_coverage_counts_only_real_irsa_queries(tmp_path):
    from backend import irsa
    from backend.tests.test_coverage import COUNTS, tap_csv
    from backend.tests.test_irsa import FakeIrsa
    fake = FakeIrsa([(200, tap_csv(COUNTS))] * 3)
    client = irsa.IrsaClient(tmp_path / "c", session_factory=fake.factory, sleep=lambda s: None)
    http = TestClient(create_app(client=client, cubes_dir=tmp_path, limiter=Limiter(10, 2)))
    for p in positions(2):
        assert http.get("/api/coverage", params=dict(ra=p["ra"], dec=p["dec"])).status_code == 200
    for p in positions(2):  # cached now: free
        assert http.get("/api/coverage", params=dict(ra=p["ra"], dec=p["dec"])).status_code == 200
    r = http.get("/api/coverage", params=dict(ra=50.0, dec=20.0))
    assert r.status_code == 429 and len(fake.calls) == 2


def test_job_answers_say_when_the_server_started(make):
    """A poller that sees server_started_utc change knows the server restarted and the job began again."""
    gate = threading.Event()
    http, _ = make(gate=gate)
    a = http.get("/api/cube", params=BARNARD).json()
    b = http.get("/api/cube", params=BARNARD).json()
    assert a["server_started_utc"] == b["server_started_utc"] and a["job_started_utc"]
    gate.set()
