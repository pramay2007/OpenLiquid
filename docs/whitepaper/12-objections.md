# Objections and answers

A review of this design raised five objections. All five are fair. This page takes them one at a time: what the contracts actually do, what was changed in response, and what is still open.

| Objection | Where it stands |
|---|---|
| 1. The slow price depends on how often the oracle is updated | Correct. Bounded and documented; the exact fix needs a new oracle contract. |
| 2. It is unclear which price triggers liquidation | Answered: the mid. The trade-off is stated below. |
| 3. A 60 second validity window lets a trader choose a stale price | Correct. The window was cut to 20 seconds on the live deployment. Not eliminated. |
| 4. It does not solve liquidity-provider solvency | Paying winners is solved. Provider profit is not, and is not claimed. |
| 5. It penalises traders who are right about a real move | Correct, and deliberate. |

## 1. The slow price depends on the update pattern

The oracle moves the slow price with this step each time a price arrives:

```
slow  ←  slow + (held − slow) × dt / (τ + dt)
```

Take a price held for 60 seconds with a 60 second averaging time. If the oracle is updated once at the end, the step is `60 / (60 + 60)` and the slow price covers 50% of the gap. If it is updated every second, the steps compound and it covers `1 − e^(−1)`, about 63%. The same held price gives two different answers.

So the reviewer is right: the result depends on how often prices are delivered, and anyone can deliver a signed price.

What this means in practice:

- The slow price always lands between the two paths. It can never move faster than the every-second path.
- Nobody can force the slower path on someone else, because anyone can deliver prices.
- The figures in this paper that measure what an attacker can take use the faster path. The replay's "held for 60 seconds" case updates every two seconds. That is close to the attacker's best case.

The clean fix is the exact form, which gives one answer whatever the update pattern:

```
slow  ←  mid + (slow − mid) × e^(−dt / τ)
```

That is a change to the oracle contract. It is not in the current deployment and is the first change we would make in the next one.

## 2. Which price triggers liquidation

The mid. A position is liquidatable when its equity at the mid falls to 20% of margin, and it is settled at the mid.

The reviewer lists the three options and their costs correctly:

- Using the worse-of price liquidates early, in exactly the moments the market is moving.
- Using the slow price leaves positions that are already under water open for up to a minute, and the vault pays for the losses beyond their margin.
- Using the mid means a short spike can liquidate a high-leverage position.

We chose the mid because the vault pays every winner, and a rule that leaves it holding bad debt in fast markets undermines the one guarantee the design makes. The cost falls on traders at very high leverage, and is limited in three ways: a liquidated trader gets the remaining equity back; causing liquidations pays an attacker only the 5% liquidator reward on margin that the capacity limit keeps small; and leverage is the trader's choice. The numbers are in [Fees, funding and liquidation](04-fees-funding-liquidation.md).

Still open: a confirmation rule, such as requiring two signed prices a few seconds apart to both be past the liquidation level. It would remove single-tick spikes at the price of a few seconds of extra risk for the vault. It is not built.

## 3. The validity window and choosing a price

The reviewer is right, and this was the most serious of the five.

The keeper signs a new price every second. The contracts accept any signed price that is inside the validity window and newer than the one already on-chain. A trader can therefore hold several valid prices and submit the one that suits them.

- **Opening:** a trader can enter at a price from a few seconds ago. Worse-of fills mean they must then wait for the slow price to catch up before collecting, but the head start is theirs.
- **Closing:** after a move against them, a trader can close at a price from just before the move, provided no newer price has reached the chain. This gain is immediate.

With the original 60 second window that was a real edge. At 1000×, one basis point is 10% of margin.

What was changed: the validity window is now **20 seconds** on every market of the live deployment. It is a per-market setting, so this needed no new contracts.

We first set it to 10 seconds, and orders began to fail. Arc's nodes estimate a transaction's gas against a pending block stamped 12 seconds after the latest one, so a price valid for 10 seconds looked expired before the order was sent. Twenty seconds is the shortest window that leaves room for that and for a person confirming in a wallet.

What already bounded it: the keeper posts a price on-chain whenever a market has moved 5 basis points, at most every 10 seconds while anyone is trading, and every trade posts the price it carries. Each of those closes the window for everyone.

What is left: up to 20 seconds of choice, and whatever the price moves in that time. Papertrade does not have this problem, because it reads the reference book directly with no signer and no window. Closing it further means posting every price on-chain, so that the newest price always supersedes the older ones, and several independent signers. Shortening the window alone runs into the limit above.

## 4. Liquidity-provider solvency

Two questions are being asked at once.

**Can winners always be paid?** Yes, by construction. A position opens only if the vault can lock its maximum payout, and providers cannot withdraw locked funds. There is no state in which the vault owes a trader more than it holds.

**Will providers make money?** Not guaranteed, and not claimed. If traders correctly call a real move, the vault loses. The mechanisms in this paper stop a manufactured move from being profitable. They do nothing about a real one.

What bounds the loss:

- Every position's profit is capped at ten times its margin.
- Open interest per side follows the real book's depth and is recomputed on every price update. This is a dynamic limit, not a fixed one.
- The crowded side pays funding.
- The worst case at any moment is the total reserve, which anyone can read from the vault contract.

What is missing: hedging the vault's net exposure on the reference venues, and a second reference venue per market. Both are listed as future work.

The reviewer's underlying question is whether the cost traders pay in fast markets, plus fees, funding and trader losses, is enough to pay providers for adverse selection and inventory risk. That is an empirical question. A testnet with test funds cannot answer it, and this paper does not pretend to.

## 5. A real move is treated like a pushed one

True. The engine cannot tell, in the first seconds, whether a price moved because of news or because someone pushed it. It treats both the same.

A trader who is right about a sudden move and closes at once is paid at the slow price. Waiting one averaging time collects about 63% of the move; three collect about 95%. The reviewer calls this a tax on short-horizon information, and that is an accurate description.

It is also the point. The traders this costs most are the ones whose edge lasts seconds: latency traders and those reacting fastest to news. Those are the traders a pool is least able to survive, because it is always on the wrong side of them. A trader whose view holds for longer than a minute loses very little.

Whether that trade is worth making is a judgment about who the venue is for. Ours is that a venue with one price and no order book cannot afford to pay for information that is seconds old.

## What the reviewer preferred, and what they asked for

The review's conclusion was that this is a better pricing design than Papertrade's but not yet shown to be a better exchange, and that it should be combined with dynamic open-interest limits, oracle verification across venues and a clearly defined liquidation rule.

| Asked for | Status |
|---|---|
| Dynamic open-interest limits | In place: capacity follows reference depth on every price update. |
| A clearly defined liquidation rule | In place: the mid, with the trade-off stated above. |
| Multi-venue oracle verification | Not built. One signer, one reference venue per market. |
| Evidence that providers are compensated | Not available from a testnet. |

We agree with that conclusion.
