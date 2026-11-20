// Review: spec conformance and arithmetic (PerpEngine.sol, PriceOracle.sol).
//
// Block 1 states an INTENDED rule in each test and asserts it. A failing test there is a place
// where the contracts do not do what the rule (or the whitepaper) says; the numbers are printed.
// Block 2 holds checks that pass: formulas verified against the rules, to the last unit where
// that is meaningful.
//
//   npx hardhat test test/review-spec-math.test.js

const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");
const { deploy, marketConfig, usd, px, fmtUsd, BTC, EVT } = require("./helpers");

const DAY = 86_400;
const HOUR = 3_600;
const WAD = 10n ** 18n;
const UNIT = 10n ** 36n;
const BPS = 10_000n;
const DEPTH = usd(2_000_000);

const coder = ethers.AbiCoder.defaultAbiCoder();
const PRICE_DATA = ["tuple(uint32 marketId,uint256 price,uint256 depthUsd,uint64 timestamp,bool resolved)[]", "bytes[]"];
const encode = (signed) => coder.encode(PRICE_DATA, [signed.map((s) => s.update), signed.map((s) => s.sig)]);
const note = (...a) => console.log("        ", ...a);
const fe = (v) => ethers.formatEther(v);

async function eventSetup(overrides = {}, daysOut = 300, p0 = 0.5) {
  const ctx = await deploy();
  const expiry = (await time.latest()) + daysOut * DAY;
  ctx.expiry = expiry;
  await ctx.engine.setMarket(
    EVT,
    marketConfig({
      isEvent: true,
      maxLeverage: 50,
      profitFeeBps: 1000,
      maxGapBps: 500,
      expiry,
      maxPositionNotional: usd(1_000_000),
      ...overrides,
    })
  );
  await ctx.vault.connect(ctx.lp).deposit(usd(1_000_000), ctx.lp.address);
  await ctx.push(EVT, px(p0), DEPTH);
  return ctx;
}

async function btcSetup(overrides = {}, p0 = px(60_000)) {
  const ctx = await deploy();
  await ctx.engine.setMarket(BTC, marketConfig(overrides));
  await ctx.vault.connect(ctx.lp).deposit(usd(5_000_000), ctx.lp.address);
  await ctx.push(BTC, p0);
  return ctx;
}

async function closedArgs(engine, txPromise) {
  const rc = await (await txPromise).wait();
  for (const l of rc.logs) {
    try {
      const e = engine.interface.parseLog(l);
      if (e && e.name === "PositionClosed") return e.args;
    } catch {
      /* not an engine log */
    }
  }
  throw new Error("no PositionClosed event");
}

/** PriceOracle._expNeg, in the same integer arithmetic. */
const LN2 = 693147180559945309n;
function expNeg(x) {
  const k = x / LN2;
  if (k >= 60n) return 0n;
  const r = x - k * LN2;
  let term = WAD;
  let sum = WAD;
  for (let i = 1n; i <= 16n; i++) {
    term = (term * r) / (WAD * i);
    sum += term;
  }
  return (WAD * WAD) / sum >> k;
}

