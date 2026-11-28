import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  createHash,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from 'node:crypto';

import { DatabaseService } from '../database/database.service';
import { StaffRole, StaffSessionPrincipal } from './staff.types';

const SESSION_COOKIE_NAME = 'flash_staff_session';
const SESSION_DURATION_MS = 8 * 60 * 60 * 1000;

interface StaffUserRow {
  id: string;
  tenant_id: string;
  branch_id: string;
  tenant_code: string;
  branch_code: string;
  user_code: string;
  first_name: string;
  last_name: string;
  identity_document: string | null;
  phone: string | null;
  email: string | null;
  password_hash: string;
  password_change_required: boolean;
  user_status: 'ACTIVE' | 'INACTIVE';
  branch_user_status: 'ACTIVE' | 'INACTIVE';
  role: StaffRole;
}

interface StaffListRow {
  id: string;
  user_code: string;
  first_name: string;
  last_name: string;
  identity_document: string | null;
  phone: string | null;
  email: string | null;
  role: StaffRole;
  status: 'ACTIVE' | 'INACTIVE';
  created_at: string | Date;
  last_login_at: string | Date | null;
  password_change_required: boolean;
}

interface CreateStaffInput {
  firstName?: string;
  lastName?: string;
  identityDocument?: string;
  phone?: string;
  email?: string;
  role?: string;
}

interface BootstrapAdminInput {
  tenantCode?: string;
  branchCode?: string;
  firstName?: string;
  lastName?: string;
  identityDocument?: string;
  phone?: string;
  email?: string;
  opsAccessKey?: string;
}

interface LoginInput {
  tenantCode?: string;
  branchCode?: string;
  userCode?: string;
  password?: string;
}

interface RecoverAdminInput {
  tenantCode?: string;
  branchCode?: string;
  userCode?: string;
  opsAccessKey?: string;
}

@Injectable()
export class StaffService {
  constructor(
    private readonly databaseService: DatabaseService,
    private readonly configService: ConfigService,
  ) {}

  async getBootstrapStatus(tenantCode?: string, branchCode?: string) {
    const tenant = this.requireCode(tenantCode, 'tenantCode');
    const branch = this.requireCode(branchCode, 'branchCode');

    const result = await this.databaseService.query<{ user_count: string }>(
      `
        select count(*)::text as user_count
        from public.staff_users u
        inner join public.staff_user_branches ub
          on ub.tenant_id = u.tenant_id
         and ub.user_id = u.id
        inner join public.tenants t
          on t.id = u.tenant_id
        inner join public.branches b
          on b.tenant_id = ub.tenant_id
         and b.id = ub.branch_id
        where upper(t.code) = $1
          and upper(b.code) = $2
      `,
      [tenant, branch],
    );

    return {
      tenantCode: tenant,
      branchCode: branch,
      bootstrapRequired: Number(result.rows[0]?.user_count ?? '0') === 0,
    };
  }

  async bootstrapAdmin(input: BootstrapAdminInput) {
    this.assertOpsBootstrapKey(input.opsAccessKey);

    const tenantCode = this.requireCode(input.tenantCode, 'tenantCode');
    const branchCode = this.requireCode(input.branchCode, 'branchCode');

    const existing = await this.getBootstrapStatus(tenantCode, branchCode);

    if (!existing.bootstrapRequired) {
      throw new ConflictException(
        'Staff administration has already been initialized for this branch',
      );
    }

    return this.createStaffUserInternal({
      tenantCode,
      branchCode,
      firstName: input.firstName,
      lastName: input.lastName,
      identityDocument: input.identityDocument,
      phone: input.phone,
      email: input.email,
      role: 'ADMIN',
      createdByUserId: null,
    });
  }

