// Coverage review: behaviours of the engine and oracle rules that the existing suites
// (engine.test.js, events.test.js, exploit.test.js) do not exercise, or exercise only at 50c
// where the YES and NO formulas coincide.
//
// The first blocks pin down behaviour that is correct today. The last block, "open findings",
// holds tests that FAIL against the current contracts; each one names the rule it checks.
//
// Event fees and premiums are checked against the rule the engine and whitepaper state as of the
// PerpEngine edit of Nov 19 21:34: borrowed contracts * p(1-p) / tau * hazardScale, the same
// per-contract rate for YES and NO.
//
//   npx hardhat test test/review-coverage.test.js
//   npx hardhat test test/review-coverage.test.js --grep "REVIEW coverage: (?!open findings)"   (the green part only)

const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time, loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { deploy, marketConfig, usd, px, BTC, EVT } = require("./helpers");

const DAY = 86_400;
const HOUR = 3_600;
const P0 = px(60_000);
const BTC_DEPTH = usd(20_000_000);
const DEPTH = usd(2_000_000);
const KIND = { Close: 0n, Liquidation: 1n, ForceClose: 2n, Settlement: 3n, Collect: 4n };

/** A float amount of USDC as 6-decimal units. */
const usdF = (x) => BigInt(Math.round(x * 1e6));

// ---- fixtures -------------------------------------------------------------------------------

async function btcSetup(overrides = {}) {
  const ctx = await deploy();
  await ctx.engine.setMarket(BTC, marketConfig(overrides));
  await ctx.vault.connect(ctx.lp).deposit(usd(5_000_000), ctx.lp.address);
  await ctx.push(BTC, P0);
  ctx.feeds = [[BTC, P0, BTC_DEPTH]];
  return ctx;
}

async function eventSetup({ p0 = 0.5, daysOut = 300, oracleTau, depth = DEPTH, ...overrides } = {}) {
  const ctx = await deploy();
  if (oracleTau !== undefined) await ctx.oracle.setTau(EVT, oracleTau);
  ctx.expiry = (await time.latest()) + daysOut * DAY;
  ctx.config = marketConfig({
    isEvent: true,
    maxLeverage: 50,
    profitFeeBps: 1000,
    maxGapBps: 500, // five points of probability
    expiry: ctx.expiry,
    maxPositionNotional: usd(1_000_000),
    ...overrides,
  });
  await ctx.engine.setMarket(EVT, ctx.config);
  await ctx.vault.connect(ctx.lp).deposit(usd(1_000_000), ctx.lp.address);
  await ctx.push(EVT, px(p0), depth);
  ctx.feeds = [[EVT, px(p0), depth]];
  return ctx;
}

async function bothSetup() {
  const ctx = await deploy();
  ctx.expiry = (await time.latest()) + 300 * DAY;
  await ctx.engine.setMarket(BTC, marketConfig({ crowdingPerDay: px(0.001) }));
  await ctx.engine.setMarket(
    EVT,
    marketConfig({
      isEvent: true,
      boostEnabled: true,
      maxLeverage: 50,
      profitFeeBps: 1000,
      maxGapBps: 500,
      expiry: ctx.expiry,
      maxPositionNotional: usd(1_000_000),
      hazardScale: px(1),
    })
  );
  await ctx.vault.connect(ctx.lp).deposit(usd(5_000_000), ctx.lp.address);
  await ctx.push(BTC, P0);
  await ctx.push(EVT, px(0.5), DEPTH);
  ctx.feeds = [
    [BTC, P0, BTC_DEPTH],
    [EVT, px(0.5), DEPTH],
  ];
  return ctx;
}

const HAZARD = { hazardScale: px(1), boostEnabled: true };
const btc = () => btcSetup();
const btcCrowded = () => btcSetup({ crowdingPerDay: px(0.001) }); // 0.1% of notional a day at full skew
const evt = () => eventSetup();
const evtQuarter = () => eventSetup({ p0: 0.25 });
const evtTen = () => eventSetup({ p0: 0.1 });
const evtThin = () => eventSetup({ depth: usd(200_000) });
// No averaging in the oracle, so the price can be stepped around freely.
const evtSnap = () => eventSetup({ oracleTau: 0 });
const evtSnapLowMax = () => eventSetup({ oracleTau: 0, maxLeverage: 10 });
const hazard = () => eventSetup(HAZARD);
const hazardQuarter = () => eventSetup({ p0: 0.25, ...HAZARD });
const hazardHalfScale = () => eventSetup({ hazardScale: px(0.5), boostEnabled: true });
const hazardFourDays = () => eventSetup({ daysOut: 4, ...HAZARD });
const hazardThirtyDays = () => eventSetup({ daysOut: 30, ...HAZARD });
const timed = () => eventSetup({ daysOut: 3, reactionSeconds: 120 });
// The same market with a one-second averaging time, so a held price converges in under a minute.
const timedFast = () => eventSetup({ daysOut: 3, reactionSeconds: 120, oracleTau: 1 });
const timedSnap = () => eventSetup({ daysOut: 3, reactionSeconds: 120, oracleTau: 0 });
const timedBoost = () => eventSetup({ daysOut: 3, reactionSeconds: 120, ...HAZARD });
const both = () => bothSetup();

// ---- helpers --------------------------------------------------------------------------------

/**
 * Restore a fixture and re-push its prices. A snapshot is restored at its own block time plus
 * however long the run has taken since, so on a slow machine its last price would be stale.
 */
async function load(fixture) {
  const ctx = await loadFixture(fixture);
  for (const [market, price, depth] of ctx.feeds) await ctx.push(market, price, depth);
  return ctx;
}

/** Pin the next block one second after the last, whatever the wall clock has done. */
const tick = async () => time.setNextBlockTimestamp((await time.latest()) + 1);

async function openPos(ctx, who, market, isLong, margin, leverage, boost = false) {
  const id = await ctx.engine.nextPositionId();
  await tick();
  await ctx.engine.connect(who).open(market, isLong, usd(margin), leverage, boost, "0x");
  return id;
}

/** Send a transaction that closes a position; return its PositionClosed event and block time. */
async function closed(ctx, send) {
  await tick();
  const rc = await (await send()).wait();
  for (const log of rc.logs) {
    let ev = null;
    try {
      ev = ctx.engine.interface.parseLog(log);
    } catch {
      /* another contract's log */
    }
    if (ev && ev.name === "PositionClosed") {
      const at = (await ethers.provider.getBlock(rc.blockNumber)).timestamp;
      return Object.assign(ev.args.toObject(), { at });
    }
  }
  throw new Error("no PositionClosed event");
}

/**
 * Move a market to `price` and hold it until the slow price equals it exactly: the oracle's
 * decay factor is exactly zero once a value has been held for 60 halvings (42 averaging times).
 */
async function settleAt(ctx, market, price, depth) {
  const tau = Number(await ctx.oracle.tau(market));
  await ctx.push(market, price, depth);
  await time.increase(42 * tau);
  await ctx.push(market, price, depth);
}

/**
 * R8/R9 in floating point, for one accrual interval at price p:
 * units * p(1-p) * scale * dt / tau, tau being the time to expiry at the interval's midpoint,
 * floored at one hour.
 */
function hazardCharge({ units, p, from, to, expiry, scale = 1 }) {
  const dt = to - from;
  const tau = Math.max(HOUR, Math.max(0, expiry - to) + dt / 2);
  return (units * p * (1 - p) * scale * dt) / tau;
}

/** R6 in floating point: min(maxLeverage, tick bound, time bound), floored at 1x. */
function specMaxLeverage(p, secondsLeft, reaction = 120, cap = 50) {
  const dist = Math.min(p, 1 - p);
  const tickLev = Math.floor(Math.round(dist * 1000) / 20);
  const timeLev = Math.floor(dist / (3 * Math.sqrt((p * (1 - p) * reaction) / secondsLeft)));
  return Math.max(1, Math.min(cap, tickLev, timeLev));
}

const lastAccrual = async (ctx, market) => Number((await ctx.engine.states(market)).lastAccrual);

// =============================================================================================

describe("REVIEW coverage: oracle (R1)", () => {
  it("averages reported depth exactly like the price: 1 - e^(-dt/tau) of the gap, whatever the update count", async () => {
    const a = await load(btc);
    const t0 = await a.push(BTC, P0, usd(200_000_000)); // ten times the depth appears, then is held for 60 s
    await time.increaseTo(t0 + 60);
    const once = (await a.oracle.read(BTC)).slowDepth;

    const b = await load(btc);
    const t1 = await b.push(BTC, P0, usd(200_000_000));
    for (let t = 2; t <= 60; t += 2) {
      await time.setNextBlockTimestamp(t1 + t);
      const { update, sig } = await b.sign(BTC, P0, usd(200_000_000), t1 + t);
      await b.oracle.push([update], [sig]);
    }
    const often = (await b.oracle.read(BTC)).slowDepth;

    expect(once).to.be.closeTo(usdF(20e6 + 180e6 * (1 - Math.exp(-1))), usd(1));
    expect(often).to.be.closeTo(once, 100n); // thirty updates or none
    // Capacity is kappa (0.5) times the lesser of the reported and the persistent depth.
    expect((await b.engine.marketView(BTC)).sideCap).to.equal(often / 2n);
  });

  it("resolution snaps slow and slowDepth to the final report, and nothing moves them afterwards", async () => {
    const { oracle, engine, alice, push } = await load(evt);
    await push(EVT, px(0.9), usd(50_000_000)); // a jump in price and depth that has not been averaged in
    let f = await oracle.read(EVT);
    expect(f.slow).to.be.lessThan(px(0.51));
    expect(f.slowDepth).to.be.lessThan(usd(2_500_000));

    const ts = await push(EVT, px(1), 0n, true); // the keeper reports no depth with the result
    f = await oracle.read(EVT);
    expect([f.mid, f.slow, f.depthUsd, f.slowDepth, f.resolved]).to.deep.equal([px(1), px(1), 0n, 0n, true]);
    expect((await engine.marketView(EVT)).sideCap).to.equal(0n);

    await time.increase(10_000);
    await push(EVT, px(0.3), usd(5_000_000)); // a later signed, unresolved update is skipped, not applied
    f = await oracle.read(EVT);
    expect([f.mid, f.slow, f.depthUsd, f.slowDepth, f.resolved]).to.deep.equal([px(1), px(1), 0n, 0n, true]);
    expect(f.timestamp).to.equal(BigInt(ts));
    await expect(engine.connect(alice).open(EVT, true, usd(10), 1, false, "0x")).to.be.revertedWithCustomError(
      engine,
      "MarketResolved"
    );
  });

  it("fills worse-of on both sides, at open and at close", async () => {
    const ctx = await load(btc);
    const { engine, oracle, alice, bob, push } = ctx;
    await push(BTC, px(60_030)); // +5 bps, inside the 10 bps guard: the mid is above the slow price

    const long = await openPos(ctx, alice, BTC, true, 100, 100);
    expect((await engine.positions(long)).entryPrice).to.equal(px(60_030)); // a buy fills at the higher price
    const short = await openPos(ctx, bob, BTC, false, 100, 100);
    let f = await oracle.read(BTC); // evaluated at the open's block time
    expect(f.slow).to.be.lessThan(px(60_005));
    expect((await engine.positions(short)).entryPrice).to.equal(f.slow); // a sell fills at the lower price

    await push(BTC, px(59_970)); // now the mid is below the slow price
    const closeLong = await closed(ctx, () => engine.connect(alice).close(long, "0x"));
    expect(closeLong.exitPrice).to.equal(px(59_970)); // closing a long is a sell
    const closeShort = await closed(ctx, () => engine.connect(bob).close(short, "0x"));
    f = await oracle.read(BTC);
    expect(f.slow).to.be.greaterThan(px(59_995));
    expect(closeShort.exitPrice).to.equal(f.slow); // closing a short is a buy
  });

  it("fills an event NO at the worse NO price, and refuses a NO that would start too far under water", async () => {
    const ctx = await load(evt);
    const { engine, oracle, alice, bob, push } = ctx;
    await push(EVT, px(0.52), DEPTH); // YES up two points: NO is 0.48 at the mid, about 0.50 at the slow price

    const no = await openPos(ctx, bob, EVT, false, 100, 2);
    let f = await oracle.read(EVT);
    expect(f.slow).to.be.lessThan(px(0.501));
    expect((await engine.positions(no)).entryPrice).to.equal(f.slow); // pays the dearer NO
    const yes = await openPos(ctx, alice, EVT, true, 100, 2);
    expect((await engine.positions(yes)).entryPrice).to.equal(px(0.52)); // pays the dearer YES

    // A 10x NO here would be about 39% of its margin under water at the mid.
    await expect(engine.connect(bob).open(EVT, false, usd(100), 10, false, "0x")).to.be.revertedWithCustomError(
      engine,
      "EntryTooFarFromMid"
    );

    await push(EVT, px(0.49), DEPTH); // the mid is now below the slow price
    const closeYes = await closed(ctx, () => engine.connect(alice).close(yes, "0x"));
    expect(closeYes.exitPrice).to.equal(px(0.49));
    const closeNo = await closed(ctx, () => engine.connect(bob).close(no, "0x"));
    f = await oracle.read(EVT);
    expect(f.slow).to.be.greaterThan(px(0.5));
    expect(closeNo.exitPrice).to.equal(f.slow);
  });
});

