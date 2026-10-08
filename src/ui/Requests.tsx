/** Assignment requests: team members with "request assigning" ask, the admin approves or rejects. */
import { useState } from 'preact/hooks';
import type { Account, ID } from '../lib/types';
import { store, useStore } from '../lib/store';
import { assigneeOf, assignTo, canRequestAssign } from '../lib/schedule';
import { rel } from '../lib/util';
import { Avatar, Icon, Sheet } from './components';
import { openAccount, set, toast, useUI } from './bus';

export const pendingRequests = () => store.accounts().filter((a) => a.assignReq);

/** Admin: approve or reject what the team asked for. */
export function RequestsSheet() {
  const u = useUI();
  const s = useStore();
  if (!u.requests || !s.isX) return null;
  const reqs = pendingRequests().sort((a, b) => a.assignReq!.at.localeCompare(b.assignReq!.at));
  const close = () => set({ requests: false });
  const decide = (list: Account[], ok: boolean) => {
    if (!list.length) return;
    s.batch(ok ? `Approved ${list.length} assignment${list.length > 1 ? 's' : ''}` : `Rejected ${list.length} request${list.length > 1 ? 's' : ''}`,
      list.map((a) => ({ rec: a, set: ok ? { ...assignTo(a.assignReq!.to), assignReq: null } : { assignReq: null } })));
    toast(ok ? `Approved · ${list.length}` : `Rejected · ${list.length}`, { undo: true });
  };
  return (
    <Sheet title="Assignment requests" onClose={close} wide
      foot={reqs.length > 1 ? <>
        <button class="btn btn--ghost" onClick={() => decide(reqs, false)}>Reject all</button>
        <button class="btn btn--primary right" onClick={() => decide(reqs, true)}><Icon n="check" /> Approve all {reqs.length}</button>
      </> : undefined}>
      {!reqs.length ? <div class="empty"><b>Nothing waiting</b>Requests from the team show up here.</div> : (
        <div class="col" style={{ gap: '6px' }}>
          {reqs.map((a) => {
            const r = a.assignReq!;
            const now = assigneeOf(a, s.team);
            return (
              <div class="qi" style={{ gridTemplateColumns: 'auto 1fr auto', cursor: 'default' }}>
                <Avatar id={r.by} name={s.nameOf(r.by)} size="sm" />
                <div style={{ minWidth: 0 }}>
                  <div class="small"><b>{s.nameOf(r.by)}</b> wants <a href="#" onClick={(e) => { e.preventDefault(); openAccount(a.id); }}><b>{a.name}</b></a> assigned to <b>{r.to ? s.nameOf(r.to) : 'automatic (by stage)'}</b></div>
                  <div class="tiny muted">Now with {now ? s.nameOf(now) : 'nobody'} · asked {rel(r.at)}</div>
                </div>
                <div class="row" style={{ gap: '4px' }}>
                  <button class="btn btn--sm btn--ghost" onClick={() => decide([a], false)}>Reject</button>
                  <button class="btn btn--sm btn--good" onClick={() => decide([a], true)}><Icon n="check" /> Approve</button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </Sheet>
  );
}

/** For people allowed to ask: pick who the leads should go to; it waits for the admin. */
export function RequestAssign({ leads, onDone, compact }: { leads: Account[]; onDone?: () => void; compact?: boolean }) {
  const s = useStore();
  const me = s.me!.id;
  if (s.isX || !canRequestAssign(s.team, me) || !leads.length) return null;
  const ask = (to: ID | null) => {
    const at = new Date().toISOString();
    s.batch(`Requested assignment of ${leads.length}`, leads.map((a) => ({ rec: a, set: { assignReq: { to, by: me, at } } })));
    toast(`Sent for approval · ${leads.length}`, { undo: true });
    onDone?.();
  };
  return (
    <select class="select" style={compact ? { width: 'auto', height: '30px' } : undefined} onChange={(e) => {
      const v = (e.target as HTMLSelectElement).value;
      (e.target as HTMLSelectElement).value = '';
      if (v) ask(v === '-' ? null : v);
    }}>
      <option value="">Request assign to…</option>
      <option value="-">Automatic (by stage)</option>
      {s.team.filter((m) => m.active).map((m) => <option value={m.id}>{m.name}</option>)}
    </select>
  );
}

/** Shown on a lead with a pending request. */
export function RequestNote({ a }: { a: Account }) {
  const s = useStore();
  const [busy, setBusy] = useState(false);
  const r = a.assignReq;
  if (!r) return null;
  const mine = r.by === s.me?.id;
  const decide = (ok: boolean) => {
    setBusy(true);
    s.update(a, ok ? { ...assignTo(r.to), assignReq: null } : { assignReq: null }, ok ? 'Approved assignment' : 'Rejected request');
    toast(ok ? 'Approved' : 'Rejected', { undo: true });
  };
  return (
    <div class="banner banner--accent" style={{ margin: '12px 0 0' }}>
      <Icon n="user" />
      <span class="small grow"><b>{mine ? 'You' : s.nameOf(r.by)}</b> asked to assign this to <b>{r.to ? s.nameOf(r.to) : 'automatic'}</b> · {rel(r.at)}{!s.isX && ' — waiting for approval'}</span>
      {s.isX && <>
        <button class="btn btn--sm btn--ghost" disabled={busy} onClick={() => decide(false)}>Reject</button>
        <button class="btn btn--sm btn--good" disabled={busy} onClick={() => decide(true)}>Approve</button>
      </>}
      {!s.isX && mine && <button class="btn btn--sm btn--ghost" onClick={() => { s.update(a, { assignReq: null }, 'Withdrew request'); toast('Request withdrawn', { undo: true }); }}>Withdraw</button>}
    </div>
  );
}
