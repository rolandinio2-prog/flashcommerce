import {
  recoveryPhone,
  recoveryPhoneAliases,
  sameRecoveryPhone,
  RECOVERY_PAGE_SIZE,
  RECOVERY_UUID,
} from './recovery-access';
import {
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import {
  createHash,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from 'node:crypto';
import { DatabaseService } from '../database/database.service';
import {
  type CustomerRecoveryEnrollInput,
  type CustomerRecoveryLoginInput,
} from './order.types';

@Injectable()
export class CustomerRecoveryService {
  constructor(private readonly databaseService: DatabaseService) {}

  // =========================================================
  // CUSTOMER ORDER RECOVERY V1
  // =========================================================

  private readonly customerRecoveryCookieName = 'flash_customer_session';

  private readonly customerRecoverySessionMaxAgeMs = 30 * 24 * 60 * 60 * 1000;

  getCustomerRecoverySessionCookieName(): string {
    return this.customerRecoveryCookieName;
  }

  getCustomerRecoverySessionMaxAgeMs(): number {
    return this.customerRecoverySessionMaxAgeMs;
  }

  extractCustomerRecoverySessionToken(cookieHeader?: string): string | null {
    const cookieText = cookieHeader || '';

    for (const pair of cookieText.split(';')) {
      const separator = pair.indexOf('=');

      if (separator <= 0) {
        continue;
      }

      const name = pair.slice(0, separator).trim();

      if (name !== this.customerRecoveryCookieName) {
        continue;
      }

      const value = pair.slice(separator + 1).trim();

      return value || null;
    }

    return null;
  }

  async enrollCustomerRecovery(input: CustomerRecoveryEnrollInput) {
    const trackingToken = input.trackingToken?.trim() || '';

    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        trackingToken,
      )
    ) {
      throw new BadRequestException('trackingToken must be a valid UUID');
    }

    const phoneNormalized = this.normalizeCustomerRecoveryPhone(input.phone);

    const pin = this.normalizeCustomerRecoveryPin(input.pin);

    const orderResult = await this.databaseService.query<{
      tenant_id: string;
      tenant_code: string;
      order_group_id: string;
      customer_account_id: string | null;
      customer_phone: string | null;
    }>(
      `
          select
            o.tenant_id::text,
            t.code as tenant_code,
            o.order_group_id::text,
            o.customer_account_id::text,
            o.customer_phone

          from public.orders o

          inner join public.tenants t
            on t.id = o.tenant_id

          where o.tracking_token = $1::uuid

          limit 1
        `,
      [trackingToken],
    );

    const order = orderResult.rows[0];

    if (!order) {
      throw new NotFoundException('Order not found');
    }

    if (!sameRecoveryPhone(order.customer_phone, phoneNormalized)) {
      throw new BadRequestException(
        'Usa el telefono de contacto de este pedido para activar su recuperacion',
      );
    }

    let account = await this.findCustomerRecoveryAccount(
      order.tenant_id,
      phoneNormalized,
    );

    if (account) {
      await this.assertCustomerRecoveryPin(account, pin);
    } else {
      const created = await this.databaseService.query<{
        id: string;
        tenant_id: string;
        pin_hash: string;
        failed_attempts: number;
        locked_until: string | Date | null;
      }>(
        `
            insert into public.customer_accounts (
              tenant_id,
              phone_normalized,
              pin_hash
            )
            values (
              $1::uuid,
              $2,
              $3
            )
            on conflict (
              tenant_id,
              phone_normalized
            )
            do nothing
            returning
              id::text,
              tenant_id::text,
              pin_hash,
              failed_attempts,
              locked_until
          `,
        [order.tenant_id, phoneNormalized, this.hashCustomerRecoveryPin(pin)],
      );

      account = created.rows[0] ?? null;

      if (!account) {
        account = await this.findCustomerRecoveryAccount(
          order.tenant_id,
          phoneNormalized,
        );

        if (!account) {
          throw new ConflictException(
            'Customer recovery account could not be created',
          );
        }

        await this.assertCustomerRecoveryPin(account, pin);
      }
    }

    if (order.customer_account_id && order.customer_account_id !== account.id) {
      throw new ConflictException(
        'Order is already linked to another recovery account',
      );
    }

    const linked = await this.databaseService.query(
      `update public.orders set customer_account_id=$3::uuid, updated_at=now()
       where tenant_id=$1::uuid and tracking_token=$2::uuid
         and (customer_account_id is null or customer_account_id=$3::uuid)
       returning id`,
      [order.tenant_id, trackingToken, account.id],
    );
    if (linked.rows.length !== 1)
      throw new ConflictException(
        'Order is already linked to another recovery account',
      );

    const sessionToken = await this.createCustomerRecoverySession(
      order.tenant_id,
      account.id,
    );

    const recoveredResult = await this.databaseService.query<{
      count: string;
    }>(
      `
          select count(*)::text as count
          from public.orders
          where tenant_id = $1::uuid
            and customer_account_id = $2::uuid
        `,
      [order.tenant_id, account.id],
    );

    return {
      sessionToken,
      tenantCode: order.tenant_code,
      recoveredOrderCount: Number(recoveredResult.rows[0]?.count ?? 0),
    };
  }

  async getCustomerRecoveryProfile(
    cookieHeader: string | undefined,
    tenantCode: string,
  ) {
    const raw = this.extractCustomerRecoverySessionToken(cookieHeader);
    const session = raw
      ? await this.findCustomerRecoverySessionByToken(raw)
      : null;
    if (!session || session.tenant_code !== tenantCode)
      throw new UnauthorizedException('Recovery session required');
    const result = await this.databaseService.query<{
      full_name: string | null;
    }>(
      'select full_name from public.customer_accounts where id=$1::uuid and tenant_id=$2::uuid',
      [session.customer_account_id, session.tenant_id],
    );
    return {
      fullName: result.rows[0]?.full_name ?? '',
      phone: recoveryPhone(session.phone_normalized),
      tenantCode,
    };
  }

  async registerCustomerRecovery(
    input: CustomerRecoveryLoginInput & { fullName?: string },
    cookieHeader?: string,
  ) {
    const tenantCode =
      typeof input.tenantCode === 'string' ? input.tenantCode.trim() : '';
    const fullName =
      typeof input.fullName === 'string'
        ? input.fullName.trim().replace(/\s+/g, ' ')
        : '';
    if (fullName.length < 2 || fullName.length > 120)
      throw new BadRequestException(
        'Enter a full name between 2 and 120 characters',
      );
    const phone = this.normalizeCustomerRecoveryPhone(input.phone);
    const tenant = (
      await this.databaseService.query<{ id: string; code: string }>(
        'select id::text,code from public.tenants where code=$1 limit 1',
        [tenantCode],
      )
    ).rows[0];
    if (!tenant)
      throw new UnauthorizedException('Invalid recovery credentials');
    const raw = this.extractCustomerRecoverySessionToken(cookieHeader);
    const session = raw
      ? await this.findCustomerRecoverySessionByToken(raw)
      : null;
    let account = await this.findCustomerRecoveryAccount(tenant.id, phone);
    const authenticated = Boolean(
      account &&
      session &&
      session.tenant_id === tenant.id &&
      session.customer_account_id === account.id &&
      sameRecoveryPhone(phone, session.phone_normalized),
    );
    if (!authenticated) {
      if (!input.pin)
        throw new UnauthorizedException('Recovery credentials required');
      const pin = this.normalizeCustomerRecoveryPin(input.pin);
      if (!account) {
        // Never claim historical orders by phone or replace a disabled/legacy account.
        await this.databaseService.query(
          `insert into public.customer_accounts (tenant_id,phone_normalized,pin_hash,full_name)
          select $1::uuid,$2,$3,$4 where not exists (
            select 1 from public.customer_accounts where tenant_id=$1::uuid and phone_normalized=any($5::text[]))
          on conflict (tenant_id,phone_normalized) do nothing`,
          [
            tenant.id,
            phone,
            this.hashCustomerRecoveryPin(pin),
            fullName,
            recoveryPhoneAliases(phone),
          ],
        );
        account = await this.findCustomerRecoveryAccount(tenant.id, phone);
      }
      if (!account) {
        this.performDummyCustomerRecoveryPinWork(pin);
        throw new UnauthorizedException('Invalid recovery credentials');
      }
      await this.assertCustomerRecoveryPin(account, pin);
    }
    if (!account)
      throw new UnauthorizedException('Invalid recovery credentials');
    // Registration authenticates existing accounts but never renames them.
    // An explicit, session-bound and PIN-verified action updates the name.
    const sessionToken = authenticated
      ? raw!
      : await this.createCustomerRecoverySession(tenant.id, account.id);
    return { sessionToken, tenantCode, fullName, phone };
  }

  async updateCustomerRecoveryName(
    input: CustomerRecoveryLoginInput & { fullName?: string },
    cookieHeader?: string,
  ) {
    const tenantCode =
      typeof input.tenantCode === 'string' ? input.tenantCode.trim() : '';
    const raw = this.extractCustomerRecoverySessionToken(cookieHeader);
    const session = raw
      ? await this.findCustomerRecoverySessionByToken(raw)
      : null;
    const phone = this.normalizeCustomerRecoveryPhone(input.phone);
    if (
      !session ||
      session.tenant_code !== tenantCode ||
      !sameRecoveryPhone(phone, session.phone_normalized)
    )
      throw new UnauthorizedException('Invalid recovery credentials');
    const fullName =
      typeof input.fullName === 'string'
        ? input.fullName.trim().replace(/\s+/g, ' ')
        : '';
    if (fullName.length < 2 || fullName.length > 120)
      throw new BadRequestException(
        'Enter a full name between 2 and 120 characters',
      );
    const pin = this.normalizeCustomerRecoveryPin(input.pin);
    const account = await this.findCustomerRecoveryAccount(
      session.tenant_id,
      phone,
    );
    if (!account || account.id !== session.customer_account_id)
      throw new UnauthorizedException('Invalid recovery credentials');
    await this.assertCustomerRecoveryPin(account, pin);
    // Recheck session validity at the write, including revocation during the request.
    const changed = await this.databaseService.query(
      `update public.customer_accounts a set full_name=$1, updated_at=now()
       where a.id=$2::uuid and a.tenant_id=$3::uuid and a.status='ACTIVE'
       and exists(select 1 from public.customer_sessions s where s.customer_account_id=a.id
         and s.tenant_id=a.tenant_id and s.token_hash=$4 and s.revoked_at is null and s.expires_at>now())
       returning a.id`,
      [
        fullName,
        account.id,
        session.tenant_id,
        this.hashCustomerRecoverySessionToken(raw!),
      ],
    );
    if (!changed.rows.length)
      throw new UnauthorizedException('Invalid recovery credentials');
    return { authenticated: true };
  }

  async loginCustomerRecovery(input: CustomerRecoveryLoginInput) {
    const tenantCode = input.tenantCode?.trim() || '';

    if (!tenantCode) {
      throw new BadRequestException('tenantCode is required');
    }

    const phoneNormalized = this.normalizeCustomerRecoveryPhone(input.phone);

    const pin = this.normalizeCustomerRecoveryPin(input.pin);

    const tenantResult = await this.databaseService.query<{
      id: string;
      code: string;
    }>(
      `
          select
            id::text,
            code
          from public.tenants
          where code = $1
          limit 1
        `,
      [tenantCode],
    );

    const tenant = tenantResult.rows[0];

    if (!tenant) {
      this.performDummyCustomerRecoveryPinWork(pin);
      throw new UnauthorizedException('Invalid recovery credentials');
    }

    const account = await this.findCustomerRecoveryAccount(
      tenant.id,
      phoneNormalized,
    );

    if (!account) {
      this.performDummyCustomerRecoveryPinWork(pin);
      throw new UnauthorizedException('Invalid recovery credentials');
    }

    await this.assertCustomerRecoveryPin(account, pin);

    const sessionToken = await this.createCustomerRecoverySession(
      tenant.id,
      account.id,
    );

    return {
      sessionToken,
      tenantCode: tenant.code,
    };
  }

  async linkCustomerRecoveryOrders(
    cookieHeader: string | undefined,
    input: {
      tenantCode?: string;
      branchCode?: string;
      trackingTokens?: unknown;
    },
  ) {
    const tokens = input.trackingTokens;
    if (
      !Array.isArray(tokens) ||
      tokens.length > 100 ||
      tokens.some((t) => typeof t !== 'string' || !RECOVERY_UUID.test(t))
    ) {
      throw new BadRequestException('Invalid order access list');
    }
    const raw = this.extractCustomerRecoverySessionToken(cookieHeader);
    const session = raw
      ? await this.findCustomerRecoverySessionByToken(raw)
      : null;
    if (!session || session.tenant_code !== input.tenantCode)
      throw new UnauthorizedException('Customer recovery session required');
    const branchCode = input.branchCode?.trim();
    if (!branchCode) throw new BadRequestException('branch required');
    return this.databaseService.withTransaction(async (client) => {
      const result = await client.query<{
        id: string;
        customer_account_id: string | null;
        customer_phone: string | null;
      }>(
        `select o.id::text, o.customer_account_id::text, o.customer_phone
        from public.orders o join public.branches b on b.id=o.branch_id and b.tenant_id=o.tenant_id
        where o.tenant_id=$1::uuid and b.code=$2 and o.tracking_token=any($3::uuid[]) for update of o`,
        [session.tenant_id, branchCode, [...new Set(tokens)]],
      );
      const eligible = result.rows.filter(
        (o) =>
          sameRecoveryPhone(o.customer_phone, session.phone_normalized) &&
          (!o.customer_account_id ||
            o.customer_account_id === session.customer_account_id),
      );
      const ids = eligible
        .filter((o) => !o.customer_account_id)
        .map((o) => o.id);
      if (ids.length)
        await client.query(
          `update public.orders set customer_account_id=$2::uuid, updated_at=now()
        where tenant_id=$1::uuid and id=any($3::uuid[]) and customer_account_id is null`,
          [session.tenant_id, session.customer_account_id, ids],
        );
      return { linked: ids.length };
    });
  }

  async getCustomerRecoveryOrders(
    cookieHeader: string | undefined,
    tenantCodeInput: string | undefined,
    branchCodeInput: string | undefined,
    cursor?: string,
  ) {
    const tenantCode = tenantCodeInput?.trim() || '',
      branchCode = branchCodeInput?.trim() || '';
    if (!tenantCode || !branchCode)
      throw new BadRequestException('tenant and branch are required');
    if (cursor && !RECOVERY_UUID.test(cursor))
      throw new BadRequestException('Invalid recovery cursor');
    const raw = this.extractCustomerRecoverySessionToken(cookieHeader);
    const session = raw
      ? await this.findCustomerRecoverySessionByToken(raw)
      : null;
    if (!session || session.tenant_code !== tenantCode)
      throw new UnauthorizedException('Customer recovery session required');
    const result = await this.databaseService.query<{
      id: string;
      tracking_token: string;
    }>(
      `
      select o.id::text, o.tracking_token::text from public.orders o
      join public.branches b on b.id=o.branch_id and b.tenant_id=o.tenant_id
      where o.tenant_id=$1::uuid and o.customer_account_id=$2::uuid and b.code=$3
        and ($4::uuid is null or (o.created_at,o.id) < (
          select c.created_at,c.id from public.orders c
          where c.id=$4::uuid and c.tenant_id=o.tenant_id and c.customer_account_id=o.customer_account_id and c.branch_id=o.branch_id
        ))
      order by o.created_at desc,o.id desc limit $5`,
      [
        session.tenant_id,
        session.customer_account_id,
        branchCode,
        cursor || null,
        RECOVERY_PAGE_SIZE + 1,
      ],
    );
    const page = result.rows.slice(0, RECOVERY_PAGE_SIZE);
    return {
      authenticated: true,
      tenantCode,
      branchCode,
      orderTrackingTokens: page.map((o) => o.tracking_token),
      nextCursor:
        result.rows.length > RECOVERY_PAGE_SIZE
          ? page[page.length - 1].id
          : null,
    };
  }

  async logoutCustomerRecovery(cookieHeader?: string) {
    const rawToken = this.extractCustomerRecoverySessionToken(cookieHeader);

    if (!rawToken) {
      return;
    }

    await this.databaseService.query(
      `
        update public.customer_sessions
        set revoked_at = coalesce(revoked_at, now())
        where token_hash = $1
      `,
      [this.hashCustomerRecoverySessionToken(rawToken)],
    );
  }

  private normalizeCustomerRecoveryPhone(value?: string): string {
    const normalized = recoveryPhone(value);

    if (normalized.length < 7 || normalized.length > 15) {
      throw new BadRequestException(
        'phone must contain between 7 and 15 digits',
      );
    }

    return normalized;
  }

  private normalizeCustomerRecoveryPin(value?: string): string {
    const pin = value?.trim() || '';

    if (!/^\d{6}$/.test(pin)) {
      throw new BadRequestException('pin must contain exactly 6 digits');
    }

    return pin;
  }

  private hashCustomerRecoveryPin(pin: string): string {
    const salt = randomBytes(16);

    const derived = scryptSync(pin, salt, 64);

    return `scrypt$${salt.toString('base64url')}$${derived.toString('base64url')}`;
  }

  private verifyCustomerRecoveryPin(pin: string, encoded: string): boolean {
    const [algorithm, saltEncoded, hashEncoded] = encoded.split('$');

    if (algorithm !== 'scrypt' || !saltEncoded || !hashEncoded) {
      return false;
    }

    try {
      const salt = Buffer.from(saltEncoded, 'base64url');

      const expected = Buffer.from(hashEncoded, 'base64url');

      const actual = scryptSync(pin, salt, expected.length);

      return (
        expected.length === actual.length && timingSafeEqual(expected, actual)
      );
    } catch {
      return false;
    }
  }

  private performDummyCustomerRecoveryPinWork(pin: string) {
    scryptSync(pin, Buffer.alloc(16, 1), 64);
  }

  private async findCustomerRecoveryAccount(
    tenantId: string,
    phoneNormalized: string,
  ) {
    const result = await this.databaseService.query<{
      id: string;
      tenant_id: string;
      pin_hash: string;
      failed_attempts: number;
      locked_until: string | Date | null;
    }>(
      `
          select
            id::text,
            tenant_id::text,
            pin_hash,
            failed_attempts,
            locked_until

          from public.customer_accounts

          where tenant_id = $1::uuid
            and phone_normalized = any($2::text[])
            and status = 'ACTIVE'

          limit 2
        `,
      [tenantId, recoveryPhoneAliases(phoneNormalized)],
    );

    if (result.rows.length > 1)
      throw new ConflictException(
        'Recovery account requires administrative review',
      );
    return result.rows[0] ?? null;
  }

  private async assertCustomerRecoveryPin(
    account: {
      id: string;
      pin_hash: string;
      failed_attempts: number;
      locked_until: string | Date | null;
    },
    pin: string,
  ) {
    const lockedUntil = account.locked_until
      ? new Date(account.locked_until)
      : null;

    if (lockedUntil && lockedUntil.getTime() > Date.now()) {
      throw new HttpException(
        {
          message: 'Recovery temporarily locked',
          retryAfterSeconds: Math.max(
            1,
            Math.ceil((lockedUntil.getTime() - Date.now()) / 1000),
          ),
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const valid = this.verifyCustomerRecoveryPin(pin, account.pin_hash);

    if (!valid) {
      // Increment the persisted counter atomically: concurrent failures cannot overwrite one another.
      await this.databaseService.query(
        `update public.customer_accounts
         set failed_attempts=failed_attempts+1,
             locked_until=case when failed_attempts+1>=5
               then greatest(coalesce(locked_until,now()),now()+interval '15 minutes')
               else locked_until end,
             updated_at=now()
         where id=$1::uuid`,
        [account.id],
      );

      throw new UnauthorizedException('Invalid recovery credentials');
    }

    if (account.failed_attempts !== 0 || account.locked_until) {
      await this.databaseService.query(
        `
          update public.customer_accounts
          set
            failed_attempts = 0,
            locked_until = null,
            updated_at = now()
          where id = $1::uuid
        `,
        [account.id],
      );
    }
  }

  private hashCustomerRecoverySessionToken(token: string): string {
    return createHash('sha256').update(token, 'utf8').digest('hex');
  }

  private async createCustomerRecoverySession(
    tenantId: string,
    customerAccountId: string,
  ): Promise<string> {
    const rawToken = randomBytes(32).toString('base64url');

    const tokenHash = this.hashCustomerRecoverySessionToken(rawToken);

    const expiresAt = new Date(
      Date.now() + this.customerRecoverySessionMaxAgeMs,
    );

    await this.databaseService.query(
      `
        insert into public.customer_sessions (
          tenant_id,
          customer_account_id,
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
      [tenantId, customerAccountId, tokenHash, expiresAt.toISOString()],
    );

    return rawToken;
  }

  async findCustomerRecoverySessionByToken(rawToken: string) {
    const tokenHash = this.hashCustomerRecoverySessionToken(rawToken);

    const result = await this.databaseService.query<{
      customer_account_id: string;
      tenant_id: string;
      tenant_code: string;
      phone_normalized: string;
    }>(
      `
          select
            s.customer_account_id::text,
            s.tenant_id::text,
            t.code as tenant_code,
            a.phone_normalized

          from public.customer_sessions s

          inner join public.customer_accounts a
            on a.id = s.customer_account_id
           and a.tenant_id = s.tenant_id

          inner join public.tenants t
            on t.id = s.tenant_id

          where s.token_hash = $1
            and s.revoked_at is null
            and s.expires_at > now()
            and a.status = 'ACTIVE'

          limit 1
        `,
      [tokenHash],
    );

    return result.rows[0] ?? null;
  }
}