// =============================================================================================

describe("REVIEW coverage: opening (R2, R3, R5, R6)", () => {
  it("event markets measure the dislocation guard in points of probability, and never block a close", async () => {
    const ctx = await load(evtTen);
    const { engine, alice, bob, push } = ctx;
    await push(EVT, px(0.14), DEPTH); // +4 points is +40% of the price, but inside the 5-point guard
    const id = await openPos(ctx, alice, EVT, true, 100, 1);

    await push(EVT, px(0.16), DEPTH); // six points above the slow price
    for (const isLong of [true, false]) {
      await expect(engine.connect(bob).open(EVT, isLong, usd(100), 1, false, "0x")).to.be.revertedWithCustomError(
        engine,
        "PriceDislocated"
      );
    }
    await engine.connect(alice).close(id, "0x");
    expect(await engine.openPositionCount()).to.equal(0n);
  });

  it("caps each side of an event market at kappa times depth, counts notional, and frees room on close", async () => {
    const ctx = await load(evtThin); // depth 200k * 0.5 = 100k a side
    const { engine, alice, bob } = ctx;
    expect((await engine.marketView(EVT)).sideCap).to.equal(usd(100_000));

    const yes = await openPos(ctx, alice, EVT, true, 10_000, 10); // 100,000 of YES: exactly the cap
    await expect(engine.connect(bob).open(EVT, true, usd(1), 1, false, "0x")).to.be.revertedWithCustomError(
      engine,
      "SideCapExceeded"
    );
    await openPos(ctx, bob, EVT, false, 60_000, 1); // the NO side has its own room
    await expect(engine.connect(bob).open(EVT, false, usd(50_000), 1, false, "0x")).to.be.revertedWithCustomError(
      engine,
      "SideCapExceeded"
    );

    await engine.connect(alice).close(yes, "0x");
    await openPos(ctx, bob, EVT, true, 1, 1);
  });

  it("reserves the right maximum profit for each side and mode away from 50c", async () => {
    const ctx = await load(hazardQuarter); // YES 0.25, NO 0.75
    const { engine, vault, alice, bob } = ctx;
    const yes = await openPos(ctx, alice, EVT, true, 100, 10);
    const no = await openPos(ctx, bob, EVT, false, 100, 10);
    const boostNo = await openPos(ctx, bob, EVT, false, 100, 10, true);
    const boostYes = await openPos(ctx, alice, EVT, true, 100, 10, true);

    // Free mode: what the 100 of margin would win outright on that side.
    expect((await engine.positions(yes)).reserve).to.equal(usd(300)); // 100 * 0.75 / 0.25
    expect((await engine.positions(no)).reserve).to.equal(33_333_333n); // 100 * 0.25 / 0.75
    // Boosted: the full 1,000 of notional, under the ceiling of 10x margin.
    expect((await engine.positions(boostNo)).reserve).to.equal(333_333_333n); // 1,000 * 0.25 / 0.75
    expect((await engine.positions(boostYes)).reserve).to.equal(usd(1_000)); // 3,000 uncapped
    expect(await vault.reserved()).to.equal(usd(300) + 33_333_333n + 333_333_333n + usd(1_000));
    expect(await vault.marginHeld()).to.equal(usd(400));

    // The win line is where the price P&L reaches the reserve.
    expect((await engine.positionView(yes)).winPrice).to.equal(px(0.325)); // 0.25 + 0.75 / 10
    expect((await engine.positionView(no)).winPrice).to.be.closeTo(px(0.225), 10n ** 12n); // 0.25 - 0.25 / 10
    expect((await engine.positionView(boostNo)).winPrice).to.be.closeTo(0n, 10n ** 12n);
    expect((await engine.positionView(boostYes)).winPrice).to.equal(px(0.5)); // the 10x-margin ceiling
  });

  it("reserves notional below the profit multiple, the multiple above it, and caps an outright long shot", async () => {
    const ctx = await load(btc);
    const low = await openPos(ctx, ctx.alice, BTC, true, 100, 5);
    const high = await openPos(ctx, ctx.alice, BTC, false, 100, 1000);
    expect((await ctx.engine.positions(low)).reserve).to.equal(usd(500)); // a 100% move on 5x
    expect((await ctx.engine.positions(high)).reserve).to.equal(usd(1_000)); // 10x margin
    expect(await ctx.vault.reserved()).to.equal(usd(1_500));

    // An outright YES at 5c would win 19x its stake; the ceiling stops it at 10x.
    const e = await load(evtSnap);
    await e.push(EVT, px(0.05), DEPTH);
    const shot = await openPos(e, e.alice, EVT, true, 100, 1);
    expect((await e.engine.positions(shot)).reserve).to.equal(usd(1_000));
    expect((await e.engine.positionView(shot)).winPrice).to.equal(px(0.55));
  });

  it("applies the two-tick leverage bound at prices across the range, on both sides", async () => {
    const ctx = await load(evtSnap);
    const { engine, alice, push } = ctx;
    const table = [
      [0.03, 1],
      [0.05, 2],
      [0.1, 5],
      [0.3, 15],
      [0.5, 25],
      [0.7, 15],
      [0.9, 5],
      [0.95, 2],
      [0.97, 1],
      [0.985, 1], // less than one tick of room rounds to zero: the 1x floor
    ];
    for (const [p, lev] of table) {
      await push(EVT, px(p), DEPTH);
      const v = await engine.marketView(EVT);
      expect(v.maxLeverageLong, `max leverage at ${p}`).to.equal(BigInt(lev));
      expect(v.maxLeverageShort, `max leverage at ${p}`).to.equal(BigInt(lev));
      for (const isLong of [true, false]) {
        await expect(
          engine.connect(alice).open(EVT, isLong, usd(10), lev + 1, false, "0x"),
          `one above the bound at ${p}`
        ).to.be.revertedWithCustomError(engine, "BadLeverage");
        await openPos(ctx, alice, EVT, isLong, 10, lev);
      }
    }
    // Within one tick of 0 or 1 nothing opens; one tick away is the edge of the range.
    for (const [p, allowed] of [[0.005, false], [0.01, true], [0.99, true], [0.995, false]]) {
      await push(EVT, px(p), DEPTH);
      for (const isLong of [true, false]) {
        if (allowed) await openPos(ctx, alice, EVT, isLong, 10, 1);
        else {
          await expect(
            engine.connect(alice).open(EVT, isLong, usd(10), 1, false, "0x"),
            `open at ${p}`
          ).to.be.revertedWithCustomError(engine, "EventPriceOutOfRange");
        }
      }
    }

    // The market's own maximum binds when it is the lowest of the three.
    const capped = await load(evtSnapLowMax);
    expect((await capped.engine.marketView(EVT)).maxLeverageLong).to.equal(10n);
    await expect(
      capped.engine.connect(capped.alice).open(EVT, true, usd(10), 11, false, "0x")
    ).to.be.revertedWithCustomError(capped.engine, "BadLeverage");
  });

  it("applies the square-root-of-time leverage bound at several prices and horizons", async () => {
    const ctx = await load(timedSnap);
    const { engine, push, expiry } = ctx;
    const prices = [0.5, 0.3, 0.7, 0.2, 0.8, 0.1, 0.9, 0.05];
    const spot = {
      [3 * DAY]: { 0.5: 15, 0.3: 10, 0.2: 7, 0.8: 7, 0.1: 5, 0.05: 2 }, // at 0.05 the tick bound (2) is below the time bound (3)
      [12 * HOUR]: { 0.5: 6, 0.3: 4, 0.2: 3, 0.1: 2, 0.9: 2, 0.05: 1 },
      [HOUR]: { 0.5: 1, 0.3: 1 },
    };
    for (const left of [3 * DAY, 12 * HOUR, HOUR]) {
      if (left < 3 * DAY) await time.increaseTo(expiry - left);
      for (const p of prices) {
        await push(EVT, px(p), DEPTH);
        const got = (await engine.marketView(EVT)).maxLeverageLong;
        expect(got, `${p} with ${left}s left`).to.equal(BigInt(specMaxLeverage(p, expiry - (await time.latest()))));
        if (spot[left][p] !== undefined) expect(got, `${p} with ${left}s left`).to.equal(BigInt(spot[left][p]));
      }
    }

    // The bound is enforced at open, on both sides, where it is tighter than the tick bound.
    const fresh = await load(timedSnap);
    await fresh.push(EVT, px(0.2), DEPTH); // tick bound 10, time bound 7
    for (const isLong of [true, false]) {
      await expect(
        fresh.engine.connect(fresh.alice).open(EVT, isLong, usd(10), 8, false, "0x")
      ).to.be.revertedWithCustomError(fresh.engine, "BadLeverage");
      await openPos(fresh, fresh.alice, EVT, isLong, 10, 7);
    }
  });
});

// =============================================================================================

