/** Data model shared by the app, the in-browser mock and apps-script/Code.gs (keep in sync). */

export type ID = string;
export type Kind = 'account' | 'contact' | 'activity';

/** Server-managed fields on every record. */
export interface Base {
  id: ID;
  kind: Kind;
  rev: number;
  createdAt: string;
  createdBy: ID;
  updatedAt: string;
  updatedBy: ID;
  /** Hidden from everyone's views (team "remove" / undo of a create). */
  voided?: boolean;
}

export type StageId = 'new' | 'intro' | 'shared' | 'engaged' | 'discovery' | 'assessment';
export type Status = 'open' | 'won' | 'lost' | 'parked';
export type ActionType = 'call' | 'send' | 'remind' | 'followup' | 'discovery' | 'find-number';
export type Channel = 'call' | 'whatsapp' | 'email' | 'meeting' | 'note';

export interface NextAction {
  type: ActionType;
  due: string;
  contactId?: ID;
  note?: string;
  /** The prospect asked for this exact time — treat as a promise. */
  timed?: boolean;
  /** Explicit assignee (otherwise routed by stage allocation). */
  assignee?: ID;
  /** Preferred channel for follow-ups. */
  channel?: Channel;
}

export interface Account extends Base {
  kind: 'account';
  name: string;
  city?: string;
  state?: string;
  sector?: string;
  website?: string;
  size?: string;
  address?: string;
  linkedin?: string;
  phones: string[];
  emails: string[];
  /** Columns from imports that don't map to a known field. */
  extra: Record<string, string>;
  stage: StageId;
  status: Status;
  lostReason?: string;
  owner?: ID;
  /** Who is working the lead right now (admin assignment or stage hand-off). */
  handler?: ID | null;
  primaryContactId?: ID;
  next?: NextAction | null;
  /** Unanswered attempts in a row on the current contact. */
  attempts: number;
  /** Position in the follow-up cadence. */
  cadence: number;
  /** -2 (cold / negative) … +3 (hot). */
  heat: number;
  tags: string[];
  source?: string;
  /** Phones marked as wrong — kept so they're never re-suggested. */
  badPhones?: string[];
  /** Enrichment suggestions awaiting review. */
  found?: { phones: string[]; emails: string[]; website?: string; sources: string[]; at: string; note?: string } | null;
  brief?: { text: string; at: string } | null;
}

export type ContactRole = 'decision-maker' | 'influencer' | 'gatekeeper' | 'unknown';

export interface Contact extends Base {
  kind: 'contact';
  accountId: ID;
  name: string;
  designation?: string;
  phones: string[];
  emails: string[];
  role: ContactRole;
  referredBy?: ID;
  status: 'active' | 'wrong-number' | 'left';
  language?: string;
  notes?: string;
}

export interface Activity extends Base {
  kind: 'activity';
  accountId: ID;
  contactId?: ID;
  channel: Channel;
  outcome?: string;
  note?: string;
  transcript?: string;
  stageFrom?: StageId;
  stageTo?: StageId;
  statusTo?: Status;
  sentiment?: number;
  /** When it happened (client clock — activities can be logged offline). */
  at: string;
  /** Was this the planned next action, and was it done on time? */
  planned?: boolean;
  onTime?: boolean;
  points?: number;
  /** System entries (stage moves, imports, assignments) are shown smaller. */
  system?: boolean;
}

export type Rec = Account | Contact | Activity;
export interface Tombstone { id: ID; kind: Kind; rev: number; deleted: true }

/* ------------------------------------------------------------------ config */

export interface Member {
  id: ID;
  name: string;
  active: boolean;
  /** Stages this person works. Empty = no allocation (sees everything). */
  stages: StageId[];
  /** Per-person target overrides. */
  targets?: Partial<Record<TargetKey, number>>;
  /** Set by the admin: may move and edit any lead, not just their own (assigning stays admin-only). */
  editAll?: boolean;
  color?: string;
}

export type TargetKey = 'dials' | 'connects' | 'shared' | 'newLeads' | 'followupsOnTime' | 'discovery' | 'won';

export interface Target { on: boolean; value: number; per: 'day' | 'week' | 'month'; label: string }

export interface Settings {
  targets: Record<TargetKey, Target>;
  /** Follow-up cadence: days between touches and the channel for each. */
  cadence: { gaps: number[]; channels: Channel[]; nurtureDays: number };
  remindAfterMin: number;
  /** New outreach slows as overdue follow-ups approach this and stops at it. */
  backlogLimit: number;
  workDays: number[];
  workStart: string;
  workEnd: string;
  lunch: [string, string] | null;
  holidays: { date: string; name: string }[];
  fun: { points: boolean; leaderboard: boolean; confetti: boolean; streaks: boolean };
  /** Context fed to AI: what we sell, links to share. */
  pitch: string;
  links: { deck: string; website: string; booking: string };
  signature: string;
  ai: { enabled: boolean };
}

export interface Me { id: ID; name: string; x?: 1 }

/** Who is looking at / calling which account right now. */
export interface Claim { user: ID; until: number }

export interface SyncResponse {
  ok: true;
  seq: number;
  epoch: string;
  floor: number;
  changes: (Rec | Tombstone)[];
  applied: Record<string, number>;
  rejected?: { oid: string; error: string }[];
  cfgRev: number;
  settings?: Settings;
  team?: Member[];
  claims?: Record<ID, Claim>;
  full?: boolean;
}

export type Op =
  | { oid: string; t: 'put'; kind: Kind; id: ID; data: Record<string, any> }
  | { oid: string; t: 'set'; kind: Kind; id: ID; set: Record<string, any> }
  | { oid: string; t: 'del'; kind: Kind; id: ID };

export interface AuditRow { seq: number; at: string; by: ID; op: string; kind: Kind; id: ID; changes: Record<string, [any, any]> }
