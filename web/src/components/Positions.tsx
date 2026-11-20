import { memo, useState } from "react";
import { marketMeta } from "../chain/config";
import { closePosition } from "../data/wallet";
import { fillPrice, pnl as pnlAt } from "../lib/engine";
import { fmtPct, fmtPrice, fmtSignedUsd, fmtUsd } from "../lib/format";
import { feedOf, useStore, type PositionRow } from "../state/store";
import { displayName } from "./MarketRail";
import { Bar, Num, Spinner } from "./primitives";

const Row = memo(function Row({ p }: { p: PositionRow }) {
  const meta = marketMeta.get(p.marketId)!;
  const feed = useStore((s) => feedOf(s, p.marketId));
  const resolved = useStore((s) => s.markets[p.marketId]?.resolved ?? false);
  // An event market stops trading at its expiry: nothing closes at a price, positions wait for the result.
  const waiting = useStore((s) => {
    const m = s.markets[p.marketId];
    return !!m && m.isEvent && !m.resolved && (m.closed || (m.expiry > 0 && m.expiry * 1000 <= Date.now()));
  });
  const select = useStore((s) => s.select);
  const [closing, setClosing] = useState(false);
  const isEvent = meta.kind === "event";

  // A close is a sell for a long and a buy for a short.
  const mark = feed ? (resolved ? feed.mid : fillPrice(feed, !p.isLong)) : null;
  const raw = mark == null ? null : pnlAt(isEvent, p.isLong, p.notional, p.entryPrice, mark);
  const leverage = Math.round(p.notional / p.margin);
  // A 1× event position is a plain purchase of shares: never liquidated, paid the full result.
  const outright = isEvent && leverage <= 1;
  // The engine's result: never more than the reserve, less the crowding fee and any Boost premium,
  // never below minus the stake. From expiry on, a position that is still leveraged cannot win.
  const charges = p.crowdingFee + p.boostPremium;
  const result = raw == null ? null : Math.max(-p.margin, Math.min(p.reserve, raw) - charges);
  const pnl = result == null ? null : waiting && !outright ? Math.min(0, result) : result;
  const up = (pnl ?? 0) >= 0;
  const maxed = raw != null && raw >= p.reserve && !resolved && !waiting;

  // How much of the cushion between entry and liquidation is left.
  const span = p.entryPrice - p.liquidationPrice;
  const cushion =
    feed == null || outright || span === 0 ? 1 : Math.max(0, Math.min(1, (feed.mid - p.liquidationPrice) / span));
  const side = isEvent ? (p.isLong ? "Yes" : "No") : p.isLong ? "Long" : "Short";

  return (
    <tr>
      <td>
        <div className="pos-market">
          <button className="link" style={{ color: "inherit" }} onClick={() => select(p.marketId)}>
            <b>{displayName(meta).title}</b>
          </button>
          <span className={`badge ${p.isLong ? "long" : "short"}`}>
            {side} {leverage}×{p.boosted ? " Boost" : ""}
          </span>
        </div>
      </td>
      <td className="mono">{fmtUsd(p.notional)}</td>
      <td className="mono">{fmtUsd(p.margin)}</td>
      <td className="mono">{fmtPrice(p.entryPrice, meta)}</td>
      <td>
        <Num value={mark} format={(n) => fmtPrice(n, meta)} />
        {isEvent && (
          <div className="mono sub-line" title="The odds at which this position is paid in full">
            {p.winPrice <= 0.001 || p.winPrice >= 0.999 ? "pays at the result" : `pays at ${fmtPrice(p.winPrice, meta)}`}
          </div>
        )}
      </td>
      <td className="mono">
        {outright ? (
          <>
            Never
            <div className="mono sub-line" title="A 1× position is a plain purchase of shares. It is not liquidated.">
              rides to the result
            </div>
          </>
        ) : (
          <>
            {fmtPrice(p.liquidationPrice, meta)}
            <div className="health" title="Cushion left before liquidation">
              <Bar fraction={cushion} color={cushion > 0.5 ? "var(--long)" : cushion > 0.25 ? "var(--brass)" : "var(--short)"} />
            </div>
          </>
        )}
      </td>
      <td className={up ? "long" : "short"}>
        <Num value={pnl} format={(n) => fmtSignedUsd(n)} />
        <div className="mono" style={{ fontSize: 11, opacity: 0.8 }}>
          {pnl == null ? "" : maxed ? "at its maximum" : fmtPct(pnl / p.margin, 1)}
        </div>
        {p.crowdingFee > 0.005 && (
          <div className="mono sub-line" title="Crowding fee paid so far, out of your stake. Only the crowded side pays it.">
            {fmtUsd(p.crowdingFee)} crowding fee paid
          </div>
        )}
        {p.boostPremium > 0.005 && (
          <div className="mono sub-line" title="Boost premium paid so far, out of your stake">
            {fmtUsd(p.boostPremium)} premium paid
          </div>
        )}
      </td>
      <td>
        {waiting ? (
          <span
            className="badge neutral"
            title={
              outright
                ? "Trading has closed. This position is paid when the result is in."
                : "Trading has closed. A position that is still leveraged gets back at most its stake."
            }
          >
            Waiting for result
          </span>
        ) : (
          <button
            className="btn btn-ghost"
            disabled={closing}
            onClick={async () => {
              setClosing(true);
              const ok = await closePosition(p.id, p.marketId);
              if (!ok) setClosing(false);
            }}
          >
            {closing ? <Spinner /> : resolved ? "Settle" : maxed ? "Collect" : "Close"}
          </button>
        )}
      </td>
    </tr>
  );
});

export function Positions() {
  const positions = useStore((s) => s.positions);
  const account = useStore((s) => s.account);

  return (
    <section className="positions">
      <div className="panel-head">
        Positions <span className="count">{positions.length}</span>
      </div>
      {positions.length ? (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Market</th>
                <th>Size</th>
                <th>Stake</th>
                <th>Entry</th>
                <th>Mark</th>
                <th>Liquidation</th>
                <th>PnL</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {positions.map((p) => (
                <Row key={String(p.id)} p={p} />
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="empty">
          {account
            ? "No open positions. Pick a market, set your margin and leverage, and open one."
            : "Start a demo account to trade with test USDC. No wallet or sign-up needed."}
        </div>
      )}
    </section>
  );
}
