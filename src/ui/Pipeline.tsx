import { useState } from 'preact/hooks';
import type { Account, StageId } from '../lib/types';
import { useStore } from '../lib/store';
import { STAGES, stageLabel } from '../lib/defaults';
import { assigneeOf, actionLabel, canEdit, stageMove } from '../lib/schedule';
import { fmtWhen, norm } from '../lib/util';
import { Avatar, Heat, Icon, Seg } from './components';
import { openAccount, toast } from './bus';

export function Pipeline() {
  const s = useStore();
  const [scope, setScope] = useState<'all' | 'mine'>('all');
  const [q, setQ] = useState('');
  const [over, setOver] = useState<StageId | null>(null);
  const [drag, setDrag] = useState<string | null>(null);
  const contacts = s.contactsBy();
  const me = s.me!.id;
  const qq = norm(q);
  const list = s.accounts().filter((a) => (a.status === 'open' || a.status === 'parked' || a.status === 'won')
    && (scope === 'all' || assigneeOf(a, s.team) === me || a.owner === me)
    && (!qq || norm(`${a.name} ${a.city || ''} ${(contacts.get(a.id) || []).map((c) => c.name).join(' ')}`).includes(qq)));

  const move = (id: string, st: StageId) => {
    const a = s.get<Account>(id);
    if (!a || a.stage === st) return;
    if (!canEdit(a, s.team, me, s.isX)) {
      const w = assigneeOf(a, s.team);
      toast(w ? `${a.name} is ${s.nameOf(w)}'s lead — you can view it, not move it` : `${a.name} isn't assigned to you yet`);
      return;
    }
    s.batch(`Moved ${a.name} to ${stageLabel(st)}`, [
      { rec: a, set: { ...stageMove(a, st, s.team), status: st === 'assessment' ? 'won' : a.status === 'won' ? 'open' : a.status, ...(st !== 'new' && !a.next ? { next: { type: 'call', due: new Date().toISOString() } } : {}) } },
      { kind: 'activity', create: { accountId: a.id, channel: 'note', at: new Date().toISOString(), stageFrom: a.stage, stageTo: st, system: true, note: `Moved to ${stageLabel(st)}` } },
    ]);
    toast(`${a.name} → ${stageLabel(st)}`, { undo: true });
  };

  return (
    <div>
      <div class="page-head">
        <div><h1>Pipeline</h1><p class="muted small">{list.length} active · drag a card to move it</p></div>
        <div class="row right wrap">
          <div class="search" style={{ width: '220px' }}><Icon n="search" /><input class="input" placeholder="Filter" value={q} onInput={(e) => setQ((e.target as HTMLInputElement).value)} /></div>
          <Seg value={scope} options={[['all', 'Everyone'], ['mine', 'Mine']]} onChange={setScope} />
        </div>
      </div>
      <div class="board">
        {STAGES.map((st) => {
          const items = list.filter((a) => a.stage === st.id).sort((x, y) => (x.next?.due || 'z').localeCompare(y.next?.due || 'z'));
          return (
            <div class={`lane ${over === st.id ? 'is-over' : ''}`}
              onDragOver={(e) => { e.preventDefault(); setOver(st.id); }}
              onDragLeave={() => setOver(null)}
              onDrop={(e) => { e.preventDefault(); setOver(null); const id = e.dataTransfer?.getData('text/plain'); if (id) move(id, st.id); }}>
              <div class="lane__head"><span class="stage" data-s={st.id}>{st.label}</span><span class="muted right num">{items.length}</span></div>
              <div class="lane__list">
                {items.slice(0, 150).map((a) => {
                  const c = (contacts.get(a.id) || []).find((x) => x.id === a.primaryContactId) || contacts.get(a.id)?.[0];
                  const who = assigneeOf(a, s.team);
                  const late = a.next && new Date(a.next.due).getTime() < Date.now();
                  const mine = canEdit(a, s.team, me, s.isX);
                  return (
                    <div class={`bcard ${drag === a.id ? 'is-drag' : ''} ${mine ? '' : 'is-ro'}`} draggable={mine} title={mine ? undefined : who ? `${s.nameOf(who)}'s lead — view only` : 'Not assigned yet — view only'} onDragStart={(e) => { e.dataTransfer?.setData('text/plain', a.id); setDrag(a.id); }} onDragEnd={() => setDrag(null)} onClick={() => openAccount(a.id)}>
                      <div class="row"><span class="bcard__name ellipsis grow">{a.name}</span><Heat v={a.heat} /></div>
                      <div class="tiny muted ellipsis">{c ? `${c.name}${c.designation ? ` · ${c.designation}` : ''}` : a.city || '—'}</div>
                      <div class="row" style={{ marginTop: '6px' }}>
                        {a.status === 'parked' ? <span class="chip chip--warn">Parked</span> : a.next ? <span class={`chip ${late ? 'chip--warn' : ''}`}>{actionLabel(a.next.type)} · {fmtWhen(a.next.due)}</span> : a.status === 'won' ? <span class="chip chip--good">Won</span> : null}
                        {who && <span class="right"><Avatar id={who} name={s.nameOf(who)} size="sm" /></span>}
                      </div>
                    </div>
                  );
                })}
                {items.length > 150 && <p class="tiny muted" style={{ padding: '6px' }}>+{items.length - 150} more — use Leads to search</p>}
                {!items.length && <p class="tiny muted" style={{ padding: '10px 6px' }}>{st.hint}</p>}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
