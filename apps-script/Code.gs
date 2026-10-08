/**
 * Kensara Sales CRM — free backend on Google Apps Script (Drive JSON + Sheets).
 * Mirrors src/lib/mock.ts (keep the two in sync).
 *
 * Script Properties (Project Settings → Script properties):
 *   ADMIN_KEY            – your private passphrase (12+ characters). Sign in with your name + this as the PIN.
 *   GEMINI_API_KEY       – free key from https://aistudio.google.com/apikey (optional but recommended)
 *   GEMINI_MODEL         – default "gemini-3.5-flash"
 *   GEMINI_SEARCH_MODEL  – default "gemini-2.5-flash" (free tier includes Google Search grounding)
 *   GROQ_API_KEY         – optional free fallback from https://console.groq.com/keys
 *   GROQ_MODEL           – default "llama-3.3-70b-versatile"
 *   ADMIN_DEVICE         – set by the app when you lock Settings to one device; delete it to unlock
 *
 * Storage (folder "Kensara Sales CRM" in your Drive):
 *   core.json            – accounts + contacts (+ tombstones)
 *   act-YYMM.json        – activities, one file per month
 *   config.json          – settings + team (PINs are salted hashes)
 *   sessions.json        – signed-in devices (tokens are hashed)
 *   snapshots/           – checkpoints
 * The bound spreadsheet gets: "Audit" (every change), "Sign-ins", and a read-only "Leads" view.
 */

const VERSION = 1;
const ROOT_NAME = 'Kensara Sales CRM';
const MAX_BODY = 8 * 1024 * 1024;
const SESSION_DAYS = 180;
const PIN_FAILS = 8;
const KINDS = { account: 'c', contact: 'p', activity: 'e' };
const PROTECTED = { id: 1, kind: 1, rev: 1, createdAt: 1, createdBy: 1, updatedAt: 1, updatedBy: 1 };
const AUDIT_COLS = ['Seq', 'When', 'Who', 'Who id', 'Action', 'Kind', 'Record id', 'Company', 'Changes'];

/* ================================================================== entry points */

function doPost(e) {
  let b;
  try {
    const raw = (e && e.postData && e.postData.contents) || '';
    if (raw.length > MAX_BODY) return out({ ok: false, error: 'too-large' });
    b = JSON.parse(raw || '{}');
  } catch (err) {
    return out({ ok: false, error: 'bad-request' });
  }
  try {
    const rid = typeof b.rid === 'string' && /^[a-f0-9]{8,40}$/.test(b.rid) ? 'rid:' + b.rid : '';
    if (rid) {
      const hit = cache().get(rid);
      if (hit) return ContentService.createTextOutput(hit).setMimeType(ContentService.MimeType.JSON);
    }
    const res = route(String(b.action || ''), b);
    if (rid && res.ok) {
      const s = JSON.stringify(res);
      if (s.length < 90000) cache().put(rid, s, 600);
    }
    return out(res);
  } catch (err) {
    console.error(err && err.stack || err);
    return out({ ok: false, error: 'server-error', detail: String(err).slice(0, 300) });
  }
}

function doGet() {
  return out({ ok: true, service: 'kensara-crm', version: VERSION });
}

function route(action, b) {
  if (action === 'login') return login(b);
  const a = auth(b.token);
  if (!a) return { ok: false, error: 'auth' };
  switch (action) {
    case 'sync': return sync(a, b);
    case 'history': return history(b);
    case 'ai': return ai(a, b);
    case 'logout': return logout(b.token);
    case 'x': return a.x ? adminOp(a, b) : { ok: false, error: 'unknown-action' };
  }
  return { ok: false, error: 'unknown-action' };
}

/* ================================================================== auth */

function login(b) {
  const name = String(b.name || '').trim().slice(0, 60);
  const pin = String(b.pin || '');
  if (!name || !pin) return { ok: false, error: 'missing' };
  const fk = 'lf:' + name.toLowerCase();
  const fails = Number(cache().get(fk) || 0);
  const global = Number(cache().get('lf:*') || 0);
  if (fails >= PIN_FAILS || global >= 60) return { ok: false, error: 'locked' };
  const fail = function () {
    cache().put(fk, String(fails + 1), 30 * 60);
    cache().put('lf:*', String(global + 1), 15 * 60);
    return { ok: false, error: 'bad-pin' };
  };

  const adminKey = props().getProperty('ADMIN_KEY') || '';
  const isAdminKey = adminKey.length >= 12 && pin === adminKey;
  return withLock(function () {
    const cfg = loadConfig(true);
    let m = cfg.team.filter(function (t) { return t.name.toLowerCase() === name.toLowerCase(); })[0];
    let x = false;
    if (isAdminKey) {
      const lockDev = props().getProperty('ADMIN_DEVICE');
      if (lockDev && lockDev !== hash(String(b.device || ''))) return fail();
      if (!m) {
        m = { id: 'u' + rand(4), name: name, active: true, stages: [] };
        cfg.team.push(m);
        cfg.cfgRev++;
        saveConfig(cfg);
      }
      x = true;
    } else {
      if (!m || !m.active || !m.pinHash || m.pinHash !== hash(pin + ':' + m.id)) return fail();
    }
    if (!m.active) return fail();
    cache().remove(fk);
    const token = rand(24);
    const sess = loadSessions();
    sess[hash(token)] = { user: m.id, x: x, device: hash(String(b.device || '')), label: String(b.label || '').slice(0, 60), at: now() };
    saveSessions(sess);
    logAccess(m, x ? 'login (elevated)' : 'login', String(b.label || ''));
    return { ok: true, token: token, me: x ? { id: m.id, name: m.name, x: 1 } : { id: m.id, name: m.name } };
  });
}

