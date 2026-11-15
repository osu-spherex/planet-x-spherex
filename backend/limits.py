"""Per-visitor limits for the open API (task C-07).

Every new position costs IRSA one TAP query (8-30 s) and ~60 cutout downloads of 4 MB, and the
free Render instance runs only MAX_JOBS jobs at a time. One visitor clicking around the sky could
queue dozens of positions, slow IRSA down for everyone and make the judges wait behind them.
So, per visitor address:
    * at most `max_running` jobs (cube or measure) running at once        (default 2)
    * at most `max_new_per_min` NEW positions per minute                    (default 3)
A "position" is the rounded (ra, dec) of /api/cube (0.36"), whatever the detector or endpoint:
loading the cube, the measurement and the coverage of one place counts once.

Only requests that would START work are counted. Finished results, polling a running job and the
static files (/cubes/..., the five demo objects) are never limited.

The address is taken from proxy headers (Render sits behind a proxy): CF-Connecting-IP,
True-Client-IP, the first X-Forwarded-For entry, else the socket peer. A visitor can forge those
headers, so this is a courtesy limit against accidental overload, not a security boundary.
"""
from __future__ import annotations

import math
import os
import threading
import time
from collections import defaultdict
from typing import Callable

WINDOW_S = 60.0


class RateLimited(Exception):
    def __init__(self, message: str, retry_after: int):
        super().__init__(message)
        self.message = message
        self.retry_after = retry_after

    def body(self) -> dict:
        return {"status": "limited", "progress": 0.0, "message": self.message, "retry_after": self.retry_after}


def client_address(headers, peer: str | None) -> str:
    for name in ("cf-connecting-ip", "true-client-ip"):
        v = headers.get(name)
        if v:
            return v.strip()
    xff = headers.get("x-forwarded-for")
    if xff:
        first = xff.split(",")[0].strip()
        if first:
            return first
    return peer or "unknown"


class Limiter:
    def __init__(self, max_running: int | None = None, max_new_per_min: int | None = None,
                 clock: Callable[[], float] = time.time):
        self.max_running = int(os.environ.get("OSU_LIMIT_RUNNING", 2)) if max_running is None else max_running
        self.max_new = int(os.environ.get("OSU_LIMIT_NEW_PER_MIN", 3)) if max_new_per_min is None else max_new_per_min
        self._clock = clock
        self._lock = threading.Lock()
        self._jobs: dict[str, list] = defaultdict(list)                 # address -> jobs it started
        self._seen: dict[str, dict[str, float]] = defaultdict(dict)     # address -> {position: first seen}

    def admit(self, address: str, position: str, job=None) -> None:
        """Allow `address` to start work on `position` (and, if `job` is given, count it as running),
        or raise RateLimited. Thread-safe."""
        now = self._clock()
        with self._lock:
            seen = self._seen[address]
            for p, t in list(seen.items()):
                if now - t >= WINDOW_S:
                    del seen[p]
            running = [j for j in self._jobs[address] if getattr(j, "finished_at", None) is None]
            self._jobs[address] = running
            if job is not None and len(running) >= self.max_running:
                raise RateLimited(
                    f"You already have {len(running)} searches running. Please wait until one finishes "
                    f"(about a minute); the five demo objects work without waiting.", retry_after=15)
            if position not in seen and len(seen) >= self.max_new:
                wait = max(1, math.ceil(min(seen.values()) + WINDOW_S - now))
                raise RateLimited(
                    f"Too many new positions from your connection: at most {self.max_new} per minute. "
                    f"Please try again in {wait} seconds; the five demo objects work without waiting.",
                    retry_after=wait)
            seen.setdefault(position, now)
            if job is not None:
                self._jobs[address].append(job)
