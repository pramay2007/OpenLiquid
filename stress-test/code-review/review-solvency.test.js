// Pre-deployment review, lens: accounting and solvency.
//
// Two groups.
//   1. "holds": properties that were checked and are true on the current code. These pass.
//   2. "DEFECT": each test states the intended behaviour and FAILS on the current code. The
//      numbers in the failure message are the size of the problem. A test passes once the
//      defect is fixed.
//
// Run:  npx hardhat test test/review-solvency.test.js

const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");
const { deploy, marketConfig, usd, px, fmtUsd, BTC, EVT } = require("./helpers");

const DAY = 86_400;
const EDEPTH = usd(2_000_000);
const BDEPTH = usd(20_000_000);
const UNIT = 10n ** 36n;
const WAD = 10n ** 18n;

/** One crypto market and one event market sharing a vault. */
async function mixed({ evt = {}, btc = {}, daysOut = 300, lpUsd = 5_000_000 } = {}) {
  const ctx = await deploy();
  ctx.expiry = (await time.latest()) + daysOut * DAY;
  ctx.btcConfig = marketConfig(btc);
  ctx.evtConfig = marketConfig({
    isEvent: true,
    maxLeverage: 50,
    profitFeeBps: 1000,
    maxGapBps: 500,
    expiry: ctx.expiry,
    maxPositionNotional: usd(1_000_000),
    ...evt,
  });
  await ctx.engine.setMarket(BTC, ctx.btcConfig);
  await ctx.engine.setMarket(EVT, ctx.evtConfig);
  await ctx.vault.connect(ctx.lp).deposit(usd(lpUsd), ctx.lp.address);
  await ctx.push(BTC, px(60_000));
  await ctx.push(EVT, px(0.5), EDEPTH);
  return ctx;
}

/** The PositionClosed event of a closing transaction. */
async function closedEvent(engine, tx) {
  const rc = await (await tx).wait();
  for (const l of rc.logs) {
    try {
      const parsed = engine.interface.parseLog(l);
      if (parsed && parsed.name === "PositionClosed") return parsed.args;
    } catch {
      /* a log from another contract */
    }
  }
  throw new Error("no PositionClosed event");
}

/** What traders are owed at the mid with every position bounded by its own margin and reserve. */
async function cappedOwed(engine) {
  const n = Number(await engine.openPositionCount());
  let owed = 0n;
  for (const v of n ? await engine.openPositions(0, n) : []) owed += v.equityAtMid - v.position.margin;
  return owed;
}

/** LP value if every open position were bounded individually. */
async function fairNav(ctx) {
  return (await ctx.vault.cash()) - (await ctx.vault.marginHeld()) - (await cappedOwed(ctx.engine));
}

const succeeds = (promise) =>
  promise.then(
    () => true,
    () => false
  );

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

const unitsOf = (isEvent, isLong, amount, entry) =>
  isEvent && !isLong ? (amount * UNIT) / (WAD - entry) : (amount * UNIT) / entry;

/** The engine's totals and the vault's locked balances must equal the sums over open positions. */
async function checkLedger(ctx, label) {
  const { engine, vault } = ctx;
  const n = Number(await engine.openPositionCount());
  const views = n ? await engine.openPositions(0, n) : [];
  let margin = 0n;
  let reserve = 0n;
  const per = {};
  for (const m of [BTC, EVT]) {
    per[m] = { longOI: 0n, shortOI: 0n, longUnits: 0n, shortUnits: 0n, longBorrowed: 0n, shortBorrowed: 0n };
  }
  for (const v of views) {
    const p = v.position;
    const m = Number(p.marketId);
    margin += p.margin;
    reserve += p.reserve;
    const u = unitsOf(m === EVT, p.isLong, p.notional, p.entryPrice);
    const side = p.isLong ? "long" : "short";
    per[m][side + "OI"] += p.notional;
    per[m][side + "Units"] += u;
    per[m][side + "Borrowed"] += p.borrowedUnits;
  }
  expect(await vault.marginHeld(), label + ": marginHeld").to.equal(margin);
  expect(await vault.reserved(), label + ": reserved").to.equal(reserve);
  expect(await vault.cash(), label + ": cash covers margin + reserve").to.be.gte(margin + reserve);
  for (const m of [BTC, EVT]) {
    const s = await engine.states(m);
    for (const k of Object.keys(per[m])) expect(s[k], `${label}: market ${m} ${k}`).to.equal(per[m][k]);
  }
}

