// Second-reviewer verification of the edge-case finding
//   "unrealizedPnl() is uncapped per position, so the LP share price is wrong whenever a position
//    is past its stop or its win line".
//
// Each test builds the claimed scenario, detects which engine it is running against, and pins the
// exact numbers for that state. A number that fits neither state fails the test.
//   - as reviewed (PerpEngine.sol 2026-11-19 21:34): unrealizedPnl() is the uncapped aggregate and
//     the finding reproduces with the claimed figures;
//   - once unrealizedPnl() marks each open position inside its own margin and reserve: the share
//     price no longer moves at a liquidation or settlement and the round trips earn nothing.
// The state each test saw is printed. The second set of figures was checked against a patched copy
// of the engine kept outside the repository.
//
// Run only this file:  npx hardhat test test/review-verify-edge-cases.test.js

const { expect } = require("chai");
const { ethers, network } = require("hardhat");
const { time, takeSnapshot } = require("@nomicfoundation/hardhat-network-helpers");
const { deploy, marketConfig, usd, px, BTC, EVT } = require("./helpers");

const DAY = 86_400;
const DEPTH = usd(2_000_000);
const CENT = usd(0.01);
const f6 = (v) => Number(ethers.formatUnits(v, 6));
const note = (...a) => console.log("        ", ...a);

/** What the open positions would be paid or lose at the mid, each one inside its own bounds. */
async function cappedMark(engine) {
  const n = Number(await engine.openPositionCount());
  let total = 0n;
  for (const v of await engine.openPositions(0, n)) total += v.equityAtMid - v.position.margin;
  return total;
}

/** LP value with every open position marked inside its own bounds. */
async function fairNav(ctx) {
  const { usdc, vault, engine } = ctx;
  return (await usdc.balanceOf(vault.target)) - (await vault.marginHeld()) - (await cappedMark(engine));
}

/** True while the engine's mark differs from the per-position one, i.e. the finding is live. */
async function findingIsLive(ctx, label) {
  const live = (await ctx.engine.unrealizedPnl()) !== (await cappedMark(ctx.engine));
  note(`${label}: ${live ? "uncapped aggregate mark, the finding reproduces" : "per-position mark, the finding is fixed"}`);
  return live;
}

async function redeemAll(ctx, who) {
  const { usdc, vault } = ctx;
  const before = await usdc.balanceOf(who.address);
  await vault.connect(who).redeem(await vault.balanceOf(who.address), who.address, who.address);
  return (await usdc.balanceOf(who.address)) - before;
}

/** Mine everything `send` submits in one block stamped `ts`, in the order it was submitted. */
async function inOneBlock(ts, send) {
  await network.provider.send("evm_setAutomine", [false]);
  let txs;
  try {
    txs = await send();
    await time.setNextBlockTimestamp(ts);
    await network.provider.send("evm_mine");
  } finally {
    await network.provider.send("evm_setAutomine", [true]);
  }
  const receipts = await Promise.all(txs.map((t) => t.wait()));
  expect(receipts.map((r) => r.status), "every transaction succeeded").to.deep.equal(receipts.map(() => 1));
  expect(new Set(receipts.map((r) => r.blockNumber)).size, "all in one block").to.equal(1);
  expect(receipts.map((r) => r.index), "in the order sent").to.deep.equal(receipts.map((_, i) => i));
  return receipts[0].blockNumber;
}

/** Scenario (a): two LPs with 2,500,000 each; Alice 1000x long on 5,000; Bob a 10x long and a 10x short. */
async function btcBook() {
  const ctx = await deploy();
  const { engine, vault, lp, alice, bob, carol, push } = ctx;
  await engine.setMarket(BTC, marketConfig()); // 1000x, as deployed for crypto
  await vault.connect(lp).deposit(usd(2_500_000), lp.address);
  await vault.connect(carol).deposit(usd(2_500_000), carol.address);
  await push(BTC, px(60_000));
  await engine.connect(alice).open(BTC, true, usd(5_000), 1000, false, "0x"); // 5,000,000 long
  await engine.connect(bob).open(BTC, true, usd(20_000), 10, false, "0x");
  await engine.connect(bob).open(BTC, false, usd(20_000), 10, false, "0x");
  ctx.aliceId = (await engine.positionsOf(alice.address))[0].id;
  return ctx;
}

