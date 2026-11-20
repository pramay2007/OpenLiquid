# Questions and answers

## Is there really no slippage?

When the market is calm, yes: the fill is the reference mid, at any size the market has room for. When the price is moving fast, the fill is the worse of the mid and the slow price, and that difference is a cost. See [How a trade is priced](02-pricing.md).

## Can I really use 1000×?

Yes, on crypto, stocks and commodities, when the market is quiet. A 1000× long is liquidated by a move of 0.08% against it, so it is a very short-lived position. While the price is moving, the entry guard refuses orders that would open already deep under water, which in practice lowers the leverage on offer.

## What is the most I can lose?

The margin on the position. Nothing else in your account can be touched by it.

## What is the most I can win?

On crypto, stocks and commodities, ten times the margin on the position. On a prediction market, what your stake would win if you bought the shares outright, and with leverage never more than the stake itself. Boost, where it is offered, raises that to the leveraged win. Either way the amount is set aside for you in the vault before the position opens.

## Will I be paid if I win?

Yes, in the same transaction that closes the position. The vault cannot open a position unless it can lock the full payout first, and liquidity providers cannot withdraw locked funds.

## What happens when I am liquidated?

The position is closed at the mid once its equity falls to 20% of margin. The liquidator takes 5% of the margin. The rest of the remaining equity is returned to you.

## What does it cost?

Nothing to open or close. When you close a winner you pay 5% of the profit, or 10% on a prediction market. While a market is lopsided, the larger side pays a crowding fee of up to 0.05% of its size per day; the smaller side pays nothing. On the prediction markets listed today there is no crowding fee. On Arc, gas is about one cent to open and half a cent to close, paid in USDC.

## Is there funding?

No. Funding exists on other venues to pull a perpetual's price back to the asset's price. Here every trade fills at the reference price, so there is nothing to pull back. One job is left: when traders all lean one way, the vault carries that lean, and the crowding fee pays it for doing so. Only the larger side pays it.

## How do prediction markets work here?

They are live Gemini contracts with leverage. You pick Yes or No, a stake and a leverage. The position is paid in full when the odds reach its win line and is stopped out near its stop line. The most it can win is what the stake would win outright, and never more than the stake; leverage brings that closer. See [Leverage on prediction markets](05-prediction-markets.md).

## What happens to my leveraged bet if the odds jump?

If they jump your way, you are paid your maximum win. If they jump against you, you lose your stake and nothing more. Your maximum win is locked in the vault when you open, which is why it can always be paid.

## What is Boost?

An option on some prediction markets to keep the leveraged win, up to ten times the stake. It costs a premium every day, taken from your stake. It is cheap when the result is far away and expensive when it is close. Today it is offered on the BTC price market.

## Can I hold a leveraged bet through a match?

No. Leverage falls as the event nears and is 1× by kickoff. A position above the limit is closed at the normal price, with no penalty. A 1× bet stays open to the result and is never liquidated.

## Where do prices come from?

Hyperliquid for crypto, stocks and commodities. Gemini Prediction Markets for event contracts. A keeper signs each price together with the depth resting near it, and the contracts check the signature.

## How do I get OLQ?

By losing a trade. The loss goes to the vault and you receive OLQ for it. There is no other source. You can then stake it and earn 30% of the fees winners pay.

## Why is OLQ minted on losses?

Because a loss is money that enters the vault, and the vault is what pays winners. The rate is boosted while the vault is drawn down, so refilling it is rewarded when it is needed. See [The OLQ token](06-olq-token.md).

## Who is on the other side of my trade?

The vault, which is funded by liquidity providers. They earn when traders lose and pay when traders win.

## Is this live with real money?

No. OpenLiquid runs on Arc testnet with test funds. It is an unaudited prototype.

## Has anyone tried to break it?

Yes. Before deploying we set a group of AI agents to attack the rules and the contracts. Seven attacked the mechanism with simulations and six reviewed the code. They reported 58 economic findings and 51 code findings, many of them the same hole seen twice, and several rules exist because of them. There are more experiments we want to run, and they are listed with the open items. The record is in [stress-test/](../../stress-test/README.md).

## What are the weak points?

See [What we are still working on](09-risks.md) and [Objections and answers](12-objections.md).

Next: [Objections and answers](12-objections.md)
