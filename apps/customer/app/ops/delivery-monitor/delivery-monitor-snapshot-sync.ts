export interface SnapshotSyncOptions<T> {
  fetchSnapshot(signal: AbortSignal): Promise<T>;
  onSnapshot(snapshot: T): void;
  onError(error: unknown): void;
  onLoading(loading: boolean): void;
  isVisible(): boolean;
  intervalMs?: number;
  setTimer?: (callback: () => void, delay: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
}

// One request at a time. Wakeups coalesce; disposal prevents late session data.
export function createMonitorSnapshotSync<T>(options: SnapshotSyncOptions<T>) {
  const schedule = options.setTimer ?? setTimeout;
  const cancel = options.clearTimer ?? clearTimeout;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  let pending = false;
  let inFlight: Promise<void> | null = null;
  let controller: AbortController | null = null;

  function clearScheduled() {
    if (timer !== undefined) cancel(timer);
    timer = undefined;
  }

  function request(): Promise<void> {
    if (disposed) return Promise.resolve();
    clearScheduled();
    if (inFlight) {
      pending = true;
      return inFlight;
    }
    if (!options.isVisible()) return Promise.resolve();
    controller = new AbortController();
    const signal = controller.signal;
    options.onLoading(true);
    // Start through a microtask so callbacks cannot race assignment to inFlight.
    inFlight = Promise.resolve().then(async () => {
      try {
        if (disposed || signal.aborted) return;
        const snapshot = await options.fetchSnapshot(signal);
        if (!disposed && !signal.aborted) options.onSnapshot(snapshot);
      } catch (error) {
        if (!disposed && !signal.aborted) options.onError(error);
      } finally {
        inFlight = null;
        controller = null;
        if (!disposed) {
          options.onLoading(false);
          const delay = pending ? 0 : (options.intervalMs ?? 5000);
          pending = false;
          timer = schedule(() => { timer = undefined; void request(); }, delay);
        }
      }
    });
    return inFlight;
  }

  function dispose() {
    disposed = true;
    pending = false;
    clearScheduled();
    controller?.abort();
  }

  return {request, dispose};
}
