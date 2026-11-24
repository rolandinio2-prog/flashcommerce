import {
  BadRequestException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import {
  createHash,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from 'node:crypto';

import { DatabaseService } from '../core/database/database.service';
import type { AuthenticatedDriverContext } from './driver-access.guard';

const DRIVER_SESSION_DURATION_MS = 12 * 60 * 60 * 1000;

interface DriverLoginInput {
  tenantCode?: unknown;
  driverCode?: unknown;
  password?: unknown;
}

interface DriverPasswordInput {
  newPassword?: unknown;
}

@Injectable()
export class DriverAuthService {
  constructor(private readonly databaseService: DatabaseService) {}

  async login(input: DriverLoginInput) {
    const tenantCode = this.requireCode(input.tenantCode, 'tenantCode');
    const driverCode = this.requireCode(input.driverCode, 'driverCode');
    const password = this.requirePassword(input.password);

    const accessToken = randomBytes(32).toString('hex');
    const tokenHash = this.hashToken(accessToken);
    const expiresAt = new Date(Date.now() + DRIVER_SESSION_DURATION_MS);

    const driver = await this.databaseService.withTransaction(
      async (client) => {
        const result = await client.query<{
          tenant_id: string;
          tenant_code: string;
          driver_id: string;
          driver_code: string;
          display_name: string;
          phone: string;
          password_hash: string | null;
          password_change_required: boolean;
        }>(
          `
          select
            t.id::text as tenant_id,
            t.code as tenant_code,
            drv.id::text as driver_id,
            drv.code as driver_code,
            drv.display_name,
            drv.phone,
            drv.password_hash,
            drv.password_change_required
          from public.delivery_drivers drv
          inner join public.tenants t
            on t.id = drv.tenant_id
          where t.code = $1
            and drv.code = $2
            and t.status = 'ACTIVE'
            and drv.status = 'ACTIVE'
            and exists (
              select 1
              from public.delivery_driver_branches db
              where db.tenant_id = drv.tenant_id
                and db.driver_id = drv.id
                and db.status = 'ENABLED'
            )
          limit 1
          for update of drv
        `,
          [tenantCode, driverCode],
        );

        const row = result.rows[0];

        if (
          !row ||
          !row.password_hash ||
          !this.verifyPassword(password, row.password_hash)
        ) {
          throw this.invalidCredentials();
        }

        await client.query(
          `
          update public.delivery_driver_credentials
          set
            status = 'REVOKED',
            revoked_at = coalesce(revoked_at, now()),
            updated_at = now()
          where tenant_id = $1::uuid
            and driver_id = $2::uuid
            and status = 'ACTIVE'
        `,
          [row.tenant_id, row.driver_id],
        );

        await client.query(
          `
          insert into public.delivery_driver_credentials (
            tenant_id,
            driver_id,
            token_hash,
            expires_at
          )
          values (
            $1::uuid,
            $2::uuid,
            $3,
            $4::timestamptz
          )
        `,
          [row.tenant_id, row.driver_id, tokenHash, expiresAt.toISOString()],
        );

        await client.query(
          `
          update public.delivery_drivers
          set
            last_login_at = now(),
            updated_at = now()
          where tenant_id = $1::uuid
            and id = $2::uuid
        `,
          [row.tenant_id, row.driver_id],
        );

        return row;
      },
    );

    return {
      authenticated: true,
      accessToken,
      expiresAt: expiresAt.toISOString(),
      passwordChangeRequired: driver.password_change_required,
      driver: {
        id: driver.driver_id,
        code: driver.driver_code,
        displayName: driver.display_name,
        phone: driver.phone,
      },
      tenant: {
        id: driver.tenant_id,
        code: driver.tenant_code,
      },
    };
  }

  async changePassword(
    principal: AuthenticatedDriverContext,
    input: DriverPasswordInput,
  ) {
    const newPassword = this.requirePersonalPassword(input.newPassword);
    const passwordHash = this.hashPassword(newPassword);

    const result = await this.databaseService.query<{ id: string }>(
      `
        update public.delivery_drivers
        set
          password_hash = $3,
          password_change_required = false,
          password_changed_at = now(),
          updated_at = now()
        where tenant_id = $1::uuid
          and id = $2::uuid
        returning id::text
      `,
      [principal.tenantId, principal.driverId, passwordHash],
    );

    if (!result.rows[0]) {
      throw this.invalidCredentials();
    }

    return {
      changed: true,
      passwordChangeRequired: false,
    };
  }

  async logout(principal: AuthenticatedDriverContext) {
    await this.databaseService.query(
      `
        update public.delivery_driver_credentials
        set
          status = 'REVOKED',
          revoked_at = coalesce(revoked_at, now()),
          updated_at = now()
        where tenant_id = $1::uuid
          and id = $2::uuid
          and status = 'ACTIVE'
      `,
      [principal.tenantId, principal.credentialId],
    );

    return { loggedOut: true };
  }

  private requireCode(value: unknown, field: string): string {
    if (typeof value !== 'string') {
      throw new BadRequestException(`${field} is required`);
    }

    const normalized = value.trim().toUpperCase();

    if (!/^[A-Z0-9_-]{2,50}$/.test(normalized)) {
      throw new BadRequestException(`${field} is invalid`);
    }

    return normalized;
  }

  private requirePassword(value: unknown): string {
    if (typeof value !== 'string' || value.length < 8 || value.length > 200) {
      throw new BadRequestException('password is invalid');
    }

    return value;
  }

  private requirePersonalPassword(value: unknown): string {
    if (typeof value !== 'string' || value.length < 10 || value.length > 128) {
      throw new BadRequestException(
        'newPassword must contain between 10 and 128 characters',
      );
    }

    if (!/[A-Za-z]/.test(value) || !/\d/.test(value)) {
      throw new BadRequestException(
        'newPassword must contain at least one letter and one number',
      );
    }

    return value;
  }

  private hashPassword(password: string): string {
    const salt = randomBytes(16);
    const derived = scryptSync(password, salt, 64);

    return `scrypt$${salt.toString('base64url')}$${derived.toString('base64url')}`;
  }

  private verifyPassword(password: string, encoded: string): boolean {
    const [algorithm, saltEncoded, hashEncoded] = encoded.split('$');

    if (algorithm !== 'scrypt' || !saltEncoded || !hashEncoded) {
      return false;
    }

    try {
      const salt = Buffer.from(saltEncoded, 'base64url');
      const expected = Buffer.from(hashEncoded, 'base64url');
      const actual = scryptSync(password, salt, expected.length);

      return (
        expected.length === actual.length && timingSafeEqual(expected, actual)
      );
    } catch {
      return false;
    }
  }

  private hashToken(token: string): string {
    return createHash('sha256').update(token, 'utf8').digest('hex');
  }

  private invalidCredentials(): UnauthorizedException {
    return new UnauthorizedException('Invalid driver credentials');
  }
}
