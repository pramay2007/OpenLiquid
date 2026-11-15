// OpenLiquid keeper.
//
// Decision loop, every TICK_MS:
//   1. Read reference prices: Hyperliquid mids (websocket) and Gemini prediction-market books.
//   2. Sign one PriceUpdate per market (EIP-712) with the reference mid and nearby depth.
//   3. Serve the signed updates over HTTP so a trade can carry its own fresh price.
//   4. Relay them on-chain when a market's heartbeat is due or its price has moved enough.
//   5. Scan open positions and liquidate, force-close or settle whatever the engine says is due.
//
// Limits on what this process can do:
//   - Its key can only sign prices and send the permissionless calls above. It holds no user
//     funds and has no admin role on any contract.
//   - On test networks it also drips a small, fixed amount of gas to new demo accounts: once
//     per address, and never more than DRIP_MAX_PER_HOUR times an hour.
//   - A price is signed only if the source produced it within MAX_SOURCE_AGE_MS.
//   - An event market is marked resolved only when Gemini reports the contract as settled.
//   - It stops relaying when the gas balance falls below MIN_GAS_BALANCE.

import dotenv from "dotenv";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { ethers } from "ethers";
import { hlSubscribeMids, hlDepth, hlMid, hlCandles, hlPrevDay } from "./sources/hyperliquid.js";
import { geminiBook, geminiEvent, geminiCandles, depthNearMid, resolutionPrice } from "./sources/gemini.js";

const root = (p) => fileURLToPath(new URL(`../../${p}`, import.meta.url));
dotenv.config({ path: root(".env"), quiet: true });
const NETWORK = process.env.NETWORK ?? "localhost";
const LOCAL = NETWORK === "localhost";
const deployment = JSON.parse(await readFile(root(`deployments/${NETWORK}.json`), "utf8"));
// ABIs come from the copies the deploy script commits for the frontend, so the keeper runs
// from a clean clone without compiling the contracts.
const abi = async (name) => JSON.parse(await readFile(root(`web/src/chain/${name}.abi.json`), "utf8"));

const TICK_MS = Number(process.env.TICK_MS ?? 1000);
// On a real network every relay costs gas, so prices go on-chain less often there. Trades and
// upkeep calls carry their own fresh signed price, so this only affects how closely the on-chain
// slow price tracks between trades.
const HEARTBEAT_S = Number(process.env.HEARTBEAT_S ?? (LOCAL ? 3 : 120));
const DEVIATION_BPS = Number(process.env.DEVIATION_BPS ?? (LOCAL ? 2 : 5));
const SWEEP_EVERY_TICKS = Number(process.env.SWEEP_EVERY_TICKS ?? (LOCAL ? 1 : 3));
// Relays are batched: at most one transaction every MIN_RELAY_GAP_S. While nobody has the app
// open and no position is live, the keeper falls back to the slower IDLE_* cadence.
const MIN_RELAY_GAP_S = Number(process.env.MIN_RELAY_GAP_S ?? (LOCAL ? 0 : 10));
const IDLE_HEARTBEAT_S = Number(process.env.IDLE_HEARTBEAT_S ?? (LOCAL ? HEARTBEAT_S : 1800));
const IDLE_DEVIATION_BPS = Number(process.env.IDLE_DEVIATION_BPS ?? (LOCAL ? DEVIATION_BPS : 15));
const IDLE_RELAY_GAP_S = Number(process.env.IDLE_RELAY_GAP_S ?? (LOCAL ? 0 : 60));
const MAX_SOURCE_AGE_MS = Number(process.env.MAX_SOURCE_AGE_MS ?? 15_000);
const MIN_GAS_BALANCE = ethers.parseEther(process.env.MIN_GAS_BALANCE ?? "0.05");
const PORT = Number(process.env.PORT ?? 8787);
// Hardhat's published test key #1 on localhost; a real key must be supplied anywhere else.
const LOCAL_TEST_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const KEY = LOCAL ? LOCAL_TEST_KEY : process.env.KEEPER_PRIVATE_KEY;
if (!KEY) throw new Error("Set KEEPER_PRIVATE_KEY in .env to run the keeper off localhost");

