import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { deployment, type MarketMeta } from "../chain/config";
import { connectDemo } from "../data/wallet";
import { fmtCompactUsd, fmtPrice } from "../lib/format";
import { useStore } from "../state/store";
import "../home.css";

const GITHUB_URL = "https://github.com/pramay2007/OpenLiquid";

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(
    () => typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const onChange = () => setReduced(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return reduced;
}

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const ease = (x: number) => {
  const t = clamp01(x);
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
};

/** Seconds for one pass: a book, the book folding into one line, the line as a live price, and back. */
const LOOP = 9;

type Phase = "book" | "price";

/**
 * The idea of the product in one picture. An order book ladder, bids below a gap and asks above
 * it, folds into a single line. The line then moves as a live price.
 */
function BookToPrice({ reduced, onPhase }: { reduced: boolean; onPhase: (p: Phase) => void }) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;

    const accent = getComputedStyle(canvas).getPropertyValue("--home-accent-rgb").trim() || "227, 178, 90";
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const started = performance.now();
    let w = 0;
    let h = 0;
    let raf = 0;
    let onScreen = true;
    let phase: Phase | null = null;

    const bar = (x: number, y: number, width: number, height: number) => {
      const r = Math.min(height / 2, width / 2);
      ctx.beginPath();
      ctx.moveTo(x + r, y);
      ctx.lineTo(x + width - r, y);
      ctx.arc(x + width - r, y + r, r, -Math.PI / 2, Math.PI / 2);
      ctx.lineTo(x + r, y + height);
      ctx.arc(x + r, y + r, r, Math.PI / 2, (3 * Math.PI) / 2);
      ctx.closePath();
      ctx.fill();
    };

    const draw = (now: number) => {
      // `clock` never resets, so the price path flows on across loops. `t` is the place in the loop.
      const clock = reduced ? 2.7 : (now - started) / 1000;
      const t = reduced ? 6 : clock % LOOP;

      // fold: 0 is the full ladder, 1 is everything folded into the line.
      let fold = 0;
      let line = 0;
      let amp = 0;
      if (t < 2) {
        fold = 0;
      } else if (t < 3.6) {
        fold = (t - 2) / 1.6;
        line = ease(fold);
      } else if (t < 4.6) {
        fold = 1;
        line = 1;
        amp = ease((t - 3.6) / 1);
      } else if (t < 7.4) {
        fold = 1;
        line = 1;
        amp = 1;
      } else if (t < 8) {
        fold = 1;
        line = 1;
        amp = 1 - ease((t - 7.4) / 0.6);
      } else {
        fold = 1 - (t - 8) / 1;
        line = 1 - ease((t - 8) / 1);
      }

      const next: Phase = fold < 0.5 ? "book" : "price";
      if (next !== phase) {
        phase = next;
        onPhase(next);
      }

      ctx.clearRect(0, 0, w, h);
      const pad = 14;
      const x0 = pad;
      const rw = Math.max(1, w - pad * 2);
      const rh = Math.max(1, h - pad * 2);
      const xc = x0 + rw / 2;
      const yc = pad + rh / 2;

      // ---- the ladder -------------------------------------------------------------------
      if (fold < 1) {
        const levels = rh < 260 ? 6 : 9;
        const gap = Math.max(16, rh * 0.075);
        const step = (rh / 2 - gap / 2) / levels;
        const thick = Math.max(2, Math.min(6, step * 0.32));
        for (let side = -1; side <= 1; side += 2) {
          for (let i = 1; i <= levels; i++) {
            const k = i / levels;
            // Levels nearest the mid fold first; the far ones follow.
            const f = ease(fold * 1.5 - 0.5 * k);
            const rest = yc + side * (gap / 2 + (i - 0.5) * step);
            const y = rest + (yc - rest) * f;
            const breathe =
              1 + 0.07 * Math.sin(clock * 1.1 + i * 1.7 + side * 0.8) + 0.04 * Math.sin(clock * 2.3 + i * 0.6);
            const restLen = rw * (0.14 + 0.72 * Math.pow(k, 0.8)) * breathe;
            const len = restLen + (rw - restLen) * f;
            const height = thick + (1 - thick) * f;
            const alpha = (i === 1 ? 0.5 : 0.32 - 0.22 * k) * (1 - f * f);
            if (alpha < 0.004) continue;
            ctx.fillStyle = `rgba(236, 239, 243, ${alpha})`;
            bar(xc - len / 2, y - height / 2, len, height);
          }
        }
      }

      // ---- the price --------------------------------------------------------------------
      if (line > 0.002) {
        const half = (rw / 2) * line;
        const left = xc - half;
        const right = xc + half;
        const swing = rh * 0.2 * amp;
        const yAt = (x: number) => {
          const u = (x - x0) / rw;
          const s = u * 0.9 + clock * 0.13;
          const wave =
            0.55 * Math.sin(6.2 * s) + 0.3 * Math.sin(13.7 * s + 1.3) + 0.15 * Math.sin(31 * s + 0.4);
          return yc + swing * wave * (0.35 + 0.65 * u);
        };

        const trace = () => {
          ctx.beginPath();
          ctx.moveTo(left, yAt(left));
          for (let x = left + 4; x < right; x += 4) ctx.lineTo(x, yAt(x));
          ctx.lineTo(right, yAt(right));
        };

        if (amp > 0.01) {
          const wash = ctx.createLinearGradient(0, yc - swing, 0, pad + rh);
          wash.addColorStop(0, `rgba(${accent}, ${0.1 * amp * line})`);
          wash.addColorStop(1, `rgba(${accent}, 0)`);
          trace();
          ctx.lineTo(right, pad + rh);
          ctx.lineTo(left, pad + rh);
          ctx.closePath();
          ctx.fillStyle = wash;
          ctx.fill();
        }

        const stroke = ctx.createLinearGradient(left, 0, right, 0);
        stroke.addColorStop(0, `rgba(${accent}, ${0.06 * line})`);
        stroke.addColorStop(0.4, `rgba(${accent}, ${0.6 * line})`);
        stroke.addColorStop(1, `rgba(${accent}, ${line})`);
        ctx.lineJoin = "round";
        ctx.lineCap = "round";
        ctx.save();
        ctx.shadowColor = `rgba(${accent}, ${0.55 * line})`;
        ctx.shadowBlur = 18;
        ctx.strokeStyle = stroke;
        ctx.lineWidth = 1.75;
        trace();
        ctx.stroke();
        ctx.restore();
        ctx.strokeStyle = stroke;
        ctx.lineWidth = 1.25;
        trace();
        ctx.stroke();

        // The newest price, at the right-hand end.
        const head = clamp01((line - 0.8) / 0.2);
        if (head > 0) {
          const hy = yAt(right);
          const pulse = reduced ? 0.4 : (clock * 0.7) % 1;
          ctx.beginPath();
          ctx.arc(right, hy, 3.4 + 11 * pulse, 0, Math.PI * 2);
          ctx.strokeStyle = `rgba(${accent}, ${0.35 * (1 - pulse) * head})`;
          ctx.lineWidth = 1;
          ctx.stroke();
          ctx.beginPath();
          ctx.arc(right, hy, 3.4, 0, Math.PI * 2);
          ctx.fillStyle = `rgba(${accent}, ${head})`;
          ctx.fill();
        }
      }
    };

    const frame = (now: number) => {
      draw(now);
      raf = requestAnimationFrame(frame);
    };
    const play = () => {
      if (reduced || raf || !onScreen || document.hidden) return;
      raf = requestAnimationFrame(frame);
    };
    const pause = () => {
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
    };

    const resize = () => {
      const r = canvas.getBoundingClientRect();
      w = r.width;
      h = r.height;
      canvas.width = Math.max(1, Math.round(w * dpr));
      canvas.height = Math.max(1, Math.round(h * dpr));
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      draw(performance.now());
    };

    resize();
    const sized = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(resize);
    sized?.observe(canvas);
    const seen =
      typeof IntersectionObserver === "undefined"
        ? null
        : new IntersectionObserver((entries) => {
            onScreen = entries.some((e) => e.isIntersecting);
            if (onScreen) play();
            else pause();
          });
    seen?.observe(canvas);
    const onVisibility = () => (document.hidden ? pause() : play());
    document.addEventListener("visibilitychange", onVisibility);
    play();

    return () => {
      pause();
      sized?.disconnect();
      seen?.disconnect();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [reduced, onPhase]);

  return <canvas ref={ref} className="home-art-canvas" aria-hidden="true" />;
}

