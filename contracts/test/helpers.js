const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

const usd = (n) => ethers.parseUnits(String(n), 6);
const px = (n) => ethers.parseUnits(String(n), 18);
const fmtUsd = (v) => Number(ethers.formatUnits(v, 6));

const UPDATE_TYPES = {
  PriceUpdate: [
    { name: "marketId", type: "uint32" },
    { name: "price", type: "uint256" },
    { name: "depthUsd", type: "uint256" },
    { name: "timestamp", type: "uint64" },
    { name: "resolved", type: "bool" },
  ],
};

const BTC = 1;
const EVT = 2;

function marketConfig(overrides = {}) {
  // Names from before the fee was split in two still work, so older tests read naturally.
  const { boostEnabled, hazardScale, ...rest } = overrides;
  const config = {
    enabled: true,
    isEvent: false,
    maxLeverage: 1000,
    maxProfitMult: 10,
    profitFeeBps: 500,
    kappaBps: 5000,
    maxGapBps: 10,
    maxAge: 30,
    reactionSeconds: 0,
    expiry: 0,
    nextEvent: 0,
    minDistance: 0n,
    maxPositionNotional: usd(10_000_000),
    maxSideNotional: 0n,
    crowdingPerDay: 0n,
    crowdingScale: 0n,
    boostScale: 0n,
    ...rest,
  };
  if (hazardScale !== undefined) {
    if (rest.crowdingScale === undefined) config.crowdingScale = hazardScale;
    if (rest.boostScale === undefined && boostEnabled) config.boostScale = hazardScale;
  }
  // Event markets need a minimum line distance. Two ticks unless a test asks for another.
  if (config.isEvent && config.minDistance === 0n) config.minDistance = px(0.02);
  return config;
}

/** @param withdrawDelay seconds LP shares stay locked after a deposit (600 in production). */
async function deploy({ withdrawDelay = 0 } = {}) {
  const [owner, keeper, lp, alice, bob, carol, liquidator] = await ethers.getSigners();

  const usdc = await (await ethers.getContractFactory("MockUSDC")).deploy();
  const oracle = await (await ethers.getContractFactory("PriceOracle")).deploy(owner.address);
  const vault = await (await ethers.getContractFactory("Vault")).deploy(usdc.target, owner.address, withdrawDelay);
  // 100 OLQ per 1 USDC of fee at launch, 1M USDC curve scale => 100M OLQ maximum supply.
  const token = await (await ethers.getContractFactory("OpenLiquidToken")).deploy(
    ethers.parseEther("100"),
    usd(1_000_000),
    owner.address
  );
  const staking = await (await ethers.getContractFactory("Staking")).deploy(token.target, usdc.target);
  const engine = await (await ethers.getContractFactory("PerpEngine")).deploy(
    oracle.target,
    vault.target,
    token.target,
    staking.target,
    owner.address
  );

  await vault.setEngine(engine.target);
  await token.setMinter(engine.target);
  await oracle.setSigner(keeper.address, true);
  await oracle.setTau(BTC, 60);
  await oracle.setTau(EVT, 300);

  for (const user of [lp, alice, bob, carol]) {
    await usdc.mint(user.address, usd(50_000_000));
    await usdc.connect(user).approve(vault.target, ethers.MaxUint256);
  }

  const net = await ethers.provider.getNetwork();
  const domain = { name: "OpenLiquidOracle", version: "1", chainId: net.chainId, verifyingContract: oracle.target };

  async function sign(marketId, price, depthUsd, timestamp, resolved = false, signer = keeper) {
    const update = { marketId, price, depthUsd, timestamp, resolved };
    const sig = await signer.signTypedData(domain, UPDATE_TYPES, update);
    return { update, sig };
  }

  /** Sign a price stamped with the next block's time and relay it in that block. */
  async function push(marketId, price, depthUsd = usd(20_000_000), resolved = false) {
    const ts = (await time.latest()) + 1;
    await time.setNextBlockTimestamp(ts);
    const { update, sig } = await sign(marketId, price, depthUsd, ts, resolved);
    await oracle.push([update], [sig]);
    return ts;
  }

  /** Hold a price for `seconds`, pushing a sample every `step` seconds like a live keeper. */
  async function hold(marketId, price, seconds, depthUsd = usd(20_000_000), step = 2) {
    for (let t = 0; t < seconds; t += step) {
      await time.increase(step - 1);
      await push(marketId, price, depthUsd);
    }
  }

  return { owner, keeper, lp, alice, bob, carol, liquidator, usdc, oracle, vault, token, staking, engine, sign, push, hold };
}

module.exports = { deploy, marketConfig, usd, px, fmtUsd, BTC, EVT, UPDATE_TYPES };
