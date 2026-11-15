const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time, loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { deploy, marketConfig, usd, px, BTC } = require("./helpers");

const P0 = px(60_000);

async function fixture() {
  const ctx = await deploy();
  await ctx.engine.setMarket(BTC, marketConfig());
  await ctx.vault.connect(ctx.lp).deposit(usd(5_000_000), ctx.lp.address);
  await ctx.push(BTC, P0);
  return ctx;
}

describe("PerpEngine: crypto / equity / commodity markets", () => {
  it("fills with zero slippage in a calm market: open and close at the same mid returns margin", async () => {
    const { engine, usdc, alice } = await loadFixture(fixture);
    const before = await usdc.balanceOf(alice.address);
    await engine.connect(alice).open(BTC, true, usd(100), 1000, "0x");
    const [pos] = await engine.positionsOf(alice.address);
    expect(pos.position.entryPrice).to.equal(P0);
    expect(pos.position.notional).to.equal(usd(100_000));
    await engine.connect(alice).close(pos.id, "0x");
    expect(await usdc.balanceOf(alice.address)).to.equal(before);
  });

  it("pays a winner in full at close, charges the fee on profit only, and mints OLQ for the fee", async () => {
    const { engine, usdc, token, alice, hold } = await loadFixture(fixture);
    const before = await usdc.balanceOf(alice.address);
    await engine.connect(alice).open(BTC, true, usd(100), 1000, "0x");
    // +0.05% held long enough for the slow price to converge.
    await hold(BTC, px(60_030), 1200);
    const [pos] = await engine.positionsOf(alice.address);
    await engine.connect(alice).close(pos.id, "0x");
    const gained = (await usdc.balanceOf(alice.address)) - before;
    // 100,000 notional * 0.05% = 50 profit, less 5% fee. Slow price lags by a hair.
    expect(gained).to.be.closeTo(usd(47.5), usd(0.1));
    expect(await token.balanceOf(alice.address)).to.be.closeTo(ethers.parseEther("250"), ethers.parseEther("1"));
  });

  it("caps the loss at margin and charges a loser nothing extra", async () => {
    const { engine, usdc, token, alice, hold } = await loadFixture(fixture);
    const before = await usdc.balanceOf(alice.address);
    await engine.connect(alice).open(BTC, true, usd(100), 10, "0x");
    await hold(BTC, px(30_000), 20); // -50% on a 10x long: five times the margin
    const [pos] = await engine.positionsOf(alice.address);
    await engine.connect(alice).close(pos.id, "0x");
    expect(before - (await usdc.balanceOf(alice.address))).to.equal(usd(100));
    expect(await token.balanceOf(alice.address)).to.equal(0n);
  });

  it("liquidates at the maintenance level and returns the leftover equity to the trader", async () => {
    const { engine, usdc, alice, liquidator, push } = await loadFixture(fixture);
    await engine.connect(alice).open(BTC, true, usd(100), 1000, "0x");
    const [pos] = await engine.positionsOf(alice.address);

    await push(BTC, px(59_970)); // -0.05%: equity 50, above the 20 maintenance level
    await expect(engine.connect(liquidator).liquidate(pos.id, "0x")).to.be.revertedWithCustomError(
      engine,
      "NotLiquidatable"
    );

    await push(BTC, px(59_951.4)); // -0.081%: equity 19
    const aliceBefore = await usdc.balanceOf(alice.address);
    await engine.connect(liquidator).liquidate(pos.id, "0x");
    expect(await usdc.balanceOf(liquidator.address)).to.equal(usd(5)); // 5% of margin
    expect((await usdc.balanceOf(alice.address)) - aliceBefore).to.equal(usd(14)); // 19 - 5
  });

  it("reports the liquidation price it will act on", async () => {
    const { engine, alice } = await loadFixture(fixture);
    await engine.connect(alice).open(BTC, true, usd(100), 1000, "0x");
    await engine.connect(alice).open(BTC, false, usd(100), 1000, "0x");
    const [long, short] = await engine.positionsOf(alice.address);
    // 80% of margin is 0.08% of notional.
    expect(long.liquidationPrice).to.equal(px(59_952));
    expect(short.liquidationPrice).to.equal(px(60_048));
  });

  it("locks every position's maximum profit, so the vault can never owe more than it holds", async () => {
    const { engine, vault, usdc, lp, alice, hold } = await loadFixture(fixture);
    await engine.connect(alice).open(BTC, true, usd(10_000), 1000, "0x");
    expect(await vault.reserved()).to.equal(usd(100_000)); // 10x margin
    expect(await vault.marginHeld()).to.equal(usd(10_000));

    // LPs cannot withdraw into the reserve.
    expect(await vault.maxWithdraw(lp.address)).to.equal(usd(4_900_000));
    await expect(vault.connect(lp).withdraw(usd(4_950_000), lp.address, lp.address)).to.be.reverted;

    // A 5% rally would be 50x margin uncapped; the payout stops at the reserve and is paid at once.
    await hold(BTC, px(63_000), 1200);
    const before = await usdc.balanceOf(alice.address);
    const [pos] = await engine.positionsOf(alice.address);
    await engine.connect(alice).close(pos.id, "0x");
    expect((await usdc.balanceOf(alice.address)) - before).to.equal(usd(10_000 + 100_000 - 5_000));
    expect(await vault.reserved()).to.equal(0n);
    expect(await vault.marginHeld()).to.equal(0n);
  });

  it("refuses a position the vault cannot fully reserve", async () => {
    const { engine, alice } = await loadFixture(fixture);
    // 5M vault / 10x profit multiple = at most 500k of margin outstanding.
    await engine.setMarket(BTC, marketConfig({ kappaBps: 10_000_000, maxPositionNotional: usd(1e12) }));
    await expect(engine.connect(alice).open(BTC, true, usd(600_000), 100, "0x")).to.be.revertedWithCustomError(
      await ethers.getContractAt("Vault", await engine.vault()),
      "InsufficientLiquidity"
    );
  });

  it("caps each side's open interest at a multiple of reference depth", async () => {
    const { engine, alice, bob, push } = await loadFixture(fixture);
    // Depth 20M * kappa 0.5 = 10M per side.
    await engine.connect(alice).open(BTC, true, usd(6_000), 1000, "0x");
    await expect(engine.connect(bob).open(BTC, true, usd(5_000), 1000, "0x")).to.be.revertedWithCustomError(
      engine,
      "SideCapExceeded"
    );
    await engine.connect(bob).open(BTC, false, usd(5_000), 1000, "0x"); // the other side is open

    // The cap follows the book: if depth halves, so does the room.
    await push(BTC, P0, usd(10_000_000));
    await expect(engine.connect(bob).open(BTC, true, usd(1), 1000, "0x")).to.be.revertedWithCustomError(
      engine,
      "SideCapExceeded"
    );
  });

  it("blocks opens while the mid is dislocated from the slow price, but always allows closes", async () => {
    const { engine, alice, push } = await loadFixture(fixture);
    await engine.connect(alice).open(BTC, true, usd(100), 100, "0x");
    await push(BTC, px(60_120)); // +0.2% in one update
    await expect(engine.connect(alice).open(BTC, true, usd(100), 100, "0x")).to.be.revertedWithCustomError(
      engine,
      "PriceDislocated"
    );
    const [pos] = await engine.positionsOf(alice.address);
    await engine.connect(alice).close(pos.id, "0x");
  });

  it("lowers the usable leverage while the price is moving, instead of opening near liquidation", async () => {
    const { engine, alice, push } = await loadFixture(fixture);
    await push(BTC, px(59_952)); // -8 bps: inside the dislocation guard, slow price still near 60,000
    // A 1000x long would fill at the slow price and start about 80% of its margin under water.
    await expect(engine.connect(alice).open(BTC, true, usd(100), 1000, "0x")).to.be.revertedWithCustomError(
      engine,
      "EntryTooFarFromMid"
    );
    await engine.connect(alice).open(BTC, true, usd(100), 300, "0x"); // 24% of margin: allowed
    await engine.connect(alice).open(BTC, false, usd(100), 1000, "0x"); // the short fills at the mid: unaffected
    const [long, short] = await engine.positionsOf(alice.address);
    expect(long.liquidatable).to.equal(false);
    expect(short.position.entryPrice).to.equal(px(59_952));
  });

  it("rejects stale prices and accepts a fresh signed price bundled with the trade", async () => {
    const { engine, alice, sign } = await loadFixture(fixture);
    await time.increase(120);
    await expect(engine.connect(alice).open(BTC, true, usd(100), 100, "0x")).to.be.revertedWithCustomError(
      engine,
      "StalePrice"
    );
    const ts = await time.latest();
    const { update, sig } = await sign(BTC, P0, usd(20_000_000), ts);
    const priceData = ethers.AbiCoder.defaultAbiCoder().encode(
      ["tuple(uint32 marketId,uint256 price,uint256 depthUsd,uint64 timestamp,bool resolved)[]", "bytes[]"],
      [[update], [sig]]
    );
    await engine.connect(alice).open(BTC, true, usd(100), 100, priceData);
    expect((await engine.positionsOf(alice.address)).length).to.equal(1);
  });

  it("charges skew funding to the crowded side and pays the other side", async () => {
    const { engine, usdc, alice, bob, hold } = await loadFixture(fixture);
    await engine.setMarket(BTC, marketConfig({ fundingPerDay: px(0.001) })); // 0.1%/day at full skew
    await engine.connect(alice).open(BTC, true, usd(8_000), 1000, "0x"); // 8M long
    await engine.connect(bob).open(BTC, false, usd(2_000), 1000, "0x"); // 2M short => skew 6M of a 10M cap
    await hold(BTC, P0, 3600, usd(20_000_000), 60);

    const a0 = await usdc.balanceOf(alice.address);
    const b0 = await usdc.balanceOf(bob.address);
    const [pa] = await engine.positionsOf(alice.address);
    const [pb] = await engine.positionsOf(bob.address);
    await engine.connect(alice).close(pa.id, "0x");
    await engine.connect(bob).close(pb.id, "0x");

    // rate = 0.1%/day * 0.6 for one hour = 0.0025% of notional
    const alicePaid = usd(8_000) - ((await usdc.balanceOf(alice.address)) - a0);
    const bobNet = (await usdc.balanceOf(bob.address)) - b0 - usd(2_000);
    expect(alicePaid).to.be.closeTo(usd(200), usd(5));
    expect(bobNet).to.be.closeTo(usd(47.5), usd(2)); // 50 received, less the 5% profit fee
  });

  it("marks open positions in the LP share price", async () => {
    const { engine, vault, alice, hold } = await loadFixture(fixture);
    expect(await vault.totalAssets()).to.equal(usd(5_000_000));
    await engine.connect(alice).open(BTC, true, usd(10_000), 1000, "0x");
    expect(await vault.totalAssets()).to.be.closeTo(usd(5_000_000), 2n); // margin is not LP money

    await hold(BTC, px(60_030), 10); // traders up 5,000
    expect(await vault.totalAssets()).to.be.closeTo(usd(4_995_000), usd(1));
    await hold(BTC, px(59_990), 10); // traders down 1,667
    expect(await vault.totalAssets()).to.be.closeTo(usd(5_001_666), usd(2));
  });

  it("sends the stakers' share of the fee to staking only when someone is staked", async () => {
    const { engine, usdc, token, staking, alice, bob, hold } = await loadFixture(fixture);
    // Alice earns OLQ from a winning trade, then stakes it.
    await engine.connect(alice).open(BTC, true, usd(100), 1000, "0x");
    await hold(BTC, px(60_030), 1200);
    let [pos] = await engine.positionsOf(alice.address);
    await engine.connect(alice).close(pos.id, "0x");
    expect(await usdc.balanceOf(staking.target)).to.equal(0n);

    const olq = await token.balanceOf(alice.address);
    await token.connect(alice).approve(staking.target, olq);
    await staking.connect(alice).stake(olq);

    // Bob's winning trade now pays 30% of its fee to stakers.
    await engine.connect(bob).open(BTC, true, usd(1_000), 1000, "0x");
    await hold(BTC, px(60_060), 1200);
    [pos] = await engine.positionsOf(bob.address);
    await engine.connect(bob).close(pos.id, "0x");

    const pending = await staking.pending(alice.address);
    expect(pending).to.be.closeTo(usd(7.5), usd(0.1)); // fee ~25 * 30%
    const before = await usdc.balanceOf(alice.address);
    await staking.connect(alice).claim();
    expect((await usdc.balanceOf(alice.address)) - before).to.equal(pending);
  });
});

