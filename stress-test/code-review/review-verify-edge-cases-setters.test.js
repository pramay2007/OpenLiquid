// Second-reviewer verification of the edge-case finding
//   "The setters accept configurations that break views, closes or Boost pricing
//    (owner-only, but nothing stops them)", parts (a) to (d).
//
// review-verify-edge-cases.test.js already holds the verification of another finding, so this
// one has its own file.
//
// Every test here PASSES against the contracts as reviewed (PerpEngine.sol 2026-11-19 21:34):
// each one pins the behaviour the finding claims, so a green run means the claim reproduces.
// The tests also pin where each claim stops (what keeps working, who can undo it), because that
// is what decides the severity and the shape of the fix. Once the engine is fixed the "reverts
// with panic" assertions are expected to change.
//
// Run only this file:  npx hardhat test test/review-verify-edge-cases-setters.test.js

const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");
const { deploy, marketConfig, usd, px, BTC, EVT } = require("./helpers");

const DAY = 86_400;
const DEPTH = usd(2_000_000);
const P0 = px(60_000);
const UNDERFLOW = 0x11; // Solidity panic: arithmetic underflow or overflow
const DIV_BY_ZERO = 0x12; // Solidity panic: division by zero
const f6 = (v) => Number(ethers.formatUnits(v, 6));
const note = (...a) => console.log("        ", ...a);

async function btcSetup(overrides = {}, lpDeposit = 5_000_000) {
  const ctx = await deploy();
  await ctx.engine.setMarket(BTC, marketConfig(overrides));
  await ctx.vault.connect(ctx.lp).deposit(usd(lpDeposit), ctx.lp.address);
  await ctx.push(BTC, P0);
  return ctx;
}

async function eventSetup(overrides = {}, daysOut = 300, p0 = 0.5) {
  const ctx = await deploy();
  ctx.expiry = (await time.latest()) + daysOut * DAY;
  ctx.eventConfig = marketConfig({
    isEvent: true,
    maxLeverage: 50,
    profitFeeBps: 1000,
    maxGapBps: 500,
    expiry: ctx.expiry,
    maxPositionNotional: usd(1_000_000),
    ...overrides,
  });
  await ctx.engine.setMarket(EVT, ctx.eventConfig);
  await ctx.vault.connect(ctx.lp).deposit(usd(1_000_000), ctx.lp.address);
  await ctx.push(EVT, px(p0), DEPTH);
  return ctx;
}

/** The position scan exactly as keeper/src/index.js sweep() does it: one try around every page. */
async function keeperScan(engine, page = 100) {
  const count = Number(await engine.openPositionCount());
  let seen = 0;
  try {
    for (let offset = 0; offset < count; offset += page) {
      seen += (await engine.openPositions(offset, page)).length;
    }
    return { count, seen, error: null };
  } catch (e) {
    return { count, seen, error: (e.message || "").split("\n")[0] };
  }
}

async function paidTo(usdc, who, action) {
  const before = await usdc.balanceOf(who.address);
  await action();
  return (await usdc.balanceOf(who.address)) - before;
}