  async login(input: LoginInput) {
    const tenantCode = this.requireCode(input.tenantCode, 'tenantCode');
    const branchCode = this.requireCode(input.branchCode, 'branchCode');
    const userCode = this.requireUserCode(input.userCode);
    const password = this.requirePassword(input.password);

    const result = await this.databaseService.query<StaffUserRow>(
      `
        select
          u.id::text,
          u.tenant_id::text,
          ub.branch_id::text,
          upper(t.code) as tenant_code,
          upper(b.code) as branch_code,
          u.user_code,
          u.first_name,
          u.last_name,
          u.identity_document,
          u.phone,
          u.email,
          u.password_hash,
          u.password_change_required,
          u.status as user_status,
          ub.status as branch_user_status,
          ub.role
        from public.staff_users u
        inner join public.staff_user_branches ub
          on ub.tenant_id = u.tenant_id
         and ub.user_id = u.id
        inner join public.tenants t
          on t.id = u.tenant_id
        inner join public.branches b
          on b.tenant_id = ub.tenant_id
         and b.id = ub.branch_id
        where upper(t.code) = $1
          and upper(b.code) = $2
          and upper(u.user_code) = $3
          and t.status = 'ACTIVE'
          and b.status = 'ACTIVE'
        limit 1
      `,
      [tenantCode, branchCode, userCode],
    );

    const user = result.rows[0];

    if (
      !user ||
      user.user_status !== 'ACTIVE' ||
      user.branch_user_status !== 'ACTIVE' ||
      !this.verifyPassword(password, user.password_hash)
    ) {
      throw new UnauthorizedException('Invalid staff credentials');
    }

    const rawToken = randomBytes(32).toString('base64url');
    const tokenHash = this.hashToken(rawToken);
    const expiresAt = new Date(Date.now() + SESSION_DURATION_MS);

    const sessionResult = await this.databaseService.query<{ id: string }>(
      `
        insert into public.staff_sessions (
          tenant_id,
          branch_id,
          user_id,
          token_hash,
          expires_at
        )
        values (
          $1::uuid,
          $2::uuid,
          $3::uuid,
          $4,
          $5::timestamptz
        )
        returning id::text
      `,
      [
        user.tenant_id,
        user.branch_id,
        user.id,
        tokenHash,
        expiresAt.toISOString(),
      ],
    );

    await this.databaseService.query(
      `
        update public.staff_users
        set last_login_at = now()
        where tenant_id = $1::uuid
          and id = $2::uuid
      `,
      [user.tenant_id, user.id],
    );

    return {
      token: rawToken,
      principal: this.mapPrincipal({
        ...user,
        session_id: sessionResult.rows[0].id,
        expires_at: expiresAt,
      }),
    };
  }

  async logout(sessionId: string) {
    await this.databaseService.query(
      `
        update public.staff_sessions
        set revoked_at = coalesce(revoked_at, now())
        where id = $1::uuid
      `,
      [sessionId],
    );

    return { loggedOut: true };
  }

  async resolveSession(token: string): Promise<StaffSessionPrincipal | null> {
    if (!token || token.length < 32 || token.length > 256) {
      return null;
    }

    const tokenHash = this.hashToken(token);

    const result = await this.databaseService.query<
      StaffUserRow & {
        session_id: string;
        expires_at: string | Date;
      }
    >(
      `
        select
          s.id::text as session_id,
          s.expires_at,
          u.id::text,
          u.tenant_id::text,
          ub.branch_id::text,
          upper(t.code) as tenant_code,
          upper(b.code) as branch_code,
          u.user_code,
          u.first_name,
          u.last_name,
          u.identity_document,
          u.phone,
          u.email,
          u.password_hash,
          u.password_change_required,
          u.status as user_status,
          ub.status as branch_user_status,
          ub.role
        from public.staff_sessions s
        inner join public.staff_users u
          on u.tenant_id = s.tenant_id
         and u.id = s.user_id
        inner join public.staff_user_branches ub
          on ub.tenant_id = s.tenant_id
         and ub.branch_id = s.branch_id
         and ub.user_id = s.user_id
        inner join public.tenants t
          on t.id = s.tenant_id
        inner join public.branches b
          on b.tenant_id = s.tenant_id
         and b.id = s.branch_id
        where s.token_hash = $1
          and s.revoked_at is null
          and s.expires_at > now()
          and u.status = 'ACTIVE'
          and ub.status = 'ACTIVE'
          -- A suspended or inactive business (or branch) ends its staff sessions immediately.
          and t.status = 'ACTIVE'
          and b.status = 'ACTIVE'
        limit 1
      `,
      [tokenHash],
    );

    const row = result.rows[0];

    return row ? this.mapPrincipal(row) : null;
  }

