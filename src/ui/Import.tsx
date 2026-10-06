import { useMemo, useState } from 'preact/hooks';
import type { Account, ID } from '../lib/types';
import { useStore } from '../lib/store';
import { assignTo, canEdit } from '../lib/schedule';
import { FIELDS, autoMap, buildLeads, findHeaderRow, hasPhone, markDuplicates, readFile, type FieldId, type Lead } from '../lib/importer';
import { aiMapColumns } from '../lib/ai';
import { queueEnrich } from '../lib/enrichQueue';
import { newId, plural, uniq } from '../lib/util';
import { Icon, Seg, Spinner } from './components';
import { EnrichProgress } from './Leads';
import { go, toast } from './bus';

type Step = 'pick' | 'map' | 'done';

export function Import() {
  const s = useStore();
  const [step, setStep] = useState<Step>('pick');
  const [sheets, setSheets] = useState<{ name: string; rows: string[][] }[]>([]);
  const [sheetIdx, setSheetIdx] = useState(0);
  const [headerRow, setHeaderRow] = useState(0);
  const [map, setMap] = useState<FieldId[]>([]);
  const [fileName, setFileName] = useState('');
  const [over, setOver] = useState(false);
  const [busy, setBusy] = useState('');
  const [dupMode, setDupMode] = useState<'merge' | 'skip'>('merge');
  const [assign, setAssign] = useState<string>('auto');
  const [source, setSource] = useState('');
  const [paste, setPaste] = useState('');
  const [result, setResult] = useState<{ created: number; merged: number; noPhone: ID[]; othersSkipped: number } | null>(null);

  const sheet = sheets[sheetIdx];
  const headers = sheet ? sheet.rows[headerRow].map((h, i) => String(h).trim() || `Column ${i + 1}`) : [];
  const body = sheet ? sheet.rows.slice(headerRow + 1).filter((r) => r.some((c) => String(c).trim())) : [];

  const load = (sh: { name: string; rows: string[][] }[], name: string) => {
    if (!sh.length) { toast('That file looks empty'); return; }
    setSheets(sh);
    setSheetIdx(0);
    const hr = findHeaderRow(sh[0].rows);
    setHeaderRow(hr);
    setMap(autoMap(sh[0].rows[hr].map(String), sh[0].rows.slice(hr + 1, hr + 40)));
    setFileName(name);
    setSource(`${name.replace(/\.(xlsx|xls|csv)$/i, '')} · ${new Date().toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}`);
    setStep('map');
  };

  const onFile = async (f?: File | null) => {
    if (!f) return;
    setBusy('Reading file…');
    try { load(await readFile(f), f.name); } catch (e) { console.error(e); toast("Couldn't read that file — try .xlsx or .csv"); }
    setBusy('');
  };

  const onPaste = () => {
    const rows = paste.split(/\r?\n/).filter((l) => l.trim()).map((l) => l.split('\t'));
    if (rows.length < 2) { toast('Paste at least a header row and one data row'); return; }
    load([{ name: 'Pasted', rows }], 'Pasted list');
  };

  const switchSheet = (i: number) => {
    setSheetIdx(i);
    const hr = findHeaderRow(sheets[i].rows);
    setHeaderRow(hr);
    setMap(autoMap(sheets[i].rows[hr].map(String), sheets[i].rows.slice(hr + 1, hr + 40)));
  };

  const aiMap = async () => {
    setBusy('Asking AI to read the columns…');
    const r = await aiMapColumns(headers, body.slice(0, 4), FIELDS as any);
    setBusy('');
    if (!r) { toast('AI unavailable — the automatic guess is still applied'); return; }
    setMap(headers.map((_, i) => (FIELDS.some((f) => f.id === r[String(i)]) ? (r[String(i)] as FieldId) : map[i])));
    toast('Columns mapped by AI — check and adjust');
  };

  const { leads, skipped } = useMemo(() => {
    if (step !== 'map' || !sheet) return { leads: [] as Lead[], skipped: 0 };
    const r = buildLeads(headers, body, map);
    markDuplicates(r.leads, s.accounts(), s.contactsBy());
    return r;
  }, [step, sheetIdx, headerRow, map.join(), s.version]);

  const dups = leads.filter((l) => l.dupOf).length;
  const withPhone = leads.filter(hasPhone).length;
  const hasCompany = map.includes('company') || map.includes('contactName') || map.includes('firstName');
  const intro = s.team.filter((m) => m.active && (m.stages.includes('new') || m.stages.includes('intro')));

  const run = () => {
    const parts: Parameters<typeof s.batch>[1] = [];
    let created = 0, merged = 0, othersSkipped = 0;
    const noPhone: ID[] = [];
    let rr = 0;
    const ownerFor = () => assign === 'auto' ? undefined : assign === 'rr' ? (intro.length ? intro[rr++ % intro.length].id : undefined) : assign;
    for (const l of leads) {
      if (l.dupOf) {
        if (dupMode === 'skip') continue;
        const a = s.get<Account>(l.dupOf);
        if (!a) continue;
        if (!canEdit(a, s.team, s.me!.id, s.isX)) { othersSkipped++; continue; }
        const existing = s.contactsBy().get(a.id) || [];
        parts.push({ rec: a, set: {
          phones: uniq([...a.phones, ...l.phones.filter((p) => !(a.badPhones || []).includes(p))]), emails: uniq([...a.emails, ...l.emails]),
          city: a.city || l.city, sector: a.sector || l.sector, website: a.website || l.website, state: a.state || l.state, size: a.size || l.size,
          address: a.address || l.address, linkedin: a.linkedin || l.linkedin, extra: { ...l.extra, ...a.extra },
          // Re-importing a lead that was closed brings it back into the pipeline.
          ...(a.status === 'lost' ? { status: 'open', lostReason: null, next: a.stage === 'new' ? null : { type: 'call', due: new Date().toISOString() } } : {}),
        } });
        for (const c of l.contacts) {
          const same = existing.find((x) => x.name.toLowerCase() === c.name.toLowerCase());
          if (same) parts.push({ rec: same, set: { phones: uniq([...same.phones, ...c.phones]), emails: uniq([...same.emails, ...c.emails]), designation: same.designation || c.designation } });
          else parts.push({ kind: 'contact', create: { accountId: a.id, name: c.name, designation: c.designation || '', phones: c.phones, emails: c.emails, role: 'unknown', status: 'active' } });
        }
        merged++;
        continue;
      }
      const id = newId('account');
      const cids = l.contacts.map(() => newId('contact'));
      const extra = { ...l.extra };
      if (l.notes.length) extra['Notes'] = l.notes.join(' · ').slice(0, 1000);
      parts.push({ kind: 'account', id, create: {
        name: l.name, city: l.city, state: l.state, sector: l.sector, website: l.website, linkedin: l.linkedin, address: l.address, size: l.size,
        phones: l.phones, emails: l.emails, extra, stage: 'new', status: 'open', attempts: 0, cadence: 0, heat: 0, tags: [], source: source || fileName,
        ...(s.isX ? assignTo(ownerFor() ?? null) : {}), primaryContactId: cids[0], next: null,
      } });
      l.contacts.forEach((c, i) => parts.push({ kind: 'contact', id: cids[i], create: { accountId: id, name: c.name, designation: c.designation || '', phones: c.phones, emails: c.emails, role: 'unknown', status: 'active' } }));
      if (!hasPhone(l)) noPhone.push(id);
      created++;
    }
    if (!parts.length) { toast('Nothing new to import'); return; }
    s.batch(`Imported ${created} leads`, parts);
    setResult({ created, merged, noPhone, othersSkipped });
    setStep('done');
    toast(`Imported ${plural(created, 'lead')}${merged ? `, updated ${merged}` : ''}`, { undo: true });
  };

  if (step === 'done' && result) {
    return (
      <div>
        <div class="page-head"><h1>Import done</h1></div>
        <div class="card card--pad col" style={{ gap: '14px', maxWidth: '640px' }}>
          <div style={{ fontSize: '40px' }}>✅</div>
          <h2>{plural(result.created, 'new lead')} added{result.merged ? ` · ${plural(result.merged, 'existing lead')} updated` : ''}</h2>
          <p class="muted">{s.isX ? "They're now in the team's queues, routed by owner and stage. New outreach is paced automatically so follow-ups never pile up." : 'Your team lead will assign them; they show up in the right queues once assigned.'}</p>
          {result.othersSkipped > 0 && <p class="small muted">{plural(result.othersSkipped, 'company was', 'companies were')} already being worked by someone else and left unchanged.</p>}
          {result.noPhone.length > 0 && (
            <div class="banner banner--accent" style={{ margin: 0 }}>
              <Icon n="phone" />
              <div class="grow small"><b>{plural(result.noPhone.length, 'company has', 'companies have')} no phone number.</b> AI can search the web for their public business numbers — you approve each one.</div>
              <button class="btn btn--accent btn--sm" onClick={() => { queueEnrich(result.noPhone); toast('Searching in the background — keep working'); }}><Icon n="sparkle" /> Find numbers</button>
            </div>
          )}
          <EnrichProgress />
          <div class="row">
            <button class="btn" onClick={() => { setStep('pick'); setSheets([]); setResult(null); }}>Import another</button>
            <button class="btn btn--primary" onClick={() => go('today')}>Start calling <Icon n="arrow" /></button>
          </div>
        </div>
      </div>
    );
  }

  if (step === 'map' && sheet) {
    return (
      <div>
        <div class="page-head">
          <div><h1>Check the columns</h1><p class="muted small">{fileName} · {body.length} rows{skipped ? ` · ${skipped} without a company or name will be skipped` : ''}</p></div>
          <div class="row right">
            <button class="btn btn--ghost" onClick={() => { setStep('pick'); setSheets([]); }}>Back</button>
            <button class="btn btn--accent" onClick={aiMap} disabled={!!busy}>{busy ? <Spinner /> : <Icon n="sparkle" />} Map with AI</button>
          </div>
        </div>
        {sheets.length > 1 && (
          <div class="row wrap" style={{ marginBottom: '12px' }}>
            <span class="small muted">Sheet</span>
            {sheets.map((sh, i) => <button class={`chip ${i === sheetIdx ? 'is-on' : ''}`} onClick={() => switchSheet(i)}>{sh.name}</button>)}
          </div>
        )}
        <div class="row small" style={{ marginBottom: '10px' }}>
          <span class="muted">Header row</span>
          <select class="select" style={{ width: 'auto', height: '30px' }} value={headerRow} onChange={(e) => { const hr = Number((e.target as HTMLSelectElement).value); setHeaderRow(hr); setMap(autoMap(sheet.rows[hr].map(String), sheet.rows.slice(hr + 1, hr + 40))); }}>
            {sheet.rows.slice(0, 10).map((r, i) => <option value={i}>Row {i + 1}: {r.filter(Boolean).slice(0, 3).join(', ').slice(0, 50)}</option>)}
          </select>
        </div>
        <div class="card" style={{ marginBottom: '16px' }}>
          {headers.map((h, i) => (
            <div class="map-row">
              <b class="ellipsis" title={h}>{h}</b>
              <select class="select" style={{ height: '32px' }} value={map[i]} onChange={(e) => { const m = [...map]; m[i] = (e.target as HTMLSelectElement).value as FieldId; setMap(m); }}>
                {FIELDS.map((f) => <option value={f.id}>{f.label}</option>)}
              </select>
              <span class="tiny muted ellipsis">{body.slice(0, 3).map((r) => r[i]).filter(Boolean).join(' · ') || 'empty'}</span>
            </div>
          ))}
        </div>

        <div class="card card--pad col" style={{ gap: '14px' }}>
          <div class="kpis">
            <div class="kpi"><div class="kpi__l">Companies</div><div class="kpi__v">{leads.length}</div><div class="kpi__d muted">from {body.length} rows</div></div>
            <div class="kpi"><div class="kpi__l">With a phone</div><div class="kpi__v">{withPhone}</div></div>
            <div class="kpi"><div class="kpi__l">No phone yet</div><div class="kpi__v">{leads.length - withPhone}</div><div class="kpi__d muted">AI can find these after</div></div>
            <div class="kpi"><div class="kpi__l">Already in CRM</div><div class="kpi__v">{dups}</div></div>
          </div>
          {dups > 0 && <div class="row wrap"><span class="small">Companies already in the CRM:</span><Seg value={dupMode} options={[['merge', 'Add new details to them'], ['skip', 'Skip them']]} onChange={setDupMode} /></div>}
          <div class="grid2">
            {s.isX ? <label class="field"><span>Assign to</span>
              <select class="select" value={assign} onChange={(e) => setAssign((e.target as HTMLSelectElement).value)}>
                <option value="auto">Automatically by stage</option>
                {intro.length > 1 && <option value="rr">Share equally between callers ({intro.map((m) => m.name).join(', ')})</option>}
                {s.team.filter((m) => m.active).map((m) => <option value={m.id}>{m.name}</option>)}
              </select>
            </label> : <p class="small muted" style={{ alignSelf: 'end' }}>New leads go to your team lead to assign.</p>}
            <label class="field"><span>Source label</span><input class="input" value={source} onInput={(e) => setSource((e.target as HTMLInputElement).value)} /></label>
          </div>
          <div class="row">
            {!hasCompany && <span class="small" style={{ color: 'var(--bad)' }}>Map at least one column to "Company name"</span>}
            <button class="btn btn--primary btn--lg right" disabled={!hasCompany || !leads.length} onClick={run}>Import {plural(leads.filter((l) => !l.dupOf || dupMode === 'merge').length, 'company', 'companies')}</button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div>
      <div class="page-head"><div><h1>Import leads</h1><p class="muted small">Any Excel or CSV layout — columns are recognised automatically, gaps are fine</p></div></div>
      <label class={`drop ${over ? 'is-over' : ''}`} style={{ display: 'block' }}
        onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)}
        onDrop={(e) => { e.preventDefault(); setOver(false); onFile(e.dataTransfer?.files?.[0]); }}>
        <input type="file" accept=".xlsx,.xls,.csv,.ods" class="sr" onChange={(e) => onFile((e.target as HTMLInputElement).files?.[0])} />
        <div style={{ fontSize: '30px' }}>📄</div>
        <h2 style={{ marginTop: '8px' }}>{busy || 'Drop your lead sheet here'}</h2>
        <p class="muted small" style={{ marginTop: '4px' }}>or click to choose · .xlsx, .xls, .csv</p>
      </label>
      <div class="section-title">Or paste from Excel / Google Sheets</div>
      <textarea class="textarea" rows={5} placeholder="Copy the cells including the header row, then paste here" value={paste} onInput={(e) => setPaste((e.target as HTMLTextAreaElement).value)} />
      <button class="btn" style={{ marginTop: '8px' }} disabled={!paste.trim()} onClick={onPaste}>Continue</button>
      <EnrichProgress />
    </div>
  );
}

