import { useEffect, useState } from "react";
import { marketMeta } from "../chain/config";
import { fmtCompactUsd, fmtDuration, fmtPct, fmtPrice } from "../lib/format";
import { useStore } from "../state/store";
import { displayName } from "./MarketRail";
import { Bar, Num } from "./primitives";

function useNow(intervalMs = 30_000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

export function MarketHeader() {
  const id = useStore((s) => s.selected);
  const meta = marketMeta.get(id)!;
  const m = useStore((s) => s.markets[id]);
  const mid = useStore((s) => s.live[id]?.mid ?? s.markets[id]?.mid);
  const prev = useStore((s) => s.summary[id]?.prevDay);
  const now = useNow();
  const { title, sub } = displayName(meta);
  const isEvent = meta.kind === "event";

  const up = mid != null && prev ? mid >= prev : true;
  const change =
    mid != null && prev
      ? isEvent
        ? `${up ? "+" : "−"}${Math.abs((mid - prev) * 100).toFixed(1)}¢`
        : fmtPct(mid / prev - 1)
      : null;

  // The crowding fee accrues on one side at most. Shown as a daily rate: on event markets per
  // dollar of borrowed position, elsewhere per dollar of position.
  let crowd: { side: string; rate: number } | null = null;
  if (m && mid != null) {
    if (m.feePerDayLong > 0) {
      crowd = { side: isEvent ? "Yes" : "Longs", rate: isEvent ? m.feePerDayLong / Math.max(mid, 0.01) : m.feePerDayLong };
    } else if (m.feePerDayShort > 0) {
      crowd = { side: isEvent ? "No" : "Shorts", rate: isEvent ? m.feePerDayShort / Math.max(1 - mid, 0.01) : m.feePerDayShort };
    }
  }

  const closedNow = isEvent && !!m && !m.resolved && (m.closed || m.expiry * 1000 <= now);

  const slow = m?.slow;
  const gap = mid != null && slow ? (isEvent ? (mid - slow) * 1e4 : ((mid - slow) / slow) * 1e4) : null;
  const paused = gap != null && m ? Math.abs(gap) > m.maxGapBps : false;
  const gapText =
    gap == null ? "—" : isEvent ? `${(gap / 100).toFixed(1)}¢` : `${gap >= 0 ? "+" : "−"}${Math.abs(gap).toFixed(1)} bps`;

  return (
    <div className="mkt-head">
      <div className="mkt-title">
        <h1>{title}</h1>
        <p>
          {isEvent ? `${sub} · Gemini` : `${sub} · ${meta.kind === "crypto" ? "Hyperliquid" : "Hyperliquid xyz"}`}
        </p>
      </div>

      <div className="mkt-price">
        <Num className="big" value={mid} format={(n) => fmtPrice(n, meta)} flash />
        {change && <span className={`badge ${up ? "long" : "short"}`}>{change}</span>}
        {m?.resolved && <span className="badge brass">Resolved</span>}
        {closedNow && <span className="badge brass">Waiting for result</span>}
        {paused && !m?.resolved && !closedNow && <span className="badge brass">Opens paused</span>}
      </div>

      <div className="stats">
        <div className="stat" title="Time-weighted price. Trades fill at the worse of this and the mid.">
          <label>Slow price</label>
          <Num className="v" value={slow} format={(n) => fmtPrice(n, meta)} />
        </div>
        <div className="stat hide-md" title="Distance between the mid and the slow price">
          <label>Gap</label>
          <span className="v mono">{gapText}</span>
        </div>
        <div
          className="stat hide-md"
          title="Paid by the crowded side only, out of the stake, while the market is lopsided. A balanced market pays nothing."
        >
          <label>Crowding fee / day</label>
          <span className="v mono">{!m ? "—" : crowd ? `${crowd.side} ${fmtPct(crowd.rate, 3, false)}` : "None"}</span>
        </div>
        {isEvent && m && (
          <div
            className="stat"
            title="Trading stops at this time and positions wait for the result. Leverage falls as it nears and is 1x by then."
          >
            <label>{closedNow ? "Trading" : "Trading closes"}</label>
            <span className="v mono">{m.resolved ? "—" : closedNow ? "Closed" : `in ${fmtDuration(m.expiry - now / 1000)}`}</span>
          </div>
        )}
        <div className="stat" title="Open interest on each side against the cap set by reference-venue depth">
          <label>Capacity used · cap {fmtCompactUsd(m?.sideCap)}</label>
          <div className="capacity">
            <div className="cap-row">
              <span className="long">L</span>
              <Bar fraction={m ? m.longOI / m.sideCap : 0} color="var(--long)" />
              <span className="mono">{fmtCompactUsd(m?.longOI)}</span>
            </div>
            <div className="cap-row">
              <span className="short">S</span>
              <Bar fraction={m ? m.shortOI / m.sideCap : 0} color="var(--short)" />
              <span className="mono">{fmtCompactUsd(m?.shortOI)}</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
