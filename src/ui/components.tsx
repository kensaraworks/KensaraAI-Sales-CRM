import type { ComponentChildren, JSX } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { colorFor, initials } from '../lib/util';
import { getLang, setLang, speechSupported, useDictation, type SpeechLang } from '../lib/speech';
import { stageLabel } from '../lib/defaults';
import type { StageId } from '../lib/types';
import { store } from '../lib/store';
import { dismissToast, toast, ui, useUI } from './bus';

/* ------------------------------------------------------------------ icons */

const P: Record<string, JSX.Element> = {
  today: <><circle cx="12" cy="12" r="8.5" /><path d="M12 7.5V12l3 2" /></>,
  pipeline: <><rect x="3.5" y="4" width="4.5" height="16" rx="1.5" /><rect x="9.75" y="4" width="4.5" height="11" rx="1.5" /><rect x="16" y="4" width="4.5" height="7" rx="1.5" /></>,
  leads: <><path d="M4 6h16M4 12h16M4 18h10" /></>,
  insights: <><path d="M4 20V10M10 20V4M16 20v-7M22 20H2" /></>,
  import: <><path d="M12 3v12m0 0-4-4m4 4 4-4M4 17v2a2 2 0 002 2h12a2 2 0 002-2v-2" /></>,
  control: <><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.7 1.7 0 00-1.8-.3 1.7 1.7 0 00-1 1.5V21a2 2 0 11-4 0v-.1a1.7 1.7 0 00-1.1-1.5 1.7 1.7 0 00-1.8.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.7 1.7 0 00.3-1.8 1.7 1.7 0 00-1.5-1H3a2 2 0 110-4h.1a1.7 1.7 0 001.5-1.1 1.7 1.7 0 00-.3-1.8l-.1-.1a2 2 0 112.8-2.8l.1.1a1.7 1.7 0 001.8.3H9a1.7 1.7 0 001-1.5V3a2 2 0 114 0v.1a1.7 1.7 0 001 1.5 1.7 1.7 0 001.8-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.7 1.7 0 00-.3 1.8V9a1.7 1.7 0 001.5 1H21a2 2 0 110 4h-.1a1.7 1.7 0 00-1.5 1z" /></>,
  phone: <path d="M5 4h3l1.5 4.5-2 1.2a11 11 0 006 6l1.2-2L19 15v3a2 2 0 01-2 2A15 15 0 013 6a2 2 0 012-2z" />,
  whatsapp: <><path d="M4 20l1.3-3.9A8 8 0 1112 20a8 8 0 01-4.2-1.2z" /><path d="M9 9.5c0 3 2.5 5.5 5.5 5.5l1-1.5-2-1-1 .8a4 4 0 01-1.8-1.8l.8-1-1-2z" /></>,
  mail: <><rect x="3" y="5" width="18" height="14" rx="2" /><path d="m4 7 8 6 8-6" /></>,
  mic: <><rect x="9" y="3" width="6" height="12" rx="3" /><path d="M5.5 11a6.5 6.5 0 0013 0M12 17.5V21" /></>,
  plus: <path d="M12 5v14M5 12h14" />,
  search: <><circle cx="11" cy="11" r="6.5" /><path d="m20 20-4.2-4.2" /></>,
  undo: <path d="M9 14 4 9l5-5M4 9h10.5a5.5 5.5 0 010 11H11" />,
  x: <path d="M6 6l12 12M18 6 6 18" />,
  check: <path d="m5 12.5 4.5 4.5L19 7.5" />,
  chevron: <path d="m9 6 6 6-6 6" />,
  down: <path d="m6 9 6 6 6-6" />,
  sparkle: <path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M18 6l-2.5 2.5M8.5 15.5 6 18" />,
  clock: <><circle cx="12" cy="12" r="8.5" /><path d="M12 7.5V12l3 2" /></>,
  user: <><circle cx="12" cy="8" r="4" /><path d="M4 21a8 8 0 0116 0" /></>,
  fire: <path d="M12 21c4 0 7-2.7 7-6.5 0-3-2-5.2-3.5-6.5.2 2-1 3.2-2 3.5.5-3-1.5-6-4.5-8 .3 3-1.2 4.6-2.6 6.2C5.3 11.1 5 12.7 5 14.5 5 18.3 8 21 12 21z" />,
  more: <><circle cx="5" cy="12" r="1.3" /><circle cx="12" cy="12" r="1.3" /><circle cx="19" cy="12" r="1.3" /></>,
  trash: <path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13" />,
  logout: <path d="M15 4h3a2 2 0 012 2v12a2 2 0 01-2 2h-3M10 17l-5-5 5-5M5 12h11" />,
  sun: <><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></>,
  moon: <path d="M20 14.5A8 8 0 019.5 4 8 8 0 1020 14.5z" />,
  play: <path d="M7 4.5v15l12-7.5z" />,
  skip: <path d="M6 5l9 7-9 7zM18 5v14" />,
  arrow: <path d="M5 12h14m-5-5 5 5-5 5" />,
  copy: <><rect x="8" y="8" width="12" height="12" rx="2" /><path d="M16 8V6a2 2 0 00-2-2H6a2 2 0 00-2 2v8a2 2 0 002 2h2" /></>,
  globe: <><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3a14 14 0 010 18M12 3a14 14 0 000 18" /></>,
  edit: <path d="M4 20h4L19 9l-4-4L4 16zM14 6l4 4" />,
  history: <><path d="M3 12a9 9 0 103-6.7L3 8" /><path d="M3 3v5h5M12 8v4l3 2" /></>,
  bolt: <path d="M13 3 5 13h6l-1 8 8-10h-6z" />,
  link: <path d="M10 14a4 4 0 005.7 0l3-3a4 4 0 00-5.7-5.7l-1 1M14 10a4 4 0 00-5.7 0l-3 3a4 4 0 005.7 5.7l1-1" />,
};

