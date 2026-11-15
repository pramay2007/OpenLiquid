// Gemini Prediction Markets: public market-data endpoints, no API key.

const BASE = process.env.GEMINI_API_URL ?? "https://api.gemini.com";

/** Ticks either side of the mid that count toward a contract's reference depth. */
export const DEPTH_TICKS = 5;
const TICK = 0.01;

async function getJson(path) {
  const res = await fetch(BASE + path, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`Gemini ${path} -> HTTP ${res.status}`);
  return res.json();
}

/** All events with the given status, following pagination. */
export async function geminiEvents({ status = "active", maxEvents = 1000 } = {}) {
  const out = [];
  const limit = 200;
  for (let offset = 0; offset < maxEvents; offset += limit) {
    const page = await getJson(`/v1/prediction-markets/events?status=${status}&limit=${limit}&offset=${offset}`);
    out.push(...(page.data ?? []));
    if (!page.data?.length || out.length >= (page.pagination?.total ?? 0)) break;
  }
  return out;
}

export async function geminiEvent(eventTicker) {
  return getJson(`/v1/prediction-markets/events/${encodeURIComponent(eventTicker)}`);
}

export async function geminiBook(instrumentSymbol) {
  return getJson(`/v1/book/${encodeURIComponent(instrumentSymbol)}?limit_bids=50&limit_asks=50`);
}

/** Hourly candles, oldest first: [{ time (s), open, high, low, close }]. */
export async function geminiCandles(instrumentSymbol, interval = "1hr") {
  const rows = await getJson(`/v2/candles/${encodeURIComponent(instrumentSymbol)}/${interval}`);
  return rows
    .map(([t, open, high, low, close]) => ({ time: Math.floor(t / 1000), open, high, low, close }))
    .sort((a, b) => a.time - b.time);
}

/**
 * Mid price and the USD resting within DEPTH_TICKS of it, on the thinner side.
 * Returns mid = null when either side of the book is empty.
 */
export function depthNearMid(book) {
  const bids = (book.bids ?? []).map((l) => ({ px: Number(l.price), sz: Number(l.amount) }));
  const asks = (book.asks ?? []).map((l) => ({ px: Number(l.price), sz: Number(l.amount) }));
  if (!bids.length || !asks.length) return { mid: null, bid: null, ask: null, depthUsd: 0 };
  const bid = Math.max(...bids.map((l) => l.px));
  const ask = Math.min(...asks.map((l) => l.px));
  const mid = (bid + ask) / 2;
  const band = DEPTH_TICKS * TICK + 1e-9;
  const side = (levels) =>
    levels.filter((l) => Math.abs(l.px - mid) <= band).reduce((sum, l) => sum + l.px * l.sz, 0);
  return { mid, bid, ask, depthUsd: Math.min(side(bids), side(asks)) };
}

/** Final price of a settled contract (1 for YES, 0 for NO), or null if it has not settled. */
export function resolutionPrice(contract) {
  if (contract?.status !== "settled" || !contract.resolutionSide) return null;
  return contract.resolutionSide.toLowerCase() === "yes" ? 1 : 0;
}
