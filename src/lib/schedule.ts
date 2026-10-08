/**
 * Scheduling brain: working hours, a "when do people pick up" model learned from every past call,
 * and the prioritised daily queue for each team member.
 */
import type { Account, Activity, Contact, ID, Member, Settings, StageId } from './types';
import { DAY, HOUR, MIN, clamp, fmtTime, hashNum, parseHM, rel, startOfDay, ymd } from './util';
import { CONNECTED, OUTCOMES } from './outcomes';

/* ------------------------------------------------------------------ working time */

export function isWorkDay(d: Date, s: Settings) {
  return s.workDays.includes(d.getDay()) && !s.holidays.some((h) => h.date === ymd(d));
}

const minutesOf = (d: Date) => d.getHours() * 60 + d.getMinutes();
const at = (d: Date, mins: number) => { const x = new Date(d); x.setHours(Math.floor(mins / 60), mins % 60, 0, 0); return x; };

/** Move a moment into working hours (skipping lunch, evenings, weekends and holidays). */
export function clampToWork(d: Date, s: Settings): Date {
  let x = new Date(d);
  const start = parseHM(s.workStart), end = parseHM(s.workEnd);
  for (let i = 0; i < 30; i++) {
    if (!isWorkDay(x, s)) { x = at(new Date(x.getTime() + DAY), start); continue; }
    const m = minutesOf(x);
    if (m < start) return at(x, start);
    if (m >= end - 15) { x = at(new Date(x.getTime() + DAY), start); continue; }
    if (s.lunch) {
      const [l1, l2] = s.lunch.map(parseHM);
      if (m >= l1 && m < l2) return at(x, l2);
    }
    return x;
  }
  return x;
}

export function addWorkDays(d: Date, n: number, s: Settings): Date {
  let x = new Date(d);
  let left = n;
  for (let guard = 0; left > 0 && guard < 400; guard++) {
    x = new Date(x.getTime() + DAY);
    if (isWorkDay(x, s)) left--;
  }
  return x;
}

/* ------------------------------------------------------------------ pick-up model */

export interface TimeModel {
  /** Smoothed connect rate per [weekday][hour]. */
  rate: number[][];
  base: number;
  calls: number;
  /** Hours at which each account has picked up before. */
  acct: Map<ID, number[]>;
}

const CALL_OUTCOMES = new Set(OUTCOMES.filter((o) => (o.channel ?? 'call') === 'call').map((o) => o.id));

export function buildTimeModel(acts: Activity[]): TimeModel {
  const tries = Array.from({ length: 7 }, () => new Array(24).fill(0));
  const hits = Array.from({ length: 7 }, () => new Array(24).fill(0));
  const acct = new Map<ID, number[]>();
  let T = 0, H = 0;
  for (const a of acts) {
    if (a.voided || a.channel !== 'call' || !a.outcome || !CALL_OUTCOMES.has(a.outcome)) continue;
    const d = new Date(a.at);
    const wd = d.getDay(), h = d.getHours();
    tries[wd][h]++; T++;
    if (CONNECTED.has(a.outcome)) {
      hits[wd][h]++; H++;
      const l = acct.get(a.accountId) || [];
      l.push(h);
      acct.set(a.accountId, l);
    }
  }
  const base = T >= 20 ? H / T : 0.35;
  const k = 4;
  // Prior: mornings 11–12:30 and late afternoons tend to be better for Indian B2B calls.
  const prior = (h: number) => base * (h === 11 || h === 12 || h === 16 || h === 17 ? 1.15 : h === 13 || h === 10 ? 0.9 : 1);
  const rate = tries.map((row, wd) => row.map((t, h) => (hits[wd][h] + prior(h) * k) / (t + k)));
  return { rate, base, calls: T, acct };
}

/** Load: how many follow-ups an assignee already has per hour bucket (to spread the day). */
export type Load = Map<string, number>;
export const loadKey = (who: ID | null, d: Date) => `${who || '*'}|${ymd(d)}|${d.getHours()}`;

/**
 * Best moment at or after `from` to reach someone: high pick-up rate, sooner rather than later,
 * avoiding hours the assignee is already stacked in, and leaning towards hours this account picked up before.
 */
