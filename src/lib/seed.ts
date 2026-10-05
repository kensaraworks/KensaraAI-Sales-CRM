/** Demo data for mock mode: fictional companies run through the real workflow so every screen has life. */
import type { Account, Activity, Contact, Member, Rec } from './types';
import { DEFAULT_SETTINGS } from './defaults';
import { buildTimeModel, clampToWork } from './schedule';
import { planOutcome } from './workflow';
import { DAY, HOUR, MIN } from './util';

let s = 42;
const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
const pick = <T,>(a: T[]) => a[Math.floor(rnd() * a.length)];
const hex = (n: number) => Array.from({ length: n }, () => Math.floor(rnd() * 16).toString(16)).join('');

const A = ['Sahyadri', 'Kaveri', 'Nilgiri', 'Aravalli', 'Konkan', 'Deccan', 'Narmada', 'Malabar', 'Satpura', 'Shivalik', 'Godavari', 'Vindhya', 'Banyan', 'Lotus', 'Tapti', 'Chinar', 'Saffron', 'Peacock', 'Monsoon', 'Indigo', 'Coral', 'Teak', 'Sandal', 'Jasmine'];
const B: [string, string][] = [
  ['Logistics', 'Logistics'], ['Health', 'Healthcare'], ['Finserv', 'Banking & NBFC'], ['Pharma', 'Pharma'], ['Textiles', 'Manufacturing'],
  ['Infotech', 'IT Services'], ['Retail', 'Retail'], ['Realty', 'Real Estate'], ['Foods', 'FMCG'], ['Capital', 'Fintech'], ['Hospitals', 'Healthcare'],
  ['Learning', 'Education'], ['Insurance', 'Insurance'], ['Chemicals', 'Manufacturing'], ['Hotels', 'Hospitality'],
];
const CITIES = ['Mumbai', 'Pune', 'Bengaluru', 'Hyderabad', 'Chennai', 'Gurugram', 'Ahmedabad', 'Kolkata', 'Jaipur', 'Kochi', 'Indore', 'Coimbatore'];
const FIRST = ['Rahul', 'Priya', 'Amit', 'Sneha', 'Vikram', 'Ananya', 'Suresh', 'Kavita', 'Arjun', 'Meera', 'Rohan', 'Divya', 'Karthik', 'Pooja', 'Sanjay', 'Lakshmi', 'Imran', 'Farah', 'Gurpreet', 'Nikhil'];
const LAST = ['Sharma', 'Iyer', 'Patel', 'Reddy', 'Nair', 'Gupta', 'Kulkarni', 'Banerjee', 'Singh', 'Menon', 'Desai', 'Rao', 'Khan', 'Joshi', 'Pillai', 'Chatterjee'];
const FRONT = ['Reception', 'Front desk', 'Admin executive', 'Office assistant'];
const DM = ['CFO', 'CIO', 'CTO', 'Head of IT', 'Compliance Head', 'Director', 'COO', 'DPO', 'Head – Legal'];

const PATHS: string[][] = [
  [], [], [], [], [], [], [], [], [], [], [], [], [], [], [],
  ['no-answer'], ['no-answer', 'busy'], ['no-answer', 'no-answer', 'no-answer'], ['switched-off'], ['callback'], ['callback'], ['gatekeeper'],
  ['referred'], ['referred', 'no-answer'], ['wrong-number'], ['call-later'],
  ['pitched-share'], ['no-answer', 'pitched-share'], ['pitched-share', 'sent'], ['referred', 'pitched-share', 'sent'], ['pitched-share', 'sent', 'ack'],
  ['pitched-share', 'sent', 'ack', 'no-response'], ['pitched-share', 'sent', 'no-answer'], ['busy', 'pitched-share', 'sent', 'ack', 'no-response', 'no-response'],
  ['pitched-share', 'sent', 'read-interested'], ['pitched-share', 'sent', 'questions'], ['referred', 'pitched-share', 'sent', 'ack', 'read-interested'],
  ['pitched-share', 'sent', 'read-interested', 'discovery-booked'], ['interested', 'discovery-booked'], ['pitched-share', 'sent', 'ack', 'discovery-booked'],
  ['pitched-share', 'sent', 'read-interested', 'discovery-booked', 'held-thinking'], ['pitched-share', 'sent', 'discovery-booked', 'won'],
  ['referred', 'pitched-share', 'sent', 'read-interested', 'discovery-booked', 'won'], ['not-interested'], ['pitched-share', 'sent', 'not-interested'],
  ['not-now'], ['no-answer', 'not-now'],
];

