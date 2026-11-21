import {
  ForbiddenException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import type { StaffSessionPrincipal } from './staff.types';

export function commercialLinks(
  base: string | undefined,
  tenant: string,
  branch: string,
) {
  if (![tenant, branch].every((code) => /^[A-Za-z0-9_-]{1,80}$/.test(code)))
    throw new ServiceUnavailableException('Commercial links unavailable');
  let url: URL;
  try {
    url = new URL(base?.trim() || '');
  } catch {
    throw new ServiceUnavailableException(
      'Public customer URL is not configured',
    );
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/' ||
    url.hostname === 'localhost' ||
    url.hostname === '127.0.0.1' ||
    url.hostname === '[::1]'
  ) {
    throw new ServiceUnavailableException(
      'Public customer URL must be an HTTPS origin',
    );
  }
  const commerceUrl = `${url.origin}/menu/${encodeURIComponent(tenant)}`;
  return {
    commerceUrl,
    branchUrl: `${commerceUrl}/${encodeURIComponent(branch)}`,
  };
}
@Injectable()
export class StaffCommercialLinksService {
  constructor(private readonly databaseService: DatabaseService) {}
  async getLinks(principal: StaffSessionPrincipal) {
    if (
      !['ADMIN', 'MANAGER'].includes(principal.role) ||
      principal.passwordChangeRequired
    )
      throw new ForbiddenException('Commercial links access denied');
    const result = await this.databaseService.query<{
      tenant_code: string;
      tenant_name: string;
      branch_code: string;
      branch_name: string;
    }>(
      `
      select t.code as tenant_code, t.name as tenant_name, b.code as branch_code, b.name as branch_name
      from public.tenants t inner join public.branches b on b.tenant_id = t.id
      where t.id = $1::uuid and b.id = $2::uuid
        and t.status = 'ACTIVE' and b.status = 'ACTIVE'
      limit 1
    `,
      [principal.tenantId, principal.branchId],
    );
    const row = result.rows[0];
    if (
      !row ||
      row.tenant_code !== principal.tenantCode ||
      row.branch_code !== principal.branchCode
    )
      throw new ForbiddenException('Commerce or branch unavailable');
    return {
      tenant: { code: row.tenant_code, name: row.tenant_name },
      branch: { code: row.branch_code, name: row.branch_name },
      ...commercialLinks(
        process.env.FLASH_CUSTOMER_URL,
        row.tenant_code,
        row.branch_code,
      ),
    };
  }
}
