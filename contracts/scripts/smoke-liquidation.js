// Local smoke test of the keeper's liquidation path: open a 1000x long and a 1000x short on BTC
// and wait for the keeper to liquidate whichever the market moves against (about 8 bps).
//   npx hardhat run scripts/smoke-liquidation.js --network localhost
const { ethers, network } = require("hardhat");
const deployment = require(`../../deployments/${network.name}.json`);

const KEEPER_URL = process.env.KEEPER_URL || "http://localhost:8787";
const BTC = 1;
const WAIT_SECONDS = Number(process.env.WAIT_SECONDS || 240);

async function priceData(marketId) {
  const { prices } = await (await fetch(`${KEEPER_URL}/prices`)).json();
  const p = prices.find((x) => x.marketId === marketId);
  return ethers.AbiCoder.defaultAbiCoder().encode(
    ["tuple(uint32 marketId,uint256 price,uint256 depthUsd,uint64 timestamp,bool resolved)[]", "bytes[]"],
    [[p.update], [p.sig]]
  );
}

(async () => {
  const trader = (await ethers.getSigners())[5];
  const usdc = await ethers.getContractAt("MockUSDC", deployment.contracts.USDC, trader);
  const engine = await ethers.getContractAt("PerpEngine", deployment.contracts.PerpEngine, trader);
  await (await usdc.mint(trader.address, ethers.parseUnits("1000", 6))).wait();
  await (await usdc.approve(deployment.contracts.Vault, ethers.MaxUint256)).wait();

  for (const isLong of [true, false]) {
    try {
      await (await engine.open(BTC, isLong, ethers.parseUnits("50", 6), 1000, await priceData(BTC))).wait();
      console.log(`opened 1000x ${isLong ? "long" : "short"}`);
    } catch (err) {
      console.log(`${isLong ? "long" : "short"} refused: ${err.revert?.name ?? err.shortMessage}`);
    }
  }
  const opened = (await engine.positionsOf(trader.address)).length;
  if (!opened) return console.log("nothing opened (price moving fast); run again");

  const start = Date.now();
  while (Date.now() - start < WAIT_SECONDS * 1000) {
    const left = (await engine.positionsOf(trader.address)).length;
    if (left < opened) {
      const logs = await engine.queryFilter(engine.filters.PositionClosed(null, trader.address), -200);
      const last = logs[logs.length - 1].args;
      console.log(
        `keeper liquidated #${last.id} after ${Math.round((Date.now() - start) / 1000)}s: kind=${last.kind} ` +
          `exit=${ethers.formatUnits(last.exitPrice, 18)} returned to trader=$${ethers.formatUnits(last.payout, 6)}`
      );
      return;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  console.log(`no liquidation within ${WAIT_SECONDS}s (price moved less than 8 bps)`);
})();
