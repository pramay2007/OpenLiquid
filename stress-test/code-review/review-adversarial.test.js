// Review lens: abuse of permissionless functions and ordering.
//
// collect(), forceClose(), liquidate(), poke(), oracle.push(), the vault's deposit/redeem and
// staking.claim() can be called by anyone, with any signed price newer than the one on-chain.
//
// Every test is written as an assertion of the behaviour the rules intend, so a FAILING test is a
// demonstrated defect (each prints the numbers). Tests named "OK: ..." are properties that were
// checked and hold. Reviewed against PerpEngine.sol as saved 2026-11-19 21:34 (hazard p(1-p)/tau).
//
//   cd contracts && npx hardhat test test/review-adversarial.test.js

const { expect } = require("chai");
const { ethers, network } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");
const { deploy, marketConfig, usd, px, fmtUsd, BTC, EVT } = require("./helpers");

const DAY = 86_400;
const P0 = px(60_000);
const BTC_DEPTH = usd(20_000_000);
const EVT_DEPTH = usd(2_000_000);

const PRICE_DATA_TYPES = [
  "tuple(uint32 marketId,uint256 price,uint256 depthUsd,uint64 timestamp,bool resolved)[]",
  "bytes[]",
];
const encode = (...signed) =>
  ethers.AbiCoder.defaultAbiCoder().encode(PRICE_DATA_TYPES, [signed.map((s) => s.update), signed.map((s) => s.sig)]);

async function btcSetup(overrides = {}) {
  const ctx = await deploy();
  await ctx.engine.setMarket(BTC, marketConfig(overrides));
  await ctx.vault.connect(ctx.lp).deposit(usd(5_000_000), ctx.lp.address);
  await ctx.push(BTC, P0, BTC_DEPTH);
  return ctx;
}

