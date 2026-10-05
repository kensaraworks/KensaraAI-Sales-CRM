import { rand } from './util';

// Mock is the default only in `npm run dev`; a production build must point at the real backend.
const ENDPOINT = (import.meta.env.VITE_ENDPOINT as string | undefined) || (import.meta.env.DEV ? 'mock' : '');
export const isMock = ENDPOINT === 'mock';

/** Errors worth retrying: the backend was momentarily busy or hiccuped. */
const TRANSIENT = new Set(['busy', 'server-error']);

export class NetworkError extends Error {
  code = 'network';
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * POST to the backend. Resolves to the server's JSON ({ok, ...}) or throws NetworkError.
 * Apps Script answers with an HTML page when something fails on Google's side, so anything
 * that isn't JSON is retried. Each call carries a request id so retries never apply twice.
 */
export async function post(body: Record<string, any>, attempts = 4): Promise<any> {
  // Written as a literal comparison so production builds drop the demo backend entirely.
  if (import.meta.env.VITE_ENDPOINT === 'mock' || (import.meta.env.DEV && !import.meta.env.VITE_ENDPOINT)) {
    const { mockHandle } = await import('./mock');
    return mockHandle(JSON.parse(JSON.stringify(body)));
  }
  if (!ENDPOINT) throw new NetworkError('Backend not configured (VITE_ENDPOINT missing)');
  const payload = JSON.stringify({ rid: rand(10), ...body });
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    if (i) await sleep(Math.min(8000, 900 * 2 ** (i - 1)) + Math.random() * 400);
    try {
      // text/plain avoids a CORS preflight, which Apps Script cannot answer.
      const res = await fetch(ENDPOINT, { method: 'POST', body: payload, headers: { 'Content-Type': 'text/plain;charset=utf-8' } });
      const text = await res.text();
      let json: any;
      try { json = JSON.parse(text); } catch { last = new Error(`Unexpected response (${res.status})`); continue; }
      if (!json || typeof json !== 'object') { last = new Error('Empty response'); continue; }
      if (!json.ok && TRANSIENT.has(json.error) && i < attempts - 1) { last = new Error(json.detail || json.error); continue; }
      return json;
    } catch (e) {
      last = e;
    }
  }
  throw new NetworkError(last instanceof Error ? last.message : 'Network error');
}
