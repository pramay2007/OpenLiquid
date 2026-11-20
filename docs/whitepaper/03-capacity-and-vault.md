# Capacity and the vault

Filling at a reference price is only safe if the size on offer bears some relation to the market the price comes from. This page covers the two limits that tie OpenLiquid to the real book, and the vault that pays winners.

## Depth-backed capacity

With every price, the keeper also signs one more number: the dollars resting near the mid on the reference venue. It takes the thinner of the two sides, within 10 basis points of the mid on Hyperliquid and within five ticks on Gemini.

The engine caps open interest on each side of a market at half of that depth:

```
open interest per side  ≤  0.5 × persistent reference depth
```

| Market type | Share of depth | Per-position limit |
|---|---|---|
| Crypto | 0.5 | $10M notional |
| Stocks and commodities | 0.5 | $5M notional |
| Prediction markets | 0.25, sized in shares, and never more than $1,000 a side | $100k notional |

On a prediction market a share on the cheap side pays many times its price, so capacity there is sized in shares: the dollar limit is scaled by twice the distance to the nearer of 0 and 1. At 50 cents that changes nothing. At 90 cents it is a fifth as much. A ceiling of $1,000 a side applies whatever the book shows, because quotes on a thin book can be placed without ever trading.

If $20M rests near the ETH mid on Hyperliquid, each side of the ETH market here can hold $10M. When the real book thins out, so does the room here, on the next price update. Existing positions stay open; new ones are refused until there is room.

**Depth has to persist to count.** The oracle keeps a time average of the reported depth, with the same averaging time as the slow price, and capacity uses the smaller of the current depth and that average. Depth that disappears lowers capacity at once. Depth that appears raises it only as it stays. Resting orders placed for a few seconds to inflate capacity therefore buy almost nothing.

The reason is cost. Moving a price by a given amount costs roughly the depth you have to trade through. If the size that can be held against a move is a fraction of that depth, the move costs more than it can pay.

## The vault is the counterparty

All trades are against one pool, an ERC-4626 vault holding USDC. Liquidity providers deposit USDC and receive vault shares. Traders' net profit is the vault's loss, and the reverse.

The vault earns:

- trader losses,
- the crowding fee, which the larger side of a lopsided market pays while it is open,
- Boost premiums on prediction-market positions,
- 70% of the profit share.

It pays trader wins.

## Payouts are reserved when a position opens

The vault holds three kinds of money.

| Balance | Whose it is |
|---|---|
| Trader margin | The traders', until their positions close. |
| Reserve | Locked against the maximum profit of every open position. |
| Free liquidity | The liquidity providers', and the only part they can withdraw. |

Every position has a maximum profit, known when it opens. On crypto, stocks and commodities it is ten times the margin or a 100% move in price, whichever is smaller. On a prediction market it is what the stake would win if spent on shares outright, and for a leveraged position never more than the stake, or the leveraged win if the position pays for Boost (see [Prediction markets](05-prediction-markets.md)). When a position opens, the engine asks the vault to lock that whole amount. If the vault cannot, the position does not open.

Two things follow.

1. **A winner is always paid at close, in full, in the same transaction.** The money was set aside before the trade existed. If the vault is ever drawn down, winners are paid first in, first out as it refills, and OLQ emissions are boosted to refill it faster. See [The OLQ token](06-olq-token.md).
2. **Liquidity providers cannot withdraw money that is locked.** Withdrawals are limited to free liquidity, so a provider cannot leave just before a winning trader closes.

## How vault shares are valued

A share is worth the vault's cash, less trader margin, less what traders are owed on open positions at the current oracle price:

```
LP value  =  cash − trader margin − unrealised trader profit
```

Unrealised profit is bounded on both sides, and the bound is applied to each side of each market before they are added: a side cannot be owed more than its reserve, and cannot owe more than its margin. A position that has gone past its cap or its stop is then not marked against another market's headroom. Marking open positions this way means a deposit or withdrawal happens at a fair price whether traders are currently winning or losing.

Shares cannot be redeemed or transferred for ten minutes after a deposit, and a deposit can only be made for oneself. The share price steps whenever a price reaches the chain or a position settles. Without the delay, anyone could deposit just before a step in the vault's favour and redeem just after it. The stress test found exactly that, in one block, and the delay is the fix.

The vault uses a virtual-share offset, the standard defence against a first depositor inflating the share price.

## What liquidity providers are exposed to

Providers are short the traders. They do well when traders lose, and badly when traders win. The crowding fee, the capacity limits and the profit caps bound how one-sided that exposure can get; they do not remove it. See [What we are still working on](09-risks.md).

Next: [Fees and liquidation](04-fees-funding-liquidation.md)
