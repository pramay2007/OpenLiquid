import { useEffect, useMemo, useState } from "react";
import { deployment, marketMeta } from "../chain/config";
import { connectDemo, connectInjected, faucet, openPosition } from "../data/wallet";
import { fillPrice, leverageToSlider, liquidationPrice, maxProfit, sliderToLeverage } from "../lib/engine";
import { fmtCompactUsd, fmtPct, fmtPrice, fmtUsd } from "../lib/format";
import { feedOf, useStore } from "../state/store";
import { Spinner } from "./primitives";

const MARGIN_CHIPS = [10, 50, 100, 500];
const MAX_ENTRY_LOSS = 0.3;

function leverageChips(max: number): number[] {
  const base = max >= 500 ? [10, 100, 500] : max >= 50 ? [2, 10, 25] : [1, 2, 5];
  return [...new Set([...base.filter((x) => x < max), max])];
}

export function OrderTicket() {
  const id = useStore((s) => s.selected);
  const meta = marketMeta.get(id)!;
  const m = useStore((s) => s.markets[id]);
  const feed = useStore((s) => feedOf(s, id));
  const account = useStore((s) => s.account);
  const connecting = useStore((s) => s.connecting);
  const balance = useStore((s) => s.balances.usdc);
  const params = useStore((s) => s.params);
  const isEvent = meta.kind === "event";

  const [isLong, setIsLong] = useState(true);
  const [marginText, setMarginText] = useState("100");
  const [leverage, setLeverage] = useState(100);
  const [busy, setBusy] = useState(false);

  const maxLev = Math.max(1, (isLong ? m?.maxLevLong : m?.maxLevShort) ?? 1);
  useEffect(() => {
    setLeverage((l) => Math.min(l, maxLev));
  }, [maxLev]);
  // A sensible starting leverage for each market type.
  useEffect(() => {
    setLeverage(isEvent ? 5 : 100);
  }, [id, isEvent]);

  const margin = Number(marginText) || 0;
  const lev = Math.min(leverage, maxLev);
  const notional = margin * lev;

  const preview = useMemo(() => {
    if (!feed || !m) return null;
    const entry = fillPrice(feed, isLong);
    const liq = liquidationPrice(isEvent, isLong, entry, lev, params.maintFraction);
    const profitCap = maxProfit(isEvent, isLong, margin, notional, entry, m.maxProfitMult);
    const gapBps = isEvent ? Math.abs(feed.mid - feed.slow) * 1e4 : (Math.abs(feed.mid - feed.slow) / feed.slow) * 1e4;
    const entryCostBps = isEvent ? Math.abs(entry - feed.mid) * 1e4 : (Math.abs(entry - feed.mid) / feed.mid) * 1e4;
    return { entry, liq, profitCap, gapBps, entryCostBps, liqDistance: Math.abs(liq - entry) / entry };
  }, [feed, m, isLong, isEvent, lev, margin, notional, params.maintFraction]);

  const sideOI = m ? (isLong ? m.longOI : m.shortOI) : 0;
  const room = m ? Math.max(0, m.sideCap - sideOI) : 0;

  let blocker: string | null = null;
  if (!m || !feed) blocker = "Waiting for prices";
  else if (m.resolved) blocker = "Market resolved";
  else if (isEvent && m.expiry * 1000 <= Date.now()) blocker = "Closed to new positions";
  else if (margin < params.minMargin) blocker = `Enter at least ${fmtUsd(params.minMargin, 0)}`;
  else if (account && margin > balance) blocker = "Not enough USDC";
  else if (notional > m.maxPositionNotional) blocker = `Above the ${fmtCompactUsd(m.maxPositionNotional)} position limit`;
  else if (notional > room) blocker = `Only ${fmtCompactUsd(room)} of capacity left`;
  else if (preview && preview.gapBps > m.maxGapBps) blocker = "Opens paused: price moving fast";
  else if (preview && (preview.entryCostBps / 1e4) * lev > MAX_ENTRY_LOSS) {
    // Mirrors PerpEngine.MAX_ENTRY_LOSS_BPS: the fill may not start more than 30% of margin under water.
    const usable = Math.max(1, Math.floor(MAX_ENTRY_LOSS / (preview.entryCostBps / 1e4)));
    blocker = `Moving fast: up to ${usable}× right now`;
  }

  const sideWord = isEvent ? (isLong ? "Yes" : "No") : isLong ? "Long" : "Short";
  const short = isEvent ? "" : ` ${meta.symbol}`;

  async function submit() {
    setBusy(true);
    await openPosition(id, isLong, margin, lev);
    setBusy(false);
  }

  const t = leverageToSlider(lev, maxLev);

  return (
    <aside className="ticket">
      <div className="ticket-body">
        <div className="side-toggle" data-side={isLong ? "long" : "short"} role="group" aria-label="Side">
          <span className="thumb" />
          <button aria-pressed={isLong} onClick={() => setIsLong(true)}>
            {isEvent ? "Yes" : "Long"}
          </button>
          <button aria-pressed={!isLong} onClick={() => setIsLong(false)}>
            {isEvent ? "No" : "Short"}
          </button>
        </div>

        <div className="field">
          <div className="field-head">
            <span>Margin</span>
            <span>
              Balance <b className="mono">{account ? fmtUsd(balance) : "—"}</b>
            </span>
          </div>
          <label className="amount">
            <span>$</span>
            <input
              inputMode="decimal"
              value={marginText}
              onChange={(e) => setMarginText(e.target.value.replace(/[^0-9.]/g, "").replace(/(\..*)\./g, "$1"))}
              aria-label="Margin in USDC"
            />
            <em>USDC</em>
          </label>
          <div className="quick">
            {MARGIN_CHIPS.map((v) => (
              <button key={v} aria-pressed={margin === v} onClick={() => setMarginText(String(v))}>
                ${v}
              </button>
            ))}
            <button onClick={() => setMarginText(String(Math.floor(balance * 100) / 100))} disabled={!account}>
              Max
            </button>
          </div>
        </div>

        <div className="field">
          <div className="field-head">
            <span>Leverage</span>
            <span className="lev-readout">
              {lev}×<small>max {maxLev}×</small>
            </span>
          </div>
          <div className="slider" style={{ ["--t" as string]: t }}>
            <input
              type="range"
              min={0}
              max={1}
              step={0.001}
              value={t}
              onChange={(e) => setLeverage(sliderToLeverage(Number(e.target.value), maxLev))}
              aria-label="Leverage"
              aria-valuetext={`${lev} times`}
            />
          </div>
          <div className="quick">
            {leverageChips(maxLev).map((v) => (
              <button key={v} aria-pressed={lev === v} onClick={() => setLeverage(v)}>
                {v}×
              </button>
            ))}
          </div>
        </div>

        <dl className="summary">
          <div>
            <dt>Position size</dt>
            <dd className="mono">{fmtUsd(notional)}</dd>
          </div>
          <div>
            <dt>Entry price</dt>
            <dd className="mono">
              {fmtPrice(preview?.entry, meta)}
              <small>{preview && preview.entryCostBps >= 0.05 ? `${preview.entryCostBps.toFixed(1)} bps off mid` : "no slippage"}</small>
            </dd>
          </div>
          <div>
            <dt>Liquidation price</dt>
            <dd className="mono">
              {fmtPrice(preview?.liq, meta)}
              <small>{preview ? fmtPct(preview.liqDistance, preview.liqDistance < 0.01 ? 3 : 2, false) + " away" : ""}</small>
            </dd>
          </div>
          <div>
            <dt>Most you can lose</dt>
            <dd className="mono">{fmtUsd(margin)}</dd>
          </div>
          <div>
            <dt>Most you can make</dt>
            <dd className="mono long">{preview ? fmtUsd(preview.profitCap) : "—"}</dd>
          </div>
          <div>
            <dt>Fee</dt>
            <dd>
              None to open<small>{m ? `${m.profitFeeBps / 100}% of profit` : ""}</small>
            </dd>
          </div>
        </dl>

        {account ? (
          <button
            className={`btn btn-lg ${isLong ? "cta-long" : "cta-short"}`}
            disabled={busy || !!blocker}
            onClick={submit}
          >
            {busy ? <Spinner /> : null}
            {blocker ?? `${sideWord}${short} · ${fmtCompactUsd(notional)}`}
          </button>
        ) : (
          <div style={{ display: "grid", gap: 8 }}>
            <button className="btn btn-lg btn-primary" disabled={connecting} onClick={() => connectDemo()}>
              {connecting ? <Spinner /> : null}
              Start with a demo account
            </button>
            <button className="btn btn-lg btn-ghost" disabled={connecting} onClick={connectInjected}>
              Connect a wallet
            </button>
          </div>
        )}

        {account && blocker === "Not enough USDC" && deployment.faucet && (
          <p className="note">
            Need test funds?{" "}
            <button className="link" onClick={() => faucet()}>
              Add 10,000 test USDC
            </button>
          </p>
        )}
        <p className="note">
          {isEvent
            ? "A No position is a long on the other outcome, so 1× is always fully collateralised. Leverage shrinks toward 1× as resolution approaches."
            : "Fills at the mid when the market is calm. When the price is moving fast, you get the worse of the mid and the slow price."}
        </p>
      </div>

      <div className="ticket-foot">
        <div className="kv">
          <span>Remaining {sideWord.toLowerCase()} capacity</span>
          <b className="mono">{fmtCompactUsd(room)}</b>
        </div>
        <div className="kv">
          <span>Profit cap</span>
          <b className="mono">{m ? `${m.maxProfitMult}× margin` : "—"}</b>
        </div>
        <div className="kv">
          <span>Liquidation at</span>
          <b className="mono">{fmtPct(params.maintFraction, 0, false)} margin left</b>
        </div>
      </div>
    </aside>
  );
}