  readSessionToken(
    headers: Record<string, string | string[] | undefined>,
  ): string | null {
    const authorizationHeader = headers.authorization;
    const authorization = Array.isArray(authorizationHeader)
      ? authorizationHeader[0]
      : authorizationHeader;

    if (authorization?.startsWith('Bearer ')) {
      const bearer = authorization.slice('Bearer '.length).trim();

      if (bearer) {
        return bearer;
      }
    }

    const cookieHeader = headers.cookie;
    const cookieText = Array.isArray(cookieHeader)
      ? cookieHeader[0]
      : cookieHeader || '';

    for (const pair of cookieText.split(';')) {
      const separator = pair.indexOf('=');

      if (separator < 1) {
        continue;
      }

      const name = pair.slice(0, separator).trim();

      if (name !== SESSION_COOKIE_NAME) {
        continue;
      }

      const value = pair.slice(separator + 1).trim();

      return value ? decodeURIComponent(value) : null;
    }

    return null;
  }

  getSessionCookieName(): string {
    return SESSION_COOKIE_NAME;
  }

  getSessionDurationMs(): number {
    return SESSION_DURATION_MS;
  }

  async changePassword(principal: StaffSessionPrincipal, rawPassword?: string) {
    const password = this.requirePersonalPassword(rawPassword);
    const passwordHash = this.hashPassword(password);

    await this.databaseService.withTransaction(async (client) => {
      const updated = await client.query<{ id: string }>(
        `
          update public.staff_users
          set
            password_hash = $3,
            password_change_required = false,
            password_changed_at = now(),
            updated_at = now()
          where tenant_id = $1::uuid
            and id = $2::uuid
          returning id::text
        `,
        [principal.tenantId, principal.userId, passwordHash],
      );

      if (!updated.rows[0]) {
        throw new NotFoundException('Staff user not found');
      }

      await client.query(
        `
          update public.staff_sessions
          set revoked_at = coalesce(revoked_at, now())
          where tenant_id = $1::uuid
            and branch_id = $2::uuid
            and user_id = $3::uuid
            and id <> $4::uuid
            and revoked_at is null
        `,
        [
          principal.tenantId,
          principal.branchId,
          principal.userId,
          principal.sessionId,
        ],
      );
    });

    return {
      changed: true,
      user: {
        ...principal,
        passwordChangeRequired: false,
      },
    };
  }

