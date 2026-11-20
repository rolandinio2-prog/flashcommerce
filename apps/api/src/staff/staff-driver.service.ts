import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { randomBytes, scryptSync } from 'node:crypto';

import { DatabaseService } from '../database/database.service';
import type { StaffSessionPrincipal } from './staff.types';

interface DriverListRow {
  id: string;
  code: string;
  display_name: string;
  first_name: string | null;
  last_name: string | null;
  identity_document: string | null;
  phone: string;
  email: string | null;
  vehicle_plate: string | null;
  driver_status: 'ACTIVE' | 'INACTIVE';
  branch_status: 'ENABLED' | 'DISABLED';
  created_at: string | Date;
  active_assignments: string;
  password_configured: boolean;
  password_change_required: boolean;
  session_active: boolean;
}

interface DriverProfileInput {
  firstName?: string;
  lastName?: string;
  identityDocument?: string;
  phone?: string;
  email?: string;
  vehiclePlate?: string;
}

@Injectable()
export class StaffDriverService {
  constructor(private readonly databaseService: DatabaseService) {}

  async listBranchDrivers(principal: StaffSessionPrincipal) {
    const result = await this.databaseService.query<DriverListRow>(
      `
        select
          drv.id::text,
          drv.code,
          drv.display_name,
          drv.first_name,
          drv.last_name,
          drv.identity_document,
          drv.phone,
          drv.email,
          drv.vehicle_plate,
          drv.status as driver_status,
          db.status as branch_status,
          drv.created_at,
          coalesce(active.active_assignments, 0)::text as active_assignments,
          (drv.password_hash is not null) as password_configured,
          drv.password_change_required,
          exists (
            select 1
            from public.delivery_driver_credentials cred
            where cred.tenant_id = drv.tenant_id
              and cred.driver_id = drv.id
              and cred.status = 'ACTIVE'
              and cred.revoked_at is null
              and (
                cred.expires_at is null
                or cred.expires_at > now()
              )
          ) as session_active
        from public.delivery_driver_branches db
        inner join public.delivery_drivers drv
          on drv.tenant_id = db.tenant_id
         and drv.id = db.driver_id
        left join lateral (
          select count(*)::integer as active_assignments
          from public.delivery_assignments a
          where a.tenant_id = drv.tenant_id
            and a.driver_id = drv.id
            and a.status in ('ASSIGNED', 'ACCEPTED')
        ) active on true
        where db.tenant_id = $1::uuid
          and db.branch_id = $2::uuid
        order by
          case
            when drv.status = 'ACTIVE' and db.status = 'ENABLED' then 0
            else 1
          end,
          drv.display_name,
          drv.code
      `,
      [principal.tenantId, principal.branchId],
    );

    return {
      tenantCode: principal.tenantCode,
      branchCode: principal.branchCode,
      drivers: result.rows.map((row) => this.mapDriver(row)),
    };
  }

