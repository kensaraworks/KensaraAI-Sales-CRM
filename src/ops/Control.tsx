/**
 * Elevated console. Lazy-loaded only for an elevated session, and every action here is
 * re-checked by the server — hiding the UI is convenience, not the security boundary.
 */
import { useEffect, useState } from 'preact/hooks';
import type { Account, Activity, Channel, Contact, Member, Rec, Settings, StageId, TargetKey } from '../lib/types';
import { store, useStore, deviceId } from '../lib/store';
import { post } from '../lib/api';
import { STAGES, DEFAULT_SETTINGS } from '../lib/defaults';
import { fmtWhen, rel } from '../lib/util';
import { Avatar, Icon, Spinner, Toggle } from '../ui/components';
import { toast } from '../ui/bus';

type Tab = 'team' | 'targets' | 'workflow' | 'messaging' | 'access' | 'saves' | 'removed' | 'security';

const x = (op: string, extra: Record<string, any> = {}) => post({ action: 'x', op, token: store.token, ...extra });

// Ctrl/⌘+S anywhere in the app: quiet checkpoint (registered once, when this chunk loads).
if (!(window as any).__ksSave) {
  (window as any).__ksSave = true;
  window.addEventListener('keydown', (e) => {
    if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== 's' || !store.isX) return;
    e.preventDefault();
    x('snapshot').then((r) => { if (r.ok) { toast('Saved'); store.sync(); } else toast('Save failed'); }).catch(() => toast('Offline'));
  });
}

export default function Control() {
  const [tab, setTab] = useState<Tab>('team');
  const tabs: [Tab, string][] = [['team', 'Team'], ['targets', 'Targets'], ['workflow', 'Workflow'], ['messaging', 'Messaging & AI'], ['access', 'Sign-ins'], ['saves', 'Checkpoints'], ['removed', 'Removed'], ['security', 'Security']];
  return (
    <div>
      <div class="page-head"><div><h1>Settings</h1><p class="muted small">Only you can see this. <span class="kbd">Ctrl S</span> saves a checkpoint from anywhere.</p></div></div>
      <div class="row wrap" style={{ marginBottom: '18px' }}>
        {tabs.map(([t, l]) => <button class={`chip ${tab === t ? 'is-on' : ''}`} style={{ height: '30px', padding: '0 12px' }} onClick={() => setTab(t)}>{l}</button>)}
      </div>
      {tab === 'team' && <Team />}
      {tab === 'targets' && <Targets />}
      {tab === 'workflow' && <Workflow />}
      {tab === 'messaging' && <Messaging />}
      {tab === 'access' && <Access />}
      {tab === 'saves' && <Saves />}
      {tab === 'removed' && <Removed />}
      {tab === 'security' && <Security />}
    </div>
  );
}

/* ------------------------------------------------------------------ settings helper */

function useSettings(): [Settings, (p: Partial<Settings>) => void, () => Promise<void>, boolean] {
  const s = useStore();
  const [draft, setDraft] = useState<Settings>(structuredClone(s.settings));
  const [dirty, setDirty] = useState(false);
  useEffect(() => { if (!dirty) setDraft(structuredClone(s.settings)); }, [s.cfgRev]);
  const update = (p: Partial<Settings>) => { setDraft((d) => ({ ...d, ...p })); setDirty(true); };
  const save = async () => {
    const r = await x('settings', { settings: draft });
    if (r.ok) { setDirty(false); toast('Settings saved — everyone gets them within a minute'); store.sync(); } else toast(r.error || 'Save failed');
  };
  return [draft, update, save, dirty];
}

const SaveBar = ({ dirty, save }: { dirty: boolean; save: () => void }) =>
  dirty ? <div class="bulk" style={{ position: 'sticky' }}><span class="small grow">Unsaved changes</span><button class="btn btn--sm" onClick={save} style={{ background: 'var(--bg)', color: 'var(--ink)' }}>Save changes</button></div> : null;

/* ------------------------------------------------------------------ team */

