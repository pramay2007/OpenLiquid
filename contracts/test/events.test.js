const { expect } = require("chai");
const { time, loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { deploy, marketConfig, usd, px, EVT } = require("./helpers");

const DAY = 86_400;
const DEPTH = usd(200_000);

async function fixture() {
  const ctx = await deploy();
  const expiry = (await time.latest()) + 3 * DAY;
  ctx.expiry = expiry;
  ctx.eventConfig = marketConfig({
    isEvent: true,
    maxLeverage: 50,
    profitFeeBps: 1000,
    maxGapBps: 500, // five points of probability
    expiry,
    compressWindow: DAY,
    maxPositionNotional: usd(1_000_000),
  });
  await ctx.engine.setMarket(EVT, ctx.eventConfig);
  await ctx.vault.connect(ctx.lp).deposit(usd(1_000_000), ctx.lp.address);
  await ctx.push(EVT, px(0.5), DEPTH);
  return ctx;
}

describe("PerpEngine: event (prediction) markets", () => {
  it("limits leverage so that liquidation is at least two ticks from entry", async () => {
    const { engine, alice, push } = await loadFixture(fixture);
    let v = await engine.marketView(EVT);
    expect(v.maxLeverageLong).to.equal(25n); // 0.50 / 0.02
    expect(v.maxLeverageShort).to.equal(25n);
    await expect(engine.connect(alice).open(EVT, true, usd(10), 26, "0x")).to.be.revertedWithCustomError(
      engine,
      "BadLeverage"
    );
    await engine.connect(alice).open(EVT, true, usd(10), 25, "0x");

    await push(EVT, px(0.48), DEPTH);
    await push(EVT, px(0.1), DEPTH); // a real repricing, held below
    await time.increase(3000);
    await push(EVT, px(0.1), DEPTH);
    v = await engine.marketView(EVT);
    expect(v.maxLeverageLong).to.equal(5n); // 0.10 / 0.02
    expect(v.maxLeverageShort).to.equal(45n); // 0.90 / 0.02
  });

  it("treats a short as a long on NO, so 1x is fully collateralised on both sides", async () => {
    const { engine, usdc, alice, bob, push, hold } = await loadFixture(fixture);
    await hold(EVT, px(0.25), 3000, DEPTH, 60);
    // NO costs 0.75. 300 of notional buys 400 NO contracts.
    await engine.connect(alice).open(EVT, false, usd(300), 1, "0x");
    await engine.connect(bob).open(EVT, true, usd(300), 1, "0x");
    const a0 = await usdc.balanceOf(alice.address);
    const b0 = await usdc.balanceOf(bob.address);

    await push(EVT, px(1), DEPTH, true); // resolves YES
    const [pa] = await engine.positionsOf(alice.address);
    const [pb] = await engine.positionsOf(bob.address);
    await engine.close(pa.id, "0x"); // anyone may settle after resolution
    await engine.close(pb.id, "0x");

    expect((await usdc.balanceOf(alice.address)) - a0).to.equal(0n); // NO expired worthless: margin gone, no more
    // YES bought at 0.25: 300 * 0.75/0.25 = 900 profit, less the 10% fee.
    // (The entry sits a hair above 0.25 because the slow price is still converging.)
    expect((await usdc.balanceOf(bob.address)) - b0).to.be.closeTo(usd(300 + 900 - 90), usd(0.5));
  });

  it("settles at the final price, pays instantly, and stops trading after resolution", async () => {
    const { engine, vault, usdc, alice, push } = await loadFixture(fixture);
    await engine.connect(alice).open(EVT, false, usd(100), 10, "0x"); // 1,000 short at 0.50
    expect(await vault.reserved()).to.equal(usd(1_000)); // the most a NO position can make
    const before = await usdc.balanceOf(alice.address);

    await push(EVT, 0n, DEPTH, true); // resolves NO
    await expect(engine.connect(alice).open(EVT, true, usd(10), 1, "0x")).to.be.revertedWithCustomError(
      engine,
      "MarketResolved"
    );
    const [pos] = await engine.positionsOf(alice.address);
    await engine.close(pos.id, "0x");
    expect((await usdc.balanceOf(alice.address)) - before).to.equal(usd(100 + 1_000 - 100));
    expect(await vault.reserved()).to.equal(0n);
  });

  it("a 1x long + 1x short held through resolution cannot profit from the jump", async () => {
    const { engine, usdc, alice, push } = await loadFixture(fixture);
    const before = await usdc.balanceOf(alice.address);
    await engine.connect(alice).open(EVT, true, usd(100), 1, "0x");
    await engine.connect(alice).open(EVT, false, usd(100), 1, "0x");
    await push(EVT, px(1), DEPTH, true);
    for (const p of await engine.positionsOf(alice.address)) await engine.close(p.id, "0x");
    // +100 on YES less the 10% fee, -100 on NO.
    expect((await usdc.balanceOf(alice.address)) - before).to.equal(-usd(10));
  });

  it("compresses leverage toward 1x into resolution and lets anyone force-close what is above the cap", async () => {
    const { engine, usdc, alice, bob, push, expiry } = await loadFixture(fixture);
    await engine.connect(alice).open(EVT, true, usd(100), 25, "0x");
    const [pos] = await engine.positionsOf(alice.address);
    await expect(engine.connect(bob).forceClose(pos.id, "0x")).to.be.revertedWithCustomError(
      engine,
      "NotForceClosable"
    );

    // Six hours out the cap is 1 + 49 * 0.25 = 13x.
    await time.increaseTo(expiry - DAY / 4);
    await push(EVT, px(0.5), DEPTH);
    expect((await engine.marketView(EVT)).maxLeverageLong).to.equal(13n);
    await expect(engine.connect(bob).open(EVT, true, usd(10), 14, "0x")).to.be.revertedWithCustomError(
      engine,
      "BadLeverage"
    );

    const before = await usdc.balanceOf(alice.address);
    expect((await engine.positionView(pos.id)).forceClosable).to.equal(true);
    await engine.connect(bob).forceClose(pos.id, "0x");
    expect((await usdc.balanceOf(alice.address)) - before).to.equal(usd(100)); // flat price: margin back, no penalty

    // At expiry only 1x is left, and no new positions open.
    await time.increaseTo(expiry + 1);
    await push(EVT, px(0.5), DEPTH);
    await expect(engine.connect(bob).open(EVT, true, usd(10), 1, "0x")).to.be.revertedWithCustomError(
      engine,
      "BadLeverage"
    );
  });

  it("charges a borrow fee on the leveraged part of a position", async () => {
    const { engine, usdc, alice, hold, eventConfig } = await loadFixture(fixture);
    await engine.setMarket(EVT, { ...eventConfig, borrowPerDay: px(0.01) }); // 1% per day on borrowed notional
    const before = await usdc.balanceOf(alice.address);
    await engine.connect(alice).open(EVT, true, usd(100), 10, "0x"); // borrows 900
    await hold(EVT, px(0.5), DAY / 2, DEPTH, 600);
    const [pos] = await engine.positionsOf(alice.address);
    await engine.connect(alice).close(pos.id, "0x");
    expect(before - (await usdc.balanceOf(alice.address))).to.be.closeTo(usd(4.5), usd(0.1));
  });

  it("does not open when the price is within a tick of 0 or 1", async () => {
    const { engine, alice, hold } = await loadFixture(fixture);
    await hold(EVT, px(0.995), 3000, DEPTH, 60);
    await expect(engine.connect(alice).open(EVT, true, usd(10), 1, "0x")).to.be.revertedWithCustomError(
      engine,
      "EventPriceOutOfRange"
    );
  });
});
