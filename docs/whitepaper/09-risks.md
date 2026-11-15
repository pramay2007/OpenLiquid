# Risks and assumptions

The design rests on a small number of assumptions. This page states each one, what protects it, and what happens if it fails.

## 1. Moving a price and holding it costs more than it pays

The slow price forces a pushed price to be held for about the averaging time before it can be traded against. The capacity limit bounds the size that can be held against it.

**If it fails.** If a reference book is much thinner than the depth the keeper reports, or the capacity multiple is set too high, a held push could pay. The multiple of 2 on prediction markets is a demonstration setting for books with only a few hundred dollars near the mid. The five-minute slow price is the main defence there.

## 2. The keeper's price is honest and fresh

One key signs every price in this build.

**If it fails.** A dishonest or compromised signer can misprice every market, and the vault would pay for it. A stalled signer stops trading, because prices expire after 20 seconds; it does not let anyone trade on a stale price. A production version needs several independent signers and a median, and a second reference venue for each market.

## 3. Prices move continuously enough to liquidate

Losses are capped at margin. If a price gaps through a position's liquidation level, the part of the loss beyond the margin is never collected, and the vault bears it. The profit cap limits the matching win on the other side.

**If it fails.** Liquidity providers lose money in fast, gapping markets. This is most acute at 1000×, where 0.08% is the whole distance to liquidation.

## 4. Binary markets jump

A prediction market can go straight to 0 or 1 on news while leverage is still high. A trader holding leveraged Yes and leveraged No through the jump wins on one side and loses only margin on the other, at the vault's expense.

**What bounds it.** The profit cap, the capacity limit, tick-bounded leverage, compression to 1× before the outcome, and the borrow fee. Holding 1× on both sides through resolution loses the fee; this is tested.

**What does not.** A surprise before compression begins. This is priced and bounded. It is not eliminated.

## 5. Latency

The keeper signs a price every second, and a trader may submit any signed price that is inside the 20 second validity window and newer than the one on-chain. A trader can therefore pick the best price of the last few seconds. On the way in, worse-of fills delay the gain but do not remove it. On the way out it is immediate: after a move against them, a trader can close at a price from just before it, if no newer price has reached the chain.

**What bounds it.** The window, which was cut from 60 seconds to 20. The keeper posting a new price on-chain whenever one has moved 5 basis points, which closes the window early. At 1000× a single basis point is 10% of margin, so what is left still matters. A shorter window, posting every price, and several signers are the next steps.

## 6. Liquidity providers are short the traders

If traders as a group win, providers lose. That includes the plain case where traders are right about a real move.

Two things should be kept apart. Whether winners get paid is settled by construction: every position's maximum payout is locked before it opens, so the vault cannot owe more than it holds. Whether providers make money is not settled at all. Their worst case at any moment is the total reserve, a number anyone can read from the vault contract. The profit cap, the depth-backed capacity (which moves with the real book on every price update) and funding bound how large and how one-sided that gets. Nothing hedges it. Hedging the vault's net exposure on the reference venues is future work, and whether fees, funding and trader losses pay providers enough for this risk is something only live trading can show.

## 7. Administration

The contracts have an owner that can list markets, change market parameters and set the signer. On testnet the owner is a single key. The owner cannot move user funds, change the token's minter or its supply curve, or withdraw from the vault. A production version needs a timelock and a multisig.

## 8. Software

The contracts are unaudited. They have 30 tests, including the replay of the launch-day trade, and have been exercised on Arc testnet. That is not an audit.

## What the tests cover

| Suite | Tests |
|---|---|
| Crypto, stock and commodity markets | 14 |
| Prediction markets | 7 |
| Price oracle | 3 |
| Replay of the launch-day trade | 6 |

A review of the design raised five specific objections. They are answered one by one in [Objections and answers](12-objections.md).

Next: [Parameters and contracts](10-parameters-and-contracts.md)
