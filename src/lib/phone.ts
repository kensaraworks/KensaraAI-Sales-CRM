/** Indian-first phone and email helpers. */

/** Normalise to +91XXXXXXXXXX for Indian mobiles, +91-STD-landline for landlines, or +CC… for others. */
export function normPhone(raw: string): string {
  let s = String(raw || '').trim();
  if (!s) return '';
  const plus = s.startsWith('+');
  s = s.replace(/(ext|extn|x)\.?\s*\d+$/i, '').replace(/[^\d]/g, '');
  if (!s) return '';
  if (plus && !s.startsWith('91')) return s.length >= 8 ? `+${s}` : '';
  if (s.startsWith('0091')) s = s.slice(4);
  else if (s.length === 12 && s.startsWith('91')) s = s.slice(2);
  else if (s.length === 11 && s.startsWith('0')) s = s.slice(1);
  if (s.length === 10) return `+91${s}`;
  if (s.length > 10 && s.length <= 13 && s.startsWith('91')) return `+${s}`;
  return s.length >= 6 ? s : '';
}

/** Split a cell like "98765 43210 / 022-2345678, +91 99887 76655". */
export function splitPhones(raw: string): string[] {
  if (!raw) return [];
  const parts = String(raw).split(/[\/,;|\n]+|\s{2,}|\bor\b/i);
  const out: string[] = [];
  for (const p of parts) {
    const n = normPhone(p);
    if (n && !out.includes(n)) out.push(n);
  }
  // "9876543210 9988776655" in one cell
  if (!out.length) {
    const digits = String(raw).match(/(?:\+?91[\s-]?)?[6-9]\d{4}[\s-]?\d{5}/g) || [];
    for (const d of digits) { const n = normPhone(d); if (n && !out.includes(n)) out.push(n); }
  }
  return out;
}

export const isMobile = (p: string) => /^\+91[6-9]\d{9}$/.test(p);

export function prettyPhone(p: string): string {
  if (/^\+91\d{10}$/.test(p)) return `+91 ${p.slice(3, 8)} ${p.slice(8)}`;
  return p;
}

/** Digits for wa.me (country code, no plus). */
export const waNumber = (p: string) => {
  const n = normPhone(p).replace(/^\+/, '');
  return n.length === 10 ? `91${n}` : n;
};

export const telHref = (p: string) => `tel:${normPhone(p) || p}`;

export function waHref(p: string, text?: string) {
  return `https://wa.me/${waNumber(p)}${text ? `?text=${encodeURIComponent(text)}` : ''}`;
}

export function mailHref(to: string, subject: string, body: string) {
  return `mailto:${encodeURIComponent(to)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
export const splitEmails = (raw: string): string[] => [...new Set((String(raw || '').match(EMAIL) || []).map((e) => e.toLowerCase()))];
export const isEmail = (s: string) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s.trim());

export function normUrl(raw: string): string {
  const s = String(raw || '').trim();
  if (!s || /\s/.test(s) || !/\./.test(s)) return '';
  return /^https?:\/\//i.test(s) ? s : `https://${s}`;
}

export const domainOf = (url: string) => {
  try { return new URL(normUrl(url)).hostname.replace(/^www\./, ''); } catch { return ''; }
};
