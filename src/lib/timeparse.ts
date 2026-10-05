/**
 * Understands how people actually say times on Indian sales calls, in English and Hinglish:
 * "kal 4 baje", "Monday after lunch", "saade 11", "next week", "after Diwali", "in 2 hours", "15 Oct 3pm".
 * Works offline; the AI parser is used on top of it when available.
 */
import type { Settings } from './types';

export interface ParsedTime { date: Date; timed: boolean; text: string }

const WD: Record<string, number> = {
  sun: 0, sunday: 0, ravivar: 0, itwar: 0, mon: 1, monday: 1, somvar: 1, tue: 2, tues: 2, tuesday: 2, mangalvar: 2,
  wed: 3, wednesday: 3, budhvar: 3, thu: 4, thur: 4, thurs: 4, thursday: 4, guruvar: 4, fri: 5, friday: 5, shukravar: 5,
  sat: 6, saturday: 6, shanivar: 6,
};
const MON: Record<string, number> = {
  jan: 0, january: 0, feb: 1, february: 1, mar: 2, march: 2, apr: 3, april: 3, may: 4, jun: 5, june: 5, jul: 6, july: 6,
  aug: 7, august: 7, sep: 8, sept: 8, september: 8, oct: 9, october: 9, nov: 10, november: 10, dec: 11, december: 11,
};
const NUM: Record<string, number> = {
  one: 1, ek: 1, two: 2, do: 2, three: 3, teen: 3, four: 4, char: 4, chaar: 4, five: 5, paanch: 5, panch: 5, six: 6, chhe: 6, che: 6,
  seven: 7, saat: 7, eight: 8, aath: 8, nine: 9, nau: 9, ten: 10, das: 10, eleven: 11, gyarah: 11, twelve: 12, barah: 12, half: 0.5, adha: 0.5, aadha: 0.5,
};

const num = (s: string) => (/^\d+(\.\d+)?$/.test(s) ? Number(s) : NUM[s] ?? NaN);

