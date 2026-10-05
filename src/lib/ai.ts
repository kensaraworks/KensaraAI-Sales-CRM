/**
 * AI helpers. Calls go through the backend (keys never reach the browser) to free-tier Gemini,
 * with Groq as a fallback. Every helper has an offline fallback so nothing breaks without AI.
 */
import type { Account, Activity, Contact, Settings } from './types';
import { post } from './api';
import { store } from './store';
import { OUTCOMES, OUTCOME } from './outcomes';
import { parseTime } from './timeparse';
import { splitEmails, splitPhones, normPhone, normUrl } from './phone';
import { template, type Lang, type Purpose, type Tone } from './templates';
import { fmtWhen } from './util';
import { STAGES, LOST_REASONS } from './defaults';

let offUntil = 0;

async function ask(prompt: string, o: { system?: string; json?: boolean; search?: boolean; temperature?: number } = {}): Promise<{ text: string; sources?: string[] } | null> {
  if (!store.settings.ai.enabled || Date.now() < offUntil) return null;
  try {
    const r = await post({ action: 'ai', token: store.token, prompt, ...o }, 2);
    if (r.ok && r.text) return { text: r.text, sources: r.sources };
    if (r.error === 'ai-off') offUntil = Date.now() + 10 * 60e3;
    return null;
  } catch {
    return null;
  }
}

/** Pull the first JSON object/array out of a model reply. */
export function looseJSON<T = any>(s: string): T | null {
  const m = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = (m ? m[1] : s).trim();
  for (const [o, c] of [['{', '}'], ['[', ']']]) {
    const i = body.indexOf(o), j = body.lastIndexOf(c);
    if (i >= 0 && j > i) { try { return JSON.parse(body.slice(i, j + 1)); } catch { /* next */ } }
  }
  return null;
}

const nowLine = () => {
  const d = new Date();
  return `${d.toLocaleString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', hour: 'numeric', minute: '2-digit' })} (India time)`;
};

function context(a: Account, contacts: Contact[], acts: Activity[]) {
  const who = (id?: string) => contacts.find((c) => c.id === id);
  const people = contacts.map((c) => `- ${c.name}${c.designation ? `, ${c.designation}` : ''}${c.role !== 'unknown' ? ` [${c.role}]` : ''}${c.referredBy ? ` (referred by ${who(c.referredBy)?.name || 'someone'})` : ''}${c.status !== 'active' ? ` (${c.status})` : ''}`).join('\n');
  const hist = acts.slice(0, 12).map((x) => `- ${fmtWhen(x.at)}: ${x.channel}${x.outcome ? ` · ${OUTCOME.get(x.outcome)?.label}` : ''}${x.contactId ? ` · with ${who(x.contactId)?.name || '?'}` : ''}${x.note ? ` · "${x.note.slice(0, 200)}"` : ''}`).join('\n');
  return `Company: ${a.name}${a.city ? `, ${a.city}` : ''}${a.sector ? ` · ${a.sector}` : ''}
Stage: ${STAGES.find((s) => s.id === a.stage)?.label} · status ${a.status} · warmth ${a.heat} (-2..3)
People:\n${people || '- none recorded'}
Recent history (newest first):\n${hist || '- no activity yet'}`;
}

/* ------------------------------------------------------------------ voice / text note → outcome */

export interface ParsedNote {
  outcome?: string;
  time?: string;
  timed?: boolean;
  newContact?: { name: string; designation?: string; phone?: string; email?: string; direction?: 'we-call' | 'they-call' };
  share?: 'whatsapp' | 'email' | 'both';
  reason?: string;
  sentiment?: number;
  summary?: string;
  via: 'ai' | 'rules';
}

