import { createContext } from 'preact';
import { useContext, useEffect, useState } from 'preact/hooks';
import type { Account, Activity, AuditRow, Contact, ContactRole, StageId } from '../lib/types';
import { store, useStore } from '../lib/store';
import { OUTCOME } from '../lib/outcomes';
import { STAGES, stageLabel } from '../lib/defaults';
import { describeNext } from '../lib/workflow';
import { assigneeOf, actionLabel, assignTo, canEdit, stageMove } from '../lib/schedule';

/** True when the viewer may only look at this lead (it's someone else's). */
const ReadOnly = createContext(false);
import { brief, enrich, googleSearchUrl } from '../lib/ai';
import { post } from '../lib/api';
import { fmtWhen, rel, uniq } from '../lib/util';
import { isEmail, normUrl, prettyPhone, splitEmails, splitPhones, telHref, waHref } from '../lib/phone';
import { Avatar, Heat, Icon, Spinner, Stage } from './components';
import { openAccount, openCompose, openLog, toast, useUI } from './bus';

export function AccountPanel() {
  const u = useUI();
  const s = useStore();
  const a = s.get<Account>(u.account);
  useEffect(() => { s.setFocus(a?.id || null); return () => s.setFocus(null); }, [a?.id]);
  useEffect(() => {
    if (!u.account) return;
    const k = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !u.log && !u.compose) openAccount(null);
      const tag = (e.target as HTMLElement).tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || u.log || u.compose || e.ctrlKey || e.metaKey) return;
      if (e.key === 'l') { e.preventDefault(); openLog(u.account!); }
      if (e.key === 'm') { e.preventDefault(); openCompose(u.account!); }
    };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [u.account, u.log, u.compose]);
  if (!u.account) return null;
  if (!a) return (<><div class="overlay" onClick={() => openAccount(null)} /><div class="drawer"><div class="empty"><b>Not found</b>This lead may have been removed.</div></div></>);
  return (
    <>
      <div class="overlay" onClick={() => openAccount(null)} />
      <div class="drawer" role="dialog" aria-label={a.name}><Panel a={a} /></div>
    </>
  );
}

