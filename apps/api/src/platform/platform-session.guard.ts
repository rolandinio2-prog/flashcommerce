import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  SetMetadata,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';

import {
  PlatformAuthService,
  type PlatformPrincipal,
} from './platform-auth.service';

export type PlatformRequest = Request & { platform?: PlatformPrincipal };

const ALLOW_PENDING = 'platform:allowPendingPassword';
/** The route stays usable while the operator still has to replace a temporary password. */
export const AllowPendingPassword = () => SetMetadata(ALLOW_PENDING, true);

function allowedOrigins(): Set<string> {
  const list = (process.env.FLASH_ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
  if (process.env.FLASH_CUSTOMER_URL)
    list.push(process.env.FLASH_CUSTOMER_URL.trim());
  if (process.env.NODE_ENV !== 'production')
    list.push('http://localhost:3000', 'http://127.0.0.1:3000');
  return new Set(list.map((o) => o.replace(/\/+$/, '')));
}

/**
 * Platform console routes: a valid platform session, and for writes an Origin from the configured
 * web origins (the cookie is SameSite=Strict too; this is a second CSRF barrier).
 */
@Injectable()
export class PlatformSessionGuard implements CanActivate {
  constructor(
    private readonly auth: PlatformAuthService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<PlatformRequest>();
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
      const origin = request.headers.origin;
      if (!origin || !allowedOrigins().has(origin.replace(/\/+$/, '')))
        throw new ForbiddenException('Origen no permitido.');
    }
    const token = this.auth.readToken(request.headers);
    const principal = token ? await this.auth.resolve(token) : null;
    if (!principal)
      throw new UnauthorizedException('Inicia sesión en la consola.');
    const allowPending = this.reflector.getAllAndOverride<boolean>(
      ALLOW_PENDING,
      [context.getHandler(), context.getClass()],
    );
    if (principal.passwordChangeRequired && !allowPending)
      throw new ForbiddenException(
        'Cambia tu contraseña temporal antes de continuar.',
      );
    request.platform = principal;
    return true;
  }
}