describe("REVIEW coverage: the NO side and liquidation (R4, R6, R11)", () => {
  it("measures a leveraged NO position on the NO price, in its P&L, its close and the LP share price", async () => {
    const ctx = await load(evtQuarter); // YES 0.25: NO costs 0.75
    const { engine, vault, usdc, alice, bob, push } = ctx;
    const a = await openPos(ctx, alice, EVT, false, 100, 10); // 1,000 of NO: 1,333.33 contracts
    const b = await openPos(ctx, bob, EVT, false, 100, 10);

    await push(EVT, px(0.28), DEPTH); // NO falls 3c: -1,000 * 0.03 / 0.75 = -40 each (it would be -120 on the YES price)
    expect((await engine.positionView(b)).equityAtMid).to.equal(usd(60));
    expect(await engine.unrealizedPnl()).to.be.closeTo(-usd(80), 5n);
    expect(await vault.totalAssets()).to.be.closeTo(usd(1_000_080), 5n);

    let before = await usdc.balanceOf(bob.address);
    await engine.connect(bob).close(b, "0x"); // buys back at the higher of mid and slow: the mid here
    expect((await usdc.balanceOf(bob.address)) - before).to.equal(usd(60));

    await settleAt(ctx, EVT, px(0.2425), DEPTH); // NO up 0.75c: +1,000 * 0.0075 / 0.75 = +10, less the 10% share
    before = await usdc.balanceOf(alice.address);
    const ev = await closed(ctx, () => engine.connect(alice).close(a, "0x"));
    expect(ev.exitPrice).to.equal(px(0.2425));
    expect(ev.pnl).to.equal(usd(10));
    expect((await usdc.balanceOf(alice.address)) - before).to.equal(usd(109));
  });

  it("bounds the marked P&L by everything reserved on the way up and by all margin held on the way down", async () => {
    const ctx = await load(evt);
    const { engine, vault, usdc, alice, push } = ctx;
    await openPos(ctx, alice, EVT, true, 1_000, 25); // 25,000 of YES in free mode: reserve 1,000
    const cash = await usdc.balanceOf(vault.target);

    await push(EVT, px(0.6), DEPTH); // uncapped the position is up 5,000
    expect(await engine.unrealizedPnl()).to.be.closeTo(usd(5_000), 5n);
    expect(await vault.totalAssets()).to.equal(cash - usd(1_000) - usd(1_000)); // margin, and no more than the reserve

    await push(EVT, px(0.4), DEPTH); // uncapped it is down 5,000
    expect(await engine.unrealizedPnl()).to.be.closeTo(-usd(5_000), 5n);
    expect(await vault.totalAssets()).to.equal(cash); // the margin is the most LPs can be marked up by
  });

  it("liquidates a NO and a YES exactly at the reported price, judged and paid at the mid", async () => {
    const ctx = await load(evtQuarter);
    const { engine, usdc, alice, bob, liquidator, push } = ctx;
    const no = await openPos(ctx, bob, EVT, false, 100, 10);
    const yes = await openPos(ctx, alice, EVT, true, 100, 10);
    expect((await engine.positionView(no)).liquidationPrice).to.equal(px(0.31)); // 0.25 + 0.75 * 80% / 10
    expect((await engine.positionView(yes)).liquidationPrice).to.equal(px(0.23)); // 0.25 - 0.25 * 80% / 10

    await push(EVT, px(0.3099), DEPTH); // equity 20.13
    expect((await engine.positionView(no)).liquidatable).to.equal(false);
    await expect(engine.connect(liquidator).liquidate(no, "0x")).to.be.revertedWithCustomError(engine, "NotLiquidatable");
    await push(EVT, px(0.31), DEPTH); // equity exactly 20% of margin: the line itself is liquidatable
    const bobBefore = await usdc.balanceOf(bob.address);
    let ev = await closed(ctx, () => engine.connect(liquidator).liquidate(no, "0x"));
    expect(ev.kind).to.equal(KIND.Liquidation);
    expect(await usdc.balanceOf(liquidator.address)).to.equal(usd(5)); // 5% of margin
    expect((await usdc.balanceOf(bob.address)) - bobBefore).to.equal(usd(15)); // the rest of the 20 left

    // The YES dips to 0.20 and is held there (the slow price follows), then recovers to just
    // above its line. At the slow price it would be wiped out; at the mid it is safe.
    await settleAt(ctx, EVT, px(0.2), DEPTH);
    await push(EVT, px(0.2301), DEPTH);
    await expect(engine.connect(liquidator).liquidate(yes, "0x")).to.be.revertedWithCustomError(engine, "NotLiquidatable");
    await push(EVT, px(0.2299), DEPTH); // equity 100 - 1,000 * 0.0201 / 0.25 = 19.6
    const aliceBefore = await usdc.balanceOf(alice.address);
    ev = await closed(ctx, () => engine.connect(liquidator).liquidate(yes, "0x"));
    expect(ev.exitPrice).to.equal(px(0.2299));
    expect((await usdc.balanceOf(alice.address)) - aliceBefore).to.equal(usd(14.6));
    expect(await usdc.balanceOf(liquidator.address)).to.equal(usd(10));
  });

  it("liquidates a short, and pays the liquidator only out of the equity that is left", async () => {
    const ctx = await load(btc);
    const { engine, vault, usdc, alice, bob, carol, liquidator, push } = ctx;
    const short = await openPos(ctx, bob, BTC, false, 100, 1000);
    const longA = await openPos(ctx, alice, BTC, true, 100, 1000);
    const longC = await openPos(ctx, carol, BTC, true, 100, 1000);
    expect((await engine.positionView(short)).liquidationPrice).to.equal(px(60_048));

    await push(BTC, px(60_048.6)); // +8.1 bps: the short has 19 left
    let before = await usdc.balanceOf(bob.address);
    await engine.connect(liquidator).liquidate(short, "0x");
    expect(await usdc.balanceOf(liquidator.address)).to.equal(usd(5));
    expect((await usdc.balanceOf(bob.address)) - before).to.equal(usd(14));

    await push(BTC, px(59_941.8)); // -9.7 bps: each long has 3 left, less than the 5 reward
    before = await usdc.balanceOf(carol.address);
    await engine.connect(liquidator).liquidate(longC, "0x");
    expect(await usdc.balanceOf(liquidator.address)).to.equal(usd(8)); // all 3 of it
    expect((await usdc.balanceOf(carol.address)) - before).to.equal(0n);

    await push(BTC, px(59_900)); // through the whole margin: nothing is left for anyone
    before = await usdc.balanceOf(alice.address);
    const ev = await closed(ctx, () => engine.connect(liquidator).liquidate(longA, "0x"));
    expect(ev.pnl).to.equal(-usd(100)); // the loss stops at the margin
    expect(await usdc.balanceOf(liquidator.address)).to.equal(usd(8));
    expect((await usdc.balanceOf(alice.address)) - before).to.equal(0n);
    expect(await vault.marginHeld()).to.equal(0n);
    expect(await vault.reserved()).to.equal(0n);
  });

  it("does not count an accrued crowding fee toward liquidation, and takes none of it from a liquidated loser", async () => {
    const ctx = await load(hazard);
    const { engine, usdc, alice, liquidator, push, expiry } = ctx;
    const id = await openPos(ctx, alice, EVT, true, 100, 10); // 1,800 borrowed shares, one-sided book
    const from = await lastAccrual(ctx, EVT);
    await time.increase(60 * DAY);
    await push(EVT, px(0.5), DEPTH);

    // Sixty days accrue about 100: more than the 80 of margin above the maintenance level.
    const v = await engine.positionView(id);
    const owed = hazardCharge({ units: 1800, p: 0.5, from, to: await time.latest(), expiry });
    expect(owed).to.be.greaterThan(90);
    expect(v.crowdingFee).to.be.closeTo(usdF(owed), usd(0.01));
    expect(v.equityAtMid).to.equal(usd(100));
    expect(v.liquidatable).to.equal(false);
    await expect(engine.connect(liquidator).liquidate(id, "0x")).to.be.revertedWithCustomError(engine, "NotLiquidatable");

    await push(EVT, px(0.461), DEPTH); // equity 22: the fee still does not count
    await expect(engine.connect(liquidator).liquidate(id, "0x")).to.be.revertedWithCustomError(engine, "NotLiquidatable");

    await push(EVT, px(0.459), DEPTH); // equity 18
    const before = await usdc.balanceOf(alice.address);
    const ev = await closed(ctx, () => engine.connect(liquidator).liquidate(id, "0x"));
    expect(ev.crowdingFee).to.equal(0n);
    expect(ev.pnl).to.equal(-usd(82));
    expect(await usdc.balanceOf(liquidator.address)).to.equal(usd(5));
    expect((await usdc.balanceOf(alice.address)) - before).to.equal(usd(13));
  });
});

// =============================================================================================

