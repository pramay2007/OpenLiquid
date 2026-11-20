# Leverage on prediction markets

OpenLiquid lists live contracts from Gemini Prediction Markets and lets you trade them with leverage. You can take a position on "Arsenal to beat Dortmund" or "BTC above $60,000 on 30 November", sized several times your stake, and be paid as soon as the odds move your way.

Prediction markets have had almost no leverage until now, and for a good reason. This page explains the reason, the rules we use, and what a group of adversarial agents found when they attacked those rules.

## Why leverage on prediction markets is hard

On an ordinary market, a leveraged position that is losing gets closed before the loss exceeds its margin. That works when prices move in small steps.

A prediction market does not move in small steps. It can go from 54 cents to 20 cents on one headline, and at the end it goes to exactly 0 or 100. Nobody can close a position in the middle of a jump.

So take two people with $100 each, both at 10× on a market at 54 cents, one on each side. The market jumps to 20 cents. The loser can only lose their $100. The winner, paid on the full move, is owed about $739. The house collects $100 and pays $739.

Every team that has tried leverage here has run into this. The published answers are to keep leverage very low, to lend against shares with a large safety margin, to force positions closed before the result, or to charge a fee equal to the expected shortfall. Research on real Polymarket data found that margin rules alone mostly fail, because the final jump is too large for any margin to cover.

## The rule: leverage zooms the odds

Our answer is to change what a leveraged position can win.

> **A leveraged position can win at most what its stake would win if you simply bought the shares and your side won, and never more than the stake itself.** Leverage makes the position reach that payout sooner. It does not make the payout bigger.

Take $100 on Yes at 54 cents.

| | Wins $85.19 when | Loses the $100 when |
|---|---|---|
| Outright (1×) | the market resolves Yes | the market resolves No |
| 5× | the odds reach 63.2¢ | the odds fall to 43.2¢ |
| 10× | the odds reach 58.6¢ | the odds fall to 48.6¢ |

The payout is the same in every row. Leverage shrinks the distance the odds have to travel. At 10× the bet is decided by a move of 4.6 points in the odds, which might happen this week, and not by an election two years away.

Now the other side. $100 on No at 46 cents would win $117.39 outright. With leverage it can win at most $100. An underdog position with leverage is double or nothing on a short move.

The two edges have names. The **win line** is where the position is paid in full. The **stop line** is where the stake is gone; the position is closed a little before it, when 20% of the stake is left, and what is left goes back to the trader.

```
stop line  =  entry − entry / leverage
win line   =  entry + (maximum win / stake) × entry / leverage
```

For a favourite the win line is `(1 − entry) / leverage` above entry. For an underdog it is exactly as far above entry as the stop line is below it. (For a No position the same lines apply to the No price, which is one minus the Yes price.)

### Why this is fair to the trader

For a price that moves fairly and in small steps, the chance of reaching the win line before the stop line works out to the entry price for a favourite, and to one half for an underdog. In both cases the bet has no built-in edge for either side.

That is the chance of the odds touching the line. Being paid also needs the slow price to get there, and positions are stopped out a little before the stop line. The stress test measured what that costs. See below.

### Why the win is never more than the stake

Our first version capped the win at the outright payoff alone. On a jump straight to the result that is exactly fair: the house owes what it would owe someone who had bought shares with no leverage.

The stress test found the case it misses. Most jumps do not go to 0 or 100. A headline moves the odds ten points and stops. A cheap position at 20 cents with 10× leverage is then paid its full outright win, four times its stake, on a ten-point move up, and loses only its stake on a ten-point move down. An agent measured this at +$1.30 per dollar staked, per jump.

Capping the win at the stake as well closes it. When a jump crosses both lines, the trader gains only if the jump was more likely than not to go their way, and more likely than the price of their side said. The same agent re-ran its best strategy against this cap: from +0.55 to −0.01.

No cap can fix every case. A position that cannot lose more than its stake always has some pattern of jumps that pays it. The rules choose which patterns are fair, and the rest is handled by the limits below.

### Why this protects the house

The vault locks the position's maximum win when it opens. It can never owe more than that, whatever the price does. In every run of the stress test, across millions of simulated paths, no position was paid more than its locked amount.

### When a position reaches its win line

It has nothing more to gain, so it is closed and paid. Anyone can do that for the owner, and the keeper does it automatically.

### A 1× position is just the shares

A position with no leverage is a plain purchase. It is never liquidated, it has no ceiling other than the outright payoff, and it rides to the result.

## Boost: keeping the leveraged win

Some traders want the full leveraged payout: if the odds go from 54 to 70 cents on a 10× position, they want the $296 that move is worth, and not $85.

That is possible, but it cannot be free. On a jump the loser still pays only their stake, so the difference has to come from somewhere. Boost makes the trader who wants the upside pay for it.

- **Free mode** is the default. The win is capped as above.
- **Boost** raises the cap to the full leveraged win, up to ten times the stake. In exchange the position pays a premium every day, out of its stake.

