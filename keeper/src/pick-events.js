// Choose a handful of live Gemini prediction-market contracts to list as event markets, and
// write them into markets.json. Run before deploying:  npm run pick-events
//
// Selection: active contracts that resolve at least MIN_DAYS out, priced away from 0 and 1,
// with a tight spread; ranked by resting depth near the mid; at most PER_CATEGORY per category.

import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { geminiBook, geminiEvents, depthNearMid } from "./sources/gemini.js";

const MARKETS_FILE = fileURLToPath(new URL("../../markets.json", import.meta.url));
const MIN_DAYS = Number(process.env.MIN_DAYS ?? 6);
const COUNT = Number(process.env.COUNT ?? 6);
const PER_CATEGORY = Number(process.env.PER_CATEGORY ?? 2);
const FIRST_ID = 101;

const events = await geminiEvents({ status: "active", maxEvents: 1000 });
const cutoff = Date.now() + MIN_DAYS * 86_400_000;

const candidates = [];
for (const ev of events) {
  for (const c of ev.contracts ?? []) {
    const bid = Number(c.prices?.bestBid);
    const ask = Number(c.prices?.bestAsk);
    // Leverage must be gone before the outcome starts being decided. For a match that is
    // kickoff, which comes well before the contract's formal expiry.
    const formalExpiry = Date.parse(c.expiryDate ?? ev.expiryDate);
    const start = Date.parse(ev.startTime ?? "");
    const expiry = Number.isFinite(start) && start > Date.now() && start < formalExpiry ? start : formalExpiry;
    if (!(bid > 0 && ask > 0) || !Number.isFinite(expiry)) continue;
    const mid = (bid + ask) / 2;
    if (c.status !== "active" || c.isCombo || expiry < cutoff) continue;
    if (mid < 0.2 || mid > 0.8 || ask - bid > 0.021) continue;
    candidates.push({ ev, c, mid, expiry, volume: Number(ev.volume24h ?? 0) });
  }
}
candidates.sort((a, b) => b.volume - a.volume);
console.log(`${events.length} active events, ${candidates.length} candidate contracts`);

// Depth is one request per contract, so only the most active candidates are measured.
const measured = [];
for (const cand of candidates.slice(0, 60)) {
  try {
    const book = await geminiBook(cand.c.instrumentSymbol);
    measured.push({ ...cand, depth: depthNearMid(book).depthUsd });
  } catch (err) {
    console.warn(`skip ${cand.c.instrumentSymbol}: ${err.message}`);
  }
}
measured.sort((a, b) => b.depth - a.depth);

const picked = [];
const perCategory = {};
const perEvent = new Set();
for (const m of measured) {
  const cat = m.ev.category ?? "Other";
  if ((perCategory[cat] ?? 0) >= PER_CATEGORY || perEvent.has(m.ev.id)) continue;
  perCategory[cat] = (perCategory[cat] ?? 0) + 1;
  perEvent.add(m.ev.id);
  picked.push(m);
  if (picked.length >= COUNT) break;
}

const file = JSON.parse(await readFile(MARKETS_FILE, "utf8"));
file.events = picked.map((m, i) => ({
  id: FIRST_ID + i,
  symbol: m.c.instrumentSymbol.replace(/^GEMI-/, ""),
  name: m.ev.title,
  outcome: m.c.label,
  category: m.ev.category ?? "Other",
  kind: "event",
  source: "gemini",
  ref: m.c.instrumentSymbol,
  eventTicker: m.ev.ticker,
  expiry: Math.floor(m.expiry / 1000),
}));
await writeFile(MARKETS_FILE, JSON.stringify(file, null, 2) + "\n");

for (const [i, m] of picked.entries()) {
  console.log(
    `${FIRST_ID + i}  ${m.ev.category.padEnd(11)} ${m.ev.title} / ${m.c.label}  mid ${m.mid.toFixed(3)}  depth $${m.depth.toFixed(0)}  expires ${new Date(m.expiry).toISOString().slice(0, 16)}`
  );
}
