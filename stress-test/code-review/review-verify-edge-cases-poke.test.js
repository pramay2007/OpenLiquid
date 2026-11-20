// Second-reviewer verification of one reported finding (PerpEngine.sol as of 2026-11-19 21:34):
//
//   "poke() on an unconfigured market id permanently keeps that market out of marketIds"
//
// Every "V" test states the INTENDED behaviour and compares a run in which a stranger called
// poke(id) before the owner's setMarket(id) against an otherwise identical run with no poke.
// A V test that fails therefore reproduces the finding; the printed lines give the numbers.
// The "C" tests are controls that hold on the code as reviewed and must keep holding after a fix.
//
// Run only this file:  npx hardhat test test/review-verify-edge-cases-poke.test.js
//
// (Kept under a name of its own: review-verify-edge-cases.test.js holds the verification of a
// different edge-case finding.)

const fs = require("fs");
const path = require("path");
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");
const { deploy, marketConfig, usd, px, fmtUsd } = require("./helpers");

const NEW = 7; // an id the fixture has not configured
const P0 = px(60_000);
const DAY = 86_400;
const DEPTH = usd(20_000_000);
const round = (v) => Math.round(fmtUsd(v));
const note = (...a) => console.log("        ", ...a);

/** List market NEW (optionally after a stranger's poke), fund the vault, put one trader +5,000 at the mid. */
async function listAndTrade({ pokeFirst, feedFirst = false }) {
  const ctx = await deploy();
  const { engine, oracle, vault, lp, alice, bob, push } = ctx;
  if (feedFirst) await push(NEW, P0); // the keeper may already be signing this id
  let pokeGas = null;
  if (pokeFirst) pokeGas = (await (await engine.connect(bob).poke(NEW)).wait()).gasUsed; // bob is not the owner
  const stamp = (await engine.states(NEW)).lastAccrual;
  await oracle.setTau(NEW, 60);
  await engine.setMarket(NEW, marketConfig()); // the owner's listing transaction
  await vault.connect(lp).deposit(usd(5_000_000), lp.address);
  await push(NEW, P0);
  await engine.connect(alice).open(NEW, true, usd(10_000), 1000, false, "0x");
  await push(NEW, px(60_030)); // 10,000,000 notional, +0.05%
  const [pos] = await engine.positionsOf(alice.address);
  return { ...ctx, pokeGas, stamp, pos };
}

async function books({ engine, vault, pos }) {
  return {
    enabled: (await engine.markets(NEW)).enabled,
    marketCount: Number(await engine.marketCount()),
    allMarkets: Array.from(await engine.allMarkets(), (v) => Number(v.marketId)),
    traderPnlAtMid: round(pos.equityAtMid - pos.position.margin),
    unrealizedPnl: round(await engine.unrealizedPnl()),
    lpNav: round(await vault.totalAssets()),
  };
}

const LISTED_AND_MARKED = {
  enabled: true,
  marketCount: 1,
  allMarkets: [NEW],
  traderPnlAtMid: 5_000,
  unrealizedPnl: 5_000,
  lpNav: 4_995_000,
};