export function Icon({ n, size }: { n: string; size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size ?? 18} height={size ?? 18} fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      {P[n] ?? null}
    </svg>
  );
}

/* ------------------------------------------------------------------ bits */

export const Avatar = ({ id, name, size }: { id: string; name: string; size?: 'sm' | 'lg' }) => (
  <span class={`avatar ${size ? `avatar--${size}` : ''}`} style={{ background: store.member(id)?.color || colorFor(id) }} title={name}>{initials(name)}</span>
);

export const Stage = ({ s }: { s: StageId }) => <span class="stage" data-s={s}>{stageLabel(s)}</span>;

export const Heat = ({ v }: { v: number }) => (
  <span class="heat" title={`Warmth ${v}`}>{[0, 1, 2].map((i) => <i class={v > i ? 'on' : ''} />)}</span>
);

export function Toggle({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label?: string }) {
  return (
    <label class="toggle" title={label}>
      <input type="checkbox" checked={on} onChange={(e) => onChange((e.target as HTMLInputElement).checked)} aria-label={label} />
      <i />
    </label>
  );
}

export function Seg<T extends string>({ value, options, onChange }: { value: T; options: [T, string][]; onChange: (v: T) => void }) {
  return (
    <div class="seg" role="tablist">
      {options.map(([v, l]) => <button type="button" class={v === value ? 'is-on' : ''} onClick={() => onChange(v)}>{l}</button>)}
    </div>
  );
}

export function Ring({ pct, size = 44 }: { pct: number; size?: number }) {
  const r = (size - 6) / 2, c = 2 * Math.PI * r;
  return (
    <svg class="ring" width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
      <circle class="bg" cx={size / 2} cy={size / 2} r={r} />
      <circle class="fg" cx={size / 2} cy={size / 2} r={r} stroke-dasharray={c} stroke-dashoffset={c * (1 - Math.max(0.001, pct))} />
    </svg>
  );
}

export function Sheet({ title, onClose, children, foot, wide }: { title: ComponentChildren; onClose: () => void; children: ComponentChildren; foot?: ComponentChildren; wide?: boolean }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    window.addEventListener('keydown', k, true);
    return () => window.removeEventListener('keydown', k, true);
  }, [onClose]);
  return (
    <>
      <div class="overlay" style={{ zIndex: 69 }} onClick={onClose} />
      <div class={`sheet ${wide ? 'sheet--wide' : ''}`} role="dialog" aria-modal="true">
        <div class="sheet__head">
          <h2 class="grow">{title}</h2>
          <button class="btn btn--ghost btn--icon btn--sm" onClick={onClose} aria-label="Close"><Icon n="x" /></button>
        </div>
        <div class="sheet__body">{children}</div>
        {foot && <div class="sheet__foot">{foot}</div>}
      </div>
    </>
  );
}

/** Mic button that dictates into a text value (English-India or Hindi). */
export function Mic({ onText, small, onLive }: { onText: (t: string) => void; small?: boolean; onLive?: (on: boolean) => void }) {
  const d = useDictation(onText);
  useEffect(() => { onLive?.(d.on); }, [d.on]);
  useEffect(() => { if (d.error) toast(d.error); }, [d.error]);
  if (!speechSupported) return null;
  return (
    <button type="button" class={`mic ${small ? 'mic--sm' : ''} ${d.on ? 'is-on' : ''}`} onClick={d.toggle} aria-label={d.on ? 'Stop voice typing' : 'Voice typing'} title={d.on ? 'Stop' : 'Speak'}>
      <Icon n={d.on ? 'check' : 'mic'} />
    </button>
  );
}