  async recoverAdminAccess(input: RecoverAdminInput) {
    this.assertOpsBootstrapKey(input.opsAccessKey);

    const tenantCode = this.requireCode(input.tenantCode, 'tenantCode');
    const branchCode = this.requireCode(input.branchCode, 'branchCode');
    const userCode = this.requireUserCode(input.userCode);
    const temporaryPassword = this.generateTemporaryPassword();
    const passwordHash = this.hashPassword(temporaryPassword);

    const recovered = await this.databaseService.withTransaction(
      async (client) => {
        const userResult = await client.query<{
          id: string;
          user_code: string;
          first_name: string;
          last_name: string;
          tenant_id: string;
          branch_id: string;
        }>(
          `
            select
              u.id::text,
              u.user_code,
              u.first_name,
              u.last_name,
              u.tenant_id::text,
              ub.branch_id::text
            from public.staff_users u
            inner join public.staff_user_branches ub
              on ub.tenant_id = u.tenant_id
             and ub.user_id = u.id
            inner join public.tenants t
              on t.id = u.tenant_id
            inner join public.branches b
              on b.tenant_id = ub.tenant_id
             and b.id = ub.branch_id
            where upper(t.code) = $1
              and upper(b.code) = $2
              and upper(u.user_code) = $3
              and u.status = 'ACTIVE'
              and ub.status = 'ACTIVE'
              and ub.role = 'ADMIN'
            limit 1
            for update of u
          `,
          [tenantCode, branchCode, userCode],
        );

        const user = userResult.rows[0];

        if (!user) {
          throw new NotFoundException('Active administrator not found');
        }

        await client.query(
          `
            update public.staff_users
            set
              password_hash = $3,
              password_change_required = true,
              password_changed_at = null,
              updated_at = now()
            where tenant_id = $1::uuid
              and id = $2::uuid
          `,
          [user.tenant_id, user.id, passwordHash],
        );

        await client.query(
          `
            update public.staff_sessions
            set revoked_at = coalesce(revoked_at, now())
            where tenant_id = $1::uuid
              and branch_id = $2::uuid
              and user_id = $3::uuid
              and revoked_at is null
          `,
          [user.tenant_id, user.branch_id, user.id],
        );

        return user;
      },
    );

    return {
      user: {
        userCode: recovered.user_code,
        displayName: `${recovered.first_name} ${recovered.last_name}`.trim(),
      },
      credentials: {
        userCode: recovered.user_code,
        temporaryPassword,
      },
    };
  }

  async listBranchUsers(principal: StaffSessionPrincipal) {
    const result = await this.databaseService.query<StaffListRow>(
      `
        select
          u.id::text,
          u.user_code,
          u.first_name,
          u.last_name,
          u.identity_document,
          u.phone,
          u.email,
          ub.role,
          case
            when u.status = 'ACTIVE' and ub.status = 'ACTIVE'
              then 'ACTIVE'
            else 'INACTIVE'
          end as status,
          u.created_at,
          u.last_login_at,
          u.password_change_required
        from public.staff_users u
        inner join public.staff_user_branches ub
          on ub.tenant_id = u.tenant_id
         and ub.user_id = u.id
        where u.tenant_id = $1::uuid
          and ub.branch_id = $2::uuid
        order by
          case ub.role
            when 'ADMIN' then 1
            when 'MANAGER' then 2
            when 'CASHIER' then 3
            when 'KITCHEN' then 4
            when 'WAITER' then 5
            else 9
          end,
          u.first_name,
          u.last_name,
          u.user_code
      `,
      [principal.tenantId, principal.branchId],
    );

    return {
      tenantCode: principal.tenantCode,
      branchCode: principal.branchCode,
      users: result.rows.map((row) => this.mapStaffListRow(row)),
    };
  }

  async createBranchUser(
    principal: StaffSessionPrincipal,
    input: CreateStaffInput,
  ) {
    return this.createStaffUserInternal({
      tenantCode: principal.tenantCode,
      branchCode: principal.branchCode,
      firstName: input.firstName,
      lastName: input.lastName,
      identityDocument: input.identityDocument,
      phone: input.phone,
      email: input.email,
      role: this.requireRole(input.role),
      createdByUserId: principal.userId,
    });
  }

  async resetCredentials(principal: StaffSessionPrincipal, userId: string) {
    const temporaryPassword = this.generateTemporaryPassword();
    const passwordHash = this.hashPassword(temporaryPassword);

    const result = await this.databaseService.withTransaction(
      async (client) => {
        const updated = await client.query<{
          user_code: string;
          first_name: string;
          last_name: string;
        }>(
          `
          update public.staff_users u
          set
            password_hash = $4,
            password_change_required = true,
            password_changed_at = null,
            updated_at = now()
          where u.tenant_id = $1::uuid
            and u.id = $2::uuid
            and exists (
              select 1
              from public.staff_user_branches ub
              where ub.tenant_id = u.tenant_id
                and ub.branch_id = $3::uuid
                and ub.user_id = u.id
            )
          returning
            u.user_code,
            u.first_name,
            u.last_name
        `,
          [principal.tenantId, userId, principal.branchId, passwordHash],
        );

        const user = updated.rows[0];

        if (!user) {
          throw new NotFoundException('Staff user not found in this branch');
        }

        await client.query(
          `
          update public.staff_sessions
          set revoked_at = coalesce(revoked_at, now())
          where tenant_id = $1::uuid
            and branch_id = $2::uuid
            and user_id = $3::uuid
            and revoked_at is null
        `,
          [principal.tenantId, principal.branchId, userId],
        );

        return user;
      },
    );

    return {
      user: {
        id: userId,
        userCode: result.user_code,
        displayName: `${result.first_name} ${result.last_name}`.trim(),
      },
      credentials: {
        userCode: result.user_code,
        temporaryPassword,
      },
    };
  }

