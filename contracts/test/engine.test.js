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

// A restored snapshot keeps its block time, but the next block is stamped from the wall clock, so
// on a slow run the fixture's price can be past its validity. Each test starts from a fresh one.
async function load() {
  const ctx = await loadFixture(fixture);
  await ctx.push(BTC, P0);
  return ctx;
}

describe("PerpEngine: crypto / equity / commodity markets", () => {
  it("fills with zero slippage in a calm market: open and close at the same mid returns margin", async () => {
    const { engine, usdc, alice } = await load();
    const before = await usdc.balanceOf(alice.address);
    await engine.connect(alice).open(BTC, true, usd(100), 1000, false, "0x");
    const [pos] = await engine.positionsOf(alice.address);
    expect(pos.position.entryPrice).to.equal(P0);
    expect(pos.position.notional).to.equal(usd(100_000));
    await engine.connect(alice).close(pos.id, "0x");
    expect(await usdc.balanceOf(alice.address)).to.equal(before);
  });

  it("pays a winner in full at close, charges the fee on profit only, and mints OLQ for the fee", async () => {
    const { engine, usdc, token, alice, hold } = await load();
    const before = await usdc.balanceOf(alice.address);
    await engine.connect(alice).open(BTC, true, usd(100), 1000, false, "0x");
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
    const { engine, usdc, token, alice, hold } = await load();
    const before = await usdc.balanceOf(alice.address);
    await engine.connect(alice).open(BTC, true, usd(100), 10, false, "0x");
    await hold(BTC, px(30_000), 20); // -50% on a 10x long: five times the margin
    const [pos] = await engine.positionsOf(alice.address);
    await engine.connect(alice).close(pos.id, "0x");
    expect(before - (await usdc.balanceOf(alice.address))).to.equal(usd(100));
    expect(await token.balanceOf(alice.address)).to.equal(0n);
  });

  it("liquidates at the maintenance level and returns the leftover equity to the trader", async () => {
    const { engine, usdc, alice, liquidator, push } = await load();
    await engine.connect(alice).open(BTC, true, usd(100), 1000, false, "0x");
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
    const { engine, alice } = await load();
    await engine.connect(alice).open(BTC, true, usd(100), 1000, false, "0x");
    await engine.connect(alice).open(BTC, false, usd(100), 1000, false, "0x");
    const [long, short] = await engine.positionsOf(alice.address);
    // 80% of margin is 0.08% of notional.
    expect(long.liquidationPrice).to.equal(px(59_952));
    expect(short.liquidationPrice).to.equal(px(60_048));
  });

  it("locks every position's maximum profit, so the vault can never owe more than it holds", async () => {
    const { engine, vault, usdc, lp, alice, hold } = await load();
    await engine.connect(alice).open(BTC, true, usd(10_000), 1000, false, "0x");
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
    const { engine, alice } = await load();
    // 5M vault / 10x profit multiple = at most 500k of margin outstanding.
    await engine.setMarket(BTC, marketConfig({ kappaBps: 10_000_000, maxPositionNotional: usd(1e12) }));
    await expect(engine.connect(alice).open(BTC, true, usd(600_000), 100, false, "0x")).to.be.revertedWithCustomError(
      await ethers.getContractAt("Vault", await engine.vault()),
      "InsufficientLiquidity"
    );
  });

  it("caps each side's open interest at a multiple of reference depth", async () => {
    const { engine, alice, bob, push } = await load();
    // Depth 20M * kappa 0.5 = 10M per side.
    await engine.connect(alice).open(BTC, true, usd(6_000), 1000, false, "0x");
    await expect(engine.connect(bob).open(BTC, true, usd(5_000), 1000, false, "0x")).to.be.revertedWithCustomError(
      engine,
      "SideCapExceeded"
    );
    await engine.connect(bob).open(BTC, false, usd(5_000), 1000, false, "0x"); // the other side is open

    // The cap follows the book: if depth halves, so does the room.
    await push(BTC, P0, usd(10_000_000));
    await expect(engine.connect(bob).open(BTC, true, usd(1), 1000, false, "0x")).to.be.revertedWithCustomError(
      engine,
      "SideCapExceeded"
    );
  });

  it("blocks opens while the mid is dislocated from the slow price, but always allows closes", async () => {
    const { engine, alice, push } = await load();
    await engine.connect(alice).open(BTC, true, usd(100), 100, false, "0x");
    await push(BTC, px(60_120)); // +0.2% in one update
    await expect(engine.connect(alice).open(BTC, true, usd(100), 100, false, "0x")).to.be.revertedWithCustomError(
      engine,
      "PriceDislocated"
    );
    const [pos] = await engine.positionsOf(alice.address);
    await engine.connect(alice).close(pos.id, "0x");
  });

  it("lowers the usable leverage while the price is moving, instead of opening near liquidation", async () => {
    const { engine, alice, push } = await load();
    await push(BTC, px(59_952)); // -8 bps: inside the dislocation guard, slow price still near 60,000
    // A 1000x long would fill at the slow price and start about 80% of its margin under water.
    await expect(engine.connect(alice).open(BTC, true, usd(100), 1000, false, "0x")).to.be.revertedWithCustomError(
      engine,
      "EntryTooFarFromMid"
    );
    await engine.connect(alice).open(BTC, true, usd(100), 300, false, "0x"); // 24% of margin: allowed
    await engine.connect(alice).open(BTC, false, usd(100), 1000, false, "0x"); // the short fills at the mid: unaffected
    const [long, short] = await engine.positionsOf(alice.address);
    expect(long.liquidatable).to.equal(false);
    expect(short.position.entryPrice).to.equal(px(59_952));
  });

  it("rejects stale prices and accepts a fresh signed price bundled with the trade", async () => {
    const { engine, alice, sign } = await load();
    await time.increase(120);
    await expect(engine.connect(alice).open(BTC, true, usd(100), 100, false, "0x")).to.be.revertedWithCustomError(
      engine,
      "StalePrice"
    );
    const ts = await time.latest();
    const { update, sig } = await sign(BTC, P0, usd(20_000_000), ts);
    const priceData = ethers.AbiCoder.defaultAbiCoder().encode(
      ["tuple(uint32 marketId,uint256 price,uint256 depthUsd,uint64 timestamp,bool resolved)[]", "bytes[]"],
      [[update], [sig]]
    );
    await engine.connect(alice).open(BTC, true, usd(100), 100, false, priceData);
    expect((await engine.positionsOf(alice.address)).length).to.equal(1);
  });

  it("charges the crowding fee to the crowded side out of its stake, and nothing to the other side", async () => {
    const { engine, usdc, alice, bob, carol, hold } = await load();
    await engine.setMarket(BTC, marketConfig({ crowdingPerDay: px(0.001) })); // 0.1%/day at full skew
    await engine.connect(alice).open(BTC, true, usd(4_000), 1000, false, "0x"); // 4M long
    await engine.connect(carol).open(BTC, true, usd(4_000), 1000, false, "0x"); // 4M long
    await engine.connect(bob).open(BTC, false, usd(2_000), 1000, false, "0x"); // 2M short => skew 6M of a 10M cap
    await hold(BTC, P0, 3600, usd(20_000_000), 60);

    // rate = 0.1%/day * 0.6 for one hour = 0.0025% of notional: 100 accrued on each 4M long.
    const [pa] = await engine.positionsOf(alice.address);
    expect(pa.crowdingFee).to.be.closeTo(usd(100), usd(3));
    expect(pa.equityAtMid).to.equal(usd(4_000) - pa.crowdingFee); // it is a claim on the stake

    // Alice closes flat and pays for the time she held. Closing does not shed the fee.
    const a0 = await usdc.balanceOf(alice.address);
    await engine.connect(alice).close(pa.id, "0x");
    expect((await usdc.balanceOf(alice.address)) - a0).to.be.closeTo(usd(3_900), usd(3));

    // The uncrowded side accrues nothing and pays nothing.
    const [pb] = await engine.positionsOf(bob.address);
    expect(pb.crowdingFee).to.equal(0n);
    const b0 = await usdc.balanceOf(bob.address);
    await engine.connect(bob).close(pb.id, "0x");
    expect((await usdc.balanceOf(bob.address)) - b0).to.equal(usd(2_000));

    // Carol closes a winner: +0.05% on 4M is 2,000, less the fee, then the 5% share of what is left.
    await hold(BTC, px(60_030), 1200);
    const [pc] = await engine.positionsOf(carol.address);
    const accrued = pc.crowdingFee;
    expect(accrued).to.be.greaterThan(usd(100));
    const c0 = await usdc.balanceOf(carol.address);
    await engine.connect(carol).close(pc.id, "0x");
    const net = (await usdc.balanceOf(carol.address)) - c0 - usd(4_000);
    expect(net).to.be.closeTo(((usd(2_000) - accrued) * 95n) / 100n, usd(3));
  });

  it("lets anyone clear a position whose stake the crowding fee has used up", async () => {
    const { engine, usdc, alice, liquidator, hold } = await load();
    await engine.setMarket(BTC, marketConfig({ crowdingPerDay: px(0.05) })); // an extreme rate
    await engine.connect(alice).open(BTC, true, usd(5_000), 1000, false, "0x"); // 5M of a 10M cap
    await hold(BTC, P0, 3600, usd(20_000_000), 60); // about 5,200 accrued at a flat price
    const [pos] = await engine.positionsOf(alice.address);
    expect(pos.crowdingFee).to.be.greaterThan(usd(5_000));
    expect(pos.liquidatable).to.equal(true);
    const before = await usdc.balanceOf(alice.address);
    await engine.connect(liquidator).liquidate(pos.id, "0x");
    expect(await usdc.balanceOf(alice.address)).to.equal(before); // nothing left to return
    expect(await usdc.balanceOf(liquidator.address)).to.equal(usd(250)); // 5% of the stake
  });

  it("pays the liquidator even when the price has jumped through the stop", async () => {
    const { engine, usdc, vault, alice, liquidator, push } = await load();
    await engine.connect(alice).open(BTC, true, usd(100), 1000, false, "0x");
    await push(BTC, px(59_700)); // -0.5% in one update: five times the stake
    const [pos] = await engine.positionsOf(alice.address);
    const before = await usdc.balanceOf(alice.address);
    await engine.connect(liquidator).liquidate(pos.id, "0x");
    expect(await usdc.balanceOf(alice.address)).to.equal(before);
    expect(await usdc.balanceOf(liquidator.address)).to.equal(usd(5)); // out of the stake the vault keeps
    expect(await vault.totalAssets()).to.equal(usd(5_000_095));
  });

  it("refuses to accrue a market that was never listed, and lists it normally afterwards", async () => {
    const { engine, alice } = await load();
    await expect(engine.connect(alice).poke(7)).to.be.revertedWithCustomError(engine, "MarketDisabled");
    await engine.setMarket(7, marketConfig());
    expect(await engine.marketCount()).to.equal(2n);
    await engine.connect(alice).poke(7);
  });

  it("marks open positions in the LP share price", async () => {
    const { engine, vault, alice, hold } = await load();
    expect(await vault.totalAssets()).to.equal(usd(5_000_000));
    await engine.connect(alice).open(BTC, true, usd(10_000), 1000, false, "0x");
    expect(await vault.totalAssets()).to.be.closeTo(usd(5_000_000), 2n); // margin is not LP money

    await hold(BTC, px(60_030), 10); // traders up 5,000
    expect(await vault.totalAssets()).to.be.closeTo(usd(4_995_000), usd(1));
    await hold(BTC, px(59_990), 10); // traders down 1,667
    expect(await vault.totalAssets()).to.be.closeTo(usd(5_001_666), usd(2));
  });

  it("bounds each side of each market by what it can lose and win before marking the LP share price", async () => {
    const { engine, vault, alice, bob, push } = await load();
    const EVT = 2;
    const expiry = (await time.latest()) + 300 * 86_400;
    await engine.setMarket(
      EVT,
      marketConfig({ isEvent: true, maxLeverage: 50, maxGapBps: 500, expiry, maxPositionNotional: usd(1_000_000) })
    );
    await push(EVT, px(0.5), usd(2_000_000));
    await engine.connect(bob).open(BTC, true, usd(5_000), 10, false, "0x"); // 50,000 of reserve it is not using
    await engine.connect(alice).open(EVT, true, usd(1_000), 25, false, "0x"); // can win 1,000 at most
    await push(BTC, P0);
    await push(EVT, px(0.9), usd(2_000_000)); // uncapped, Alice would be up 20,000
    // The vault owes Alice her cap and no more, whatever room other positions have reserved.
    expect(await vault.totalAssets()).to.be.closeTo(usd(4_999_000), usd(1));
  });

  it("locks LP shares for a while after a deposit, so nobody can step in and out around a price", async () => {
    const { vault, usdc, lp, alice } = await deploy({ withdrawDelay: 600 });
    await vault.connect(lp).deposit(usd(1_000), lp.address);
    expect(await vault.maxRedeem(lp.address)).to.equal(0n);
    await expect(vault.connect(lp).redeem(1n, lp.address, lp.address)).to.be.revertedWithCustomError(
      vault,
      "ERC4626ExceededMaxRedeem"
    );
    await expect(vault.connect(lp).transfer(alice.address, 1n)).to.be.revertedWithCustomError(vault, "SharesLocked");
    // A deposit starts the receiver's lock, so it can only be made for oneself.
    await expect(vault.connect(alice).deposit(usd(1), lp.address)).to.be.revertedWithCustomError(
      vault,
      "DepositForSelfOnly"
    );
    await time.increase(600);
    const before = await usdc.balanceOf(lp.address);
    await vault.connect(lp).redeem(await vault.balanceOf(lp.address), lp.address, lp.address);
    expect((await usdc.balanceOf(lp.address)) - before).to.equal(usd(1_000));
  });

  it("does not lose staker fees that are too small to divide", async () => {
    const { usdc, token, staking, owner, alice, lp } = await load();
    // Mint OLQ directly so a large stake exists: 1M OLQ against sub-dollar fees.
    const olq = await (await ethers.getContractFactory("OpenLiquidToken")).deploy(
      ethers.parseEther("100"),
      usd(1_000_000),
      owner.address
    );
    await olq.setMinter(owner.address);
    await olq.mintForFee(alice.address, usd(10_102)); // about 1,000,000 OLQ
    const s = await (await ethers.getContractFactory("Staking")).deploy(olq.target, usdc.target);
    const stake = await olq.balanceOf(alice.address);
    await olq.connect(alice).approve(s.target, stake);
    await s.connect(alice).stake(stake);
    // A hundred fees of 0.90 each, with a stranger syncing after every one.
    for (let i = 0; i < 100; i++) {
      await usdc.connect(lp).transfer(s.target, usd(0.9));
      await s.connect(lp).claim();
    }
    expect(await s.pending(alice.address)).to.be.closeTo(usd(90), usd(1));
    void token;
    void staking;
  });

  it("sends the stakers' share of the fee to staking only when someone is staked", async () => {
    const { engine, usdc, token, staking, alice, bob, hold } = await load();
    // Alice earns OLQ from a winning trade, then stakes it.
    await engine.connect(alice).open(BTC, true, usd(100), 1000, false, "0x");
    await hold(BTC, px(60_030), 1200);
    let [pos] = await engine.positionsOf(alice.address);
    await engine.connect(alice).close(pos.id, "0x");
    expect(await usdc.balanceOf(staking.target)).to.equal(0n);

    const olq = await token.balanceOf(alice.address);
    await token.connect(alice).approve(staking.target, olq);
    await staking.connect(alice).stake(olq);

    // Bob's winning trade now pays 30% of its fee to stakers.
    await engine.connect(bob).open(BTC, true, usd(1_000), 1000, false, "0x");
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
    const { oracle, alice, sign } = await load();
    const now = await time.latest();
    const forged = await sign(BTC, px(1), usd(1), now + 1, false, alice);
    await expect(oracle.push([forged.update], [forged.sig])).to.be.revertedWithCustomError(oracle, "BadSignature");
    const early = await sign(BTC, px(1), usd(1), now + 3600);
    await expect(oracle.push([early.update], [early.sig])).to.be.revertedWithCustomError(oracle, "FutureTimestamp");
  });

  it("skips an update older than the stored one instead of reverting", async () => {
    const { oracle, sign } = await load();
    const feed = await oracle.read(BTC);
    const old = await sign(BTC, px(1), usd(1), feed.timestamp - 1n);
    await oracle.push([old.update], [old.sig]);
    expect((await oracle.read(BTC)).mid).to.equal(P0);
  });

  it("moves the slow price only as a new price is held", async () => {
    const { oracle, push } = await load();
    await push(BTC, px(60_600)); // +1% jump
    const f0 = await oracle.read(BTC);
    expect(f0.mid).to.equal(px(60_600));
    expect(f0.slow).to.be.closeTo(P0, px(10)); // one second of a 60s average

    await time.increase(60); // held for one averaging time: 1 - 1/e of the way there
    const f1 = await oracle.read(BTC);
    expect(f1.slow).to.be.closeTo(px(60_379.3), px(10));
  });

  it("averages exactly: the slow price does not depend on how often it is updated", async () => {
    const { oracle, push, hold } = await load();
    const t0 = await push(BTC, px(60_600)); // +1%, then held for 60 s
    await time.increaseTo(t0 + 60);
    const once = (await oracle.read(BTC)).slow;

    const other = await load();
    const t1 = await other.push(BTC, px(60_600));
    for (let t = 2; t <= 60; t += 2) {
      await time.setNextBlockTimestamp(t1 + t);
      const { update, sig } = await other.sign(BTC, px(60_600), usd(20_000_000), t1 + t);
      await other.oracle.push([update], [sig]);
    }
    const often = (await other.oracle.read(BTC)).slow;
    expect(often).to.be.closeTo(once, px(0.001)); // thirty updates or none: the same number
    expect(once).to.be.closeTo(px(60_000 + 600 * (1 - Math.exp(-1))), px(0.5));
  });

  it("counts reference depth only once it has persisted", async () => {
    const { engine, oracle, alice, push } = await load();
    expect((await engine.marketView(BTC)).sideCap).to.equal(usd(10_000_000));
    await push(BTC, P0, usd(200_000_000)); // ten times the depth appears
    const jumped = (await engine.marketView(BTC)).sideCap;
    expect(jumped).to.be.lessThan(usd(13_000_000)); // capacity has barely moved
    await push(BTC, P0, usd(2_000_000)); // depth collapses: capacity follows at once
    expect((await engine.marketView(BTC)).sideCap).to.equal(usd(1_000_000));
    await expect(engine.connect(alice).open(BTC, true, usd(2_000), 1000, false, "0x")).to.be.revertedWithCustomError(
      engine,
      "SideCapExceeded"
    );
    expect((await oracle.read(BTC)).slowDepth).to.be.greaterThan(usd(2_000_000));
  });
});
