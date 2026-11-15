"""Catalogue overlay for any position: GET /api/catalog (task C-08, interface O5 in docs/ARCHITECTURE.md).

The query itself is role A's (data.catalog.sources_near: Gaia DR3 + CatWISE2020 through IRSA TAP,
task A-11), imported lazily so the backend runs before it exists (then: 503 "unavailable").
This module adds what the open API needs around it:
    * a disk cache of 24 h per (rounded position, radius) -- the TAP queries take 10-30 s
    * when IRSA fails, the last saved answer, flagged `source.stale = true` with `source.saved_utc`
For the 5 demo objects the frontend reads the static /cubes/<obj>/catalog.json instead.
"""
from __future__ import annotations

import json
import logging
import os
import threading
import time
from pathlib import Path
from typing import Callable

log = logging.getLogger("osu.catalog")

DEFAULT_RADIUS = 150.0  # arcsec; tasks/A.md A-11 uses 150" for the static files (covers a 6' field)
MAX_RADIUS = 600.0      # a 10' field has a 300" half-width diagonal of ~425"; 600" leaves margin
TTL_S = 24 * 3600
COORD_DECIMALS = 4      # as /api/cube: 0.36"


class CatalogUnavailable(RuntimeError):
    """data/catalog.py (A-11) is not there yet."""


class CatalogError(RuntimeError):
    """The query failed and nothing was saved before."""


def default_fetch() -> Callable | None:
    try:
        from data import catalog  # noqa: PLC0415  (A-11; pulls in astropy/pyvo)
    except ImportError:
        return None
    return getattr(catalog, "sources_near", None)


class CatalogCache:
    def __init__(self, cache_dir: Path, fetch: Callable | None | str = "auto", ttl: float = TTL_S,
                 clock: Callable[[], float] = time.time):
        self.cache_dir = Path(cache_dir)
        self._fetch = fetch
        self.ttl = ttl
        self._clock = clock
        self._locks: dict[str, threading.Lock] = {}
        self._guard = threading.Lock()

    def fetcher(self) -> Callable | None:
        return default_fetch() if self._fetch == "auto" else self._fetch

    def present(self) -> bool:
        """Cheap check for /health (no import)."""
        if self._fetch != "auto":
            return self._fetch is not None
        import importlib.util  # noqa: PLC0415
        try:
            return importlib.util.find_spec("data.catalog") is not None
        except (ImportError, ValueError):
            return False

    @staticmethod
    def _norm(ra: float, dec: float, radius: float) -> tuple[float, float, float]:
        if not (0.0 <= ra < 360.0) or not (-90.0 <= dec <= 90.0):
            raise ValueError(f"need 0 <= ra < 360 and -90 <= dec <= 90, got ra={ra}, dec={dec}")
        if not 0 < radius <= MAX_RADIUS:
            raise ValueError(f"radius must be in (0, {MAX_RADIUS:g}] arcsec, got {radius}")
        return round(ra, COORD_DECIMALS), round(dec, COORD_DECIMALS), round(float(radius), 1)

    def _path(self, ra: float, dec: float, radius: float) -> Path:
        return self.cache_dir / f"{ra:.{COORD_DECIMALS}f}_{dec:+.{COORD_DECIMALS}f}_r{radius:g}.json"

    def _read(self, path: Path):
        try:
            with open(path, encoding="utf-8") as f:
                return json.load(f)
        except (OSError, ValueError):
            return None

    def is_fresh(self, ra: float, dec: float, radius: float = DEFAULT_RADIUS) -> bool:
        ra, dec, radius = self._norm(ra, dec, radius)
        saved = self._read(self._path(ra, dec, radius))
        return saved is not None and self._clock() - saved["saved_at"] < self.ttl

    def get(self, ra: float, dec: float, radius: float = DEFAULT_RADIUS) -> dict:
        ra, dec, radius = self._norm(ra, dec, radius)
        path = self._path(ra, dec, radius)
        with self._guard:
            lock = self._locks.setdefault(str(path), threading.Lock())
        with lock:  # two visitors asking for the same field wait for one query
            saved = self._read(path)
            if saved is not None and self._clock() - saved["saved_at"] < self.ttl:
                return _answer(saved, stale=False)
            fetch = self.fetcher()
            if fetch is None:
                raise CatalogUnavailable("catalogue lookup (data/catalog.py, task A-11) is not available yet")
            try:
                result = fetch(ra, dec, radius)
                json.dumps(result, allow_nan=False)  # must survive JSON.parse in the browser
            except Exception as e:  # network, TAP and parsing errors all end here
                err = f"{type(e).__name__}: {e}"[:200]
                if saved is not None:
                    log.warning("catalogue query failed (%s); using the answer saved %s", err, path)
                    return _answer(saved, stale=True, error=err)
                raise CatalogError(f"catalogue query failed: {err}") from e
            saved = {"saved_at": self._clock(), "result": result}
            path.parent.mkdir(parents=True, exist_ok=True)
            tmp = path.with_name(f"{path.name}.{threading.get_ident()}.tmp")
            tmp.write_text(json.dumps(saved), encoding="utf-8")
            os.replace(tmp, path)
            return _answer(saved, stale=False)


def _answer(saved: dict, stale: bool, error: str | None = None) -> dict:
    result = saved["result"]
    source = dict(result.get("source") or {})
    source.update(saved_utc=time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(saved["saved_at"])), stale=stale)
    if error:
        source["error"] = error
    return {**result, "source": source}
