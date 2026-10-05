/**
 * In-browser stand-in for apps-script/Code.gs (VITE_ENDPOINT=mock). Same actions, same rules,
 * stored in this browser's localStorage, seeded with demo data so every screen has something to show.
 *
 * Demo sign-in: any name + PIN 1234. Admin passphrase: kensara-admin
 */
import type { AuditRow, Member, Op, Rec, Settings, Tombstone } from './types';
import { DEFAULT_SETTINGS } from './defaults';
import { rand } from './util';
import { seedDemo } from './seed';

interface Session { user: string; x: boolean; device: string; label: string; at: string; seen: number }
interface DB {
  seq: number;
  epoch: string;
  floor: number;
  cfgRev: number;
  settings: Settings;
  team: (Member & { pinHash?: string })[];
  records: Record<string, Rec>;
  tombs: Record<string, Tombstone>;
  audit: AuditRow[];
  access: { at: string; user: string; event: string; device: string }[];
  sessions: Record<string, Session>;
  snapshots: { id: string; at: string; by: string; seq: number; size: number }[];
  snapData: Record<string, string>;
  adminDevice: string;
  claims: Record<string, { user: string; until: number }>;
}

const KEY = 'ks-crm-mock';
const ADMIN_KEY = 'kensara-admin';
const DEMO_PIN = '1234';
const PROTECTED = new Set(['id', 'kind', 'rev', 'createdAt', 'createdBy', 'updatedAt', 'updatedBy']);
const KINDS: Record<string, string> = { account: 'c', contact: 'p', activity: 'e' };
const now = () => new Date().toISOString();
const hash = async (s: string) =>
  [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))].map((x) => x.toString(16).padStart(2, '0')).join('');

let mem: DB | null = null;
function load(): DB {
  if (mem) return mem;
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return (mem = JSON.parse(raw));
  } catch { /* fresh */ }
  const { team, records } = seedDemo();
  let seq = 0;
  for (const r of records) r.rev = ++seq;
  mem = {
    seq, epoch: rand(4), floor: 0, cfgRev: 1, settings: structuredClone(DEFAULT_SETTINGS), team,
    records: Object.fromEntries(records.map((r) => [r.id, r])), tombs: {}, audit: [], access: [], sessions: {},
    snapshots: [], snapData: {}, adminDevice: '', claims: {},
  };
  save(mem);
  return mem;
}
function save(db: DB) {
  mem = db;
  try { localStorage.setItem(KEY, JSON.stringify(db)); } catch (e) { console.warn('mock storage full', e); }
}

export function resetMock() { localStorage.removeItem(KEY); mem = null; }

function clean(v: any, depth = 0): any {
  if (v == null) return v;
  if (typeof v === 'string') return v.slice(0, 8000);
  if (typeof v === 'number' || typeof v === 'boolean') return v;
  if (Array.isArray(v)) return v.slice(0, 50).map((x) => clean(x, depth + 1));
  if (typeof v === 'object' && depth < 4) {
    const o: any = {};
    for (const [k, x] of Object.entries(v).slice(0, 80)) o[k.slice(0, 80)] = clean(x, depth + 1);
    return o;
  }
  return null;
}

const short = (v: any) => { const s = v === undefined ? null : JSON.stringify(v); return s && s.length > 300 ? `${s.slice(0, 300)}…` : v ?? null; };

function applyOps(db: DB, ops: Op[], user: string, x: boolean) {
  const applied: Record<string, number> = {};
  const rejected: { oid: string; error: string }[] = [];
  const at = now();
  for (const op of ops || []) {
    if (!op || !KINDS[op.kind] || typeof op.id !== 'string' || !op.id.startsWith(KINDS[op.kind]) || op.id.length > 40) { rejected.push({ oid: op?.oid, error: 'bad-op' }); continue; }
    const cur = db.records[op.id];
    if (op.t === 'del') {
      if (!x) { rejected.push({ oid: op.oid, error: 'forbidden' }); continue; }
      const ids = [op.id];
      if (op.kind === 'account') for (const r of Object.values(db.records)) if ((r as any).accountId === op.id) ids.push(r.id);
      for (const id of ids) {
        const r = db.records[id];
        if (!r) continue;
        delete db.records[id];
        db.tombs[id] = { id, kind: r.kind, rev: ++db.seq, deleted: true };
      }
      db.audit = db.audit.filter((a) => !ids.includes(a.id));
      applied[op.oid] = db.seq;
      continue;
    }
    if (db.tombs[op.id]) { rejected.push({ oid: op.oid, error: 'deleted' }); continue; }
    if (op.t === 'put' && !cur) {
      const data = clean(op.data) || {};
      for (const k of PROTECTED) delete data[k];
      const rec = { ...data, id: op.id, kind: op.kind, rev: ++db.seq, createdAt: at, createdBy: user, updatedAt: at, updatedBy: user } as Rec;
      if (JSON.stringify(rec).length > 40000) { db.seq--; rejected.push({ oid: op.oid, error: 'too-large' }); continue; }
      db.records[op.id] = rec;
      db.audit.push({ seq: db.seq, at, by: user, op: 'create', kind: op.kind, id: op.id, changes: Object.fromEntries(Object.entries(data).filter(([, v]) => v != null && v !== '').map(([k, v]) => [k, [null, short(v)]])) });
      applied[op.oid] = db.seq;
      continue;
    }
    if (!cur) { rejected.push({ oid: op.oid, error: 'missing' }); continue; }
    const patch = clean(op.t === 'put' ? op.data : op.set) || {};
    const changes: Record<string, [any, any]> = {};
    const next: any = { ...cur };
    for (const [k, v] of Object.entries(patch)) {
      if (PROTECTED.has(k)) continue;
      if (JSON.stringify((cur as any)[k] ?? null) === JSON.stringify(v ?? null)) continue;
      changes[k] = [short((cur as any)[k]), short(v)];
      if (v === null) delete next[k];
      else next[k] = v;
    }
    if (!Object.keys(changes).length) { applied[op.oid] = cur.rev; continue; }
    Object.assign(next, { rev: ++db.seq, updatedAt: at, updatedBy: user });
    db.records[op.id] = next;
    db.audit.push({ seq: db.seq, at, by: user, op: 'update', kind: op.kind, id: op.id, changes });
    applied[op.oid] = db.seq;
  }
  return { applied, rejected };
}

