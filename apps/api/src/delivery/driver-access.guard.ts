import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';

import { DatabaseService } from '../core/database/database.service';

export interface AuthenticatedDriverContext {
  credentialId: string;

  tenantId: string;
  tenantCode: string;

  driverId: string;
  driverCode: string;
  displayName: string;
  phone: string;
  passwordChangeRequired: boolean;

  expiresAt: string | Date | null;
}

export interface DriverAuthenticatedRequest {
  headers: Record<string, string | string[] | undefined>;

  driverAuth?: AuthenticatedDriverContext;
}

@Injectable()
export class DriverAccessGuard implements CanActivate {
  constructor(private readonly databaseService: DatabaseService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context
      .switchToHttp()
      .getRequest<DriverAuthenticatedRequest>();

    const authorizationHeader = request.headers.authorization;

    const authorization = (
      Array.isArray(authorizationHeader)
        ? authorizationHeader[0]
        : authorizationHeader || ''
    ).trim();

    const bearerMatch = /^Bearer\s+(.+)$/i.exec(authorization);

    if (!bearerMatch) {
      throw this.invalidCredentials();
    }

    const rawToken = bearerMatch[1]?.trim() || '';

    // The guard intentionally does not prescribe a token
    // alphabet. Production tokens may use base64url or hex.
    // It only enforces sane transport bounds.
    if (rawToken.length < 32 || rawToken.length > 512) {
      throw this.invalidCredentials();
    }

    const tokenHash = createHash('sha256')
      .update(rawToken, 'utf8')
      .digest('hex');

    const credentialResult = await this.databaseService.query<{
      credential_id: string;

      tenant_id: string;
      tenant_code: string;

      driver_id: string;
      driver_code: string;
      display_name: string;
      phone: string;
      password_change_required: boolean;

      expires_at: string | Date | null;
    }>(
      `
          select
            c.id::text
              as credential_id,

            t.id::text
              as tenant_id,

            t.code
              as tenant_code,

            drv.id::text
              as driver_id,

            drv.code
              as driver_code,

            drv.display_name,
            drv.phone,
            drv.password_change_required,

            c.expires_at

          from public.delivery_driver_credentials c

          inner join public.delivery_drivers drv
            on drv.tenant_id = c.tenant_id
           and drv.id = c.driver_id

          inner join public.tenants t
            on t.id = c.tenant_id

          where c.token_hash = $1

            and c.status = 'ACTIVE'
            and c.revoked_at is null

            and (
              c.expires_at is null
              or c.expires_at > now()
            )

            and drv.status = 'ACTIVE'
            and t.status = 'ACTIVE'

          limit 1
        `,
      [tokenHash],
    );

    const credential = credentialResult.rows[0];

    // Deliberately use the same response for:
    //
    // - unknown hash
    // - revoked credential
    // - expired credential
    // - inactive driver
    // - inactive tenant
    //
    // This prevents authentication-state probing.
    if (!credential) {
      throw this.invalidCredentials();
    }

    request.driverAuth = {
      credentialId: credential.credential_id,

      tenantId: credential.tenant_id,

      tenantCode: credential.tenant_code,

      driverId: credential.driver_id,

      driverCode: credential.driver_code,

      displayName: credential.display_name,

      phone: credential.phone,

      passwordChangeRequired: credential.password_change_required,

      expiresAt: credential.expires_at,
    };

    return true;
  }

  private invalidCredentials(): UnauthorizedException {
    return new UnauthorizedException('Invalid driver credentials');
  }
}