function Panel({ a }: { a: Account }) {
  const s = useStore();
  const [tab, setTab] = useState<'overview' | 'timeline' | 'trail'>('overview');
  const [menu, setMenu] = useState(false);
  const contacts = s.contactsBy().get(a.id) || [];
  const acts = s.actsBy().get(a.id) || [];
  const target = contacts.find((c) => c.id === a.next?.contactId) || contacts.find((c) => c.id === a.primaryContactId) || contacts[0];
  const phone = target?.phones[0] || a.phones[0] || contacts.find((c) => c.phones.length)?.phones[0];
  const claim = s.claims[a.id];
  const who = assigneeOf(a, s.team);
  const editable = canEdit(a, s.team, s.me!.id, s.isX);
  const late = a.next && new Date(a.next.due).getTime() < Date.now() - 30 * 60e3;

  const setStage = (st: StageId) => {
    if (st === a.stage) return;
    s.batch(`Moved to ${stageLabel(st)}`, [
      { rec: a, set: { ...stageMove(a, st, s.team), status: st === 'assessment' ? 'won' : a.status === 'won' ? 'open' : a.status } },
      { kind: 'activity', create: { accountId: a.id, channel: 'note', at: new Date().toISOString(), stageFrom: a.stage, stageTo: st, system: true, note: `Moved to ${stageLabel(st)}` } },
    ]);
    toast(`Moved to ${stageLabel(st)}`, { undo: true });
  };

  return (
    <>
      <div class="drawer__head">
        <div class="acct-title">
          <div class="grow">
            <Editable value={a.name} onSave={(v) => v.trim() && s.update(a, { name: v.trim() }, 'Renamed')} big ro={!editable} />
            <div class="row wrap small muted" style={{ marginTop: '4px' }}>
              <Stage s={a.stage} />
              {a.status !== 'open' && <span class={`chip ${a.status === 'won' ? 'chip--good' : a.status === 'lost' ? 'chip--bad' : 'chip--warn'}`}>{a.status === 'parked' ? 'Parked' : a.status === 'won' ? 'Won' : 'Closed'}</span>}
              <Heat v={a.heat} />
              {a.city && <span>· {a.city}</span>}
              {a.sector && <span>· {a.sector}</span>}
            </div>
          </div>
          <div style={{ position: 'relative' }}>
            {editable && <button class="btn btn--ghost btn--icon" onClick={() => setMenu(!menu)} aria-label="More"><Icon n="more" /></button>}
            {editable && menu && <Menu a={a} onClose={() => setMenu(false)} setStage={setStage} />}
          </div>
          <button class="btn btn--ghost btn--icon" onClick={() => openAccount(null)} aria-label="Close"><Icon n="x" /></button>
        </div>

        {claim && <div class="qi__claim" style={{ marginTop: '8px' }}>● {s.nameOf(claim.user)} has this open right now</div>}

        {a.next && (
          <div class="next-box" style={{ marginTop: '12px', background: late ? 'var(--bad-soft)' : undefined }}>
            <Icon n="clock" />
            <div class="grow small">
              <b>{describeNext(a.next, contacts.find((c) => c.id === a.next?.contactId)?.name)}</b>
              <div class="muted tiny">{late ? `Overdue · ${rel(a.next.due)}` : rel(a.next.due)}{who ? ` · ${s.nameOf(who)}` : ''}{a.next.note ? ` · ${a.next.note}` : ''}</div>
            </div>
          </div>
        )}

        {!editable && (
          <div class="banner" style={{ margin: '12px 0 0' }}>
            <Icon n="user" />
            <span class="small grow">{who ? <><b>{s.nameOf(who)}</b> is working this lead</> : <>Not assigned to anyone yet</>} — view only.</span>
          </div>
        )}

        {editable && <div class="acct-actions">
          {phone ? <a class="btn btn--primary" href={telHref(phone)} onClick={() => setTimeout(() => openLog(a.id, { contactId: target?.id }), 600)}><Icon n="phone" /> Call</a>
            : <button class="btn btn--primary" onClick={() => setTab('overview')}><Icon n="search" /> Find number</button>}
          <button class="btn" onClick={() => openLog(a.id, { contactId: target?.id })}><Icon n="check" /> Log</button>
          <button class="btn btn--wa" onClick={() => openCompose(a.id, undefined, 'whatsapp')}><Icon n="whatsapp" /> WhatsApp</button>
          <button class="btn" onClick={() => openCompose(a.id, undefined, 'email')}><Icon n="mail" /> Email</button>
        </div>}

        <div class="tabs" style={{ marginTop: '14px', marginBottom: '-15px' }}>
          {(['overview', 'timeline', 'trail'] as const).map((t) => (
            <button class={tab === t ? 'is-on' : ''} onClick={() => setTab(t)}>
              {t === 'overview' ? 'Overview' : t === 'timeline' ? `Timeline · ${acts.length}` : 'Edit trail'}
            </button>
          ))}
        </div>
      </div>
      <div class="drawer__body">
        {tab === 'overview' && <ReadOnly.Provider value={!editable}><Overview a={a} contacts={contacts} acts={acts} /></ReadOnly.Provider>}
        {tab === 'timeline' && <Timeline acts={acts} contacts={contacts} />}
        {tab === 'trail' && <Trail a={a} contacts={contacts} />}
      </div>
    </>
  );
}

