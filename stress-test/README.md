# Stress test: a swarm of agents against the rules

Before the final contracts were deployed, the rules of OpenLiquid were handed to a group of AI agents with one instruction: break them. This folder holds what they wrote and what they found.

Read this first: the numbers below were measured against the **draft** rules the agents were given. Many of those rules have since been changed because of what the agents found. The changed rules have not yet been through a second full round, so "Fixed" means "the defect the agent demonstrated no longer applies as demonstrated", and nothing more.

## How it was run

**Mechanism stress test.** Seven scenarios, one agent each. Every agent received the same written rule set and one line of attack. It had to model the rules exactly, find the strategy that takes the most from the vault, and measure it. The agents used exact enumeration on the one-cent price grid, closed forms where they exist, and Monte Carlo at 200,000 to 1,000,000 paths per case. Each returned its findings with a size, the evidence, the rule at fault, the smallest change that would close it, and a list of rules it tried to break and could not.

The seven scenarios reported 58 findings between them, 13 of them rated critical. Each finding below comes from one agent and has not yet been re-derived by a second. The tables say what is fixed in the code; they do not say the fix has been re-attacked. Both are on the list of next experiments at the end of the scenario tables.

**Code review.** Separately, six agents reviewed the Solidity, each through a different lens: the arithmetic against the written rules, solvency, edge cases, an adversarial caller, test coverage, and a randomized invariant test. Each wrote failing tests that reproduce its findings. The same defects were found independently by several lenses (the unlisted-market defect by five, the share-price defect by five, the forced-close defect by four). Five of the findings were then re-verified by a further agent, and all five were confirmed. The fixes were made from the reproductions.

The invariant test ran 10,400 randomized steps and opened and closed 1,738 positions (1,023 closes, 301 liquidations, 125 forced closes, 124 collects, 165 settlements). No position was ever paid more than its margin plus its locked reserve, and every ledger total returned to zero.

## What held

These are properties the agents attacked and could not break.

- **No payout ever exceeded the locked reserve.** Every loss in this document is an expected-value loss inside the reserve. None is a shortfall.
- **Worse-of fills defeat the plain price push.** Opening and then closing into a pushed price is a loss at every leverage and hold time once the cost of the push is paid.
- **A leveraged position through a jump straight to the result costs the vault what an unleveraged bet would.** Exact, at any leverage. A Yes position and a No position with equal shares are flat through every jump.
- **No uninformed strategy has a positive expected value in a diffusive market.** Every one tested loses 3% to 27% of the stake per position under the draft rules.
- **The square-root-of-time leverage limit keeps leverage out of play.** In 200,000 simulated matches no leveraged position could be opened on a late favourite.
- **Fee accounting order.** Every entry point accrues before it changes state, so a one-second offset or splitting a position saves nothing.
- **Time decay on a continuously traded underlying is not an edge.** On a "will it trade above X" market the side that decays in its favour pays for it through adverse moves.

## Mechanism scenarios

Sizes are per $1 of margin unless a line says otherwise. "House" is the vault.

### diffusive-baseline

A mostly diffusive market far from its result. Baseline costs, and a search for any strategy with positive expected value.

| Finding | Measured size (draft rules) | Status |
|---|---|---|
| A one-tick head start or last look flips the sign of every bet | +0.28 to +0.42 per trade at 25×; +0.15 to +0.17 at 10× | **Open.** A trader can choose among the signed prices of the last 20 seconds. Maximum leverage is now 10×, so the lower figure applies. The fix is two-step fills. |
| A jump that stops short of 0 or 1 pays the cheap side | +1.30 per ±10-point jump for a 10× buyer of the 20c side; a balanced book still costs the house 0.91 per jump | **Fixed.** A leveraged win is now capped at the smaller of the stake and the outright payoff, so the two lines are equally far for the underdog. |
| Stop-line pocket: the third tick down skips the 20% buffer | 82 of 2,232 price and leverage pairs positive, best +4.1% per bet | **Fixed.** Minimum line distance is 5 ticks. The agent's own re-test: 0 of 2,232 pairs positive. |
| "Chance of winning equals the entry price" is the chance of touching the win line, not of being paid | Paid with probability 0.38 to 0.48 at 25× and 50c, against 0.50 | **Open.** It favours the house. The whitepaper now says so. |
| Crowding fee shed for free by closing at break-even | Fee paid falls by about half in a diffusive market | **Fixed.** The fee comes out of the stake while the position is open. |
| A 1× position is liquidated at an 80% loss | Liquidated in 55.6% of cases instead of resolving No in 50% | **Fixed.** A 1× prediction position is never liquidated. |
| Cost to an honest trader at maximum leverage | 15% to 27% of the stake per position in an active market | **Reduced.** The agent measured 7% to 16% with a 5-tick distance. |

