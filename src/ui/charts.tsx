/** Small hand-rolled SVG charts (no chart library): stacked columns, horizontal bars, heatmap. Every mark has a hover tooltip. */
import { useState } from 'preact/hooks';
import type { ComponentChildren } from 'preact';

interface Tip { x: number; y: number; html: ComponentChildren }

function useTip() {
  const [tip, setTip] = useState<Tip | null>(null);
  const show = (e: MouseEvent, html: ComponentChildren) => setTip({ x: e.clientX, y: e.clientY, html });
  const el = tip ? <div class="tip" style={{ left: `${Math.min(tip.x + 12, innerWidth - 200)}px`, top: `${tip.y - 40}px` }}>{tip.html}</div> : null;
  return { show, hide: () => setTip(null), el };
}

const nice = (max: number) => {
  if (max <= 5) return 5;
  const p = 10 ** Math.floor(Math.log10(max));
  const m = max / p;
  return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10) * p;
};

/** Stacked columns, two series (bottom = a, top = b). */
export function StackCols({ data, a, b, height = 180 }: {
  data: { label: string; sub?: string; a: number; b: number }[];
  a: { name: string; color: string };
  b: { name: string; color: string };
  height?: number;
}) {
  const t = useTip();
  const W = 960, H = height, pl = 30, pb = 22, pt = 8;
  const max = nice(Math.max(1, ...data.map((d) => d.a + d.b)));
  const band = (W - pl) / Math.max(1, data.length);
  const bw = Math.min(24, band * 0.62);
  const y = (v: number) => pt + (H - pt - pb) * (1 - v / max);
  const ticks = [0, max / 2, max];
  const every = Math.ceil(data.length / 10);
  return (
    <div class="chart">
      <div class="legend"><span><i style={{ background: a.color }} />{a.name}</span><span><i style={{ background: b.color }} />{b.name}</span></div>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${a.name} and ${b.name} per day`}>
        {ticks.map((v) => <g><line x1={pl} x2={W} y1={y(v)} y2={y(v)} stroke="var(--grid)" /><text x={pl - 6} y={y(v) + 4} text-anchor="end">{Math.round(v)}</text></g>)}
        {data.map((d, i) => {
          const x = pl + i * band + (band - bw) / 2;
          const ya = y(d.a), yb = y(d.a + d.b);
          const gap = d.a && d.b ? 2 : 0;
          return (
            <g onMouseMove={(e) => t.show(e as any, <><b>{d.label}</b> · {d.a} {a.name.toLowerCase()} · {d.b} {b.name.toLowerCase()}</>)} onMouseLeave={t.hide}>
              <rect x={pl + i * band} y={pt} width={band} height={H - pt - pb} fill="transparent" />
              {d.a > 0 && <path d={colPath(x, ya, bw, y(0) - ya, !d.b)} fill={a.color} />}
              {d.b > 0 && <path d={colPath(x, yb, bw, ya - yb - gap, true)} fill={b.color} />}
              {i % every === 0 && <text x={x + bw / 2} y={H - 6} text-anchor="middle">{d.sub ?? d.label}</text>}
            </g>
          );
        })}
      </svg>
      {t.el}
    </div>
  );
}

/** Column with a 4px rounded top (data end) and a square base. */
function colPath(x: number, y: number, w: number, h: number, round: boolean) {
  if (h <= 0) return '';
  const r = round ? Math.min(4, w / 2, h) : 0;
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
}

/** Horizontal bars with value at the tip; optional secondary note (e.g. conversion %). */
export function HBars({ rows, color = 'var(--series-1)', fmt = (v: number) => String(v) }: {
  rows: { label: string; value: number; note?: string; color?: string; title?: string }[];
  color?: string;
  fmt?: (v: number) => string;
}) {
  const t = useTip();
  const max = Math.max(1, ...rows.map((r) => r.value));
  if (!rows.length) return <p class="small muted">No data yet</p>;
  return (
    <div class="hbar">
      {rows.map((r) => (
        <>
          <span class="hbar__l" title={r.label}>{r.label}</span>
          <span class="hbar__track" onMouseMove={(e) => t.show(e as any, r.title || `${r.label}: ${fmt(r.value)}${r.note ? ` · ${r.note}` : ''}`)} onMouseLeave={t.hide}>
            <span class="hbar__bar" style={{ width: `${(r.value / max) * 82}%`, background: r.color || color }} />
            <span class="hbar__v">{fmt(r.value)}{r.note && <small>{r.note}</small>}</span>
          </span>
        </>
      ))}
      {t.el}
    </div>
  );
}

/** Weekday × hour grid, sequential blue by value (0..1). */
export function Heatmap({ rows, cols, value, label }: { rows: string[]; cols: string[]; value: (r: number, c: number) => { v: number; n: number }; label: (r: number, c: number, v: number, n: number) => string }) {
  const t = useTip();
  const steps = ['var(--seq-0)', 'var(--seq-1)', 'var(--seq-2)', 'var(--seq-3)', 'var(--seq-4)', 'var(--seq-5)'];
  const cells: { v: number; n: number }[][] = rows.map((_, r) => cols.map((__, c) => value(r, c)));
  const max = Math.max(0.01, ...cells.flat().filter((x) => x.n > 0).map((x) => x.v));
  return (
    <div>
      <div class="heatmap" style={{ gridTemplateColumns: `34px repeat(${cols.length}, 1fr)` }}>
        <span />
        {cols.map((c) => <span class="tiny muted" style={{ textAlign: 'center' }}>{c}</span>)}
        {rows.map((r, ri) => (
          <>
            <span class="tiny muted" style={{ alignSelf: 'center' }}>{r}</span>
            {cols.map((_, ci) => {
              const { v, n } = cells[ri][ci];
              const step = n === 0 ? 0 : 1 + Math.min(4, Math.floor((v / max) * 4.999));
              return <span class="cell" style={{ background: steps[step] }} onMouseMove={(e) => t.show(e as any, label(ri, ci, v, n))} onMouseLeave={t.hide} />;
            })}
          </>
        ))}
      </div>
      <div class="row tiny muted" style={{ marginTop: '8px', gap: '4px' }}>
        <span>Fewer pick-ups</span>{steps.slice(1).map((s) => <span style={{ width: '18px', height: '8px', borderRadius: '2px', background: s }} />)}<span>More</span>
      </div>
      {t.el}
    </div>
  );
}
