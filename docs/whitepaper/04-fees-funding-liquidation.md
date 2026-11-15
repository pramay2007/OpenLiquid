# Fees, funding and liquidation

## Fees

There is no fee to open a position and no fee to close one at a loss. The protocol charges a share of profit.

| | Crypto, stocks, commodities | Prediction markets |
|---|---|---|
| Open or close | None | None |
| Profit fee | 5% of profit | 10% of profit |
| Funding | Paid by the crowded side | Paid by the crowded side |
| Borrow fee | None | 0.2% a day on the leveraged part |

The profit fee is taken only when a position closes in profit, on the profit after funding and borrow charges. It is split:

- 70% stays in the vault, with the liquidity providers.
- 30% goes to OLQ stakers, in USDC. If nobody is staking, it stays in the vault.

Paying a profit fee is also the only thing that mints OLQ. See [The OLQ token](06-olq-token.md).

## Skew funding

A pool that takes the other side of every trade ends up with a one-way bet whenever traders lean one way. Funding is the price of leaning.

```
skew          =  (long open interest − short open interest) / capacity,  limited to ±1
funding rate  =  skew × maximum rate
```

| Market type | Maximum rate, per day, at full skew |
|---|---|
| Crypto, stocks, commodities | 0.05% of notional |
| Prediction markets | 0.10% of notional |

When longs outweigh shorts, longs pay and shorts receive, at the same rate per dollar of notional. When the book is balanced the rate is zero. Funding accrues every second and is settled when a position closes.

## Liquidation

Every position has its own margin. A trader cannot lose more than the margin on a position, and one position cannot draw on another.

A position can be liquidated once its equity, measured at the mid, falls to 20% of its margin:

```
equity  =  margin + profit or loss at the mid − funding and borrow charges
liquidatable when  equity ≤ 20% of margin
```

For a long with no charges accrued, that is a fall of `0.8 / leverage` from the entry price.

| Leverage | Move against the position that triggers liquidation |
|---|---|
| 10× | 8% |
| 100× | 0.8% |
| 1000× | 0.08% |

Anyone can liquidate an eligible position. The liquidator receives 5% of the margin. **Whatever equity is left after that goes back to the trader.** A liquidation does not forfeit the whole margin.

Liquidation is judged at the mid rather than at the worse-of price, so a position is not liquidated by the gap between the two prices.

## The profit cap

Profit on a position is capped at ten times its margin. At 1000× that is a move of 1% in the trader's favour; at 100× it is 10%. Beyond the cap the position earns nothing more, and the trader should close.

The cap exists so that every position's maximum payout is a known number that can be locked in the vault when it opens.

## Minimum size

The minimum margin is $1.

Next: [Prediction-market perpetuals](05-prediction-markets.md)