### jump-straddle

Yes and No held together through one jump to the result, partial jumps, and repeated jumps.

| Finding | Measured size (draft rules) | Status |
|---|---|---|
| Free mode pays the full outright win on a partial move | House −0.55 per symmetric 20-point jump against the 30c side; −1.30 per 10-point jump at 20c | **Fixed.** Same change as above. The agent tested this cap: best-response result on symmetric jumps falls from +0.55 to −0.01. |
| Boost: a Yes and No pair through an anticipated jump | House −1.44 (10 points) to −3.40 (20 points) per $1 of pair margin | **Reduced.** Scheduled news now forces 1× through the event clock, and the Boost premium is 2.5 times the base rate. An unscheduled jump a little larger than the stop distance still favours the pair. |
| Crowding fee does not cover partial crashes, and low-leverage positions on the other side switch it off | House −0.22 over 5 days at full fee; −0.62 when it is switched off | **Open.** |
| Winners near the time limit are force-closed at the lagging price | House +0.50 per $1, taken from winners | **Fixed.** The limit is now taken at the position's own entry price, so only time triggers it, with 25% slack. Before expiry a forced close needs the two prices within one cent. |
| Two jobs paid the caller nothing: the kickoff close and liquidating through the stop | A late keeper turns a +0.28 pair into −0.14 | **Fixed.** The liquidator's reward now comes from the margin the vault keeps, and a position still leveraged when the event starts can lose but cannot win. |
| A two-tick flicker in the mid liquidates one leg of every pair at maximum leverage | House +0.50 per spike, taken from traders | **Open.** With a 5-tick distance it now takes a four-tick flicker. |
| A 1× position is liquidated | 53% to 55% of matches | **Fixed.** |
| A balanced pair, or a 1× position on a cheap contract, holds capacity and reserve at no cost | A 1× position at 2c locks $49 of reserve per $1 | **Open.** Opens below 3c are now refused, which bounds it at about $32. |
| Draft engine differed from the rules: lazy accrual, and a 10× ceiling on 1× positions | The whole holding period on a quiet market | **Fixed.** |

### drift-harvest

The side of a "will it happen by a date" market that wins when nothing happens.

| Finding | Measured size (draft rules) | Status |
|---|---|---|
| With no fee, the harvest pays about the hazard rate on borrowed size | +0.48 per day at 50c with 30 days left | This is what the crowding fee is for. |
| Reset attack: close and re-open before each tick to shed the fee | +0.43 per day, 90% of the no-fee harvest | **Fixed.** The fee comes out of the stake. |
| Fee clock is the contract date, so a market decided early is under-priced | +0.76 per day when the true window is a third of the contract | **Open.** The fee scale and clock are per market. No listed market is of this kind. |
| Tick sniping with an older signed price | +0.40 per tick at 25× | **Open.** Same root as the last-look finding. |
| A winnings-only fee collects about 80% of the fair charge when the price is noisy | +0.016 per day | **Fixed.** |
| Honest traders: the fee eats the whole capped profit; forced closes are not free | All winnings gone after 5.3 hours at 10× two days before kickoff | **Fixed.** The fee is off on sports and price-on-a-date markets. |

### fee-gaming

Every way of dodging the crowding fee.

