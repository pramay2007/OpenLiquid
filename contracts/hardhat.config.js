require("@nomicfoundation/hardhat-toolbox");
require("dotenv").config({ path: "../.env" });

const DEPLOYER_KEY = process.env.DEPLOYER_PRIVATE_KEY;

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: {
    version: "0.8.24",
    settings: {
      optimizer: { enabled: true, runs: 1 },
      viaIR: true,
      // Conservative target so the bytecode runs on any EVM chain, Arc included.
      evmVersion: "paris",
    },
  },
  // The tests step through simulated hours of prices; a loaded machine needs more than the default.
  mocha: { timeout: 180000 },
  paths: { sources: "./src", tests: "./test", cache: "./cache", artifacts: "./artifacts" },
  networks: {
    hardhat: { chainId: 31337 },
    localhost: { url: "http://127.0.0.1:8545", chainId: 31337 },
    arcTestnet: {
      url: process.env.ARC_RPC_URL || "https://rpc.testnet.arc.io",
      chainId: 5042002,
      accounts: DEPLOYER_KEY ? [DEPLOYER_KEY] : [],
    },
  },
};
