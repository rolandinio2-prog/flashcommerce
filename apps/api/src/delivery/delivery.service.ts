import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import type { PoolClient } from 'pg';

import { DatabaseService } from '../database/database.service';
import type {
  CreatedDelivery,
  DeliveryCheckoutQuote,
  DeliveryQuoteInput,
  DeliveryQuoteResponse,
} from './delivery.types';

interface DeliveryBranchRow {
  tenant_id: string;
  branch_id: string;
  branch_code: string;
  branch_name: string;
  delivery_enabled: boolean;
}

interface DeliveryZoneRow {
  id: string;
  code: string;
  name: string;
  delivery_fee: string;
  minimum_order: string;
  eta_min_minutes: number;
  eta_max_minutes: number;
}

@Injectable()
export class DeliveryService {
  constructor(private readonly databaseService: DatabaseService) {}

  async quoteDelivery(
    input: DeliveryQuoteInput,
  ): Promise<DeliveryQuoteResponse> {
    const tenantCode = this.requireCode(input.tenantCode, 'tenantCode');

    const branchCode = this.requireCode(input.branchCode, 'branchCode');

    const latitude = this.requireCoordinate(
      input.latitude,
      'latitude',
      -90,
      90,
    );

    const longitude = this.requireCoordinate(
      input.longitude,
      'longitude',
      -180,
      180,
    );

    const subtotal = this.requireSubtotal(input.subtotal);

    const branchResult = await this.databaseService.query<DeliveryBranchRow>(
      `
          select
            t.id::text as tenant_id,
            b.id::text as branch_id,
            b.code as branch_code,
            b.name as branch_name,
            b.delivery_enabled
          from public.tenants t
          inner join public.branches b
            on b.tenant_id = t.id
          where t.code = $1
            and b.code = $2
            and t.status = 'ACTIVE'
            and b.status = 'ACTIVE'
          limit 1
        `,
      [tenantCode, branchCode],
    );

    const branch = branchResult.rows[0];

    if (!branch) {
      throw new NotFoundException(
        `Tenant or branch not found: ${tenantCode}/${branchCode}`,
      );
    }

    if (!branch.delivery_enabled) {
      return this.buildUnavailableResponse(branch, 'DELIVERY_DISABLED');
    }

    const zoneResult = await this.databaseService.query<DeliveryZoneRow>(
      `
          select
            z.id::text,
            z.code,
            z.name,
            z.delivery_fee::text,
            z.minimum_order::text,
            z.eta_min_minutes,
            z.eta_max_minutes
          from public.delivery_zones z
          where z.tenant_id = $1::uuid
            and z.branch_id = $2::uuid
            and z.status = 'ACTIVE'
            and gis.ST_Covers(
              z.area,
              gis.ST_SetSRID(
                gis.ST_MakePoint(
                  $3::double precision,
                  $4::double precision
                ),
                4326
              )
            )
          order by
            z.priority asc,
            z.code asc,
            z.id asc
          limit 1
        `,
      [branch.tenant_id, branch.branch_id, longitude, latitude],
    );

    const zone = zoneResult.rows[0];

    if (!zone) {
      return this.buildUnavailableResponse(branch, 'OUTSIDE_DELIVERY_AREA');
    }

    const deliveryFee = this.databaseMoneyToNumber(
      zone.delivery_fee,
      'delivery_fee',
    );

    const minimumOrder = this.databaseMoneyToNumber(
      zone.minimum_order,
      'minimum_order',
    );

    const minimumOrderMissing = Math.max(
      0,
      this.roundMoney(minimumOrder - subtotal),
    );

    const commonResponse = {
      branch: {
        code: branch.branch_code,
        name: branch.branch_name,
      },

      zone: {
        code: zone.code,
        name: zone.name,
      },

      deliveryFee,
      minimumOrder,

      eta: {
        minMinutes: zone.eta_min_minutes,
        maxMinutes: zone.eta_max_minutes,
      },
    };

    if (minimumOrderMissing > 0) {
      return {
        available: false,
        reason: 'MINIMUM_ORDER_NOT_MET',

        ...commonResponse,

        minimumOrderMissing,
      };
    }

    return {
      available: true,
      reason: null,

      ...commonResponse,

      minimumOrderMissing: 0,
    };
  }

