# Compared with Papertrade

Papertrade is the best-known venue that fills trades at a reference price with no order book. This page sets the two designs side by side: what they share, where they differ and why, and what OpenLiquid gives up.

Everything said about Papertrade here is our reading of its public documentation at [docs.papertrade.xyz](https://docs.papertrade.xyz/) and of press reports, as of November 2026. We are not affiliated with Papertrade.

## What the two share

- One price for every trade, taken from a reference venue. No order book, no spread.
- Leverage up to 1000×.
- Isolated margin. A position can lose its margin and nothing more.
- No fee to open, and no fee to close at a loss.
- A token with no pre-mint and no team or investor allocation.

## What happened on launch day

Papertrade launched on 10 October 2026. About eight hours later, according to press reports, one wallet that held large ETH positions on Papertrade bought roughly 6,000 ETH on Hyperliquid. That moved Hyperliquid's mid price by about 0.12% for about a minute. The wallet closed on Papertrade at the moved price and then sold the ETH.

The reported cost of moving the price was about $52,000 in trading fees. The reported profit was about $1.28M.

Nothing was hacked. Every rule worked as written. The venue filled any size at a price that could be moved for less than the fill was worth.

## The changes

### 1. Price

| | Papertrade | OpenLiquid |
|---|---|---|
| Fill price | Hyperliquid's mid, at that instant | The worse, for the trader, of the mid and a time-weighted slow price |
| A price pushed for one minute | Can be opened against and closed into | Moves the mid but barely moves the slow price, so it cannot be closed into |
| Deviation or time-weighted check | None, by its own documentation | Opens pause when the two prices are more than 20 basis points apart |

This is the change that addresses the launch-day trade directly. See [How a trade is priced](02-pricing.md).

### 2. Size

| | Papertrade | OpenLiquid |
|---|---|---|
| Open-interest limit | Set by a keeper, at launch about $1B of headroom per side | Half of the dollars resting within 10 basis points of the mid on the reference venue, per side |
| Follows the real book | No | Yes, on every price update |

A limit that is not tied to the book can be larger than what it costs to move the price. Ours cannot be, by construction.

### 3. Who pays winners

| | Papertrade | OpenLiquid |
|---|---|---|
| Pool at launch | Empty; it takes no deposits and grows only from trader losses | A funded ERC-4626 vault that anyone can deposit into |
| When a trader wins | Profit joins a first-in-first-out queue and is paid as other traders lose | Paid in full when the position closes |
| How that is guaranteed | It is not; the pool can be in deficit by design | The position's maximum profit is locked in the vault before it opens |
| Maximum profit | Not stated | Ten times margin, which is what makes it lockable |

### 4. What a winner keeps

After launch, Papertrade's second contract set added a holdback and a size-dependent scale that are taken off every winning close, before a 2% fee. Its documentation gives the share of the raw gain a trader keeps as about 88% on a 1% move in BTC and about 74% on a 0.1% move.

OpenLiquid takes 5% of profit and nothing else. The cost of protection is paid only by trades made while the price is moving, through the worse-of fill, and not by every winner all the time.

### 5. Funding

Papertrade charges no funding, so nothing discourages every trader from leaning the same way against the pool. OpenLiquid charges the crowded side and pays the other, in proportion to the imbalance.

### 6. Liquidation

| | Papertrade | OpenLiquid |
|---|---|---|
| Trigger | About 5 basis points before equity reaches zero | Equity at 20% of margin |
| At 1000×, the move that triggers it | About 0.05% | 0.08% |
| What the trader gets back | Nothing; the margin is forfeited | Whatever equity is left, less a 5% reward to the liquidator |

### 7. The token

| | PAPER | OLQ |
|---|---|---|
| Minted when | A trader loses | A trader pays a profit fee |
| Rate | Currently proportional to existing supply, with a boost of up to five times while the pool is in deficit | 100 per dollar of fee at the start, falling as fees accumulate |
| Maximum supply | None stated | 100,000,000 |
| Stakers earn | Half of fees, plus pool surplus above a cap, when no winner is waiting | 30% of profit fees |

Minting on losses pays a trader for losing, and pays two wallets for trading against each other. Minting on fees pays a trader for paying the protocol. See [The OLQ token](06-olq-token.md).

### 8. Markets

Papertrade lists BTC and ETH. OpenLiquid lists four crypto assets, four stocks and indices, three commodities, and four live prediction markets from Gemini, the last with [rules of their own](05-prediction-markets.md).

## The same trade, replayed

The contract tests replay the launch-day sequence against the engine configured both ways: once with the rules above switched off, once with them on. The oracle reports the pushed price faithfully in both. The attacker tries to open $297M at 1000×.

| Engine | Size it accepted | Attacker's result on one leg | Cost of the move |
|---|---|---|---|
| Any size, at the mid | $297.0M | +$349,272 | about $52,000 |
| OpenLiquid | $9.9M | +$185 | about $52,000 |
| OpenLiquid, with the push held for 60 seconds | $9.9M | +$7,135 | more than $52,000 |

The replay is a model of the reported trade and not a reconstruction of Papertrade's contracts. Press reports disagree on which positions produced the profit; the replay uses the $297M figure that appears in them. The test is `contracts/test/exploit.test.js`.

## What we gave up

These changes are not free, and Papertrade does some things better.

- **A trusted price signer, and a validity window.** Papertrade reads Hyperliquid's book directly on-chain, with nobody in between and no delay. Arc cannot do that, so OpenLiquid relies on a keeper that signs prices, each usable for 20 seconds. In this build that is one key. A dishonest signer could misprice every market, and a trader can choose among the last few seconds of prices.
- **Slippage in fast markets.** Papertrade fills at the mid always. OpenLiquid fills at the mid only when the market is calm. A trader who is right about a sudden real move has to wait about a minute to collect most of it.
- **Less leverage when it is most tempting.** The entry guard refuses very high leverage while the price is moving.
- **Capital up front.** Papertrade needed no liquidity providers. OpenLiquid needs a funded vault before the first trade, and its size limits what can be traded.
- **Liquidity providers carry real risk.** Somebody has to be on the other side of a winning trade. Here it is a named party that chose to be.
- **Track record.** Papertrade is live with real money. OpenLiquid is an unaudited testnet prototype.
