# Parameters and contracts

## Market parameters

These are the values in the Arc testnet deployment. They are set per market by the contract owner and are readable on-chain.

| | Crypto | Stocks and commodities | Prediction markets |
|---|---|---|---|
| Maximum leverage | 1000× | 1000× | 50×, then the tick and time limits |
| Averaging time of the slow price | 60 s | 120 s | 300 s |
| Capacity multiple κ | 0.5 | 0.5 | 2.0 |
| Depth band on the reference venue | ±10 basis points | ±10 basis points | ±5 ticks |
| Opens pause when the price gap exceeds | 20 basis points | 25 basis points | 5 points |
| Per-position limit | $10M | $5M | $100k |
| Profit fee | 5% | 5% | 10% |
| Maximum funding per day, at full skew | 0.05% | 0.05% | 0.10% |
| Borrow fee per day | None | None | 0.2% on notional minus margin |
| Leverage compression window | None | None | 24 hours |

## Engine parameters

| Parameter | Value |
|---|---|
| Profit cap | 10× margin |
| Liquidation threshold | Equity at 20% of margin |
| Liquidator reward | 5% of margin |
| Entry guard | Fill may start at most 30% of margin under water |
| Staker share of profit fees | 30% |
| Minimum margin | $1 |
| Price validity | 20 seconds |
| Event markets: minimum distance to zero equity | 2 ticks |

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
| PerpEngine | Positions, fills, limits, funding, liquidation, settlement | [`0xa7c418e3A57292F59eCB554191D2906cd0Cd44e8`](https://explorer.testnet.arc.io/address/0xa7c418e3A57292F59eCB554191D2906cd0Cd44e8) |
| Vault | ERC-4626 pool: trader margin, reserves, liquidity providers | [`0x2b32560890De4070A66b47fD4242F2b817FBEF58`](https://explorer.testnet.arc.io/address/0x2b32560890De4070A66b47fD4242F2b817FBEF58) |
| PriceOracle | Verifies signed prices, keeps the mid and the slow price | [`0xbF48c715F8816649D7D56AC01e5ae19850Ae517a`](https://explorer.testnet.arc.io/address/0xbF48c715F8816649D7D56AC01e5ae19850Ae517a) |
| OpenLiquidToken | OLQ, minted on fees | [`0x0C1221ee07A921B078391512acb8fD1dCE72E6C3`](https://explorer.testnet.arc.io/address/0x0C1221ee07A921B078391512acb8fD1dCE72E6C3) |
| Staking | Pays stakers their share of fees in USDC | [`0xb0FaFD344dE5d451638B7711206e6A3Df0902f06`](https://explorer.testnet.arc.io/address/0xb0FaFD344dE5d451638B7711206e6A3Df0902f06) |
| Test USDC | Collateral on testnet, with an open faucet | [`0xE4475D526B1f625C87b3B0C56C7548016d20BB72`](https://explorer.testnet.arc.io/address/0xE4475D526B1f625C87b3B0C56C7548016d20BB72) |

The price signer and keeper is [`0xe386ABa1C3197D166130ec45566208b0A658F6d2`](https://explorer.testnet.arc.io/address/0xe386ABa1C3197D166130ec45566208b0A658F6d2).

## Source

The contracts, the keeper, the web app and the tests are in the repository at [github.com/pramay2007/OpenLiquid](https://github.com/pramay2007/OpenLiquid).

| Path | Contents |
|---|---|
| `contracts/src/` | The six contracts |
| `contracts/test/` | 30 tests, including the replay |
| `keeper/` | Price signer, relayer, liquidation and settlement bot |
| `web/` | The trading interface |
| `docs/whitepaper/` | These pages |

Next: [Questions and answers](11-faq.md)