export function bestSlot(
  from: Date,
  s: Settings,
  m: TimeModel,
  opt: { accountId?: ID; horizonDays?: number; load?: Load; who?: ID | null; avoidHour?: number } = {},
): Date {
  const first = clampToWork(from, s);
  const horizon = opt.horizonDays ?? 2;
  const end = parseHM(s.workEnd);
  const affinity = opt.accountId ? m.acct.get(opt.accountId) : undefined;
  let best = first, bestScore = -1;
  let cur = new Date(first);
  const dayZero = startOfDay(first).getTime();
  for (let i = 0; i < (horizon + 1) * 24 && cur.getTime() < first.getTime() + (horizon + 4) * DAY; i++) {
    cur = clampToWork(cur, s);
    const dayIdx = Math.round((startOfDay(cur).getTime() - dayZero) / DAY);
    if (dayIdx > horizon) break;
    const h = cur.getHours();
    let sc = m.rate[cur.getDay()][h] * Math.pow(0.82, dayIdx);
    if (affinity?.length) sc *= 1 + 0.25 * affinity.filter((x) => Math.abs(x - h) <= 1).length / affinity.length;
    if (opt.avoidHour != null && Math.abs(h - opt.avoidHour) <= 1) sc *= 0.75;
    const load = opt.load?.get(loadKey(opt.who ?? null, cur)) ?? 0;
    sc *= 1 / (1 + load * 0.18);
    // Slight nudge to the first slot so "soon" wins ties.
    if (cur.getTime() === first.getTime()) sc *= 1.04;
    if (sc > bestScore) { bestScore = sc; best = new Date(cur); }
    const nxt = new Date(cur.getTime() + 30 * MIN);
    cur = minutesOf(nxt) >= end ? new Date(nxt.getTime() + 14 * HOUR) : nxt;
  }
  // Round to the nearest 15 minutes.
  best.setMinutes(Math.round(best.getMinutes() / 15) * 15, 0, 0);
  return clampToWork(best, s);
}

/* ------------------------------------------------------------------ routing */

/**
 * Who works this lead right now. Everything here is set by the admin:
 *   1. a specific person for the next step (e.g. the expert hosting a discovery call)
 *   2. the lead's owner — unless the lead moved to a stage the owner doesn't work and someone else does (hand-off)
 *   3. whoever is allocated to the lead's current stage (shared evenly if several)
 *   4. nobody (null) — unassigned, waiting for the admin
 * Mirrored in apps-script/Code.gs (keep the two identical — the server enforces it).
 */
export function assigneeOf(a: Account, team: Member[]): ID | null {
  if (a.next?.assignee) return a.next.assignee;
  const active = team.filter((m) => m.active);
  // Explicit "working it now": set when the admin assigns, or by a stage hand-off.
  if (a.handler && active.some((m) => m.id === a.handler)) return a.handler;
  const workers = active.filter((m) => (m.stages || []).includes(a.stage));
  const owner = a.owner ? active.find((m) => m.id === a.owner) : undefined;
  if (owner && (!workers.length || !(owner.stages || []).length || workers.includes(owner))) return owner.id;
  if (workers.length) return workers[hashNum(a.id) % workers.length].id;
  return null;
}

/**
 * Who should handle a lead after it moves to `stage`: keep the current handler if they work that stage
 * (or work every stage); otherwise hand off to whoever is allocated to it. null = fall back to owner/stage routing.
 */
export function handlerFor(a: Account, stage: StageId, team: Member[]): ID | null {
  const active = team.filter((m) => m.active);
  const workers = active.filter((m) => (m.stages || []).includes(stage));
  const cur = a.handler ? active.find((m) => m.id === a.handler) : undefined;
  if (cur && (!(cur.stages || []).length || workers.includes(cur))) return cur.id;
  if (!workers.length) return null;
  const owner = a.owner ? active.find((m) => m.id === a.owner) : undefined;
  if (owner && (!(owner.stages || []).length || workers.includes(owner))) return null;
  return workers[hashNum(a.id) % workers.length].id;
}

/** Fields to write when a lead changes stage (keeps hand-offs consistent everywhere). */
export const stageMove = (a: Account, stage: StageId, team: Member[]) => ({ stage, handler: handlerFor(a, stage, team) });

/** Fields to write when the admin assigns a lead to someone (or back to automatic with null). */
export const assignTo = (who: ID | null) => ({ owner: who, handler: who });

export const isMine = (a: Account, team: Member[], me: ID) => assigneeOf(a, team) === me;

export const canRequestAssign = (team: Member[], me: ID) => team.some((m) => m.id === me && m.active && m.assignAsk);

/**
 * Assignment requests: someone with "request assigning" may ask (or withdraw their own ask); only the admin approves.
 * Returns true/false when the op is a request, undefined when it isn't one. Mirrored in apps-script/Code.gs.
 */
export function requestAllowed(data: Record<string, any>, cur: Account | undefined, team: Member[], me: ID): boolean | undefined {
  if (!data || !('assignReq' in data)) return undefined;
  if (Object.keys(data).length !== 1) return false;
  const v = data.assignReq;
  if (v == null) return !!cur?.assignReq && cur.assignReq.by === me;
  return canRequestAssign(team, me) && v.by === me && (v.to === null || team.some((t) => t.id === v.to && t.active));
}

