/**
 * Import any spreadsheet shape: guess what each column is (headers + the values themselves),
 * group rows into companies with several contacts, and spot duplicates of existing accounts.
 */
import type { Account, Contact } from './types';
import { companyKey, norm } from './util';
import { domainOf, isMobile, normUrl, splitEmails, splitPhones } from './phone';

export const FIELDS = [
  { id: 'company', label: 'Company name' },
  { id: 'contactName', label: 'Contact person' },
  { id: 'firstName', label: 'Contact first name' },
  { id: 'lastName', label: 'Contact last name' },
  { id: 'designation', label: 'Designation' },
  { id: 'mobile', label: 'Contact phone / mobile' },
  { id: 'phone', label: 'Company phone / landline' },
  { id: 'email', label: 'Email' },
  { id: 'city', label: 'City' },
  { id: 'state', label: 'State' },
  { id: 'sector', label: 'Industry / sector' },
  { id: 'website', label: 'Website' },
  { id: 'linkedin', label: 'LinkedIn' },
  { id: 'address', label: 'Address' },
  { id: 'size', label: 'Size / employees / turnover' },
  { id: 'notes', label: 'Notes / remarks' },
  { id: 'extra', label: 'Keep as custom field' },
  { id: 'skip', label: "Don't import" },
] as const;
export type FieldId = (typeof FIELDS)[number]['id'];

const SYN: [FieldId, RegExp][] = [
  ['linkedin', /linked ?in/],
  ['email', /e ?mail|mail id|email id/],
  ['website', /website|web site|\burl\b|^web$|^domain$|^site$/],
  ['firstName', /first name|fname|given name/],
  ['lastName', /last name|surname|lname|family name/],
  ['designation', /designation|desig|title|role|position|job|post\b/],
  ['phone', /landline|office (phone|no|number|tel)|board|company (phone|number|tel)|\btel(ephone)?\b|\bstd\b/],
  ['mobile', /mobile|cell|whats ?app|contact (no|number|num)|phone|ph\b|ph no|mob\b|number/],
  ['contactName', /contact (person|name)|person|poc|spoc|full name|key person|owner name|director name|concerned|name of (the )?(person|contact)/],
  ['sector', /industry|sector|vertical|segment|category|domain of business|business type|nature of business/],
  ['company', /company|organi[sz]ation|org\b|firm|business|account|client|entity|corporate|employer|party name|customer/],
  ['city', /city|location|town|district|\bplace\b/],
  ['state', /\bstate\b|region|province/],
  ['address', /address|addr|street|pin ?code|pincode/],
  ['size', /employees|employee count|size|headcount|turnover|revenue|staff/],
  ['notes', /notes?|remarks?|comments?|description|feedback|status/],
];

export function guessField(header: string, values: string[], hasCompanyCol: boolean): { field: FieldId; sure: boolean } {
  const h = norm(header);
  const vs = values.map((v) => String(v ?? '').trim()).filter(Boolean).slice(0, 30);
  const share = (re: RegExp) => (vs.length ? vs.filter((v) => re.test(v)).length / vs.length : 0);
  for (const [f, re] of SYN) {
    if (re.test(h)) {
      if (f === 'company' && /person|contact/.test(h)) continue;
      return { field: f, sure: true };
    }
  }
  if (/^name$|^names?$/.test(h)) return { field: hasCompanyCol ? 'contactName' : 'company', sure: true };
  if (share(/@[a-z0-9-]+\./i) > 0.5) return { field: 'email', sure: false };
  if (share(/^(\+?91[\s-]?)?[6-9]\d{4}[\s-]?\d{5}$/) > 0.5) return { field: 'mobile', sure: false };
  if (share(/^0\d{2,4}[\s-]?\d{6,8}$/) > 0.5) return { field: 'phone', sure: false };
  if (share(/^(https?:\/\/)?(www\.)?[a-z0-9-]+\.[a-z.]{2,}(\/|$)/i) > 0.5) return { field: share(/linkedin/i) > 0.5 ? 'linkedin' : 'website', sure: false };
  if (share(/\b(pvt|ltd|limited|llp|inc|technologies|industries|solutions)\b/i) > 0.4) return { field: 'company', sure: false };
  if (!vs.length) return { field: 'skip', sure: false };
  return { field: 'extra', sure: false };
}

export function autoMap(headers: string[], rows: string[][]): FieldId[] {
  const hasCompany = headers.some((h) => /company|organi[sz]ation|firm|business|account|client/.test(norm(h)));
  const used = new Set<FieldId>();
  return headers.map((h, i) => {
    const g = guessField(h, rows.map((r) => r[i]), hasCompany);
    // One column per single-value field; later duplicates become custom fields (phones/emails can repeat).
    if (used.has(g.field) && !['mobile', 'phone', 'email', 'extra', 'skip', 'notes'].includes(g.field)) return 'extra';
    used.add(g.field);
    return g.field;
  });
}

export interface Lead {
  key: string;
  name: string;
  city?: string;
  state?: string;
  sector?: string;
  website?: string;
  linkedin?: string;
  address?: string;
  size?: string;
  phones: string[];
  emails: string[];
  extra: Record<string, string>;
  contacts: { name: string; designation?: string; phones: string[]; emails: string[] }[];
  notes: string[];
  dupOf?: string;
  rows: number;
}

const GENERIC = /^(info|contact|sales|support|hello|admin|office|enquiry|enquiries|hr|careers|mail)@/i;

