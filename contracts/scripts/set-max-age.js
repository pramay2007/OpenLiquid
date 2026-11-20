// Set how long a signed price stays usable, on every market of a live deployment.
//
//   MAX_AGE=10 npx hardhat run scripts/set-max-age.js --network arcTestnet
//
// A trader may submit any signed price that is newer than the one on-chain and no older than
// this window, so the window is the upper bound on how stale a chosen price can be. Every other
// field of each market's configuration is read back from the chain and written unchanged.

const fs = require("fs");
const path = require("path");
const { ethers, network } = require("hardhat");

async function main() {
  const maxAge = Number(process.env.MAX_AGE);
  if (!Number.isInteger(maxAge) || maxAge < 3) throw new Error("Set MAX_AGE to a whole number of seconds, 3 or more");

  const file = path.join(__dirname, `../../deployments/${network.name}.json`);
  const deployment = JSON.parse(fs.readFileSync(file, "utf8"));
  const [owner] = await ethers.getSigners();
  const signer = new ethers.NonceManager(owner);
  const engine = await ethers.getContractAt("PerpEngine", deployment.contracts.PerpEngine, signer);

  const count = Number(await engine.marketCount());
  for (let i = 0; i < count; i++) {
    const id = await engine.marketIds(i);
    const c = (await engine.marketView(id)).config;
    if (Number(c.maxAge) === maxAge) {
      console.log(`market ${String(id).padStart(3)}  already ${maxAge}s`);
      continue;
    }
    // Every field as it is on-chain, with one changed.
    const next = { ...c.toObject(), maxAge };
    await (await engine.setMarket(id, next)).wait();
    console.log(`market ${String(id).padStart(3)}  ${c.maxAge}s -> ${maxAge}s`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
