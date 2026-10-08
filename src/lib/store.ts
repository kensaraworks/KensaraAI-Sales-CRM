/**
 * Client state: an offline-first mirror of the backend.
 * Every change is an op: applied instantly here, queued in an outbox, pushed on the next sync.
 * The server stamps who/when on each record and keeps the audit trail.
 */
import { useEffect, useState } from 'preact/hooks';
import type { Account, Activity, Claim, Contact, ID, Kind, Me, Member, Op, Rec, Settings, SyncResponse, Tombstone } from './types';
import { post } from './api';
import { withDefaults } from './defaults';
import { allRecords, clearAll, kvGet, kvSet, putRecords } from './idb';
import { buildTimeModel, loadMap, type Load, type TimeModel } from './schedule';
import type { OutcomeInput, Plan } from './workflow';
import { newId, nowISO, rand } from './util';

export interface UndoEntry { id: string; label: string; ops: Op[]; oids: string[]; rev: number; at: number }
type SyncState = 'idle' | 'syncing' | 'offline' | 'error';

const LS_SESSION = 'ks-session';
const LS_DEVICE = 'ks-device';
const LS_UNDO = 'ks-undo';
/** Poll fast while someone is working, slower when idle, rarely when the tab is hidden. */
const POLL_ACTIVE_MS = 5000;
const POLL_IDLE_MS = 15000;
const POLL_HIDDEN_MS = 60000;
const BATCH = 500;
/** The apps-script/Code.gs VERSION this build needs (keep in step with that file). */
export const BACKEND_VERSION = 4;

export function deviceId(): string {
  try {
    let d = localStorage.getItem(LS_DEVICE);
    if (!d) { d = rand(16); localStorage.setItem(LS_DEVICE, d); }
    return d;
  } catch { return 'nodevice'; }
}

export function deviceLabel(): string {
  const ua = navigator.userAgent;
  const os = /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Windows/.test(ua) ? 'Windows' : /Mac/.test(ua) ? 'Mac' : /Linux/.test(ua) ? 'Linux' : 'Device';
  const br = /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  return `${br} on ${os}`;
}

function applyLocal(map: Map<ID, Rec>, op: Op, me: ID) {
  const cur = map.get(op.id);
  const at = nowISO();
  if (op.t === 'del') {
    map.delete(op.id);
    if (op.kind === 'account') for (const [id, r] of map) if ((r as any).accountId === op.id) map.delete(id);
    return;
  }
  if (op.t === 'put' && !cur) {
    map.set(op.id, { ...op.data, id: op.id, kind: op.kind, rev: 0, createdAt: at, createdBy: me, updatedAt: at, updatedBy: me } as Rec);
    return;
  }
  if (!cur) return;
  const patch = op.t === 'put' ? op.data : op.set;
  const next: any = { ...cur, updatedAt: at, updatedBy: me };
  for (const [k, v] of Object.entries(patch)) { if (v === null) delete next[k]; else next[k] = v; }
  map.set(op.id, next);
}

class Store {
  base = new Map<ID, Rec>();
  view = new Map<ID, Rec>();
  outbox: Op[] = [];
  since = 0;
  epoch = '';
  floor = 0;
  cfgRev = -1;
  settings: Settings = withDefaults();
  team: Member[] = [];
  me: Me | null = null;
  token = '';
  claims: Record<ID, Claim> = {};
  focus: ID | null = null;
  state: SyncState = 'idle';
  lastSync = 0;
  ready = false;
  undoStack: UndoEntry[] = [];
  version = 0;
  /** Version reported by the live backend (0 = an old copy that doesn't report one). */
  backendVersion = -1;
  /** Shows a message to the user (wired to the toast in the UI). */
  onNotice?: (msg: string) => void;
  private subs = new Set<() => void>();
  private memo = new Map<string, { v: number; val: any }>();
  private syncing = false;
  private again = false;
  private timer: ReturnType<typeof setTimeout> | undefined;

  subscribe(fn: () => void) { this.subs.add(fn); return () => { this.subs.delete(fn); }; }
  emit() { this.version++; this.subs.forEach((f) => f()); }
  /** Re-render for status only (sync dot) without invalidating cached queues and stats. */
  quiet() { this.subs.forEach((f) => f()); }

  /** Cache a derived value until the next change. */
  sel<T>(key: string, fn: () => T): T {
    const m = this.memo.get(key);
    if (m && m.v === this.version) return m.val;
    const val = fn();
    this.memo.set(key, { v: this.version, val });
    return val;
  }

  /* ------------------------------------------------------------ session */

