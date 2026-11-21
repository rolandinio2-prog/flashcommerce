import { request } from 'node:https';

const GOOGLE_HOSTS = new Set([
  'geocode.googleapis.com',
  'places.googleapis.com',
  'routes.googleapis.com',
]);

/** Use the IPv4 egress authorized by the server's Google Maps key. */
export function requestGoogleIpv4(
  url: string,
  init: RequestInit,
): Promise<Response> {
  const target = new URL(url);
  if (
    target.protocol !== 'https:' ||
    !GOOGLE_HOSTS.has(target.hostname) ||
    target.username ||
    target.password ||
    (target.port && target.port !== '443')
  ) {
    return Promise.reject(new Error('Invalid Google transport destination'));
  }
  if (
    init.body !== undefined &&
    init.body !== null &&
    typeof init.body !== 'string'
  ) {
    return Promise.reject(new Error('Invalid Google request body'));
  }
  return new Promise((resolve, reject) => {
    const outgoing = request(
      target,
      {
        method: init.method || 'GET',
        headers: Object.fromEntries(new Headers(init.headers).entries()),
        family: 4,
        // Keep the provider's deadline across connect, headers and response body.
        signal: init.signal ?? undefined,
      },
      (incoming) => {
        const chunks: Buffer[] = [];
        let bytes = 0;
        incoming.on('data', (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > 4 * 1024 * 1024) {
            const error = new Error('Google response too large');
            reject(error);
            incoming.destroy(error);
            outgoing.destroy(error);
            return;
          }
          chunks.push(chunk);
        });
        incoming.on('error', (error) =>
          reject(init.signal?.aborted ? init.signal.reason : error),
        );
        incoming.on('aborted', () =>
          reject(
            init.signal?.aborted
              ? init.signal.reason
              : new Error('Google response interrupted'),
          ),
        );
        incoming.on('end', () => {
          try {
            const headers = new Headers();
            for (const [name, value] of Object.entries(incoming.headers)) {
              if (Array.isArray(value))
                value.forEach((v) => headers.append(name, v));
              else if (value !== undefined) headers.set(name, value);
            }
            const status = incoming.statusCode ?? 502;
            const body = [204, 205, 304].includes(status)
              ? null
              : Buffer.concat(chunks).toString('utf8');
            // Native HTTPS does not follow redirects or retry the request.
            resolve(new Response(body, { status, headers }));
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    outgoing.on('error', (error) => {
      reject(init.signal?.aborted ? init.signal.reason : error);
    });
    if (typeof init.body === 'string') outgoing.end(init.body);
    else outgoing.end();
  });
}