function Menu({ a, onClose, setStage }: { a: Account; onClose: () => void; setStage: (s: StageId) => void }) {
  const s = useStore();
  const [hold, setHold] = useState(false);
  useEffect(() => {
    const f = () => onClose();
    setTimeout(() => window.addEventListener('click', f, { once: true }), 0);
    return () => window.removeEventListener('click', f);
  }, []);
  return (
    <div class="card" style={{ position: 'absolute', right: 0, top: '40px', zIndex: 5, width: '230px', padding: '6px', boxShadow: 'var(--shadow-lg)' }} onClick={(e) => e.stopPropagation()}>
      <div class="tiny muted" style={{ padding: '6px 8px' }}>Move to stage</div>
      {STAGES.map((st) => (
        <button class="nav__item" style={{ padding: '6px 8px' }} onClick={() => { setStage(st.id); onClose(); }}>
          <Stage s={st.id} />{st.id === a.stage && <Icon n="check" size={14} />}
        </button>
      ))}
      <div class="divider" style={{ margin: '6px 0' }} />
      {s.isX && <>
      <div class="tiny muted" style={{ padding: '6px 8px' }}>Owner</div>
      <select class="select" style={{ height: '32px', margin: '0 4px 6px', width: 'calc(100% - 8px)' }} value={a.owner || ''} onChange={(e) => { s.update(a, assignTo((e.target as HTMLSelectElement).value || null), 'Changed owner'); onClose(); }}>
        <option value="">Auto (by stage)</option>
        {s.team.filter((m) => m.active).map((m) => <option value={m.id}>{m.name}</option>)}
      </select>
      </>}
      <div class="divider" style={{ margin: '6px 0' }} />
      {a.status === 'open' || a.status === 'parked' ? (
        <button class="nav__item" style={{ padding: '6px 8px' }} onClick={() => { s.update(a, { status: 'lost', lostReason: 'Removed from pipeline', next: null }, `Closed ${a.name}`); toast('Removed from pipeline', { undo: true }); onClose(); }}>
          <Icon n="x" /> Remove from pipeline
        </button>
      ) : (
        <button class="nav__item" style={{ padding: '6px 8px' }} onClick={() => { s.update(a, { status: 'open', lostReason: null, next: { type: 'call', due: new Date().toISOString() } }, `Reopened ${a.name}`); toast('Reopened', { undo: true }); onClose(); }}>
          <Icon n="undo" /> Reopen
        </button>
      )}
      <button class="nav__item" style={{ padding: '6px 8px' }} onClick={() => { s.update(a, { voided: true }, `Removed ${a.name}`); toast('Lead removed', { undo: true }); onClose(); openAccount(null); }}>
        <Icon n="trash" /> Remove lead (duplicate / junk)
      </button>
      {s.isX && (
        <button class="nav__item btn--danger" style={{ padding: '6px 8px', color: 'var(--bad)' }}
          onClick={() => { if (!hold) { setHold(true); setTimeout(() => setHold(false), 2500); return; } s.destroy('account', a.id); onClose(); openAccount(null); toast('Deleted'); }}>
          <Icon n="trash" /> {hold ? 'Click again to confirm' : 'Delete forever'}
        </button>
      )}
    </div>
  );
}