  async boot() {
    try {
      const s = JSON.parse(localStorage.getItem(LS_SESSION) || 'null');
      if (s?.token) { this.token = s.token; this.me = s.me; }
    } catch { /* none */ }
    try { this.undoStack = JSON.parse(localStorage.getItem(LS_UNDO) || '[]'); } catch { this.undoStack = []; }
    if (this.token) {
      const [recs, meta, outbox] = await Promise.all([allRecords<Rec>(), kvGet<any>('meta'), kvGet<Op[]>('outbox')]);
      for (const r of recs) this.base.set(r.id, r);
      if (meta) Object.assign(this, { since: meta.since, epoch: meta.epoch, floor: meta.floor || 0, cfgRev: meta.cfgRev ?? -1, team: meta.team || [] }), (this.settings = withDefaults(meta.settings));
      this.outbox = outbox || [];
      this.rebuild();
      this.ready = recs.length > 0 || !!meta;
      this.emit();
      this.startLoop();
      this.sync();
    } else this.emit();
  }

  async login(name: string, pin: string): Promise<string | null> {
    const r = await post({ action: 'login', name, pin, device: deviceId(), label: deviceLabel() });
    if (!r.ok) return r.error === 'locked' ? 'Too many tries. Please wait a few minutes.' : r.error === 'missing' ? 'Enter your name and PIN.' : "That didn't match. Check your name and PIN.";
    if (this.me && this.me.id !== r.me.id) await this.wipeLocal();
    this.token = r.token;
    this.me = r.me;
    localStorage.setItem(LS_SESSION, JSON.stringify({ token: r.token, me: r.me }));
    this.emit();
    this.startLoop();
    await this.sync();
    return null;
  }

  async logout() {
    try { await post({ action: 'logout', token: this.token }); } catch { /* offline */ }
    await this.wipeLocal();
    localStorage.removeItem(LS_SESSION);
    this.token = '';
    this.me = null;
    clearTimeout(this.timer);
    this.emit();
  }

  private async wipeLocal() {
    await clearAll();
    this.base.clear(); this.view.clear(); this.outbox = []; this.since = 0; this.epoch = ''; this.cfgRev = -1; this.undoStack = [];
    localStorage.removeItem(LS_UNDO);
  }

  get isX() { return this.me?.x === 1; }

  /* ------------------------------------------------------------ sync */

  private lastInput = Date.now();
  private lastRemote = 0;

  private pollDelay() {
    if (document.visibilityState !== 'visible') return POLL_HIDDEN_MS;
    const t = Date.now();
    return t - this.lastInput < 3 * 60e3 || t - this.lastRemote < 60e3 ? POLL_ACTIVE_MS : POLL_IDLE_MS;
  }

