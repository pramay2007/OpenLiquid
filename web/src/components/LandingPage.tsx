import { useEffect, useRef } from "react";
import { deployment, type MarketMeta } from "../chain/config";
import { connectDemo } from "../data/wallet";
import { corridor } from "../lib/corridor";
import { fmtDuration, fmtPct, fmtPrice } from "../lib/format";
import { useStore } from "../state/store";
import { displayName } from "./MarketRail";
import { Num, Sparkline } from "./primitives";

const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * The backdrop: layered lines moving like the surface of deep water, each one also readable as
 * a price path. Nearer lines are larger and slower to settle; one of them is brass and carries
 * a light along it.
 */
function LiquidField() {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    let w = 0;
    let h = 0;
    let raf = 0;
    let pointer = 0.5;

    const resize = () => {
      const r = canvas.getBoundingClientRect();
      w = r.width;
      h = r.height;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };

    const LINES = 24;
    const BRASS = 9;
    const STEP = 10;

    const heightAt = (i: number, x: number, t: number) => {
      const k = i / (LINES - 1); // 0 = far, 1 = near
      const base = h * (0.4 + 0.64 * Math.pow(k, 1.6));
      const amp = 5 + 54 * Math.pow(k, 1.5);
      const u = x / Math.max(w, 1);
      return (
        base +
        amp *
          (0.58 * Math.sin(u * (7.5 - 3.5 * k) + t * (0.16 + 0.34 * k) + i * 1.7) +
            0.3 * Math.sin(u * (15 - 6 * k) - t * (0.11 + 0.22 * k) + i * 0.9 + pointer * 1.6) +
            0.12 * Math.sin(u * 41 + t * 0.5 + i * 2.3))
      );
    };

    const draw = (ms: number) => {
      const t = ms / 1000;
      ctx.clearRect(0, 0, w, h);
      for (let i = 0; i < LINES; i++) {
        const k = i / (LINES - 1);
        ctx.beginPath();
        ctx.moveTo(-STEP, heightAt(i, -STEP, t));
        for (let x = 0; x <= w + STEP; x += STEP) ctx.lineTo(x, heightAt(i, x, t));
        // Fill beneath each line so nearer layers cover the ones behind them.
        ctx.save();
        ctx.lineTo(w + STEP, h + 2);
        ctx.lineTo(-STEP, h + 2);
        ctx.closePath();
        ctx.fillStyle = `rgba(${7 + 6 * k}, ${9 + 9 * k}, ${12 + 14 * k}, ${0.72 + 0.2 * k})`;
        ctx.fill();
        ctx.restore();

        ctx.beginPath();
        ctx.moveTo(-STEP, heightAt(i, -STEP, t));
        for (let x = 0; x <= w + STEP; x += STEP) ctx.lineTo(x, heightAt(i, x, t));
        if (i === BRASS) {
          ctx.shadowColor = "rgba(227, 178, 90, 0.75)";
          ctx.shadowBlur = 18;
          ctx.strokeStyle = "rgba(227, 178, 90, 0.95)";
          ctx.lineWidth = 1.6;
        } else {
          ctx.shadowBlur = 0;
          ctx.strokeStyle = `rgba(132, 172, 214, ${0.05 + 0.24 * k})`;
          ctx.lineWidth = 1;
        }
        ctx.stroke();
        ctx.shadowBlur = 0;

        if (i === BRASS) {
          const x = ((t * 70) % (w + 240)) - 120;
          const y = heightAt(i, x, t);
          const glow = ctx.createRadialGradient(x, y, 0, x, y, 26);
          glow.addColorStop(0, "rgba(255, 226, 160, 0.9)");
          glow.addColorStop(0.25, "rgba(227, 178, 90, 0.45)");
          glow.addColorStop(1, "rgba(227, 178, 90, 0)");
          ctx.fillStyle = glow;
          ctx.beginPath();
          ctx.arc(x, y, 26, 0, Math.PI * 2);
          ctx.fill();
          ctx.fillStyle = "#fff3d6";
          ctx.beginPath();
          ctx.arc(x, y, 2.6, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      if (!reducedMotion()) raf = requestAnimationFrame(draw);
    };

    const onMove = (ev: PointerEvent) => (pointer = ev.clientX / Math.max(window.innerWidth, 1));
    const onResize = () => {
      resize();
      if (reducedMotion()) draw(0);
    };
    resize();
    raf = requestAnimationFrame(draw);
    window.addEventListener("resize", onResize);
    window.addEventListener("pointermove", onMove, { passive: true });
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", onResize);
      window.removeEventListener("pointermove", onMove);
    };
  }, []);

  return <canvas ref={ref} className="liquid" aria-hidden />;
}

