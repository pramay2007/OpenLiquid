import { memo, useMemo, useState } from "react";
import { deployment, type MarketKind, type MarketMeta } from "../chain/config";
import { fmtPct, fmtPrice } from "../lib/format";
import { useStore } from "../state/store";
import { Num, Sparkline } from "./primitives";

const GROUPS: { kind: MarketKind; label: string; chip: string }[] = [
  { kind: "crypto", label: "Crypto", chip: "Crypto" },
  { kind: "equity", label: "Stocks & indices", chip: "Stocks" },
  { kind: "commodity", label: "Commodities", chip: "Commodities" },
  { kind: "event", label: "Prediction markets", chip: "Events" },
];

/** Short display name: events are listed by what they ask, not by their ticker. */
export function displayName(m: MarketMeta): { title: string; sub: string } {
  if (m.kind === "event") return { title: m.name, sub: m.outcome ?? "Yes" };
  return { title: m.symbol, sub: m.name };
}

const Row = memo(function Row({ meta, selected }: { meta: MarketMeta; selected: boolean }) {
  const mid = useStore((s) => s.live[meta.id]?.mid ?? s.markets[meta.id]?.mid);
  const prev = useStore((s) => s.summary[meta.id]?.prevDay);
  const spark = useStore((s) => s.sparks[meta.id]);
  const select = useStore((s) => s.select);
  const { title, sub } = displayName(meta);

  let change: string | null = null;
  let up = true;
  if (mid != null && prev) {
    up = mid >= prev;
    change = meta.kind === "event" ? `${up ? "+" : "−"}${Math.abs((mid - prev) * 100).toFixed(1)}¢` : fmtPct(mid / prev - 1);
  }

  return (
    <button className="market-row" aria-current={selected} onClick={() => select(meta.id)}>
      <span style={{ minWidth: 0 }}>
        <span className="sym" style={{ display: "block" }}>
          {title}
        </span>
        <span className="sub" style={{ display: "block" }}>
          {sub}
        </span>
      </span>
      <Sparkline points={spark ?? []} />
      <span>
        <Num className="px" value={mid} format={(n) => fmtPrice(n, meta)} flash />
        <span className={`chg mono ${up ? "long" : "short"}`} style={{ display: "block" }}>
          {change ?? " "}
        </span>
      </span>
    </button>
  );
});

export function MarketRail() {
  const selected = useStore((s) => s.selected);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<MarketKind | "all">("all");

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    return GROUPS.filter((g) => filter === "all" || filter === g.kind)
      .map((g) => ({
        ...g,
        items: deployment.markets.filter(
          (m) =>
            m.kind === g.kind &&
            (!q || `${m.symbol} ${m.name} ${m.outcome ?? ""} ${m.category ?? ""}`.toLowerCase().includes(q))
        ),
      }))
      .filter((g) => g.items.length);
  }, [query, filter]);

  return (
    <aside className="rail">
      <div className="rail-head">
        <input
          className="search"
          placeholder="Search markets"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Search markets"
        />
        <div className="chips">
          <button className="chip" aria-pressed={filter === "all"} onClick={() => setFilter("all")}>
            All
          </button>
          {GROUPS.map((g) => (
            <button key={g.kind} className="chip" aria-pressed={filter === g.kind} onClick={() => setFilter(g.kind)}>
              {g.chip}
            </button>
          ))}
        </div>
      </div>
      <div className="rail-list">
        {groups.map((g) => (
          <div key={g.kind} style={{ display: "contents" }}>
            <div className="rail-group">{g.label}</div>
            {g.items.map((m) => (
              <Row key={m.id} meta={m} selected={m.id === selected} />
            ))}
          </div>
        ))}
        {!groups.length && <div className="empty">No markets match “{query}”.</div>}
      </div>
    </aside>
  );
}
