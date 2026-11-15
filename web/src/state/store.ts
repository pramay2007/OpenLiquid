import { create } from "zustand";
import { deployment } from "../chain/config";

export interface SignedUpdate {
  marketId: number;
  price: string;
  depthUsd: string;
  timestamp: number;
  resolved: boolean;
}

export interface LivePrice {
  mid: number;
  depthUsd: number;
  update: SignedUpdate;
  sig: `0x${string}`;
}

/** One market as the engine sees it right now. USD amounts and prices are plain numbers. */
export interface MarketState {
  id: number;
  enabled: boolean;
  isEvent: boolean;
  maxLeverage: number;
  maxProfitMult: number;
  profitFeeBps: number;
  maxGapBps: number;
  expiry: number;
  compressWindow: number;
  maxPositionNotional: number;
  longOI: number;
  shortOI: number;
  mid: number;
  slow: number;
  timestamp: number;
  resolved: boolean;
  sideCap: number;
  maxLevLong: number;
  maxLevShort: number;
  fundingPerDay: number;
}

export interface PositionRow {
  id: bigint;
  marketId: number;
  isLong: boolean;
  openedAt: number;
  margin: number;
  notional: number;
  entryPrice: number;
  reserve: number;
  liquidationPrice: number;
  /** Funding and borrow accrued so far, in USD. Positive means the trader pays. */
  carry: number;
  liquidatable: boolean;
}

export interface Account {
  address: `0x${string}`;
  kind: "demo" | "wallet";
}

export interface Balances {
  usdc: number;
  olq: number;
  gas: number;
  allowance: number;
}

export interface VaultState {
  totalAssets: number;
  cash: number;
  marginHeld: number;
  reserved: number;
  free: number;
  sharePrice: number;
  myShares: bigint;
  myAssets: number;
  myMaxWithdraw: number;
}

export interface StakingState {
  totalStaked: number;
  myStaked: number;
  myPending: number;
  totalSupply: number;
  maxSupply: number;
  cumulativeFees: number;
  mintRate: number; // OLQ per 1 USDC of fee right now
}

export interface EngineParams {
  maintFraction: number;
  liqFeeFraction: number;
  stakerShare: number;
  minMargin: number;
}

export interface Toast {
  id: number;
  kind: "success" | "error" | "info";
  title: string;
  body?: string;
}

export type Page = "trade" | "earn" | "mechanics";

interface Store {
  page: Page;
  selected: number;
  live: Record<number, LivePrice>;
  markets: Record<number, MarketState>;
  summary: Record<number, { prevDay: number }>;
  sparks: Record<number, number[]>;
  keeperOnline: boolean;
  chainOnline: boolean;
  account: Account | null;
  connecting: boolean;
  balances: Balances;
  positions: PositionRow[];
  vault: VaultState | null;
  staking: StakingState | null;
  params: EngineParams;
  toasts: Toast[];
  setPage: (page: Page) => void;
  select: (id: number) => void;
  toast: (t: Omit<Toast, "id">) => void;
  dismiss: (id: number) => void;
}

let toastId = 1;

// Deep links: #earn, #mechanics, or #m/<marketId> for a market on the trade page.
function fromHash(): { page: Page; selected: number } {
  const first = deployment.markets[0]?.id ?? 1;
  const hash = typeof location === "undefined" ? "" : location.hash.slice(1);
  if (hash === "earn" || hash === "mechanics") return { page: hash, selected: first };
  const id = Number(/^m\/(\d+)$/.exec(hash)?.[1]);
  return { page: "trade", selected: deployment.markets.some((m) => m.id === id) ? id : first };
}
const toHash = (page: Page, selected: number) =>
  history.replaceState(null, "", page === "trade" ? `#m/${selected}` : `#${page}`);

export const useStore = create<Store>((set, get) => ({
  ...fromHash(),
  live: {},
  markets: {},
  summary: {},
  sparks: {},
  keeperOnline: false,
  chainOnline: false,
  account: null,
  connecting: false,
  balances: { usdc: 0, olq: 0, gas: 0, allowance: 0 },
  positions: [],
  vault: null,
  staking: null,
  params: { maintFraction: 0.2, liqFeeFraction: 0.05, stakerShare: 0.3, minMargin: 1 },
  toasts: [],
  setPage: (page) => {
    toHash(page, get().selected);
    set({ page });
  },
  select: (selected) => {
    toHash("trade", selected);
    set({ selected, page: "trade" });
  },
  toast: (t) => {
    const id = toastId++;
    set({ toasts: [...get().toasts, { ...t, id }] });
    setTimeout(() => get().dismiss(id), t.kind === "error" ? 6500 : 4500);
  },
  dismiss: (id) => set({ toasts: get().toasts.filter((t) => t.id !== id) }),
}));

/** The feed the UI trades against: live keeper mid where available, on-chain slow price. */
export function feedOf(state: Pick<Store, "live" | "markets">, id: number): { mid: number; slow: number } | null {
  const m = state.markets[id];
  const mid = state.live[id]?.mid ?? m?.mid;
  if (mid == null || !Number.isFinite(mid)) return null;
  return { mid, slow: m?.slow || mid };
}