/** An event market at 0.50 and one LP. */
async function eventBook(overrides = {}, daysOut = 300, lpDeposit = 1_000_000) {
  const ctx = await deploy();
  const { engine, vault, lp, push } = ctx;
  ctx.expiry = (await time.latest()) + daysOut * DAY;
  await engine.setMarket(
    EVT,
    marketConfig({
      isEvent: true,
      maxLeverage: 50,
      profitFeeBps: 1000,
      maxGapBps: 500,
      expiry: ctx.expiry,
      maxPositionNotional: usd(1_000_000),
      ...overrides,
    })
  );
  await vault.connect(lp).deposit(usd(lpDeposit), lp.address);
  await push(EVT, px(0.5), DEPTH);
  return ctx;
}

/** Scenario (b): a free 25x YES on 100 (can win 100) and an outright NO on 1,200. */
async function resolutionBook() {
  const ctx = await eventBook();
  await ctx.engine.connect(ctx.alice).open(EVT, true, usd(100), 25, false, "0x");
  await ctx.engine.connect(ctx.bob).open(EVT, false, usd(1_200), 1, false, "0x");
  return ctx;
}

describe("Verify: the LP share price marks positions past their own bounds", function () {
  this.timeout(300_000);

  it("V1 (a) a 1000x long gapped through its stop: is the first LP out paid more than the one who stays?", async () => {
    const ctx = await btcBook();
    const { engine, vault, usdc, lp, alice, carol, liquidator, push, aliceId } = ctx;
    await push(BTC, px(59_700)); // one update, -0.5%, before anyone liquidates
    const live = await findingIsLive(ctx, "V1");

    const upnl = await engine.unrealizedPnl();
    const marked = await vault.totalAssets();
    const view = await engine.positionView(aliceId);
    note(`unrealizedPnl() ${f6(upnl)} | per-position ${f6(await cappedMark(engine))} | marginHeld ${f6(await vault.marginHeld())}`);
    note(`totalAssets() ${f6(marked)} | with each position inside its bounds ${f6(await fairNav(ctx))}`);

    // True in both states: Alice has lost her 5,000 and no more, and can be liquidated.
    expect(view.equityAtMid, "Alice's equity at the mid").to.equal(0n);
    expect(view.liquidatable).to.equal(true);
    expect(await cappedMark(engine), "what the three positions can lose").to.equal(-usd(5_000));
    expect(await vault.marginHeld()).to.equal(usd(45_000)); // so the vault's floor of -45,000 does not bind
    expect(await fairNav(ctx), "LP value in fact").to.equal(usd(5_005_000));
    expect(upnl, "engine mark").to.be.closeTo(live ? -usd(25_000) : -usd(5_000), 5n);
    expect(marked, "LP value as marked").to.be.closeTo(live ? usd(5_025_000) : usd(5_005_000), 5n);

    // Control: liquidate first, then redeem. Each LP holds 2,502,500.
    const snap = await takeSnapshot();
    const liq0 = await usdc.balanceOf(liquidator.address);
    const a0 = await usdc.balanceOf(alice.address);
    await engine.connect(liquidator).liquidate(aliceId, "0x");
    expect(await vault.totalAssets(), "LP value once Alice is liquidated").to.be.closeTo(usd(5_005_000), 5n);
    expect((await usdc.balanceOf(liquidator.address)) - liq0).to.equal(0n); // nothing left to reward from
    expect((await usdc.balanceOf(alice.address)) - a0).to.equal(0n);
    expect(await redeemAll(ctx, carol), "an LP who redeems after the liquidation").to.be.closeTo(usd(2_502_500), CENT);
    await snap.restore();

    // The claim: one LP redeems before the liquidation.
    const took = await redeemAll(ctx, carol);
    await engine.connect(liquidator).liquidate(aliceId, "0x");
    const left = await vault.convertToAssets(await vault.balanceOf(lp.address));
    note(`LP who redeems first receives ${f6(took)}; the one who stays holds ${f6(left)}`);
    expect(await vault.totalAssets()).to.be.closeTo(left, 5n);
    if (live) {
      expect(took, "first LP out").to.be.closeTo(usd(2_512_500), CENT);
      expect(left, "the LP who stayed").to.be.closeTo(usd(2_492_500), CENT);
      // Traders lost 5,000 in all, yet the LP who stayed is down 7,500 on a 2,500,000 stake.
      expect(usd(2_500_000) - left).to.be.closeTo(usd(7_500), CENT);
    } else {
      expect(took, "first LP out").to.be.closeTo(usd(2_502_500), CENT);
      expect(left, "the LP who stayed").to.be.closeTo(usd(2_502_500), CENT);
    }
  });

  it("V2 (a) one party relays the signed price and redeems in the same block, ahead of any liquidation", async () => {
    const ctx = await btcBook();
    const { engine, vault, oracle, usdc, carol, liquidator, sign, push, aliceId } = ctx;
    const probe = await takeSnapshot();
    await push(BTC, px(59_700));
    const live = await findingIsLive(ctx, "V2");
    await probe.restore();

    // The keeper serves its signed updates over HTTP (keeper/src/index.js, /prices); Carol only relays one.
    const ts = (await time.latest()) + 1;
    const { update, sig } = await sign(BTC, px(59_700), usd(20_000_000), ts);
    const shares = await vault.balanceOf(carol.address);
    const before = await usdc.balanceOf(carol.address);
    const block = await inOneBlock(ts, async () => [
      await oracle.connect(carol).push([update], [sig], { gasLimit: 500_000 }),
      await vault.connect(carol).redeem(shares, carol.address, carol.address, { gasLimit: 3_000_000 }),
    ]);
    const took = (await usdc.balanceOf(carol.address)) - before;
    note(`relay + redeem in block ${block}: Carol receives ${f6(took)} for a 2,500,000 stake`);
    expect(took).to.be.closeTo(live ? usd(2_512_500) : usd(2_502_500), CENT);
    // Alice is still open and liquidatable afterwards: no liquidation could have come first.
    expect((await engine.positionView(aliceId)).liquidatable).to.equal(true);
    await engine.connect(liquidator).liquidate(aliceId, "0x");
    expect(await vault.totalAssets()).to.be.closeTo(live ? usd(2_492_500) : usd(2_502_500), CENT);
  });

  it("V3 (b) resolution with a leveraged winner: what does a deposit made before the settlements earn?", async () => {
    const ctx = await resolutionBook();
    const { engine, vault, usdc, lp, carol, push } = ctx;
    expect(await vault.reserved()).to.equal(usd(1_300));
    await push(EVT, px(1), DEPTH, true); // resolves YES
    const live = await findingIsLive(ctx, "V3");

    const upnl = await engine.unrealizedPnl();
    const marked = await vault.totalAssets();
    note(`unrealizedPnl() ${f6(upnl)} | per-position ${f6(await cappedMark(engine))} | reserved ${f6(await vault.reserved())}`);
    note(`totalAssets() ${f6(marked)} | with each position inside its bounds ${f6(await fairNav(ctx))}`);
    expect(await cappedMark(engine)).to.equal(-usd(1_100)); // +100 on the YES, -1,200 on the NO
    expect(upnl).to.equal(live ? usd(1_300) : -usd(1_100)); // uncapped: +2,500 and -1,200
    expect(marked).to.equal(live ? usd(998_700) : usd(1_001_100));

    // Control: settle first, then deposit and redeem. LPs are up 1,110 and the newcomer gains nothing.
    const snap = await takeSnapshot();
    for (const p of await engine.openPositions(0, 10)) await engine.close(p.id, "0x");
    expect(await vault.totalAssets(), "LP value once both are settled").to.equal(usd(1_001_110));
    await vault.connect(carol).deposit(usd(1_000_000), carol.address);
    expect((await redeemAll(ctx, carol)) - usd(1_000_000)).to.be.closeTo(0n, 5n);
    await snap.restore();

    // The claim: deposit between the resolution and the settlements.
    const c0 = await usdc.balanceOf(carol.address);
    await vault.connect(carol).deposit(usd(1_000_000), carol.address);
    for (const p of await engine.openPositions(0, 10)) await engine.close(p.id, "0x"); // anyone may settle
    await redeemAll(ctx, carol);
    const gain = (await usdc.balanceOf(carol.address)) - c0;
    const lpLeft = await vault.convertToAssets(await vault.balanceOf(lp.address));
    note(`depositor's round trip: ${f6(gain)}; the original LP holds ${f6(lpLeft)} (1,001,110 with no depositor)`);
    // Fixed, all that is left is her half of the 10 profit fee that arrives while she holds shares.
    expect(gain, "round trip around the settlements").to.be.closeTo(live ? usd(1_205.78) : usd(5), CENT);
    expect(lpLeft).to.be.closeTo(usd(1_001_110) - gain, 5n);
  });

  it("V4 (b) the same party relays the result, deposits, settles and redeems inside one block", async () => {
    const ctx = await resolutionBook();
    const { engine, vault, oracle, usdc, carol, sign, push } = ctx;
    const ids = (await engine.openPositions(0, 10)).map((p) => p.id);
    const probe = await takeSnapshot();
    await push(EVT, px(1), DEPTH, true);
    const live = await findingIsLive(ctx, "V4");
    const shares = await vault.previewDeposit(usd(1_000_000)); // what the deposit will mint after the relay
    await probe.restore();

    const ts = (await time.latest()) + 1;
    const { update, sig } = await sign(EVT, px(1), DEPTH, ts, true);
    const c0 = await usdc.balanceOf(carol.address);
    const o = { gasLimit: 3_000_000 };
    const block = await inOneBlock(ts, async () => [
      await oracle.connect(carol).push([update], [sig], o),
      await vault.connect(carol).deposit(usd(1_000_000), carol.address, o),
      await engine.connect(carol).close(ids[0], "0x", o),
      await engine.connect(carol).close(ids[1], "0x", o),
      await vault.connect(carol).redeem(shares, carol.address, carol.address, o),
    ]);
    expect(await vault.balanceOf(carol.address)).to.equal(0n);
    const gain = (await usdc.balanceOf(carol.address)) - c0;
    note(`relay + deposit + 2 settlements + redeem in block ${block}: Carol gains ${f6(gain)}`);
    expect(gain).to.be.closeTo(live ? usd(1_205.78) : usd(5), CENT);
  });

  it("V5 the suggested per-market, per-side clamp would repair (b) but not (a)", async () => {
    // Emulated off-chain from on-chain state, so it reads the same against either engine: each side's
    // uncapped P&L, bounded by that side's own totals of margin and reserve.
    const sideClamped = async (ctx, marketId, isEvent) => {
      const v = await ctx.engine.marketView(marketId);
      const UNIT = 10n ** 36n;
      const WAD = 10n ** 18n;
      const mid = v.feed.mid;
      const longPnl = (v.state.longUnits * mid) / UNIT - v.state.longOI;
      const shortPnl = isEvent
        ? (v.state.shortUnits * (WAD - mid)) / UNIT - v.state.shortOI
        : v.state.shortOI - (v.state.shortUnits * mid) / UNIT;
      const tot = { true: { m: 0n, r: 0n }, false: { m: 0n, r: 0n } };
      for (const p of await ctx.engine.openPositions(0, 50)) {
        tot[p.position.isLong].m += p.position.margin;
        tot[p.position.isLong].r += p.position.reserve;
      }
      const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);
      return clamp(longPnl, -tot.true.m, tot.true.r) + clamp(shortPnl, -tot.false.m, tot.false.r);
    };

    const a = await btcBook();
    await a.push(BTC, px(59_700));
    const aSide = await sideClamped(a, BTC, false);
    note(`(a) per-side clamp ${f6(aSide)} vs per-position ${f6(await cappedMark(a.engine))}: Bob's 20,000 long margin still lends Alice headroom`);
    expect(aSide).to.be.closeTo(-usd(24_000), 5n); // long side floored at -25,000, short side +1,000
    expect(await cappedMark(a.engine)).to.equal(-usd(5_000));

    const b = await resolutionBook();
    await b.push(EVT, px(1), DEPTH, true);
    const bSide = await sideClamped(b, EVT, true);
    note(`(b) per-side clamp ${f6(bSide)} vs per-position ${f6(await cappedMark(b.engine))}`);
    expect(bSide).to.equal(-usd(1_100));
  });

  it("V6 severity: the bound is vault-wide, so one position is mis-marked by leverage times its own cap", async () => {
    // Deployed event parameters (reactionSeconds 120, 100,000 per position), a 2,000,000 vault as seeded,
    // and two ordinary BTC positions whose reserves are what the vault-wide ceiling is made of.
    const ctx = await eventBook({ reactionSeconds: 120, maxPositionNotional: usd(100_000) }, 6, 2_000_000);
    const { engine, vault, usdc, lp, alice, bob, carol, liquidator, push, hold } = ctx;
    await engine.setMarket(BTC, marketConfig());
    await push(BTC, px(60_000));
    await engine.connect(bob).open(BTC, true, usd(20_000), 10, false, "0x"); // reserve 200,000, flat
    await engine.connect(bob).open(BTC, false, usd(20_000), 10, false, "0x"); // reserve 200,000, flat
    expect((await engine.marketView(EVT)).maxLeverageLong).to.equal(21n); // six days out at 0.50
    await engine.connect(alice).open(EVT, true, usd(5_000), 20, false, "0x"); // 100,000 of YES, can win 5,000
    const [pos] = await engine.positionsOf(alice.address);
    expect(pos.position.reserve).to.equal(usd(5_000));

    await push(EVT, px(0.9), DEPTH); // news: the odds jump, the market is not resolved
    const live = await findingIsLive(ctx, "V6");
    const marked = await vault.totalAssets();
    const fair = await fairNav(ctx);
    note(`after the jump: unrealizedPnl() ${f6(await engine.unrealizedPnl())} for a position capped at 5,000`);
    note(`totalAssets() ${f6(marked)} vs ${f6(fair)} in fact: ${((f6(fair - marked) / f6(fair)) * 100).toFixed(2)}% under`);
    expect(fair).to.equal(usd(1_995_000));
    expect(await engine.unrealizedPnl()).to.be.closeTo(live ? usd(80_000) : usd(5_000), 5n);
    expect(fair - marked).to.be.closeTo(live ? usd(75_000) : 0n, 5n);

    // A newcomer deposits at that mark, waits for the keeper to pay the position its cap, and leaves.
    const c0 = await usdc.balanceOf(carol.address);
    await vault.connect(carol).deposit(usd(20_000_000), carol.address);
    await hold(EVT, px(0.9), 120, DEPTH, 10); // the slow price reaches the win line; BTC untouched
    await engine.connect(liquidator).collect(pos.id, "0x");
    await redeemAll(ctx, carol);
    const gain = (await usdc.balanceOf(carol.address)) - c0;
    const lpLost = usd(2_000_000) - (await vault.convertToAssets(await vault.balanceOf(lp.address)));
    note(`a 20,000,000 deposit held across the collect gains ${f6(gain)}; the LP is down ${f6(lpLost)} (Alice won 5,000 less a 500 fee)`);
    if (live) {
      expect(gain, "taken from the LP through one position with 5,000 of margin").to.be.closeTo(usd(68_886.86), usd(1));
      expect(lpLost).to.be.closeTo(usd(73_386.86), usd(1));
    } else {
      expect(gain, "at most the 500 profit fee that arrives while she holds shares").to.be.within(0n, usd(500));
      expect(lpLost).to.be.within(usd(4_500), usd(5_000));
    }
  });

  it("V7 severity: with the reserve ceiling padded by a flat pair, the share price is marked to zero", async () => {
    // Test-fixture limits (1,000,000 per event position, deep event book). Alice and Carol act together.
    const ctx = await eventBook({ profitFeeBps: 0 });
    const { engine, vault, usdc, lp, alice, carol, push } = ctx;
    await engine.setMarket(BTC, marketConfig());
    await push(BTC, px(60_000));
    await engine.connect(alice).open(EVT, true, usd(40_000), 25, false, "0x"); // can win 40,000
    const c0 = await usdc.balanceOf(carol.address);
    // A long and a short of the same size cost nothing to hold and lock 960,000 of reserve between them.
    await engine.connect(carol).open(BTC, true, usd(48_000), 10, false, "0x");
    await engine.connect(carol).open(BTC, false, usd(48_000), 10, false, "0x");
    expect(await vault.reserved()).to.equal(usd(1_000_000));
    expect(await vault.freeLiquidity()).to.equal(0n);

    await push(EVT, px(1), DEPTH, true); // resolves YES: uncapped the YES is up 1,000,000
    const live = await findingIsLive(ctx, "V7");
    const marked = await vault.totalAssets();
    expect(await fairNav(ctx)).to.equal(usd(960_000));
    expect(marked, "LP value as marked").to.equal(live ? 0n : usd(960_000));

    await vault.connect(carol).deposit(usd(1), carol.address); // one dollar, at that mark
    const [pa] = await engine.positionsOf(alice.address);
    await engine.connect(carol).close(pa.id, "0x"); // settle Alice: she is paid her 40,000
    await push(BTC, px(60_000));
    for (const p of await engine.positionsOf(carol.address)) await engine.connect(carol).close(p.id, "0x"); // flat
    await redeemAll(ctx, carol);
    const gain = (await usdc.balanceOf(carol.address)) - c0;
    const lpLeft = await vault.convertToAssets(await vault.balanceOf(lp.address));
    note(`marked ${f6(marked)} against 960,000 in fact; Carol's flat pair and 1.00 deposit end ${f6(gain)} up; the LP's 1,000,000 is now ${f6(lpLeft)}`);
    if (live) {
      expect(gain, "the pool, for one dollar").to.be.closeTo(usd(959_999), usd(2));
      expect(lpLeft).to.be.lessThan(usd(2));
    } else {
      expect(gain).to.be.closeTo(0n, 5n);
      expect(lpLeft).to.be.closeTo(usd(960_000), 5n);
    }
  });
});
