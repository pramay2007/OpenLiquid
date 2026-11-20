# What we are still working on

OpenLiquid is an unaudited prototype on a test network, with test funds. This page lists what we know is unfinished. We would rather a reader find it here than find it out.

## How this list was made

Before deploying the current contracts we gave the rules to a group of AI agents and told them to break them. Eleven agents each took one line of attack on the mechanism, modelled the rules, and measured the best strategy against the vault with exact enumeration and Monte Carlo at 200,000 to 1,000,000 paths. Six more reviewed the contract code and wrote failing tests for what they found.

They found a lot. Most of it is fixed, and several rules on the other pages exist because of it. What follows is what is not fixed. The full record, including the scripts, is in the repository: [stress-test/README.md](../../stress-test/README.md).

The sizes below were measured against the draft rules. Where a rule has since changed, the line says so.

## Open

### A trader can choose among recent prices

The keeper signs a price every second. The contracts accept any signed price that is newer than the one on-chain and at most 20 seconds old. A trader can hold several and submit the one that suits them.

On a prediction market one tick is a large part of a leveraged position. At 10×, with lines five ticks away, one tick is 20% of the stake. An agent measured a one-tick head start at +$0.15 to +$0.17 per dollar staked per trade at 10×. Before team news on a sports market the same edge was +$0.16 to +$0.46 at 5×.

The fix is two-step fills: the order is recorded first, and filled at the first price signed a few seconds later. The trader's own price becomes only a limit. This is designed and not built. Shortening the window alone does not work on Arc, for the reason given in [Objections and answers](12-objections.md).

### The slow price can be fed selectively

The slow price is computed on-chain from the samples that reach the chain. It treats the newest sample as held until the next one arrives, and the caller chooses which samples arrive. A reviewer showed that one hand-picked sample turns the replay's +$187 into about +$4,300.

Making that one print on the reference venue is estimated to cost about $52,000, and capacity is tied to the depth that has to be bought through to make it. So the attack still loses money. It is a thinner margin than we claimed. The fix is for the keeper to sign its own average over every sample it sees.

### The reference book can be manipulated on thin markets

One agent attacked the Gemini reference books directly. Three findings matter.

- **Resting orders that never trade raise capacity.** Depth has to persist to count, but it does not have to trade. Under the draft rules, quoting for five minutes inflated capacity and the house lost about 3.3% of the spoofed depth per cycle: $3,079 on a $99,000 spoof. Each side of a prediction market now has a ceiling of $1,000 that does not come from the book, which bounds this. It does not remove it.
- **Push and release.** Pushing the price, waiting for the slow price to follow, and releasing harvests the lag twice. Measured at $37.80 of house loss per $1,000 of depth per cycle.
- **Cheap shares at extreme prices.** Capacity used to be counted in dollars, so near 0 or 1 it bought many shares. It is now sized in shares, which was the fix the agent proposed. This has not been re-attacked.

On the books listed today this is small, because they hold $660 to $1,800 near the mid and capacity is half of that. It would not be small on a deep book. The fixes are an absolute ceiling per market that does not come from the signed book, capacity counted in contracts, and a minimum holding time before a win is paid.

### News-driven markets

On a "will it happen by a date" market, one side gains slowly and loses all at once. A leveraged position on that side collects the gain and risks only its stake. With no fee an agent measured +$0.48 per dollar per day.

The crowding fee is built for this and is now taken from the stake, so it cannot be shed. Two gaps remain. It is priced off the contract date, so a market whose decision comes early is under-charged: +$0.76 per day when the real window is a third of the contract. And low-leverage positions on the other side switch the fee off without protecting the vault: −$0.62 per dollar over five days in one test.

No market of this kind is listed. We would not list one with leverage until this is settled.

### A flicker in the mid can liquidate a position

Liquidation is judged at the live mid. On a thin book the mid can jump when one order is placed or pulled. With lines five ticks away, a four-tick flicker liquidates a position at maximum leverage. The trader gets the remaining equity back, and the position is gone. Requiring two signed prices a few seconds apart would stop it. Not built.

### Smaller items

- **One keeper key.** One key signs every price. A dishonest or compromised signer could misprice every market.
- **No price limit on orders.** `open` and `close` fill at whatever signed price lands. A newer price can arrive between clicking and filling.
- **Free occupation.** A balanced long and short pair, or a 1× position on a cheap contract, holds capacity and vault reserve at no cost. Bounded by each market's capacity.
- **Voided matches.** A void is settled as whatever the reference venue reports.
- **No pass-through of the reference venue's funding.** A long here against a short on the reference venue can earn that venue's funding. The scenario that was to size this was cut off before it reported.
- **The market list only grows**, so vault deposits and withdrawals get more expensive as markets are added.
- **The share price nets positions on the same side of a market.** It no longer nets across sides or markets.

## Reduced

- **Boost through news.** A boosted Yes and No pair through an anticipated jump took $1.44 to $3.40 per dollar under the draft rules. Scheduled news now forces 1×, and the premium is 2.5 times the base rate. An unscheduled jump a little larger than the stop distance still favours the pair.
- **The cost to an honest trader.** 15% to 27% of the stake per position at maximum leverage under the draft rules, 7% to 16% with lines five ticks away.
- **The kickoff hand-over.** From expiry on, a leveraged position cannot win. If the keeper is late, one that was losing can still get back to its stake.

## What does not change

Some risks are part of the design and will stay.

- **Liquidity providers are short the traders.** If traders correctly call a real move, the vault loses. The rules stop a manufactured move from paying. They do nothing about a real one.
- **A fast real move is treated like a pushed one.** A trader who is right about sudden news has to wait for the slow price to collect most of it.
- **A funded vault is needed before the first trade**, and its size limits what can be traded.

## What has not been tested

The changed rules have not been through a second full round of the stress test. Four of the eleven scenarios were cut off by a usage limit before they reported, and so were the second-agent checks of the mechanism findings and the re-run against the changed rules. No part of this has been audited, and none of it has met real money.

Next: [Parameters and contracts](10-parameters-and-contracts.md)