describe("Verify (a): a zero minimum margin lets any account break the position scan", function () {
  this.timeout(300_000);

  it("A1 setParams takes a zero minimum; an account with no USDC then opens on zero margin, and every view that includes it panics 0x12", async () => {
    const { engine, vault, usdc, alice, bob, liquidator: stranger } = await btcSetup();
    await engine.connect(alice).open(BTC, true, usd(100), 10, false, "0x"); // #1
    await engine.connect(bob).open(BTC, false, usd(100), 10, false, "0x"); // #2
    // As deployed (minMargin = 1 USDC) the same open is refused.
    await expect(engine.connect(stranger).open(BTC, true, 0, 1, false, "0x")).to.be.revertedWithCustomError(
      engine,
      "BadMargin"
    );

    await engine.setParams(2000, 500, 3000, 0); // accepted
    expect(await engine.minMargin()).to.equal(0n);
    expect(await usdc.balanceOf(stranger.address)).to.equal(0n);
    expect(await usdc.allowance(stranger.address, vault.target)).to.equal(0n);
    await engine.connect(stranger).open(BTC, true, 0, 1, false, "0x"); // #3: no USDC, no allowance, gas only
    const z = await engine.positions(3);
    expect([z.owner, z.margin, z.notional, z.reserve]).to.deep.equal([stranger.address, 0n, 0n, 0n]);
    expect(await engine.openPositionCount()).to.equal(3n);
    expect(await vault.marginHeld()).to.equal(usd(200)); // nothing was locked for it

    await expect(engine.positionView(3)).to.be.revertedWithPanic(DIV_BY_ZERO);
    await expect(engine.openPositions(0, 100)).to.be.revertedWithPanic(DIV_BY_ZERO);
    await expect(engine.positionsOf(stranger.address)).to.be.revertedWithPanic(DIV_BY_ZERO);

    // Where it stops: only calls that include that position. Other pages, other accounts,
    // the market views, the mark and the vault are untouched.
    expect((await engine.openPositions(0, 2)).length).to.equal(2);
    await expect(engine.openPositions(2, 1)).to.be.revertedWithPanic(DIV_BY_ZERO);
    expect((await engine.positionsOf(alice.address)).length).to.equal(1);
    await engine.positionView(1);
    await engine.allMarkets();
    expect(await engine.unrealizedPnl()).to.equal(0n);
    expect(await vault.totalAssets()).to.equal(usd(5_000_000));
  });

  it("A1b the same on an event market, either side", async () => {
    const { engine, liquidator: stranger } = await eventSetup();
    await engine.setParams(2000, 500, 3000, 0);
    await engine.connect(stranger).open(EVT, true, 0, 1, false, "0x"); // #1
    await engine.connect(stranger).open(EVT, false, 0, 1, false, "0x"); // #2
    await expect(engine.positionView(1)).to.be.revertedWithPanic(DIV_BY_ZERO);
    await expect(engine.positionView(2)).to.be.revertedWithPanic(DIV_BY_ZERO);
    await expect(engine.openPositions(0, 100)).to.be.revertedWithPanic(DIV_BY_ZERO);
  });

  it("A2 the keeper's scan stops at the page that holds it: a liquidatable position goes unfound, and the bad page moves forward as others close", async () => {
    const { engine, usdc, alice, bob, carol, liquidator: stranger, push } = await btcSetup();
    await engine.connect(alice).open(BTC, true, usd(100), 1000, false, "0x"); // #1: stop 8 bps below entry
    await engine.connect(bob).open(BTC, false, usd(100), 10, false, "0x"); // #2
    await engine.connect(carol).open(BTC, true, usd(100), 10, false, "0x"); // #3
    await engine.setParams(2000, 500, 3000, 0);
    await engine.connect(stranger).open(BTC, true, 0, 1, false, "0x"); // #4
    await push(BTC, px(59_946)); // 9 bps down: #1 has 10 of equity left, under the 20 maintenance level
    expect((await engine.positionView(1)).liquidatable).to.equal(true);

    // The keeper's real page size: all four are in page 0, so it sees nothing at all.
    const real = await keeperScan(engine, 100);
    note("keeper scan, page 100:", JSON.stringify(real));
    expect(real).to.include({ count: 4, seen: 0 });
    expect(real.error).to.match(/0x12/);

    // A scaled-down keeper (page 2) shows the page boundary: [#1,#2] is read, [#3,#4] is not.
    expect(await keeperScan(engine, 2)).to.include({ count: 4, seen: 2 });

    // The engine itself is not blocked: named by id, the position liquidates. Discovery is what is lost.
    const reward = await paidTo(usdc, bob, () => engine.connect(bob).liquidate(1, "0x"));
    expect(reward).to.equal(usd(5));

    // Removing #1 swaps the last entry (#4) into its slot: the set now reads [#4, #2, #3], the
    // first page reverts, and sweep() never reaches the pages after it.
    const after = await keeperScan(engine, 2);
    note("scaled keeper scan after one liquidation, page 2:", JSON.stringify(after));
    expect(after).to.include({ count: 3, seen: 0 });
    expect((await engine.openPositions(1, 2)).length).to.equal(2);
  });

  it("A3 who can undo it: the owner of the position, or anyone through collect() or liquidate(); raising the minimum again does not", async () => {
    const { engine, alice, bob, liquidator: stranger, push } = await btcSetup();
    await engine.connect(alice).open(BTC, true, usd(100), 10, false, "0x"); // #1
    await engine.setParams(2000, 500, 3000, 0);
    await engine.connect(stranger).open(BTC, true, 0, 1, false, "0x"); // #2
    await engine.setParams(2000, 500, 3000, usd(1)); // the minimum is back; the position is still there
    await expect(engine.openPositions(0, 100)).to.be.revertedWithPanic(DIV_BY_ZERO);

    // Not "until that account closes": P&L 0 >= reserve 0, so anyone may collect it.
    await engine.connect(bob).collect(2, "0x");
    expect((await engine.openPositions(0, 100)).length).to.equal(1);

    // While the minimum is zero it comes straight back, for gas.
    await engine.setParams(2000, 500, 3000, 0);
    await engine.connect(stranger).open(BTC, true, 0, 1, false, "0x"); // #3
    await expect(engine.openPositions(0, 100)).to.be.revertedWithPanic(DIV_BY_ZERO);
    // Equity 0 <= maintenance 0, so anyone may liquidate it too.
    await engine.connect(bob).liquidate(3, "0x");
    expect((await engine.openPositions(0, 100)).length).to.equal(1);

    await push(BTC, P0);
    await engine.connect(stranger).open(BTC, true, 0, 1, false, "0x"); // #4
    await engine.connect(stranger).close(4, "0x"); // and its owner can close it
    expect((await engine.openPositions(0, 100)).length).to.equal(1);

    // Only exactly zero does it: the smallest non-zero margin gives a non-zero notional.
    await engine.connect(alice).open(BTC, true, 1, 1, false, "0x"); // one millionth of a USDC
    const all = await engine.openPositions(0, 100);
    expect(all.length).to.equal(2);
    expect(all[1].position.notional).to.equal(1n);
  });
});

