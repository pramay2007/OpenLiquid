# OpenLiquid

OpenLiquid is a venue for leveraged trading on crypto, stocks, commodities and live prediction markets, in one place, on Arc. Every trade fills at one price taken from a reference venue. There is no order book, and in a calm market there is no slippage.

## Why it exists

Trading should have one price. On an order book the price you see is not the price you get. There is a spread, the book thins out when the market moves, and a larger order fills worse than a smaller one. A trader pays for all of that without ever seeing a fee.

OpenLiquid removes the book. Every trade fills at a single price taken from the deepest market for that asset. In a calm market that is the mid, with no spread and no slippage, at any size the market has room for.

Leverage should be real. A small account should be able to take a real position: at 1000×, $10 controls $10,000 for a short move. With one price and no book to walk, the leverage on the screen is the leverage you get.

Trading should be cheap to try. There is no fee to open or close a position and no funding between traders. A winner pays a share of the profit. The only holding cost is a small fee on the crowded side of a market, paid to the vault that carries the other side of it.

The same engine should work for anything with a price. That includes prediction markets, which until now have had almost no leverage at all.

## The problem that had to be solved

A venue that fills at a price from somewhere else has one obvious weakness. Anyone who can move that price for a moment can trade against the move. Pushing a reference price by a tenth of a percent for a minute can cost tens of thousands of dollars and, against a venue that fills any size at the mid, pay hundreds of thousands.

The rules below exist so that this does not pay, so that winners are always paid, and so that the venue cannot owe more than it holds.

## The rules, in one table

| Rule | What it does |
|---|---|
| [Worse-of fills](02-pricing.md) | Each trade fills at the worse, for the trader, of the live mid and a slow time-averaged price. Calm market: the same number, no slippage. Pushed price: it cannot be traded against. |
| [Depth-backed capacity](03-capacity-and-vault.md) | Open interest per side is capped at half the dollars really resting near the mid on the reference venue, and that depth has to stay there to count. |
| [Reserved payouts](03-capacity-and-vault.md) | A funded vault locks each position's maximum profit when it opens. Winners are paid at close. |
| [No fee to trade](04-fees-funding-liquidation.md) | No fee to open or close, and no funding. A share of profit from winners, and a crowding fee on the larger side of a lopsided market. |
| [Softer liquidation](04-fees-funding-liquidation.md) | Liquidation at 20% of margin left, and what remains goes back to the trader. |
| [Leverage that zooms the odds](05-prediction-markets.md) | On prediction markets a leveraged bet wins at most what its stake would win outright, never more than the stake, and reaches it sooner. A jump cannot leave the vault short. Boost keeps the leveraged win for a daily premium. |
| [Stress-tested by agents](09-risks.md) | A group of adversarial AI agents attacked the rules before deployment. What they broke was changed, and what is still open is listed. |
| [The OLQ token](06-olq-token.md) | OLQ is earned by losing, faster when the vault is drawn down. Stakers earn fees from winners. |

## What you can trade

| Type | Markets | Price source | Maximum leverage |
|---|---|---|---|
| Crypto | BTC, ETH, SOL, HYPE | Hyperliquid | 1000× |
| Stocks and indices | Nasdaq 100, NVDA, TSLA, AAPL | Hyperliquid | 1000× |
| Commodities | Gold, silver, oil | Hyperliquid | 1000× |
| Prediction markets | Five live Gemini contracts | Gemini Prediction Markets | Up to 10×, or 5× on sports. Lower near 0 and 1 and as the result nears |

## Who is involved

**Traders** post USDC margin, choose a side and a leverage, and trade against the vault.

**Liquidity providers** deposit USDC into the vault. They are the other side of every trade: they collect trader losses and most of the fees, and they pay trader wins. Shares can be withdrawn ten minutes after a deposit.

**Stakers** stake OLQ and receive 30% of profit fees in USDC. They take no trading risk.

**The keeper** reads reference prices, signs them, and carries out liquidations, payouts at the win line and settlements. It holds no user funds and has no special powers over the contracts.

## Why Arc

Everything on OpenLiquid is in dollars: margin, profit, fees, the vault, staking rewards. On Arc the gas is in dollars too, because USDC is the native token. A trader never needs a second asset. See [Oracle, keeper and Arc](08-oracle-keeper-arc.md).

## Status

OpenLiquid is live on Arc testnet. It is a prototype built for the University Blockchain Conference 2026 hackathon. It is unaudited and uses test funds only. Nothing here is an offer of a financial product.

Next: [How a trade is priced](02-pricing.md)
