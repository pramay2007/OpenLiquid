"""
Monte Carlo verification (200,000 paths per row, explicit keeper timeline) of the DP values, plus
the two fixes that need the timeline to be evaluated (next-observation fill; crowding fee).

Usage: python3 mc_verify.py <1/lam> [corridor p0] [L]
"""
import json, sys, time
from model import Corridor, solve_dp, value_at
from mc import run, fmt

N = 200_000


def main():
    inv_lam = float(sys.argv[1])
    p0 = float(sys.argv[2]) if len(sys.argv) > 2 else 0.5
    L = int(sys.argv[3]) if len(sys.argv) > 3 else 25
    lam = 1.0 / inv_lam
    cor = Corridor(p0, L)
    print(cor, " tick every %.0fs" % inv_lam, flush=True)
    rows = []

    def go(label, dpv, **kw):
        t0 = time.time()
        r = run(n=N, cor=cor, lam=lam, **kw)
        r["label"] = label
        r["dp"] = dpv
        rows.append(r)
        z = (r.get("ev_trade", float("nan")) - dpv) / r.get("se_trade", float("nan")) if dpv is not None else float("nan")
        print(f"{label:58s} DP {dpv if dpv is None else round(dpv,4)}  z={z:+.1f} | {fmt(r)} [{time.time()-t0:.0f}s]", flush=True)

    kw = dict(ds=0.005)
    sp = solve_dp(cor, lam, q=0.0, la_nonliq=False, la_liq=False, mode="passive", tp_frac=0.9, **kw)
    go("honest entry, passive (TP at 90% of cap)", value_at(sp, 0, 0), seed=101, d=2, J=0, policy="passive")
    go("(i) entry snipe, passive, d=2", value_at(sp, 1, 0), seed=102, d=2, J=1, policy="passive")
    go("(i) entry snipe, passive, d=1", value_at(sp, 1, 0), seed=103, d=1, J=1, policy="passive")
    for d, q in ((2, 1.0), (1, 0.75)):
        spd = solve_dp(cor, lam, q=q, la_nonliq=False, la_liq=True, mode="passive", tp_frac=0.9, **kw)
        go(f"(iii) honest entry, passive + dodge, d={d}", value_at(spd, 0, 0), seed=110 + d, d=d, J=0,
           policy="passive", use_dodge=True)
        go(f"(i)+(iii) entry snipe, passive + dodge, d={d}", value_at(spd, 1, 0), seed=120 + d, d=d, J=1,
           policy="passive", use_dodge=True)
        s3 = solve_dp(cor, lam, q=q, la_nonliq=False, la_liq=True, mode="opt", **kw)
        go(f"(iii) honest entry, optimal exit + dodge only, d={d}", value_at(s3, 0, 0), seed=130 + d, d=d, J=0,
           policy="table", sol=s3, use_la_nonliq=False, use_la_liq=True)
        s2 = solve_dp(cor, lam, q=q, la_nonliq=True, la_liq=False, mode="opt", **kw)
        go(f"(ii) honest entry, optimal exit + adverse-tick exit only, d={d}", value_at(s2, 0, 0), seed=140 + d,
           d=d, J=0, policy="table", sol=s2, use_la_nonliq=True, use_la_liq=False)
        sf = solve_dp(cor, lam, q=q, la_nonliq=True, la_liq=True, mode="opt", **kw)
        go(f"(ii)+(iii) honest entry, optimal exits, d={d}", value_at(sf, 0, 0), seed=150 + d, d=d, J=0,
           policy="table", sol=sf)
        go(f"(i)+(ii)+(iii) full sniper, d={d}", value_at(sf, 1, 0), seed=160 + d, d=d, J=1,
           policy="table", sol=sf)
        if d == 2:
            fee = (cor.L - 1) / cor.p0 * (1 - cor.p0) / (7.8 * 86400)
            go(f"full sniper, d=2, crowding fee at full skew (7.8d to expiry)", None, seed=170, d=d, J=1,
               policy="table", sol=sf, fee_rate=fee)
    so = solve_dp(cor, lam, q=0.0, la_nonliq=False, la_liq=False, mode="opt", **kw)
    go("(i) entry snipe, optimal honest exit (no look-ahead later), d=2", value_at(so, 1, 0), seed=180, d=2, J=1,
       policy="table", sol=so, use_la_nonliq=False, use_la_liq=False)
    # fix: next-observation fill
    go("FIX next-observation fill: honest, passive", None, seed=201, d=2, J=0, policy="passive", fix="nextobs")
    go("FIX next-observation fill: 'sniper' entry + dodge attempts", None, seed=202, d=2, J=1, policy="passive",
       use_dodge=True, fix="nextobs")
    json.dump(rows, open(f"mc_verify_{int(inv_lam)}_{p0}_{L}.json", "w"), indent=1)


if __name__ == "__main__":
    main()
