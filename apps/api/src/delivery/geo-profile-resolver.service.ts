import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import type { GeoCapabilities } from './geo.types';
import type {
  EffectiveGeoProfile,
  GeoGeocodingProviderId,
  GeoProfileCode,
  GeoProfileSource,
  GeoRendererId,
  GeoRoutingProviderId,
  GeoTrafficProviderId,
} from './geo-profile.types';

interface GeoContextRow {
  tenant_id: string;
  branch_id: string | null;
}

interface GeoProfileRow {
  code: GeoProfileCode;
  renderer: GeoRendererId;
  routing_provider: GeoRoutingProviderId;
  geocoding_provider: GeoGeocodingProviderId;
  traffic_provider: GeoTrafficProviderId;
  capabilities: GeoCapabilities;
  source: GeoProfileSource;
}

const LEGACY_DEFAULT_PROFILE: EffectiveGeoProfile = {
  code: 'GOOGLE_PREMIUM',
  renderer: 'GOOGLE_MAPS',
  routingProvider: 'GOOGLE',
  geocodingProvider: 'GOOGLE',
  trafficProvider: 'GOOGLE',
  capabilities: {
    routing: {
      route: true,
      matrix: false,
      mapMatch: false,
      trafficAware: true,
    },
    geocoding: {
      search: true,
      resolve: true,
      forward: true,
      reverse: false,
    },
  },
  source: 'LEGACY_DEFAULT',
};

@Injectable()
export class GeoProfileResolver {
  constructor(
    private readonly databaseService: DatabaseService,
  ) {}

  async resolve(
    tenantCode: string,
    branchCode?: string,
  ): Promise<EffectiveGeoProfile> {
    const normalizedTenantCode =
      this.normalizeRequiredCode(
        tenantCode,
        'tenantCode',
      );

    const normalizedBranchCode =
      this.normalizeOptionalCode(
        branchCode,
      );

    const context =
      await this.resolveContext(
        normalizedTenantCode,
        normalizedBranchCode,
      );

    const configuredProfile =
      await this.resolveConfiguredProfile(
        context.tenant_id,
        context.branch_id,
      );

    if (configuredProfile) {
      return this.mapProfile(
        configuredProfile,
      );
    }

    return LEGACY_DEFAULT_PROFILE;
  }

  private async resolveContext(
    tenantCode: string,
    branchCode: string | null,
  ): Promise<GeoContextRow> {
    const result =
      await this.databaseService.query<GeoContextRow>(
        `
          select
            t.id::text as tenant_id,
            b.id::text as branch_id
          from public.tenants t
          left join public.branches b
            on b.tenant_id = t.id
           and b.code = $2
          where t.code = $1
          limit 1
        `,
        [
          tenantCode,
          branchCode,
        ],
      );

    const context =
      result.rows[0];

    if (!context) {
      throw new NotFoundException(
        'Tenant not found',
      );
    }

    if (
      branchCode !== null &&
      context.branch_id === null
    ) {
      throw new NotFoundException(
        'Branch not found',
      );
    }

    return context;
  }

  private async resolveConfiguredProfile(
    tenantId: string,
    branchId: string | null,
  ): Promise<GeoProfileRow | null> {
    const result =
      await this.databaseService.query<GeoProfileRow>(
        `
          select
            gp.code,
            gp.renderer,
            gp.routing_provider,
            gp.geocoding_provider,
            gp.traffic_provider,
            gp.capabilities,
            case
              when tgs.branch_id is not null
                then 'BRANCH_OVERRIDE'
              else 'TENANT_DEFAULT'
            end as source
          from public.tenant_geo_settings tgs
          inner join public.geo_profiles gp
            on gp.id = tgs.profile_id
          where tgs.tenant_id = $1::uuid
            and (
              tgs.branch_id = $2::uuid
              or tgs.branch_id is null
            )
          order by
            case
              when tgs.branch_id = $2::uuid
                then 0
              else 1
            end,
            tgs.updated_at desc,
            tgs.id
          limit 1
        `,
        [
          tenantId,
          branchId,
        ],
      );

    return result.rows[0] ?? null;
  }

  private mapProfile(
    row: GeoProfileRow,
  ): EffectiveGeoProfile {
    return {
      code: row.code,
      renderer: row.renderer,
      routingProvider:
        row.routing_provider,
      geocodingProvider:
        row.geocoding_provider,
      trafficProvider:
        row.traffic_provider,
      capabilities:
        row.capabilities,
      source: row.source,
    };
  }

  private normalizeRequiredCode(
    value: string,
    fieldName: string,
  ): string {
    const normalized =
      value?.trim().toUpperCase();

    if (!normalized) {
      throw new BadRequestException(
        `${fieldName} is required`,
      );
    }

    return normalized;
  }

  private normalizeOptionalCode(
    value?: string,
  ): string | null {
    const normalized =
      value?.trim().toUpperCase();

    return normalized || null;
  }
}