describe("Verify (b): Boost can be switched on with no premium", function () {
  this.timeout(300_000);

  it("B1 boostEnabled with hazardScale 0 is accepted: a boosted 10x on 100 reserves 1,000, pays nothing over 100 days, and keeps the whole leveraged win", async () => {
    const { engine, usdc, alice, bob, liquidator: stranger, push } = await eventSetup({
      boostEnabled: true,
      hazardScale: 0n,
    }); // setMarket did not revert
    const c = await engine.markets(EVT);
    expect([c.isEvent, c.boostEnabled, c.hazardScale]).to.deep.equal([true, true, 0n]);

    await engine.connect(alice).open(EVT, true, usd(100), 10, true, "0x"); // #1 boosted
    await engine.connect(bob).open(EVT, true, usd(100), 10, false, "0x"); // #2 free mode, same size
    let [a] = await engine.positionsOf(alice.address);
    const [b] = await engine.positionsOf(bob.address);
    expect(a.position.boosted).to.equal(true);
    expect(a.position.reserve).to.equal(usd(1_000));
    expect(b.position.reserve).to.equal(usd(100));
    expect(a.position.borrowedUnits).to.equal(b.position.borrowedUnits);
    expect(a.position.borrowedUnits).to.be.greaterThan(0n); // 1,800 borrowed shares that the premium is charged on

    await time.increase(100 * DAY);
    await push(EVT, px(0.5), DEPTH);
    await engine.poke(EVT);
    [a] = await engine.positionsOf(alice.address);
    expect(a.boostPremium).to.equal(0n);
    expect(a.equityAtMid).to.equal(usd(100));
    expect((await engine.marketView(EVT)).boostPerDayLong).to.equal(0n);

    // The upside the premium is the price of: the result arrives as a jump from 0.50.
    await push(EVT, px(1), DEPTH, true);
    const boosted = await paidTo(usdc, alice, () => engine.connect(stranger).close(1, "0x"));
    const free = await paidTo(usdc, bob, () => engine.connect(stranger).close(2, "0x"));
    note("YES result from 0.50, 10x on 100: boosted paid", f6(boosted), "| free mode paid", f6(free), "| premium paid 0");
    expect(boosted).to.equal(usd(1_000)); // 100 + 1,000 less the 10% profit share
    expect(free).to.equal(usd(190)); // 100 + 100 less the 10% profit share
  });

  it("B2 for scale: at hazardScale 1 the same position owes about 180 over the same 100 days, more than its whole margin", async () => {
    const { engine, alice, push } = await eventSetup({ boostEnabled: true, hazardScale: px(1) });
    await engine.connect(alice).open(EVT, true, usd(100), 10, true, "0x");
    await time.increase(100 * DAY);
    await push(EVT, px(0.5), DEPTH);
    const [a] = await engine.positionsOf(alice.address);
    note("premium accrued at hazardScale 1 over 100 days:", f6(a.boostPremium));
    expect(f6(a.boostPremium)).to.be.closeTo(180, 0.5);
    expect(a.equityAtMid).to.equal(0n);
    expect(a.liquidatable).to.equal(true);
  });
});

