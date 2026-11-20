import { createPublicClient, formatUnits, http } from "viem";
import { abis, addresses, chain, IS_LOCAL } from "../chain/config";
import { useStore, type MarketState, type PositionRow } from "../state/store";

// A public RPC rate-limits, so off localhost reads go through Multicall3 and polling is slower.
export const publicClient = createPublicClient({
  chain,
  transport: http(),
  pollingInterval: 1000,
  batch: IS_LOCAL ? undefined : { multicall: { wait: 16 } },
});

const usd = (v: bigint) => Number(formatUnits(v, 6));
const wad = (v: bigint) => Number(formatUnits(v, 18));

const read = <T>(address: `0x${string}`, abi: typeof abis.engine, functionName: string, args: unknown[] = []) =>
  publicClient.readContract({ address, abi, functionName, args }) as Promise<T>;

/* eslint-disable @typescript-eslint/no-explicit-any */

export async function refreshMarkets() {
  try {
    const views = await read<any[]>(addresses.PerpEngine, abis.engine, "allMarkets");
    const markets: Record<number, MarketState> = {};
    for (const v of views) {
      const id = Number(v.marketId);
      markets[id] = {
        id,
        enabled: v.config.enabled,
        isEvent: v.config.isEvent,
        // Boost is offered wherever the market charges for it. (`boostEnabled` is the flag an
        // older deployment carried; it is read only until the app is pointed at the new one.)
        boostEnabled: v.config.boostScale != null ? v.config.boostScale > 0n : !!v.config.boostEnabled,
        maxLeverage: Number(v.config.maxLeverage),
        maxProfitMult: Number(v.config.maxProfitMult),
        profitFeeBps: Number(v.config.profitFeeBps),
        maxGapBps: Number(v.config.maxGapBps),
        expiry: Number(v.config.expiry),
        nextEvent: Number(v.config.nextEvent ?? 0n),
        closed: !!v.closed,
        reactionSeconds: Number(v.config.reactionSeconds),
        minDistance: wad(v.config.minDistance ?? 20_000_000_000_000_000n),
        crowdingScale: wad(v.config.crowdingScale ?? v.config.hazardScale ?? 0n),
        boostScale: wad(v.config.boostScale ?? (v.config.boostEnabled ? (v.config.hazardScale ?? 0n) : 0n)),
        maxPositionNotional: usd(v.config.maxPositionNotional),
        longOI: usd(v.state.longOI),
        shortOI: usd(v.state.shortOI),
        mid: wad(v.feed.mid),
        slow: wad(v.feed.slow),
        timestamp: Number(v.feed.timestamp),
        resolved: v.feed.resolved,
        sideCap: usd(v.sideCap),
        maxLevLong: Number(v.maxLeverageLong),
        maxLevShort: Number(v.maxLeverageShort),
        feePerDayLong: wad(v.feePerDayLong),
        feePerDayShort: wad(v.feePerDayShort),
        boostPerDay: wad(v.boostPerDay ?? v.boostPerDayLong ?? 0n),
      };
    }
    useStore.setState({ markets, chainOnline: true });
  } catch {
    useStore.setState({ chainOnline: false });
  }
}

export async function refreshParams() {
  try {
    const [maint, liq, staker, minMargin] = await Promise.all([
      read<number>(addresses.PerpEngine, abis.engine, "maintBps"),
      read<number>(addresses.PerpEngine, abis.engine, "liqFeeBps"),
      read<number>(addresses.PerpEngine, abis.engine, "stakerShareBps"),
      read<bigint>(addresses.PerpEngine, abis.engine, "minMargin"),
    ]);
    useStore.setState({
      params: {
        maintFraction: Number(maint) / 1e4,
        liqFeeFraction: Number(liq) / 1e4,
        stakerShare: Number(staker) / 1e4,
        minMargin: usd(minMargin),
      },
    });
  } catch {
    /* defaults stay in place */
  }
}

