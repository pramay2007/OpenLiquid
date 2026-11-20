"""ctypes wrapper around sim.c (compiled on first import)."""
import ctypes
import os
import subprocess
import numpy as np
from model import no_closed

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, "sim.c")
SO = os.path.join(HERE, "sim_v3.so")

P_NAMES = ["sigma", "T", "delta", "dy", "gap_sd", "maint", "liq_fee", "profit_fee", "cap_mult", "h_react",
           "z_time", "tau_floor", "tau_slow", "lev_ceil", "min_dist", "jump_ticks", "t0", "dt_sec", "take_frac",
           "skew", "lev", "theta", "entry_eps", "flat_before", "flat_after", "lev_cap", "min_lev", "max_gap",
           "half_spread"]
I_NAMES = ["use_closed", "n_rows", "ny", "n_gaps", "use_time_lev", "clock_mode", "jump_1x", "max_steps",
           "lat_steps", "mode", "side", "policy", "nout"]
DEFAULTS = dict(maint=0.20, liq_fee=0.05, profit_fee=0.10, cap_mult=10.0, h_react=120.0, z_time=3.0,
                tau_floor=3600.0, tau_slow=300.0, lev_ceil=50.0, min_dist=0.02, jump_ticks=2.0, take_frac=0.95,
                skew=1.0, lev=0.0, theta=0.0, entry_eps=1e-9, flat_before=-1.0, flat_after=-1.0, lev_cap=0.0,
                min_lev=1.0, max_gap=0.05, half_spread=0.0, gap_sd=0.0, delta=1.0, dy=1.0,
                use_closed=0, n_rows=1, ny=2, n_gaps=0, use_time_lev=1, clock_mode=0, jump_1x=0, lat_steps=0,
                mode=0, side=1, policy=0)
SEC_Y = 365.0 * 86400.0


def build():
    if not os.path.exists(SO) or os.path.getmtime(SO) < os.path.getmtime(SRC):
        subprocess.check_call(["cc", "-O3", "-shared", "-fPIC", "-o", SO, SRC, "-lm"])


build()
_lib = ctypes.CDLL(SO)
_lib.simulate.restype = None
_lib.simulate.argtypes = [ctypes.c_void_p] * 6 + [ctypes.c_int64, ctypes.c_uint64, ctypes.c_void_p]


def tables(m):
    if not hasattr(m, "_ctab"):
        lo = np.ascontiguousarray(m.no, dtype=np.float64)
        hi = np.empty_like(lo)
        for i in range(m.n_t):
            hi[i] = m.no_pre[i + 1] if (i + 1) in m.no_pre else m.no[i + 1]
        hi[m.n_t] = lo[m.n_t]
        m._ctab = (lo, np.ascontiguousarray(hi))
    return m._ctab


def y_from_yes_closed(f, theta, sigma):
    yg = np.linspace(0.0, 6.0, 600001)
    row = no_closed(yg, theta, sigma)
    return np.interp(1.0 - np.asarray(f), row, yg)


def run(y0, seed, model=None, closed=None, **kw):
    """model: OneTouch (table) or closed=(sigma, T_years) for pure GBM closed form.
    mode 0 output columns: r, kind, hold_sec, crowd_full, spanned, trader, house, liqfee
    mode 1 output columns: trader, house, n_trades, n_wins, liqfees, crowd_paid, hold_sec, ended, gross_r, alive_sec"""
    cfg = dict(DEFAULTS)
    gaps = np.zeros(1)
    if model is not None:
        lo, hi = tables(model)
        cfg.update(sigma=model.sigma, T=model.T, delta=model.delta, dy=model.dy, gap_sd=model.gap_sd,
                   n_rows=model.n_t + 1, ny=model.ny, use_closed=0)
        gaps = np.ascontiguousarray(np.array(model.gap_t if len(model.gap_t) else [0.0], dtype=np.float64))
        cfg["n_gaps"] = len(model.gap_t)
    else:
        lo = hi = np.zeros(2)
        cfg.update(sigma=closed[0], T=closed[1], use_closed=1, n_gaps=0)
    cfg.update(kw)
    mode = int(cfg["mode"])
    nout = 8 if mode == 0 else 10
    cfg["nout"] = nout
    dt = cfg["dt_sec"] / SEC_Y
    for g in (gaps[: cfg["n_gaps"]] if cfg["n_gaps"] else []):
        if g > cfg["t0"] + 1e-12:
            k = (g - cfg["t0"]) / dt
            assert abs(k - round(k)) < 1e-6, "gap time must fall on the simulation grid"
    par = np.array([float(cfg[k]) for k in P_NAMES], dtype=np.float64)
    ipar = np.array([int(cfg[k]) for k in I_NAMES], dtype=np.int64)
    y0 = np.ascontiguousarray(y0, dtype=np.float64)
    n = len(y0)
    out = np.zeros((n, nout), dtype=np.float64)
    _lib.simulate(par.ctypes.data, ipar.ctypes.data, lo.ctypes.data, hi.ctypes.data, gaps.ctypes.data,
                  y0.ctypes.data, n, ctypes.c_uint64(seed), out.ctypes.data)
    return out


def stats0(out):
    """Summary for mode 0."""
    n = len(out)
    se = lambda x: x.std(ddof=1) / np.sqrt(n)
    r, kind = out[:, 0], out[:, 1]
    return dict(ev=out[:, 5].mean(), ev_se=se(out[:, 5]), house=out[:, 6].mean(), house_se=se(out[:, 6]),
                liq=out[:, 7].mean(), gross=r.mean(), gross_se=se(r), p_win=(r > 0).mean(),
                p_take=(kind == 1).mean(), p_liq=(kind == 0).mean(), p_res=(kind == 2).mean(),
                p_fc=(kind == 3).mean(), p_to=(kind == 4).mean(), hold_days=out[:, 2].mean() / 86400.0,
                spanned=out[:, 4].mean(), wipe=(r <= -1 + 1e-9).mean())