describe("Verify (c): the market kind can be flipped under open positions", function () {
  this.timeout(300_000);

  it("C1 BTC flipped to isEvent with positions open: the mark, the vault and everything touching a short revert 0x11 until it is flipped back", async () => {
    const { engine, vault, usdc, lp, alice, bob, carol, liquidator: stranger, push } = await btcSetup();
    await engine.connect(alice).open(BTC, true, usd(100), 10, false, "0x"); // #1 long
    await engine.connect(bob).open(BTC, false, usd(100), 10, false, "0x"); // #2 short
    await engine.connect(carol).open(BTC, true, usd(100), 10, false, "0x"); // #3 long
    const nav0 = await vault.totalAssets();

    await engine.setMarket(BTC, marketConfig({ isEvent: true })); // accepted with three positions open
    await push(BTC, P0); // the price is fresh throughout

    const reverting = {
      "engine.unrealizedPnl": () => engine.unrealizedPnl(),
      "vault.totalAssets": () => vault.totalAssets(),
      "vault.maxWithdraw": () => vault.maxWithdraw(lp.address),
      "vault.previewDeposit": () => vault.previewDeposit(usd(1)),
      "vault.deposit": () => vault.connect(lp).deposit(usd(1), lp.address),
      "vault.withdraw": () => vault.connect(lp).withdraw(usd(1), lp.address, lp.address),
      "vault.redeem": () => vault.connect(lp).redeem(1n, lp.address, lp.address),
      "engine.openPositions": () => engine.openPositions(0, 100),
      "engine.positionView(short)": () => engine.positionView(2),
      "engine.positionsOf(short owner)": () => engine.positionsOf(bob.address),
      "close(short)": () => engine.connect(bob).close(2, "0x"),
      "liquidate(short)": () => engine.connect(carol).liquidate(2, "0x"),
      "collect(short)": () => engine.connect(carol).collect(2, "0x"),
      "forceClose(short)": () => engine.connect(carol).forceClose(2, "0x"),
    };
    for (const [name, call] of Object.entries(reverting)) {
      await expect(call(), name).to.be.revertedWithPanic(UNDERFLOW);
    }

    // Where it stops. With expiry 0 the market reads as expired, so marketView returns before
    // the subtraction; longs can be viewed and closed; nothing new can be opened.
    expect((await engine.marketView(BTC)).maxLeverageLong).to.equal(0n);
    await engine.allMarkets();
    await expect(engine.connect(alice).open(BTC, true, usd(100), 1, false, "0x")).to.be.revertedWithCustomError(
      engine,
      "EventPriceOutOfRange"
    );
    // A side effect the finding does not list: every leveraged long is now above the "time
    // limit" of 1x, so anyone can force-close it.
    expect((await engine.positionView(3)).forceClosable).to.equal(true);
    expect(await paidTo(usdc, carol, () => engine.connect(stranger).forceClose(3, "0x"))).to.equal(usd(100));
    expect(await paidTo(usdc, alice, () => engine.connect(alice).close(1, "0x"))).to.equal(usd(100));

    // With an expiry in the future the market views go too.
    await engine.setMarket(BTC, marketConfig({ isEvent: true, expiry: (await time.latest()) + 300 * DAY }));
    await expect(engine.marketView(BTC)).to.be.revertedWithPanic(UNDERFLOW);
    await expect(engine.allMarkets()).to.be.revertedWithPanic(UNDERFLOW);

    // Flipping back restores everything; nothing was lost in between (to the last unit of the mark's rounding).
    await engine.setMarket(BTC, marketConfig());
    await push(BTC, P0);
    expect(nav0 - (await vault.totalAssets())).to.be.within(0n, 1n);
    expect((await engine.openPositions(0, 100)).length).to.equal(1);
    await engine.allMarkets();
    expect(await paidTo(usdc, bob, () => engine.connect(bob).close(2, "0x"))).to.equal(usd(100));
    expect(await vault.marginHeld()).to.equal(0n);
    expect(await vault.reserved()).to.equal(0n);
  });

  it("C2 the other direction: an event market flipped to a non-event one marks a flat NO as a 200 win and its close reverts 0x11", async () => {
    const ctx = await eventSetup();
    const { engine, vault, usdc, alice, hold } = ctx;
    await hold(EVT, px(0.25), 3000, DEPTH, 60);
    await engine.connect(alice).open(EVT, false, usd(300), 1, false, "0x"); // 400 NO at 0.75, reserve 100
    const nav0 = await vault.totalAssets();
    expect(await engine.unrealizedPnl()).to.equal(0n);

    await engine.setMarket(EVT, { ...ctx.eventConfig, isEvent: false }); // accepted
    expect(await engine.unrealizedPnl()).to.equal(usd(200)); // 300 - 400 * 0.25, on a position that has not moved
    expect(nav0 - (await vault.totalAssets())).to.equal(usd(100)); // LP value down by the whole reserve
    // The close subtracts 300 / 0.25 = 1,200 units where 300 / 0.75 = 400 were added.
    await expect(engine.connect(alice).close(1, "0x")).to.be.revertedWithPanic(UNDERFLOW);

    await engine.setMarket(EVT, ctx.eventConfig);
    expect(await vault.totalAssets()).to.equal(nav0);
    const back = await paidTo(usdc, alice, () => engine.connect(alice).close(1, "0x"));
    expect(f6(back)).to.be.closeTo(300, 0.05);
  });
});

