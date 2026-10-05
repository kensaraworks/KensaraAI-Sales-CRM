import type { Settings, StageId } from './types';

export const STAGES: { id: StageId; label: string; short: string; hint: string }[] = [
  { id: 'new', label: 'New', short: 'New', hint: 'Not contacted yet' },
  { id: 'intro', label: 'Intro call', short: 'Intro', hint: 'Reaching the right person' },
  { id: 'shared', label: 'Details shared', short: 'Shared', hint: 'Deck sent, waiting for a read' },
  { id: 'engaged', label: 'Engaged', short: 'Warm', hint: 'Interested — book a discovery call' },
  { id: 'discovery', label: 'Discovery', short: 'Discovery', hint: '30-min call with our experts' },
  { id: 'assessment', label: 'Gap assessment', short: 'Won', hint: 'Proceeding — converted' },
];

export const stageIndex = (s: StageId) => STAGES.findIndex((x) => x.id === s);
export const stageLabel = (s: StageId) => STAGES.find((x) => x.id === s)?.label ?? s;

export const LOST_REASONS = [
  'Already have a vendor / in-house team',
  'No budget right now',
  'Not relevant to their business',
  'Asked not to call again',
  'Company closed / unreachable',
  'Chose a competitor',
  'Other',
];

export const DEFAULT_SETTINGS: Settings = {
  targets: {
    dials: { on: true, value: 40, per: 'day', label: 'Calls made' },
    connects: { on: true, value: 12, per: 'day', label: 'Conversations' },
    shared: { on: true, value: 4, per: 'day', label: 'Details shared' },
    newLeads: { on: true, value: 20, per: 'day', label: 'New leads opened' },
    followupsOnTime: { on: true, value: 90, per: 'day', label: 'Follow-ups on time (%)' },
    discovery: { on: true, value: 3, per: 'week', label: 'Discovery calls booked' },
    won: { on: false, value: 2, per: 'month', label: 'Gap assessments won' },
  },
  // Value-led multi-touch cadence: gaps widen, channels alternate, ends with a polite "close the file?" note.
  cadence: {
    gaps: [2, 3, 3, 4, 7, 7, 14, 21],
    channels: ['call', 'whatsapp', 'call', 'email', 'call', 'whatsapp', 'call', 'email'],
    nurtureDays: 30,
  },
  remindAfterMin: 30,
  backlogLimit: 15,
  workDays: [1, 2, 3, 4, 5, 6],
  workStart: '10:00',
  workEnd: '18:30',
  lunch: ['13:15', '14:15'],
  holidays: [
    { date: '2026-10-02', name: 'Gandhi Jayanti' },
    { date: '2026-10-20', name: 'Dussehra' },
    { date: '2026-11-08', name: 'Diwali' },
    { date: '2026-11-09', name: 'Diwali (Govardhan Puja)' },
    { date: '2026-12-25', name: 'Christmas' },
    { date: '2027-01-26', name: 'Republic Day' },
  ],
  fun: { points: true, leaderboard: true, confetti: true, streaks: true },
  pitch:
    'KensaraAI helps enterprises get compliant with data-privacy laws (India DPDP Act, GDPR, UAE & Saudi PDPL). We start with a 30-minute discovery call, then a structured privacy gap assessment that maps their data practices, teams and systems and gives a prioritised remediation roadmap.',
  links: { deck: '', website: 'https://kensara.ai', booking: '' },
  signature: 'Team KensaraAI',
  ai: { enabled: true },
};

/** Merge stored settings over defaults so new fields always exist. */
export function withDefaults(s?: Partial<Settings> | null): Settings {
  const d = DEFAULT_SETTINGS;
  if (!s) return structuredClone(d);
  return {
    ...d,
    ...s,
    targets: Object.fromEntries(Object.entries(d.targets).map(([k, v]) => [k, { ...v, ...(s.targets as any)?.[k] }])) as Settings['targets'],
    cadence: { ...d.cadence, ...s.cadence },
    fun: { ...d.fun, ...s.fun },
    links: { ...d.links, ...s.links },
    ai: { ...d.ai, ...s.ai },
  };
}