/** Big voice capture block: speak naturally, see the words, then act on them. */
export function VoiceCapture({ onFinal, placeholder, autoStart }: { onFinal: (full: string) => void; placeholder?: string; autoStart?: boolean }) {
  const [text, setText] = useState('');
  const [lang, setL] = useState<SpeechLang>(getLang());
  const acc = useRef('');
  const d = useDictation((t) => { acc.current = `${acc.current} ${t}`.trim(); setText(acc.current); });
  const wasOn = useRef(false);
  useEffect(() => { if (autoStart && speechSupported) d.start(); }, []);
  useEffect(() => {
    if (wasOn.current && !d.on && acc.current) onFinal(acc.current);
    wasOn.current = d.on;
  }, [d.on]);
  if (!speechSupported) return null;
  return (
    <div class={`voice ${d.on ? 'is-on' : ''}`}>
      <button type="button" class={`mic ${d.on ? 'is-on' : ''}`} onClick={() => { if (!d.on) { acc.current = ''; setText(''); } d.toggle(); }} aria-label="Speak">
        <Icon n={d.on ? 'check' : 'mic'} />
      </button>
      <div class="grow">
        {d.on || text ? (
          <div class="small">{text}<span class="voice__live"> {d.interim}</span>{d.on && !text && !d.interim && <span class="muted">Listening…</span>}</div>
        ) : (
          <div class="small"><b>{placeholder || 'Tell me what happened'}</b><div class="muted tiny">e.g. "Spoke to reception, they said call Mr. Rao, CFO, on 98201 23456 tomorrow at 11"</div></div>
        )}
      </div>
      <button type="button" class="chip chip--line" title="Speech language" onClick={() => { const n = lang === 'en-IN' ? 'hi-IN' : 'en-IN'; setLang(n); setL(n); }}>
        {lang === 'en-IN' ? 'EN' : 'हि'}
      </button>
    </div>
  );
}

/** Textarea with a dictation button inside. */
export function NoteField({ value, onInput, placeholder, rows = 3 }: { value: string; onInput: (v: string) => void; placeholder?: string; rows?: number }) {
  return (
    <div class="ta-wrap">
      <textarea class="textarea" rows={rows} placeholder={placeholder} value={value} onInput={(e) => onInput((e.target as HTMLTextAreaElement).value)} />
      <Mic small onText={(t) => onInput(`${value ? `${value.trimEnd()} ` : ''}${t}`)} />
    </div>
  );
}

/* ------------------------------------------------------------------ toasts + confetti */

export function Toasts() {
  const u = useUI();
  return (
    <div class="toasts" aria-live="polite">
      {u.toasts.map((t) => (
        <div class="toast" key={t.id}>
          {t.points ? <span class="toast__pts">+{t.points}</span> : null}
          <span>{t.text}</span>
          {t.undo && (
            <button onClick={() => { const l = store.undo(); dismissToast(t.id); if (l) toast(`Undone: ${l}`); }}>Undo</button>
          )}
        </div>
      ))}
    </div>
  );
}

export function Confetti() {
  const u = useUI();
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (!u.celebrate || !store.settings.fun.confetti) return;
    const c = ref.current;
    if (!c || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const g = c.getContext('2d')!;
    const dpr = devicePixelRatio || 1;
    c.width = innerWidth * dpr; c.height = innerHeight * dpr;
    g.scale(dpr, dpr);
    const colors = ['#5b5bd6', '#22c55e', '#f59e0b', '#ec4899', '#06b6d4', '#e8590c'];
    const n = ui.celebrateBig ? 180 : 60;
    const ps = Array.from({ length: n }, () => ({
      x: innerWidth / 2 + (Math.random() - 0.5) * (ui.celebrateBig ? innerWidth * 0.6 : 200), y: innerHeight * (ui.celebrateBig ? 0.35 : 0.7),
      vx: (Math.random() - 0.5) * (ui.celebrateBig ? 14 : 9), vy: -Math.random() * (ui.celebrateBig ? 16 : 11) - 4,
      r: Math.random() * 6 + 3, c: colors[Math.floor(Math.random() * colors.length)], a: Math.random() * Math.PI, va: (Math.random() - 0.5) * 0.3,
    }));
    let raf = 0, t = 0;
    const loop = () => {
      g.clearRect(0, 0, innerWidth, innerHeight);
      t++;
      for (const p of ps) {
        p.vy += 0.35; p.vx *= 0.99; p.x += p.vx; p.y += p.vy; p.a += p.va;
        g.save(); g.translate(p.x, p.y); g.rotate(p.a); g.fillStyle = p.c; g.globalAlpha = Math.max(0, 1 - t / 140);
        g.fillRect(-p.r / 2, -p.r / 4, p.r, p.r / 2); g.restore();
      }
      if (t < 140) raf = requestAnimationFrame(loop); else g.clearRect(0, 0, innerWidth, innerHeight);
    };
    loop();
    return () => cancelAnimationFrame(raf);
  }, [u.celebrate]);
  return <canvas ref={ref} class="confetti" />;
}

export function Spinner() { return <span class="spin" />; }

export function copy(text: string) {
  navigator.clipboard?.writeText(text).then(() => toast('Copied'), () => toast('Copy failed'));
}
