import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';

export function recoveryCookieSecure(): boolean {
  return process.env.NODE_ENV === 'production' || [
    process.env.FLASH_CUSTOMER_URL || '',
    ...(process.env.FLASH_ALLOWED_ORIGINS || '').split(','),
  ].some(origin => origin.trim().toLowerCase().startsWith('https://'));
}

// Recovery mutations accept JSON from trusted origins only. Do not trust Host or
// forwarded headers to define the origin allowlist. Non-browser JSON clients
// without Origin remain subject to the same PIN/session and throttling checks.
@Injectable()
export class RecoveryRequestGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<{headers: Record<string,string|string[]|undefined>}>();
    const response = context.switchToHttp().getResponse<{setHeader:(name:string,value:string)=>void}>();
    response.setHeader('Cache-Control','no-store');
    const header = (name:string) => typeof request.headers[name] === 'string' ? request.headers[name] as string : '';
    const contentType=header('content-type').split(';')[0].trim().toLowerCase();
    const origin=header('origin');
    const allowed = new Set([
      ...(process.env.FLASH_ALLOWED_ORIGINS || '').split(','), process.env.FLASH_CUSTOMER_URL || '',
      ...(process.env.NODE_ENV !== 'production' ? ['http://localhost:3000'] : []),
    ].map(value=>value.trim()).filter(Boolean));
    if (contentType !== 'application/json' || header('sec-fetch-site') === 'cross-site' ||
        (origin && !allowed.has(origin))) throw new ForbiddenException('Invalid recovery request');
    return true;
  }
}
