import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { deployment, type MarketMeta } from "../chain/config";
import { corridor, hazardPerShareDay, maxEventLeverage } from "../lib/corridor";
import { fmtDuration, fmtUsd } from "../lib/format";
import { useStore } from "../state/store";
import { displayName } from "./MarketRail";
import { Bar, Num, Sparkline } from "./primitives";
import "../predict.css";

// The Predict page: an interactive picture of what leverage does to a bet on a prediction market,
// the event markets that are live, and the rules that keep the vault able to pay. Every number
// comes from lib/corridor.ts, which mirrors the engine.

const EVENTS = deployment.markets.filter((m) => m.kind === "event");

const STAKES = [50, 100, 500];
const ENTRY_PRICES = [0.2, 0.35, 0.54, 0.7, 0.85];

// The explainer's made-up market: 30 days from its result, with the settings a dated event market
// runs on (a 120 second reaction time, a 10× ceiling, both lines at least 5 cents from entry, a
// boosted win capped at 10× the stake, and Boost priced at 2.5 times the implied hazard).
const DEMO_SECONDS = 30 * 86_400;
const DEMO_REACTION_SECONDS = 120;
const DEMO_CEILING = 10;
const DEMO_MIN_DISTANCE = 0.05;
const DEMO_PROFIT_MULT = 10;
const DEMO_BOOST_SCALE = 2.5;

/** Cents with one decimal, and none at the two ends of the scale. Takes 0..100. */
function cents(n: number): string {
  const r = Math.round(n * 10) / 10;
  return r <= 0 || r >= 100 ? r.toFixed(0) : r.toFixed(1);
}

const centsMark = (n: number) => `${cents(n)}¢`;
/** A whole-cent price, such as an entry picked from the chips. Takes 0..1. */
const wholeCents = (price: number) => `${Math.round(price * 100)}¢`;
const usd = (n: number) => fmtUsd(n);
/** Dollars without ".00" when the amount is whole. */
const usdShort = (n: number) => fmtUsd(n, Number.isInteger(n) ? 0 : 2);

/** "a" or "an" before a number under 100 read aloud: an 8.0-point move, an 11.2-point move. */
function article(n: number): string {
  const lead = Math.floor(Math.round(n * 10) / 10); // as it will be printed, to one decimal
  return lead === 8 || lead === 11 || lead === 18 || (lead >= 80 && lead < 90) ? "an" : "a";
}

/** A 0..1 price as a position along the odds bar, in percent. */
const pct = (price: number) => Math.min(100, Math.max(0, price * 100));
const band = (a: number, b: number): CSSProperties => ({
  left: `${Math.min(a, b)}%`,
  width: `${Math.abs(a - b)}%`,
});

/** Wall-clock seconds, refreshed often enough for a countdown that shows minutes. */
function useNowSeconds(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now() / 1000);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now() / 1000), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

/* ---- the explainer ---------------------------------------------------------------------- */