  async setUserStatus(
    principal: StaffSessionPrincipal,
    userId: string,
    rawStatus?: string,
  ) {
    const status = (rawStatus || '').trim().toUpperCase();

    if (status !== 'ACTIVE' && status !== 'INACTIVE') {
      throw new BadRequestException('status must be ACTIVE or INACTIVE');
    }

    if (userId === principal.userId && status === 'INACTIVE') {
      throw new ConflictException('You cannot deactivate your own user');
    }

    return this.databaseService.withTransaction(async (client) => {
      const updated = await client.query<{
        id: string;
        user_code: string;
        first_name: string;
        last_name: string;
      }>(
        `
          update public.staff_users u
          set status = $4
          where u.tenant_id = $1::uuid
            and u.id = $2::uuid
            and exists (
              select 1
              from public.staff_user_branches ub
              where ub.tenant_id = u.tenant_id
                and ub.branch_id = $3::uuid
                and ub.user_id = u.id
            )
          returning
            u.id::text,
            u.user_code,
            u.first_name,
            u.last_name
        `,
        [principal.tenantId, userId, principal.branchId, status],
      );

      const user = updated.rows[0];

      if (!user) {
        throw new NotFoundException('Staff user not found in this branch');
      }

      await client.query(
        `
          update public.staff_user_branches
          set status = $4
          where tenant_id = $1::uuid
            and branch_id = $2::uuid
            and user_id = $3::uuid
        `,
        [principal.tenantId, principal.branchId, userId, status],
      );

      if (status === 'INACTIVE') {
        await client.query(
          `
            update public.staff_sessions
            set revoked_at = coalesce(revoked_at, now())
            where tenant_id = $1::uuid
              and branch_id = $2::uuid
              and user_id = $3::uuid
              and revoked_at is null
          `,
          [principal.tenantId, principal.branchId, userId],
        );
      }

      return {
        changed: true,
        user: {
          id: user.id,
          userCode: user.user_code,
          displayName: `${user.first_name} ${user.last_name}`.trim(),
          status,
        },
      };
    });
  }

  /**
   * First ADMIN of a branch created from the platform console (R4a). Same rules as bootstrapAdmin
   * (only while the branch has no staff), but authorized by the platform session instead of the ops key.
   */
  async createInitialAdminForPlatform(
    input: Omit<BootstrapAdminInput, 'opsAccessKey'>,
  ) {
    const tenantCode = this.requireCode(input.tenantCode, 'tenantCode');
    const branchCode = this.requireCode(input.branchCode, 'branchCode');
    const existing = await this.getBootstrapStatus(tenantCode, branchCode);
    if (!existing.bootstrapRequired)
      throw new ConflictException(
        'Staff administration has already been initialized for this branch',
      );
    return this.createStaffUserInternal({
      tenantCode,
      branchCode,
      firstName: input.firstName,
      lastName: input.lastName,
      identityDocument: input.identityDocument,
      phone: input.phone,
      email: input.email,
      role: 'ADMIN',
      createdByUserId: null,
    });
  }

