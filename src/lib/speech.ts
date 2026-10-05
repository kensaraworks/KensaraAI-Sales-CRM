/** Free, on-device-ish dictation via the browser's Web Speech API (Chrome, Edge, Android, Safari 14.5+). */
import { useEffect, useRef, useState } from 'preact/hooks';

const SR: any = typeof window !== 'undefined' ? (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition : null;
export const speechSupported = !!SR;

export type SpeechLang = 'en-IN' | 'hi-IN';

export function getLang(): SpeechLang {
  try { return (localStorage.getItem('ks-speech') as SpeechLang) || 'en-IN'; } catch { return 'en-IN'; }
}
export function setLang(l: SpeechLang) { try { localStorage.setItem('ks-speech', l); } catch { /* ignore */ } }

/**
 * Continuous dictation. `onFinal` gets each finished phrase; `interim` shows what's being heard.
 * Stops on its own after a few seconds of silence.
 */
export function useDictation(onFinal: (text: string) => void) {
  const [on, setOn] = useState(false);
  const [interim, setInterim] = useState('');
  const [error, setError] = useState('');
  const rec = useRef<any>(null);
  const cb = useRef(onFinal);
  cb.current = onFinal;

  useEffect(() => () => rec.current?.abort?.(), []);

  const start = () => {
    if (!SR) { setError('Voice typing needs Chrome or Edge'); return; }
    setError('');
    const r = new SR();
    r.lang = getLang();
    r.continuous = true;
    r.interimResults = true;
    r.maxAlternatives = 1;
    r.onresult = (e: any) => {
      let live = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i];
        if (res.isFinal) cb.current(res[0].transcript.trim());
        else live += res[0].transcript;
      }
      setInterim(live);
    };
    r.onerror = (e: any) => {
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') setError('Microphone blocked — allow it in the address bar');
      else if (e.error === 'no-speech') setError('');
      else if (e.error !== 'aborted') setError('Voice typing hiccup — tap to try again');
    };
    r.onend = () => { setOn(false); setInterim(''); };
    rec.current = r;
    try { r.start(); setOn(true); } catch { setOn(false); }
  };
  const stop = () => { rec.current?.stop?.(); };
  return { on, interim, error, start, stop, toggle: () => (on ? stop() : start()) };
}