export async function refreshAccount() {
  const account = useStore.getState().account;
  if (!account) return;
  try {
    const [usdc, allowance, olq, gas, views] = await Promise.all([
      read<bigint>(addresses.USDC, abis.usdc, "balanceOf", [account.address]),
      read<bigint>(addresses.USDC, abis.usdc, "allowance", [account.address, addresses.Vault]),
      read<bigint>(addresses.OpenLiquidToken, abis.token, "balanceOf", [account.address]),
      publicClient.getBalance({ address: account.address }),
      read<any[]>(addresses.PerpEngine, abis.engine, "positionsOf", [account.address]),
    ]);
    const positions: PositionRow[] = views.map((v) => {
      const p = v.position;
      return {
        id: v.id,
        marketId: Number(p.marketId),
        isLong: p.isLong,
        openedAt: Number(p.openedAt),
        margin: usd(p.margin),
        notional: usd(p.notional),
        entryPrice: wad(p.entryPrice),
        reserve: usd(p.reserve),
        boosted: p.boosted,
        liquidationPrice: wad(v.liquidationPrice),
        winPrice: wad(v.winPrice),
        crowdingFee: usd(v.crowdingFee),
        boostPremium: usd(v.boostPremium),
        liquidatable: v.liquidatable,
        collectable: v.collectable,
      };
    });
    positions.sort((a, b) => Number(b.id - a.id));
    useStore.setState({
      balances: { usdc: usd(usdc), allowance: usd(allowance), olq: wad(olq), gas: wad(gas) },
      positions,
    });
  } catch {
    /* keep the last good values */
  }
}

export async function refreshEarn() {
  const account = useStore.getState().account;
  const zero = "0x0000000000000000000000000000000000000000" as const;
  const who = account?.address ?? zero;
  try {
    const [totalAssets, cash, marginHeld, reserved, free, oneShare, myShares, myMax] = await Promise.all([
      read<bigint>(addresses.Vault, abis.vault, "totalAssets"),
      read<bigint>(addresses.Vault, abis.vault, "cash"),
      read<bigint>(addresses.Vault, abis.vault, "marginHeld"),
      read<bigint>(addresses.Vault, abis.vault, "reserved"),
      read<bigint>(addresses.Vault, abis.vault, "freeLiquidity"),
      read<bigint>(addresses.Vault, abis.vault, "convertToAssets", [10n ** 12n]),
      read<bigint>(addresses.Vault, abis.vault, "balanceOf", [who]),
      read<bigint>(addresses.Vault, abis.vault, "maxWithdraw", [who]),
    ]);
    const myAssets = await read<bigint>(addresses.Vault, abis.vault, "convertToAssets", [myShares]);
    // The share lock arrived with the current vault; an older deployment has neither call.
    const [withdrawDelay, lockedUntil] = await Promise.all([
      read<bigint>(addresses.Vault, abis.vault, "withdrawDelay"),
      read<bigint>(addresses.Vault, abis.vault, "lockedUntil", [who]),
    ]).catch(() => [0n, 0n]);
    const [totalStaked, myStaked, myPending, totalSupply, maxSupply, cumFees, perDollar] = await Promise.all([
      read<bigint>(addresses.Staking, abis.staking, "totalStaked"),
      read<bigint>(addresses.Staking, abis.staking, "staked", [who]),
      read<bigint>(addresses.Staking, abis.staking, "pending", [who]),
      read<bigint>(addresses.OpenLiquidToken, abis.token, "totalSupply"),
      read<bigint>(addresses.OpenLiquidToken, abis.token, "maxSupply"),
      read<bigint>(addresses.OpenLiquidToken, abis.token, "cumulativeFees"),
      read<bigint>(addresses.OpenLiquidToken, abis.token, "quoteMint", [1_000_000n]),
    ]);
    useStore.setState({
      vault: {
        totalAssets: usd(totalAssets),
        cash: usd(cash),
        marginHeld: usd(marginHeld),
        reserved: usd(reserved),
        free: usd(free),
        sharePrice: usd(oneShare), // 1e12 share units = one whole share at the 6-decimal offset
        myShares,
        myAssets: usd(myAssets),
        myMaxWithdraw: usd(myMax),
        withdrawDelay: Number(withdrawDelay),
        lockedUntil: Number(lockedUntil),
      },
      staking: {
        totalStaked: wad(totalStaked),
        myStaked: wad(myStaked),
        myPending: usd(myPending),
        totalSupply: wad(totalSupply),
        maxSupply: wad(maxSupply),
        cumulativeFees: usd(cumFees),
        mintRate: wad(perDollar),
      },
    });
  } catch {
    /* keep the last good values */
  }
}

export async function refreshAll() {
  await refreshMarkets();
  await Promise.all([refreshAccount(), refreshEarn()]);
}

let started = false;
export function startChainPolling() {
  if (started) return;
  started = true;
  refreshParams();
  refreshAll();
  setInterval(refreshMarkets, IS_LOCAL ? 2500 : 4000);
  setInterval(refreshAccount, IS_LOCAL ? 2500 : 4000);
  setInterval(refreshEarn, IS_LOCAL ? 6000 : 12000);
}