// ==========================================================================================
describe("review-solvency: holds", function () {
  this.timeout(1_800_000);

  it("random sequences of every call keep the ledger exact and never pay more than margin + reserve", async function () {
    for (const seed of [11, 22]) {
      const ctx = await mixed({
        evt: { hazardScale: px(1), boostEnabled: true, reactionSeconds: 120 },
        btc: { crowdingPerDay: px(0.0005) },
        daysOut: 4,
      });
      const { engine, vault, usdc, token, staking, oracle, lp, alice, bob, carol, liquidator, push } = ctx;
      const R = rng(seed);
      const traders = [alice, bob, carol];
      let btc = 60_000;
      let evt = 0.5;
      const btcCfg = { ...ctx.btcConfig };
      const evtCfg = { ...ctx.evtConfig };
      const done = { open: 0, close: 0, liquidate: 0, collect: 0, forceClose: 0, settle: 0, setMarket: 0, lp: 0 };

      const pushBoth = async () => {
        await push(BTC, px(btc.toFixed(6)));
        if (!(await oracle.read(EVT)).resolved) await push(EVT, px(evt.toFixed(6)), EDEPTH);
      };
      const all = async () => {
        const n = Number(await engine.openPositionCount());
        return n ? engine.openPositions(0, n) : [];
      };

      /** Run one closing call and check what left the vault. */
      const closing = async (kind, id, send) => {
        const p = await engine.positions(id);
        const before = await Promise.all([vault.cash(), usdc.balanceOf(p.owner), usdc.balanceOf(staking.target), usdc.balanceOf(liquidator.address)]);
        const ev = await closedEvent(engine, send());
        const after = await Promise.all([vault.cash(), usdc.balanceOf(p.owner), usdc.balanceOf(staking.target), usdc.balanceOf(liquidator.address)]);
        const out = before[0] - after[0];
        const toOwner = after[1] - before[1];
        const toStakers = after[2] - before[2];
        const toLiquidator = after[3] - before[3];
        expect(out, `${kind}: vault outflow <= margin + reserve`).to.be.lte(p.margin + p.reserve);
        expect(out, `${kind}: outflow is the three payments`).to.equal(toOwner + toStakers + toLiquidator);
        expect(toOwner, `${kind}: owner receives the reported payout`).to.equal(ev.payout);
        expect(toStakers, `${kind}: staker share <= fee`).to.be.lte(ev.fee);
        if (ev.pnl <= 0n) expect(toOwner, `${kind}: a loser never gets more than margin`).to.be.lte(p.margin);
        done[kind]++;
      };

      for (let step = 0; step < 150; step++) {
        const r = R();
        if (r < 0.3) {
          const who = traders[Math.floor(R() * 3)];
          const onEvent = R() < 0.5;
          await pushBoth();
          let lev;
          let margin;
          let boost = false;
          if (onEvent) {
            const maxLev = Number((await engine.marketView(EVT)).maxLeverageLong);
            if (maxLev === 0) continue;
            lev = 1 + Math.floor(R() * maxLev);
            margin = usd((10 + R() * 3000).toFixed(2));
            boost = R() < 0.4;
          } else {
            lev = [1, 2, 5, 10, 50, 100, 500, 1000][Math.floor(R() * 8)];
            margin = usd((10 + R() * 8000).toFixed(2));
          }
          if (await succeeds(engine.connect(who).open(onEvent ? EVT : BTC, R() < 0.5, margin, lev, boost, "0x"))) done.open++;
        } else if (r < 0.5) {
          const jump = R() < 0.15;
          btc *= 1 + (R() - 0.5) * (jump ? 0.08 : 0.004);
          evt = Math.min(0.97, Math.max(0.03, evt + (R() - 0.5) * (jump ? 0.5 : 0.06)));
          await pushBoth();
          if (R() < 0.6) {
            for (let t = 0; t < 300 + R() * 900; t += 60) {
              await time.increase(59);
              await pushBoth();
            }
          }
        } else if (r < 0.64) {
          const views = await all();
          if (!views.length) continue;
          const v = views[Math.floor(R() * views.length)];
          const owner = traders.find((t) => t.address === v.position.owner);
          await pushBoth();
          await closing("close", v.id, () => engine.connect(owner).close(v.id, "0x"));
        } else if (r < 0.74) {
          await pushBoth();
          for (const v of await all()) {
            if (v.liquidatable) await closing("liquidate", v.id, () => engine.connect(liquidator).liquidate(v.id, "0x"));
          }
        } else if (r < 0.81) {
          await pushBoth();
          for (const v of await all()) {
            if (v.collectable) await closing("collect", v.id, () => engine.connect(liquidator).collect(v.id, "0x"));
          }
        } else if (r < 0.86) {
          await pushBoth();
          for (const v of await all()) {
            if (v.forceClosable) await closing("forceClose", v.id, () => engine.connect(liquidator).forceClose(v.id, "0x"));
          }
        } else if (r < 0.92) {
          // Parameter changes on a live market, positions open.
          const k = Math.floor(R() * 7);
          if (k === 0) evtCfg.hazardScale = px((R() * 5).toFixed(3));
          if (k === 1) evtCfg.maxProfitMult = 2 + Math.floor(R() * 18);
          if (k === 2) evtCfg.boostEnabled = !evtCfg.boostEnabled;
          if (k === 3) btcCfg.maxProfitMult = 2 + Math.floor(R() * 18);
          if (k === 4) btcCfg.crowdingPerDay = px((R() * 0.01).toFixed(5));
          if (k === 5) evtCfg.profitFeeBps = Math.floor(R() * 5000);
          if (k === 6) btcCfg.kappaBps = 1000 + Math.floor(R() * 9000);
          await engine.setMarket(BTC, btcCfg);
          await engine.setMarket(EVT, evtCfg);
          done.setMarket++;
        } else if (r < 0.95) {
          // LP flow: withdraw what is free, or add.
          if (R() < 0.5) {
            const max = await vault.maxRedeem(lp.address);
            if (max > 0n) await vault.connect(lp).redeem((max * BigInt(Math.floor(R() * 1000))) / 1000n, lp.address, lp.address);
          } else {
            await vault.connect(lp).deposit(usd(Math.floor(R() * 500_000) + 1), lp.address);
          }
          done.lp++;
        } else if (r < 0.97) {
          await engine.poke(R() < 0.5 ? BTC : EVT);
        } else {
          await time.increase(600 + Math.floor(R() * 6 * 3600));
          await pushBoth();
        }
        if (step === 60) {
          // From here on a share of every fee leaves the vault for stakers.
          for (const t of traders) {
            const bal = await token.balanceOf(t.address);
            if (bal === 0n) continue;
            await token.connect(t).approve(staking.target, bal);
            await staking.connect(t).stake(bal);
          }
        }
        await checkLedger(ctx, `seed ${seed} step ${step}`);
      }

      // Near expiry the time limit falls to 1x: every leveraged event position still open, plus a
      // few opened here, must be closable by anyone, and the ledger must stay exact.
      for (let t = 0; t < 1200; t += 60) {
        await time.increase(59);
        await pushBoth();
      }
      for (const [i, who] of traders.entries()) {
        const maxLev = Number((await engine.marketView(EVT)).maxLeverageLong);
        if (maxLev < 2) break;
        await pushBoth();
        await succeeds(engine.connect(who).open(EVT, i % 2 === 0, usd(200 + 100 * i), Math.min(maxLev, 4), i === 1 && evtCfg.boostEnabled, "0x"));
      }
      if ((await time.latest()) < ctx.expiry - 1800) await time.increaseTo(ctx.expiry - 1800);
      await pushBoth();
      for (const v of await all()) {
        if (v.liquidatable) await closing("liquidate", v.id, () => engine.connect(liquidator).liquidate(v.id, "0x"));
        else if (v.forceClosable) await closing("forceClose", v.id, () => engine.connect(liquidator).forceClose(v.id, "0x"));
      }
      await checkLedger(ctx, `seed ${seed} after force-closes`);
      // Unleveraged bets on both sides are still allowed; they are settled after resolution.
      await pushBoth();
      await succeeds(engine.connect(alice).open(EVT, true, usd(300), 1, false, "0x"));
      await succeeds(engine.connect(bob).open(EVT, false, usd(300), 1, false, "0x"));

      // Resolve the event, settle every event position through a third party, close the rest.
      await push(EVT, R() < 0.5 ? px(1) : 0n, EDEPTH, true);
      for (const v of await all()) {
        const onEvent = Number(v.position.marketId) === EVT;
        const owner = traders.find((t) => t.address === v.position.owner);
        await push(BTC, px(btc.toFixed(6)));
        if (onEvent) await closing("settle", v.id, () => engine.connect(liquidator).close(v.id, "0x"));
        else await closing("close", v.id, () => engine.connect(owner).close(v.id, "0x"));
      }
      await checkLedger(ctx, `seed ${seed} final`);
      expect(await vault.marginHeld()).to.equal(0n);
      expect(await vault.reserved()).to.equal(0n);
      expect(await engine.unrealizedPnl()).to.equal(0n);
      expect(await vault.totalAssets()).to.equal(await vault.cash());
      for (const m of [BTC, EVT]) {
        const s = await engine.states(m);
        expect(s.longOI + s.shortOI + s.longUnits + s.shortUnits + s.longBorrowed + s.shortBorrowed).to.equal(0n);
      }
      console.log(`      seed ${seed}: ${JSON.stringify(done)}`);
    }
  });

  it("what a position can be paid is fixed at open: lowering maxProfitMult, switching Boost off or changing hazardScale later changes nothing that was locked", async () => {
    const ctx = await mixed({ evt: { hazardScale: px(1), boostEnabled: true } });
    const { engine, vault, usdc, alice, bob, push, hold } = ctx;
    await engine.connect(alice).open(BTC, true, usd(1_000), 1000, false, "0x"); // reserve 10,000
    await engine.connect(bob).open(EVT, true, usd(100), 10, true, "0x"); // boosted, reserve 1,000
    expect(await vault.reserved()).to.equal(usd(11_000));

    await engine.setMarket(BTC, { ...ctx.btcConfig, maxProfitMult: 2 });
    await engine.setMarket(EVT, { ...ctx.evtConfig, maxProfitMult: 1, boostEnabled: false, hazardScale: px(5) });
    expect(await vault.reserved()).to.equal(usd(11_000));

    await hold(BTC, px(61_800), 1200, BDEPTH, 60); // +3%: three times the cap
    const [pa] = await engine.positionsOf(alice.address);
    const a0 = await usdc.balanceOf(alice.address);
    await engine.connect(alice).close(pa.id, "0x");
    expect((await usdc.balanceOf(alice.address)) - a0).to.equal(usd(1_000 + 10_000 - 500)); // the reserve locked at open

    await push(EVT, px(1), EDEPTH, true);
    const [pb] = await engine.positionsOf(bob.address);
    const cash0 = await vault.cash();
    const ev = await closedEvent(engine, engine.close(pb.id, "0x"));
    expect(cash0 - (await vault.cash())).to.be.lte(usd(100 + 1_000));
    expect(ev.pnl).to.be.lte(usd(1_000));
    expect(await vault.reserved()).to.equal(0n);
    expect(await vault.marginHeld()).to.equal(0n);
  });

  it("rounding: a flat round trip returns the margin exactly, and price P&L is off by less than one millionth of a dollar", async () => {
    const ctx = await mixed();
    const { engine, usdc, oracle, alice, hold } = ctx;
    const a0 = await usdc.balanceOf(alice.address);
    await engine.connect(alice).open(BTC, true, 1_000_001n, 1, false, "0x");
    await engine.connect(alice).open(BTC, false, 1_000_001n, 1, false, "0x");
    let views = await engine.positionsOf(alice.address);
    for (const v of views) await engine.connect(alice).close(v.id, "0x");
    expect(await usdc.balanceOf(alice.address)).to.equal(a0);

    // A loss is truncated toward zero, i.e. in the trader's favour, by under 1e-6 USDC.
    await engine.connect(alice).open(BTC, true, 1_000_001n, 1, false, "0x");
    await hold(BTC, px(59_999.4), 1200, BDEPTH, 60);
    const f = await oracle.read(BTC);
    const fill = f.mid < f.slow ? f.mid : f.slow;
    views = await engine.positionsOf(alice.address);
    await engine.connect(alice).close(views[0].id, "0x");
    const charged = a0 - (await usdc.balanceOf(alice.address));
    const exactTimesMillion = (1_000_001n * (px(60_000) - fill) * 1_000_000n) / px(60_000);
    expect(charged * 1_000_000n).to.be.lte(exactTimesMillion);
    expect(exactTimesMillion - charged * 1_000_000n).to.be.lt(1_000_000n);
  });
});

