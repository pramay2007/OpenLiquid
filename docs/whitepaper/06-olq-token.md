# The OLQ token

OLQ is the protocol's token. There is no pre-mint. It is earned by trading, and staking it earns a share of protocol fees in USDC.

OLQ is designed around one job: refilling the vault.

## The design, in four lines

1. **You earn OLQ by losing.** When a position closes at a loss, the loss goes to the vault and the trader receives OLQ for it. That is the only way OLQ is minted.
2. **The rate is boosted when the vault is drawn down.** While the vault holds less than its liquidity providers put in, each dollar lost mints more OLQ.
3. **Winners are paid first in, first out.** They are paid from the vault. If the vault is ever short, they are paid in order as losses refill it.
4. **You stake OLQ to earn fees from winners.** Stakers receive 30% of every profit fee, in USDC.

## Why it is built this way

A venue with no order book needs someone on the other side of every winning trade. Here that is the vault. The question every such venue has to answer is what happens when the vault has been paying out.

OLQ is the answer. Every OLQ minted corresponds to a dollar that entered the vault as a loss. When the vault is full, losing earns the base rate. When the vault has been drawn down, losing earns more, so trading that refills the vault is rewarded exactly when it is needed. That is how liquidity comes back.

Staking closes the loop. A trader who earned OLQ through losses can stake it and earn a share of what winners pay from then on.

## Emission and supply

The base rate is 100 OLQ per dollar lost. While the vault's value is below what its liquidity providers deposited, the rate is boosted, and the boost grows with the size of the shortfall.

There is no pre-mint, no team allocation, no investor allocation and no airdrop. There is no fixed cap: OLQ is minted for as long as losses are refilling the vault. It is transferable from the first token, and the only minter is the trading engine.

## Staking

Staked OLQ earns 30% of every profit fee, paid in USDC. The other 70% stays in the vault with the liquidity providers. There is no lock-up; a staker can unstake or claim at any time.

Stakers are paid from fees and only from fees. They do not receive trader losses and do not pay trader wins. That risk and that reward both belong to the liquidity providers.

## What to watch

A token minted on losses can be farmed by two wallets trading against each other: one loses and earns OLQ, the other wins the same amount back less the profit fee. The fee is the cost of that farm. It is on the list of [what we are still working on](09-risks.md).

## What OLQ is not

This is a testnet deployment. OLQ on Arc testnet has no value and is not offered for sale. The contracts are unaudited.

Next: [Oracle, keeper and Arc](08-oracle-keeper-arc.md)