  async createBranchDriver(
    principal: StaffSessionPrincipal,
    input: DriverProfileInput,
  ) {
    const profile = this.normalizeProfile(input);

    for (let attempt = 0; attempt < 8; attempt += 1) {
      const driverCode = this.generateDriverCode();
      const temporaryPassword = this.generateTemporaryPassword();
      const passwordHash = this.hashPassword(temporaryPassword);

      try {
        const created = await this.databaseService.withTransaction(
          async (client) => {
            const driverResult = await client.query<{
              id: string;
              created_at: string | Date;
            }>(
              `
                insert into public.delivery_drivers (
                  tenant_id,
                  code,
                  display_name,
                  phone,
                  first_name,
                  last_name,
                  identity_document,
                  email,
                  vehicle_plate,
                  created_by_staff_user_id,
                  password_hash,
                  password_change_required
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
                  $9,
                  $10::uuid,
                  $11,
                  true
                )
                returning
                  id::text,
                  created_at
              `,
              [
                principal.tenantId,
                driverCode,
                profile.displayName,
                profile.phone,
                profile.firstName,
                profile.lastName,
                profile.identityDocument,
                profile.email,
                profile.vehiclePlate,
                principal.userId,
                passwordHash,
              ],
            );

            const driver = driverResult.rows[0];

            await client.query(
              `
                insert into public.delivery_driver_branches (
                  tenant_id,
                  branch_id,
                  driver_id,
                  status
                )
                values (
                  $1::uuid,
                  $2::uuid,
                  $3::uuid,
                  'ENABLED'
                )
              `,
              [principal.tenantId, principal.branchId, driver.id],
            );

            return driver;
          },
        );

        return {
          driver: {
            id: created.id,
            code: driverCode,
            displayName: profile.displayName,
            firstName: profile.firstName,
            lastName: profile.lastName,
            identityDocument: profile.identityDocument,
            phone: profile.phone,
            email: profile.email,
            vehiclePlate: profile.vehiclePlate,
            status: 'ACTIVE' as const,
            activeAssignments: 0,
            passwordConfigured: true,
            passwordChangeRequired: true,
            sessionActive: false,
            createdAt: new Date(created.created_at).toISOString(),
          },
          credentials: {
            driverCode,
            temporaryPassword,
          },
        };
      } catch (error) {
        const constraint = this.getUniqueConstraint(error);

        if (
          constraint === 'uq_delivery_drivers_code'
        ) {
          continue;
        }

        this.throwProfileConflict(constraint);
        throw error;
      }
    }

    throw new ServiceUnavailableException(
      'Could not allocate driver account',
    );
  }

  async updateDriverProfile(
    principal: StaffSessionPrincipal,
    driverId: string,
    input: DriverProfileInput,
  ) {
    const profile = this.normalizeProfile(input);

    try {
      const result = await this.databaseService.query<{ id: string }>(
        `
          update public.delivery_drivers drv
          set
            display_name = $4,
            phone = $5,
            first_name = $6,
            last_name = $7,
            identity_document = $8,
            email = $9,
            vehicle_plate = $10,
            updated_at = now()
          where drv.tenant_id = $1::uuid
            and drv.id = $2::uuid
            and exists (
              select 1
              from public.delivery_driver_branches db
              where db.tenant_id = drv.tenant_id
                and db.branch_id = $3::uuid
                and db.driver_id = drv.id
            )
          returning drv.id::text
        `,
        [
          principal.tenantId,
          driverId,
          principal.branchId,
          profile.displayName,
          profile.phone,
          profile.firstName,
          profile.lastName,
          profile.identityDocument,
          profile.email,
          profile.vehiclePlate,
        ],
      );

      if (!result.rows[0]) {
        throw new NotFoundException('Delivery driver not found in this branch');
      }
    } catch (error) {
      const constraint = this.getUniqueConstraint(error);
      this.throwProfileConflict(constraint);
      throw error;
    }

    return {
      changed: true,
      driver: await this.getBranchDriver(principal, driverId),
    };
  }

  async resetDriverCredentials(
    principal: StaffSessionPrincipal,
    driverId: string,
  ) {
    const temporaryPassword = this.generateTemporaryPassword();
    const passwordHash = this.hashPassword(temporaryPassword);

    const driver = await this.databaseService.withTransaction(async (client) => {
      const driverResult = await client.query<{
        id: string;
        code: string;
        display_name: string;
      }>(
        `
          select
            drv.id::text,
            drv.code,
            drv.display_name
          from public.delivery_drivers drv
          inner join public.delivery_driver_branches db
            on db.tenant_id = drv.tenant_id
           and db.driver_id = drv.id
          where drv.tenant_id = $1::uuid
            and db.branch_id = $2::uuid
            and drv.id = $3::uuid
          for update of drv
        `,
        [principal.tenantId, principal.branchId, driverId],
      );

      const row = driverResult.rows[0];

      if (!row) {
        throw new NotFoundException('Delivery driver not found in this branch');
      }

      await client.query(
        `
          update public.delivery_drivers
          set
            password_hash = $3,
            password_change_required = true,
            password_changed_at = null,
            updated_at = now()
          where tenant_id = $1::uuid
            and id = $2::uuid
        `,
        [principal.tenantId, driverId, passwordHash],
      );

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
        [principal.tenantId, driverId],
      );



      return row;
    });

