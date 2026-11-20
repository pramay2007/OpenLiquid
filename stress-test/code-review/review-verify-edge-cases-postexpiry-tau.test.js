// Second-reviewer verification of the edge-case finding
//   "After expiry tau is dt/2 instead of the one-hour floor, so the charge depends on how often
//    the market is poked"   (PerpEngine._deltas, l.511-512)
//
// (review-verify-edge-cases.test.js already holds the verification of another finding, so this
// one has its own file.)
//
// Default run: every test PASSES against the contracts as reviewed (PerpEngine.sol 2026-11-19
// 21:34, md5 3e62568f...). Each V test pins the behaviour the finding claims, with the claimed
// numbers, so a green run means the claim reproduces. C tests are controls that hold with or
// without a fix.
//
// The same scenarios can be checked against a corrected engine by naming the fix that was applied:
//   ENGINE_FIXED=split     time past expiry priced at the floor, the time before it at its own
//                          midpoint (the change this verification recommends)
//   ENGINE_FIXED=midpoint  time to expiry taken at the interval's midpoint, clamped at zero
//                          (the first reviewer's suggestion)
// The two differ in V5 only; both sets of numbers are written out there.
//
// Run only this file:  npx hardhat test test/review-verify-edge-cases-postexpiry-tau.test.js

const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");
const { deploy, marketConfig, usd, px, EVT } = require("./helpers");

const MODE = process.env.ENGINE_FIXED || "";
if (!["", "midpoint", "split"].includes(MODE)) throw new Error(`ENGINE_FIXED must be "midpoint" or "split", got "${MODE}"`);
/** The expected value for the engine under test: as reviewed, with the midpoint fix, with the split fix. */
const pick = (asReviewed, midpoint, split = midpoint) => ({ "": asReviewed, midpoint, split })[MODE];

const DAY = 86_400;
const HOUR = 3_600;
const UNIT = 10n ** 36n;
const DEPTH = usd(2_000_000);
const f6 = (v) => Number(ethers.formatUnits(v, 6));
const f18 = (v) => Number(ethers.formatUnits(v, 18));
const note = (...a) => console.log("        ", ...a);
const PRICE_DATA = ["tuple(uint32 marketId,uint256 price,uint256 depthUsd,uint64 timestamp,bool resolved)[]", "bytes[]"];

/** One floor-hour of the index at 0.50 with hazardScale 0.01: 0.50 * 0.50 * 1% * 1 h / 1 h, per borrowed share. */
const FLOOR_HOUR = px(0.0025);

/** A signed price stamped `ts`, encoded for the engine's priceData argument. */
async function priceData(ctx, price, ts) {
  const { update, sig } = await ctx.sign(EVT, price, DEPTH, ts);
  return ethers.AbiCoder.defaultAbiCoder().encode(PRICE_DATA, [[update], [sig]]);
}

/**
 * The finding's book: an event market two days out with hazardScale 0.01, and Alice in a 2x YES
 * on 100 at 0.50, opened exactly two days before expiry: 400 shares, 200 of them borrowed.
 */
async function book({ boost = true, overrides = {} } = {}) {
  const ctx = await deploy();
  const { engine, vault, lp, alice, push } = ctx;
  ctx.expiry = (await time.latest()) + 2 * DAY + 60;
  await engine.setMarket(
    EVT,
    marketConfig({
      isEvent: true,
      boostEnabled: true,
      maxLeverage: 50,
      profitFeeBps: 1000,
      maxGapBps: 500,
      expiry: ctx.expiry,
      maxPositionNotional: usd(1_000_000),
      hazardScale: px(0.01),
      ...overrides,
    })
  );
  await vault.connect(lp).deposit(usd(1_000_000), lp.address);
  await push(EVT, px(0.5), DEPTH);
  const openedAt = ctx.expiry - 2 * DAY;
  await time.setNextBlockTimestamp(openedAt);
  await engine.connect(alice).open(EVT, true, usd(100), 2, boost, await priceData(ctx, px(0.5), openedAt));
  [ctx.view] = await engine.positionsOf(alice.address);
  ctx.id = ctx.view.id;
  ctx.pos = ctx.view.position;
  expect(ctx.pos.entryPrice).to.equal(px(0.5));
  expect(ctx.pos.borrowedUnits).to.equal(200n * 10n ** 24n); // 200 shares (USDC 6 dp * 1e36 / price 1e18)
  return ctx;
}

