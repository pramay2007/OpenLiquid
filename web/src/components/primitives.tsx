import { useEffect, useRef } from "react";

const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * A number that glides to each new value instead of snapping, written straight to the DOM so a
 * price ticking every second costs no React renders. `flash` washes it green or red on change.
 */
export function Num({
  value,
  format,
  flash = false,
  className = "",
}: {
  value: number | null | undefined;
  format: (n: number) => string;
  flash?: boolean;
  className?: string;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const shown = useRef<number | null>(null);
  const formatRef = useRef(format);
  formatRef.current = format;

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (value == null || !Number.isFinite(value)) {
      el.textContent = "—";
      shown.current = null;
      return;
    }
    const from = shown.current;
    if (from == null || from === value || reducedMotion()) {
      el.textContent = formatRef.current(value);
      shown.current = value;
      return;
    }
    if (flash) {
      el.classList.remove("tick-up", "tick-down");
      void el.offsetWidth; // restart the animation
      el.classList.add(value > from ? "tick-up" : "tick-down");
    }
    const start = performance.now();
    let raf = 0;
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / 340);
      const eased = 1 - Math.pow(1 - t, 3);
      shown.current = from + (value - from) * eased;
      el.textContent = formatRef.current(shown.current);
      if (t < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [value, flash]);

  return <span ref={ref} className={`num ${className}`} />;
}

export function Sparkline({ points, width = 54, height = 20 }: { points: number[]; width?: number; height?: number }) {
  if (points.length < 2) return <svg className="spark" width={width} height={height} aria-hidden />;
  const min = Math.min(...points);
  const max = Math.max(...points);
  const span = max - min || 1;
  const d = points
    .map((p, i) => {
      const x = (i / (points.length - 1)) * width;
      const y = height - 2 - ((p - min) / span) * (height - 4);
      return `${i ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`;
    })
    .join(" ");
  const up = points[points.length - 1] >= points[0];
  return (
    <svg className="spark" width={width} height={height} aria-hidden>
      <path d={d} fill="none" stroke={up ? "var(--long)" : "var(--short)"} strokeWidth="1.25" strokeLinejoin="round" strokeLinecap="round" opacity="0.9" />
    </svg>
  );
}

export function Bar({ fraction, color }: { fraction: number; color: string }) {
  const pct = Math.max(0, Math.min(1, Number.isFinite(fraction) ? fraction : 0)) * 100;
  return (
    <div className="bar">
      <i style={{ width: `${pct}%`, background: color }} />
    </div>
  );
}

export function Spinner() {
  return <span className="spinner" aria-label="Working" />;
}

export function Mark({ size = 20 }: { size?: number }) {
  // An open ring around a drop: the book is open, the liquidity is real.
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M19.4 7.2A9 9 0 1 0 21 12" stroke="var(--brass)" strokeWidth="2.4" strokeLinecap="round" />
      <path d="M12 7.2c2 2.4 3.2 4 3.2 5.7a3.2 3.2 0 0 1-6.4 0c0-1.7 1.2-3.3 3.2-5.7Z" fill="var(--brass)" />
    </svg>
  );
}