const provider = new ethers.JsonRpcProvider(process.env.RPC_URL ?? deployment.rpcUrl, deployment.chainId, {
  staticNetwork: true,
});
const wallet = new ethers.NonceManager(new ethers.Wallet(KEY, provider));
const keeperAddress = await wallet.getAddress();
const oracle = new ethers.Contract(deployment.contracts.PriceOracle, await abi("PriceOracle"), wallet);
const engine = new ethers.Contract(deployment.contracts.PerpEngine, await abi("PerpEngine"), wallet);

const DOMAIN = {
  name: "OpenLiquidOracle",
  version: "1",
  chainId: deployment.chainId,
  verifyingContract: deployment.contracts.PriceOracle,
};
const TYPES = {
  PriceUpdate: [
    { name: "marketId", type: "uint32" },
    { name: "price", type: "uint256" },
    { name: "depthUsd", type: "uint256" },
    { name: "timestamp", type: "uint64" },
    { name: "resolved", type: "bool" },
  ],
};

const markets = deployment.markets;
/** marketId -> { mid, depthUsd, at (ms), resolved } as last seen at the source. */
const source = new Map();
/** marketId -> latest signed update, as served to clients. */
const signed = new Map();
/** marketId -> { price, timestamp } last relayed on-chain. */
const relayed = new Map();
/** marketId -> rolling one-second history of mids, for sparklines and event charts. */
const history = new Map();
const HISTORY_POINTS = 3600;

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

// ---- sources ------------------------------------------------------------------------------

const hlMarkets = markets.filter((m) => m.source === "hyperliquid");
const gemMarkets = markets.filter((m) => m.source === "gemini");
const byRef = new Map(markets.map((m) => [m.ref, m]));

// Best bid/offer only ticks when it changes, so a quiet market is not a stale one. A
// Hyperliquid mid counts as current while the websocket itself is alive.
let hlAliveAt = 0;
hlSubscribeMids(
  hlMarkets.map((m) => m.ref),
  (coin, mid) => {
    const m = byRef.get(coin);
    if (!m) return;
    const prev = source.get(m.id);
    source.set(m.id, { mid, depthUsd: prev?.depthUsd ?? 0, at: Date.now(), resolved: false });
  },
  () => (hlAliveAt = Date.now())
);

async function refreshHlDepth() {
  for (const m of hlMarkets) {
    try {
      const depthUsd = await hlDepth(m.ref);
      const prev = source.get(m.id);
      if (prev) prev.depthUsd = depthUsd;
      else source.set(m.id, { mid: await hlMid(m.ref), depthUsd, at: Date.now(), resolved: false });
    } catch (err) {
      log(`depth ${m.symbol}: ${err.message}`);
    }
  }
}

async function refreshGemini() {
  for (const m of gemMarkets) {
    if (source.get(m.id)?.resolved) continue;
    try {
      const { mid, depthUsd } = depthNearMid(await geminiBook(m.ref));
      if (mid !== null) source.set(m.id, { mid, depthUsd, at: Date.now(), resolved: false });
    } catch (err) {
      log(`book ${m.symbol}: ${err.message}`);
    }
  }
}

/** Ask Gemini for each unresolved event; a settled contract carries its outcome. */
async function checkResolutions() {
  for (const m of gemMarkets) {
    if (source.get(m.id)?.resolved || !m.eventTicker) continue;
    try {
      const res = await geminiEvent(m.eventTicker);
      const event = res.data ?? res;
      const contract = (event.contracts ?? []).find((c) => c.instrumentSymbol === m.ref);
      const final = resolutionPrice(contract);
      if (final === null) continue;
      source.set(m.id, { mid: final, depthUsd: 0, at: Date.now(), resolved: true });
      log(`RESOLVED ${m.symbol} -> ${final === 1 ? "YES" : "NO"}`);
    } catch (err) {
      log(`resolution ${m.symbol}: ${err.message}`);
    }
  }
}

// ---- signing and relaying -----------------------------------------------------------------

const toWad = (x) => ethers.parseUnits(x.toFixed(12), 18);
const toUsdc = (x) => ethers.parseUnits(Math.max(0, x).toFixed(6), 6);