describe("REVIEW coverage: crowding fee (R8)", () => {
  it("non-event: charges the short side when shorts are the crowded side", async () => {
    const ctx = await load(btcCrowded);
    const { engine, alice, bob, carol, hold } = ctx;
    const b = await openPos(ctx, bob, BTC, false, 4_000, 1000); // 4M short
    const c = await openPos(ctx, carol, BTC, false, 4_000, 1000); // 4M short
    const a = await openPos(ctx, alice, BTC, true, 2_000, 1000); // 2M long: skew 6M of a 10M cap
    await hold(BTC, P0, 3600, BTC_DEPTH, 60);

    // 0.1%/day * 0.6 for one hour on 4M = 100.
    const vb = await engine.positionView(b);
    expect(vb.crowdingFee).to.be.closeTo(usd(100), usd(1));
    expect(vb.equityAtMid).to.equal(usd(4_000));
    expect((await engine.positionView(a)).crowdingFee).to.equal(0n);
    const mv = await engine.marketView(BTC);
    expect(mv.feePerDayLong).to.equal(0n);
    expect(mv.feePerDayShort).to.equal(px(0.0006));

    // A flat close on either side pays nothing.
    let ev = await closed(ctx, () => engine.connect(bob).close(b, "0x"));
    expect([ev.crowdingFee, ev.payout]).to.deep.equal([0n, usd(4_000)]);
    ev = await closed(ctx, () => engine.connect(alice).close(a, "0x"));
    expect([ev.crowdingFee, ev.payout]).to.deep.equal([0n, usd(2_000)]);

    // Carol's short wins 2,000 as the price falls 5 bps. The fee comes off first, then the 5% share.
    await settleAt(ctx, BTC, px(59_970), BTC_DEPTH);
    ev = await closed(ctx, () => engine.connect(carol).close(c, "0x"));
    expect(ev.exitPrice).to.equal(px(59_970));
    expect(ev.pnl).to.equal(usd(2_000));
    expect(ev.crowdingFee).to.be.closeTo(usd(146.8), usd(2)); // 100, plus 42 minutes alone at skew 0.4
    const left = usd(2_000) - ev.crowdingFee;
    expect(ev.fee).to.equal((left * 500n) / 10_000n);
    expect(ev.payout).to.equal(usd(4_000) + left - ev.fee);
  });

  it("non-event: skew is measured against capacity and stops at 1", async () => {
    const ctx = await load(btcCrowded);
    const { engine, alice, carol, hold } = ctx;
    const a = await openPos(ctx, alice, BTC, true, 4_000, 1000);
    await openPos(ctx, carol, BTC, true, 4_000, 1000); // 8M of longs under a 10M cap
    await hold(BTC, P0, 3600, usd(2_000_000), 60); // the book thins to a tenth: capacity 1M, imbalance 8M

    expect((await engine.marketView(BTC)).sideCap).to.be.closeTo(usd(1_000_000), usd(1));
    expect((await engine.marketView(BTC)).feePerDayLong).to.equal(px(0.001)); // the full rate, not eight times it
    expect((await engine.positionView(a)).crowdingFee).to.be.closeTo(usdF((4e6 * 0.001) / 24), usd(1)); // 166.67
  });

  it("event: charges a crowded NO side on the NO contracts it borrowed, and nothing on an outright bet", async () => {
    const ctx = await load(hazardQuarter); // YES 0.25, NO 0.75
    const { engine, alice, bob, carol, push, expiry } = ctx;
    const a = await openPos(ctx, alice, EVT, false, 100, 10); // 1,333.33 NO contracts, 1,200 of them borrowed
    const b = await openPos(ctx, bob, EVT, false, 100, 10);
    const c = await openPos(ctx, carol, EVT, true, 5_000, 1); // outright YES: borrows nothing, offsets nothing
    const from = await lastAccrual(ctx, EVT);
    await time.increase(DAY);
    await push(EVT, px(0.25), DEPTH);

    // 1,200 borrowed NO contracts * 0.25 * 0.75 / 300 days = 0.75 a day.
    // (A YES position of the same size borrows 3,600 shares; charging the NO on those would be 2.25.)
    const dayOne = hazardCharge({ units: 1200, p: 0.25, from, to: await time.latest(), expiry });
    expect(dayOne).to.be.closeTo(0.75, 0.01);
    const vb = await engine.positionView(b);
    expect(vb.crowdingFee).to.be.closeTo(usdF(dayOne), usd(0.005));
    expect(vb.boostPremium).to.equal(0n);
    expect(vb.equityAtMid).to.equal(usd(100));
    expect((await engine.positionView(c)).crowdingFee).to.equal(0n);

    const mv = await engine.marketView(EVT);
    expect(mv.feePerDayLong).to.equal(0n);
    expect(mv.feePerDayShort).to.equal(mv.boostPerDayShort); // fully one-sided: the same rate as Boost
    expect(mv.boostPerDayLong).to.equal(mv.boostPerDayShort); // p(1-p) is the same number for YES and NO

    // Bob closes flat and pays nothing.
    let ev = await closed(ctx, () => engine.connect(bob).close(b, "0x"));
    expect([ev.crowdingFee, ev.payout]).to.deep.equal([0n, usd(100)]);
    const bobClosedAt = ev.at;
    const booked = hazardCharge({ units: 1200, p: 0.25, from, to: bobClosedAt, expiry });

    // Alice wins 10 as YES falls to 0.2425. The fee comes off first, then the 10% share.
    await settleAt(ctx, EVT, px(0.2425), DEPTH);
    ev = await closed(ctx, () => engine.connect(alice).close(a, "0x"));
    const tail = hazardCharge({ units: 1200, p: 0.2425, from: bobClosedAt, to: ev.at, expiry });
    expect(ev.pnl).to.equal(usd(10));
    expect(ev.crowdingFee).to.be.closeTo(usdF(booked + tail), usd(0.01));
    const left = usd(10) - ev.crowdingFee;
    expect(ev.fee).to.equal(left / 10n);
    expect(ev.payout).to.equal(usd(100) + left - ev.fee);
  });

  it("event: the fee stops at the win, so a small winner gets its margin back and never less", async () => {
    const ctx = await load(hazard);
    const { engine, alice, push } = ctx;
    const id = await openPos(ctx, alice, EVT, true, 100, 10); // one-sided book
    await time.increase(60 * DAY);
    await push(EVT, px(0.51), DEPTH); // up one point: +20
    expect((await engine.positionView(id)).crowdingFee).to.be.greaterThan(usd(90)); // far more than the win
    await settleAt(ctx, EVT, px(0.51), DEPTH);
    const ev = await closed(ctx, () => engine.connect(alice).close(id, "0x"));
    expect([ev.pnl, ev.crowdingFee, ev.fee, ev.payout]).to.deep.equal([usd(20), usd(20), 0n, usd(100)]);
  });

  it("event: charges in proportion to how one-sided the borrowed shares are, whichever side is crowded", async () => {
    // NO crowded at 25c: 2,400 borrowed NO contracts against 400 borrowed YES shares.
    const q = await load(hazardQuarter);
    const qa = await openPos(q, q.alice, EVT, false, 100, 10); // 1,200 borrowed NO
    await openPos(q, q.bob, EVT, false, 100, 10); // 1,200 borrowed NO
    const qc = await openPos(q, q.carol, EVT, true, 100, 2); // 800 YES shares, 400 of them borrowed
    const qFrom = await lastAccrual(q, EVT);
    await time.increase(DAY);
    await q.push(EVT, px(0.25), DEPTH);
    // (2,400 - 400) / 2,400 = 5/6 of the rate: 1,200 * 5/6 * 0.25 * 0.75 / 300 days = 0.625 a day.
    const qExpected = hazardCharge({ units: 1000, p: 0.25, from: qFrom, to: await time.latest(), expiry: q.expiry });
    expect(qExpected).to.be.closeTo(0.625, 0.01);
    expect((await q.engine.positionView(qa)).crowdingFee).to.be.closeTo(usdF(qExpected), usd(0.005));
    expect((await q.engine.positionView(qc)).crowdingFee).to.equal(0n);

    // YES crowded at 50c.
    const ctx = await load(hazard);
    const { engine, alice, bob, carol, push, expiry } = ctx;
    const a = await openPos(ctx, alice, EVT, true, 100, 10); // 1,800 borrowed YES
    await openPos(ctx, carol, EVT, true, 100, 10); // 1,800 borrowed YES
    const b = await openPos(ctx, bob, EVT, false, 100, 10); // 1,800 borrowed NO: half of the YES side is offset
    const from = await lastAccrual(ctx, EVT);
    await time.increase(DAY);
    await push(EVT, px(0.5), DEPTH);

    // (3,600 - 1,800) / 3,600 = half the rate: 1,800 * 0.5 * 0.25 / 300 days = 0.75 a day.
    const expected = hazardCharge({ units: 1800 * 0.5, p: 0.5, from, to: await time.latest(), expiry });
    expect(expected).to.be.closeTo(0.75, 0.01);
    expect((await engine.positionView(a)).crowdingFee).to.be.closeTo(usdF(expected), usd(0.005));
    expect((await engine.positionView(b)).crowdingFee).to.equal(0n); // the uncrowded side pays nothing
    const mv = await engine.marketView(EVT);
    expect(mv.feePerDayShort).to.equal(0n);
    expect(mv.feePerDayLong).to.be.closeTo(mv.boostPerDayLong / 2n, 10n);
  });

  it("event: a boosted position pays the premium and no crowding fee, yet its borrowed shares count in the skew", async () => {
    const ctx = await load(hazard);
    const { engine, alice, bob, carol, push, expiry } = ctx;
    const boosted = await openPos(ctx, alice, EVT, true, 100, 10, true); // 1,800 borrowed YES
    const outright = await openPos(ctx, alice, EVT, true, 100, 1, true); // boosted at 1x: nothing borrowed
    const free = await openPos(ctx, carol, EVT, true, 100, 10); // 1,800 borrowed YES
    const from = await lastAccrual(ctx, EVT);
    await time.increase(DAY);
    await push(EVT, px(0.5), DEPTH);

    // Day one: 3,600 borrowed YES against none. Each pays 1,800 * 0.25 / 300 days = 1.50, one as premium, one as fee.
    const dayOne = hazardCharge({ units: 1800, p: 0.5, from, to: await time.latest(), expiry });
    expect(dayOne).to.be.closeTo(1.5, 0.01);
    let vb = await engine.positionView(boosted);
    let vf = await engine.positionView(free);
    expect(vb.boostPremium).to.be.closeTo(usdF(dayOne), usd(0.005));
    expect(vb.crowdingFee).to.equal(0n);
    expect(vb.equityAtMid).to.be.closeTo(usd(100) - usdF(dayOne), usd(0.005)); // the premium is a claim on margin
    expect(vf.crowdingFee).to.be.closeTo(usdF(dayOne), usd(0.005));
    expect(vf.boostPremium).to.equal(0n);
    expect(vf.equityAtMid).to.equal(usd(100)); // the fee is not
    const vo = await engine.positionView(outright);
    expect([vo.boostPremium, vo.crowdingFee, vo.position.reserve]).to.deep.equal([0n, 0n, usd(100)]);

    // A boosted NO arrives: its 1,800 borrowed NO offset half of the YES side.
    const no = await openPos(ctx, bob, EVT, false, 100, 10, true);
    const split = await lastAccrual(ctx, EVT);
    const booked = hazardCharge({ units: 1800, p: 0.5, from, to: split, expiry });
    await time.increase(DAY);
    await push(EVT, px(0.5), DEPTH);
    const dayTwo = hazardCharge({ units: 1800, p: 0.5, from: split, to: await time.latest(), expiry });
    vb = await engine.positionView(boosted);
    vf = await engine.positionView(free);
    const vn = await engine.positionView(no);
    expect(vb.boostPremium).to.be.closeTo(usdF(booked + dayTwo), usd(0.01)); // the premium does not depend on skew
    expect(vf.crowdingFee).to.be.closeTo(usdF(booked + dayTwo / 2), usd(0.01)); // the fee is now at half rate
    expect(vn.boostPremium).to.be.closeTo(usdF(dayTwo), usd(0.01));
    expect(vn.crowdingFee).to.equal(0n);
  });

  it("event: prices an accrual interval at its midpoint and floors the time left at one hour", async () => {
    const ctx = await load(hazardFourDays);
    const { engine, alice, expiry } = ctx;
    const id = await openPos(ctx, alice, EVT, true, 100, 2); // 400 shares, 200 of them borrowed; one-sided book
    let st = await engine.states(EVT);
    const from = Number(st.lastAccrual);
    const index0 = st.cumFeeLong;

    // One accrual covering the two days from four days out to two days out: priced at three days out.
    await time.setNextBlockTimestamp(expiry - 2 * DAY);
    await engine.poke(EVT);
    const perShare = hazardCharge({ units: 1, p: 0.5, from, to: expiry - 2 * DAY, expiry });
    expect(perShare).to.be.closeTo(1 / 6, 1e-4); // 0.25 * 2 days / 3 days; priced at either end it would be 0.125 or 0.25
    st = await engine.states(EVT);
    // (The engine halves the interval with integer division: up to half a second in three days.)
    expect(st.cumFeeLong - index0).to.be.closeTo(px(perShare.toFixed(12)), 10n ** 12n);
    expect((await engine.positionView(id)).crowdingFee).to.be.closeTo(usdF(200 * perShare), usd(0.001));

    // Thirty minutes ending ten minutes before expiry: the midpoint is 25 minutes out, floored to an hour.
    await time.setNextBlockTimestamp(expiry - 40 * 60);
    await engine.poke(EVT);
    let index = (await engine.states(EVT)).cumFeeLong;
    await time.setNextBlockTimestamp(expiry - 10 * 60);
    await engine.poke(EVT);
    st = await engine.states(EVT);
    expect(st.cumFeeLong - index).to.equal(px(0.125)); // 0.25 * 30 min / 60 min; unfloored it would be 0.30

    // The same thirty minutes straddling expiry.
    index = st.cumFeeLong;
    await time.setNextBlockTimestamp(expiry + 20 * 60);
    await engine.poke(EVT);
    expect((await engine.states(EVT)).cumFeeLong - index).to.equal(px(0.125));
  });

  it("event: scales the fee and the premium by hazardScale", async () => {
    const ctx = await load(hazardHalfScale);
    const { engine, alice, carol, push, expiry } = ctx;
    const boosted = await openPos(ctx, alice, EVT, true, 100, 10, true);
    const free = await openPos(ctx, carol, EVT, true, 100, 10);
    const from = await lastAccrual(ctx, EVT);
    await time.increase(DAY);
    await push(EVT, px(0.5), DEPTH);
    const expected = hazardCharge({ units: 1800, p: 0.5, from, to: await time.latest(), expiry, scale: 0.5 });
    expect(expected).to.be.closeTo(0.75, 0.01); // half of the 1.50 a day charged at full scale
    expect((await engine.positionView(boosted)).boostPremium).to.be.closeTo(usdF(expected), usd(0.005));
    expect((await engine.positionView(free)).crowdingFee).to.be.closeTo(usdF(expected), usd(0.005));
  });

  it("non-event: a setMarket call accrues at the old rate first, then charges the new one", async () => {
    const ctx = await load(btcCrowded);
    const { engine, alice } = ctx;
    const id = await openPos(ctx, alice, BTC, true, 5_000, 1000); // 5M of a 10M cap: skew 0.5
    const t0 = await lastAccrual(ctx, BTC);
    const perHour = (rate) => (5e6 * 0.5 * rate) / 24;

    await time.setNextBlockTimestamp(t0 + HOUR);
    await engine.setMarket(BTC, marketConfig({ crowdingPerDay: px(0.003) })); // the rate triples after one hour
    await time.setNextBlockTimestamp(t0 + 2 * HOUR);
    await engine.poke(BTC);
    // 104.17 for the first hour and 312.50 for the second; charging both at the new rate would be 625.
    expect((await engine.positionView(id)).crowdingFee).to.be.closeTo(usdF(perHour(0.001) + perHour(0.003)), 5n);

    await time.setNextBlockTimestamp(t0 + 3 * HOUR);
    await engine.setMarket(BTC, marketConfig({ crowdingPerDay: 0n })); // switched off after the third hour
    await time.setNextBlockTimestamp(t0 + 4 * HOUR);
    await engine.poke(BTC);
    expect((await engine.positionView(id)).crowdingFee).to.be.closeTo(usdF(perHour(0.001) + 2 * perHour(0.003)), 5n);
  });

  it("event: a setMarket call accrues the premium at the old hazardScale first", async () => {
    const ctx = await load(hazard);
    const { engine, alice, expiry, config } = ctx;
    const id = await openPos(ctx, alice, EVT, true, 100, 10, true);
    const t0 = await lastAccrual(ctx, EVT);

    await time.setNextBlockTimestamp(t0 + DAY);
    await engine.setMarket(EVT, { ...config, hazardScale: px(2) }); // doubled after one day
    await time.setNextBlockTimestamp(t0 + 2 * DAY);
    await engine.poke(EVT);
    const expected =
      hazardCharge({ units: 1800, p: 0.5, from: t0, to: t0 + DAY, expiry, scale: 1 }) +
      hazardCharge({ units: 1800, p: 0.5, from: t0 + DAY, to: t0 + 2 * DAY, expiry, scale: 2 });
    expect(expected).to.be.closeTo(4.52, 0.02); // 1.5 + 3; both days at the new scale would be 6
    expect((await engine.positionView(id)).boostPremium).to.be.closeTo(usdF(expected), usd(0.001));
  });

  it("event: collect and settlement take the accrued fee from the capped win, before the profit share", async () => {
    for (const how of ["collect", "settle"]) {
      const ctx = await load(hazard);
      const { engine, alice, bob, push, expiry } = ctx;
      const id = await openPos(ctx, alice, EVT, true, 100, 10); // capped at +100; one-sided book
      const from = await lastAccrual(ctx, EVT);
      await time.increase(DAY);
      await push(EVT, px(0.5), DEPTH);
      await tick();
      await engine.poke(EVT); // book day one at 0.50
      const pokedAt = await time.latest();
      let expected = hazardCharge({ units: 1800, p: 0.5, from, to: pokedAt, expiry });

      let ev;
      if (how === "collect") {
        await settleAt(ctx, EVT, px(0.56), DEPTH); // through the win line at 0.55
        ev = await closed(ctx, () => engine.connect(bob).collect(id, "0x"));
        expected += hazardCharge({ units: 1800, p: 0.56, from: pokedAt, to: ev.at, expiry });
        expect(ev.kind).to.equal(KIND.Collect);
      } else {
        await push(EVT, px(1), DEPTH, true); // resolves YES
        ev = await closed(ctx, () => engine.connect(bob).close(id, "0x"));
        expect(ev.kind).to.equal(KIND.Settlement);
        expect(ev.exitPrice).to.equal(px(1));
      }
      expect(ev.pnl, how).to.equal(usd(100)); // capped at the reserve
      expect(ev.crowdingFee, how).to.be.closeTo(usdF(expected), usd(0.01));
      const left = usd(100) - ev.crowdingFee;
      expect(ev.fee, how).to.equal(left / 10n);
      expect(ev.payout, how).to.equal(usd(100) + left - ev.fee);
    }
  });
});

