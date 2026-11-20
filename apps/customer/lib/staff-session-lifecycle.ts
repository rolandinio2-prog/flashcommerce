import {newStaffDiagnostic} from './staff-me-diagnostic';
import {withReadDeadline} from './read-deadline';

// Logout messages contain no user, session, token or business data.
const signal = 'flashcommerce:staff-logout:v1';
const message = 'logout';

export function announceStaffLogout(): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new Event(signal));
  try {
    const channel = new BroadcastChannel(signal);
    channel.postMessage(message);
    channel.close();
  } catch { /* Storage events provide a fallback when BroadcastChannel is unavailable. */ }
  try {
    window.localStorage.setItem(signal, message);
    window.localStorage.removeItem(signal);
  } catch { /* The local notification and available channel still apply. */ }
}

export function onStaffLogout(listener: () => void): () => void {
  if (typeof window === 'undefined') return () => {};
  let disposed = false;
  const notify = () => { if (!disposed) listener(); };
  const storage = (event: StorageEvent) => {
    if (event.key === signal && event.newValue === message && event.storageArea === window.localStorage) notify();
  };
  let channel: BroadcastChannel | undefined;
  window.addEventListener(signal, notify);
  window.addEventListener('storage', storage);
  try {
    channel = new BroadcastChannel(signal);
    channel.onmessage = event => { if (event.data === message) notify(); };
  } catch { /* Fall back to local and storage events. */ }
  return () => {
    if (disposed) return;
    disposed = true;
    window.removeEventListener(signal, notify);
    window.removeEventListener('storage', storage);
    channel?.close();
  };
}

// A late successful verification must never undo logout or access denial.
export function watchStaffSession<T>(
  read: (signal?: AbortSignal) => Promise<T>,
  accept: (session: T) => boolean,
  deny: () => void,
  options: {onTransient?: () => void} = {},
): () => void {
  let stopped = false;
  let inFlight = false;
  let pendingOnline = false;
  let controller: AbortController | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let unsubscribe = () => {};
  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearTimeout(timer);
    controller?.abort();
    unsubscribe();
    if (typeof window !== 'undefined') window.removeEventListener('online', wake);
  };
  const reject = () => { if (!stopped) { stop(); deny(); } };
  function wake() {
    if (stopped) return;
    if (inFlight) { pendingOnline = true; return; }
    clearTimeout(timer);
    void verify();
  }
  unsubscribe = onStaffLogout(() => { newStaffDiagnostic('WATCHER').record('LOGOUT','REJECTED'); reject(); });
  if (options.onTransient && typeof window !== 'undefined') window.addEventListener('online', wake);
  async function verify() {
    if (stopped || inFlight) return;
    inFlight = true;
    controller = new AbortController();
    let delay = 10000;
    const diagnostic = newStaffDiagnostic('WATCHER');
    try {
      let session: T;
      try {
        session = await withReadDeadline(signal => read(signal), {signal: controller.signal, timeoutMs: 8000});
      } catch (error) {
        if (stopped) return;
        diagnostic.record('READ','THREW',error);
        const e = error as {name?: string; status?: number} | null;
        const status = e?.status;
        const transient = typeof status === 'number'
          ? status === 408 || status === 429 || (status >= 500 && status <= 599)
          : e?.name === 'TypeError' || e?.name === 'TimeoutError';
        if (!options.onTransient || !transient) { reject(); return; }
        // Hide protected data until a fresh session check succeeds; do not logout.
        options.onTransient();
        delay = 5000;
        return;
      }
      if (!stopped) {
        const accepted = accept(session);
        diagnostic.record('ACCEPT',accepted ? 'OK' : 'REJECTED');
        if (!accepted) reject();
      }
    } catch (error) { diagnostic.record('ACCEPT','THREW',error); reject(); } // Invalid session/callback errors must not grant access.
    finally {
      inFlight = false;
      controller = undefined;
      if (!stopped) {
        timer = setTimeout(verify, pendingOnline ? 0 : delay);
        pendingOnline = false;
      }
    }
  }
  void verify();
  return stop;
}
