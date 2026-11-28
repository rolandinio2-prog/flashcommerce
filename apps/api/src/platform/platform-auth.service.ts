import {
  BadRequestException,
  ConflictException,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { IncomingHttpHeaders } from 'node:http';

import { DatabaseService } from '../core/database/database.service';
import {
  hashPassword,
  hashToken,
  newSessionToken,
  sameSecret,
  temporaryPassword,
  verifyPassword,
} from './platform-credentials';

export const PLATFORM_SESSION_COOKIE = 'flash_platform_session';
const SESSION_MS = 8 * 60 * 60 * 1000;
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,120}\.[^\s@]{2,}$/;

export interface PlatformPrincipal {
  userId: string;
  sessionId: string;
  email: string;
  displayName: string;
  passwordChangeRequired: boolean;
}

interface UserRow {
  id: string;
  email: string;
  display_name: string;
  password_hash: string;
  status: string;
  password_change_required: boolean;
}

/** Sign-in for FlashCommerce Cloud platform operators (separate from business staff). */
@Injectable()
export class PlatformAuthService {
  constructor(
    private readonly db: DatabaseService,
    private readonly config: ConfigService,
  ) {}

  private email(value: unknown): string {
    const email = typeof value === 'string' ? value.trim().toLowerCase() : '';
    if (!EMAIL.test(email))
      throw new BadRequestException('email no es válido.');
    return email;
  }

  /**
   * Creates the first platform operator. Only works while there is none, and needs the server's
   * OPS_ACCESS_KEY, so it cannot be used to add operators later. Returns a temporary password once.
   */
  async bootstrap(
    input: { email?: unknown; displayName?: unknown },
    opsKey?: string,
  ) {
    const configured = this.config.get<string>('OPS_ACCESS_KEY')?.trim() ?? '';
    if (configured.length < 48)
      throw new ServiceUnavailableException(
        'La clave de operaciones no está configurada.',
      );
    if (!sameSecret((opsKey ?? '').trim(), configured))
      throw new UnauthorizedException('Clave de operaciones incorrecta.');
    const email = this.email(input?.email);
    const displayName =
      typeof input?.displayName === 'string' && input.displayName.trim()
        ? input.displayName.trim().slice(0, 120)
        : null;
    if (!displayName)
      throw new BadRequestException('displayName es obligatorio.');
    const password = temporaryPassword();
    return this.db.withTransaction(async (client) => {
      await client.query('lock table public.platform_users in exclusive mode');
      const n = await client.query<{ n: number }>(
        'select count(*)::int as n from public.platform_users',
      );
      if (n.rows[0].n > 0)
        throw new ConflictException(
          'La consola ya tiene un operador. Pídele que te cree el acceso.',
        );
      const r = await client.query<{ id: string }>(
        'insert into public.platform_users (email, display_name, password_hash) values ($1,$2,$3) returning id::text',
        [email, displayName, hashPassword(password)],
      );
      await client.query(
        "insert into public.platform_audit_events (actor_user_id, action, details) values ($1::uuid, 'PLATFORM_BOOTSTRAP', $2::jsonb)",
        [r.rows[0].id, JSON.stringify({ email })],
      );
      return { email, temporaryPassword: password };
    });
  }

  async login(input: { email?: unknown; password?: unknown }) {
    const email = this.email(input?.email);
    const password = typeof input?.password === 'string' ? input.password : '';
    const r = await this.db.query<UserRow>(
      'select id::text, email, display_name, password_hash, status, password_change_required from public.platform_users where lower(email)=$1',
      [email],
    );
    const user = r.rows[0];
    // Always run the hash so a missing user takes as long as a wrong password.
    const ok = verifyPassword(
      password,
      user?.password_hash ?? 'scrypt$AAAAAAAAAAAAAAAAAAAAAA$' + 'A'.repeat(86),
    );
    if (!user || !ok || user.status !== 'ACTIVE')
      throw new UnauthorizedException('Correo o contraseña incorrectos.');
    const token = newSessionToken();
    const expiresAt = new Date(Date.now() + SESSION_MS);
    const s = await this.db.query<{ id: string }>(
      'insert into public.platform_sessions (user_id, token_hash, expires_at) values ($1::uuid,$2,$3::timestamptz) returning id::text',
      [user.id, hashToken(token), expiresAt.toISOString()],
    );
    await this.db.query(
      'update public.platform_users set last_login_at=now() where id=$1::uuid',
      [user.id],
    );
    return {
      token,
      expiresAt,
      principal: {
        userId: user.id,
        sessionId: s.rows[0].id,
        email: user.email,
        displayName: user.display_name,
        passwordChangeRequired: user.password_change_required,
      } satisfies PlatformPrincipal,
    };
  }

  async resolve(token: string): Promise<PlatformPrincipal | null> {
    const r = await this.db.query<UserRow & { session_id: string }>(
      `select u.id::text, u.email, u.display_name, u.password_hash, u.status, u.password_change_required, s.id::text as session_id
         from public.platform_sessions s join public.platform_users u on u.id=s.user_id
        where s.token_hash=$1 and s.revoked_at is null and s.expires_at > now() and u.status='ACTIVE'`,
      [hashToken(token)],
    );
    const u = r.rows[0];
    return u
      ? {
          userId: u.id,
          sessionId: u.session_id,
          email: u.email,
          displayName: u.display_name,
          passwordChangeRequired: u.password_change_required,
        }
      : null;
  }

  async logout(sessionId: string) {
    await this.db.query(
      'update public.platform_sessions set revoked_at=now() where id=$1::uuid and revoked_at is null',
      [sessionId],
    );
  }

  async changePassword(
    principal: PlatformPrincipal,
    input: { currentPassword?: unknown; newPassword?: unknown },
  ) {
    const next =
      typeof input?.newPassword === 'string' ? input.newPassword : '';
    if (next.length < 12 || next.length > 200)
      throw new BadRequestException(
        'La nueva contraseña debe tener al menos 12 caracteres.',
      );
    const r = await this.db.query<{ password_hash: string }>(
      'select password_hash from public.platform_users where id=$1::uuid',
      [principal.userId],
    );
    const current =
      typeof input?.currentPassword === 'string' ? input.currentPassword : '';
    if (!r.rows[0] || !verifyPassword(current, r.rows[0].password_hash))
      throw new UnauthorizedException('La contraseña actual no es correcta.');
    await this.db.withTransaction(async (client) => {
      await client.query(
        'update public.platform_users set password_hash=$2, password_change_required=false, updated_at=now() where id=$1::uuid',
        [principal.userId, hashPassword(next)],
      );
      // Other sessions of this operator end; the current one stays.
      await client.query(
        'update public.platform_sessions set revoked_at=now() where user_id=$1::uuid and id<>$2::uuid and revoked_at is null',
        [principal.userId, principal.sessionId],
      );
      await client.query(
        "insert into public.platform_audit_events (actor_user_id, action) values ($1::uuid, 'PASSWORD_CHANGED')",
        [principal.userId],
      );
    });
    return { ok: true };
  }

  readToken(headers: IncomingHttpHeaders): string | null {
    const raw = typeof headers.cookie === 'string' ? headers.cookie : '';
    for (const pair of raw.split(';')) {
      const i = pair.indexOf('=');
      if (i > 0 && pair.slice(0, i).trim() === PLATFORM_SESSION_COOKIE) {
        const v = decodeURIComponent(pair.slice(i + 1).trim());
        return v || null;
      }
    }
    return null;
  }
}
