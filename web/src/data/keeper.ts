import { KEEPER_URL } from "../chain/config";
import { useStore, type LivePrice } from "../state/store";

interface PricesFrame {
  time: number;
  prices: { marketId: number; mid: number; depthUsd: number; update: LivePrice["update"]; sig: `0x${string}` }[];
}

function apply(frame: PricesFrame) {
  const live: Record<number, LivePrice> = {};
  for (const p of frame.prices) {
    live[p.marketId] = { mid: p.mid, depthUsd: p.depthUsd, update: p.update, sig: p.sig };
  }
  useStore.setState({ live, keeperOnline: true });
}

async function refreshSummary() {
  try {
    const res = await fetch(`${KEEPER_URL}/summary`);
    const { summary, sparks } = await res.json();
    useStore.setState({ summary, sparks });
  } catch {
    /* the rail simply shows no change figures */
  }
}

let started = false;
export function startKeeperStream() {
  if (started) return;
  started = true;
  const es = new EventSource(`${KEEPER_URL}/stream`);
  es.onmessage = (ev) => apply(JSON.parse(ev.data));
  es.onerror = () => useStore.setState({ keeperOnline: false }); // EventSource retries by itself
  refreshSummary();
  setInterval(refreshSummary, 30_000);
}

export interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

export async function fetchCandles(marketId: number, interval: string): Promise<Candle[]> {
  const res = await fetch(`${KEEPER_URL}/candles?market=${marketId}&interval=${interval}`);
  if (!res.ok) throw new Error(`candles ${res.status}`);
  return res.json();
}

/** Mids the keeper has seen since it started, one per second: [{ time (s), value }]. */
export async function fetchHistory(marketId: number): Promise<{ time: number; value: number }[]> {
  try {
    const res = await fetch(`${KEEPER_URL}/history?market=${marketId}`);
    return res.ok ? res.json() : [];
  } catch {
    return [];
  }
}

export async function requestDrip(address: string): Promise<void> {
  try {
    await fetch(`${KEEPER_URL}/drip?address=${address}`);
  } catch {
    /* a wallet with its own gas does not need it */
  }
}
