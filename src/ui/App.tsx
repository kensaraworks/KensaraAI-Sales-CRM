import { lazy, Suspense } from 'preact/compat';
import { useEffect, useState } from 'preact/hooks';
import { store, useStore } from '../lib/store';
import { level } from '../lib/stats';
import { rel } from '../lib/util';
import { Avatar, Confetti, Icon, Toasts } from './components';
import { go, set, toast, useUI, type Route } from './bus';
import { Login } from './Login';
import { Today, useQueue } from './Today';
import { Focus } from './Focus';
import { Pipeline } from './Pipeline';
import { AddLead, Leads } from './Leads';
import { Insights } from './Insights';
import { Import } from './Import';
import { AccountPanel } from './AccountPanel';
import { LogSheet } from './LogSheet';
import { ComposeSheet } from './Compose';
import { Palette } from './Palette';

// Loaded only for an elevated session; it isn't part of the main bundle.
const Control = lazy(() => import('../ops/Control'));

const NAV: [Route, string, string][] = [
  ['today', 'Today', 'today'],
  ['pipeline', 'Pipeline', 'pipeline'],
  ['leads', 'Leads', 'leads'],
  ['insights', 'Insights', 'insights'],
  ['import', 'Import', 'import'],
];

export function App() {
  const s = useStore();
  const u = useUI();
  const [booted, setBooted] = useState(false);
  useEffect(() => { store.onNotice = (m) => toast(m, { ms: 5000 }); store.boot().then(() => setBooted(true)); }, []);
  // Elevated sessions load their extras (incl. the Ctrl+S checkpoint shortcut) in the background.
  useEffect(() => { if (s.isX) import('../ops/Control'); }, [s.isX]);

  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName;
      const typing = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); set({ palette: !u.palette }); return; }
      // Never let the browser's "save page" dialog pop up.
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); return; }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !typing) {
        e.preventDefault();
        const l = store.undo();
        toast(l ? `Undone: ${l}` : 'Nothing to undo');
        return;
      }
      if (typing || e.ctrlKey || e.metaKey || e.altKey || u.log || u.compose || u.account || u.focus) return;
      if (e.key === 'f') { e.preventDefault(); set({ focus: true }); }
      if (e.key === '/') { e.preventDefault(); set({ palette: true }); }
      if (e.key === 'n') { e.preventDefault(); set({ addLead: true }); }
      const n = Number(e.key);
      if (n >= 1 && n <= NAV.length) go(NAV[n - 1][0]);
    };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [u.palette, u.log, u.compose, u.account, u.focus]);

  if (!booted) return <div class="login"><span class="spin" /></div>;
  if (!s.token || !s.me) return <Login />;
  if (!s.ready) return <div class="login"><div class="col" style={{ alignItems: 'center' }}><span class="spin" /><p class="muted small">Getting your leads…</p></div></div>;

  const route = u.route === 'control' && !s.isX ? 'today' : u.route;
  return (
    <div class="shell">
      <Nav route={route} />
      <main class="main">
        <MobileTop />
        {route === 'today' && <Today />}
        {route === 'pipeline' && <Pipeline />}
        {route === 'leads' && <Leads />}
        {route === 'insights' && <Insights />}
        {route === 'import' && <Import />}
        {route === 'control' && s.isX && <Suspense fallback={<span class="spin" />}><Control /></Suspense>}
      </main>
      <TabBar route={route} />
      {!u.focus && <button class="fab" onClick={() => set({ palette: true })} aria-label="Search or log"><Icon n="search" /></button>}
      <AccountPanel />
      {u.focus && <Focus />}
      <LogSheet />
      <ComposeSheet />
      <AddLead />
      <Palette />
      <Toasts />
      <Confetti />
    </div>
  );
}