  async quoteDeliveryForCheckout(
    client: PoolClient,
    input: {
      tenantId: string;
      branchId: string;
      latitude: unknown;
      longitude: unknown;
      subtotal: number;
    },
  ): Promise<DeliveryCheckoutQuote> {
    const latitude = this.requireCoordinate(
      input.latitude,
      'deliveryLatitude',
      -90,
      90,
    );

    const longitude = this.requireCoordinate(
      input.longitude,
      'deliveryLongitude',
      -180,
      180,
    );

    const subtotal = this.requireSubtotal(input.subtotal);

    const branchResult = await client.query<{
      delivery_enabled: boolean;
    }>(
      `
        select
          b.delivery_enabled
        from public.branches b
        where b.tenant_id = $1::uuid
          and b.id = $2::uuid
          and b.status = 'ACTIVE'
        for share
      `,
      [input.tenantId, input.branchId],
    );

    const branch = branchResult.rows[0];

    if (!branch) {
      throw new NotFoundException('Branch not found for delivery checkout');
    }

    if (!branch.delivery_enabled) {
      throw new ConflictException('Delivery is disabled for this branch');
    }

    const zoneResult = await client.query<DeliveryZoneRow>(
      `
          select
            z.id::text,
            z.code,
            z.name,
            z.delivery_fee::text,
            z.minimum_order::text,
            z.eta_min_minutes,
            z.eta_max_minutes
          from public.delivery_zones z
          where z.tenant_id = $1::uuid
            and z.branch_id = $2::uuid
            and z.status = 'ACTIVE'
            and gis.ST_Covers(
              z.area,
              gis.ST_SetSRID(
                gis.ST_MakePoint(
                  $3::double precision,
                  $4::double precision
                ),
                4326
              )
            )
          order by
            z.priority asc,
            z.code asc,
            z.id asc
          limit 1
          for share of z
        `,
      [input.tenantId, input.branchId, longitude, latitude],
    );

    const zone = zoneResult.rows[0];

    if (!zone) {
      throw new ConflictException(
        'Delivery address is outside the delivery area',
      );
    }

    const deliveryFee = this.databaseMoneyToNumber(
      zone.delivery_fee,
      'delivery_fee',
    );

    const minimumOrder = this.databaseMoneyToNumber(
      zone.minimum_order,
      'minimum_order',
    );

    const minimumOrderMissing = this.roundMoney(minimumOrder - subtotal);

    if (minimumOrderMissing > 0) {
      throw new ConflictException(
        `Minimum delivery order not met: ${minimumOrderMissing.toFixed(2)} BOB missing`,
      );
    }

    return {
      zoneId: zone.id,

      zone: {
        code: zone.code,
        name: zone.name,
      },

      deliveryFee,
      minimumOrder,

      eta: {
        minMinutes: zone.eta_min_minutes,
        maxMinutes: zone.eta_max_minutes,
      },
    };
  }