// =============================================================================================

describe("REVIEW coverage: Boost (R9)", () => {
  it("Boost on the NO side: the premium is charged on the NO contracts borrowed, and the full win is kept on the NO price", async () => {
    const ctx = await load(hazardQuarter); // YES 0.25, NO 0.75
    const { engine, vault, alice, bob, push, expiry } = ctx;
    const no = await openPos(ctx, bob, EVT, false, 100, 10, true); // 1,333.33 NO contracts, 1,200 borrowed
    const yes = await openPos(ctx, alice, EVT, true, 100, 10, true); // 4,000 YES shares, 3,600 borrowed
    expect(await vault.reserved()).to.equal(333_333_333n + usd(1_000));
    const from = await lastAccrual(ctx, EVT);
    await time.increase(DAY);
    await push(EVT, px(0.25), DEPTH);
    await tick();
    await engine.poke(EVT); // book day one at 0.25
    const pokedAt = await time.latest();

    // The per-contract rate is the same on both sides; the NO borrowed a third of the contracts.
    const perShare = hazardCharge({ units: 1, p: 0.25, from, to: pokedAt, expiry });
    expect(1200 * perShare).to.be.closeTo(0.75, 0.01); // 1,200 * 0.25 * 0.75 / 300 days
    const vn = await engine.positionView(no);
    const vy = await engine.positionView(yes);
    expect(vn.boostPremium).to.be.closeTo(usdF(1200 * perShare), usd(0.001));
    expect(vy.boostPremium).to.be.closeTo(usdF(3600 * perShare), usd(0.001));
    expect([vn.crowdingFee, vy.crowdingFee]).to.deep.equal([0n, 0n]);
    expect(vn.equityAtMid).to.be.closeTo(usd(100) - usdF(1200 * perShare), usd(0.001));

    // A flat close pays the premium out of margin.
    let ev = await closed(ctx, () => engine.connect(alice).close(yes, "0x"));
    const yesClosedAt = ev.at;
    expect(ev.boostPremium).to.be.closeTo(usdF(3600 * perShare), usd(0.001));
    expect(ev.pnl).to.equal(-ev.boostPremium);
    expect([ev.fee, ev.payout]).to.deep.equal([0n, usd(100) - ev.boostPremium]);

    // YES falls to 0.10: 1,000 * 0.15 / 0.75 = 200, where free mode would stop at 33.33.
    await settleAt(ctx, EVT, px(0.1), DEPTH);
    ev = await closed(ctx, () => engine.connect(bob).close(no, "0x"));
    const premium =
      1200 *
      (perShare +
        hazardCharge({ units: 1, p: 0.25, from: pokedAt, to: yesClosedAt, expiry }) +
        hazardCharge({ units: 1, p: 0.1, from: yesClosedAt, to: ev.at, expiry }));
    expect(ev.boostPremium).to.be.closeTo(usdF(premium), usd(0.005));
    expect(ev.crowdingFee).to.equal(0n);
    expect(ev.pnl).to.equal(usd(200) - ev.boostPremium);
    expect(ev.fee).to.equal(ev.pnl / 10n);
    expect(ev.payout).to.equal(usd(100) + ev.pnl - ev.fee);
    expect(await vault.reserved()).to.equal(0n);
  });

  it("the premium alone can take a boosted position to liquidation, and never takes more than the margin", async () => {
    const ctx = await load(hazardThirtyDays);
    const { engine, vault, usdc, alice, carol, liquidator, push, expiry } = ctx;
    const id = await openPos(ctx, alice, EVT, true, 100, 10, true); // 1,800 borrowed shares: about 15 a day at first
    const other = await openPos(ctx, carol, EVT, true, 100, 10, true);
    const from = await lastAccrual(ctx, EVT);

    await time.increaseTo(from + 4 * DAY);
    await push(EVT, px(0.5), DEPTH);
    let v = await engine.positionView(id);
    let owed = hazardCharge({ units: 1800, p: 0.5, from, to: await time.latest(), expiry });
    expect(owed).to.be.closeTo(64.29, 0.05); // 450 * 4 / 28
    expect(v.boostPremium).to.be.closeTo(usdF(owed), usd(0.01));
    expect(v.liquidatable).to.equal(false);
    await expect(engine.connect(liquidator).liquidate(id, "0x")).to.be.revertedWithCustomError(engine, "NotLiquidatable");

    await time.increaseTo(from + 5.25 * DAY);
    await push(EVT, px(0.5), DEPTH); // the price has not moved at all
    v = await engine.positionView(id);
    expect(v.liquidatable).to.equal(true);
    expect(v.liquidationPrice).to.be.gte(px(0.5)); // no buffer left: liquidatable at its own entry price
    const before = await usdc.balanceOf(alice.address);
    let ev = await closed(ctx, () => engine.connect(liquidator).liquidate(id, "0x"));
    owed = hazardCharge({ units: 1800, p: 0.5, from, to: ev.at, expiry });
    expect(owed).to.be.closeTo(86.3, 0.05); // 450 * 5.25 / 27.375
    expect(ev.kind).to.equal(KIND.Liquidation);
    expect(ev.boostPremium).to.be.closeTo(usdF(owed), usd(0.01));
    expect(ev.pnl).to.equal(-ev.boostPremium);
    expect(await usdc.balanceOf(liquidator.address)).to.equal(usd(5));
    expect((await usdc.balanceOf(alice.address)) - before).to.equal(usd(95) - ev.boostPremium);

    // Left for ten days the premium owed is well over the margin. The loss still stops at the margin.
    await time.increaseTo(from + 10 * DAY);
    await push(EVT, px(0.5), DEPTH);
    v = await engine.positionView(other);
    expect(v.boostPremium).to.be.greaterThan(usd(150));
    expect(v.equityAtMid).to.equal(0n);
    const carolBefore = await usdc.balanceOf(carol.address);
    ev = await closed(ctx, () => engine.connect(liquidator).liquidate(other, "0x"));
    expect(ev.pnl).to.equal(-usd(100));
    expect(ev.payout).to.equal(0n);
    expect(await usdc.balanceOf(liquidator.address)).to.equal(usd(5)); // nothing left to reward
    expect((await usdc.balanceOf(carol.address)) - carolBefore).to.equal(0n);
    expect(await vault.marginHeld()).to.equal(0n);
    expect(await vault.reserved()).to.equal(0n);
  });

  it("settles boosted positions at 1 and at 0: the winner gets its full leveraged win less premium, the loser loses its margin", async () => {
    for (const final of [1, 0]) {
      const ctx = await load(hazard);
      const { engine, vault, usdc, alice, bob, carol, push, expiry } = ctx;
      const yes = await openPos(ctx, alice, EVT, true, 100, 10, true); // reserve 1,000
      const no = await openPos(ctx, bob, EVT, false, 100, 10, true); // reserve 1,000
      const from = await lastAccrual(ctx, EVT);
      await time.increase(DAY);
      await push(EVT, px(0.5), DEPTH);
      await tick();
      await engine.poke(EVT); // the day's premium is booked before the result arrives
      const premium = hazardCharge({ units: 1800, p: 0.5, from, to: await time.latest(), expiry });
      expect(premium).to.be.closeTo(1.5, 0.01);

      await push(EVT, px(final), DEPTH, true);
      const [winner, loser] = final === 1 ? [yes, no] : [no, yes];
      const cashBefore = await usdc.balanceOf(vault.target);
      const win = await closed(ctx, () => engine.connect(carol).close(winner, "0x")); // anyone may settle
      const lose = await closed(ctx, () => engine.connect(carol).close(loser, "0x"));

      expect(win.kind, `at ${final}`).to.equal(KIND.Settlement);
      expect(win.exitPrice, `at ${final}`).to.equal(px(final));
      expect(win.boostPremium, `at ${final}`).to.be.closeTo(usdF(premium), usd(0.01));
      expect(win.pnl, `at ${final}`).to.equal(usd(1_000) - win.boostPremium);
      expect(win.fee, `at ${final}`).to.equal(win.pnl / 10n);
      expect(win.payout, `at ${final}`).to.equal(usd(100) + win.pnl - win.fee);

      expect(lose.pnl, `at ${final}`).to.equal(-usd(100)); // the premium cannot push the loss past the margin
      expect([lose.payout, lose.fee], `at ${final}`).to.deep.equal([0n, 0n]);

      expect(cashBefore - (await usdc.balanceOf(vault.target)), `at ${final}`).to.equal(win.payout);
      expect(await vault.reserved()).to.equal(0n);
      expect(await vault.marginHeld()).to.equal(0n);
      expect(await engine.openPositionCount()).to.equal(0n);
    }
  });

  it("a boosted position at the profit ceiling is collectable there, and is paid the ceiling less premium", async () => {
    const ctx = await load(hazard);
    const { engine, alice, bob } = ctx;
    const id = await openPos(ctx, alice, EVT, true, 100, 25, true); // 2,500 of YES: the full win would be 2,500
    expect((await engine.positions(id)).reserve).to.equal(usd(1_000)); // the 10x-margin ceiling
    expect((await engine.positionView(id)).winPrice).to.equal(px(0.7)); // 0.50 + 0.50 * 1,000 / 2,500

    await settleAt(ctx, EVT, px(0.69), DEPTH); // 950
    await expect(engine.connect(bob).collect(id, "0x")).to.be.revertedWithCustomError(engine, "NotCollectable");
    await settleAt(ctx, EVT, px(0.72), DEPTH); // 1,100 uncapped
    const ev = await closed(ctx, () => engine.connect(bob).collect(id, "0x"));
    expect(ev.kind).to.equal(KIND.Collect);
    expect(ev.boostPremium).to.be.greaterThan(0n);
    expect(ev.pnl).to.equal(usd(1_000) - ev.boostPremium); // capped first, then the premium
    expect(ev.payout).to.equal(usd(100) + ev.pnl - ev.pnl / 10n);
  });
});