export function seedDemo(): { team: Member[]; records: Rec[] } {
  s = 42;
  const team: Member[] = [
    { id: 'uasha', name: 'Asha', active: true, stages: ['new', 'intro'], color: '#0d9488' },
    { id: 'uravi', name: 'Ravi', active: true, stages: ['shared', 'engaged'], color: '#5b5bd6' },
    { id: 'uneha', name: 'Neha', active: true, stages: ['discovery'], color: '#c2255c' },
  ];
  const settings = DEFAULT_SETTINGS;
  const model = buildTimeModel([]);
  const records: Rec[] = [];
  const nowT = Date.now();
  const base = (id: string, kind: any, by: string, at: string) => ({ id, kind, rev: 0, createdAt: at, createdBy: by, updatedAt: at, updatedBy: by });
  const used = new Set<string>();

  PATHS.forEach((path, i) => {
    let name = '';
    let sector = '';
    do { const b = pick(B); name = `${pick(A)} ${b[0]}`; sector = b[1]; } while (used.has(name));
    used.add(name);
    const created = new Date(nowT - (16 + rnd() * 4) * DAY).toISOString();
    const noPhone = path.length === 0 && i % 4 === 3;
    const aid = `c${hex(12)}`;
    const acct: Account = {
      ...base(aid, 'account', 'uasha', created), kind: 'account', name: `${name} Pvt Ltd`, city: pick(CITIES), sector,
      website: `https://${name.toLowerCase().replace(/\s+/g, '')}.example.in`,
      phones: noPhone ? [] : [`+91${pick(['98', '99', '97', '90', '88', '70'])}${String(Math.floor(rnd() * 1e8)).padStart(8, '0')}`],
      emails: rnd() > 0.5 ? [`info@${name.toLowerCase().replace(/\s+/g, '')}.example.in`] : [],
      extra: rnd() > 0.6 ? { Employees: pick(['50-200', '200-500', '500-1000', '1000+']), 'Lead source': pick(['IndiaMART', 'LinkedIn', 'Event', 'Referral']) } : {},
      stage: 'new', status: 'open', attempts: 0, cadence: 0, heat: 0, tags: [], source: 'Demo import', next: null,
    };
    const contacts: Contact[] = [];
    const mkContact = (front: boolean, by?: string): Contact => ({
      ...base(`p${hex(12)}`, 'contact', 'uasha', created), kind: 'contact', accountId: aid,
      name: front ? `${pick(FIRST)} (${pick(FRONT)})` : `${pick(FIRST)} ${pick(LAST)}`, designation: front ? '' : pick(DM),
      phones: front ? [] : [`+91${pick(['98', '99', '91', '81'])}${String(Math.floor(rnd() * 1e8)).padStart(8, '0')}`], emails: [],
      role: front ? 'gatekeeper' : 'unknown', status: 'active', referredBy: by,
    });
    if (rnd() > 0.45 || path.length === 0) { const c = mkContact(false); c.role = 'unknown'; contacts.push(c); acct.primaryContactId = c.id; }

    let t = new Date(nowT - (3 + rnd() * 11) * DAY);
    t = clampToWork(new Date(t.setHours(10 + Math.floor(rnd() * 7), Math.floor(rnd() * 4) * 15)), settings);
    let a = acct;
    for (const oc of path) {
      if (t.getTime() > nowT) break;
      const who = a.stage === 'discovery' ? 'uneha' : a.stage === 'shared' || a.stage === 'engaged' ? 'uravi' : 'uasha';
      const contact = contacts.find((c) => c.id === (a.next?.contactId || a.primaryContactId)) || contacts[0];
      const future = new Date(Math.min(nowT + 2 * DAY, t.getTime() + (1 + rnd() * 3) * DAY));
      const p = planOutcome({
        outcome: oc, account: a, contact,
        time: oc === 'callback' ? clampToWork(new Date(t.getTime() + (2 + rnd() * 26) * HOUR), settings) : oc === 'discovery-booked' ? clampToWork(future, settings) : oc === 'not-now' ? new Date(nowT + 60 * DAY) : undefined,
        share: 'whatsapp', reason: 'Already have a vendor / in-house team',
        newContact: oc === 'referred' ? { name: `${pick(FIRST)} ${pick(LAST)}`, designation: pick(DM), phone: `+9198${String(Math.floor(rnd() * 1e8)).padStart(8, '0')}`, direction: 'we-call' } : null,
        note: oc === 'callback' ? 'In a meeting, asked to call back' : oc === 'referred' ? 'Reception gave the right person\'s number' : undefined,
      }, { settings, model, load: new Map(), team, me: who, now: t });
      let newContactId: string | undefined;
      if (p.newContact) {
        const nc: Contact = { ...base(`p${hex(12)}`, 'contact', who, t.toISOString()), kind: 'contact', accountId: aid, ...p.newContact };
        contacts.push(nc);
        newContactId = nc.id;
      }
      if (p.contact) { const c = contacts.find((x) => x.id === p.contact!.id); if (c) Object.assign(c, p.contact.set); }
      const next = p.next ? { ...p.next, contactId: p.next.contactId || newContactId } : null;
      a = { ...a, ...p.account, next, primaryContactId: p.account.primaryContactId === '__new__' ? newContactId : p.account.primaryContactId ?? a.primaryContactId, updatedAt: t.toISOString(), updatedBy: who } as Account;
      const act: Activity = { ...base(`e${hex(12)}`, 'activity', who, t.toISOString()), kind: 'activity', ...(p.activity as any), contactId: contact?.id };
      records.push(act);
      const nd = next ? new Date(next.due).getTime() : Infinity;
      t = new Date(Math.max(t.getTime() + 20 * MIN, nd + (rnd() - 0.3) * 2 * HOUR));
      t = clampToWork(t, settings);
    }
    // Keep the demo believable: nothing more than a day or so overdue.
    if (a.next && new Date(a.next.due).getTime() < nowT - 1.5 * DAY) a.next = { ...a.next, due: new Date(nowT - (0.5 + rnd() * 20) * HOUR).toISOString() };
    records.push(a, ...contacts);
  });

  // A couple of promises due right around now, so the queue has something urgent.
  const intro = records.filter((r): r is Account => r.kind === 'account' && r.stage === 'intro' && r.status === 'open');
  if (intro[0]) intro[0].next = { type: 'call', due: new Date(nowT + 8 * MIN).toISOString(), timed: true, contactId: intro[0].primaryContactId, note: 'Asked to call back after their meeting' };
  if (intro[1]) intro[1].next = { type: 'call', due: new Date(nowT - 50 * MIN).toISOString(), timed: true, contactId: intro[1].primaryContactId };
  return { team, records };
}