function Overview({ a, contacts, acts }: { a: Account; contacts: Contact[]; acts: Activity[] }) {
  const s = useStore();
  const ro = useContext(ReadOnly);
  const [b, setB] = useState<{ text: string; via: string } | null>(a.brief ? { text: a.brief.text, via: 'saved' } : null);
  const [loadingBrief, setLB] = useState(false);
  const [finding, setFinding] = useState(false);
  const [adding, setAdding] = useState(false);
  const hasPhone = a.phones.length > 0 || contacts.some((c) => c.phones.length > 0);

  const getBrief = async () => {
    setLB(true);
    const r = await brief(a, contacts, acts);
    setLB(false);
    setB(r);
    if (r.via === 'ai') store.update(a, { brief: { text: r.text, at: new Date().toISOString() } });
  };
  const find = async () => {
    setFinding(true);
    const r = await enrich(a);
    setFinding(false);
    if (!r) { toast('AI search unavailable — try Google'); return; }
    if (!r.phones.length && !r.emails.length && !r.website) { toast('Nothing reliable found — try Google'); return; }
    s.update(a, { found: { ...r, at: new Date().toISOString() } });
  };

  // Order people as a referral chain: whoever referred someone comes first.
  const ordered: Contact[] = [];
  const add = (c: Contact) => { if (ordered.includes(c)) return; ordered.push(c); contacts.filter((x) => x.referredBy === c.id).forEach(add); };
  contacts.filter((c) => !c.referredBy || !contacts.some((x) => x.id === c.referredBy)).forEach(add);
  contacts.forEach(add);

  return (
    <div class="col" style={{ gap: '18px' }}>
      <div>
        {b ? (
          <div class="brief"><div class="row tiny muted" style={{ marginBottom: '6px' }}><Icon n="sparkle" size={13} /> Before you call <button class="btn btn--ghost btn--sm right" onClick={getBrief} disabled={loadingBrief}>{loadingBrief ? <Spinner /> : 'Refresh'}</button></div>{b.text}</div>
        ) : (
          <button class="btn btn--accent" onClick={getBrief} disabled={loadingBrief}>{loadingBrief ? <Spinner /> : <Icon n="sparkle" />} Brief me before the call</button>
        )}
      </div>

      {a.found && !ro && <Found a={a} />}

      {!hasPhone && !a.found && !ro && (
        <div class="banner">
          <Icon n="phone" />
          <div class="grow small"><b>No phone number yet.</b> Find the company's public number.</div>
          <button class="btn btn--sm btn--accent" onClick={find} disabled={finding}>{finding ? <Spinner /> : <Icon n="sparkle" />} Find with AI</button>
          <a class="btn btn--sm" href={googleSearchUrl(a)} target="_blank" rel="noopener"><Icon n="globe" /> Google</a>
        </div>
      )}

      <section>
        <div class="row" style={{ marginBottom: '4px' }}>
          <h3>People</h3>
          {!ro && <button class="btn btn--ghost btn--sm right" onClick={() => setAdding(true)}><Icon n="plus" /> Add person</button>}
        </div>
        {adding && <PersonForm accountId={a.id} contacts={contacts} onDone={() => setAdding(false)} />}
        <div class="people">
          {ordered.map((c) => <Person c={c} a={a} contacts={contacts} />)}
          {!contacts.length && !adding && <p class="small muted" style={{ padding: '8px 0' }}>No one recorded yet — whoever you speak to gets added here.</p>}
        </div>
      </section>

      <section>
        <div class="row" style={{ marginBottom: '8px' }}>
          <h3>Company</h3>
          {hasPhone && !ro && <button class="btn btn--ghost btn--sm right" onClick={find} disabled={finding}>{finding ? <Spinner /> : <Icon n="sparkle" />} Find more contacts</button>}
        </div>
        <dl class="kv">
          <dt>Phones</dt><dd><ListEdit values={a.phones} render={(p) => <a href={telHref(p)}>{prettyPhone(p)}</a>} parse={splitPhones} onSave={(v) => s.update(a, { phones: v }, 'Edited phones')} /></dd>
          <dt>Emails</dt><dd><ListEdit values={a.emails} parse={splitEmails} onSave={(v) => s.update(a, { emails: v }, 'Edited emails')} /></dd>
          <dt>City</dt><dd><Editable value={a.city || ''} onSave={(v) => s.update(a, { city: v || null }, 'Edited city')} /></dd>
          <dt>State</dt><dd><Editable value={a.state || ''} onSave={(v) => s.update(a, { state: v || null }, 'Edited state')} /></dd>
          <dt>Sector</dt><dd><Editable value={a.sector || ''} onSave={(v) => s.update(a, { sector: v || null }, 'Edited sector')} /></dd>
          <dt>Website</dt><dd><Editable value={a.website || ''} link onSave={(v) => s.update(a, { website: normUrl(v) || null }, 'Edited website')} /></dd>
          <dt>LinkedIn</dt><dd><Editable value={a.linkedin || ''} link onSave={(v) => s.update(a, { linkedin: v || null }, 'Edited LinkedIn')} /></dd>
          <dt>Size</dt><dd><Editable value={a.size || ''} onSave={(v) => s.update(a, { size: v || null }, 'Edited size')} /></dd>
          <dt>Address</dt><dd><Editable value={a.address || ''} onSave={(v) => s.update(a, { address: v || null }, 'Edited address')} /></dd>
          {Object.entries(a.extra || {}).map(([k, v]) => (
            <><dt class="ellipsis" title={k}>{k}</dt><dd><Editable value={v} onSave={(nv) => { const e = { ...a.extra }; if (nv) e[k] = nv; else delete e[k]; s.update(a, { extra: e }, `Edited ${k}`); }} /></dd></>
          ))}
          {a.source && <><dt>Source</dt><dd class="muted">{a.source}</dd></>}
          {a.lostReason && <><dt>Closed because</dt><dd>{a.lostReason}</dd></>}
          <dt>Added</dt><dd class="muted">{fmtWhen(a.createdAt, false)} by {s.nameOf(a.createdBy)} · last change {rel(a.updatedAt)} by {s.nameOf(a.updatedBy)}</dd>
        </dl>
        {!ro && <AddField a={a} />}
      </section>
    </div>
  );
}

