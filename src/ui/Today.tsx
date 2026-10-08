import { useState } from 'preact/hooks';
import { store, useStore } from '../lib/store';
import { buildQueue, actionLabel, type Queue, type QueueItem, type Section } from '../lib/schedule';
import { targetProgress, streak, metrics, level } from '../lib/stats';
import { fmtTime, fmtDay, plural, startOfDay } from '../lib/util';
import { telHref, waHref } from '../lib/phone';
import { Icon, Ring, Seg, Stage } from './components';
import { openAccount, openCompose, openLog, set } from './bus';
import { pendingRequests } from './Requests';

export function useQueue(everyone = false): Queue {
  const s = store;
  // Signed out mid-render (session revoked): an empty queue until the sign-in screen takes over.
  const me = s.me?.id || '';
  return s.sel(`queue:${everyone}:${me}`, () => buildQueue({
    accounts: me ? s.accounts() : [], contacts: s.contactsBy(), acts: s.acts(), settings: s.settings, team: s.team, me, model: s.model(), everyone,
  }));
}

export function Today() {
  const s = useStore();
  const [scope, setScope] = useState<'me' | 'team'>('me');
  const q = useQueue(scope === 'team');
  if (!s.me) return null;
  const me = s.me;
  const acts = s.acts();
  // People who don't work the opening stages never get fresh leads, so skip that ring and banner for them.
  const mine = s.member(me.id);
  const getsFresh = !mine?.stages.length || mine.stages.some((x) => x === 'new' || x === 'intro');
  const targets = targetProgress(acts, s.settings, s.team, me.id).filter((t) => getsFresh || t.key !== 'newLeads');
  const today = metrics(acts, startOfDay(), new Date(Date.now() + 864e5), me.id);
  const allPts = acts.reduce((n, a) => n + (a.createdBy === me.id && !a.voided ? a.points || 0 : 0), 0);
  const lvl = level(allPts);
  const st = s.settings.fun.streaks ? streak(acts, s.settings, s.team, me.id) : 0;
  const h = new Date().getHours();
  const hello = h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
  const queueCount = q.now.length + q.due.length + q.fresh.length;
  const total = q.now.length + q.due.length + q.later.length;

  return (
    <div>
      <div class="hello">
        <div>
          <p class="muted small">{fmtDay(new Date())}</p>
          <h1>{hello}, {me.name.split(' ')[0]}</h1>
          <p class="muted" style={{ marginTop: '4px' }}>
            {queueCount ? <>You have <b style={{ color: 'var(--ink)' }}>{plural(q.now.length + q.due.length, 'follow-up')}</b>{q.fresh.length ? <> and <b style={{ color: 'var(--ink)' }}>{plural(q.fresh.length, 'fresh lead')}</b></> : null} lined up.</> : total ? 'All caught up for now — more later today.' : 'All clear. Nice.'}
          </p>
        </div>
        <div class="hello__stats">
          {s.settings.fun.points && <span class="stat-pill"><Icon n="bolt" size={15} /><b>{today.points}</b> pts today</span>}
          {s.settings.fun.streaks && st > 0 && <span class="stat-pill" title="Days in a row hitting your calls target"><span style={{ color: 'var(--hot)' }}><Icon n="fire" size={15} /></span><b>{st}</b> day streak</span>}
          {s.settings.fun.points && <span class="stat-pill" title={`${lvl.toNext} pts to next level`}>Lv {lvl.n} · {lvl.name}</span>}
          {s.isX && <Seg value={scope} options={[['me', 'Mine'], ['team', 'Team']]} onChange={setScope} />}
        </div>
      </div>

      {targets.length > 0 && scope === 'me' && (
        <div class="rings">
          {targets.map((t) => (
            <div class={`ring-card ${t.pct >= 1 ? 'is-done' : ''}`} title={`${t.label} — ${t.per === 'day' ? 'today' : t.per === 'week' ? 'this week' : 'this month'}`}>
              <Ring pct={t.pct} />
              <div>
                <div class="ring-card__v">{t.value}<small>{t.key === 'followupsOnTime' ? '%' : ''} / {t.target}{t.key === 'followupsOnTime' ? '%' : ''}</small></div>
                <div class="ring-card__l">{t.label.replace(' (%)', '')}{t.per !== 'day' ? ` · ${t.per}` : ''}</div>
              </div>
            </div>
          ))}
        </div>
      )}

      {s.isX && pendingRequests().length > 0 && (
        <div class="banner banner--accent" style={{ marginTop: '14px', marginBottom: 0 }}>
          <Icon n="check" />
          <div class="small grow"><b>{plural(pendingRequests().length, 'assignment request')}</b> waiting for your approval.</div>
          <button class="btn btn--sm btn--primary" onClick={() => set({ requests: true })}>Review</button>
        </div>
      )}

      {s.isX && q.unassigned > 0 && (
        <div class="banner banner--accent" style={{ marginTop: '14px', marginBottom: 0 }}>
          <Icon n="user" />
          <div class="small grow"><b>{plural(q.unassigned, "lead isn't", "leads aren't")} assigned to anyone</b> — nobody will call {q.unassigned === 1 ? 'it' : 'them'} until you assign {q.unassigned === 1 ? 'it' : 'them'} or allocate stages in Settings → Team.</div>
          <button class="btn btn--sm" onClick={() => set({ route: 'leads' })}>Assign in Leads</button>
        </div>
      )}

      {q.throttle < 1 && scope === 'me' && getsFresh && (
        <div class="banner" style={{ marginTop: '14px', marginBottom: 0 }}>
          <Icon n="clock" />
          <div class="small grow">
            {q.throttle === 0
              ? <><b>New outreach paused.</b> {q.backlog} follow-ups are overdue — clear them first so no warm lead goes cold.</>
              : <><b>Fewer fresh leads today.</b> {q.backlog} follow-ups are overdue; clearing them brings fresh leads back.</>}
          </div>
        </div>
      )}

      {queueCount > 0 && scope === 'me' && (
        <button class="focus-cta" onClick={() => set({ focus: true })}>
          <span class="focus-cta__icon"><Icon n="play" /></span>
          <div class="grow"><b>Start calling</b><span>{queueCount} in your queue · one at a time, in the best order</span></div>
          <span class="kbd" style={{ color: 'inherit', background: 'transparent', borderColor: 'currentColor', opacity: 0.5 }}>F</span>
        </button>
      )}

      <QSection title="Right now" items={q.now} section="now" />
      <QSection title="Follow-ups due" items={q.due} section="due" />
      <QSection title="Later today" items={q.later} section="later" />
      <QSection title="Fresh leads" items={q.fresh} section="fresh" hint={q.newQuota ? `${q.newDone} of ${q.newTarget} opened today` : undefined} />
      <QSection title="Needs a phone number" items={q.number} section="number" limit={8} />
      <QSection title="Tomorrow" items={q.upcoming} section="upcoming" limit={6} />

      {!total && !q.fresh.length && !q.number.length && (
        <div class="card empty" style={{ marginTop: '24px' }}>
          <b>Nothing in your queue</b>
          {s.accounts().length ? (s.isX ? "Nothing is assigned to you. Use the Team switch above to see everyone's queue." : 'Leads assigned to you will appear here.') : 'Import a lead list to get started.'}
          {!s.accounts().length && <div style={{ marginTop: '12px' }}><button class="btn btn--primary" onClick={() => set({ route: 'import' })}><Icon n="import" /> Import leads</button></div>}
        </div>
      )}
    </div>
  );
}