/** Bring the market's indexes up to date in a block stamped `ts`. Bob holds nothing and is not the owner. */
async function pokeAt(ctx, ts, who = ctx.bob) {
  await time.setNextBlockTimestamp(ts);
  await ctx.engine.connect(who).poke(EVT);
}

/** Relay a price straight to the oracle, as the keeper does, in a block stamped `ts`. The engine is not touched. */
async function pushAt(ctx, price, ts) {
  const { update, sig } = await ctx.sign(EVT, price, DEPTH, ts);
  await time.setNextBlockTimestamp(ts);
  await ctx.oracle.push([update], [sig]);
}

const boostIndex = async (ctx) => (await ctx.engine.states(EVT)).cumBoostLong;
const feeIndex = async (ctx) => (await ctx.engine.states(EVT)).cumFeeLong;

/** close / forceClose in a block stamped `ts`, carrying a price signed for that second. Returns PositionClosed. */
async function settleAt(ctx, ts, price, who = ctx.alice, fn = "close") {
  const data = await priceData(ctx, price, ts);
  await time.setNextBlockTimestamp(ts);
  const receipt = await (await ctx.engine.connect(who)[fn](ctx.id, data)).wait();
  for (const log of receipt.logs) {
    if (log.address !== ctx.engine.target) continue;
    const parsed = ctx.engine.interface.parseLog(log);
    if (parsed && parsed.name === "PositionClosed") return parsed.args;
  }
  throw new Error("no PositionClosed event");
}