const useMid = (id: number | undefined) =>
  useStore((s) => (id == null ? undefined : (s.live[id]?.mid ?? s.markets[id]?.mid)));

/** The featured prediction market: live odds, and how much leverage each side can take now. */
function EventCard({ meta }: { meta: MarketMeta }) {
  const mid = useMid(meta.id);
  const market = useStore((s) => s.markets[meta.id]);
  const select = useStore((s) => s.select);
  const yes = mid != null && mid > 0 ? mid : 0.5;
  // The same limit applies to both sides: each line of the bet stays a minimum distance from entry.
  const best = market?.maxLevLong || Math.max(1, Math.floor(Math.min(yes, 1 - yes) / (market?.minDistance || 0.1)));
  // Trading stops at the market's expiry: five minutes before kickoff for a match.
  const secondsLeft = (market?.expiry || meta.expiry || 0) - Date.now() / 1000;

  return (
    <button className="glass event-card" onClick={() => select(meta.id)}>
      <div className="eyebrow">Prediction market · Gemini</div>
      <h3>{meta.name}</h3>
      <div className="odds" aria-label="Live odds">
        <i className="yes" style={{ width: `${yes * 100}%` }} />
      </div>
      <div className="odds-legend">
        <span>
          <b className="long">
            <Num value={yes * 100} format={(n) => `${n.toFixed(0)}¢`} />
          </b>
          {meta.outcome ?? "Yes"}
        </span>
        <span>
          Not
          <b className="short">
            <Num value={(1 - yes) * 100} format={(n) => `${n.toFixed(0)}¢`} />
          </b>
        </span>
      </div>

      <div className="gauge">
        <svg viewBox="0 0 180 104" aria-hidden>
          <path d="M20 92 A70 70 0 0 1 160 92" pathLength={100} className="gauge-track" />
          <path
            d="M20 92 A70 70 0 0 1 160 92"
            pathLength={100}
            className="gauge-fill"
            style={{ strokeDashoffset: 100 - Math.min(100, (best / 10) * 100) }}
          />
        </svg>
        <div className="gauge-read">
          <b>
            <Num value={best} format={(n) => `${Math.round(n)}×`} />
          </b>
          <span>leverage, right now</span>
        </div>
      </div>
      <div className="event-sides">
        <span>
          Yes or No, up to <b>{best}×</b>
        </span>
        {secondsLeft > 0 && (
          <span>
            closes in <b>{fmtDuration(secondsLeft)}</b>
          </span>
        )}
      </div>
    </button>
  );
}

function MiniCard({ meta, className }: { meta: MarketMeta; className: string }) {
  const mid = useMid(meta.id);
  const prev = useStore((s) => s.summary[meta.id]?.prevDay);
  const spark = useStore((s) => s.sparks[meta.id]);
  const lev = useStore((s) => s.markets[meta.id]?.maxLeverage ?? 1000);
  const select = useStore((s) => s.select);
  const change = mid != null && prev ? mid / prev - 1 : null;

  return (
    <button className={`glass mini-card ${className}`} onClick={() => select(meta.id)}>
      <div className="mini-head">
        <b>{meta.symbol}</b>
        <span className="lev-chip">{lev}×</span>
      </div>
      <Num className="mini-px" value={mid} format={(n) => fmtPrice(n, meta)} flash />
      <div className="mini-foot">
        <span className={`mono ${change == null || change >= 0 ? "long" : "short"}`}>{change == null ? meta.name : fmtPct(change)}</span>
        <Sparkline points={spark ?? []} width={84} height={26} />
      </div>
    </button>
  );
}

