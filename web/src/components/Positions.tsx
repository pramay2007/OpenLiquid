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
  const select = useStore((s) => s.select);
  const [closing, setClosing] = useState(false);
  const isEvent = meta.kind === "event";

  // A close is a sell for a long and a buy for a short.
  const mark = feed ? (resolved ? feed.mid : fillPrice(feed, !p.isLong)) : null;
  const raw = mark == null ? null : pnlAt(isEvent, p.isLong, p.notional, p.entryPrice, mark) - p.carry;
  const pnl = raw == null ? null : Math.max(-p.margin, Math.min(p.reserve, raw));
  const up = (pnl ?? 0) >= 0;

  // How much of the cushion between entry and liquidation is left.
  const cushion =
    feed == null ? 1 : Math.max(0, Math.min(1, (feed.mid - p.liquidationPrice) / (p.entryPrice - p.liquidationPrice)));
  const leverage = Math.round(p.notional / p.margin);
  const side = isEvent ? (p.isLong ? "Yes" : "No") : p.isLong ? "Long" : "Short";

  return (
    <tr>
      <td>
        <div className="pos-market">
          <button className="link" style={{ color: "inherit" }} onClick={() => select(p.marketId)}>
            <b>{displayName(meta).title}</b>
          </button>
          <span className={`badge ${p.isLong ? "long" : "short"}`}>
            {side} {leverage}×
          </span>
        </div>
      </td>
      <td className="mono">{fmtUsd(p.notional)}</td>
      <td className="mono">{fmtUsd(p.margin)}</td>
      <td className="mono">{fmtPrice(p.entryPrice, meta)}</td>
      <td>
        <Num value={mark} format={(n) => fmtPrice(n, meta)} />
      </td>
      <td className="mono">
        {fmtPrice(p.liquidationPrice, meta)}
        <div className="health" title="Cushion left before liquidation">
          <Bar fraction={cushion} color={cushion > 0.5 ? "var(--long)" : cushion > 0.25 ? "var(--brass)" : "var(--short)"} />
        </div>
      </td>
      <td className={up ? "long" : "short"}>
        <Num value={pnl} format={(n) => fmtSignedUsd(n)} />
        <div className="mono" style={{ fontSize: 11, opacity: 0.8 }}>
          {pnl == null ? "" : fmtPct(pnl / p.margin, 1)}
        </div>
      </td>
      <td>
        <button
          className="btn btn-ghost"
          disabled={closing}
          onClick={async () => {
            setClosing(true);
            const ok = await closePosition(p.id, p.marketId);
            if (!ok) setClosing(false);
          }}
        >
          {closing ? <Spinner /> : resolved ? "Settle" : "Close"}
        </button>
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
                <th>Margin</th>
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
