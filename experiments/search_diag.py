"""A-13 diagnostics: why does the velocity search's shuffle test fail on Epsilon Indi B?

A numpy copy of frontend/search (stack.ts, grid.ts, significance.ts) so that the question can be
measured quickly on the static cubes (data/cubes/<obj>/<band>/cube.json + cube.f32). It is a
diagnostic tool only: the numbers the site quotes come from the TypeScript code
(frontend/search/numbers.test.ts). `check` compares this copy with those numbers.

    python experiments/search_diag.py check              # this copy vs the TypeScript numbers
    python experiments/search_diag.py frames             # step 0a/0c: per-frame flux, noise, visits
    python experiments/search_diag.py peak               # step 0b: what makes the WISE 0855 P-07 peak
    python experiments/search_diag.py amp                # A-13 rule: per-frame aperture brightness / noise
    python experiments/search_diag.py modes [n] [objects] [variants]
                                                         # compare stacking rules with n shuffles (default 20),
                                                         # e.g. modes 100 epsindb,rwaur "norm + pixel,default"

"norm + pixel clip" in `modes` is the rule that went into frontend/search (A-13). Shuffles use the
same seeded generator as significance.ts, so the counts agree with the TypeScript tests.
"""

from __future__ import annotations

import json
import sys
import time
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
CUBES = ROOT / "data" / "cubes"
JULIAN_YEAR_DAYS = 365.25
MAD_TO_SIGMA = 1.4826
WEIGHT_EPS = 1e-9

# Catalogue motions shown on the site (frontend/lib/objects.ts), arcsec/yr, (RA*cosDec, Dec).
MOVERS = {
    "wise0855": ("wise0855/D6", (-7.97, 0.81)),
    "barnard": ("barnard/D1", (-0.8, 10.36)),
    "epsindb": ("epsindb/D2", (3.967, -2.536)),
    # Check object, not used for the design of A-13 (Gaia DR3 35227046884571776).
    "teegarden": ("teegarden/D1", (3.429, -3.806)),
}

# Stars that do not move measurably in a year (variable stars of the demo): a real-data check that
# the search does not call a standing star moving. `modes` accepts these names too.
STILL = {
    "rwaur": ("rwaur/D1", (0.0, 0.0)),
    "rdra": ("rdra/D1", (0.0, 0.0)),
}


class Cube:
    def __init__(self, rel: str):
        d = CUBES / rel
        self.meta = json.loads((d / "cube.json").read_text(encoding="utf8"))
        n, h, w = self.meta["shape"]
        self.n, self.h, self.w = n, h, w
        self.data = np.fromfile(d / self.meta["data_url"], dtype="<f4").reshape(n, h, w).astype(np.float64)
        fr = self.meta["frames"]
        self.mjd = np.array([f["mjd"] for f in fr])
        self.noise = np.array([f["noise"] for f in fr])
        self.lam = np.array([f.get("lam_um", np.nan) for f in fr])
        self.epoch = np.array([f.get("epoch", -1) for f in fr])
        self.pix = self.meta["pixscale_arcsec"]


# ---------- stack.ts ----------

PAD = 24


def sample_all(data: np.ndarray, dx: np.ndarray, dy: np.ndarray) -> np.ndarray:
    """sampleBilinear for every pixel of every frame: out[k, y, x] = frame k at (x + dx[k], y + dy[k])."""
    k, h, w = data.shape
    padded = np.full((k, h + 2 * PAD, w + 2 * PAD), np.nan)
    padded[:, PAD : PAD + h, PAD : PAD + w] = data
    ix = np.floor(dx).astype(int)
    iy = np.floor(dy).astype(int)
    fx = dx - ix
    fy = dy - iy
    kk = np.arange(k)[:, None, None]
    out = np.zeros((k, h, w))
    for j in (0, 1):
        wy = (1 - fy) if j == 0 else fy
        rows = np.clip(PAD + iy[:, None] + j + np.arange(h)[None, :], 0, h + 2 * PAD - 1)
        for i in (0, 1):
            wx = (1 - fx) if i == 0 else fx
            cols = np.clip(PAD + ix[:, None] + i + np.arange(w)[None, :], 0, w + 2 * PAD - 1)
            use = (wy >= WEIGHT_EPS) & (wx >= WEIGHT_EPS)
            term = (wx * wy)[:, None, None] * padded[kk, rows[:, :, None], cols[:, None, :]]
            out += np.where(use[:, None, None], term, 0.0)
    return out