  private startLoop() {
    clearTimeout(this.timer);
    const tick = () => {
      if (document.visibilityState === 'visible') this.sync();
      this.timer = setTimeout(tick, this.pollDelay());
    };
    this.timer = setTimeout(tick, this.pollDelay());
    if (!(this as any)._listeners) {
      (this as any)._listeners = true;
      const seen = () => { this.lastInput = Date.now(); };
      window.addEventListener('pointerdown', seen, { passive: true });
      window.addEventListener('keydown', seen, { passive: true });
      window.addEventListener('focus', () => this.token && this.sync());
      window.addEventListener('online', () => this.token && this.sync());
      document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && this.token && this.sync());
    }
  }

  private soon = (() => { let t: any; return () => { clearTimeout(t); t = setTimeout(() => this.sync(), 500); }; })();

  setFocus(id: ID | null) {
    if (this.focus === id) return;
    this.focus = id;
    if (id) this.soon();
  }

  async sync(): Promise<void> {
    if (!this.token) return;
    if (this.syncing) { this.again = true; return; }
    this.syncing = true;
    this.again = false;
    const ops = this.outbox.slice(0, BATCH);
    this.state = 'syncing';
    this.quiet();
    let dataChanged = ops.length > 0;
    try {
      const r: SyncResponse & { ok: boolean; error?: string } = await post({
        action: 'sync', token: this.token, since: this.since, epoch: this.epoch, cfgRev: this.cfgRev, ops, focus: this.focus,
      });
      if (!r.ok) {
        if (r.error === 'auth') { await this.logout(); return; }
        this.state = 'error';
        return;
      }
      const changed: Rec[] = [];
      const dels: ID[] = [];
      if (r.full) { this.base.clear(); await clearAll(); }
      const me = this.me?.id;
      for (const c of r.changes) {
        if ((c as Tombstone).deleted) { this.base.delete(c.id); dels.push(c.id); }
        else {
          const prev = this.base.get(c.id);
          if (prev && prev.rev === c.rev) continue;
          this.base.set(c.id, c as Rec);
          changed.push(c as Rec);
          if ((c as Rec).updatedBy !== me) this.lastRemote = Date.now();
        }
      }
      if (changed.length || dels.length || r.full) dataChanged = true;
      const sent = new Set(ops.map((o) => o.oid));
      this.outbox = this.outbox.filter((o) => !sent.has(o.oid));
      for (const u of this.undoStack) for (const oid of u.oids) if (r.applied[oid]) u.rev = Math.max(u.rev, r.applied[oid]);
      if (r.rejected?.length) {
        console.warn('rejected ops', r.rejected);
        if (r.rejected.some((x) => x.error === 'forbidden')) this.onNotice?.("Some changes weren't saved — that lead isn't assigned to you");
      }
      this.since = r.seq;
      this.epoch = r.epoch;
      this.floor = r.floor || 0;
      // Changes sealed by a checkpoint can't be undone any more.
      this.undoStack = this.undoStack.filter((u) => !u.rev || u.rev > this.floor);
      if (r.settings) { this.settings = withDefaults(r.settings); dataChanged = true; this.lastRemote = Date.now(); }
      if (r.team) { this.team = r.team; dataChanged = true; }
      this.cfgRev = r.cfgRev;
      this.backendVersion = Number((r as any).bv) || 0;
      const claims = r.claims || {};
      if (JSON.stringify(claims) !== JSON.stringify(this.claims)) { this.claims = claims; dataChanged = true; }
      if (dataChanged || !this.ready) this.rebuild();
      if (!this.ready) dataChanged = true;
      this.ready = true;
      this.state = 'idle';
      this.lastSync = Date.now();
      if (dataChanged) {
        await putRecords(changed, dels);
        await kvSet('outbox', this.outbox);
        this.saveUndo();
      }
      await kvSet('meta', { since: this.since, epoch: this.epoch, floor: this.floor, cfgRev: this.cfgRev, settings: this.settings, team: this.team });
    } catch {
      this.state = 'offline';
    } finally {
      this.syncing = false;
      // Only a real data change re-computes queues and charts; a quiet poll just updates the sync dot.
      if (dataChanged) this.emit(); else this.quiet();
      if (this.again || this.outbox.length) this.soon();
    }
  }

  private rebuild() {
    const v = new Map(this.base);
    for (const op of this.outbox) applyLocal(v, op, this.me?.id || '');
    this.view = v;
  }

  /* ------------------------------------------------------------ writes */

  /** Queue ops (applied locally right away). Pass an undo label + inverse ops to make it undoable. */
  apply(ops: Op[], undo?: { label: string; ops: Op[] }) {
    if (!ops.length) return;
    this.outbox.push(...ops);
    for (const op of ops) applyLocal(this.view, op, this.me?.id || '');
    if (undo) {
      this.undoStack.push({ id: rand(4), label: undo.label, ops: undo.ops, oids: ops.map((o) => o.oid), rev: 0, at: Date.now() });
      if (this.undoStack.length > 40) this.undoStack.shift();
      this.saveUndo();
    }
    kvSet('outbox', this.outbox);
    this.emit();
    this.soon();
  }

  undo(): string | null {
    const u = this.undoStack.pop();
    if (!u) return null;
    this.apply(u.ops.map((o) => ({ ...o, oid: rand(8) })));
    this.saveUndo();
    return u.label;
  }

  private saveUndo() {
    try { localStorage.setItem(LS_UNDO, JSON.stringify(this.undoStack.slice(-40))); } catch { /* full */ }
  }

  get<T extends Rec>(id?: ID | null): T | undefined { return id ? (this.view.get(id) as T | undefined) : undefined; }

  create<T extends Rec>(kind: Kind, data: Partial<T>, label?: string, at?: Date): T {
    const id = (data.id as string) || newId(kind, at);
    const op: Op = { oid: rand(8), t: 'put', kind, id, data: { ...data, id: undefined } };
    delete (op as any).data.id;
    this.apply([op], label ? { label, ops: [{ oid: '', t: 'set', kind, id, set: { voided: true } }] } : undefined);
    return this.get<T>(id)!;
  }

  update(rec: Rec, set: Record<string, any>, label?: string) {
    const prev: Record<string, any> = {};
    const real: Record<string, any> = {};
    for (const [k, v] of Object.entries(set)) {
      const cur = (rec as any)[k];
      if (JSON.stringify(cur ?? null) === JSON.stringify(v ?? null)) continue;
      real[k] = v ?? null;
      prev[k] = cur ?? null;
    }
    if (!Object.keys(real).length) return;
    this.apply([{ oid: rand(8), t: 'set', kind: rec.kind, id: rec.id, set: real }], label ? { label, ops: [{ oid: '', t: 'set', kind: rec.kind, id: rec.id, set: prev }] } : undefined);
  }

  /** Several record changes as one undoable step. */
  batch(label: string, parts: { rec?: Rec; kind?: Kind; id?: ID; set?: Record<string, any>; create?: Record<string, any> }[]) {
    const ops: Op[] = [];
    const inv: Op[] = [];
    for (const p of parts) {
      if (p.create) {
        const kind = p.kind!;
        const id = p.id || newId(kind);
        ops.push({ oid: rand(8), t: 'put', kind, id, data: p.create });
        inv.push({ oid: '', t: 'set', kind, id, set: { voided: true } });
      } else if (p.rec && p.set) {
        const prev: Record<string, any> = {};
        const real: Record<string, any> = {};
        for (const [k, v] of Object.entries(p.set)) {
          const cur = (p.rec as any)[k];
          if (JSON.stringify(cur ?? null) === JSON.stringify(v ?? null)) continue;
          real[k] = v ?? null;
          prev[k] = cur ?? null;
        }
        if (Object.keys(real).length) {
          ops.push({ oid: rand(8), t: 'set', kind: p.rec.kind, id: p.rec.id, set: real });
          inv.unshift({ oid: '', t: 'set', kind: p.rec.kind, id: p.rec.id, set: prev });
        }
      }
    }
    this.apply(ops, { label, ops: inv });
  }

  /** Permanent delete (server enforces who may). */
  destroy(kind: Kind, id: ID) {
    this.apply([{ oid: rand(8), t: 'del', kind, id }]);
  }

  /** Turn a workflow plan into one undoable change: new contact, contact update, account update, activity. */
  commitPlan(plan: Plan, inp: OutcomeInput, label: string): Activity {
    const a = inp.account;
    const parts: Parameters<Store['batch']>[1] = [];
    let newContactId: ID | undefined;
    if (plan.newContact) {
      newContactId = newId('contact');
      parts.push({ kind: 'contact', id: newContactId, create: { ...plan.newContact, accountId: a.id } });
    }
    if (plan.contact) {
      const c = this.get<Contact>(plan.contact.id);
      if (c) parts.push({ rec: c, set: plan.contact.set });
    }
    const set: Record<string, any> = { ...plan.account };
    if (set.primaryContactId === '__new__') set.primaryContactId = newContactId;
    if (plan.next && !plan.next.contactId && newContactId) set.next = { ...plan.next, contactId: newContactId };
    parts.push({ rec: a, set });
    const actId = newId('activity');
    parts.push({ kind: 'activity', id: actId, create: { ...plan.activity } });
    this.batch(label, parts);
    return this.get<Activity>(actId)!;
  }

  /* ------------------------------------------------------------ reads */

  accounts(): Account[] {
    return this.sel('accounts', () => [...this.view.values()].filter((r): r is Account => r.kind === 'account' && !r.voided));
  }
  contactsBy(): Map<ID, Contact[]> {
    return this.sel('contactsBy', () => {
      const m = new Map<ID, Contact[]>();
      for (const r of this.view.values()) if (r.kind === 'contact' && !r.voided) { const l = m.get(r.accountId) || []; l.push(r); m.set(r.accountId, l); }
      return m;
    });
  }
  acts(): Activity[] {
    return this.sel('acts', () => [...this.view.values()].filter((r): r is Activity => r.kind === 'activity' && !r.voided).sort((a, b) => (a.at < b.at ? 1 : -1)));
  }
  actsBy(): Map<ID, Activity[]> {
    return this.sel('actsBy', () => {
      const m = new Map<ID, Activity[]>();
      for (const a of this.acts()) { const l = m.get(a.accountId) || []; l.push(a); m.set(a.accountId, l); }
      return m;
    });
  }
  model(): TimeModel { return this.sel('model', () => buildTimeModel(this.acts())); }
  load(): Load { return this.sel('load', () => loadMap(this.accounts(), this.team)); }
  member(id?: ID | null): Member | undefined { return id ? this.team.find((m) => m.id === id) : undefined; }
  nameOf(id?: ID | null): string { return (id && this.member(id)?.name) || (id === this.me?.id ? this.me?.name : '') || '—'; }
  voided(): Rec[] { return [...this.view.values()].filter((r) => r.voided); }
}

export const store = new Store();

/** Re-render on any store change. */
export function useStore() {
  const [, set] = useState(0);
  useEffect(() => store.subscribe(() => set((n) => n + 1)), []);
  return store;
}
