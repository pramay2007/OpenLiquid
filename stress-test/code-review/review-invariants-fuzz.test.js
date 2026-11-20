// Reproductions of what the seeded simulation (review-invariants.test.js) and the rule-by-rule
// comparison behind it turned up. Each test states the intended behaviour, so each one FAILS
// against the contracts as they stand and should pass, unchanged, once the defect is fixed.
//
//   npx hardhat test test/review-invariants-fuzz.test.js

const { expect } = require("chai");
const { time, loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { deploy, marketConfig, usd, px, fmtUsd, BTC, EVT } = require("./helpers");

const DAY = 86_400;
const DEPTH = usd(2_000_000);

/** A far-dated event market next to a crypto market, and 1,000,000 of LP money. */
async function setup(overrides = {}, daysOut = 300) {
  const ctx = await deploy();
  const expiry = (await time.latest()) + daysOut * DAY;
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
  await ctx.engine.setMarket(BTC, marketConfig());
  await ctx.vault.connect(ctx.lp).deposit(usd(1_000_000), ctx.lp.address);
  await ctx.push(EVT, px(0.5), DEPTH);
  await ctx.push(BTC, px(60_000));
  return { ...ctx, expiry };
}
const plainFixture = () => setup();
const boostFixture = () => setup({ hazardScale: px(1), boostEnabled: true }, 10);
const timedFixture = () => setup({ reactionSeconds: 120 }, 2);

/** Send a closing call and return its PositionClosed event. */
async function closed(engine, sending) {
  const rc = await (await sending).wait();
  for (const log of rc.logs) {
    try {
      const parsed = engine.interface.parseLog(log);
      if (parsed?.name === "PositionClosed") return parsed.args;
    } catch {
      /* another contract's log */
    }
  }
  throw new Error("no PositionClosed event");
}
const redeemAll = async (vault, usdc, who) => {
  const before = await usdc.balanceOf(who.address);
  await vault.connect(who).redeem(await vault.maxRedeem(who.address), who.address, who.address);
  return (await usdc.balanceOf(who.address)) - before;
};

describe("Review finding: poke() on a market that is not listed yet", () => {
  // poke() is open to anyone and stamps states[id].lastAccrual. setMarket() takes a zero
  // lastAccrual to mean "new market", so a market poked first is never added to marketIds.
  async function pokedThenListed() {
    const ctx = await deploy();
    await ctx.vault.connect(ctx.lp).deposit(usd(1_000_000), ctx.lp.address);
    const NEW = 7;
    await ctx.engine.connect(ctx.bob).poke(NEW).catch(() => {}); // a stranger; a fix may make this revert
    await ctx.oracle.setTau(NEW, 60);
    await ctx.engine.setMarket(NEW, marketConfig());
    await ctx.push(NEW, px(100));
    return { ...ctx, NEW };
  }

  it("the market is still listed: marketCount() and allMarkets() include it", async () => {
    const { engine, NEW } = await loadFixture(pokedThenListed);
    const listed = (await engine.allMarkets()).map((v) => Number(v.marketId));
    expect({ count: Number(await engine.marketCount()), listed }).to.deep.equal({ count: 1, listed: [NEW] });
  });

  it("the market's open positions are still marked in the LP share price", async () => {
    const { engine, vault, alice, hold, NEW } = await loadFixture(pokedThenListed);
    await engine.connect(alice).open(NEW, true, usd(1_000), 10, false, "0x"); // 10,000 long
    await hold(NEW, px(110), 600, usd(20_000_000), 20); // +10%: the trader is owed 1,000
    const [pos] = await engine.positionsOf(alice.address);
    expect(fmtUsd(pos.pnl)).to.be.closeTo(1_000, 5);
    expect({
      unrealizedPnl: Math.round(fmtUsd(await engine.unrealizedPnl())),
      totalAssets: Math.round(fmtUsd(await vault.totalAssets())),
    }).to.deep.equal({ unrealizedPnl: 1_000, totalAssets: 999_000 });
  });
});

describe("Review finding: fees and the Boost premium accrue only when someone touches the market", () => {
  // _accrue() runs on trades and on poke(), and prices the whole interval since the last one at
  // the mid of the moment it runs. The keeper relays prices to the oracle, not to the engine.
  // So in a quiet market the premium for the time before a jump is charged at the rate after it,
  // and the interval that ends in the resolution is not charged at all.

  /** Boosted 10x YES at 50c, a quiet day, a jump to 90c, close once the new price has been held. */
  async function boostedDay(ctx, strangerPokes) {
    const { engine, alice, bob, push, hold } = ctx;
    await engine.connect(alice).open(EVT, true, usd(100), 10, true, "0x"); // 2,000 shares, 1,800 borrowed
    const [pos] = await engine.positionsOf(alice.address);
    for (let hour = 0; hour < 24; hour++) {
      await time.increase(3_599);
      await push(EVT, px(0.5), DEPTH); // the keeper's relay goes to the oracle only
    }
    if (strangerPokes) await engine.connect(bob).poke(EVT);
    await push(EVT, px(0.9), DEPTH);
    await hold(EVT, px(0.9), 1_800, DEPTH, 60);
    return closed(engine, engine.connect(alice).close(pos.id, "0x"));
  }

  it("the premium for a day at 50c is the same whether or not a stranger poked the market", async () => {
    const quiet = await boostedDay(await loadFixture(boostFixture), false);
    const poked = await boostedDay(await loadFixture(boostFixture), true);
    console.log(
      `      premium for the same day: $${fmtUsd(poked.boostPremium).toFixed(2)} if someone poked before the jump, ` +
        `$${fmtUsd(quiet.boostPremium).toFixed(2)} if nobody did`
    );
    // 1,800 borrowed shares x 0.5 x 0.5 x 1 day / 9.5 days left = 47.4, plus the half hour after the jump.
    expect(fmtUsd(poked.boostPremium)).to.be.closeTo(47.7, 1.5);
    expect(fmtUsd(quiet.boostPremium)).to.be.closeTo(fmtUsd(poked.boostPremium), 1);
  });

  it("a boosted position held into the result pays for the time it was held", async () => {
    const { engine, alice, bob, push } = await loadFixture(boostFixture);
    await engine.connect(alice).open(EVT, true, usd(100), 10, true, "0x");
    const [pos] = await engine.positionsOf(alice.address);
    for (let hour = 0; hour < 24; hour++) {
      await time.increase(3_599);
      await push(EVT, px(0.5), DEPTH);
    }
    expect(fmtUsd((await engine.positionView(pos.id)).boostPremium)).to.be.closeTo(47.4, 0.5); // what the view shows
    await push(EVT, px(1), 0n, true); // resolves YES
    const settled = await closed(engine, engine.connect(bob).close(pos.id, "0x"));
    console.log(`      premium charged at settlement after a day of Boost: $${fmtUsd(settled.boostPremium).toFixed(2)}`);
    expect(fmtUsd(settled.boostPremium)).to.be.closeTo(47.4, 0.5);
  });
});

describe("Review finding: a forced close at the slow price takes a winner's win", () => {
  // forceClose() fills at min(mid, slow) with no check that the two agree. A jump in a position's
  // favour moves the mid at once and the slow price over minutes, and the same jump lowers the
  // time-based leverage limit, so the position becomes force-closable exactly then.
  it("a position past its win line is paid its win, forced close or not", async () => {
    const { engine, usdc, alice, bob, push, hold } = await loadFixture(timedFixture);
    await engine.connect(alice).open(EVT, true, usd(100), 10, false, "0x"); // win line 55c: +100 there
    const [pos] = await engine.positionsOf(alice.address);
    expect(pos.forceClosable).to.equal(false); // the limit two days out at 50c is 12x
    const before = await usdc.balanceOf(alice.address);

    await push(EVT, px(0.8), DEPTH); // far through the win line
    const view = await engine.positionView(pos.id);
    expect(view.equityAtMid).to.equal(usd(200)); // at the mid the position has its full win
    expect(view.collectable).to.equal(false); // but the slow price has not caught up
    expect(view.forceClosable).to.equal(true); // and at 80c the limit is 6x

    // What the keeper's sweep does next: it cannot collect, so it force-closes. A fix may refuse this
    // while the two prices disagree; then the price is held and the position is collected.
    await engine.connect(bob).forceClose(pos.id, "0x").catch(() => {});
    if ((await engine.positionsOf(alice.address)).length) {
      await hold(EVT, px(0.8), 900, DEPTH, 60);
      await engine.connect(bob).collect(pos.id, "0x");
    }
    const paid = fmtUsd((await usdc.balanceOf(alice.address)) - before);
    console.log(`      paid to the owner of a position at its cap: $${paid.toFixed(2)} (margin 100, win 100 less 10%)`);
    expect(paid).to.be.closeTo(190, 1);
  });
});

describe("Review finding: the LP share price marks positions past their own bounds", () => {
  // unrealizedPnl() is the uncapped sum, and the vault bounds only the total by `reserved` and
  // `marginHeld`. One position far past its cap (or its stop) therefore borrows headroom from
  // every other position's reserve (or margin), and the share price is wrong until it is closed.

  /** Five flat BTC longs (200,000 reserved in all) and one 25x YES with 4,000 margin, capped at 4,000 profit. */
  async function book(ctx) {
    const { engine, alice, carol } = ctx;
    for (let i = 0; i < 5; i++) await engine.connect(carol).open(BTC, true, usd(4_000), 100, false, "0x");
    await engine.connect(alice).open(EVT, true, usd(4_000), 25, false, "0x");
    return (await engine.positionsOf(alice.address))[0];
  }

  it("depositing while a position sits past its win line, and leaving once it is paid, earns nothing", async () => {
    const ctx = await loadFixture(plainFixture);
    const { engine, vault, usdc, bob, liquidator, push, hold } = ctx;
    const pos = await book(ctx);
    expect(fmtUsd(await vault.totalAssets())).to.be.closeTo(1_000_000, 1);

    await push(EVT, px(0.9), DEPTH); // the position can be paid 4,000; uncapped it would be 80,000
    const marked = fmtUsd(await vault.totalAssets());
    const spent = usd(1_000_000);
    await vault.connect(bob).deposit(spent, bob.address); // a newcomer buys shares at the marked price
    await hold(EVT, px(0.9), 1_800, DEPTH, 60);
    await engine.connect(liquidator).collect(pos.id, "0x"); // the keeper pays the position its cap
    const profit = fmtUsd((await redeemAll(vault, usdc, bob)) - spent);
    console.log(
      `      vault marked at $${marked.toFixed(0)} while worth $996,000; ` +
        `a $1,000,000 deposit made then and redeemed after the collect gains $${profit.toFixed(0)}`
    );
    expect(marked).to.be.closeTo(996_000, 500);
    expect(profit).to.be.lessThan(500); // at most its share of the 400 profit fee
  });

  it("an LP cannot leave ahead of a winning trader's close and push the loss onto the others", async () => {
    const ctx = await loadFixture(plainFixture);
    const { engine, vault, usdc, lp, bob, carol, liquidator, push, hold } = ctx;
    await vault.connect(bob).deposit(usd(1_000_000), bob.address); // two LPs, equal stakes
    const pos = await book(ctx);

    await hold(BTC, px(60_600), 600, usd(20_000_000), 20); // the BTC longs are up 1%: owed 20,000, inside their caps
    await push(EVT, px(0.1), DEPTH); // the YES is wiped: it can lose 4,000, uncapped it would be 80,000
    const marked = fmtUsd(await vault.totalAssets());
    const bobOut = fmtUsd(await redeemAll(vault, usdc, bob)); // one LP leaves before anything is closed

    await engine.connect(liquidator).liquidate(pos.id, "0x");
    await push(BTC, px(60_600));
    for (const p of await engine.positionsOf(carol.address)) await engine.connect(carol).close(p.id, "0x");
    const lpOut = fmtUsd(await redeemAll(vault, usdc, lp));
    console.log(
      `      vault marked at $${marked.toFixed(0)} while worth about $1,985,000; ` +
        `the LP who left first took $${bobOut.toFixed(0)}, the one who stayed $${lpOut.toFixed(0)}`
    );
    // Equal stakes: the two differ at most by the 1,000 profit share that arrives after the first has left.
    expect(Math.abs(bobOut - lpOut)).to.be.lessThan(2_000);
  });
});

describe("Review finding: an event price above 1.00 stops the vault", () => {
  // unrealizedPnl() computes WAD - mid for every event market with no bound on mid. The oracle
  // accepts any signed price, and a resolved feed can never be corrected.
  it("one over-scaled final price does not lock every LP in the vault", async () => {
    const { vault, lp, push } = await loadFixture(plainFixture);
    await push(EVT, px(1) + 1n, 0n, true).catch(() => {}); // "resolved YES", one wei above 1.00; a fix may reject it
    const outcome = async (call) => call.then(() => "ok").catch((e) => (e.message.match(/panic code 0x[0-9a-f]+/) ?? ["reverted"])[0]);
    expect({
      totalAssets: await outcome(vault.totalAssets()),
      withdraw: await outcome(vault.connect(lp).withdraw(usd(1), lp.address, lp.address)),
    }).to.deep.equal({ totalAssets: "ok", withdraw: "ok" });
  });
});
