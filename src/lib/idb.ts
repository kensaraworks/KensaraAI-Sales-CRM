/** Tiny IndexedDB key-value store (records survive reloads and work offline). */
const DB_NAME = 'ks-crm';
let dbp: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  if (dbp) return dbp;
  dbp = new Promise((res, rej) => {
    const r = indexedDB.open(DB_NAME, 1);
    r.onupgradeneeded = () => {
      r.result.createObjectStore('records');
      r.result.createObjectStore('kv');
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  return dbp;
}

const tx = async (store: string, mode: IDBTransactionMode) => (await open()).transaction(store, mode).objectStore(store);
const done = <T,>(r: IDBRequest<T>) => new Promise<T>((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

export async function kvGet<T>(k: string): Promise<T | undefined> {
  try { return await done((await tx('kv', 'readonly')).get(k)); } catch { return undefined; }
}
export async function kvSet(k: string, v: any) {
  try { await done((await tx('kv', 'readwrite')).put(v, k)); } catch (e) { console.warn(e); }
}

export async function allRecords<T>(): Promise<T[]> {
  try { return await done((await tx('records', 'readonly')).getAll()); } catch { return []; }
}

export async function putRecords(recs: { id: string }[], dels: string[] = []) {
  if (!recs.length && !dels.length) return;
  try {
    const db = await open();
    const t = db.transaction('records', 'readwrite');
    const s = t.objectStore('records');
    for (const r of recs) s.put(r, r.id);
    for (const id of dels) s.delete(id);
    await new Promise<void>((res, rej) => { t.oncomplete = () => res(); t.onerror = () => rej(t.error); });
  } catch (e) { console.warn(e); }
}

export async function clearAll() {
  try {
    await done((await tx('records', 'readwrite')).clear());
    await done((await tx('kv', 'readwrite')).clear());
  } catch { /* ignore */ }
}
