// Deadlines apply to reads, including response parsing. No request is retried here.
export async function withReadDeadline<T>(
  read: (signal: AbortSignal) => Promise<T>,
  options: {signal?: AbortSignal; timeoutMs?: number} = {},
): Promise<T> {
  const controller = new AbortController();
  let rejectDeadline: (reason: Error) => void = () => {};
  const interrupted = new Promise<never>((_, reject) => { rejectDeadline = reject; });
  function interrupt(error: Error) { rejectDeadline(error); controller.abort(); }
  const onAbort = () => interrupt(Object.assign(new Error('Lectura cancelada'), {name: 'AbortError'}));
  const timer = setTimeout(() => interrupt(Object.assign(new Error('La consulta tardó demasiado. Se conserva la última información.'), {name: 'TimeoutError'})), options.timeoutMs ?? 15000);
  options.signal?.addEventListener('abort', onAbort, {once: true});
  try {
    if (options.signal?.aborted) { onAbort(); }
    const work = Promise.resolve().then(() => {
      if (controller.signal.aborted) throw Object.assign(new Error('Lectura cancelada'), {name: 'AbortError'});
      return read(controller.signal);
    });
    return await Promise.race([work, interrupted]);
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onAbort);
  }
}
