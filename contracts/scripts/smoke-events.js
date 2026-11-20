// End-to-end check against a running deployment and keeper: open and close a crypto position,
// a leveraged prediction-market position in free mode, and a boosted one, each with the
// keeper's freshly signed price bundled into the transaction.
//
//   KEEPER_URL=http://localhost:8787 npx hardhat run scripts/smoke-events.js --network localhost

const fs = require("fs");
const path = require("path");
const { ethers, network } = require("hardhat");

const KEEPER_URL = process.env.KEEPER_URL ?? "http://localhost:8787";
const TYPES = ["tuple(uint32 marketId,uint256 price,uint256 depthUsd,uint64 timestamp,bool resolved)[]", "bytes[]"];
const usd = (n) => ethers.parseUnits(String(n), 6);
const fmt = (v, d = 6) => Number(ethers.formatUnits(v, d));

async function priceData(marketId) {
  const res = await (await fetch(`${KEEPER_URL}/prices`)).json();
  const p = res.prices.find((x) => x.marketId === marketId);
  if (!p) throw new Error(`keeper has no price for market ${marketId}`);
  return ethers.AbiCoder.defaultAbiCoder().encode(TYPES, [[p.update], [p.sig]]);
}

async function main() {
  const file = path.join(__dirname, `../../deployments/${network.name}.json`);
  const d = JSON.parse(fs.readFileSync(file, "utf8"));
  const [owner] = await ethers.getSigners();
  const trader = new ethers.NonceManager(owner);
  const engine = await ethers.getContractAt("PerpEngine", d.contracts.PerpEngine, trader);
  const usdc = await ethers.getContractAt("MockUSDC", d.contracts.USDC, trader);
  const me = await owner.getAddress();
  if (d.faucet && (await usdc.balanceOf(me)) < usd(1_000)) await (await usdc.mint(me, usd(10_000))).wait();
  await (await usdc.approve(d.contracts.Vault, ethers.MaxUint256)).wait();

  const show = async (label) => {
    for (const p of await engine.positionsOf(me)) {
      console.log(
        `  ${label} #${p.id} market ${p.position.marketId} ${p.position.isLong ? "long/yes" : "short/no"}` +
          `${p.position.boosted ? " boost" : ""} stake ${fmt(p.position.margin)} notional ${fmt(p.position.notional)}` +
          ` entry ${fmt(p.position.entryPrice, 18)} win at ${fmt(p.winPrice, 18)} liq at ${fmt(p.liquidationPrice, 18)}` +
          ` max win ${fmt(p.position.reserve)} pnl ${fmt(p.pnl)}`
      );
    }
  };
  const closeAll = async () => {
    for (const p of await engine.positionsOf(me)) {
      await (await engine.close(p.id, await priceData(Number(p.position.marketId)))).wait();
    }
  };

  const before = await usdc.balanceOf(me);
  await (await engine.open(1, true, usd(50), 100, false, await priceData(1))).wait();
  await show("crypto");
  await closeAll();

  for (const m of d.markets.filter((x) => x.kind === "event")) {
    const v = await engine.marketView(m.id);
    const lev = Number(v.maxLeverageLong);
    const boost = v.config.boostScale > 0n;
    console.log(
      `${m.name} / ${m.outcome}: yes ${fmt(v.feed.mid, 18)} max leverage ${lev}x boost ${boost ? "on" : "off"}` +
        ` premium/share/day ${fmt(v.boostPerDay, 18)} closed ${v.closed}`
    );
    if (lev < 1 || v.closed) continue;
    // Capacity follows the reference book, and these books are thin: size the test inside it.
    const stake = Math.max(1, Math.min(20, Math.floor(fmt(v.sideCap) / (lev * 3))));
    console.log(`  capacity per side ${fmt(v.sideCap)} USDC, test stake ${stake}`);
    await (await engine.open(m.id, true, usd(stake), lev, false, await priceData(m.id))).wait();
    await (await engine.open(m.id, false, usd(stake), 1, false, await priceData(m.id))).wait();
    if (boost && lev >= 2) await (await engine.open(m.id, true, usd(stake), lev, true, await priceData(m.id))).wait();
    await show("event");
    await closeAll();
  }
  console.log(`net change after all round trips: ${fmt((await usdc.balanceOf(me)) - before)} USDC`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