// =============================================================================================

describe("REVIEW coverage: collect (R7)", () => {
  it("collects a NO position once the close fill, not just the mid, is through its win line", async () => {
    const ctx = await load(evtQuarter);
    const { engine, usdc, alice, bob, push } = ctx;
    const id = await openPos(ctx, bob, EVT, false, 100, 10); // can win 33.33; win line 0.225

    await settleAt(ctx, EVT, px(0.23), DEPTH); // +26.67: not there yet
    await expect(engine.connect(alice).collect(id, "0x")).to.be.revertedWithCustomError(engine, "NotCollectable");

    await push(EVT, px(0.22), DEPTH); // the mid is through the line; the slow price, where a NO buys back, is not
    expect((await engine.positionView(id)).collectable).to.equal(false);
    await expect(engine.connect(alice).collect(id, "0x")).to.be.revertedWithCustomError(engine, "NotCollectable");

    await settleAt(ctx, EVT, px(0.22), DEPTH); // +40 uncapped
    expect((await engine.positionView(id)).collectable).to.equal(true);
    const bobBefore = await usdc.balanceOf(bob.address);
    const aliceBefore = await usdc.balanceOf(alice.address);
    const ev = await closed(ctx, () => engine.connect(alice).collect(id, "0x")); // alice collects for bob
    expect(ev.kind).to.equal(KIND.Collect);
    expect((await usdc.balanceOf(bob.address)) - bobBefore).to.equal(usd(130)); // 100 + 33.333333 - 3.333333
    expect(await usdc.balanceOf(alice.address)).to.equal(aliceBefore); // the caller earns nothing
  });

  it("collects a non-event long and short at the profit multiple", async () => {
    const ctx = await load(btc);
    const { engine, usdc, alice, bob, carol, push } = ctx;
    const long = await openPos(ctx, alice, BTC, true, 100, 1000); // can win 1,000: the win line is +1%, at 60,600
    expect((await engine.positionView(long)).winPrice).to.equal(px(60_600));

    await push(BTC, px(60_660)); // the mid is through the line, the slow price is not
    expect((await engine.positionView(long)).collectable).to.equal(false);
    await expect(engine.connect(carol).collect(long, "0x")).to.be.revertedWithCustomError(engine, "NotCollectable");

    await settleAt(ctx, BTC, px(60_599), BTC_DEPTH); // held one dollar under the line: +998.33
    await expect(engine.connect(carol).collect(long, "0x")).to.be.revertedWithCustomError(engine, "NotCollectable");
    await settleAt(ctx, BTC, px(60_600), BTC_DEPTH); // on the line itself
    let before = await usdc.balanceOf(alice.address);
    await engine.connect(carol).collect(long, "0x");
    expect((await usdc.balanceOf(alice.address)) - before).to.equal(usd(1_050)); // 100 + 1,000 - 5%

    const short = await openPos(ctx, bob, BTC, false, 100, 1000); // entry 60,600: win line 1% below
    expect((await engine.positionView(short)).winPrice).to.equal(px(59_994));
    await settleAt(ctx, BTC, px(59_994), BTC_DEPTH);
    before = await usdc.balanceOf(bob.address);
    await engine.connect(carol).collect(short, "0x");
    expect((await usdc.balanceOf(bob.address)) - before).to.equal(usd(1_050));
  });
});

// =============================================================================================

describe("REVIEW coverage: forced close (R6)", () => {
  it("force-closes a losing position at the normal close fill, with no penalty and no reward", async () => {
    const ctx = await load(timed);
    const { engine, usdc, alice, bob, push, expiry } = ctx;
    const id = await openPos(ctx, alice, EVT, true, 100, 15); // 1,500 of YES at the 15x limit
    await expect(engine.connect(bob).forceClose(id, "0x")).to.be.revertedWithCustomError(engine, "NotForceClosable");

    await time.increaseTo(expiry - 6 * HOUR); // the limit is now 4x
    await push(EVT, px(0.49), DEPTH); // and the position is 30 under water: 1,500 * 0.01 / 0.50
    const v = await engine.positionView(id);
    expect([v.forceClosable, v.liquidatable]).to.deep.equal([true, false]);

    const aliceBefore = await usdc.balanceOf(alice.address);
    const bobBefore = await usdc.balanceOf(bob.address);
    const ev = await closed(ctx, () => engine.connect(bob).forceClose(id, "0x"));
    expect(ev.kind).to.equal(KIND.ForceClose);
    expect(ev.exitPrice).to.equal(px(0.49));
    expect([ev.pnl, ev.fee]).to.deep.equal([-usd(30), 0n]);
    expect((await usdc.balanceOf(alice.address)) - aliceBefore).to.equal(usd(70)); // margin less the loss, nothing more
    expect(await usdc.balanceOf(bob.address)).to.equal(bobBefore);
  });

  it("force-closes a winner for its normal payout, never a 1x position, and everything above 1x after expiry", async () => {
    const ctx = await load(timedFast);
    const { engine, usdc, alice, bob, carol, push, expiry } = ctx;
    const a = await openPos(ctx, alice, EVT, true, 100, 15);
    const b = await openPos(ctx, bob, EVT, true, 100, 1);

    await time.increaseTo(expiry - 6 * HOUR);
    await settleAt(ctx, EVT, px(0.51), DEPTH); // +30 on the 15x, held until the slow price agrees
    const before = await usdc.balanceOf(alice.address);
    let ev = await closed(ctx, () => engine.connect(carol).forceClose(a, "0x"));
    expect([ev.exitPrice, ev.pnl, ev.fee]).to.deep.equal([px(0.51), usd(30), usd(3)]);
    expect((await usdc.balanceOf(alice.address)) - before).to.equal(usd(127));
    await expect(engine.connect(carol).forceClose(b, "0x")).to.be.revertedWithCustomError(engine, "NotForceClosable");

    // With six hours left 2x is still inside the limit. One second after expiry it is not.
    const c = await openPos(ctx, alice, EVT, true, 100, 2);
    await expect(engine.connect(carol).forceClose(c, "0x")).to.be.revertedWithCustomError(engine, "NotForceClosable");
    await time.increaseTo(expiry + 1);
    await push(EVT, px(0.51), DEPTH);
    expect((await engine.positionView(c)).forceClosable).to.equal(true);
    expect((await engine.positionView(b)).forceClosable).to.equal(false);
    ev = await closed(ctx, () => engine.connect(carol).forceClose(c, "0x"));
    expect(ev.payout).to.equal(usd(100)); // flat: margin back
    await expect(engine.connect(carol).forceClose(b, "0x")).to.be.revertedWithCustomError(engine, "NotForceClosable");

    // After the result only settlement is left.
    await push(EVT, px(1), DEPTH, true);
    for (const fn of ["forceClose", "liquidate", "collect"]) {
      await expect(engine.connect(carol)[fn](b, "0x")).to.be.revertedWithCustomError(engine, "MarketResolved");
    }
  });

  it("the limit follows the current price: a move away from 50c makes a position force-closable at once", async () => {
    const ctx = await load(timedFast);
    const { engine, usdc, alice, bob } = ctx;
    const id = await openPos(ctx, alice, EVT, true, 100, 15); // the limit at 0.50 with three days left
    expect((await engine.positionView(id)).forceClosable).to.equal(false);

    await settleAt(ctx, EVT, px(0.6), DEPTH); // a minute later, at 0.60, the limit is 12x
    expect((await engine.marketView(EVT)).maxLeverageLong).to.equal(12n);
    const v = await engine.positionView(id);
    expect([v.forceClosable, v.collectable]).to.deep.equal([true, true]);
    const before = await usdc.balanceOf(alice.address);
    await engine.connect(bob).forceClose(id, "0x");
    // With the slow price converged the forced close pays the same capped win a collect would: 100 + 100 - 10.
    expect((await usdc.balanceOf(alice.address)) - before).to.equal(usd(190));
  });
});

// =============================================================================================

