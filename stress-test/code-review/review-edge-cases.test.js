// Pre-deployment review, lens: edge cases and reverts.
//
// Two groups:
//   "defects"   - each test states the intended behaviour and FAILS on the code as reviewed
//                 (PerpEngine.sol as of 2026-11-19 21:34, md5 3e62568f...). They are written to
//                 pass once the behaviour is fixed, whichever way the fix is made.
//   "confirmed" - boundary behaviour that was checked and holds. These pass.
//
// Run only this file:  npx hardhat test test/review-edge-cases.test.js

const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time, takeSnapshot } = require("@nomicfoundation/hardhat-network-helpers");
const { deploy, marketConfig, usd, px, BTC, EVT } = require("./helpers");

const DAY = 86_400;
const HOUR = 3_600;
const DEPTH = usd(2_000_000);
const P0 = px(60_000);
const MAX64 = (1n << 64n) - 1n;
const MAX32 = 4_294_967_295;
const f6 = (v) => Number(ethers.formatUnits(v, 6));
const f18 = (v) => Number(ethers.formatUnits(v, 18));
const PRICE_DATA = ["tuple(uint32 marketId,uint256 price,uint256 depthUsd,uint64 timestamp,bool resolved)[]", "bytes[]"];

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

async function btcSetup(overrides = {}, lpDeposit = 5_000_000) {
  const ctx = await deploy();
  await ctx.engine.setMarket(BTC, marketConfig(overrides));
  await ctx.vault.connect(ctx.lp).deposit(usd(lpDeposit), ctx.lp.address);
  await ctx.push(BTC, P0);
  return ctx;
}

const note = (...a) => console.log("        ", ...a);