describe("PriceOracle", () => {
  it("rejects updates from an unknown signer and from the future", async () => {
    const { oracle, alice, sign } = await loadFixture(fixture);
    const now = await time.latest();
    const forged = await sign(BTC, px(1), usd(1), now + 1, false, alice);
    await expect(oracle.push([forged.update], [forged.sig])).to.be.revertedWithCustomError(oracle, "BadSignature");
    const early = await sign(BTC, px(1), usd(1), now + 3600);
    await expect(oracle.push([early.update], [early.sig])).to.be.revertedWithCustomError(oracle, "FutureTimestamp");
  });

  it("skips an update older than the stored one instead of reverting", async () => {
    const { oracle, sign } = await loadFixture(fixture);
    const feed = await oracle.read(BTC);
    const old = await sign(BTC, px(1), usd(1), feed.timestamp - 1n);
    await oracle.push([old.update], [old.sig]);
    expect((await oracle.read(BTC)).mid).to.equal(P0);
  });

  it("moves the slow price only as a new price is held", async () => {
    const { oracle, push } = await loadFixture(fixture);
    await push(BTC, px(60_600)); // +1% jump
    const f0 = await oracle.read(BTC);
    expect(f0.mid).to.equal(px(60_600));
    expect(f0.slow).to.be.closeTo(P0, px(10)); // one second of a 60s average

    await time.increase(60); // held for one averaging time: halfway there
    const f1 = await oracle.read(BTC);
    expect(f1.slow).to.be.closeTo(px(60_300), px(10));
  });
});