  async createDeliveryForOrder(
    client: PoolClient,
    input: {
      tenantId: string;
      branchId: string;
      orderId: string;

      quote: DeliveryCheckoutQuote;

      recipientName: string;
      recipientPhone: string;

      addressText: string;
      addressReference: string | null;

      latitude: number;
      longitude: number;
    },
  ): Promise<CreatedDelivery> {
    const result = await client.query<{
      id: string;
      tracking_token: string;
      status: 'CREATED';
    }>(
      `
        insert into public.deliveries (
          tenant_id,
          branch_id,
          order_id,
          zone_id,

          status,

          recipient_name,
          recipient_phone,

          address_text,
          address_reference,

          destination,

          quoted_delivery_fee,

          eta_min_minutes,
          eta_max_minutes
        )
        values (
          $1::uuid,
          $2::uuid,
          $3::uuid,
          $4::uuid,

          'CREATED',

          $5,
          $6,

          $7,
          $8,

          gis.ST_SetSRID(
            gis.ST_MakePoint(
              $9::double precision,
              $10::double precision
            ),
            4326
          )::gis.geography,

          $11,

          $12,
          $13
        )
        returning
          id::text,
          tracking_token::text,
          status
      `,
      [
        input.tenantId,
        input.branchId,
        input.orderId,
        input.quote.zoneId,

        input.recipientName,
        input.recipientPhone,

        input.addressText,
        input.addressReference,

        input.longitude,
        input.latitude,

        input.quote.deliveryFee,

        input.quote.eta.minMinutes,
        input.quote.eta.maxMinutes,
      ],
    );

    const delivery = result.rows[0];

    if (!delivery) {
      throw new Error('Delivery creation returned no row');
    }

    await client.query(
      `
        insert into public.delivery_events (
          tenant_id,
          branch_id,
          delivery_id,

          event_type,
          from_status,
          to_status,

          actor_type,
          actor_reference,

          payload
        )
        values (
          $1::uuid,
          $2::uuid,
          $3::uuid,

          'DELIVERY_CREATED',
          null,
          'CREATED',

          'SYSTEM',
          'ORDER_CHECKOUT',

          jsonb_build_object(
            'zoneCode',
            $4::text,
            'deliveryFee',
            $5::numeric,
            'etaMinMinutes',
            $6::integer,
            'etaMaxMinutes',
            $7::integer
          )
        )
      `,
      [
        input.tenantId,
        input.branchId,
        delivery.id,

        input.quote.zone.code,
        input.quote.deliveryFee,
        input.quote.eta.minMinutes,
        input.quote.eta.maxMinutes,
      ],
    );

    return {
      id: delivery.id,
      trackingToken: delivery.tracking_token,
      status: delivery.status,
    };
  }
  private buildUnavailableResponse(
    branch: DeliveryBranchRow,
    reason: 'DELIVERY_DISABLED' | 'OUTSIDE_DELIVERY_AREA',
  ): DeliveryQuoteResponse {
    return {
      available: false,
      reason,

      branch: {
        code: branch.branch_code,
        name: branch.branch_name,
      },

      zone: null,

      deliveryFee: null,
      minimumOrder: null,
      minimumOrderMissing: null,

      eta: null,
    };
  }

  private requireCode(value: unknown, field: string): string {
    if (typeof value !== 'string') {
      throw new BadRequestException(`${field} is required`);
    }

    const normalized = value.trim();

    if (
      normalized.length < 2 ||
      normalized.length > 40 ||
      !/^[A-Za-z0-9_-]+$/.test(normalized)
    ) {
      throw new BadRequestException(`${field} is invalid`);
    }

    return normalized;
  }

  private requireCoordinate(
    value: unknown,
    field: string,
    minimum: number,
    maximum: number,
  ): number {
    if (
      typeof value !== 'number' ||
      !Number.isFinite(value) ||
      value < minimum ||
      value > maximum
    ) {
      throw new BadRequestException(`${field} is invalid`);
    }

    return value;
  }

  private requireSubtotal(value: unknown): number {
    if (
      typeof value !== 'number' ||
      !Number.isFinite(value) ||
      value < 0 ||
      value > 999_999_999.99
    ) {
      throw new BadRequestException('subtotal is invalid');
    }

    return this.roundMoney(value);
  }

  private databaseMoneyToNumber(value: string, field: string): number {
    const normalized = Number(value);

    if (!Number.isFinite(normalized) || normalized < 0) {
      throw new Error(`Invalid ${field} stored in database`);
    }

    return this.roundMoney(normalized);
  }

  private roundMoney(value: number): number {
    return Math.round((value + Number.EPSILON) * 100) / 100;
  }
}
