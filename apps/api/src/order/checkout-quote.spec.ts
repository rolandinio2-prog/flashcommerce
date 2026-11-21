import { ConflictException } from '@nestjs/common';

import { issueQuote, requireQuoteToken, verifyQuote } from './checkout-quote';

describe('delivery checkout quotes', () => {
  const now = 1_790_000_000_000;
  const context = 'POLLO001|SUC001|cart-1|-17.78,-63.18|BOB 15.00';

  it('issues a token valid for five minutes for the exact same context', () => {
    const { quoteToken, expiresAt } = issueQuote(context, now);
    expect(quoteToken).toMatch(/^1\.\d{13}\.[a-f0-9]{64}$/);
    expect(Date.parse(expiresAt) - now).toBe(5 * 60_000);
    expect(() => verifyQuote(quoteToken, context, now + 60_000)).not.toThrow();
  });

  it('rejects the token for any other context (address, cart or price changed)', () => {
    const { quoteToken } = issueQuote(context, now);
    expect(() =>
      verifyQuote(quoteToken, context.replace('15.00', '1.00'), now),
    ).toThrow(ConflictException);
  });

  it('rejects an expired token', () => {
    const { quoteToken } = issueQuote(context, now);
    expect(() => verifyQuote(quoteToken, context, now + 5 * 60_000)).toThrow(
      ConflictException,
    );
  });

  it('rejects a token whose expiry was pushed into the future', () => {
    const { quoteToken } = issueQuote(context, now);
    const [, , sig] = quoteToken.split('.');
    const forged = `1.${now + 4 * 60_000}.${sig}`;
    expect(() => verifyQuote(forged, context, now)).toThrow(ConflictException);
    expect(() =>
      requireQuoteToken(`1.${now + 60 * 60_000}.${sig}`, now),
    ).toThrow(ConflictException);
  });

  it.each([
    ['non-string', 123],
    ['wrong version', '2.1790000300000.' + 'a'.repeat(64)],
    ['short signature', '1.1790000300000.abc'],
    ['uppercase hex', '1.1790000300000.' + 'A'.repeat(64)],
    ['undefined', undefined],
  ])('rejects malformed token: %s', (_label, token) => {
    expect(() => requireQuoteToken(token, now)).toThrow(ConflictException);
  });
});
