# Questions and answers

## Is there really no slippage?

When the market is calm, yes: the fill is the reference mid, at any size the market has room for. When the price is moving fast, the fill is the worse of the mid and the slow price, and that difference is a cost. See [How a trade is priced](02-pricing.md).

## Can I really use 1000×?

Yes, on crypto, stocks and commodities, when the market is quiet. A 1000× long is liquidated by a move of 0.08% against it, so it is a very short-lived position. While the price is moving, the entry guard refuses orders that would open already deep under water, which in practice lowers the leverage on offer.

## What is the most I can lose?

The margin on the position. Nothing else in your account can be touched by it.

## What is the most I can win?

Ten times the margin on the position. That amount is set aside for you in the vault before the position opens.

## Will I be paid if I win?

Yes, in the same transaction that closes the position. The vault cannot open a position unless it can lock the full payout first, and liquidity providers cannot withdraw locked funds.

## What happens when I am liquidated?

The position is closed at the mid once its equity falls to 20% of margin. The liquidator takes 5% of the margin. The rest of the remaining equity is returned to you.

## What does it cost?

Nothing to open. Nothing to close at a loss. 5% of profit when you close a winner, or 10% on a prediction market. Funding if you are on the crowded side. On Arc, gas of about one cent to open and half a cent to close, paid in USDC.

## How do prediction markets work here?

They are live Gemini contracts with leverage. Buying No is a position of its own, not a short with unlimited loss. Leverage is limited by how close the price is to 0 or 1, and falls to 1× over the last 24 hours before the outcome. See [Prediction-market perpetuals](05-prediction-markets.md).

## Where do prices come from?

Hyperliquid for crypto, stocks and commodities. Gemini Prediction Markets for event contracts. A keeper signs each price together with the depth resting near it, and the contracts check the signature.

## How do I get OLQ?

By closing a winning trade. The profit fee you pay mints OLQ to you. There is no other source.

## Why is OLQ not minted on losses?

Because that pays people for losing and pays two wallets for trading against each other. See [The OLQ token](06-olq-token.md).

## Who is on the other side of my trade?

The vault, which is funded by liquidity providers. They earn when traders lose and pay when traders win.

## Is this live with real money?

No. OpenLiquid runs on Arc testnet with test funds. It is an unaudited prototype.

## What are the weak points?

See [Risks and assumptions](09-risks.md) and [Objections and answers](12-objections.md).

Next: [Objections and answers](12-objections.md)
