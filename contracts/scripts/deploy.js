// Deploy OpenLiquid and register every market in ../markets.json.
//
//   npx hardhat run scripts/deploy.js --network localhost
//   npx hardhat run scripts/deploy.js --network arcTestnet
//
// Environment (../.env):
//   KEEPER_ADDRESS   address allowed to sign prices (localhost always uses Hardhat account #1)
//   USDC_ADDRESS     collateral token to use; if unset a faucet test USDC is deployed
//   SEED_LIQUIDITY   test USDC to deposit into the vault when the faucet token is used

const fs = require("fs");
const path = require("path");
const { ethers, network } = require("hardhat");

const usd = (n) => ethers.parseUnits(String(n), 6);
const wad = (n) => ethers.parseUnits(String(n), 18);

// Demo parameters per market kind. The whitepaper's parameters page gives the reasoning.
//   tau              averaging time of the slow price and of the persistent depth, seconds
//   kappaBps         capacity per side as a share of persistent reference depth (event markets:
//                    further scaled by 2 * min(p, 1-p), so it is sized in shares)
//   maxSideNotional  ceiling on each side's open interest that does not come from the signed book
//   crowdingPerDay   other markets: crowding fee at full skew, as a share of notional per day
//   minDistance      event markets: both lines at least this far from entry
//   crowdingScale    event markets: multiple of the implied hazard charged to the crowded side
//   boostScale       event markets: multiple of the implied hazard charged for Boost; 0 = no Boost
//   reactionSeconds  event markets: reaction time in the square-root-of-time leverage limit
//   closeBefore      event markets: trading stops this many seconds before the listed time
const KINDS = {
  crypto: { tau: 60, maxLeverage: 1000, profitFeeBps: 500, kappaBps: 5000, maxGapBps: 20, maxPositionNotional: usd(10_000_000), crowdingPerDay: wad(0.0005) },
  equity: { tau: 120, maxLeverage: 1000, profitFeeBps: 500, kappaBps: 5000, maxGapBps: 25, maxPositionNotional: usd(5_000_000), crowdingPerDay: wad(0.0005) },
  commodity: { tau: 120, maxLeverage: 1000, profitFeeBps: 500, kappaBps: 5000, maxGapBps: 25, maxPositionNotional: usd(5_000_000), crowdingPerDay: wad(0.0005) },
  // A result fixed at a known time on a price that moves continuously (BTC on a date).
  event: { tau: 300, maxLeverage: 10, profitFeeBps: 1000, kappaBps: 2500, maxGapBps: 500, maxPositionNotional: usd(100_000), maxSideNotional: usd(1_000), reactionSeconds: 120, minDistance: wad(0.05), crowdingScale: 0n, boostScale: wad(2.5), closeBefore: 0 },
  // A match: leverage is for the odds before it starts. Trading stops five minutes before kickoff.
  sports: { tau: 300, maxLeverage: 5, profitFeeBps: 1000, kappaBps: 2500, maxGapBps: 500, maxPositionNotional: usd(100_000), maxSideNotional: usd(1_000), reactionSeconds: 120, minDistance: wad(0.1), crowdingScale: 0n, boostScale: 0n, closeBefore: 300 },
};
const kindOf = (m) => (m.kind === "event" && m.category === "Sports" ? "sports" : m.kind);
// LP shares stay locked this long after a deposit, so nobody can step in and out around a price.
const WITHDRAW_DELAY = 600;

