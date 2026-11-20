// Hyperliquid: best bid/offer over websocket for the mid, REST order book for depth.
// Covers the main perp dex (BTC, ETH, ...) and HIP-3 dexes such as "xyz:TSLA", "xyz:GOLD".

const API = process.env.HL_API_URL ?? "https://api.hyperliquid.xyz/info";
const WS = process.env.HL_WS_URL ?? "wss://api.hyperliquid.xyz/ws";

/** Half-width of the band around the mid that counts toward reference depth. */
export const DEPTH_BAND = 0.001; // 10 bps: the distance a 1000x position survives

async function info(body) {
  const res = await fetch(API, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`Hyperliquid ${body.type} -> HTTP ${res.status}`);
  return res.json();
}

/** Mid from the full-precision book. Used once per market, before the websocket has ticked. */
export async function hlMid(coin) {
  const book = await info({ type: "l2Book", coin });
  const [bids, asks] = book.levels;
  if (!bids.length || !asks.length) return null;
  return (Number(bids[0].px) + Number(asks[0].px)) / 2;
}

/** USD resting within DEPTH_BAND of the mid, on the thinner side. */
export async function hlDepth(coin) {
  // Four significant figures aggregates levels so that 20 of them span the whole band.
  const book = await info({ type: "l2Book", coin, nSigFigs: 4 });
  const [bids, asks] = book.levels.map((side) => side.map((l) => ({ px: Number(l.px), sz: Number(l.sz) })));
  if (!bids.length || !asks.length) return 0;
  const mid = (bids[0].px + asks[0].px) / 2;
  const side = (levels) =>
    levels.filter((l) => Math.abs(l.px - mid) / mid <= DEPTH_BAND).reduce((sum, l) => sum + l.px * l.sz, 0);
  return Math.min(side(bids), side(asks));
}

/** Previous-day price for every coin on a dex ("" is the main dex), keyed by coin name. */
export async function hlPrevDay(dex = "") {
  const [meta, ctxs] = await info({ type: "metaAndAssetCtxs", dex });
  return new Map(meta.universe.map((u, i) => [u.name, Number(ctxs[i]?.prevDayPx)]));
}

/** Candles, oldest first: [{ time (s), open, high, low, close }]. */
export async function hlCandles(coin, interval = "1m", count = 300) {
  const ms = { "1m": 60_000, "5m": 300_000, "15m": 900_000, "1h": 3_600_000, "4h": 14_400_000, "1d": 86_400_000 }[interval];
  if (!ms) throw new Error(`unsupported interval ${interval}`);
  const endTime = Date.now();
  const rows = await info({ type: "candleSnapshot", req: { coin, interval, startTime: endTime - ms * count, endTime } });
  return rows.map((r) => ({
    time: Math.floor(r.t / 1000),
    open: Number(r.o),
    high: Number(r.h),
    low: Number(r.l),
    close: Number(r.c),
  }));
}

/**
 * Subscribe to best bid/offer for a set of coins. Calls onMid(coin, mid, timeMs) on every
 * update and reconnects with backoff if the socket drops.
 */
export function hlSubscribeMids(coins, onMid, onAlive = () => {}) {
  let ws;
  let closed = false;
  let retry = 1000;
  let pingTimer;

  function connect() {
    ws = new WebSocket(WS);
    ws.onopen = () => {
      retry = 1000;
      for (const coin of coins) {
        ws.send(JSON.stringify({ method: "subscribe", subscription: { type: "bbo", coin } }));
      }
      pingTimer = setInterval(() => ws.readyState === 1 && ws.send(JSON.stringify({ method: "ping" })), 5_000);
    };
    ws.onmessage = (msg) => {
      let data;
      try {
        data = JSON.parse(msg.data);
      } catch {
        return;
      }
      onAlive(); // any frame, pongs included, shows the feed is live
      if (data.channel !== "bbo") return;
      const [bid, ask] = data.data.bbo ?? [];
      if (!bid || !ask) return;
      onMid(data.data.coin, (Number(bid.px) + Number(ask.px)) / 2, data.data.time);
    };
    ws.onclose = () => {
      clearInterval(pingTimer);
      if (closed) return;
      setTimeout(connect, retry);
      retry = Math.min(retry * 2, 30_000);
    };
    ws.onerror = () => {
      // Closing a socket that never connected raises another error event, so handle only the first.
      ws.onerror = null;
      try {
        ws.close();
      } catch {
        /* already closed */
      }
    };
  }

  connect();
  return () => {
    closed = true;
    ws?.close();
  };
}
