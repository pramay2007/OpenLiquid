# Capacity and the vault

Filling at a reference price is only safe if the size on offer bears some relation to the market the price comes from. This page covers the two limits that tie OpenLiquid to the real book, and the vault that pays winners.

## Depth-backed capacity

With every price, the keeper also signs one more number: the dollars resting near the mid on the reference venue. It takes the thinner of the two sides, within 10 basis points of the mid on Hyperliquid and within five ticks on Gemini.

The engine caps open interest on each side of a market at a multiple of that depth:

```
open interest per side  ≤  κ × reference depth
```

| Market type | κ | Per-position limit |
|---|---|---|
| Crypto | 0.5 | $10M notional |
| Stocks and commodities | 0.5 | $5M notional |
| Prediction markets | 2.0 | $100k notional |

If $20M rests near the ETH mid on Hyperliquid, each side of the ETH market here can hold $10M. When the real book thins out, so does the room here, on the next price update. Existing positions stay open; new ones are refused until there is room.

The reason is cost. Moving a price by a given amount costs roughly the depth you have to trade through. If the size that can be held against a move is a fraction of that depth, the move costs more than it can pay.

## The vault is the counterparty

All trades are against one pool, an ERC-4626 vault holding USDC. Liquidity providers deposit USDC and receive vault shares. Traders' net profit is the vault's loss, and the reverse.

The vault earns:

- trader losses,
- funding paid by the crowded side,
- borrow fees on prediction-market positions,
- 70% of profit fees.

It pays trader wins.

## Payouts are reserved when a position opens

The vault holds three kinds of money.

| Balance | Whose it is |
|---|---|
| Trader margin | The traders', until their positions close. |
| Reserve | Locked against the maximum profit of every open position. |
| Free liquidity | The liquidity providers', and the only part they can withdraw. |

A position's profit is capped at ten times its margin (or the natural maximum of the contract on a prediction market, if that is smaller). When a position opens, the engine asks the vault to lock that whole amount. If the vault cannot, the position does not open.

Two things follow.

1. **A winner is always paid at close, in full, in the same transaction.** The money was set aside before the trade existed. There is no queue and no IOU.
2. **Liquidity providers cannot withdraw money that is locked.** Withdrawals are limited to free liquidity, so a provider cannot leave just before a winning trader closes.

## How vault shares are valued

A share is worth the vault's cash, less trader margin, less what traders are owed on open positions at the current oracle price:

```
LP value  =  cash − trader margin − unrealised trader profit
```

Unrealised profit is bounded on both sides: traders cannot be owed more than the reserve, and cannot owe more than their margin. Marking open positions this way means a deposit or withdrawal happens at a fair price whether traders are currently winning or losing.

The vault uses a virtual-share offset, the standard defence against a first depositor inflating the share price.

## What liquidity providers are exposed to

Providers are short the traders. They do well when traders lose or pay funding, and badly when traders win. Skew funding, the capacity limits and the profit cap bound how one-sided that exposure can get; they do not remove it. See [Risks and assumptions](09-risks.md).

Next: [Fees, funding and liquidation](04-fees-funding-liquidation.md)