export async function parseNote(text: string, a: Account, contacts: Contact[], acts: Activity[]): Promise<ParsedNote> {
  const local = parseLocal(text, store.settings);
  const r = await ask(
    `Now: ${nowLine()}\n\n${context(a, contacts, acts)}\n\nSalesperson's note about the latest interaction (may be English, Hindi or Hinglish, possibly from speech-to-text):\n"""${text}"""\n\n` +
      `Pick the single best outcome id from:\n${OUTCOMES.map((o) => `${o.id}: ${o.label}`).join('\n')}\n\n` +
      `Lost reasons: ${LOST_REASONS.join(' | ')}\n\n` +
      `Return JSON: {"outcome": id, "time": ISO-8601 local datetime with +05:30 offset or null (when to call/meet next, if mentioned), "timed": true if an exact clock time was given, ` +
      `"newContact": null or {"name","designation","phone","email","direction":"we-call"|"they-call"} if they referred us to someone, "share": "whatsapp"|"email"|"both"|null, ` +
      `"reason": lost reason or null, "sentiment": -2..2, "summary": one clean sentence in English for the CRM log}`,
    { json: true, temperature: 0.1, system: 'You turn messy sales-call notes into structured CRM updates for an Indian B2B sales team. Be precise; never invent phone numbers or names that are not in the note.' },
  );
  const j = r && looseJSON<any>(r.text);
  if (!j || !OUTCOME.has(j.outcome)) return local;
  const phone = j.newContact?.phone ? normPhone(j.newContact.phone) : undefined;
  return {
    outcome: j.outcome,
    time: j.time && !Number.isNaN(Date.parse(j.time)) ? new Date(j.time).toISOString() : local.time,
    timed: j.time ? !!j.timed : local.timed,
    newContact: j.newContact?.name ? { ...j.newContact, phone, direction: j.newContact.direction === 'they-call' ? 'they-call' : 'we-call' } : local.newContact,
    share: j.share || local.share,
    reason: j.reason || local.reason,
    sentiment: typeof j.sentiment === 'number' ? j.sentiment : undefined,
    summary: j.summary,
    via: 'ai',
  };
}

