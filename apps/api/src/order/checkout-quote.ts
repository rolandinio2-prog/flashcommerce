import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { ConflictException } from '@nestjs/common';

// Quotes contain only an expiry and an HMAC, never addresses or cart contents.
// A dedicated shared secret supports multiple API processes. Without one,
// restarting this API safely invalidates outstanding quotes (recalculate).
const bootKey = randomBytes(32);
const ttlMs = 5 * 60_000;
const changed = 'El cálculo de envío venció o cambió. Calcula nuevamente y revisa el total antes de confirmar.';
function key() { return process.env.FLASH_CHECKOUT_QUOTE_SECRET?.trim() || bootKey; }
function signature(context: string, expires: number) {
  return createHmac('sha256', key()).update('flashcommerce:delivery-quote:v1\n' + expires + '\n' + context).digest('hex');
}
export function requireQuoteToken(token: unknown, now = Date.now()): { token: string; expires: number } {
  if (typeof token !== 'string' || !/^1\.\d{13}\.[a-f0-9]{64}$/.test(token)) throw new ConflictException(changed);
  const expires = Number(token.split('.')[1]);
  if (expires <= now || expires > now + ttlMs) throw new ConflictException(changed);
  return { token, expires };
}
export function issueQuote(context: string, now = Date.now()) {
  const expires = now + ttlMs;
  return { quoteToken: `1.${expires}.${signature(context, expires)}`, expiresAt: new Date(expires).toISOString() };
}
export function verifyQuote(token: unknown, context: string, now = Date.now()) {
  const parsed = requireQuoteToken(token, now);
  if (!timingSafeEqual(Buffer.from(parsed.token.split('.')[2], 'hex'), Buffer.from(signature(context, parsed.expires), 'hex'))) {
    throw new ConflictException(changed);
  }
}
