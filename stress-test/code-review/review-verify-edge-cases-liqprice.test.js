// Second-reviewer verification of the edge-case finding
//   "positionView.liquidationPrice returns the entry price once the premium has used up the
//    buffer, while the position is liquidatable beyond entry"   (PerpEngine._liquidationPrice, l.727-738)
//
// Part 1 runs the contracts exactly as they are (PerpEngine.sol 2026-11-19 21:34, md5 3e62568f...).
// Every test PASSES when the claim reproduces: the assertions pin the claimed numbers.
//
// Part 2 checks the recommended fix. Nothing under contracts/src is touched: the candidate is the
// text of src/PerpEngine.sol with one edit applied (FIX below), compiled in memory with the
// project's own solc through Hardhat's compile subtasks, and installed at the fixture's engine
// address before first use. The constructor arguments are the same, so the immutables are the
// same, and the edit is inside one view helper, so the storage layout is the same.
//
// Run only this file:  npx hardhat test test/review-verify-edge-cases-liqprice.test.js

const { expect } = require("chai");
const hre = require("hardhat");
const { ethers, network } = hre;
const { time, takeSnapshot } = require("@nomicfoundation/hardhat-network-helpers");
const fs = require("fs");
const path = require("path");
const { deploy, marketConfig, usd, px, BTC, EVT } = require("./helpers");

const DAY = 86_400;
const DEPTH = usd(2_000_000);
const LIQUIDATION = 1n; // PerpEngine.CloseKind
const f6 = (v) => Number(ethers.formatUnits(v, 6));
const f18 = (v) => Number(ethers.formatUnits(v, 18));
const note = (...a) => console.log("        ", ...a);
const coder = ethers.AbiCoder.defaultAbiCoder();
const PRICE_DATA = ["tuple(uint32 marketId,uint256 price,uint256 depthUsd,uint64 timestamp,bool resolved)[]", "bytes[]"];

// ---- the recommended fix, as an edit to the source under review ---------------------------------

const ROOT = path.join(__dirname, "..");
const ENGINE = "src/PerpEngine.sol";
const SRC = fs.readFileSync(path.join(ROOT, ENGINE), "utf8");

const AS_REVIEWED = "        if (buffer <= 0) return p.entryPrice;\n";
const FIX = [
  "        if (buffer <= 0) {",
  "            // The premium has used up the buffer, so the line is on the winning side of entry: the",
  "            // position is liquidatable until its gain exceeds the shortfall. The gain stops at the",
  "            // reserve, so the line stops at the win price.",
  "            uint256 need = uint256(-buffer) < p.reserve ? uint256(-buffer) : p.reserve;",
  "            if (need == 0) return p.entryPrice;",
  "            uint256 gain = (need * WAD) / p.notional;",
  "            if (p.isLong) return p.entryPrice + (p.entryPrice * gain) / WAD;",
  "            uint256 drop = ((isEvent ? WAD - p.entryPrice : p.entryPrice) * gain) / WAD;",
  "            return drop >= p.entryPrice ? 0 : p.entryPrice - drop;",
  "        }",
  "",
].join("\n");

function edit(src, from, to) {
  const parts = src.split(from);
  if (parts.length !== 2) throw new Error(`expected exactly one "${from.trim()}", found ${parts.length - 1}`);
  return parts.join(to);
}

