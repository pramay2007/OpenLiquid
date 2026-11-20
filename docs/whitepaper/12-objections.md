# Objections and answers

A review of this design raised five objections. All five are fair. This page takes them one at a time: what the contracts actually do, what was changed in response, and what is still open.

| Objection | Where it stands |
|---|---|
| 1. The slow price depends on how often the oracle is updated | Correct, and fixed for the number of updates. Which samples reach the chain is still the caller's choice; see below. |
| 2. It is unclear which price triggers liquidation | Answered: the mid. The trade-off is stated below. |
| 3. A 60 second validity window lets a trader choose a stale price | Correct. The window is now 20 seconds, and prediction-market prices are posted on-chain as they change. Not eliminated. |
| 4. It does not solve liquidity-provider solvency | Paying winners is solved. Provider profit is not, and is not claimed. |
| 5. It penalises traders who are right about a real move | Correct, and deliberate. |

## 1. The slow price depended on the update pattern

The first version of the oracle moved the slow price with this step each time a price arrived:

```
slow  ←  slow + (held − slow) × dt / (τ + dt)
```

Take a price held for 60 seconds with a 60 second averaging time. Updated once at the end, the step is `60 / (60 + 60)` and the slow price covers 50% of the gap. Updated every second, the steps compound and it covers `1 − e^(−1)`, about 63%. The same held price gave two different answers, and anyone can deliver a signed price.

The reviewer was right, and this is fixed. The oracle now uses the exact form:

```
slow  ←  held + (slow − held) × e^(−dt / τ)
```

A price held for a given time now moves the slow price by the same amount whether the oracle was updated once or a thousand times in between. A contract test checks this directly: thirty updates and none produce the same number.

One part of this is still open. The oracle treats the newest sample on-chain as held until the next one arrives, and the caller chooses which samples arrive. A later review showed a single hand-picked sample is worth about $4,300 on the replay where the honest sequence is worth $187. The fix is for the keeper to sign its own average over every sample. It is listed in [What we are still working on](09-risks.md).

## 2. Which price triggers liquidation

The mid. A position is liquidatable when its equity at the mid falls to 20% of margin, and it is settled at the mid.

The reviewer lists the three options and their costs correctly:

- Using the worse-of price liquidates early, in exactly the moments the market is moving.
- Using the slow price leaves positions that are already under water open for up to a minute, and the vault pays for the losses beyond their margin.
- Using the mid means a short spike can liquidate a high-leverage position.

We chose the mid because the vault pays every winner, and a rule that leaves it holding bad debt in fast markets undermines the one guarantee the design makes. The cost falls on traders at very high leverage, and is limited in three ways: a liquidated trader gets the remaining equity back; causing liquidations pays an attacker only the 5% liquidator reward on margin that the capacity limit keeps small; and leverage is the trader's choice. The numbers are in [Fees and liquidation](04-fees-funding-liquidation.md).

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

On prediction markets, where one tick is a large share of a leveraged position's range, the keeper now posts every change of price at once. An older signed price is then refused, so the window there is a few seconds in practice. The stress test still measured a one-tick head start at 15 to 17 cents per dollar staked at 10×, so this is not closed. See [What we are still working on](09-risks.md).

What is left: up to 20 seconds of choice, and whatever the price moves in that time. A venue built on the same chain as its reference market does not have this problem, because it can read the book directly with no signer and no window. Closing it further means posting every price on-chain, so that the newest price always supersedes the older ones, and several independent signers. Shortening the window alone runs into the limit above.

## 4. Liquidity-provider solvency

Two questions are being asked at once.

**Can winners always be paid?** Yes, by construction. A position opens only if the vault can lock its maximum payout, and providers cannot withdraw locked funds. There is no state in which the vault owes a trader more than it holds.

**Will providers make money?** Not guaranteed, and not claimed. If traders correctly call a real move, the vault loses. The mechanisms in this paper stop a manufactured move from being profitable. They do nothing about a real one.

What bounds the loss:

- Every position's profit is capped at ten times its margin.
- Open interest per side follows the real book's depth and is recomputed on every price update. This is a dynamic limit, not a fixed one.
- The larger side of a lopsided market pays a crowding fee to the vault while it is open.
- The worst case at any moment is the total reserve, which anyone can read from the vault contract.

What is missing: hedging the vault's net exposure on the reference venues, and a second reference venue per market. Both are listed as future work.

The reviewer's underlying question is whether the cost traders pay in fast markets, plus fees and trader losses, is enough to pay providers for adverse selection and inventory risk. That is an empirical question. A testnet with test funds cannot answer it, and this paper does not pretend to.

## 5. A real move is treated like a pushed one

True. The engine cannot tell, in the first seconds, whether a price moved because of news or because someone pushed it. It treats both the same.

A trader who is right about a sudden move and closes at once is paid at the slow price. Waiting one averaging time collects about 63% of the move; three collect about 95%. The reviewer calls this a tax on short-horizon information, and that is an accurate description.

It is also the point. The traders this costs most are the ones whose edge lasts seconds: latency traders and those reacting fastest to news. Those are the traders a pool is least able to survive, because it is always on the wrong side of them. A trader whose view holds for longer than a minute loses very little.

Whether that trade is worth making is a judgment about who the venue is for. Ours is that a venue with one price and no order book cannot afford to pay for information that is seconds old.

## What the reviewer preferred, and what they asked for

The review's conclusion was that this is a better pricing design than filling at the mid but not yet shown to be a better exchange, and that it should be combined with dynamic open-interest limits, oracle verification across venues and a clearly defined liquidation rule.

| Asked for | Status |
|---|---|
| Dynamic open-interest limits | In place: capacity follows reference depth on every price update. |
| A clearly defined liquidation rule | In place: the mid, with the trade-off stated above. |
| Multi-venue oracle verification | Not built. One signer, one reference venue per market. |
| Evidence that providers are compensated | Not available from a testnet. |

We agree with that conclusion.

Next: [Compared with Papertrade](13-compared-with-papertrade.md)
