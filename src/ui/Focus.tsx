import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { Account } from '../lib/types';
import { useStore } from "../lib/store";
import { OUTCOME, CONNECTED } from '../lib/outcomes';
import { brief } from '../lib/ai';
import { actionLabel } from '../lib/schedule';
import { fmtWhen } from '../lib/util';
import { prettyPhone, telHref, waHref } from '../lib/phone';
import { Avatar, Heat, Icon, Spinner, Stage } from './components';
import { openCompose, set } from './bus';
import { LogForm } from './LogSheet';
import { useQueue } from './Today';

/** One lead at a time, best first. Log the outcome and the next one slides in. */
export function Focus() {
  const s = useStore();
  const q = useQueue(false);
  // Freeze the order when the session starts so the list doesn't reshuffle mid-call.
  const order = useMemo(() => [...q.now, ...q.due, ...q.fresh].map((x) => x.account.id), []);
  const reasons = useMemo(() => new Map([...q.now, ...q.due, ...q.fresh].map((x) => [x.account.id, x.reasons])), []);
  const [i, setI] = useState(0);
  const [done, setDone] = useState(0);
  const [pts, setPts] = useState(0);
  const [combo, setCombo] = useState(0);
  const started = useRef(Date.now());
  const [, tick] = useState(0);
  useEffect(() => { const t = setInterval(() => tick((n) => n + 1), 1000); return () => clearInterval(t); }, []);

  const id = order[i];
  const a = s.get<Account>(id);
  useEffect(() => { s.setFocus(id || null); return () => s.setFocus(null); }, [id]);

  const next = () => setI((n) => n + 1);
  const exit = () => set({ focus: false });

  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName;
      if (e.key === 'Escape') exit();
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (e.key === 'ArrowRight' || e.key === 's') next();
    };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, []);

  const secs = Math.floor((Date.now() - started.current) / 1000);
  const clock = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;

  return (
    <div class="focus">
      <div class="focus__top">
        <button class="btn btn--ghost btn--sm" onClick={exit}><Icon n="x" /> End</button>
        <div class="focus__progress"><i style={{ width: `${order.length ? (Math.min(i, order.length) / order.length) * 100 : 100}%` }} /></div>
        <span class="small muted num">{Math.min(i + 1, order.length)} / {order.length}</span>
        <span class="right row small">
          {combo >= 3 && <span class="combo">🔥 {combo} in a row</span>}
          <span class="muted num">{clock}</span>
          <span class="chip"><Icon n="check" size={12} /> {done}</span>
          {s.settings.fun.points && <span class="chip chip--accent"><Icon n="bolt" size={12} /> {pts}</span>}
        </span>
      </div>
      <div class="focus__stage">
        {!a || i >= order.length ? (
          <div class="focus__card" style={{ textAlign: 'center', paddingTop: '10vh' }}>
            <div style={{ fontSize: '48px' }}>🎉</div>
            <h1 style={{ marginTop: '10px' }}>Queue cleared</h1>
            <p class="muted" style={{ marginTop: '8px' }}>{done} logged · {pts} points · {clock}</p>
            <button class="btn btn--primary btn--lg" style={{ marginTop: '22px' }} onClick={exit}>Back to Today</button>
          </div>
        ) : (
          <Card key={a.id} a={a} reasons={reasons.get(a.id) || []} onSkip={next} onSaved={(oc) => {
            const o = OUTCOME.get(oc);
            setDone((n) => n + 1);
            setPts((p) => p + (o?.points || 0));
            setCombo((c) => (CONNECTED.has(oc) ? c + 1 : 0));
            setTimeout(next, 350);
          }} />
        )}
      </div>
    </div>
  );
}

