import { useEffect, useMemo, useState } from 'preact/hooks';
import type { Account, Contact, StageId, Status } from '../lib/types';
import { useStore } from '../lib/store';
import { STAGES, stageLabel } from '../lib/defaults';
import { assigneeOf, actionLabel, assignTo, canEdit, stageMove } from '../lib/schedule';
import { extractLead } from '../lib/ai';
import { queueEnrich, enrichState, onEnrich } from '../lib/enrichQueue';
import { companyKey, fmtWhen, norm, rel, uniq } from '../lib/util';
import { normPhone, normUrl, prettyPhone } from '../lib/phone';
import { Avatar, Icon, Seg, Sheet, Stage, VoiceCapture } from './components';
import { openAccount, set, toast, useUI } from './bus';

type SortKey = 'next' | 'updated' | 'name' | 'created';

export function Leads() {
  const s = useStore();
  const [q, setQ] = useState('');
  const [stage, setStage] = useState<StageId | ''>('');
  const [status, setStatus] = useState<Status | 'all'>('open');
  const [owner, setOwner] = useState('');
  const [noPhone, setNoPhone] = useState(false);
  const [city, setCity] = useState('');
  const [sector, setSector] = useState('');
  const [sort, setSort] = useState<SortKey>('next');
  const [limit, setLimit] = useState(100);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const contacts = s.contactsBy();
  const all = s.accounts();

  const cities = useMemo(() => uniq(all.map((a) => a.city).filter(Boolean) as string[]).sort(), [all.length]);
  const sectors = useMemo(() => uniq(all.map((a) => a.sector).filter(Boolean) as string[]).sort(), [all.length]);
  const qq = norm(q);

  const rows = useMemo(() => {
    const r = all.filter((a) => {
      if (status !== 'all' && a.status !== status && !(status === 'open' && a.status === 'parked')) return false;
      if (stage && a.stage !== stage) return false;
      if (owner === '__none' && assigneeOf(a, s.team) !== null) return false;
      if (owner && owner !== '__none' && assigneeOf(a, s.team) !== owner && a.owner !== owner) return false;
      if (city && a.city !== city) return false;
      if (sector && a.sector !== sector) return false;
      const cs = contacts.get(a.id) || [];
      if (noPhone && (a.phones.length || cs.some((c) => c.phones.length))) return false;
      if (qq) {
        const hay = norm(`${a.name} ${a.city || ''} ${a.sector || ''} ${a.phones.join(' ')} ${a.emails.join(' ')} ${cs.map((c) => `${c.name} ${c.designation || ''} ${c.phones.join(' ')} ${c.emails.join(' ')}`).join(' ')} ${Object.values(a.extra || {}).join(' ')}`);
        if (!qq.split(' ').every((w) => hay.includes(w) || hay.replace(/\s/g, '').includes(w))) return false;
      }
      return true;
    });
    const by: Record<SortKey, (a: Account, b: Account) => number> = {
      next: (a, b) => (a.next?.due || 'z').localeCompare(b.next?.due || 'z'),
      updated: (a, b) => b.updatedAt.localeCompare(a.updatedAt),
      created: (a, b) => b.createdAt.localeCompare(a.createdAt),
      name: (a, b) => a.name.localeCompare(b.name),
    };
    return r.sort(by[sort]);
  }, [s.version, q, stage, status, owner, noPhone, city, sector, sort]);

  const me = s.me!.id;
  const selectable = (a: Account) => canEdit(a, s.team, me, s.isX);
  const toggle = (id: string) => { const n = new Set(sel); n.has(id) ? n.delete(id) : n.add(id); setSel(n); };
  const selected = rows.filter((a) => sel.has(a.id));

  const bulk = (label: string, set: (a: Account) => Record<string, any>) => {
    s.batch(label, selected.map((a) => ({ rec: a, set: set(a) })));
    toast(`${label} · ${selected.length}`, { undo: true });
    setSel(new Set());
  };

  return (
    <div>
      <div class="page-head">
        <div><h1>Leads</h1><p class="muted small">{rows.length} of {all.length}</p></div>
        <div class="row right">
          <button class="btn btn--primary" onClick={() => set({ addLead: true })}><Icon n="plus" /> Add lead</button>
        </div>
      </div>

      <div class="row wrap" style={{ marginBottom: '12px' }}>
        <div class="search grow" style={{ minWidth: '220px' }}><Icon n="search" /><input class="input" placeholder="Search company, person, phone, email…" value={q} onInput={(e) => setQ((e.target as HTMLInputElement).value)} /></div>
        <Seg value={status} options={[['open', 'Active'], ['won', 'Won'], ['lost', 'Closed'], ['all', 'All']]} onChange={setStatus} />
      </div>
      <div class="row wrap" style={{ marginBottom: '14px' }}>
        <button class={`chip ${!stage ? 'is-on' : ''}`} onClick={() => setStage('')}>All stages</button>
        {STAGES.map((st) => <button class={`chip ${stage === st.id ? 'is-on' : ''}`} onClick={() => setStage(stage === st.id ? '' : st.id)}>{st.short}</button>)}
        <button class={`chip ${noPhone ? 'is-on' : ''}`} onClick={() => setNoPhone(!noPhone)}>No phone</button>
        <select class="select" style={{ width: 'auto', height: '28px', fontSize: '12.5px' }} value={owner} onChange={(e) => setOwner((e.target as HTMLSelectElement).value)}>
          <option value="">Anyone</option>{s.isX && <option value="__none">Unassigned</option>}{s.team.filter((m) => m.active).map((m) => <option value={m.id}>{m.name}</option>)}
        </select>
        {cities.length > 1 && <select class="select" style={{ width: 'auto', height: '28px', fontSize: '12.5px' }} value={city} onChange={(e) => setCity((e.target as HTMLSelectElement).value)}><option value="">Any city</option>{cities.map((c) => <option>{c}</option>)}</select>}
        {sectors.length > 1 && <select class="select" style={{ width: 'auto', height: '28px', fontSize: '12.5px' }} value={sector} onChange={(e) => setSector((e.target as HTMLSelectElement).value)}><option value="">Any sector</option>{sectors.map((c) => <option>{c}</option>)}</select>}
        <select class="select right" style={{ width: 'auto', height: '28px', fontSize: '12.5px' }} value={sort} onChange={(e) => setSort((e.target as HTMLSelectElement).value as SortKey)}>
          <option value="next">Sort: next step</option><option value="updated">Sort: recently updated</option><option value="created">Sort: newest</option><option value="name">Sort: name</option>
        </select>
      </div>

      <EnrichProgress />

      <div class="table-wrap">
        <table class="t">
          <thead><tr>
            <th class="chk"><input type="checkbox" checked={selected.length > 0 && selected.length === Math.min(rows.length, limit)} onChange={(e) => setSel((e.target as HTMLInputElement).checked ? new Set(rows.slice(0, limit).filter(selectable).map((a) => a.id)) : new Set())} aria-label="Select all" /></th>
            <th>Company</th><th>Stage</th><th>Contact</th><th>Next</th><th>With</th><th>Updated</th>
          </tr></thead>
          <tbody>
            {rows.slice(0, limit).map((a) => {
              const cs = contacts.get(a.id) || [];
              const c: Contact | undefined = cs.find((x) => x.id === a.primaryContactId) || cs[0];
              const who = assigneeOf(a, s.team);
              const phone = c?.phones[0] || a.phones[0];
              return (
                <tr class={sel.has(a.id) ? 'is-sel' : ''} onClick={() => openAccount(a.id)}>
                  <td class="chk" onClick={(e) => { e.stopPropagation(); if (selectable(a)) toggle(a.id); }}>{selectable(a) && <input type="checkbox" checked={sel.has(a.id)} aria-label="Select" />}</td>
                  <td><b>{a.name}</b><div class="tiny muted">{[a.city, a.sector].filter(Boolean).join(' · ')}</div></td>
                  <td><Stage s={a.stage} />{a.status !== 'open' && <div class="tiny muted">{a.status === 'parked' ? 'Parked' : a.status === 'won' ? 'Won' : 'Closed'}</div>}</td>
                  <td>{c ? <>{c.name}<div class="tiny muted">{c.designation}</div></> : <span class="muted">—</span>}{!phone && <div class="tiny" style={{ color: 'var(--warn)' }}>no phone</div>}</td>
                  <td>{a.next ? <><span class="small">{actionLabel(a.next.type)}</span><div class={`tiny ${new Date(a.next.due) < new Date() ? '' : 'muted'}`} style={new Date(a.next.due) < new Date() ? { color: 'var(--bad)' } : {}}>{fmtWhen(a.next.due)}</div></> : <span class="muted">—</span>}</td>
                  <td>{who ? <Avatar id={who} name={s.nameOf(who)} size="sm" /> : <span class="muted tiny">anyone</span>}</td>
                  <td class="tiny muted">{rel(a.updatedAt)}<div>{s.nameOf(a.updatedBy)}</div></td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {!rows.length && <div class="empty"><b>No leads match</b>Try clearing a filter.</div>}
      </div>
      {rows.length > limit && <button class="btn" style={{ marginTop: '10px' }} onClick={() => setLimit(limit + 200)}>Show more ({rows.length - limit})</button>}

      {selected.length > 0 && (
        <div class="bulk">
          <b class="small">{selected.length} selected</b>
          {s.isX && <select class="select" onChange={(e) => { const v = (e.target as HTMLSelectElement).value; if (v) bulk('Assigned', () => assignTo(v === '-' ? null : v)); (e.target as HTMLSelectElement).value = ''; }}>
            <option value="">Assign to…</option><option value="-">Auto (by stage)</option>{s.team.filter((m) => m.active).map((m) => <option value={m.id}>{m.name}</option>)}
          </select>}
          <select class="select" onChange={(e) => { const v = (e.target as HTMLSelectElement).value as StageId; if (v) bulk(`Moved to ${stageLabel(v)}`, (a) => stageMove(a, v, s.team)); (e.target as HTMLSelectElement).value = ''; }}>
            <option value="">Move to…</option>{STAGES.map((st) => <option value={st.id}>{st.label}</option>)}
          </select>
          <button class="btn btn--sm" onClick={() => { const ids = selected.filter((a) => !a.phones.length && !(contacts.get(a.id) || []).some((c) => c.phones.length)).map((a) => a.id); if (!ids.length) { toast('All selected leads already have a number'); return; } queueEnrich(ids); toast(`Finding numbers for ${ids.length} — results appear on each lead`); setSel(new Set()); }}>
            <Icon n="sparkle" /> Find numbers
          </button>
          {selected.some((a) => a.status === 'lost')
            ? <button class="btn btn--sm" onClick={() => bulk('Reopened', (a) => ({ status: 'open', lostReason: null, next: a.stage === 'new' ? null : { type: 'call', due: new Date().toISOString() } }))}>Reopen</button>
            : <button class="btn btn--sm" onClick={() => bulk('Removed from pipeline', () => ({ status: 'lost', lostReason: 'Removed from pipeline', next: null }))}>Close</button>}
          {rows.filter(selectable).length > selected.length && <button class="btn btn--sm" onClick={() => setSel(new Set(rows.filter(selectable).map((a) => a.id)))}>Select all {rows.filter(selectable).length}</button>}
          <button class="btn btn--sm right" onClick={() => setSel(new Set())}>Clear</button>
        </div>
      )}
    </div>
  );
}

export function EnrichProgress() {
  const [, set] = useState(0);
  useEffect(() => onEnrich(() => set((n) => n + 1)), []);
  if (!enrichState.total) return null;
  return (
    <div class="banner banner--accent">
      <Icon n="sparkle" />
      <div class="grow small">
        {enrichState.running ? <>Finding public numbers… {enrichState.done}/{enrichState.total} · {enrichState.found} found</> : <>Search finished — found contacts for {enrichState.found} of {enrichState.total}. Review them on each lead (filter "No phone").</>}
        <div class="bar" style={{ marginTop: '6px' }}><i style={{ width: `${(enrichState.done / Math.max(1, enrichState.total)) * 100}%` }} /></div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ add lead */

export function AddLead() {
  const u = useUI();
  const s = useStore();
  const [f, setF] = useState({ company: '', city: '', sector: '', contactName: '', designation: '', phone: '', email: '', website: '' });
  const [busy, setBusy] = useState(false);
  if (!u.addLead) return null;
  const close = () => { set({ addLead: false }); setF({ company: '', city: '', sector: '', contactName: '', designation: '', phone: '', email: '', website: '' }); };
  const dup = f.company.trim().length > 2 ? s.accounts().find((a) => companyKey(a.name) === companyKey(f.company)) : undefined;
  const save = (open: boolean) => {
    if (!f.company.trim()) return;
    const phone = normPhone(f.phone);
    const a = s.create<Account>('account', {
      name: f.company.trim(), city: f.city.trim() || undefined, sector: f.sector.trim() || undefined, website: normUrl(f.website) || undefined,
      phones: phone && !f.contactName.trim() ? [phone] : [], emails: f.email.trim() && !f.contactName.trim() ? [f.email.trim().toLowerCase()] : [],
      extra: {}, stage: 'new', status: 'open', attempts: 0, cadence: 0, heat: 0, tags: [], source: 'Added manually', next: null,
    } as Partial<Account>, `Added ${f.company.trim()}`);
    if (f.contactName.trim()) {
      const c = s.create<Contact>('contact', { accountId: a.id, name: f.contactName.trim(), designation: f.designation.trim(), phones: phone ? [phone] : [], emails: f.email.trim() ? [f.email.trim().toLowerCase()] : [], role: 'unknown', status: 'active' } as any);
      s.update(s.get<Account>(a.id)!, { primaryContactId: c.id });
    }
    toast(`Added ${f.company.trim()}`, { undo: true });
    close();
    if (open) openAccount(a.id);
  };
  const inp = (k: keyof typeof f, label: string, ph = '', mode?: string) => (
    <label class="field"><span>{label}</span><input class="input" value={f[k]} placeholder={ph} inputMode={mode as any} onInput={(e) => setF({ ...f, [k]: (e.target as HTMLInputElement).value })} /></label>
  );
  return (
    <Sheet title="Add a lead" onClose={close} foot={<><button class="btn btn--ghost" onClick={close}>Cancel</button><button class="btn right" disabled={!f.company.trim()} onClick={() => save(false)}>Save</button><button class="btn btn--primary" disabled={!f.company.trim()} onClick={() => save(true)}>Save & open</button></>}>
      <div class="col" style={{ gap: '12px' }}>
        <VoiceCapture placeholder="Say the lead" onFinal={async (t) => {
          setBusy(true);
          const d = await extractLead(t);
          setBusy(false);
          setF((x) => ({ ...x, ...Object.fromEntries(Object.entries(d).filter(([, v]) => v)), phone: d.phone ? prettyPhone(d.phone) : x.phone }));
        }} />
        {busy && <span class="small muted">Filling in…</span>}
        {inp('company', 'Company', 'Company name')}
        {dup && <div class="banner" style={{ margin: 0 }}><span class="small grow">Already in the CRM: <b>{dup.name}</b>{dup.city ? `, ${dup.city}` : ''}</span><button class="btn btn--sm" onClick={() => { close(); openAccount(dup.id); }}>Open it</button></div>}
        <div class="grid2">{inp('city', 'City')}{inp('sector', 'Sector')}</div>
        <div class="grid2">{inp('contactName', 'Contact person')}{inp('designation', 'Designation')}</div>
        <div class="grid2">{inp('phone', 'Phone', '98xxx xxxxx', 'tel')}{inp('email', 'Email', '', 'email')}</div>
        {inp('website', 'Website')}
      </div>
    </Sheet>
  );
}