async function auth(db: DB, token: string) {
  if (typeof token !== 'string') return null;
  const s = db.sessions[await hash(token)];
  if (!s) return null;
  const m = db.team.find((t) => t.id === s.user);
  if (!m || !m.active) return null;
  return { s, m };
}

const pubTeam = (db: DB) => db.team.map(({ pinHash, ...m }) => m);

export async function mockHandle(b: any): Promise<any> {
  await new Promise((r) => setTimeout(r, 120 + Math.random() * 180));
  const db = load();

  if (b.action === 'login') {
    const name = String(b.name || '').trim();
    const pin = String(b.pin || '');
    if (!name || !pin) return { ok: false, error: 'missing' };
    let m = db.team.find((t) => t.name.toLowerCase() === name.toLowerCase());
    let x = false;
    if (pin === ADMIN_KEY) {
      if (db.adminDevice && db.adminDevice !== (await hash(String(b.device)))) return { ok: false, error: 'bad-pin' };
      if (!m) { m = { id: `u${rand(4)}`, name, active: true, stages: [] }; db.team.push(m); db.cfgRev++; }
      x = true;
    } else if (!m) {
      if (pin !== DEMO_PIN) return { ok: false, error: 'bad-pin' };
      m = { id: `u${rand(4)}`, name, active: true, stages: [] };
      db.team.push(m);
      db.cfgRev++;
    } else if (m.pinHash ? m.pinHash !== (await hash(`${pin}:${m.id}`)) : pin !== DEMO_PIN) return { ok: false, error: 'bad-pin' };
    if (!m.active) return { ok: false, error: 'bad-pin' };
    const token = rand(24);
    db.sessions[await hash(token)] = { user: m.id, x, device: String(b.device || ''), label: String(b.label || ''), at: now(), seen: Date.now() };
    db.access.unshift({ at: now(), user: m.id, event: x ? 'login (elevated)' : 'login', device: String(b.label || '') });
    save(db);
    return { ok: true, token, me: { id: m.id, name: m.name, ...(x ? { x: 1 } : {}) } };
  }

  const a = await auth(db, b.token);
  if (!a) return { ok: false, error: 'auth' };
  const { s, m } = a;
  const x = s.x;

  switch (b.action) {
    case 'sync': {
      if (Date.now() - s.seen > 30 * 60e3) db.access.unshift({ at: now(), user: m.id, event: 'open', device: s.label });
      s.seen = Date.now();
      const res = applyOps(db, b.ops || [], m.id, x);
      const t = Date.now();
      for (const [k, c] of Object.entries(db.claims)) if (c.until < t || c.user === m.id) delete db.claims[k];
      if (b.focus) db.claims[b.focus] = { user: m.id, until: t + 10 * 60e3 };
      const full = b.epoch !== db.epoch;
      const since = full ? 0 : Number(b.since) || 0;
      const changes = [...Object.values(db.records), ...(full ? [] : Object.values(db.tombs))].filter((r) => r.rev > since);
      save(db);
      return {
        ok: true, seq: db.seq, epoch: db.epoch, floor: db.floor, changes, ...res, full, cfgRev: db.cfgRev,
        ...(b.cfgRev !== db.cfgRev ? { settings: db.settings, team: pubTeam(db) } : {}),
        claims: Object.fromEntries(Object.entries(db.claims).filter(([, c]) => c.user !== m.id)),
        ...(x ? { me: { id: m.id, name: m.name, x: 1 } } : {}),
      };
    }
    case 'history':
      return { ok: true, rows: db.audit.filter((r) => r.id === b.id || (b.ids || []).includes(r.id)).slice(-200) };
    case 'ai':
      return devAI(b);
    case 'logout':
      for (const [k, v] of Object.entries(db.sessions)) if (v === s) delete db.sessions[k];
      save(db);
      return { ok: true };
    case 'x':
      if (!x) return { ok: false, error: 'unknown-action' };
      return adminOp(db, b, m.id);
  }
  return { ok: false, error: 'unknown-action' };
}

