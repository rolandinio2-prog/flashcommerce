export type CartAction = 'add' | 'decrease' | 'remove';
export type PendingCartAction = { key: string; action: CartAction };
export function isCartActionPending(pending: readonly PendingCartAction[], key: string, action: CartAction) {
  return pending.some(item => item.key === key && item.action === action);
}

// One mutation followed by one authoritative read, in click order. Never retry writes.
export function createCartActionQueue(onChange: (pending: PendingCartAction[]) => void, onError: (error: unknown, cancelled: number) => void) {
  type Job = PendingCartAction & { run: () => Promise<void> };
  let jobs: Job[] = [], running = false, paused = false;
  const emit = () => onChange(jobs.map(({ key, action }) => ({ key, action })));
  async function drain() {
    if (running || paused) return;
    running = true;
    try {
      while (jobs.length && !paused) {
        const job = jobs[0];
        try { await job.run(); }
        catch (error) {
          const cancelled = Math.max(0, jobs.length - 1);
          jobs = []; paused = true; emit(); onError(error, cancelled); return;
        }
        jobs.shift(); emit();
      }
    } finally { running = false; }
  }
  return {
    enqueue(key: string, action: CartAction, run: () => Promise<void>) {
      if (paused || isCartActionPending(jobs, key, action)) return false;
      jobs.push({ key, action, run }); emit(); void drain(); return true;
    },
    isBusy: () => running || jobs.length > 0,
    pause() { paused = true; jobs = running ? jobs.slice(0, 1) : []; emit(); },
    resume() { paused = false; void drain(); },
  };
}