async function eventSetup(overrides = {}, daysOut = 300, p0 = 0.5) {
  const ctx = await deploy();
  ctx.expiry = (await time.latest()) + daysOut * DAY;
  await ctx.engine.setMarket(
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
  await ctx.vault.connect(ctx.lp).deposit(usd(1_000_000), ctx.lp.address);
  await ctx.push(EVT, px(p0), EVT_DEPTH);
  return ctx;
}

/** Relay one already-signed update in a block stamped `at`. */
async function relayAt(ctx, who, signed, at) {
  await time.setNextBlockTimestamp(at);
  await ctx.oracle.connect(who).push([signed.update], [signed.sig]);
}

describe("REVIEW adversarial: permissionless calls and ordering", function () {
  this.timeout(600_000);
  // ------------------------------------------------------------------------------------------
  // 1. poke() on an id that is not a market yet
  // ------------------------------------------------------------------------------------------
  describe("poke() before a market is listed", () => {
    it("a market listed after a stranger poked its id is still registered, listed and marked in the LP share price", async () => {
      const ctx = await deploy();
      const { engine, vault, lp, alice, carol, push, hold } = ctx;

      // Anyone, before the owner's setMarket lands (the deploy script lists markets one transaction
      // at a time, and future ids are predictable).
      const poked = await (await engine.connect(carol).poke(BTC)).wait();
      console.log("      poke() on an unlisted id: %s gas", poked.gasUsed);

      await engine.setMarket(BTC, marketConfig());
      await vault.connect(lp).deposit(usd(5_000_000), lp.address);
      await push(BTC, P0, BTC_DEPTH);

      // The market trades normally...
      await engine.connect(alice).open(BTC, true, usd(10_000), 1000, false, "0x");
      await hold(BTC, px(60_300), 600); // +0.5% held: the trader is owed 50,000
      const [pos] = await engine.positionsOf(alice.address);
      console.log(
        "      position pnl %s | marketCount %s | allMarkets %s | unrealizedPnl %s | LP totalAssets %s",
        fmtUsd(pos.pnl),
        await engine.marketCount(),
        (await engine.allMarkets()).length,
        fmtUsd(await engine.unrealizedPnl()),
        fmtUsd(await vault.totalAssets())
      );

      // ...but it never entered marketIds, and listing it again does not repair that.
      await engine.setMarket(BTC, marketConfig());
      expect(await engine.marketCount(), "marketCount").to.equal(1n);
      expect((await engine.allMarkets()).length, "allMarkets (what the app reads)").to.equal(1);
      expect(await engine.unrealizedPnl(), "unrealizedPnl").to.be.closeTo(usd(50_000), usd(500));
      expect(await vault.totalAssets(), "LP NAV").to.be.closeTo(usd(4_950_000), usd(500));
    });
  });

  // ------------------------------------------------------------------------------------------
  // 2. forceClose(): eligibility is judged at the mid, the fill is the worse of mid and slow
  // ------------------------------------------------------------------------------------------
  describe("forceClose() at a moment a third party chooses", () => {
    const timed = () => eventSetup({ reactionSeconds: 120 }, 3);

    it("a jump in the owner's favour does not let a stranger close the winner at the pre-jump price", async () => {
      // Control: nobody interferes. The price jumps 0.50 -> 0.60, the slow price follows, and the
      // position is collected at its capped win.
      const a = await timed();
      await a.engine.connect(a.alice).open(EVT, true, usd(100), 15, false, "0x");
      const [pa] = await a.engine.positionsOf(a.alice.address);
      const a0 = await a.usdc.balanceOf(a.alice.address);
      await a.push(EVT, px(0.6), EVT_DEPTH);
      await a.hold(EVT, px(0.6), 600, EVT_DEPTH, 60);
      await a.engine.connect(a.bob).collect(pa.id, "0x");
      const undisturbed = (await a.usdc.balanceOf(a.alice.address)) - a0;

      // Same position, same price path. A stranger calls forceClose in the block after the jump.
      const b = await timed();
      await b.engine.connect(b.alice).open(EVT, true, usd(100), 15, false, "0x");
      const [pb] = await b.engine.positionsOf(b.alice.address);
      const b0 = await b.usdc.balanceOf(b.alice.address);
      await b.push(EVT, px(0.6), EVT_DEPTH);
      const v = await b.engine.positionView(pb.id);
      console.log(
        "      after the jump: forceClosable %s, collectable %s, liquidatable %s, mid %s, close fill %s",
        v.forceClosable,
        v.collectable,
        v.liquidatable,
        ethers.formatUnits((await b.oracle.read(EVT)).mid, 18),
        Number(ethers.formatUnits(v.markPrice, 18)).toFixed(5)
      );
      const nav0 = await b.vault.totalAssets();
      await b.engine.connect(b.bob).forceClose(pb.id, "0x");
      const forced = (await b.usdc.balanceOf(b.alice.address)) - b0;
      console.log(
        "      owner receives: left alone %s | force-closed by a stranger %s | LP NAV step at the forced close %s",
        fmtUsd(undisturbed),
        fmtUsd(forced),
        fmtUsd((await b.vault.totalAssets()) - nav0)
      );

      expect(undisturbed).to.equal(usd(100 + 100 - 10));
      // "No penalty": being force-closed must not cost the owner the move that made it closable.
      expect(forced, "payout when force-closed right after the jump").to.be.greaterThan(usd(150));
    });

    it("a one-sample dip does not let a stranger realise a loss on a position that is nowhere near liquidation", async () => {
      const { engine, oracle, usdc, alice, bob, sign } = await timed();
      await engine.connect(alice).open(EVT, true, usd(100), 15, false, "0x");
      const [pos] = await engine.positionsOf(alice.address);
      const before = await usdc.balanceOf(alice.address);

      // The keeper signs three consecutive samples: 0.50, a single print at 0.48, 0.50 again.
      const t = (await time.latest()) + 1;
      const dip = await sign(EVT, px(0.48), EVT_DEPTH, t + 1);
      const back = await sign(EVT, px(0.5), EVT_DEPTH, t + 2);

      // A stranger relays only the dip and force-closes on it.
      await time.setNextBlockTimestamp(t + 2);
      await engine.connect(bob).forceClose(pos.id, encode(dip));
      const got = (await usdc.balanceOf(alice.address)) - before;
      await oracle.push([back.update], [back.sig]);
      console.log(
        "      15x long at 0.50, liquidation line %s. One print at 0.48: stranger force-closes, owner gets %s of 100 margin; mid is back at %s one second later",
        ethers.formatUnits(pos.liquidationPrice, 18),
        fmtUsd(got),
        ethers.formatUnits((await oracle.read(EVT)).mid, 18)
      );
      expect(got, "owner's payout").to.be.greaterThan(usd(90));
    });

    it("a stranger with capital is not paid for force-closing a winner (deposit, forceClose, redeem in one block)", async () => {
      const { engine, vault, usdc, alice, bob, push } = await timed();
      await engine.connect(alice).open(EVT, true, usd(100), 15, false, "0x");
      const [pos] = await engine.positionsOf(alice.address);
      await push(EVT, px(0.6), EVT_DEPTH); // the jump: alice is owed her 100 reserve at the mark

      const before = await usdc.balanceOf(bob.address);
      const shares = await vault.previewDeposit(usd(9_000_000)); // the mark uses the mid, which does not move
      await network.provider.send("evm_setAutomine", [false]);
      try {
        const o = { gasLimit: 1_500_000 };
        await vault.connect(bob).deposit(usd(9_000_000), bob.address, o);
        await engine.connect(bob).forceClose(pos.id, "0x", o);
        await vault.connect(bob).redeem(shares, bob.address, bob.address, o);
        await network.provider.send("evm_mine");
      } finally {
        await network.provider.send("evm_setAutomine", [true]);
      }
      expect((await ethers.provider.getBlock("latest")).transactions.length).to.equal(3);
      const gain = (await usdc.balanceOf(bob.address)) - before;
      console.log("      stranger deposits 9M, force-closes the winner, redeems, all in one block: gain %s of the owner's forfeited 99", fmtUsd(gain));
      expect(gain, "stranger's gain from closing someone else's winner").to.be.lessThanOrEqual(usd(1));
    });
  });

  // ------------------------------------------------------------------------------------------
  // 2b. liquidate() on a position that borrowed nothing
  // ------------------------------------------------------------------------------------------
  describe("liquidate() on a fully paid 1x event position", () => {
    it("an outright YES bought at 0.50 is not taken from its owner on a print at 0.10", async () => {
      // Left alone: the print passes, the market resolves YES, the outright bet pays.
      const a = await eventSetup();
      await a.engine.connect(a.alice).open(EVT, true, usd(100), 1, false, "0x"); // 200 YES shares, fully paid
      const [pa] = await a.engine.positionsOf(a.alice.address);
      const a0 = await a.usdc.balanceOf(a.alice.address);
      await a.push(EVT, px(0.1), EVT_DEPTH);
      await a.push(EVT, px(0.5), EVT_DEPTH);
      await a.push(EVT, px(1), EVT_DEPTH, true);
      await a.engine.close(pa.id, "0x");
      const held = (await a.usdc.balanceOf(a.alice.address)) - a0;

      // Same path, but a stranger liquidates on the one sample at 0.10.
      const b = await eventSetup();
      await b.engine.connect(b.alice).open(EVT, true, usd(100), 1, false, "0x");
      const [pb] = await b.engine.positionsOf(b.alice.address);
      const b0 = await b.usdc.balanceOf(b.alice.address);
      await b.push(EVT, px(0.1), EVT_DEPTH);
      let liquidated = true;
      try {
        await b.engine.connect(b.liquidator).liquidate(pb.id, "0x");
      } catch {
        liquidated = false;
      }
      const got = (await b.usdc.balanceOf(b.alice.address)) - b0;
      console.log(
        "      1x YES, 100 paid in full (borrowed units %s): one print at 0.10 -> liquidated: %s, owner gets %s, caller gets %s. Held to the YES result it pays %s",
        pb.position.borrowedUnits,
        liquidated,
        fmtUsd(got),
        fmtUsd(await b.usdc.balanceOf(b.liquidator.address)),
        fmtUsd(held)
      );
      expect(liquidated, "a position with no borrowed units was liquidated").to.equal(false);
    });
  });

  // ------------------------------------------------------------------------------------------
  // 3. LP share price: anyone holds newer signed prices than the chain has
  // ------------------------------------------------------------------------------------------
  describe("LP share price around a price the caller relays", () => {
    it("deposit and redeem around two already-signed prices, in one block, earns nothing", async () => {
      const ctx = await btcSetup();
      const { engine, vault, oracle, usdc, lp, alice, bob, sign } = ctx;
      await engine.connect(alice).open(BTC, true, usd(10_000), 1000, false, "0x"); // 10M long

      // Two consecutive keeper samples, both served over HTTP, neither relayed yet: +5 bp, then back.
      const t = (await time.latest()) + 1;
      const up = await sign(BTC, px(60_030), BTC_DEPTH, t);
      const back = await sign(BTC, P0, BTC_DEPTH, t + 1);

      const lpBefore = await vault.totalAssets();
      const bobBefore = await usdc.balanceOf(bob.address);

      // Dry run on a snapshot, only to learn how many shares the deposit will mint.
      const snap = await network.provider.send("evm_snapshot");
      await relayAt(ctx, bob, up, t);
      const shares = await vault.previewDeposit(usd(45_000_000));
      await network.provider.send("evm_revert", [snap]);

      // One block: relay the sample that marks the vault down, deposit, relay the next, redeem.
      await network.provider.send("evm_setAutomine", [false]);
      try {
        const o = { gasLimit: 1_000_000 };
        await oracle.connect(bob).push([up.update], [up.sig], o);
        await vault.connect(bob).deposit(usd(45_000_000), bob.address, o);
        await oracle.connect(bob).push([back.update], [back.sig], o);
        await vault.connect(bob).redeem(shares, bob.address, bob.address, o);
        await time.setNextBlockTimestamp(t + 1);
        await network.provider.send("evm_mine");
      } finally {
        await network.provider.send("evm_setAutomine", [true]);
      }
      const block = await ethers.provider.getBlock("latest");
      expect(block.transactions.length, "all four calls in one block").to.equal(4);

      const bobGain = (await usdc.balanceOf(bob.address)) - bobBefore;
      const lpAfter = await vault.totalAssets();
      console.log(
        "      one block, no position, no price risk: stranger %s | incumbent LPs %s (price is back where it started)",
        fmtUsd(bobGain),
        fmtUsd(lpAfter - lpBefore)
      );
      expect(await vault.balanceOf(bob.address)).to.be.lessThan(10n ** 9n); // dust: he is out again
      expect(bobGain, "stranger's risk-free gain").to.be.lessThanOrEqual(usd(1));
      expect(lpAfter, "incumbent LP value").to.be.closeTo(lpBefore, usd(1));
    });

    it("ordinary one-basis-point noise does not move value from LPs to a stranger who is only in the vault for the down-ticks", async () => {
      const { engine, vault, usdc, alice, bob, push } = await btcSetup();
      await engine.connect(alice).open(BTC, true, usd(10_000), 1000, false, "0x"); // 10M long
      const lpBefore = await vault.totalAssets();
      const bobBefore = await usdc.balanceOf(bob.address);
      for (let i = 0; i < 10; i++) {
        await push(BTC, px(60_006), BTC_DEPTH); // up-tick: the vault is marked down 1,000; bob is outside
        await vault.connect(bob).deposit(usd(45_000_000), bob.address); // he holds the next sample already
        await push(BTC, P0, BTC_DEPTH); // down-tick relayed: the vault is marked back up
        await vault.connect(bob).redeem(await vault.balanceOf(bob.address), bob.address, bob.address);
      }
      const bobGain = (await usdc.balanceOf(bob.address)) - bobBefore;
      const lpChange = (await vault.totalAssets()) - lpBefore;
      console.log(
        "      ten 1 bp up/down ticks, price ends where it started, the one position is flat: stranger %s | incumbent LPs %s",
        fmtUsd(bobGain),
        fmtUsd(lpChange)
      );
      expect(bobGain, "stranger's gain over ten ticks").to.be.lessThanOrEqual(usd(10));
    });

    it("an LP cannot leave between a price jump and the liquidations it makes due", async () => {
      const ctx = await btcSetup();
      const { engine, vault, usdc, lp, alice, bob, carol, liquidator, push } = ctx;
      await vault.connect(bob).deposit(usd(5_000_000), bob.address); // bob and lp each own half
      await engine.connect(alice).open(BTC, true, usd(10_000), 1000, false, "0x"); // 10M long
      await engine.connect(carol).open(BTC, false, usd(10_000), 1000, false, "0x"); // 10M short
      const [short] = await engine.positionsOf(carol.address);

      await push(BTC, px(60_600), BTC_DEPTH); // +1% in one sample
      // The long is owed its full 100,000 reserve. The short has lost its 10,000 margin and no more.
      // LPs are therefore down 90,000. The mark nets +100,000 against an uncapped -100,000.
      const marked = await vault.totalAssets();
      const bobBefore = await usdc.balanceOf(bob.address);
      await vault.connect(bob).redeem(await vault.balanceOf(bob.address), bob.address, bob.address);
      const bobOut = (await usdc.balanceOf(bob.address)) - bobBefore;
      await engine.connect(liquidator).liquidate(short.id, "0x");
      const left = await vault.totalAssets();
      console.log(
        "      NAV marked after the jump %s (true 9,910,000). LP who leaves before the liquidation takes %s; the LP who stays is left with %s",
        fmtUsd(marked),
        fmtUsd(bobOut),
        fmtUsd(left)
      );
      expect(bobOut, "value redeemed by the LP who left first").to.be.closeTo(usd(4_955_000), usd(1_000));
      expect(left, "value left for the LP who stayed").to.be.closeTo(usd(4_955_000), usd(1_000));
      expect(await vault.balanceOf(lp.address)).to.be.greaterThan(0n);
    });
  });

  // ------------------------------------------------------------------------------------------
  // 4. Fee and premium indexes are priced at the instant someone accrues them
  // ------------------------------------------------------------------------------------------
  describe("Boost premium and crowding fee: who accrues, and when", () => {
    const DAYS_OUT = 30;
    const HELD = 29 * DAY;

    /** A 10x Boost long at 0.50, repriced to 0.90 a second later, then nothing for 29 days. */
    async function boosted(pokeEvery = 0) {
      const ctx = await eventSetup({ hazardScale: px(1), boostEnabled: true }, DAYS_OUT);
      const { engine, usdc, alice, bob, push } = ctx;
      await engine.connect(alice).open(EVT, true, usd(100), 10, true, "0x"); // 1,800 borrowed shares
      const [pos] = await engine.positionsOf(alice.address);
      const start = await usdc.balanceOf(alice.address);
      await push(EVT, px(0.9), EVT_DEPTH);
      if (pokeEvery) {
        for (let t = 0; t < HELD; t += pokeEvery) {
          await time.increase(pokeEvery - 1);
          await engine.connect(bob).poke(EVT);
        }
      } else {
        await time.increase(HELD);
      }
      const shown = (await engine.positionView(pos.id)).boostPremium;
      return { ...ctx, pos, start, shown };
    }

    /** The keeper's (or anyone's) settlement call: relay the result, then close. */
    async function settleYes(ctx) {
      await ctx.push(EVT, px(1), EVT_DEPTH, true);
      await ctx.engine.connect(ctx.bob).close(ctx.pos.id, "0x");
      return (await ctx.usdc.balanceOf(ctx.alice.address)) - ctx.start - usd(100);
    }

    it("a Boost position pays the same premium whether or not a stranger called poke()", async () => {
      // Continuous accrual: 1,800 shares * 0.90 * 0.10 * ln(30 days / 1 day) = 551 of premium on a 1,000 win.
      const quiet = await boosted();
      const netQuiet = await settleYes(quiet);

      const once = await boosted();
      await once.engine.connect(once.bob).poke(EVT); // one call, one block before the result is relayed
      const netOnce = await settleYes(once);

      const often = await boosted(6 * 3600);
      const netOften = await settleYes(often);

      console.log("      Boost 10x long, 100 margin, 0.50 -> 0.90, resolves YES 29 days later (win before premium: 1,000):");
      console.log("        nobody touched the market : premium shown to the owner %s, net win paid %s", fmtUsd(quiet.shown), fmtUsd(netQuiet));
      console.log("        one poke() before the result: premium shown %s, net win paid %s", fmtUsd(once.shown), fmtUsd(netOnce));
      console.log("        poke() every six hours      : premium shown %s, net win paid %s", fmtUsd(often.shown), fmtUsd(netOften));

      expect(netQuiet, "net win with no accrual before resolution").to.be.closeTo(netOften, usd(20));
      expect(netOnce, "net win with one accrual").to.be.closeTo(netOften, usd(20));
    });

    it("one unusual-depth sample relayed with a poke() does not reprice a whole day of crowding fee", async () => {
      async function run(oneSampleDepth) {
        const ctx = await btcSetup({ crowdingPerDay: px(0.001) }); // 0.1% a day at full skew
        const { engine, usdc, alice, bob, push, hold } = ctx;
        await engine.connect(alice).open(BTC, true, usd(4_000), 1000, false, "0x"); // 4M of a 10M cap: skew 0.4
        const [pos] = await engine.positionsOf(alice.address);
        await time.increase(DAY); // a quiet day: nobody trades this market, so nothing accrues on-chain
        if (oneSampleDepth !== undefined) {
          await push(BTC, P0, oneSampleDepth); // one keeper sample with unusual depth within 10 bp
          await engine.connect(bob).poke(BTC);
        }
        await push(BTC, P0, BTC_DEPTH);
        await engine.connect(bob).poke(BTC);
        const accrued = (await engine.positionView(pos.id)).crowdingFee;
        await hold(BTC, px(60_120), 1200, BTC_DEPTH, 20); // +0.2% held: an 8,000 win
        const before = await usdc.balanceOf(alice.address);
        await engine.connect(alice).close(pos.id, "0x");
        return { accrued, net: (await usdc.balanceOf(alice.address)) - before - usd(4_000) };
      }
      const normal = await run();
      const thin = await run(usd(100_000));
      const empty = await run(0n);
      console.log(
        "      crowding fee booked for the same quiet day: %s normally | %s if a stranger relays one thin-depth sample and pokes | %s if the trader relays one zero-depth sample and pokes",
        fmtUsd(normal.accrued),
        fmtUsd(thin.accrued),
        fmtUsd(empty.accrued)
      );
      console.log("      the winner's net on the same 8,000 move: %s | %s | %s", fmtUsd(normal.net), fmtUsd(thin.net), fmtUsd(empty.net));
      expect(thin.accrued, "fee booked for the day after one thin-depth sample").to.be.closeTo(normal.accrued, usd(50));
      expect(empty.accrued, "fee booked for the day after one zero-depth sample").to.be.closeTo(normal.accrued, usd(50));
    });

    it("OK: a position opened or closed in the block before a settlement does not change what was already accrued", async () => {
      const { engine, alice, bob, carol, push } = await eventSetup({ hazardScale: px(1), boostEnabled: true });
      await engine.connect(alice).open(EVT, true, usd(100), 10, false, "0x"); // 1,800 borrowed YES shares
      await engine.connect(bob).open(EVT, false, usd(100), 10, false, "0x"); // 1,800 borrowed NO shares
      const [pa] = await engine.positionsOf(alice.address);
      const [pb] = await engine.positionsOf(bob.address);
      await time.increase(DAY);
      await push(EVT, px(0.5), EVT_DEPTH);
      const balanced = (await engine.positionView(pa.id)).crowdingFee;

      // The offsetting side leaves just before alice would settle: her balanced day stays free.
      await engine.connect(bob).close(pb.id, "0x");
      const afterExit = (await engine.positionView(pa.id)).crowdingFee;
      expect(afterExit - balanced).to.be.lessThan(usd(0.001));

      // A one-sided day costs 1.50 (1,800 * 0.25 / 300); a stranger offsetting at the end does not rewrite it.
      await time.increase(DAY);
      await push(EVT, px(0.5), EVT_DEPTH);
      const oneSided = (await engine.positionView(pa.id)).crowdingFee;
      await engine.connect(carol).open(EVT, false, usd(1_000), 10, false, "0x");
      const afterOffset = (await engine.positionView(pa.id)).crowdingFee;
      expect(oneSided).to.be.closeTo(usd(1.5), usd(0.05));
      expect(afterOffset - oneSided).to.be.lessThan(usd(0.001));
    });
  });

  // ------------------------------------------------------------------------------------------
  // 5. "Held" is measured between on-chain samples, and the caller picks the samples
  // ------------------------------------------------------------------------------------------
  describe("oracle.push(): withholding the samples that follow a spike", () => {
    it("a one-second price print is not credited as held because nobody relayed the next sample", async () => {
      const ctx = await btcSetup();
      const { engine, usdc, alice, sign } = ctx;
      await engine.connect(alice).open(BTC, true, usd(9_900), 1000, false, "0x"); // 9.9M long at 60,000
      const [pos] = await engine.positionsOf(alice.address);
      const before = await usdc.balanceOf(alice.address);

      // The keeper signs one sample at +0.12% and is back at 60,000 a second later.
      const t = (await time.latest()) + 1;
      const print = await sign(BTC, px(60_072), BTC_DEPTH, t);
      await relayAt(ctx, alice, print, t); // the trader relays the print and nothing after it
      await time.setNextBlockTimestamp(t + 29); // still inside maxAge (30 here, 20 on Arc)
      await engine.connect(alice).close(pos.id, "0x");
      const profit = (await usdc.balanceOf(alice.address)) - before - usd(9_900);
      console.log(
        "      price shown for ONE second at +0.12%%, relayed by the trader, next samples withheld for 29 s: close pays %s (1.65%% of the gap would be about 190)",
        fmtUsd(profit)
      );
      expect(profit, "profit from a one-second print").to.be.lessThan(usd(1_040)); // exploit.test.js bound for a quick close
    });

    it("two one-second prints are not credited as a price held for the time between them", async () => {
      // The caller chooses which signed samples reach the chain. maxAge only limits the last one.
      const PRINT = px(60_072); // +0.12%
      async function twoPrints(ctx) {
        const t = (await time.latest()) + 1;
        const first = await ctx.sign(BTC, PRINT, BTC_DEPTH, t); // one sample at +0.12%...
        const second = await ctx.sign(BTC, PRINT, BTC_DEPTH, t + 98); // ...and one more, 98 s later
        await time.setNextBlockTimestamp(t + 98);
        return encode(first, second); // nothing in between is relayed (keeper heartbeat on Arc: 120 s)
      }

      // Leg 1: close a long into the print.
      const a = await btcSetup();
      await a.engine.connect(a.alice).open(BTC, true, usd(9_900), 1000, false, "0x");
      const [long] = await a.engine.positionsOf(a.alice.address);
      const a0 = await a.usdc.balanceOf(a.alice.address);
      await a.engine.connect(a.alice).close(long.id, await twoPrints(a));
      const leg1 = (await a.usdc.balanceOf(a.alice.address)) - a0 - usd(9_900);

      // Leg 2: open a short at the print (exploit.test.js expects PriceDislocated), close when it is gone.
      const b = await btcSetup();
      const b0 = await b.usdc.balanceOf(b.alice.address);
      let opened = true;
      try {
        await b.engine.connect(b.alice).open(BTC, false, usd(9_900), 1000, false, await twoPrints(b));
      } catch {
        opened = false;
      }
      let leg2 = 0n;
      if (opened) {
        const [short] = await b.engine.positionsOf(b.alice.address);
        await b.hold(BTC, P0, 600, BTC_DEPTH, 20);
        await b.engine.connect(b.alice).close(short.id, "0x");
        leg2 = (await b.usdc.balanceOf(b.alice.address)) - b0;
      }
      console.log(
        "      two one-second prints at +0.12%%, 98 s apart, relayed in the same call: close a 9.9M long into them %s | short opened at the print: %s, P&L %s",
        fmtUsd(leg1),
        opened,
        fmtUsd(leg2)
      );
      expect(leg1, "profit from closing into two prints").to.be.lessThan(usd(1_040));
      expect(opened, "a short opened at a price that was shown for two seconds").to.equal(false);
    });

    it("one sample of 10x depth does not multiply the side cap", async () => {
      const ctx = await btcSetup();
      const { engine, alice, sign } = ctx;
      expect((await engine.marketView(BTC)).sideCap).to.equal(usd(10_000_000));

      const t = (await time.latest()) + 1;
      const spoof = await sign(BTC, P0, usd(200_000_000), t); // depth shown for one keeper sample
      await relayAt(ctx, alice, spoof, t);

      // 29 s later, still inside maxAge, four 9.9M longs in one block.
      await network.provider.send("evm_setAutomine", [false]);
      try {
        for (let i = 0; i < 4; i++) {
          await engine.connect(alice).open(BTC, true, usd(9_900), 1000, false, "0x", { gasLimit: 1_500_000 });
        }
        await time.setNextBlockTimestamp(t + 29);
        await network.provider.send("evm_mine");
      } finally {
        await network.provider.send("evm_setAutomine", [true]);
      }
      const cap = (await engine.marketView(BTC)).sideCap;
      const opened = Number((await engine.marketView(BTC)).state.longOI / 1_000_000n);
      console.log(
        "      one 200M depth sample, next samples withheld for 29 s: side cap %s (persistent depth supports 10,000,000); long OI opened %s",
        fmtUsd(cap),
        opened
      );
      expect(opened, "long open interest against 20M of persistent depth").to.be.lessThanOrEqual(11_000_000);
    });
  });

  // ------------------------------------------------------------------------------------------
  // 6. Staking: anyone can trigger the sync that rounds a fee away
  // ------------------------------------------------------------------------------------------
  describe("Staking: claim() by a non-staker after each fee", () => {
    it("stakers receive the fees sent to the contract", async () => {
      const [owner, , , alice, , carol] = await ethers.getSigners();
      const usdc = await (await ethers.getContractFactory("MockUSDC")).deploy();
      const olq = await (await ethers.getContractFactory("OpenLiquidToken")).deploy(
        ethers.parseEther("100"),
        usd(1_000_000),
        owner.address
      );
      await olq.setMinter(owner.address); // stands in for the engine
      const staking = await (await ethers.getContractFactory("Staking")).deploy(olq.target, usdc.target);

      await olq.mintForFee(alice.address, usd(25_000)); // what 25,000 of profit fees mint: about 2.4M OLQ
      const stake = await olq.balanceOf(alice.address);
      await olq.connect(alice).approve(staking.target, stake);
      await staking.connect(alice).stake(stake);

      // 100 closes each send a 2.00 staker share (vault.settlePosition's plain transfer). After each
      // one, someone with no stake calls claim(), which runs _sync().
      for (let i = 0; i < 100; i++) {
        await usdc.mint(staking.target, usd(2));
        await staking.connect(carol).claim();
      }
      const pending = await staking.pending(alice.address);
      console.log(
        "      %s OLQ staked by the only staker; 100 fees of 2.00 arrive, each followed by a stranger's claim(): pending %s, held by the contract %s",
        Math.round(Number(ethers.formatEther(stake))),
        fmtUsd(pending),
        fmtUsd(await usdc.balanceOf(staking.target))
      );
      expect(pending, "the only staker's pending rewards").to.be.closeTo(usd(200), usd(1));
    });
  });

  // ------------------------------------------------------------------------------------------
  // 7. Smaller items
  // ------------------------------------------------------------------------------------------
  describe("smaller items", () => {
    it("a flat long+short pair that locks the whole vault has a carrying cost", async () => {
      const { engine, vault, usdc, lp, alice, bob, push } = await btcSetup({ crowdingPerDay: px(0.0005) });
      const before = await usdc.balanceOf(bob.address);
      // 10x each way: reserve = notional = 10x margin. 250,000 a side locks 5,000,000.
      await engine.connect(bob).open(BTC, true, usd(250_000), 10, false, "0x");
      await engine.connect(bob).open(BTC, false, usd(250_000), 10, false, "0x");
      const free = await vault.freeLiquidity();
      const lpCanWithdraw = await vault.maxWithdraw(lp.address);
      let othersCanOpen = true;
      try {
        await engine.connect(alice).open(BTC, true, usd(100), 10, false, "0x");
      } catch {
        othersCanOpen = false;
      }
      await time.increase(7 * DAY);
      await push(BTC, P0, BTC_DEPTH);
      for (const p of await engine.positionsOf(bob.address)) await engine.connect(bob).close(p.id, "0x");
      const cost = before - (await usdc.balanceOf(bob.address));
      console.log(
        "      500,000 of margin, net exposure zero, held 7 days: free liquidity %s, LP can withdraw %s of 5,000,000, others can open: %s, cost to the holder %s",
        fmtUsd(free),
        fmtUsd(lpCanWithdraw),
        othersCanOpen,
        fmtUsd(cost)
      );
      expect(cost, "cost of freezing the vault for a week").to.be.greaterThan(0n);
    });

    it("a close fills at the price its sender relayed, or not at all", async () => {
      const ctx = await btcSetup();
      const { engine, oracle, usdc, alice, bob, sign, hold } = ctx;
      await engine.connect(alice).open(BTC, true, usd(100), 1000, false, "0x");
      const [pos] = await engine.positionsOf(alice.address);
      await hold(BTC, px(60_030), 1200, BTC_DEPTH, 20); // +5 bp, held: the app shows a 47.50 net win
      const before = await usdc.balanceOf(alice.address);

      const t = (await time.latest()) + 1;
      const seen = await sign(BTC, px(60_030), BTC_DEPTH, t); // the price alice bundles with her close
      const newer = await sign(BTC, P0, BTC_DEPTH, t + 1); // the next sample: five basis points lower

      await relayAt(ctx, bob, newer, t + 1); // lands first: the keeper's relay, or a front-runner
      await engine.connect(alice).close(pos.id, encode(seen)); // her update is skipped silently
      const net = (await usdc.balanceOf(alice.address)) - before - usd(100);
      console.log("      close sent with a 60,030 price attached (a 47.50 win); a newer 60,000 sample landed first: paid %s, no revert", fmtUsd(net));
      expect((await oracle.read(BTC)).mid).to.equal(P0);
      expect(net, "net win on the close").to.be.closeTo(usd(47.5), usd(1));
    });

    it("liquidating a position that has gone through zero equity is rewarded", async () => {
      // It is the liquidation the vault needs most: until it happens the owner holds a free option.
      const a = await btcSetup();
      await a.engine.connect(a.alice).open(BTC, true, usd(10_000), 1000, false, "0x"); // 10M long
      const [pos] = await a.engine.positionsOf(a.alice.address);
      await a.push(BTC, px(59_880), BTC_DEPTH); // -0.2% in one sample: twice the margin
      await a.engine.connect(a.liquidator).liquidate(pos.id, "0x");
      const reward = await a.usdc.balanceOf(a.liquidator.address);

      // Same path, but nobody bothers (no reward, keeper busy or down). The price comes back.
      const b = await btcSetup();
      await b.engine.connect(b.alice).open(BTC, true, usd(10_000), 1000, false, "0x");
      const [pb] = await b.engine.positionsOf(b.alice.address);
      const before = await b.usdc.balanceOf(b.alice.address);
      await b.push(BTC, px(59_880), BTC_DEPTH);
      const under = (await b.engine.positionView(pb.id)).equityAtMid;
      await b.hold(BTC, px(60_060), 1200, BTC_DEPTH, 20);
      await b.engine.connect(b.alice).close(pb.id, "0x");
      const net = (await b.usdc.balanceOf(b.alice.address)) - before - usd(10_000);
      console.log(
        "      10M long through zero equity (equity at mid %s): liquidator is paid %s. Left unliquidated, the price recovers and the owner closes for %s",
        fmtUsd(under),
        fmtUsd(reward),
        fmtUsd(net)
      );
      expect(reward, "reward for liquidating a position with no equity left").to.be.greaterThan(0n);
    });

    it("OK: a newer price relayed first never makes the owner's close revert", async () => {
      const ctx = await btcSetup();
      const { engine, alice, bob, sign } = ctx;
      await engine.connect(alice).open(BTC, true, usd(100), 100, false, "0x");
      const [pos] = await engine.positionsOf(alice.address);
      const t = (await time.latest()) + 1;
      const mine = await sign(BTC, P0, BTC_DEPTH, t);
      const newer = await sign(BTC, px(60_600), BTC_DEPTH, t + 1); // +1% in one sample: opens are blocked
      await relayAt(ctx, bob, newer, t + 1);
      await expect(engine.connect(alice).open(BTC, true, usd(100), 100, false, "0x")).to.be.revertedWithCustomError(
        engine,
        "PriceDislocated"
      );
      await engine.connect(alice).close(pos.id, encode(mine)); // closes are always allowed (R2)
      expect((await engine.positionsOf(alice.address)).length).to.equal(0);
    });

    it("OK: collect() cannot be used on a single print through the win line, and costs the owner nothing when it is due", async () => {
      const ctx = await eventSetup();
      const { engine, usdc, alice, bob, push, hold } = ctx;
      await engine.connect(alice).open(EVT, true, usd(100), 10, false, "0x"); // win line 0.55
      const [pos] = await engine.positionsOf(alice.address);
      await push(EVT, px(0.6), EVT_DEPTH);
      await expect(engine.connect(bob).collect(pos.id, "0x")).to.be.revertedWithCustomError(engine, "NotCollectable");
      await hold(EVT, px(0.6), 600, EVT_DEPTH, 60);
      const before = await usdc.balanceOf(alice.address);
      await engine.connect(bob).collect(pos.id, "0x");
      expect((await usdc.balanceOf(alice.address)) - before).to.equal(usd(190)); // the maximum the position can ever pay
      expect(await usdc.balanceOf(bob.address)).to.equal(usd(50_000_000)); // nothing for the caller
    });

    it("OK: liquidate() cannot be called on a healthy position, and its reward never comes out of the vault", async () => {
      const ctx = await btcSetup();
      const { engine, vault, usdc, alice, liquidator, push } = ctx;
      await engine.connect(alice).open(BTC, true, usd(100), 1000, false, "0x");
      const [pos] = await engine.positionsOf(alice.address);
      await push(BTC, px(59_960), BTC_DEPTH); // -6.7 bp: equity 33
      await expect(engine.connect(liquidator).liquidate(pos.id, "0x")).to.be.revertedWithCustomError(
        engine,
        "NotLiquidatable"
      );
      await push(BTC, px(59_000), BTC_DEPTH); // far through: no equity left
      const cash = await vault.cash();
      await engine.connect(liquidator).liquidate(pos.id, "0x");
      expect(await usdc.balanceOf(liquidator.address)).to.equal(0n); // no equity, no reward
      expect(await vault.cash()).to.equal(cash); // and nothing leaves the vault
    });
  });
});