  private async createStaffUserInternal(input: {
    tenantCode: string;
    branchCode: string;
    firstName?: string;
    lastName?: string;
    identityDocument?: string;
    phone?: string;
    email?: string;
    role: StaffRole;
    createdByUserId: string | null;
  }) {
    const firstName = this.requireText(input.firstName, 'firstName', 80);
    const lastName = this.requireText(input.lastName, 'lastName', 80);
    const identityDocument = this.optionalText(
      input.identityDocument,
      'identityDocument',
      40,
    );
    const phone = this.optionalText(input.phone, 'phone', 40);
    const email = this.optionalEmail(input.email);
    const temporaryPassword = this.generateTemporaryPassword();
    const passwordHash = this.hashPassword(temporaryPassword);

    for (let attempt = 0; attempt < 8; attempt += 1) {
      const userCode = this.generateUserCode(input.role);

      try {
        const created = await this.databaseService.withTransaction(
          async (client) => {
            const scopeResult = await client.query<{
              tenant_id: string;
              branch_id: string;
            }>(
              `
                select
                  t.id::text as tenant_id,
                  b.id::text as branch_id
                from public.tenants t
                inner join public.branches b
                  on b.tenant_id = t.id
                where upper(t.code) = $1
                  and upper(b.code) = $2
                  and t.status = 'ACTIVE'
                  and b.status = 'ACTIVE'
                limit 1
              `,
              [input.tenantCode, input.branchCode],
            );

            const scope = scopeResult.rows[0];

            if (!scope) {
              throw new NotFoundException('Tenant or branch not found');
            }

            const userResult = await client.query<{
              id: string;
              created_at: string | Date;
            }>(
              `
                insert into public.staff_users (
                  tenant_id,
                  user_code,
                  first_name,
                  last_name,
                  identity_document,
                  phone,
                  email,
                  password_hash,
                  created_by_user_id
                )
                values (
                  $1::uuid,
                  $2,
                  $3,
                  $4,
                  $5,
                  $6,
                  $7,
                  $8,
                  $9::uuid
                )
                returning
                  id::text,
                  created_at
              `,
              [
                scope.tenant_id,
                userCode,
                firstName,
                lastName,
                identityDocument,
                phone,
                email,
                passwordHash,
                input.createdByUserId,
              ],
            );

            const user = userResult.rows[0];

            await client.query(
              `
                insert into public.staff_user_branches (
                  tenant_id,
                  branch_id,
                  user_id,
                  role
                )
                values (
                  $1::uuid,
                  $2::uuid,
                  $3::uuid,
                  $4
                )
              `,
              [scope.tenant_id, scope.branch_id, user.id, input.role],
            );

            return {
              id: user.id,
              createdAt: user.created_at,
            };
          },
        );

        return {
          user: {
            id: created.id,
            userCode,
            firstName,
            lastName,
            displayName: `${firstName} ${lastName}`.trim(),
            identityDocument,
            phone,
            email,
            role: input.role,
            status: 'ACTIVE' as const,
            passwordChangeRequired: true,
            createdAt: created.createdAt,
          },
          credentials: {
            userCode,
            temporaryPassword,
          },
        };
      } catch (error) {
        if (this.isUniqueViolation(error)) {
          continue;
        }

        throw error;
      }
    }

    throw new ServiceUnavailableException(
      'Could not allocate a staff user code',
    );
  }

  private mapPrincipal(
    row: StaffUserRow & {
      session_id: string;
      expires_at: string | Date;
    },
  ): StaffSessionPrincipal {
    return {
      sessionId: row.session_id,
      userId: row.id,
      tenantId: row.tenant_id,
      tenantCode: row.tenant_code,
      branchId: row.branch_id,
      branchCode: row.branch_code,
      userCode: row.user_code,
      firstName: row.first_name,
      lastName: row.last_name,
      displayName: `${row.first_name} ${row.last_name}`.trim(),
      role: row.role,
      passwordChangeRequired: row.password_change_required,
      expiresAt: new Date(row.expires_at).toISOString(),
    };
  }

  private mapStaffListRow(row: StaffListRow) {
    return {
      id: row.id,
      userCode: row.user_code,
      firstName: row.first_name,
      lastName: row.last_name,
      displayName: `${row.first_name} ${row.last_name}`.trim(),
      identityDocument: row.identity_document,
      phone: row.phone,
      email: row.email,
      role: row.role,
      status: row.status,
      createdAt: new Date(row.created_at).toISOString(),
      lastLoginAt: row.last_login_at
        ? new Date(row.last_login_at).toISOString()
        : null,
      passwordChangeRequired: row.password_change_required,
    };
  }