/** The odds from 0 to 100 cents with a position's lines on it. Inputs are YES prices, 0..1. */
function OddsBar({
  isYes,
  price,
  winLine,
  liqLine,
  stopLine,
  noStop,
}: {
  isYes: boolean;
  price: number;
  winLine: number;
  liqLine: number;
  stopLine: number;
  /** A 1× bet is never stopped out: it only loses at the losing result. */
  noStop: boolean;
}) {
  const entry = pct(price);
  const win = pct(winLine);
  const liq = pct(liqLine);
  const gone = pct(stopLine);
  // Yes wins as the price rises, so its win line sits right of the entry and its stop line left.
  // No is the mirror image. Each label hangs off the outer side of its line, away from the entry.
  const winFlag = isYes ? "to-right" : "to-left";
  const stopFlag = isYes ? "to-left" : "to-right";

  return (
    <div
      className={`pm-odds ${isYes ? "is-yes" : "is-no"}`}
      role="img"
      aria-label={
        `The odds from 0 to 100 cents. Entry at ${cents(entry)} cents. Paid in full at ${cents(win)} cents. ` +
        (noStop ? "Never stopped out." : `Stopped out near ${cents(liq)} cents.`)
      }
    >
      {/* Labels are plain text, not Num: a label's width sets where it sits, so it has to be
          final on the first paint. --x is the label's price in percent along the bar. */}
      <div className="pm-odds-labels">
        <span className="pm-entry-label" style={{ ["--x" as string]: entry }}>
          Entry <b className="mono">{wholeCents(price)}</b>
        </span>
        {!noStop && (
          <span className={`pm-flag pm-flag-stop ${stopFlag}`} style={{ ["--x" as string]: liq }}>
            Stop <b className="mono">{centsMark(liq)}</b>
          </span>
        )}
        <span className={`pm-flag pm-flag-win ${winFlag}`} style={{ ["--x" as string]: win }}>
          Win <b className="mono">{centsMark(win)}</b>
        </span>
      </div>

      <div className="pm-track">
        <div className="pm-track-clip">
          {/* From the stop to the point where the stake would be gone. The bet is closed before
              the price gets here, so this slice is the part of the stake that is left. */}
          {!noStop && (
            <i
              className="pm-zone pm-zone-tail"
              style={band(liq, gone)}
              title={`The stake would be gone at ${centsMark(gone)}. The bet is closed before that, at ${centsMark(liq)}, and what is left comes back.`}
            />
          )}
          <i className="pm-zone pm-zone-stop" style={band(entry, liq)} />
          <i className="pm-zone pm-zone-win" style={band(entry, win)} />
        </div>
        {!noStop && <i className="pm-line pm-line-stop" style={{ left: `${liq}%` }} />}
        <i className="pm-line pm-line-win" style={{ left: `${win}%` }} />
        <i className="pm-pin" style={{ left: `${entry}%` }} />
      </div>

      <div className="pm-ticks">
        <span className="pm-tick-first">
          0 · <b>No</b>
        </span>
        <span style={{ left: "25%" }}>25</span>
        <span style={{ left: "50%" }}>50</span>
        <span style={{ left: "75%" }}>75</span>
        <span className="pm-tick-last">
          <b>Yes</b> · 100
        </span>
      </div>
    </div>
  );
}

/** One plain statement in the readout: a label, the sentence, and a quieter second line. */
function Statement({
  tone,
  label,
  sub,
  children,
}: {
  tone: "win" | "stop" | "plain" | "boost";
  label: string;
  sub: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className={`pm-statement is-${tone}`}>
      <span className="pm-statement-label">{label}</span>
      <p className="pm-statement-main">{children}</p>
      <p className="pm-statement-sub">{sub}</p>
    </div>
  );
}