function Card({ a, reasons, onSkip, onSaved }: { a: Account; reasons: string[]; onSkip: () => void; onSaved: (oc: string) => void }) {
  const s = useStore();
  const contacts = s.contactsBy().get(a.id) || [];
  const acts = s.actsBy().get(a.id) || [];
  const target = contacts.find((c) => c.id === a.next?.contactId) || contacts.find((c) => c.id === a.primaryContactId) || contacts[0];
  const ref = target?.referredBy ? contacts.find((c) => c.id === target.referredBy) : undefined;
  const phones = [...(target?.phones || []), ...a.phones];
  const [b, setB] = useState<string | null>(a.brief?.text || null);
  const [busy, setBusy] = useState(false);

  return (
    <div class="focus__card">
      <div class="row wrap" style={{ gap: '10px' }}>
        <Stage s={a.stage} />
        <Heat v={a.heat} />
        {a.next && <span class="chip">{actionLabel(a.next.type)}{a.next.timed ? ` · promised ${fmtWhen(a.next.due)}` : ''}</span>}
        {reasons.slice(0, 3).map((r) => <span class="chip chip--line">{r}</span>)}
      </div>
      <div class="focus__name" style={{ marginTop: '10px' }}>{a.name}</div>
      <p class="muted" style={{ marginTop: '4px' }}>{[a.city, a.sector, a.size].filter(Boolean).join(' · ')}</p>

      <div class="focus__who">
        {target ? <Avatar id={target.id} name={target.name} size="lg" /> : <span class="avatar avatar--lg" style={{ background: 'var(--soft-2)', color: 'var(--muted)' }}>?</span>}
        <div class="grow">
          <div><b>{target ? `Ask for ${target.name}` : 'Ask who handles data privacy / IT compliance'}</b>{target?.designation ? <span class="muted"> · {target.designation}</span> : null}</div>
          {ref && <div class="small muted">Referred by {ref.name}{ref.designation ? ` (${ref.designation})` : ''}</div>}
          {phones[0] ? <div class="focus__phone" style={{ marginTop: '4px' }}>{prettyPhone(phones[0])}</div> : <div class="small" style={{ color: 'var(--warn)' }}>No number — skip or find one</div>}
          {phones.length > 1 && <div class="row wrap tiny muted" style={{ gap: '10px' }}>{phones.slice(1).map((p) => <a href={telHref(p)}>{prettyPhone(p)}</a>)}</div>}
        </div>
        <div class="col" style={{ gap: '6px' }}>
          {phones[0] && <a class="btn btn--primary btn--lg" href={telHref(phones[0])}><Icon n="phone" /> Call</a>}
          {phones[0] && <a class="btn btn--wa btn--sm" href={waHref(phones[0])} target="_blank" rel="noopener"><Icon n="whatsapp" /> WhatsApp</a>}
        </div>
      </div>

      {a.next?.note && <p class="small" style={{ marginTop: '10px' }}><Icon n="arrow" size={13} /> {a.next.note}</p>}

      <div class="grid2" style={{ marginTop: '14px', alignItems: 'start' }}>
        <div class="col" style={{ gap: '6px' }}>
          <span class="tiny muted" style={{ textTransform: 'uppercase', letterSpacing: '.05em', fontWeight: 600 }}>Last touches</span>
          {acts.slice(0, 3).map((x) => (
            <div class="small"><span>{OUTCOME.get(x.outcome || '')?.icon || '•'} {OUTCOME.get(x.outcome || '')?.label || x.note}</span> <span class="muted">· {fmtWhen(x.at)} · {s.nameOf(x.createdBy)}</span>
              {x.note && !x.system && <div class="tiny muted ellipsis">“{x.note}”</div>}</div>
          ))}
          {!acts.length && <span class="small muted">First contact</span>}
        </div>
        <div>
          {b ? <div class="brief small">{b}</div> : (
            <button class="btn btn--accent btn--sm" disabled={busy} onClick={async () => { setBusy(true); const r = await brief(a, contacts, acts); setBusy(false); setB(r.text); }}>
              {busy ? <Spinner /> : <Icon n="sparkle" />} Brief me
            </button>
          )}
        </div>
      </div>

      <div class="divider" style={{ margin: '20px 0 16px' }} />
      {a.next?.type === 'send' ? (
        <div class="row">
          <button class="btn btn--accent btn--lg" onClick={() => openCompose(a.id, 'details', a.next?.channel === 'email' ? 'email' : 'whatsapp')}><Icon n="whatsapp" /> Write & send details</button>
          <button class="btn btn--ghost right" onClick={onSkip}>Next <Icon n="skip" /></button>
        </div>
      ) : (
        <>
          <LogForm account={a} onSaved={onSaved} compact />
          <div class="row" style={{ marginTop: '10px' }}>
            <button class="btn btn--ghost btn--sm" onClick={() => openCompose(a.id)}><Icon n="mail" /> Message instead</button>
            <button class="btn btn--ghost btn--sm right" onClick={onSkip}>Skip for now <Icon n="skip" /></button>
          </div>
        </>
      )}
    </div>
  );
}

