import {
  BaseError,
  ContractFunctionRevertedError,
  UserRejectedRequestError,
  createWalletClient,
  custom,
  encodeAbiParameters,
  http,
  maxUint256,
  parseEventLogs,
  parseUnits,
  type Abi,
  type TransactionReceipt,
  type WalletClient,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { abis, addresses, chain, deployment, marketMeta } from "../chain/config";
import { useStore } from "../state/store";
import { publicClient, refreshAll } from "./chain";
import { requestDrip } from "./keeper";
import { fmtPrice, fmtSignedUsd, fmtNumber } from "../lib/format";

const DEMO_KEY = "openliquid.demo.key";
const FAUCET_AMOUNT = 10_000;

let wallet: WalletClient | null = null;

// ---- connecting -----------------------------------------------------------------------------

/** A throwaway key kept in this browser. Test networks only: it signs without prompts. */
export async function connectDemo(fresh = false) {
  const store = useStore.getState();
  useStore.setState({ connecting: true });
  try {
    let key = fresh ? null : (localStorage.getItem(DEMO_KEY) as `0x${string}` | null);
    const isNew = !key;
    if (!key) {
      key = generatePrivateKey();
      localStorage.setItem(DEMO_KEY, key);
    }
    const account = privateKeyToAccount(key);
    wallet = createWalletClient({ account, chain, transport: http() });
    useStore.setState({ account: { address: account.address, kind: "demo" } });
    await requestDrip(account.address);
    await waitForGas(account.address);
    await refreshAll();
    if (isNew && deployment.faucet) {
      await send(addresses.USDC, abis.usdc, "mint", [account.address, parseUnits(String(FAUCET_AMOUNT), 6)]);
      await send(addresses.USDC, abis.usdc, "approve", [addresses.Vault, maxUint256]);
      await refreshAll();
      store.toast({ kind: "success", title: "Demo account ready", body: `${fmtNumber(FAUCET_AMOUNT)} test USDC added` });
    }
  } catch (err) {
    store.toast({ kind: "error", title: "Could not start the demo account", body: explain(err) });
  } finally {
    useStore.setState({ connecting: false });
  }
}

async function waitForGas(address: `0x${string}`) {
  for (let i = 0; i < 20; i++) {
    if ((await publicClient.getBalance({ address })) > 0n) return;
    await new Promise((r) => setTimeout(r, 500));
  }
}

export async function connectInjected() {
  const store = useStore.getState();
  const eth = (window as unknown as { ethereum?: Parameters<typeof custom>[0] }).ethereum;
  if (!eth) {
    store.toast({ kind: "info", title: "No browser wallet found", body: "Use the demo account, or install a wallet." });
    return;
  }
  useStore.setState({ connecting: true });
  try {
    const client = createWalletClient({ chain, transport: custom(eth) });
    const [address] = await client.requestAddresses();
    try {
      await client.switchChain({ id: chain.id });
    } catch {
      await client.addChain({ chain });
    }
    wallet = createWalletClient({ account: address, chain, transport: custom(eth) });
    useStore.setState({ account: { address, kind: "wallet" } });
    await refreshAll();
  } catch (err) {
    store.toast({ kind: "error", title: "Wallet connection failed", body: explain(err) });
  } finally {
    useStore.setState({ connecting: false });
  }
}

export function disconnect() {
  wallet = null;
  useStore.setState({ account: null, positions: [], balances: { usdc: 0, olq: 0, gas: 0, allowance: 0 } });
}

export function restoreSession() {
  if (localStorage.getItem(DEMO_KEY)) void connectDemo();
}

// ---- transactions ---------------------------------------------------------------------------

async function send(address: `0x${string}`, abi: Abi, functionName: string, args: unknown[]): Promise<TransactionReceipt> {
  if (!wallet?.account) throw new Error("Connect an account first");
  const { request } = await publicClient.simulateContract({ address, abi, functionName, args, account: wallet.account });
  const hash = await wallet.writeContract(request);
  return publicClient.waitForTransactionReceipt({ hash });
}

const REASONS: Record<string, string> = {
  SideCapExceeded: "That side is at its depth-backed capacity. Try a smaller size.",
  PriceDislocated: "Opens are paused while the price is moving fast. Try again in a moment.",
  EntryTooFarFromMid: "The price is moving fast. Lower the leverage or try again in a moment.",
  StalePrice: "No fresh price for this market yet.",
  BadLeverage: "Leverage is above this market's current limit.",
  BadMargin: "Margin is below the minimum.",
  PositionTooLarge: "Position is above the per-position limit.",
  InsufficientLiquidity: "The vault cannot reserve the full payout for a position this large.",
  MarketResolved: "This market has resolved.",
  MarketDisabled: "This market is not open for trading.",
  EventPriceOutOfRange: "This market is within a tick of 0 or 1; new positions are closed.",
  NotOwner: "This position belongs to another account.",
  NoPosition: "This position is already closed.",
  ERC20InsufficientBalance: "Not enough USDC.",
  ERC20InsufficientAllowance: "USDC is not approved for trading yet.",
  ERC4626ExceededMaxWithdraw: "More than can be withdrawn right now: part of the vault is locked against open positions.",
  ERC4626ExceededMaxRedeem: "More than can be withdrawn right now: part of the vault is locked against open positions.",
};

export function explain(err: unknown): string {
  if (err instanceof BaseError) {
    if (err.walk((e) => e instanceof UserRejectedRequestError)) return "Cancelled in the wallet.";
    const revert = err.walk((e) => e instanceof ContractFunctionRevertedError);
    if (revert instanceof ContractFunctionRevertedError) {
      const name = revert.data?.errorName ?? revert.reason ?? "";
      return REASONS[name] ?? (name || "The transaction would revert.");
    }
    return err.shortMessage;
  }
  return err instanceof Error ? err.message : String(err);
}

/** The freshest signed price for a market, encoded for the engine's `priceData` argument. */
function priceDataFor(marketId: number): `0x${string}` {
  const live = useStore.getState().live[marketId];
  if (!live) return "0x";
  return encodeAbiParameters(
    [
      {
        type: "tuple[]",
        components: [
          { name: "marketId", type: "uint32" },
          { name: "price", type: "uint256" },
          { name: "depthUsd", type: "uint256" },
          { name: "timestamp", type: "uint64" },
          { name: "resolved", type: "bool" },
        ],
      },
      { type: "bytes[]" },
    ],
    [
      [
        {
          marketId: live.update.marketId,
          price: BigInt(live.update.price),
          depthUsd: BigInt(live.update.depthUsd),
          timestamp: BigInt(live.update.timestamp),
          resolved: live.update.resolved,
        },
      ],
      [live.sig],
    ]
  );
}

async function ensureAllowance(token: `0x${string}`, abi: Abi, spender: `0x${string}`, amount: bigint) {
  const owner = wallet!.account!.address;
  const current = (await publicClient.readContract({ address: token, abi, functionName: "allowance", args: [owner, spender] })) as bigint;
  if (current < amount) await send(token, abi, "approve", [spender, maxUint256]);
}

/** Run an action, toast the outcome, refresh state. Returns true on success. */
async function run(title: string, action: () => Promise<{ title: string; body?: string } | void>): Promise<boolean> {
  const { toast } = useStore.getState();
  try {
    const result = await action();
    if (result) toast({ kind: "success", ...result });
    return true;
  } catch (err) {
    toast({ kind: "error", title, body: explain(err) });
    return false;
  } finally {
    void refreshAll();
  }
}

export function openPosition(marketId: number, isLong: boolean, margin: number, leverage: number) {
  const meta = marketMeta.get(marketId)!;
  return run("Order not placed", async () => {
    const amount = parseUnits(margin.toFixed(6), 6);
    await ensureAllowance(addresses.USDC, abis.usdc, addresses.Vault, amount);
    const receipt = await send(addresses.PerpEngine, abis.engine, "open", [marketId, isLong, amount, leverage, priceDataFor(marketId)]);
    const [log] = parseEventLogs({ abi: abis.engine, logs: receipt.logs, eventName: "PositionOpened" }) as unknown as {
      args: { entryPrice: bigint; notional: bigint };
    }[];
    const entry = log ? Number(log.args.entryPrice) / 1e18 : NaN;
    const side = meta.kind === "event" ? (isLong ? "Yes" : "No") : isLong ? "Long" : "Short";
    return { title: `${side} ${meta.symbol.split("-")[0]} opened`, body: `${leverage}× at ${fmtPrice(entry, meta)}` };
  });
}

export function closePosition(id: bigint, marketId: number) {
  const meta = marketMeta.get(marketId)!;
  return run("Close failed", async () => {
    const receipt = await send(addresses.PerpEngine, abis.engine, "close", [id, priceDataFor(marketId)]);
    const [log] = parseEventLogs({ abi: abis.engine, logs: receipt.logs, eventName: "PositionClosed" }) as unknown as {
      args: { pnl: bigint; fee: bigint; payout: bigint; olqMinted: bigint; exitPrice: bigint };
    }[];
    if (!log) return { title: "Position closed" };
    const fee = Number(log.args.fee) / 1e6;
    const net = Number(log.args.pnl) / 1e6 - fee;
    const minted = Number(log.args.olqMinted) / 1e18;
    const parts = [`at ${fmtPrice(Number(log.args.exitPrice) / 1e18, meta)}`];
    if (minted > 0) parts.push(`${fmtNumber(minted, 1)} OLQ earned`);
    return { title: `Closed ${fmtSignedUsd(net)}`, body: parts.join(" · ") };
  });
}

export function faucet() {
  return run("Faucet failed", async () => {
    await send(addresses.USDC, abis.usdc, "mint", [wallet!.account!.address, parseUnits(String(FAUCET_AMOUNT), 6)]);
    return { title: `${fmtNumber(FAUCET_AMOUNT)} test USDC added` };
  });
}

export function vaultDeposit(amount: number) {
  return run("Deposit failed", async () => {
    const assets = parseUnits(amount.toFixed(6), 6);
    await ensureAllowance(addresses.USDC, abis.usdc, addresses.Vault, assets);
    await send(addresses.Vault, abis.vault, "deposit", [assets, wallet!.account!.address]);
    return { title: "Deposited to the vault", body: `$${fmtNumber(amount, 2)}` };
  });
}

export function vaultWithdraw(amount: number) {
  return run("Withdrawal failed", async () => {
    const me = wallet!.account!.address;
    await send(addresses.Vault, abis.vault, "withdraw", [parseUnits(amount.toFixed(6), 6), me, me]);
    return { title: "Withdrawn from the vault", body: `$${fmtNumber(amount, 2)}` };
  });
}

export function stake(amount: number) {
  return run("Stake failed", async () => {
    const value = parseUnits(amount.toFixed(18), 18);
    await ensureAllowance(addresses.OpenLiquidToken, abis.token, addresses.Staking, value);
    await send(addresses.Staking, abis.staking, "stake", [value]);
    return { title: "OLQ staked", body: fmtNumber(amount, 2) };
  });
}

export function unstake(amount: number) {
  return run("Unstake failed", async () => {
    await send(addresses.Staking, abis.staking, "unstake", [parseUnits(amount.toFixed(18), 18)]);
    return { title: "OLQ unstaked", body: fmtNumber(amount, 2) };
  });
}

export function claimFees() {
  return run("Claim failed", async () => {
    await send(addresses.Staking, abis.staking, "claim", []);
    return { title: "Fees claimed" };
  });
}