function Found({ a }: { a: Account }) {
  const s = useStore();
  const f = a.found!;
  const accept = (kind: 'phone' | 'email' | 'website', v: string) => {
    const rest = { ...f, phones: f.phones.filter((x) => x !== v), emails: f.emails.filter((x) => x !== v), website: kind === 'website' ? undefined : f.website };
    const empty = !rest.phones.length && !rest.emails.length && !rest.website;
    s.update(a, {
      ...(kind === 'phone' ? { phones: uniq([...a.phones, v]) } : kind === 'email' ? { emails: uniq([...a.emails, v]) } : { website: v }),
      found: empty ? null : rest,
      ...(kind === 'phone' && a.next?.type === 'find-number' ? { next: { type: 'call', due: new Date().toISOString() } } : {}),
    }, `Added ${v}`);
    toast('Added', { undo: true });
  };
  return (
    <div class="found">
      <div class="row small" style={{ marginBottom: '8px' }}><Icon n="sparkle" size={15} /><b>Found online — check before using</b>
        <button class="btn btn--ghost btn--sm right" onClick={() => s.update(a, { found: null })}>Dismiss</button></div>
      <div class="col" style={{ gap: '6px' }}>
        {f.phones.map((p) => <div class="row small"><Icon n="phone" size={14} /> {prettyPhone(p)} <button class="btn btn--sm btn--good right" onClick={() => accept('phone', p)}>Add</button></div>)}
        {f.emails.map((e) => <div class="row small"><Icon n="mail" size={14} /> {e} <button class="btn btn--sm btn--good right" onClick={() => accept('email', e)}>Add</button></div>)}
        {f.website && !a.website && <div class="row small"><Icon n="globe" size={14} /> {f.website} <button class="btn btn--sm btn--good right" onClick={() => accept('website', f.website!)}>Add</button></div>}
        {f.note && <p class="tiny muted">{f.note}</p>}
        {f.sources.length > 0 && <div class="row wrap tiny">{f.sources.map((u, i) => <a href={u} target="_blank" rel="noopener" class="chip chip--line">Source {i + 1}</a>)}</div>}
      </div>
    </div>
  );
}

const ROLES: [ContactRole, string][] = [['decision-maker', 'Decision maker'], ['influencer', 'Influencer'], ['gatekeeper', 'Gatekeeper'], ['unknown', 'Unknown']];

function Person({ c, a, contacts }: { c: Contact; a: Account; contacts: Contact[] }) {
  const ro = useContext(ReadOnly);
  const [edit, setEdit] = useState(false);
  const ref = c.referredBy ? contacts.find((x) => x.id === c.referredBy) : undefined;
  if (edit) return <PersonForm accountId={a.id} contacts={contacts} c={c} onDone={() => setEdit(false)} />;
  return (
    <div class={`person ${ref ? 'is-ref' : ''}`}>
      <Avatar id={c.id} name={c.name} />
      <div class="grow">
        <div class="row wrap" style={{ gap: '6px' }}>
          <b class="small">{c.name}</b>
          {c.designation && <span class="small muted">{c.designation}</span>}
          {c.role === 'decision-maker' && <span class="chip chip--good">Decision maker</span>}
          {c.role === 'gatekeeper' && <span class="chip">Gatekeeper</span>}
          {c.id === a.primaryContactId && <span class="chip chip--accent">Main</span>}
          {c.status !== 'active' && <span class="chip chip--bad">{c.status === 'left' ? 'Left company' : 'Wrong number'}</span>}
        </div>
        <div class="row wrap tiny muted" style={{ gap: '10px', marginTop: '2px' }}>
          {c.phones.map((p) => <span class="row" style={{ gap: '4px' }}><a href={telHref(p)}>{prettyPhone(p)}</a><a href={waHref(p)} target="_blank" rel="noopener" title="WhatsApp" style={{ color: '#16a34a' }}><Icon n="whatsapp" size={13} /></a></span>)}
          {c.emails.map((e) => <a href={`mailto:${e}`}>{e}</a>)}
          {ref && <span>referred by {ref.name.split(' ')[0]}</span>}
        </div>
      </div>
      <div class="row" style={{ gap: '2px' }}>
        {c.phones[0] && <a class="btn btn--ghost btn--sm btn--icon" href={telHref(c.phones[0])} onClick={() => setTimeout(() => openLog(a.id, { contactId: c.id }), 600)} title="Call"><Icon n="phone" /></a>}
        {!ro && <button class="btn btn--ghost btn--sm btn--icon" onClick={() => setEdit(true)} title="Edit"><Icon n="edit" /></button>}
      </div>
    </div>
  );
}

