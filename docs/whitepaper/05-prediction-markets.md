# Prediction-market perpetuals

OpenLiquid lists live contracts from Gemini Prediction Markets as leveraged markets. A trader can take a position on "Arsenal to beat Dortmund" or "BTC above $60,000 on 30 November" with leverage, and close it at any time before the outcome is known.

A binary market cannot be listed on a perpetuals engine unchanged. The price lives between 0 and 1, moves in one-cent ticks, sits on a thin book, and jumps to exactly 0 or 1 at the end. Event markets here run on the same engine with five rules of their own.

## 1. A short is a long on No

On an ordinary market, a short loses without limit as the price rises. On a binary market that makes no sense: the price cannot go above 1.

So a short position is treated as buying the No side at `1 − price`. Its profit is measured on the No price.

```
Yes position:  profit = size × (exit − entry) / entry
No position:   profit = size × (entry − exit) / (1 − entry)
```

A position at 1× on either side is fully paid for. It can lose what was put in and no more, whatever happens.

## 2. Leverage is bounded by the tick

A leveraged Yes position bought at price `p` loses its margin after a fall of `p / leverage`. If that distance is smaller than a tick or two, the position can be wiped out by the smallest possible move.

Maximum leverage keeps that distance at two ticks or more:

```
Yes:  maximum leverage = price / 0.02
No:   maximum leverage = (1 − price) / 0.02
```

| Contract price | Maximum leverage, Yes | Maximum leverage, No |
|---|---|---|
| 20¢ | 10× | 40× |
| 50¢ | 25× | 25× |
| 80¢ | 40× | 10× |

The overall ceiling is 50×. New positions are not accepted when the price is within one cent of 0 or 1.

## 3. Leverage compresses before the outcome

The dangerous moment is the one where the price jumps. For a match that starts at kickoff; for a price-threshold contract it is the approach to expiry.

Over the last 24 hours before that moment, the maximum leverage falls in a straight line to 1×. A position that is above the current limit can be closed by anyone. This is not a liquidation: the trader receives the normal closing price and pays no penalty.

## 4. Settlement

When Gemini reports the contract as settled, the keeper signs the final price, 0 or 1, and marks the market resolved. From then on anyone can settle any position at that price. No further price updates are accepted for the market.

## 5. Costs

Event markets carry more risk for the vault, and are priced for it.

| | Event markets | For comparison, crypto |
|---|---|---|
| Averaging time of the slow price | 300 seconds | 60 seconds |
| Profit fee | 10% | 5% |
| Borrow fee | 0.2% a day on notional minus margin | None |
| Maximum funding at full skew | 0.10% a day | 0.05% a day |
| Per-position limit | $100k | $10M |

Capacity follows the Gemini book: open interest per side is limited to twice the dollars resting within five ticks of the mid.

## Where the data comes from

All of it is Gemini's public market-data API, with no key.

| Use | Endpoint |
|---|---|
| Choosing which contracts to list | `GET /v1/prediction-markets/events` |
| Price and depth, every 4 seconds | `GET /v1/book/{symbol}` |
| Chart history | `GET /v2/candles/{symbol}/1hr` |
| Detecting settlement | `GET /v1/prediction-markets/events/{ticker}` |

Contracts are chosen by a script, not by hand: they must resolve at least six days out, trade between 20¢ and 80¢, have a spread of two ticks or less, and are ranked by resting depth.

## What is not solved

A binary market can jump to 0 or 1 on news while leverage is still high. Losses stop at margin, so the part of the jump beyond a trader's margin falls on the vault. A trader holding leveraged Yes and leveraged No through such a jump collects on one and loses only margin on the other. The profit cap, the capacity limit, tick-bounded leverage and the borrow fee bound and price this. They do not remove it. See [Risks and assumptions](09-risks.md).

Next: [The OLQ token](06-olq-token.md)