function Ticker() {
  const items = deployment.markets;
  const Row = ({ meta }: { meta: MarketMeta }) => {
    const mid = useMid(meta.id);
    const { title, sub } = displayName(meta);
    return (
      <span className="tick">
        <b>{meta.kind === "event" ? `${title} · ${sub}` : title}</b>
        <Num value={mid} format={(n) => fmtPrice(n, meta)} />
      </span>
    );
  };
  // The list is rendered twice so the loop has no seam.
  return (
    <div className="ticker" aria-hidden>
      <div className="ticker-track">
        {[0, 1].map((copy) => (
          <div className="ticker-set" key={copy}>
            {items.map((m) => (
              <Row key={m.id} meta={m} />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

const CHAINS = [
  { name: "Base", x: 42, y: 34 },
  { name: "Ethereum", x: 34, y: 96 },
  { name: "Arbitrum", x: 238, y: 30 },
  { name: "OP", x: 250, y: 92 },
  { name: "Avalanche", x: 140, y: 122 },
];

function Features() {
  return (
    <section className="features">
      <article className="feature">
        <svg viewBox="0 0 280 140" className="feature-art" aria-hidden>
          <defs>
            <clipPath id="reveal">
              <rect className="reveal" x="0" y="0" width="280" height="140" />
            </clipPath>
          </defs>
          <line x1="10" y1="118" x2="270" y2="118" className="art-axis" />
          <g clipPath="url(#reveal)">
            <path d="M10 88H112V38H176V88H270" className="art-mid" />
            <path d="M10 88H112C134 88 156 70 176 66C204 72 236 86 270 88" className="art-slow" />
            <circle cx="150" cy="73" r="4" className="art-fill" />
          </g>
          <text x="118" y="30" className="art-label">
            pushed price
          </text>
          <text x="131" y="104" className="art-label brass">
            your fill
          </text>
        </svg>
        <h4>A pushed price pays nothing</h4>
        <p>
          Every trade fills at the worse of the live price and a slow, time-weighted one. Calm market: the same number,
          no slippage. A price shoved for a minute moves one and not the other.
        </p>
      </article>

      <article className="feature">
        <svg viewBox="0 0 280 140" className="feature-art" aria-hidden>
          <rect x="10" y="46" width="260" height="34" rx="8" className="art-vault" />
          <rect x="10" y="46" width="52" height="34" rx="8" className="art-margin" />
          <rect x="62" y="46" width="120" height="34" className="art-reserve" />
          <text x="14" y="102" className="art-label">
            margin
          </text>
          <text x="66" y="102" className="art-label brass">
            locked for winners
          </text>
          <text x="214" y="102" className="art-label">
            free for LPs
          </text>
          <path d="M122 30v-5a8 8 0 0 1 16 0v5m-20 0h24v14h-24z" className="art-lock" />
        </svg>
        <h4>Winners are paid when they close</h4>
        <p>
          A funded vault sets aside each position's maximum payout before it opens, and liquidity providers cannot
          withdraw what is set aside. No queue, no IOU.
        </p>
      </article>

      <article className="feature">
        <svg viewBox="0 0 280 140" className="feature-art" aria-hidden>
          {CHAINS.map((c, i) => (
            <g key={c.name}>
              <path id={`hop-${i}`} d={`M${c.x} ${c.y}L140 70`} className="art-hop" />
              <circle r="2.4" className="art-coin">
                <animateMotion dur={`${2.6 + i * 0.35}s`} begin={`${i * 0.5}s`} repeatCount="indefinite">
                  <mpath href={`#hop-${i}`} />
                </animateMotion>
              </circle>
              <circle cx={c.x} cy={c.y} r="4" className="art-node" />
              <text x={c.x} y={c.y + (c.y > 100 ? 14 : -9)} textAnchor="middle" className="art-label">
                {c.name}
              </text>
            </g>
          ))}
          <circle cx="140" cy="70" r="17" className="art-arc" />
          <text x="140" y="74" textAnchor="middle" className="art-label brass strong">
            Arc
          </text>
        </svg>
        <h4>Dollars all the way down</h4>
        <p>
          Margin, profit, fees and gas are all USDC on Arc. Bring it from five other chains with Circle's CCTP: one
          signature, and it arrives ready to spend.
        </p>
      </article>

      <article className="feature">
        <svg viewBox="0 0 280 140" className="feature-art" aria-hidden>
          <text x="14" y="44" className="art-label">
            you win
          </text>
          <rect x="74" y="30" width="190" height="22" rx="6" className="art-win" />
          <rect x="246" y="30" width="18" height="22" rx="6" className="art-fee" />
          <text x="206" y="68" className="art-label brass">
            a share of profit
          </text>
          <text x="14" y="104" className="art-label">
            you lose
          </text>
          <rect x="74" y="90" width="92" height="22" rx="6" className="art-loss" />
          <text x="176" y="105" className="art-label">
            no fee to close
          </text>
        </svg>
        <h4>No fee to open, no funding</h4>
        <p>
          Nothing to open or close, and no funding paid between traders. Winners pay a share of profit. The crowded
          side of a market pays a small daily crowding fee; a balanced market pays none.
        </p>
      </article>
    </section>
  );
}

/** A leveraged bet on the featured market, drawn as a win line and a stop line on the odds. */
function OddsZoom({ meta }: { meta: MarketMeta }) {
  const mid = useMid(meta.id);
  const market = useStore((s) => s.markets[meta.id]);
  const maint = useStore((s) => s.params.maintFraction);
  const select = useStore((s) => s.select);
  const price = mid != null && mid > 0.03 && mid < 0.97 ? mid : 0.54;
  const lev = Math.max(1, Math.min(10, Math.floor(market?.maxLevLong || 5)));
  const c = corridor({ price, isYes: true, margin: 100, leverage: lev, boost: false, maintFraction: maint, maxProfitMult: 10 });
  const pct = (x: number) => `${Math.max(0, Math.min(1, x)) * 100}%`;
  const cents = (x: number) => `${(x * 100).toFixed(1)}¢`;

  return (
    <button className="zoom" onClick={() => select(meta.id)} aria-label={`Trade ${meta.name}`}>
      <div className="zoom-head">
        <span>
          {meta.name} · Yes = {meta.outcome ?? "Yes"}
        </span>
        <b>$100 at {lev}×</b>
      </div>
      <div className="zoom-bar">
        <i className="lose" style={{ left: pct(c.liqLine), width: pct(price - c.liqLine) }} />
        <i className="win" style={{ left: pct(price), width: pct(c.winLine - price) }} />
        <u style={{ left: pct(price) }} />
      </div>
      <div className="zoom-scale">
        <span>0¢</span>
        <span>50¢</span>
        <span>100¢</span>
      </div>
      <dl className="zoom-read">
        <div>
          <dt>Pays in full at</dt>
          <dd className="long">{c.winLine >= 0.9995 ? "the result" : cents(c.winLine)}</dd>
        </div>
        <div>
          <dt>You win</dt>
          <dd>${c.maxWin.toFixed(2)}</dd>
        </div>
        <div>
          <dt>Stops out near</dt>
          <dd className="short">{c.neverLiquidated ? "never" : cents(c.liqLine)}</dd>
        </div>
      </dl>
    </button>
  );
}

export function LandingPage() {
  const setPage = useStore((s) => s.setPage);
  const openDoc = useStore((s) => s.openDoc);
  const events = deployment.markets.filter((m) => m.kind === "event");
  const featured = events[0];
  const byId = (id: number) => deployment.markets.find((m) => m.id === id);
  const sideA = byId(1) ?? deployment.markets[0];
  const sideB = byId(40) ?? byId(21) ?? deployment.markets[1];

  function start() {
    setPage("trade");
    const { account, keeperOnline } = useStore.getState();
    if (!account && keeperOnline) void connectDemo();
  }

  return (
    <main className="landing">
      <section className="hero">
        <LiquidField />
        <div className="hero-copy">
          <div className="eyebrow">Live on Arc testnet</div>
          <h1>
            No order book.
            <br />
            No slippage.
            <em>Just the price.</em>
          </h1>
          <ul className="claims">
            <li>
              <b>1000×</b> leverage on crypto, stocks and commodities
            </li>
            <li>
              <b>0</b> order book, <b>0</b> spread, <b>0</b> market impact
            </li>
            <li>
              <b>$0</b> to open or close, and no funding between traders
            </li>
            <li>
              <b>leverage on prediction markets</b>, built so the house can always pay
            </li>
            <li>
              <b>100%</b> onchain on Arc, with gas in USDC
            </li>
          </ul>
          <div className="hero-cta">
            <button className="btn btn-primary btn-hero" onClick={start}>
              Start trading
            </button>
            <button className="btn btn-ghost btn-hero" onClick={() => setPage("predict")}>
              Prediction markets
            </button>
            <button className="link hero-link" onClick={() => openDoc("")}>
              Whitepaper
            </button>
          </div>
          <p className="hero-foot">
            No slippage when the market is calm. When a price is moving fast, a fill takes the slower of two prices.{" "}
            <button className="link" onClick={() => openDoc("pricing")}>
              How fills work
            </button>
          </p>
        </div>

        <div className="hero-stage" aria-label="Live markets">
          {sideA && <MiniCard meta={sideA} className="a" />}
          {featured && <EventCard meta={featured} />}
          {sideB && <MiniCard meta={sideB} className="b" />}
        </div>

        <Ticker />
      </section>

      {featured && (
        <section className="band">
          <div>
            <div className="eyebrow">New: leverage on prediction markets</div>
            <h2>
              A bet that pays when the odds move, <em>not when the game ends.</em>
            </h2>
            <p>
              Put $100 on an outcome with leverage and it is paid in full as soon as the odds reach your win line. A
              leveraged position wins what the same stake would win outright, and never more than the stake itself.
              Leverage brings that win closer. That one rule is why a sudden jump in the odds cannot leave the house
              short.
            </p>
            <p>
              Want the leveraged win? Where a market offers it, switch on Boost and pay a daily premium for it. Up to
              10× on dated markets and up to 5× on sports, less as the result nears.
            </p>
            <div className="hero-cta">
              <button className="btn btn-primary btn-hero" onClick={() => setPage("predict")}>
                See the markets
              </button>
              <button className="btn btn-ghost btn-hero" onClick={() => openDoc("prediction-markets")}>
                How it works
              </button>
            </div>
          </div>
          <OddsZoom meta={featured} />
        </section>
      )}

      <Features />

      <section className="replay-strip">
        <div>
          <div className="eyebrow">The price-push attack, tested</div>
          <p>
            A venue that fills any size at a reference price pays anyone who can move that price for a minute. Our
            contract tests run that attack twice: against an engine that simply fills at the mid, and against
            OpenLiquid. The attacker spends about $52,000 pushing the price by 0.12%.
          </p>
          <button className="link" onClick={() => setPage("mechanics")}>
            Watch the replay
          </button>
        </div>
        <div className="replay-figures">
          <div>
            <span>Any size, at the mid</span>
            <b className="short">+$349,272</b>
          </div>
          <div>
            <span>OpenLiquid</span>
            <b className="brass">+$187</b>
          </div>
        </div>
      </section>

      <section className="replay-strip">
        <div>
          <div className="eyebrow">Stress-tested by a swarm of agents</div>
          <p>
            Before launch we set a swarm of AI agents on the design: seven adversarial Monte Carlo attacks and six
            independent code reviews. They reported 58 economic findings and 51 code findings, many
            of them the same hole seen twice. The ones fixed are listed with the ones still open in the whitepaper.
          </p>
          <button className="link" onClick={() => openDoc("risks")}>
            What they found, and what is still open
          </button>
        </div>
        <div className="replay-figures">
          <div>
            <span>Adversarial simulations</span>
            <b className="brass">11</b>
          </div>
          <div>
            <span>Independent code reviews</span>
            <b className="brass">6</b>
          </div>
        </div>
      </section>

      <footer className="landing-foot">
        <span>Testnet prototype. Unaudited. Test funds only. Some mechanics are still being refined.</span>
        <span>
          <button className="link" onClick={() => openDoc("")}>
            Whitepaper
          </button>
          <a className="link" href="https://github.com/pramay2007/OpenLiquid" target="_blank" rel="noreferrer">
            GitHub
          </a>
        </span>
      </footer>
    </main>
  );
}