async function adminOp(db: DB, b: any, me: string): Promise<any> {
  const done = (extra: any = {}) => { save(db); return { ok: true, ...extra }; };
  switch (b.op) {
    case 'settings':
      db.settings = b.settings; db.cfgRev++;
      return done();
    case 'member': {
      const p = b.member || {};
      let m = db.team.find((t) => t.id === p.id);
      if (!m) { m = { id: `u${rand(4)}`, name: '', active: true, stages: [] }; db.team.push(m); }
      if (p.name != null) {
        const clash = db.team.find((t) => t !== m && t.name.toLowerCase() === String(p.name).trim().toLowerCase());
        if (clash) return { ok: false, error: 'Someone already has that name' };
        m.name = String(p.name).trim().slice(0, 60);
      }
      if (p.active != null) m.active = !!p.active;
      if (p.stages) m.stages = p.stages;
      if (p.targets !== undefined) m.targets = p.targets || undefined;
      if (p.color) m.color = p.color;
      let pin = '';
      if (b.newPin) {
        pin = String(b.pin || '').trim() || String(100000 + Math.floor(Math.random() * 900000));
        if (!/^\d{4,8}$/.test(pin)) return { ok: false, error: 'PIN must be 4–8 digits' };
        m.pinHash = await hash(`${pin}:${m.id}`);
        for (const [k, v] of Object.entries(db.sessions)) if (v.user === m.id && !v.x) delete db.sessions[k];
      }
      if (!m.active) for (const [k, v] of Object.entries(db.sessions)) if (v.user === m.id) delete db.sessions[k];
      db.cfgRev++;
      const { pinHash, ...pub } = m;
      return done({ member: pub, pin, hasPin: !!pinHash });
    }
    case 'access':
      return { ok: true, rows: db.access.slice(0, 1000) };
    case 'sessions':
      return {
        ok: true,
        rows: Object.entries(db.sessions).map(([k, v]) => ({ id: k.slice(0, 12), user: v.user, x: v.x, label: v.label, at: v.at, seen: new Date(v.seen).toISOString() })),
        adminDevice: !!db.adminDevice,
      };
    case 'revoke':
      for (const k of Object.keys(db.sessions)) if (k.startsWith(b.id)) delete db.sessions[k];
      return done();
    case 'device-lock':
      db.adminDevice = b.on ? await hash(String(b.device)) : '';
      return done();
    case 'snapshot': {
      const id = `s${Date.now()}`;
      const data = JSON.stringify({ records: db.records, settings: db.settings, team: db.team, seq: db.seq });
      db.snapData = { ...Object.fromEntries(Object.entries(db.snapData).slice(-4)), [id]: data };
      db.snapshots.unshift({ id, at: now(), by: me, seq: db.seq, size: data.length });
      db.floor = db.seq;
      return done({ snapshot: db.snapshots[0] });
    }
    case 'snapshots':
      return { ok: true, rows: db.snapshots.filter((s) => db.snapData[s.id]) };
    case 'restore': {
      const raw = db.snapData[b.id];
      if (!raw) return { ok: false, error: 'Snapshot not found' };
      const snap = JSON.parse(raw);
      db.records = snap.records;
      db.settings = snap.settings;
      db.team = snap.team;
      db.tombs = {};
      for (const r of Object.values(db.records)) r.rev = ++db.seq;
      db.epoch = rand(4);
      db.floor = db.seq;
      db.cfgRev++;
      return done();
    }
    case 'purge-history':
      db.audit = db.audit.filter((r) => !(b.ids || [b.id]).includes(r.id));
      return done();
    case 'mirror':
      return { ok: true, url: '' };
  }
  return { ok: false, error: 'unknown-op' };
}

/** Optional: set VITE_DEV_GEMINI_KEY in .env.local to try AI features in mock mode. */
async function devAI(b: any) {
  const key = import.meta.env.VITE_DEV_GEMINI_KEY as string | undefined;
  if (!key) return { ok: false, error: 'ai-off' };
  const model = b.search ? 'gemini-2.5-flash' : 'gemini-3.5-flash';
  const body: any = {
    contents: [{ role: 'user', parts: [{ text: b.prompt }] }],
    ...(b.system ? { systemInstruction: { parts: [{ text: b.system }] } } : {}),
    generationConfig: { temperature: b.temperature ?? 0.4, ...(b.json && !b.search ? { responseMimeType: 'application/json' } : {}) },
    ...(b.search ? { tools: [{ google_search: {} }] } : {}),
  };
  try {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    const j = await r.json();
    const text = j?.candidates?.[0]?.content?.parts?.map((p: any) => p.text || '').join('') || '';
    const sources = (j?.candidates?.[0]?.groundingMetadata?.groundingChunks || []).map((c: any) => c.web?.uri).filter(Boolean);
    return text ? { ok: true, text, sources } : { ok: false, error: 'ai-empty', detail: j?.error?.message };
  } catch (e) {
    return { ok: false, error: 'ai-failed', detail: String(e) };
  }
}
