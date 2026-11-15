// USDC in and out of Arc with Circle's CCTP V2.
//
// A transfer is one transaction on the source chain: USDC is burned there with the forwarding
// hook attached, Circle attests the burn, and Circle's forwarding service submits the mint on
// the destination. The sender needs nothing on the destination chain. No API key is involved:
// the contracts are permissionless and the attestation API is public.
//
// Addresses, domains and the hook value are from developers.circle.com/cctp (checked on-chain
// 2026-11-15). TokenMessengerV2 has the same address on every testnet used here.

import {
  createPublicClient,
  createWalletClient,
  custom,
  erc20Abi,
  http,
  pad,
  parseAbi,
  type Chain,
  type PublicClient,
  type WalletClient,
  zeroHash,
} from "viem";
import { arbitrumSepolia, avalancheFuji, baseSepolia, optimismSepolia, sepolia } from "viem/chains";
import { EXPLORER_URL, chain as arc } from "../chain/config";
import { publicClient as arcClient } from "./chain";
import { useStore } from "../state/store";
import { activeWallet, withHeadroom } from "./wallet";

const IRIS = "https://iris-api-sandbox.circle.com";
const TOKEN_MESSENGER = "0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA" as const;
/** "cctp-forward", right-padded: asks Circle to submit the mint on the destination. */
const FORWARD_HOOK = "0x636374702d666f72776172640000000000000000000000000000000000000000" as const;
const FAST = 1000;
const STANDARD = 2000;

const messengerAbi = parseAbi([
  "function depositForBurnWithHook(uint256 amount, uint32 destinationDomain, bytes32 mintRecipient, address burnToken, bytes32 destinationCaller, uint256 maxFee, uint32 minFinalityThreshold, bytes hookData)",
]);

export interface BridgeChain {
  key: string;
  name: string;
  /** CCTP domain id. */
  domain: number;
  chain: Chain;
  rpc?: string;
  usdc: `0x${string}`;
  /** Whether a Fast Transfer is offered from this chain; Arc and Fuji finalise quickly anyway. */
  fast: boolean;
  /** Rough time for Circle to attest a burn made here. */
  eta: string;
  txUrl: (hash: string) => string;
}

export const ARC: BridgeChain = {
  key: "arc",
  name: "Arc Testnet",
  domain: 26,
  chain: arc,
  usdc: "0x3600000000000000000000000000000000000000",
  fast: false,
  eta: "a few seconds",
  txUrl: (h) => `${EXPLORER_URL ?? "https://explorer.testnet.arc.io"}/tx/${h}`,
};

export const REMOTE_CHAINS: BridgeChain[] = [
  {
    key: "base",
    name: "Base Sepolia",
    domain: 6,
    chain: baseSepolia,
    rpc: "https://sepolia.base.org",
    usdc: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    fast: true,
    eta: "about 10 seconds",
    txUrl: (h) => `https://sepolia.basescan.org/tx/${h}`,
  },
  {
    key: "ethereum",
    name: "Ethereum Sepolia",
    domain: 0,
    chain: sepolia,
    rpc: "https://ethereum-sepolia-rpc.publicnode.com",
    usdc: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
    fast: true,
    eta: "about 20 seconds",
    txUrl: (h) => `https://sepolia.etherscan.io/tx/${h}`,
  },
  {
    key: "arbitrum",
    name: "Arbitrum Sepolia",
    domain: 3,
    chain: arbitrumSepolia,
    rpc: "https://sepolia-rollup.arbitrum.io/rpc",
    usdc: "0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d",
    fast: true,
    eta: "about 10 seconds",
    txUrl: (h) => `https://sepolia.arbiscan.io/tx/${h}`,
  },
  {
    key: "optimism",
    name: "OP Sepolia",
    domain: 2,
    chain: optimismSepolia,
    rpc: "https://sepolia.optimism.io",
    usdc: "0x5fd84259d66Cd46123540766Be93DFE6D43130D7",
    fast: true,
    eta: "about 10 seconds",
    txUrl: (h) => `https://sepolia-optimism.etherscan.io/tx/${h}`,
  },
  {
    key: "avalanche",
    name: "Avalanche Fuji",
    domain: 1,
    chain: avalancheFuji,
    rpc: "https://api.avax-test.network/ext/bc/C/rpc",
    usdc: "0x5425890298aed601595a70AB815c96711a31Bc65",
    fast: false,
    eta: "about 10 seconds",
    txUrl: (h) => `https://testnet.snowtrace.io/tx/${h}`,
  },
];

export interface Quote {
  /** Circle's transfer fee, in USDC. Zero on Standard transfers. */
  protocolFee: number;
  /** What Circle charges to submit the mint on the destination, in USDC. */
  forwardFee: number;
  /** Total fees as passed on-chain, protocol plus forwarding (USDC base units). */
  maxFee: bigint;
  threshold: number;
}

const units = (amount: number) => BigInt(Math.round(amount * 1e6));

/** Live fees for a route, from Circle's API. */
export async function quote(from: BridgeChain, to: BridgeChain, amount: number): Promise<Quote> {
  const res = await fetch(`${IRIS}/v2/burn/USDC/fees/${from.domain}/${to.domain}?forward=true`);
  if (!res.ok) throw new Error(`Circle fee service returned ${res.status}`);
  const rows = (await res.json()) as {
    finalityThreshold: number;
    minimumFee: number; // basis points
    forwardFee: { low: number; med: number; high: number };
  }[];
  const threshold = from.fast ? FAST : STANDARD;
  const row = rows.find((r) => r.finalityThreshold === threshold) ?? rows[0];
  if (!row) throw new Error("Circle has no fee quote for this route");
  // Basis points can be fractional (1.3), so work in hundredths of a basis point and round up.
  const protocol = (units(amount) * BigInt(Math.round(row.minimumFee * 100)) + 999_999n) / 1_000_000n;
  return {
    protocolFee: Number(protocol) / 1e6,
    // The whole maximum is charged (observed on testnet), so quote the figure that is passed.
    forwardFee: row.forwardFee.high / 1e6,
    maxFee: protocol + BigInt(row.forwardFee.high),
    threshold,
  };
}