// ==========================================================================================
describe("review-solvency: DEFECT (each test fails until the defect is fixed)", function () {
  this.timeout(1_800_000);

  // ---- 1. poke() before setMarket ---------------------------------------------------------
  it("DEFECT 1: anyone calling poke(id) before the owner lists a market must not keep it out of the vault's books", async () => {
    const ctx = await deploy();
    const { engine, vault, lp, alice, push, hold } = ctx;
    await succeeds(engine.connect(alice).poke(BTC)); // permissionless, before setMarket
    await engine.setMarket(BTC, marketConfig());
    await vault.connect(lp).deposit(usd(5_000_000), lp.address);
    await push(BTC, px(60_000));
    await engine.connect(alice).open(BTC, true, usd(5_000), 1000, false, "0x");
    await hold(BTC, px(60_300), 600, BDEPTH, 60); // +0.5% on 5M: the trader is up about 25,000

    const [pos] = await engine.positionsOf(alice.address);
    const owed = pos.equityAtMid - pos.position.margin;
    const report =
      `marketCount=${await engine.marketCount()}, allMarkets=${(await engine.allMarkets()).length}, ` +
      `trader is owed ${fmtUsd(owed)}, engine.unrealizedPnl()=${fmtUsd(await engine.unrealizedPnl())}, ` +
      `vault.totalAssets()=${fmtUsd(await vault.totalAssets())}`;
    expect(await engine.marketCount(), report).to.equal(1n);
    expect(await engine.unrealizedPnl(), report).to.be.closeTo(owed, usd(1));
    expect(await vault.totalAssets(), report).to.be.closeTo(usd(5_000_000) - owed, usd(1));
  });

  // ---- 2. share price uses uncapped P&L ---------------------------------------------------
  it("DEFECT 2a: after an event resolves, a new depositor must not be able to take LP money by settling positions (deposit, settle, redeem)", async () => {
    // Profit share and hazard off, so the only thing measured is how open positions are marked.
    const ctx = await mixed({ evt: { profitFeeBps: 0 }, lpUsd: 1_000_000 });
    const { engine, vault, usdc, lp, alice, bob, carol, push } = ctx;
    await engine.connect(bob).open(BTC, true, usd(400_000), 2, false, "0x"); // an ordinary 2x long, flat throughout
    await engine.connect(alice).open(EVT, true, usd(40_000), 25, false, "0x"); // 25x YES: can win at most 40,000
    const navBefore = await vault.totalAssets();

    await push(EVT, px(1), EDEPTH, true); // resolves YES
    const navMarked = await vault.totalAssets();
    const navFair = await fairNav(ctx);

    // Carol was not an LP when the market resolved. Three transactions, no price risk.
    const c0 = await usdc.balanceOf(carol.address);
    await vault.connect(carol).deposit(usd(1_000_000), carol.address);
    const [pa] = await engine.positionsOf(alice.address);
    await engine.connect(carol).close(pa.id, "0x"); // anyone may settle after resolution
    await succeeds(vault.connect(carol).redeem(await vault.maxRedeem(carol.address), carol.address, carol.address));
    const gain =
      (await usdc.balanceOf(carol.address)) - c0 + (await vault.convertToAssets(await vault.balanceOf(carol.address)));
    const lpLeft = await vault.convertToAssets(await vault.balanceOf(lp.address));

    const report =
      `LP value before resolution ${fmtUsd(navBefore)}; after resolution the vault marks ${fmtUsd(navMarked)} ` +
      `although the capped liability leaves ${fmtUsd(navFair)}; depositor's gain ${fmtUsd(gain)}; ` +
      `the original LP's 1,000,000 is now worth ${fmtUsd(lpLeft)}`;
    expect(gain, report).to.be.lte(0n);
    expect(navMarked, report).to.be.closeTo(navFair, usd(1));
  });

  it("DEFECT 2b: a position past its profit cap must not let a depositor profit from collecting it (deposit, collect, redeem)", async () => {
    const ctx = await deploy();
    const { engine, vault, usdc, lp, alice, bob, carol, push, hold } = ctx;
    await engine.setMarket(BTC, marketConfig({ profitFeeBps: 0 })); // profit share off: only the marking is measured
    await vault.connect(lp).deposit(usd(5_000_000), lp.address);
    await push(BTC, px(60_000));
    await engine.connect(alice).open(BTC, true, usd(5_000), 1000, false, "0x"); // capped at +50,000 (a 1% move)
    await engine.connect(bob).open(BTC, true, usd(1_000_000), 2, false, "0x"); // 2x, far from any cap
    await hold(BTC, px(61_800), 1200, BDEPTH, 60); // +3%

    const navMarked = await vault.totalAssets();
    const navFair = await fairNav(ctx);
    const c0 = await usdc.balanceOf(carol.address);
    await vault.connect(carol).deposit(usd(5_000_000), carol.address);
    const [pa] = await engine.positionsOf(alice.address);
    await engine.connect(carol).collect(pa.id, "0x"); // permissionless
    await succeeds(vault.connect(carol).redeem(await vault.maxRedeem(carol.address), carol.address, carol.address));
    const cashGain = (await usdc.balanceOf(carol.address)) - c0;
    expect(
      cashGain,
      `vault marks ${fmtUsd(navMarked)}, capped liability leaves ${fmtUsd(navFair)}; ` +
        `depositor walks away with ${fmtUsd(cashGain)} more than she put in, three transactions later`
    ).to.be.lte(0n);
  });

  it("DEFECT 2c: an LP must not be able to leave at a price that ignores a loss the vault will never collect (gap through a 1000x long)", async () => {
    const ctx = await mixed();
    const { engine, vault, usdc, lp, alice, bob, carol, liquidator, push } = ctx;
    await vault.connect(carol).deposit(usd(5_000_000), carol.address); // carol and lp hold half each
    await engine.connect(alice).open(BTC, true, usd(5_000), 1000, false, "0x"); // can lose 5,000 at most
    await engine.connect(bob).open(BTC, false, usd(500_000), 2, false, "0x"); // 2x short

    await push(BTC, px(59_400)); // -1% in one update: alice is 50,000 under water on paper, bob is up 10,000
    const navMarked = await vault.totalAssets();
    const navFair = await fairNav(ctx);
    const c0 = await usdc.balanceOf(carol.address);
    await vault.connect(carol).redeem(await vault.balanceOf(carol.address), carol.address, carol.address);
    const carolGot = (await usdc.balanceOf(carol.address)) - c0;

    const [pa] = await engine.positionsOf(alice.address);
    await push(BTC, px(59_400));
    await engine.connect(liquidator).liquidate(pa.id, "0x");
    const lpLeft = await vault.convertToAssets(await vault.balanceOf(lp.address));
    expect(
      carolGot,
      `vault marks ${fmtUsd(navMarked)}, capped liability leaves ${fmtUsd(navFair)}; ` +
        `the leaving LP is paid ${fmtUsd(carolGot)} for a half share worth ${fmtUsd(navFair / 2n)}; ` +
        `the LP who stayed is left with ${fmtUsd(lpLeft)}`
    ).to.be.lte(navFair / 2n + usd(1));
  });

  it("DEFECT 2d: reserve locked by a flat long+short pair must not turn another position's uncapped P&L into a zero share price (1 USDC buys the pool)", async () => {
    const ctx = await mixed({ evt: { profitFeeBps: 0 }, lpUsd: 1_000_000 });
    const { engine, vault, usdc, lp, alice, carol, push } = ctx;
    await engine.connect(alice).open(EVT, true, usd(40_000), 25, false, "0x"); // 25x YES: can win at most 40,000
    const c0 = await usdc.balanceOf(carol.address);
    // Carol opens a long and a short of the same size. It costs nothing to hold and it locks all the
    // free liquidity as reserve, which is the ceiling the vault applies to what traders are owed.
    await engine.connect(carol).open(BTC, true, usd(48_000), 10, false, "0x");
    await engine.connect(carol).open(BTC, false, usd(48_000), 10, false, "0x");
    expect(await vault.freeLiquidity()).to.equal(0n);

    await push(EVT, px(1), EDEPTH, true); // resolves YES: alice's uncapped P&L is 1,000,000, her cap 40,000
    const navMarked = await vault.totalAssets();
    const navFair = await fairNav(ctx);
    await vault.connect(carol).deposit(usd(1), carol.address);
    const [pa] = await engine.positionsOf(alice.address);
    await engine.connect(carol).close(pa.id, "0x"); // settle alice
    await push(BTC, px(60_000));
    for (const p of await engine.positionsOf(carol.address)) await engine.connect(carol).close(p.id, "0x"); // flat
    await succeeds(vault.connect(carol).redeem(await vault.maxRedeem(carol.address), carol.address, carol.address));
    const gain =
      (await usdc.balanceOf(carol.address)) - c0 + (await vault.convertToAssets(await vault.balanceOf(carol.address)));
    const lpLeft = await vault.convertToAssets(await vault.balanceOf(lp.address));
    expect(
      gain,
      `after resolution the vault marks ${fmtUsd(navMarked)} although the capped liability leaves ${fmtUsd(navFair)}; ` +
        `a 1 USDC deposit ends with ${fmtUsd(gain)} of gain; the LP's 1,000,000 is now worth ${fmtUsd(lpLeft)}`
    ).to.be.lte(0n);
  });

  // ---- 3. shares can be minted and burned around any jump in the share price ---------------
  it("DEFECT 3a: depositing, relaying a newer signed price and redeeming must not pay (the keeper publishes prices before they are on-chain)", async () => {
    const ctx = await mixed();
    const { engine, vault, usdc, oracle, lp, alice, carol, sign } = ctx;
    await engine.connect(alice).open(BTC, true, usd(50_000), 100, false, "0x"); // traders are 5M net long
    // The keeper has signed -5 bps (its relay threshold) and served it over HTTP; it is not on-chain yet.
    const ts = (await time.latest()) + 2;
    const { update, sig } = await sign(BTC, px(59_970), usd(20_000_000), ts);

    const c0 = await usdc.balanceOf(carol.address);
    await vault.connect(carol).deposit(usd(45_000_000), carol.address);
    await time.setNextBlockTimestamp(ts);
    await oracle.connect(carol).push([update], [sig]);
    await succeeds(vault.connect(carol).redeem(await vault.balanceOf(carol.address), carol.address, carol.address));
    const cashGain = (await usdc.balanceOf(carol.address)) - c0;
    const lpGain = (await vault.convertToAssets(await vault.balanceOf(lp.address))) - usd(5_000_000);
    expect(
      cashGain,
      `the price update was worth 2,500 to the vault; the sandwich took ${fmtUsd(cashGain)} of it and left the LP ${fmtUsd(lpGain)}`
    ).to.be.lte(0n);
  });

  it("DEFECT 3b: a trader must not get the Boost premium back by wrapping the close in a vault deposit and redeem", async () => {
    const ctx = await mixed({ evt: { hazardScale: px(1), boostEnabled: true } });
    const { engine, vault, usdc, alice, push } = ctx;
    await engine.connect(alice).open(EVT, true, usd(1_000), 10, true, "0x");
    await time.increase(20 * DAY);
    await push(EVT, px(0.5), EDEPTH); // flat price: the only thing that happened is premium

    const a0 = await usdc.balanceOf(alice.address);
    await vault.connect(alice).deposit(usd(45_000_000), alice.address);
    const [pos] = await engine.positionsOf(alice.address);
    const ev = await closedEvent(engine, engine.connect(alice).close(pos.id, "0x"));
    await succeeds(vault.connect(alice).redeem(await vault.balanceOf(alice.address), alice.address, alice.address));
    const net = (await usdc.balanceOf(alice.address)) - a0;
    expect(
      net - ev.payout,
      `premium charged ${fmtUsd(ev.boostPremium)}; recovered through vault shares in the same three transactions: ${fmtUsd(net - ev.payout)}`
    ).to.be.lte(usd(1));
  });

  // ---- 4. setMarket can change isEvent on a live market ------------------------------------
  it("DEFECT 4: setMarket must not be able to switch isEvent under open positions (or the vault and the shorts must keep working)", async () => {
    const ctx = await mixed();
    const { engine, vault, lp, alice, push } = ctx;
    await engine.connect(alice).open(BTC, false, usd(1_000), 10, false, "0x");
    const [pos] = await engine.positionsOf(alice.address);

    const accepted = await succeeds(engine.setMarket(BTC, { ...ctx.btcConfig, isEvent: true, expiry: ctx.expiry }));
    if (accepted) {
      await push(BTC, px(60_000));
      const navWorks = await succeeds(vault.totalAssets());
      const withdrawWorks = await succeeds(vault.connect(lp).withdraw(usd(1), lp.address, lp.address));
      const closeWorks = await succeeds(engine.connect(alice).close(pos.id, "0x"));
      expect(
        { navWorks, withdrawWorks, closeWorks },
        "the engine accepted isEvent=true on a market with an open short at 60,000"
      ).to.deep.equal({ navWorks: true, withdrawWorks: true, closeWorks: true });
    }
  });

  // ---- 5. nothing accrues for the stretch that ends at resolution ----------------------------
  it("DEFECT 5: the Boost premium for the time before resolution must still be charged when the market resolves", async () => {
    const ctx = await mixed({ evt: { hazardScale: px(1), boostEnabled: true } });
    const { engine, alice, push } = ctx;
    await engine.connect(alice).open(EVT, true, usd(100), 10, true, "0x");
    await time.increase(10 * DAY); // a quiet market: nobody trades, the keeper never calls poke
    await push(EVT, px(0.5), EDEPTH);
    const [before] = await engine.positionsOf(alice.address);
    const pending = before.boostPremium;

    await push(EVT, px(1), EDEPTH, true); // resolution reaches the oracle first, as the keeper sends it
    const ev = await closedEvent(engine, engine.close(before.id, "0x"));
    expect(
      ev.boostPremium,
      `premium due one block before resolution ${fmtUsd(pending)}; charged at settlement ${fmtUsd(ev.boostPremium)}; pays out the full boosted win of ${fmtUsd(ev.pnl)}`
    ).to.be.gte((pending * 9n) / 10n);
  });

  // ---- 6. Staking loses fees to integer division ---------------------------------------------
  it("DEFECT 6: a fee paid to stakers must stay claimable (accPerShare has 18 decimals against an 18-decimal token and 6-decimal USDC)", async () => {
    const ctx = await mixed({ lpUsd: 20_000_000 });
    const { engine, usdc, token, staking, alice, bob, carol, push, hold } = ctx;
    // Alice earns about 990,000 OLQ from one large win (10,000 of fee at the launch rate) and stakes it.
    await engine.connect(alice).open(BTC, true, usd(20_000), 500, false, "0x");
    await hold(BTC, px(61_200), 1200, BDEPTH, 60);
    let [pos] = await engine.positionsOf(alice.address);
    await engine.connect(alice).close(pos.id, "0x");
    const olq = await token.balanceOf(alice.address);
    await token.connect(alice).approve(staking.target, olq);
    await staking.connect(alice).stake(olq);

    // Three ordinary winning trades by Bob, each sending about 0.9 USDC to stakers. After each one
    // somebody touches the staking contract (any stake, unstake or claim does; here a claim by an
    // account with no stake).
    let paid = 0n;
    for (let i = 0; i < 3; i++) {
      await push(BTC, px(61_200));
      await engine.connect(bob).open(BTC, true, usd(100), 100, false, "0x");
      await hold(BTC, px(61_567.2), 900, BDEPTH, 60); // +0.6% on 10,000
      [pos] = await engine.positionsOf(bob.address);
      const s0 = await usdc.balanceOf(staking.target);
      await engine.connect(bob).close(pos.id, "0x");
      paid += (await usdc.balanceOf(staking.target)) - s0;
      await staking.connect(carol).claim();
      await hold(BTC, px(61_200), 900, BDEPTH, 60);
    }
    const claimable = await staking.pending(alice.address);
    expect(
      claimable,
      `${ethers.formatEther(olq)} OLQ staked by the only staker; ${fmtUsd(paid)} USDC of fees arrived; claimable ${fmtUsd(claimable)}`
    ).to.be.gte((paid * 99n) / 100n);
  });
});
