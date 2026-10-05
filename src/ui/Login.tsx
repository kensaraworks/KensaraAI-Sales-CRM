import { useState } from 'preact/hooks';
import { store } from '../lib/store';
import { isMock } from '../lib/api';
import { Spinner } from './components';

export function Login() {
  const [name, setName] = useState(() => { try { return localStorage.getItem('ks-last-name') || ''; } catch { return ''; } });
  const [pin, setPin] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: Event) => {
    e.preventDefault();
    if (!name.trim() || !pin) { setErr('Enter your name and PIN.'); return; }
    setBusy(true);
    setErr('');
    try {
      const e2 = await store.login(name.trim(), pin);
      if (e2) setErr(e2);
      else try { localStorage.setItem('ks-last-name', name.trim()); } catch { /* ignore */ }
    } catch {
      setErr("Can't reach the server. Check your internet and try again.");
    }
    setBusy(false);
  };

  return (
    <div class="login">
      <form class="login__card" onSubmit={submit}>
        <div class="login__mark">K</div>
        <h1>Kensara Sales</h1>
        <p class="muted" style={{ margin: '6px 0 24px' }}>Sign in once on this device — you'll stay signed in.</p>
        <div class="col" style={{ gap: '12px' }}>
          <label class="field"><span>Your name</span>
            <input class="input" autoComplete="username" value={name} onInput={(e) => setName((e.target as HTMLInputElement).value)} autoFocus={!name} />
          </label>
          <label class="field"><span>PIN</span>
            <input class="input" type="password" autoComplete="current-password" value={pin} onInput={(e) => setPin((e.target as HTMLInputElement).value)} autoFocus={!!name} />
          </label>
          {err && <p class="err">{err}</p>}
          <button class="btn btn--primary btn--lg" disabled={busy} type="submit">{busy ? <Spinner /> : 'Sign in'}</button>
          <p class="tiny muted">Don't have a PIN? Ask your team lead.</p>
          {isMock && <p class="tiny muted" style={{ padding: '10px 12px', background: 'var(--soft)', borderRadius: '10px' }}>Demo mode — try <b>Asha</b> (calls), <b>Ravi</b> (shares details) or <b>Neha</b> (discovery) with PIN <b>1234</b>.</p>}
        </div>
      </form>
    </div>
  );
}
