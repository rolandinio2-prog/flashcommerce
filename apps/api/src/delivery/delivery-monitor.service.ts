import { BadRequestException, Injectable } from '@nestjs/common';

import { DatabaseService } from '../database/database.service';
import { DeliveryService } from './delivery.service';
import type {
  DeliveryMonitorDeliveryStatus,
  DeliveryMonitorItem,
  DeliveryMonitorSnapshot,
} from './delivery-monitor.types';

interface DeliveryMonitorRow {
  delivery_id: string;
  assignment_id: string | null;
  assigned_at: string | Date | null;
  order_id: string;
  order_number: string;
  delivery_status: DeliveryMonitorDeliveryStatus;
  driver_id: string | null;
  driver_code: string | null;
  location_latitude: number | null;
  location_longitude: number | null;
  accuracy_meters: string | null;
  captured_at: string | Date | null;
  location_trail: unknown;
  destination_latitude: number;
  destination_longitude: number;
}

interface DeliveryMonitorScopeRow {
  tenant_id: string;
  branch_id: string;
  tenant_code: string;
  branch_code: string;
}
@Injectable()
export class DeliveryMonitorService {
  constructor(
    private readonly databaseService: DatabaseService,
    private readonly deliveryService: DeliveryService,
  ) {}

  async getActiveSnapshot(
    tenantCode?: string,
    branchCode?: string,
    routeDeliveryId?: string,
    includeRoutes = true,
  ): Promise<DeliveryMonitorSnapshot> {
    const tenant = this.requireCode(tenantCode, 'tenant');

    const branch = this.requireCode(branchCode, 'branch');

    const result = await this.databaseService.query<DeliveryMonitorRow>(
      `
          select
            d.id::text
              as delivery_id,

            o.id::text
              as order_id,

            o.order_number::text
              as order_number,

            d.status
              as delivery_status,

            assignment.assignment_id::text,
            assignment.assigned_at,

            assignment.driver_id::text
              as driver_id,

            drv.code
              as driver_code,

            loc.latitude
              as location_latitude,

            loc.longitude
              as location_longitude,

            loc.accuracy_meters,
            loc.captured_at,

            trail.points
              as location_trail,

            gis.ST_Y(
              d.destination::gis.geometry
            )::double precision
              as destination_latitude,

            gis.ST_X(
              d.destination::gis.geometry
            )::double precision
              as destination_longitude

          from public.deliveries d

          inner join public.orders o
            on o.tenant_id = d.tenant_id
           and o.branch_id = d.branch_id
           and o.id = d.order_id

          inner join public.tenants t
            on t.id = d.tenant_id

          inner join public.branches b
            on b.tenant_id = d.tenant_id
           and b.id = d.branch_id

          left join lateral (
            select
              a.id as assignment_id,
              a.driver_id,
              a.assignment_number,
              a.assigned_at

            from public.delivery_assignments a

            where a.tenant_id = d.tenant_id
              and a.branch_id = d.branch_id
              and a.delivery_id = d.id
              and a.status in (
                'ASSIGNED',
                'ACCEPTED'
              )

            order by
              a.assignment_number desc,
              a.assigned_at desc,
              a.id desc

            limit 1
          ) assignment
            on true

          left join public.delivery_drivers drv
            on drv.tenant_id = d.tenant_id
           and drv.id = assignment.driver_id

          left join lateral (
            select
              gis.ST_Y(
                l.position::gis.geometry
              )::double precision
                as latitude,

              gis.ST_X(
                l.position::gis.geometry
              )::double precision
                as longitude,

              l.accuracy_meters::text,
              l.captured_at

            from public.delivery_driver_locations l

            where l.tenant_id = d.tenant_id
              and l.branch_id = d.branch_id
              and l.delivery_id = d.id
              and l.driver_id = assignment.driver_id
              and l.captured_at >= assignment.assigned_at

            order by
              l.captured_at desc,
              l.received_at desc,
              l.id desc

            limit 1
          ) loc
            on assignment.driver_id is not null

          left join lateral (
            select
              coalesce(
                jsonb_agg(
                  jsonb_build_object(
                    'latitude',
                    sample.latitude,
                    'longitude',
                    sample.longitude,
                    'accuracyM',
                    sample.accuracy_meters,
                    'capturedAt',
                    sample.captured_at
                  )
                  order by
                    sample.captured_at asc,
                    sample.received_at asc,
                    sample.id asc
                ),
                '[]'::jsonb
              ) as points

            from (
              select
                l.id,

                gis.ST_Y(
                  l.position::gis.geometry
                )::double precision
                  as latitude,

                gis.ST_X(
                  l.position::gis.geometry
                )::double precision
                  as longitude,

                l.accuracy_meters::double precision
                  as accuracy_meters,

                l.captured_at,
                l.received_at

              from public.delivery_driver_locations l

              where l.tenant_id = d.tenant_id
                and l.branch_id = d.branch_id
                and l.delivery_id = d.id
                and l.driver_id = assignment.driver_id
                and l.captured_at >= assignment.assigned_at

              order by
                l.captured_at desc,
                l.received_at desc,
                l.id desc

              limit 500
            ) sample
          ) trail
            on assignment.driver_id is not null

          where t.code = $1
            and b.code = $2
            and ($3::uuid is null or d.id = $3::uuid)
            and d.status in (
              'CREATED',
              'WAITING_ASSIGNMENT',
              'ASSIGNED',
              'ACCEPTED',
              'PICKED_UP',
              'EN_ROUTE',
              'ARRIVED'
            )

          order by
            d.updated_at desc,
            d.id
        `,
      [tenant, branch, routeDeliveryId ?? null],
    );

    return {
      snapshotVersion: 'delivery-monitor.snapshot.v1',

      generatedAt: new Date().toISOString(),

      items: includeRoutes
        ? await this.mapRowsWithRoutes(
            result.rows,
            (await this.resolveScope(tenantCode, branchCode)).tenantId,
            routeDeliveryId,
          )
        : result.rows.map((row) => this.mapRow(row)),
    };
  }

