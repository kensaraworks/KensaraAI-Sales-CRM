/** App-wide UI state: which panel/sheet is open, toasts, celebrations. */
import { useEffect, useState } from 'preact/hooks';
import type { ID } from '../lib/types';
import type { Purpose } from '../lib/templates';

export type Route = 'today' | 'pipeline' | 'leads' | 'insights' | 'import' | 'control';

export interface UIState {
  route: Route;
  account: ID | null;
  log: { accountId: ID; outcome?: string; contactId?: ID; text?: string } | null;
  compose: { accountId: ID; purpose?: Purpose; channel?: 'whatsapp' | 'email' } | null;
  addLead: boolean | { text?: string };
  focus: boolean;
  palette: boolean;
  requests: boolean;
}

export interface Toast { id: number; text: string; undo?: boolean; points?: number }

type Fn = () => void;
const subs = new Set<Fn>();
const parseRoute = (): { route: Route; account: ID | null } => {
  const h = location.hash.replace(/^#\/?/, '');
  const [r, q] = h.split('?');
  const route = (['today', 'pipeline', 'leads', 'insights', 'import', 'control'].includes(r) ? r : 'today') as Route;
  const account = new URLSearchParams(q || '').get('a');
  return { route, account };
};

export const ui: UIState & { toasts: Toast[]; celebrate: number; celebrateBig: boolean } = {
  ...parseRoute(),
  log: null,
  compose: null,
  addLead: false,
  focus: false,
  palette: false,
  requests: false,
  toasts: [],
  celebrate: 0,
  celebrateBig: false,
};

const emit = () => subs.forEach((f) => f());

function writeHash() {
  const h = `#/${ui.route}${ui.account ? `?a=${ui.account}` : ''}`;
  if (location.hash !== h) history.pushState(null, '', h);
}

window.addEventListener('popstate', () => { Object.assign(ui, parseRoute()); emit(); });

export function set(p: Partial<UIState>) {
  Object.assign(ui, p);
  if ('route' in p || 'account' in p) writeHash();
  emit();
}

export const go = (route: Route) => set({ route, account: null });
export const openAccount = (id: ID | null) => set({ account: id });
export const openLog = (accountId: ID, extra: Partial<NonNullable<UIState['log']>> = {}) => set({ log: { accountId, ...extra } });
export const openCompose = (accountId: ID, purpose?: Purpose, channel?: 'whatsapp' | 'email') => set({ compose: { accountId, purpose, channel } });

let tid = 0;
export function toast(text: string, o: { undo?: boolean; points?: number; ms?: number } = {}) {
  const t: Toast = { id: ++tid, text, undo: o.undo, points: o.points };
  ui.toasts = [...ui.toasts.slice(-2), t];
  emit();
  setTimeout(() => { ui.toasts = ui.toasts.filter((x) => x.id !== t.id); emit(); }, o.ms ?? (o.undo ? 6000 : 3200));
}
export const dismissToast = (id: number) => { ui.toasts = ui.toasts.filter((x) => x.id !== id); emit(); };

export function celebrate(big = false) {
  ui.celebrate++;
  ui.celebrateBig = big;
  emit();
}

export function useUI() {
  const [, setN] = useState(0);
  useEffect(() => { const f = () => setN((n) => n + 1); subs.add(f); return () => { subs.delete(f); }; }, []);
  return ui;
}
