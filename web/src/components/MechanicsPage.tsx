import { useEffect, useRef, useState } from "react";
import { fmtSignedUsd } from "../lib/format";
import { useStore } from "../state/store";

const RULES = [
  {
    title: "Worse-of fills",
    body: "Every trade is checked against two prices: the live mid and a slow, time-averaged price. Buys fill at the higher, sells at the lower. In a calm market they are the same number, so there is no slippage. A price that was just pushed has not moved the slow price yet, so it cannot be traded against.",
  },
  {
    title: "Depth-backed capacity",
    body: "Open interest on each side is capped at half the dollars resting near the mid on the reference venue, and that depth has to stay there to count. When the real book thins out, so does the room here. The size you can take never outruns what it would cost to move the price.",
  },
  {
    title: "Payouts locked up front",
    body: "A position opens only if the vault can lock its maximum payout at that moment. Liquidity providers cannot withdraw locked funds. A winner is paid in full when they close; there is no queue and no IOU.",
  },
  {
    title: "No funding, one crowding fee",
    body: "There is no fee to open or close and no funding paid between traders. Winners pay a share of profit. The only holding cost is a crowding fee, paid out of the stake by the crowded side of a market to the vault that is carrying the other side. A balanced market pays nothing.",
  },
  {
    title: "Leverage that zooms the odds",
    body: "On a prediction market a leveraged bet wins what the same stake would win outright, and never more than the stake itself. Leverage brings that win closer. The win line is never further from entry than the stop line, which is what keeps a jump across both from paying the trader. Boost keeps the leveraged win for a daily premium.",
  },
  {
    title: "Fees mint the token",
    body: "OLQ is minted when a fee is paid, to the account that paid it, on a decaying curve with a fixed maximum supply. Losses mint nothing. Stakers earn a share of fees; trader losses stay with the liquidity providers who underwrite trader wins.",
  },
];

// Figures below are the output of contracts/test/exploit.test.js, which replays the reported
// attack against both configurations of the engine.
const LANES = [
  {
    key: "naive",
    name: "Any size, at the mid",
    accepted: 297_000_000,
    pnl: 349_272,
    fillsAtPush: true,
  },
  {
    key: "openliquid",
    name: "OpenLiquid",
    accepted: 9_900_000,
    pnl: 187,
    fillsAtPush: false,
  },
];

const W = 440;
const H = 150;
const T_OPEN = 0.22;
const T_PUSH = 0.42;
const T_CLOSE = 0.52;
const T_REVERT = 0.74;
const y = (level: number) => H - 28 - level * 78; // level 0 = fair price, 1 = pushed price
const x = (t: number) => 14 + t * (W - 28);

function midPath(upTo: number) {
  const pts: [number, number][] = [[0, 0]];
  if (upTo > T_PUSH) pts.push([T_PUSH, 0], [T_PUSH, 1]);
  if (upTo > T_REVERT) pts.push([T_REVERT, 1], [T_REVERT, 0]);
  pts.push([upTo, upTo > T_PUSH && upTo <= T_REVERT ? 1 : 0]);
  return pts.map(([t, l], i) => `${i ? "L" : "M"}${x(t).toFixed(1)} ${y(l).toFixed(1)}`).join(" ");
}

/** The slow price: flat until the push, then easing toward whatever the mid is holding. */
function slowLevel(t: number) {
  if (t <= T_PUSH) return 0;
  const k = 1.6;
  const up = 1 - Math.exp(-k * (Math.min(t, T_REVERT) - T_PUSH));
  if (t <= T_REVERT) return up;
  return up * Math.exp(-k * (t - T_REVERT));
}

function slowPath(upTo: number) {
  const steps = 60;
  let d = "";
  for (let i = 0; i <= steps; i++) {
    const t = (upTo * i) / steps;
    d += `${i ? "L" : "M"}${x(t).toFixed(1)} ${y(slowLevel(t)).toFixed(1)} `;
  }
  return d;
}