// Prices are stamped in chain time. A chain's clock can run ahead of this machine's (a local
// devnet does after a burst of blocks), and the engine compares the stamp with block.timestamp.
let chainSkew = 0;
let lastStamp = 0;
async function refreshChainSkew() {
  try {
    const block = await provider.getBlock("latest");
    chainSkew = Math.max(0, Number(block.timestamp) - Math.floor(Date.now() / 1000));
  } catch {
    /* keep the last value */
  }
}

async function signAll() {
  const now = Date.now();
  const timestamp = Math.max(lastStamp, Math.floor(now / 1000) + chainSkew);
  lastStamp = timestamp;
  for (const m of markets) {
    const s = source.get(m.id);
    if (!s || s.mid === null) continue;
    const seenAt = m.source === "hyperliquid" ? Math.max(s.at, hlAliveAt) : s.at;
    if (!s.resolved && now - seenAt > MAX_SOURCE_AGE_MS) continue; // never sign a stale source
    const update = {
      marketId: m.id,
      price: toWad(s.mid),
      depthUsd: toUsdc(s.depthUsd),
      timestamp,
      resolved: s.resolved,
    };
    const sig = await wallet.signer.signTypedData(DOMAIN, TYPES, update);
    signed.set(m.id, { update, sig, mid: s.mid, depthUsd: s.depthUsd });

    const h = history.get(m.id) ?? [];
    if (!h.length || h[h.length - 1].time !== timestamp) h.push({ time: timestamp, value: s.mid });
    if (h.length > HISTORY_POINTS) h.shift();
    history.set(m.id, h);
  }
}

/** Someone is watching prices or has a position open, so on-chain prices should track closely. */
let openPositions = 0;
/** When a client last fetched prices directly; apps behind a proxy that drops streams do this. */
let lastPollAt = 0;
const active = () => LOCAL || sseClients.size > 0 || openPositions > 0 || Date.now() - lastPollAt < 15_000;

function dueForRelay(id, entry) {
  const last = relayed.get(id);
  if (!last) return true;
  if (entry.update.resolved) return !last.resolved;
  const busy = active();
  if (entry.update.timestamp - last.timestamp >= (busy ? HEARTBEAT_S : IDLE_HEARTBEAT_S)) return true;
  return (Math.abs(entry.mid - last.mid) / last.mid) * 1e4 >= (busy ? DEVIATION_BPS : IDLE_DEVIATION_BPS);
}

let relaying = false;
let lastRelayAt = 0;
async function relay() {
  if (relaying) return;
  if (Date.now() - lastRelayAt < (active() ? MIN_RELAY_GAP_S : IDLE_RELAY_GAP_S) * 1000) return;
  relaying = true;
  try {
    const due = [...signed.entries()].filter(([id, e]) => dueForRelay(id, e));
    if (!due.length) return;
    lastRelayAt = Date.now();
    if ((await provider.getBalance(keeperAddress)) < MIN_GAS_BALANCE) {
      log("gas balance below MIN_GAS_BALANCE: not relaying");
      return;
    }
    const tx = await oracle.push(
      due.map(([, e]) => e.update),
      due.map(([, e]) => e.sig)
    );
    await tx.wait();
    for (const [id, e] of due) {
      relayed.set(id, { mid: e.mid, timestamp: e.update.timestamp, resolved: e.update.resolved });
    }
  } catch (err) {
    log(`relay: ${err.shortMessage ?? err.message}`);
    wallet.reset();
  } finally {
    relaying = false;
  }
}

// ---- position upkeep ----------------------------------------------------------------------

const coder = ethers.AbiCoder.defaultAbiCoder();
const PRICE_DATA_TYPES = [
  "tuple(uint32 marketId,uint256 price,uint256 depthUsd,uint64 timestamp,bool resolved)[]",
  "bytes[]",
];

/** The freshest signed price for a market, encoded for the engine's `priceData` argument. */
function priceDataFor(marketId) {
  const e = signed.get(marketId);
  return e ? coder.encode(PRICE_DATA_TYPES, [[e.update], [e.sig]]) : "0x";
}

/**
 * What, if anything, is due on a position. Judged against the live reference price, not the
 * last price relayed on-chain: the call carries that live price with it.
 */
