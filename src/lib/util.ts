import type { ID } from './types';

export const rand = (bytes = 8) => {
  const b = new Uint8Array(bytes);
  crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
};

/** Record ids carry their kind; activity ids also carry YYMM so the server knows the shard. */
export const newId = (kind: 'account' | 'contact' | 'activity', at = new Date()): ID => {
  if (kind === 'account') return `c${rand(6)}`;
  if (kind === 'contact') return `p${rand(6)}`;
  const yymm = `${String(at.getFullYear()).slice(2)}${String(at.getMonth() + 1).padStart(2, '0')}`;
  return `e${yymm}${rand(6)}`;
};

export const nowISO = () => new Date().toISOString();

export const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

export const DAY = 864e5;
export const HOUR = 36e5;
export const MIN = 6e4;

export const startOfDay = (d = new Date()) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };
export const endOfDay = (d = new Date()) => { const x = new Date(d); x.setHours(23, 59, 59, 999); return x; };
export const startOfWeek = (d = new Date()) => { const x = startOfDay(d); const wd = (x.getDay() + 6) % 7; x.setDate(x.getDate() - wd); return x; };
export const startOfMonth = (d = new Date()) => { const x = startOfDay(d); x.setDate(1); return x; };
export const sameDay = (a: Date, b: Date) => a.toDateString() === b.toDateString();
export const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

const timeFmt = new Intl.DateTimeFormat('en-IN', { hour: 'numeric', minute: '2-digit', hour12: true });
const dayFmt = new Intl.DateTimeFormat('en-IN', { weekday: 'short', day: 'numeric', month: 'short' });
const dateFmt = new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });

export const fmtTime = (d: Date | string) => timeFmt.format(new Date(d)).replace(' ', ' ').toUpperCase();
export const fmtDay = (d: Date | string) => dayFmt.format(new Date(d));
export const fmtDate = (d: Date | string) => dateFmt.format(new Date(d));

/** "Today 4:30 PM", "Tomorrow 11 AM", "Thu 3 PM", "12 Oct". */
export function fmtWhen(iso: string | Date, withTime = true): string {
  const d = new Date(iso);
  const now = new Date();
  const t = withTime ? ` ${fmtTime(d)}` : '';
  if (sameDay(d, now)) return `Today${t}`;
  const tm = new Date(now); tm.setDate(tm.getDate() + 1);
  if (sameDay(d, tm)) return `Tomorrow${t}`;
  const ys = new Date(now); ys.setDate(ys.getDate() - 1);
  if (sameDay(d, ys)) return `Yesterday${t}`;
  const diff = (d.getTime() - now.getTime()) / DAY;
  if (diff > 0 && diff < 6) return `${d.toLocaleDateString('en-IN', { weekday: 'short' })}${t}`;
  return `${d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}${t}`;
}

/** "in 2h", "5m ago", "3d ago". */
export function rel(iso: string | Date): string {
  const ms = new Date(iso).getTime() - Date.now();
  const a = Math.abs(ms);
  const s = a < HOUR ? `${Math.max(1, Math.round(a / MIN))}m` : a < DAY ? `${Math.round(a / HOUR)}h` : `${Math.round(a / DAY)}d`;
  return ms >= 0 ? `in ${s}` : `${s} ago`;
}

export const initials = (name: string) =>
  name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join('') || '?';

export const hashNum = (s: string) => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
};

const PALETTE = ['#5b5bd6', '#0d9488', '#d9480f', '#c2255c', '#2f9e44', '#1971c2', '#9c36b5', '#e67700'];
export const colorFor = (id: string) => PALETTE[hashNum(id) % PALETTE.length];

export const norm = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/** Company-name key for duplicate detection: drops legal suffixes and punctuation. */
export const companyKey = (s: string) =>
  norm(s)
    .replace(/\b(private|pvt|limited|ltd|llp|inc|corp|corporation|co|company|india|the|and|technologies|technology|tech|solutions|services|group|enterprises?)\b/g, ' ')
    .replace(/\s+/g, '')
    .trim();

export const uniq = <T,>(a: T[]) => [...new Set(a)];

export const plural = (n: number, w: string, p = `${w}s`) => `${n} ${n === 1 ? w : p}`;

export const debounce = <A extends any[]>(fn: (...a: A) => void, ms: number) => {
  let t: ReturnType<typeof setTimeout> | undefined;
  return (...a: A) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
};

export const parseHM = (s: string) => { const [h, m] = s.split(':').map(Number); return h * 60 + (m || 0); };

export const toLocalInput = (d: Date) => {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
};