function auth(token) {
  if (typeof token !== 'string' || token.length < 20) return null;
  const h = hash(token);
  let s = null;
  const hit = cache().get('sess:' + h);
  if (hit) s = JSON.parse(hit);
  else {
    s = loadSessions()[h] || null;
    if (s) cache().put('sess:' + h, JSON.stringify(s), 3600);
  }
  if (!s) return null;
  if (Date.now() - new Date(s.at).getTime() > SESSION_DAYS * 864e5) return null;
  const m = loadConfig().team.filter(function (t) { return t.id === s.user; })[0];
  if (!m || !m.active) return null;
  return { id: m.id, name: m.name, x: !!s.x, h: h, label: s.label };
}

function logout(token) {
  const h = hash(String(token));
  withLock(function () { const s = loadSessions(); delete s[h]; saveSessions(s); return { ok: true }; });
  cache().remove('sess:' + h);
  return { ok: true };
}

/* ================================================================== sync */

function sync(a, b) {
  // Access trail: an "open" whenever someone comes back after 30+ minutes.
  const sk = 'seen:' + a.h;
  const last = Number(cache().get(sk) || 0);
  if (Date.now() - last > 30 * 60e3) { try { logAccess({ id: a.id, name: a.name }, 'open', a.label); } catch (err) { console.error(err); } }
  cache().put(sk, String(Date.now()), 21600);

  let res = { applied: {}, rejected: [] };
  if (b.ops && b.ops.length) {
    const r = withLock(function () { return applyOps(b.ops, a); });
    if (r.ok === false) return r;
    res = r;
  }

  const meta = getMeta();
  const full = b.epoch !== meta.epoch;
  const since = full ? 0 : Number(b.since) || 0;
  const changes = [];
  if (since < meta.seq) {
    // Fast path: recent changes are kept in memory (the journal), so most syncs never touch Drive.
    let done = false;
    if (!full) {
      const j = journalGet(meta.seq);
      if (j && since >= j.floor) {
        for (let i = 0; i < j.recs.length; i++) if (j.recs[i].rev > since) changes.push(j.recs[i]);
        done = true;
      }
    }
    if (!done) {
      const keys = Object.keys(meta.shards);
      for (let i = 0; i < keys.length; i++) {
        if (meta.shards[keys[i]] <= since) continue;
        const f = readShard(keys[i], meta.shards[keys[i]]);
        collect(f.records, since, changes);
        if (!full) collect(f.tombs, since, changes);
      }
    }
  }

  // Who's looking at which lead (soft lock shown to teammates).
  const claims = updateClaims(a.id, b.focus);
  const cfg = loadConfig();
  const resp = {
    ok: true, seq: meta.seq, epoch: meta.epoch, floor: meta.floor || 0, changes: changes, applied: res.applied, rejected: res.rejected,
    full: full, cfgRev: cfg.cfgRev, claims: claims,
  };
  if (b.cfgRev !== cfg.cfgRev) { resp.settings = cfg.settings; resp.team = pubTeam(cfg); }
  return resp;
}

function collect(map, since, outArr) {
  const ks = Object.keys(map || {});
  for (let i = 0; i < ks.length; i++) if (map[ks[i]].rev > since) outArr.push(map[ks[i]]);
}

function shardOf(kind, id) {
  if (kind !== 'activity') return 'core';
  const m = /^e(\d{4})/.exec(id);
  return m ? m[1] : 'misc';
}

