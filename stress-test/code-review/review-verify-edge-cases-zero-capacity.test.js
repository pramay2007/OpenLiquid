// Second-reviewer verification of one reported finding (PerpEngine.sol as of 2026-11-19 21:34,
// md5 3e62568f...; PriceOracle.sol md5 69efaec8...):
//
//   "Crowding fee switches off when capacity is zero, where the rule's clamp gives full skew"
//   PerpEngine._deltas:  if (cap == 0 || c.crowdingPerDay == 0 || s.longOI == s.shortOI) return (0, 0, 0, 0);
//
// Every "V" test states the INTENDED behaviour (R8: fee = notional * skew * crowdingPerDay with
// skew = clamp(imbalance / capacity, 0, 1), so a side that is over a capacity of nothing is at
// full skew, as it is over a capacity of one cent). A V test that passes refutes the finding; one
// that fails reproduces it, and the printed lines give the numbers.
// The "C" tests are controls that hold on the code as reviewed and must keep holding after a fix.
//
// (review-verify-edge-cases.test.js belongs to the verification of a different finding, so this
// one has its own file.)
//
// Run only this file:  npx hardhat test test/review-verify-edge-cases-zero-capacity.test.js

const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time, takeSnapshot } = require("@nomicfoundation/hardhat-network-helpers");
const { deploy, marketConfig, usd, px, BTC } = require("./helpers");

const DAY = 86_400;
const WAD = 10n ** 18n;
const P0 = px(60_000);
const DEPTH = usd(20_000_000); // capacity 10,000,000 a side at kappa 0.5
const RATE = px(0.001); // crowdingPerDay: 0.1% of notional a day at full skew
const FULL = usd(5_000); // one day at full skew on 5,000,000
const f6 = (v) => Number(ethers.formatUnits(v, 6));
const pct = (v) => `${Number(ethers.formatUnits(v, 16))}%`;
const note = (...a) => console.log("        ", ...a);
const PRICE_DATA = [
  "tuple(uint32 marketId,uint256 price,uint256 depthUsd,uint64 timestamp,bool resolved)[]",
  "bytes[]",
];

const closedEvent = (engine, receipt) =>
  receipt.logs
    .map((l) => {
      try {
        return engine.interface.parseLog(l);
      } catch {
        return null;
      }
    })
    .find((e) => e && e.name === "PositionClosed").args;

/** BTC at 0.1% a day and 20M of reference depth, holding one 5,000,000 long and nothing short. */
async function book(overrides = {}) {
  const ctx = await deploy();
  const { engine, oracle, vault, lp, alice, sign } = ctx;
  await engine.setMarket(BTC, marketConfig({ crowdingPerDay: RATE, ...overrides }));
  await vault.connect(lp).deposit(usd(5_000_000), lp.address);
  await ctx.push(BTC, P0, DEPTH);
  await engine.connect(alice).open(BTC, true, usd(5_000), 1000, false, "0x");
  ctx.t0 = await time.latest();
  ctx.id = (await engine.positionsOf(alice.address))[0].id;

  /** Relay one signed sample in a block stamped `ts`. */
  ctx.relayAt = async (ts, depth, price = P0) => {
    const { update, sig } = await sign(BTC, price, depth, ts);
    await time.setNextBlockTimestamp(ts);
    await oracle.push([update], [sig]);
  };
  ctx.pokeAt = async (ts) => {
    await time.setNextBlockTimestamp(ts);
    await engine.poke(BTC);
  };
  /** Crowding fee booked against the long in storage: notional * (index now - index at entry). */
  ctx.booked = async () => {
    const [s, p] = [await engine.states(BTC), await engine.positions(ctx.id)];
    return (p.notional * (s.cumFeeLong - p.entryFee)) / WAD;
  };
  /**
   * The fee booked over exactly one day in which every sample reported `depth`. The day is
   * bracketed by two accruals that both see that depth, so the answer does not depend on how the
   * time before it is priced.
   */
  ctx.dayAt = async (depth) => {
    const t = ctx.t0 + 60;
    await ctx.relayAt(t, depth);
    await ctx.pokeAt(t + 1);
    const start = await ctx.booked();
    await ctx.relayAt(t + DAY, depth);
    await ctx.pokeAt(t + 1 + DAY);
    return (await ctx.booked()) - start;
  };
  return ctx;
}

