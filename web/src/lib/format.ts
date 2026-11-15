import type { MarketMeta } from "../chain/config";

const nf = (min: number, max: number) =>
  new Intl.NumberFormat("en-US", { minimumFractionDigits: min, maximumFractionDigits: max });

/** Decimals that keep about five significant figures across the price range we list. */
export function priceDecimals(price: number): number {
  if (!Number.isFinite(price) || price <= 0) return 2;
  if (price >= 10_000) return 1;
  if (price >= 100) return 2;
  if (price >= 1) return 3;
  return 4;
}

export function fmtPrice(price: number | null | undefined, market?: Pick<MarketMeta, "kind">): string {
  if (price == null || !Number.isFinite(price)) return "—";
  if (market?.kind === "event") return `${nf(1, 1).format(price * 100)}¢`;
  const d = priceDecimals(price);
  return nf(d, d).format(price);
}

export function fmtUsd(value: number | null | undefined, decimals = 2): string {
  if (value == null || !Number.isFinite(value)) return "—";
  const sign = value < 0 ? "−" : "";
  return `${sign}$${nf(decimals, decimals).format(Math.abs(value))}`;
}

export function fmtSignedUsd(value: number, decimals = 2): string {
  const sign = value > 0 ? "+" : value < 0 ? "−" : "";
  return `${sign}$${nf(decimals, decimals).format(Math.abs(value))}`;
}

export function fmtCompactUsd(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  const abs = Math.abs(value);
  if (abs >= 1e9) return `$${nf(2, 2).format(value / 1e9)}B`;
  if (abs >= 1e6) return `$${nf(2, 2).format(value / 1e6)}M`;
  if (abs >= 1e4) return `$${nf(1, 1).format(value / 1e3)}K`;
  return `$${nf(0, 0).format(value)}`;
}

export function fmtPct(fraction: number | null | undefined, decimals = 2, signed = true): string {
  if (fraction == null || !Number.isFinite(fraction)) return "—";
  const sign = !signed ? "" : fraction > 0 ? "+" : fraction < 0 ? "−" : "";
  return `${sign}${nf(decimals, decimals).format(Math.abs(fraction) * 100)}%`;
}

export function fmtNumber(value: number, decimals = 0): string {
  return nf(decimals, decimals).format(value);
}

export function fmtDuration(seconds: number): string {
  if (seconds <= 0) return "now";
  const d = Math.floor(seconds / 86_400);
  const h = Math.floor((seconds % 86_400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

export const shortAddress = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