function Explainer() {
  const maintFraction = useStore((s) => s.params.maintFraction);
  const liqFeeFraction = useStore((s) => s.params.liqFeeFraction);
  const [isYes, setIsYes] = useState(true);
  const [stake, setStake] = useState(100);
  const [price, setPrice] = useState(0.54);
  const [leverage, setLeverage] = useState(5);
  const [boostOn, setBoostOn] = useState(false);

  // The limit depends on the price, so the chosen leverage is kept and clamped on the way out:
  // going to a tighter price and back restores it.
  const maxLev = maxEventLeverage(price, DEMO_SECONDS, DEMO_REACTION_SECONDS, DEMO_CEILING, DEMO_MIN_DISTANCE);
  const lev = Math.min(leverage, maxLev);
  // Boost needs something borrowed to boost, so it starts at 2×.
  const boost = boostOn && lev >= 2;
  const c = corridor({
    price,
    isYes,
    margin: stake,
    leverage: lev,
    boost,
    maintFraction,
    maxProfitMult: DEMO_PROFIT_MULT,
  });

  const side = isYes ? "Yes" : "No";
  // At 1×, and with Boost until the profit cap binds, the win line is the result itself.
  const atResult = isYes ? c.winLine >= 0.9995 : c.winLine <= 0.0005;
  // A liquidation returns what is left of the stake at the stop, less the liquidator's fee.
  const back = Math.round(stake * Math.max(0, maintFraction - liqFeeFraction) * 100) / 100;
  const move = Math.abs(c.winLine - price) * 100;
  const capped = boost && c.maxWin >= stake * DEMO_PROFIT_MULT - 1e-9;
  // In free mode a leveraged bet never wins more than its stake, which binds on the cheaper side.
  const atStake = !boost && lev > 1 && c.maxWin < c.outrightWin - 1e-9;
  const boostPerDay = c.borrowedShares * hazardPerShareDay(price, DEMO_SECONDS, DEMO_BOOST_SCALE);
  const sliderT = maxLev > 1 ? (lev - 1) / (maxLev - 1) : 0;

  return (
    <section className="card pm-explainer">
      <div className="pm-explainer-head">
        <div className="eyebrow">Zoom the odds</div>
        <h3>What leverage does to a bet</h3>
        <p>
          A made-up market, 30 days from its result. Pick a bet, then move the leverage. A leveraged bet wins what the
          same stake would win outright, and never more than the stake itself. Leverage moves the win line and the stop
          line closer to the entry.
        </p>
      </div>

      <div className="pm-controls">
        <div className="field">
          <div className="field-head">
            <span>Side</span>
          </div>
          <div className="seg pm-seg" role="group" aria-label="Side">
            <button className="pm-yes" aria-pressed={isYes} onClick={() => setIsYes(true)}>
              Yes
            </button>
            <button className="pm-no" aria-pressed={!isYes} onClick={() => setIsYes(false)}>
              No
            </button>
          </div>
        </div>

        <div className="field">
          <div className="field-head">
            <span>Stake</span>
          </div>
          <div className="quick pm-chips" role="group" aria-label="Stake">
            {STAKES.map((v) => (
              <button key={v} aria-pressed={stake === v} onClick={() => setStake(v)}>
                {usdShort(v)}
              </button>
            ))}
          </div>
        </div>

        <div className="field pm-wide">
          <div className="field-head">
            <span>Entry price</span>
          </div>
          <div className="quick pm-chips" role="group" aria-label="Entry price">
            {ENTRY_PRICES.map((p) => (
              <button key={p} aria-pressed={price === p} onClick={() => setPrice(p)}>
                {wholeCents(p)}
              </button>
            ))}
          </div>
        </div>

        <div className="field pm-payout">
          <div className="field-head">
            <span>Payout</span>
          </div>
          <div className="seg pm-seg" role="group" aria-label="Payout mode">
            <button
              aria-pressed={!boost}
              onClick={() => setBoostOn(false)}
              title="Wins what the stake would win outright, and never more than the stake."
            >
              Free
            </button>
            <button
              className="pm-boost"
              aria-pressed={boost}
              onClick={() => setBoostOn(true)}
              disabled={lev < 2}
              title={
                lev < 2
                  ? "Boost needs leverage of 2× or more."
                  : "Keeps the leveraged win, up to 10× the stake, for a daily premium out of the stake."
              }
            >
              Boost
            </button>
          </div>
        </div>
      </div>

      <div className="field">
        <div className="field-head">
          <span>Leverage</span>
          <span className="lev-readout">
            {lev}×
            <small title="Both lines must stay at least 5 cents from the entry, and the limit falls as the result nears.">
              max {maxLev}×
            </small>
          </span>
        </div>
        <div className="slider" style={{ ["--t" as string]: sliderT }}>
          <input
            type="range"
            min={1}
            max={maxLev}
            step={1}
            value={lev}
            onChange={(e) => setLeverage(Number(e.target.value))}
            aria-label="Leverage"
            aria-valuetext={`${lev} times`}
          />
        </div>
        <div className="slider-ticks">
          <span>1×</span>
          <span>
            {maxLev}× at {wholeCents(price)}
          </span>
        </div>
      </div>

      <div className="field">
        <div className="field-head">
          <span>The odds: the price of Yes, in cents</span>
        </div>
        <OddsBar
          isYes={isYes}
          price={price}
          winLine={c.winLine}
          liqLine={c.liqLine}
          stopLine={c.stopLine}
          noStop={c.neverLiquidated}
        />
      </div>

      <div className="pm-readout">
        <Statement
          tone="win"
          label={boost ? "Win line, with Boost" : "Win line"}
          sub={
            lev === 1
              ? "At 1× the win line is the result itself."
              : boost
                ? capped
                  ? `The most a boosted bet can win is ${DEMO_PROFIT_MULT}× its stake.`
                  : `The leveraged win: ${lev}× what the outright bet wins.`
                : atStake
                  ? "A leveraged bet never wins more than its stake."
                  : "Paid in full there, without waiting for the result."
          }
        >
          {boost ? "Wins up to " : "Wins "}
          <b className="long">
            <Num value={c.maxWin} format={usd} />
          </b>
          {atResult ? (
            ` if the event resolves ${side}.`
          ) : (
            <>
              {isYes ? " when the odds reach " : " when the odds fall to "}
              <b>
                <Num value={pct(c.winLine)} format={cents} />
              </b>
              {" cents."}
            </>
          )}
        </Statement>

        {c.neverLiquidated ? (
          <Statement tone="stop" label="Stop line" sub="The stake is lost only if the event resolves the other way.">
            {"Never stopped out. At 1× you are buying shares, and they ride to the result."}
          </Statement>
        ) : (
          <Statement
            tone="stop"
            label="Stop line"
            sub={
              `The stake would be gone at ${cents(pct(c.stopLine))} cents. ` +
              (boost
                ? "As the premium is paid, this line moves toward the entry."
                : "The bet is closed before that, and what is left comes back.")
            }
          >
            {"Stopped out near "}
            <b className="short">
              <Num value={pct(c.liqLine)} format={cents} />
            </b>
            {" cents (about "}
            <b>{usdShort(back)}</b>
            {" back)."}
          </Statement>
        )}

        {boost ? (
          <Statement
            tone="boost"
            label="Boost premium"
            sub={
              "The premium comes out of the stake. It is cheap far from the result and costs more as the result nears."
            }
          >
            {"Boost costs about "}
            <b className="brass">
              <Num value={boostPerDay} format={usd} />
            </b>
            {" a day now."}
          </Statement>
        ) : (
          <Statement
            tone="plain"
            label="The outright bet"
            sub={
              lev === 1
                ? "At 1× there is no shortcut. The win needs the result."
                : atStake
                  ? `With leverage the win is the stake itself, ${article(move)} ${move.toFixed(1)}-point move away.`
                  : `Same bet, decided by ${article(move)} ${move.toFixed(1)}-point move instead of the final result.`
            }
          >
            {`The same ${usdShort(stake)} outright wins `}
            <b>
              <Num value={c.outrightWin} format={usd} />
            </b>
            {" only at the result."}
          </Statement>
        )}
      </div>

      <p className="note">
        Wins are shown before fees. A win pays 10% of its profit. If your side of a market is crowded, a crowding fee
        comes out of the stake each day; a balanced market pays none. A bet cannot lose more than its stake.
      </p>
    </section>
  );
}