function Team() {
  const s = useStore();
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [shown, setShown] = useState<{ name: string; pin: string } | null>(null);

  const saveMember = async (member: Partial<Member>, opts: { newPin?: boolean; pin?: string } = {}) => {
    const r = await x('member', { member, ...opts });
    if (!r.ok) { toast(r.error || 'Failed'); return null; }
    if (r.pin) setShown({ name: r.member.name, pin: r.pin });
    store.sync();
    return r;
  };

  return (
    <div class="col" style={{ gap: '12px' }}>
      {shown && (
        <div class="banner banner--accent">
          <Icon n="check" />
          <div class="grow small">PIN for <b>{shown.name}</b>: <b class="num" style={{ fontSize: '18px', letterSpacing: '.15em' }}>{shown.pin}</b> — share it with them now; it won't be shown again. They sign in once per device.</div>
          <button class="btn btn--sm" onClick={() => setShown(null)}>Done</button>
        </div>
      )}
      <p class="small muted">Tick the stages each person works. Leads route to whoever works their current stage (several people on one stage share the work evenly), unless you've assigned a lead to someone. Leads in a stage nobody works stay unassigned until you assign them. <b>Edit all leads</b> lets that person move and edit anyone's leads. <b>Assign (with your OK)</b> lets them request assignments, which wait for your approval.</p>
      <div class="table-wrap">
        <table class="t">
          <thead><tr><th>Person</th>{STAGES.map((st) => <th style={{ textAlign: 'center' }}>{st.short}</th>)}<th title="May move and edit every lead, not just their own. Assigning stays with you.">Edit all leads</th><th title="May ask to assign leads to anyone; nothing changes until you approve.">Assign (with your OK)</th><th>Active</th><th /></tr></thead>
          <tbody>
            {s.team.map((m) => (
              <tr style={{ cursor: 'default' }}>
                <td><span class="row"><Avatar id={m.id} name={m.name} size="sm" /><b>{m.name}</b>{m.id === s.me?.id && <span class="tiny muted">(you)</span>}</span></td>
                {STAGES.map((st) => (
                  <td style={{ textAlign: 'center' }}>
                    <input type="checkbox" checked={m.stages.includes(st.id)} aria-label={`${m.name} works ${st.label}`}
                      onChange={(e) => saveMember({ id: m.id, stages: (e.target as HTMLInputElement).checked ? [...m.stages, st.id] : m.stages.filter((z) => z !== st.id) as StageId[] })} />
                  </td>
                ))}
                <td><Toggle on={!!m.editAll} label={`${m.name} can edit all leads`} onChange={(v) => saveMember({ id: m.id, editAll: v })} /></td>
                <td><Toggle on={!!m.assignAsk} label={`${m.name} can request assignments`} onChange={(v) => saveMember({ id: m.id, assignAsk: v })} /></td>
                <td><Toggle on={m.active} label="Active" onChange={(v) => saveMember({ id: m.id, active: v })} /></td>
                <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                  <MemberMenu m={m} onPin={() => saveMember({ id: m.id }, { newPin: true })} onRename={(n) => saveMember({ id: m.id, name: n })} onColor={(c) => saveMember({ id: m.id, color: c })} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {adding ? (
        <div class="row">
          <input class="input" autoFocus placeholder="Name they'll sign in with" value={name} onInput={(e) => setName((e.target as HTMLInputElement).value)} style={{ maxWidth: '280px' }}
            onKeyDown={(e) => e.key === 'Enter' && name.trim() && saveMember({ name: name.trim(), stages: [] }, { newPin: true }).then(() => { setAdding(false); setName(''); })} />
          <button class="btn btn--primary" disabled={!name.trim()} onClick={() => saveMember({ name: name.trim(), stages: [] }, { newPin: true }).then(() => { setAdding(false); setName(''); })}>Add & create PIN</button>
          <button class="btn btn--ghost" onClick={() => setAdding(false)}>Cancel</button>
        </div>
      ) : <button class="btn" style={{ alignSelf: 'flex-start' }} onClick={() => setAdding(true)}><Icon n="plus" /> Add team member</button>}
      <TargetOverrides />
    </div>
  );
}

function MemberMenu({ m, onPin, onRename, onColor }: { m: Member; onPin: () => void; onRename: (n: string) => void; onColor: (c: string) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <span style={{ position: 'relative' }}>
      <button class="btn btn--ghost btn--sm" onClick={() => setOpen(!open)}>Manage</button>
      {open && (
        <div class="card" style={{ position: 'absolute', right: 0, top: '34px', zIndex: 5, width: '220px', padding: '6px', boxShadow: 'var(--shadow-lg)', textAlign: 'left' }}>
          <button class="nav__item" onClick={() => { setOpen(false); onPin(); }}><Icon n="bolt" /> New PIN</button>
          <button class="nav__item" onClick={() => { setOpen(false); const n = prompt('New name', m.name); if (n?.trim()) onRename(n.trim()); }}><Icon n="edit" /> Rename</button>
          <div class="row wrap" style={{ padding: '6px 10px', gap: '6px' }}>
            {['#0d9488', '#5b5bd6', '#c2255c', '#d9480f', '#2f9e44', '#1971c2', '#9c36b5', '#e67700'].map((c) => (
              <button aria-label={c} onClick={() => { setOpen(false); onColor(c); }} style={{ width: '20px', height: '20px', borderRadius: '50%', border: 0, background: c }} />
            ))}
          </div>
        </div>
      )}
    </span>
  );
}

function TargetOverrides() {
  const s = useStore();
  const on = (Object.entries(s.settings.targets) as [TargetKey, Settings['targets'][TargetKey]][]).filter(([, t]) => t.on);
  if (!on.length) return null;
  const set = async (m: Member, k: TargetKey, v: string) => {
    const targets = { ...(m.targets || {}) };
    if (v === '') delete targets[k]; else targets[k] = Number(v);
    const r = await x('member', { member: { id: m.id, targets: Object.keys(targets).length ? targets : null } });
    if (r.ok) store.sync();
  };
  return (
    <div style={{ marginTop: '12px' }}>
      <h3>Per-person targets</h3>
      <p class="small muted" style={{ margin: '4px 0 10px' }}>Leave blank to use the team target.</p>
      <div class="table-wrap">
        <table class="t">
          <thead><tr><th>Person</th>{on.map(([, t]) => <th>{t.label}<div class="tiny muted">team {t.value}/{t.per}</div></th>)}</tr></thead>
          <tbody>
            {s.team.filter((m) => m.active).map((m) => (
              <tr style={{ cursor: 'default' }}>
                <td><b>{m.name}</b></td>
                {on.map(([k]) => (
                  <td><input class="input" style={{ width: '80px', height: '30px' }} type="number" min="0" placeholder="—" value={m.targets?.[k] ?? ''} onChange={(e) => set(m, k, (e.target as HTMLInputElement).value)} /></td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ targets & fun */

function Targets() {
  const [d, update, save, dirty] = useSettings();
  return (
    <div class="col" style={{ gap: '14px', maxWidth: '760px' }}>
      <div class="card">
        {(Object.entries(d.targets) as [TargetKey, Settings['targets'][TargetKey]][]).map(([k, t]) => (
          <div class="map-row" style={{ gridTemplateColumns: 'auto 1fr 110px 130px' }}>
            <Toggle on={t.on} label={t.label} onChange={(v) => update({ targets: { ...d.targets, [k]: { ...t, on: v } } })} />
            <b class="small">{t.label}</b>
            <input class="input" type="number" min="0" style={{ height: '32px' }} value={t.value} onInput={(e) => update({ targets: { ...d.targets, [k]: { ...t, value: Number((e.target as HTMLInputElement).value) } } })} />
            <select class="select" style={{ height: '32px' }} value={t.per} onChange={(e) => update({ targets: { ...d.targets, [k]: { ...t, per: (e.target as HTMLSelectElement).value as any } } })}>
              <option value="day">per day</option><option value="week">per week</option><option value="month">per month</option>
            </select>
          </div>
        ))}
      </div>
      <p class="small muted">"New leads opened" also sets how many fresh leads each person gets per day (before the follow-up throttle kicks in).</p>
      <h3>Fun stuff</h3>
      <div class="card">
        {([['points', 'Points & levels'], ['leaderboard', 'Leaderboard'], ['streaks', 'Daily streaks'], ['confetti', 'Confetti on big wins']] as [keyof Settings['fun'], string][]).map(([k, l]) => (
          <div class="map-row" style={{ gridTemplateColumns: 'auto 1fr' }}>
            <Toggle on={d.fun[k]} label={l} onChange={(v) => update({ fun: { ...d.fun, [k]: v } })} /><span class="small">{l}</span>
          </div>
        ))}
      </div>
      <SaveBar dirty={dirty} save={save} />
    </div>
  );
}

/* ------------------------------------------------------------------ workflow */

function Workflow() {
  const [d, update, save, dirty] = useSettings();
  const [hol, setHol] = useState({ date: '', name: '' });
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  return (
    <div class="col" style={{ gap: '16px', maxWidth: '760px' }}>
      <div class="card card--pad col" style={{ gap: '12px' }}>
        <h3>Pacing</h3>
        <div class="grid2">
          <label class="field"><span>Pause new outreach when overdue follow-ups reach</span><input class="input" type="number" min="0" value={d.backlogLimit} onInput={(e) => update({ backlogLimit: Number((e.target as HTMLInputElement).value) })} /></label>
          <label class="field"><span>Reminder call after sending details (minutes)</span><input class="input" type="number" min="5" value={d.remindAfterMin} onInput={(e) => update({ remindAfterMin: Number((e.target as HTMLInputElement).value) })} /></label>
        </div>
        <p class="tiny muted">Fresh leads slow down gradually as overdue follow-ups build up, and stop at this number. 0 turns pacing off.</p>
      </div>

      <div class="card card--pad col" style={{ gap: '12px' }}>
        <h3>Follow-up cadence</h3>
        <p class="small muted">After details are shared and there's no clear answer, follow-ups go out at these gaps (working days), alternating channels. After the last one: every {d.cadence.nurtureDays} days until a clear yes or no.</p>
        <div class="row wrap">
          {d.cadence.gaps.map((g, i) => (
            <div class="card" style={{ padding: '8px', width: '96px' }}>
              <div class="tiny muted">#{i + 1}</div>
              <input class="input" type="number" min="1" style={{ height: '30px' }} value={g} onInput={(e) => { const gaps = [...d.cadence.gaps]; gaps[i] = Number((e.target as HTMLInputElement).value); update({ cadence: { ...d.cadence, gaps } }); }} />
              <select class="select" style={{ height: '28px', marginTop: '4px', fontSize: '12px' }} value={d.cadence.channels[i] || 'call'} onChange={(e) => { const channels = [...d.cadence.channels]; channels[i] = (e.target as HTMLSelectElement).value as Channel; update({ cadence: { ...d.cadence, channels } }); }}>
                <option value="call">Call</option><option value="whatsapp">WhatsApp</option><option value="email">Email</option>
              </select>
            </div>
          ))}
          <div class="col" style={{ gap: '4px' }}>
            <button class="btn btn--sm" onClick={() => update({ cadence: { ...d.cadence, gaps: [...d.cadence.gaps, 7], channels: [...d.cadence.channels, 'call'] } })}><Icon n="plus" /></button>
            {d.cadence.gaps.length > 2 && <button class="btn btn--sm" onClick={() => update({ cadence: { ...d.cadence, gaps: d.cadence.gaps.slice(0, -1), channels: d.cadence.channels.slice(0, -1) } })}>−</button>}
          </div>
        </div>
        <label class="field" style={{ maxWidth: '240px' }}><span>Then every (days)</span><input class="input" type="number" min="7" value={d.cadence.nurtureDays} onInput={(e) => update({ cadence: { ...d.cadence, nurtureDays: Number((e.target as HTMLInputElement).value) } })} /></label>
      </div>

      <div class="card card--pad col" style={{ gap: '12px' }}>
        <h3>Working hours</h3>
        <div class="row wrap">{days.map((l, i) => <button class={`chip ${d.workDays.includes(i) ? 'is-on' : ''}`} onClick={() => update({ workDays: d.workDays.includes(i) ? d.workDays.filter((z) => z !== i) : [...d.workDays, i].sort() })}>{l}</button>)}</div>
        <div class="grid3">
          <label class="field"><span>Start</span><input class="input" type="time" value={d.workStart} onInput={(e) => update({ workStart: (e.target as HTMLInputElement).value })} /></label>
          <label class="field"><span>End</span><input class="input" type="time" value={d.workEnd} onInput={(e) => update({ workEnd: (e.target as HTMLInputElement).value })} /></label>
          <label class="field"><span>Lunch (no calls)</span>
            <div class="row"><input class="input" type="time" value={d.lunch?.[0] || ''} onInput={(e) => update({ lunch: [(e.target as HTMLInputElement).value, d.lunch?.[1] || '14:00'] })} /><input class="input" type="time" value={d.lunch?.[1] || ''} onInput={(e) => update({ lunch: [d.lunch?.[0] || '13:00', (e.target as HTMLInputElement).value] })} /></div>
          </label>
        </div>
        <h3 style={{ marginTop: '6px' }}>Holidays</h3>
        <p class="tiny muted">No follow-ups get scheduled on these days. Names are also understood in notes ("call after Diwali").</p>
        <div class="row wrap">{d.holidays.map((h) => <span class="chip">{h.name} · {h.date}<button class="btn btn--ghost btn--sm btn--icon" style={{ height: '18px', width: '18px' }} onClick={() => update({ holidays: d.holidays.filter((z) => z !== h) })}><Icon n="x" size={11} /></button></span>)}</div>
        <div class="row">
          <input class="input" type="date" style={{ maxWidth: '170px' }} value={hol.date} onInput={(e) => setHol({ ...hol, date: (e.target as HTMLInputElement).value })} />
          <input class="input" placeholder="Name (e.g. Holi)" value={hol.name} onInput={(e) => setHol({ ...hol, name: (e.target as HTMLInputElement).value })} />
          <button class="btn" disabled={!hol.date || !hol.name} onClick={() => { update({ holidays: [...d.holidays, hol].sort((a, b) => a.date.localeCompare(b.date)) }); setHol({ date: '', name: '' }); }}>Add</button>
        </div>
      </div>
      <button class="btn btn--ghost btn--sm" style={{ alignSelf: 'flex-start' }} onClick={() => update({ cadence: DEFAULT_SETTINGS.cadence, backlogLimit: DEFAULT_SETTINGS.backlogLimit, remindAfterMin: DEFAULT_SETTINGS.remindAfterMin })}>Reset pacing & cadence to defaults</button>
      <SaveBar dirty={dirty} save={save} />
    </div>
  );
}

/* ------------------------------------------------------------------ messaging */

function Messaging() {
  const [d, update, save, dirty] = useSettings();
  return (
    <div class="col" style={{ gap: '14px', maxWidth: '760px' }}>
      <div class="card card--pad col" style={{ gap: '12px' }}>
        <label class="field"><span>What we sell (AI uses this in every message and brief)</span><textarea class="textarea" rows={5} value={d.pitch} onInput={(e) => update({ pitch: (e.target as HTMLTextAreaElement).value })} /></label>
        <div class="grid2">
          <label class="field"><span>Deck / brochure link</span><input class="input" value={d.links.deck} placeholder="https://…" onInput={(e) => update({ links: { ...d.links, deck: (e.target as HTMLInputElement).value } })} /></label>
          <label class="field"><span>Website</span><input class="input" value={d.links.website} onInput={(e) => update({ links: { ...d.links, website: (e.target as HTMLInputElement).value } })} /></label>
          <label class="field"><span>Booking link (Calendly / Google)</span><input class="input" value={d.links.booking} placeholder="optional" onInput={(e) => update({ links: { ...d.links, booking: (e.target as HTMLInputElement).value } })} /></label>
          <label class="field"><span>Signature</span><input class="input" value={d.signature} onInput={(e) => update({ signature: (e.target as HTMLInputElement).value })} /></label>
        </div>
      </div>
      <div class="card card--pad row">
        <Toggle on={d.ai.enabled} label="AI" onChange={(v) => update({ ai: { enabled: v } })} />
        <div class="grow small"><b>AI assistance</b><div class="muted tiny">Voice-note understanding, personalised messages, call briefs, column mapping, number finding. Uses the free Gemini key set in the backend (Script Properties). Off → everything falls back to rules and templates.</div></div>
      </div>
      <SaveBar dirty={dirty} save={save} />
    </div>
  );
}

/* ------------------------------------------------------------------ sign-ins */

function Access() {
  const s = useStore();
  const [rows, setRows] = useState<any[] | null>(null);
  const [who, setWho] = useState('');
  useEffect(() => { x('access').then((r) => setRows(r.ok ? r.rows : [])); }, []);
  if (!rows) return <Spinner />;
  const shown = rows.filter((r) => !who || r.user === who);
  return (
    <div class="col" style={{ gap: '10px' }}>
      <div class="row">
        <p class="small muted grow">Every sign-in, and every time someone opens the app after 30+ minutes away.</p>
        <select class="select" style={{ width: 'auto', height: '32px' }} value={who} onChange={(e) => setWho((e.target as HTMLSelectElement).value)}>
          <option value="">Everyone</option>{s.team.map((m) => <option value={m.id}>{m.name}</option>)}
        </select>
      </div>
      <div class="table-wrap">
        <table class="t">
          <thead><tr><th>When</th><th>Who</th><th>What</th><th>Device</th></tr></thead>
          <tbody>{shown.slice(0, 500).map((r) => <tr style={{ cursor: 'default' }}><td>{fmtWhen(r.at)}<div class="tiny muted">{rel(r.at)}</div></td><td>{s.nameOf(r.user)}</td><td>{r.event}</td><td class="small muted">{r.device}</td></tr>)}</tbody>
        </table>
        {!shown.length && <div class="empty">No sign-ins yet</div>}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ checkpoints */

function Saves() {
  const s = useStore();
  const [rows, setRows] = useState<any[] | null>(null);
  const [busy, setBusy] = useState(false);
  const load = () => x('snapshots').then((r) => setRows(r.ok ? r.rows : []));
  useEffect(() => { load(); }, []);
  return (
    <div class="col" style={{ gap: '12px', maxWidth: '760px' }}>
      <div class="card card--pad col" style={{ gap: '8px' }}>
        <p class="small">A checkpoint is a full copy of all data. Saving one also locks in everything so far — nobody can undo changes made before it. A checkpoint is also taken automatically every night.</p>
        <button class="btn btn--primary" style={{ alignSelf: 'flex-start' }} disabled={busy} onClick={async () => { setBusy(true); const r = await x('snapshot'); setBusy(false); if (r.ok) { toast('Saved'); load(); store.sync(); } else toast(r.error || 'Failed'); }}>
          {busy ? <Spinner /> : <Icon n="check" />} Save checkpoint now
        </button>
      </div>
      {!rows ? <Spinner /> : (
        <div class="table-wrap">
          <table class="t">
            <thead><tr><th>Saved</th><th>By</th><th>Size</th><th /></tr></thead>
            <tbody>{rows.map((r) => (
              <tr style={{ cursor: 'default' }}>
                <td>{fmtWhen(r.at)}<div class="tiny muted">{rel(r.at)}</div></td><td>{r.by === 'auto' ? 'Nightly' : s.nameOf(r.by)}</td><td class="small muted">{Math.round((r.size || 0) / 1024)} KB</td>
                <td style={{ textAlign: 'right' }}><button class="btn btn--sm" onClick={async () => {
                  if (!confirm(`Restore everything to ${fmtWhen(r.at)}? Changes made after it will be replaced (take a checkpoint first if unsure).`)) return;
                  const res = await x('restore', { id: r.id });
                  if (res.ok) { toast('Restored'); store.sync(); } else toast(res.error || 'Failed');
                }}>Restore</button></td>
              </tr>
            ))}</tbody>
          </table>
          {!rows.length && <div class="empty">No checkpoints yet</div>}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ removed items */

function Removed() {
  const s = useStore();
  const [hold, setHold] = useState<string | null>(null);
  const items = s.voided().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const label = (r: Rec) => r.kind === 'account' ? (r as Account).name : r.kind === 'contact' ? `${(r as Contact).name} · ${s.get<Account>((r as Contact).accountId)?.name || ''}` : `Activity · ${s.get<Account>((r as Activity).accountId)?.name || ''} · ${(r as Activity).outcome || (r as Activity).note || ''}`;
  const del = (r: Rec) => {
    if (hold !== r.id) { setHold(r.id); setTimeout(() => setHold(null), 2500); return; }
    s.destroy(r.kind, r.id);
    toast('Deleted forever');
  };
  return (
    <div class="col" style={{ gap: '10px' }}>
      <p class="small muted">Things the team removed (or undid). They're hidden from everyone. Restore them, or delete them for good — deleting also erases their edit history.</p>
      {items.length > 0 && <div class="row"><button class="btn btn--sm btn--danger right" onClick={() => { if (confirm(`Delete all ${items.length} removed items forever?`)) { items.forEach((r) => s.destroy(r.kind, r.id)); toast('Deleted forever'); } }}><Icon n="trash" /> Delete all forever</button></div>}
      <div class="table-wrap">
        <table class="t">
          <thead><tr><th>Item</th><th>Removed by</th><th>When</th><th /></tr></thead>
          <tbody>{items.slice(0, 300).map((r) => (
            <tr style={{ cursor: 'default' }}>
              <td><span class="chip" style={{ marginRight: '6px' }}>{r.kind === 'account' ? 'Lead' : r.kind === 'contact' ? 'Person' : 'Activity'}</span>{label(r)}</td>
              <td>{s.nameOf(r.updatedBy)}</td><td class="small muted">{rel(r.updatedAt)}</td>
              <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                <button class="btn btn--sm" onClick={() => s.update(r, { voided: false }, 'Restored')}>Restore</button>{' '}
                <button class="btn btn--sm btn--danger" onClick={() => del(r)}>{hold === r.id ? 'Confirm' : 'Delete forever'}</button>
              </td>
            </tr>
          ))}</tbody>
        </table>
        {!items.length && <div class="empty">Nothing removed</div>}
      </div>
      <ExportCsv />
    </div>
  );
}

function ExportCsv() {
  const s = useStore();
  const go = () => {
    const cs = s.contactsBy();
    const head = ['Company', 'City', 'Sector', 'Stage', 'Status', 'Next step', 'Due', 'Main contact', 'Designation', 'Phones', 'Emails', 'Website', 'Updated by', 'Updated at'];
    const rows = s.accounts().map((a) => {
      const c = (cs.get(a.id) || []).find((p) => p.id === a.primaryContactId);
      return [a.name, a.city, a.sector, a.stage, a.status, a.next?.type, a.next?.due, c?.name, c?.designation, [...(c?.phones || []), ...a.phones].join(' / '), [...(c?.emails || []), ...a.emails].join(' / '), a.website, s.nameOf(a.updatedBy), a.updatedAt];
    });
    const csv = [head, ...rows].map((r) => r.map((v) => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',')).join('\n');
    const url = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv' }));
    const el = document.createElement('a');
    el.href = url; el.download = `kensara-leads-${new Date().toISOString().slice(0, 10)}.csv`; el.click();
    URL.revokeObjectURL(url);
  };
  return <button class="btn btn--sm" style={{ alignSelf: 'flex-start', marginTop: '12px' }} onClick={go}><Icon n="import" /> Download all leads (CSV)</button>;
}

/* ------------------------------------------------------------------ security */

function Security() {
  const s = useStore();
  const [d, setD] = useState<{ rows: any[]; adminDevice: boolean } | null>(null);
  const load = () => x('sessions').then((r) => setD(r.ok ? { rows: r.rows, adminDevice: r.adminDevice } : { rows: [], adminDevice: false }));
  useEffect(() => { load(); }, []);
  if (!d) return <Spinner />;
  return (
    <div class="col" style={{ gap: '14px', maxWidth: '820px' }}>
      <div class="card card--pad row">
        <Toggle on={d.adminDevice} label="Lock to this device" onChange={async (v) => { const r = await x('device-lock', { on: v, device: deviceId() }); if (r.ok) { toast(v ? 'Locked to this device' : 'Unlocked'); load(); } }} />
        <div class="grow small"><b>Only this device can open Settings</b><div class="muted tiny">Even with the passphrase, other devices sign in as a normal team member. Lost this device? Delete the ADMIN_DEVICE script property in Apps Script to unlock.</div></div>
      </div>
      <h3>Signed-in devices</h3>
      <div class="table-wrap">
        <table class="t">
          <thead><tr><th>Who</th><th>Device</th><th>Signed in</th><th>Last seen</th><th /></tr></thead>
          <tbody>{d.rows.sort((a, b) => b.seen.localeCompare(a.seen)).map((r) => (
            <tr style={{ cursor: 'default' }}>
              <td>{s.nameOf(r.user)}{r.x ? ' ✦' : ''}</td><td class="small">{r.label}</td><td class="small muted">{fmtWhen(r.at)}</td><td class="small muted">{rel(r.seen)}</td>
              <td style={{ textAlign: 'right' }}><button class="btn btn--sm btn--danger" onClick={async () => { await x('revoke', { id: r.id }); toast('Signed out'); load(); }}>Sign out</button></td>
            </tr>
          ))}</tbody>
        </table>
      </div>
      <p class="tiny muted">Every change is kept in the edit trail; a checkpoint is taken every night.</p>
    </div>
  );
}
