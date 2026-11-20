// Second-reviewer verification of one reported finding (PerpEngine.sol as of 2026-11-19 21:34,
// keeper/src/index.js as of 21:27):
//
//   "forceClose fills at the lagging worse-of price at a moment the caller picks; right after a
//    favourable jump it takes the win away, and the keeper does it automatically"
//
// Every "V" test states the INTENDED behaviour (R6: a position above the time-based limit "can be
// force-closed by anyone at the normal close fill, no penalty"). A V test that passes refutes the
// finding; one that fails reproduces it, and the printed lines give the numbers. Each is written
// to pass however the behaviour is fixed: a forced close that is refused while the two prices are
// apart, or one that pays what the position is worth.
// The "C" tests are controls that hold on the code as reviewed and must keep holding after a fix.
//
// On the code as reviewed V1-V6 fail and C1-C2 pass: the owner of a 15x YES receives 103.59 where
// 189.21 (free) or 999.21 (boosted) was due, the keeper's sweep sends that forceClose one second
// after the jump, a stranger with capital takes 86.77 / 896.81 of it in one block, and at the
// leverage limit a single tick in the owner's favour pays 100.12 where the mid says 136.
//
// (review-verify-edge-cases.test.js belongs to the verification of a different finding, so this
// one has its own file.)
//
// Run only this file:  npx hardhat test test/review-verify-edge-cases-forceclose.test.js

const { expect } = require("chai");
const { ethers, network } = require("hardhat");
const { time, mine, takeSnapshot } = require("@nomicfoundation/hardhat-network-helpers");
const { deploy, marketConfig, usd, px, EVT } = require("./helpers");

const DAY = 86_400;
const DEPTH = usd(2_000_000);
const JUMP = 0.9;
const f6 = (v) => Number(ethers.formatUnits(v, 6));
const f18 = (v) => Number(ethers.formatUnits(v, 18));
const note = (...a) => console.log("        ", ...a);
const PRICE_DATA = [
  "tuple(uint32 marketId,uint256 price,uint256 depthUsd,uint64 timestamp,bool resolved)[]",
  "bytes[]",
];
const encode = (s) => ethers.AbiCoder.defaultAbiCoder().encode(PRICE_DATA, [[s.update], [s.sig]]);

/**
 * An event market as scripts/deploy.js lists every event off localhost (KINDS.event, maxAge 20,
 * Boost on) with the oracle's 300 s averaging time (helpers.js), five days and ten minutes from
 * expiry, so that the limit at 0.50 is the 20x of the whitepaper's table.
 */
async function eventSetup(secondsOut = 5 * DAY + 600) {
  const ctx = await deploy();
  ctx.expiry = (await time.latest()) + secondsOut;
  await ctx.engine.setMarket(
    EVT,
    marketConfig({
      isEvent: true,
      boostEnabled: true,
      maxLeverage: 50,
      maxProfitMult: 10,
      profitFeeBps: 1000,
      kappaBps: 5000,
      maxGapBps: 500,
      maxAge: 20,
      reactionSeconds: 120,
      expiry: ctx.expiry,
      maxPositionNotional: usd(100_000),
      hazardScale: px(1),
    })
  );
  await ctx.vault.connect(ctx.lp).deposit(usd(2_000_000), ctx.lp.address);
  await ctx.push(EVT, px(0.5), DEPTH);
  return ctx;
}

/** Stamp the next block one second after the last, whatever the wall clock did in between. */
const oneSecondOn = async () => time.setNextBlockTimestamp((await time.latest()) + 1);

/** Alice opens a YES (or a NO) with 100 margin at 0.50, then ONE signed update moves the mid to `to`. */
async function openThenMove(ctx, { leverage = 15, boost = false, to = JUMP, yes = true } = {}) {
  const { engine, usdc, alice, push } = ctx;
  const limit = Number((await engine.marketView(EVT)).maxLeverageLong);
  await oneSecondOn();
  await engine.connect(alice).open(EVT, yes, usd(100), leverage, boost, "0x");
  const [pos] = await engine.positionsOf(alice.address);
  const before = await usdc.balanceOf(alice.address); // the margin has left her wallet
  const movedAt = await push(EVT, px(to), DEPTH);
  return {
    id: pos.id,
    limit,
    movedAt,
    received: async () => f6((await usdc.balanceOf(alice.address)) - before),
    isOpen: async () => (await engine.positionsOf(alice.address)).length > 0,
  };
}

