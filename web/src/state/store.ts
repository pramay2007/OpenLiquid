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
  /** Event markets: a position may pay a premium to keep the leveraged win (the market's Boost scale is above zero). */
  boostEnabled: boolean;
  maxLeverage: number;
  maxProfitMult: number;
  profitFeeBps: number;
  maxGapBps: number;
  /** Event markets: unix seconds at which trading stops and positions wait for the result. */
  expiry: number;
  /** Event markets: unix seconds of the next scheduled information event; 0 means the expiry. */
  nextEvent: number;
  /** Event markets: past expiry and waiting for the result. Nothing opens or closes at a price. */
  closed: boolean;
  /** Event markets: reaction time, in seconds, in the time-based leverage limit. */
  reactionSeconds: number;
  /** Event markets: the least distance from entry to either line, as a price (0.05 = 5 cents). */
  minDistance: number;
  /** Event markets: multiple of the implied hazard charged to the crowded side. Zero means no crowding fee. */
  crowdingScale: number;
  /** Event markets: multiple of the implied hazard charged for Boost. Zero means no Boost. */
  boostScale: number;
  maxPositionNotional: number;
  longOI: number;
  shortOI: number;
  mid: number;
  slow: number;
  timestamp: number;
  resolved: boolean;
  sideCap: number;
  /** The most leverage a new position may take right now (the same on both sides). */
  maxLevLong: number;
  maxLevShort: number;
  /**
   * Crowding fee the next day would add at the current state, per side. Zero on the uncrowded side.
   * Event markets: USDC per borrowed share. Other markets: a fraction of notional.
   */
  feePerDayLong: number;
  feePerDayShort: number;
  /** Event markets: Boost premium per borrowed share per day, in USDC. The same for Yes and No. */
  boostPerDay: number;
}

export interface PositionRow {
  id: bigint;
  marketId: number;
  isLong: boolean;
  openedAt: number;
  margin: number;
  notional: number;
  entryPrice: number;
  /** The most this position can be paid in profit. */
  reserve: number;
  boosted: boolean;
  liquidationPrice: number;
  /** Price at which the position reaches its maximum profit. */
  winPrice: number;
  /** Crowding fee accrued so far, in USD. It comes out of the stake. */
  crowdingFee: number;
  /** Boost premium accrued so far, in USD. It comes out of the stake. */
  boostPremium: number;
  liquidatable: boolean;
  /** At its maximum profit: closing now pays it in full. */
  collectable: boolean;
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
  /** Seconds after a deposit before the depositor's shares can be withdrawn. */
  withdrawDelay: number;
  /** Unix seconds at which the connected account's shares unlock; 0 if they are not locked. */
  lockedUntil: number;
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

export type Page = "home" | "trade" | "predict" | "earn" | "bridge" | "mechanics" | "docs";

interface Store {
  page: Page;
  selected: number;
  /** Whitepaper page being read, by slug; empty means the first page. */
  doc: string;
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
  openDoc: (slug: string) => void;
  toast: (t: Omit<Toast, "id">) => void;
  dismiss: (id: number) => void;
}

let toastId = 1;

// Deep links: #earn, #bridge, #mechanics, #docs/<page>, or #m/<marketId> for a market on the
// trade page. No hash is the opening page.
function fromHash(): { page: Page; selected: number; doc: string } {
  const first = deployment.markets[0]?.id ?? 1;
  const hash = typeof location === "undefined" ? "" : location.hash.slice(1);
  if (!hash) return { page: "home", selected: first, doc: "" };
  if (hash === "earn" || hash === "mechanics" || hash === "bridge" || hash === "predict") {
    return { page: hash, selected: first, doc: "" };
  }
  const doc = /^docs(?:\/([\w-]+))?$/.exec(hash);
  if (doc) return { page: "docs", selected: first, doc: doc[1] ?? "" };
  const id = Number(/^m\/(\d+)$/.exec(hash)?.[1]);
  return { page: "trade", selected: deployment.markets.some((m) => m.id === id) ? id : first, doc: "" };
}
const toHash = (page: Page, selected: number, doc = "") =>
  history.replaceState(
    null,
    "",
    page === "home"
      ? location.pathname + location.search
      : page === "trade"
        ? `#m/${selected}`
        : page === "docs" && doc
          ? `#docs/${doc}`
          : `#${page}`
  );

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
    toHash(page, get().selected, get().doc);
    set({ page });
  },
  openDoc: (doc) => {
    toHash("docs", get().selected, doc);
    set({ page: "docs", doc });
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

// A link typed, pasted or reached with the back button changes the page without a reload.
if (typeof window !== "undefined") {
  window.addEventListener("hashchange", () => useStore.setState(fromHash()));
}

/** The feed the UI trades against: live keeper mid where available, on-chain slow price. */
export function feedOf(state: Pick<Store, "live" | "markets">, id: number): { mid: number; slow: number } | null {
  const m = state.markets[id];
  const mid = state.live[id]?.mid ?? m?.mid;
  if (mid == null || !Number.isFinite(mid)) return null;
  return { mid, slow: m?.slow || mid };
}