| Finding | Measured size (draft rules) | Status |
|---|---|---|
| Fee reset by closing flat and re-opening | Fee paid 0.2% of the stake instead of 5.2% per tick; +3.4% to +12.6% | **Fixed.** |
| Profit cap makes the fee under-collect | About 37% short | **Fixed.** |
| A whole unaccrued interval is priced at the price of the next call | Fee multiplied by 0.10 if a 99c print is used | **Fixed.** Each interval is priced at the mid stored when it began. The stretch that ends in a result is charged up to the result. |
| Scheduled one-sided step, opened seconds before | +0.69 per event | **Fixed.** Each market carries the time of its next scheduled information event. Leverage is 1× at it. |
| One-hour floor on the fee clock | Matters only if forced closes have failed for a long time | **Open.** Unchanged. |
| Offsetting, splitting, flash offsets, Boost as a dodge | No saving in any | Held. |

### sports

Leverage before a match, the hand-over at kickoff, and positions held through play.

| Finding | Measured size (draft rules) | Status |
|---|---|---|
| After kickoff a holder can sell at the price from before a score | House −0.07 to −0.33 per $1 staked, even at 1× | **Fixed** in the engine: see the expiry rule in `contracts/src/PerpEngine.sol` and its tests. |
| Before the match a bot can open at the price from before team news | +0.16 to +1.21 per news item | **Open.** Same root as the last-look finding. Leverage on sports is now at most 5×. |
| A 2 to 4 point stop in front of scheduled team news | +0.39 to +1.28 per announcement on the cheap side | **Fixed.** Minimum distance on sports is 10 ticks and Boost is off. The agent's re-test of this rule: house +0.03 to +0.05. |
| The kickoff hand-over depends on one keeper | Upkeep stalled all match: +0.10 to +0.58 to the trader | **Reduced.** From expiry on a leveraged position cannot win. One that was losing at kickoff can still get back to its stake if the keeper is late. |
| Forced close at the slow price after a jump | −0.50 to the trader | **Fixed.** |
| Time-based fee and Boost premium overcharge before a match | A 5× position owes its whole possible profit after 22% of the time left | **Fixed.** Both are off on sports. |
| 1× bets liquidated, and capped at 10× | 60% of 1× Yes bets liquidated before the whistle | **Fixed.** |
| Voided matches settle as No | 5% chance of a void is worth +0.09 on a 35c No | **Open.** |
| Capacity held for free before kickoff | No cost | **Open.** |
| In-play leverage would not be safe | +0.55 to +2.20 per goal | Not allowed by the rules. |

### early-resolution

Markets that can be decided before their date, such as "will NVDA trade above $200 before 2027".

| Finding | Measured size (draft rules) | Status |
|---|---|---|
| Scheduled gaps: the cheap side at maximum leverage before an earnings release | +0.41 to +1.28 per release | **Fixed.** The event clock forces 1× at each scheduled release. The agent's re-test of this rule: −0.02 and −0.04. |
| Scheduled decision points in a "by a date" market | +0.39 to +0.92 per decision | **Fixed.** Same clock. |
| Fee uses the contract-end clock | Collects 4% of the harvest when the decision window is early | **Open.** |
| Fair value is known inside the one-cent tick | +2.6% to +4% per trade at a two-tick distance | **Fixed.** With a 5-tick distance the agent measured −0.4%. |
| No close-only state once the outcome is decided | +0.9% to +4.7%, risk-free | **Reduced.** Nothing opens below 3c or above 97c. A stale price from before a release is still the last-look problem. |
| The leverage limit misprices a market near its barrier on the last day | A liquidation 60 seconds late gives away +0.11 | **Open.** |
| Reserve held for months at no charge by a 1× position on a cheap contract | $9 locked per $1 for up to 320 days | **Open.** |

### thin-book-push

Manipulating the reference price on a thin Gemini book. This scenario reported last. Two of its findings were answered with a rule change before deployment; the rest are open.