describe("Verify (d): an event price above 1.00", function () {
  this.timeout(300_000);

  it("D1 an unresolved print one wei above 1.00 makes marketView, allMarkets, unrealizedPnl and the vault revert 0x11; the paths that clamp keep working; the next print clears it", async () => {
    const { engine, vault, lp, alice, bob, push } = await eventSetup({
      hazardScale: px(1),
      boostEnabled: true,
      reactionSeconds: 120,
    });
    await engine.connect(alice).open(EVT, true, usd(100), 5, false, "0x"); // #1
    await engine.connect(bob).open(EVT, false, usd(100), 1, false, "0x"); // #2

    await push(EVT, px(1), DEPTH); // exactly 1.00, unresolved: fine
    expect((await engine.marketView(EVT)).maxLeverageLong).to.equal(1n);
    await engine.allMarkets();
    await engine.unrealizedPnl();
    await vault.totalAssets();

    await push(EVT, px(1) + 1n, DEPTH); // the oracle stores whatever is signed
    const reverting = {
      "engine.marketView": () => engine.marketView(EVT),
      "engine.allMarkets": () => engine.allMarkets(),
      "engine.unrealizedPnl": () => engine.unrealizedPnl(),
      "vault.totalAssets": () => vault.totalAssets(),
      "vault.maxWithdraw": () => vault.maxWithdraw(lp.address),
      "vault.deposit": () => vault.connect(lp).deposit(usd(1), lp.address),
      "vault.redeem": () => vault.connect(lp).redeem(1n, lp.address, lp.address),
    };
    for (const [name, call] of Object.entries(reverting)) {
      await expect(call(), name).to.be.revertedWithPanic(UNDERFLOW);
    }
    // _deltas and _timeLeverage clamp, so accrual and the position scan are unaffected.
    await engine.poke(EVT);
    expect((await engine.openPositions(0, 100)).length).to.equal(2);

    await push(EVT, px(0.5), DEPTH);
    await engine.allMarkets();
    await engine.unrealizedPnl();
    await vault.totalAssets();
    await vault.connect(lp).deposit(usd(1), lp.address);
  });

  it("D2 no position needs to be open; after expiry marketView stops reverting but the mark and the vault still do", async () => {
    const { engine, vault, lp, push, expiry } = await eventSetup({}, 2);
    expect(await engine.openPositionCount()).to.equal(0n);
    await push(EVT, px(1.5), DEPTH);
    await expect(engine.marketView(EVT)).to.be.revertedWithPanic(UNDERFLOW);
    await expect(engine.unrealizedPnl()).to.be.revertedWithPanic(UNDERFLOW);
    await expect(vault.totalAssets()).to.be.revertedWithPanic(UNDERFLOW);
    await expect(vault.connect(lp).redeem(1n, lp.address, lp.address)).to.be.revertedWithPanic(UNDERFLOW);

    await time.increaseTo(expiry + 1);
    expect((await engine.marketView(EVT)).maxLeverageLong).to.equal(0n); // returns before the subtraction
    await expect(engine.unrealizedPnl()).to.be.revertedWithPanic(UNDERFLOW);
    await expect(vault.totalAssets()).to.be.revertedWithPanic(UNDERFLOW);
  });

  it("D3 beyond the claim: a RESOLVED print above 1.00 is frozen in the feed, so the vault stays shut after every position has settled; the only way out today is the owner flipping isEvent", async () => {
    const ctx = await eventSetup();
    const { engine, vault, usdc, oracle, lp, alice, bob, liquidator: stranger, push } = ctx;
    await engine.connect(alice).open(EVT, true, usd(100), 1, false, "0x"); // #1
    await engine.connect(bob).open(EVT, false, usd(100), 1, false, "0x"); // #2
    await push(EVT, px(100), DEPTH, true); // "YES" signed as 100 instead of 1

    await expect(vault.totalAssets()).to.be.revertedWithPanic(UNDERFLOW);
    // Settlement itself is unaffected: the win is capped at the reserve, the loss at the margin.
    expect(await paidTo(usdc, alice, () => engine.connect(stranger).close(1, "0x"))).to.equal(usd(190));
    expect(await paidTo(usdc, bob, () => engine.connect(stranger).close(2, "0x"))).to.equal(0n);
    expect(await engine.openPositionCount()).to.equal(0n);

    // The book is empty and the vault is still shut; a corrected print is ignored after resolution.
    await push(EVT, px(1), DEPTH, true);
    expect((await oracle.read(EVT)).mid).to.equal(px(100));
    await expect(engine.unrealizedPnl()).to.be.revertedWithPanic(UNDERFLOW);
    await expect(vault.connect(lp).redeem(1n, lp.address, lp.address)).to.be.revertedWithPanic(UNDERFLOW);
    await expect(vault.connect(lp).deposit(usd(1), lp.address)).to.be.revertedWithPanic(UNDERFLOW);

    // The way out as the code stands. A fix for (c) that froze isEvent for good, without the
    // clamp for (d), would close it.
    await engine.setMarket(EVT, { ...ctx.eventConfig, isEvent: false });
    expect(await engine.unrealizedPnl()).to.equal(0n);
    const out = await paidTo(usdc, lp, async () =>
      vault.connect(lp).redeem(await vault.balanceOf(lp.address), lp.address, lp.address)
    );
    note("LP redeems after the owner re-types the resolved market:", f6(out));
    expect(f6(out)).to.be.closeTo(1_000_010, 0.01); // 1,000,000 + 100 lost by the NO - 90 paid to the YES after the 10 profit share
  });
});

describe("Fix design: what 'listed' means in setMarket", function () {
  it("F1 anyone can make an unlisted id look listed (lastAccrual != 0, isEvent false) with poke(), so the isEvent guard must not be keyed on lastAccrual", async () => {
    const { engine, bob } = await deploy();
    const NEW = 7;
    await engine.connect(bob).poke(NEW);
    expect((await engine.states(NEW)).lastAccrual).to.not.equal(0n);
    expect((await engine.markets(NEW)).isEvent).to.equal(false);
    // Today the owner can still list it as an event market. "Refuse to change isEvent once
    // lastAccrual is set" would refuse this, for any id a stranger has poked.
    await engine.setMarket(NEW, marketConfig({ isEvent: true, expiry: (await time.latest()) + 30 * DAY }));
    expect((await engine.markets(NEW)).isEvent).to.equal(true);
  });
});