```
premium per day  =  borrowed shares × p × (1 − p) / days until the result × Boost scale
```

`p × (1 − p)` is how uncertain the market still is. Spread over the days left, it is what a jump to the result would be expected to hand an uncapped position per day. The stress test showed that this under-prices news that moves the odds part of the way, so the scale is 2.5 on the one market that offers Boost.

Boost is expensive close to the result. On a market eleven days away, at 5×, it costs close to half the stake per day. That is the rule working as intended: near the result a jump is nearly certain.

Boost is offered only on markets with a fixed result time and no scheduled news before it. Today that is the BTC price market.

## How much leverage

Three limits apply, and the lowest one wins.

**A ceiling per market.** 10× on dated markets. 5× on sports.

**Both lines a minimum distance away.** Prices move in one-cent steps, and one tick should not be a large part of a position. The minimum is 5 ticks on dated markets and 10 ticks on sports.

```
maximum leverage  =  min(price, 1 − price) / minimum distance
```

On a dated market that is 10× at 50 cents, 6× at 30 or 70 cents, 4× at 20 or 80 cents.

**Less leverage as news nears.** A result known to be coming is a jump known to be coming. Research on how probabilities move gives a way to size this: the total squared movement a fair probability is expected to make before it resolves is `p × (1 − p)`. Spread over the time left, that gives the size of a normal move over any short interval, and the stop line is kept three such moves away over the two minutes it can take the keeper to act.

```
maximum leverage  =  min(price, 1 − price) / (3 × √( p × (1 − p) × 120 s / seconds left ))
```

Leverage therefore falls with the square root of the time left, to 1× at the event.

The clock runs to the market's **next scheduled information event**, which is not always its last. An earnings release, a court date or a vote is a jump at a known time, whether or not it ends the market. Each market carries the time of the next one, and leverage is 1× when it arrives. The stress test found that a clock running only to the contract date let a trader buy the cheap side an hour before an earnings release for +$0.41 to +$1.28 per dollar. With the clock on the release the same trade loses.

A position whose leverage is well above the current limit can be closed by anyone, at the normal closing price and with no penalty. The limit is taken at the position's own entry price, so a move in its favour never makes it closable. Only the passing of time does.

## Different kinds of market

**Dated markets on a traded price**, such as "BTC above $60,000 on 30 November". These move with the underlying price, in small steps. Up to 10×, Boost offered, no crowding fee. On this kind of market the stress test found no strategy without information that makes money.

**Sports.** Odds move little before a match and in jumps once it starts. Up to 5×, lines at least ten points away, no Boost and no crowding fee. Leverage on a match means trading the odds before it starts. A bet held into the match is an ordinary 1× bet on the result.

**News-driven "will it happen by a date" markets.** None is listed today. On these one side wins slowly by nothing happening and loses all at once. A leveraged position on that side collects the drift and risks only its stake. This is what the crowding fee is for on prediction markets:

```
fee per day  =  borrowed shares × p × (1 − p) / days until the result × crowding scale × imbalance
```

The imbalance is measured on borrowed shares: how much more the larger side has borrowed than the smaller, as a share of the larger. The fee comes out of the stake, like Boost. The stress test showed the rate is right when the event can happen at any time up to the contract date, and too low when the decision comes early. The scale and the clock are set per market for that reason, and we would not list such a market with leverage before that is settled.

## Settlement

When Gemini reports a contract settled, the keeper signs the final price, 0 or 1, and the market is closed to further prices. Anyone can then settle any position.

## Costs, in one place

| | Prediction markets |
|---|---|
| Open or close | None |
| Profit share | 10% of profit |
| Crowding fee | Off on the markets listed today |
| Boost premium | Only if chosen; from the stake |
| Capacity per side | A quarter of the dollars resting within five ticks of the mid on Gemini, once they have stayed there, sized in shares, and never more than $1,000 |
| Averaging time of the slow price | 300 seconds |

## What it costs an honest trader

The stress test measured this too. A trader with no information, at maximum leverage, loses a part of the stake on average. The causes are the 10% profit share, the liquidator's cut, tick rounding, and the fact that a stop is judged at the live price while a win needs the slow price to catch up. Under the first rules, with lines two ticks away, that was 15% to 27% of the stake per position in an active market. With lines five ticks away an agent measured 7% to 16%. Lower leverage costs less.

## Where the data comes from

All of it is Gemini's public market-data API, with no key.

| Use | Endpoint |
|---|---|
| Choosing which contracts to list | `GET /v1/prediction-markets/events` |
| Price and depth, every 4 seconds | `GET /v1/book/{symbol}` |
| Chart history | `GET /v2/candles/{symbol}/1hr` |
| Detecting settlement | `GET /v1/prediction-markets/events/{ticker}` |

## What we are still working on

Leverage on prediction markets is new, and we do not think every part of this is finished. The stress test left open items, and the largest is that a trader can choose among the prices signed in the last 20 seconds. The full list, with the measured size of each, is on its own page: [What we are still working on](09-risks.md).

Next: [The OLQ token](06-olq-token.md)