  async resolveScope(
    tenantCode?: string,
    branchCode?: string,
  ): Promise<{
    tenantId: string;
    branchId: string;
    tenantCode: string;
    branchCode: string;
  }> {
    const tenant = this.requireCode(tenantCode, 'tenant');

    const branch = this.requireCode(branchCode, 'branch');

    const result = await this.databaseService.query<DeliveryMonitorScopeRow>(
      `
          select
            t.id::text
              as tenant_id,

            b.id::text
              as branch_id,

            t.code
              as tenant_code,

            b.code
              as branch_code

          from public.tenants t

          inner join public.branches b
            on b.tenant_id = t.id

          where t.code = $1
            and b.code = $2

          limit 2
        `,
      [tenant, branch],
    );

    if (result.rows.length !== 1) {
      throw new BadRequestException('Delivery monitor scope was not found');
    }

    const row = result.rows[0];

    return {
      tenantId: row.tenant_id,

      branchId: row.branch_id,

      tenantCode: row.tenant_code,

      branchCode: row.branch_code,
    };
  }
  async getActiveDeliveryRoute(
    tenantCode: string | undefined,
    branchCode: string | undefined,
    deliveryId: string,
  ): Promise<DeliveryMonitorSnapshot['items'][number]['route']> {
    const snapshot = await this.getActiveSnapshot(
      tenantCode,
      branchCode,
      deliveryId,
    );

    return (
      snapshot.items.find((item) => item.deliveryId === deliveryId)?.route ??
      null
    );
  }

  private async mapRowsWithRoutes(
    rows: DeliveryMonitorRow[],
    tenantId: string,
    routeDeliveryId?: string,
  ): Promise<DeliveryMonitorSnapshot['items']> {
    const items = rows.map((row) => this.mapRow(row));

    const targetIndexes = items
      .map((item, index) => ({ item, index }))
      .filter(
        ({ item }) => !routeDeliveryId || item.deliveryId === routeDeliveryId,
      )
      .map(({ index }) => index);

    let cursor = 0;

    const worker = async (): Promise<void> => {
      while (true) {
        const cursorIndex = cursor;
        cursor += 1;

        if (cursorIndex >= targetIndexes.length) {
          return;
        }

        const targetIndex = targetIndexes[cursorIndex];

        if (targetIndex === undefined) {
          continue;
        }

        const item = items[targetIndex];

        if (!item) {
          continue;
        }

        const route = await this.buildMonitorRouteFailOpen(item, tenantId);

        items[targetIndex] = {
          ...item,
          route,
        };
      }
    };

    const workerCount = Math.min(2, targetIndexes.length);

    const workers: Array<Promise<void>> = [];

    for (let index = 0; index < workerCount; index += 1) {
      workers.push(worker());
    }

    await Promise.all(workers);

    return items;
  }

