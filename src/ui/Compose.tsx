import { useEffect, useMemo, useState } from 'preact/hooks';
import type { Account, Contact, ID } from '../lib/types';
import { store, useStore } from '../lib/store';
import { compose } from '../lib/ai';
import { PURPOSES, suggestPurpose, template, type Lang, type Purpose, type Tone } from '../lib/templates';
import { planOutcome } from '../lib/workflow';
import { mailHref, prettyPhone, waHref } from '../lib/phone';
import { fmtWhen } from '../lib/util';
import { Icon, Seg, Sheet, Spinner, copy } from './components';
import { set, toast, useUI } from './bus';

function lsGet<T extends string>(k: string, d: T): T { try { return (localStorage.getItem(k) as T) || d; } catch { return d; } }
function lsSet(k: string, v: string) { try { localStorage.setItem(k, v); } catch { /* ignore */ } }

export function ComposeSheet() {
  const u = useUI();
  if (!u.compose) return null;
  const a = store.get<Account>(u.compose.accountId);
  if (!a) return null;
  return <Compose a={a} initial={u.compose} onClose={() => set({ compose: null })} />;
}

function Compose({ a, initial, onClose }: { a: Account; initial: { purpose?: Purpose; channel?: 'whatsapp' | 'email' }; onClose: () => void }) {
  const s = useStore();
  const contacts = (s.contactsBy().get(a.id) || []).filter((c) => c.status !== 'left');
  const acts = s.actsBy().get(a.id) || [];
  const first = contacts.find((c) => c.id === a.next?.contactId) || contacts.find((c) => c.id === a.primaryContactId) || contacts[0];
  const [cid, setCid] = useState<ID | undefined>(first?.id);
  const c = contacts.find((x) => x.id === cid);
  const referrer = c?.referredBy ? contacts.find((x) => x.id === c.referredBy) : undefined;
  const [purpose, setPurpose] = useState<Purpose>(initial.purpose || suggestPurpose(a, c, referrer));
  const [channel, setChannel] = useState<'whatsapp' | 'email'>(initial.channel || (a.next?.channel === 'email' ? 'email' : 'whatsapp'));
  const [tone, setTone] = useState<Tone>(lsGet('ks-tone', 'warm'));
  const [lang, setLang] = useState<Lang>(lsGet('ks-lang', 'English'));
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [via, setVia] = useState<'ai' | 'template' | ''>('');
  const [opened, setOpened] = useState(false);

  const phones = [...(c?.phones || []), ...a.phones];
  const emails = [...(c?.emails || []), ...a.emails];
  const [to, setTo] = useState('');
  useEffect(() => { setTo(channel === 'whatsapp' ? phones[0] || '' : emails[0] || ''); }, [channel, cid]);

  // Instant template; AI personalisation on demand (or automatically when AI is on).
  useEffect(() => {
    const t = template(purpose, { a, c, referrer, s: s.settings, me: s.me?.name || '', tone, lang, when: a.next?.type === 'discovery' ? fmtWhen(a.next.due) : undefined });
    setSubject(t.subject); setBody(t.body); setVia('template');
  }, [purpose, tone, lang, cid]);

  const label = PURPOSES.find((p) => p.id === purpose)?.label || purpose;
  const personalise = async () => {
    setBusy(true);
    const r = await compose({ a, c, referrer, contacts, acts, purpose, label, channel, tone, lang });
    setBusy(false);
    setSubject(r.subject); setBody(r.body); setVia(r.via);
    if (r.via === 'template') toast('AI unavailable — using the template');
  };

  const href = channel === 'whatsapp' ? (to ? waHref(to, body) : '') : mailHref(to, subject, body);

  const markSent = () => {
    const outcome = purpose === 'details' ? 'sent' : 'msg-sent';
    const input = { outcome, account: a, contact: c, channel, share: channel, note: `${label} on ${channel === 'whatsapp' ? 'WhatsApp' : 'email'}` } as const;
    const plan = planOutcome(input, { settings: s.settings, model: s.model(), load: s.load(), team: s.team, me: s.me!.id });
    s.commitPlan(plan, input, `${label} sent · ${a.name}`);
    toast(`Sent. ${purpose === 'details' ? `Reminder call ${fmtWhen(plan.next!.due)}` : 'Follow-up planned'}`, { undo: true, points: s.settings.fun.points ? plan.points : undefined });
    onClose();
  };

  const purposeOpts = useMemo(() => PURPOSES, []);

  return (
    <Sheet title={<span>Message · <span class="muted">{a.name}</span></span>} onClose={onClose} wide
      foot={
        <>
          <button class="btn btn--ghost" onClick={() => { copy(channel === 'email' ? `Subject: ${subject}\n\n${body}` : body); setOpened(true); }}><Icon n="copy" /> Copy</button>
          {href ? (
            <a class={`btn ${channel === 'whatsapp' ? 'btn--wa' : ''}`} href={href} target="_blank" rel="noopener" onClick={() => setOpened(true)}>
              <Icon n={channel === 'whatsapp' ? 'whatsapp' : 'mail'} /> Open {channel === 'whatsapp' ? 'WhatsApp' : 'email'}
            </a>
          ) : <span class="small muted">No {channel === 'whatsapp' ? 'number' : 'email'} on file</span>}
          <button class={`btn ${opened ? 'btn--primary' : ''} right`} onClick={markSent}><Icon n="check" /> Mark as sent</button>
        </>
      }>
      <div class="col" style={{ gap: '12px' }}>
        <div class="row wrap">
          <Seg value={channel} options={[['whatsapp', 'WhatsApp'], ['email', 'Email']]} onChange={setChannel} />
          <select class="select" style={{ width: 'auto', height: '34px' }} value={purpose} onChange={(e) => setPurpose((e.target as HTMLSelectElement).value as Purpose)}>
            {purposeOpts.map((p) => <option value={p.id}>{p.label}</option>)}
          </select>
        </div>
        <div class="row wrap">
          <Seg value={tone} options={[['warm', 'Warm'], ['formal', 'Formal'], ['crisp', 'Crisp']]} onChange={(v) => { setTone(v); lsSet('ks-tone', v); }} />
          <Seg value={lang} options={[['English', 'English'], ['Hinglish', 'Hinglish'], ['Hindi', 'हिंदी']]} onChange={(v) => { setLang(v); lsSet('ks-lang', v); }} />
        </div>
        <div class="grid2">
          {contacts.length > 0 && (
            <label class="field"><span>To</span>
              <select class="select" value={cid} onChange={(e) => setCid((e.target as HTMLSelectElement).value || undefined)}>
                {contacts.map((x: Contact) => <option value={x.id}>{x.name}{x.designation ? ` · ${x.designation}` : ''}</option>)}
                <option value="">Company</option>
              </select>
            </label>
          )}
          <label class="field"><span>{channel === 'whatsapp' ? 'WhatsApp number' : 'Email'}</span>
            {(channel === 'whatsapp' ? phones : emails).length > 1 ? (
              <select class="select" value={to} onChange={(e) => setTo((e.target as HTMLSelectElement).value)}>
                {(channel === 'whatsapp' ? phones : emails).map((p) => <option value={p}>{channel === 'whatsapp' ? prettyPhone(p) : p}</option>)}
              </select>
            ) : (
              <input class="input" value={to} placeholder={channel === 'whatsapp' ? '98xxx xxxxx' : 'name@company.com'} onInput={(e) => setTo((e.target as HTMLInputElement).value)} />
            )}
          </label>
        </div>
        {channel === 'email' && <input class="input" value={subject} onInput={(e) => setSubject((e.target as HTMLInputElement).value)} placeholder="Subject" />}
        <textarea class="textarea" rows={channel === 'email' ? 11 : 8} value={body} onInput={(e) => setBody((e.target as HTMLTextAreaElement).value)} />
        <div class="row">
          <button class="btn btn--accent" onClick={personalise} disabled={busy}>{busy ? <Spinner /> : <Icon n="sparkle" />} {via === 'ai' ? 'Rewrite' : 'Personalise with AI'}</button>
          <span class="small muted">{via === 'ai' ? 'Written from this lead\'s history — edit freely' : 'Template — AI uses the full history, tone & language'}</span>
        </div>
      </div>
    </Sheet>
  );
}