function applyOps(ops, a) {
  const meta = getMeta();
  const prevSeq = meta.seq;
  const open = {};
  const get = function (k) { if (!open[k]) open[k] = readShard(k, meta.shards[k]); return open[k]; };
  const dirty = {};
  const touched = {};
  const purged = [];
  const team = loadConfig().team;
  const applied = {};
  const rejected = [];
  const audit = [];
  const at = now();
  const companyOf = function (rec) {
    if (!rec) return '';
    if (rec.kind === 'account') return rec.name || '';
    const acc = get('core').records[rec.accountId];
    return acc ? acc.name : '';
  };

  for (let i = 0; i < ops.length && i < 600; i++) {
    const op = ops[i];
    if (!op || !KINDS[op.kind] || typeof op.id !== 'string' || op.id.indexOf(KINDS[op.kind]) !== 0 || op.id.length > 40 || !/^[a-z0-9]+$/.test(op.id)) {
      rejected.push({ oid: op && op.oid, error: 'bad-op' });
      continue;
    }
    const sk = shardOf(op.kind, op.id);
    const shard = get(sk);
    const cur = shard.records[op.id];

    if (op.t === 'del') {
      if (!a.x) { rejected.push({ oid: op.oid, error: 'forbidden' }); continue; }
      const gone = [];
      const kill = function (k, id) {
        const sh = get(k);
        const r = sh.records[id];
        if (!r) return;
        delete sh.records[id];
        sh.tombs[id] = { id: id, kind: r.kind, rev: ++meta.seq, deleted: true };
        touched[id] = sh.tombs[id];
        meta.shards[k] = meta.seq;
        dirty[k] = 1;
        gone.push(id);
      };
      kill(sk, op.id);
      if (op.kind === 'account') {
        const core = get('core');
        Object.keys(core.records).forEach(function (id) { if (core.records[id].accountId === op.id) kill('core', id); });
        Object.keys(meta.shards).forEach(function (k) {
          if (k === 'core') return;
          const sh = get(k);
          Object.keys(sh.records).forEach(function (id) { if (sh.records[id].accountId === op.id) kill(k, id); });
        });
      }
      purged.push.apply(purged, gone);
      applied[op.oid] = meta.seq;
      continue;
    }

    if (shard.tombs[op.id]) { rejected.push({ oid: op.oid, error: 'deleted' }); continue; }
    if (!a.x && !permitted(op, cur, a.id, get('core').records, team)) { rejected.push({ oid: op.oid, error: 'forbidden' }); continue; }

    if (op.t === 'put' && !cur) {
      const data = clean(op.data) || {};
      Object.keys(PROTECTED).forEach(function (k) { delete data[k]; });
      const rec = Object.assign({}, data, { id: op.id, kind: op.kind, rev: ++meta.seq, createdAt: at, createdBy: a.id, updatedAt: at, updatedBy: a.id });
      if (JSON.stringify(rec).length > 40000) { meta.seq--; rejected.push({ oid: op.oid, error: 'too-large' }); continue; }
      shard.records[op.id] = rec;
      touched[op.id] = rec;
      meta.shards[sk] = meta.seq;
      dirty[sk] = 1;
      const ch = {};
      Object.keys(data).forEach(function (k) { if (data[k] != null && data[k] !== '') ch[k] = [null, short(data[k])]; });
      audit.push([meta.seq, at, a.name, a.id, 'create', op.kind, op.id, companyOf(rec), ch]);
      applied[op.oid] = meta.seq;
      continue;
    }

    if (!cur) { rejected.push({ oid: op.oid, error: 'missing' }); continue; }
    const patch = clean(op.t === 'put' ? op.data : op.set) || {};
    const changes = {};
    const next = Object.assign({}, cur);
    Object.keys(patch).forEach(function (k) {
      if (PROTECTED[k]) return;
      const v = patch[k];
      if (JSON.stringify(cur[k] == null ? null : cur[k]) === JSON.stringify(v == null ? null : v)) return;
      changes[k] = [short(cur[k]), short(v)];
      if (v === null) delete next[k]; else next[k] = v;
    });
    if (!Object.keys(changes).length) { applied[op.oid] = cur.rev; continue; }
    next.rev = ++meta.seq;
    next.updatedAt = at;
    next.updatedBy = a.id;
    shard.records[op.id] = next;
    touched[op.id] = next;
    meta.shards[sk] = meta.seq;
    dirty[sk] = 1;
    audit.push([meta.seq, at, a.name, a.id, 'update', op.kind, op.id, companyOf(next), changes]);
    applied[op.oid] = meta.seq;
  }

  if (meta.seq === prevSeq) return { applied: applied, rejected: rejected };
  Object.keys(dirty).forEach(function (k) { writeShard(k, open[k], meta.shards[k]); });
  setMeta(meta);
  journalAdd(prevSeq, meta.seq, Object.keys(touched).map(function (id) { return touched[id]; }));
  if (audit.length) { try { writeAudit(audit); } catch (err) { console.error(err); } }
  if (purged.length) { try { purgeAudit(purged); } catch (err) { console.error(err); } }
  return { applied: applied, rejected: rejected };
}

/* ---- who may change what (mirrors canEdit / assigneeOf in src/lib/schedule.ts — keep identical) */

const HANDOFF_GRACE_MS = 30 * 60e3;

