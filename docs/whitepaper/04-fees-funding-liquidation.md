# Fees and liquidation

## What a trade costs

There is no fee to open a position and none to close it. There is no funding paid between traders. A winning position pays a share of its profit.

One cost applies while a position is open, and only on one side: the crowding fee. A market where both sides are the same size pays nothing.

| | Crypto, stocks, commodities | Prediction markets |
|---|---|---|
| Open or close | None | None |
| Profit share | 5% of profit | 10% of profit |
| Crowding fee | On the larger side only, up to 0.05% of size per day | Set per market. Off on the markets listed today |
| Boost premium | Not offered | Only if chosen, on markets that offer it |

The profit share is split:

- 70% stays in the vault, with the liquidity providers.
- 30% goes to OLQ stakers, in USDC. If nobody is staking, it stays in the vault.

Paying a profit share is also the only thing that mints OLQ. See [The OLQ token](06-olq-token.md).

## Why there is no funding rate

On an exchange with an order book, the price of a perpetual can drift away from the price of the asset. Funding is the payment between longs and shorts that pulls it back. That job does not exist here. Every trade fills at the reference price, so there is nothing to pull back.

What is left of funding's purpose on a venue like this is different. The vault takes the other side of every trade. When traders lean one way, the vault carries that lean. Somebody should pay it for doing so.

## The crowding fee

A market is lopsided when one side holds more than the other. While it is, the larger side pays a fee to the vault. The more lopsided the market, the higher the fee. The smaller side pays nothing, and a balanced market pays nothing.

```
fee per day  =  position size × 0.05% × imbalance
imbalance    =  (larger side − smaller side) / market capacity, at most 1
```

The fee builds up while the position is open and comes out of the position when it closes, whatever its result. It counts against the position's equity, like any holding cost.

### Why it is not taken only from winners

Our first design took this fee only from a winning position, so that nothing was ever added to a loss. We liked that rule. The stress test broke it.

A fee that is forgiven whenever a position closes flat can be shed for free: close at break-even, open again, and the clock starts from zero. An agent measured a trader keeping 96% of the fee this way. A charge that grows with time has to come out of the position whether it wins or not, or it is not a charge.

So the fee is now an ordinary holding cost. What is left of the original idea is that it is one-sided. It is paid only by the side the vault is exposed to, only in proportion to that exposure, and never by a balanced book.

On prediction markets the fee is scaled differently, because the risk is different. See [Leverage on prediction markets](05-prediction-markets.md).

## Liquidation

Every position has its own margin. A trader cannot lose more than the margin on a position, and one position cannot draw on another.

A position can be liquidated once its equity, measured at the mid, falls to 20% of its margin:

```
equity  =  margin + profit or loss at the mid − crowding fee − any Boost premium
liquidatable when  equity ≤ 20% of margin
```

For a long, that is a fall of `0.8 / leverage` from the entry price.

| Leverage | Move against the position that triggers liquidation |
|---|---|
| 10× | 8% |
| 100× | 0.8% |
| 1000× | 0.08% |

Anyone can liquidate an eligible position. The liquidator receives 5% of the margin. **Whatever equity is left after that goes back to the trader.** A liquidation does not forfeit the whole margin.

If the price has jumped straight through the stop and no equity is left, the liquidator is still paid, out of the margin the vault keeps. Somebody always has a reason to clear the position.

A 1× position on a prediction market is a plain purchase of shares. It is never liquidated.

### Which price triggers it

Liquidation is judged at the mid, and settled at the mid. There were three choices.

| Trigger price | What goes wrong |
|---|---|
| The worse-of price | Positions are liquidated early, by the gap between the two prices, exactly when the market is moving. |
| The slow price | In a real fast move, positions that are already under water stay open for up to a minute. |
| **The mid** (chosen) | A short spike in the reference mid can liquidate a high-leverage position that would otherwise have survived. |

The cost is real at very high leverage. Three things limit it. A liquidated trader gets back the equity that is left, so a spike does not take the whole margin. Nobody can profit much by causing liquidations: the liquidator's reward is 5% of margin, and the capacity limit bounds the margin within reach. And the trader chooses the leverage: at 100× a spike that would liquidate a 1000× position does nothing.

This is still on the list of [what we are working on](09-risks.md).

## The profit cap

Profit on a position is capped. On crypto, stocks and commodities the cap is ten times the margin, or a 100% move in price if that is smaller. At 1000× the cap is reached after a move of 1% in the trader's favour; at 100× it is 10%.

The cap exists so that every position's maximum payout is a known number that can be locked in the vault when it opens. Once a position has reached its cap it has nothing more to gain, so anyone may close it and pay its owner. The keeper does this automatically.

## Minimum size

The minimum margin is $1.

Next: [Leverage on prediction markets](05-prediction-markets.md)