/* ---- live markets ----------------------------------------------------------------------- */

function MarketCard({ meta, now }: { meta: MarketMeta; now: number }) {
  const market = useStore((s) => s.markets[meta.id]);
  const liveMid = useStore((s) => s.live[meta.id]?.mid ?? s.markets[meta.id]?.mid);
  const prev = useStore((s) => s.summary[meta.id]?.prevDay);
  const spark = useStore((s) => s.sparks[meta.id]);
  const maintFraction = useStore((s) => s.params.maintFraction);
  const select = useStore((s) => s.select);
  const { title } = displayName(meta);

  const resolved = market?.resolved ?? false;
  // Once a market has resolved the chain holds its final price; the last live quote may be older.
  const mid = resolved ? market?.mid : liveMid;
  const yes = mid != null && Number.isFinite(mid) && mid >= 0 && mid <= 1 ? mid : null;
  const expiry = market?.expiry || meta.expiry || 0;
  // A market stops trading at its expiry: five minutes before kickoff for a match.
  const closed = !resolved && (!!market?.closed || (expiry > 0 && now >= expiry));

  // What $100 on Yes does at the most leverage the engine allows right now. The engine reports
  // no limit until it has a price, so anything under 1× is shown as 1×.
  let quote: { lev: number; maxWin: number; winLine: number } | null = null;
  if (market && yes != null && yes > 0 && yes < 1 && !resolved && !closed) {
    const lev = Math.max(1, Math.floor(market.maxLevLong) || 1);
    const c = corridor({
      price: yes,
      isYes: true,
      margin: 100,
      leverage: lev,
      boost: false,
      maintFraction,
      maxProfitMult: market.maxProfitMult,
    });
    // A half-loaded market must read as "waiting", never as NaN.
    if (Number.isFinite(c.maxWin) && Number.isFinite(c.winLine)) {
      quote = { lev, maxWin: c.maxWin, winLine: c.winLine };
    }
  }

  const when = resolved
    ? "Resolved"
    : closed
      ? "Waiting for result"
      : expiry > 0
        ? `Closes in ${fmtDuration(expiry - now)}`
        : null;

  const change = yes != null && prev && !resolved ? (yes - prev) * 100 : null;
  const hasSpark = spark != null && spark.length > 1;

  return (
    <article className="card pm-market">
      <div className="pm-market-top">
        <span className="eyebrow">{meta.category ?? "Event"}</span>
        {when && <span className="pm-market-when">{when}</span>}
      </div>

      <div className="pm-market-title">
        <div>
          <h4 className="pm-market-q">{title}</h4>
          {meta.outcome && (
            <p className="pm-market-yes">
              <span className="long">Yes</span> = {meta.outcome}
            </p>
          )}
        </div>
        {(hasSpark || change != null) && (
          <div className="pm-market-trend">
            {hasSpark && <Sparkline points={spark} width={88} height={28} />}
            {change != null && (
              <span className={`mono ${change >= 0 ? "long" : "short"}`} title="Change over the last day">
                {change >= 0 ? "+" : "−"}
                {Math.abs(change).toFixed(1)}¢
              </span>
            )}
          </div>
        )}
      </div>

      <div className={`pm-quote${yes == null ? " is-empty" : ""}`}>
        <div className="pm-quote-row">
          <span className="long">
            <Num value={yes == null ? null : yes * 100} format={centsMark} />
            <small>Yes</small>
          </span>
          <span className="short">
            <small>No</small>
            <Num value={yes == null ? null : (1 - yes) * 100} format={centsMark} />
          </span>
        </div>
        <Bar fraction={yes ?? 0} color="var(--long)" />
      </div>

      <div className="pm-market-lev">
        {quote ? (
          <>
            <span className="badge brass">Up to {quote.lev}× now</span>
            <p className="pm-market-line">
              $100 on Yes at {quote.lev}×: pays <b className="mono">{usd(quote.maxWin)}</b>{" "}
              {quote.winLine >= 0.9995 ? (
                "at the result."
              ) : (
                <>
                  at <b className="mono">{cents(quote.winLine * 100)}</b> cents.
                </>
              )}
            </p>
          </>
        ) : resolved ? (
          <>
            <span className="badge neutral">{yes != null && yes >= 0.5 ? "Resolved Yes" : "Resolved No"}</span>
            <p className="pm-market-line">Open bets can be settled at the final price.</p>
          </>
        ) : closed ? (
          <>
            <span className="badge neutral">Closed</span>
            <p className="pm-market-line">Trading closed. Positions settle at the result.</p>
          </>
        ) : (
          <p className="pm-market-line is-quiet">Waiting for prices.</p>
        )}
      </div>

      {resolved || closed ? (
        <div className="pm-market-actions">
          <button className="btn btn-ghost pm-btn" onClick={() => select(meta.id)}>
            View market
          </button>
        </div>
      ) : (
        <div className="pm-market-actions is-pair">
          <button className="btn pm-btn pm-btn-yes" onClick={() => select(meta.id)}>
            Trade Yes
          </button>
          <button className="btn pm-btn pm-btn-no" onClick={() => select(meta.id)}>
            Trade No
          </button>
        </div>
      )}
    </article>
  );
}