| Finding | Measured size (draft rules) | Status |
|---|---|---|
| Depth spoofing: resting orders that never trade raise capacity | House −$3,079 per cycle on a $99,000 spoof, against a $27 push | **Reduced.** Each side of a prediction market now has a ceiling of $1,000 that does not come from the signed book, so resting quotes cannot unlock more than that. The agent measured the same spoof at −$16 for the house with a ceiling of this kind. |
| Two-leg push and release harvests the slow-price lag twice | House −$37.80 per $1,000 of depth per cycle; attacker +$8.60 | **Open.** |
| Thin favourite at an extreme price: capacity in dollars buys many cheap shares | +$270 per $1,000 of depth per cycle | **Fixed.** Capacity on a prediction market is now sized in shares: it is scaled by twice the distance to the nearer of 0 and 1, and the share of depth was cut from 0.5 to 0.25. |
| A fee-free reference venue makes the one-leg push pay | +$6.50 per $1,000 of depth | **Open.** A minimum holding time closes it. |
| A pushed mid can trigger other traders' stop-outs | A few dollars per victim; harm to traders, not the vault | **Open.** |
| Capacity multiple documented as 2.0 and deployed as 0.5 | At 2.0 the plain push pays | **Fixed.** The documents and the deployment now agree: 0.5 on crypto, stocks and commodities, 0.25 in shares on prediction markets. |

On the live books this is bounded by size. The Gemini contracts listed here have $660 to $1,800 resting within five ticks, so capacity is a few hundred dollars per side.

### Next experiments

The stress test is something to keep running, and each round should make the mechanics safer. Scripts for these four scenarios are started in the folders of the same name. None has produced a result yet, so no number is quoted from them.

- `stale-price`: choosing among signed prices inside the validity window.
- `boost-pricing`: whether the Boost premium covers what Boost can pay.
- `solvency-accounting`: a randomized accounting model of the vault.
- `no-funding-nonevent`: what the absence of a funding rate costs on crypto, stock and commodity markets.

Two more belong on the same list:

- A second agent re-deriving each finding from scratch. A start on the fee findings is in `verify-fee-gaming`.
- A second round of the seven scenarios above against the changed rules.

## Code review

Distinct defects after removing duplicates between lenses.

| Defect | Severity given | Status |
|---|---|---|
| `poke()` on an unlisted market kept it out of the market list for good | High | **Fixed.** Listing has its own flag. |
| LP share price marked positions past their cap or stop against other positions' headroom. In one test a 1 USDC deposit could take the pool | Critical | **Reduced.** Each side of each market is now bounded by its own margin and reserve before netting. Positions on the same side of the same market are still netted against each other. |
| Deposit, relay a signed price, redeem, in one block | Critical | **Fixed.** Shares are locked for 10 minutes after a deposit. Deposits are for oneself only. Locked shares cannot be transferred. |
| Forced close judged at the mid and filled at the lagging price | High | **Fixed.** |
| Fees priced at the next touch, and never charged for the stretch ending in a result | Medium | **Fixed.** |
| The on-chain slow price treats the newest relayed sample as held until the next, and the caller picks which samples land | High | **Open.** One hand-picked sample turns the replay's +$187 into about +$4,300, against roughly $52,000 to make the print. The fix is for the keeper to sign its own average over every sample. |
| A fully paid 1× prediction position could be liquidated on one print | Medium | **Fixed.** |
| Staking: small fees rounded to zero and were then stuck | Medium | **Fixed.** Only what was credited is marked as accounted. |
| No reward for liquidating a position that jumped through zero equity | Low | **Fixed.** |
| Setters accepted settings that break views or closes | Low | **Fixed.** Zero minimum margin, changing a market's kind, and Boost with no price are refused. Event prices above 1 are clamped. |
| Fee clock after expiry; fee at zero capacity; gap test rounding; liquidation price once charges exceed the buffer; per-day quotes looking backward | Low | **Fixed.** |
| Rule text said (1 − p)/τ where the contract charges p(1 − p)/τ | Low | **Fixed.** The text follows the contract. |
| A flat long and short pair can lock the vault's free liquidity at no cost | Low | **Open.** Bounded by each market's capacity and position limit. |
| `open` and `close` take no price limit | Low | **Open.** |
| The market list only grows, so vault calls get dearer | Low | **Open.** |

## What this folder contains

One folder per scenario: the agent's model of the rules, its attack scripts, and their text outputs. Large JSON dumps and compiled files were left out, and local paths were replaced with relative ones. The scripts are Python, with one C simulator in `early-resolution`. They were written to be run once by their author and are kept as evidence. They model the draft rules.

The contract tests are in `contracts/test`.

## What is still open, in one place

See [What we are still working on](../docs/whitepaper/09-risks.md).