/** The price stays where it is for `seconds`, sampled every 15 s, and then the owner closes. */
async function holdThenOwnerCloses(ctx, id, price, seconds = 1500) {
  await ctx.hold(EVT, px(price), seconds, DEPTH, 15);
  await oneSecondOn();
  await ctx.engine.connect(ctx.alice).close(id, "0x");
}

/**
 * Send the call `fn(...args)` in the block stamped `at` if the engine would carry it out, as a
 * caller who estimates gas first does; otherwise let that block pass empty. (Hardhat's in-process
 * network mines a reverting transaction, which would otherwise move the clock twice. It also runs
 * a static call at the latest block's time, so the chain is first brought to the second before.)
 */
async function sendIfAccepted(fn, args, at) {
  if ((await time.latest()) < at - 1) await time.increaseTo(at - 1);
  await time.setNextBlockTimestamp(at);
  try {
    await fn.staticCall(...args);
  } catch {
    await mine();
    return false;
  }
  await fn(...args);
  return true;
}

/** A stranger calls forceClose in the block after the move. True if the engine carried it out. */
const strangerForces = (ctx, pos) =>
  sendIfAccepted(ctx.engine.connect(ctx.bob).forceClose, [pos.id, "0x"], pos.movedAt + 1);

/** R6's time limit, min(p,1-p) / (3 sqrt(p(1-p) h / tau)), as _timeLeverage floors it. */
const timeLimit = (p, secondsLeft, h = 120) =>
  Math.max(1, Math.floor(Math.min(p, 1 - p) / (3 * Math.sqrt((p * (1 - p) * h) / secondsLeft))));

// keeper/src/index.js actionFor(), copied line for line apart from the resolved branch: what the
// sweep sends for a position, from the engine's own view and the live reference mid.
function actionFor(p, liveMid) {
  const liq = f18(p.liquidationPrice);
  if (p.liquidatable || (p.position.isLong ? liveMid <= liq : liveMid >= liq)) return "liquidate";
  if (p.collectable) return "collect";
  if (p.forceClosable) return "forceClose";
  return null;
}

/**
 * One keeper sweep in the block stamped `at`, as sweep() does it: the freshest signed price is
 * attached, and a call the engine refuses is found out in estimateGas and never sent.
 */
async function keeperSweep(ctx, id, liveMid, at) {
  const action = actionFor(await ctx.engine.positionView(id), liveMid);
  if (!action) {
    await time.setNextBlockTimestamp(at);
    await mine();
    return null;
  }
  const live = await ctx.sign(EVT, px(liveMid), DEPTH, at);
  return (await sendIfAccepted(ctx.engine.connect(ctx.keeper)[action], [id, encode(live)], at)) ? action : null;
}