export function parseTime(input: string, now = new Date(), s?: Settings): ParsedTime | null {
  const t = ` ${input.toLowerCase().replace(/[,.!?]/g, ' ').replace(/\s+/g, ' ')} `;
  let day: Date | null = null;
  let hour: number | null = null;
  let minute = 0;
  let timed = false;
  const hits: string[] = [];
  const base = new Date(now);

  const setDay = (d: Date) => { day = new Date(d.getFullYear(), d.getMonth(), d.getDate()); };
  const plusDays = (n: number) => { const d = new Date(base); d.setDate(d.getDate() + n); return d; };

  // --- relative durations: "in 2 hours", "2 ghante baad", "after 30 min", "3 din baad", "in 2 weeks"
  const dur = t.match(/(?:in|after)?\s?(\d+|an?|one|ek|two|do|three|teen|half|adha|aadha)\s?(minutes?|mins?|hours?|hrs?|ghante?|ghanta|days?|din|weeks?|hafte?|months?|mahine?)\s?(?:baad|later|mein|me)?/);
  if (dur && (/\b(in|after|baad|later|mein|me)\b/.test(dur[0]) || /baad|later/.test(t))) {
    const n = dur[1] === 'a' || dur[1] === 'an' ? 1 : num(dur[1]);
    const u = dur[2];
    if (!Number.isNaN(n)) {
      hits.push(dur[0].trim());
      if (/^(min)/.test(u)) return { date: new Date(base.getTime() + n * 6e4), timed: true, text: hits.join(' ') };
      if (/^(hour|hr|ghant)/.test(u)) return { date: new Date(base.getTime() + n * 36e5), timed: true, text: hits.join(' ') };
      if (/^(day|din)/.test(u)) setDay(plusDays(n));
      if (/^(week|haft)/.test(u)) setDay(plusDays(n * 7));
      if (/^(month|mahin)/.test(u)) { const d = new Date(base); d.setMonth(d.getMonth() + n); setDay(d); }
    }
  }

  // --- named days
  if (!day) {
    if (/\b(day after tomorrow|parso|parson)\b/.test(t)) { setDay(plusDays(2)); hits.push('day after tomorrow'); }
    else if (/\b(tomorrow|tmrw|tmr|kal|kl)\b/.test(t)) { setDay(plusDays(1)); hits.push('tomorrow'); }
    else if (/\b(today|aaj|aj|tonight|later today|abhi)\b/.test(t)) { setDay(base); hits.push('today'); }
    else if (/\bnext week|agle hafte|agle week\b/.test(t)) { const d = plusDays(((8 - base.getDay()) % 7) || 7); setDay(d); hits.push('next week'); }
    else if (/\bnext month|agle mahine\b/.test(t)) { const d = new Date(base.getFullYear(), base.getMonth() + 1, 1); setDay(d); hits.push('next month'); }
    else if (/\b(end of (the )?month|month end)\b/.test(t)) { const d = new Date(base.getFullYear(), base.getMonth() + 1, 0); setDay(d); hits.push('month end'); }
    else if (/\b(new financial year|after march|april)\b/.test(t) && !/\d/.test(t)) { const y = base.getMonth() >= 3 ? base.getFullYear() + 1 : base.getFullYear(); setDay(new Date(y, 3, 5)); hits.push('new FY'); }
  }
  if (!day) {
    const w = t.match(/\b(next |agle |this |is )?(sun|sunday|mon|monday|tue|tues|tuesday|wed|wednesday|thu|thur|thurs|thursday|fri|friday|sat|saturday|somvar|mangalvar|budhvar|guruvar|shukravar|shanivar|ravivar|itwar)\b/);
    if (w) {
      const target = WD[w[2]];
      let diff = (target - base.getDay() + 7) % 7;
      if (diff === 0) diff = 7;
      if (w[1] && /next|agle/.test(w[1]) && diff < 7 && base.getDay() !== 0 && target > base.getDay()) diff += 7;
      setDay(plusDays(diff));
      hits.push(w[0].trim());
    }
  }
  if (!day) {
    // "15 oct", "oct 15", "15th october", "15/10", "15-10-2026"
    const a = t.match(/\b(\d{1,2})(?:st|nd|rd|th)?\s(jan|january|feb|february|mar|march|apr|april|may|jun|june|jul|july|aug|august|sep|sept|september|oct|october|nov|november|dec|december)\b/);
    const b = t.match(/\b(jan|january|feb|february|mar|march|apr|april|may|jun|june|jul|july|aug|august|sep|sept|september|oct|october|nov|november|dec|december)\s(\d{1,2})(?:st|nd|rd|th)?\b/);
    const c = t.match(/\b(\d{1,2})[\/-](\d{1,2})(?:[\/-](\d{2,4}))?\b/);
    let d: Date | null = null;
    if (a) d = new Date(base.getFullYear(), MON[a[2]], Number(a[1]));
    else if (b) d = new Date(base.getFullYear(), MON[b[1]], Number(b[2]));
    else if (c && Number(c[2]) <= 12) d = new Date(c[3] ? Number(c[3].length === 2 ? `20${c[3]}` : c[3]) : base.getFullYear(), Number(c[2]) - 1, Number(c[1]));
    if (d) {
      if (d.getTime() < base.getTime() - 864e5) d.setFullYear(d.getFullYear() + 1);
      setDay(d);
      hits.push((a || b || c)![0]);
    }
  }
  // "after diwali" / "post holi" — uses the holiday calendar in settings
  if (!day && s) {
    const m1 = t.match(/\b(?:after|post)\s(\w+)/);
    const m2 = t.match(/(\w+)\s(?:ke baad|ke bad)\b/);
    const name = (m1 && m1[1]) || (m2 && m2[1]);
    const h = name && s.holidays.find((x) => x.name.toLowerCase().includes(name) && new Date(x.date) >= startOfToday(base));
    if (h) {
      const d = new Date(h.date);
      d.setDate(d.getDate() + 2);
      setDay(d);
      hits.push(`after ${h.name}`);
    }
  }

  // --- clock time
  const hm = t.match(/\b(\d{1,2})[:.](\d{2})\s?(am|pm|a m|p m)?\b/);
  const hap = t.match(/\b(\d{1,2})\s?(am|pm|a m|p m|baje|bje|o'?clock|oclock)\b/);
  const atN = t.match(/\b(?:at|around|by|@)\s(\d{1,2})\b(?![\/-])/);
  const saade = t.match(/\b(saade|sade|sawa|sava|paune|pone)\s(\d{1,2}|\w+)\b/);
  const fixHour = (h: number, ap?: string) => {
    if (ap) { const pm = ap.startsWith('p'); return pm ? (h % 12) + 12 : h % 12; }
    return h <= 7 ? h + 12 : h; // "at 4" on a sales call means 4 PM
  };
  if (saade) {
    const h = num(saade[2]);
    if (!Number.isNaN(h)) {
      const w = saade[1];
      if (/^s(aa|a)de/.test(w)) { hour = fixHour(h); minute = 30; }
      else if (/^saw|^sav/.test(w)) { hour = fixHour(h); minute = 15; }
      else { hour = fixHour(h - 1); minute = 45; }
      timed = true;
      hits.push(saade[0]);
    }
  } else if (hm) {
    hour = fixHour(Number(hm[1]), hm[3]?.replace(' ', '')); minute = Number(hm[2]); timed = true; hits.push(hm[0].trim());
  } else if (hap) {
    hour = fixHour(Number(hap[1]), /am|pm|a m|p m/.test(hap[2]) ? hap[2].replace(' ', '') : undefined); timed = true; hits.push(hap[0].trim());
  } else if (atN) {
    hour = fixHour(Number(atN[1])); timed = true; hits.push(atN[0].trim());
  }

  // --- parts of the day
  if (hour == null) {
    const parts: [RegExp, number, number][] = [
      [/\b(early morning|subah subah)\b/, 10, 0],
      [/\b(morning|subah|first half)\b/, 11, 0],
      [/\b(before lunch)\b/, 12, 0],
      [/\b(noon|dopahar|dopehar|afternoon|after lunch|lunch ke baad|second half)\b/, 15, 0],
      [/\b(evening|shaam|sham|eod|end of day|before leaving)\b/, 17, 0],
      [/\b(night|raat|tonight)\b/, 18, 0],
    ];
    for (const [re, h, m] of parts) if (re.test(t)) { hour = h; minute = m; hits.push(t.match(re)![0]); break; }
  }

  if (!day && hour == null) return null;
  const d = day ? new Date(day) : new Date(base);
  if (hour != null) d.setHours(hour, minute, 0, 0);
  else { d.setHours(11, 0, 0, 0); }
  // A time with no day that has already passed today means tomorrow.
  if (!day && d.getTime() < base.getTime() - 5 * 6e4) d.setDate(d.getDate() + 1);
  return { date: d, timed: timed && hour != null, text: hits.join(' ') };
}

const startOfToday = (d: Date) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };
