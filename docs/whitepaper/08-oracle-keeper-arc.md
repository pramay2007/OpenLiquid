# Oracle, keeper and Arc

## Signed prices

A price reaches the contracts as a signed message with five fields.

| Field | Meaning |
|---|---|
| `marketId` | Which market |
| `price` | The reference mid |
| `depthUsd` | Dollars resting near the mid, on the thinner side |
| `timestamp` | When it was signed, in chain time |
| `resolved` | For prediction markets: this is the final price |

The oracle contract checks the signature against its list of signers (EIP-712), refuses timestamps from the future, ignores anything older than what it already has, and accepts nothing more for a market once it is resolved. Anyone may deliver a signed price. Delivering one earns nothing and grants nothing.

Every trade carries a fresh signed price inside the same transaction. A trader is never waiting for somebody else to update the oracle.

## The keeper

The keeper is a small program that runs once a second.

1. Read prices: Hyperliquid's best bid and offer by websocket, Gemini's books by REST.
2. Sign one update per market, with the mid and the nearby depth.
3. Serve the signed updates to the app, so each trade can carry one.
4. Post them on-chain when a market's price has moved enough or its heartbeat is due.
5. Scan open positions and liquidate, force-close or settle whatever is due.

What it is not allowed to do:

- It never signs a price whose source is more than 15 seconds old.
- It marks a prediction market resolved only when Gemini reports the contract settled.
- Its key has no administrative role and holds no user funds.

What the contracts stop it doing regardless: signatures are checked, timestamps cannot go backwards, prices expire after 60 seconds, and resolved markets are closed to updates.

The limit of this design is stated plainly in [Risks and assumptions](09-risks.md): one signer is one point of trust.

## Why Arc

**One unit of account.** Margin, profit, fees, the vault and staking rewards are in USDC. On Arc gas is in USDC as well, because USDC is the chain's native token. A trader holds one asset.

**Small, predictable fees.** Opening or closing a position costs about 0.006 USDC in gas, measured on testnet. Deploying the whole protocol, with its 15 markets, cost about 0.3 USDC.

**Fast finality.** A signed price is valid for 60 seconds. A trade on Arc is final well inside that.

**No wallet needed to try it.** The demo account is a key created in the browser. The keeper sends it 0.1 USDC once, which is enough gas for about fifteen transactions.

## USDC from other chains, with CCTP

The app's Bridge page moves USDC between Arc and five other test networks (Base, Ethereum, Arbitrum, OP and Avalanche) using Circle's Cross-Chain Transfer Protocol, version 2.

A transfer is one transaction. USDC is burned on the chain it is leaving, with a hook that asks Circle's forwarding service to finish the job. Circle attests the burn and submits the mint on the other chain. The sender needs no gas token on the destination and signs nothing there. Fees are read live from Circle and shown before signing.

On Arc this matters twice over, because the USDC that arrives is also the gas the account needs.

On this testnet deployment the trading collateral is a faucet token, so that anyone can try the venue at size without waiting on a faucet. USDC bridged to Arc pays an account's gas. On a mainnet deployment the collateral is USDC itself, and the same transfer is the deposit.

Circle's USDC Paymaster is not deployed on Arc, and is not needed there: gas is already paid in USDC.

Next: [Risks and assumptions](09-risks.md)