describe("Verify: forceClose() in the blocks after a move in the owner's favour", function () {
  this.timeout(600_000);

  for (const boost of [false, true]) {
    const mode = boost ? "boosted" : "free";

    it(`V${boost ? 2 : 1} ${mode} 15x YES, mid 0.50 -> 0.90 in one update: a stranger's forceClose does not cost the owner the win`, async () => {
      const ctx = await eventSetup();
      const { engine, alice, carol } = ctx;
      const pos = await openThenMove(ctx, { boost });
      const v = await engine.positionView(pos.id);
      const secondsLeft = ctx.expiry - pos.movedAt;
      note(
        `limit at open ${pos.limit}x; after the jump the time limit is ${timeLimit(JUMP, secondsLeft)}x. ` +
          `View: forceClosable=${v.forceClosable} collectable=${v.collectable} liquidatable=${v.liquidatable} ` +
          `closeFill=${f18(v.markPrice).toFixed(4)} winPrice=${f18(v.winPrice).toFixed(4)} ` +
          `equityAtMid=${f6(v.equityAtMid).toFixed(2)} reserve=${f6(v.position.reserve)}`
      );
      // The setting the finding describes. None of this depends on how forceClose behaves.
      expect(pos.limit).to.equal(20);
      expect(timeLimit(JUMP, secondsLeft)).to.equal(6);
      expect(v.collectable).to.equal(false);
      expect(v.liquidatable).to.equal(false);
      expect(f18(v.markPrice)).to.be.lessThan(0.502);
      // R2: with mid and slow 40 points apart nobody may open (the bound is 5 points).
      await expect(
        engine.connect(carol).open.staticCall(EVT, true, usd(10), 1, false, "0x")
      ).to.be.revertedWithCustomError(engine, "PriceDislocated");

      const afterMove = await takeSnapshot();

      // (a) Nobody interferes. The price stays at 0.90 and the owner closes 25 minutes later.
      await holdThenOwnerCloses(ctx, pos.id, JUMP);
      const leftAlone = await pos.received();
      await afterMove.restore();

      // (b) The owner closes in the next block of her own accord: the normal close fill, right now.
      await time.setNextBlockTimestamp(pos.movedAt + 1);
      await engine.connect(alice).close(pos.id, "0x");
      const ownCloseNow = await pos.received();
      await afterMove.restore();

      // (c) A stranger calls forceClose in the next block. If the engine refuses, (a) follows.
      const executed = await strangerForces(ctx, pos);
      if (await pos.isOpen()) await holdThenOwnerCloses(ctx, pos.id, JUMP);
      const forced = await pos.received();

      note(
        `${mode}: owner receives ${leftAlone.toFixed(2)} if left alone | ${ownCloseNow.toFixed(2)} if she chose to close in the next block | ` +
          `${forced.toFixed(2)} after a stranger's forceClose in the next block (${executed ? "executed" : "refused"})`
      );
      expect(forced, `${mode}: owner's payout, stranger's forceClose vs left alone`).to.be.closeTo(leftAlone, boost ? 10 : 2);
    });
  }

  it("V3 the keeper's own sweep (actionFor, copied) does not close the winner at the pre-jump price", async () => {
    const seen = {};
    for (const boost of [false, true]) {
      const ctx = await eventSetup();
      // An event market's move is relayed in the tick it is seen (eventMoved), which is the push here.
      const pos = await openThenMove(ctx, { boost });
      const afterMove = await takeSnapshot();
      await holdThenOwnerCloses(ctx, pos.id, JUMP);
      const leftAlone = await pos.received();
      await afterMove.restore();

      // Sweep in the tick that relayed the move, then every third one-second tick (SWEEP_EVERY_TICKS).
      const did = [];
      let at = pos.movedAt;
      for (let n = 0; n < 400 && (await pos.isOpen()); n++) {
        at += n === 0 ? 1 : 3;
        const action = await keeperSweep(ctx, pos.id, JUMP, at);
        if (action) did.push(`${action} ${at - pos.movedAt} s after the jump`);
      }
      if (await pos.isOpen()) await holdThenOwnerCloses(ctx, pos.id, JUMP, 15);
      const withKeeper = await pos.received();
      note(
        `${boost ? "boosted" : "free"}: keeper sent [${did.join(", ") || "nothing"}]; owner receives ${withKeeper.toFixed(2)} ` +
          `with the keeper running, ${leftAlone.toFixed(2)} if left alone`
      );
      seen[boost ? "boosted" : "free"] = { withKeeper, leftAlone };
    }
    expect(seen.free.withKeeper, "free: payout with the keeper running").to.be.greaterThan(seen.free.leftAlone - 2);
    expect(seen.boosted.withKeeper, "boosted: payout with the keeper running").to.be.greaterThan(
      seen.boosted.leftAlone - 10
    );
  });

  it("V4 a stranger with capital is not paid for it (deposit, forceClose, redeem in one block)", async () => {
    const gains = {};
    for (const boost of [false, true]) {
      const ctx = await eventSetup();
      const { engine, vault, usdc, bob } = ctx;
      const pos = await openThenMove(ctx, { boost });
      const before = await usdc.balanceOf(bob.address);
      const amount = usd(18_000_000); // nine times the vault
      const shares = await vault.previewDeposit(amount);
      await network.provider.send("evm_setAutomine", [false]);
      try {
        const o = { gasLimit: 2_000_000 };
        await vault.connect(bob).deposit(amount, bob.address, o);
        await engine.connect(bob).forceClose(pos.id, "0x", o);
        await vault.connect(bob).redeem(shares, bob.address, bob.address, o);
        await time.setNextBlockTimestamp(pos.movedAt + 1);
        await network.provider.send("evm_mine");
      } finally {
        await network.provider.send("evm_setAutomine", [true]);
      }
      expect((await ethers.provider.getBlock("latest")).transactions.length).to.equal(3);
      gains[boost ? "boosted" : "free"] = f6((await usdc.balanceOf(bob.address)) - before);
    }
    note(
      `stranger's gain from one block of deposit + forceClose + redeem: ${gains.free.toFixed(2)} against the free position, ` +
        `${gains.boosted.toFixed(2)} against the boosted one`
    );
    expect(gains.free, "gain against the free position").to.be.lessThanOrEqual(1);
    expect(gains.boosted, "gain against the boosted position").to.be.lessThanOrEqual(1);
  });

  it("V5 at the leverage limit, one tick in the owner's favour is not forfeited to a forced close", async () => {
    const run = async (to, yes = true) => {
      const ctx = await eventSetup();
      const pos = await openThenMove(ctx, { leverage: 20, to, yes });
      const v = await ctx.engine.positionView(pos.id);
      const result = f6(v.equityAtMid) - 100;
      // What the position is worth at the mid: its equity, less the 10% share of any profit.
      const worthAtMid = 100 + (result > 0 ? result * 0.9 : result);
      const executed = await strangerForces(ctx, pos);
      return {
        limitAtOpen: pos.limit,
        limitNow: timeLimit(to, ctx.expiry - pos.movedAt),
        forceClosable: v.forceClosable,
        closeFill: f18(v.markPrice),
        worthAtMid,
        executed,
        got: executed ? await pos.received() : null,
      };
    };
    const up = await run(0.51);
    const down = await run(0.49);
    const noDown = await run(0.49, false);
    const noUp = await run(0.51, false);
    note("20x YES at the 20x limit, one tick up   (0.51):", JSON.stringify(up));
    note("20x YES at the 20x limit, one tick down (0.49):", JSON.stringify(down));
    note("20x NO  at the 20x limit, one tick down (0.49):", JSON.stringify(noDown));
    note("20x NO  at the 20x limit, one tick up   (0.51):", JSON.stringify(noUp));
    expect(up.limitAtOpen).to.equal(20);
    expect(up.limitNow).to.equal(19);
    // A tick against the owner, if force-closed, pays the mid value and no less.
    if (down.executed) expect(down.got).to.be.closeTo(down.worthAtMid, 0.01);
    if (noUp.executed) expect(noUp.got).to.be.closeTo(noUp.worthAtMid, 0.01);
    // A tick in the owner's favour: the same.
    if (up.executed) expect(up.got, "YES: payout after the forced close vs the position's value at the mid").to.be.closeTo(up.worthAtMid, 2);
    if (noDown.executed) expect(noDown.got, "NO: payout after the forced close vs the position's value at the mid").to.be.closeTo(noDown.worthAtMid, 2);
  });

  it("V6 whichever moment in the 40 minutes after that tick the caller picks, a forced close pays the mid value to within 1% of margin", async () => {
    const ctx = await eventSetup();
    const { engine, bob, sign } = ctx;
    const pos = await openThenMove(ctx, { leverage: 20, to: 0.51 }); // worth 2,000 * 0.01 / 0.50 = 40 at the mid
    const afterMove = await takeSnapshot();
    const seconds = [1, 2, 3, 5, 10, 20, 30, 45];
    for (let s = 60; s <= 2400; s += 60) seconds.push(s);

    let firstAccepted = null;
    let worst = { shortfall: -Infinity };
    for (const s of seconds) {
      await afterMove.restore();
      // The mid has not moved since the tick; the caller attaches the keeper's latest signed price.
      const live = await sign(EVT, px(0.51), DEPTH, pos.movedAt + s);
      const accepted = await sendIfAccepted(engine.connect(bob).forceClose, [pos.id, encode(live)], pos.movedAt + s);
      if (!accepted) continue;
      const [closed] = await engine.queryFilter(engine.filters.PositionClosed(pos.id), "latest");
      const atMid = 100 + (40 - f6(closed.args.crowdingFee)) * 0.9; // less the crowding fee and the 10% share
      const shortfall = atMid - (await pos.received());
      firstAccepted ??= s;
      if (shortfall > worst.shortfall) worst = { secondsAfterTheTick: s, closeFill: f18(closed.args.exitPrice), shortfall };
    }
    note(
      firstAccepted === null
        ? "no forced close was accepted in the 40 minutes after the tick"
        : `first accepted ${firstAccepted} s after the tick; largest shortfall against the mid value: ${JSON.stringify(worst)}`
    );
    expect(firstAccepted, "the price is settled long before 40 minutes are up, so the forced close does go through").to.not.equal(null);
    expect(worst.shortfall, "owner's shortfall against the mid value, at the worst moment").to.be.lessThanOrEqual(1);
  });

  it("C1 control: at a settled price a position above the limit is force-closed for exactly its margin", async () => {
    const ctx = await eventSetup();
    const { engine, usdc, alice, bob, push, expiry } = ctx;
    await oneSecondOn();
    await engine.connect(alice).open(EVT, true, usd(100), 15, false, "0x");
    const [pos] = await engine.positionsOf(alice.address);
    const before = await usdc.balanceOf(alice.address);
    await expect(engine.connect(bob).forceClose.staticCall(pos.id, "0x")).to.be.revertedWithCustomError(
      engine,
      "NotForceClosable"
    );

    await time.increaseTo(expiry - 2 * DAY); // two days out the limit at 0.50 is 12x
    await push(EVT, px(0.5), DEPTH);
    expect((await engine.positionView(pos.id)).forceClosable).to.equal(true);
    await oneSecondOn();
    await engine.connect(bob).forceClose(pos.id, "0x");
    expect((await usdc.balanceOf(alice.address)) - before).to.equal(usd(100));
  });

  it("C2 control: once the slow price has caught up with a move, the forced close goes through and pays the mid value", async () => {
    const ctx = await eventSetup();
    const { engine, alice, bob, hold } = ctx;
    // 20x at the limit; 0.52 is short of the 0.525 win line and lowers the limit to 19x.
    const pos = await openThenMove(ctx, { leverage: 20, to: 0.52 });
    await hold(EVT, px(0.52), 3000, DEPTH, 15); // ten averaging times
    const v = await engine.positionView(pos.id);
    expect(v.forceClosable).to.equal(true);
    expect(v.collectable).to.equal(false);
    expect(0.52 - f18(v.markPrice)).to.be.lessThan(0.00001);
    const at = (await time.latest()) + 1;
    const settled = await takeSnapshot();

    await time.setNextBlockTimestamp(at);
    await engine.connect(alice).close(pos.id, "0x");
    const ownClose = await pos.received();
    await settled.restore();

    await time.setNextBlockTimestamp(at);
    await engine.connect(bob).forceClose(pos.id, "0x");
    const forced = await pos.received();
    // 2,000 * 0.02 / 0.50 = 80 at the mid, less the crowding fee accrued so far, less the 10% share.
    const worthAtMid = 100 + (80 - f6(v.crowdingFee)) * 0.9;
    note(`settled at 0.52: forced close pays ${forced}, the owner's own close ${ownClose}, value at the mid ${worthAtMid.toFixed(2)}`);
    expect(forced).to.equal(ownClose);
    expect(forced).to.be.closeTo(worthAtMid, 1);
  });
});
