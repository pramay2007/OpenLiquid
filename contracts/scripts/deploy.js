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

// Demo parameters per market kind. See README "Parameters" for the reasoning behind each.
const KINDS = {
  crypto: { tau: 60, maxLeverage: 1000, profitFeeBps: 500, kappaBps: 5000, maxGapBps: 20, maxPositionNotional: usd(10_000_000), fundingPerDay: wad(0.0005), borrowPerDay: 0n },
  equity: { tau: 120, maxLeverage: 1000, profitFeeBps: 500, kappaBps: 5000, maxGapBps: 25, maxPositionNotional: usd(5_000_000), fundingPerDay: wad(0.0005), borrowPerDay: 0n },
  commodity: { tau: 120, maxLeverage: 1000, profitFeeBps: 500, kappaBps: 5000, maxGapBps: 25, maxPositionNotional: usd(5_000_000), fundingPerDay: wad(0.0005), borrowPerDay: 0n },
  event: { tau: 300, maxLeverage: 50, profitFeeBps: 1000, kappaBps: 20000, maxGapBps: 500, maxPositionNotional: usd(100_000), fundingPerDay: wad(0.001), borrowPerDay: wad(0.002), compressWindow: 86_400 },
};

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
  const maxAge = isLocal ? 30 : 10;

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
  const vault = await deployOne("Vault", usdcAddress, deployer.address);
  const token = await deployOne("OpenLiquidToken", ethers.parseEther("100"), usd(1_000_000), deployer.address);
  const staking = await deployOne("Staking", token.target, usdcAddress);
  const engine = await deployOne("PerpEngine", oracle.target, vault.target, token.target, staking.target, deployer.address);

  const send = async (tx) => (await tx).wait();
  await send(vault.setEngine(engine.target));
  await send(token.setMinter(engine.target));
  await send(oracle.setSigner(keeper, true));

  for (const m of markets) {
    const k = KINDS[m.kind];
    await send(oracle.setTau(m.id, k.tau));
    await send(
      engine.setMarket(m.id, {
        enabled: true,
        isEvent: m.kind === "event",
        maxLeverage: k.maxLeverage,
        maxProfitMult: 10,
        profitFeeBps: k.profitFeeBps,
        kappaBps: k.kappaBps,
        maxGapBps: k.maxGapBps,
        maxAge,
        expiry: m.expiry ?? 0,
        compressWindow: k.compressWindow ?? 0,
        maxPositionNotional: k.maxPositionNotional,
        fundingPerDay: k.fundingPerDay,
        borrowPerDay: k.borrowPerDay,
      })
    );
    console.log(`market ${String(m.id).padStart(3)}  ${m.kind.padEnd(9)} ${m.symbol}`);
  }

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
