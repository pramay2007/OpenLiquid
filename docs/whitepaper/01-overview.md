# OpenLiquid

OpenLiquid is a venue for leveraged trading on crypto, stocks, commodities and live prediction markets, in one place, on Arc. Every trade fills at one price taken from a reference venue. There is no order book. A position can lose its margin and nothing more.

## The idea, and its problem

In October 2026 Papertrade showed how much people want this: up to 1000× leverage, any size filled at a reference mid price, no slippage, no fees to get in. It took billions of dollars of volume in its first days.

It also showed the problem. If a venue fills any size at a price from somewhere else, then anyone who can move that price for a moment can be paid for it. On launch day one trader reportedly spent about $52,000 moving the reference price by 0.12% and took about $1.28M.

OpenLiquid keeps the experience and changes the rules underneath, so that the trade stops paying.

## The rules, in one table

| Rule | What it does |
|---|---|
| [Worse-of fills](02-pricing.md) | Each trade fills at the worse, for the trader, of the live mid and a slow time-weighted price. Calm market: the same number, no slippage. Pushed price: it cannot be traded against. |
| [Depth-backed capacity](03-capacity-and-vault.md) | Open interest per side is capped at a multiple of the dollars really resting near the mid on the reference venue. |
| [Reserved payouts](03-capacity-and-vault.md) | A funded vault locks each position's maximum profit when it opens. Winners are paid at close. There is no queue. |
| [Skew funding](04-fees-funding-liquidation.md) | The crowded side pays the other side. |
| [Softer liquidation](04-fees-funding-liquidation.md) | Liquidation at 20% of margin left, and what remains goes back to the trader. |
| [Event-market rules](05-prediction-markets.md) | Prediction markets get tick-bounded leverage that compresses to 1× before the outcome. |
| [Fee-minted token](06-olq-token.md) | OLQ is minted when a fee is paid, never for losing, up to a fixed maximum. |

One page sets these side by side with Papertrade's design: [What we changed from Papertrade](07-what-we-changed.md).

## What you can trade

| Type | Markets | Price source | Maximum leverage |
|---|---|---|---|
| Crypto | BTC, ETH, SOL, HYPE | Hyperliquid | 1000× |
| Stocks and indices | Nasdaq 100, NVDA, TSLA, AAPL | Hyperliquid | 1000× |
| Commodities | Gold, silver, oil | Hyperliquid | 1000× |
| Prediction markets | Four live Gemini contracts | Gemini Prediction Markets | Up to 50×, lower near 0, 1 and the outcome |

## Who is involved

**Traders** post USDC margin, choose a side and a leverage, and trade against the vault.

**Liquidity providers** deposit USDC into the vault. They are the other side of every trade: they collect trader losses, funding and most of the fees, and they pay trader wins.

**Stakers** stake OLQ and receive 30% of profit fees in USDC. They take no trading risk.

**The keeper** reads reference prices, signs them, and carries out liquidations and settlements. It holds no user funds and has no special powers over the contracts.

## Why Arc

Everything on OpenLiquid is in dollars: margin, profit, fees, the vault, staking rewards. On Arc the gas is in dollars too, because USDC is the native token. A trader never needs a second asset. See [Oracle, keeper and Arc](08-oracle-keeper-arc.md).

## Status

OpenLiquid is live on Arc testnet. It is a prototype built for the University Blockchain Conference 2026 hackathon. It is unaudited and uses test funds only. Nothing here is an offer of a financial product.

Next: [How a trade is priced](02-pricing.md)