    return {
      driver: {
        id: driver.id,
        code: driver.code,
        displayName: driver.display_name,
      },
      credentials: {
        driverCode: driver.code,
        temporaryPassword,
      },
    };
  }

  async setDriverStatus(
    principal: StaffSessionPrincipal,
    driverId: string,
    rawStatus?: string,
  ) {
    const status = (rawStatus || '').trim().toUpperCase();

    if (status !== 'ACTIVE' && status !== 'INACTIVE') {
      throw new BadRequestException('status must be ACTIVE or INACTIVE');
    }

    await this.databaseService.withTransaction(async (client) => {
      const currentResult = await client.query<{
        id: string;
        active_assignments: string;
      }>(
        `
          select
            drv.id::text,
            (
              select count(*)::text
              from public.delivery_assignments a
              where a.tenant_id = drv.tenant_id
                and a.driver_id = drv.id
                and a.status in ('ASSIGNED', 'ACCEPTED')
            ) as active_assignments
          from public.delivery_drivers drv
          inner join public.delivery_driver_branches db
            on db.tenant_id = drv.tenant_id
           and db.driver_id = drv.id
          where drv.tenant_id = $1::uuid
            and db.branch_id = $2::uuid
            and drv.id = $3::uuid
          for update of drv, db
        `,
        [principal.tenantId, principal.branchId, driverId],
      );

      const current = currentResult.rows[0];

      if (!current) {
        throw new NotFoundException('Delivery driver not found in this branch');
      }

      if (status === 'INACTIVE' && Number(current.active_assignments) > 0) {
        throw new ConflictException(
          'Cannot deactivate a driver with an active delivery',
        );
      }

      await client.query(
        `
          update public.delivery_drivers
          set
            status = $3,
            updated_at = now()
          where tenant_id = $1::uuid
            and id = $2::uuid
        `,
        [principal.tenantId, driverId, status],
      );

      await client.query(
        `
          update public.delivery_driver_branches
          set
            status = $4,
            updated_at = now()
          where tenant_id = $1::uuid
            and branch_id = $2::uuid
            and driver_id = $3::uuid
        `,
        [
          principal.tenantId,
          principal.branchId,
          driverId,
          status === 'ACTIVE' ? 'ENABLED' : 'DISABLED',
        ],
      );
    });

    return {
      changed: true,
      driver: await this.getBranchDriver(principal, driverId),
    };
  }

  private async getBranchDriver(
    principal: StaffSessionPrincipal,
    driverId: string,
  ) {
    const result = await this.databaseService.query<DriverListRow>(
      `
        select
          drv.id::text,
          drv.code,
          drv.display_name,
          drv.first_name,
          drv.last_name,
          drv.identity_document,
          drv.phone,
          drv.email,
          drv.vehicle_plate,
          drv.status as driver_status,
          db.status as branch_status,
          drv.created_at,
          coalesce(active.active_assignments, 0)::text as active_assignments,
          (drv.password_hash is not null) as password_configured,
          drv.password_change_required,
          exists (
            select 1
            from public.delivery_driver_credentials cred
            where cred.tenant_id = drv.tenant_id
              and cred.driver_id = drv.id
              and cred.status = 'ACTIVE'
              and cred.revoked_at is null
              and (
                cred.expires_at is null
                or cred.expires_at > now()
              )
          ) as session_active
        from public.delivery_driver_branches db
        inner join public.delivery_drivers drv
          on drv.tenant_id = db.tenant_id
         and drv.id = db.driver_id
        left join lateral (
          select count(*)::integer as active_assignments
          from public.delivery_assignments a
          where a.tenant_id = drv.tenant_id
            and a.driver_id = drv.id
            and a.status in ('ASSIGNED', 'ACCEPTED')
        ) active on true
        where db.tenant_id = $1::uuid
          and db.branch_id = $2::uuid
          and drv.id = $3::uuid
        limit 1
      `,
      [principal.tenantId, principal.branchId, driverId],
    );

    const row = result.rows[0];

    if (!row) {
      throw new NotFoundException('Delivery driver not found in this branch');
    }

    return this.mapDriver(row);
  }

  private mapDriver(row: DriverListRow) {
    const active =
      row.driver_status === 'ACTIVE' && row.branch_status === 'ENABLED';

    return {
      id: row.id,
      code: row.code,
      displayName: row.display_name,
      firstName: row.first_name,
      lastName: row.last_name,
      identityDocument: row.identity_document,
      phone: row.phone,
      email: row.email,
      vehiclePlate: row.vehicle_plate,
      status: active ? ('ACTIVE' as const) : ('INACTIVE' as const),
      activeAssignments: Number(row.active_assignments),
      passwordConfigured: row.password_configured,
      passwordChangeRequired: row.password_change_required,
      sessionActive: row.session_active,
      createdAt: new Date(row.created_at).toISOString(),
    };
  }

  private normalizeProfile(input: DriverProfileInput) {
    const firstName = this.requireText(input.firstName, 'firstName', 80);
    const lastName = this.requireText(input.lastName, 'lastName', 80);
    const identityDocument = this.requireText(
      input.identityDocument,
      'identityDocument',
      40,
      3,
    ).toUpperCase();
    const phone = this.requireText(input.phone, 'phone', 40, 5);
    const email = this.optionalEmail(input.email);
    const vehiclePlate = this.requireVehiclePlate(input.vehiclePlate);

    return {
      firstName,
      lastName,
      displayName: `${firstName} ${lastName}`.trim(),
      identityDocument,
      phone,
      email,
      vehiclePlate,
    };
  }

  private requireText(
    value: unknown,
    field: string,
    maxLength: number,
    minLength = 2,
  ): string {
    if (typeof value !== 'string') {
      throw new BadRequestException(`${field} is required`);
    }

    const normalized = value.trim().replace(/\s+/g, ' ');

    if (
      normalized.length < minLength ||
      normalized.length > maxLength
    ) {
      throw new BadRequestException(`${field} is invalid`);
    }

    return normalized;
  }

  private optionalEmail(value: unknown): string | null {
    if (value === undefined || value === null || value === '') {
      return null;
    }

    if (typeof value !== 'string') {
      throw new BadRequestException('email is invalid');
    }

    const normalized = value.trim().toLowerCase();

    if (
      normalized.length < 5 ||
      normalized.length > 160 ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)
    ) {
      throw new BadRequestException('email is invalid');
    }

    return normalized;
  }

  private requireVehiclePlate(value: unknown): string {
    if (typeof value !== 'string') {
      throw new BadRequestException('vehiclePlate is required');
    }

    const normalized = value.trim().toUpperCase().replace(/\s+/g, ' ');

    if (
      normalized.length < 3 ||
      normalized.length > 20 ||
      !/^[A-Z0-9 -]+$/.test(normalized)
    ) {
      throw new BadRequestException('vehiclePlate is invalid');
    }

    return normalized;
  }

  private generateDriverCode(): string {
    return `DRV-${randomBytes(3).toString('hex').toUpperCase()}`;
  }

  private generateTemporaryPassword(): string {
    return randomBytes(12).toString('base64url');
  }

  private hashPassword(password: string): string {
    const salt = randomBytes(16);
    const derived = scryptSync(password, salt, 64);

    return `scrypt$${salt.toString('base64url')}$${derived.toString('base64url')}`;
  }

  private getUniqueConstraint(error: unknown): string | null {
    if (
      !error ||
      typeof error !== 'object' ||
      !('code' in error) ||
      (error as { code?: string }).code !== '23505'
    ) {
      return null;
    }

    return 'constraint' in error &&
      typeof (error as { constraint?: unknown }).constraint === 'string'
      ? (error as { constraint: string }).constraint
      : '';
  }

  private throwProfileConflict(constraint: string | null): void {
    if (constraint === 'uq_delivery_drivers_identity_document') {
      throw new ConflictException(
        'A delivery driver with this identity document already exists',
      );
    }

    if (constraint === 'uq_delivery_drivers_vehicle_plate') {
      throw new ConflictException(
        'A delivery driver with this vehicle plate already exists',
      );
    }
  }
}
