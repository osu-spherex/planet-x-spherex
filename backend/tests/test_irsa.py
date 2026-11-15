"""IRSA client tests. No network: a fake requests.Session replays scripted IRSA answers.

Run from the repo root:  python -m pytest backend/tests -q
"""
import threading
import time

import pytest
import requests

from backend import irsa

URI = "ibe/data/spherex/dr1/level2/2025W35_1A/l2b-v27-2026-230/1/level2_2025W35_1A_0432_4D1_spx_l2b-v27-2026-230.fits"
FITS = b"SIMPLE  =                    T" + b" " * (2880 - 30)  # one valid 2880-byte FITS block
TAP_CSV = "uri,band,mjd\n" + f"{URI},SPHEREx-D1,60914.212530\n"


def response(status=200, body=b"", headers=None, url="https://irsa.example/x"):
    r = requests.Response()
    r.status_code = status
    r._content = body if isinstance(body, bytes) else body.encode()
    r._content_consumed = True
    r.headers.update(headers or {})
    r.url = url
    r.reason = {200: "OK", 404: "Not Found", 503: "Service Unavailable"}.get(status, "")
    r.encoding = "utf-8"
    return r


class FakeIrsa:
    """Shared by every session the client creates. `script` is consumed one item per request:
    an int status, a (status, body) tuple, or an exception instance to raise."""

    def __init__(self, script, default=(200, FITS), delay=0.0):
        self.script = list(script)
        self.default = default
        self.delay = delay
        self.calls = []
        self.lock = threading.Lock()
        self.in_flight = 0
        self.max_in_flight = 0

    def factory(self):
        fake = self

        class Session:
            def get(self, url, **kw):
                return fake.handle("GET", url, kw)

            def post(self, url, **kw):
                return fake.handle("POST", url, kw)

            def close(self):
                pass

        return Session()

    def handle(self, method, url, kw):
        with self.lock:
            self.calls.append((method, url, kw))
            item = self.script.pop(0) if self.script else self.default
            self.in_flight += 1
            self.max_in_flight = max(self.max_in_flight, self.in_flight)
        try:
            if self.delay:
                time.sleep(self.delay)
            if isinstance(item, Exception):
                raise item
            status, body = (item, b"") if isinstance(item, int) else item
            return response(status, body, url=url)
        finally:
            with self.lock:
                self.in_flight -= 1


@pytest.fixture
def make_client(tmp_path):
    sleeps = []

    def make(fake, **kw):
        c = irsa.IrsaClient(tmp_path, session_factory=fake.factory, sleep=sleeps.append, **kw)
        c.sleeps = sleeps
        return c

    return make


# ---------- retry on 503 ----------

def test_cutout_survives_three_503s(make_client):
    fake = FakeIrsa([503, 503, 503])
    c = make_client(fake)
    path = c.fetch_cutout(URI, 269.4464, 4.7666, 0.05)
    assert path.read_bytes() == FITS
    assert len(fake.calls) == 4
    # exponential backoff: 1, 2, 4 s (+ <= 25% jitter)
    assert len(c.sleeps) == 3
    for got, base in zip(c.sleeps, [1, 2, 4]):
        assert base <= got <= base * 1.25


def test_cutout_gives_up_after_retries(make_client, tmp_path):
    fake = FakeIrsa([503] * 10)
    c = make_client(fake)
    with pytest.raises(irsa.IrsaError) as e:
        c.fetch_cutout(URI, 269.4464, 4.7666, 0.05)
    assert e.value.status == 503
    assert len(fake.calls) == 4  # first attempt + 3 retries, no more
    assert not list(tmp_path.rglob("*.fits")) and not list(tmp_path.rglob("*.part"))


def test_client_error_is_not_retried(make_client):
    fake = FakeIrsa([404])
    c = make_client(fake)
    with pytest.raises(irsa.IrsaError) as e:
        c.fetch_cutout(URI, 269.4464, 4.7666, 0.05)
    assert e.value.status == 404
    assert len(fake.calls) == 1 and c.sleeps == []


def test_dropped_connection_and_html_error_page_are_retried(make_client):
    fake = FakeIrsa([requests.ConnectionError("reset"), requests.Timeout("slow"),
                     (200, b"<html>Service busy</html>")])
    c = make_client(fake)
    assert c.fetch_cutout(URI, 269.4464, 4.7666, 0.05).read_bytes() == FITS
    assert len(fake.calls) == 4


def test_tap_query_retries_503(make_client):
    # listing=None: Barnard's Star is in data/listings now, and with a saved list the search gets one
    # attempt only (C-14, test_saved_listing.py); this test is about the retry without a list
    fake = FakeIrsa([503, (200, TAP_CSV)])
    c = make_client(fake, listing=None)
    rows = c.query_images(269.4464, 4.7666, "D1")
    assert rows == [{"uri": URI, "band": "SPHEREx-D1", "mjd": 60914.21253}]
    assert len(fake.calls) == 2
    adql = fake.calls[1][2]["data"]["QUERY"]
    assert "'SPHEREx-D1'" in adql and "spherex.artifact" in adql


