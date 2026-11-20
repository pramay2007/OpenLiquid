// Display-side mirror of the engine's arithmetic (PerpEngine.sol). The chain is the authority;
// these are used to preview a trade and to move PnL smoothly between on-chain reads.

export interface FeedLike {
  mid: number;
  slow: number;
}

/** Worse-of fill: buys at the higher of mid and slow, sells at the lower. */
export function fillPrice(feed: FeedLike, isBuy: boolean): number {
  return isBuy ? Math.max(feed.mid, feed.slow) : Math.min(feed.mid, feed.slow);
}

export function pnl(isEvent: boolean, isLong: boolean, notional: number, entry: number, exit: number): number {
  if (isLong) return (notional * (exit - entry)) / entry;
  if (isEvent) return (notional * (entry - exit)) / (1 - entry);
  return (notional * (entry - exit)) / entry;
}

/** Price at which equity reaches the maintenance level (maintFraction of margin). */
export function liquidationPrice(
  isEvent: boolean,
  isLong: boolean,
  entry: number,
  leverage: number,
  maintFraction: number
): number {
  const frac = (1 - maintFraction) / leverage; // adverse move as a fraction of notional
  if (isLong) return Math.max(0, entry * (1 - frac));
  if (isEvent) return Math.min(1, entry + (1 - entry) * frac);
  return entry * (1 + frac);
}

/**
 * The most a position can make: the reserve the vault locks for it. Event markets are handled by
 * lib/corridor.ts; this is the rule for every other market, a 100% move or the margin ceiling.
 */
export function maxProfit(margin: number, notional: number, maxProfitMult: number): number {
  return Math.min(margin * maxProfitMult, notional);
}

/** Leverage slider position (0..1) to leverage and back, on a log scale. */
export function sliderToLeverage(t: number, max: number): number {
  if (max <= 1) return 1;
  const raw = Math.exp(Math.log(max) * Math.min(1, Math.max(0, t)));
  if (raw < 10) return Math.max(1, Math.round(raw));
  if (raw < 100) return Math.round(raw / 5) * 5;
  return Math.min(max, Math.round(raw / 25) * 25);
}

export function leverageToSlider(leverage: number, max: number): number {
  if (max <= 1) return 0;
  return Math.log(Math.max(1, leverage)) / Math.log(max);
}