/** Rule-based fallback: keywords (English + Hinglish) and the local time parser. */
export function parseLocal(text: string, s: Settings): ParsedNote {
  const t = ` ${text.toLowerCase()} `;
  const tm = parseTime(text, new Date(), s);
  const phones = splitPhones(text);
  const emails = splitEmails(text);
  const has = (re: RegExp) => re.test(t);
  let outcome: string | undefined;
  let share: ParsedNote['share'];
  let reason: string | undefined;
  let newContact: ParsedNote['newContact'];

  if (has(/wrong number|galat number|incorrect number|number (is )?not (correct|valid)/)) outcome = 'wrong-number';
  else if (has(/not interested|no need|nahi chahiye|don'?t call|do not call|not required|no requirement|mat karo call/)) {
    outcome = 'not-interested';
    reason = has(/already|vendor|in-?house|existing/) ? LOST_REASONS[0] : has(/budget|cost|expensive|paisa/) ? LOST_REASONS[1] : has(/don'?t call|do not call|mat karo/) ? LOST_REASONS[3] : 'Other';
  } else if (has(/switch(ed)? off|not reachable|unreachable|out of (coverage|network)|band (hai|tha)/)) outcome = 'switched-off';
  else if (has(/(after|in|next) (\d+|few|couple of|two|three|six) months|next quarter|new financial year|after march|budget (cycle|next)|abhi nahi|not now|later this year/)) outcome = 'not-now';
  else if (has(/\b(won|signed|confirmed|go ahead|proceed(ing)?|po (issued|received)|agreed)\b.*(assessment|engagement|proposal)?/) && !has(/not /)) outcome = 'won';
  else if (has(/(meeting|discovery|demo|call) (booked|fixed|scheduled|set)|book(ed)? (a |the )?(discovery|meeting|demo)|schedule(d)? (a |the )?(meeting|discovery|demo)/)) outcome = 'discovery-booked';
  else if (has(/(connect(ed)?|transfer(red)?|refer(red)?|talk to|speak (to|with)|baat karo|contact (karo|him|her)|gave (me |us )?(the )?(number|contact)|handles? this|is the right person)/) || (phones.length && has(/\b(mr|ms|mrs|sir|madam|ji)\b/))) {
    outcome = 'referred';
    const nm = text.match(/\b(?:[Mm]rs?|[Mm]s|[Dd]r|[Ss]hri|[Ss]mt)\.?\s+([A-Z][a-z]+(?:\s[A-Z][a-z]+)?)/) || text.match(/\b(?:talk to|speak (?:to|with)|connect (?:to|with)|name is|named)\s+([A-Z][a-z]+(?:\s[A-Z][a-z]+)?)/i);
    const des = text.match(/\b(ceo|cfo|cto|cio|ciso|coo|md|managing director|director|founder|owner|head(?: of)? [a-z]+|it head|it manager|compliance (?:head|officer|manager)|dpo|legal head|hr head|vp [a-z]+|manager)\b/i);
    newContact = { name: nm ? nm[1] : '', designation: des ? des[1].toUpperCase().length <= 4 ? des[1].toUpperCase() : des[1] : '', phone: phones[0], email: emails[0], direction: has(/(will|would) call (us|back|me)|they('| wi)ll call|call karenge|wo call karenge/) ? 'they-call' : 'we-call' };
  } else if (has(/(send|share|mail|forward|whatsapp)\b.*(details|deck|profile|brochure|proposal|info|presentation)|(details|profile|deck|brochure).*(bhej|send|share|whatsapp|mail)|whatsapp (karo|kar do|it)|mail (karo|kar do)/)) {
    outcome = 'pitched-share';
    const wa = has(/whatsapp|wa\b|watsapp/), em = has(/e-?mail|mail\b/);
    share = wa && em ? 'both' : em ? 'email' : 'whatsapp';
  } else if (has(/(got|received|mil gay[ai]|saw|seen) (it|the|your|details|deck)|will (go through|check|review|look)|dekh (lenge|leta|lungi|lunga)/)) outcome = 'ack';
  else if (has(/question|doubt|query|clarif|confus|sawal/)) outcome = 'questions';
  else if (has(/interested|sounds good|let'?s (talk|connect|meet)|keen|achha laga|want(s)? to know more/)) outcome = 'interested';
  else if (has(/no answer|not pick|didn'?t pick|did not pick|uthaya nahi|no response on call|ringing|not answering|unanswered/)) outcome = 'no-answer';
  else if (has(/reception|front desk|operator|gatekeeper|won'?t connect|did not connect|not connecting/)) outcome = 'gatekeeper';
  else if (has(/busy|in a meeting|meeting mein|driving|travel(l)?ing|cut the call|disconnect|call (me )?(back|later)|baad mein|later|kal call|callback/)) outcome = tm?.timed ? 'callback' : tm ? 'call-later' : 'busy';
  else if (has(/no reply|no response|not respond|ghost|seen but/)) outcome = 'no-response';
  else if (has(/needs? time|think about it|discuss internally|get back to (us|me)|soch/)) outcome = 'needs-time';

  if (!outcome && tm && has(/call|baat|connect|reach|phone|ring/)) outcome = tm.timed ? 'callback' : 'call-later';
  if (outcome === 'call-later' && tm?.timed) outcome = 'callback';
  return {
    outcome, time: tm?.date.toISOString(), timed: tm?.timed, newContact, share, reason,
    sentiment: has(/interested|great|positive|keen|happy|good/) ? 1 : has(/rude|angry|irritat|annoy/) ? -2 : undefined,
    summary: undefined, via: 'rules',
  };
}

/* ------------------------------------------------------------------ messages */

export async function compose(o: { a: Account; c?: Contact; referrer?: Contact; contacts: Contact[]; acts: Activity[]; purpose: Purpose; label: string; channel: 'whatsapp' | 'email'; tone: Tone; lang: Lang }) {
  const s = store.settings;
  const me = store.me?.name || 'Team';
  const fallback = template(o.purpose, { a: o.a, c: o.c, referrer: o.referrer, s, me, tone: o.tone, lang: o.lang, when: o.a.next?.type === 'discovery' ? fmtWhen(o.a.next.due) : undefined });
  const r = await ask(
    `What we sell:\n${s.pitch}\nLinks we may include: ${[s.links.deck && `deck ${s.links.deck}`, s.links.website && `website ${s.links.website}`, s.links.booking && `booking ${s.links.booking}`].filter(Boolean).join(', ') || 'none'}\n\n` +
      `${context(o.a, o.contacts, o.acts)}\n\nWrite a ${o.channel === 'whatsapp' ? 'WhatsApp message (short, 40–90 words, no subject, line breaks ok, at most one emoji)' : 'business email (90–160 words, with a subject line)'} ` +
      `to ${o.c?.name || 'the contact'}${o.c?.designation ? ` (${o.c.designation})` : ''}. Purpose: ${o.label}. Tone: ${o.tone}. Language: ${o.lang === 'Hinglish' ? 'Hinglish (Hindi in Latin script mixed with English, as Indian professionals write on WhatsApp)' : o.lang === 'Hindi' ? 'Hindi in Devanagari script' : 'Indian business English'}. ` +
      `Match the warmth to the history above — acknowledge what they said last. No fake claims, no made-up numbers or clients. Sign off as ${me}, ${s.signature}.\n\nReturn JSON {"subject": "...", "body": "..."}`,
    { json: true, temperature: 0.7, system: 'You write concise, human, respectful sales messages for an Indian B2B audience. Never pushy. Never invent facts.' },
  );
  const j = r && looseJSON<any>(r.text);
  if (j?.body) return { subject: j.subject || fallback.subject, body: String(j.body).trim(), via: 'ai' as const };
  return { ...fallback, via: 'template' as const };
}

/* ------------------------------------------------------------------ pre-call brief */

export async function brief(a: Account, contacts: Contact[], acts: Activity[]): Promise<{ text: string; via: 'ai' | 'rules' }> {
  const r = await ask(
    `${context(a, contacts, acts)}\n\nNow: ${nowLine()}\nWhat we sell: ${store.settings.pitch}\n\nWrite a pre-call brief for the salesperson in at most 5 short bullet lines: who to ask for and why, what happened so far (who referred whom), ` +
      `the one goal of this call, a natural opening line (they may prefer Hinglish), and one watch-out. Plain text bullets starting with "• ".`,
    { temperature: 0.4, system: 'You are a sharp sales coach for an Indian B2B team. Be brief and concrete.' },
  );
  if (r?.text) return { text: r.text.trim(), via: 'ai' };
  return { text: ruleBrief(a, contacts, acts), via: 'rules' };
}

function ruleBrief(a: Account, contacts: Contact[], acts: Activity[]): string {
  const target = contacts.find((c) => c.id === a.next?.contactId) || contacts.find((c) => c.id === a.primaryContactId) || contacts[0];
  const ref = target?.referredBy ? contacts.find((c) => c.id === target.referredBy) : undefined;
  const last = acts[0];
  const lines = [
    target ? `• Ask for ${target.name}${target.designation ? ` (${target.designation})` : ''}${ref ? ` — referred by ${ref.name}` : ''}` : '• No named contact yet — ask who handles data privacy / IT compliance',
    last ? `• Last: ${OUTCOME.get(last.outcome || '')?.label || last.channel} ${fmtWhen(last.at)}${last.note ? ` — "${last.note.slice(0, 90)}"` : ''}` : '• First call to this company',
    `• Goal: ${a.next?.type === 'remind' ? 'confirm they got the details and offer a walkthrough' : a.stage === 'engaged' ? 'book the 30-min discovery call' : a.stage === 'shared' ? 'get a reaction to the details and move to a discovery call' : 'reach the decision maker and get permission to share details'}`,
    a.attempts >= 2 ? `• ${a.attempts} unanswered tries — keep it short, or drop a WhatsApp first` : `• Opener: "Namaste, I'm ${store.me?.name} from KensaraAI — is this a good time for 2 minutes?"`,
  ];
  return lines.join('\n');
}

/* ------------------------------------------------------------------ import column mapping */

export async function aiMapColumns(headers: string[], samples: string[][], fields: { id: string; label: string }[]): Promise<Record<string, string> | null> {
  const r = await ask(
    `Spreadsheet columns with sample values:\n${headers.map((h, i) => `${i}. "${h}": ${samples.map((row) => JSON.stringify(row[i] ?? '')).join(', ')}`).join('\n')}\n\n` +
      `Map each column to one of these CRM fields (or "extra" to keep it as a custom field, or "skip" for junk):\n${fields.map((f) => `${f.id}: ${f.label}`).join('\n')}\n\nReturn JSON {"<column index>": "<field id>"}`,
    { json: true, temperature: 0, system: 'You map messy spreadsheet columns to CRM fields. Indian business data.' },
  );
  const j = r && looseJSON<Record<string, string>>(r.text);
  return j && typeof j === 'object' ? j : null;
}

/* ------------------------------------------------------------------ find public business contact details */

export interface Found { phones: string[]; emails: string[]; website?: string; sources: string[]; note?: string }

export async function enrich(a: Account): Promise<Found | null> {
  const r = await ask(
    `Find the publicly listed business contact details for the company "${a.name}"${a.city ? ` in ${a.city}` : ''}, India${a.website ? ` (website ${a.website})` : ''}${a.sector ? `, sector ${a.sector}` : ''}.\n` +
      `Only include official office / board numbers and generic company emails that the company itself publishes (its website, Google Business profile) or that appear in reputable business directories. ` +
      `Do not include personal mobile numbers of individuals unless the company publishes them as its business contact.\n` +
      `Return ONLY JSON: {"phones": ["+91..."], "emails": ["..."], "website": "https://...", "note": "where you found it and how confident you are"}. Use empty arrays if nothing reliable is found.`,
    { search: true, temperature: 0 },
  );
  if (!r) return null;
  const j = looseJSON<any>(r.text) || {};
  const phones = (j.phones || []).flatMap((p: string) => splitPhones(String(p))).filter((p: string) => !(a.badPhones || []).includes(p) && !a.phones.includes(p));
  const emails = (j.emails || []).flatMap((e: string) => splitEmails(String(e))).filter((e: string) => !a.emails.includes(e));
  return { phones: [...new Set<string>(phones)].slice(0, 4), emails: [...new Set<string>(emails)].slice(0, 4), website: normUrl(j.website || '') || undefined, sources: (r.sources || []).slice(0, 5), note: j.note };
}

export const googleSearchUrl = (a: Account) => `https://www.google.com/search?q=${encodeURIComponent(`${a.name} ${a.city || ''} contact number`)}`;

/* ------------------------------------------------------------------ quick add by voice */

export interface LeadDraft { company: string; city: string; sector: string; contactName: string; designation: string; phone: string; email: string }

export async function extractLead(text: string): Promise<Partial<LeadDraft>> {
  const phones = splitPhones(text), emails = splitEmails(text);
  const base: Partial<LeadDraft> = { phone: phones[0] || '', email: emails[0] || '' };
  const r = await ask(
    `Extract a new sales lead from this dictated note (Indian context, may be Hinglish):\n"""${text}"""\nReturn JSON {"company","city","sector","contactName","designation","phone","email"} with empty strings for anything not mentioned. Never invent values.`,
    { json: true, temperature: 0 },
  );
  const j = r && looseJSON<any>(r.text);
  if (!j) {
    const m = text.match(/^(.*?)(?:,|\bin\b|\bfrom\b)\s*([A-Z][a-z]+)?/);
    return { ...base, company: m?.[1]?.trim() || text.split(/[,.]/)[0].trim(), city: m?.[2] || '' };
  }
  return { ...j, phone: j.phone ? normPhone(j.phone) : base.phone, email: j.email || base.email };
}
