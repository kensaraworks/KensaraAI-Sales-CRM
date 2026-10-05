import type { Channel, StageId } from './types';

/** Extra inputs an outcome asks for before it can be saved. */
export type Need = 'time' | 'later' | 'contact' | 'reason' | 'share' | 'expert' | 'optTime';

export interface Outcome {
  id: string;
  label: string;
  icon: string;
  /** Stages where this outcome is offered first (others appear under "More"). */
  stages: StageId[];
  channel?: Channel;
  connected?: boolean;
  needs?: Need[];
  tone: 'great' | 'good' | 'neutral' | 'bad';
  points: number;
  hint?: string;
}

const CALLING: StageId[] = ['new', 'intro', 'shared', 'engaged'];

export const OUTCOMES: Outcome[] = [
  // ---- reaching someone
  { id: 'no-answer', label: 'No answer', icon: '📵', stages: [...CALLING, 'discovery'], tone: 'neutral', points: 1, hint: 'We\'ll retry at a better time' },
  { id: 'busy', label: 'Busy / cut the call', icon: '⏳', stages: CALLING, tone: 'neutral', points: 1 },
  { id: 'switched-off', label: 'Switched off / unreachable', icon: '📴', stages: CALLING, tone: 'neutral', points: 1 },
  { id: 'wrong-number', label: 'Wrong number', icon: '🚫', stages: CALLING, tone: 'bad', points: 1, hint: 'We\'ll find the right one' },
  { id: 'callback', label: 'Call back at…', icon: '🕓', stages: CALLING, connected: true, needs: ['time'], tone: 'good', points: 3, hint: 'They gave a time' },
  { id: 'call-later', label: 'Call later (no time given)', icon: '↪️', stages: CALLING, connected: true, needs: ['later'], tone: 'neutral', points: 3 },
  { id: 'referred', label: 'Referred to someone else', icon: '🔀', stages: CALLING, connected: true, needs: ['contact'], tone: 'good', points: 4, hint: 'Add the new person' },
  { id: 'gatekeeper', label: "Couldn't get past reception", icon: '🛡️', stages: ['new', 'intro'], connected: true, tone: 'neutral', points: 2 },
  { id: 'pitched-share', label: 'Pitched — send details', icon: '🎯', stages: ['new', 'intro', 'engaged'], connected: true, needs: ['share'], tone: 'great', points: 6, hint: 'Decision maker wants it on WhatsApp / email' },
  { id: 'interested', label: 'Interested — wants a call', icon: '🔥', stages: ['new', 'intro', 'shared'], connected: true, needs: ['optTime'], tone: 'great', points: 8 },

  // ---- after details are shared
  { id: 'sent', label: 'Details sent', icon: '📤', stages: ['shared'], channel: 'whatsapp', needs: ['share'], tone: 'good', points: 3, hint: 'Logs it and plans the reminder call' },
  { id: 'ack', label: 'Got it — will go through', icon: '👍', stages: ['shared'], connected: true, tone: 'good', points: 3 },
  { id: 'read-interested', label: 'Read it — interested', icon: '✨', stages: ['shared'], connected: true, needs: ['optTime'], tone: 'great', points: 6 },
  { id: 'questions', label: 'Has questions', icon: '❓', stages: ['shared', 'engaged'], connected: true, tone: 'good', points: 4 },
  { id: 'replied', label: 'They replied on WhatsApp / email', icon: '💬', stages: ['shared', 'engaged'], channel: 'whatsapp', tone: 'good', points: 3 },

  // ---- warm
  { id: 'discovery-booked', label: 'Discovery call booked', icon: '📅', stages: ['shared', 'engaged'], connected: true, needs: ['time', 'expert'], tone: 'great', points: 25 },
  { id: 'needs-time', label: 'Needs time to decide', icon: '🤔', stages: ['shared', 'engaged', 'discovery'], connected: true, tone: 'neutral', points: 2 },
  { id: 'no-response', label: 'No response to follow-up', icon: '🔇', stages: ['shared', 'engaged', 'discovery'], tone: 'neutral', points: 1 },

  // ---- discovery
  { id: 'won', label: 'Proceeding to gap assessment', icon: '🏆', stages: ['discovery', 'engaged'], connected: true, tone: 'great', points: 100 },
  { id: 'held-thinking', label: 'Discovery done — thinking', icon: '🧭', stages: ['discovery'], connected: true, tone: 'good', points: 10 },
  { id: 'rescheduled', label: 'Rescheduled', icon: '🔁', stages: ['discovery'], connected: true, needs: ['time'], tone: 'neutral', points: 2 },
  { id: 'no-show', label: 'No-show', icon: '👻', stages: ['discovery'], tone: 'bad', points: 1 },

  // ---- closing
  { id: 'not-now', label: 'Not now — reconnect later', icon: '🗓️', stages: [...CALLING, 'discovery'], connected: true, needs: ['later'], tone: 'neutral', points: 2, hint: 'Parks the lead until then' },
  { id: 'not-interested', label: 'Clear no', icon: '✋', stages: [...CALLING, 'discovery'], connected: true, needs: ['reason'], tone: 'bad', points: 2, hint: 'Closes the lead' },
  { id: 'msg-sent', label: 'Message sent', icon: '✉️', stages: [], channel: 'whatsapp', tone: 'neutral', points: 2, hint: 'Follow-up / nudge sent on WhatsApp or email' },
  { id: 'note', label: 'Just a note', icon: '📝', stages: [], channel: 'note', tone: 'neutral', points: 0 },
];

export const OUTCOME = new Map(OUTCOMES.map((o) => [o.id, o]));
export const CONNECTED = new Set(OUTCOMES.filter((o) => o.connected).map((o) => o.id));
/** Spoke to someone who can say yes. */
export const DM_OUTCOMES = new Set(['pitched-share', 'interested', 'read-interested', 'discovery-booked', 'won', 'held-thinking']);

export function outcomesFor(stage: StageId, nextType?: string): { primary: Outcome[]; more: Outcome[] } {
  let primary = OUTCOMES.filter((o) => o.stages.includes(stage));
  if (nextType === 'send') primary = [OUTCOME.get('sent')!, ...primary.filter((o) => o.id !== 'sent')];
  if (stage === 'shared' && nextType !== 'send') primary = primary.filter((o) => o.id !== 'sent').concat(OUTCOME.get('sent')!);
  const ids = new Set(primary.map((o) => o.id));
  return { primary, more: OUTCOMES.filter((o) => !ids.has(o.id)) };
}
