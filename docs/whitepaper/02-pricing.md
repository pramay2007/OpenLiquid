# How a trade is priced

Every trade fills against one price taken from a reference venue. There is no order book on OpenLiquid and no spread. The one rule that differs from "fill at the mid" is that the engine looks at two prices and gives the trader the worse one.

## Two prices per market

The oracle keeps two numbers for each market.

| Price | What it is | How fast it moves |
|---|---|---|
| `mid` | The latest signed mid from the reference venue (Hyperliquid for crypto, stocks and commodities; Gemini for prediction markets). | Instantly. |
| `slow` | A time-weighted average of the mid. | Only as time passes. |

When a new price arrives, `slow` moves toward the price that was in force since the last update, in proportion to how long it was in force:

```
slow  ←  slow + (held − slow) × dt / (τ + dt)
```

`held` is the previous mid, `dt` is the seconds it was held for, and `τ` is the averaging time of the market (60 seconds for crypto, 120 for stocks and commodities, 300 for prediction markets).

The point of this form is that a price which has only just appeared has `dt = 0`. It changes `mid` at once and does not change `slow` at all. A price has to be held to count.

## The fill rule

```
buy   fills at   max(mid, slow)
sell  fills at   min(mid, slow)
```

Opening a long and closing a short are buys. Opening a short and closing a long are sells.

In a calm market the two prices are the same number, so the fill is the mid with no slippage. That is the normal case.

When the price has just moved, the two differ, and the trader gets the less favourable one. A buyer pays the higher price. A seller receives the lower one.

## Why this stops a pushed price

Take ETH at $3,000 with a 60 second averaging time. Someone pushes the reference mid to $3,003.60, a move of 0.12%.

| Moment | `mid` | `slow` | A long closing (a sell) fills at |
|---|---|---|---|
| Before the push | 3,000.00 | 3,000.00 | 3,000.00 |
| The instant after | 3,003.60 | 3,000.00 | 3,000.00 |
| Push held for 60 s | 3,003.60 | about 3,002.30 | about 3,002.30 |
| Push released | 3,000.00 | above 3,000 and falling | 3,000.00 |

A trader who opened a long before the push and closes into it gets the slow price, which has not moved. To be paid for the push, they have to keep the reference price there. After a full averaging time, `slow` has covered about 63% of the gap. Holding a price on a real venue for a minute means trading against everyone who sees it is wrong, which costs far more than touching it once.

The other direction fails the same way. Shorting the pushed price is a sell, so it fills at `min(mid, slow)`, which is the old price. When the push is released there is nothing to collect.

## Two guards on top

The fill rule already removes the profit. Two further checks stop trades that would only hurt the trader making them.

**Dislocation guard.** New positions are refused while `mid` and `slow` are further apart than a per-market limit: 20 basis points for crypto, 25 for stocks and commodities, 5 points of probability for prediction markets. Closing is always allowed.

**Entry guard.** An open is refused if its fill would start more than 30% of margin under water against the mid. This matters at very high leverage. At 1000×, a gap of 3 basis points between the two prices is already 30% of margin.

## What this costs an honest trader

Worse-of fills are not free. In a market that is trending, `slow` lags `mid`, and a trader following the trend fills at the worse of the two.

| Leverage | Cost of a 3 basis point gap, as a share of margin |
|---|---|
| 10× | 0.3% |
| 100× | 3% |
| 1000× | 30%, and the entry guard refuses the order |

So "no slippage" is true when the market is calm and is not true when it is moving fast. In practice the highest leverage is available in quiet markets and falls away in fast ones. We think that is the right way round.

## Price freshness

A signed price is usable for 60 seconds on Arc. Every trade carries its own freshly signed price in the same transaction, so a trade never depends on someone else having updated the oracle first. A price stamped in the future or older than the last one is ignored.

Next: [Capacity and the vault](03-capacity-and-vault.md)