function PersonForm({ accountId, contacts, c, onDone }: { accountId: string; contacts: Contact[]; c?: Contact; onDone: () => void }) {
  const s = useStore();
  const a = s.get<Account>(accountId)!;
  const [f, setF] = useState({
    name: c?.name || '', designation: c?.designation || '', phones: (c?.phones || []).map(prettyPhone).join(', '), emails: (c?.emails || []).join(', '),
    role: c?.role || 'unknown' as ContactRole, referredBy: c?.referredBy || '', status: c?.status || 'active', main: c ? a.primaryContactId === c.id : !a.primaryContactId,
  });
  const save = () => {
    if (!f.name.trim()) return;
    const data = { name: f.name.trim(), designation: f.designation.trim(), phones: splitPhones(f.phones), emails: splitEmails(f.emails), role: f.role, referredBy: f.referredBy || null, status: f.status };
    if (c) {
      s.update(c, data, `Edited ${c.name}`);
      if (f.main && a.primaryContactId !== c.id) s.update(a, { primaryContactId: c.id });
    } else {
      const id = s.create<Contact>('contact', { ...data, referredBy: data.referredBy || undefined, accountId } as any, `Added ${data.name}`).id;
      if (f.main) s.update(a, { primaryContactId: id });
    }
    onDone();
  };
  const inp = (k: keyof typeof f, ph = '') => <input class="input" value={f[k] as string} placeholder={ph} onInput={(e) => setF({ ...f, [k]: (e.target as HTMLInputElement).value })} />;
  return (
    <div class="card card--pad col" style={{ gap: '10px', margin: '8px 0' }}>
      <div class="grid2">
        <label class="field"><span>Name</span>{inp('name', 'Full name')}</label>
        <label class="field"><span>Designation</span>{inp('designation', 'CFO, IT Head…')}</label>
        <label class="field"><span>Phones</span>{inp('phones', 'Comma separated')}</label>
        <label class="field"><span>Emails</span>{inp('emails', 'Comma separated')}</label>
        <label class="field"><span>Role</span>
          <select class="select" value={f.role} onChange={(e) => setF({ ...f, role: (e.target as HTMLSelectElement).value as ContactRole })}>{ROLES.map(([v, l]) => <option value={v}>{l}</option>)}</select>
        </label>
        <label class="field"><span>Referred by</span>
          <select class="select" value={f.referredBy} onChange={(e) => setF({ ...f, referredBy: (e.target as HTMLSelectElement).value })}>
            <option value="">—</option>{contacts.filter((x) => x.id !== c?.id).map((x) => <option value={x.id}>{x.name}</option>)}
          </select>
        </label>
      </div>
      <div class="row wrap">
        <label class="row small"><input type="checkbox" checked={f.main} onChange={(e) => setF({ ...f, main: (e.target as HTMLInputElement).checked })} /> Main contact</label>
        {c && (
          <select class="select" style={{ width: 'auto', height: '30px' }} value={f.status} onChange={(e) => setF({ ...f, status: (e.target as HTMLSelectElement).value as any })}>
            <option value="active">Active</option><option value="wrong-number">Wrong number</option><option value="left">Left company</option>
          </select>
        )}
        <button class="btn btn--ghost btn--sm right" onClick={onDone}>Cancel</button>
        {c && <button class="btn btn--ghost btn--sm btn--danger" onClick={() => { s.update(c, { voided: true }, `Removed ${c.name}`); toast('Removed', { undo: true }); onDone(); }}>Remove</button>}
        <button class="btn btn--primary btn--sm" onClick={save}>Save</button>
      </div>
    </div>
  );
}

