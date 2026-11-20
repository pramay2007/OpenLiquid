# Parameters and contracts

## Market parameters

These are the values in the Arc testnet deployment. They are set per market by the contract owner and are readable on-chain.

| | Crypto | Stocks and commodities |
|---|---|---|
| Maximum leverage | 1000× | 1000× |
| Averaging time of the slow price | 60 s | 120 s |
| Capacity per side | 0.5 × persistent depth | 0.5 × persistent depth |
| Depth band on the reference venue | ±10 basis points | ±10 basis points |
| Opens pause when the price gap exceeds | 20 basis points | 25 basis points |
| Per-position limit | $10M | $5M |
| Profit share | 5% | 5% |
| Crowding fee at full imbalance | 0.05% of size per day | 0.05% of size per day |
| Profit cap | 10× margin, or a 100% move | 10× margin, or a 100% move |

| | Dated prediction markets | Sports |
|---|---|---|
| Listed today | BTC price on November 30 | Four matches |
| Maximum leverage | 10× | 5× |
| Minimum distance to each line | 5 ticks | 10 ticks |
| Reaction time in the time limit | 120 s, three standard deviations | 120 s, three standard deviations |
| Boost | Yes, scale 2.5 | No |
| Crowding fee scale | 0 | 0 |
| Leveraged win, free mode | The smaller of the stake and the outright payoff | The same |
| Win at 1× | The outright payoff | The same |
| Boost win | The leveraged win, up to 10× the stake | Not offered |
| Averaging time of the slow price | 300 s | 300 s |
| Capacity per side | 0.25 × persistent depth within 5 ticks × 2·min(p, 1−p), at most $1,000 | The same |
| Opens pause when the price gap exceeds | 5 points | 5 points |
| Opens refused | Below 3c and above 97c | The same |
| Per-position limit | $100k | $100k |
| Profit share | 10% | 10% |

## Engine parameters

| Parameter | Value |
|---|---|
| Liquidation threshold | Equity at 20% of margin |
| Liquidator reward | 5% of margin |
| Entry guard | Fill may start at most 30% of margin under water |
| Forced close | Leverage more than 25% above the time limit; before expiry, the two prices within one cent |
| Staker share of profit fees | 30% |
| Minimum margin | $1 |
| Price validity | 20 seconds |
| LP withdrawal delay after a deposit | 10 minutes |

## Token parameters

| Parameter | Value |
|---|---|
| Starting rate `R0` | 100 OLQ per $1 of fee |
| Curve scale `H` | $1,000,000 of cumulative fees |
| Maximum supply | 100,000,000 OLQ |
| Pre-mint | None |

## Contracts on Arc testnet

Chain ID `5042002`. RPC `https://rpc.testnet.arc.io`.

| Contract | What it does | Address |
|---|---|---|
| PerpEngine | Positions, fills, limits, fees, liquidation, settlement | [`0xD6D4910E7cACf224c143999186f1a745c22CfdF3`](https://explorer.testnet.arc.io/address/0xD6D4910E7cACf224c143999186f1a745c22CfdF3) |
| Vault | ERC-4626 pool: trader margin, reserves, liquidity providers | [`0x4eDafC142dA2d5299424b5ac0b884A194A20f7E1`](https://explorer.testnet.arc.io/address/0x4eDafC142dA2d5299424b5ac0b884A194A20f7E1) |
| PriceOracle | Verifies signed prices, keeps the mid and the slow price | [`0x3D8931Cc87d1A619546A82569E3B0dcb1535EFd5`](https://explorer.testnet.arc.io/address/0x3D8931Cc87d1A619546A82569E3B0dcb1535EFd5) |
| OpenLiquidToken | OLQ, minted on fees | [`0xF22b9D7139D0517DABA57f176Ee25A711601b9a1`](https://explorer.testnet.arc.io/address/0xF22b9D7139D0517DABA57f176Ee25A711601b9a1) |
| Staking | Pays stakers their share of fees in USDC | [`0x40C7E6f03d0B2885976087f1903effD15c691841`](https://explorer.testnet.arc.io/address/0x40C7E6f03d0B2885976087f1903effD15c691841) |
| Test USDC | Collateral on testnet, with an open faucet | [`0xaAC1cE7B8d2a84541B19C559a384207f4C6F2982`](https://explorer.testnet.arc.io/address/0xaAC1cE7B8d2a84541B19C559a384207f4C6F2982) |

The price signer and keeper is [`0xe386ABa1C3197D166130ec45566208b0A658F6d2`](https://explorer.testnet.arc.io/address/0xe386ABa1C3197D166130ec45566208b0A658F6d2).

## Source

The contracts, the keeper, the web app and the tests are in the repository at [github.com/pramay2007/OpenLiquid](https://github.com/pramay2007/OpenLiquid).

| Path | Contents |
|---|---|
| `contracts/src/` | The six contracts |
| `contracts/test/` | The contract tests, including the replay |
| `keeper/` | Price signer, relayer, liquidation and settlement bot |
| `web/` | The trading interface |
| `stress-test/` | The agents' simulations and findings |
| `docs/whitepaper/` | These pages |

Next: [Questions and answers](11-faq.md)
