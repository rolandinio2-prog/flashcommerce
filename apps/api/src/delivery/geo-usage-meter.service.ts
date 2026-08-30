import {
  Injectable,
  Logger,
} from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import type {
  GeoUsageMeasureInput,
  GeoUsageRecordInput,
} from './geo-usage.types';

interface GeoUsageWriteRow {
  id: string;
}

@Injectable()
export class GeoUsageMeterService {
  private readonly logger =
    new Logger(GeoUsageMeterService.name);

  constructor(
    private readonly databaseService: DatabaseService,
  ) {}

  async measure<T>(
    input: GeoUsageMeasureInput,
    action: () => Promise<T>,
  ): Promise<T> {
    const startedAt =
      Date.now();

    try {
      return await action();
    } finally {
      await this.record({
        ...input,
        latencyMs:
          Date.now() - startedAt,
      });
    }
  }

  async record(
    input: GeoUsageRecordInput,
  ): Promise<void> {
    try {
      const tenantId =
        input.tenantId?.trim() || null;

      const tenantCode =
        input.tenantCode
          ?.trim()
          .toUpperCase() || null;

      if (!tenantId && !tenantCode) {
        this.logger.warn(
          'Geo usage metering skipped because tenant identity is empty',
        );

        return;
      }

      const latencyMs =
        Math.max(
          0,
          Math.round(
            Number.isFinite(input.latencyMs)
              ? input.latencyMs
              : 0,
          ),
        );

      const cacheHitCount =
        input.cacheHit
          ? 1
          : 0;

      const result =
        await this.databaseService.query<GeoUsageWriteRow>(
          `
            insert into public.geo_provider_usage (
              usage_date,
              tenant_id,
              provider,
              operation,
              request_count,
              cache_hit_count,
              latency_ms
            )
            select
              timezone('UTC', now())::date,
              t.id,
              $3,
              $4,
              1,
              $5::bigint,
              $6::bigint
            from public.tenants t
            where (
              $1::uuid is not null
              and t.id = $1::uuid
            )
            or (
              $1::uuid is null
              and $2::text is not null
              and t.code = $2
            )
            on conflict (
              usage_date,
              tenant_id,
              provider,
              operation
            )
            do update
            set
              request_count =
                public.geo_provider_usage.request_count +
                excluded.request_count,
              cache_hit_count =
                public.geo_provider_usage.cache_hit_count +
                excluded.cache_hit_count,
              latency_ms =
                public.geo_provider_usage.latency_ms +
                excluded.latency_ms,
              updated_at = now()
            returning
              id::text
          `,
          [
            tenantId,
            tenantCode,
            input.provider,
            input.operation,
            cacheHitCount,
            latencyMs,
          ],
        );

      if (!result.rows[0]) {
        this.logger.warn(
          'Geo usage metering skipped because tenant was not found',
        );
      }
    } catch {
      this.logger.warn(
        'Geo usage metering failed',
      );
    }
  }
}