describe("Review, edge cases: defects (each of these fails until fixed)", function () {
  this.timeout(300_000);

  it("E1 [high] a market is still listed and marked when someone pokes its id before the owner configures it", async () => {
    const { engine, oracle, vault, lp, alice, bob, push, hold } = await deploy();
    const NEW = 7; // any id the owner has not configured yet; the ids are public in markets.json
    await engine.connect(bob).poke(NEW).catch(() => {}); // anyone, one cheap transaction
    await oracle.setTau(NEW, 60);
    await engine.setMarket(NEW, marketConfig());
    await vault.connect(lp).deposit(usd(5_000_000), lp.address);
    await push(NEW, P0);
    await engine.connect(alice).open(NEW, true, usd(10_000), 1000, false, "0x"); // it trades normally
    await hold(NEW, px(60_030), 10); // traders are up 5,000 at the mid

    const seen = {
      marketCount: Number(await engine.marketCount()),
      allMarkets: (await engine.allMarkets()).length,
      unrealizedPnl: Math.round(f6(await engine.unrealizedPnl())),
      lpNav: Math.round(f6(await vault.totalAssets())),
    };
    note("after poke-then-setMarket:", JSON.stringify(seen));
    expect(seen).to.deep.equal({ marketCount: 1, allMarkets: 1, unrealizedPnl: 5_000, lpNav: 4_995_000 });
  });

  it("E2 [high] a forced close does not cost the owner the win a jump has just handed them", async () => {
    // Deployed event parameters: reactionSeconds 120, a few days to expiry. The jump toward 1 is what
    // lowers the time-based limit below the position's leverage, in the same block it creates the win.
    const run = async (boost, thirdPartyForces) => {
      const { engine, usdc, alice, bob, push, hold } = await eventSetup(
        { reactionSeconds: 120, hazardScale: px(1), boostEnabled: true },
        5
      );
      await engine.connect(alice).open(EVT, true, usd(100), 15, boost, "0x");
      const [pos] = await engine.positionsOf(alice.address);
      const before = await usdc.balanceOf(alice.address);
      await push(EVT, px(0.9), DEPTH); // the odds jump from 0.50 to 0.90
      const v = await engine.positionView(pos.id);
      if (thirdPartyForces) {
        note(
          `${boost ? "boosted" : "free"} 15x YES after the jump: forceClosable=${v.forceClosable} collectable=${v.collectable} ` +
            `closeFill=${f18(v.markPrice).toFixed(4)} equityAtMid=${f6(v.equityAtMid).toFixed(2)}`
        );
        // The keeper's own sweep does exactly this (keeper/src/index.js actionFor -> "forceClose").
        await engine.connect(bob).forceClose(pos.id, "0x").catch(() => {});
      }
      if ((await engine.positionsOf(alice.address)).length) {
        await hold(EVT, px(0.9), 1500, DEPTH, 30); // the price simply stays where it jumped to
        await engine.connect(alice).close(pos.id, "0x");
      }
      return f6((await usdc.balanceOf(alice.address)) - before);
    };
    const free = { forced: await run(false, true), left: await run(false, false) };
    const boosted = { forced: await run(true, true), left: await run(true, false) };
    note("free    15x: trader receives", free.forced, "if force-closed in the next block,", free.left, "if left alone");
    note("boosted 15x: trader receives", boosted.forced, "if force-closed in the next block,", boosted.left, "if left alone");
    expect(free.forced, "free position, forced close vs left alone").to.be.closeTo(free.left, 1);
    expect(boosted.forced, "boosted position, forced close vs left alone").to.be.closeTo(boosted.left, 10);
  });

  it("E3a [high] the LP share price does not change when a position that is already past its stop is liquidated", async () => {
    // Deployed crypto parameters: 1000x, liquidation 8 bps away. One update moves the mid 0.5%.
    const { engine, vault, usdc, alice, bob, carol, liquidator, push } = await btcSetup({}, 2_500_000);
    await vault.connect(carol).deposit(usd(2_500_000), carol.address); // a second LP with half the vault
    await engine.connect(alice).open(BTC, true, usd(5_000), 1000, false, "0x"); // 5M long, can lose 5,000
    await engine.connect(bob).open(BTC, true, usd(20_000), 10, false, "0x"); // other traders' margin in the vault
    await engine.connect(bob).open(BTC, false, usd(20_000), 10, false, "0x");
    await push(BTC, px(59_700)); // -0.5%

    const marked = await vault.totalAssets();
    const upnl = await engine.unrealizedPnl();
    const [pa] = await engine.positionsOf(alice.address);
    const snap = await takeSnapshot();
    await engine.connect(liquidator).liquidate(pa.id, "0x");
    const realised = await vault.totalAssets();
    await snap.restore();

    // What that difference is worth to an LP who redeems in between.
    const c0 = await usdc.balanceOf(carol.address);
    await vault.connect(carol).redeem(await vault.balanceOf(carol.address), carol.address, carol.address);
    const took = (await usdc.balanceOf(carol.address)) - c0;
    await engine.connect(liquidator).liquidate(pa.id, "0x");
    note(`unrealizedPnl = ${f6(upnl)} for a position whose margin is 5,000: NAV ${f6(marked)} before liquidation, ${f6(realised)} after`);
    note(`an LP who redeems a 2,500,000 half first takes ${f6(took)}; the other LP is left with ${f6(await vault.totalAssets())}`);
    expect(marked, "NAV marked before liquidation vs NAV after it").to.be.closeTo(realised, usd(1));
  });

  it("E3b [high] a deposit made between a resolution and the settlements does not profit from them", async () => {
    const { engine, vault, usdc, alice, bob, carol, push } = await eventSetup({});
    await engine.connect(alice).open(EVT, true, usd(100), 25, false, "0x"); // free 25x YES: can win 100
    await engine.connect(bob).open(EVT, false, usd(1_200), 1, false, "0x"); // outright NO: loses 1,200 on YES
    await push(EVT, px(1), DEPTH, true); // resolves YES; anyone may relay this signed update
    const marked = f6(await vault.totalAssets());

    const c0 = await usdc.balanceOf(carol.address);
    await vault.connect(carol).deposit(usd(1_000_000), carol.address);
    for (const p of await engine.openPositions(0, 10)) await engine.close(p.id, "0x");
    await vault.connect(carol).redeem(await vault.balanceOf(carol.address), carol.address, carol.address);
    const pnl = f6((await usdc.balanceOf(carol.address)) - c0);
    note(`NAV marked ${marked} between resolution and settlement (LPs are in fact up 1,110); depositor's round trip: ${pnl}`);
    expect(Math.abs(pnl), "risk-free round trip around the settlements").to.be.lessThan(10);
  });

  it("E4a [medium] a boosted position pays the premium for the time it was open before the market resolved", async () => {
    const { engine, usdc, alice, push } = await eventSetup({ hazardScale: px(1), boostEnabled: true });
    await engine.connect(alice).open(EVT, true, usd(100), 10, true, "0x"); // borrows 1,800 shares
    await time.increase(20 * DAY); // a quiet market: nobody trades or pokes
    const [before] = await engine.positionsOf(alice.address);
    await push(EVT, px(1), DEPTH, true); // the keeper relays the result straight to the oracle
    const [after] = await engine.positionsOf(alice.address);
    const b0 = await usdc.balanceOf(alice.address);
    await engine.close(after.id, "0x");
    note(
      `premium shown one block before the result: ${f6(before.boostPremium)}; charged at settlement: ${f6(after.boostPremium)}; ` +
        `paid out ${f6((await usdc.balanceOf(alice.address)) - b0)}`
    );
    expect(f6(after.boostPremium), "premium still owed after the result").to.be.closeTo(f6(before.boostPremium), 0.5);
  });

  it("E4b [medium] what a position has accrued does not depend on where the price is when someone first touches the market", async () => {
    const run = async (pokeBeforeTheMove) => {
      const { engine, alice, push } = await eventSetup({ hazardScale: px(1), boostEnabled: true });
      await engine.connect(alice).open(EVT, true, usd(100), 10, true, "0x");
      await time.increase(20 * DAY); // twenty days at 0.50
      if (pokeBeforeTheMove) await engine.poke(EVT);
      await push(EVT, px(0.99), DEPTH); // then the odds go to 0.99
      const [p] = await engine.positionsOf(alice.address);
      return f6(p.boostPremium);
    };
    const poked = await run(true);
    const untouched = await run(false);
    note(`20 days at 0.50, then 0.99: premium ${poked} if someone poked before the move, ${untouched} if nobody did`);
    expect(untouched, "premium for the same 20 days at 0.50").to.be.closeTo(poked, 0.5);
  });

  it("E5 [medium] stakers receive the fees sent to them, however large the stake and however small the fee", async () => {
    const [owner, alice, , anyone] = await ethers.getSigners();
    const usdc = await (await ethers.getContractFactory("MockUSDC")).deploy();
    const token = await (await ethers.getContractFactory("OpenLiquidToken")).deploy(
      ethers.parseEther("100"),
      usd(1_000_000),
      owner.address
    );
    const staking = await (await ethers.getContractFactory("Staking")).deploy(token.target, usdc.target);
    await token.setMinter(owner.address);
    await token.mintForFee(alice.address, usd("10101.010102")); // the fee volume that mints 1,000,000 OLQ (1% of supply)
    const stake = await token.balanceOf(alice.address);
    await token.connect(alice).approve(staking.target, stake);
    await staking.connect(alice).stake(stake);

    let sent = 0n;
    for (let i = 0; i < 100; i++) {
      await usdc.mint(staking.target, usd(0.9)); // the stakers' share of one ordinary winning close
      sent += usd(0.9);
      await staking.connect(anyone).claim(); // needs no stake: it only runs _sync
    }
    const b0 = await usdc.balanceOf(alice.address);
    await staking.connect(alice).claim();
    const got = (await usdc.balanceOf(alice.address)) - b0;
    note(
      `${Number(ethers.formatEther(stake)).toFixed(0)} OLQ staked by one account; ${f6(sent)} USDC of fees arrived; ` +
        `claimable ${f6(got)}; left in the contract with no way out ${f6(await usdc.balanceOf(staking.target))}`
    );
    expect(got, "sole staker's claim").to.be.closeTo(sent, usd(1));
  });

  it("E6 [low] after expiry the premium owed does not depend on how often the market is poked", async () => {
    const run = async (pokes) => {
      const { engine, alice, expiry } = await eventSetup({ hazardScale: px(0.01), boostEnabled: true }, 2);
      await engine.connect(alice).open(EVT, true, usd(100), 2, true, "0x"); // borrows 200 shares
      await time.setNextBlockTimestamp(expiry);
      await engine.poke(EVT); // both runs are identical up to expiry
      const [atExpiry] = await engine.positionsOf(alice.address);
      for (let i = 1; i <= pokes; i++) {
        await time.setNextBlockTimestamp(expiry + (i * 10 * HOUR) / pokes);
        await engine.poke(EVT);
      }
      const [end] = await engine.positionsOf(alice.address);
      return f6(end.boostPremium) - f6(atExpiry.boostPremium);
    };
    const once = await run(1);
    const hourly = await run(10);
    note(`premium for the ten hours after expiry: ${once.toFixed(3)} with one poke at the end, ${hourly.toFixed(3)} with one an hour`);
    expect(once, "ten hours at the one-hour floor: 200 * 0.25 * 0.01 * 10 = 5.00").to.be.closeTo(hourly, 0.05);
  });

  it("E7 [low] the crowded side still accrues the crowding fee while the reference depth reads zero", async () => {
    const run = async (depth) => {
      const { engine, alice, hold } = await btcSetup({ crowdingPerDay: px(0.001) });
      await engine.connect(alice).open(BTC, true, usd(5_000), 1000, false, "0x"); // 5M long, nothing short
      await hold(BTC, P0, DAY, depth, 3600);
      const [p] = await engine.positionsOf(alice.address);
      return f6(p.crowdingFee);
    };
    const thin = await run(usd(2)); // capacity 1 USDC: skew clamps to 1
    const empty = await run(0n); // capacity 0
    note(`one day, 5M one-sided: fee ${thin} with 2 USDC of reference depth, ${empty} with none`);
    expect(empty, "fee with no capacity at all").to.be.closeTo(thin, 1);
  });

  it("E8 [low] liquidationPrice agrees with the liquidatable flag once the premium has used up the buffer", async () => {
    const { engine, alice, push } = await eventSetup({ hazardScale: px(1), boostEnabled: true }, 40);
    await engine.connect(alice).open(EVT, true, usd(100), 10, true, "0x");
    const [pos] = await engine.positionsOf(alice.address);
    let v;
    for (let d = 0; d < 70; d++) {
      await time.increase(DAY / 2);
      await push(EVT, px(0.6), DEPTH); // the position is 200 in profit throughout
      v = await engine.positionView(pos.id);
      if (v.liquidatable) break;
    }
    note(
      `long from 0.50, mid 0.60, premium ${f6(v.boostPremium)}: liquidatable=${v.liquidatable}, ` +
        `liquidationPrice reported ${f18(v.liquidationPrice)}`
    );
    expect(v.liquidatable).to.equal(true);
    // A long is liquidatable exactly when the mid is at or below its liquidation price.
    expect(f18(v.liquidationPrice), "liquidation price of a long that is liquidatable at 0.60").to.be.at.least(0.6);
  });

  it("E9 [low] no position can make the keeper's position scan revert, whatever minMargin is set to", async () => {
    const { engine, alice, bob } = await btcSetup();
    await engine.connect(alice).open(BTC, true, usd(100), 10, false, "0x");
    await engine.setParams(2000, 500, 3000, 0); // setParams accepts a zero minimum
    await engine.connect(bob).open(BTC, true, 0, 1, false, "0x").catch(() => {}); // free to send
    let scan = "ok";
    try {
      await engine.openPositions(0, 100);
    } catch (e) {
      scan = (e.message || "").split("\n")[0];
    }
    note("openPositions(0, 100) with a zero-margin position in the page:", scan);
    expect(scan).to.equal("ok");
  });
});

