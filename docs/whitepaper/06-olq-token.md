# The OLQ token

OLQ is the protocol's token. There is no pre-mint. It is earned by trading, and staking it earns a share of protocol fees in USDC.

> **Status.** This page describes the OLQ design. The contracts on Arc testnet today run the first version of the token, which mints OLQ on the fee a winner pays. The loss-minted version below is the next contract update.

## How it works, in four lines

1. **You earn OLQ by losing.** When a position closes at a loss, the loss goes to the vault and the trader receives OLQ for it. That is the only way OLQ is minted.
2. **The rate is boosted when the vault is drawn down.** While the vault holds less than its liquidity providers put in, each dollar lost mints more OLQ.
3. **Winners are paid first in, first out.** They are paid from the vault. If the vault is ever short, they are paid in order as losses refill it.
4. **You stake OLQ to earn fees from winners.** Stakers receive 30% of every profit fee, in USDC.

## Why it is built this way

A venue with no order book needs someone on the other side of every winning trade. Here that is the vault. The question every such venue has to answer is what happens when the vault has been paying out.

OLQ is the answer. Every OLQ minted corresponds to a dollar that entered the vault as a loss. When the vault is full, losing earns the base rate. When the vault has been drawn down, losing earns more, so trading that refills the vault is rewarded exactly when it is needed. That is how liquidity comes back.

Staking closes the loop. A trader who earned OLQ through losses can stake it and earn a share of what winners pay from then on.

## Emission

```
base rate(F)  =  R0 × ( H / (H + F) )²        OLQ per $1 lost
```

`F` is the running total that has been paid in so far. `R0` is 100. `H` is $1,000,000. The base rate falls smoothly as the total grows. There are no epochs and no schedule to game.

The boost multiplies the base rate while the vault's value is below what its liquidity providers deposited, and grows with the size of the shortfall. Boosted minting counts against the same curve, so it brings the cap closer and never raises it.

## Supply

Summed over everything that could ever be minted, the curve produces `R0 × H` tokens. That is a hard ceiling of **100,000,000 OLQ**, set by the arithmetic of the curve and not by an administrator.

- No pre-mint, no team allocation, no investor allocation, no airdrop.
- Transferable from the first token.
- The only minter is the trading engine.

## Staking

Staked OLQ earns 30% of every profit fee, paid in USDC. The other 70% stays in the vault with the liquidity providers. There is no lock-up; a staker can unstake or claim at any time.

Stakers are paid from fees and only from fees. They do not receive trader losses and do not pay trader wins. That risk and that reward both belong to the liquidity providers.

## What to watch

A token minted on losses can be farmed by two wallets trading against each other: one loses and earns OLQ, the other wins the same amount back less the profit fee. The fee is the cost of that farm, and the cap and the falling rate bound what it can earn. It is on the list of [what we are still working on](09-risks.md).

## What OLQ is not

This is a testnet deployment. OLQ on Arc testnet has no value and is not offered for sale. The contracts are unaudited.

Next: [Oracle, keeper and Arc](08-oracle-keeper-arc.md)
