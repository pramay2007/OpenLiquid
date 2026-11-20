"""Summarise the reference-book poll: step sizes of the mid and what follows a half-cent step."""
import json, sys
rows = [json.loads(l) for l in open(sys.argv[1]) if l.strip()]
by = {}
for r in rows:
    if "sym" in r and "mid" in r:
        by.setdefault(r["sym"], []).append(r)
tmax = max(r["t"] for r in rows)
print(f"poll length {tmax / 60:.1f} min, 4 s cadence")
for s, rs in by.items():
    ch = [r for r in rs if r["dmid"] is not None]
    steps = [round(r["dmid"] / 0.005) for r in ch]
    half = sum(1 for x in steps if abs(x) == 1)
    whole = sum(1 for x in steps if abs(x) == 2)
    big = sum(1 for x in steps if abs(x) > 2)
    spreads = [round((r["ask"] - r["bid"]) / 0.01) for r in rs]
    print(f"{s}: start bid/ask {rs[0]['bid']}/{rs[0]['ask']} depth ${rs[0]['depth']:.0f}; mid changes {len(ch)}: half-cent {half}, whole-cent {whole}, larger {big}; "
          f"net move {sum(steps) * 0.5:+.1f} ticks; sum of squares {sum(x * x for x in steps) * 0.25:.2f} ticks^2")
    # what follows a half-cent step that leaves a two-tick spread
    cont = rev = 0
    gaps = []
    for i in range(len(ch) - 1):
        a, b = ch[i], ch[i + 1]
        if abs(steps[i]) == 1 and round((a["ask"] - a["bid"]) / 0.01) == 2:
            if steps[i + 1] * steps[i] > 0:
                cont += 1
            else:
                rev += 1
            gaps.append(round(b["t"] - a["t"], 1))
    if cont + rev:
        print(f"   after a half-cent step that widened the spread to two ticks: continued {cont}, reversed {rev}; delays (s): {gaps}")
    same = sum(1 for i in range(len(steps) - 1) if steps[i] * steps[i + 1] > 0)
    if len(steps) > 1:
        print(f"   consecutive changes with the same sign: {same} of {len(steps) - 1}")