def test_tap_error_votable_is_an_error(make_client):
    fake = FakeIrsa([(200, "<VOTABLE><INFO name='QUERY_STATUS' value='ERROR'/></VOTABLE>")])
    with pytest.raises(irsa.IrsaError):
        # listing=None: without the saved image list of A-17, which C-13 would use for this position
        make_client(fake, listing=None).query_images(269.4464, 4.7666, "D1")


# ---------- disk cache ----------

def test_cutout_cache_hit_makes_no_request(make_client):
    fake = FakeIrsa([])
    c = make_client(fake)
    p1 = c.fetch_cutout(URI, 269.4464, 4.7666, 0.05)
    p2 = c.fetch_cutout(URI, 269.4464, 4.7666, 0.05)
    assert p1 == p2 and len(fake.calls) == 1
    # a different centre or size is a different cutout
    c.fetch_cutout(URI, 269.4464, 4.7766, 0.05)
    c.fetch_cutout(URI, 269.4464, 4.7666, 0.07)
    assert len(fake.calls) == 3


def test_tap_cache_and_stale_fallback(make_client):
    fake = FakeIrsa([(200, TAP_CSV)])
    c = make_client(fake)
    first = c.query_images(269.4464, 4.7666, "SPHEREx-D1")
    assert c.query_images(269.4464, 4.7666, "D1") == first  # cache hit, same key for both spellings
    assert len(fake.calls) == 1
    # after the TTL IRSA is asked again; if it is down, the saved answer is used
    stale = make_client(FakeIrsa([503] * 10), tap_ttl=0)
    assert stale.query_images(269.4464, 4.7666, "D1") == first


def test_tap_down_and_nothing_saved_raises(make_client):
    with pytest.raises(irsa.IrsaError):
        make_client(FakeIrsa([503] * 10)).query_images(10.0, 20.0, "D2")


# ---------- concurrency ----------

def test_never_more_than_8_requests_in_flight(make_client):
    fake = FakeIrsa([], delay=0.05)
    c = make_client(fake)
    uris = [URI.replace("0432_4D1", f"{i:04d}_4D1") for i in range(30)]
    seen = []
    out = c.fetch_cutouts(uris, 269.4464, 4.7666, 0.05, progress=lambda d, n: seen.append((d, n)))
    assert all(p.read_bytes() == FITS for p in out)
    assert 1 < fake.max_in_flight <= 8
    assert seen[-1] == (30, 30) and len(seen) == 30


def test_semaphore_caps_independent_callers(make_client):
    """The cap is per client, not per fetch_cutouts call: 3 callers in parallel still share 8 slots."""
    fake = FakeIrsa([], delay=0.05)
    c = make_client(fake)
    uris = [URI.replace("0432_4D1", f"{i:04d}_4D1") for i in range(36)]
    threads = [threading.Thread(target=c.fetch_cutouts, args=(uris[k::3], 269.4464, 4.7666, 0.05))
               for k in range(3)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert fake.max_in_flight <= 8 and len(fake.calls) == 36


def test_one_failed_cutout_does_not_sink_the_batch(make_client):
    fake = FakeIrsa([404])  # first request fails permanently, the rest succeed
    c = make_client(fake, max_concurrent=1)  # 1 slot so the order is deterministic
    uris = [URI, URI.replace("0432_4D1", "0433_4D1")]
    out = c.fetch_cutouts(uris, 269.4464, 4.7666, 0.05)
    assert isinstance(out[0], irsa.IrsaError) and out[1].read_bytes() == FITS


def test_same_cutout_requested_twice_at_once_downloads_once(make_client):
    fake = FakeIrsa([], delay=0.1)
    c = make_client(fake)
    out = c.fetch_cutouts([URI] * 5, 269.4464, 4.7666, 0.05)
    assert len(set(out)) == 1 and len(fake.calls) == 1


# ---------- input checks (values go into ADQL and URLs) ----------

@pytest.mark.parametrize("band", ["D7", "SPHEREx-D1' OR '1'='1", "d1 ", ""])
def test_bad_band_rejected(band, make_client):
    with pytest.raises(ValueError):
        make_client(FakeIrsa([])).query_images(1.0, 2.0, band)


@pytest.mark.parametrize("ra,dec", [(-1, 0), (360, 0), (10, 91), (10, -90.5)])
def test_bad_coords_rejected(ra, dec, make_client):
    with pytest.raises(ValueError):
        make_client(FakeIrsa([])).query_images(ra, dec)


def test_bad_uri_rejected(make_client):
    with pytest.raises(ValueError):
        make_client(FakeIrsa([])).fetch_cutout("https://evil.example/x.fits", 1.0, 2.0)