function Lane({ lane, progress }: { lane: (typeof LANES)[number]; progress: number }) {
  const opened = progress >= T_OPEN;
  const closed = progress >= T_CLOSE;
  const closeLevel = lane.fillsAtPush ? 1 : slowLevel(T_CLOSE);
  // The counter runs up over a short stretch after the close.
  const ramp = Math.max(0, Math.min(1, (progress - T_CLOSE) / 0.12));
  const pnl = lane.pnl * (1 - Math.pow(1 - ramp, 3));
  const bad = lane.key === "naive";

  return (
    <div className="lane">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <b>{lane.name}</b>
        <span className={`badge ${bad ? "short" : "long"}`}>{bad ? "Drained" : "Holds"}</span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${lane.name}: price path and the attacker's fills`}>
        <line x1={x(0)} x2={x(1)} y1={y(0)} y2={y(0)} stroke="var(--line-strong)" strokeDasharray="2 5" />
        <text x={x(1)} y={y(0) + 15} textAnchor="end" fill="var(--text-4)" fontSize="10" fontFamily="var(--font-mono)">
          fair price
        </text>
        <text x={x(1)} y={y(1) - 7} textAnchor="end" fill="var(--text-4)" fontSize="10" fontFamily="var(--font-mono)">
          +0.12%
        </text>
        {!lane.fillsAtPush && (
          <path d={slowPath(progress)} fill="none" stroke="var(--brass)" strokeWidth="1.5" strokeDasharray="4 4" />
        )}
        <path d={midPath(progress)} fill="none" stroke="var(--text)" strokeWidth="1.75" strokeLinejoin="round" />
        {opened && (
          <g>
            <circle cx={x(T_OPEN)} cy={y(0)} r="4.5" fill="var(--long)" />
            <text x={x(T_OPEN)} y={y(0) + 17} textAnchor="middle" fill="var(--text-3)" fontSize="10">
              opens long
            </text>
          </g>
        )}
        {closed && (
          <g>
            <circle cx={x(T_CLOSE)} cy={y(closeLevel)} r="4.5" fill={bad ? "var(--short)" : "var(--brass)"} />
            <text
              x={x(T_CLOSE) + 8}
              y={y(closeLevel) + (lane.fillsAtPush ? -9 : 16)}
              fill="var(--text-3)"
              fontSize="10"
            >
              {lane.fillsAtPush ? "closes at the pushed mid" : "closes at the slow price"}
            </text>
          </g>
        )}
      </svg>
      <div className="lane-stats">
        <div className="metric">
          <label>Size the attacker could open</label>
          <div className="v">{opened ? `$${(lane.accepted / 1e6).toFixed(1)}M` : "—"}</div>
        </div>
        <div className="metric">
          <label>Attacker profit, one leg</label>
          <div className={`v ${bad ? "short" : "long"}`}>{closed ? fmtSignedUsd(pnl, 0) : "—"}</div>
        </div>
      </div>
    </div>
  );
}

function ExploitReplay() {
  const [progress, setProgress] = useState(1);
  const raf = useRef(0);

  function play() {
    cancelAnimationFrame(raf.current);
    const start = performance.now();
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / 5200);
      setProgress(t);
      if (t < 1) raf.current = requestAnimationFrame(step);
    };
    raf.current = requestAnimationFrame(step);
  }

  useEffect(() => {
    if (!window.matchMedia("(prefers-reduced-motion: reduce)").matches) play();
    return () => cancelAnimationFrame(raf.current);
  }, []);

  return (
    <section className="card replay">
      <div className="replay-head">
        <div>
          <div className="eyebrow">Replay</div>
          <h3 style={{ marginTop: 6 }}>The reference-price attack, run against both designs</h3>
        </div>
        <button className="btn btn-ghost" onClick={play}>
          Replay
        </button>
      </div>
      <p>
        One price with no order book has one obvious weakness: push the reference price for a minute and trade against
        the push. Here an attacker spends about $52,000 moving the price by 0.12%. The sequence is the same in both
        lanes: open at the fair price, push the reference, close into the push. The white line is the mid; the dashed
        brass line is OpenLiquid's slow price.
      </p>
      <div className="lanes">
        {LANES.map((lane) => (
          <Lane key={lane.key} lane={lane} progress={progress} />
        ))}
      </div>
      <p className="note">
        Figures come from the contract test suite (<span className="mono">contracts/test/exploit.test.js</span>), not
        from this animation. Holding the push for a full minute raises OpenLiquid's figure to about $7,200, still far below
        what the move costs.
      </p>
    </section>
  );
}

export function MechanicsPage() {
  const openDoc = useStore((s) => s.openDoc);
  return (
    <main className="page">
      <div className="page-inner">
        <div>
          <h2>
            High leverage, <em>in the open.</em>
          </h2>
          <p className="lede">
            Filling any size at a single reference price is simple to use and simple to drain. OpenLiquid keeps the
            experience (one price, no order book, losses capped at your margin) and changes the rules underneath it.
          </p>
        </div>

        <ExploitReplay />

        <div className="rules">
          {RULES.map((r, i) => (
            <article className="rule" key={r.title}>
              <span className="n">{i + 1}</span>
              <h4>{r.title}</h4>
              <p>{r.body}</p>
            </article>
          ))}
        </div>

        <section className="card">
          <div className="eyebrow">Stress test</div>
          <h3 style={{ marginTop: 6 }}>Attacked by a swarm of agents before launch</h3>
          <p>
            Before launch we set a swarm of AI agents on the design: seven adversarial Monte Carlo attacks and six
            independent code reviews. They reported 58 economic findings and 51 code findings, many
            of them the same hole seen twice. The ones fixed are listed with the ones still open in the whitepaper.
          </p>
          <button className="link" onClick={() => openDoc("risks")}>
            What they found, and what is still open
          </button>
        </section>

        <section className="card">
          <h3>What we are still working on</h3>
          <p>
            Prices are signed by a single keeper in this build; a production version needs several independent signers.
            A trader can choose among the last 20 seconds of signed prices, which matters most on prediction markets,
            where one cent is a large share of a leveraged stake. No cap can make leverage safe against every kind of
            jump, so scheduled news needs the market's clock set to it, and Boost is priced for news that arrives at
            random. Liquidity providers are the other side of every trade and can lose money when traders are right.
            This is a testnet prototype, unaudited.
          </p>
          <button className="link" onClick={() => openDoc("risks")}>
            Read the full list
          </button>
        </section>
      </div>
    </main>
  );
}
