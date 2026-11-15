import { defineChain, type Abi } from "viem";
import engineAbi from "./PerpEngine.abi.json";
import vaultAbi from "./Vault.abi.json";
import oracleAbi from "./PriceOracle.abi.json";
import tokenAbi from "./OpenLiquidToken.abi.json";
import stakingAbi from "./Staking.abi.json";
import usdcAbi from "./MockUSDC.abi.json";

export type MarketKind = "crypto" | "equity" | "commodity" | "event";

export interface MarketMeta {
  id: number;
  symbol: string;
  name: string;
  kind: MarketKind;
  source: "hyperliquid" | "gemini";
  ref: string;
  outcome?: string;
  category?: string;
  expiry?: number;
}

export interface Deployment {
  network: string;
  chainId: number;
  rpcUrl: string;
  keeper: string;
  faucet: boolean;
  contracts: Record<"USDC" | "PriceOracle" | "Vault" | "OpenLiquidToken" | "Staking" | "PerpEngine", `0x${string}`>;
  markets: MarketMeta[];
}

// The deploy script writes deployment.<network>.json next to this file.
const deployments = import.meta.glob<Deployment>("./deployment.*.json", { eager: true, import: "default" });
const wanted = import.meta.env.VITE_NETWORK ?? "localhost";
const found = deployments[`./deployment.${wanted}.json`] ?? Object.values(deployments)[0];
if (!found) throw new Error("No deployment found. Run the deploy script first.");

export const deployment: Deployment = found;
export const KEEPER_URL: string = import.meta.env.VITE_KEEPER_URL ?? "http://localhost:8787";
export const IS_LOCAL = deployment.chainId === 31337;
export const NETWORK_LABEL = IS_LOCAL ? "Local devnet" : "Arc Testnet";
export const EXPLORER_URL = IS_LOCAL ? null : "https://explorer.testnet.arc.io";

export const chain = defineChain({
  id: deployment.chainId,
  name: NETWORK_LABEL,
  nativeCurrency: IS_LOCAL
    ? { name: "Ether", symbol: "ETH", decimals: 18 }
    : { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: { default: { http: [import.meta.env.VITE_RPC_URL ?? deployment.rpcUrl] } },
  // Multicall3 is deployed on Arc; reads are folded into one RPC call per refresh there.
  contracts: IS_LOCAL ? undefined : { multicall3: { address: "0xcA11bde05977b3631167028862bE2a173976CA11" } },
});

const errorsOf = (abi: unknown) => (abi as Abi).filter((item) => item.type === "error");

/** Each ABI carries the custom errors of the contracts it calls into, so reverts decode by name. */
export const abis = {
  engine: [...(engineAbi as Abi), ...errorsOf(vaultAbi), ...errorsOf(oracleAbi), ...errorsOf(usdcAbi)] as Abi,
  vault: [...(vaultAbi as Abi), ...errorsOf(usdcAbi)] as Abi,
  oracle: oracleAbi as Abi,
  token: tokenAbi as Abi,
  staking: stakingAbi as Abi,
  usdc: usdcAbi as Abi,
};

export const addresses = deployment.contracts;
export const marketMeta = new Map(deployment.markets.map((m) => [m.id, m]));
