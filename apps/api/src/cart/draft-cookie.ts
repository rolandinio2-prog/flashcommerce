import { createHash } from 'crypto';
import { scope, secret } from './draft-validation';

export function draftCookieName(tenant: unknown, branch: unknown) {
  return (
    '__Secure-fc_draft_' +
    createHash('sha256')
      .update(JSON.stringify([scope(tenant), scope(branch)]))
      .digest('hex')
      .slice(0, 32)
  );
}
export function readDraftCookie(
  header: string | undefined,
  tenant: unknown,
  branch: unknown,
): string | null {
  const name = draftCookieName(tenant, branch);
  const value = header
    ?.split(';')
    .map((x) => x.trim())
    .find((x) => x.startsWith(name + '='))
    ?.slice(name.length + 1);
  try {
    return value ? secret(decodeURIComponent(value)) : null;
  } catch {
    return null;
  }
}
export function draftCookieOptions(expiresAt: string | Date) {
  const expires = new Date(expiresAt);
  if (!Number.isFinite(expires.getTime()) || expires.getTime() <= Date.now())
    throw new Error('DRAFT_COOKIE_EXPIRY_INVALID');
  return {
    httpOnly: true,
    secure: true,
    sameSite: 'lax' as const,
    path: '/api/v1/checkout-drafts',
    expires,
  };
}