describe("REVIEW coverage: settlement invariants (R10)", () => {
  it("through a mixed book the vault never pays a position more than margin + reserve, and its cash always covers what is locked", async () => {
    const ctx = await load(both);
    const { engine, vault, usdc, token, staking, alice, bob, carol, liquidator, push } = ctx;

    const solvent = async () =>
      expect(await usdc.balanceOf(vault.target)).to.be.gte((await vault.marginHeld()) + (await vault.reserved()));
    const open = async (...args) => {
      const id = await openPos(ctx, ...args);
      await solvent();
      return id;
    };
    /**
     * Close a position by any route. The vault pays the trader, the stakers' share of the fee and
     * the liquidator, nothing else, and all of it stays within that position's margin + reserve.
     */
    const settle = async (id, send) => {
      const p = await engine.positions(id);
      const staked = (await staking.totalStaked()) > 0n;
      const [cash, toStakers, toLiquidator] = await Promise.all(
        [vault.target, staking.target, liquidator.address].map((a) => usdc.balanceOf(a))
      );
      const ev = await closed(ctx, send);
      const paid = cash - (await usdc.balanceOf(vault.target));
      const stakerShare = (await usdc.balanceOf(staking.target)) - toStakers;
      const reward = (await usdc.balanceOf(liquidator.address)) - toLiquidator;
      expect(stakerShare).to.equal(staked ? (ev.fee * 3000n) / 10_000n : 0n);
      expect(paid).to.equal(ev.payout + stakerShare + reward);
      expect(paid).to.be.lte(p.margin + p.reserve);
      await solvent();
      return ev;
    };

    // A first winner earns OLQ and stakes it, so later fees carry a staker share out of the vault.
    const first = await open(alice, BTC, true, 100, 1000);
    await settleAt(ctx, BTC, px(60_030), BTC_DEPTH);
    await settle(first, () => engine.connect(alice).close(first, "0x"));
    const olq = await token.balanceOf(alice.address);
    expect(olq).to.be.greaterThan(0n);
    await token.connect(alice).approve(staking.target, olq);
    await staking.connect(alice).stake(olq);

    await push(EVT, px(0.5), DEPTH);
    await push(BTC, px(60_030));
    const yes = await open(alice, EVT, true, 100, 10); // free YES: stop near 0.46
    const no = await open(carol, EVT, false, 100, 25); // free NO: win line 0.48
    const boostNo = await open(bob, EVT, false, 200, 10, true); // boosted NO: can win 2,000
    const short = await open(alice, BTC, false, 100, 1000);
    const long = await open(bob, BTC, true, 100, 500);
    expect(await vault.marginHeld()).to.equal(usd(600));
    expect(await vault.reserved()).to.equal(usd(100 + 100 + 2_000 + 1_000 + 1_000));

    // A day later YES is at 0.47 and holds: the free NO is through its win line and a stranger collects it.
    await time.increase(DAY);
    await settleAt(ctx, EVT, px(0.47), DEPTH);
    let ev = await settle(no, () => engine.connect(bob).collect(no, "0x"));
    expect(ev.kind).to.equal(KIND.Collect);
    expect(ev.crowdingFee).to.be.greaterThan(0n); // NO was the crowded side

    // 0.455: the free YES is down 90 of its 100 and is liquidated.
    await push(EVT, px(0.455), DEPTH);
    ev = await settle(yes, () => engine.connect(liquidator).liquidate(yes, "0x"));
    expect([ev.kind, ev.payout]).to.deep.equal([KIND.Liquidation, usd(5)]);

    // BTC +0.2%: the 1000x short is wiped out, the 500x long takes its profit.
    await settleAt(ctx, BTC, px(60_150), BTC_DEPTH);
    ev = await settle(short, () => engine.connect(liquidator).liquidate(short, "0x"));
    expect(ev.payout).to.equal(0n);
    ev = await settle(long, () => engine.connect(bob).close(long, "0x"));
    expect(ev.fee).to.be.greaterThan(0n);

    // The event resolves NO: the boosted NO is settled for its owner by a stranger.
    await push(EVT, 0n, DEPTH, true);
    ev = await settle(boostNo, () => engine.connect(carol).close(boostNo, "0x"));
    expect(ev.kind).to.equal(KIND.Settlement);
    expect(ev.pnl).to.equal(usd(2_000) - ev.boostPremium);

    // Everything is unwound: nothing locked, no open interest, no units, and NAV is plain cash.
    expect(await engine.openPositionCount()).to.equal(0n);
    expect(await vault.marginHeld()).to.equal(0n);
    expect(await vault.reserved()).to.equal(0n);
    for (const m of [BTC, EVT]) {
      const s = await engine.states(m);
      expect([s.longOI, s.shortOI, s.longUnits, s.shortUnits, s.longBorrowed, s.shortBorrowed]).to.deep.equal(
        [0n, 0n, 0n, 0n, 0n, 0n]
      );
    }
    expect(await engine.unrealizedPnl()).to.equal(0n);
    expect(await vault.totalAssets()).to.equal(await usdc.balanceOf(vault.target));
    expect(await staking.pending(alice.address)).to.be.greaterThan(0n);
  });
});

// =============================================================================================

describe("REVIEW coverage: access, guards and views", () => {
  it("only the owner can close before resolution, and each upkeep call reverts unless it is due", async () => {
    const ctx = await load(btc);
    const { engine, alice, bob } = ctx;
    const id = await openPos(ctx, alice, BTC, true, 100, 10);
    await expect(engine.connect(bob).close(id, "0x")).to.be.revertedWithCustomError(engine, "NotOwner");
    await expect(engine.connect(bob).liquidate(id, "0x")).to.be.revertedWithCustomError(engine, "NotLiquidatable");
    await expect(engine.connect(bob).collect(id, "0x")).to.be.revertedWithCustomError(engine, "NotCollectable");
    // A forced close exists only on event markets.
    await expect(engine.connect(bob).forceClose(id, "0x")).to.be.revertedWithCustomError(engine, "NotForceClosable");
    for (const fn of ["close", "liquidate", "collect", "forceClose"]) {
      await expect(engine.connect(bob)[fn](999, "0x")).to.be.revertedWithCustomError(engine, "NoPosition");
    }
    await expect(engine.positionView(999)).to.be.revertedWithCustomError(engine, "NoPosition");

    await time.increase(120); // and none of them acts on a stale price
    for (const fn of ["close", "liquidate", "collect"]) {
      await expect(engine.connect(alice)[fn](id, "0x")).to.be.revertedWithCustomError(engine, "StalePrice");
    }
  });

  it("refuses bad sizes, leverage and Boost at open; a disabled market still lets positions out", async () => {
    const ctx = await load(btc);
    const { engine, alice } = ctx;
    const open = (market, margin, lev, boost = false) => engine.connect(alice).open(market, true, margin, lev, boost, "0x");
    await expect(open(BTC, usd(0.5), 10)).to.be.revertedWithCustomError(engine, "BadMargin");
    await expect(open(BTC, usd(100), 0)).to.be.revertedWithCustomError(engine, "BadLeverage");
    await expect(open(BTC, usd(100), 1001)).to.be.revertedWithCustomError(engine, "BadLeverage");
    await expect(open(BTC, usd(20_000), 1000)).to.be.revertedWithCustomError(engine, "PositionTooLarge"); // 20M against a 10M limit
    await expect(open(BTC, usd(100), 10, true)).to.be.revertedWithCustomError(engine, "BoostUnavailable");
    await expect(open(99, usd(100), 10)).to.be.revertedWithCustomError(engine, "MarketDisabled"); // never registered

    const id = await openPos(ctx, alice, BTC, true, 100, 10);
    await engine.setMarket(BTC, marketConfig({ enabled: false }));
    await expect(open(BTC, usd(100), 10)).to.be.revertedWithCustomError(engine, "MarketDisabled");
    await engine.connect(alice).close(id, "0x");
    expect(await engine.openPositionCount()).to.equal(0n);
  });

  it("validates market and engine parameters, and the engine parameters take effect", async () => {
    const ctx = await load(btc);
    const { engine, usdc, alice, liquidator, push } = ctx;
    await expect(engine.connect(alice).setMarket(BTC, marketConfig())).to.be.revertedWithCustomError(
      engine,
      "OwnableUnauthorizedAccount"
    );
    await expect(engine.connect(alice).setParams(2000, 500, 3000, usd(1))).to.be.revertedWithCustomError(
      engine,
      "OwnableUnauthorizedAccount"
    );
    const badMarkets = [
      { maxLeverage: 0 },
      { maxProfitMult: 0 },
      { profitFeeBps: 5001 },
      { hazardScale: px(10) + 1n },
      { boostEnabled: true }, // Boost on a market that is not an event
    ];
    for (const bad of badMarkets) {
      await expect(engine.setMarket(BTC, marketConfig(bad))).to.be.revertedWithCustomError(engine, "BadParams");
    }
    const badParams = [
      [10_000, 500, 3000], // maintenance at 100% of margin
      [2000, 2001, 3000], // reward above the maintenance level
      [2000, 500, 10_001], // staker share above 100%
    ];
    for (const bad of badParams) {
      await expect(engine.setParams(...bad, usd(1))).to.be.revertedWithCustomError(engine, "BadParams");
    }

    // Maintenance at 50% of margin, a 10% reward, and a 5 USDC minimum.
    await engine.setParams(5000, 1000, 3000, usd(5));
    await expect(engine.connect(alice).open(BTC, true, usd(4), 10, false, "0x")).to.be.revertedWithCustomError(
      engine,
      "BadMargin"
    );
    const id = await openPos(ctx, alice, BTC, true, 100, 1000);
    expect((await engine.positionView(id)).liquidationPrice).to.equal(px(59_970)); // 50% of margin is 5 bps
    await push(BTC, px(59_970));
    const before = await usdc.balanceOf(alice.address);
    await engine.connect(liquidator).liquidate(id, "0x");
    expect(await usdc.balanceOf(liquidator.address)).to.equal(usd(10));
    expect((await usdc.balanceOf(alice.address)) - before).to.equal(usd(40));
  });

  it("upkeep and settlement work from a price bundled with the call, the way the keeper sends them", async () => {
    const ctx = await load(evt);
    const { engine, oracle, usdc, alice, bob, carol, liquidator, sign } = ctx;
    const yes = await openPos(ctx, alice, EVT, true, 100, 10); // stop line 0.46
    const no = await openPos(ctx, bob, EVT, false, 100, 1);
    /** A price signed for the next block, encoded as the engine's `priceData`. */
    const bundle = async (price, resolved = false) => {
      const { update, sig } = await sign(EVT, price, DEPTH, (await time.latest()) + 1, resolved);
      return ethers.AbiCoder.defaultAbiCoder().encode(
        ["tuple(uint32 marketId,uint256 price,uint256 depthUsd,uint64 timestamp,bool resolved)[]", "bytes[]"],
        [[update], [sig]]
      );
    };

    await time.increase(600); // the price on chain is long stale
    await expect(engine.connect(liquidator).liquidate(yes, "0x")).to.be.revertedWithCustomError(engine, "StalePrice");
    let before = await usdc.balanceOf(alice.address);
    let ev = await closed(ctx, async () => engine.connect(liquidator).liquidate(yes, await bundle(px(0.459))));
    expect([ev.kind, ev.exitPrice]).to.deep.equal([KIND.Liquidation, px(0.459)]);
    expect(await usdc.balanceOf(liquidator.address)).to.equal(usd(5));
    expect((await usdc.balanceOf(alice.address)) - before).to.equal(usd(13));

    // The result arrives inside the settling call itself.
    before = await usdc.balanceOf(bob.address);
    ev = await closed(ctx, async () => engine.connect(carol).close(no, await bundle(0n, true)));
    expect([ev.kind, ev.exitPrice]).to.deep.equal([KIND.Settlement, 0n]);
    expect((await usdc.balanceOf(bob.address)) - before).to.equal(usd(190)); // 100 of NO bought at 0.50 pays 200, less the share
    expect((await oracle.read(EVT)).resolved).to.equal(true);
  });

  it("pages through open positions for the keeper and lists them per owner", async () => {
    const ctx = await load(btc);
    const { engine, alice, bob } = ctx;
    const ids = [
      await openPos(ctx, alice, BTC, true, 100, 10),
      await openPos(ctx, bob, BTC, false, 100, 10),
      await openPos(ctx, alice, BTC, false, 100, 10),
    ];
    const idsOf = (views) => Array.from(views, (v) => v.id);
    expect(await engine.openPositionCount()).to.equal(3n);
    expect(idsOf(await engine.openPositions(0, 2))).to.deep.equal([ids[0], ids[1]]);
    expect(idsOf(await engine.openPositions(2, 100))).to.deep.equal([ids[2]]);
    expect(idsOf(await engine.openPositions(3, 100))).to.deep.equal([]);
    expect(idsOf(await engine.positionsOf(alice.address))).to.deep.equal([ids[0], ids[2]]);

    await engine.connect(alice).close(ids[0], "0x");
    expect(idsOf(await engine.openPositions(0, 100))).to.have.members([ids[1], ids[2]]);
    expect(idsOf(await engine.positionsOf(alice.address))).to.deep.equal([ids[2]]);
    expect(idsOf(await engine.positionsOf(bob.address))).to.deep.equal([ids[1]]);
  });

  it("poke() books exactly what the views show as pending, for anyone who calls it", async () => {
    const ctx = await load(hazard);
    const { engine, alice, bob, push } = ctx;
    const id = await openPos(ctx, alice, EVT, true, 100, 10, true);
    await time.increase(DAY);
    await push(EVT, px(0.5), DEPTH);
    const pending = (await engine.positionView(id)).boostPremium; // includes the day not yet in the index
    const before = await engine.states(EVT);

    await tick();
    await engine.connect(bob).poke(EVT);
    const after = await engine.states(EVT);
    expect(after.lastAccrual).to.equal(BigInt(await time.latest()));
    expect(after.cumBoostLong).to.be.greaterThan(before.cumBoostLong);
    expect(after.cumBoostShort - before.cumBoostShort).to.equal(after.cumBoostLong - before.cumBoostLong);
    const booked = (await engine.positionView(id)).boostPremium; // now entirely from the stored index
    expect(booked).to.be.gte(pending);
    expect(booked).to.be.closeTo(pending, usd(0.001)); // one more second
  });
});