/** Grace window in which you can still change (or undo) a lead you just handed off. */
export const HANDOFF_GRACE_MS = 30 * 60e3;

/**
 * May this person change this lead? The admin: always. Others: their own leads, unassigned leads they
 * added themselves, and leads they changed in the last 30 minutes (so a hand-off can still be undone).
 */
export function canEdit(a: Account, team: Member[], me: ID, admin: boolean, now = Date.now()): boolean {
  if (admin) return true;
  if (team.some((m) => m.id === me && m.active && m.editAll)) return true;
  const who = assigneeOf(a, team);
  if (who === me) return true;
  if (who === null && a.createdBy === me) return true;
  return a.updatedBy === me && now - Date.parse(a.updatedAt) < HANDOFF_GRACE_MS;
}

/* ------------------------------------------------------------------ the daily queue */

export type Section = 'now' | 'due' | 'later' | 'fresh' | 'number' | 'upcoming';

export interface QueueItem {
  account: Account;
  contact?: Contact;
  section: Section;
  score: number;
  reasons: string[];
  due?: Date;
}

export interface Queue {
  now: QueueItem[];
  due: QueueItem[];
  later: QueueItem[];
  fresh: QueueItem[];
  number: QueueItem[];
  upcoming: QueueItem[];
  backlog: number;
  newQuota: number;
  newTarget: number;
  newDone: number;
  throttle: number;
  /** Open leads nobody is assigned to (shown to the admin). */
  unassigned: number;
}

const STAGE_W: Record<StageId, number> = { new: 4, intro: 10, shared: 24, engaged: 38, discovery: 48, assessment: 16 };
const ACTION_LABEL: Record<string, string> = {
  call: 'Call', send: 'Send details', remind: 'Reminder call', followup: 'Follow up', discovery: 'Discovery call', 'find-number': 'Find number',
};
export const actionLabel = (t?: string) => (t ? ACTION_LABEL[t] ?? t : 'Open');

export interface QueueInput {
  accounts: Account[];
  contacts: Map<ID, Contact[]>;
  acts: Activity[];
  settings: Settings;
  team: Member[];
  me: ID;
  model: TimeModel;
  now?: Date;
  /** Show the whole team's queue (admin overview). */
  everyone?: boolean;
}

export function targetFor(key: keyof Settings['targets'], s: Settings, team: Member[], me: ID) {
  const m = team.find((x) => x.id === me);
  return m?.targets?.[key] ?? s.targets[key].value;
}

