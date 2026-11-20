// Second-reviewer verification of one reported finding (PerpEngine.sol as of 2026-11-19 21:34,
// md5 3e62568f...; PriceOracle.sol md5 69efaec8...; keeper/src/index.js as of 21:27):
//
//   "Fees and premiums accrue lazily and the whole un-accrued interval is priced with whatever
//    the feed says at the next touch; a resolution prices it at zero"
//
// Every "V" test states the INTENDED behaviour (R8, R9: a charge is a rate over time, so what a
// position owes for a stretch of time is set by the price and depth in force during that stretch,
// not by the first price to arrive after it). A V test that passes refutes the finding; one that
// fails reproduces it, and the printed lines give the numbers. Each is written to pass however
// the behaviour is fixed.
// The "C" tests are controls that hold on the code as reviewed and must keep holding after a fix.
//
// (review-verify-edge-cases.test.js belongs to the verification of a different finding, so this
// one has its own file.)
//
// Run only this file:  npx hardhat test test/review-verify-edge-cases-lazy-accrual.test.js

const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");
const { deploy, marketConfig, usd, px, BTC, EVT } = require("./helpers");

const DAY = 86_400;
const DEPTH = usd(2_000_000);
const SHARE = 10n ** 18n; // borrowedUnits per 0.000001 of a share
const f6 = (v) => Number(ethers.formatUnits(v, 6));
const note = (...a) => console.log("        ", ...a);
const PRICE_DATA = [
  "tuple(uint32 marketId,uint256 price,uint256 depthUsd,uint64 timestamp,bool resolved)[]",
  "bytes[]",
];
const encode = (s) => ethers.AbiCoder.defaultAbiCoder().encode(PRICE_DATA, [[s.update], [s.sig]]);

async function setup() {
  const ctx = await deploy();
  // A fix may have the oracle tell the engine before it applies a price. Where the contracts offer
  // that connection and the fixture has not made it, make it here as scripts/deploy.js would.
  const { oracle, engine } = ctx;
  const has = (name) => oracle.interface.hasFunction(name);
  if (has("setEngine") && has("engine") && (await oracle.engine()) === ethers.ZeroAddress) {
    await oracle.setEngine(engine.target);
  }
  return ctx;
}

/** An event market `daysOut` from its result, hazard share 1, Boost on, the mid at `p0`. */
async function eventBook({ p0 = 0.5, daysOut = 300, overrides = {}, lpDeposit = 1_000_000 } = {}) {
  const ctx = await setup();
  const { engine, vault, lp, push } = ctx;
  ctx.expiry = (await time.latest()) + daysOut * DAY;
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
      hazardScale: px(1),
      ...overrides,
    })
  );
  await vault.connect(lp).deposit(usd(lpDeposit), lp.address);
  await push(EVT, px(p0), DEPTH);
  return ctx;
}

/**
 * Alice opens a boosted position, and then nothing touches the engine for `days`: no trade, no
 * poke. The default is a 10x YES on 100 from 0.50, which borrows 1,800 shares.
 */
async function quietBoosted({ isLong = true, leverage = 10, margin = 100, days = 20, ...book } = {}) {
  const ctx = await eventBook(book);
  const { engine, alice } = ctx;
  await engine.connect(alice).open(EVT, isLong, usd(margin), leverage, true, "0x");
  const [pos] = await engine.positionsOf(alice.address);
  ctx.id = pos.id;
  ctx.borrowed = pos.position.borrowedUnits;
  await time.increaseTo(Number(pos.position.openedAt) + Math.round(days * DAY));
  return ctx;
}

/** A signed update stamped for the next block, encoded for an engine call's `priceData`. */
async function signedForNextBlock(ctx, marketId, price, depth, resolved = false) {
  const ts = (await time.latest()) + 1;
  await time.setNextBlockTimestamp(ts);
  return encode(await ctx.sign(marketId, price, depth, ts, resolved));
}

async function closedEvent(engine, tx) {
  const receipt = await tx.wait();
  for (const log of receipt.logs) {
    try {
      const parsed = engine.interface.parseLog(log);
      if (parsed?.name === "PositionClosed") return parsed.args;
    } catch {
      /* another contract's log */
    }
  }
  throw new Error("no PositionClosed event");
}

// 1,800 borrowed shares, p(1-p) = 0.25, 20 of the 300 days, time left taken at the interval's midpoint.
const FAIR = (1800 * 0.25 * 20) / 290; // 31.03