function hashNum(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

function assigneeOf(acc, team) {
  if (acc.next && acc.next.assignee) return acc.next.assignee;
  const active = team.filter(function (m) { return m.active; });
  if (acc.handler && active.some(function (m) { return m.id === acc.handler; })) return acc.handler;
  const workers = active.filter(function (m) { return (m.stages || []).indexOf(acc.stage) >= 0; });
  const owner = acc.owner ? active.filter(function (m) { return m.id === acc.owner; })[0] : null;
  if (owner && (!workers.length || !(owner.stages || []).length || workers.indexOf(owner) >= 0)) return owner.id;
  if (workers.length) return workers[hashNum(acc.id) % workers.length].id;
  return null;
}

function canEdit(acc, team, me) {
  if (team.some(function (m) { return m.id === me && m.active && m.editAll; })) return true;
  const who = assigneeOf(acc, team);
  if (who === me) return true;
  if (who === null && acc.createdBy === me) return true;
  return acc.updatedBy === me && Date.now() - Date.parse(acc.updatedAt) < HANDOFF_GRACE_MS;
}

/** Team members (not the admin): never assign; only change the leads they work. */
function permitted(op, cur, me, core, team) {
  const data = op.t === 'put' ? op.data : op.t === 'set' ? op.set : {};
  const has = function (k) { return data && typeof data === 'object' && Object.prototype.hasOwnProperty.call(data, k); };
  // Assignment requests: only "request assigning" people may ask (or withdraw their own ask); the admin approves.
  if (has('assignReq')) {
    if (op.kind !== 'account' || op.t !== 'set' || Object.keys(data).length !== 1) return false;
    const v = data.assignReq;
    if (v == null) return !!(cur && cur.assignReq && cur.assignReq.by === me);
    const asker = team.filter(function (t) { return t.id === me && t.active && t.assignAsk; })[0];
    return !!asker && v.by === me && (v.to === null || team.some(function (t) { return t.id === v.to && t.active; }));
  }
  if (op.kind === 'account' && has('owner')) return false;
  // A stage hand-off may only go to someone who works the new stage (no self-assigning).
  if (op.kind === 'account' && has('handler') && data.handler != null && !(cur && cur.handler === data.handler)) {
    const stage = has('stage') ? data.stage : cur && cur.stage;
    const m = team.filter(function (t) { return t.id === data.handler && t.active; })[0];
    if (!m || (m.stages || []).indexOf(stage) < 0) return false;
  }
  if (cur && cur.createdBy === me && Date.now() - Date.parse(cur.createdAt) < HANDOFF_GRACE_MS) return true;
  const accId = op.kind === 'account' ? op.id : ((cur && cur.accountId) || (data && data.accountId));
  const acc = accId ? core[accId] : null;
  if (!acc) return true;
  return canEdit(acc, team, me);
}

function clean(v, depth) {
  depth = depth || 0;
  if (v == null) return v;
  if (typeof v === 'string') return v.slice(0, 8000);
  if (typeof v === 'number') return isFinite(v) ? v : null;
  if (typeof v === 'boolean') return v;
  if (Array.isArray(v)) return v.slice(0, 50).map(function (x) { return clean(x, depth + 1); });
  if (typeof v === 'object' && depth < 4) {
    const o = {};
    Object.keys(v).slice(0, 80).forEach(function (k) { if (k !== '__proto__' && k !== 'constructor' && k !== 'prototype') o[k.slice(0, 80)] = clean(v[k], depth + 1); });
    return o;
  }
  return null;
}

function short(v) {
  if (v === undefined) return null;
  const s = JSON.stringify(v);
  return s && s.length > 300 ? s.slice(0, 300) + '…' : v;
}

function updateClaims(me, focus) {
  let c = {};
  try { c = JSON.parse(cache().get('claims') || '{}'); } catch (err) { c = {}; }
  const t = Date.now();
  const before = JSON.stringify(c);
  // Drop expired claims and my own old one, then claim what I'm looking at now.
  Object.keys(c).forEach(function (k) { if (c[k].until < t || c[k].user === me) delete c[k]; });
  if (focus && typeof focus === 'string' && focus.length < 40) c[focus] = { user: me, until: t + 10 * 60e3 };
  if (JSON.stringify(c) !== before) cache().put('claims', JSON.stringify(c), 3600);
  const mine = {};
  Object.keys(c).forEach(function (k) { if (c[k].user !== me) mine[k] = c[k]; });
  return mine;
}

/* ================================================================== history (audit sheet) */

function history(b) {
  const ids = (Array.isArray(b.ids) ? b.ids : [b.id]).filter(function (x) { return typeof x === 'string'; }).slice(0, 40);
  const sh = sheet('Audit', AUDIT_COLS);
  const last = sh.getLastRow();
  if (last < 2) return { ok: true, rows: [] };
  const rows = [];
  const col = sh.getRange(2, 7, last - 1, 1);
  ids.forEach(function (id) {
    const found = col.createTextFinder(id).matchEntireCell(true).findAll();
    found.slice(-150).forEach(function (r) {
      const v = sh.getRange(r.getRow(), 1, 1, AUDIT_COLS.length).getValues()[0];
      let changes = {};
      try { changes = JSON.parse(v[8] || '{}'); } catch (err) { changes = {}; }
      rows.push({ seq: Number(v[0]), at: String(v[1]), by: String(v[3]), op: String(v[4]), kind: String(v[5]), id: String(v[6]), changes: changes });
    });
  });
  return { ok: true, rows: rows };
}

function writeAudit(rows) {
  const sh = sheet('Audit', AUDIT_COLS);
  const vals = rows.map(function (r) { return [String(r[0]), r[1], r[2], r[3], r[4], r[5], r[6], r[7], trunc(JSON.stringify(r[8]))]; });
  const range = sh.getRange(sh.getLastRow() + 1, 1, vals.length, AUDIT_COLS.length);
  range.setNumberFormat('@');
  range.setValues(vals);
}

function purgeAudit(ids) {
  if (!ids || !ids.length) return;
  const sh = sheet('Audit', AUDIT_COLS);
  const last = sh.getLastRow();
  if (last < 2) return;
  // One read and one write, however many rows go (deleting row by row times out on big purges).
  const gone = {};
  ids.forEach(function (id) { gone[id] = 1; });
  const range = sh.getRange(2, 1, last - 1, AUDIT_COLS.length);
  const vals = range.getValues();
  const keep = vals.filter(function (r) { return !gone[String(r[6])]; });
  if (keep.length === vals.length) return;
  range.clearContent();
  if (keep.length) {
    const r2 = sh.getRange(2, 1, keep.length, AUDIT_COLS.length);
    r2.setNumberFormat('@');
    r2.setValues(keep.map(function (row) { return row.map(String); }));
  }
}

function logAccess(m, event, device) {
  const sh = sheet('Sign-ins', ['When', 'Who', 'Who id', 'Event', 'Device']);
  const r = sh.getRange(sh.getLastRow() + 1, 1, 1, 5);
  r.setNumberFormat('@');
  r.setValues([[now(), m.name, m.id, event, String(device || '').slice(0, 80)]]);
}

/* ================================================================== AI proxy */

function ai(a, b) {
  const st = loadConfig().settings;
  if (st && st.ai && st.ai.enabled === false) return { ok: false, error: 'ai-off' };
  const gem = props().getProperty('GEMINI_API_KEY');
  const groq = props().getProperty('GROQ_API_KEY');
  if (!gem && !groq) return { ok: false, error: 'ai-off' };
  // Per-person limits keep everyone inside the free tiers.
  const mk = 'aim:' + a.id + ':' + Math.floor(Date.now() / 60000);
  const dk = 'aid:' + a.id + ':' + new Date().toISOString().slice(0, 10);
  const perMin = Number(cache().get(mk) || 0), perDay = Number(cache().get(dk) || 0);
  if (perMin >= 20 || perDay >= 800) return { ok: false, error: 'ai-busy' };
  cache().put(mk, String(perMin + 1), 120);
  cache().put(dk, String(perDay + 1), 86400);

  const prompt = String(b.prompt || '').slice(0, 30000);
  const system = String(b.system || '').slice(0, 4000);
  const temp = typeof b.temperature === 'number' ? Math.max(0, Math.min(1.2, b.temperature)) : 0.4;
  if (gem) {
    const model = b.search ? (props().getProperty('GEMINI_SEARCH_MODEL') || 'gemini-2.5-flash') : (props().getProperty('GEMINI_MODEL') || 'gemini-3.5-flash');
    const body = {
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { temperature: temp },
    };
    if (system) body.systemInstruction = { parts: [{ text: system }] };
    if (b.json && !b.search) body.generationConfig.responseMimeType = 'application/json';
    if (b.search) body.tools = [{ google_search: {} }];
    try {
      const r = UrlFetchApp.fetch('https://generativelanguage.googleapis.com/v1beta/models/' + encodeURIComponent(model) + ':generateContent', {
        method: 'post', contentType: 'application/json', payload: JSON.stringify(body), muteHttpExceptions: true,
        headers: { 'x-goog-api-key': gem },
      });
      const j = JSON.parse(r.getContentText() || '{}');
      const cand = j.candidates && j.candidates[0];
      const text = cand && cand.content && cand.content.parts ? cand.content.parts.map(function (p) { return p.text || ''; }).join('') : '';
      const sources = cand && cand.groundingMetadata && cand.groundingMetadata.groundingChunks
        ? cand.groundingMetadata.groundingChunks.map(function (c) { return c.web && c.web.uri; }).filter(Boolean) : [];
      if (text) return { ok: true, text: text, sources: sources };
      console.warn('gemini', r.getResponseCode(), r.getContentText().slice(0, 300));
    } catch (err) { console.error(err); }
  }
  if (groq && !b.search) {
    try {
      const msgs = [];
      if (system) msgs.push({ role: 'system', content: system });
      msgs.push({ role: 'user', content: prompt });
      const body2 = { model: props().getProperty('GROQ_MODEL') || 'llama-3.3-70b-versatile', messages: msgs, temperature: temp };
      if (b.json) body2.response_format = { type: 'json_object' };
      const r2 = UrlFetchApp.fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'post', contentType: 'application/json', payload: JSON.stringify(body2), muteHttpExceptions: true,
        headers: { Authorization: 'Bearer ' + groq },
      });
      const j2 = JSON.parse(r2.getContentText() || '{}');
      const t2 = j2.choices && j2.choices[0] && j2.choices[0].message && j2.choices[0].message.content;
      if (t2) return { ok: true, text: t2, sources: [] };
    } catch (err) { console.error(err); }
  }
  return { ok: false, error: 'ai-failed' };
}