function Nav({ route }: { route: Route }) {
  const s = useStore();
  const q = useQueue(false);
  const due = q.now.length + q.due.length;
  const me = s.me!;
  const pts = s.acts().reduce((n, a) => n + (a.createdBy === me.id ? a.points || 0 : 0), 0);
  const lvl = level(pts);
  const undoTop = s.undoStack[s.undoStack.length - 1];
  return (
    <nav class="nav">
      <div class="brand"><span class="brand__mark">K</span>Kensara Sales</div>
      {NAV.map(([r, l, ic], i) => (
        <button class={`nav__item ${route === r ? 'is-on' : ''}`} onClick={() => go(r)} title={`${l} (${i + 1})`}>
          <Icon n={ic} />{l}
          {r === 'today' && due > 0 && <span class={`nav__badge ${q.now.length ? 'is-warn' : ''}`}>{due}</span>}
        </button>
      ))}
      {s.isX && (
        <button class={`nav__item ${route === 'control' ? 'is-on' : ''}`} onClick={() => go('control')}><Icon n="control" />Settings</button>
      )}
      <button class="nav__item" onClick={() => set({ palette: true })}><Icon n="search" />Search <span class="kbd right">Ctrl K</span></button>
      <div class="nav__foot">
        {undoTop && (
          <button class="nav__item" onClick={() => { const l = store.undo(); if (l) toast(`Undone: ${l}`); }} title="Ctrl+Z">
            <Icon n="undo" /><span class="ellipsis small">Undo {undoTop.label.split(' · ')[0].toLowerCase()}</span>
          </button>
        )}
        <SyncDot />
        <div class="me">
          <Avatar id={me.id} name={me.name} />
          <div class="grow" style={{ minWidth: 0 }}>
            <div class="small ellipsis"><b>{me.name}</b></div>
            {s.settings.fun.points ? <><div class="tiny muted">Lv {lvl.n} · {lvl.name} · {pts} pts</div><div class="me__lvl"><i style={{ width: `${lvl.pct * 100}%` }} /></div></> : null}
          </div>
          <ThemeBtn />
          <button class="btn btn--ghost btn--sm btn--icon" title="Sign out" onClick={() => { if (confirm('Sign out on this device?')) store.logout(); }}><Icon n="logout" /></button>
        </div>
      </div>
    </nav>
  );
}

function SyncDot() {
  const s = useStore();
  const pending = s.outbox.length;
  const label = s.state === 'offline' ? `Offline${pending ? ` · ${pending} to sync` : ''}` : s.state === 'syncing' ? 'Syncing…' : s.state === 'error' ? 'Sync issue — retrying' : pending ? `${pending} to sync` : `Synced ${s.lastSync ? rel(new Date(s.lastSync)) : ''}`;
  return <span class={`sync is-${s.state}`} style={{ padding: '0 10px' }}><i />{label}</span>;
}

function ThemeBtn() {
  const [t, setT] = useState(() => document.documentElement.dataset.theme || '');
  const dark = t === 'dark' || (!t && matchMedia('(prefers-color-scheme: dark)').matches);
  return (
    <button class="btn btn--ghost btn--sm btn--icon" title="Theme" onClick={() => {
      const n = dark ? 'light' : 'dark';
      document.documentElement.dataset.theme = n;
      try { localStorage.setItem('ks-theme', n); } catch { /* ignore */ }
      setT(n);
    }}><Icon n={dark ? 'sun' : 'moon'} /></button>
  );
}

function MobileTop() {
  const s = useStore();
  return (
    <div class="topbar-m">
      <span class="brand__mark">K</span>
      <SyncDot />
      <span class="right row">
        {s.undoStack.length > 0 && <button class="btn btn--ghost btn--sm btn--icon" onClick={() => { const l = store.undo(); if (l) toast(`Undone: ${l}`); }} aria-label="Undo"><Icon n="undo" /></button>}
        <ThemeBtn />
        <button class="btn btn--ghost btn--sm btn--icon" onClick={() => { if (confirm('Sign out on this device?')) store.logout(); }} aria-label="Sign out"><Icon n="logout" /></button>
      </span>
    </div>
  );
}

function TabBar({ route }: { route: Route }) {
  const s = useStore();
  const q = useQueue(false);
  const due = q.now.length + q.due.length;
  const items: [Route, string, string][] = [...NAV.slice(0, 4), ...(s.isX ? [['control', 'Settings', 'control'] as [Route, string, string]] : [NAV[4]])];
  return (
    <div class="tabbar">
      {items.map(([r, l, ic]) => (
        <button class={route === r ? 'is-on' : ''} onClick={() => go(r)}>
          <Icon n={ic} />{l}
          {r === 'today' && due > 0 && <span class="dot">{due}</span>}
        </button>
      ))}
    </div>
  );
}