async function main() {
  const [deployer, localKeeper] = await ethers.getSigners();
  // Nonces are tracked here, not read back per transaction: a load-balanced public RPC can
  // answer with a stale count right after a transaction lands.
  const signer = new ethers.NonceManager(deployer);
  const isLocal = network.name === "localhost" || network.name === "hardhat";
  // Localhost always uses Hardhat's test account #1, whatever .env holds for the real network.
  const keeper = isLocal ? localKeeper.address : process.env.KEEPER_ADDRESS;
  if (!keeper) throw new Error("Set KEEPER_ADDRESS in .env");
  // How long a signed price stays usable. A trader can choose among the prices signed inside
  // this window, so it is kept short (scripts/set-max-age.js changes it on a live deployment).
  // Not below about 15 on Arc: nodes estimate gas against a pending block stamped 12 s ahead, so a
  // shorter window makes a fresh price look expired before the transaction is sent.
  const maxAge = isLocal ? 30 : 20;

  const file = JSON.parse(fs.readFileSync(path.join(__dirname, "../../markets.json"), "utf8"));
  const markets = [...file.markets, ...file.events];

  const deployOne = async (name, ...args) => {
    const c = await (await ethers.getContractFactory(name, signer)).deploy(...args);
    await c.waitForDeployment();
    console.log(`${name.padEnd(13)} ${c.target}`);
    return c;
  };

  let usdcAddress = process.env.USDC_ADDRESS;
  let faucet = false;
  if (!usdcAddress) {
    usdcAddress = (await deployOne("MockUSDC")).target;
    faucet = true;
  }
  const oracle = await deployOne("PriceOracle", deployer.address);
  const vault = await deployOne("Vault", usdcAddress, deployer.address, WITHDRAW_DELAY);
  const token = await deployOne("OpenLiquidToken", ethers.parseEther("100"), usd(1_000_000), deployer.address);
  const staking = await deployOne("Staking", token.target, usdcAddress);
  const engine = await deployOne("PerpEngine", oracle.target, vault.target, token.target, staking.target, deployer.address);

  const send = async (tx) => (await tx).wait();
  await send(vault.setEngine(engine.target));
  await send(token.setMinter(engine.target));
  await send(oracle.setSigner(keeper, true));

  for (const m of markets) {
    const k = KINDS[kindOf(m)];
    const isEvent = m.kind === "event";
    await send(oracle.setTau(m.id, k.tau));
    await send(
      engine.setMarket(m.id, {
        enabled: true,
        isEvent,
        maxLeverage: m.maxLeverage ?? k.maxLeverage,
        maxProfitMult: 10,
        profitFeeBps: k.profitFeeBps,
        kappaBps: k.kappaBps,
        maxGapBps: k.maxGapBps,
        maxAge,
        reactionSeconds: k.reactionSeconds ?? 0,
        expiry: isEvent ? m.expiry - k.closeBefore : 0,
        // The next scheduled information event before the result, if the market has one.
        nextEvent: m.nextEvent ?? 0,
        minDistance: k.minDistance ?? 0n,
        maxPositionNotional: k.maxPositionNotional,
        maxSideNotional: k.maxSideNotional ?? 0n,
        crowdingPerDay: k.crowdingPerDay ?? 0n,
        crowdingScale: k.crowdingScale ?? 0n,
        boostScale: k.boostScale ?? 0n,
      })
    );
    console.log(`market ${String(m.id).padStart(3)}  ${kindOf(m).padEnd(9)} ${m.symbol}`);
  }
  // Every market has to be on the list the vault marks and the app reads.
  const listedCount = Number(await engine.marketCount());
  if (listedCount !== markets.length) throw new Error(`listed ${listedCount} of ${markets.length} markets`);

  if (faucet) {
    const seed = usd(process.env.SEED_LIQUIDITY || 2_000_000);
    const usdc = await ethers.getContractAt("MockUSDC", usdcAddress, signer);
    await send(usdc.mint(deployer.address, seed));
    await send(usdc.approve(vault.target, seed));
    await send(vault.deposit(seed, deployer.address));
    console.log(`seeded vault with ${ethers.formatUnits(seed, 6)} test USDC`);
    if (isLocal) await send(signer.sendTransaction({ to: keeper, value: ethers.parseEther("100") }));
  }

  const { chainId } = await ethers.provider.getNetwork();
  const out = {
    network: network.name,
    chainId: Number(chainId),
    rpcUrl: network.config.url || "http://127.0.0.1:8545",
    deployedAt: new Date().toISOString(),
    keeper,
    faucet,
    contracts: {
      USDC: usdcAddress,
      PriceOracle: oracle.target,
      Vault: vault.target,
      OpenLiquidToken: token.target,
      Staking: staking.target,
      PerpEngine: engine.target,
    },
    markets,
  };
  const dir = path.join(__dirname, "../../deployments");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${network.name}.json`), JSON.stringify(out, null, 2) + "\n");

  // The frontend imports ABIs and the deployment from its own source tree.
  const webDir = path.join(__dirname, "../../web/src/chain");
  fs.mkdirSync(webDir, { recursive: true });
  for (const name of ["PerpEngine", "Vault", "PriceOracle", "OpenLiquidToken", "Staking", "MockUSDC"]) {
    const artifact = JSON.parse(
      fs.readFileSync(path.join(__dirname, `../artifacts/src/${name}.sol/${name}.json`), "utf8")
    );
    fs.writeFileSync(path.join(webDir, `${name}.abi.json`), JSON.stringify(artifact.abi));
  }
  fs.writeFileSync(path.join(webDir, `deployment.${network.name}.json`), JSON.stringify(out, null, 2) + "\n");
  console.log(`wrote deployments/${network.name}.json`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