function LiveMarkets() {
  const now = useNowSeconds();
  const online = useStore((s) => s.keeperOnline);
  // Four cards sit two by two; any other number goes three across.
  const columns = EVENTS.length === 4 || EVENTS.length < 3 ? 2 : 3;

  return (
    <section className="pm-section">
      <div className="pm-head">
        <h3>Live markets</h3>
        {EVENTS.length > 0 && (
          <p className="pm-live">
            <span className={`dot${online ? " is-on" : ""}`} />
            {online ? "Event contracts from Gemini, priced live" : "Event contracts from Gemini"}
          </p>
        )}
      </div>
      {EVENTS.length > 0 ? (
        <div className="pm-markets" data-columns={columns}>
          {EVENTS.map((m) => (
            <MarketCard key={m.id} meta={m} now={now} />
          ))}
        </div>
      ) : (
        <p className="pm-empty">No prediction markets are listed on this network yet.</p>
      )}
    </section>
  );
}

/* ---- how it stays safe ------------------------------------------------------------------ */

const SAFETY = [
  {
    title: "A jump cannot leave the house short",
    body: "The odds can jump, even straight to 0 or 100. A leveraged bet can lose its stake, and it can win at most its stake and never more than the outright payout. That win is locked in the vault when the bet opens.",
  },
  {
    title: "Less leverage near the result",
    body: "The limit falls with the square root of the time left, down to 1× by the time the event starts. A 1× bet is just the shares: it is never liquidated and it rides to the result.",
  },
  {
    title: "Size follows the real order book",
    body: "Each side can hold half the money resting near the price on Gemini. That money has to stay there to count.",
  },
];