describe("REVIEW spec-math, block 1: intended rules the contracts do not meet (each failure is a finding)", () => {
  it("A. R11: a market whose id was poked before it was registered is still listed and marked in the LP share price", async () => {
    const { engine, vault, lp, alice, bob, push, hold } = await deploy();

    // Anyone, any id, before the owner's setMarket lands. (A fix may make this call revert instead.)
    await engine.connect(bob).poke(BTC).catch(() => {});
    await engine.setMarket(BTC, marketConfig());
    await vault.connect(lp).deposit(usd(5_000_000), lp.address);
    await push(BTC, px(60_000));
    await engine.connect(alice).open(BTC, true, usd(10_000), 1000, false, "0x"); // 10M long
    await hold(BTC, px(60_030), 10); // +0.05%: traders are up 5,000

    const count = await engine.marketCount();
    const listed = (await engine.allMarkets()).length;
    const nav = await vault.totalAssets();
    note(`marketCount ${count}, allMarkets().length ${listed}, unrealizedPnl ${fmtUsd(await engine.unrealizedPnl())}, LP NAV ${fmtUsd(nav)}`);
    expect(count, "marketCount").to.equal(1n);
    expect(listed, "allMarkets").to.equal(1);
    expect(nav, "NAV marks the 5,000 owed").to.be.closeTo(usd(4_995_000), usd(1));
  });

  it("B1. R9: a boosted position pays the premium for the time it was held when the result arrives with no accrual in between", async () => {
    const { engine, usdc, alice, push } = await eventSetup({ hazardScale: px(1), boostEnabled: true });
    await engine.connect(alice).open(EVT, true, usd(100), 10, true, "0x"); // 2,000 shares, 1,800 borrowed
    const [pos] = await engine.positionsOf(alice.address);
    await time.increase(10 * DAY); // nobody trades this market; the keeper never calls poke

    const owed = (await engine.positionView(pos.id)).boostPremium; // 1,800 * 0.50 * 0.50 * 10 / 295 days
    await push(EVT, px(1), DEPTH, true); // the result, relayed straight to the oracle as the keeper does
    const before = await usdc.balanceOf(alice.address);
    const closed = await closedArgs(engine, engine.close(pos.id, "0x"));
    const paid = (await usdc.balanceOf(alice.address)) - before;
    note(`premium owed the second before the result ${fmtUsd(owed)}; charged at settlement ${fmtUsd(closed.boostPremium)}; payout ${fmtUsd(paid)}`);
    expect(owed).to.be.closeTo(usd(15.25), usd(0.05));
    expect(closed.boostPremium, "premium for ten days held").to.be.closeTo(owed, usd(0.05));
  });

  it("B2. R9: the premium a position has built up never falls as time passes", async () => {
    const { engine, usdc, alice, push, hold } = await eventSetup({ hazardScale: px(1), boostEnabled: true });
    await engine.connect(alice).open(EVT, true, usd(100), 10, true, "0x");
    const [pos] = await engine.positionsOf(alice.address);
    await time.increase(10 * DAY); // ten quiet days at 50c
    const owedAt50 = (await engine.positionView(pos.id)).boostPremium;

    await hold(EVT, px(0.9), 3000, DEPTH, 60); // the odds move to 90c; prices go to the oracle, nobody touches the engine
    const owedAt90 = (await engine.positionView(pos.id)).boostPremium;
    const closed = await closedArgs(engine, engine.connect(alice).close(pos.id, "0x"));
    note(`premium for ten days at 50c: ${fmtUsd(owedAt50)}; fifty minutes later at 90c: ${fmtUsd(owedAt90)}; charged at close: ${fmtUsd(closed.boostPremium)}`);
    // The ten days at 50c are re-priced at p(1-p) = 0.09, the price at the moment of the first accrual.
    expect(owedAt90, "accrued premium is monotone in time").to.be.greaterThanOrEqual(owedAt50);
    expect(closed.boostPremium).to.be.greaterThanOrEqual(owedAt50);
  });

  it("C. R8/R9: past expiry the rate is the 1-hour floor, however rarely the index is brought up to date", async () => {
    const run = async (pokes) => {
      const { engine, alice, expiry } = await eventSetup({ hazardScale: px(0.01), boostEnabled: true }, 3);
      await engine.connect(alice).open(EVT, true, usd(100), 2, true, "0x"); // 400 shares, 200 borrowed
      await time.setNextBlockTimestamp(expiry);
      await engine.poke(EVT); // index exact up to expiry
      const at = (await engine.states(EVT)).cumBoostLong;
      for (let i = 1; i <= pokes; i++) {
        await time.setNextBlockTimestamp(expiry + (i * 6 * HOUR) / pokes);
        await engine.poke(EVT);
      }
      return (await engine.states(EVT)).cumBoostLong - at; // per share, over the six hours after expiry
    };
    const often = await run(12);
    const once = await run(1);
    // 0.50 * 0.50 * 1% * 6 h / 1 h = 0.015 a share whichever way it is counted.
    note(`six hours past expiry, per borrowed share: twelve accruals ${fe(often)}, one accrual ${fe(once)}`);
    expect(often).to.equal(px(0.015));
    expect(once, "one accrual over the same six hours").to.equal(often);
  });

  it("D. R11: the LP share price already carries a capped position at its cap, so a deposit around its collection earns nothing", async () => {
    const { engine, vault, usdc, lp, alice, bob, carol, push, hold } = await deploy();
    const expiry = (await time.latest()) + 300 * DAY;
    await engine.setMarket(
      EVT,
      marketConfig({ isEvent: true, maxLeverage: 50, profitFeeBps: 1000, maxGapBps: 500, expiry, maxPositionNotional: usd(1_000_000) })
    );
    await engine.setMarket(BTC, marketConfig());
    await vault.connect(lp).deposit(usd(1_000_000), lp.address);
    await push(EVT, px(0.5), DEPTH);
    await push(BTC, px(60_000));

    await engine.connect(alice).open(EVT, true, usd(1_000), 25, false, "0x"); // 25,000 of YES, can win 1,000 at most
    await engine.connect(bob).open(BTC, true, usd(5_000), 1000, false, "0x"); // any other position: 50,000 reserved, flat
    expect(await vault.reserved()).to.equal(usd(51_000));

    await hold(EVT, px(0.9), 3000, DEPTH, 60); // the odds jump; Alice is far past her win line at 0.52
    const [pos] = await engine.positionsOf(alice.address);
    expect(pos.collectable).to.equal(true);
    const mark = await engine.unrealizedPnl();
    const navBefore = await vault.totalAssets();

    const c0 = await usdc.balanceOf(carol.address);
    await vault.connect(carol).deposit(usd(1_000_000), carol.address);
    await engine.connect(carol).collect(pos.id, "0x"); // pays Alice 1,000 + 1,000 - 100
    const navAfter = (await vault.totalAssets()) - usd(1_000_000);
    await vault.connect(carol).redeem(await vault.balanceOf(carol.address), carol.address, carol.address);
    const gain = (await usdc.balanceOf(carol.address)) - c0;
    note(`Alice can be owed at most 1,000; unrealizedPnl() reports ${fmtUsd(mark)}`);
    note(`LP NAV before the collect ${fmtUsd(navBefore)}, after ${fmtUsd(navAfter)}; Carol's deposit-collect-redeem gain ${fmtUsd(gain)}`);
    // Owed to Alice is 1,000 whatever the odds do next; the 100 fee is the only thing a collect can add.
    expect(navBefore, "NAV with Alice marked at her cap").to.be.closeTo(usd(999_000), usd(101));
    expect(gain, "risk-free gain taken from the other LPs").to.be.lessThan(usd(100));
  });

  it("D2. R11: margin is not LP money, so one trader's margin is never counted toward the LP share price", async () => {
    const { engine, vault, lp, alice, bob, liquidator, push } = await deploy();
    const expiry = (await time.latest()) + 300 * DAY;
    await engine.setMarket(
      EVT,
      marketConfig({ isEvent: true, maxLeverage: 50, profitFeeBps: 1000, maxGapBps: 500, expiry, maxPositionNotional: usd(1_000_000) })
    );
    await engine.setMarket(BTC, marketConfig());
    await vault.connect(lp).deposit(usd(1_000_000), lp.address);
    await push(EVT, px(0.5), DEPTH);
    await push(BTC, px(60_000));
    await engine.connect(alice).open(EVT, true, usd(1_000), 25, false, "0x"); // can lose 1,000 at most
    await engine.connect(bob).open(BTC, true, usd(5_000), 1000, false, "0x"); // flat; his 5,000 margin is his

    await push(EVT, px(0.3), DEPTH); // the odds jump the other way: Alice is 10,000 under water on paper
    const navBefore = await vault.totalAssets();
    const [pos] = await engine.positionsOf(alice.address);
    await engine.connect(liquidator).liquidate(pos.id, "0x");
    const navAfter = await vault.totalAssets();
    note(`LP NAV with Alice's loss marked: ${fmtUsd(navBefore)}; after she is liquidated: ${fmtUsd(navAfter)}`);
    // The vault has won Alice's 1,000 and nothing else. The other 5,000 it shows is Bob's margin.
    expect(navBefore, "NAV before the liquidation").to.be.closeTo(usd(1_001_000), usd(1));
    expect(navAfter).to.be.closeTo(usd(1_001_000), usd(1));
  });

  it("D3. R10/R11: a trader cannot take the profit share back by depositing into the vault around their own close", async () => {
    const run = async (sandwich) => {
      const { engine, vault, usdc, alice, hold } = await btcSetup(); // 5M of LP money, 5% profit share
      const start = await usdc.balanceOf(alice.address);
      await engine.connect(alice).open(BTC, true, usd(1_000), 1000, false, "0x"); // 1M long
      await hold(BTC, px(60_300), 1200); // +0.5%, held: 5,000 of profit, 250 of it the vault's share
      const [pos] = await engine.positionsOf(alice.address);
      if (sandwich) await vault.connect(alice).deposit(usd(45_000_000), alice.address);
      await engine.connect(alice).close(pos.id, "0x");
      // (If the vault later locks fresh deposits this redeem reverts, and nothing is recovered.)
      if (sandwich) await vault.connect(alice).redeem(await vault.balanceOf(alice.address), alice.address, alice.address).catch(() => {});
      return (await usdc.balanceOf(alice.address)) - start;
    };
    const plain = await run(false);
    const wrapped = await run(true);
    note(`net of a 5,000 win: closed normally ${fmtUsd(plain)}; with a deposit and redeem in the same minute ${fmtUsd(wrapped)}`);
    expect(wrapped - plain, "profit share recovered through the share price").to.be.lessThan(usd(5));
  });

  it("E. views: boostPerDay is what holding one borrowed share for the next day adds to the index", async () => {
    const { engine } = await eventSetup({ hazardScale: px(1), boostEnabled: true }, 3);
    await engine.poke(EVT);
    const quoted = (await engine.marketView(EVT)).boostPerDayLong;
    const at = (await engine.states(EVT)).cumBoostLong;
    await time.increase(DAY - 1);
    await engine.poke(EVT);
    const charged = (await engine.states(EVT)).cumBoostLong - at;
    // Three days out at 50c. Quoted: 0.25 / 3.5 days. Charged for the next day: 0.25 / 2.5 days.
    note(`quoted per share per day ${fe(quoted)}, charged over the next day ${fe(charged)}`);
    expect(charged).to.be.closeTo(quoted, quoted / 20n);
  });

  it("F. R1: a price that has only just been relayed has no effect on the slow price, whatever its timestamp says", async () => {
    // The exploit replay's numbers: ETH at 3,000, a +0.12% push, 9.9M of 1000x long open against it.
    const P0 = px(3_000);
    const PUSHED = px(3_003.6);
    const { engine, oracle, usdc, alice, sign } = await btcSetup({}, P0);
    const start = await usdc.balanceOf(alice.address);
    await engine.connect(alice).open(BTC, true, usd(9_900), 1000, false, "0x");
    const [pos] = await engine.positionsOf(alice.address);

    // The mid is pushed for one sample. Nobody relays it or the samples after it for 25 s
    // (off localhost the keeper's heartbeat is 120 s), then the attacker relays that one sample with the close.
    const t = await time.latest();
    const spike = await sign(BTC, PUSHED, usd(20_000_000), t + 1);
    await time.setNextBlockTimestamp(t + 26);
    const closed = await closedArgs(engine, engine.connect(alice).close(pos.id, encode([spike])));
    const profit = (await usdc.balanceOf(alice.address)) - start;
    const feed = await oracle.read(BTC);
    note(`close filled at ${fe(closed.exitPrice)} (mid ${fe(feed.mid)}); attacker profit ${fmtUsd(profit)}`);
    // 1 - e^(-25/60) = 34% of the push is credited to a price that was on-chain for zero seconds.
    expect(closed.exitPrice, "fill against a price that was never held").to.be.closeTo(P0, px(0.1));
    expect(fmtUsd(profit)).to.be.lessThan(52_000 / 50); // the bound exploit.test.js asserts for a close into a fresh push
  });

  it("F2. R3: depth that has only just been relayed does not count toward capacity, whatever its timestamp says", async () => {
    const { engine, oracle, sign } = await btcSetup(); // 20M of depth, capacity 10M a side
    const t = await time.latest();
    const flash = await sign(BTC, px(60_000), usd(200_000_000), t + 1); // ten times the depth, for one sample
    await time.setNextBlockTimestamp(t + 26);
    await oracle.push([flash.update], [flash.sig]); // relayed 25 s after it was signed, with nothing newer
    const cap = (await engine.marketView(BTC)).sideCap;
    note(`capacity in the block the flashed depth arrives: ${fmtUsd(cap)} (10,000,000 before it)`);
    // engine.test.js expects under 13M one second after a fresh relay of the same jump.
    expect(cap).to.be.lessThan(usd(13_000_000));
  });

  it("G. R8: with no capacity left the crowded side is at full skew, not at none", async () => {
    const { engine, alice, push } = await btcSetup({ crowdingPerDay: px(0.001) });
    await engine.connect(alice).open(BTC, true, usd(4_000), 1000, false, "0x"); // 4M long, nothing short
    await push(BTC, px(60_000), 0n); // the reference book reports no depth
    await time.increase(DAY);
    await push(BTC, px(60_000), 0n);
    const [pos] = await engine.positionsOf(alice.address);
    note(`crowding fee accrued over a day at zero capacity: ${fmtUsd(pos.crowdingFee)} (at any depth from 1 cent to 8M it is 4,000)`);
    expect(pos.crowdingFee).to.be.closeTo(usd(4_000), usd(50));
  });

  it("H. R2: an open is refused whenever the gap is above maxGap, including by less than a whole basis point", async () => {
    const { engine, oracle, alice, push } = await btcSetup(); // maxGapBps 10
    await push(BTC, px(60_066)); // +11.0 bps in one update
    let opened = true;
    try {
      await engine.connect(alice).open(BTC, false, usd(100), 10, false, "0x");
    } catch {
      opened = false;
    }
    const f = await oracle.read(BTC); // same block time as the open
    const gapBps = Number(((f.mid - f.slow) * 1_000_000n) / f.slow) / 100;
    note(`gap in the block of the open: ${gapBps} bps against a 10 bps limit; open accepted: ${opened}`);
    expect(gapBps).to.be.greaterThan(10);
    expect(opened, "open accepted above the limit").to.equal(false);
  });

  it("I. views: a long is liquidatable exactly when the mid is at or below its reported liquidation price", async () => {
    const { engine, alice, liquidator, push } = await eventSetup({ hazardScale: px(1), boostEnabled: true });
    await engine.connect(alice).open(EVT, true, usd(100), 10, true, "0x");
    await time.increase(56 * DAY); // the premium has grown past 80% of the stake
    await push(EVT, px(0.5005), DEPTH); // the odds are a touch ABOVE entry
    const [pos] = await engine.positionsOf(alice.address);
    note(
      `premium ${fmtUsd(pos.boostPremium)}, equity ${fmtUsd(pos.equityAtMid)}, liquidatable ${pos.liquidatable}, ` +
        `reported liquidation price ${fe(pos.liquidationPrice)}, mid 0.5005`
    );
    expect(pos.liquidatable).to.equal(true);
    await engine.connect(liquidator).liquidate.staticCall(pos.id, "0x"); // and it really is
    expect(pos.liquidationPrice, "reported line is at or above the mid it is liquidatable at").to.be.greaterThanOrEqual(px(0.5005));
  });

  it("J. whitepaper: a 1x prediction-market position is an outright bet, left alone until the result", async () => {
    const { engine, usdc, alice, liquidator, push } = await eventSetup();
    await engine.connect(alice).open(EVT, true, usd(100), 1, false, "0x"); // 200 YES shares, fully paid for
    const a0 = await usdc.balanceOf(alice.address);
    await push(EVT, px(0.09), DEPTH); // the other side scores: 9c, but the match is not over
    const [pos] = await engine.positionsOf(alice.address);
    let liquidated = true;
    try {
      await engine.connect(liquidator).liquidate(pos.id, "0x");
    } catch {
      liquidated = false;
    }
    const back = (await usdc.balanceOf(alice.address)) - a0;
    note(
      `1x YES bought at 50c, odds at 9c: liquidatable ${pos.liquidatable}, liquidated ${liquidated}; ` +
        `trader handed ${fmtUsd(back)}, liquidator ${fmtUsd(await usdc.balanceOf(liquidator.address))}; the bet no longer exists`
    );
    expect(liquidated, "a fully collateralised position was closed for its owner").to.equal(false);
  });
});

