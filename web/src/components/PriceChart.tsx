import { useEffect, useRef, useState } from "react";
import {
  ColorType,
  CrosshairMode,
  LineStyle,
  createChart,
  type IChartApi,
  type IPriceLine,
  type ISeriesApi,
  type UTCTimestamp,
} from "lightweight-charts";
import { marketMeta } from "../chain/config";
import { fetchCandles, fetchHistory, type Candle } from "../data/keeper";
import { priceDecimals } from "../lib/format";
import { useStore } from "../state/store";

const INTERVALS = ["1m", "5m", "15m", "1h"] as const;
const SECONDS: Record<string, number> = { "1m": 60, "5m": 300, "15m": 900, "1h": 3600 };
const css = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

export function PriceChart() {
  const id = useStore((s) => s.selected);
  const meta = marketMeta.get(id)!;
  const isEvent = meta.kind === "event";
  const [interval, setIntervalKey] = useState<(typeof INTERVALS)[number]>("1m");
  // Event history is hourly; live points are added per minute on top of it.
  const bucket = isEvent ? 60 : SECONDS[interval];

  const el = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const series = useRef<ISeriesApi<"Candlestick"> | ISeriesApi<"Area"> | null>(null);
  const last = useRef<Candle | null>(null);
  const slowLine = useRef<IPriceLine | null>(null);
  const posLines = useRef<IPriceLine[]>([]);
  const [status, setStatus] = useState<"loading" | "ready">("loading");

  // One chart for the life of the component.
  useEffect(() => {
    const c = createChart(el.current!, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: "transparent" },
        textColor: css("--text-3"),
        fontFamily: css("--font-mono"),
        fontSize: 11,
      },
      grid: { vertLines: { color: "rgba(255,255,255,0.025)" }, horzLines: { color: "rgba(255,255,255,0.025)" } },
      rightPriceScale: { borderVisible: false, scaleMargins: { top: 0.16, bottom: 0.1 } },
      timeScale: { borderVisible: false, timeVisible: true, secondsVisible: false, rightOffset: 6 },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: { color: "rgba(227,178,90,0.35)", labelBackgroundColor: "#1e2833" },
        horzLine: { color: "rgba(227,178,90,0.35)", labelBackgroundColor: "#1e2833" },
      },
      handleScale: { axisPressedMouseMove: { time: true, price: false } },
    });
    chart.current = c;
    return () => {
      c.remove();
      chart.current = null;
      series.current = null;
    };
  }, []);

  // A new series whenever the market or interval changes.
  useEffect(() => {
    const c = chart.current!;
    if (series.current) c.removeSeries(series.current);
    slowLine.current = null;
    posLines.current = [];
    last.current = null;
    setStatus("loading");

    const mid = useStore.getState().live[id]?.mid ?? useStore.getState().markets[id]?.mid ?? 1;
    const decimals = priceDecimals(mid);
    const priceFormat = isEvent
      ? { type: "custom" as const, minMove: 0.001, formatter: (p: number) => `${(p * 100).toFixed(1)}¢` }
      : { type: "price" as const, precision: decimals, minMove: 1 / 10 ** decimals };

    const s = isEvent
      ? c.addAreaSeries({
          lineColor: css("--brass"),
          topColor: "rgba(227,178,90,0.22)",
          bottomColor: "rgba(227,178,90,0)",
          lineWidth: 2,
          priceFormat,
          priceLineColor: "rgba(227,178,90,0.5)",
        })
      : c.addCandlestickSeries({
          upColor: css("--long"),
          downColor: css("--short"),
          wickUpColor: css("--long"),
          wickDownColor: css("--short"),
          borderVisible: false,
          priceFormat,
          priceLineColor: "rgba(233,237,241,0.35)",
        });
    series.current = s;

    let cancelled = false;
    // Event markets: hourly history from the venue, then the keeper's recent mids per minute,
    // so a quiet contract still shows where it has been trading.
    const load = async (): Promise<Candle[]> => {
      const candles = await fetchCandles(id, interval).catch(() => [] as Candle[]);
      if (!isEvent) return candles;
      const lastTime = candles.length ? candles[candles.length - 1].time : 0;
      const minutes = new Map<number, number>();
      for (const p of await fetchHistory(id)) minutes.set(Math.floor(p.time / 60) * 60, p.value);
      const recent = [...minutes.entries()]
        .filter(([time]) => time > lastTime)
        .map(([time, value]) => ({ time, open: value, high: value, low: value, close: value }));
      return [...candles, ...recent];
    };
    load()
      .then((rows) => {
        if (cancelled || series.current !== s) return;
        // No history is fine: the series starts empty and the live price draws it from here.
        if (!rows.length) return setStatus("ready");
        if (isEvent) {
          (s as ISeriesApi<"Area">).setData(rows.map((r) => ({ time: r.time as UTCTimestamp, value: r.close })));
        } else {
          (s as ISeriesApi<"Candlestick">).setData(rows.map((r) => ({ ...r, time: r.time as UTCTimestamp })));
        }
        last.current = rows[rows.length - 1];
        c.timeScale().setVisibleLogicalRange({ from: Math.max(0, rows.length - 140), to: rows.length + 6 });
        setStatus("ready");
      })
      .catch(() => !cancelled && series.current === s && setStatus("ready"));
    return () => {
      cancelled = true;
    };
  }, [id, interval, isEvent]);

  // Live price: extend the last bar, or start a new one when the bucket rolls over. The clock
  // tick keeps bars coming on a market whose price is not changing.
  const mid = useStore((s) => s.live[id]?.mid);
  const [clock, setClock] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setClock((c) => c + 1), 5000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    const s = series.current;
    if (!s || mid == null || status !== "ready") return;
    const time = Math.floor(Date.now() / 1000 / bucket) * bucket;
    const prev = last.current;
    const bar: Candle =
      prev && prev.time >= time
        ? { ...prev, high: Math.max(prev.high, mid), low: Math.min(prev.low, mid), close: mid }
        : { time, open: prev?.close ?? mid, high: mid, low: mid, close: mid };
    last.current = bar;
    if (isEvent) (s as ISeriesApi<"Area">).update({ time: bar.time as UTCTimestamp, value: bar.close });
    else (s as ISeriesApi<"Candlestick">).update({ ...bar, time: bar.time as UTCTimestamp });
  }, [mid, bucket, isEvent, status, clock]);

  // The slow price: the second price every fill is checked against.
  const slow = useStore((s) => s.markets[id]?.slow);
  useEffect(() => {
    const s = series.current;
    if (!s || !slow || status !== "ready") return;
    if (slowLine.current) slowLine.current.applyOptions({ price: slow });
    else {
      slowLine.current = s.createPriceLine({
        price: slow,
        color: "rgba(227,178,90,0.75)",
        lineWidth: 1,
        lineStyle: LineStyle.Dashed,
        axisLabelVisible: true,
        title: "slow",
      });
    }
  }, [slow, status, id, interval]);

  // Entry and liquidation levels of the account's positions in this market.
  const positions = useStore((s) => s.positions);
  const key = positions
    .filter((p) => p.marketId === id)
    .map((p) => `${p.id}:${p.liquidationPrice}`)
    .join("|");
  useEffect(() => {
    const s = series.current;
    if (!s || status !== "ready") return;
    for (const line of posLines.current) s.removePriceLine(line);
    posLines.current = positions
      .filter((p) => p.marketId === id)
      .flatMap((p) => [
        s.createPriceLine({
          price: p.entryPrice,
          color: p.isLong ? css("--long") : css("--short"),
          lineWidth: 1,
          lineStyle: LineStyle.Solid,
          axisLabelVisible: true,
          title: `${p.isLong ? "long" : "short"} entry`,
        }),
        s.createPriceLine({
          price: p.liquidationPrice,
          color: "rgba(244,111,98,0.7)",
          lineWidth: 1,
          lineStyle: LineStyle.Dotted,
          axisLabelVisible: true,
          title: "liq",
        }),
      ]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, status, id, interval]);

  return (
    <div className="chart-wrap">
      <div className="chart-tools">
        {!isEvent && (
          <div className="seg" role="group" aria-label="Chart interval">
            {INTERVALS.map((i) => (
              <button key={i} aria-pressed={interval === i} onClick={() => setIntervalKey(i)}>
                {i}
              </button>
            ))}
          </div>
        )}
        <div className="legend">
          <span>slow price</span>
        </div>
      </div>
      <div className="chart" ref={el} />
      {status !== "ready" && <div className="chart-empty">Loading chart…</div>}
    </div>
  );
}