describe("Verify: the crowding fee at zero capacity", function () {
  this.timeout(300_000);

  it("C1 control: with 2 USDC of reference depth (capacity 1 USDC) a 5M one-sided day costs 5,000", async () => {
    const ctx = await book();
    const fee = await ctx.dayAt(usd(2));
    const mv = await ctx.engine.marketView(BTC);
    note(`depth 2 -> capacity ${f6(mv.sideCap)}: one day books ${f6(fee)}, marketView shows ${pct(mv.feePerDayLong)} a day`);
    expect(mv.sideCap).to.equal(usd(1));
    expect(fee).to.equal(FULL);
    expect(mv.feePerDayLong).to.equal(RATE);
  });

  it("V1 with no reference depth at all the same day costs the same 5,000, and the view shows 0.1% a day", async () => {
    const ctx = await book();
    const fee = await ctx.dayAt(0n);
    const mv = await ctx.engine.marketView(BTC);
    const pv = await ctx.engine.positionView(ctx.id);
    note(`depth 0 -> capacity ${f6(mv.sideCap)}: one day books ${f6(fee)}, marketView shows ${pct(mv.feePerDayLong)} a day`);
    note(`positionView.crowdingFee after that day: ${f6(pv.crowdingFee)}`);
    expect(mv.sideCap).to.equal(0n);
    expect({ feeForTheDay: f6(fee), feePerDayLong: pct(mv.feePerDayLong) }).to.deep.equal({
      feeForTheDay: 5_000,
      feePerDayLong: "0.1%",
    });
  });

  it("V2 the fee never falls as the reference book thins, down to nothing", async () => {
    const ctx = await book();
    const snap = await takeSnapshot();
    const rows = [];
    // 1 and 2 are millionths of a USDC: at kappa 0.5 a depth of 0.000001 also rounds to no capacity.
    for (const depth of [DEPTH, usd(10_000_000), usd(2_000_000), usd(2), 2n, 1n, 0n]) {
      const fee = await ctx.dayAt(depth);
      rows.push({ depth, cap: (await ctx.engine.marketView(BTC)).sideCap, fee });
      await snap.restore();
    }
    for (const r of rows) note(`depth ${f6(r.depth)} -> capacity ${f6(r.cap)} -> one day costs ${f6(r.fee)}`);
    // Controls: half skew at the depth the position was opened into, full skew once capacity is under the imbalance.
    expect(rows[0].fee).to.equal(usd(2_500));
    for (const r of rows.slice(1, 5)) expect(r.fee, `depth ${f6(r.depth)}`).to.equal(FULL);
    // The finding.
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i].fee, `one day at depth ${f6(rows[i].depth)} against depth ${f6(rows[i - 1].depth)}`).to.be.at.least(
        rows[i - 1].fee
      );
    }
  });

  it("V3 a winner gains nothing by closing with an empty-book sample instead of the normal one", async () => {
    const ctx = await book();
    const { engine, usdc, vault, alice, sign, hold, t0, id } = ctx;
    // A quiet day: the price ends 0.2% up, every sample carries the normal 20M of depth, and nobody
    // trades this market, so the engine has not accrued since the open.
    await time.increaseTo(t0 + DAY - 600);
    await hold(BTC, px(60_120), 590, DEPTH, 10);
    expect(await time.latest()).to.equal(t0 + DAY - 10);
    expect((await engine.states(BTC)).lastAccrual).to.equal(BigInt(t0));

    // The keeper serves every signed sample over HTTP (keeper/src/index.js, /prices and /stream),
    // and close() relays whichever one the caller attaches.
    const snap = await takeSnapshot();
    const closeWith = async (depth) => {
      const { update, sig } = await sign(BTC, px(60_120), depth, t0 + DAY);
      const data = ethers.AbiCoder.defaultAbiCoder().encode(PRICE_DATA, [[update], [sig]]);
      const before = await usdc.balanceOf(alice.address);
      await time.setNextBlockTimestamp(t0 + DAY);
      const ev = closedEvent(engine, await (await engine.connect(alice).close(id, data)).wait());
      const out = {
        crowding: ev.crowdingFee,
        pnl: ev.pnl,
        paid: (await usdc.balanceOf(alice.address)) - before,
        lp: await vault.totalAssets(),
      };
      await snap.restore();
      return out;
    };
    const normal = await closeWith(DEPTH);
    const thin = await closeWith(usd(2));
    const empty = await closeWith(0n);
    for (const [name, r] of [["20M", normal], ["2 USDC", thin], ["0", empty]]) {
      note(`closing sample depth ${name}: win ${f6(r.pnl)}, crowding fee ${f6(r.crowding)}, paid ${f6(r.paid)}, LPs left with ${f6(r.lp)}`);
    }
    note(`empty-book sample against the normal one: trader ${f6(empty.paid - normal.paid)}, LPs ${f6(empty.lp - normal.lp)}`);

    expect(normal.crowding, "a day at half skew").to.equal(usd(2_500)); // control
    expect(thin.pnl).to.equal(normal.pnl); // control: the fill is the same in all three
    expect(empty.pnl).to.equal(normal.pnl);
    expect(thin.crowding, "control: a thinner sample never books less").to.be.at.least(normal.crowding);
    expect(empty.crowding, "an empty book is charged like a nearly empty one").to.equal(thin.crowding);
    expect(empty.paid, "paid with the empty-book sample against the normal one").to.be.at.most(normal.paid);
  });

  it("V4 the daily rate does not jump from nothing to its maximum when an empty book comes back", async () => {
    const ctx = await book();
    const { engine, t0 } = ctx;
    const rate = async () => (await engine.marketView(BTC)).feePerDayLong;
    const seen = { normal: await rate() };
    await ctx.relayAt(t0 + 10, 0n); // the book empties
    await time.increaseTo(t0 + 3_600);
    seen.empty = await rate();
    await ctx.relayAt(t0 + 3_610, DEPTH); // an hour later it is back
    await time.increaseTo(t0 + 3_611);
    seen.back = await rate();
    const capBack = (await engine.marketView(BTC)).sideCap;
    await time.increaseTo(t0 + 3_610 + 900);
    seen.settled = await rate();
    note(
      `rate on a 5M one-sided book: ${pct(seen.normal)} normally | ${pct(seen.empty)} while the book is empty | ` +
        `${pct(seen.back)} a second after it returns (capacity ${f6(capBack)}) | ${pct(seen.settled)} fifteen minutes later`
    );
    expect(seen.normal).to.equal(RATE / 2n); // controls
    expect(seen.back).to.equal(RATE);
    expect(seen.settled).to.be.closeTo(RATE / 2n, RATE / 1000n);
    expect(seen.empty, "rate while the book is empty against the rate once it is barely back").to.be.at.least(seen.back);
  });

  it("V5 the same when the owner sets kappa to 0 to stop new opens: the side left open is at full skew", async () => {
    const ctx = await book();
    const { engine, bob } = ctx;
    await engine.setMarket(BTC, marketConfig({ crowdingPerDay: RATE, kappaBps: 0 }));
    await ctx.push(BTC, P0, DEPTH);
    const mv = await engine.marketView(BTC);
    note(`kappa 0, 20M of depth: capacity ${f6(mv.sideCap)}, 5M long against nothing, rate ${pct(mv.feePerDayLong)} a day`);
    expect(mv.sideCap).to.equal(0n);
    // Nobody can open the other side to bring the imbalance down while capacity is zero.
    await expect(engine.connect(bob).open(BTC, false, usd(1_000), 10, false, "0x")).to.be.revertedWithCustomError(
      engine,
      "SideCapExceeded"
    );
    expect(mv.feePerDayLong).to.equal(RATE);
  });

  it("C2 control: zero capacity charges nothing where there is nothing to charge (balanced book, or a zero rate)", async () => {
    const a = await book();
    await a.engine.connect(a.bob).open(BTC, false, usd(5_000), 1000, false, "0x"); // 5M short: balanced
    await a.relayAt((await time.latest()) + 5, 0n);
    let mv = await a.engine.marketView(BTC);
    expect([mv.sideCap, mv.feePerDayLong, mv.feePerDayShort]).to.deep.equal([0n, 0n, 0n]);

    const b = await book({ crowdingPerDay: 0n });
    await b.relayAt(b.t0 + 5, 0n);
    mv = await b.engine.marketView(BTC);
    expect([mv.sideCap, mv.feePerDayLong, mv.feePerDayShort]).to.deep.equal([0n, 0n, 0n]);
  });

  it("C3 control: whatever accrues at zero capacity is never taken from margin and never liquidates", async () => {
    const ctx = await book();
    const { engine, usdc, alice, liquidator, t0, id } = ctx;
    await ctx.relayAt(t0 + 60, 0n);
    await ctx.relayAt(t0 + DAY - 1, 0n, px(59_970)); // a day with an empty book; the price ends 0.05% down
    const v = await engine.positionView(id);
    note(`a day at zero capacity, 2,500 under water: crowding fee shown ${f6(v.crowdingFee)}, equity ${f6(v.equityAtMid)}`);
    expect(v.equityAtMid).to.equal(usd(2_500));
    expect(v.liquidatable).to.equal(false);
    await time.setNextBlockTimestamp(t0 + DAY);
    await expect(engine.connect(liquidator).liquidate(id, "0x")).to.be.revertedWithCustomError(engine, "NotLiquidatable");

    const before = await usdc.balanceOf(alice.address);
    await time.setNextBlockTimestamp(t0 + DAY + 1);
    const ev = closedEvent(engine, await (await engine.connect(alice).close(id, "0x")).wait());
    expect(ev.pnl).to.equal(-usd(2_500));
    expect(ev.crowdingFee).to.equal(0n);
    expect((await usdc.balanceOf(alice.address)) - before).to.equal(usd(2_500)); // margin less the loss, nothing else
  });
});