export type BridgeStage = "approve" | "burn" | "attest" | "done";

export interface BridgeProgress {
  stage: BridgeStage;
  burnTx?: string;
  mintTx?: string;
}

type Eth = Parameters<typeof custom>[0];
const injected = () => (window as unknown as { ethereum?: Eth }).ethereum;

async function switchTo(client: WalletClient, target: Chain) {
  try {
    await client.switchChain({ id: target.id });
  } catch {
    await client.addChain({ chain: target });
    await client.switchChain({ id: target.id });
  }
}

/** A signer on the source chain: the app's own account on Arc, a browser wallet elsewhere. */
async function signerOn(from: BridgeChain): Promise<{ wallet: WalletClient; address: `0x${string}`; reader: PublicClient }> {
  if (from.key === ARC.key) {
    const wallet = activeWallet();
    if (!wallet?.account) throw new Error("Connect an account first");
    return { wallet, address: wallet.account.address, reader: arcClient as PublicClient };
  }
  const eth = injected();
  if (!eth) throw new Error(`Bringing USDC from ${from.name} needs a browser wallet holding it there`);
  const probe = createWalletClient({ chain: from.chain, transport: custom(eth) });
  const [address] = await probe.requestAddresses();
  await switchTo(probe, from.chain);
  return {
    wallet: createWalletClient({ account: address, chain: from.chain, transport: custom(eth) }),
    address,
    reader: createPublicClient({ chain: from.chain, transport: http(from.rpc) }) as PublicClient,
  };
}

/** Poll Circle until the burn is attested and its mint has been submitted on the destination. */
async function waitForMint(from: BridgeChain, burnTx: string, timeoutMs = 240_000): Promise<string | null> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    await new Promise((r) => setTimeout(r, 2500));
    try {
      const res = await fetch(`${IRIS}/v2/messages/${from.domain}?transactionHash=${burnTx}`);
      if (!res.ok) continue; // 404 until Circle has indexed the burn
      const message = ((await res.json()) as { messages?: Record<string, string | null>[] }).messages?.[0];
      const mintTx = message?.forwardTxHash ?? message?.destinationMintTxHash;
      if (mintTx) return mintTx;
    } catch {
      /* transient network error: keep polling */
    }
  }
  return null;
}

/**
 * Burn `amount` USDC on `from` and have Circle mint it to `recipient` on `to`.
 * Resolves once the mint has been submitted, or with `mintTx` unset if Circle is still working
 * on it after a few minutes (the transfer still completes).
 */
export async function bridge(
  from: BridgeChain,
  to: BridgeChain,
  amount: number,
  recipient: `0x${string}`,
  onProgress: (p: BridgeProgress) => void
): Promise<BridgeProgress> {
  const value = units(amount);
  const { maxFee, threshold } = await quote(from, to, amount);
  if (maxFee >= value) throw new Error("The amount is smaller than the transfer fee");

  const { wallet, address, reader } = await signerOn(from);
  try {
    const balance = await reader.readContract({ address: from.usdc, abi: erc20Abi, functionName: "balanceOf", args: [address] });
    if (balance < value) throw new Error(`Not enough USDC on ${from.name}`);

    const allowance = await reader.readContract({
      address: from.usdc,
      abi: erc20Abi,
      functionName: "allowance",
      args: [address, TOKEN_MESSENGER],
    });
    if (allowance < value) {
      onProgress({ stage: "approve" });
      const { request } = await reader.simulateContract({
        address: from.usdc,
        abi: erc20Abi,
        functionName: "approve",
        args: [TOKEN_MESSENGER, value],
        account: wallet.account!, // the signer itself, so a local key signs locally
      });
      const gas = withHeadroom(await reader.estimateContractGas({ ...request, account: wallet.account! }));
      await reader.waitForTransactionReceipt({ hash: await wallet.writeContract({ ...request, gas }) });
    }

    onProgress({ stage: "burn" });
    const { request } = await reader.simulateContract({
      address: TOKEN_MESSENGER,
      abi: messengerAbi,
      functionName: "depositForBurnWithHook",
      // A zero destination caller lets anyone submit the mint, which is what lets Circle forward it.
      args: [value, to.domain, pad(recipient), from.usdc, zeroHash, maxFee, threshold, FORWARD_HOOK],
      account: wallet.account!,
    });
    const gas = withHeadroom(await reader.estimateContractGas({ ...request, account: wallet.account! }));
    const burnTx = await wallet.writeContract({ ...request, gas });
    await reader.waitForTransactionReceipt({ hash: burnTx });

    onProgress({ stage: "attest", burnTx });
    const mintTx = await waitForMint(from, burnTx);
    const done: BridgeProgress = { stage: "done", burnTx, mintTx: mintTx ?? undefined };
    onProgress(done);
    return done;
  } finally {
    // A browser wallet that was moved to another chain goes back to Arc for trading.
    if (from.key !== ARC.key && useStore.getState().account?.kind === "wallet") {
      await switchTo(wallet, arc).catch(() => undefined);
    }
  }
}