describe("Verify: a quiet stretch is charged at whatever price arrives after it", function () {
  this.timeout(300_000);

  it("C1 control: 20 quiet days at 0.50 cost a boosted 10x YES on 100 the 31.03 the formula gives", async () => {
    const { engine, usdc, alice, push, id, borrowed } = await quietBoosted();
    expect(borrowed).to.equal(usd(1800) * SHARE);
    const shown = (await engine.positionView(id)).boostPremium;
    await engine.poke(EVT);
    const booked = (await engine.positionView(id)).boostPremium;
    await push(EVT, px(0.5), DEPTH); // a fresh price at the same level, so the owner can close
    const b0 = await usdc.balanceOf(alice.address);
    await engine.connect(alice).close(id, "0x");
    const paid = f6((await usdc.balanceOf(alice.address)) - b0);
    note(`premium shown ${f6(shown)}; booked by a poke ${f6(booked)}; closing flat pays back ${paid} of the 100`);
    expect(f6(shown)).to.be.closeTo(FAIR, 0.01);
    expect(f6(booked)).to.be.closeTo(FAIR, 0.01);
    expect(paid).to.be.closeTo(100 - FAIR, 0.01);
  });

  it("C2 control: R10 holds through a result. The vault pays no more than margin + reserve and stays covered", async () => {
    const { engine, vault, usdc, alice, bob, push, id } = await quietBoosted();
    const pos = (await engine.positionView(id)).position;
    await push(EVT, px(1), DEPTH, true);
    expect(await vault.cash()).to.be.gte((await vault.marginHeld()) + (await vault.reserved()));
    const cash0 = await vault.cash();
    const b0 = await usdc.balanceOf(alice.address);
    await engine.connect(bob).close(id, "0x");
    const paid = (await usdc.balanceOf(alice.address)) - b0;
    expect(paid).to.be.lte(pos.margin + pos.reserve);
    expect(cash0 - (await vault.cash()), "nobody is staking, so the trader's payout is all that leaves").to.equal(paid);
    expect(await vault.marginHeld()).to.equal(0n);
    expect(await vault.reserved()).to.equal(0n);
  });

  it("V1 (a) a result relayed straight to the oracle leaves the 20 days of premium owed", async () => {
    const { engine, usdc, alice, bob, push, id } = await quietBoosted();
    const before = await engine.positionView(id);
    await push(EVT, px(1), DEPTH, true); // what keeper/src/index.js relay() does: oracle.push, nothing else
    const after = await engine.positionView(id);
    const b0 = await usdc.balanceOf(alice.address);
    const closed = await closedEvent(engine, await engine.connect(bob).close(id, "0x")); // anyone may settle
    const paid = f6((await usdc.balanceOf(alice.address)) - b0);
    note(
      `premium owed one block before the result ${f6(before.boostPremium)}; once it is in ${f6(after.boostPremium)}; ` +
        `charged at settlement ${f6(closed.boostPremium)}; paid out ${paid}`
    );
    expect(f6(before.boostPremium), "premium owed one block before the result").to.be.closeTo(FAIR, 0.01);
    expect(f6(after.boostPremium), "premium owed once the result is in").to.be.closeTo(FAIR, 0.01);
    expect(f6(closed.boostPremium), "premium charged at settlement").to.be.closeTo(FAIR, 0.01);
    expect(paid, "paid: 100 + 90% of (1,000 - 31.03)").to.be.closeTo(100 + 0.9 * (1000 - FAIR), 0.01);
  });

  it("V2 (a) the same when the result arrives inside the settlement call itself", async () => {
    const ctx = await quietBoosted();
    const { engine, usdc, alice, bob, id } = ctx;
    const data = await signedForNextBlock(ctx, EVT, px(1), DEPTH, true);
    const b0 = await usdc.balanceOf(alice.address);
    // keeper sweep(): engine.close(id, priceDataFor(market)). _pushPrices runs before _accrue.
    const closed = await closedEvent(engine, await engine.connect(bob).close(id, data));
    const paid = f6((await usdc.balanceOf(alice.address)) - b0);
    note(`result carried by close(): premium charged ${f6(closed.boostPremium)}; paid out ${paid}`);
    expect(f6(closed.boostPremium), "premium charged at settlement").to.be.closeTo(FAIR, 0.01);
    expect(paid, "paid: 100 + 90% of (1,000 - 31.03)").to.be.closeTo(100 + 0.9 * (1000 - FAIR), 0.01);
  });

  it("V3 (b) 20 quiet days at 0.50 cost the same whether or not anyone touched the market before the price moved", async () => {
    const run = async (pokeFirst) => {
      const { engine, push, id } = await quietBoosted();
      if (pokeFirst) await engine.poke(EVT);
      await push(EVT, px(0.99), DEPTH); // then one update takes the mid to 0.99
      return f6((await engine.positionView(id)).boostPremium);
    };
    const poked = await run(true);
    const untouched = await run(false);
    note(`20 days at 0.50, then 0.99: premium owed ${poked} if someone poked before the move, ${untouched} if nobody did`);
    expect(poked, "poked before the move").to.be.closeTo(FAIR, 0.01);
    expect(untouched, "nobody touched the market before the move").to.be.closeTo(FAIR, 0.01);
  });

  it("V4 (b) the same when the new price arrives inside another trader's own call to the engine", async () => {
    const ctx = await eventBook();
    const { engine, alice, bob } = ctx;
    await engine.connect(alice).open(EVT, true, usd(100), 10, true, "0x");
    await engine.connect(bob).open(EVT, true, usd(100), 1, false, "0x"); // an outright bet: nothing borrowed
    const [a] = await engine.positionsOf(alice.address);
    const [b] = await engine.positionsOf(bob.address);
    await time.increaseTo(Number(a.position.openedAt) + 20 * DAY);
    const data = await signedForNextBlock(ctx, EVT, px(0.99), DEPTH);
    await engine.connect(bob).close(b.id, data); // the engine relays the price, then accrues with it
    const owed = f6((await engine.positionView(a.id)).boostPremium);
    note(`20 days at 0.50, then 0.99 carried by someone else's close(): premium owed ${owed}`);
    expect(owed).to.be.closeTo(FAIR, 0.01);
  });

  it("V5 the other direction: a boosted NO held while the mid sat at 0.90 is not charged at 0.50 for that time", async () => {
    const fair = (4000 * 0.09 * 20) / 290; // 24.83
    const run = async (pokeFirst) => {
      const { engine, push, id, borrowed } = await quietBoosted({ p0: 0.9, isLong: false, leverage: 5 });
      expect(borrowed).to.equal(usd(4000) * SHARE); // 500 of NO at 0.10 is 5,000 shares; 1,000 are paid for
      if (pokeFirst) await engine.poke(EVT);
      await push(EVT, px(0.5), DEPTH); // the odds fall to 0.50: this position is winning
      return f6((await engine.positionView(id)).boostPremium);
    };
    const poked = await run(true);
    const untouched = await run(false);
    note(`20 days at 0.90, then 0.50: premium owed ${poked} if someone poked before the move, ${untouched} if nobody did`);
    expect(poked, "poked before the move").to.be.closeTo(fair, 0.01);
    expect(untouched, "nobody touched the market before the move").to.be.closeTo(fair, 0.01);
  });

  it("V6 crowding fee, other markets: 20 days at one depth are not re-priced by the next depth reading", async () => {
    // scripts/deploy.js "crypto": 0.05% of notional per day at full skew, capacity half the persistent depth.
    const run = async (pokeFirst) => {
      const { engine, vault, usdc, lp, alice, push, hold } = await setup();
      await engine.setMarket(BTC, marketConfig({ maxGapBps: 20, crowdingPerDay: px(0.0005) }));
      await vault.connect(lp).deposit(usd(5_000_000), lp.address);
      await push(BTC, px(60_000), usd(20_000_000)); // capacity 10,000,000 a side
      await engine.connect(alice).open(BTC, true, usd(10_000), 100, false, "0x"); // 1,000,000 long: skew 0.1
      const [pos] = await engine.positionsOf(alice.address);
      await time.increaseTo(Number(pos.position.openedAt) + 20 * DAY);
      const quiet = f6((await engine.positionView(pos.id)).crowdingFee);
      if (pokeFirst) await engine.poke(BTC);
      await push(BTC, px(60_000), usd(2_000_000)); // one thinner reading of the reference book: skew 1
      const accrued = f6((await engine.positionView(pos.id)).crowdingFee);
      // The fee is only ever taken from a win, so let the position win: +2%, held until the slow price is there.
      await hold(BTC, px(61_200), 600, usd(2_000_000), 10);
      const b0 = await usdc.balanceOf(alice.address);
      const closed = await closedEvent(engine, await engine.connect(alice).close(pos.id, "0x"));
      return { quiet, accrued, charged: f6(closed.crowdingFee), paid: f6((await usdc.balanceOf(alice.address)) - b0) };
    };
    const poked = await run(true);
    const untouched = await run(false);
    note("poked before the reading:", JSON.stringify(poked));
    note("nobody touched the market:", JSON.stringify(untouched));
    expect(poked.quiet, "20 days at skew 0.1: 1,000,000 x 0.1 x 0.05% x 20").to.be.closeTo(1_000, 0.01);
    expect(untouched.quiet).to.be.closeTo(1_000, 0.01);
    expect(poked.accrued, "poked before the reading").to.be.closeTo(1_000, 1);
    expect(untouched.accrued, "nobody touched the market before the reading").to.be.closeTo(1_000, 1);
    expect(untouched.charged, "crowding fee taken at the close").to.be.closeTo(poked.charged, 1);
    expect(untouched.paid, "paid at the close").to.be.closeTo(poked.paid, 1);
  });

  it("V7 deployed event parameters, eleven days out: twelve quiet hours are charged at the odds that held", async () => {
    // scripts/deploy.js "event" (reactionSeconds 120, 100,000 a position), as far from its result as
    // the BTC-on-November-30 market is today. A boosted 10x YES on 1,000 from 0.50 borrows 18,000 shares.
    const fair = (18_000 * 0.25 * 0.5) / 10.75; // 209.30
    const run = async (pokeFirst) => {
      const { engine, push, id, borrowed } = await quietBoosted({
        margin: 1_000,
        days: 0.5,
        daysOut: 11,
        lpDeposit: 2_000_000,
        overrides: { reactionSeconds: 120, maxAge: 20, maxPositionNotional: usd(100_000) },
      });
      expect(borrowed).to.equal(usd(18_000) * SHARE);
      if (pokeFirst) await engine.poke(EVT);
      await push(EVT, px(0.9), DEPTH); // news: the odds jump to 0.90
      return f6((await engine.positionView(id)).boostPremium);
    };
    const poked = await run(true);
    const untouched = await run(false);
    note(`12 hours at 0.50, then 0.90: premium owed ${poked} if someone poked before the move, ${untouched} if nobody did`);
    expect(poked, "poked before the move").to.be.closeTo(fair, 0.05);
    expect(untouched, "nobody touched the market before the move").to.be.closeTo(fair, 0.05);
  });

  it("V8 R4: a small move against a position does not liquidate it by re-pricing the quiet days behind it", async () => {
    // A boosted 5x NO on 100 from 0.10, 30 days out: 444.44 borrowed NO shares. 20 quiet days at 0.10
    // cost 444.44 x 0.09 x 20 / 20 = 40.00. Then the odds go to 0.15: the position is down 27.78,
    // so its equity is 32.22, above the 20 at which it can be liquidated.
    const run = async (pokeFirst) => {
      const { engine, usdc, alice, liquidator, push, id } = await quietBoosted({
        p0: 0.1,
        isLong: false,
        leverage: 5,
        daysOut: 30,
      });
      if (pokeFirst) await engine.poke(EVT);
      await push(EVT, px(0.15), DEPTH);
      const v = await engine.positionView(id);
      const b0 = await usdc.balanceOf(alice.address);
      const liquidated = await engine
        .connect(liquidator)
        .liquidate(id, "0x")
        .then(() => true)
        .catch(() => false);
      return {
        premium: f6(v.boostPremium),
        equityAtMid: f6(v.equityAtMid),
        liquidatable: v.liquidatable,
        liquidated,
        returnedToTrader: f6((await usdc.balanceOf(alice.address)) - b0),
        liquidatorPaid: f6(await usdc.balanceOf(liquidator.address)),
      };
    };
    const poked = await run(true);
    const untouched = await run(false);
    note("poked before the move:", JSON.stringify(poked));
    note("nobody touched the market:", JSON.stringify(untouched));
    expect(poked.equityAtMid).to.be.closeTo(32.22, 0.01);
    expect(poked.liquidated).to.equal(false);
    expect(untouched.equityAtMid, "equity when nobody touched the market before the move").to.be.closeTo(32.22, 0.01);
    expect(untouched.liquidated, "liquidated although its equity for the time held is above maintenance").to.equal(false);
  });
});
