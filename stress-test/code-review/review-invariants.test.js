// Seeded random simulation of the whole venue, checked against the written rules after every step.
//
// One crypto market and two event markets (one with a hazard rate, Boost and a reaction time, so
// its leverage limit falls as expiry nears), three traders, a liquidator, an LP and stakers. Each
// step is drawn from: open, close, liquidate / force-close / collect, a price move (small steps
// and occasional jumps), a depth change, a time advance, a poke, an LP deposit or withdrawal, a
// stake. The run ends by resolving the event markets and settling every position.
//
// The test keeps its own statement of the rules (the `rules` object below, in the engine's integer
// arithmetic) and a shadow book of positions and fee indexes. After every step it asserts:
//   I1  vault cash >= marginHeld + reserved
//   I2  sum of open margins == marginHeld, sum of open reserves == reserved
//   I3  per market: open interest, units and borrowed units equal the sums over open positions
//   I4  no payout exceeds margin + reserve, and the vault never pays out more than that in total
//   I5  a position that closes with a non-positive result pays no crowding fee
//   I6  totalAssets() does not revert and equals cash - margin - the bounded mark of open positions
//   I7  the engine's stored positions and fee indexes equal the shadow book's
// and, on every trade:
//   - an open succeeds exactly when no rule forbids it, and is refused only for a rule that applies
//   - every payout, fee, liquidator reward and staker share equals the rule-derived figure
//   - the keeper-facing views (liquidatable / forceClosable / collectable, accrued charges, the
//     liquidation and win prices) agree with the rules and with what the calls then do
//   - the oracle's slow price and slow depth follow the exact exponential average
//
//   REVIEW_SEEDS=7,8 REVIEW_STEPS=1000 npx hardhat test test/review-invariants.test.js
//
// REVIEW_STRICT=1 adds two checks that the engine does not pass today (see the review notes):
//   S1  totalAssets() stays within 0.1% of the vault's value with each open position marked inside
//       its own bounds (no more than its reserve, no less than minus its margin)
//   S2  a forced close pays the owner about what the position is worth at the mid

const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");
const { deploy, marketConfig, usd, px } = require("./helpers");

const SEEDS = (process.env.REVIEW_SEEDS ?? "1,2,3").split(",").map(Number);
const STEPS = Number(process.env.REVIEW_STEPS ?? 300);
const STRICT = process.env.REVIEW_STRICT === "1";
const FULL_CHECK_EVERY = 20; // steps between complete re-reads of every stored position

const WAD = 10n ** 18n;
const BPS = 10_000n;
const UNIT = 10n ** 36n;
const HOUR = 3_600;
const DAY = 86_400;
const BTC = 1;
const EVA = 2; // event market with a hazard rate, Boost and a reaction time
const EVB = 3; // plain event market
const MARKETS = [BTC, EVA, EVB];
const SYMBOL = { [BTC]: "BTC", [EVA]: "EVA", [EVB]: "EVB" };
const KINDS = ["Close", "Liquidation", "ForceClose", "Settlement", "Collect"];
const KIND_OF = { close: "Close", liquidate: "Liquidation", forceClose: "ForceClose", collect: "Collect" };
const PRICE_DATA_TYPES = ["tuple(uint32 marketId,uint256 price,uint256 depthUsd,uint64 timestamp,bool resolved)[]", "bytes[]"];

const min = (a, b) => (a < b ? a : b);
const max = (a, b) => (a > b ? a : b);
const abs = (a) => (a < 0n ? -a : a);
const fmt = (v, dp = 6) => ethers.formatUnits(v, dp);

function isqrt(n) {
  if (n < 2n) return n;
  let x = 1n << BigInt((n.toString(2).length + 1) >> 1);
  for (;;) {
    const y = (x + n / x) >> 1n;
    if (y >= x) return x;
    x = y;
  }
}

/** Deterministic PRNG (mulberry32). */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---- the rules, restated ---------------------------------------------------------------------
// Amounts are USDC with 6 decimals, prices 1e18, all BigInt. Division truncates toward zero.

const rules = {
  EVENT_MIN_PRICE: WAD / 100n,
  EVENT_MAX_PRICE: (WAD * 99n) / 100n,
  EVENT_MIN_DISTANCE: (WAD * 2n) / 100n,
  MAX_ENTRY_LOSS_BPS: 3_000n,
  TAU_FLOOR: 3_600n,
  // Two places where this file follows the rules as they are written today. If the engine changes
  // there (both are discussed in the review notes), change these two lines with it:
  //   R11: unrealizedPnl() is the plain, uncapped sum over positions. Set to true if it starts
  //        bounding each side's mark by that side's margin and reserve.
  MARK_BOUNDED: false,
  //   R6:  a forced close is never refused for the state of the price. If it starts being refused
  //        while mid and slow disagree, name the error it reverts with here.
  FORCED_CLOSE_GUARD_ERRORS: [],

  /** R1: worse-of fill. */
  fill: (F, isBuy) => (isBuy ? max(F.mid, F.slow) : min(F.mid, F.slow)),
  /** R2: distance between mid and slow, in bps of price (points of 1.00 on an event market). */
  gapBps: (c, F) => (abs(F.mid - F.slow) * BPS) / (c.isEvent ? WAD : F.slow),
  /** R3: capacity per side. */
  sideCap: (c, F) => (min(F.depthUsd, F.slowDepth) * c.kappaBps) / BPS,
  /** R6: the price a side holds. An event short is a long on NO. */
  sidePrice: (isEvent, isLong, price) => (isEvent && !isLong ? WAD - price : price),
  units: (isEvent, isLong, amount, entry) => (amount * UNIT) / rules.sidePrice(isEvent, isLong, entry),
  pnl(isEvent, isLong, notional, entry, exit) {
    if (isLong) return (notional * (exit - entry)) / entry;
    if (isEvent) return (notional * (WAD - exit - (WAD - entry))) / (WAD - entry);
    return (notional * (entry - exit)) / entry;
  },
  /** R5: the most a position can win, locked at open. */
  reserve(c, isLong, boost, margin, notional, entry) {
    let natural = notional;
    if (c.isEvent) {
      const p0 = rules.sidePrice(true, isLong, entry);
      natural = ((boost ? notional : margin) * (WAD - p0)) / p0;
    }
    return min(margin * c.maxProfitMult, natural);
  },
  /** R6: min(p, 1-p) / (3 sqrt(p (1-p) h / tau)), whole numbers, floor 1x, 1x from expiry on. */
  timeLeverage(c, mid, ts) {
    if (!c.isEvent) return c.maxLeverage;
    if (BigInt(ts) >= c.expiry) return 1n;
    if (c.reactionSeconds === 0n) return c.maxLeverage;
    if (mid >= WAD) return 1n;
    const spread = (mid * (WAD - mid)) / WAD;
    if (spread === 0n) return 1n;
    const root = isqrt(((c.expiry - BigInt(ts)) * UNIT) / (c.reactionSeconds * spread));
    const lev = (min(mid, WAD - mid) * root) / (3n * 10n ** 9n * WAD);
    return max(1n, min(lev, c.maxLeverage));
  },
  /** R6: the most leverage a new position may take. Zero once an event has expired. */
  maxLeverage(c, F, ts) {
    if (!c.isEvent) return c.maxLeverage;
    if (BigInt(ts) >= c.expiry) return 0n;
    const tick = min(F.mid, WAD - F.mid) / rules.EVENT_MIN_DISTANCE;
    return max(1n, min(c.maxLeverage, min(tick, rules.timeLeverage(c, F.mid, ts))));
  },
  /** R8, R9: growth of (crowding long, crowding short, boost long, boost short) over dt seconds ending at ts. */
  deltas(c, s, F, dt, ts) {
    const zero = [0n, 0n, 0n, 0n];
    if (dt === 0n || F.timestamp === 0n || F.resolved) return zero;
    if (!c.isEvent) {
      const cap = rules.sideCap(c, F);
      if (cap === 0n || c.crowdingPerDay === 0n || s.longOI === s.shortOI) return zero;
      const skew = min(WAD, (abs(s.longOI - s.shortOI) * WAD) / cap);
      const grown = (skew * c.crowdingPerDay * dt) / (BigInt(DAY) * WAD);
      return s.longOI > s.shortOI ? [grown, 0n, 0n, 0n] : [0n, grown, 0n, 0n];
    }
    if (c.hazardScale === 0n) return zero;
    const left = BigInt(ts) < c.expiry ? c.expiry - BigInt(ts) : 0n;
    const tau = max(rules.TAU_FLOOR, left + dt / 2n); // midpoint of the interval
    const mid = min(F.mid, WAD);
    // The implied hazard, p (1 - p) / tau per borrowed share per second: the same for YES and NO.
    const boost = (((mid * (WAD - mid)) / WAD) * c.hazardScale * dt) / (tau * WAD);
    let feeLong = 0n;
    let feeShort = 0n;
    if (s.longBorrowed > s.shortBorrowed) feeLong = (boost * (s.longBorrowed - s.shortBorrowed)) / s.longBorrowed;
    if (s.shortBorrowed > s.longBorrowed) feeShort = (boost * (s.shortBorrowed - s.longBorrowed)) / s.shortBorrowed;
    return [feeLong, feeShort, boost, boost];
  },
  /** What a position owes against its side's indexes: a boosted position the premium, any other the crowding fee. */
  charges(p, isEvent, cumFee, cumBoost) {
    if (!isEvent) return { crowding: (p.notional * (cumFee - p.entryFee)) / WAD, premium: 0n };
    if (p.boosted) return { crowding: 0n, premium: (p.borrowedUnits * (cumBoost - p.entryBoost)) / UNIT };
    return { crowding: (p.borrowedUnits * (cumFee - p.entryFee)) / UNIT, premium: 0n };
  },
  /** R10: price P&L capped at the reserve, less the boost premium, floored at minus the margin. */
  result(p, isEvent, price, premium) {
    const r = min(rules.pnl(isEvent, p.isLong, p.notional, p.entryPrice, price), p.reserve) - premium;
    return max(r, -p.margin);
  },
  /** R4, R10: everything that is paid when a position closes at `exit`. */
  settle(p, c, charges, exit, kind, G, anyoneStaked) {
    const pricePnl = rules.pnl(c.isEvent, p.isLong, p.notional, p.entryPrice, exit);
    const result = rules.result(p, c.isEvent, exit, charges.premium);
    let crowding = 0n;
    let fee = 0n;
    let payout = p.margin + result;
    if (result > 0n) {
      crowding = min(charges.crowding, result);
      fee = ((result - crowding) * c.profitFeeBps) / BPS;
      payout = p.margin + result - crowding - fee;
    }
    let liqFee = 0n;
    if (kind === "Liquidation") {
      liqFee = min((p.margin * G.liqFeeBps) / BPS, payout);
      payout -= liqFee;
    }
    const stakerFee = anyoneStaked ? (fee * G.stakerShareBps) / BPS : 0n;
    return { pricePnl, result, crowding, premium: charges.premium, fee, payout, liqFee, stakerFee };
  },
};

const normConfig = (c) => ({
  enabled: c.enabled,
  isEvent: c.isEvent,
  boostEnabled: c.boostEnabled,
  maxLeverage: BigInt(c.maxLeverage),
  maxProfitMult: BigInt(c.maxProfitMult),
  profitFeeBps: BigInt(c.profitFeeBps),
  kappaBps: BigInt(c.kappaBps),
  maxGapBps: BigInt(c.maxGapBps),
  maxAge: BigInt(c.maxAge),
  reactionSeconds: BigInt(c.reactionSeconds),
  expiry: BigInt(c.expiry),
  maxPositionNotional: BigInt(c.maxPositionNotional),
  crowdingPerDay: BigInt(c.crowdingPerDay),
  hazardScale: BigInt(c.hazardScale),
});
const FEED_FIELDS = ["mid", "slow", "depthUsd", "slowDepth", "timestamp", "resolved"];
const TOTAL_FIELDS = ["longOI", "shortOI", "longUnits", "shortUnits", "longBorrowed", "shortBorrowed"];
const STATE_FIELDS = [...TOTAL_FIELDS, "cumFeeLong", "cumFeeShort", "cumBoostLong", "cumBoostShort", "lastAccrual"];
const POSITION_FIELDS = [
  "owner",
  "marketId",
  "isLong",
  "boosted",
  "openedAt",
  "margin",
  "notional",
  "entryPrice",
  "reserve",
  "borrowedUnits",
  "entryFee",
  "entryBoost",
];
const fields = (names) => (x) => Object.fromEntries(names.map((k) => [k, x[k]]));
const normFeed = fields(FEED_FIELDS);
const normState = fields(STATE_FIELDS);
const normPosition = (p) => ({ ...fields(POSITION_FIELDS)(p), marketId: Number(p.marketId) });

// ---- the simulation ----------------------------------------------------------------------------

async function simulate({ seed, steps }) {
  const rand = mulberry32(seed);
  const chance = (p) => rand() < p;
  const pick = (xs) => xs[Math.floor(rand() * xs.length)];
  const between = (lo, hi) => lo + (hi - lo) * rand();
  const intBetween = (lo, hi) => lo + Math.floor(rand() * (hi - lo + 1));

  const ctx = await deploy();
  const { lp, alice, bob, carol, liquidator, usdc, oracle, vault, token, staking, engine, sign } = ctx;
  const traders = [alice, bob, carol];
  const signerOf = new Map(traders.map((t) => [t.address, t]));
  const nameOf = new Map([
    [alice.address, "alice"],
    [bob.address, "bob"],
    [carol.address, "carol"],
  ]);
  const everyone = [vault.target, staking.target, lp.address, liquidator.address, ...traders.map((t) => t.address)];
  const coder = ethers.AbiCoder.defaultAbiCoder();

  // ---- bookkeeping ----
  let step = 0;
  let label = "setup";
  let now = 0;
  const violations = [];
  const violation = (kind, detail) => violations.push({ seed, step, action: label, kind, detail });
  const stats = {
    opens: 0,
    boosted: 0,
    closes: Object.fromEntries(KINDS.map((k) => [k, 0])),
    refused: {},
    crowdingPaid: 0n,
    crowdingCharged: 0,
    crowdingWaived: 0,
    premiumPaid: 0n,
    premiumCharged: 0,
    profitFees: 0n,
    stakerFees: 0n,
    liquidatorFees: 0n,
    capped: 0,
    wiped: 0,
    relays: 0,
    bundles: 0,
    pokes: 0,
    lpMoves: 0,
    viewsChecked: 0,
    maxOpen: 0,
    navGap: { usd: 0n, step: 0, nav: 0n },
    forcedLoss: { usd: 0n, step: 0 },
    simulatedHours: 0,
  };
  const refuse = (what, reason) => {
    const key = `${what}:${reason}`;
    stats.refused[key] = (stats.refused[key] ?? 0) + 1;
  };

  function errName(e) {
    const data = e?.data ?? e?.error?.data ?? e?.info?.error?.data;
    if (typeof data === "string" && data.length >= 10) {
      for (const c of [engine, vault, oracle, usdc]) {
        try {
          const parsed = c.interface.parseError(data);
          if (parsed) return parsed.name;
        } catch {
          /* not this contract's error */
        }
      }
    }
    return "UNKNOWN: " + String(e?.shortMessage ?? e?.message ?? e).slice(0, 200);
  }
  const tryCall = async (fn) => {
    try {
      return { ok: true, value: await fn() };
    } catch (e) {
      return { ok: false, error: errName(e) };
    }
  };
  /** Mine `fn`'s transaction in a block stamped `ts`. Every block in a run is stamped explicitly. */
  async function mine(ts, fn) {
    await time.setNextBlockTimestamp(ts);
    try {
      const tx = await fn();
      return await tx.wait();
    } finally {
      now = await time.latest();
    }
  }
  const parseLogs = (rc, name) =>
    rc.logs
      .filter((l) => l.address === engine.target)
      .map((l) => engine.interface.parseLog(l))
      .filter((l) => l && l.name === name);

  // ---- markets ----
  await oracle.setTau(EVB, 300);
  const t0 = await time.latest();
  const G = {
    maintBps: await engine.maintBps(),
    liqFeeBps: await engine.liqFeeBps(),
    stakerShareBps: await engine.stakerShareBps(),
    minMargin: await engine.minMargin(),
  };
  const tauOf = {};
  const cfg = {};
  const raw = {
    [BTC]: marketConfig({ crowdingPerDay: px("0.02") }),
    [EVA]: marketConfig({
      isEvent: true,
      boostEnabled: true,
      maxLeverage: 50,
      profitFeeBps: 1000,
      maxGapBps: 500,
      reactionSeconds: 120,
      // Some runs go past this expiry, some come close to it, some stay far from it.
      expiry: t0 + [12, 24, 60][seed % 3] * HOUR,
      maxPositionNotional: usd(1_000_000),
      hazardScale: px(1),
    }),
    [EVB]: marketConfig({
      isEvent: true,
      maxLeverage: 50,
      profitFeeBps: 1000,
      maxGapBps: 500,
      expiry: t0 + 30 * DAY,
      maxPositionNotional: usd(1_000_000),
      hazardScale: seed % 2 ? px("0.5") : 0n,
    }),
  };
  const st = {}; // shadow of engine.states
  for (const m of MARKETS) {
    await engine.setMarket(m, raw[m]);
    cfg[m] = normConfig(raw[m]);
    tauOf[m] = Number(await oracle.tau(m));
    st[m] = normState(await engine.states(m));
  }
  await vault.connect(lp).deposit(usd(5_000_000), lp.address);
  const totalUsdc = async () => (await Promise.all(everyone.map((a) => usdc.balanceOf(a)))).reduce((a, b) => a + b, 0n);
  const usdcAtStart = await totalUsdc();

  const pos = new Map(); // shadow of the open positions, by id
  let vaultNow = { cash: 0n, marginHeld: 0n, reserved: 0n }; // as of the last invariant check
  const truth = {
    [BTC]: { price: 60_000, depth: 20_000_000, baseDepth: 20_000_000 },
    [EVA]: { price: Math.round(between(0.3, 0.7) * 100) / 100, depth: 2_000_000, baseDepth: 2_000_000 },
    [EVB]: { price: Math.round(between(0.15, 0.85) * 100) / 100, depth: 2_000_000, baseDepth: 2_000_000 },
  };
  const resolved = new Set();
  const wadPrice = (m) => px(truth[m].price.toFixed(m === BTC ? 2 : 4));

  // ---- oracle ----
  const feedLatest = async (m) => normFeed(await oracle.read(m));
  const feedPending = async (m) => normFeed(await oracle.read(m, { blockTag: "pending" }));
  const stale = (F, ts, c) => F.timestamp === 0n || BigInt(ts) > F.timestamp + c.maxAge;

  async function signUpdate(m, ts, over = {}) {
    const { update, sig } = await sign(
      m,
      over.price ?? wadPrice(m),
      over.depth ?? usd(Math.round(truth[m].depth)),
      ts,
      over.resolved ?? false
    );
    return { update, sig, data: coder.encode(PRICE_DATA_TYPES, [[update], [sig]]) };
  }
  /** What the oracle holds after applying `u` in the block the feed `F` was read for. */
  function overlay(m, F, u) {
    if (!u || F.resolved || BigInt(u.timestamp) <= F.timestamp) return F; // skipped, not reverted
    const reset = F.timestamp === 0n || u.resolved || tauOf[m] === 0;
    return {
      mid: u.price,
      slow: reset ? u.price : F.slow,
      depthUsd: u.depthUsd,
      slowDepth: reset ? u.depthUsd : F.slowDepth,
      timestamp: BigInt(u.timestamp),
      resolved: u.resolved,
    };
  }
  /** The keeper relays the current reference price in its own block. Checks R1 on the way. */
  async function relay(m, dt = 1, over = {}) {
    const before = await feedLatest(m); // slow already advanced to `now`
    const ts = now + dt;
    const u = await signUpdate(m, ts, over);
    await mine(ts, () => oracle.push([u.update], [u.sig]));
    stats.relays++;
    const after = await feedLatest(m);
    if (before.resolved) {
      if (FEED_FIELDS.some((k) => after[k] !== before[k])) {
        violation("R1 resolved feed changed", `${SYMBOL[m]} accepted an update after resolution`);
      }
      return after;
    }
    if (after.mid !== u.update.price || after.depthUsd !== u.update.depthUsd || after.timestamp !== BigInt(ts)) {
      violation("R1 mid not stored", `${SYMBOL[m]} mid ${after.mid} depth ${after.depthUsd} ts ${after.timestamp}`);
    }
    if (u.update.resolved || before.timestamp === 0n || tauOf[m] === 0) {
      if (after.slow !== u.update.price || after.slowDepth !== u.update.depthUsd) {
        violation("R1 slow at reset", `${SYMBOL[m]} slow ${after.slow}`);
      }
      return after;
    }
    // Exact exponential: since the read above, the old mid was held for `dt` more seconds, however
    // many updates and reads came before.
    const decay = Math.exp(-dt / tauOf[m]);
    for (const [avg, held, got, what] of [
      [before.slow, before.mid, after.slow, "slow"],
      [before.slowDepth, before.depthUsd, after.slowDepth, "slowDepth"],
    ]) {
      const gap = Number(avg - held);
      const want = Number(held) + gap * decay;
      if (Math.abs(Number(got) - want) > Math.abs(gap) * 1e-9 + Math.abs(want) * 1e-12 + 4) {
        violation("R1 exponential average", `${SYMBOL[m]} ${what} ${got} expected ${want} after ${dt}s`);
      }
      if (got < min(avg, held) || got > max(avg, held)) {
        violation("R1 average left its range", `${SYMBOL[m]} ${what} ${got} outside [${avg}, ${held}]`);
      }
    }
    return after;
  }

  function move(m, big) {
    const t = truth[m];
    if (m === BTC) {
      const r = big ? (chance(0.5) ? -1 : 1) * between(0.003, 0.03) : between(-0.0006, 0.0006);
      t.price = Math.max(1_000, Math.round(t.price * (1 + r) * 100) / 100);
      return;
    }
    let p = t.price;
    const edge = big && chance(0.12);
    if (edge) p = pick([0, 0.001, 0.005, 0.995, 0.999, 1]);
    else if (big) p += (chance(0.5) ? -1 : 1) * between(0.05, 0.4);
    else p += between(-0.015, 0.015);
    if (!edge) p = Math.min(0.995, Math.max(0.005, p));
    t.price = Math.round(p * 1e4) / 1e4;
  }

  // ---- shadow book ----
  function accrue(m, F, ts) {
    const s = st[m];
    const dt = BigInt(ts) - s.lastAccrual;
    if (dt === 0n) return;
    const d = rules.deltas(cfg[m], s, F, dt, ts);
    s.cumFeeLong += d[0];
    s.cumFeeShort += d[1];
    s.cumBoostLong += d[2];
    s.cumBoostShort += d[3];
    s.lastAccrual = BigInt(ts);
  }
  /** A position's charges as they would stand if the market were brought up to date at `ts`. */
  function chargesAt(p, F, ts) {
    const c = cfg[p.marketId];
    const s = st[p.marketId];
    const d = rules.deltas(c, s, F, BigInt(ts) - s.lastAccrual, ts);
    return rules.charges(
      p,
      c.isEvent,
      p.isLong ? s.cumFeeLong + d[0] : s.cumFeeShort + d[1],
      p.isLong ? s.cumBoostLong + d[2] : s.cumBoostShort + d[3]
    );
  }
  /** What the rules say about a position at `ts` under feed `F`. */
  function assess(p, F, ts) {
    const c = cfg[p.marketId];
    const ch = chargesAt(p, F, ts);
    const mark = F.resolved ? F.mid : rules.fill(F, !p.isLong);
    const equityAtMid = p.margin + rules.result(p, c.isEvent, F.mid, ch.premium);
    return {
      ...ch,
      mark,
      pnl: rules.result(p, c.isEvent, mark, ch.premium),
      equityAtMid,
      liquidatable: !F.resolved && equityAtMid <= (p.margin * G.maintBps) / BPS,
      forceClosable: !F.resolved && c.isEvent && p.notional > p.margin * rules.timeLeverage(c, F.mid, ts),
      collectable: !F.resolved && rules.pnl(c.isEvent, p.isLong, p.notional, p.entryPrice, mark) >= p.reserve,
    };
  }
  function addToBook(id, p) {
    const s = st[p.marketId];
    const u = rules.units(cfg[p.marketId].isEvent, p.isLong, p.notional, p.entryPrice);
    s[p.isLong ? "longOI" : "shortOI"] += p.notional;
    s[p.isLong ? "longUnits" : "shortUnits"] += u;
    s[p.isLong ? "longBorrowed" : "shortBorrowed"] += p.borrowedUnits;
    pos.set(id, p);
  }
  function removeFromBook(id) {
    const p = pos.get(id);
    const s = st[p.marketId];
    const u = rules.units(cfg[p.marketId].isEvent, p.isLong, p.notional, p.entryPrice);
    s[p.isLong ? "longOI" : "shortOI"] -= p.notional;
    s[p.isLong ? "longUnits" : "shortUnits"] -= u;
    s[p.isLong ? "longBorrowed" : "shortBorrowed"] -= p.borrowedUnits;
    pos.delete(id);
  }

  // ---- invariants, after every step ----
  // Every step re-reads the vault, the engine's totals and indexes and the oracle. Positions never
  // change once stored, so each is compared with the rules when it opens and checked gone when it
  // closes; every FULL_CHECK_EVERY steps (`full`) all of them are re-read through the keeper's view.
  async function checkInvariants(full = false) {
    const guard = (p) => p.catch((e) => new Error(errName(e)));
    const [cash, marginHeld, reserved, totalAssets, unrealized, count, marketCount, views, all, ...rest] = await Promise.all([
      usdc.balanceOf(vault.target),
      vault.marginHeld(),
      vault.reserved(),
      guard(vault.totalAssets()),
      guard(engine.unrealizedPnl()),
      engine.openPositionCount(),
      engine.marketCount(),
      full ? guard(engine.openPositions(0, 100_000)) : null,
      full ? guard(engine.allMarkets()) : null,
      ...MARKETS.map((m) => engine.states(m)),
      ...MARKETS.map((m) => oracle.read(m)),
    ]);
    const states = Object.fromEntries(MARKETS.map((m, i) => [m, normState(rest[i])]));
    const feeds = Object.fromEntries(MARKETS.map((m, i) => [m, normFeed(rest[MARKETS.length + i])]));
    vaultNow = { cash, marginHeld, reserved };

    // I1
    if (cash < marginHeld + reserved) {
      violation("I1 cash < marginHeld + reserved", `cash ${fmt(cash)} margin ${fmt(marginHeld)} reserved ${fmt(reserved)}`);
    }
    // I6 (first half)
    if (totalAssets instanceof Error) violation("I6 totalAssets() reverted", totalAssets.message);
    if (unrealized instanceof Error) violation("I6 unrealizedPnl() reverted", unrealized.message);
    if (marketCount !== BigInt(MARKETS.length)) violation("market registry", `marketCount ${marketCount}`);
    if (all instanceof Error) violation("view allMarkets() reverted", all.message);
    else if (all && all.some((v, i) => Number(v.marketId) !== MARKETS[i])) violation("market registry", "allMarkets()");

    // I7: the engine's open positions are the shadow book's.
    if (count !== BigInt(pos.size)) violation("I7 open position count", `engine ${count}, book ${pos.size}`);
    if (views instanceof Error) violation("view openPositions() reverted", views.message);
    else if (views) {
      if (views.length !== pos.size) violation("I7 open position count", `views ${views.length}, book ${pos.size}`);
      const seen = new Set();
      for (const v of views) {
        const onChain = normPosition(v.position);
        const mine = pos.get(v.id);
        seen.add(v.id);
        const diff = mine ? POSITION_FIELDS.filter((k) => mine[k] !== onChain[k]) : ["(not in the book)"];
        if (diff.length) {
          violation("I7 stored position differs from the book", `#${v.id} ${diff}`);
          pos.set(v.id, onChain); // adopt the chain's position; the checks below report what follows from it
        }
      }
      for (const id of [...pos.keys()]) {
        if (seen.has(id)) continue;
        violation("I7 position missing on chain", `#${id}`);
        pos.delete(id);
      }
    }

    const sums = Object.fromEntries(MARKETS.map((m) => [m, Object.fromEntries(TOTAL_FIELDS.map((k) => [k, 0n]))]));
    let sumMargin = 0n;
    let sumReserve = 0n;
    let markUncapped = 0n;
    let markCapped = 0n;
    for (const [id, p] of pos) {
      const c = cfg[p.marketId];
      const s = sums[p.marketId];
      const u = rules.units(c.isEvent, p.isLong, p.notional, p.entryPrice);
      const borrowed = c.isEvent ? u - rules.units(true, p.isLong, p.margin, p.entryPrice) : 0n;
      if (borrowed !== p.borrowedUnits) violation("I3 borrowed units", `#${id} stored ${p.borrowedUnits} expected ${borrowed}`);
      s[p.isLong ? "longOI" : "shortOI"] += p.notional;
      s[p.isLong ? "longUnits" : "shortUnits"] += u;
      s[p.isLong ? "longBorrowed" : "shortBorrowed"] += p.borrowedUnits;
      sumMargin += p.margin;
      sumReserve += p.reserve;
      const atMid = rules.pnl(c.isEvent, p.isLong, p.notional, p.entryPrice, feeds[p.marketId].mid);
      markUncapped += atMid;
      markCapped += max(-p.margin, min(p.reserve, atMid));
    }
    // I2
    if (sumMargin !== marginHeld) violation("I2 sum of margins != marginHeld", `${fmt(sumMargin)} vs ${fmt(marginHeld)}`);
    if (sumReserve !== reserved) violation("I2 sum of reserves != reserved", `${fmt(sumReserve)} vs ${fmt(reserved)}`);
    // I3, and I7 for the fee indexes
    for (const m of MARKETS) {
      for (const k of TOTAL_FIELDS) {
        if (sums[m][k] !== states[m][k]) {
          violation(`I3 ${k} != sum over open positions`, `${SYMBOL[m]} state ${states[m][k]} sum ${sums[m][k]}`);
        }
      }
      const diff = STATE_FIELDS.filter((k) => st[m][k] !== states[m][k]);
      if (diff.length) {
        violation(
          "I7 market state differs from the rules",
          `${SYMBOL[m]} ` + diff.map((k) => `${k}: engine ${states[m][k]} rules ${st[m][k]}`).join("; ")
        );
        st[m] = states[m];
      }
    }
    // I6 (second half): the share price marks open positions at the oracle, bounded by reserved and marginHeld.
    if (!(totalAssets instanceof Error) && !(unrealized instanceof Error)) {
      const owed = max(-marginHeld, min(reserved, unrealized));
      const nav = max(0n, cash - marginHeld - owed);
      if (totalAssets !== nav) violation("I6 totalAssets formula", `${fmt(totalAssets)} vs ${fmt(nav)}`);
      const slack = BigInt(pos.size) + 2n; // rounding: under a micro-dollar per position
      const offSum = abs(unrealized - markUncapped) > slack;
      const offBand = unrealized < min(markCapped, markUncapped) - slack || unrealized > max(markCapped, markUncapped) + slack;
      if (rules.MARK_BOUNDED ? offBand : offSum) {
        violation(
          "I6 aggregate mark != sum of position marks",
          `${fmt(unrealized)} vs ${fmt(markUncapped)} uncapped, ${fmt(markCapped)} with each position inside its bounds`
        );
      }
      // Reported, not asserted: how far the aggregate mark is from marking each position within its own bounds.
      const perPosition = max(0n, cash - marginHeld - markCapped);
      if (abs(totalAssets - perPosition) > abs(stats.navGap.usd)) {
        stats.navGap = { usd: totalAssets - perPosition, step, nav: perPosition };
      }
    }
    stats.maxOpen = Math.max(stats.maxOpen, pos.size);
  }

  // ---- trades ----
  /** How a trade gets its price: bundled with the call, relayed just before it, or whatever is on chain. */
  async function priceFor(m, ts) {
    const mode = rand();
    if (resolved.has(m) || mode < 0.15) return null;
    if (mode < 0.6) {
      if (chance(0.5)) move(m, false);
      stats.bundles++;
      // Now and then the bundled update is no newer than the on-chain one: the oracle must skip it.
      const held = (await feedLatest(m)).timestamp;
      if (held > 0n && chance(0.06)) return signUpdate(m, Number(held) - intBetween(0, 5), { price: wadPrice(m) / 2n });
      return signUpdate(m, ts);
    }
    return "relay";
  }

  /** Every rule that forbids this open. Empty means it must be accepted. */
  function openBlockers(c, F, ts, s, o) {
    const out = new Set();
    if (F.resolved) out.add("MarketResolved");
    if (stale(F, ts, c)) out.add("StalePrice");
    if (c.isEvent && (F.mid < rules.EVENT_MIN_PRICE || F.mid > rules.EVENT_MAX_PRICE)) out.add("EventPriceOutOfRange");
    if (F.timestamp !== 0n && (c.isEvent || F.slow > 0n) && rules.gapBps(c, F) > c.maxGapBps) out.add("PriceDislocated");
    if (o.margin < G.minMargin) out.add("BadMargin");
    if (o.leverage === 0n || o.leverage > rules.maxLeverage(c, F, ts)) out.add("BadLeverage");
    if (o.boost && !c.boostEnabled) out.add("BoostUnavailable");
    const notional = o.margin * o.leverage;
    if (notional > c.maxPositionNotional) out.add("PositionTooLarge");
    if ((o.isLong ? s.longOI : s.shortOI) + notional > rules.sideCap(c, F)) out.add("SideCapExceeded");
    const entry = rules.fill(F, o.isLong);
    if (rules.sidePrice(c.isEvent, o.isLong, entry) > 0n) {
      if (-rules.pnl(c.isEvent, o.isLong, notional, entry, F.mid) > (o.margin * rules.MAX_ENTRY_LOSS_BPS) / BPS) {
        out.add("EntryTooFarFromMid");
      }
      const reserve = rules.reserve(c, o.isLong, o.boost, o.margin, notional, entry);
      if (vaultNow.cash < vaultNow.marginHeld + vaultNow.reserved + reserve) out.add("InsufficientLiquidity");
    }
    return out;
  }

  async function stepOpen() {
    const m = pick([BTC, BTC, BTC, EVA, EVA, EVA, EVB, EVB]);
    const c = cfg[m];
    const trader = pick(traders);
    const isLong = chance(0.5);
    let ts = now + 1;
    let quote = await priceFor(m, ts);
    if (quote === "relay") {
      await relay(m);
      quote = null;
      ts = now + 1;
    }
    await time.setNextBlockTimestamp(ts);
    const F = overlay(m, await feedPending(m), quote?.update);
    const limit = rules.maxLeverage(c, F, ts);

    // The view the app reads its leverage limit and capacity from.
    if (!quote && chance(0.5)) {
      const mv = await tryCall(() => engine.marketView(m, { blockTag: "pending" }));
      if (!mv.ok) violation("view marketView() reverted", `${SYMBOL[m]} ${mv.error}`);
      else {
        const shown = F.resolved || F.timestamp === 0n ? 0n : limit;
        if (mv.value.maxLeverageLong !== shown || mv.value.maxLeverageShort !== shown) {
          violation("R6 marketView leverage", `${SYMBOL[m]} view ${mv.value.maxLeverageLong} rules ${shown}`);
        }
        if (mv.value.sideCap !== rules.sideCap(c, F)) violation("R3 marketView capacity", `${SYMBOL[m]}`);
      }
    }
    // R6 against the formula in floating point: min(p, 1-p) / (3 sqrt(p (1-p) h / tau)).
    if (c.isEvent && c.reactionSeconds > 0n && BigInt(ts) < c.expiry && F.mid > 0n && F.mid < WAD) {
      const p = Number(F.mid) / 1e18;
      const real = Math.min(p, 1 - p) / (3 * Math.sqrt((p * (1 - p) * Number(c.reactionSeconds)) / (Number(c.expiry) - ts)));
      const want = Math.max(1, Math.min(Number(c.maxLeverage), Math.floor(real)));
      const got = Number(rules.timeLeverage(c, F.mid, ts));
      if (got !== want && Math.abs(real - Math.round(real)) > 1e-6) violation("R6 time leverage", `${got} vs ${real}`);
    }

    const cap = Number(limit > 0n ? limit : 1n);
    const lr = rand();
    let leverage = lr < 0.22 ? 1 : lr < 0.6 ? intBetween(1, cap) : lr < 0.9 ? cap : lr < 0.99 ? cap + 1 : 0;
    if (m === BTC && lr >= 0.22 && lr < 0.6) leverage = pick([2, 3, 5, 10, 25, 50, 100, 250, 500, 750, 1000]);
    const sr = rand();
    const dollars = sr < 0.02 ? between(0.1, 0.99) : sr < 0.06 ? between(100_000, 600_000) : 10 ** between(1, 3.9);
    const o = {
      isLong,
      margin: BigInt(Math.floor(dollars * 1e6)),
      leverage: BigInt(leverage),
      boost: c.boostEnabled ? chance(0.5) : chance(0.05),
    };
    label = `open ${SYMBOL[m]} ${isLong ? "long" : "short"} ${fmt(o.margin)} x${leverage}${o.boost ? " boost" : ""} by ${nameOf.get(trader.address)}`;

    const blockers = openBlockers(c, F, ts, st[m], o);
    const data = quote?.data ?? "0x";
    const dry = await tryCall(() =>
      engine.connect(trader).open.staticCall(m, o.isLong, o.margin, o.leverage, o.boost, data, { blockTag: "pending" })
    );
    if (!dry.ok) {
      refuse("open", dry.error);
      if (!blockers.has(dry.error)) {
        violation(
          "open refused although no rule forbids it",
          `${dry.error}; rules give {${[...blockers]}} mid ${F.mid} slow ${F.slow} limit ${limit}`
        );
      }
      return;
    }
    if (blockers.size) violation("open accepted although a rule forbids it", `{${[...blockers]}} mid ${F.mid} slow ${F.slow}`);

    const id = dry.value;
    const traderBefore = await usdc.balanceOf(trader.address);
    const rc = await mine(ts, () => engine.connect(trader).open(m, o.isLong, o.margin, o.leverage, o.boost, data));
    accrue(m, F, ts);
    const s = st[m];
    const entry = rules.fill(F, o.isLong);
    const notional = o.margin * o.leverage;
    const borrowed = c.isEvent
      ? rules.units(true, o.isLong, notional, entry) - rules.units(true, o.isLong, o.margin, entry)
      : 0n;
    const want = {
      owner: trader.address,
      marketId: m,
      isLong: o.isLong,
      boosted: o.boost,
      openedAt: BigInt(ts),
      margin: o.margin,
      notional,
      entryPrice: entry,
      reserve: rules.reserve(c, o.isLong, o.boost, o.margin, notional, entry),
      borrowedUnits: borrowed,
      entryFee: o.isLong ? s.cumFeeLong : s.cumFeeShort,
      entryBoost: o.isLong ? s.cumBoostLong : s.cumBoostShort,
    };
    const [stored, traderAfter] = await Promise.all([engine.positions(id), usdc.balanceOf(trader.address)]);
    const got = normPosition(stored);
    const diff = POSITION_FIELDS.filter((k) => want[k] !== got[k]);
    if (diff.length) {
      violation(
        "R1/R5 stored position differs from the rules",
        `#${id} ` + diff.map((k) => `${k}: engine ${got[k]} rules ${want[k]}`).join("; ")
      );
    }
    addToBook(id, diff.length ? got : want);
    stats.opens++;
    if (o.boost) stats.boosted++;

    const [ev] = parseLogs(rc, "PositionOpened");
    if (!ev || ev.args.id !== id || ev.args.entryPrice !== want.entryPrice || ev.args.reserve !== want.reserve) {
      violation("open event", `id ${ev?.args.id} entry ${ev?.args.entryPrice} reserve ${ev?.args.reserve}`);
    }
    if (traderBefore - traderAfter !== o.margin) violation("open took something other than the margin", fmt(traderBefore - traderAfter));
    // R3 as a post-condition on the stored market.
    if ((o.isLong ? s.longOI : s.shortOI) > rules.sideCap(c, F)) violation("R3 open interest above capacity", SYMBOL[m]);
  }

  /** Every rule that forbids this call. Empty means it must go through. */
  function actionBlockers(action, p, F, ts, byOwner, a) {
    const out = new Set();
    const c = cfg[p.marketId];
    if (action === "close") {
      if (F.resolved) return out; // anyone may settle after resolution
      if (!byOwner) out.add("NotOwner");
      if (stale(F, ts, c)) out.add("StalePrice");
      return out;
    }
    if (F.resolved) out.add("MarketResolved");
    if (stale(F, ts, c)) out.add("StalePrice");
    if (action === "liquidate" && !a.liquidatable) out.add("NotLiquidatable");
    if (action === "forceClose" && !a.forceClosable) out.add("NotForceClosable");
    if (action === "collect" && !a.collectable) out.add("NotCollectable");
    return out;
  }

  /** Try one of close / liquidate / forceClose / collect on a position and check everything it pays. */
  async function act(action, id, caller, quote, ts = now + 1) {
    const p = pos.get(id);
    const m = p.marketId;
    const c = cfg[m];
    const byOwner = caller.address === p.owner;
    await time.setNextBlockTimestamp(ts);
    const F = overlay(m, await feedPending(m), quote?.update);
    const a = assess(p, F, ts);
    const blockers = actionBlockers(action, p, F, ts, byOwner, a);
    const data = quote?.data ?? "0x";
    label =
      `${action} #${id} (${SYMBOL[m]} ${p.isLong ? "long" : "short"} x${p.notional / p.margin}` +
      `${p.boosted ? " boost" : ""}) by ${byOwner ? "owner" : "third party"}`;

    const dry = await tryCall(() => engine.connect(caller)[action].staticCall(id, data, { blockTag: "pending" }));
    if (!dry.ok) {
      refuse(action, dry.error);
      const guarded =
        action === "forceClose" && rules.fill(F, !p.isLong) !== F.mid && rules.FORCED_CLOSE_GUARD_ERRORS.includes(dry.error);
      if (!blockers.has(dry.error) && !guarded) {
        violation(`${action} refused although the rules allow it`, `${dry.error}; rules give {${[...blockers]}}`);
      }
      return false;
    }
    if (blockers.size) violation(`${action} accepted although the rules forbid it`, `{${[...blockers]}}`);

    const kind = action === "close" && F.resolved ? "Settlement" : KIND_OF[action];
    const watched = [p.owner, vault.target, staking.target, caller.address];
    const balances = () => Promise.all(watched.map((x) => usdc.balanceOf(x)));
    const [before, totalStaked] = await Promise.all([balances(), staking.totalStaked()]);
    const rc = await mine(ts, () => engine.connect(caller)[action](id, data));
    const [after, gone] = await Promise.all([balances(), engine.positions(id)]);
    const toOwner = after[0] - before[0];
    const fromVault = before[1] - after[1];
    const toStaking = after[2] - before[2];
    const toCaller = byOwner ? 0n : after[3] - before[3];

    accrue(m, F, ts);
    const s = st[m];
    const ch = rules.charges(p, c.isEvent, p.isLong ? s.cumFeeLong : s.cumFeeShort, p.isLong ? s.cumBoostLong : s.cumBoostShort);
    const exit = kind === "Liquidation" || kind === "Settlement" ? F.mid : rules.fill(F, !p.isLong);
    const want = rules.settle(p, c, ch, exit, kind, G, totalStaked > 0n);
    removeFromBook(id);
    if (gone.owner !== ethers.ZeroAddress) violation("I7 closed position still stored", `#${id}`);

    const tag = `#${id} ${kind} exit ${fmt(exit, 18)} margin ${fmt(p.margin)} reserve ${fmt(p.reserve)} pricePnl ${fmt(want.pricePnl)}`;
    // I4
    if (toOwner > p.margin + p.reserve) violation("I4 payout above margin + reserve", `${tag} paid ${fmt(toOwner)}`);
    if (fromVault > p.margin + p.reserve) violation("I4 vault paid out more than margin + reserve", `${tag} out ${fmt(fromVault)}`);
    if (fromVault !== toOwner + toStaking + toCaller) violation("I4 vault outflow not accounted for", tag);
    // I5: nothing but the price loss leaves a position that did not win.
    const [ev] = parseLogs(rc, "PositionClosed");
    if (!p.boosted && want.pricePnl <= 0n && toOwner + toCaller !== p.margin + max(want.pricePnl, -p.margin)) {
      violation("I5 non-winning position was charged", `${tag} paid ${fmt(toOwner + toCaller)}`);
    }
    if (ev && ev.args.pnl <= 0n && ev.args.crowdingFee !== 0n) violation("I5 crowding fee on a non-positive result", tag);
    if (!p.boosted && kind !== "Liquidation" && want.pricePnl > 0n && toOwner < p.margin) {
      violation("R8 crowding fee reached into margin", `${tag} paid ${fmt(toOwner)}`);
    }
    // R4, R10: exact figures.
    if (toOwner !== want.payout) violation("R10 payout", `${tag} paid ${fmt(toOwner)} rules ${fmt(want.payout)}`);
    if (toCaller !== want.liqFee) violation("R4 liquidator reward", `${tag} paid ${fmt(toCaller)} rules ${fmt(want.liqFee)}`);
    if (toStaking !== want.stakerFee) violation("R10 staker share", `${tag} paid ${fmt(toStaking)} rules ${fmt(want.stakerFee)}`);
    if (!ev) violation("close event missing", tag);
    else {
      const e = ev.args;
      const got = [KINDS[Number(e.kind)], e.exitPrice, e.pnl, e.fee, e.payout, e.crowdingFee, e.boostPremium];
      const exp = [kind, exit, want.result, want.fee, want.payout, want.crowding, want.premium];
      if (got.some((x, i) => x !== exp[i])) violation("close event differs from the rules", `${tag} event [${got}] rules [${exp}]`);
    }

    if (kind === "ForceClose") {
      // Reported, and asserted only under REVIEW_STRICT: what the forced fill cost the owner against the mid.
      const lost = rules.settle(p, c, ch, F.mid, kind, G, totalStaked > 0n).payout - want.payout;
      if (lost > stats.forcedLoss.usd) stats.forcedLoss = { usd: lost, step };
      if (STRICT && lost > max(10n ** 6n, p.margin / 20n)) {
        violation("S2 forced close paid less than the position was worth at the mid", `${tag} mid ${fmt(F.mid, 18)} short by ${fmt(lost)}`);
      }
    }

    stats.closes[kind]++;
    stats.profitFees += want.fee;
    stats.stakerFees += want.stakerFee;
    stats.liquidatorFees += want.liqFee;
    if (want.crowding > 0n) {
      stats.crowdingCharged++;
      stats.crowdingPaid += want.crowding;
    }
    if (ch.crowding > want.crowding) stats.crowdingWaived++;
    if (want.premium > 0n) {
      stats.premiumCharged++;
      stats.premiumPaid += want.premium;
    }
    if (want.pricePnl >= p.reserve && p.reserve > 0n) stats.capped++;
    if (want.result === -p.margin) stats.wiped++;
    return true;
  }

  async function stepClose() {
    if (!pos.size) return stepPrice();
    const id = pick([...pos.keys()]);
    const p = pos.get(id);
    let quote = await priceFor(p.marketId, now + 1);
    if (quote === "relay") {
      await relay(p.marketId);
      quote = null;
    }
    // Mostly the owner. Sometimes a stranger, who must be turned away unless the market has resolved.
    const caller = chance(0.92) ? signerOf.get(p.owner) : liquidator;
    await act("close", id, caller, quote);
  }

  /** The numbers and flags the keeper and the app read for one position, against the rules. */
  function checkView(v, p, F, ts) {
    const c = cfg[p.marketId];
    const a = assess(p, F, ts);
    const got = [v.markPrice, v.pnl, v.equityAtMid, v.crowdingFee, v.boostPremium, v.liquidatable, v.forceClosable, v.collectable];
    const exp = [a.mark, a.pnl, a.equityAtMid, a.crowding, a.premium, a.liquidatable, a.forceClosable, a.collectable];
    if (got.some((x, i) => x !== exp[i])) violation("positionView differs from the rules", `#${v.id} view [${got}] rules [${exp}]`);
    stats.viewsChecked++;

    // winPrice: where the price P&L equals the reserve.
    const slack = 3n + p.notional / 10n ** 12n;
    const atWin = rules.pnl(c.isEvent, p.isLong, p.notional, p.entryPrice, v.winPrice);
    if (abs(atWin - p.reserve) > slack) violation("view winPrice", `#${v.id} P&L there ${fmt(atWin)} reserve ${fmt(p.reserve)}`);
    // liquidationPrice: where equity at the mid equals the maintenance level.
    const maint = (p.margin * G.maintBps) / BPS;
    const buffer = p.margin - maint - a.premium;
    const clamped = v.liquidationPrice === 0n || (c.isEvent && v.liquidationPrice >= WAD);
    if (buffer > 0n && !clamped) {
      const equity = p.margin + rules.result(p, c.isEvent, v.liquidationPrice, a.premium);
      if (abs(equity - maint) > slack) violation("view liquidationPrice", `#${v.id} equity there ${fmt(equity)} maintenance ${fmt(maint)}`);
    }
    return a;
  }

  /** The keeper's sweep: compare every view with the rules, then do some of what is due. */
  async function stepUpkeep() {
    if (!pos.size) return stepPrice();
    label = "sweep";
    for (const m of MARKETS) {
      if (resolved.has(m) || ![...pos.values()].some((p) => p.marketId === m)) continue;
      if (stale(await feedLatest(m), now + 2, cfg[m]) || chance(0.3)) await relay(m);
    }
    const ts = now + 1;
    await time.setNextBlockTimestamp(ts);
    const [views, ...pending] = await Promise.all([
      tryCall(() => engine.openPositions(0, 100_000, { blockTag: "pending" })),
      ...MARKETS.map((m) => feedPending(m)),
    ]);
    const feeds = Object.fromEntries(MARKETS.map((m, i) => [m, pending[i]]));
    if (!views.ok) {
      violation("view openPositions() reverted", views.error);
      return;
    }
    const due = [];
    for (const v of views.value) {
      const p = pos.get(v.id);
      if (!p) continue;
      const F = feeds[p.marketId];
      const a = checkView(v, p, F, ts);
      if (F.resolved) due.push([v.id, "close"]);
      else if (!stale(F, ts, cfg[p.marketId])) {
        if (a.liquidatable) due.push([v.id, "liquidate"]);
        if (a.collectable) due.push([v.id, "collect"]);
        if (a.forceClosable) due.push([v.id, "forceClose"]);
      }
    }
    if (!due.length || chance(0.15)) {
      // Something that is probably not due: it must be refused, and for a reason that applies.
      const id = pick([...pos.keys()]);
      const m = pos.get(id).marketId;
      const quote = !resolved.has(m) && chance(0.4) ? await signUpdate(m, ts) : null;
      await act(pick(["liquidate", "forceClose", "collect"]), id, liquidator, quote, ts);
      return;
    }
    for (let n = 0; n < 3 && due.length; n++) {
      const [id, action] = due.splice(Math.floor(rand() * due.length), 1)[0];
      if (pos.has(id)) await act(action, id, liquidator, null);
    }
  }

  async function stepPrice() {
    const m = pick(MARKETS);
    const big = chance(0.12);
    if (!resolved.has(m)) move(m, big);
    if (truth[m].depth === 0 && chance(0.3)) truth[m].depth = truth[m].baseDepth; // the book comes back
    label = `price ${SYMBOL[m]} -> ${truth[m].price}${big ? " (jump)" : ""}`;
    await relay(m, intBetween(1, 3));
    // Half the jumps are then held, so the slow price catches up and the new level can be traded.
    if (big && chance(0.5)) {
      const held = intBetween(2 * tauOf[m], 6 * tauOf[m]);
      await time.increaseTo(now + held);
      now += held;
      await relay(m);
    }
  }

  async function stepDepth() {
    const m = pick(MARKETS);
    const t = truth[m];
    t.depth = chance(0.1) ? 0 : Math.min(5 * t.baseDepth, Math.max(1_000, (t.depth || t.baseDepth) * between(0.3, 2.5)));
    label = `depth ${SYMBOL[m]} -> ${Math.round(t.depth)}`;
    await relay(m);
  }

  async function stepTime() {
    const r = rand();
    const dt =
      r < 0.4 ? intBetween(5, 60) : r < 0.7 ? intBetween(60, 15 * 60) : r < 0.95 ? intBetween(HOUR / 2, 4 * HOUR) : intBetween(6 * HOUR, 12 * HOUR);
    label = `wait ${dt}s`;
    await time.increaseTo(now + dt);
    now += dt;
    // The keeper comes back with prices for most markets.
    for (const m of MARKETS) if (chance(0.7)) await relay(m);
  }

  async function stepPoke() {
    const m = pick(MARKETS);
    label = `poke ${SYMBOL[m]}`;
    const ts = now + intBetween(1, 5);
    await time.setNextBlockTimestamp(ts);
    const F = await feedPending(m);
    await mine(ts, () => engine.connect(liquidator).poke(m));
    accrue(m, F, ts);
    stats.pokes++;
  }

  async function stepLp() {
    stats.lpMoves++;
    if (chance(0.55)) {
      const amount = usd(intBetween(10_000, 500_000));
      label = `lp deposits ${fmt(amount)}`;
      await mine(now + 1, () => vault.connect(lp).deposit(amount, lp.address));
      return;
    }
    const ts = now + 1;
    await time.setNextBlockTimestamp(ts);
    const most = await vault.maxWithdraw(lp.address, { blockTag: "pending" });
    const amount = chance(0.15) && pos.size ? most : (most * BigInt(intBetween(5, 40))) / 100n;
    label = `lp withdraws ${fmt(amount)} of ${fmt(most)}`;
    const over = await tryCall(() =>
      vault.connect(lp).withdraw.staticCall(most + 1n, lp.address, lp.address, { blockTag: "pending" })
    );
    if (over.ok) violation("vault let an LP withdraw locked money", `${fmt(most + 1n)}`);
    if (amount === 0n) return;
    const dry = await tryCall(() => vault.connect(lp).withdraw.staticCall(amount, lp.address, lp.address, { blockTag: "pending" }));
    if (!dry.ok) {
      violation("vault refused a withdrawal within maxWithdraw", dry.error);
      return;
    }
    await mine(ts, () => vault.connect(lp).withdraw(amount, lp.address, lp.address));
  }

  async function stepStake() {
    for (const t of traders) {
      const olq = await token.balanceOf(t.address);
      if (olq === 0n) continue;
      label = `${nameOf.get(t.address)} stakes OLQ`;
      await mine(now + 1, () => token.connect(t).approve(staking.target, olq));
      await mine(now + 1, () => staking.connect(t).stake(olq));
      return;
    }
    await stepPrice();
  }

  async function resolveMarket(m) {
    const yes = chance(0.5);
    label = `resolve ${SYMBOL[m]} ${yes ? "YES" : "NO"}`;
    truth[m].price = yes ? 1 : 0;
    const final = { price: yes ? WAD : 0n, depth: 0n, resolved: true };
    const held = [...pos.keys()].filter((id) => pos.get(id).marketId === m);
    if (held.length && chance(0.5)) {
      // The keeper's first settling call carries the final price with it.
      const ts = now + 1;
      if (!(await act("close", pick(held), liquidator, await signUpdate(m, ts, final), ts))) {
        violation("settlement with a bundled final price refused", SYMBOL[m]);
      }
      label = `resolve ${SYMBOL[m]} ${yes ? "YES" : "NO"}`;
    } else await relay(m, 1, final);
    resolved.add(m);
    const F = await feedLatest(m);
    if (!F.resolved || F.mid !== final.price || F.slow !== final.price) violation("resolution not stored", SYMBOL[m]);
    // After resolution nothing opens: positions only settle.
    await time.setNextBlockTimestamp(now + 1);
    const o = await tryCall(() => engine.connect(alice).open.staticCall(m, true, usd(10), 1, false, "0x", { blockTag: "pending" }));
    if (o.ok || o.error !== "MarketResolved") violation("open after resolution", o.ok ? "accepted" : o.error);
  }

  // ---- run ----
  now = await time.latest();
  for (const m of MARKETS) await relay(m);
  await checkInvariants(true);

  const actions = [
    [stepOpen, 34],
    [stepClose, 9],
    [stepUpkeep, 16],
    [stepPrice, 22],
    [stepTime, 7],
    [stepDepth, 3],
    [stepPoke, 2],
    [stepLp, 3],
    [stepStake, 2],
  ];
  const totalWeight = actions.reduce((n, [, w]) => n + w, 0);
  // In every other run the plain event market resolves early, and the rest of the run trades around it.
  const earlyResolution = seed % 2 === 0 ? intBetween(Math.floor(steps * 0.5), Math.floor(steps * 0.8)) : -1;

  // Two runs in three are taken to the timed market's expiry part way through: one to just before
  // it, where the leverage limit is down to 1x or 2x, and one past it, where nothing opens.
  const expiryVisit = Math.floor(steps * 0.55);
  const visitTo = Number(cfg[EVA].expiry) + [intBetween(10, 900), -intBetween(600, 3_000), 0][seed % 3];

  for (step = 1; step <= steps; step++) {
    label = "?";
    if (step === earlyResolution) await resolveMarket(EVB);
    else if (step === expiryVisit && seed % 3 !== 2 && now < visitTo) {
      label = `wait until ${visitTo - Number(cfg[EVA].expiry)}s from EVA's expiry`;
      await time.increaseTo(visitTo);
      now = visitTo;
      for (const m of MARKETS) await relay(m);
    } else {
      let r = rand() * totalWeight;
      let chosen = actions[0][0];
      for (const [fn, w] of actions) {
        if (r < w) {
          chosen = fn;
          break;
        }
        r -= w;
      }
      if (pos.size >= 30 && chosen === stepOpen) chosen = chance(0.5) ? stepClose : stepUpkeep;
      await chosen();
    }
    await checkInvariants(step % FULL_CHECK_EVERY === 0);
  }

  // ---- resolution and final settlement ----
  step = steps + 1;
  await checkInvariants(true);
  for (const m of [EVA, EVB]) {
    if (resolved.has(m)) continue;
    await resolveMarket(m);
    await checkInvariants();
  }
  for (const id of [...pos.keys()]) {
    const p = pos.get(id);
    if (p.marketId === BTC) continue;
    // Liquidation, force-close and collect are all refused once a market has resolved.
    await act(pick(["liquidate", "forceClose", "collect"]), id, liquidator, null);
    if (!(await act("close", id, chance(0.5) ? liquidator : signerOf.get(p.owner), null))) {
      violation("resolved position could not be settled", `#${id}`);
    }
    await checkInvariants();
  }
  move(BTC, false);
  await relay(BTC);
  for (const id of [...pos.keys()]) {
    if (stale(await feedLatest(BTC), now + 1, cfg[BTC])) await relay(BTC);
    if (!(await act("close", id, signerOf.get(pos.get(id).owner), null))) violation("owner could not close", `#${id}`);
    await checkInvariants();
  }

  label = "end";
  await checkInvariants(true);
  const end = {
    open: await engine.openPositionCount(),
    marginHeld: await vault.marginHeld(),
    reserved: await vault.reserved(),
    cash: await usdc.balanceOf(vault.target),
    totalAssets: await vault.totalAssets(),
    unrealized: await engine.unrealizedPnl(),
  };
  if (pos.size || end.open !== 0n) violation("end: positions left open", `${end.open}`);
  if (end.marginHeld !== 0n) violation("end: marginHeld != 0", fmt(end.marginHeld));
  if (end.reserved !== 0n) violation("end: reserved != 0", fmt(end.reserved));
  if (end.unrealized !== 0n) violation("end: unrealizedPnl != 0", fmt(end.unrealized));
  if (end.totalAssets !== end.cash) violation("end: totalAssets != cash", `${fmt(end.totalAssets)} vs ${fmt(end.cash)}`);
  for (const m of MARKETS) {
    const s = normState(await engine.states(m));
    for (const k of TOTAL_FIELDS) if (s[k] !== 0n) violation(`end: ${k} != 0`, `${SYMBOL[m]} ${s[k]}`);
  }
  if ((await totalUsdc()) !== usdcAtStart) violation("end: USDC not conserved", "");
  // With nothing open nothing is locked: the only LP can take out everything but dust. (When the
  // vault has lost money, maxRedeem stops a fraction of a micro-dollar short of a sole holder's
  // balance, because the vault's virtual shares own a sliver of the cash.)
  const [shares, held, supply] = await Promise.all([vault.maxRedeem(lp.address), vault.balanceOf(lp.address), vault.totalSupply()]);
  if (held !== supply) violation("end: the LP is not the only shareholder", "");
  const stuck = await vault.convertToAssets(held - shares);
  if (stuck > 2n) violation("end: LP cannot redeem its shares", `${fmt(stuck)} USDC of shares not redeemable`);
  if (shares > 0n) await mine(now + 1, () => vault.connect(lp).redeem(shares, lp.address, lp.address));
  const left = await usdc.balanceOf(vault.target);
  const virtualSlice = ((end.cash + 1n) * 10n ** 6n) / (supply + 10n ** 6n); // what the virtual shares own
  if (left > virtualSlice + 4n) violation("end: money left in the vault after the LP left", fmt(left));

  if (STRICT && abs(stats.navGap.usd) * 1_000n > stats.navGap.nav) {
    step = stats.navGap.step;
    label = "share price";
    violation("S1 totalAssets() off the per-position mark by more than 0.1%", `by $${fmt(stats.navGap.usd)} on a vault worth $${fmt(stats.navGap.nav)}`);
  }
  stats.simulatedHours = Math.round(((now - t0) / HOUR) * 10) / 10;
  return { seed, steps, violations, stats };
}

