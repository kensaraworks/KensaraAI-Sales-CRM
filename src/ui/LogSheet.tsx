import { useEffect, useMemo, useState } from 'preact/hooks';
import type { Account, Channel, Contact, ID, NextAction } from '../lib/types';
import { store, useStore } from '../lib/store';
import { OUTCOME, outcomesFor, type Outcome } from '../lib/outcomes';
import { describeNext, planOutcome, type NewContactInput, type OutcomeInput } from '../lib/workflow';
import { parseNote } from '../lib/ai';
import { parseTime } from '../lib/timeparse';
import { addWorkDays, assigneeOf, clampToWork } from '../lib/schedule';
import { LOST_REASONS } from '../lib/defaults';
import { fmtWhen, startOfDay, toLocalInput, DAY, HOUR } from '../lib/util';
import { normPhone, prettyPhone, isEmail } from '../lib/phone';
import { Icon, NoteField, Seg, Sheet, Spinner, VoiceCapture } from './components';
import { celebrate, openCompose, set, toast, ui, useUI } from './bus';

export function LogSheet() {
  const u = useUI();
  if (!u.log) return null;
  const a = store.get<Account>(u.log.accountId);
  if (!a) return null;
  const close = () => set({ log: null });
  return (
    <Sheet title={<span>Log · <span class="muted">{a.name}</span></span>} onClose={close} wide>
      <LogForm account={a} preset={u.log} onSaved={close} />
    </Sheet>
  );
}

interface Props {
  account: Account;
  preset?: { outcome?: string; contactId?: ID; text?: string };
  onSaved: (outcome: string) => void;
  compact?: boolean;
}

