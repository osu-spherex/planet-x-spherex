"""Warm start on Render and stage timings in job answers (C-10 follow-up: first look 39 s right after a deploy)."""
import subprocess
import sys
import time

import pytest
from fastapi.testclient import TestClient

from backend import app as app_mod
from backend.app import create_app
from backend.limits import Limiter
from backend.tests.test_cube_api import BARNARD, fake_builder
from backend.tests.test_preview import VisitClient, wait_for


@pytest.mark.parametrize("env,expected", [
    ({}, False),
    ({"RENDER": "true"}, True),
    ({"OSU_WARMUP": "1"}, True),
    ({"OSU_WARMUP": "0", "RENDER": "true"}, False),
])
def test_warm_up_only_on_render_or_when_asked(monkeypatch, env, expected):
    for k in ("RENDER", "OSU_WARMUP"):
        monkeypatch.delenv(k, raising=False)
    for k, v in env.items():
        monkeypatch.setenv(k, v)
    assert app_mod.should_warm_up() is expected


def test_warm_up_imports_the_pipeline_in_the_background(tmp_path):
    """Fresh process, OSU_WARMUP=1: /health answers at once, data.cube gets imported behind it."""
    code = (
        "import os, sys, time; os.environ['OSU_WARMUP'] = '1'\n"
        "from fastapi.testclient import TestClient\n"
        "from backend.app import app\n"
        "c = TestClient(app)\n"
        "t = time.time(); first = c.get('/health').json(); took = time.time() - t\n"
        "assert took < 2, took\n"
        "for _ in range(600):\n"
        "    w = c.get('/health').json()['warmup']\n"
        "    if w['state'] != 'running': break\n"
        "    time.sleep(0.1)\n"
        "assert w['state'] == 'done', w\n"
        "assert 'data.cube' in sys.modules and 'data.photometry' in sys.modules\n"
        "print(w)\n"
    )
    out = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True, timeout=120)
    assert out.returncode == 0, out.stderr[-2000:]


def test_job_answers_carry_stage_timings(tmp_path):
    client = VisitClient(tmp_path / "cache")
    http = TestClient(create_app(client=client, cubes_dir=tmp_path, builder=fake_builder, max_frames=120,
                                 limiter=Limiter(10, 100)))
    params = dict(BARNARD, preview=1)
    http.get("/api/cube", params=params)
    wait_for(http, params, "preview")
    body = http.get("/api/cube", params=dict(BARNARD)).json()  # the plain 202 job answer
    t = body["timings"]
    assert list(t)[:4] == ["pipeline_loaded", "searched", "first_look_downloaded", "first_look"]
    assert t["pipeline_loaded"] <= t["searched"] <= t["first_look_downloaded"] <= t["first_look"]
    client.full_gate.set()
    wait_for(http, params, "done")