  private assertOpsBootstrapKey(receivedValue?: string) {
    const configured =
      this.configService.get<string>('OPS_ACCESS_KEY')?.trim() || '';

    if (configured.length < 48) {
      throw new ServiceUnavailableException(
        'Operations bootstrap access is not configured',
      );
    }

    const received = (receivedValue || '').trim();
    const configuredBuffer = Buffer.from(configured, 'utf8');
    const receivedBuffer = Buffer.from(received, 'utf8');

    const valid =
      configuredBuffer.length === receivedBuffer.length &&
      timingSafeEqual(configuredBuffer, receivedBuffer);

    if (!valid) {
      throw new UnauthorizedException(
        'Invalid operations bootstrap credentials',
      );
    }
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

  private requireUserCode(value: unknown): string {
    if (typeof value !== 'string') {
      throw new BadRequestException('userCode is required');
    }

    const normalized = value.trim().toUpperCase();

    if (!/^[A-Z]{3}-[A-Z0-9]{6}$/.test(normalized)) {
      throw new BadRequestException('userCode is invalid');
    }

    return normalized;
  }

  private requirePassword(value: unknown): string {
    if (typeof value !== 'string' || value.length < 8 || value.length > 200) {
      throw new BadRequestException('password is invalid');
    }

    return value;
  }

  private requireRole(value: unknown): StaffRole {
    const normalized =
      typeof value === 'string' ? value.trim().toUpperCase() : '';

    if (
      normalized !== 'ADMIN' &&
      normalized !== 'MANAGER' &&
      normalized !== 'CASHIER' &&
      normalized !== 'KITCHEN' &&
      normalized !== 'WAITER'
    ) {
      throw new BadRequestException('role is invalid');
    }

    return normalized;
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

  private requireText(
    value: unknown,
    field: string,
    maxLength: number,
  ): string {
    if (typeof value !== 'string') {
      throw new BadRequestException(`${field} is required`);
    }

    const normalized = value.trim().replace(/\s+/g, ' ');

    if (!normalized || normalized.length > maxLength) {
      throw new BadRequestException(`${field} is invalid`);
    }

    return normalized;
  }

  private optionalText(
    value: unknown,
    field: string,
    maxLength: number,
  ): string | null {
    if (value == null || value === '') {
      return null;
    }

    if (typeof value !== 'string') {
      throw new BadRequestException(`${field} is invalid`);
    }

    const normalized = value.trim().replace(/\s+/g, ' ');

    if (!normalized || normalized.length > maxLength) {
      throw new BadRequestException(`${field} is invalid`);
    }

    return normalized;
  }

  private optionalEmail(value: unknown): string | null {
    if (value == null || value === '') {
      return null;
    }

    if (typeof value !== 'string') {
      throw new BadRequestException('email is invalid');
    }

    const normalized = value.trim().toLowerCase();

    if (
      normalized.length > 160 ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)
    ) {
      throw new BadRequestException('email is invalid');
    }

    return normalized;
  }

  private generateUserCode(role: StaffRole): string {
    const prefix: Record<StaffRole, string> = {
      ADMIN: 'ADM',
      MANAGER: 'GER',
      CASHIER: 'CAJ',
      KITCHEN: 'COC',
      WAITER: 'MES',
    };

    const suffix = randomBytes(3).toString('hex').toUpperCase();

    return `${prefix[role]}-${suffix}`;
  }

  private generateTemporaryPassword(): string {
    return randomBytes(12).toString('base64url');
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
    return createHash('sha256').update(token).digest('hex');
  }

  private isUniqueViolation(error: unknown): boolean {
    return Boolean(
      error &&
      typeof error === 'object' &&
      'code' in error &&
      (error as { code?: string }).code === '23505',
    );
  }
}
