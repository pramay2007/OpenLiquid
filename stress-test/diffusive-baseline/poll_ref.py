"""
Read-only calibration aid: poll the public reference books every 4 s (the keeper's cadence) and
log how the mid = (best bid + best ask)/2 actually moves: half-cent or whole-cent steps.
No account, no key, no user data; public market-data endpoint only.
"""
import json, sys, time, urllib.request

SYMS = ["GEMI-BTC2611302200-HI60000", "GEMI-UCL-2611242000-BVB-ARS-M-ARS", "GEMI-NFL-2611261800-CHI-DET-M-CHI",
        "GEMI-NFL-2611260100-GB-LAR-M-LAR", "GEMI-NFL-2611262130-PHI-DAL-M-DAL"]
DUR = float(sys.argv[1]) if len(sys.argv) > 1 else 1500.0
out = open(sys.argv[2] if len(sys.argv) > 2 else "poll_ref.jsonl", "a")
last = {}
t0 = time.time()
while time.time() - t0 < DUR:
    loop = time.time()
    for s in SYMS:
        try:
            req = urllib.request.Request(f"https://api.gemini.com/v1/book/{s}?limit_bids=50&limit_asks=50",
                                         headers={"User-Agent": "market-data-check/1.0"})
            b = json.loads(urllib.request.urlopen(req, timeout=10).read())
            bids = [(float(l["price"]), float(l["amount"])) for l in b.get("bids", [])]
            asks = [(float(l["price"]), float(l["amount"])) for l in b.get("asks", [])]
            if not bids or not asks:
                continue
            bid = max(p for p, _ in bids); ask = min(p for p, _ in asks)
            mid = (bid + ask) / 2
            band = 0.05 + 1e-9
            dep = min(sum(p * q for p, q in bids if abs(p - mid) <= band), sum(p * q for p, q in asks if abs(p - mid) <= band))
            key = (bid, ask)
            if last.get(s) != key:
                prev = last.get(s)
                rec = {"t": round(time.time() - t0, 1), "sym": s, "bid": bid, "ask": ask, "mid": round(mid, 4),
                       "depth": round(dep, 1), "dmid": None if prev is None else round(mid - (prev[0] + prev[1]) / 2, 4)}
                out.write(json.dumps(rec) + "\n"); out.flush()
                last[s] = key
        except Exception as e:
            out.write(json.dumps({"t": round(time.time() - t0, 1), "sym": s, "err": str(e)[:80]}) + "\n"); out.flush()
    time.sleep(max(0.0, 4.0 - (time.time() - loop)))
out.write(json.dumps({"t": round(time.time() - t0, 1), "done": True}) + "\n")
