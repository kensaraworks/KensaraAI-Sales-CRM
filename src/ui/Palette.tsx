import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { useStore } from '../lib/store';
import { norm } from '../lib/util';
import { Icon, Stage } from './components';
import { go, openAccount, set, useUI, type Route } from './bus';

interface Item { id: string; label: string; sub?: string; icon: string; run: () => void; stage?: any }

/** Ctrl/⌘+K: jump to any lead, person or screen. */
export function Palette() {
  const u = useUI();
  const s = useStore();
  const [q, setQ] = useState('');
  const [i, setI] = useState(0);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { if (u.palette) { setQ(''); setI(0); setTimeout(() => ref.current?.focus(), 10); } }, [u.palette]);

  const items = useMemo<Item[]>(() => {
    if (!u.palette) return [];
    const close = () => set({ palette: false });
    const screens: [Route, string, string][] = [['today', 'Today', 'today'], ['pipeline', 'Pipeline', 'pipeline'], ['leads', 'Leads', 'leads'], ['insights', 'Insights', 'insights'], ['import', 'Import leads', 'import']];
    const acts: Item[] = [
      { id: 'add', label: 'Add a lead', icon: 'plus', run: () => { close(); set({ addLead: true }); } },
      { id: 'focus', label: 'Start calling (focus mode)', icon: 'play', run: () => { close(); set({ focus: true }); } },
      ...screens.map(([r, l, ic]) => ({ id: r, label: `Go to ${l}`, icon: ic, run: () => { close(); go(r); } })),
    ];
    const qq = norm(q);
    if (!qq) return acts;
    const cs = s.contactsBy();
    const hits: Item[] = [];
    for (const a of s.accounts()) {
      const people = cs.get(a.id) || [];
      const hay = norm(`${a.name} ${a.city || ''} ${a.phones.join(' ')} ${people.map((p) => `${p.name} ${p.phones.join(' ')} ${p.emails.join(' ')}`).join(' ')}`);
      if (qq.split(' ').every((w) => hay.includes(w) || hay.replace(/\s/g, '').includes(w))) {
        const who = people.find((p) => norm(p.name).includes(qq));
        hits.push({ id: a.id, label: a.name, sub: who ? `${who.name}${who.designation ? ` · ${who.designation}` : ''}` : a.city, icon: 'leads', stage: a.stage, run: () => { close(); openAccount(a.id); } });
        if (hits.length > 30) break;
      }
    }
    return [...hits, ...acts.filter((x) => norm(x.label).includes(qq))];
  }, [u.palette, q, s.version]);

  if (!u.palette) return null;
  return (
    <>
      <div class="overlay" style={{ zIndex: 94 }} onClick={() => set({ palette: false })} />
      <div class="palette" role="dialog" aria-label="Search">
        <input ref={ref} autoFocus placeholder="Search leads, people, numbers… or type a command" value={q}
          onInput={(e) => { setQ((e.target as HTMLInputElement).value); setI(0); }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') { e.preventDefault(); setI((n) => Math.min(items.length - 1, n + 1)); }
            if (e.key === 'ArrowUp') { e.preventDefault(); setI((n) => Math.max(0, n - 1)); }
            if (e.key === 'Enter') items[i]?.run();
            if (e.key === 'Escape') set({ palette: false });
          }} />
        <div class="palette__list">
          {items.map((it, k) => (
            <div class={`palette__item ${k === i ? 'is-on' : ''}`} onMouseEnter={() => setI(k)} onClick={it.run}>
              <Icon n={it.icon} size={16} />
              <div class="grow"><div class="small"><b>{it.label}</b></div>{it.sub && <div class="tiny muted">{it.sub}</div>}</div>
              {it.stage && <Stage s={it.stage} />}
            </div>
          ))}
          {!items.length && <div class="empty small">No matches</div>}
        </div>
      </div>
    </>
  );
}