function actionFor(p) {
  const live = signed.get(Number(p.position.marketId));
  if (!live) return null;
  if (live.update.resolved) return "close";
  const liq = Number(ethers.formatUnits(p.liquidationPrice, 18));
  if (p.liquidatable || (p.position.isLong ? live.mid <= liq : live.mid >= liq)) return "liquidate";
  if (p.forceClosable) return "forceClose";
  return null;
}

let sweeping = false;
async function sweep() {
  if (sweeping) return;
  sweeping = true;
  try {
    const count = Number(await engine.openPositionCount());
    openPositions = count;
    for (let offset = 0; offset < count; offset += 100) {
      for (const p of await engine.openPositions(offset, 100)) {
        const action = actionFor(p);
        if (!action) continue;
        const marketId = Number(p.position.marketId);
        try {
          // Gas estimation runs the call first, so a position that is not actually due costs nothing.
          // The estimate gets headroom: it has almost none of its own, and a node that is a block
          // behind estimates against old state.
          const data = priceDataFor(marketId);
          const gas = await engine[action].estimateGas(p.id, data);
          const tx = await engine[action](p.id, data, { gasLimit: (gas * 3n) / 2n + 60_000n });
          await tx.wait();
          log(`${action} #${p.id} (market ${marketId})`);
        } catch (err) {
          const reason = err.revert?.name ?? err.shortMessage ?? err.message;
          if (reason !== "NotLiquidatable") log(`${action} #${p.id}: ${reason}`);
          wallet.reset();
        }
      }
    }
  } catch (err) {
    log(`sweep: ${err.shortMessage ?? err.message}`);
  } finally {
    sweeping = false;
  }
}

// ---- HTTP ---------------------------------------------------------------------------------

const json = (v) => JSON.stringify(v, (_, x) => (typeof x === "bigint" ? x.toString() : x));

function pricesPayload() {
  return {
    time: Date.now(),
    prices: [...signed.entries()].map(([id, e]) => ({
      marketId: id,
      mid: e.mid,
      depthUsd: e.depthUsd,
      update: e.update,
      sig: e.sig,
    })),
  };
}

// ---- test-network gas drip ----------------------------------------------------------------

// Sized for a public demo: about ten round trips per account (an open costs roughly 0.013
// USDC in gas, a close 0.005), and a bounded hourly spend.
const DRIP_AMOUNT = ethers.parseEther(process.env.DRIP_AMOUNT ?? (LOCAL ? "1" : "0.2"));
const DRIP_MAX_PER_HOUR = Number(process.env.DRIP_MAX_PER_HOUR ?? (LOCAL ? 600 : 10));
const dripped = new Set();
let dripTimes = [];

async function drip(address) {
  if (!ethers.isAddress(address)) return { ok: false, reason: "bad address" };
  const to = ethers.getAddress(address);
  if (dripped.has(to)) return { ok: true, already: true };
  if ((await provider.getBalance(to)) >= DRIP_AMOUNT / 2n) {
    dripped.add(to);
    return { ok: true, already: true };
  }
  dripTimes = dripTimes.filter((t) => Date.now() - t < 3_600_000);
  if (dripTimes.length >= DRIP_MAX_PER_HOUR) return { ok: false, reason: "hourly limit reached" };
  if ((await provider.getBalance(keeperAddress)) < MIN_GAS_BALANCE + DRIP_AMOUNT) {
    return { ok: false, reason: "keeper is low on gas" };
  }
  dripped.add(to);
  dripTimes.push(Date.now());
  try {
    await (await wallet.sendTransaction({ to, value: DRIP_AMOUNT })).wait();
    log(`drip ${to}`);
    return { ok: true };
  } catch (err) {
    dripped.delete(to);
    wallet.reset();
    return { ok: false, reason: err.shortMessage ?? err.message };
  }
}

// ---- 24h reference prices and sparklines --------------------------------------------------

