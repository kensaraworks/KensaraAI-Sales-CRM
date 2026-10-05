/**
 * What happens after each outcome: stage, status, warmth, and — most importantly — the next step and when.
 * Pure: takes the current state, returns a plan the store turns into ops.
 */
import type { Account, ActionType, Activity, Channel, Contact, ID, Member, NextAction, Settings, StageId, Status } from './types';
import { OUTCOME } from './outcomes';
import { Load, TimeModel, addWorkDays, assigneeOf, bestSlot, clampToWork } from './schedule';
import { DAY, HOUR, MIN, clamp, fmtWhen, parseHM, startOfDay } from './util';
import { stageIndex } from './defaults';

export interface NewContactInput {
  name: string;
  designation?: string;
  phone?: string;
  email?: string;
  /** We call them, or they'll call us. */
  direction: 'we-call' | 'they-call';
}

export interface OutcomeInput {
  outcome: string;
  account: Account;
  contact?: Contact;
  phone?: string;
  channel?: Channel;
  note?: string;
  transcript?: string;
  time?: Date | null;
  reason?: string;
  share?: 'whatsapp' | 'email' | 'both';
  newContact?: NewContactInput | null;
  expert?: ID;
  sentiment?: number;
}

export interface Ctx {
  settings: Settings;
  model: TimeModel;
  load: Load;
  team: Member[];
  me: ID;
  now?: Date;
}

export interface Plan {
  account: Partial<Account>;
  contact?: { id: ID; set: Partial<Contact> };
  newContact?: Omit<Contact, 'rev' | 'createdAt' | 'createdBy' | 'updatedAt' | 'updatedBy' | 'id' | 'kind' | 'accountId'>;
  activity: Partial<Activity>;
  next: NextAction | null;
  points: number;
  celebrate?: 'small' | 'big';
  /** Human-readable next step, e.g. "Call Rahul · Tomorrow 11:30 AM". */
  summary: string;
}

const advance = (cur: StageId, to: StageId): StageId => (stageIndex(to) > stageIndex(cur) ? to : cur);

/** The next touch in the follow-up cadence. Step n uses gaps[n]; beyond the list → monthly nurture. */
export function cadenceStep(step: number, ctx: Ctx, a: Account): { due: Date; channel: Channel; note: string } {
  const s = ctx.settings;
  const now = ctx.now ?? new Date();
  const g = s.cadence.gaps;
  const last = step === g.length - 1;
  const days = step < g.length ? g[step] : s.cadence.nurtureDays;
  const channel = step < g.length ? s.cadence.channels[step] ?? 'call' : 'call';
  const day = addWorkDays(startOfDay(now), days, s);
  const morning = new Date(day);
  morning.setHours(Math.floor(parseHM(s.workStart) / 60), parseHM(s.workStart) % 60, 0, 0);
  const due = bestSlot(morning, s, ctx.model, { accountId: a.id, horizonDays: 0, load: ctx.load, who: assigneeOf(a, ctx.team) });
  const note = step >= g.length
    ? 'Monthly check-in — share something useful'
    : last ? 'Last touch of the sequence — a polite "shall I close your file?" often gets a reply'
    : ANGLES[step % ANGLES.length];
  return { due, channel, note };
}

/** Each follow-up brings a fresh reason to reply instead of "just checking in". */
const ANGLES = [
  'Check they received it and offer a quick walkthrough',
  'Share one relevant insight for their sector',
  'Mention the DPDP compliance timeline and what peers are doing',
  'Offer the 30-min discovery call with two concrete slots',
  'Share a short case example',
  'Ask who else should be part of the conversation',
  'Offer to send a one-page summary for their management',
];