/* ================================================================== admin */

function adminOp(a, b) {
  switch (b.op) {
    case 'settings':
      if (!b.settings || typeof b.settings !== 'object') return { ok: false, error: 'bad-settings' };
      return withLock(function () {
        const cfg = loadConfig(true);
        cfg.settings = clean(b.settings);
        cfg.cfgRev++;
        saveConfig(cfg);
        return { ok: true };
      });

    case 'member':
      return withLock(function () {
        const cfg = loadConfig(true);
        const p = b.member || {};
        let m = cfg.team.filter(function (t) { return t.id === p.id; })[0];
        if (!m) { m = { id: 'u' + rand(4), name: '', active: true, stages: [] }; cfg.team.push(m); }
        if (p.name != null) {
          const nm = String(p.name).trim().slice(0, 60);
          if (!nm) return { ok: false, error: 'Name is required' };
          const clash = cfg.team.filter(function (t) { return t !== m && t.name.toLowerCase() === nm.toLowerCase(); })[0];
          if (clash) return { ok: false, error: 'Someone already has that name' };
          m.name = nm;
        }
        if (p.active != null) m.active = !!p.active;
        if (p.editAll != null) { if (p.editAll) m.editAll = true; else delete m.editAll; }
        if (p.assignAsk != null) { if (p.assignAsk) m.assignAsk = true; else delete m.assignAsk; }
        if (Array.isArray(p.stages)) m.stages = p.stages.filter(function (s) { return /^[a-z]+$/.test(s); }).slice(0, 10);
        if (p.targets !== undefined) { if (p.targets) m.targets = clean(p.targets); else delete m.targets; }
        if (p.color && /^#[0-9a-f]{6}$/i.test(p.color)) m.color = p.color;
        let pin = '';
        const sess = loadSessions();
        let sessChanged = false;
        if (b.newPin) {
          pin = String(b.pin || '').trim() || String(100000 + (parseInt(rand(4), 16) % 900000));
          if (!/^\d{4,8}$/.test(pin)) return { ok: false, error: 'PIN must be 4–8 digits' };
          m.pinHash = hash(pin + ':' + m.id);
          Object.keys(sess).forEach(function (k) { if (sess[k].user === m.id && !sess[k].x) { delete sess[k]; cache().remove('sess:' + k); sessChanged = true; } });
        }
        if (!m.active) Object.keys(sess).forEach(function (k) { if (sess[k].user === m.id) { delete sess[k]; cache().remove('sess:' + k); sessChanged = true; } });
        if (sessChanged) saveSessions(sess);
        cfg.cfgRev++;
        saveConfig(cfg);
        const pubM = Object.assign({}, m);
        delete pubM.pinHash;
        return { ok: true, member: pubM, pin: pin, hasPin: !!m.pinHash };
      });

    case 'access': {
      const sh = sheet('Sign-ins', ['When', 'Who', 'Who id', 'Event', 'Device']);
      const last = sh.getLastRow();
      if (last < 2) return { ok: true, rows: [] };
      const n = Math.min(1000, last - 1);
      const v = sh.getRange(last - n + 1, 1, n, 5).getValues().reverse();
      return { ok: true, rows: v.map(function (r) { return { at: String(r[0]), user: String(r[2]), event: String(r[3]), device: String(r[4]) }; }) };
    }

    case 'sessions': {
      const s = loadSessions();
      return {
        ok: true, adminDevice: !!props().getProperty('ADMIN_DEVICE'),
        rows: Object.keys(s).map(function (k) {
          return { id: k.slice(0, 12), user: s[k].user, x: !!s[k].x, label: s[k].label, at: s[k].at, seen: new Date(Number(cache().get('seen:' + k) || 0) || new Date(s[k].at).getTime()).toISOString() };
        }),
      };
    }

    case 'revoke':
      return withLock(function () {
        const s = loadSessions();
        Object.keys(s).forEach(function (k) { if (k.indexOf(String(b.id)) === 0) { delete s[k]; cache().remove('sess:' + k); } });
        saveSessions(s);
        return { ok: true };
      });

    case 'device-lock':
      if (b.on) props().setProperty('ADMIN_DEVICE', hash(String(b.device || '')));
      else props().deleteProperty('ADMIN_DEVICE');
      return { ok: true };

    case 'snapshot':
      return withLock(function () { return { ok: true, snapshot: snapshot(a.id) }; });

    case 'snapshots':
      return { ok: true, rows: loadSnapshots() };

    case 'restore':
      return withLock(function () { return restore(String(b.id)); });

    case 'purge-history':
      purgeAudit(Array.isArray(b.ids) ? b.ids : [b.id]);
      return { ok: true };

    case 'mirror':
      mirrorLeads();
      return { ok: true, url: SpreadsheetApp.getActiveSpreadsheet().getUrl() };
  }
  return { ok: false, error: 'unknown-op' };
}

/* ================================================================== checkpoints */

function snapshot(by) {
  const meta = getMeta();
  const id = 's' + Date.now();
  const dir = subFolder('snapshots').createFolder(id);
  let size = 0;
  Object.keys(meta.shards).forEach(function (k) {
    const f = shardFile(k, false);
    if (f) { const c = f.getBlob().getDataAsString(); size += c.length; dir.createFile(f.getName(), c, 'application/json'); }
  });
  const cfgFile = fileByName('config.json', false);
  if (cfgFile) dir.createFile('config.json', cfgFile.getBlob().getDataAsString(), 'application/json');
  dir.createFile('meta.json', JSON.stringify(meta), 'application/json');
  const list = loadSnapshots();
  const snap = { id: id, at: now(), by: by, seq: meta.seq, size: size, folder: dir.getId() };
  list.unshift(snap);
  // Keep the newest 30 manual + 14 nightly checkpoints.
  const keep = [];
  let manual = 0, nightly = 0;
  list.forEach(function (s) {
    const isAuto = s.by === 'auto';
    if ((isAuto && nightly < 14) || (!isAuto && manual < 30)) { keep.push(s); if (isAuto) nightly++; else manual++; }
    else { try { DriveApp.getFolderById(s.folder).setTrashed(true); } catch (err) { /* gone */ } }
  });
  saveSnapshots(keep);
  // Seal: nothing before this point can be undone by the team.
  meta.floor = meta.seq;
  setMeta(meta);
  return snap;
}

function restore(id) {
  const s = loadSnapshots().filter(function (x) { return x.id === id; })[0];
  if (!s) return { ok: false, error: 'Checkpoint not found' };
  const dir = DriveApp.getFolderById(s.folder);
  const meta = getMeta();
  // Clear current shards, then load the checkpoint's files with fresh revisions.
  Object.keys(meta.shards).forEach(function (k) { const f = shardFile(k, false); if (f) f.setContent(JSON.stringify({ records: {}, tombs: {} })); });
  const newShards = {};
  const files = dir.getFiles();
  let cfgJson = '';
  while (files.hasNext()) {
    const f = files.next();
    const n = f.getName();
    if (n === 'config.json') { cfgJson = f.getBlob().getDataAsString(); continue; }
    const m = /^(core|act-(\w+))\.json$/.exec(n);
    if (!m) continue;
    const key = m[1] === 'core' ? 'core' : m[2];
    const data = JSON.parse(f.getBlob().getDataAsString() || '{}');
    const recs = data.records || {};
    Object.keys(recs).forEach(function (rid) { recs[rid].rev = ++meta.seq; });
    writeShard(key, { records: recs, tombs: {} }, meta.seq);
    newShards[key] = meta.seq;
  }
  if (cfgJson) {
    const c = JSON.parse(cfgJson);
    const cur = loadConfig(true);
    c.cfgRev = cur.cfgRev + 1;
    saveConfig(c);
  }
  meta.shards = newShards;
  meta.epoch = rand(4);
  meta.floor = meta.seq;
  setMeta(meta);
  return { ok: true };
}

function loadSnapshots() {
  const f = fileByName('snapshots.json', false);
  return f ? JSON.parse(f.getBlob().getDataAsString() || '[]') : [];
}
function saveSnapshots(list) { upsert('snapshots.json', JSON.stringify(list)); }

/* ================================================================== sheet mirror */

const LEAD_COLS = ['Company', 'City', 'Sector', 'Stage', 'Status', 'Next step', 'Due', 'Main contact', 'Designation', 'Phones', 'Emails', 'Website', 'Owner', 'Updated by', 'Updated at', 'Id'];

function mirrorLeads() {
  const core = readShard('core').records;
  const cfg = loadConfig();
  const nameOf = function (id) { const m = cfg.team.filter(function (t) { return t.id === id; })[0]; return m ? m.name : ''; };
  const rows = [];
  Object.keys(core).forEach(function (id) {
    const a = core[id];
    if (a.kind !== 'account' || a.voided) return;
    const c = a.primaryContactId ? core[a.primaryContactId] : null;
    rows.push([a.name, a.city || '', a.sector || '', a.stage, a.status, a.next ? a.next.type : '', a.next ? a.next.due : '', c ? c.name : '', c ? c.designation || '' : '',
      ((c && c.phones) || []).concat(a.phones || []).join(' / '), ((c && c.emails) || []).concat(a.emails || []).join(' / '), a.website || '', nameOf(a.owner), nameOf(a.updatedBy), a.updatedAt, a.id].map(trunc));
  });
  const sh = sheet('Leads', LEAD_COLS);
  sh.clearContents();
  const all = [LEAD_COLS].concat(rows);
  const range = sh.getRange(1, 1, all.length, LEAD_COLS.length);
  range.setNumberFormat('@');
  range.setValues(all);
  sh.getRange(1, 1, 1, LEAD_COLS.length).setFontWeight('bold');
  sh.setFrozenRows(1);
}

/** Time-driven (see setup): nightly checkpoint + refreshed Leads sheet. */
function nightly() {
  withLock(function () { snapshot('auto'); return { ok: true }; });
  mirrorLeads();
}

/* ================================================================== storage */

function getMeta() {
  const raw = props().getProperty('META');
  if (raw) return JSON.parse(raw);
  const m = { seq: 0, epoch: rand(4), floor: 0, shards: {} };
  props().setProperty('META', JSON.stringify(m));
  return m;
}
function setMeta(m) { props().setProperty('META', JSON.stringify(m)); }

function shardName(k) { return k === 'core' ? 'core.json' : 'act-' + k + '.json'; }
function shardFile(k, create) { return fileByName(shardName(k), create); }

/** Read a shard; with its revision, served from the in-memory cache when possible (much faster than Drive). */
function readShard(k, rev) {
  let raw = rev ? bigGet('sh:' + k + ':' + rev) : null;
  if (raw == null) {
    const f = shardFile(k, false);
    raw = f ? f.getBlob().getDataAsString() : '';
    if (rev && raw) bigPut('sh:' + k + ':' + rev, raw, 3600);
  }
  const d = JSON.parse(raw || '{}');
  if (!d.records) d.records = {};
  if (!d.tombs) d.tombs = {};
  return d;
}
function writeShard(k, data, rev) {
  const raw = JSON.stringify(data);
  upsert(shardName(k), raw);
  if (rev) bigPut('sh:' + k + ':' + rev, raw, 3600);
}

/*
 * Journal: the most recent changed records, kept in cache and keyed by sequence number.
 * A sync whose "since" is inside the journal is answered from memory without reading Drive.
 * If the cache is evicted, syncs simply fall back to reading the shards.
 */
const JOURNAL_MAX = 5000;

function journalGet(seq) {
  const raw = bigGet('jr:' + seq);
  return raw ? JSON.parse(raw) : null;
}

function journalAdd(prevSeq, seq, recs) {
  let j = journalGet(prevSeq);
  if (!j) j = { floor: prevSeq, recs: [] };
  const ids = {};
  recs.forEach(function (r) { ids[r.id] = 1; });
  j.recs = j.recs.filter(function (r) { return !ids[r.id]; }).concat(recs.sort(function (x, y) { return x.rev - y.rev; }));
  while (j.recs.length > JOURNAL_MAX) { const d = j.recs.shift(); j.floor = Math.max(j.floor, d.rev); }
  j.seq = seq;
  const s = JSON.stringify(j);
  bigPut('jr:' + seq, s.length < 6000000 ? s : JSON.stringify({ floor: seq, recs: [], seq: seq }), 1800);
}

/** Cache a large string: gzip + base64, split into chunks under the 100 KB per-key limit. */
function bigPut(key, str, ttl) {
  try {
    const z = Utilities.base64Encode(Utilities.gzip(Utilities.newBlob(str, 'application/json')).getBytes());
    const size = 95000;
    const n = Math.ceil(z.length / size);
    if (n > 60) return;
    const o = {};
    for (let i = 0; i < n; i++) o[key + ':' + i] = z.slice(i * size, (i + 1) * size);
    cache().putAll(o, ttl);
    cache().put(key + ':n', String(n), ttl); // written last, so a reader never sees a half-written value
  } catch (err) { console.error(err); }
}

function bigGet(key) {
  try {
    const n = Number(cache().get(key + ':n') || 0);
    if (!n) return null;
    const keys = [];
    for (let i = 0; i < n; i++) keys.push(key + ':' + i);
    const got = cache().getAll(keys);
    let z = '';
    for (let i = 0; i < n; i++) { if (got[keys[i]] == null) return null; z += got[keys[i]]; }
    return Utilities.ungzip(Utilities.newBlob(Utilities.base64Decode(z), 'application/x-gzip')).getDataAsString();
  } catch (err) {
    return null;
  }
}

function loadConfig(fresh) {
  if (!fresh) {
    const hit = cache().get('config');
    if (hit) return JSON.parse(hit);
  }
  const f = fileByName('config.json', false);
  const c = f ? JSON.parse(f.getBlob().getDataAsString() || '{}') : {};
  if (!c.team) c.team = [];
  if (!c.cfgRev) c.cfgRev = 1;
  if (!('settings' in c)) c.settings = null;
  const s = JSON.stringify(c);
  if (s.length < 95000) cache().put('config', s, 21600);
  return c;
}
function saveConfig(c) {
  upsert('config.json', JSON.stringify(c));
  const s = JSON.stringify(c);
  if (s.length < 95000) cache().put('config', s, 21600); else cache().remove('config');
}
function pubTeam(c) { return c.team.map(function (m) { const p = Object.assign({}, m); delete p.pinHash; return p; }); }

function loadSessions() {
  const f = fileByName('sessions.json', false);
  return f ? JSON.parse(f.getBlob().getDataAsString() || '{}') : {};
}
function saveSessions(s) { upsert('sessions.json', JSON.stringify(s)); }

function fileByName(name, create) {
  const key = 'F_' + name;
  const id = props().getProperty(key);
  if (id) { try { return DriveApp.getFileById(id); } catch (err) { /* recreate */ } }
  const it = rootFolder().getFilesByName(name);
  if (it.hasNext()) { const f = it.next(); props().setProperty(key, f.getId()); return f; }
  if (!create) return null;
  const nf = rootFolder().createFile(name, '{}', 'application/json');
  props().setProperty(key, nf.getId());
  return nf;
}
function upsert(name, content) { fileByName(name, true).setContent(content); }

function rootFolder() {
  return folderByProp('ROOT_ID', function () {
    const it = DriveApp.getFoldersByName(ROOT_NAME);
    return it.hasNext() ? it.next() : DriveApp.createFolder(ROOT_NAME);
  });
}
function subFolder(name) {
  return folderByProp('DIR_' + name, function () {
    const r = rootFolder();
    const it = r.getFoldersByName(name);
    return it.hasNext() ? it.next() : r.createFolder(name);
  });
}
function folderByProp(key, create) {
  const id = props().getProperty(key);
  if (id) { try { return DriveApp.getFolderById(id); } catch (err) { /* recreate */ } }
  const f = create();
  props().setProperty(key, f.getId());
  return f;
}

/* ================================================================== helpers */

function out(obj) { return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON); }
function props() { return PropertiesService.getScriptProperties(); }
function cache() { return CacheService.getScriptCache(); }
function now() { return new Date().toISOString(); }
function trunc(s) { s = s == null ? '' : String(s); return s.length > 49000 ? s.slice(0, 49000) + '…' : s; }