  private async buildMonitorRouteFailOpen(
    item: DeliveryMonitorSnapshot['items'][number],
    tenantId: string,
  ): Promise<DeliveryMonitorSnapshot['items'][number]['route']> {
    if (!item.latestLocation) {
      return null;
    }

    try {
      const calculatedAt = new Date();

      const route =
        await this.deliveryService.getCachedDeliveryMapRouteForMonitor(
          tenantId,
          {
            latitude: item.latestLocation.latitude,
            longitude: item.latestLocation.longitude,
          },
          {
            latitude: item.destinationLocation.latitude,
            longitude: item.destinationLocation.longitude,
          },
        );

      if (
        !Number.isFinite(route.distanceMeters) ||
        route.distanceMeters < 0 ||
        !Number.isFinite(route.durationSeconds) ||
        route.durationSeconds < 0
      ) {
        return null;
      }

      const coordinates = this.decodeGoogleEncodedPolyline(
        route.encodedPolyline,
      );

      if (coordinates.length < 2) {
        return null;
      }

      const etaAt = new Date(
        calculatedAt.getTime() + route.durationSeconds * 1000,
      );

      return {
        status: 'AVAILABLE',
        provider: 'GOOGLE',
        geoJson: {
          type: 'Feature',
          geometry: {
            type: 'LineString',
            coordinates,
          },
          properties: {},
        },
        distanceM: route.distanceMeters,
        durationS: route.durationSeconds,
        etaAt: etaAt.toISOString(),
        calculatedAt: calculatedAt.toISOString(),
      };
    } catch {
      return null;
    }
  }

  private decodeGoogleEncodedPolyline(encodedPolyline: string): number[][] {
    if (!encodedPolyline) {
      return [];
    }

    const coordinates: number[][] = [];
    let index = 0;
    let latitude = 0;
    let longitude = 0;

    const decodeValue = (): number => {
      let result = 0;
      let shift = 0;
      let byte = 0;

      do {
        if (index >= encodedPolyline.length) {
          throw new Error('Invalid encoded polyline');
        }

        byte = encodedPolyline.charCodeAt(index) - 63;
        index += 1;
        result |= (byte & 0x1f) << shift;
        shift += 5;
      } while (byte >= 0x20);

      return (result & 1) !== 0 ? ~(result >> 1) : result >> 1;
    };

    while (index < encodedPolyline.length) {
      latitude += decodeValue();
      longitude += decodeValue();

      const latitudeValue = latitude / 100000;
      const longitudeValue = longitude / 100000;

      if (!Number.isFinite(latitudeValue) || !Number.isFinite(longitudeValue)) {
        return [];
      }

      coordinates.push([longitudeValue, latitudeValue]);
    }

    return coordinates;
  }
  private mapRow(row: DeliveryMonitorRow): DeliveryMonitorItem {
    const hasLocation =
      row.location_latitude !== null &&
      row.location_longitude !== null &&
      row.captured_at !== null;

    return {
      assignmentKey: row.assignment_id,
      assignedAt: row.assigned_at
        ? new Date(row.assigned_at).toISOString()
        : null,
      deliveryId: row.delivery_id,

      orderId: row.order_id,

      orderNumber: row.order_number,

      deliveryStatus: row.delivery_status,

      driverId: row.driver_id,

      driverCode: row.driver_code,

      latestLocation: hasLocation
        ? {
            latitude: Number(row.location_latitude),

            longitude: Number(row.location_longitude),

            accuracyM:
              row.accuracy_meters === null ? null : Number(row.accuracy_meters),

            capturedAt: new Date(
              row.captured_at as string | Date,
            ).toISOString(),
          }
        : null,

      trail: this.mapTrailPoints(row.location_trail),

      destinationLocation: {
        latitude: Number(row.destination_latitude),

        longitude: Number(row.destination_longitude),
      },

      route: null,
    };
  }

  private mapTrailPoints(
    value: unknown,
  ): DeliveryMonitorSnapshot['items'][number]['trail'] {
    if (!Array.isArray(value)) {
      return [];
    }

    return value.flatMap((candidate) => {
      if (!candidate || typeof candidate !== 'object') {
        return [];
      }

      const record = candidate as Record<string, unknown>;

      const latitude = Number(record.latitude);

      const longitude = Number(record.longitude);

      const capturedAt =
        typeof record.capturedAt === 'string' ? record.capturedAt : '';

      const capturedAtMs = new Date(capturedAt).getTime();

      if (
        !Number.isFinite(latitude) ||
        !Number.isFinite(longitude) ||
        !Number.isFinite(capturedAtMs)
      ) {
        return [];
      }

      const accuracyValue = record.accuracyM;

      const accuracyM =
        accuracyValue === null || accuracyValue === undefined
          ? null
          : Number(accuracyValue);

      return [
        {
          latitude,
          longitude,
          accuracyM:
            accuracyM !== null && Number.isFinite(accuracyM) ? accuracyM : null,
          capturedAt: new Date(capturedAtMs).toISOString(),
        },
      ];
    });
  }

  private requireCode(value: string | undefined, field: string): string {
    const normalized = value?.trim();

    if (!normalized) {
      throw new BadRequestException(`${field} is required`);
    }

    if (normalized.length > 80) {
      throw new BadRequestException(`${field} is too long`);
    }

    return normalized;
  }
}
