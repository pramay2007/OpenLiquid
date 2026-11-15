// Print every market's on-chain price, cap and leverage limits.
//   npx hardhat run scripts/status.js --network localhost
const { ethers, network } = require("hardhat");
const deployment = require(`../../deployments/${network.name}.json`);

(async () => {
  const engine = await ethers.getContractAt("PerpEngine", deployment.contracts.PerpEngine);
  const names = new Map(deployment.markets.map((m) => [m.id, m.symbol]));
  for (const v of await engine.allMarkets()) {
    const cap = Math.round(Number(ethers.formatUnits(v.sideCap, 6))).toLocaleString();
    console.log(
      String(v.marketId).padStart(3),
      (names.get(Number(v.marketId)) || "").slice(0, 28).padEnd(28),
      "mid", ethers.formatUnits(v.feed.mid, 18).slice(0, 10).padEnd(10),
      "slow", ethers.formatUnits(v.feed.slow, 18).slice(0, 10).padEnd(10),
      "cap $" + cap.padStart(10),
      "max lev", `${v.maxLeverageLong}/${v.maxLeverageShort}`
    );
  }
})();