function withLock(fn) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) return { ok: false, error: 'busy' };
  try { return fn(); } finally { lock.releaseLock(); }
}

function rand(bytes) {
  let s = '';
  while (s.length < bytes * 2) s += Utilities.getUuid().replace(/-/g, '');
  return s.slice(0, bytes * 2).toLowerCase();
}

function hash(s) {
  const salt = props().getProperty('SALT') || (function () { const v = rand(16); props().setProperty('SALT', v); return v; })();
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, salt + ':' + s, Utilities.Charset.UTF_8)
    .map(function (b) { return ('0' + (b & 0xff).toString(16)).slice(-2); }).join('');
}

function sheet(name, header) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.getRange(1, 1, 1, header.length).setValues([header]).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  return sh;
}

/** Run once from the editor: grants permissions, creates storage and the nightly trigger. */
function setup() {
  rootFolder(); subFolder('snapshots');
  ['core.json', 'config.json', 'sessions.json'].forEach(function (n) { fileByName(n, true); });
  getMeta();
  sheet('Audit', AUDIT_COLS); sheet('Sign-ins', ['When', 'Who', 'Who id', 'Event', 'Device']); sheet('Leads', LEAD_COLS);
  ScriptApp.getProjectTriggers().forEach(function (t) { if (t.getHandlerFunction() === 'nightly') ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('nightly').timeBased().everyDays(1).atHour(23).create();
  try { UrlFetchApp.fetch('https://generativelanguage.googleapis.com/', { muteHttpExceptions: true }); } catch (err) { /* triggers the permission prompt */ }
  const key = props().getProperty('ADMIN_KEY') || '';
  Logger.log('Drive folder: ' + rootFolder().getUrl());
  Logger.log(key.length >= 12 ? 'ADMIN_KEY is set.' : 'Set ADMIN_KEY (12+ characters) in Script Properties before signing in.');
  Logger.log(props().getProperty('GEMINI_API_KEY') ? 'Gemini key found.' : 'No GEMINI_API_KEY — AI features will fall back to rules/templates.');
}