function QSection({ title, items, section, hint, limit }: { title: string; items: QueueItem[]; section: Section; hint?: string; limit?: number }) {
  const [all, setAll] = useState(false);
  if (!items.length) return null;
  const shown = limit && !all ? items.slice(0, limit) : items;
  return (
    <section>
      <div class="section-title"><span>{title}</span><span class="count">{items.length}</span>{hint && <span class="right" style={{ textTransform: 'none', letterSpacing: 0, fontWeight: 500 }}>{hint}</span>}</div>
      <div class="q">
        {shown.map((it, i) => <QRow it={it} i={i} />)}
      </div>
      {limit && items.length > limit && <button class="btn btn--ghost btn--sm" style={{ marginTop: '6px' }} onClick={() => setAll(!all)}>{all ? 'Show less' : `Show all ${items.length}`}</button>}
    </section>
  );
}

export function QRow({ it, i = 0 }: { it: QueueItem; i?: number }) {
  const s = store;
  const a = it.account;
  const c = it.contact;
  const phone = c?.phones[0] || a.phones[0];
  const late = it.due && it.due.getTime() < Date.now() - 5 * 60e3;
  const claim = s.claims[a.id];
  const action = a.next ? actionLabel(a.next.type) : a.stage === 'new' ? 'First call' : 'Open';
  return (
    <div class={`qi ${it.section === 'now' ? 'qi--now' : ''}`} style={{ animationDelay: `${Math.min(i, 12) * 25}ms` }} onClick={() => openAccount(a.id)}>
      <div class={`qi__time ${late ? 'is-late' : ''}`}>
        {it.section === 'now' ? 'Now' : it.due && it.section !== 'fresh' ? fmtTime(it.due).replace(/:00/, '') : '—'}
        <small>{action.split(' ')[0]}</small>
      </div>
      <div style={{ minWidth: 0 }}>
        <div class="row" style={{ gap: '8px' }}>
          <span class="qi__name ellipsis">{a.name}</span>
          <Stage s={a.stage} />
        </div>
        <div class="qi__sub ellipsis">
          {c ? <>{c.name}{c.designation ? ` · ${c.designation}` : ''}</> : a.city || 'No contact yet'}
          {a.next?.type && a.next.type !== 'call' ? ` · ${action}` : ''}
        </div>
        <div class="qi__why">
          {it.reasons.slice(0, 3).map((r) => <span class={`chip ${/Promised|Waiting|Missed/.test(r) ? 'chip--hot' : /Warm|converts|picks up/.test(r) ? 'chip--good' : /Overdue|tries|Wrong/.test(r) ? 'chip--warn' : ''}`}>{r}</span>)}
          {claim && <span class="qi__claim">● {s.nameOf(claim.user)} is on it</span>}
        </div>
      </div>
      <div class="qi__acts" onClick={(e) => e.stopPropagation()}>
        {a.next?.type === 'send' ? (
          <button class="btn btn--sm btn--accent" onClick={() => openCompose(a.id, 'details', a.next?.channel === 'email' ? 'email' : 'whatsapp')}><Icon n="whatsapp" /> Send</button>
        ) : phone ? (
          <a class="btn btn--sm btn--icon" href={telHref(phone)} title="Call" onClick={() => setTimeout(() => openLog(a.id, { contactId: c?.id }), 600)}><Icon n="phone" /></a>
        ) : null}
        {phone && a.next?.type !== 'send' && <a class="btn btn--sm btn--icon btn--wa" href={waHref(phone)} target="_blank" rel="noopener" title="WhatsApp"><Icon n="whatsapp" /></a>}
        <button class="btn btn--sm" onClick={() => openLog(a.id, { contactId: c?.id })}>Log</button>
      </div>
    </div>
  );
}