export function PredictPage() {
  const openDoc = useStore((s) => s.openDoc);

  return (
    <main className="page pm-page">
      <div className="page-inner pm-inner">
        <div>
          <h2>
            Leverage on prediction markets, <em>that the house can always pay.</em>
          </h2>
          <p className="lede">
            A leveraged bet wins what the same stake would win outright, and never more than the stake itself. Leverage
            brings that win closer: up to 10× on dated markets and up to 5× on sports.
          </p>
        </div>

        <Explainer />

        <LiveMarkets />

        <section className="pm-section">
          <div className="pm-head">
            <h3>How it stays safe</h3>
          </div>
          <div className="rules">
            {SAFETY.map((r, i) => (
              <article className="rule" key={r.title}>
                <span className="n">{i + 1}</span>
                <h4>{r.title}</h4>
                <p>{r.body}</p>
              </article>
            ))}
          </div>
          <p className="note pm-honest">
            This is a testnet prototype. Before launch a swarm of AI agents attacked the design, and some of what they
            found is still open.{" "}
            <button className="link" onClick={() => openDoc("prediction-markets")}>
              Read how it works
            </button>
            {" · "}
            <button className="link" onClick={() => openDoc("risks")}>
              What we are still working on
            </button>
          </p>
        </section>
      </div>
    </main>
  );
}