export function buildLeads(headers: string[], rows: string[][], map: FieldId[]): { leads: Lead[]; skipped: number } {
  const byKey = new Map<string, Lead>();
  let skipped = 0;
  for (const row of rows) {
    const get = (f: FieldId) => map.map((m, i) => (m === f ? String(row[i] ?? '').trim() : '')).filter(Boolean);
    const one = (f: FieldId) => get(f)[0] || '';
    const company = one('company');
    const person = one('contactName') || [one('firstName'), one('lastName')].filter(Boolean).join(' ');
    if (!company && !person) { skipped++; continue; }
    const name = company || person;
    const city = one('city');
    const key = `${companyKey(name)}|${norm(city)}`;
    const fromMobileCol = get('mobile').flatMap(splitPhones);
    // Office landlines typed into a "mobile" column belong to the company, not the person.
    const mobiles = fromMobileCol.filter((p) => isMobile(p) || !p.startsWith('+91'));
    const landlines = [...get('phone').flatMap(splitPhones), ...fromMobileCol.filter((p) => !mobiles.includes(p))];
    const emails = get('email').flatMap(splitEmails);
    let l = byKey.get(key);
    if (!l) {
      l = { key, name, phones: [], emails: [], extra: {}, contacts: [], notes: [], rows: 0 };
      byKey.set(key, l);
    }
    l.rows++;
    l.city ||= city || undefined;
    l.state ||= one('state') || undefined;
    l.sector ||= one('sector') || undefined;
    l.website ||= normUrl(one('website')) || undefined;
    l.linkedin ||= one('linkedin') || undefined;
    l.address ||= one('address') || undefined;
    l.size ||= one('size') || undefined;
    const note = get('notes').join(' · ');
    if (note) l.notes.push(note);
    map.forEach((m, i) => { const v = String(row[i] ?? '').trim(); if (m === 'extra' && v && !l!.extra[headers[i]]) l!.extra[headers[i]] = v.slice(0, 500); });
    const generic = emails.filter((e) => GENERIC.test(e));
    const personal = emails.filter((e) => !GENERIC.test(e));
    const add = (arr: string[], xs: string[]) => { for (const x of xs) if (!arr.includes(x)) arr.push(x); };
    add(l.phones, landlines);
    add(l.emails, generic);
    if (company && person) {
      let c = l.contacts.find((x) => norm(x.name) === norm(person));
      if (!c) { c = { name: person, designation: one('designation') || undefined, phones: [], emails: [] }; l.contacts.push(c); }
      add(c.phones, mobiles);
      add(c.emails, personal);
    } else {
      add(l.phones, mobiles);
      add(l.emails, personal);
    }
    if (!l.website && personal[0] && !/gmail|yahoo|hotmail|outlook|rediff/.test(personal[0])) l.website = `https://${personal[0].split('@')[1]}`;
  }
  return { leads: [...byKey.values()], skipped };
}

/** Match against what's already in the CRM: same company (+city), phone, email or website domain. */
export function markDuplicates(leads: Lead[], accounts: Account[], contacts: Map<string, Contact[]>) {
  const byKey = new Map<string, Account>();
  const byPhone = new Map<string, Account>();
  const byEmail = new Map<string, Account>();
  const byDomain = new Map<string, Account>();
  for (const a of accounts) {
    byKey.set(`${companyKey(a.name)}|${norm(a.city || '')}`, a);
    if (!byKey.has(`${companyKey(a.name)}|`)) byKey.set(`${companyKey(a.name)}|`, a);
    for (const p of a.phones) byPhone.set(p, a);
    for (const e of a.emails) byEmail.set(e, a);
    for (const c of contacts.get(a.id) || []) { for (const p of c.phones) byPhone.set(p, a); for (const e of c.emails) byEmail.set(e, a); }
    const d = a.website && domainOf(a.website);
    if (d) byDomain.set(d, a);
  }
  for (const l of leads) {
    const d = l.website && domainOf(l.website);
    const hit = byKey.get(l.key) || (!l.city ? undefined : byKey.get(`${l.key.split('|')[0]}|`)) ||
      [...l.phones, ...l.contacts.flatMap((c) => c.phones)].map((p) => byPhone.get(p)).find(Boolean) ||
      [...l.emails, ...l.contacts.flatMap((c) => c.emails)].map((e) => byEmail.get(e)).find(Boolean) ||
      (d ? byDomain.get(d) : undefined);
    l.dupOf = hit?.id;
  }
}

export const hasPhone = (l: Lead) => l.phones.length > 0 || l.contacts.some((c) => c.phones.length > 0);

/** Read .xlsx/.xls/.csv into sheets of string rows (SheetJS is loaded only when needed). */
export async function readFile(file: File): Promise<{ name: string; rows: string[][] }[]> {
  const XLSX = await import('xlsx');
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf, { type: 'array', cellDates: true, raw: false });
  return wb.SheetNames.map((n) => {
    const rows = XLSX.utils.sheet_to_json<string[]>(wb.Sheets[n], { header: 1, raw: false, defval: '', blankrows: false }) as string[][];
    return { name: n, rows: rows.map((r) => r.map((c) => String(c ?? ''))) };
  }).filter((s) => s.rows.length > 0);
}

/** The header row is the first row with several non-empty text cells (sheets often have a title row first). */
export function findHeaderRow(rows: string[][]): number {
  for (let i = 0; i < Math.min(10, rows.length); i++) {
    const filled = rows[i].filter((c) => String(c).trim()).length;
    const texty = rows[i].filter((c) => /[a-z]/i.test(String(c)) && String(c).length < 40).length;
    if (filled >= 2 && texty >= Math.max(2, filled * 0.6)) return i;
  }
  return 0;
}