describe("Review, edge cases: confirmed behaviour", function () {
  this.timeout(600_000);

  it("resolved market: views do not revert, upkeep calls refuse, anyone settles, and the book empties", async () => {
    const { engine, vault, usdc, alice, bob, carol, liquidator, push } = await eventSetup({
      hazardScale: px(1),
      boostEnabled: true,
    });
    await engine.connect(alice).open(EVT, true, usd(100), 10, false, "0x");
    await engine.connect(alice).open(EVT, false, usd(100), 10, false, "0x");
    await engine.connect(bob).open(EVT, true, usd(100), 10, true, "0x");
    await engine.connect(bob).open(EVT, false, usd(100), 10, true, "0x");
    await engine.connect(carol).open(EVT, true, usd(100), 1, true, "0x");
    await engine.connect(carol).open(EVT, false, usd(100), 1, false, "0x");
    await time.increase(DAY);
    await push(EVT, px(0.5), DEPTH);
    await push(EVT, px(1), DEPTH, true);

    const all = await engine.openPositions(0, 100);
    expect(all.length).to.equal(6);
    for (const p of all) {
      expect(p.markPrice).to.equal(px(1));
      expect(p.liquidatable || p.forceClosable || p.collectable).to.equal(false);
      expect(p.equityAtMid).to.be.at.least(0n);
    }
    const mv = await engine.marketView(EVT);
    expect(mv.maxLeverageLong).to.equal(0n);
    expect(mv.boostPerDayLong + mv.feePerDayLong + mv.feePerDayShort).to.equal(0n);
    await engine.poke(EVT);
    await engine.unrealizedPnl();
    await vault.totalAssets();
    await expect(engine.collect(all[0].id, "0x")).to.be.revertedWithCustomError(engine, "MarketResolved");
    await expect(engine.forceClose(all[0].id, "0x")).to.be.revertedWithCustomError(engine, "MarketResolved");
    await expect(engine.connect(liquidator).liquidate(all[1].id, "0x")).to.be.revertedWithCustomError(engine, "MarketResolved");
    await expect(engine.connect(alice).open(EVT, true, usd(10), 1, false, "0x")).to.be.revertedWithCustomError(engine, "MarketResolved");

    const paid = [];
    for (const p of all) {
      const b = await usdc.balanceOf(p.position.owner);
      await engine.connect(liquidator).close(p.id, "0x"); // a stranger settles for the owner
      paid.push(f6((await usdc.balanceOf(p.position.owner)) - b));
    }
    expect(paid[0]).to.be.closeTo(190, 0.01); // free 10x YES: capped at the outright win
    expect(paid[2]).to.be.closeTo(1000, 0.01); // boosted 10x YES: 100 + 1,000 less the 10% share
    expect(paid[4]).to.equal(190); // 1x YES
    expect([paid[1], paid[3], paid[5]]).to.deep.equal([0, 0, 0]); // NO loses its margin and no more
    expect(await vault.reserved()).to.equal(0n);
    expect(await vault.marginHeld()).to.equal(0n);
    const s = (await engine.marketView(EVT)).state;
    expect([s.longOI, s.shortOI, s.longUnits, s.shortUnits, s.longBorrowed, s.shortBorrowed]).to.deep.equal([0n, 0n, 0n, 0n, 0n, 0n]);
  });

  it("Boost at 1x borrows nothing and pays nothing; a book with no borrowed shares has no skew and no division by zero", async () => {
    const { engine, alice, bob, push } = await eventSetup({ hazardScale: px(1), boostEnabled: true });
    await engine.connect(alice).open(EVT, true, usd(100), 1, true, "0x");
    await engine.connect(bob).open(EVT, false, usd(100), 1, false, "0x");
    await time.increase(30 * DAY);
    await push(EVT, px(0.5), DEPTH);
    await engine.poke(EVT);
    const [pa] = await engine.positionsOf(alice.address);
    const [pb] = await engine.positionsOf(bob.address);
    expect(pa.position.borrowedUnits).to.equal(0n);
    expect(pa.position.reserve).to.equal(usd(100)); // same as an unboosted 1x at 0.50
    expect(pa.boostPremium + pa.crowdingFee + pb.boostPremium + pb.crowdingFee).to.equal(0n);
    const mv = await engine.marketView(EVT);
    expect(mv.feePerDayLong + mv.feePerDayShort).to.equal(0n); // zero borrowed on both sides
    expect(mv.boostPerDayLong).to.be.greaterThan(0n);
    // one side borrowed, the other not: the whole fee goes to the borrowed side, the other divides nothing
    await engine.connect(alice).open(EVT, true, usd(100), 10, false, "0x");
    const mv2 = await engine.marketView(EVT);
    expect(mv2.feePerDayLong).to.equal(mv2.boostPerDayLong);
    expect(mv2.feePerDayShort).to.equal(0n);
  });

  it("expiry passed and unresolved: no opens, 1x is left alone, leverage can be closed by anyone; expiry 0 on other markets is inert", async () => {
    const { engine, alice, bob, push, expiry } = await eventSetup({ hazardScale: px(0.01), boostEnabled: true }, 1);
    await engine.connect(alice).open(EVT, true, usd(100), 10, false, "0x");
    await engine.connect(alice).open(EVT, true, usd(100), 1, false, "0x");
    await time.increaseTo(expiry + 5);
    await push(EVT, px(0.5), DEPTH);
    const mv = await engine.marketView(EVT);
    expect(mv.maxLeverageLong).to.equal(0n);
    await expect(engine.connect(bob).open(EVT, true, usd(10), 1, false, "0x")).to.be.revertedWithCustomError(engine, "BadLeverage");
    const [lev, flat] = await engine.positionsOf(alice.address);
    expect([lev.forceClosable, flat.forceClosable]).to.deep.equal([true, false]);
    await expect(engine.connect(bob).forceClose(flat.id, "0x")).to.be.revertedWithCustomError(engine, "NotForceClosable");
    await engine.connect(bob).forceClose(lev.id, "0x");
    // a non-event market has expiry 0 and is never force-closable
    const b = await btcSetup();
    await b.engine.connect(b.alice).open(BTC, true, usd(100), 1000, false, "0x");
    const [bp] = await b.engine.positionsOf(b.alice.address);
    expect(bp.forceClosable).to.equal(false);
    await expect(b.engine.forceClose(bp.id, "0x")).to.be.revertedWithCustomError(b.engine, "NotForceClosable");
  });

  it("extreme configuration and prices do not overflow the leverage limit or the accrual", async () => {
    const { engine, vault, lp, alice, push } = await deploy();
    const huge = (reactionSeconds) =>
      marketConfig({
        isEvent: true,
        boostEnabled: true,
        maxLeverage: MAX32,
        maxProfitMult: MAX32,
        reactionSeconds,
        expiry: MAX64,
        hazardScale: px(10),
        maxGapBps: 10_000,
        maxAge: MAX32,
        kappaBps: MAX32,
        maxPositionNotional: ethers.MaxUint256,
      });
    await vault.connect(lp).deposit(usd(1_000_000), lp.address);
    for (const h of [MAX32, 1]) {
      await engine.setMarket(EVT, huge(h));
      for (const p of ["0", "0.000000000000000001", "0.000000000000000002", "0.01", "0.5", "0.99", "0.999999999999999999", "1"]) {
        await push(EVT, px(p), DEPTH);
        const mv = await engine.marketView(EVT);
        expect(mv.maxLeverageLong).to.be.at.least(1n);
        expect(mv.maxLeverageLong).to.be.at.most(25n);
      }
    }
    await push(EVT, px(0.5), DEPTH);
    await engine.connect(alice).open(EVT, true, usd(100), 25, true, "0x");
    await time.increase(4_000_000_000); // 126 years without an accrual
    await engine.poke(EVT);
    await engine.positionsOf(alice.address);
    // an absurd margin reverts cleanly rather than wrapping
    await expect(engine.connect(alice).open(EVT, true, 1n << 255n, 1, false, "0x")).to.be.reverted;
    await expect(engine.connect(alice).open(EVT, true, ethers.MaxUint256 / 2n, 2, false, "0x")).to.be.revertedWithPanic(0x11);
  });

  it("very long gaps between accruals: no overflow, and the fee still only comes out of winnings", async () => {
    const b = await btcSetup({ crowdingPerDay: px(0.05), maxAge: 4_000_000_000 });
    await b.engine.connect(b.alice).open(BTC, true, usd(5_000), 1000, false, "0x");
    await time.increase(5 * 365 * DAY);
    const [p] = await b.engine.positionsOf(b.alice.address);
    expect(p.crowdingFee).to.be.greaterThan(usd(100_000_000)); // far more than the position could ever win
    expect(p.equityAtMid).to.equal(usd(5_000));
    expect(p.liquidatable).to.equal(false);
    const b0 = await b.usdc.balanceOf(b.alice.address);
    await b.engine.connect(b.alice).close(p.id, "0x");
    expect((await b.usdc.balanceOf(b.alice.address)) - b0).to.equal(usd(5_000)); // flat close: margin back, no fee

    const e = await eventSetup({ hazardScale: px(10), boostEnabled: true, maxAge: 4_000_000_000 }, 3000);
    await e.engine.connect(e.alice).open(EVT, true, usd(100), 25, true, "0x");
    await e.engine.connect(e.bob).open(EVT, true, usd(100), 25, false, "0x");
    await time.increase(2999 * DAY);
    await e.engine.poke(EVT);
    await time.increase(3000 * DAY); // long after expiry
    await e.engine.poke(EVT);
    const [pa] = await e.engine.positionsOf(e.alice.address);
    const [pb] = await e.engine.positionsOf(e.bob.address);
    expect(pa.equityAtMid).to.equal(0n); // the premium stops at the margin
    expect(pb.equityAtMid).to.equal(usd(100)); // the crowding fee never touches margin
    const a0 = await e.usdc.balanceOf(e.alice.address);
    await e.engine.connect(e.alice).close(pa.id, "0x");
    expect((await e.usdc.balanceOf(e.alice.address)) - a0).to.equal(0n);
  });

  it("fills at the very edge: slow exactly 1 or exactly 0 gives a zero reserve, no division by zero, and a normal close", async () => {
    // YES side: the price sits at 1.00 unresolved until slow is exactly 1e18, then prints 0.97.
    const y = await eventSetup({});
    await y.hold(EVT, px(0.9), 3000, DEPTH, 60);
    await y.hold(EVT, px(0.99), 3000, DEPTH, 60);
    await y.push(EVT, px(1), DEPTH);
    await time.increase(300 * 45);
    let ts = (await time.latest()) + 1;
    await time.setNextBlockTimestamp(ts);
    let signed = await y.sign(EVT, px(0.97), DEPTH, ts);
    let data = ethers.AbiCoder.defaultAbiCoder().encode(PRICE_DATA, [[signed.update], [signed.sig]]);
    await y.engine.connect(y.alice).open(EVT, true, usd(100), 1, false, data); // fills at max(mid, slow) = 1.00
    let [p] = await y.engine.positionsOf(y.alice.address);
    expect(p.position.entryPrice).to.equal(px(1));
    expect(p.position.reserve).to.equal(0n);
    expect(p.winPrice).to.equal(px(1));
    expect(p.collectable).to.equal(false);
    await y.engine.allMarkets();
    await y.engine.unrealizedPnl();
    await y.vault.totalAssets();
    await expect(y.engine.connect(y.bob).collect(p.id, "0x")).to.be.revertedWithCustomError(y.engine, "NotCollectable");
    await y.engine.connect(y.alice).close(p.id, "0x");
    expect(await y.vault.reserved()).to.equal(0n);

    // NO side: slow exactly 0, then 0.03.
    const n = await eventSetup({});
    await n.hold(EVT, px(0.1), 3000, DEPTH, 60);
    await n.hold(EVT, px(0.01), 3000, DEPTH, 60);
    await n.push(EVT, 0n, DEPTH);
    await time.increase(300 * 45);
    ts = (await time.latest()) + 1;
    await time.setNextBlockTimestamp(ts);
    signed = await n.sign(EVT, px(0.03), DEPTH, ts);
    data = ethers.AbiCoder.defaultAbiCoder().encode(PRICE_DATA, [[signed.update], [signed.sig]]);
    await n.engine.connect(n.alice).open(EVT, false, usd(100), 1, false, data); // NO bought at 1.00
    [p] = await n.engine.positionsOf(n.alice.address);
    expect(p.position.entryPrice).to.equal(0n);
    expect(p.position.reserve).to.equal(0n);
    await n.engine.openPositions(0, 10);
    await n.vault.totalAssets();
    await n.push(EVT, 0n, DEPTH); // unresolved print at exactly zero
    await n.engine.allMarkets();
    await n.engine.unrealizedPnl();
    await n.engine.connect(n.alice).close(p.id, "0x");

    // The range check itself is on the mid, inclusive at both ends.
    const r = await eventSetup({});
    await r.hold(EVT, px(0.9), 3000, DEPTH, 60);
    await r.hold(EVT, px(0.99), 6000, DEPTH, 60);
    await r.engine.connect(r.alice).open(EVT, true, usd(100), 1, false, "0x");
    await r.engine.connect(r.alice).open(EVT, false, usd(100), 1, false, "0x");
    await expect(r.engine.connect(r.alice).open(EVT, false, usd(100), 2, false, "0x")).to.be.revertedWithCustomError(r.engine, "BadLeverage");
    const [yes, no] = await r.engine.positionsOf(r.alice.address);
    expect(no.position.reserve).to.equal(usd(1_000)); // 100 * 0.99 / 0.01 = 9,900, held to 10x margin
    expect(yes.position.reserve).to.be.closeTo(usd(1.0101), usd(0.01));
  });

  // Random sequences of opens, closes, price moves (including prints at 0.001, 0.999, 0 and 1), time
  // jumps, pokes, and the upkeep the views advertise, then a resolution. Checked after every step:
  // no view reverts, vault cash covers marginHeld + reserved, an owner's close with a fresh price
  // never reverts, no payout exceeds margin + reserve, and the book is empty at the end.
  function rng(seed) {
    let s = seed >>> 0;
    return () => {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      return s / 4294967296;
    };
  }
  const OPEN_REFUSALS = /PriceDislocated|EntryTooFarFromMid|SideCapExceeded|EventPriceOutOfRange|BadLeverage|InsufficientLiquidity|PositionTooLarge|StalePrice/;

  async function randomRun(seed, steps, overrides, daysOut) {
    const r = rng(seed);
    const { engine, vault, oracle, lp, alice, bob, carol, liquidator, push } = await deploy();
    const expiry = (await time.latest()) + daysOut * DAY;
    await engine.setMarket(
      EVT,
      marketConfig({ isEvent: true, maxLeverage: 50, profitFeeBps: 1000, maxGapBps: 500, expiry, maxPositionNotional: usd(1_000_000), ...overrides })
    );
    await engine.setMarket(BTC, marketConfig({ crowdingPerDay: px(0.002) }));
    await vault.connect(lp).deposit(usd(3_000_000), lp.address);
    let pe = 0.5;
    let pb = 60_000;
    await push(EVT, px(pe.toFixed(6)), DEPTH);
    await push(BTC, px(pb.toFixed(2)));
    const traders = [alice, bob, carol];
    const problems = [];
    const stats = { opened: 0, refused: 0, closed: 0, liquidated: 0, collected: 0, forced: 0 };
    const first = (e) => (e.message || "").split("\n")[0];

    const checkPayout = async (tx, pos) => {
      const rc = await tx.wait();
      for (const lg of rc.logs) {
        if (lg.address !== engine.target) continue;
        const ev = engine.interface.parseLog(lg);
        if (ev?.name === "PositionClosed" && ev.args.payout > pos.position.margin + pos.position.reserve)
          problems.push(`payout ${ev.args.payout} above margin + reserve for #${pos.id}`);
      }
    };
    const check = async (tag) => {
      try {
        const [cash, held, reserved] = await Promise.all([vault.cash(), vault.marginHeld(), vault.reserved()]);
        if (cash < held + reserved) problems.push(`${tag}: cash ${cash} below marginHeld + reserved ${held + reserved}`);
        await engine.allMarkets();
        await engine.unrealizedPnl();
        await vault.totalAssets();
        return await engine.openPositions(0, 1000);
      } catch (e) {
        problems.push(`${tag}: a view reverted: ${first(e)}`);
        return [];
      }
    };

    for (let i = 0; i < steps; i++) {
      const a = r();
      if (a < 0.3) {
        const k = r();
        let print;
        if (k < 0.6) print = pe = Math.min(0.995, Math.max(0.005, pe + (r() - 0.5) * 0.04));
        else if (k < 0.85) print = pe = Math.min(0.995, Math.max(0.005, pe + (r() - 0.5) * 0.6));
        else {
          print = [0.001, 0.999, 0.01, 0.99, 0, 1][Math.floor(r() * 6)];
          pe = Math.min(0.995, Math.max(0.005, print));
        }
        await push(EVT, px(print.toFixed(6)), DEPTH);
      } else if (a < 0.4) {
        pb *= 1 + (r() - 0.5) * (r() < 0.8 ? 0.001 : 0.05);
        await push(BTC, px(pb.toFixed(2)));
      } else if (a < 0.5) {
        await time.increase(Math.floor(r() < 0.7 ? r() * 600 : r() * 3 * DAY) + 1);
        await push(EVT, px(pe.toFixed(6)), DEPTH);
        await push(BTC, px(pb.toFixed(2)));
      } else if (a < 0.75) {
        const who = traders[Math.floor(r() * 3)];
        const isEvt = r() < 0.7;
        const m = isEvt ? EVT : BTC;
        const maxLev = Number((await engine.marketView(m)).maxLeverageLong);
        const lev = Math.max(1, Math.floor(r() * r() * (maxLev + 2)));
        const boost = Boolean(isEvt && overrides.boostEnabled && r() < 0.4);
        try {
          await engine.connect(who).open(m, r() < 0.5, usd(1 + Math.floor(r() * 500)), lev, boost, "0x");
          stats.opened++;
        } catch (e) {
          if (!OPEN_REFUSALS.test(first(e))) problems.push(`open reverted unexpectedly: ${first(e)}`);
          stats.refused++;
        }
      } else if (a < 0.8) {
        await engine.poke(r() < 0.5 ? EVT : BTC);
      } else {
        const all = await engine.openPositions(0, 1000);
        if (all.length) {
          const p = all[Math.floor(r() * all.length)];
          if (Number(p.position.marketId) === EVT) await push(EVT, px(pe.toFixed(6)), DEPTH);
          else await push(BTC, px(pb.toFixed(2)));
          const owner = traders.find((t) => t.address === p.position.owner);
          try {
            await checkPayout(await engine.connect(owner).close(p.id, "0x"), p);
            stats.closed++;
          } catch (e) {
            problems.push(`owner close of #${p.id} reverted: ${first(e)}`);
          }
        }
      }

      for (const p of await check(`step ${i}`)) {
        const age = (await time.latest()) - Number((await oracle.read(p.position.marketId)).timestamp);
        if (age > 28) continue;
        const act = p.liquidatable ? "liquidate" : p.collectable ? "collect" : p.forceClosable ? "forceClose" : null;
        if (!act) continue;
        try {
          await checkPayout(await engine.connect(liquidator)[act](p.id, "0x"), p);
          stats[{ liquidate: "liquidated", collect: "collected", forceClose: "forced" }[act]]++;
        } catch (e) {
          // The view runs one block before the transaction and the slow price moves in between.
          if (!/NotCollectable|NotLiquidatable|NotForceClosable/.test(first(e))) problems.push(`${act} #${p.id}: ${first(e)}`);
        }
      }
    }

    await push(EVT, r() < 0.5 ? px(1) : 0n, DEPTH, true);
    for (const p of await check("resolved")) {
      try {
        if (Number(p.position.marketId) === EVT) await checkPayout(await engine.connect(liquidator).close(p.id, "0x"), p);
        else {
          await push(BTC, px(pb.toFixed(2)));
          const owner = traders.find((t) => t.address === p.position.owner);
          await checkPayout(await engine.connect(owner).close(p.id, "0x"), p);
        }
      } catch (e) {
        problems.push(`final close of #${p.id}: ${first(e)}`);
      }
    }
    const [held, reserved, open] = await Promise.all([vault.marginHeld(), vault.reserved(), engine.openPositionCount()]);
    if (held !== 0n || reserved !== 0n || open !== 0n) problems.push(`left over: marginHeld ${held}, reserved ${reserved}, open ${open}`);
    for (const m of [EVT, BTC]) {
      const s = (await engine.marketView(m)).state;
      for (let j = 0; j < 6; j++) if (s[j] !== 0n) problems.push(`market ${m}: state[${j}] is ${s[j]} with nothing open`);
    }
    return { stats, problems };
  }

  for (const [seed, overrides, daysOut] of [
    [1, { hazardScale: px(1), boostEnabled: true }, 300],
    [2, { hazardScale: px(1), boostEnabled: true, reactionSeconds: 120 }, 5],
    [4, {}, 30],
  ]) {
    it(`random sequence ${seed}: no unexpected revert, vault always covered, book empties`, async () => {
      const { stats, problems } = await randomRun(seed, 200, overrides, daysOut);
      note(JSON.stringify(stats));
      for (const p of problems.slice(0, 10)) note("PROBLEM", p);
      expect(problems).to.deep.equal([]);
    });
  }
});