/** Children fade and rise in, one after another, the first time the block scrolls into view. */
function Reveal({ children, className = "" }: { children: ReactNode; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [shown, setShown] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (typeof IntersectionObserver === "undefined") {
      setShown(true);
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setShown(true);
          io.disconnect();
        }
      },
      { threshold: 0.12, rootMargin: "0px 0px -6% 0px" }
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  return (
    <div ref={ref} className={`home-reveal${shown ? " is-in" : ""}${className ? ` ${className}` : ""}`}>
      {children}
    </div>
  );
}

/** A number that runs to its value the first time it is seen. It keeps its final width throughout. */
function Count({
  to,
  from = 0,
  prefix = "",
  suffix = "",
  duration = 1400,
  group = true,
  reduced,
}: {
  to: number;
  from?: number;
  prefix?: string;
  suffix?: string;
  duration?: number;
  /** Thousands separators. */
  group?: boolean;
  reduced: boolean;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const [value, setValue] = useState(reduced ? to : from);
  const text = (n: number) => `${prefix}${group ? n.toLocaleString("en-US") : String(n)}${suffix}`;

  useEffect(() => {
    if (reduced) {
      setValue(to);
      return;
    }
    const el = ref.current;
    if (!el) return;
    let raf = 0;
    let done = false;
    const run = () => {
      const t0 = performance.now();
      const tick = (now: number) => {
        const p = clamp01((now - t0) / duration);
        setValue(Math.round(from + (to - from) * (1 - Math.pow(1 - p, 3))));
        if (p < 1) raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);
    };
    if (typeof IntersectionObserver === "undefined") {
      run();
      return () => cancelAnimationFrame(raf);
    }
    const io = new IntersectionObserver(
      (entries) => {
        if (!done && entries.some((e) => e.isIntersecting)) {
          done = true;
          io.disconnect();
          run();
        }
      },
      { threshold: 0.5 }
    );
    io.observe(el);
    return () => {
      io.disconnect();
      cancelAnimationFrame(raf);
    };
  }, [to, from, duration, reduced]);

  return (
    <span ref={ref} className="home-count" aria-label={text(to)}>
      <span className="home-count-size" aria-hidden="true">
        {text(to)}
      </span>
      <span className="home-count-live" aria-hidden="true">
        {text(value)}
      </span>
    </span>
  );
}

function TickerItem({ meta, focusable }: { meta: MarketMeta; focusable: boolean }) {
  const mid = useStore((s) => s.live[meta.id]?.mid ?? s.markets[meta.id]?.mid);
  const select = useStore((s) => s.select);
  const label = meta.kind === "event" ? `${meta.name}: ${meta.outcome ?? "Yes"}` : meta.symbol;
  const known = mid != null && Number.isFinite(mid) && mid > 0;
  return (
    <button className="home-tick" onClick={() => select(meta.id)} tabIndex={focusable ? 0 : -1}>
      <span className="home-tick-name">{label}</span>
      {known ? <span className="home-tick-price">{fmtPrice(mid, meta)}</span> : <span className="home-tick-wait" />}
    </button>
  );
}

/** One quiet row of every listed market. The row is doubled so it can loop without a seam. */
function Ticker() {
  const markets = deployment.markets;
  if (markets.length === 0) return null;
  return (
    <div className="home-ticker" aria-label="Listed markets">
      <div className="home-ticker-track">
        {[0, 1].map((copy) => (
          <div className="home-ticker-group" key={copy} aria-hidden={copy === 1}>
            {markets.map((m) => (
              <TickerItem key={m.id} meta={m} focusable={copy === 0} />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

const ENTRY = 54; // cents
const OUTRIGHT_WIN = "$85.19"; // $100 of Yes at 54c: 100 * 46 / 54

/**
 * $100 on Yes at 54 cents. The payout is the same at every leverage; the two lines move closer
 * to the entry as leverage rises.
 */
function OddsZoom() {
  const [lev, setLev] = useState(5);
  const win = ENTRY + (100 - ENTRY) / lev;
  const stop = ENTRY - ENTRY / lev;
  const cents = (c: number) => `${c.toFixed(1)}¢`;
  const style = {
    "--win": `${win}%`,
    "--stop": `${stop}%`,
    "--entry": `${ENTRY}%`,
    "--fill": `${((lev - 1) / 9) * 100}%`,
  } as CSSProperties;

  return (
    <div className="home-odds" style={style}>
      <div className="home-odds-bar" role="img" aria-label={`At ${lev}x the position is paid in full at ${cents(win)} and stopped out at ${cents(stop)}.`}>
        <div className="home-odds-track" />
        <div className="home-odds-zone" />
        <div className={`home-odds-mark is-stop${lev === 1 ? " is-flipped" : ""}`}>
          <span>{lev === 1 ? "Resolves No" : `Stop ${cents(stop)}`}</span>
        </div>
        <div className="home-odds-mark is-entry">
          <span>Entry {ENTRY}¢</span>
        </div>
        <div className={`home-odds-mark is-win${lev === 1 ? " is-flipped" : ""}`}>
          <span>{lev === 1 ? "Resolves Yes" : `Win ${cents(win)}`}</span>
        </div>
        <div className="home-odds-scale" aria-hidden="true">
          <span>0¢</span>
          <span>100¢</span>
        </div>
      </div>

      <label className="home-odds-slider">
        <span>Leverage</span>
        <input
          type="range"
          min={1}
          max={10}
          step={1}
          value={lev}
          onChange={(e) => setLev(Number(e.target.value))}
          aria-label="Leverage"
          aria-valuetext={`${lev}x`}
        />
        <b>{lev}x</b>
      </label>

      <dl className="home-odds-read">
        <div>
          <dt>Stake</dt>
          <dd>$100 on Yes at {ENTRY}¢</dd>
        </div>
        <div>
          <dt>Wins</dt>
          <dd>
            {OUTRIGHT_WIN} <small>at every setting</small>
          </dd>
        </div>
        <div>
          <dt>Paid in full</dt>
          <dd>{lev === 1 ? "when it resolves Yes" : `when odds reach ${cents(win)}`}</dd>
        </div>
        <div>
          <dt>Stake is gone</dt>
          <dd>{lev === 1 ? "when it resolves No" : `if odds fall to ${cents(stop)}`}</dd>
        </div>
      </dl>
    </div>
  );
}

function Section({ index, label, children }: { index: string; label: string; children: ReactNode }) {
  return (
    <section className="home-section">
      <div className="home-wrap home-section-grid">
        <div className="home-eyebrow">
          <span>{index}</span>
          {label}
        </div>
        <Reveal className="home-section-body">{children}</Reveal>
      </div>
    </section>
  );
}

export function HomePage() {
  const setPage = useStore((s) => s.setPage);
  const openDoc = useStore((s) => s.openDoc);
  const vault = useStore((s) => s.vault);
  const reduced = usePrefersReducedMotion();
  const rootRef = useRef<HTMLElement>(null);
  const progressRef = useRef<HTMLDivElement>(null);
  const [phase, setPhase] = useState<Phase>(reduced ? "price" : "book");

  // A hairline across the top that fills as the page is read.
  useEffect(() => {
    const el = rootRef.current;
    const bar = progressRef.current;
    if (!el || !bar) return;
    let raf = 0;
    const update = () => {
      raf = 0;
      const max = el.scrollHeight - el.clientHeight;
      bar.style.transform = `scaleX(${max > 0 ? clamp01(el.scrollTop / max) : 0})`;
    };
    const onScroll = () => {
      if (!raf) raf = requestAnimationFrame(update);
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    update();
    return () => {
      el.removeEventListener("scroll", onScroll);
      if (raf) cancelAnimationFrame(raf);
    };
  }, []);

  function start() {
    setPage("trade");
    const { account, keeperOnline } = useStore.getState();
    if (!account && keeperOnline) void connectDemo();
  }

  const vaultKnown = vault != null && Number.isFinite(vault.totalAssets) && vault.totalAssets > 0;

  return (
    <main className="home" ref={rootRef}>
      <div className="home-progress" ref={progressRef} aria-hidden="true" />

      <section className="home-hero">
        <div className="home-wrap home-hero-grid">
          <div className="home-hero-copy">
            <p className="home-status">
              <i aria-hidden="true" />
              Live on Arc testnet
            </p>
            <h1 className="home-h1">
              <span className="home-line">
                <span>No order book.</span>
              </span>
              <span className="home-line">
                <span>No slippage.</span>
              </span>
              <span className="home-line is-accent">
                <span>Just the price.</span>
              </span>
            </h1>
            <p className="home-lede">
              Trade crypto, stocks, commodities and prediction markets with leverage, at the reference price, against
              a funded vault.
            </p>
            <div className="home-cta">
              <button className="home-btn is-solid" onClick={start}>
                Start trading
              </button>
              <button className="home-btn is-ghost" onClick={() => setPage("predict")}>
                Prediction markets
              </button>
            </div>
          </div>

          <div className="home-art">
            <BookToPrice reduced={reduced} onPhase={setPhase} />
            <div className="home-art-caption" data-phase={phase} aria-hidden="true">
              <span>An order book</span>
              <span>One price</span>
            </div>
          </div>
        </div>
        <Ticker />
      </section>

      <Section index="01" label="Price">
        <h2 className="home-h2">One price for everyone.</h2>
        <p className="home-p">
          Every trade fills at the reference price. A small order and a large one get the same fill. In a calm market
          that means zero slippage.
        </p>
        <p className="home-p">
          A price that was pushed for a moment cannot be traded against. A fill uses the worse of the live price and
          its recent average, so a push has to be held before it counts.
        </p>
        <div className="home-stats">
          <div>
            <b>
              <Count from={9} to={0} reduced={reduced} />
            </b>
            <span>spread</span>
          </div>
          <div>
            <b>
              <Count from={9} to={0} reduced={reduced} />
            </b>
            <span>fee to open or close</span>
          </div>
          <div>
            <b>
              <Count from={1} to={1000} suffix="x" group={false} reduced={reduced} />
            </b>
            <span>on crypto, stocks and commodities</span>
          </div>
        </div>
      </Section>

      <Section index="02" label="Prediction markets">
        <h2 className="home-h2">Leverage on prediction markets.</h2>
        <p className="home-p">
          Prediction markets have had almost no leverage. Odds jump, and nobody can close a position in the middle of
          a jump.
        </p>
        <p className="home-p">
          Our rule: a leveraged position wins what the same stake would win outright, and never more than the stake
          itself. Leverage brings that win closer. Up to 10x.
        </p>
        <OddsZoom />
        <p className="home-note">
          Live contracts from Gemini Prediction Markets.{" "}
          <button className="home-link" onClick={() => setPage("predict")}>
            Open prediction markets
          </button>
        </p>
      </Section>

      <Section index="03" label="Stress test">
        <h2 className="home-h2">Attacked by a swarm of agents before launch.</h2>
        <p className="home-p">
          We ran seven adversarial Monte Carlo attacks and six independent code reviews. They reported 58 economic
          findings and 51 code findings, many of them the same hole seen twice. Most are fixed. The rest are
          published.
        </p>
        <div className="home-versus">
          <div>
            <b>
              <Count to={349272} prefix="+$" duration={1700} reduced={reduced} />
            </b>
            <span>What a pushed price earns on a venue that fills any size at the mid.</span>
          </div>
          <div className="is-accent">
            <b>
              <Count to={187} prefix="+$" duration={1700} reduced={reduced} />
            </b>
            <span>The same trade here.</span>
          </div>
        </div>
        <p className="home-note">
          Replayed in the contract tests.{" "}
          <button className="home-link" onClick={() => openDoc("risks")}>
            What we are still working on
          </button>
        </p>
      </Section>

      <Section index="04" label="Vault">
        <h2 className="home-h2">A vault you can see.</h2>
        <p className="home-p">
          Winners are paid at close from a funded ERC-4626 vault. Each position's maximum payout is locked before it
          opens, so the vault never owes more than it holds.
        </p>
        {vaultKnown && vault && (
          <div className="home-stats is-vault">
            <div>
              <b>{fmtCompactUsd(vault.totalAssets)}</b>
              <span>in the vault now</span>
            </div>
            <div>
              <b>{fmtCompactUsd(vault.reserved)}</b>
              <span>locked for open positions</span>
            </div>
            <div>
              <b>{fmtCompactUsd(vault.free)}</b>
              <span>free</span>
            </div>
          </div>
        )}
        <div className="home-cta">
          <button className="home-btn is-ghost" onClick={() => setPage("earn")}>
            Earn
          </button>
        </div>
      </Section>

      <footer className="home-foot">
        <div className="home-wrap home-foot-grid">
          <p>Built on Arc. USDC is the gas token. Prices from Hyperliquid and Gemini Prediction Markets.</p>
          <nav aria-label="More">
            <button className="home-link" onClick={() => setPage("docs")}>
              Docs
            </button>
            <a className="home-link" href={GITHUB_URL} target="_blank" rel="noreferrer">
              GitHub
            </a>
          </nav>
          <small>Testnet prototype. Unaudited.</small>
        </div>
      </footer>
    </main>
  );
}
