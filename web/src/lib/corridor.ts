// Event-market position arithmetic, mirroring PerpEngine.sol. The chain is the authority; these
// are for previews and explanations. Prices are YES prices between 0 and 1.
//
// A leveraged position on an event market has two lines. It is paid in full when the odds reach
// its win line and it is stopped out near its stop line. In free mode a leveraged position wins
// what the same stake would win outright, and never more than the stake itself, so leverage
// brings the lines closer together without raising the payout. With Boost the win line moves out
// to the leveraged win.

export interface CorridorInput {
  /** Current YES price, 0..1. */
  price: number;
  isYes: boolean;
  margin: number;
  leverage: number;
  boost: boolean;
  /** Share of margin left at which the position is liquidated (0.2). */
  maintFraction: number;
  /** Ceiling on a boosted position's profit as a multiple of margin (10). */
  maxProfitMult: number;
}

export interface Corridor {
  /** Price of the side being bought: the YES price for Yes, one minus it for No. */
  sidePrice: number;
  notional: number;
  shares: number;
  /** Shares financed by leverage; the base for the crowding fee and the Boost premium. */
  borrowedShares: number;
  /** The most the position can be paid in profit. */
  maxWin: number;
  /** What the same stake would win held outright to a winning result. */
  outrightWin: number;
  /** YES price at which the maximum win is reached. */
  winLine: number;
  /** YES price at which the stake is gone. */
  stopLine: number;
  /** YES price at which the position is liquidated, with the remaining stake returned. */
  liqLine: number;
  /** A 1x position is a plain purchase of shares: it is never liquidated and rides to the result. */
  neverLiquidated: boolean;
}

/** Mirrors PerpEngine._reserveFor for event markets. */
export function eventMaxWin(
  sidePrice: number,
  margin: number,
  leverage: number,
  boost: boolean,
  maxProfitMult: number
): number {
  if (!(sidePrice > 0)) return 0;
  const odds = (1 - sidePrice) / sidePrice; // what one dollar wins outright
  const outright = margin * odds;
  if (boost && leverage > 1) return Math.min(margin * maxProfitMult, margin * leverage * odds);
  if (leverage <= 1) return outright; // a plain purchase of shares, with no ceiling
  return Math.min(margin, outright);
}

export function corridor(i: CorridorInput): Corridor {
  const sidePrice = i.isYes ? i.price : 1 - i.price;
  const leverage = Math.max(1, i.leverage);
  const notional = i.margin * leverage;
  const shares = sidePrice > 0 ? notional / sidePrice : 0;
  const outrightWin = sidePrice > 0 ? (i.margin * (1 - sidePrice)) / sidePrice : 0;
  const maxWin = eventMaxWin(sidePrice, i.margin, leverage, i.boost, i.maxProfitMult);
  // In the side's own price the position wins after +maxWin/shares and is flat broke after -margin/shares.
  const up = shares > 0 ? maxWin / shares : 0;
  const down = shares > 0 ? i.margin / shares : 0;
  const toYes = (side: number) => (i.isYes ? side : 1 - side);
  const neverLiquidated = leverage <= 1;
  return {
    sidePrice,
    notional,
    shares,
    borrowedShares: shares * (1 - 1 / leverage),
    maxWin,
    outrightWin,
    winLine: toYes(Math.min(1, sidePrice + up)),
    stopLine: toYes(Math.max(0, sidePrice - down)),
    liqLine: neverLiquidated ? toYes(0) : toYes(Math.max(0, sidePrice - down * (1 - i.maintFraction))),
    neverLiquidated,
  };
}

/**
 * The most leverage a new position may take, mirroring PerpEngine._maxLeverage: both lines at
 * least `minDistance` from entry, and the stop line three standard deviations of the price's
 * expected movement over the reaction time away, where a probability's variance over h seconds is
 * p(1-p)h/tau. `secondsToEvent` runs to the market's next scheduled information event.
 */
export function maxEventLeverage(
  price: number,
  secondsToEvent: number,
  reactionSeconds: number,
  ceiling: number,
  minDistance = 0.05
): number {
  if (secondsToEvent <= 0) return 1;
  const dist = Math.min(price, 1 - price);
  let lev = Math.min(ceiling, Math.floor(dist / minDistance + 1e-9));
  if (reactionSeconds > 0) {
    const sd = Math.sqrt((price * (1 - price) * reactionSeconds) / secondsToEvent);
    lev = Math.min(lev, Math.floor(dist / (3 * sd) + 1e-9));
  }
  return Math.max(1, lev);
}

/**
 * The implied hazard: USDC per borrowed share per day at scale 1. It is p(1-p) / days left, the
 * same for Yes and No. A Boost pays `boostScale` times it on every borrowed share; a free
 * position on a fully one-sided book pays `crowdingScale` times it.
 */
export function hazardPerShareDay(price: number, secondsToExpiry: number, scale = 1): number {
  const days = Math.max(secondsToExpiry, 3600) / 86_400;
  return (scale * price * (1 - price)) / days;
}
