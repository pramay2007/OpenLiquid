# The OLQ token

OLQ is the protocol's token. It is minted by trading, there is no pre-mint, and staking it earns a share of protocol fees in USDC.

The one design decision that matters is *what* mints it. On OpenLiquid a token is minted when a trader pays a fee. It is never minted for losing.

## Emission

OLQ is minted in one place only: when a position closes in profit and pays the profit fee. The trader who paid the fee receives the tokens.

```
rate(F)  =  R0 × ( H / (H + F) )²        OLQ per $1 of fee
```

`F` is the total of all fees paid so far. `R0` is 100. `H` is $1,000,000.

| Fees paid so far | OLQ minted per $1 of fee | Share of maximum supply minted |
|---|---|---|
| $0 | 100 | 0% |
| $250,000 | 64 | 20% |
| $1,000,000 | 25 | 50% |
| $3,000,000 | 6.25 | 75% |
| $9,000,000 | 1 | 90% |

The rate falls smoothly as fees accumulate. There are no epochs and no schedule to game.

## Supply

Summed over all the fees that could ever be paid, the curve mints `R0 × H` tokens. That is a hard ceiling of **100,000,000 OLQ**, enforced by the arithmetic of the curve and not by an administrator.

- No pre-mint, no team allocation, no investor allocation, no airdrop.
- Transferable from the first token.
- The only minter is the trading engine. That is set once and cannot be changed.

## Staking

Staked OLQ earns 30% of every profit fee, paid in USDC. The other 70% stays in the vault with the liquidity providers. There is no lock-up; a staker can unstake or claim at any time.

Stakers are paid from fees and only from fees. They do not receive trader losses and do not pay trader wins. That risk and that reward both belong to the liquidity providers.

## Why not mint on losses

Papertrade mints its token to traders in proportion to what they lose. We chose not to copy that, for three reasons.

**It pays people to trade against themselves.** With one price and no spread, a trader can open a long from one wallet and a short from another. One wallet loses what the other wins. If losing mints tokens, the pair collects tokens on the whole loss while the matching win gives most of the money back. On OpenLiquid the same pair mints OLQ only on the fee it actually pays, at the same rate as everyone else. There is no cheaper way to get the token than paying the protocol.

**It ties the token to the venue losing its users' money.** Under loss emission, supply grows fastest when traders are doing worst. Under fee emission, supply grows when traders are winning and paying fees, and every token in existence corresponds to a dollar-denominated fee that was really paid.

**It needs no ceiling.** A token minted on losses has to keep minting as long as people lose. Papertrade's current rule mints in proportion to the existing supply, with no maximum. OLQ has a fixed maximum and the minting rate can only go down.

| | Papertrade (PAPER) | OpenLiquid (OLQ) |
|---|---|---|
| Minted when | A trader loses | A trader pays a profit fee |
| Minted to | The loser | The fee payer |
| Maximum supply | None stated | 100,000,000 |
| Transferable | Not at launch | From the start |
| Stakers earn | Half of fees, plus pool surplus above a cap | 30% of profit fees |
| Stakers paid when | Only while no winner is waiting in the queue | Always; there is no queue |

The Papertrade column is our reading of its public documentation at [docs.papertrade.xyz](https://docs.papertrade.xyz/) in November 2026.

## What OLQ is not

This is a testnet deployment. OLQ on Arc testnet has no value and is not offered for sale. The contracts are unaudited.

Next: [What we changed from Papertrade](07-what-we-changed.md)
