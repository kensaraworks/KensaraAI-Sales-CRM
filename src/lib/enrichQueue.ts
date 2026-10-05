/** Background "find the number" runner: one company every few seconds to stay inside free AI limits. */
import type { Account } from './types';
import { enrich } from './ai';
import { store } from './store';

let running = false;
const queue: string[] = [];
const listeners = new Set<() => void>();
export const enrichState = { total: 0, done: 0, found: 0, running: false };

const emit = () => listeners.forEach((f) => f());
export const onEnrich = (f: () => void) => { listeners.add(f); return () => { listeners.delete(f); }; };

export function queueEnrich(ids: string[]) {
  const fresh = ids.filter((id) => !queue.includes(id));
  queue.push(...fresh);
  enrichState.total += fresh.length;
  emit();
  if (!running) run();
}

async function run() {
  running = enrichState.running = true;
  emit();
  while (queue.length) {
    const id = queue.shift()!;
    const a = store.get<Account>(id);
    if (a && !a.found) {
      const r = await enrich(a);
      if (r === null && enrichState.done === 0) { queue.length = 0; break; } // AI not available
      if (r && (r.phones.length || r.emails.length || r.website)) {
        store.update(store.get<Account>(id)!, { found: { ...r, at: new Date().toISOString() } });
        enrichState.found++;
      }
      await new Promise((res) => setTimeout(res, 4500));
    }
    enrichState.done++;
    emit();
  }
  running = enrichState.running = false;
  emit();
}