describe("Verify: poke() on an id the owner has not configured yet", function () {
  this.timeout(300_000);

  it("C1 control: with no poke the market is listed and the vault marks the open position (R11)", async () => {
    const seen = await books(await listAndTrade({ pokeFirst: false }));
    note("no poke:", JSON.stringify(seen));
    expect(seen).to.deep.equal(LISTED_AND_MARKED);
  });

  it("C2 control: poke() on a listed market brings the crowding index up to date", async () => {
    const { engine, oracle, vault, lp, alice, bob, push } = await deploy();
    await oracle.setTau(NEW, 60);
    await engine.setMarket(NEW, marketConfig({ crowdingPerDay: px(0.0005) }));
    await vault.connect(lp).deposit(usd(5_000_000), lp.address);
    await push(NEW, P0);
    await engine.connect(alice).open(NEW, true, usd(10_000), 100, false, "0x"); // skew 1M / 10M capacity
    await time.increase(DAY - 1);
    await engine.connect(bob).poke(NEW); // exactly one day after the open
    const s = await engine.states(NEW);
    expect(s.lastAccrual).to.equal(BigInt(await time.latest()));
    expect(s.cumFeeLong).to.equal(px(0.00005)); // 0.0005 per day * skew 0.1
    expect(s.cumFeeShort).to.equal(0n);
  });

  it("V1 a stranger's poke(id) before setMarket(id) leaves the market listed and marked", async () => {
    const attackedCtx = await listAndTrade({ pokeFirst: true });
    const attacked = await books(attackedCtx);
    note("poke, then setMarket:", JSON.stringify(attacked));
    note(`the poke cost ${attackedCtx.pokeGas} gas and left states[${NEW}].lastAccrual = ${attackedCtx.stamp}`);
    expect(attacked).to.deep.equal(LISTED_AND_MARKED);
  });

  it("V1b the same when the keeper is already signing a price for that id", async () => {
    const attacked = await books(await listAndTrade({ pokeFirst: true, feedFirst: true }));
    note("feed, poke, then setMarket:", JSON.stringify(attacked));
    expect(attacked).to.deep.equal(LISTED_AND_MARKED);
  });

  it("V2 a poked id is listed exactly once, however often the owner sets it", async () => {
    const { engine, oracle, vault, token, owner, bob } = await deploy();
    await engine.connect(bob).poke(NEW);
    await oracle.setTau(NEW, 60);
    const counts = [];
    await engine.setMarket(NEW, marketConfig());
    counts.push(Number(await engine.marketCount()));
    await engine.setMarket(NEW, marketConfig()); // set it again
    counts.push(Number(await engine.marketCount()));
    await engine.setMarket(NEW, marketConfig({ enabled: false })); // disable, then enable
    await engine.setMarket(NEW, marketConfig());
    counts.push(Number(await engine.marketCount()));
    note("marketCount after first setMarket, second setMarket, disable + enable:", JSON.stringify(counts));

    // No way round it either: a replacement engine cannot be attached to the vault or the token.
    const fresh = await (await ethers.getContractFactory("PerpEngine")).deploy(
      oracle.target,
      vault.target,
      token.target,
      await engine.staking(),
      owner.address
    );
    await expect(vault.setEngine(fresh.target)).to.be.revertedWithCustomError(vault, "EngineAlreadySet");
    await expect(token.setMinter(fresh.target)).to.be.revertedWithCustomError(token, "MinterAlreadySet");

    expect(counts).to.deep.equal([1, 1, 1]);
  });

  it("V3 the scripts/deploy.js sequence lists all of markets.json when every id is poked in the window", async () => {
    const file = JSON.parse(fs.readFileSync(path.join(__dirname, "../../markets.json"), "utf8"));
    const all = [...file.markets, ...file.events];
    const run = async (poke) => {
      // deploy() has sent what deploy.js sends before its market loop: the six deployments,
      // setEngine, setMinter and setSigner. The stranger's transactions land here.
      const { engine, oracle, carol } = await deploy();
      if (poke) for (const m of all) await engine.connect(carol).poke(m.id);
      for (const m of all) {
        const event = m.kind === "event";
        await oracle.setTau(m.id, event ? 300 : 60);
        await engine.setMarket(
          m.id,
          marketConfig(
            event
              ? {
                  isEvent: true,
                  boostEnabled: !m.early,
                  maxLeverage: 50,
                  profitFeeBps: 1000,
                  maxGapBps: 500,
                  reactionSeconds: 120,
                  expiry: m.expiry,
                  maxPositionNotional: usd(100_000),
                  hazardScale: px(1),
                }
              : { maxGapBps: 20, crowdingPerDay: px(0.0005) }
          )
        );
      }
      let enabled = 0;
      for (const m of all) if ((await engine.markets(m.id)).enabled) enabled++;
      return {
        inMarketsJson: all.length,
        enabledOnChain: enabled,
        marketCount: Number(await engine.marketCount()),
        allMarkets: (await engine.allMarkets()).length,
      };
    };
    const control = await run(false);
    const attacked = await run(true);
    note("no poke          :", JSON.stringify(control));
    note("16 pokes, then it:", JSON.stringify(attacked));
    expect(control).to.deep.equal({ inMarketsJson: 16, enabledOnChain: 16, marketCount: 16, allMarkets: 16 });
    expect(attacked).to.deep.equal(control);
  });

  it("V4 R11: an LP who leaves while a trader is winning carries their share of what the trader is owed", async () => {
    const run = async (pokeFirst) => {
      const { engine, oracle, vault, usdc, lp, carol, alice, bob, push } = await deploy();
      if (pokeFirst) await engine.connect(bob).poke(NEW);
      await oracle.setTau(NEW, 60);
      await engine.setMarket(NEW, marketConfig());
      await vault.connect(lp).deposit(usd(2_500_000), lp.address);
      await vault.connect(carol).deposit(usd(2_500_000), carol.address);
      await push(NEW, P0);
      await engine.connect(alice).open(NEW, true, usd(10_000), 1000, false, "0x");
      await push(NEW, px(60_030)); // alice is owed 5,000 at the mid
      const before = await usdc.balanceOf(lp.address);
      await vault.connect(lp).redeem(await vault.balanceOf(lp.address), lp.address, lp.address);
      const lpTookOut = (await usdc.balanceOf(lp.address)) - before;
      // What is left for the LP who stayed, once alice's 5,000 is paid.
      const leftForCarol = (await vault.cash()) - (await vault.marginHeld()) - usd(5_000);
      return { lpTookOut: round(lpTookOut), leftForCarol: round(leftForCarol) };
    };
    const control = await run(false);
    const attacked = await run(true);
    note("no poke             :", JSON.stringify(control));
    note("poke, then setMarket:", JSON.stringify(attacked));
    expect(control).to.deep.equal({ lpTookOut: 2_497_500, leftForCarol: 2_497_500 });
    expect(attacked).to.deep.equal(control);
  });

  it("V5 R11: a deposit wrapped around the close of a losing leg earns nothing from that close", async () => {
    const run = async (pokeFirst) => {
      const { engine, oracle, vault, usdc, lp, bob, push, hold } = await deploy();
      if (pokeFirst) await engine.connect(bob).poke(NEW); // bob does everything below, too
      await oracle.setTau(NEW, 60);
      await engine.setMarket(NEW, marketConfig({ maxGapBps: 20, crowdingPerDay: px(0.0005) })); // deploy.js "crypto"
      await vault.connect(lp).deposit(usd(1_000_000), lp.address); // the LP whose money is at stake
      await push(NEW, P0);
      const start = await usdc.balanceOf(bob.address);

      // A hedged pair, 10,000 margin a side at 100x: no exposure to where the price goes.
      await engine.connect(bob).open(NEW, true, usd(10_000), 100, false, "0x");
      await engine.connect(bob).open(NEW, false, usd(10_000), 100, false, "0x");
      const views = await engine.positionsOf(bob.address);
      const long = views.find((v) => v.position.isLong).id;
      const short = views.find((v) => !v.position.isLong).id;
      await hold(NEW, px(60_300), 600, DEPTH, 10); // +0.5%, held for ten averaging times

      await vault.connect(bob).deposit(usd(19_000_000), bob.address);
      await engine.connect(bob).close(short, "0x"); // the losing leg leaves 5,000 in the vault
      await vault.connect(bob).redeem(await vault.balanceOf(bob.address), bob.address, bob.address);
      await engine.connect(bob).close(long, "0x"); // the winning leg is paid in full

      return {
        hedgedTraderNet: round((await usdc.balanceOf(bob.address)) - start),
        lpNet: round((await vault.totalAssets()) - usd(1_000_000)),
        openPositions: Number(await engine.openPositionCount()),
      };
    };
    const control = await run(false);
    const attacked = await run(true);
    note("no poke             :", JSON.stringify(control));
    note("poke, then setMarket:", JSON.stringify(attacked));
    // Listed market: the pair costs its owner the 5% profit share on the winning leg, which the LP keeps.
    expect(control).to.deep.equal({ hedgedTraderNet: -250, lpNet: 250, openPositions: 0 });
    expect(attacked).to.deep.equal(control);
  });

  it("V6 an id poked three months before its listing is still listed when the owner adds it", async () => {
    const { engine, oracle, bob } = await deploy();
    for (const id of [106, 107, 4_294_967_295]) await engine.connect(bob).poke(id);
    await time.increase(90 * DAY);
    await oracle.setTau(106, 300);
    await engine.setMarket(
      106,
      marketConfig({ isEvent: true, maxLeverage: 50, expiry: (await time.latest()) + 30 * DAY })
    );
    const seen = {
      enabled: (await engine.markets(106)).enabled,
      marketCount: Number(await engine.marketCount()),
    };
    note("poked 90 days earlier, then setMarket(106):", JSON.stringify(seen));
    expect(seen).to.deep.equal({ enabled: true, marketCount: 1 });
  });
});