def nanmedian0(s: np.ndarray) -> np.ndarray:
    """Median over axis 0 ignoring NaN (mean of the two middle values for an even count)."""
    srt = np.sort(s, axis=0)  # NaN last
    n = np.sum(~np.isnan(s), axis=0)
    lo = np.clip((n - 1) // 2, 0, s.shape[0] - 1)
    hi = np.clip(n // 2, 0, s.shape[0] - 1)
    a = np.take_along_axis(srt, lo[None], axis=0)[0]
    b = np.take_along_axis(srt, hi[None], axis=0)[0]
    return np.where(n > 0, 0.5 * (a + b), np.nan)


def robust(v: np.ndarray) -> tuple[float, float]:
    v = v[np.isfinite(v)]
    if v.size == 0:
        return np.nan, np.nan
    m = np.median(v)
    return float(m), float(MAD_TO_SIGMA * np.median(np.abs(v - m)))


def shifts(cube: Cube, pm_ra: float, pm_dec: float, ref: float, mjd: np.ndarray | None = None):
    dt = ((cube.mjd if mjd is None else mjd) - ref) / JULIAN_YEAR_DAYS
    return -pm_ra * dt / cube.pix, -pm_dec * dt / cube.pix


def combine(s: np.ndarray, noise: np.ndarray, mode: str, clip_sigma: float = 5.0):
    """Combine sampled frames s[k, y, x] (NaN = no data). Returns (image, count)."""
    valid = ~np.isnan(s)
    if mode == "mean":
        cnt = valid.sum(0)
        return np.where(cnt > 0, np.nansum(s, 0) / np.maximum(cnt, 1), np.nan), cnt
    med = nanmedian0(s)
    if mode == "median":
        return med, valid.sum(0)
    scale = np.broadcast_to(noise[:, None, None], s.shape)
    if mode == "pixel":
        spread = MAD_TO_SIGMA * nanmedian0(np.abs(s - med))
        scale = np.maximum(scale, spread[None])
    elif mode != "clipped":
        raise ValueError(mode)
    with np.errstate(invalid="ignore"):
        keep = np.abs(s - med) <= clip_sigma * scale
    cnt = keep.sum(0)
    return np.where(cnt > 0, np.where(keep, s, 0.0).sum(0) / np.maximum(cnt, 1), np.nan), cnt


def finish(image: np.ndarray, cnt: np.ndarray):
    """Background, sigma and the SNR map, as at the end of stack()."""
    image = image.astype(np.float32).astype(np.float64)
    n_typ = float(np.median(cnt[cnt > 0]))
    bg, _ = robust(image)
    with np.errstate(invalid="ignore"):
        scaled = np.where(cnt > 0, (image - bg) * np.sqrt(cnt / n_typ), np.nan).astype(np.float32).astype(np.float64)
        _, sigma = robust(scaled)
        snr = np.where(cnt > 0, (image - bg) / (sigma * np.sqrt(n_typ / np.maximum(cnt, 1))), np.nan)
    return snr, sigma, bg


def stack(cube: Cube, pm_ra, pm_dec, ref, mode="clipped", mjd=None, data=None, noise=None):
    dx, dy = shifts(cube, pm_ra, pm_dec, ref, mjd)
    s = sample_all(cube.data if data is None else data, dx, dy)
    image, cnt = combine(s, cube.noise if noise is None else noise, mode)
    snr, sigma, bg = finish(image, cnt)
    return {"image": image, "count": cnt, "snr": snr, "sigma": sigma, "bg": bg, "samples": s}


# ---------- grid.ts ----------


def axis(pm_max: float, step: float) -> np.ndarray:
    k = int(np.floor(pm_max / step + 1e-9))
    return np.arange(-k, k + 1) * step


def region_mask(cube: Cube, cx=None, cy=None, radius=4.0):
    cx = (cube.w - 1) / 2 if cx is None else cx
    cy = (cube.h - 1) / 2 if cy is None else cy
    yy, xx = np.mgrid[0 : cube.h, 0 : cube.w]
    return (xx - cx) ** 2 + (yy - cy) ** 2 <= radius**2


def fit_peak(score: np.ndarray, i0: int, j0: int, half: int = 2):
    ny, nx = score.shape
    rows, z = [], []
    for j in range(max(0, j0 - half), min(ny - 1, j0 + half) + 1):
        for i in range(max(0, i0 - half), min(nx - 1, i0 + half) + 1):
            if np.isfinite(score[j, i]):
                u, v = i - i0, j - j0
                rows.append([1, u, v, u * u, u * v, v * v])
                z.append(score[j, i])
    if len(z) < 6:
        return None
    try:
        p = np.linalg.solve(np.array(rows).T @ np.array(rows), np.array(rows).T @ np.array(z))
    except np.linalg.LinAlgError:
        return None
    _, b, c, d, e, f = p
    det = 4 * d * f - e * e
    if not (d < 0 and det > 0):
        return None
    du = (-2 * f * b + e * c) / det
    dv = (-2 * d * c + e * b) / det
    if abs(du) > half or abs(dv) > half:
        return None
    return du, dv


def grid(cube: Cube, mode="clipped", mjd=None, fit=True, data=None, noise=None, cx=None, cy=None, pm_max=15.0):
    """velocityGrid / scoreGrid. `mjd` replaces the frame times (shuffle test)."""
    t = cube.mjd if mjd is None else mjd
    base = (t.max() - t.min()) / JULIAN_YEAR_DAYS
    step = cube.pix / base
    ax = axis(pm_max, step)
    ref = float(t.mean())
    mask = region_mask(cube, cx, cy)
    score = np.zeros((ax.size, ax.size))
    for j, pd in enumerate(ax):
        for i, pr in enumerate(ax):
            snr = stack(cube, pr, pd, ref, mode, mjd, data, noise)["snr"]
            score[j, i] = np.nanmax(np.where(mask, snr, np.nan))
    j0, i0 = np.unravel_index(np.argmax(score), score.shape)
    out = {"axis": ax, "score": score, "step": step, "ref": ref, "grid_best": (ax[i0], ax[j0], score[j0, i0])}
    z = int(np.where(ax == 0)[0][0])
    out["zero"] = score[z, z]
    mv = score.copy()
    mv[z, z] = -np.inf
    jm, im = np.unravel_index(np.argmax(mv), mv.shape)
    out["moving"] = (ax[im], ax[jm], mv[jm, im])
    out["best"] = out["grid_best"]
    if fit:
        v = fit_peak(score, i0, j0)
        if v:
            pr, pd = ax[i0] + v[0] * step, ax[j0] + v[1] * step
            snr = stack(cube, pr, pd, ref, mode, mjd, data, noise)["snr"]
            out["best"] = (pr, pd, float(np.nanmax(np.where(mask, snr, np.nan))))
    return out


# ---------- significance.ts ----------


def mulberry32(seed: int):
    a = seed & 0xFFFFFFFF
    imul = lambda x, y: (x * y) & 0xFFFFFFFF

    def rand() -> float:
        nonlocal a
        a = (a + 0x6D2B79F5) & 0xFFFFFFFF
        t = a
        t = imul(t ^ (t >> 15), t | 1)
        t ^= (t + imul(t ^ (t >> 7), t | 61)) & 0xFFFFFFFF
        return ((t ^ (t >> 14)) & 0xFFFFFFFF) / 4294967296

    return rand


def permutation(n: int, rand) -> list[int]:
    p = list(range(n))
    for i in range(n - 1, 0, -1):
        j = int(np.floor(rand() * (i + 1)))
        p[i], p[j] = p[j], p[i]
    return p


def false_alarm(cube: Cube, n: int, mode="clipped", seed=1, **kw):
    real = grid(cube, mode, fit=False, **kw)
    rand = mulberry32(seed)
    null = []
    for _ in range(n):
        order = permutation(cube.n, rand)
        null.append(grid(cube, mode, mjd=cube.mjd[order], fit=False, **kw)["moving"][2])
    null = np.array(null)
    n_exceed = int(np.sum(null >= real["moving"][2]))
    sd = null.std(ddof=1) if n > 1 else np.nan
    return {
        "moving": real["moving"],
        "zero": real["zero"],
        "max_null": float(null.max()),
        "n_exceed": n_exceed,
        "p": (1 + n_exceed) / (n + 1),
        "z": (real["moving"][2] - null.mean()) / sd if sd > 0 else np.nan,
    }


# ---------- commands ----------


def off(best, cat) -> float:
    return float(np.hypot(best[0] - cat[0], best[1] - cat[1]))


def cmd_check():
    """This copy against the numbers printed by numbers.test.ts with normalise "off"
    (frontend/search/README.md, "Before")."""
    want = {"wise0855": (20.96, 0.94), "barnard": (838, 1.12), "epsindb": (78.4, 1.00), "teegarden": (1955.87, 1.20)}
    for name, (rel, cat) in MOVERS.items():
        t0 = time.time()
        g = grid(Cube(rel))
        print(
            f"{name}: gridBest=({g['grid_best'][0]:+.2f}, {g['grid_best'][1]:+.2f}) SNR {g['grid_best'][2]:.2f} "
            f"zero {g['zero']:.2f} best=({g['best'][0]:+.2f}, {g['best'][1]:+.2f}) off {off(g['best'], cat):.2f} "
            f"[TypeScript: SNR {want[name][0]}, off {want[name][1]}] {time.time() - t0:.1f} s"
        )


def track_peaks(cube: Cube, cat, half=2):
    """Brightest pixel within `half` px of the catalogue track in every frame, and its position."""
    ref = float(cube.mjd.mean())
    dx, dy = shifts(cube, cat[0], cat[1], ref)
    c = (cube.w - 1) // 2
    peak = np.full(cube.n, np.nan)
    for k in range(cube.n):
        x, y = int(round(c + dx[k])), int(round(c + dy[k]))
        box = cube.data[k, y - half : y + half + 1, x - half : x + half + 1]
        if np.isfinite(box).any():
            peak[k] = np.nanmax(box)
    return peak


def cmd_frames():
    """Step 0a / 0c: per-visit brightness, noise and wavelength on the catalogue track; how many
    samples the default clip keeps on the source pixel."""
    for name, (rel, cat) in MOVERS.items():
        cube = Cube(rel)
        peak = track_peaks(cube, cat)
        sn = peak / cube.noise
        ok = np.isfinite(sn)
        print(f"\n== {name} ({rel}): {cube.n} frames, {int((~ok).sum())} with no data on the track")
        print(
            f"   peak/noise per frame: min {np.nanmin(sn):.1f} median {np.nanmedian(sn):.1f} max {np.nanmax(sn):.1f}; "
            f"peak max/min {np.nanmax(peak) / max(np.nanmin(peak[peak > 0]), 1e-12):.0f}x; "
            f"noise max/min {cube.noise.max() / cube.noise.min():.1f}x"
        )
        print("   visit  n   MJD            lam (um)     peak/noise med [min, max]   share of sum(peak)  share of sum(SNR^2)")
        tot, tot2 = np.nansum(peak), np.nansum(sn**2)
        for e in np.unique(cube.epoch):
            m = cube.epoch == e
            print(
                f"   {e:5d} {m.sum():3d}  {cube.mjd[m].min():.1f}-{cube.mjd[m].max():.1f}  {cube.lam[m].min():.2f}-{cube.lam[m].max():.2f}  "
                f"{np.nanmedian(sn[m]):8.1f} [{np.nanmin(sn[m]):.1f}, {np.nanmax(sn[m]):.1f}]   "
                f"{np.nansum(peak[m]) / tot:6.2f}              {np.nansum(sn[m] ** 2) / tot2:6.2f}"
            )
        top = np.argsort(-np.nan_to_num(sn**2))[:5]
        print(f"   5 highest-SNR frames carry {np.nansum(sn[top] ** 2) / tot2:.2f} of sum(SNR^2); visits {cube.epoch[top].tolist()}")
        # Samples kept by each rule on the brightest stack pixel, at the catalogue motion.
        ref = float(cube.mjd.mean())
        mask = region_mask(cube)
        for mode in ("clipped", "pixel"):
            r = stack(cube, cat[0], cat[1], ref, mode)
            snr = np.where(mask, r["snr"], np.nan)
            y, x = np.unravel_index(np.nanargmax(snr), snr.shape)
            n_valid = int(np.isfinite(r["samples"][:, y, x]).sum())
            # the pixel with the most starlight (mean of all samples), whatever the clip made of it
            mean_img = np.where(mask, np.nanmean(r["samples"], axis=0), np.nan)
            ys, xs = np.unravel_index(np.nanargmax(mean_img), mean_img.shape)
            print(
                f"   {mode:8s} at the catalogue motion: best pixel ({x},{y}) SNR {snr[y, x]:.1f}, keeps {r['count'][y, x]} of {n_valid} samples; "
                f"on the brightest pixel ({xs},{ys}) it keeps {r['count'][ys, xs]} of {int(np.isfinite(r['samples'][:, ys, xs]).sum())}"
            )


def cmd_peak():
    """Step 0b: which frames and pixels make the WISE 0855 peak at (-10.57, +8.01) with the P-07 scale."""
    rel, cat = MOVERS["wise0855"]
    cube = Cube(rel)
    ref = float(cube.mjd.mean())
    mask = region_mask(cube)
    g = grid(cube, "pixel")
    print(f"P-07 scale: gridBest=({g['grid_best'][0]:+.2f}, {g['grid_best'][1]:+.2f}) SNR {g['grid_best'][2]:.2f}; "
          f"fitted best=({g['best'][0]:+.2f}, {g['best'][1]:+.2f}) SNR {g['best'][2]:.2f}, off {off(g['best'], cat):.2f}")
    cat_src = json.loads((CUBES / "wise0855" / "catalog.json").read_text(encoding="utf8"))
    cen = cube.meta["center"]
    c = (cube.w - 1) / 2
    for label, pm in (("catalogue", cat), ("P-07 grid best", g["grid_best"][:2]), ("P-07 fitted best", g["best"][:2])):
        for mode in ("clipped", "pixel"):
            r = stack(cube, pm[0], pm[1], ref, mode)
            snr = np.where(mask, r["snr"], np.nan)
            y, x = np.unravel_index(np.nanargmax(snr), snr.shape)
            s = r["samples"][:, y, x]
            z = s / cube.noise
            med = np.nanmedian(s)
            kept_frame = np.abs(s - med) <= 5 * cube.noise
            spread = MAD_TO_SIGMA * np.nanmedian(np.abs(s - med))
            kept = np.abs(s - med) <= 5 * np.maximum(cube.noise, spread) if mode == "pixel" else kept_frame
            order = np.argsort(-np.nan_to_num(s, nan=-np.inf))[:6]
            share = np.nansum(s[order[:3]][kept[order[:3]]]) / np.nansum(s[kept])
            print(f"\n{label} ({pm[0]:+.2f}, {pm[1]:+.2f}), mode {mode}: pixel ({x},{y}) SNR {snr[y, x]:.2f}, "
                  f"image {r['image'][y, x]:.4f}, sigma {r['sigma']:.5f}, kept {int(kept.sum())}/{int(np.isfinite(s).sum())}, "
                  f"pixel spread {spread:.4f} vs median frame noise {np.median(cube.noise):.4f}; top-3 kept samples = {share:.2f} of the sum")
            dxs, dys = shifts(cube, pm[0], pm[1], ref)
            for k in order:
                print(f"     frame {k:2d} visit {cube.epoch[k]} lam {cube.lam[k]:.2f} value {s[k]:8.4f} = {z[k]:6.1f} sigma "
                      f"kept(frame rule)={bool(kept_frame[k])} kept={bool(kept[k])} at cube pixel ({x + dxs[k]:.1f},{y + dys[k]:.1f})")
    print("\nCatalogue sources within 20 arcsec of the cube centre (pixel x, y; centre is 30, 30):")
    for s in cat_src["sources"]:
        if s["sep_arcsec"] <= 20:
            x = c - (s["ra"] - cen["ra"]) * np.cos(np.deg2rad(cen["dec"])) * 3600 / cube.pix
            y = c - (s["dec"] - cen["dec"]) * 3600 / cube.pix
            print(f"     {s['cat']:12s} {s['id']:22s} sep {s['sep_arcsec']:5.1f}  pixel ({x:.1f},{y:.1f})  {s['mag_band']} {s['mag']}  pm {s['pm_ra']}, {s['pm_dec']}")


# ---------- A-13 candidate: per-frame brightness from an aperture on the search region ----------

NATIVE_PIXEL_ARCSEC = 6.16  # SPHEREx detector pixel; the cubes are resampled to 3 arcsec
DETECT_SNR = 5.0


def frame_amplitude(cube: Cube, cx=None, cy=None, radius=4.0):
    """Sum of every frame inside (search radius + one native pixel) of the search centre, and its
    noise. Depends on neither the motion tried nor the frame times."""
    cx = (cube.w - 1) / 2 if cx is None else cx
    cy = (cube.h - 1) / 2 if cy is None else cy
    r_ap = radius + NATIVE_PIXEL_ARCSEC / cube.pix
    m = region_mask(cube, cx, cy, r_ap)
    vals = cube.data[:, m]
    n_valid = np.isfinite(vals).sum(1)
    amp = np.nansum(vals, axis=1)
    # Neighbouring 3 arcsec pixels share a native pixel, so the sum's noise is that of
    # n_valid * (pix / native)^2 independent values.
    sig = cube.noise * np.sqrt(n_valid) * (NATIVE_PIXEL_ARCSEC / cube.pix)
    return amp, sig, n_valid, int(m.sum())


def normalised(cube: Cube, cx=None, cy=None, radius=4.0, min_snr=DETECT_SNR):
    """(data / amplitude, noise / amplitude) with unmeasurable frames blanked, or None if the source
    is not measurable in more than half of the frames."""
    amp, sig, _, _ = frame_amplitude(cube, cx, cy, radius)
    with np.errstate(invalid="ignore", divide="ignore"):
        good = amp / sig >= min_snr
    if good.sum() * 2 <= cube.n:
        return None
    a = np.where(good, amp, np.nan)
    return cube.data / a[:, None, None], np.where(good, cube.noise / a, np.inf), good


def cmd_amp():
    rels = [v[0] for v in MOVERS.values()] + ["wise0855_control/D6"]
    for rel in rels:
        cube = Cube(rel)
        amp, sig, nv, npx = frame_amplitude(cube)
        s = amp / sig
        print(f"{rel}: aperture {npx} px, valid {nv.min()}-{nv.max()}; amplitude/noise min {s.min():.1f} "
              f"p10 {np.percentile(s, 10):.1f} median {np.median(s):.1f} max {s.max():.1f}; "
              f"frames >= {DETECT_SNR:.0f}: {(s >= DETECT_SNR).sum()} of {cube.n}; amplitude max/min {amp.max() / amp[amp > 0].min():.0f}x")
    cube = Cube("wise0855/D6")
    for cx, cy in [[15, 15], [45, 15], [15, 45], [45, 45], [30, 12], [30, 48], [12, 30], [48, 30]]:
        amp, sig, _, _ = frame_amplitude(cube, cx, cy)
        print(f"  wise0855 blank region ({cx},{cy}): frames >= 5: {(amp / sig >= 5).sum()} of {cube.n}, median {np.median(amp / sig):.1f}")
    cube = Cube("wise0855_control/D6")
    for dy in (-6, 0, 6):
        for dx in (-6, 0, 6):
            amp, sig, _, _ = frame_amplitude(cube, 30 + dx, 30 + dy)
            print(f"  control ({30 + dx},{30 + dy}): frames >= 5: {(amp / sig >= 5).sum()} of {cube.n}, median {np.median(amp / sig):.1f}")


def cmd_modes():
    n = int(sys.argv[2]) if len(sys.argv) > 2 else 20
    only = sys.argv[3].split(",") if len(sys.argv) > 3 else list(MOVERS)
    known = {**MOVERS, **STILL}
    for name in only:
        rel, cat = known[name]
        cube = Cube(rel)
        variants = [("default clipped", "clipped", {}), ("mean", "mean", {}), ("median", "median", {})]
        nm = normalised(cube)
        if nm is None:
            print(f"\n== {name}: not measurable per frame -> default only")
        else:
            data, noise, good = nm
            print(f"\n== {name}: normalised, {int(good.sum())} of {cube.n} frames used")
            kw = {"data": data, "noise": noise}
            variants += [("norm + pixel clip", "pixel", kw), ("norm + frame clip", "clipped", kw),
                         ("norm + mean", "mean", kw), ("norm + median", "median", kw)]
        want = sys.argv[4].split(",") if len(sys.argv) > 4 else None
        for label, mode, kw in variants:
            if want and not any(w in label for w in want):
                continue
            t0 = time.time()
            g = grid(cube, mode, **kw)
            line = (f"   {label:18s} best=({g['best'][0]:+.2f}, {g['best'][1]:+.2f}) off {off(g['best'], cat):.2f} "
                    f"gridBest SNR {g['grid_best'][2]:.1f} zero {g['zero']:.1f}")
            if n > 0:
                fa = false_alarm(cube, n, mode, **kw)
                line += f" | shuffles: real {fa['moving'][2]:.1f} max {fa['max_null']:.1f} exceed {fa['n_exceed']}/{n} z {fa['z']:.1f}"
            print(line + f" ({time.time() - t0:.0f} s)", flush=True)


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "check"
    {"check": cmd_check, "frames": cmd_frames, "peak": cmd_peak, "amp": cmd_amp, "modes": cmd_modes}[cmd]()
