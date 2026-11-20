const { expect } = require("chai");
const { time, loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { deploy, marketConfig, usd, px, EVT } = require("./helpers");

const DAY = 86_400;
const DEPTH = usd(2_000_000);

// A far-dated market with no time-based leverage limit, unless a test turns one on. Lines sit
// two ticks from entry at the least here; production markets use five (dated) or ten (sports).
async function setup(overrides = {}, daysOut = 300) {
  const ctx = await deploy();
  const expiry = (await time.latest()) + daysOut * DAY;
  ctx.expiry = expiry;
  ctx.eventConfig = marketConfig({
    isEvent: true,
    maxLeverage: 50,
    profitFeeBps: 1000,
    maxGapBps: 500, // five points of probability
    expiry,
    maxPositionNotional: usd(1_000_000),
    ...overrides,
  });
  await ctx.engine.setMarket(EVT, ctx.eventConfig);
  await ctx.vault.connect(ctx.lp).deposit(usd(1_000_000), ctx.lp.address);
  await ctx.push(EVT, px(0.5), DEPTH);
  return ctx;
}
// See engine.test.js: start every test from a fresh price, whatever the wall clock did.
async function load(f) {
  const ctx = await loadFixture(f);
  await ctx.push(EVT, px(0.5), DEPTH);
  return ctx;
}
const fixture = () => setup();
const feeFixture = () => setup({ crowdingScale: px(1), boostScale: px(1) });
const timedFixture = () => setup({ reactionSeconds: 120 }, 3);
const productionFixture = () => setup({ minDistance: px(0.05), maxLeverage: 10 });

describe("PerpEngine: event (prediction) markets", () => {
  it("keeps both lines at least the market's minimum distance from entry", async () => {
    const { engine, alice, push } = await load(fixture);
    let v = await engine.marketView(EVT);
    expect(v.maxLeverageLong).to.equal(25n); // 0.50 / 0.02
    expect(v.maxLeverageShort).to.equal(25n);
    await expect(engine.connect(alice).open(EVT, true, usd(10), 26, false, "0x")).to.be.revertedWithCustomError(
      engine,
      "BadLeverage"
    );
    await engine.connect(alice).open(EVT, true, usd(10), 25, false, "0x");

    await push(EVT, px(0.48), DEPTH);
    await push(EVT, px(0.1), DEPTH); // a real repricing, held below
    await time.increase(3000);
    await push(EVT, px(0.1), DEPTH);
    v = await engine.marketView(EVT);
    // At 10c a YES stops out 10c below and a NO wins 10c below: both are bound by the near edge.
    expect(v.maxLeverageLong).to.equal(5n);
    expect(v.maxLeverageShort).to.equal(5n);
  });

  it("at five ticks, the production setting, allows 10x at 50c and 4x at 20c", async () => {
    const { engine, alice, hold } = await load(productionFixture);
    expect((await engine.marketView(EVT)).maxLeverageLong).to.equal(10n);
    await expect(engine.connect(alice).open(EVT, true, usd(10), 11, false, "0x")).to.be.revertedWithCustomError(
      engine,
      "BadLeverage"
    );
    await hold(EVT, px(0.2), 3000, DEPTH, 60);
    expect((await engine.marketView(EVT)).maxLeverageLong).to.equal(4n);
  });

  it("treats a short as a long on NO, so 1x is fully collateralised on both sides", async () => {
    const { engine, usdc, alice, bob, push, hold } = await load(fixture);
    await hold(EVT, px(0.25), 3000, DEPTH, 60);
    // NO costs 0.75. 300 of notional buys 400 NO contracts.
    await engine.connect(alice).open(EVT, false, usd(300), 1, false, "0x");
    await engine.connect(bob).open(EVT, true, usd(300), 1, false, "0x");
    const a0 = await usdc.balanceOf(alice.address);
    const b0 = await usdc.balanceOf(bob.address);

    await push(EVT, px(1), DEPTH, true); // resolves YES
    const [pa] = await engine.positionsOf(alice.address);
    const [pb] = await engine.positionsOf(bob.address);
    await engine.close(pa.id, "0x"); // anyone may settle after resolution
    await engine.close(pb.id, "0x");

    expect((await usdc.balanceOf(alice.address)) - a0).to.equal(0n); // NO expired worthless: margin gone, no more
    // YES bought at 0.25: 300 * 0.75/0.25 = 900 profit, less the 10% share.
    expect((await usdc.balanceOf(bob.address)) - b0).to.be.closeTo(usd(300 + 900 - 90), usd(0.5));
  });

  it("caps a leveraged win at what the stake would win outright, and reserves exactly that", async () => {
    const { engine, vault, alice, bob } = await load(fixture);
    await engine.connect(alice).open(EVT, true, usd(100), 10, false, "0x"); // 1,000 of YES at 0.50
    expect(await vault.reserved()).to.equal(usd(100)); // 100 * 0.50 / 0.50, not 1,000
    const [yes] = await engine.positionsOf(alice.address);
    expect(yes.winPrice).to.equal(px(0.55)); // 0.50 + 0.50 / 10
    expect(yes.liquidationPrice).to.equal(px(0.46)); // 80% of the way to 0.45

    await engine.connect(bob).open(EVT, false, usd(100), 10, false, "0x"); // 1,000 of NO at 0.50
    const [no] = await engine.positionsOf(bob.address);
    expect(no.winPrice).to.equal(px(0.45));
    expect(no.liquidationPrice).to.equal(px(0.54));
    expect(await vault.reserved()).to.equal(usd(200));
  });

  it("caps an underdog's leveraged win at the stake, so its two lines are equally far away", async () => {
    const { engine, vault, alice, bob, hold } = await load(productionFixture);
    await hold(EVT, px(0.2), 3000, DEPTH, 60);
    // Outright, 100 of YES at 20c would win 400. Leveraged, it wins 100 at the most.
    await engine.connect(alice).open(EVT, true, usd(100), 4, false, "0x");
    expect(await vault.reserved()).to.equal(usd(100));
    const [lev] = await engine.positionsOf(alice.address);
    expect(lev.winPrice).to.be.closeTo(px(0.25), px(0.0001)); // +5c
    expect(lev.liquidationPrice).to.be.closeTo(px(0.16), px(0.0001)); // 80% of the way to the stop at 15c: -5c

    // At 1x it is a plain purchase of shares and keeps the whole outright win.
    await engine.connect(bob).open(EVT, true, usd(100), 1, false, "0x");
    expect(await vault.reserved()).to.be.closeTo(usd(100 + 400), usd(0.1));
    const [plain] = await engine.positionsOf(bob.address);
    expect(plain.winPrice).to.be.closeTo(px(1), px(0.0001));
  });

  it("a jump across both lines pays the underdog no more than it costs it the other way", async () => {
    // The same 4x YES at 20c, through a ten-point jump either way.
    for (const up of [true, false]) {
      const { engine, usdc, alice, liquidator, push, hold } = await load(productionFixture);
      await hold(EVT, px(0.2), 3000, DEPTH, 60);
      const before = await usdc.balanceOf(alice.address);
      await engine.connect(alice).open(EVT, true, usd(100), 4, false, "0x");
      const [pos] = await engine.positionsOf(alice.address);
      if (up) {
        await hold(EVT, px(0.3), 3000, DEPTH, 60);
        await engine.connect(liquidator).collect(pos.id, "0x");
        expect((await usdc.balanceOf(alice.address)) - before).to.equal(usd(90)); // +100 less the 10% share
      } else {
        await push(EVT, px(0.1), DEPTH);
        await engine.connect(liquidator).liquidate(pos.id, "0x");
        expect(before - (await usdc.balanceOf(alice.address))).to.equal(usd(100));
      }
    }
  });

  it("pays the capped win as soon as the odds reach the win line, and anyone can collect it", async () => {
    const { engine, usdc, alice, bob, hold } = await load(fixture);
    await engine.connect(alice).open(EVT, true, usd(100), 10, false, "0x");
    const [pos] = await engine.positionsOf(alice.address);
    await expect(engine.connect(bob).collect(pos.id, "0x")).to.be.revertedWithCustomError(engine, "NotCollectable");

    await hold(EVT, px(0.56), 3000, DEPTH, 60); // through the win line at 0.55, and held
    expect((await engine.positionView(pos.id)).collectable).to.equal(true);
    const before = await usdc.balanceOf(alice.address);
    await engine.connect(bob).collect(pos.id, "0x"); // bob collects for alice
    // Uncapped this would be 1,000 * 0.06/0.50 = 120. The cap is 100, less the 10% share.
    expect((await usdc.balanceOf(alice.address)) - before).to.equal(usd(100 + 100 - 10));
  });

  it("through a jump to the result, a leveraged favourite is paid exactly what an outright one would be", async () => {
    const { engine, vault, usdc, alice, bob, push } = await load(fixture);
    await engine.connect(alice).open(EVT, true, usd(100), 25, false, "0x"); // 2,500 of YES
    await engine.connect(bob).open(EVT, true, usd(100), 1, false, "0x"); // 100 of YES
    const a0 = await usdc.balanceOf(alice.address);
    const b0 = await usdc.balanceOf(bob.address);

    await push(EVT, px(1), DEPTH, true); // resolves YES with no warning
    for (const who of [alice, bob]) {
      const [p] = await engine.positionsOf(who.address);
      await engine.close(p.id, "0x");
    }
    const leveraged = (await usdc.balanceOf(alice.address)) - a0;
    const outright = (await usdc.balanceOf(bob.address)) - b0;
    expect(leveraged).to.equal(outright);
    expect(outright).to.equal(usd(100 + 100 - 10));
    expect(await vault.reserved()).to.equal(0n);
  });

  it("a leveraged YES plus a leveraged NO held through a jump loses the fee, like the 1x pair", async () => {
    const { engine, usdc, alice, push } = await load(fixture);
    const before = await usdc.balanceOf(alice.address);
    await engine.connect(alice).open(EVT, true, usd(100), 25, false, "0x");
    await engine.connect(alice).open(EVT, false, usd(100), 25, false, "0x");
    await push(EVT, px(1), DEPTH, true);
    for (const p of await engine.positionsOf(alice.address)) await engine.close(p.id, "0x");
    // +100 on YES less the 10% share, -100 on NO. The vault is not out of pocket.
    expect((await usdc.balanceOf(alice.address)) - before).to.equal(-usd(10));
  });

  it("a crash through the stop line costs the stake and nothing more", async () => {
    const { engine, usdc, alice, liquidator, push } = await load(fixture);
    const before = await usdc.balanceOf(alice.address);
    await engine.connect(alice).open(EVT, true, usd(100), 10, false, "0x"); // stop near 0.46
    await push(EVT, px(0.2), DEPTH); // far through it in one update
    const [pos] = await engine.positionsOf(alice.address);
    await engine.connect(liquidator).liquidate(pos.id, "0x");
    expect(before - (await usdc.balanceOf(alice.address))).to.equal(usd(100));
    expect(await usdc.balanceOf(liquidator.address)).to.equal(usd(5)); // paid although no equity was left
  });

  it("never liquidates a 1x position: it is a purchase of shares and rides to the result", async () => {
    const { engine, usdc, alice, liquidator, push } = await load(fixture);
    await engine.connect(alice).open(EVT, true, usd(100), 1, false, "0x");
    const before = await usdc.balanceOf(alice.address);
    await push(EVT, px(0.3), DEPTH);
    await push(EVT, px(0.05), DEPTH); // 90% down
    const [pos] = await engine.positionsOf(alice.address);
    expect(pos.liquidatable).to.equal(false);
    expect(pos.liquidationPrice).to.equal(0n);
    await expect(engine.connect(liquidator).liquidate(pos.id, "0x")).to.be.revertedWithCustomError(
      engine,
      "NotLiquidatable"
    );
    await push(EVT, px(1), DEPTH, true); // and YES wins after all
    await engine.close(pos.id, "0x");
    expect((await usdc.balanceOf(alice.address)) - before).to.equal(usd(100 + 100 - 10));
  });

  it("settles at the final price, pays at once, and stops trading after resolution", async () => {
    const { engine, vault, usdc, alice, push } = await load(fixture);
    await engine.connect(alice).open(EVT, false, usd(100), 10, false, "0x"); // NO at 0.50
    const before = await usdc.balanceOf(alice.address);

    await push(EVT, 0n, DEPTH, true); // resolves NO
    await expect(engine.connect(alice).open(EVT, true, usd(10), 1, false, "0x")).to.be.revertedWithCustomError(
      engine,
      "MarketResolved"
    );
    const [pos] = await engine.positionsOf(alice.address);
    await engine.close(pos.id, "0x");
    expect((await usdc.balanceOf(alice.address)) - before).to.equal(usd(100 + 100 - 10));
    expect(await vault.reserved()).to.equal(0n);
  });

  it("lowers leverage with the square root of the time left, and lets anyone close what is above it", async () => {
    const { engine, usdc, alice, bob, push, expiry } = await load(timedFixture);
    // Three days out at 50c: 0.5 * sqrt(259,200 / (120 * 0.25)) / 3 = 15.5
    expect((await engine.marketView(EVT)).maxLeverageLong).to.equal(15n);
    await expect(engine.connect(alice).open(EVT, true, usd(100), 16, false, "0x")).to.be.revertedWithCustomError(
      engine,
      "BadLeverage"
    );
    await engine.connect(alice).open(EVT, true, usd(100), 15, false, "0x");
    const [pos] = await engine.positionsOf(alice.address);
    await expect(engine.connect(bob).forceClose(pos.id, "0x")).to.be.revertedWithCustomError(
      engine,
      "NotForceClosable"
    );

    // Six hours out: 0.5 * sqrt(21,600 / 30) / 3 = 4.5
    await time.increaseTo(expiry - DAY / 4);
    await push(EVT, px(0.5), DEPTH);
    expect((await engine.marketView(EVT)).maxLeverageLong).to.equal(4n);
    expect((await engine.positionView(pos.id)).forceClosable).to.equal(true);
    const before = await usdc.balanceOf(alice.address);
    await engine.connect(bob).forceClose(pos.id, "0x");
    expect((await usdc.balanceOf(alice.address)) - before).to.equal(usd(100)); // flat price: margin back, no penalty

    // Ten minutes out only 1x is left; at expiry no new positions open at all.
    await time.increaseTo(expiry - 600);
    await push(EVT, px(0.5), DEPTH);
    expect((await engine.marketView(EVT)).maxLeverageLong).to.equal(1n);
    await engine.connect(bob).open(EVT, true, usd(10), 1, false, "0x");
    await time.increaseTo(expiry + 1);
    await push(EVT, px(0.5), DEPTH);
    await expect(engine.connect(bob).open(EVT, true, usd(10), 1, false, "0x")).to.be.revertedWithCustomError(
      engine,
      "BadLeverage"
    );
  });

  it("a move in a position's favour never makes it force-closable, and a forced close needs a calm price", async () => {
    const { engine, alice, bob, push, hold, expiry } = await load(timedFixture);
    await engine.connect(alice).open(EVT, true, usd(100), 15, false, "0x");
    const [pos] = await engine.positionsOf(alice.address);
    // One update to 0.60. The limit at the new price is lower, but the limit that counts is the
    // one at the position's own entry price.
    await push(EVT, px(0.6), DEPTH);
    expect((await engine.positionView(pos.id)).forceClosable).to.equal(false);
    await expect(engine.connect(bob).forceClose(pos.id, "0x")).to.be.revertedWithCustomError(
      engine,
      "NotForceClosable"
    );

    // Time does make it closable, but not while the mid and the slow price are apart.
    await hold(EVT, px(0.5), 3000, DEPTH, 60);
    await time.increaseTo(expiry - DAY / 4);
    await push(EVT, px(0.5), DEPTH);
    await push(EVT, px(0.45), DEPTH); // a print five points lower
    expect((await engine.positionView(pos.id)).forceClosable).to.equal(false);
    await expect(engine.connect(bob).forceClose(pos.id, "0x")).to.be.revertedWithCustomError(
      engine,
      "PriceDislocated"
    );
  });

  it("lowers leverage into a scheduled event and restores it when the next one is set", async () => {
    const ctx = await setup({ reactionSeconds: 120 }, 300);
    const { engine, alice, push, eventConfig } = ctx;
    expect((await engine.marketView(EVT)).maxLeverageLong).to.equal(25n);
    // A debate, a release or a ruling in six hours: the clock runs to it, not to the result.
    const soon = (await time.latest()) + DAY / 4;
    await engine.setMarket(EVT, { ...eventConfig, reactionSeconds: 120, nextEvent: soon });
    await push(EVT, px(0.5), DEPTH);
    expect((await engine.marketView(EVT)).maxLeverageLong).to.equal(4n);
    await time.increaseTo(soon + 1);
    await push(EVT, px(0.5), DEPTH);
    expect((await engine.marketView(EVT)).maxLeverageLong).to.equal(1n); // until the lister sets the next one
    await engine.connect(alice).open(EVT, true, usd(10), 1, false, "0x");
    await engine.setMarket(EVT, { ...eventConfig, reactionSeconds: 120, nextEvent: 0 });
    await push(EVT, px(0.5), DEPTH);
    expect((await engine.marketView(EVT)).maxLeverageLong).to.equal(25n);
  });

  it("stops trading at expiry: nothing closes at a price, and a 1x position waits for the result", async () => {
    const { engine, usdc, alice, bob, push, expiry } = await load(timedFixture);
    await time.increaseTo(expiry - 600);
    await push(EVT, px(0.5), DEPTH);
    await engine.connect(alice).open(EVT, true, usd(100), 1, false, "0x");
    const [pos] = await engine.positionsOf(alice.address);
    const before = await usdc.balanceOf(alice.address);

    await time.increaseTo(expiry + 60);
    await push(EVT, px(0.9), DEPTH); // in play: the price is whatever the last print was
    expect((await engine.marketView(EVT)).closed).to.equal(true);
    await expect(engine.connect(alice).close(pos.id, "0x")).to.be.revertedWithCustomError(engine, "MarketClosed");
    await expect(engine.connect(bob).collect(pos.id, "0x")).to.be.revertedWithCustomError(engine, "MarketClosed");

    await push(EVT, px(1), DEPTH, true);
    await engine.connect(bob).close(pos.id, "0x");
    expect((await usdc.balanceOf(alice.address)) - before).to.equal(usd(100 + 100 - 10));
  });

  it("a position still leveraged at expiry can lose but cannot win", async () => {
    for (const yesWins of [true, false]) {
      const { engine, usdc, alice, bob, push, expiry } = await load(timedFixture);
      await engine.connect(alice).open(EVT, true, usd(100), 10, false, "0x");
      const [pos] = await engine.positionsOf(alice.address);
      const before = await usdc.balanceOf(alice.address);
      // Nobody force-closes it, and the match starts.
      await time.increaseTo(expiry + 60);
      if (yesWins) {
        await push(EVT, px(1), DEPTH, true);
        await engine.connect(bob).close(pos.id, "0x");
        expect((await usdc.balanceOf(alice.address)) - before).to.equal(usd(100)); // the stake back, no win
      } else {
        await push(EVT, px(0.48), DEPTH);
        expect((await engine.positionView(pos.id)).forceClosable).to.equal(true);
        await engine.connect(bob).forceClose(pos.id, "0x"); // 2c down on 2,000 shares
        expect((await usdc.balanceOf(alice.address)) - before).to.be.closeTo(usd(60), usd(1));
      }
    }
  });

  it("charges the crowding fee on a one-sided leveraged book out of the stake, so closing does not shed it", async () => {
    const { engine, usdc, alice, bob, hold, push } = await load(feeFixture);
    await engine.connect(alice).open(EVT, true, usd(100), 10, false, "0x"); // borrows 1,800 of 2,000 shares
    await engine.connect(bob).open(EVT, true, usd(100), 10, false, "0x");
    await time.increase(DAY);
    await push(EVT, px(0.5), DEPTH);

    // Fully one-sided: 1,800 borrowed shares * 0.50 * 0.50 / 300 days = 1.50 a day.
    const [pa] = await engine.positionsOf(alice.address);
    expect(pa.crowdingFee).to.be.closeTo(usd(1.5), usd(0.03));
    expect(pa.equityAtMid).to.equal(usd(100) - pa.crowdingFee);

    // Alice closes flat and still pays for the day she held.
    const a0 = await usdc.balanceOf(alice.address);
    await engine.connect(alice).close(pa.id, "0x");
    expect((await usdc.balanceOf(alice.address)) - a0).to.be.closeTo(usd(98.5), usd(0.03));

    // Bob wins 40 (0.50 -> 0.52 on 1,000): less the fee, then the 10% share of what is left.
    await hold(EVT, px(0.52), 3000, DEPTH, 60);
    const [pb] = await engine.positionsOf(bob.address);
    const accrued = pb.crowdingFee;
    const b0 = await usdc.balanceOf(bob.address);
    await engine.connect(bob).close(pb.id, "0x");
    const net = (await usdc.balanceOf(bob.address)) - b0 - usd(100);
    expect(net).to.be.closeTo(((usd(40) - accrued) * 90n) / 100n, usd(0.05));
    expect(accrued).to.be.closeTo(usd(1.5), usd(0.1));
  });

  it("charges no crowding fee when borrowed shares balance, and outright bets do not count", async () => {
    const { engine, alice, bob, carol, push } = await load(feeFixture);
    await engine.connect(alice).open(EVT, true, usd(100), 10, false, "0x"); // 1,800 borrowed YES shares
    await engine.connect(bob).open(EVT, false, usd(100), 10, false, "0x"); // 1,800 borrowed NO shares
    await time.increase(DAY);
    await push(EVT, px(0.5), DEPTH);
    let [pa] = await engine.positionsOf(alice.address);
    expect(pa.crowdingFee).to.be.lessThan(usd(0.001)); // only the second before Bob arrived

    // Bob leaves. A large outright NO bet does not offset Alice's borrowed shares.
    const [pb] = await engine.positionsOf(bob.address);
    await engine.connect(bob).close(pb.id, "0x");
    await engine.connect(carol).open(EVT, false, usd(5_000), 1, false, "0x");
    await time.increase(DAY);
    await push(EVT, px(0.5), DEPTH);
    [pa] = await engine.positionsOf(alice.address);
    expect(pa.crowdingFee).to.be.closeTo(usd(1.5), usd(0.03));
  });

  it("prices each stretch at the odds that held during it, and charges the stretch that ends in a result", async () => {
    const { engine, usdc, alice, oracle, sign, push } = await load(feeFixture);
    await engine.connect(alice).open(EVT, true, usd(100), 10, true, "0x"); // boosted: 1,800 borrowed shares
    const [pos] = await engine.positionsOf(alice.address);
    const before = await usdc.balanceOf(alice.address);
    // Ten quiet days at 50c. Nobody touches the engine; the result goes straight to the oracle.
    await time.increase(10 * DAY);
    const ts = (await time.latest()) + 1;
    await time.setNextBlockTimestamp(ts);
    const { update, sig } = await sign(EVT, px(1), DEPTH, ts, true);
    await oracle.push([update], [sig]);
    // 1,800 * 0.25 / (about 295 days at the midpoint) * 10 days = about 15.25, not zero.
    expect((await engine.positionView(pos.id)).boostPremium).to.be.closeTo(usd(15.25), usd(0.2));
    await engine.close(pos.id, "0x");
    const net = (await usdc.balanceOf(alice.address)) - before - usd(100);
    expect(net).to.be.closeTo(((usd(1_000) - usd(15.25)) * 90n) / 100n, usd(0.3));
    void push;
  });

  it("Boost keeps the leveraged win and charges the jump premium out of the stake", async () => {
    const { engine, vault, usdc, alice, hold, push } = await load(feeFixture);
    await engine.connect(alice).open(EVT, true, usd(100), 10, true, "0x");
    expect(await vault.reserved()).to.equal(usd(1_000)); // 1,000 * 0.50/0.50, and the 10x-margin ceiling
    let [pos] = await engine.positionsOf(alice.address);
    expect(pos.winPrice).to.equal(px(1));

    await time.increase(DAY);
    await push(EVT, px(0.5), DEPTH);
    [pos] = await engine.positionsOf(alice.address);
    expect(pos.boostPremium).to.be.closeTo(usd(1.5), usd(0.03)); // 1,800 * 0.50 * 0.50 / 300 a day
    expect(pos.crowdingFee).to.equal(0n);
    expect(pos.equityAtMid).to.be.closeTo(usd(98.5), usd(0.03)); // it does come out of the stake

    // The odds jump to 0.70: 1,000 * 0.20/0.50 = 400, where free mode would stop at 100.
    await hold(EVT, px(0.7), 3000, DEPTH, 60);
    [pos] = await engine.positionsOf(alice.address);
    const premium = pos.boostPremium;
    const before = await usdc.balanceOf(alice.address);
    await engine.connect(alice).close(pos.id, "0x");
    const net = (await usdc.balanceOf(alice.address)) - before - usd(100);
    expect(net).to.be.closeTo(((usd(400) - premium) * 90n) / 100n, usd(0.05));
    expect(await vault.reserved()).to.equal(0n);
  });

  it("refuses Boost where the market does not offer it, and at 1x where there is nothing to boost", async () => {
    const plain = await load(fixture);
    await expect(
      plain.engine.connect(plain.alice).open(EVT, true, usd(100), 10, true, "0x")
    ).to.be.revertedWithCustomError(plain.engine, "BoostUnavailable");
    const priced = await load(feeFixture);
    await expect(
      priced.engine.connect(priced.alice).open(EVT, true, usd(100), 1, true, "0x")
    ).to.be.revertedWithCustomError(priced.engine, "BoostUnavailable");
  });

  it("does not open within three cents of certainty, where a market may already be decided", async () => {
    const { engine, alice, hold } = await load(fixture);
    await hold(EVT, px(0.98), 3000, DEPTH, 60);
    await expect(engine.connect(alice).open(EVT, true, usd(10), 1, false, "0x")).to.be.revertedWithCustomError(
      engine,
      "EventPriceOutOfRange"
    );
  });

  it("does not let a market change kind once it is listed", async () => {
    const { engine, eventConfig } = await load(fixture);
    await expect(engine.setMarket(EVT, { ...eventConfig, isEvent: false, minDistance: 0n })).to.be.revertedWithCustomError(
      engine,
      "BadParams"
    );
  });
});

describe("PerpEngine: event-market capacity", () => {
  it("sizes capacity in shares and never above the ceiling, whatever the book shows", async () => {
    const ctx = await deploy();
    const expiry = (await time.latest()) + 300 * DAY;
    const config = marketConfig({
      isEvent: true,
      maxLeverage: 10,
      maxGapBps: 500,
      kappaBps: 2500,
      minDistance: px(0.05),
      expiry,
      maxPositionNotional: usd(1_000_000),
      maxSideNotional: usd(1_000),
    });
    await ctx.engine.setMarket(EVT, config);
    await ctx.vault.connect(ctx.lp).deposit(usd(1_000_000), ctx.lp.address);

    // $2,000 resting near a 50c mid: 0.25 x 2,000 x (2 x 0.5) = 500 a side.
    await ctx.push(EVT, px(0.5), usd(2_000));
    expect((await ctx.engine.marketView(EVT)).sideCap).to.equal(usd(500));
    await expect(ctx.engine.connect(ctx.alice).open(EVT, true, usd(60), 10, false, "0x")).to.be.revertedWithCustomError(
      ctx.engine,
      "SideCapExceeded"
    );
    await ctx.engine.connect(ctx.alice).open(EVT, true, usd(50), 10, false, "0x");

    // The same book around a 90c mid: 0.25 x 2,000 x (2 x 0.1) = 100 a side.
    await ctx.hold(EVT, px(0.9), 3000, usd(2_000), 60);
    expect((await ctx.engine.marketView(EVT)).sideCap).to.be.closeTo(usd(100), usd(0.5));

    // A hundred times the quotes, resting for an hour, unlock the ceiling and no more.
    await ctx.hold(EVT, px(0.5), 3600, usd(200_000), 60);
    expect((await ctx.engine.marketView(EVT)).sideCap).to.equal(usd(1_000));
  });
});
