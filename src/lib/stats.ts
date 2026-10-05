/** Analytics, targets, points and streaks — all computed from the activity log. */
import type { Account, Activity, ID, Member, Settings, StageId, TargetKey } from './types';
import { CONNECTED, DM_OUTCOMES } from './outcomes';
import { STAGES, stageIndex } from './defaults';
import { DAY, startOfDay, startOfMonth, startOfWeek, ymd } from './util';
import { isWorkDay, targetFor } from './schedule';

export interface Metrics {
  dials: number;
  connects: number;
  dm: number;
  shared: number;
  newLeads: number;
  discovery: number;
  won: number;
  lost: number;
  planned: number;
  onTime: number;
  points: number;
  touches: number;
}

const empty = (): Metrics => ({ dials: 0, connects: 0, dm: 0, shared: 0, newLeads: 0, discovery: 0, won: 0, lost: 0, planned: 0, onTime: 0, points: 0, touches: 0 });

export function add(m: Metrics, a: Activity) {
  if (a.voided || a.system) return;
  m.touches++;
  m.points += a.points || 0;
  if (a.channel === 'call' && a.outcome && a.outcome !== 'note') m.dials++;
  if (a.outcome && CONNECTED.has(a.outcome)) m.connects++;
  if (a.outcome && DM_OUTCOMES.has(a.outcome)) m.dm++;
  if (a.outcome === 'sent') m.shared++;
  if (a.stageFrom === 'new') m.newLeads++;
  if (a.outcome === 'discovery-booked' || (a.stageTo === 'discovery' && a.outcome !== 'rescheduled')) m.discovery++;
  if (a.outcome === 'won') m.won++;
  if (a.statusTo === 'lost') m.lost++;
  if (a.planned) { m.planned++; if (a.onTime) m.onTime++; }
}

export function metrics(acts: Activity[], from: Date, to: Date, who?: ID | null): Metrics {
  const m = empty();
  const f = from.toISOString(), t = to.toISOString();
  for (const a of acts) {
    if (a.at < f || a.at >= t) continue;
    if (who && a.createdBy !== who) continue;
    add(m, a);
  }
  return m;
}

export const onTimePct = (m: Metrics) => (m.planned ? Math.round((m.onTime / m.planned) * 100) : 100);

export function rangeFor(per: 'day' | 'week' | 'month', now = new Date()): [Date, Date] {
  const from = per === 'day' ? startOfDay(now) : per === 'week' ? startOfWeek(now) : startOfMonth(now);
  return [from, new Date(now.getTime() + DAY)];
}

export interface TargetProgress { key: TargetKey; label: string; value: number; target: number; per: string; pct: number }

export function targetProgress(acts: Activity[], s: Settings, team: Member[], me: ID, now = new Date()): TargetProgress[] {
  const out: TargetProgress[] = [];
  const cache = new Map<string, Metrics>();
  const get = (per: 'day' | 'week' | 'month') => {
    if (!cache.has(per)) { const [f, t] = rangeFor(per, now); cache.set(per, metrics(acts, f, t, me)); }
    return cache.get(per)!;
  };
  for (const [k, t] of Object.entries(s.targets) as [TargetKey, Settings['targets'][TargetKey]][]) {
    if (!t.on) continue;
    const m = get(t.per);
    const target = targetFor(k, s, team, me);
    const value = k === 'followupsOnTime' ? onTimePct(m) : k === 'discovery' ? m.discovery : (m as any)[k] ?? 0;
    out.push({ key: k, label: t.label, value, target, per: t.per, pct: target ? Math.min(1, value / target) : 1 });
  }
  return out;
}

/** Consecutive working days (ending today or yesterday) on which the main daily target was met. */
export function streak(acts: Activity[], s: Settings, team: Member[], me: ID, now = new Date()): number {
  const goal = s.targets.dials.on ? targetFor('dials', s, team, me) : 10;
  const byLocal = new Map<string, number>();
  for (const a of acts) {
    if (a.createdBy !== me || a.voided || a.channel !== 'call') continue;
    const k = ymd(new Date(a.at));
    byLocal.set(k, (byLocal.get(k) || 0) + 1);
  }
  let n = 0;
  let d = startOfDay(now);
  if ((byLocal.get(ymd(d)) || 0) < goal) d = new Date(d.getTime() - DAY);
  for (let i = 0; i < 365; i++) {
    if (!isWorkDay(d, s)) { d = new Date(d.getTime() - DAY); continue; }
    if ((byLocal.get(ymd(d)) || 0) >= goal) n++;
    else break;
    d = new Date(d.getTime() - DAY);
  }
  return n;
}

export function series(acts: Activity[], days: number, who?: ID | null, now = new Date()) {
  const out: { day: Date; m: Metrics }[] = [];
  const start = startOfDay(new Date(now.getTime() - (days - 1) * DAY));
  for (let i = 0; i < days; i++) out.push({ day: new Date(start.getTime() + i * DAY), m: empty() });
  const idx = new Map(out.map((o, i) => [ymd(o.day), i]));
  for (const a of acts) {
    if (who && a.createdBy !== who) continue;
    const i = idx.get(ymd(new Date(a.at)));
    if (i != null) add(out[i].m, a);
  }
  return out;
}

/** Furthest stage each account ever reached (so lost deals still count in the funnel). */
export function funnel(accounts: Account[], acts: Activity[]) {
  const max = new Map<ID, number>();
  for (const a of accounts) max.set(a.id, a.status === 'won' ? stageIndex('assessment') : stageIndex(a.stage));
  for (const x of acts) if (x.stageTo) max.set(x.accountId, Math.max(max.get(x.accountId) ?? 0, stageIndex(x.stageTo)));
  return STAGES.map((s, i) => ({ stage: s, count: [...max.values()].filter((v) => v >= i).length }));
}

export function pipeline(accounts: Account[]) {
  const m = new Map<StageId, number>(STAGES.map((s) => [s.id, 0]));
  for (const a of accounts) if (a.status === 'open' || a.status === 'parked') m.set(a.stage, (m.get(a.stage) || 0) + 1);
  return STAGES.map((s) => ({ stage: s, count: m.get(s.id) || 0 }));
}

export function lostReasons(accounts: Account[]) {
  const m = new Map<string, number>();
  for (const a of accounts) if (a.status === 'lost') m.set(a.lostReason || 'Not specified', (m.get(a.lostReason || 'Not specified') || 0) + 1);
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
}

export function leaderboard(acts: Activity[], team: Member[], from: Date, to: Date) {
  return team
    .filter((m) => m.active)
    .map((m) => ({ member: m, m: metrics(acts, from, to, m.id) }))
    .sort((a, b) => b.m.points - a.m.points);
}

export const LEVELS = [0, 150, 400, 900, 1800, 3200, 5200, 8000, 12000, 18000];
export const LEVEL_NAMES = ['Rookie', 'Dialer', 'Opener', 'Connector', 'Navigator', 'Closer', 'Rainmaker', 'Ace', 'Legend', 'Oracle'];
export function level(points: number) {
  let i = 0;
  while (i < LEVELS.length - 1 && points >= LEVELS[i + 1]) i++;
  const lo = LEVELS[i], hi = LEVELS[i + 1] ?? lo * 1.5;
  return { n: i + 1, name: LEVEL_NAMES[i], pct: Math.min(1, (points - lo) / (hi - lo)), toNext: Math.max(0, hi - points) };
}