// =============================================================================================
// Open findings. Each test below states an intended rule and FAILS against the current
// contracts. They are grouped here so the rest of the file stays a green regression suite.
// =============================================================================================

describe("REVIEW coverage: open findings (these fail until the contracts change)", () => {
  it("F1a. poking an id before the owner registers it does not keep that market out of the market list", async () => {
    const ctx = await deploy();
    const { engine, oracle, bob } = ctx;
    await engine.connect(bob).poke(7); // anyone, any id, before the market exists
    await oracle.setTau(7, 60);
    await engine.setMarket(7, marketConfig());
    expect(await engine.marketCount()).to.equal(1n);
    expect(Array.from(await engine.allMarkets(), (m) => m.marketId)).to.deep.equal([7n]);
  });

  it("F1b. R11: positions in a market that was poked before registration are marked in the LP share price", async () => {
    const ctx = await deploy();
    const { engine, vault, lp, alice, bob, push } = ctx;
    await engine.connect(bob).poke(BTC);
    await engine.setMarket(BTC, marketConfig());
    await vault.connect(lp).deposit(usd(5_000_000), lp.address);
    await push(BTC, P0);
    await openPos(ctx, alice, BTC, true, 10_000, 1000); // 10M long
    await push(BTC, px(60_030)); // traders are up 5,000
    expect(await engine.unrealizedPnl()).to.be.closeTo(usd(5_000), usd(1));
    expect(await vault.totalAssets()).to.be.closeTo(usd(4_995_000), usd(1));
  });

  it("F2a. R9: a boosted position pays the premium it has accrued when the result arrives before anyone pokes", async () => {
    const ctx = await load(hazard);
    const { engine, alice, bob, push } = ctx;
    const id = await openPos(ctx, alice, EVT, true, 100, 10, true);
    await time.increase(DAY);
    await push(EVT, px(0.5), DEPTH);
    const shown = (await engine.positionView(id)).boostPremium; // about 1.50: what the engine itself reports as owed
    expect(shown).to.be.closeTo(usd(1.5), usd(0.03));

    await push(EVT, px(1), DEPTH, true); // the result, one second later
    const ev = await closed(ctx, () => engine.connect(bob).close(id, "0x"));
    expect(ev.boostPremium).to.be.closeTo(shown, usd(0.01));
  });

  it("F2b. R8: a free position's accrued crowding fee is taken from its win when the result arrives before anyone pokes", async () => {
    const ctx = await load(hazard);
    const { engine, alice, bob, push } = ctx;
    const id = await openPos(ctx, alice, EVT, true, 100, 10); // one-sided book
    await time.increase(DAY);
    await push(EVT, px(0.5), DEPTH);
    const shown = (await engine.positionView(id)).crowdingFee; // about 1.50
    expect(shown).to.be.closeTo(usd(1.5), usd(0.03));

    await push(EVT, px(1), DEPTH, true);
    const ev = await closed(ctx, () => engine.connect(bob).close(id, "0x"));
    expect(ev.crowdingFee).to.be.closeTo(shown, usd(0.01));
  });

  it("F2c. R9: the premium for ten days held at 50c is the same whether or not a stranger poked before the price moved", async () => {
    const premiumAtClose = async (pokeFirst) => {
      const ctx = await load(hazard);
      const { engine, alice, bob } = ctx;
      const id = await openPos(ctx, alice, EVT, true, 100, 10, true);
      await time.increase(10 * DAY); // ten quiet days at 0.50
      if (pokeFirst) await engine.connect(bob).poke(EVT);
      await settleAt(ctx, EVT, px(0.95), DEPTH); // then the odds move to 0.95, and the owner closes
      return (await closed(ctx, () => engine.connect(alice).close(id, "0x"))).boostPremium;
    };
    const poked = await premiumAtClose(true);
    const quiet = await premiumAtClose(false);
    expect(poked).to.be.closeTo(usd(15.3), usd(0.3)); // 1,800 * 0.25 * 10 / 295
    expect(quiet).to.be.closeTo(poked, usd(0.5));
  });

  it("F3a. R6 'no penalty': a forced close does not take a winner out at a stale slow price", async () => {
    const ctx = await load(timed);
    const { engine, usdc, alice, bob, push } = ctx;
    const id = await openPos(ctx, alice, EVT, true, 100, 15); // capped at +100; win line 0.5333
    await push(EVT, px(0.6), DEPTH); // news: ten points in the trader's favour
    const v = await engine.positionView(id);
    expect(v.forceClosable).to.equal(true); // the time limit at 0.60 is 12x
    expect(v.collectable).to.equal(false); // the slow price has not caught up, so the win cannot be collected yet

    const before = await usdc.balanceOf(alice.address);
    const refused = await engine
      .connect(bob)
      .forceClose.staticCall(id, "0x")
      .then(
        () => false,
        () => true
      );
    if (!refused) {
      await engine.connect(bob).forceClose(id, "0x");
      // At the mid the position is worth its full capped win: 100 + 100 - 10.
      expect((await usdc.balanceOf(alice.address)) - before).to.be.closeTo(usd(190), usd(1));
    }
  });

  it("F3b. R9 Boost: a boosted position keeps its leveraged win through a jump that is not yet the result", async () => {
    const ctx = await load(timedBoost);
    const { engine, usdc, alice, bob, push } = ctx;
    const id = await openPos(ctx, alice, EVT, true, 100, 10, true); // pays a premium for the uncapped upside
    await push(EVT, px(0.9), DEPTH); // news: forty points in its favour, worth 800 at the mid
    expect((await engine.positionView(id)).forceClosable).to.equal(true); // at 0.90 the time limit is 5x

    const before = await usdc.balanceOf(alice.address);
    const refused = await engine
      .connect(bob)
      .forceClose.staticCall(id, "0x")
      .then(
        () => false,
        () => true
      );
    if (!refused) {
      await engine.connect(bob).forceClose(id, "0x");
      // 100 + 800 less the 10% share; the premium for a few seconds is a fraction of a cent.
      expect((await usdc.balanceOf(alice.address)) - before).to.be.closeTo(usd(820), usd(5));
    }
  });

  it("F4. R8: when the reference book empties (capacity 0) the crowded side is at full skew, not at none", async () => {
    const ctx = await load(btcCrowded);
    const { engine, alice, hold } = ctx;
    const id = await openPos(ctx, alice, BTC, true, 5_000, 1000); // 5M long, nothing short
    await hold(BTC, P0, 3600, 0n, 60); // an hour with no depth reported
    expect((await engine.marketView(BTC)).sideCap).to.equal(0n);
    expect((await engine.positionView(id)).crowdingFee).to.be.closeTo(usdF((5e6 * 0.001) / 24), usd(3)); // 208.33
  });

  it("F5a. R11: the share price counts a position that is past its cap at its reserve, not its uncapped P&L", async () => {
    const ctx = await load(evt);
    const { vault, usdc, alice, bob, push } = ctx;
    await openPos(ctx, alice, EVT, true, 1_000, 25); // 25,000 of YES in free mode: can win 1,000 at most
    await openPos(ctx, bob, EVT, true, 20_000, 1); // an outright 20,000 of YES
    await push(EVT, px(0.6), DEPTH); // +10 points: alice's uncapped P&L is 5,000, bob's is 4,000
    const owed = usd(1_000 + 4_000); // what the two can actually be paid at this price
    const cash = await usdc.balanceOf(vault.target);
    expect(await vault.totalAssets()).to.be.closeTo(cash - usd(21_000) - owed, usd(1));
  });

  it("F5b. R11: the share price counts a position that is past its stop at minus its margin, not its uncapped loss", async () => {
    const ctx = await load(evt);
    const { vault, usdc, alice, bob, push } = ctx;
    await openPos(ctx, alice, EVT, true, 1_000, 25); // can lose 1,000 at most
    await openPos(ctx, bob, EVT, true, 20_000, 1);
    await push(EVT, px(0.4), DEPTH); // -10 points: alice's uncapped loss is 5,000, bob's is 4,000
    const owed = -usd(1_000 + 4_000);
    const cash = await usdc.balanceOf(vault.target);
    expect(await vault.totalAssets()).to.be.closeTo(cash - usd(21_000) - owed, usd(1));
  });

  it("F6. R8: an accrual interval wholly past expiry is priced at the one-hour floor, however long it is", async () => {
    const dayPastExpiry = async (pokes) => {
      const ctx = await load(hazardFourDays);
      const { engine, alice, expiry } = ctx;
      await openPos(ctx, alice, EVT, true, 100, 2); // a one-sided book, so the fee index moves at the full rate
      await time.setNextBlockTimestamp(expiry + HOUR);
      await engine.poke(EVT);
      const start = (await engine.states(EVT)).cumFeeLong;
      for (let i = 1; i <= pokes; i++) {
        await time.setNextBlockTimestamp(expiry + HOUR + (i * DAY) / pokes);
        await engine.poke(EVT);
      }
      return (await engine.states(EVT)).cumFeeLong - start;
    };
    // The time left at any midpoint past expiry is zero, so the floor applies: 0.25 * 24 h / 1 h per share.
    expect(await dayPastExpiry(24)).to.equal(px(6));
    expect(await dayPastExpiry(1)).to.equal(px(6));
  });
});