export function buildQueue(q: QueueInput): Queue {
  const now = q.now ?? new Date();
  const t0 = startOfDay(now).getTime();
  const tEnd = t0 + DAY;
  const out: Queue = { now: [], due: [], later: [], fresh: [], number: [], upcoming: [], backlog: 0, newQuota: 0, newTarget: 0, newDone: 0, throttle: 1, unassigned: 0 };
  const rateNow = q.model.rate[now.getDay()][now.getHours()];
  const lookalike = sectorStats(q.accounts);

  for (const a of q.accounts) {
    if (a.voided || a.status === 'won' || a.status === 'lost') continue;
    const who = assigneeOf(a, q.team);
    if (who === null) out.unassigned++;
    if (!q.everyone && who !== q.me) continue;
    const cs = q.contacts.get(a.id) || [];
    const contact = (a.next?.contactId && cs.find((c) => c.id === a.next!.contactId)) || cs.find((c) => c.id === a.primaryContactId) || cs[0];
    const hasPhone = !!(contact?.phones.length || a.phones.length);

    if (a.stage === 'new' && !a.next) {
      if (a.status === 'parked') continue;
      const reasons: string[] = [];
      let score = 10;
      if (!hasPhone) { out.number.push({ account: a, contact, section: 'number', score: 0, reasons: ['No phone number yet'] }); continue; }
      if (contact?.name) { score += 6; reasons.push(`Ask for ${contact.name.split(' ')[0]}`); }
      if (contact?.role === 'decision-maker') { score += 8; reasons.push('Decision maker known'); }
      if (a.emails.length || contact?.emails.length) score += 2;
      const sec = a.sector ? lookalike.get(a.sector.toLowerCase()) : undefined;
      if (sec && sec.touched >= 4) {
        const r = sec.warm / sec.touched;
        score += r * 30;
        if (r >= 0.15) reasons.push(`${a.sector} converts well (${Math.round(r * 100)}%)`);
      }
      if (!reasons.length) reasons.push(a.city ? `${a.city}${a.sector ? ` · ${a.sector}` : ''}` : 'Fresh lead');
      out.fresh.push({ account: a, contact, section: 'fresh', score, reasons });
      continue;
    }

    const nx = a.next;
    if (!nx) continue;
    const due = new Date(nx.due);
    const dt = due.getTime();
    const reasons: string[] = [];
    let score = STAGE_W[a.stage] + a.heat * 6;
    let section: Section;

    if (nx.type === 'find-number') {
      out.number.push({ account: a, contact, section: 'number', score: 0, reasons: [a.badPhones?.length ? 'Wrong number — find the right one' : 'Need a working number'], due });
      continue;
    }

    const lateMin = (now.getTime() - dt) / MIN;
    if (nx.timed && Math.abs(lateMin) <= 20) { score += 120; reasons.push(`Promised ${fmtTime(due)}`); section = 'now'; }
    else if (nx.type === 'send' && dt <= now.getTime()) { score += 90; reasons.push('Waiting for our details'); section = 'now'; }
    else if (nx.type === 'remind' && dt <= now.getTime()) { score += 70; reasons.push(`Details sent ${rel(nx.due)} — confirm they got it`); section = 'now'; }
    else if (nx.type === 'discovery' && dt > now.getTime() && dt < tEnd) { section = 'later'; reasons.push(`Discovery at ${fmtTime(due)}`); score += 50; }
    else if (dt <= now.getTime()) {
      section = 'due';
      if (nx.timed) { score += 60; reasons.push(`Missed promised ${fmtTime(due)}`); }
      const overdueDays = (now.getTime() - dt) / DAY;
      if (overdueDays >= 1) { score += Math.min(30, 4 + overdueDays * 6); reasons.push(`Overdue ${Math.floor(overdueDays)}d`); }
      if (lateMin > 30) out.backlog++;
    } else if (dt < tEnd) { section = 'later'; reasons.push(nx.timed ? `Promised ${fmtTime(due)}` : `Planned ${fmtTime(due)}`); }
    else if (dt < tEnd + DAY) { section = 'upcoming'; reasons.push(`Tomorrow ${fmtTime(due)}`); }
    else continue;

    if (a.heat >= 2) reasons.push('Warm');
    if (a.heat <= -1) reasons.push('Cooling off');
    if (a.attempts >= 3) { score -= 4; reasons.push(`${a.attempts} tries — try WhatsApp or another number`); }
    if (nx.type === 'followup' && a.cadence) reasons.push(`Follow-up ${a.cadence}`);
    if (a.status === 'parked') reasons.push('Reconnect (parked)');
    const aff = q.model.acct.get(a.id);
    if (aff?.some((h) => Math.abs(h - now.getHours()) <= 1)) { score += 8; reasons.push('Usually picks up around now'); }
    score *= 0.85 + 0.3 * clamp(rateNow / (q.model.base || 0.35), 0.5, 1.5) / 1.5;
    out[section].push({ account: a, contact, section, score, reasons, due });
  }

  // New-lead throttle: fewer fresh leads as overdue follow-ups pile up; none at the limit.
  out.newTarget = q.settings.targets.newLeads.on ? targetFor('newLeads', q.settings, q.team, q.me) : 15;
  out.newDone = q.acts.filter((x) => !x.voided && x.createdBy === q.me && x.stageFrom === 'new' && new Date(x.at).getTime() >= t0).length;
  out.throttle = q.settings.backlogLimit > 0 ? clamp(1 - out.backlog / q.settings.backlogLimit, 0, 1) : 1;
  out.newQuota = Math.max(0, Math.ceil(out.newTarget * out.throttle) - out.newDone);

  const byScore = (x: QueueItem, y: QueueItem) => y.score - x.score;
  out.now.sort(byScore);
  out.due.sort(byScore);
  out.fresh.sort(byScore);
  out.fresh = out.fresh.slice(0, q.everyone ? 50 : out.newQuota);
  out.later.sort((x, y) => x.due!.getTime() - y.due!.getTime());
  out.upcoming.sort((x, y) => x.due!.getTime() - y.due!.getTime());
  return out;
}

/** Per-sector: how many accounts were touched and how many got warm (details shared or beyond). */
function sectorStats(accounts: Account[]) {
  const m = new Map<string, { touched: number; warm: number }>();
  for (const a of accounts) {
    if (!a.sector || a.voided || a.stage === 'new') continue;
    const k = a.sector.toLowerCase();
    const v = m.get(k) || { touched: 0, warm: 0 };
    v.touched++;
    if (a.stage !== 'intro' || a.status === 'won') v.warm++;
    m.set(k, v);
  }
  return m;
}

/** Map of assignee+hour → number of planned follow-ups (for spreading new ones). */
export function loadMap(accounts: Account[], team: Member[]): Load {
  const l: Load = new Map();
  for (const a of accounts) {
    if (!a.next || a.voided || a.status === 'lost' || a.status === 'won') continue;
    const k = loadKey(assigneeOf(a, team), new Date(a.next.due));
    l.set(k, (l.get(k) || 0) + 1);
  }
  return l;
}