/** Compile PerpEngine from `source` with the project's compiler and settings. Writes nothing to disk. */
async function compileEngine(source) {
  const sources = {};
  const add = (name, content) => {
    if (sources[name]) return;
    if (content === undefined) {
      const file = path.join(ROOT, name.startsWith("src/") ? "" : "node_modules", name);
      if (!fs.existsSync(file)) return; // an import quoted in a comment
      content = fs.readFileSync(file, "utf8");
    }
    sources[name] = { content };
    for (const m of content.matchAll(/^\s*import\s[^"';]*["']([^"']+)["']\s*;/gm)) {
      add(m[1].startsWith(".") ? path.posix.join(path.posix.dirname(name), m[1]) : m[1]);
    }
  };
  add(ENGINE, source);
  const compiler = hre.config.solidity.compilers[0];
  const input = {
    language: "Solidity",
    sources,
    settings: {
      ...compiler.settings,
      outputSelection: { [ENGINE]: { PerpEngine: ["abi", "evm.bytecode.object", "evm.deployedBytecode.object"] } },
    },
  };
  const build = await hre.run("compile:solidity:solc:get-build", { quiet: true, solcVersion: compiler.version });
  const out = build.isSolcJs
    ? await hre.run("compile:solidity:solcjs:run", { input, solcJsPath: build.compilerPath })
    : await hre.run("compile:solidity:solc:run", { input, solcPath: build.compilerPath });
  const errors = (out.errors || []).filter((e) => e.severity === "error");
  if (errors.length) throw new Error(errors.map((e) => e.formattedMessage).join("\n"));
  return out.contracts[ENGINE].PerpEngine;
}

let fixedEngine; // the build with FIX applied, set in Part 2's before()

/** Runtime code of the fixed engine with this fixture's immutables. */
async function fixedRuntime(ctx) {
  const factory = new ethers.ContractFactory(fixedEngine.abi, "0x" + fixedEngine.evm.bytecode.object, ctx.owner);
  const twin = await factory.deploy(ctx.oracle.target, ctx.vault.target, ctx.token.target, ctx.staking.target, ctx.owner.address);
  await twin.waitForDeployment();
  return ethers.provider.getCode(twin.target);
}

// ---- the venue, from helpers.js -----------------------------------------------------------------

/** A signed price stamped `ts`, as the keeper holds it: not on-chain until someone relays it. */
async function signedPrice(ctx, price, ts) {
  const { update, sig } = await ctx.sign(EVT, price, DEPTH, ts);
  return { update, sig, mid: f18(price), data: coder.encode(PRICE_DATA, [[update], [sig]]) };
}

/** Relay a price straight to the oracle, as the keeper does, in a block stamped `ts`. The engine is not touched. */
async function pushAt(ctx, price, ts) {
  const { update, sig } = await ctx.sign(EVT, price, DEPTH, ts);
  await time.setNextBlockTimestamp(ts);
  await ctx.oracle.push([update], [sig]);
}

/**
 * The finding's book: an event market `daysOut` days from expiry with hazardScale 1 and Boost on,
 * and Alice in a 10x position on 100 at 0.50, opened exactly `daysOut` days before expiry:
 * 2,000 shares, 1,800 of them borrowed.
 */
async function book({ daysOut = 40, isLong = true, overrides = {}, fixed = false } = {}) {
  const ctx = await deploy();
  if (fixed) await network.provider.send("hardhat_setCode", [ctx.engine.target, await fixedRuntime(ctx)]);
  const { engine, vault, lp, alice, push } = ctx;
  ctx.expiry = (await time.latest()) + daysOut * DAY + 60;
  await engine.setMarket(
    EVT,
    marketConfig({
      isEvent: true,
      boostEnabled: true,
      maxLeverage: 50,
      profitFeeBps: 1000,
      maxGapBps: 500,
      expiry: ctx.expiry,
      maxPositionNotional: usd(1_000_000),
      hazardScale: px(1),
      ...overrides,
    })
  );
  await vault.connect(lp).deposit(usd(1_000_000), lp.address);
  await push(EVT, px(0.5), DEPTH);
  ctx.t0 = ctx.expiry - daysOut * DAY;
  await time.setNextBlockTimestamp(ctx.t0);
  await engine.connect(alice).open(EVT, isLong, usd(100), 10, true, (await signedPrice(ctx, px(0.5), ctx.t0)).data);
  const [v] = await engine.positionsOf(alice.address);
  ctx.id = v.id;
  expect(v.position.entryPrice).to.equal(px(0.5));
  expect(v.position.borrowedUnits).to.equal(1800n * 10n ** 24n);
  expect(v.position.reserve).to.equal(usd(overrides.maxProfitMult === 1 ? 100 : 1000));
  // No premium yet: the line is 80% of the way to the stop, on the losing side. Same before and after the fix.
  expect(v.liquidationPrice).to.equal(px(isLong ? 0.46 : 0.54));
  return ctx;
}

/**
 * Hold the odds at `mid` for `days` days, then bring the premium index up to date in a block
 * stamped exactly `days` days after the open (anyone may; Bob holds nothing). From here on the
 * premium is banked, so a later price changes it by a second or two of accrual and no more.
 */
async function holdAndBank(ctx, mid, days) {
  ctx.T = ctx.t0 + days * DAY;
  await pushAt(ctx, px(mid), ctx.t0 + 1);
  await pushAt(ctx, px(mid), ctx.T - 1);
  await time.setNextBlockTimestamp(ctx.T);
  await ctx.engine.connect(ctx.bob).poke(EVT);
}

/** Would liquidate() go through right now, with `data` as its priceData? False only for NotLiquidatable. */
async function canLiquidate(ctx, data = "0x") {
  try {
    await ctx.engine.connect(ctx.liquidator).liquidate.staticCall(ctx.id, data);
    return true;
  } catch (e) {
    // Hardhat names the error for bytecode it has an artifact for, and gives the selector otherwise.
    const selector = ctx.engine.interface.getError("NotLiquidatable").selector;
    const text = `${e.revert?.name} ${e.data} ${e.message}`;
    if (!text.includes("NotLiquidatable") && !text.includes(selector)) throw e;
    return false;
  }
}

/** Send liquidate() in a block stamped `ts` and return its PositionClosed event. */
async function liquidateAt(ctx, ts, data = "0x") {
  await time.setNextBlockTimestamp(ts);
  const receipt = await (await ctx.engine.connect(ctx.liquidator).liquidate(ctx.id, data)).wait();
  for (const log of receipt.logs) {
    if (log.address !== ctx.engine.target) continue;
    const parsed = ctx.engine.interface.parseLog(log);
    if (parsed && parsed.name === "PositionClosed") return parsed.args;
  }
  throw new Error("no PositionClosed event");
}

/**
 * keeper/src/index.js, actionFor(), copied line for line. `signed` is the keeper's map of the
 * latest signed price per market; its own comment: "Judged against the live reference price, not
 * the last price relayed on-chain: the call carries that live price with it."
 */
function actionFor(p, signed) {
  const live = signed.get(Number(p.position.marketId));
  if (!live) return null;
  if (live.update.resolved) return "close";
  const liq = Number(ethers.formatUnits(p.liquidationPrice, 18));
  if (p.liquidatable || (p.position.isLong ? live.mid <= liq : live.mid >= liq)) return "liquidate";
  if (p.collectable) return "collect";
  if (p.forceClosable) return "forceClose";
  return null;
}

/**
 * web/src/components/Positions.tsx, the "Cushion left before liquidation" bar, copied: the fraction
 * drawn (green above 0.5), from the mid, the entry price and the reported liquidation price.
 */
const cushion = (mid, entry, liq) => Math.max(0, Math.min(1, (mid - liq) / (entry - liq)));

/** For each mid: relay it one second after the banked state, read the view, try liquidate(), undo. */
async function scan(ctx, mids) {
  const snap = await takeSnapshot();
  const rows = [];
  for (const mid of mids) {
    await pushAt(ctx, px(mid), ctx.T + 1);
    const v = await ctx.engine.positionView(ctx.id);
    const callable = await canLiquidate(ctx);
    expect(callable, `liquidate() and the liquidatable flag agree at ${mid}`).to.equal(v.liquidatable);
    rows.push({ mid, v, liquidatable: v.liquidatable, line: v.liquidationPrice });
    await snap.restore();
  }
  return rows;
}

const table = (rows) =>
  rows.map((r) => `${r.mid}:${r.liquidatable ? "LIQUIDATABLE" : "safe"}(line ${f18(r.line).toFixed(4)})`).join("  ");

// =================================================================================================

describe("Verify: positionView.liquidationPrice once the Boost premium has used up the buffer", function () {
  this.timeout(600_000);

  describe("Part 1: the contracts as they are", () => {
    it("V1 the claim's numbers: boosted 10x YES from 0.50, mid 0.60, 20 days: premium 288, liquidatable, line reported at 0.50", async () => {
      const ctx = await book();
      const { engine, usdc, alice, liquidator, t0, id } = ctx;
      await pushAt(ctx, px(0.6), t0 + 1); // the odds move ten points in the position's favour
      await pushAt(ctx, px(0.6), t0 + 20 * DAY); // and are still there twenty days on; nothing has touched the engine
      const v = await engine.positionView(id);
      note(
        `premium ${f6(v.boostPremium)}, price P&L +200, equity at the mid ${f6(v.equityAtMid)}, liquidatable=${v.liquidatable}, ` +
          `mid ${f18(v.markPrice)}, liquidationPrice reported ${f18(v.liquidationPrice)}`
      );
      expect(v.markPrice).to.equal(px(0.6));
      expect(v.boostPremium).to.equal(usd(288)); // 1,800 * 0.24 * 20 / (20 + 10)
      expect(v.pnl).to.equal(usd(200 - 288));
      expect(v.equityAtMid).to.equal(usd(12)); // 100 + 200 - 288, against a maintenance level of 20
      expect(v.liquidatable).to.equal(true);
      expect(v.forceClosable).to.equal(false);
      expect(v.collectable).to.equal(false);
      // The claim: the line is reported at entry, ten points below a mid the position is liquidatable at.
      expect(v.liquidationPrice).to.equal(v.position.entryPrice);
      expect(v.liquidationPrice).to.equal(px(0.5));

      // What the app draws from these numbers (Positions.tsx): a full bar.
      const bar = cushion(f18(v.markPrice), f18(v.position.entryPrice), f18(v.liquidationPrice));
      note(`the app's "cushion left before liquidation" for this row: ${bar} (1 is a full green bar)`);
      expect(bar).to.equal(1);

      // And liquidate() does go through at 0.60, as the finding says: the engine itself is right.
      const before = await usdc.balanceOf(alice.address);
      const ev = await liquidateAt(ctx, t0 + 20 * DAY + 1);
      expect(ev.kind).to.equal(LIQUIDATION);
      expect(ev.exitPrice).to.equal(px(0.6));
      expect(ev.payout).to.be.closeTo(usd(7), usd(0.001)); // equity 12 less the liquidator's 5
      expect((await usdc.balanceOf(alice.address)) - before).to.equal(ev.payout);
      expect(await usdc.balanceOf(liquidator.address)).to.equal(usd(5));
    });

    it("V2 with 288 of premium banked the position is liquidatable up to 0.604; the reported line stays at 0.50 throughout", async () => {
      const ctx = await book();
      await holdAndBank(ctx, 0.6, 20);
      expect((await ctx.engine.positionView(ctx.id)).boostPremium).to.equal(usd(288));
      const rows = await scan(ctx, [0.45, 0.5, 0.55, 0.6, 0.604, 0.605, 0.62, 0.7]);
      note(table(rows));
      // Equity reaches the maintenance level where the price P&L is 288 - 80 = 208: 0.50 * (1 + 208 / 1,000).
      expect(rows.map((r) => r.liquidatable)).to.deep.equal([true, true, true, true, true, false, false, false]);
      for (const r of rows) expect(r.line, `line reported at mid ${r.mid}`).to.equal(px(0.5));
      // "A long is liquidatable exactly when the mid is at or below its liquidation price" fails on this band.
      const above = rows.filter((r) => r.liquidatable && px(r.mid) > r.line).map((r) => r.mid);
      expect(above).to.deep.equal([0.55, 0.6, 0.604]);
    });

    it("V3 the mirror: boosted 10x NO from 0.50, mid 0.40, 20 days: liquidatable, line reported at 0.50", async () => {
      const ctx = await book({ isLong: false });
      const { engine, t0, id } = ctx;
      await pushAt(ctx, px(0.4), t0 + 1);
      await pushAt(ctx, px(0.4), t0 + 20 * DAY);
      const v = await engine.positionView(id);
      note(`NO: premium ${f6(v.boostPremium)}, equity ${f6(v.equityAtMid)}, liquidatable=${v.liquidatable}, mid 0.4, liquidationPrice reported ${f18(v.liquidationPrice)}`);
      expect(v.boostPremium).to.equal(usd(288));
      expect(v.equityAtMid).to.equal(usd(12));
      expect(v.liquidatable).to.equal(true);
      expect(await canLiquidate(ctx)).to.equal(true);
      expect(v.liquidationPrice).to.equal(px(0.5)); // a short is liquidatable at or ABOVE its line; the mid is ten points below it
    });

    it("V4 the keeper's live-price check cannot fire on such a position: a due liquidation waits for the next relay", async () => {
      // Control first: the same position before the premium has used up the buffer. On-chain 0.47
      // (equity 40, flag false), live 0.455. The line (0.46) is what makes the keeper act.
      let ctx = await book();
      await pushAt(ctx, px(0.47), ctx.t0 + 1);
      let live = await signedPrice(ctx, px(0.455), ctx.t0 + 2);
      let [p] = await ctx.engine.openPositions(0, 100);
      expect(p.liquidatable).to.equal(false);
      expect(f18(p.liquidationPrice)).to.be.closeTo(0.46, 1e-6);
      expect(actionFor(p, new Map([[EVT, live]]))).to.equal("liquidate");
      expect((await liquidateAt(ctx, ctx.t0 + 2, live.data)).kind).to.equal(LIQUIDATION);

      // The finding's position. On-chain 0.62 (equity 52, flag false), live 0.60 (equity 12).
      ctx = await book();
      await holdAndBank(ctx, 0.6, 20);
      await pushAt(ctx, px(0.62), ctx.T + 1);
      live = await signedPrice(ctx, px(0.6), ctx.T + 2);
      [p] = await ctx.engine.openPositions(0, 100);
      const action = actionFor(p, new Map([[EVT, live]]));
      note(
        `on-chain mid 0.62: liquidatable=${p.liquidatable}, liquidationPrice ${f18(p.liquidationPrice)}; live mid 0.60: ` +
          `keeper's action ${action}; liquidate() carrying the live price would go through: ${await canLiquidate(ctx, live.data)}`
      );
      expect(p.liquidatable).to.equal(false);
      expect(p.liquidationPrice).to.equal(px(0.5));
      expect(action, "keeper's action with the line reported at entry").to.equal(null);
      const ev = await liquidateAt(ctx, ctx.T + 2, live.data); // yet the call the keeper skipped is valid
      expect(ev.kind).to.equal(LIQUIDATION);
      expect(ev.exitPrice).to.equal(px(0.6));
    });

    it("V5 deployed event parameters, five days out: shown a stop at 0.50, liquidated at 0.53", async () => {
      // scripts/deploy.js: hazardScale 1, reactionSeconds 120, maxLeverage 50, maxProfitMult 10, Boost on.
      const ctx = await book({ daysOut: 5, overrides: { reactionSeconds: 120, maxPositionNotional: usd(100_000) } });
      const { engine, id } = ctx;
      await holdAndBank(ctx, 0.6, 1.5); // a day and a half at 0.60
      let v = await engine.positionView(id);
      note(
        `after 1.5 days at 0.60: premium ${f6(v.boostPremium)} (buffer was 80), equity ${f6(v.equityAtMid)}, liquidatable=${v.liquidatable}, ` +
          `forceClosable=${v.forceClosable}, liquidationPrice reported ${f18(v.liquidationPrice)}; equity reaches 20 at 0.5362`
      );
      expect(v.boostPremium).to.be.closeTo(usd(152.4706), usd(0.0001)); // 432 * 1.5 / (3.5 + 0.75)
      expect(v.liquidatable).to.equal(false);
      expect(v.forceClosable).to.equal(false);
      expect(v.liquidationPrice).to.equal(px(0.5));

      await pushAt(ctx, px(0.53), ctx.T + 60); // the odds give back seven of the ten points
      v = await engine.positionView(id);
      expect(v.liquidatable).to.equal(true);
      expect(v.forceClosable).to.equal(false);
      expect(v.liquidationPrice).to.equal(px(0.5));
      const ev = await liquidateAt(ctx, ctx.T + 61);
      note(`odds back to 0.53: liquidated there for a payout of ${f6(ev.payout)} of the 100 staked; the line shown was ${f18(v.liquidationPrice)}`);
      expect(ev.kind).to.equal(LIQUIDATION);
      expect(ev.exitPrice).to.equal(px(0.53));
      expect(ev.payout).to.be.closeTo(usd(2.44), usd(0.01)); // 100 + 60 - 152.56, less the liquidator's 5
    });
  });

  describe("Part 2: the recommended fix", () => {
    before(async () => {
      fixedEngine = await compileEngine(edit(SRC, AS_REVIEWED, FIX));
    });

    it("C0 control: the unedited source, built the same way, is the bytecode the other tests run", async () => {
      const same = await compileEngine(SRC);
      const artifact = await hre.artifacts.readArtifact("PerpEngine");
      expect("0x" + same.evm.bytecode.object).to.equal(artifact.bytecode);
      expect("0x" + fixedEngine.evm.bytecode.object).to.not.equal(artifact.bytecode);
    });

    it("F1 the claim's state: the line is at 0.604 for the YES and 0.396 for the NO", async () => {
      let ctx = await book({ fixed: true });
      await pushAt(ctx, px(0.6), ctx.t0 + 1);
      await pushAt(ctx, px(0.6), ctx.t0 + 20 * DAY);
      let v = await ctx.engine.positionView(ctx.id);
      expect(v.boostPremium).to.equal(usd(288));
      expect(v.liquidatable).to.equal(true);
      expect(v.liquidationPrice).to.equal(px(0.604)); // 0.50 * (1 + 208 / 1,000): at or above the mid of 0.60
      expect((await liquidateAt(ctx, ctx.t0 + 20 * DAY + 1)).payout).to.be.closeTo(usd(7), usd(0.001)); // settlement unchanged

      ctx = await book({ fixed: true, isLong: false });
      await pushAt(ctx, px(0.4), ctx.t0 + 1);
      await pushAt(ctx, px(0.4), ctx.t0 + 20 * DAY);
      v = await ctx.engine.positionView(ctx.id);
      expect(v.liquidatable).to.equal(true);
      expect(v.liquidationPrice).to.equal(px(0.396)); // 0.50 - 0.50 * 208 / 1,000: at or below the mid of 0.40
    });

    it("F2 the flag and the line agree at every mid, on both sides, and to within a thousandth of a cent at the line", async () => {
      let ctx = await book({ fixed: true });
      await holdAndBank(ctx, 0.6, 20);
      let rows = await scan(ctx, [0.45, 0.5, 0.55, 0.6, 0.6039, 0.604, 0.6041, 0.605, 0.62, 0.7]);
      note("YES " + table(rows));
      expect(rows.map((r) => r.liquidatable)).to.deep.equal([true, true, true, true, true, true, false, false, false, false]);
      for (const r of rows) expect(r.liquidatable, `YES at ${r.mid}`).to.equal(px(r.mid) <= r.line);

      // At the reported line itself, one second on (the premium only grows), and a hair above it.
      const line = (await ctx.engine.positionView(ctx.id)).liquidationPrice;
      expect(line).to.equal(px(0.604));
      const snap = await takeSnapshot();
      await pushAt(ctx, line, ctx.T + 2);
      expect((await ctx.engine.positionView(ctx.id)).liquidatable).to.equal(true);
      expect(await canLiquidate(ctx)).to.equal(true);
      await snap.restore();
      await pushAt(ctx, line + px(0.00001), ctx.T + 2);
      expect((await ctx.engine.positionView(ctx.id)).liquidatable).to.equal(false);
      expect(await canLiquidate(ctx)).to.equal(false);

      ctx = await book({ fixed: true, isLong: false });
      await holdAndBank(ctx, 0.4, 20);
      rows = await scan(ctx, [0.55, 0.5, 0.45, 0.4, 0.3961, 0.396, 0.3959, 0.395, 0.38, 0.3]);
      note("NO  " + table(rows));
      expect(rows.map((r) => r.liquidatable)).to.deep.equal([true, true, true, true, true, true, false, false, false, false]);
      for (const r of rows) expect(r.liquidatable, `NO at ${r.mid}`).to.equal(px(r.mid) >= r.line);
    });

    it("F3 the keeper acts on the live price again", async () => {
      const ctx = await book({ fixed: true });
      await holdAndBank(ctx, 0.6, 20);
      await pushAt(ctx, px(0.62), ctx.T + 1);
      const live = await signedPrice(ctx, px(0.6), ctx.T + 2);
      const [p] = await ctx.engine.openPositions(0, 100);
      expect(p.liquidatable).to.equal(false);
      expect(f18(p.liquidationPrice)).to.be.closeTo(0.604, 1e-6);
      expect(actionFor(p, new Map([[EVT, live]]))).to.equal("liquidate");
      expect((await liquidateAt(ctx, ctx.T + 2, live.data)).kind).to.equal(LIQUIDATION);
    });

    it("F4 the line stops at the win price: past it the position is liquidatable at every price", async () => {
      // maxProfitMult 1: the reserve is 100, so the win price is 0.55. After 14 days at 0.50 the
      // premium is 190.9: more than the 80 of buffer and the 100 the position can gain, together.
      const ctx = await book({ fixed: true, overrides: { maxProfitMult: 1 } });
      await holdAndBank(ctx, 0.5, 14);
      const v = await ctx.engine.positionView(ctx.id);
      expect(v.boostPremium).to.be.closeTo(usd(190.909), usd(0.001)); // 450 * 14 / (26 + 7)
      expect(v.winPrice).to.equal(px(0.55));
      expect(v.liquidationPrice).to.equal(v.winPrice);
      const rows = await scan(ctx, [0.3, 0.5, 0.55, 0.7, 0.99]);
      note(table(rows));
      for (const r of rows) {
        expect(r.liquidatable, `at ${r.mid}`).to.equal(true);
        expect(r.line).to.equal(px(0.55));
      }
    });

    it("F5 nothing else in positionView moves: same state, same block, both engines, seven positions", async () => {
      const ctx = await deploy();
      const { engine, vault, lp, alice, bob, carol, push } = ctx;
      const original = await ethers.provider.getCode(engine.target);
      const fixed = await fixedRuntime(ctx);
      const expiry = (await time.latest()) + 40 * DAY;
      await engine.setMarket(BTC, marketConfig({ maxAge: 3600, crowdingPerDay: px(0.0005) }));
      await engine.setMarket(
        EVT,
        marketConfig({
          isEvent: true,
          boostEnabled: true,
          maxLeverage: 50,
          profitFeeBps: 1000,
          maxGapBps: 500,
          maxAge: 3600,
          expiry,
          maxPositionNotional: usd(1_000_000),
          hazardScale: px(1),
        })
      );
      await vault.connect(lp).deposit(usd(5_000_000), lp.address);
      await push(BTC, px(60_000));
      await push(EVT, px(0.5), DEPTH);
      await engine.connect(alice).open(BTC, true, usd(100), 10, false, "0x"); // 1
      await engine.connect(bob).open(BTC, false, usd(100), 25, false, "0x"); // 2
      await engine.connect(alice).open(EVT, true, usd(100), 10, true, "0x"); // 3 boosted YES: buffer used up below
      await engine.connect(bob).open(EVT, false, usd(100), 10, true, "0x"); // 4 boosted NO: buffer used up below
      await engine.connect(carol).open(EVT, true, usd(100), 10, false, "0x"); // 5 free YES
      await engine.connect(carol).open(EVT, true, usd(100), 2, true, "0x"); // 6 boosted 2x YES: premium 32, buffer left
      await engine.connect(alice).open(EVT, false, usd(200), 5, false, "0x"); // 7 free NO
      await time.increase(20 * DAY);
      await push(BTC, px(60_300));
      await push(EVT, px(0.6), DEPTH);

      const before = await engine.openPositions(0, 100);
      await network.provider.send("hardhat_setCode", [engine.target, fixed]);
      const after = await engine.openPositions(0, 100);
      await network.provider.send("hardhat_setCode", [engine.target, original]);
      expect(before.length).to.equal(7);

      const SAME = ["id", "markPrice", "pnl", "equityAtMid", "winPrice", "crowdingFee", "boostPremium", "liquidatable", "forceClosable", "collectable"];
      const moved = [];
      for (let i = 0; i < before.length; i++) {
        for (const k of SAME) expect(after[i][k], `#${before[i].id} ${k}`).to.equal(before[i][k]);
        expect([...after[i].position]).to.deep.equal([...before[i].position]);
        if (after[i].liquidationPrice !== before[i].liquidationPrice) moved.push(after[i].id);
        const maint = (before[i].position.margin * 2000n) / 10_000n;
        const buffer = before[i].position.margin - maint - before[i].boostPremium;
        note(
          `#${before[i].id} premium ${f6(before[i].boostPremium).toFixed(2)} buffer ${f6(buffer).toFixed(2)}: ` +
            `line ${f18(before[i].liquidationPrice)} -> ${f18(after[i].liquidationPrice)}`
        );
      }
      expect(moved).to.deep.equal([3n, 4n]);
      expect(before[2].liquidationPrice).to.equal(px(0.5));
      expect(f18(after[2].liquidationPrice)).to.be.closeTo(0.604, 1e-4); // YES, liquidatable at 0.60
      expect(after[2].liquidatable).to.equal(true);
      expect(before[3].liquidationPrice).to.equal(px(0.5));
      expect(f18(after[3].liquidationPrice)).to.be.closeTo(0.396, 1e-4); // NO, liquidatable at 0.60: at or above its line
      expect(after[3].liquidatable).to.equal(true);
    });

    it("F6 deployed event parameters: the line is at 0.5362 while the odds are at 0.60, and the 0.53 liquidation is below it", async () => {
      const ctx = await book({ fixed: true, daysOut: 5, overrides: { reactionSeconds: 120, maxPositionNotional: usd(100_000) } });
      await holdAndBank(ctx, 0.6, 1.5);
      let v = await ctx.engine.positionView(ctx.id);
      expect(v.liquidatable).to.equal(false);
      expect(f18(v.liquidationPrice)).to.be.closeTo(0.536235, 1e-6); // 0.50 * (1 + 72.47 / 1,000)
      note(`cushion bar for this row: ${cushion(0.6, 0.5, f18(v.liquidationPrice))} (the app's formula; 0 is an empty bar)`);
      await pushAt(ctx, px(0.53), ctx.T + 60);
      v = await ctx.engine.positionView(ctx.id);
      expect(v.liquidatable).to.equal(true);
      expect(v.liquidationPrice).to.be.greaterThan(px(0.53));
      expect((await liquidateAt(ctx, ctx.T + 61)).payout).to.be.closeTo(usd(2.44), usd(0.01)); // settlement unchanged
    });
  });
});
