"""Cross-check the rule simulator against the closed forms in the continuous-price limit
(tick = 0, no slow-price lag).  200,000 Monte Carlo paths + exact expectation of the simulator."""
from ol_sim import simulate, evaluate, DAY
from analytic import chain

cases = [dict(p0=0.5, T=30*DAY, H=5*DAY, dt=120.0), dict(p0=0.9, T=30*DAY, H=10*DAY, dt=300.0),
         dict(p0=0.2, T=30*DAY, H=8*DAY, dt=300.0), dict(p0=0.5, T=90*DAY, H=10*DAY, dt=300.0)]
print(f"{'case':44s} {'closed form':>12s} {'simulator exact':>16s} {'MC 200k':>10s} {'(se)':>8s}   (EV per $-day)")
for c in cases:
    for fee_mode, sf in [("none", 1.0), ("E4", 1.0), ("E4", 0.5), ("E4", 0.25)]:
        a = chain(c["p0"], c["T"], c["H"], fee=(fee_mode == "E4"), sf=sf)
        rec = simulate(N=1, seed=1, record=True, T=c["T"], p0=c["p0"], H=c["H"], dt=c["dt"], tick=0.0,
                       tau_slow=1e-9, strategy="cap", fee_mode=fee_mode, sf=sf, plan=False)
        r = evaluate(rec, N=200_000, seed=11)
        name = f"p0={c['p0']} tau0={c['T']/DAY:.0f}d window={c['H']/DAY:.0f}d fee={fee_mode} sf={sf}"
        print(f"{name:44s} {a['rate']:+12.5f} {r['exact_rate']:+16.5f} {r['ev_per_dollar_day']:+10.5f} "
              f"{r['ev_per_dollar_day_se']:8.5f}")