let summaryCache = { at: 0, rows: {} };
async function summary() {
  if (Date.now() - summaryCache.at < 60_000) return summaryCache.rows;
  const rows = {};
  const dexes = [...new Set(hlMarkets.map((m) => (m.ref.includes(":") ? m.ref.split(":")[0] : "")))];
  for (const dex of dexes) {
    try {
      const prev = await hlPrevDay(dex);
      for (const m of hlMarkets) if (prev.has(m.ref)) rows[m.id] = { prevDay: prev.get(m.ref) };
    } catch (err) {
      log(`summary ${dex || "main"}: ${err.message}`);
    }
  }
  for (const m of gemMarkets) {
    try {
      const rowsH = await geminiCandles(m.ref, "1hr");
      const dayAgo = Date.now() / 1000 - 86_400;
      const ref = rowsH.filter((r) => r.time <= dayAgo).pop() ?? rowsH[0];
      if (ref) rows[m.id] = { prevDay: ref.close };
    } catch {
      /* no candle history for this contract: the UI shows no 24h change */
    }
  }
  summaryCache = { at: Date.now(), rows };
  return rows;
}

/** Last hour of mids per market, one point every 30 seconds. */
function sparks() {
  const out = {};
  for (const [id, h] of history) out[id] = h.filter((_, i) => (h.length - 1 - i) % 30 === 0).map((p) => p.value);
  return out;
}

const sseClients = new Set();
const candleCache = new Map();

async function candles(marketId, interval) {
  const m = markets.find((x) => x.id === marketId);
  if (!m) return null;
  const key = `${marketId}:${interval}`;
  const hit = candleCache.get(key);
  if (hit && Date.now() - hit.at < 20_000) return hit.rows;
  const rows = m.source === "hyperliquid" ? await hlCandles(m.ref, interval) : await geminiCandles(m.ref, "1hr");
  candleCache.set(key, { at: Date.now(), rows });
  return rows;
}

createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  res.setHeader("Access-Control-Allow-Origin", "*");
  try {
    if (url.pathname === "/prices") {
      lastPollAt = Date.now();
      res.setHeader("Content-Type", "application/json");
      res.end(json(pricesPayload()));
    } else if (url.pathname === "/stream") {
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
      res.write(`data: ${json(pricesPayload())}\n\n`);
      sseClients.add(res);
      req.on("close", () => sseClients.delete(res));
    } else if (url.pathname === "/candles") {
      // A venue with no candle history for a market is an empty chart, not an error.
      const rows = await candles(Number(url.searchParams.get("market")), url.searchParams.get("interval") ?? "1m").catch(() => []);
      res.statusCode = rows ? 200 : 404;
      res.setHeader("Content-Type", "application/json");
      res.end(json(rows ?? { error: "unknown market" }));
    } else if (url.pathname === "/history") {
      res.setHeader("Content-Type", "application/json");
      res.end(json(history.get(Number(url.searchParams.get("market"))) ?? []));
    } else if (url.pathname === "/summary") {
      res.setHeader("Content-Type", "application/json");
      res.end(json({ summary: await summary(), sparks: sparks() }));
    } else if (url.pathname === "/drip") {
      res.setHeader("Content-Type", "application/json");
      res.end(json(await drip(url.searchParams.get("address") ?? "")));
    } else if (url.pathname === "/health") {
      res.setHeader("Content-Type", "application/json");
      res.end(json({ ok: true, network: NETWORK, keeper: keeperAddress, markets: signed.size, active: active() }));
    } else {
      res.statusCode = 404;
      res.end();
    }
  } catch (err) {
    res.statusCode = 502;
    res.end(json({ error: err.message }));
  }
}).listen(PORT, () => log(`keeper ${keeperAddress} on ${NETWORK}, http://localhost:${PORT}`));

// ---- main loop ----------------------------------------------------------------------------

await Promise.all([refreshHlDepth(), refreshGemini(), refreshChainSkew()]);
setInterval(refreshChainSkew, 5_000);
setInterval(refreshHlDepth, 10_000);
setInterval(refreshGemini, 4_000);
setInterval(checkResolutions, 60_000);

let ticks = 0;
setInterval(async () => {
  try {
    await signAll();
    const frame = `data: ${json(pricesPayload())}\n\n`;
    for (const client of sseClients) client.write(frame);
    await relay();
    if (++ticks % SWEEP_EVERY_TICKS === 0) await sweep();
  } catch (err) {
    log(`tick: ${err.message}`);
  }
}, TICK_MS);