describe("REVIEW spec-math, block 2: formulas checked and found to match the rules", () => {
  it("R1 _expNeg: on-chain values equal the integer model and are within 1e-15 of e^-x; zero from 60 ln 2", async () => {
    const { oracle, sign } = await deploy();
    const now = await time.latest();
    let id = 5000;
    let worst = 0n;
    const evalOnChain = async (tau, dt) => {
      id += 1;
      await oracle.setTau(id, tau);
      const a = now - dt - 100;
      // First price sets slow = 1. The second makes the mid 0 without moving slow. The third holds 0 for dt.
      const ups = [await sign(id, WAD, 1n, a), await sign(id, 0n, 1n, a + 1), await sign(id, 0n, 1n, a + 1 + dt)];
      const rc = await (await oracle.push(ups.map((u) => u.update), ups.map((u) => u.sig))).wait();
      const logs = rc.logs.map((l) => oracle.interface.parseLog(l)).filter((e) => e && e.name === "PriceUpdated");
      return logs[2].args.slow; // = 1e18 * decay / 1e18
    };
    const grid = [];
    for (const dt of [1, 12_345, 6_931_471, 6_931_472, 10_000_000, 25_000_000, 100_000_000, 200_000_000, 300_000_000, 400_000_000, 415_000_000, 420_000_000]) {
      grid.push([10_000_000, dt]);
    }
    for (const dt of [1, 2, 30, 60, 600, 2_400, 2_495, 2_496]) grid.push([60, dt]);
    for (const [tau, dt] of grid) {
      const x = (BigInt(dt) * WAD) / BigInt(tau);
      const got = await evalOnChain(tau, dt);
      expect(got, `x = ${fe(x)}`).to.equal(expNeg(x));
      const exact = BigInt(Math.round(Math.exp(-Number(x) / 1e18) * 1e18));
      const err = got > exact ? got - exact : exact - got;
      if (err > worst) worst = err;
    }
    note(`worst |_expNeg - e^-x| on the grid: ${worst} wei of 1e18 (double-precision reference)`);
    expect(worst).to.be.lessThan(1000n);
    expect(expNeg(0n)).to.equal(WAD);
    expect(expNeg(60n * LN2 - 1n)).to.be.lessThanOrEqual(1n);
    expect(expNeg(60n * LN2)).to.equal(0n);
    // Monotone across every k*ln2 seam of the range reduction.
    for (let k = 1n; k <= 60n; k++) {
      expect(expNeg(k * LN2 - 1n) >= expNeg(k * LN2), `seam ${k}`).to.equal(true);
      expect(expNeg(k * LN2) >= expNeg(k * LN2 + 1n), `seam ${k}+`).to.equal(true);
    }
  });

  it("R1 slow and slowDepth: the same number after one update or after an irregular run of them", async () => {
    const run = async (stamps) => {
      const { oracle, sign } = await deploy();
      await oracle.setTau(BTC, 60);
      const t0 = (await time.latest()) + 10;
      const seq = [await sign(BTC, px(60_000), usd(20_000_000), t0), await sign(BTC, px(60_600), usd(50_000_000), t0 + 1)];
      for (const s of stamps) seq.push(await sign(BTC, px(60_600), usd(50_000_000), t0 + 1 + s));
      await time.setNextBlockTimestamp(t0 + 90);
      await oracle.push(seq.map((u) => u.update), seq.map((u) => u.sig));
      await time.increaseTo(t0 + 1 + 90); // views run at the latest block's time: 90 s after the jump was stamped
      return oracle.read(BTC);
    };
    const once = await run([]);
    const many = await run([1, 2, 3, 7, 19, 20, 43, 44, 61, 89]);
    const want = 60_000 + 600 * (1 - Math.exp(-90 / 60));
    note(`slow after 90 s: one update ${fe(once.slow)}, ten irregular updates ${fe(many.slow)}, closed form ${want.toFixed(6)}`);
    expect(many.slow).to.be.closeTo(once.slow, px(600) / 10n ** 15n); // within 1e-15 of the 600 gap
    expect(many.slowDepth).to.be.closeTo(once.slowDepth, 20n); // millionths of a dollar
    expect(Number(fe(once.slow))).to.be.closeTo(want, 1e-6);
    expect(fmtUsd(once.slowDepth)).to.be.closeTo(20_000_000 + 30_000_000 * (1 - Math.exp(-90 / 60)), 0.01);
  });

  it("R1 fills: all four legs take the worse of mid and slow, on the side's own price", async () => {
    const { engine, oracle, alice, bob, push } = await eventSetup();
    await push(EVT, px(0.52), DEPTH); // mid 0.52, slow still about 0.50
    await engine.connect(alice).open(EVT, true, usd(100), 2, false, "0x"); // buy YES
    await engine.connect(bob).open(EVT, false, usd(100), 2, false, "0x"); // buy NO = sell YES
    const [yes] = await engine.positionsOf(alice.address);
    const [no] = await engine.positionsOf(bob.address);
    expect(yes.position.entryPrice).to.equal(px(0.52)); // max(mid, slow)
    expect(no.position.entryPrice).to.be.lessThan(px(0.5003)); // min(mid, slow)
    expect(no.position.entryPrice).to.be.greaterThan(px(0.5));

    const a = await closedArgs(engine, engine.connect(alice).close(yes.id, "0x")); // sell YES
    const f = await oracle.read(EVT);
    expect(a.exitPrice).to.equal(f.slow); // min
    const b = await closedArgs(engine, engine.connect(bob).close(no.id, "0x")); // sell NO = buy YES
    expect(b.exitPrice).to.equal(px(0.52)); // max
    expect(a.pnl).to.be.lessThan(0n);
    expect(b.pnl).to.be.lessThan(0n); // nobody gains from the gap
  });

  it("R6 leverage: the time limit matches the whitepaper's table and the tick limit binds far out", async () => {
    const { engine, expiry } = await eventSetup({ reactionSeconds: 120 }, 40);
    const at = async (secondsLeft) => {
      await time.increaseTo(expiry - secondsLeft);
      return (await engine.marketView(EVT)).maxLeverageLong;
    };
    expect(await at(30 * DAY)).to.equal(25n); // sqrt(21,600)/3 = 49, so the two-tick limit of 25 binds
    expect(await at(5 * DAY + 60)).to.equal(20n); // sqrt(3,600)/3 = 20
    expect(await at(5 * DAY - 60)).to.equal(19n);
    expect(await at(DAY)).to.equal(8n); // sqrt(720)/3 = 8.94
    expect(await at(6 * HOUR)).to.equal(4n); // sqrt(180)/3 = 4.47
    expect(await at(HOUR)).to.equal(1n); // sqrt(30)/3 = 1.83
    expect(await at(60)).to.equal(1n); // 1x floor
    expect(await at(0)).to.equal(0n); // no opens from expiry
  });

  it("R6 leverage: away from 50c the limit is min(p, 1-p) / (3 sqrt(p(1-p) h / tau)), the same for YES and NO", async () => {
    for (const p of [0.2, 0.8]) {
      const { engine, alice, expiry } = await eventSetup({ reactionSeconds: 120 }, 3, p);
      // 0.2 / (3 * sqrt(0.16 * 120 / 259,200)) = 7.74 -> 7; the tick limit there is 10.
      const lev = Number((await engine.marketView(EVT)).maxLeverageLong);
      const tau = expiry - (await time.latest());
      expect(lev).to.equal(Math.floor(0.2 / (3 * Math.sqrt((0.16 * 120) / tau))));
      expect(lev).to.equal(7);
      await expect(engine.connect(alice).open(EVT, p < 0.5, usd(10), 8, false, "0x")).to.be.revertedWithCustomError(engine, "BadLeverage");
      await engine.connect(alice).open(EVT, p > 0.5, usd(10), 7, false, "0x");
    }
  });

  it("R5/R7 NO side, free mode at 30c: reserve, win line, stop line and collection are the mirror of YES", async () => {
    const { engine, vault, usdc, bob, carol, hold } = await eventSetup({}, 300, 0.3);
    await engine.connect(bob).open(EVT, false, usd(100), 5, false, "0x"); // 500 of NO at 0.70
    const [pos] = await engine.positionsOf(bob.address);
    const reserve = (usd(100) * px(0.3)) / px(0.7); // what 100 of NO would win outright
    expect(pos.position.reserve).to.equal(reserve);
    expect(await vault.reserved()).to.equal(reserve);
    expect(pos.winPrice).to.be.closeTo(px(0.24), 10n ** 10n); // 0.30 - 0.30/5, to eight decimals
    expect(pos.liquidationPrice).to.equal(px(0.412)); // 80% of the way to 0.30 + 0.70/5

    await hold(EVT, px(0.25), 20_000, DEPTH, 500); // one cent short of the win line
    await expect(engine.connect(carol).collect(pos.id, "0x")).to.be.revertedWithCustomError(engine, "NotCollectable");
    await hold(EVT, px(0.24), 20_000, DEPTH, 500); // at it, and held so the close fills there
    const before = await usdc.balanceOf(bob.address);
    const closed = await closedArgs(engine, engine.connect(carol).collect(pos.id, "0x"));
    expect(closed.pnl).to.equal(reserve);
    expect((await usdc.balanceOf(bob.address)) - before).to.equal(usd(100) + reserve - reserve / 10n);
    expect(await vault.reserved()).to.equal(0n);
  });

  it("R6 NO side: a leveraged NO and an outright NO on the same stake are paid the same at the result", async () => {
    const { engine, usdc, alice, bob, push } = await eventSetup({}, 300, 0.3);
    await engine.connect(alice).open(EVT, false, usd(100), 15, false, "0x"); // the two-tick limit at 30c
    await engine.connect(bob).open(EVT, false, usd(100), 1, false, "0x");
    const a0 = await usdc.balanceOf(alice.address);
    const b0 = await usdc.balanceOf(bob.address);
    await push(EVT, 0n, DEPTH, true); // resolves NO
    for (const who of [alice, bob]) {
      const [p] = await engine.positionsOf(who.address);
      await engine.close(p.id, "0x");
    }
    const outright = (usd(100) * px(0.3)) / px(0.7);
    expect((await usdc.balanceOf(alice.address)) - a0).to.equal((await usdc.balanceOf(bob.address)) - b0);
    expect((await usdc.balanceOf(bob.address)) - b0).to.equal(usd(100) + outright - outright / 10n);
  });

  it("R8-R10 settlement: a boosted winner is paid to the unit what the rules give, and the vault never pays past margin + reserve", async () => {
    const { engine, vault, usdc, alice, bob, hold } = await eventSetup({ hazardScale: px(1), boostEnabled: true });
    await engine.connect(alice).open(EVT, true, usd(100), 10, true, "0x"); // boosted YES
    await engine.connect(bob).open(EVT, true, usd(100), 10, false, "0x"); // free YES on the crowded side
    const [pa] = await engine.positionsOf(alice.address);
    const [pb] = await engine.positionsOf(bob.address);
    await time.increase(DAY);
    await hold(EVT, px(0.53), 20_000, DEPTH, 500);

    for (const [who, p] of [[alice, pa], [bob, pb]]) {
      const pos = p.position;
      const cashBefore = await vault.cash();
      const balBefore = await usdc.balanceOf(who.address);
      const closed = await closedArgs(engine, engine.connect(who).close(p.id, "0x"));
      const s = await engine.states(EVT);

      const exit = closed.exitPrice;
      let pnl = (pos.notional * (exit - pos.entryPrice)) / pos.entryPrice;
      if (pnl > pos.reserve) pnl = pos.reserve;
      const premium = pos.boosted ? (pos.borrowedUnits * (s.cumBoostLong - pos.entryBoost)) / UNIT : 0n;
      let accrued = pos.boosted ? 0n : (pos.borrowedUnits * (s.cumFeeLong - pos.entryFee)) / UNIT;
      const result = pnl - premium;
      if (accrued > result) accrued = result;
      const fee = ((result - accrued) * 1000n) / BPS;
      const payout = pos.margin + result - accrued - fee;

      expect(closed.boostPremium).to.equal(premium);
      expect(closed.crowdingFee).to.equal(accrued);
      expect(closed.pnl).to.equal(result);
      expect(closed.fee).to.equal(fee);
      expect((await usdc.balanceOf(who.address)) - balBefore).to.equal(payout);
      expect(cashBefore - (await vault.cash())).to.equal(payout); // nobody is staked: the whole fee stays
      expect(payout <= pos.margin + pos.reserve).to.equal(true);
      expect((await vault.cash()) >= (await vault.marginHeld()) + (await vault.reserved())).to.equal(true);
      note(
        `${pos.boosted ? "boosted" : "free   "}: price P&L ${fmtUsd(pnl)}, premium ${fmtUsd(premium)}, crowding fee ${fmtUsd(accrued)}, share ${fmtUsd(fee)}, payout ${fmtUsd(payout)}`
      );
    }
  });

  it("R8/R9 event rates as coded: p(1-p)/tau for YES and NO alike (the whitepaper's formula), crowding fee = that times the borrowed-share imbalance", async () => {
    const { engine, alice, bob, expiry } = await eventSetup({ hazardScale: px(1), boostEnabled: true }, 300, 0.8);
    await engine.connect(alice).open(EVT, true, usd(100), 5, false, "0x"); // 625 YES shares, 500 borrowed
    await engine.connect(bob).open(EVT, false, usd(100), 2, false, "0x"); // 1,000 NO shares, 500 borrowed
    await engine.connect(bob).open(EVT, false, usd(100), 3, false, "0x"); // 1,500 NO shares, 1,000 borrowed
    const s0 = await engine.states(EVT);
    expect(s0.longBorrowed).to.equal(usd(500) * WAD);
    expect(s0.shortBorrowed).to.equal(usd(1_500) * WAD);

    const t0 = await time.latest();
    await time.setNextBlockTimestamp(t0 + DAY);
    await engine.poke(EVT);
    const s1 = await engine.states(EVT);
    const tau = BigInt(expiry - (t0 + DAY) + DAY / 2); // time left at the midpoint of the day
    const rate = (((px(0.8) * px(0.2)) / WAD) * WAD * BigInt(DAY)) / (tau * WAD); // 0.16 * dt / tau
    expect(s1.cumBoostLong - s0.cumBoostLong).to.equal(rate);
    expect(s1.cumBoostShort - s0.cumBoostShort).to.equal(rate);
    expect(s1.cumFeeLong - s0.cumFeeLong).to.equal(0n); // YES has borrowed less: it pays nothing
    expect(s1.cumFeeShort - s0.cumFeeShort).to.equal((rate * 2n) / 3n); // (1,500 - 500) / 1,500 of the full rate
    note(
      `per borrowed share per day at 80c, 300 days out: coded ${fe(rate)} for both sides; ` +
        `the review brief's (1 - p_side)/tau would be ${fe((rate * 20n) / 16n)} for YES and ${fe((rate * 80n) / 16n)} for NO`
    );
  });

  it("R8 other markets: the index grows by skew * crowdingPerDay per day, skew = imbalance / capacity capped at 1", async () => {
    const { engine, alice, bob, push } = await btcSetup({ crowdingPerDay: px(0.001) });
    await engine.connect(alice).open(BTC, true, usd(4_000), 1000, false, "0x"); // 4M long
    await engine.connect(bob).open(BTC, false, usd(1_000), 1000, false, "0x"); // 1M short: imbalance 3M of a 10M cap
    const t0 = await time.latest();
    const i0 = (await engine.states(BTC)).cumFeeLong;
    await time.setNextBlockTimestamp(t0 + DAY);
    await engine.poke(BTC);
    const s1 = await engine.states(BTC);
    expect(s1.cumFeeLong - i0).to.equal(px(0.0003)); // 0.3 * 0.1%
    expect(s1.cumFeeShort).to.equal(0n); // the smaller side accrues nothing

    await push(BTC, px(60_000), usd(2_000_000)); // depth falls: capacity 1M, imbalance 3M
    const t1 = await time.latest();
    await engine.poke(BTC);
    const i1 = (await engine.states(BTC)).cumFeeLong;
    await time.setNextBlockTimestamp(t1 + 1 + DAY);
    await engine.poke(BTC);
    expect((await engine.states(BTC)).cumFeeLong - i1).to.equal(px(0.001)); // capped at full skew
    const [pos] = await engine.positionsOf(alice.address);
    expect(pos.equityAtMid).to.equal(usd(4_000)); // never a claim on margin
    expect(pos.liquidatable).to.equal(false);
  });

  it("R4 liquidation: fires at the reported price and not a tick before; the liquidator's reward is capped by what is left", async () => {
    const { engine, usdc, alice, bob, liquidator, push } = await btcSetup();
    await engine.connect(alice).open(BTC, true, usd(100), 1000, false, "0x");
    await engine.connect(bob).open(BTC, false, usd(100), 1000, false, "0x");
    const [long] = await engine.positionsOf(alice.address);
    const [short] = await engine.positionsOf(bob.address);

    await push(BTC, long.liquidationPrice + px(0.01));
    await expect(engine.connect(liquidator).liquidate(long.id, "0x")).to.be.revertedWithCustomError(engine, "NotLiquidatable");
    await push(BTC, long.liquidationPrice); // equity exactly 20
    const a0 = await usdc.balanceOf(alice.address);
    await engine.connect(liquidator).liquidate(long.id, "0x");
    expect(await usdc.balanceOf(liquidator.address)).to.equal(usd(5));
    expect((await usdc.balanceOf(alice.address)) - a0).to.equal(usd(15));

    // The short is 98 under water at 60,058.8: 2 of equity left, all of it goes to the liquidator.
    await push(BTC, px(60_058.8));
    const b0 = await usdc.balanceOf(bob.address);
    await engine.connect(liquidator).liquidate(short.id, "0x");
    expect(await usdc.balanceOf(liquidator.address)).to.equal(usd(5 + 2));
    expect((await usdc.balanceOf(bob.address)) - b0).to.equal(0n);
  });

  it("R3 capacity: kappa * min(depth, slowDepth), in USDC, checked against the side's open interest after the new position", async () => {
    const { engine, alice, bob } = await btcSetup(); // depth 20M, kappa 0.5
    expect((await engine.marketView(BTC)).sideCap).to.equal(usd(10_000_000));
    await engine.connect(alice).open(BTC, true, usd(10_000), 1000, false, "0x"); // exactly the cap
    await expect(engine.connect(bob).open(BTC, true, usd(1), 1, false, "0x")).to.be.revertedWithCustomError(engine, "SideCapExceeded");
    await engine.connect(bob).open(BTC, false, usd(10_000), 1000, false, "0x"); // the other side has its own
  });
});