export function planOutcome(inp: OutcomeInput, ctx: Ctx): Plan {
  const o = OUTCOME.get(inp.outcome);
  if (!o) throw new Error(`Unknown outcome ${inp.outcome}`);
  const s = ctx.settings;
  const now = ctx.now ?? new Date();
  const a = inp.account;
  const who = assigneeOf(a, ctx.team);
  const slot = (from: Date, opt: { horizonDays?: number; avoidHour?: number } = {}) =>
    bestSlot(from, s, ctx.model, { accountId: a.id, load: ctx.load, who, ...opt });
  const cId = inp.contact?.id;
  const channel: Channel = inp.channel ?? o.channel ?? 'call';

  let stage: StageId = a.stage === 'new' && channel !== 'note' ? 'intro' : a.stage;
  let status: Status = a.status === 'parked' && o.connected ? 'open' : a.status;
  let heat = a.heat;
  let attempts = o.connected ? 0 : a.attempts;
  let cadence = a.cadence;
  let next: NextAction | null = a.next ?? null;
  let points = o.points;
  let celebrate: Plan['celebrate'];
  const plan: Partial<Plan> = {};
  const acc: Partial<Account> = {};
  const mk = (type: ActionType, due: Date, extra: Partial<NextAction> = {}): NextAction => ({ type, due: due.toISOString(), contactId: cId, ...extra });

  switch (o.id) {
    case 'no-answer':
    case 'busy':
    case 'switched-off': {
      attempts = a.attempts + 1;
      const h = now.getHours();
      if (o.id === 'busy') next = mk('call', slot(new Date(now.getTime() + 90 * MIN), { horizonDays: 1 }));
      else if (o.id === 'switched-off') next = mk('call', slot(addWorkDays(now, 1, s), { horizonDays: 1 }));
      else if (attempts === 1) next = mk('call', slot(new Date(now.getTime() + 2.5 * HOUR), { horizonDays: 1, avoidHour: h }));
      else if (attempts === 2) next = mk('call', slot(addWorkDays(startOfDay(now), 1, s), { horizonDays: 1, avoidHour: h }), { note: 'Try a WhatsApp intro if this one fails too' });
      else if (attempts <= 4) next = mk('call', slot(addWorkDays(startOfDay(now), 2, s), { avoidHour: h }), { note: 'Several tries — try another number or a WhatsApp message' });
      else {
        const phones = (inp.contact?.phones.length ?? 0) + a.phones.length;
        next = phones > 1 ? mk('call', slot(addWorkDays(startOfDay(now), 3, s))) : mk('find-number', now, { note: 'Too many tries on this number — find another' });
        heat = Math.max(-2, heat - 1);
      }
      if (a.next?.type === 'followup' || a.next?.type === 'remind') next = { ...next, type: a.next.type };
      break;
    }
    case 'wrong-number': {
      const bad = inp.phone || inp.contact?.phones[0] || a.phones[0];
      if (bad) {
        acc.badPhones = [...new Set([...(a.badPhones || []), bad])];
        if (a.phones.includes(bad)) acc.phones = a.phones.filter((p) => p !== bad);
        if (inp.contact?.phones.includes(bad)) {
          const rest = inp.contact.phones.filter((p) => p !== bad);
          plan.contact = { id: inp.contact.id, set: { phones: rest, ...(rest.length ? {} : { status: 'wrong-number' as const }) } };
        }
      }
      const otherPhones = (acc.phones ?? a.phones).length + ((plan.contact?.set.phones ?? inp.contact?.phones ?? []).length);
      next = otherPhones ? mk('call', slot(new Date(now.getTime() + 10 * MIN))) : mk('find-number', now);
      attempts = 0;
      break;
    }
    case 'callback': {
      const t = inp.time ?? slot(new Date(now.getTime() + HOUR));
      next = mk(a.next?.type === 'remind' || a.next?.type === 'followup' ? a.next.type : 'call', t, { timed: !!inp.time });
      break;
    }
    case 'call-later': {
      const t = inp.time ?? addWorkDays(now, 1, s);
      next = mk(a.next?.type === 'followup' ? 'followup' : 'call', slot(t, { horizonDays: 1 }));
      break;
    }
    case 'referred': {
      const nc = inp.newContact;
      if (nc?.name) {
        plan.newContact = {
          name: nc.name.trim(), designation: nc.designation?.trim() || '', phones: nc.phone ? [nc.phone] : [], emails: nc.email ? [nc.email] : [],
          role: /\b(ceo|cfo|cto|cio|ciso|coo|md|director|founder|owner|head|vp|president|partner|dpo|chief)\b/i.test(nc.designation || '') ? 'decision-maker' : 'unknown',
          referredBy: cId, status: 'active',
        };
      }
      if (inp.contact && inp.contact.role === 'unknown') plan.contact = { id: inp.contact.id, set: { role: 'gatekeeper' } };
      const nm = nc?.name?.split(' ')[0] || 'them';
      next = nc?.direction === 'they-call'
        ? { type: 'call', due: slot(addWorkDays(startOfDay(now), 1, s)).toISOString(), note: `${nm} was asked to call us — if they haven't, call them` }
        : { type: 'call', due: (inp.time ?? clampToWork(new Date(now.getTime() + 5 * MIN), s)).toISOString(), timed: !!inp.time, note: `Referred by ${inp.contact?.name || 'previous contact'}` };
      heat = Math.max(heat, 0);
      break;
    }
    case 'gatekeeper': {
      next = mk('call', slot(addWorkDays(startOfDay(now), 1, s), { avoidHour: now.getHours() }), { note: 'Ask for the decision maker by name — try early morning or after 5' });
      break;
    }
    case 'pitched-share': {
      stage = advance(stage, 'shared');
      heat = clamp(heat + 1, -2, 3);
      if (inp.contact) plan.contact = { id: inp.contact.id, set: { role: 'decision-maker' } };
      next = mk('send', now, { channel: inp.share === 'email' ? 'email' : 'whatsapp', note: `Send details on ${inp.share === 'both' ? 'WhatsApp + email' : inp.share || 'WhatsApp'}`, assignee: undefined });
      celebrate = 'small';
      break;
    }
    case 'interested':
    case 'read-interested': {
      heat = clamp(heat + 2, -2, 3);
      if (inp.time) {
        stage = advance(stage, 'discovery');
        next = mk('discovery', inp.time, { timed: true, assignee: inp.expert || expertFor(ctx) });
        points += 15;
      } else {
        stage = advance(stage, 'engaged');
        next = mk('call', slot(new Date(now.getTime() + 2 * HOUR), { horizonDays: 1 }), { note: 'Book the 30-min discovery call' });
      }
      celebrate = 'small';
      break;
    }
    case 'sent': {
      stage = advance(stage, 'shared');
      cadence = 0;
      next = mk('remind', clampToWork(new Date(now.getTime() + s.remindAfterMin * MIN), s), { note: 'Call to confirm they got the details' });
      break;
    }
    case 'ack': {
      const c = cadenceStep(0, ctx, a);
      cadence = 1;
      next = mk('followup', c.due, { channel: c.channel, note: c.note });
      break;
    }
    case 'questions': {
      stage = advance(stage, 'engaged');
      heat = clamp(heat + 1, -2, 3);
      next = mk('call', slot(new Date(now.getTime() + 3 * HOUR), { horizonDays: 1 }), { note: 'Answer their questions, then propose the discovery call' });
      break;
    }
    case 'replied': {
      const pos = (inp.sentiment ?? 1) > 0;
      if (pos) { stage = advance(stage, 'engaged'); heat = clamp(heat + 1, -2, 3); }
      next = mk('call', slot(new Date(now.getTime() + 30 * MIN), { horizonDays: 1 }), { note: pos ? 'They replied — call while it\'s fresh' : 'Read their reply and respond' });
      break;
    }
    case 'discovery-booked':
    case 'rescheduled': {
      stage = advance(stage, 'discovery');
      heat = clamp(heat + (o.id === 'discovery-booked' ? 2 : 0), -2, 3);
      const t = inp.time ?? slot(addWorkDays(now, 1, s));
      next = mk('discovery', t, { timed: true, assignee: inp.expert || a.next?.assignee || expertFor(ctx), note: 'Discovery call' });
      if (o.id === 'discovery-booked') celebrate = 'big';
      break;
    }
    case 'needs-time':
    case 'no-response': {
      const c = cadenceStep(cadence, ctx, a);
      cadence = cadence + 1;
      next = mk('followup', c.due, { channel: c.channel, note: c.note });
      if (o.id === 'no-response' && cadence > 3) heat = Math.max(-2, heat - 1);
      break;
    }
    case 'held-thinking': {
      cadence = 0;
      const c = cadenceStep(0, ctx, a);
      cadence = 1;
      next = mk('followup', c.due, { channel: c.channel, note: 'Send the discovery recap and next steps' });
      heat = clamp(heat + 1, -2, 3);
      break;
    }
    case 'no-show': {
      heat = Math.max(-2, heat - 1);
      next = mk('call', clampToWork(new Date(now.getTime() + 15 * MIN), s), { note: 'Missed the discovery call — reschedule' });
      break;
    }
    case 'won': {
      stage = 'assessment';
      status = 'won';
      heat = 3;
      next = null;
      celebrate = 'big';
      break;
    }
    case 'not-now': {
      status = 'parked';
      const t = inp.time ?? new Date(now.getTime() + 90 * DAY);
      next = mk('call', slot(t, { horizonDays: 2 }), { note: 'They asked us to reconnect around now' });
      break;
    }
    case 'not-interested': {
      status = 'lost';
      acc.lostReason = inp.reason || 'Not interested';
      next = null;
      break;
    }
    case 'msg-sent': {
      stage = a.stage === 'new' ? 'intro' : a.stage;
      if (a.next?.type === 'followup') {
        const c = cadenceStep(cadence, ctx, a);
        cadence = cadence + 1;
        next = mk('followup', c.due, { channel: c.channel, note: c.note });
      } else if (!a.next || new Date(a.next.due).getTime() <= now.getTime() + HOUR) {
        next = mk(a.next?.type === 'discovery' ? 'discovery' : 'call', a.next?.type === 'discovery' ? new Date(a.next.due) : slot(addWorkDays(startOfDay(now), 1, s)), a.next?.type === 'discovery' ? { timed: true, assignee: a.next.assignee } : { note: 'Give them a day to reply, then call' });
      }
      break;
    }
    case 'note':
      break;
  }

  // Following up on time earns a bonus and feeds the "on time" metric.
  const prev = a.next;
  const planned = !!prev && o.id !== 'note';
  const due = prev ? new Date(prev.due).getTime() : 0;
  const grace = prev?.timed ? 20 * MIN : 2 * HOUR;
  const onTime = planned && now.getTime() <= due + grace;
  if (onTime && prev && due <= now.getTime() + 4 * HOUR) points += 2;
  if (o.tone === 'great') heat = clamp(heat, -2, 3);

  if (inp.sentiment != null) heat = clamp(Math.round((heat + inp.sentiment) / 1.5), -2, 3);

  Object.assign(acc, { stage, status, heat, attempts, cadence, next });
  if (plan.newContact && o.id === 'referred') acc.primaryContactId = '__new__';
  else if (inp.contact && o.connected && !a.primaryContactId) acc.primaryContactId = inp.contact.id;

  const activity: Partial<Activity> = {
    accountId: a.id, contactId: cId, channel, outcome: o.id, note: inp.note?.trim() || undefined, transcript: inp.transcript || undefined,
    stageFrom: a.stage !== stage || a.stage === 'new' ? a.stage : undefined, stageTo: a.stage !== stage ? stage : undefined,
    statusTo: a.status !== status ? status : undefined, sentiment: inp.sentiment, at: now.toISOString(), planned, onTime, points,
  };

  return { ...plan, account: acc, activity, next, points, celebrate, summary: describeNext(next, plan.newContact?.name) } as Plan;
}

function expertFor(ctx: Ctx): ID | undefined {
  return ctx.team.find((m) => m.active && m.stages?.includes('discovery'))?.id;
}

export function describeNext(n: NextAction | null | undefined, who?: string): string {
  if (!n) return 'No next step — lead closed';
  const verb = { call: 'Call', send: 'Send details', remind: 'Reminder call', followup: 'Follow up', discovery: 'Discovery call', 'find-number': 'Find a number' }[n.type];
  const ch = n.type === 'followup' && n.channel && n.channel !== 'call' ? ` on ${n.channel === 'whatsapp' ? 'WhatsApp' : 'email'}` : '';
  return `${verb}${who ? ` ${who.split(' ')[0]}` : ''}${ch} · ${n.type === 'send' || n.type === 'find-number' ? 'now' : fmtWhen(n.due)}${n.timed ? ' (promised)' : ''}`;
}