describe(`Verify: charges for the time after expiry${MODE ? ` [engine fixed: ${MODE}]` : " [engine as reviewed]"}`, function () {
  this.timeout(300_000);

  it("C1 control: before expiry an accrual interval is priced at its midpoint, with or without a fix", async () => {
    const ctx = await book();
    const from = await boostIndex(ctx);
    await pokeAt(ctx, ctx.expiry - DAY); // one day, ending one day out: priced at a day and a half out
    const grown = (await boostIndex(ctx)) - from;
    expect(grown).to.equal((px(0.0025) * BigInt(DAY)) / BigInt(DAY + DAY / 2)); // 0.25 * 1% * 1 day / 1.5 days
    await pokeAt(ctx, ctx.expiry); // one day, ending at expiry: priced half a day out
    expect((await boostIndex(ctx)) - from - grown).to.equal(px(0.005)); // 0.25 * 1% * 1 day / 0.5 day
  });

  it("V1 ten hours past expiry: premium with one accrual at the end against ten hourly ones (the claim: 1.00 against 5.00)", async () => {
    const run = async (pokes) => {
      const ctx = await book();
      await pokeAt(ctx, ctx.expiry); // accrue exactly at expiry; identical in both runs up to here
      const atExpiry = await boostIndex(ctx);
      for (let i = 1; i <= pokes; i++) await pokeAt(ctx, ctx.expiry + (i * 10 * HOUR) / pokes);
      const grown = (await boostIndex(ctx)) - atExpiry;
      const owed = (await ctx.engine.positionView(ctx.id)).boostPremium;
      return { grown, premium: (ctx.pos.borrowedUnits * grown) / UNIT, owed };
    };
    const hourly = await run(10);
    const once = await run(1);
    note(
      `ten hours after expiry, per borrowed share: ${f18(hourly.grown)} with an accrual each hour, ${f18(once.grown)} with one at the end. ` +
        `On 200 borrowed shares: ${f6(hourly.premium)} against ${f6(once.premium)}`
    );
    // The floor rate, 200 * 0.25 * 0.01 an hour: what R9 gives for ten hours past expiry.
    expect(hourly.grown).to.equal(10n * FLOOR_HOUR);
    expect(hourly.premium).to.equal(usd(5));
    // As reviewed, one accrual: tau = dt/2 = 5 h, so 10 h / 5 h = two floor-hours.
    expect(once.grown).to.equal(pick(2n * FLOOR_HOUR, 10n * FLOOR_HOUR));
    expect(once.premium).to.equal(pick(usd(1), usd(5)));
    // The position view (premium since open: 1.00 up to expiry, plus the above) says the same.
    expect(hourly.owed).to.be.closeTo(usd(6), usd(0.001));
    expect(once.owed).to.be.closeTo(pick(usd(2), usd(6)), usd(0.001));
  });

  it("V2 one accrual over a gap that starts at expiry, by its length (the claim: two floor-hours for any gap of two hours or more)", async () => {
    const seen = [];
    for (const gap of [HOUR, 1.5 * HOUR, 2 * HOUR, 10 * HOUR, DAY, 30 * DAY]) {
      const ctx = await book();
      await pokeAt(ctx, ctx.expiry);
      const atExpiry = await boostIndex(ctx);
      await pokeAt(ctx, ctx.expiry + gap);
      const grown = (await boostIndex(ctx)) - atExpiry;
      seen.push(`${gap / HOUR} h: ${f18(grown)}`);
      const atFloor = (FLOOR_HOUR * BigInt(gap)) / BigInt(HOUR);
      const asReviewed = (FLOOR_HOUR * BigInt(Math.min(gap, 2 * HOUR))) / BigInt(HOUR);
      expect(grown, `gap of ${gap / HOUR} h`).to.equal(pick(asReviewed, atFloor));
    }
    note(`index growth per borrowed share (0.0025 is one floor-hour): ${seen.join(", ")}`);
  });

  it("V3 it reaches the payout: a boosted position closed ten hours past expiry, with and without a stranger's hourly pokes (the claim: 4.00 apart)", async () => {
    const run = async (strangerPokes) => {
      const ctx = await book();
      const { usdc, vault, alice, bob } = ctx;
      await pokeAt(ctx, ctx.expiry);
      if (strangerPokes) for (let h = 1; h <= 9; h++) await pokeAt(ctx, ctx.expiry + h * HOUR, bob);
      const before = await usdc.balanceOf(alice.address);
      const closed = await settleAt(ctx, ctx.expiry + 10 * HOUR, px(0.5)); // Alice closes at the price she opened at
      return { premium: closed.boostPremium, payout: closed.payout, paid: (await usdc.balanceOf(alice.address)) - before, vault: await usdc.balanceOf(vault.target) };
    };
    const alone = await run(false);
    const poked = await run(true);
    note(
      `closed ten hours past expiry at entry price. Nobody else touched the market: premium ${f6(alone.premium)}, payout ${f6(alone.payout)}. ` +
        `A stranger poked each hour: premium ${f6(poked.premium)}, payout ${f6(poked.payout)}`
    );
    expect(poked.premium).to.equal(usd(6)); // 1.00 up to expiry + 5.00 for ten hours at the floor
    expect(poked.payout).to.equal(usd(94));
    expect(alone.premium).to.equal(pick(usd(2), usd(6))); // as reviewed: 1.00 up to expiry + two floor-hours
    expect(alone.payout).to.equal(pick(usd(98), usd(94)));
    expect(alone.paid).to.equal(alone.payout);
    expect(alone.vault - poked.vault, "what the vault is short when nobody pokes").to.equal(pick(-usd(4), 0n));
  });

  it("V4 the crowding fee, taken from a free position's winnings, has the same dependence", async () => {
    const run = async (strangerPokes) => {
      const ctx = await book({ boost: false }); // a one-sided book: the fee index moves at the full rate
      const { bob } = ctx;
      await pushAt(ctx, px(0.6), ctx.expiry - DAY); // the odds move to 0.60 a day before expiry and stay there
      await pokeAt(ctx, ctx.expiry);
      const atExpiry = await feeIndex(ctx);
      if (strangerPokes) for (let h = 1; h <= 9; h++) await pokeAt(ctx, ctx.expiry + h * HOUR, bob);
      const closed = await settleAt(ctx, ctx.expiry + 10 * HOUR, px(0.6));
      return { grown: (await feeIndex(ctx)) - atExpiry, pnl: closed.pnl, fee: closed.crowdingFee, payout: closed.payout };
    };
    const alone = await run(false);
    const poked = await run(true);
    note(
      `free 2x YES up 40.00 at 0.60, closed ten hours past expiry. Nobody else touched the market: crowding fee ${f6(alone.fee)}, payout ${f6(alone.payout)}. ` +
        `A stranger poked each hour: fee ${f6(poked.fee)}, payout ${f6(poked.payout)}`
    );
    expect(alone.pnl).to.equal(usd(40));
    expect(poked.pnl).to.equal(usd(40));
    // Per share: 0.60 * 0.40 * 1% = 0.0024 a floor-hour. Up to expiry (one accrual over two days): 0.0048.
    expect(poked.grown).to.equal(px(0.024));
    expect(poked.fee).to.equal(usd(5.76)); // 200 * (0.0048 + 0.024)
    expect(poked.payout).to.equal(usd(130.816)); // 100 + (40 - 5.76) * 0.9
    expect(alone.grown).to.equal(pick(px(0.0048), px(0.024)));
    expect(alone.fee).to.equal(pick(usd(1.92), usd(5.76)));
    expect(alone.payout).to.equal(pick(usd(134.272), usd(130.816)));
  });

  it("V5 with no accrual at expiry: what ten hours past expiry cost, by who accrued the market when", async () => {
    // Opened two days out. What the position owes when it is closed ten hours past expiry.
    const run = async (atExpiry, hourly) => {
      const ctx = await book();
      if (atExpiry) await pokeAt(ctx, ctx.expiry);
      if (hourly) for (let h = 1; h <= 9; h++) await pokeAt(ctx, ctx.expiry + h * HOUR);
      return (await settleAt(ctx, ctx.expiry + 10 * HOUR, px(0.5))).boostPremium;
    };
    const untouched = await run(false, false);
    const expiryOnly = await run(true, false);
    const everyHour = await run(true, true);
    note(
      `premium owed ten hours past expiry: ${f6(untouched)} if nothing accrued the market since the open, ` +
        `${f6(expiryOnly)} if it was accrued at expiry, ${f6(everyHour)} if at expiry and every hour after`
    );
    expect(everyHour).to.equal(usd(6)); // two days at their midpoint (1.00) + ten hours at the floor (5.00)
    // As reviewed: one 58-hour interval with tau = 29 h, two floor-hours' worth, 1.00 in all.
    // Midpoint fix: the same interval with tau = 19 h, 58/19 of a floor-hour's worth: 1.526315.
    // Split fix: the 48 hours before expiry at their midpoint and the 10 after at the floor: 6.00.
    expect(untouched).to.equal(pick(usd(1), usd(1.526315), usd(6)));
    expect(expiryOnly).to.equal(pick(usd(2), usd(6)));
  });

  it("V6 the per-day rate marketView() reports past expiry against what a day of hourly accruals adds", async () => {
    const ctx = await book();
    await pokeAt(ctx, ctx.expiry + 2 * DAY);
    const quoted = (await ctx.engine.marketView(EVT)).boostPerDayLong;
    const from = await boostIndex(ctx);
    for (let h = 1; h <= 24; h++) await pokeAt(ctx, ctx.expiry + 2 * DAY + h * HOUR);
    const grown = (await boostIndex(ctx)) - from;
    note(`two days past expiry, per borrowed share: boostPerDayLong ${f18(quoted)}; a day of hourly accruals adds ${f18(grown)}`);
    expect(grown).to.equal(24n * FLOOR_HOUR);
    expect(quoted).to.equal(pick(2n * FLOOR_HOUR, 24n * FLOOR_HOUR)); // as reviewed: two floor-hours a day
  });

  it("V7 who gains from poking: a liquidator's hourly pokes decide whether a boosted position left open past expiry can be liquidated", async () => {
    // hazardScale 0.16: a floor-hour costs the 200 borrowed shares 8.00, and the two days up to expiry cost 16.00.
    const setup = async (pokes) => {
      const ctx = await book({ overrides: { hazardScale: px(0.16) } });
      await pokeAt(ctx, ctx.expiry);
      if (pokes) for (let h = 1; h <= 9; h++) await pokeAt(ctx, ctx.expiry + h * HOUR, ctx.liquidator);
      return ctx;
    };
    // Nobody pokes. Ten hours past expiry the price is still 0.50, where the position opened.
    const quiet = await setup(false);
    const at = quiet.expiry + 10 * HOUR;
    const data = await priceData(quiet, px(0.5), at);
    await time.setNextBlockTimestamp(at);
    const attempt = quiet.engine.connect(quiet.liquidator).liquidate(quiet.id, data, { gasLimit: 1_000_000 });
    // As reviewed the premium stands at 16 + 16 = 32, equity 68 of 100: not liquidatable.
    if (MODE === "") await expect(attempt).to.be.revertedWithCustomError(quiet.engine, "NotLiquidatable");
    else await expect(attempt).to.emit(quiet.engine, "PositionClosed"); // at the floor it is 16 + 80 = 96
    // The liquidator pokes each hour, then liquidates at the same second and the same price.
    const poked = await setup(true);
    const closed = await settleAt(poked, poked.expiry + 10 * HOUR, px(0.5), poked.liquidator, "liquidate");
    const reward = await poked.usdc.balanceOf(poked.liquidator.address);
    note(
      `ten hours past expiry at entry price: ${MODE === "" ? "not liquidatable (premium 32, equity 68)" : "liquidatable"} if nobody poked; ` +
        `after nine hourly pokes premium ${f6(closed.boostPremium)}, owner paid ${f6(closed.payout)}, liquidator paid ${f6(reward)}`
    );
    expect(closed.kind).to.equal(1n); // CloseKind.Liquidation
    expect(closed.boostPremium).to.equal(usd(96));
    expect(closed.payout).to.equal(0n);
    expect(reward).to.equal(usd(4)); // the 4.00 of equity left, short of the full 5% reward
  });

  it("C2 what limits it: from expiry on any leveraged position can be force-closed by anyone, reactionSeconds 0 included", async () => {
    const ctx = await book(); // reactionSeconds 0: no time limit on leverage before expiry
    const { engine, bob } = ctx;
    await time.setNextBlockTimestamp(ctx.expiry - 1); // the last second before expiry
    await expect(engine.connect(bob).forceClose(ctx.id, await priceData(ctx, px(0.5), ctx.expiry - 1), { gasLimit: 1_000_000 }))
      .to.be.revertedWithCustomError(engine, "NotForceClosable");
    const closed = await settleAt(ctx, ctx.expiry + 1, px(0.5), bob, "forceClose");
    note(`force-closed by a stranger one second past expiry: premium ${f6(closed.boostPremium)}, payout to the owner ${f6(closed.payout)}`);
    expect(closed.kind).to.equal(2n); // CloseKind.ForceClose
    expect(closed.payout).to.be.closeTo(usd(99), usd(0.001)); // 100 less the 1.00 owed up to expiry
    expect(await engine.openPositionCount()).to.equal(0n);
  });

  it("C3 what limits it: with reactionSeconds 120 the same 2x at 0.50 is force-closable from 72 minutes before expiry", async () => {
    const ctx = await book({ overrides: { reactionSeconds: 120 } });
    const { engine, bob } = ctx;
    // min(p,1-p) / (3 sqrt(p(1-p) * 120 / tau)) = sqrt(tau / 30) / 6: exactly 2x with 4,320 seconds left.
    await time.setNextBlockTimestamp(ctx.expiry - 4320);
    await expect(engine.connect(bob).forceClose(ctx.id, await priceData(ctx, px(0.5), ctx.expiry - 4320), { gasLimit: 1_000_000 }))
      .to.be.revertedWithCustomError(engine, "NotForceClosable");
    const closed = await settleAt(ctx, ctx.expiry - 4319, px(0.5), bob, "forceClose");
    expect(closed.kind).to.equal(2n);
    expect(await engine.openPositionCount()).to.equal(0n); // nothing leveraged is left to be charged past expiry
  });
});