export function LogForm({ account: a, preset, onSaved, compact }: Props) {
  const s = useStore();
  const contacts = (s.contactsBy().get(a.id) || []).filter((c) => c.status !== 'left');
  const acts = s.actsBy().get(a.id) || [];
  const defaultContact = contacts.find((c) => c.id === a.next?.contactId) || contacts.find((c) => c.id === a.primaryContactId) || contacts[0];

  const [outcome, setOutcome] = useState<string | undefined>(preset?.outcome);
  const [contactId, setContactId] = useState<ID | undefined>(preset?.contactId || defaultContact?.id);
  const [channel, setChannel] = useState<Channel | null>(null);
  const [note, setNote] = useState('');
  const [transcript, setTranscript] = useState('');
  const [time, setTime] = useState<Date | null>(null);
  const [timeText, setTimeText] = useState('');
  const [reason, setReason] = useState(LOST_REASONS[0]);
  const [share, setShare] = useState<'whatsapp' | 'email' | 'both'>('whatsapp');
  const [shareEmail, setShareEmail] = useState('');
  const [nc, setNc] = useState<NewContactInput>({ name: '', designation: '', phone: '', email: '', direction: 'we-call' });
  const [expert, setExpert] = useState<ID | undefined>(s.team.find((m) => m.active && m.stages.includes('discovery'))?.id);
  const [phone, setPhone] = useState<string | undefined>();
  const [more, setMore] = useState(false);
  const [thinking, setThinking] = useState(false);
  const [aiNote, setAiNote] = useState('');
  const [override, setOverride] = useState<{ due: string } | null | 'none'>(null);

  const contact = contacts.find((c) => c.id === contactId);
  const o: Outcome | undefined = outcome ? OUTCOME.get(outcome) : undefined;
  const { primary, more: rest } = outcomesFor(a.stage, a.next?.type);
  const needs = new Set(o?.needs || []);
  const phones = [...(contact?.phones || []), ...a.phones];

  useEffect(() => { if (preset?.text) handleVoice(preset.text); }, []);

  // Keyboard: 1–9 picks an outcome, Ctrl/⌘+Enter saves.
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName;
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); save(); return; }
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      const n = Number(e.key);
      if (n >= 1 && n <= 9 && primary[n - 1]) { e.preventDefault(); pick(primary[n - 1].id); }
    };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  });

  const pick = (id: string) => {
    setOutcome(id);
    setOverride(null);
    const oc = OUTCOME.get(id)!;
    if (oc.channel) setChannel(oc.channel === 'whatsapp' && id === 'sent' ? (share === 'email' ? 'email' : 'whatsapp') : oc.channel);
  };

  async function handleVoice(text: string) {
    setTranscript(text);
    setThinking(true);
    const p = await parseNote(text, a, contacts, acts);
    setThinking(false);
    if (p.outcome) pick(p.outcome);
    if (p.time) { setTime(new Date(p.time)); setTimeText(''); }
    if (p.newContact) setNc((x) => ({ ...x, ...p.newContact, phone: p.newContact!.phone ? prettyPhone(p.newContact!.phone) : x.phone, direction: p.newContact!.direction || 'we-call' }));
    if (p.share) setShare(p.share);
    if (p.reason) setReason(LOST_REASONS.includes(p.reason) ? p.reason : 'Other');
    setNote((n) => n || p.summary || text);
    setAiNote(p.outcome ? `Understood${p.via === 'ai' ? '' : ' (offline)'}: ${OUTCOME.get(p.outcome)?.label}${p.time ? ` · ${fmtWhen(p.time)}` : ''}${p.newContact?.name ? ` · new contact ${p.newContact.name}` : ''}` : "Couldn't tell the outcome — pick one below");
  }

  const input: OutcomeInput | null = useMemo(() => {
    if (!o) return null;
    return {
      outcome: o.id, account: a, contact, phone, channel: channel ?? o.channel ?? 'call', note, transcript, time, reason, share,
      newContact: o.id === 'referred' && nc.name.trim() ? { ...nc, phone: normPhone(nc.phone || '') || undefined, email: nc.email?.trim() || undefined } : null,
      expert,
    };
  }, [o, a, contact, phone, channel, note, transcript, time, reason, share, nc, expert]);

  const plan = useMemo(() => {
    if (!input) return null;
    try { return planOutcome(input, { settings: s.settings, model: s.model(), load: s.load(), team: s.team, me: s.me!.id }); } catch (e) { console.error(e); return null; }
  }, [input, s.version]);

  const finalNext: NextAction | null = !plan ? null : override === 'none' ? null : override ? { ...(plan.next || { type: 'call' }), due: new Date(override.due).toISOString() } as NextAction : plan.next;

  const missing = !o ? 'Pick what happened'
    : needs.has('time') && !time ? 'When?'
    : needs.has('contact') && !nc.name.trim() ? 'Who were you referred to?'
    : needs.has('share') && (share === 'email' || share === 'both') && !hasEmail(a, contact) && !isEmail(shareEmail) ? 'Their email?'
    : '';

  function save() {
    if (!plan || !input || missing) return;
    const p = { ...plan, next: finalNext, account: { ...plan.account, next: finalNext } };
    if (isEmail(shareEmail) && contact && !contact.emails.includes(shareEmail.trim().toLowerCase())) {
      p.contact = { id: contact.id, set: { ...(p.contact?.id === contact.id ? p.contact.set : {}), emails: [...contact.emails, shareEmail.trim().toLowerCase()] } };
    } else if (isEmail(shareEmail) && !contact) {
      p.account = { ...p.account, emails: [...a.emails, shareEmail.trim().toLowerCase()] };
    }
    s.commitPlan(p, input, `${o!.label} · ${a.name}`);
    const pts = s.settings.fun.points ? p.points : 0;
    if (p.celebrate) celebrate(p.celebrate === 'big');
    const after = { ...a, ...p.account } as Account;
    const who = finalNext ? assigneeOf(after, s.team) : null;
    const handoff = who && who !== s.me!.id ? ` — over to ${s.nameOf(who)}` : '';
    toast(`${o!.label}. ${describeNext(finalNext)}${handoff}`, { undo: true, points: pts || undefined });
    onSaved(o!.id);
    // Asked for details and it's ours to send → open the composer straight away.
    if (o!.id === 'pitched-share' && (!who || who === s.me!.id)) setTimeout(() => openCompose(a.id, 'details', share === 'email' ? 'email' : 'whatsapp'), 250);
  }

  const now = new Date();
  const quickTimes: [string, Date][] = [
    ['In 1 hour', new Date(now.getTime() + HOUR)],
    ['In 2 hours', new Date(now.getTime() + 2 * HOUR)],
    ['Today 5 PM', at(now, 17)],
    ['Tomorrow 11 AM', at(addWorkDays(now, 1, s.settings), 11)],
    ['Tomorrow 4 PM', at(addWorkDays(now, 1, s.settings), 16)],
    ['Next Mon 11 AM', at(nextMonday(now), 11)],
  ].filter(([, d]) => (d as Date).getTime() > now.getTime()) as [string, Date][];
  const upcomingHoliday = s.settings.holidays.find((h) => new Date(h.date) > now && new Date(h.date).getTime() - now.getTime() < 75 * DAY);
  const laterChoices: [string, Date][] = [
    ['Tomorrow', at(addWorkDays(now, 1, s.settings), 11)],
    ['Next week', at(nextMonday(now), 11)],
    ['In 2 weeks', at(new Date(now.getTime() + 14 * DAY), 11)],
    ['In 1 month', at(new Date(now.getTime() + 30 * DAY), 11)],
    ['In 3 months', at(new Date(now.getTime() + 91 * DAY), 11)],
    ...(upcomingHoliday ? [[`After ${upcomingHoliday.name}`, at(addWorkDays(new Date(upcomingHoliday.date), 2, s.settings), 11)] as [string, Date]] : []),
    ['New FY (April)', at(new Date(now.getMonth() >= 3 ? now.getFullYear() + 1 : now.getFullYear(), 3, 6), 11)],
  ];
  const timeOptions = needs.has('later') ? laterChoices : quickTimes;

  return (
    <div class="col" style={{ gap: '14px' }}>
      <VoiceCapture onFinal={handleVoice} />
      {(thinking || aiNote) && (
        <div class="row small" style={{ color: 'var(--accent-ink)' }}>
          {thinking ? <><Spinner /> Understanding…</> : <><Icon n="sparkle" size={15} /> {aiNote}</>}
        </div>
      )}

      {contacts.length > 0 && (
        <div class="row wrap">
          <span class="small muted">With</span>
          {contacts.map((c) => (
            <button type="button" class={`chip ${c.id === contactId ? 'is-on' : ''}`} onClick={() => setContactId(c.id)}>
              {c.name.split(' ')[0]}{c.designation ? ` · ${c.designation}` : ''}
            </button>
          ))}
          <button type="button" class={`chip ${!contactId ? 'is-on' : ''}`} onClick={() => setContactId(undefined)}>Company line</button>
        </div>
      )}

      <div>
        <div class="oc-grid">
          {primary.map((x, i) => <OutcomeBtn o={x} on={outcome === x.id} k={i < 9 ? String(i + 1) : ''} onClick={() => pick(x.id)} />)}
          {more && rest.filter((x) => x.id !== 'note' || !compact).map((x) => <OutcomeBtn o={x} on={outcome === x.id} onClick={() => pick(x.id)} />)}
        </div>
        <button type="button" class="btn btn--ghost btn--sm" style={{ marginTop: '6px' }} onClick={() => setMore(!more)}>
          {more ? 'Fewer options' : `More options (${rest.length})`}
        </button>
      </div>

      {o && (needs.has('time') || needs.has('optTime') || needs.has('later')) && (
        <div class="col" style={{ gap: '6px' }}>
          <span class="small muted">{needs.has('later') ? 'Reconnect when?' : needs.has('optTime') ? 'Meeting time (if agreed)' : o.id.startsWith('discovery') || o.id === 'rescheduled' ? 'Discovery call at' : 'When should we call?'}</span>
          <div class="quick">
            {timeOptions.map(([l, d]) => (
              <button type="button" class={`chip ${time && Math.abs(time.getTime() - d.getTime()) < 60000 ? 'is-on' : ''}`} onClick={() => setTime(d)}>{l}</button>
            ))}
          </div>
          <div class="grid2">
            <input class="input" placeholder='Or type: "kal saade 4", "Thu after lunch"' value={timeText}
              onInput={(e) => { const v = (e.target as HTMLInputElement).value; setTimeText(v); const p = parseTime(v, new Date(), s.settings); if (p) setTime(p.date); }} />
            <input class="input" type="datetime-local" value={time ? toLocalInput(time) : ''} onInput={(e) => { const v = (e.target as HTMLInputElement).value; setTime(v ? new Date(v) : null); }} />
          </div>
          {time && <span class="small">→ <b>{fmtWhen(time)}</b>{!isWorkTime(time) && <span class="muted"> · outside working hours</span>}</span>}
        </div>
      )}

      {o?.id === 'wrong-number' && phones.length > 1 && (
        <div class="row wrap"><span class="small muted">Which number?</span>
          {phones.map((p) => <button type="button" class={`chip ${(phone || phones[0]) === p ? 'is-on' : ''}`} onClick={() => setPhone(p)}>{prettyPhone(p)}</button>)}
        </div>
      )}

      {needs.has('contact') && (
        <div class="card card--pad col" style={{ gap: '10px' }}>
          <div class="grid2">
            <label class="field"><span>Name</span><input class="input" value={nc.name} placeholder="Mr. Rao" onInput={(e) => setNc({ ...nc, name: (e.target as HTMLInputElement).value })} /></label>
            <label class="field"><span>Designation</span><input class="input" value={nc.designation} placeholder="CFO / IT Head" onInput={(e) => setNc({ ...nc, designation: (e.target as HTMLInputElement).value })} /></label>
            <label class="field"><span>Phone</span><input class="input" inputMode="tel" value={nc.phone} placeholder="98xxx xxxxx" onInput={(e) => setNc({ ...nc, phone: (e.target as HTMLInputElement).value })} /></label>
            <label class="field"><span>Email</span><input class="input" inputMode="email" value={nc.email} onInput={(e) => setNc({ ...nc, email: (e.target as HTMLInputElement).value })} /></label>
          </div>
          <Seg value={nc.direction} options={[['we-call', 'We call them'], ['they-call', "They'll call us"]]} onChange={(v) => setNc({ ...nc, direction: v })} />
        </div>
      )}

      {needs.has('share') && (
        <div class="col" style={{ gap: '6px' }}>
          <span class="small muted">{o?.id === 'sent' ? 'Sent on' : 'They want it on'}</span>
          <Seg value={share} options={[['whatsapp', 'WhatsApp'], ['email', 'Email'], ['both', 'Both']]} onChange={(v) => { setShare(v); if (o?.id === 'sent') setChannel(v === 'email' ? 'email' : 'whatsapp'); }} />
          {(share === 'email' || share === 'both') && !hasEmail(a, contact) && (
            <input class="input" inputMode="email" placeholder="Their email address" value={shareEmail} onInput={(e) => setShareEmail((e.target as HTMLInputElement).value)} />
          )}
        </div>
      )}

      {needs.has('reason') && (
        <label class="field"><span>Why?</span>
          <select class="select" value={reason} onChange={(e) => setReason((e.target as HTMLSelectElement).value)}>
            {LOST_REASONS.map((r) => <option>{r}</option>)}
          </select>
        </label>
      )}

      {needs.has('expert') && s.team.length > 0 && (
        <label class="field"><span>Hosted by</span>
          <select class="select" value={expert} onChange={(e) => setExpert((e.target as HTMLSelectElement).value)}>
            {s.team.filter((m) => m.active).map((m) => <option value={m.id}>{m.name}</option>)}
          </select>
        </label>
      )}

      <NoteField value={note} onInput={setNote} placeholder="Notes (optional) — tap the mic to speak" rows={compact ? 2 : 3} />

      {plan && (
        <div class="next-box">
          <Icon n="arrow" />
          <div class="grow small">
            <b>Next:</b> {describeNext(finalNext, plan.newContact?.name)}
            {finalNext?.note && <div class="muted tiny">{finalNext.note}</div>}
          </div>
          {o?.id !== 'not-interested' && o?.id !== 'won' && (
            <input type="datetime-local" class="input" style={{ width: '190px', height: '32px' }} title="Change the next step time"
              value={finalNext ? toLocalInput(new Date(finalNext.due)) : ''} onInput={(e) => { const v = (e.target as HTMLInputElement).value; setOverride(v ? { due: v } : 'none'); }} />
          )}
        </div>
      )}

      <div class="row">
        {missing && <span class="small muted">{missing}</span>}
        <button class="btn btn--primary btn--lg right" disabled={!!missing} onClick={save}>
          Save <span class="kbd" style={{ background: 'transparent', color: 'inherit', borderColor: 'currentColor', opacity: 0.6 }}>Ctrl ↵</span>
        </button>
      </div>
    </div>
  );
}

function OutcomeBtn({ o, on, k, onClick }: { o: Outcome; on: boolean; k?: string; onClick: () => void }) {
  return (
    <button type="button" class={`oc ${on ? 'is-on' : ''}`} data-tone={o.tone} onClick={onClick} title={o.hint}>
      <span class="oc__i">{o.icon}</span>
      <span>{o.label}</span>
      {k && <span class="oc__k">{k}</span>}
    </button>
  );
}

const hasEmail = (a: Account, c?: Contact) => !!(c?.emails.length || a.emails.length);
const at = (d: Date, h: number, m = 0) => { const x = new Date(d); x.setHours(h, m, 0, 0); return x; };
const nextMonday = (d: Date) => { const x = startOfDay(d); x.setDate(x.getDate() + (((8 - x.getDay()) % 7) || 7)); return x; };
const isWorkTime = (d: Date) => clampToWork(d, store.settings).getTime() === d.getTime();

/** Exposed so other screens can open the logger with a voice note already captured. */
export const openLogWithVoice = (accountId: ID, text: string) => set({ log: { accountId, text } });
export const currentLog = () => ui.log;
