import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import { DatabaseService } from '../database/database.service';
import type { StaffSessionPrincipal } from './staff.types';

interface BranchRow {
  tenant_code: string;
  branch_code: string;
  branch_name: string;
  address: string | null;
  latitude: string | null;
  longitude: string | null;
  modified: string;
  delivery_enabled: boolean;
}
export const BRANCH_LOCATION_SELECT = `
  select t.code as tenant_code, b.code as branch_code, b.name as branch_name,
    b.delivery_origin_address as address, b.delivery_origin_latitude::text as latitude,
    b.delivery_origin_longitude::text as longitude, b.updated_at::text as modified, b.delivery_enabled
  from public.branches b
  join public.tenants t on t.id=b.tenant_id
  join public.staff_user_branches sb on sb.tenant_id=b.tenant_id and sb.branch_id=b.id and sb.user_id=$3::uuid
  join public.staff_users u on u.tenant_id=sb.tenant_id and u.id=sb.user_id
  join public.staff_sessions s on s.tenant_id=sb.tenant_id and s.branch_id=sb.branch_id and s.user_id=sb.user_id and s.id=$4::uuid
  where b.tenant_id=$1::uuid and b.id=$2::uuid
    and t.status='ACTIVE' and b.status='ACTIVE' and sb.status='ACTIVE' and sb.role='ADMIN'
    and u.status='ACTIVE' and u.password_change_required=false
    and s.revoked_at is null and s.expires_at>now()
  limit 1`;

export function validateBranchLocation(input: unknown) {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new BadRequestException('Datos de sucursal inválidos.');
  const data = input as Record<string, unknown>;
  if (
    Object.keys(data).some(
      (key) => !['address', 'latitude', 'longitude', 'revision'].includes(key),
    )
  )
    throw new BadRequestException('Campos no permitidos.');
  const address =
    typeof data.address === 'string'
      ? data.address.trim().replace(/\s+/g, ' ')
      : '';
  if (
    address.length < 8 ||
    address.length > 400 ||
    /[\u0000-\u001f\u007f]/.test(address)
  )
    throw new BadRequestException(
      'Escribe una dirección completa de 8 a 400 caracteres.',
    );
  if (
    typeof data.latitude !== 'number' ||
    !Number.isFinite(data.latitude) ||
    Math.abs(data.latitude) > 90 ||
    typeof data.longitude !== 'number' ||
    !Number.isFinite(data.longitude) ||
    Math.abs(data.longitude) > 180
  )
    throw new BadRequestException('Selecciona una ubicación válida.');
  if (
    typeof data.revision !== 'string' ||
    !/^[a-f0-9]{64}$/.test(data.revision)
  )
    throw new BadRequestException('Recarga los datos de la sucursal.');
  return {
    address,
    latitude: Number(data.latitude.toFixed(6)),
    longitude: Number(data.longitude.toFixed(6)),
    revision: data.revision,
  };
}

@Injectable()
export class StaffBranchLocationService {
  private readonly logger = new Logger(StaffBranchLocationService.name);
  constructor(private readonly databaseService: DatabaseService) {}
  private authorize(p: StaffSessionPrincipal) {
    if (p.role !== 'ADMIN' || p.passwordChangeRequired)
      throw new ForbiddenException(
        'Solo el administrador puede configurar la sucursal.',
      );
    return [p.tenantId, p.branchId, p.userId, p.sessionId];
  }
  private present(row: BranchRow | undefined, p: StaffSessionPrincipal) {
    if (
      !row ||
      row.tenant_code !== p.tenantCode ||
      row.branch_code !== p.branchCode
    )
      throw new ForbiddenException('Sucursal o sesión no disponible.');
    return {
      tenantCode: row.tenant_code,
      branchCode: row.branch_code,
      branchName: row.branch_name,
      address: row.address ?? '',
      latitude: row.latitude === null ? null : Number(row.latitude),
      longitude: row.longitude === null ? null : Number(row.longitude),
      deliveryEnabled: row.delivery_enabled,
      revision: createHash('sha256')
        .update(
          JSON.stringify([
            p.tenantId,
            p.branchId,
            row.modified,
            row.address,
            row.latitude,
            row.longitude,
          ]),
        )
        .digest('hex'),
    };
  }
  async getLocation(p: StaffSessionPrincipal) {
    const args = this.authorize(p);
    const result = await this.databaseService.query<BranchRow>(
      BRANCH_LOCATION_SELECT,
      args,
    );
    return this.present(result.rows[0], p);
  }
  async saveLocation(p: StaffSessionPrincipal, input: unknown) {
    const args = this.authorize(p),
      data = validateBranchLocation(input);
    const result = await this.databaseService.withTransaction(
      async (client) => {
        // Serialize branch edits and keep session/role validity until commit.
        const before = await client.query<BranchRow>(
          BRANCH_LOCATION_SELECT + ' FOR UPDATE OF b FOR SHARE OF s, sb, u, t',
          args,
        );
        const current = this.present(before.rows[0], p);
        if (current.revision !== data.revision)
          throw new ConflictException(
            'Otro administrador modificó la sucursal. Recarga y revisa los datos antes de guardar.',
          );
        if (
          current.address === data.address &&
          current.latitude === data.latitude &&
          current.longitude === data.longitude
        )
          return current;
        await client.query(
          `update public.branches set delivery_origin_address=$3, delivery_origin_latitude=$4,
        delivery_origin_longitude=$5, updated_at=clock_timestamp() where tenant_id=$1::uuid and id=$2::uuid`,
          [p.tenantId, p.branchId, data.address, data.latitude, data.longitude],
        );
        const after = await client.query<BranchRow>(
          BRANCH_LOCATION_SELECT,
          args,
        );
        return this.present(after.rows[0], p);
      },
    );
    // No addresses, coordinates, session tokens or internal identifiers in logs.
    this.logger.log(
      'BRANCH_LOCATION_SAVED ' +
        JSON.stringify({
          tenant: p.tenantCode,
          branch: p.branchCode,
          operator: p.userCode,
        }),
    );
    return result;
  }
}