function AddField({ a }: { a: Account }) {
  const s = useStore();
  const [open, setOpen] = useState(false);
  const [k, setK] = useState('');
  const [v, setV] = useState('');
  if (!open) return <button class="btn btn--ghost btn--sm" style={{ marginTop: '8px' }} onClick={() => setOpen(true)}><Icon n="plus" /> Add field</button>;
  return (
    <div class="row" style={{ marginTop: '8px' }}>
      <input class="input" placeholder="Field" value={k} onInput={(e) => setK((e.target as HTMLInputElement).value)} />
      <input class="input" placeholder="Value" value={v} onInput={(e) => setV((e.target as HTMLInputElement).value)} />
      <button class="btn btn--primary" onClick={() => { if (k.trim()) s.update(a, { extra: { ...a.extra, [k.trim()]: v } }, `Added ${k}`); setOpen(false); setK(''); setV(''); }}>Add</button>
    </div>
  );
}

function Editable({ value, onSave, big, link, ro: roProp }: { value: string; onSave: (v: string) => void; big?: boolean; link?: boolean; ro?: boolean }) {
  const ro = useContext(ReadOnly) || !!roProp;
  const [e, setE] = useState(false);
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  if (e) {
    return (
      <input class="input" autoFocus value={v} style={big ? { fontSize: '20px', fontWeight: 600, height: '40px' } : { height: '30px' }}
        onInput={(x) => setV((x.target as HTMLInputElement).value)}
        onBlur={() => { setE(false); if (v !== value) onSave(v); }}
        onKeyDown={(x) => { if (x.key === 'Enter') (x.target as HTMLInputElement).blur(); if (x.key === 'Escape') { setV(value); setE(false); } }} />
    );
  }
  if (big) return <h2 style={{ fontSize: '21px', cursor: ro ? 'default' : 'text' }} onClick={() => !ro && setE(true)}>{value}</h2>;
  return (
    <button class="inline-edit" disabled={ro} style={ro ? { cursor: 'default', borderColor: 'transparent', background: 'none', color: 'inherit' } : undefined} onClick={() => setE(true)}>
      {value ? (link ? <span class="row"><span class="ellipsis">{value.replace(/^https?:\/\//, '')}</span><a href={normUrl(value)} target="_blank" rel="noopener" onClick={(x) => x.stopPropagation()}><Icon n="link" size={13} /></a></span> : value) : <span class="muted">—</span>}
    </button>
  );
}

function ListEdit({ values, onSave, parse, render }: { values: string[]; onSave: (v: string[]) => void; parse: (s: string) => string[]; render?: (v: string) => any }) {
  const ro = useContext(ReadOnly);
  const [e, setE] = useState(false);
  const [v, setV] = useState(values.join(', '));
  useEffect(() => setV(values.join(', ')), [values.join()]);
  if (e) return <input class="input" autoFocus style={{ height: '30px' }} value={v} onInput={(x) => setV((x.target as HTMLInputElement).value)} onBlur={() => { setE(false); onSave(parse(v)); }} onKeyDown={(x) => x.key === 'Enter' && (x.target as HTMLInputElement).blur()} />;
  return (
    <div class="row wrap" style={{ gap: '8px' }}>
      {values.map((x) => <span>{render ? render(x) : isEmail(x) ? <a href={`mailto:${x}`}>{x}</a> : x}</span>)}
      {!ro && <button class="btn btn--ghost btn--sm btn--icon" onClick={() => setE(true)} title="Edit"><Icon n="edit" size={13} /></button>}
      {!values.length && <span class="muted small">—</span>}
    </div>
  );
}

function Timeline({ acts, contacts }: { acts: Activity[]; contacts: Contact[] }) {
  const s = useStore();
  if (!acts.length) return <div class="empty"><b>Nothing yet</b>Every call, message and note shows up here.</div>;
  return (
    <div class="timeline">
      {acts.map((x) => {
        const o = x.outcome ? OUTCOME.get(x.outcome) : undefined;
        const c = contacts.find((p) => p.id === x.contactId);
        return (
          <div class={`tl ${x.system ? 'tl--sys' : ''}`}>
            <span class="tl__dot">{o?.icon || (x.system ? '•' : x.channel === 'whatsapp' ? '💬' : x.channel === 'email' ? '✉️' : '📝')}</span>
            <div>
              <div class="row wrap" style={{ gap: '6px' }}>
                <b class="small">{o?.label || x.note || x.channel}</b>
                {x.stageTo && !x.system && <span class="chip chip--accent">→ {stageLabel(x.stageTo)}</span>}
                {x.statusTo === 'lost' && <span class="chip chip--bad">Closed</span>}
                {x.statusTo === 'parked' && <span class="chip chip--warn">Parked</span>}
                {x.onTime && <span class="chip chip--good" title="Done on time">on time</span>}
                {s.isX && <button class="btn btn--ghost btn--sm btn--icon right x-del" title="Delete forever" onClick={() => { s.destroy('activity', x.id); toast('Deleted'); }}><Icon n="trash" size={13} /></button>}
              </div>
              <div class="tl__meta">{fmtWhen(x.at)} · {s.nameOf(x.createdBy)}{c ? ` · with ${c.name}` : ''}{x.channel !== 'call' && x.channel !== 'note' ? ` · ${x.channel}` : ''}</div>
              {x.note && !x.system && <div class="tl__note">{x.note}</div>}
              {x.transcript && x.transcript !== x.note && <details class="tiny muted" style={{ marginTop: '3px' }}><summary>Voice transcript</summary>{x.transcript}</details>}
            </div>
          </div>
        );
      })}
    </div>
  );
}

const FIELD_LABEL: Record<string, string> = {
  next: 'Next step', stage: 'Stage', status: 'Status', heat: 'Warmth', attempts: 'Attempts', cadence: 'Follow-up #', primaryContactId: 'Main contact', phones: 'Phones', emails: 'Emails',
  name: 'Name', designation: 'Designation', voided: 'Removed', owner: 'Owner', lostReason: 'Close reason', role: 'Role', found: 'Found online', brief: 'Brief', badPhones: 'Wrong numbers',
};

function Trail({ a, contacts }: { a: Account; contacts: Contact[] }) {
  const s = useStore();
  const [rows, setRows] = useState<AuditRow[] | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    post({ action: 'history', token: s.token, ids: [a.id, ...contacts.map((c) => c.id)] })
      .then((r) => (r.ok ? setRows((r.rows as AuditRow[]).sort((x, y) => y.seq - x.seq)) : setErr('Could not load the trail')))
      .catch(() => setErr('Offline — the trail loads when you reconnect'));
  }, [a.id, a.rev]);
  if (err) return <div class="empty">{err}</div>;
  if (!rows) return <div class="col">{[1, 2, 3].map(() => <div class="skeleton" style={{ height: '44px' }} />)}</div>;
  if (!rows.length) return <div class="empty"><b>No changes recorded yet</b></div>;
  const show = (k: string, v: any) => {
    if (v == null || v === '') return '—';
    if (k === 'next' && typeof v === 'object') return `${actionLabel(v.type)} ${fmtWhen(v.due)}`;
    if (k === 'stage') return stageLabel(v);
    if (k === 'owner' || k === 'assignee') return s.nameOf(v);
    if (k === 'primaryContactId') return contacts.find((c) => c.id === v)?.name || v;
    if (Array.isArray(v)) return v.join(', ') || '—';
    if (typeof v === 'object') return '…';
    return String(v).slice(0, 80);
  };
  return (
    <div class="col" style={{ gap: '8px' }}>
      <p class="tiny muted">Every change, who made it and when.</p>
      {rows.map((r) => {
        const target = r.id === a.id ? '' : contacts.find((c) => c.id === r.id)?.name || 'contact';
        const ch = Object.entries(r.changes).filter(([k]) => !['brief', 'found', 'updatedAt'].includes(k));
        return (
          <div class="row" style={{ alignItems: 'flex-start', gap: '10px' }}>
            <Avatar id={r.by} name={s.nameOf(r.by)} size="sm" />
            <div class="grow small">
              <div><b>{s.nameOf(r.by)}</b> <span class="muted">{r.op === 'create' ? 'created' : 'changed'} {target}{' · '}{fmtWhen(r.at)}</span></div>
              {r.op === 'update' && ch.slice(0, 6).map(([k, [from, to]]) => (
                <div class="tiny"><span class="muted">{FIELD_LABEL[k] || k}:</span> <s class="muted">{show(k, from)}</s> → {show(k, to)}</div>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}