function describeRun({ seed, stats: s }) {
  const closes = KINDS.map((k) => `${k} ${s.closes[k]}`).join(", ");
  const refused = Object.entries(s.refused)
    .sort((a, b) => b[1] - a[1])
    .map(([k, n]) => `${k} ${n}`)
    .join(", ");
  return [
    `      seed ${seed}: ${s.simulatedHours} h simulated, ${s.opens} opens (${s.boosted} boosted), up to ${s.maxOpen} open at once`,
    `        closes: ${closes}; ${s.capped} at the profit cap, ${s.wiped} lost the whole margin`,
    `        crowding fee taken on ${s.crowdingCharged} closes ($${fmt(s.crowdingPaid)}), reduced or waived on ${s.crowdingWaived}; ` +
      `boost premium on ${s.premiumCharged} ($${fmt(s.premiumPaid)})`,
    `        profit share $${fmt(s.profitFees)} (stakers $${fmt(s.stakerFees)}), liquidators $${fmt(s.liquidatorFees)}; ` +
      `${s.relays} relays, ${s.bundles} bundled prices, ${s.pokes} pokes, ${s.lpMoves} LP moves, ${s.viewsChecked} views checked`,
    `        refused: ${refused}`,
    `        largest gap between totalAssets() and the per-position mark: $${fmt(s.navGap.usd)} at step ${s.navGap.step} (NAV $${fmt(s.navGap.nav)})`,
    `        largest cost of a forced close against the mid: $${fmt(s.forcedLoss.usd)} at step ${s.forcedLoss.step}`,
  ].join("\n");
}

function describeViolations(violations) {
  const byKind = new Map();
  for (const v of violations) byKind.set(v.kind, [...(byKind.get(v.kind) ?? []), v]);
  const lines = [`${violations.length} invariant violation(s):`];
  for (const [kind, vs] of byKind) {
    lines.push(`  ${kind}  (x${vs.length})`);
    for (const v of vs.slice(0, 3)) lines.push(`    seed ${v.seed} step ${v.step} [${v.action}] ${v.detail}`);
  }
  return lines.join("\n");
}

describe("Review: seeded random simulation against the written rules", function () {
  this.timeout(1_800_000);

  for (const seed of SEEDS) {
    it(`seed ${seed}: all invariants hold after each of ${STEPS} random steps and after final settlement`, async () => {
      const run = await simulate({ seed, steps: STEPS });
      console.log(describeRun(run));
      expect(run.violations.length, describeViolations(run.violations)).to.equal(0);
    });
  }
});
