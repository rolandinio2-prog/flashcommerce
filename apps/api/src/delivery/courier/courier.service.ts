import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import { DatabaseService } from '../../core/database/database.service';
import type { StaffSessionPrincipal } from '../../core/staff/staff.types';
import { DeliveryCheckoutService } from '../delivery-checkout.service';
import { requireCoordinate } from '../delivery-helpers';
import {
  courierFee,
  pickCourierRate,
  type CourierPricingMode,
  type CourierRate,
} from './courier-pricing';

type Db = Pick<DatabaseService, 'query'>;
type Staff = Pick<StaffSessionPrincipal, 'tenantId' | 'branchId'>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function text(value: unknown, field: string, max: number, required = false) {
  if (value === undefined || value === null || value === '') {
    if (required) throw new BadRequestException(`${field} es obligatorio.`);
    return null;
  }
  if (typeof value !== 'string')
    throw new BadRequestException(`${field} no es válido.`);
  const trimmed = value.trim();
  if (required && !trimmed)
    throw new BadRequestException(`${field} es obligatorio.`);
  if (trimmed.length > max)
    throw new BadRequestException(`${field} supera ${max} caracteres.`);
  return trimmed || null;
}
function money(value: unknown, field: string): number {
  const n = typeof value === 'string' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0 || n > 100000)
    throw new BadRequestException(`${field} no es válido.`);
  return Math.round(n * 100) / 100;
}
function optionalId(value: unknown, field: string): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || !UUID.test(value))
    throw new BadRequestException(`${field} no es válido.`);
  return value;
}
function optionalPoint(lat: unknown, lng: unknown, field: string) {
  if ((lat ?? '') === '' && (lng ?? '') === '') return null;
  return {
    latitude: requireCoordinate(lat, `${field}Latitude`, -90, 90),
    longitude: requireCoordinate(lng, `${field}Longitude`, -180, 180),
  };
}

export interface CourierClientInput {
  code?: unknown;
  name?: unknown;
  phone?: unknown;
  taxId?: unknown;
  pickupAddress?: unknown;
  pickupReference?: unknown;
  pickupLatitude?: unknown;
  pickupLongitude?: unknown;
  billingMode?: unknown;
  status?: unknown;
}
export interface CourierRateInput {
  courierClientId?: unknown;
  pricingMode?: unknown;
  baseFee?: unknown;
  perKmFee?: unknown;
  minFee?: unknown;
}
export interface CourierRequestInput {
  courierClientId?: unknown;
  pickupName?: unknown;
  pickupPhone?: unknown;
  pickupAddress?: unknown;
  pickupReference?: unknown;
  pickupLatitude?: unknown;
  pickupLongitude?: unknown;
  recipientName?: unknown;
  recipientPhone?: unknown;
  addressText?: unknown;
  addressReference?: unknown;
  latitude?: unknown;
  longitude?: unknown;
  packageDescription?: unknown;
  collectAmount?: unknown;
  feeOverride?: unknown;
  notes?: unknown;
}

interface ClientRow {
  id: string;
  code: string;
  name: string;
  phone: string | null;
  tax_id: string | null;
  pickup_address: string | null;
  pickup_reference: string | null;
  pickup_latitude: string | null;
  pickup_longitude: string | null;
  billing_mode: string;
  status: string;
}
const CLIENT_COLUMNS =
  'id::text, code, name, phone, tax_id, pickup_address, pickup_reference, pickup_latitude::text, pickup_longitude::text, billing_mode, status';

function clientView(r: ClientRow) {
  return {
    id: r.id,
    code: r.code,
    name: r.name,
    phone: r.phone,
    taxId: r.tax_id,
    pickupAddress: r.pickup_address,
    pickupReference: r.pickup_reference,
    pickupLatitude:
      r.pickup_latitude === null ? null : Number(r.pickup_latitude),
    pickupLongitude:
      r.pickup_longitude === null ? null : Number(r.pickup_longitude),
    billingMode: r.billing_mode,
    status: r.status,
  };
}

/**
 * FlashCommerce Delivery (standalone): courier clients, rates and manual
 * delivery requests. A request is stored as a DELIVERY order with origin
 * COURIER_REQUEST and no items, so the existing dispatch, driver, POD and
 * tracking flows handle it unchanged.
 */
@Injectable()
export class CourierService {
  constructor(
    private readonly databaseService: DatabaseService,
    private readonly deliveryCheckout: DeliveryCheckoutService,
  ) {}

  private async assertDeliveryProduct(db: Db, staff: Staff) {
    const r = await db.query<{ ok: boolean }>(
      "select exists(select 1 from public.tenant_products where tenant_id=$1::uuid and product='DELIVERY' and status='ACTIVE') as ok",
      [staff.tenantId],
    );
    if (!r.rows[0]?.ok)
      throw new ForbiddenException(
        'El producto Delivery no está activo para este negocio.',
      );
  }

  // ---------------- clients ----------------

  async listClients(staff: Staff) {
    await this.assertDeliveryProduct(this.databaseService, staff);
    const r = await this.databaseService.query<ClientRow>(
      `select ${CLIENT_COLUMNS} from public.courier_clients where tenant_id=$1::uuid order by status, name`,
      [staff.tenantId],
    );
    return { clients: r.rows.map(clientView) };
  }

  private clientFields(input: CourierClientInput, creating: boolean) {
    const billing = input.billingMode ?? (creating ? 'PER_DELIVERY' : null);
    if (
      billing !== null &&
      !['PER_DELIVERY', 'PERIODIC'].includes(billing as string)
    )
      throw new BadRequestException('billingMode no es válido.');
    const status = input.status ?? (creating ? 'ACTIVE' : null);
    if (status !== null && !['ACTIVE', 'INACTIVE'].includes(status as string))
      throw new BadRequestException('status no es válido.');
    const code = text(input.code, 'code', 32, creating);
    if (code !== null && !/^[A-Za-z0-9_-]+$/.test(code))
      throw new BadRequestException(
        'code solo admite letras, números, guion y guion bajo.',
      );
    return {
      code: code?.toUpperCase() ?? null,
      name: text(input.name, 'name', 120, creating),
      phone: text(input.phone, 'phone', 32),
      taxId: text(input.taxId, 'taxId', 32),
      pickupAddress: text(input.pickupAddress, 'pickupAddress', 500),
      pickupReference: text(input.pickupReference, 'pickupReference', 500),
      pickup: optionalPoint(
        input.pickupLatitude,
        input.pickupLongitude,
        'pickup',
      ),
      billing: billing as string | null,
      status: status as string | null,
    };
  }

  async createClient(staff: Staff, input: CourierClientInput) {
    await this.assertDeliveryProduct(this.databaseService, staff);
    const f = this.clientFields(input ?? {}, true);
    try {
      const r = await this.databaseService.query<ClientRow>(
        `insert into public.courier_clients (tenant_id, code, name, phone, tax_id, pickup_address, pickup_reference, pickup_latitude, pickup_longitude, billing_mode, status)
         values ($1::uuid,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) returning ${CLIENT_COLUMNS}`,
        [
          staff.tenantId,
          f.code,
          f.name,
          f.phone,
          f.taxId,
          f.pickupAddress,
          f.pickupReference,
          f.pickup?.latitude ?? null,
          f.pickup?.longitude ?? null,
          f.billing,
          f.status,
        ],
      );
      return clientView(r.rows[0]);
    } catch (error) {
      if ((error as { code?: string }).code === '23505')
        throw new ConflictException('Ya existe un cliente con ese código.');
      throw error;
    }
  }

  async updateClient(
    staff: Staff,
    clientId: string,
    input: CourierClientInput,
  ) {
    await this.assertDeliveryProduct(this.databaseService, staff);
    const id = optionalId(clientId, 'clientId');
    const f = this.clientFields(input ?? {}, false);
    const pickupGiven =
      input?.pickupLatitude !== undefined ||
      input?.pickupLongitude !== undefined;
    const r = await this.databaseService.query<ClientRow>(
      `update public.courier_clients set
         name=coalesce($3,name), phone=case when $4::boolean then $5 else phone end,
         tax_id=case when $6::boolean then $7 else tax_id end,
         pickup_address=case when $8::boolean then $9 else pickup_address end,
         pickup_reference=case when $10::boolean then $11 else pickup_reference end,
         pickup_latitude=case when $12::boolean then $13::numeric else pickup_latitude end,
         pickup_longitude=case when $12::boolean then $14::numeric else pickup_longitude end,
         billing_mode=coalesce($15,billing_mode), status=coalesce($16,status)
       where tenant_id=$1::uuid and id=$2::uuid returning ${CLIENT_COLUMNS}`,
      [
        staff.tenantId,
        id,
        f.name,
        input?.phone !== undefined,
        f.phone,
        input?.taxId !== undefined,
        f.taxId,
        input?.pickupAddress !== undefined,
        f.pickupAddress,
        input?.pickupReference !== undefined,
        f.pickupReference,
        pickupGiven,
        f.pickup?.latitude ?? null,
        f.pickup?.longitude ?? null,
        f.billing,
        f.status,
      ],
    );
    if (!r.rows[0]) throw new NotFoundException('Cliente no encontrado.');
    return clientView(r.rows[0]);
  }

  // ---------------- rates ----------------

  private async loadRates(db: Db, tenantId: string) {
    const r = await db.query<{
      courier_client_id: string | null;
      pricing_mode: CourierPricingMode;
      base_fee: string;
      per_km_fee: string;
      min_fee: string;
    }>(
      'select courier_client_id::text, pricing_mode, base_fee::text, per_km_fee::text, min_fee::text from public.courier_rates where tenant_id=$1::uuid',
      [tenantId],
    );
    return r.rows.map((x) => ({
      courierClientId: x.courier_client_id,
      pricingMode: x.pricing_mode,
      baseFee: Number(x.base_fee),
      perKmFee: Number(x.per_km_fee),
      minFee: Number(x.min_fee),
    }));
  }

  async listRates(staff: Staff) {
    await this.assertDeliveryProduct(this.databaseService, staff);
    return {
      rates: await this.loadRates(this.databaseService, staff.tenantId),
    };
  }

  async setRate(staff: Staff, input: CourierRateInput) {
    await this.assertDeliveryProduct(this.databaseService, staff);
    const clientId = optionalId(input?.courierClientId, 'courierClientId');
    const mode = input?.pricingMode;
    if (mode !== 'ZONE' && mode !== 'DISTANCE')
      throw new BadRequestException('pricingMode debe ser ZONE o DISTANCE.');
    const rate: CourierRate = {
      pricingMode: mode,
      baseFee: money(input.baseFee ?? 0, 'baseFee'),
      perKmFee: money(input.perKmFee ?? 0, 'perKmFee'),
      minFee: money(input.minFee ?? 0, 'minFee'),
    };
    return this.databaseService.withTransaction(async (client) => {
      if (clientId) {
        const c = await client.query(
          'select 1 from public.courier_clients where tenant_id=$1::uuid and id=$2::uuid',
          [staff.tenantId, clientId],
        );
        if (!c.rowCount) throw new NotFoundException('Cliente no encontrado.');
      }
      await client.query(
        `delete from public.courier_rates where tenant_id=$1::uuid and courier_client_id is not distinct from $2::uuid`,
        [staff.tenantId, clientId],
      );
      await client.query(
        `insert into public.courier_rates (tenant_id, courier_client_id, pricing_mode, base_fee, per_km_fee, min_fee)
         values ($1::uuid,$2::uuid,$3,$4,$5,$6)`,
        [
          staff.tenantId,
          clientId,
          rate.pricingMode,
          rate.baseFee,
          rate.perKmFee,
          rate.minFee,
        ],
      );
      return { courierClientId: clientId, ...rate };
    });
  }

  // ---------------- quote + request ----------------

  private async quoteWith(
    db: Db,
    staff: Staff,
    courierClientId: string | null,
    pickup: { latitude: number; longitude: number } | null,
    destination: { latitude: number; longitude: number },
  ) {
    const branch = await db.query<{
      delivery_enabled: boolean;
      lat: string | null;
      lng: string | null;
    }>(
      'select delivery_enabled, delivery_origin_latitude::text as lat, delivery_origin_longitude::text as lng from public.branches where tenant_id=$1::uuid and id=$2::uuid',
      [staff.tenantId, staff.branchId],
    );
    const b = branch.rows[0];
    if (!b?.delivery_enabled)
      throw new ConflictException(
        'Delivery no está habilitado en esta sucursal.',
      );
    const origin =
      pickup ??
      (b.lat !== null && b.lng !== null
        ? { latitude: Number(b.lat), longitude: Number(b.lng) }
        : null);
    if (!origin)
      throw new BadRequestException(
        'Indica el punto de recogida (la sucursal no tiene ubicación).',
      );
    const zone = await db.query<{
      id: string;
      code: string;
      name: string;
      delivery_fee: string;
      eta_min_minutes: number;
      eta_max_minutes: number;
      distance_meters: number;
    }>(
      `select z.id::text, z.code, z.name, z.delivery_fee::text, z.eta_min_minutes, z.eta_max_minutes,
              round(gis.ST_Distance(
                gis.ST_SetSRID(gis.ST_MakePoint($3::double precision,$4::double precision),4326)::gis.geography,
                gis.ST_SetSRID(gis.ST_MakePoint($5::double precision,$6::double precision),4326)::gis.geography))::integer as distance_meters
         from public.delivery_zones z
        where z.tenant_id=$1::uuid and z.branch_id=$2::uuid and z.status='ACTIVE'
          and gis.ST_Covers(z.area, gis.ST_SetSRID(gis.ST_MakePoint($5::double precision,$6::double precision),4326))
        order by z.priority asc, z.code asc, z.id asc limit 1`,
      [
        staff.tenantId,
        staff.branchId,
        origin.longitude,
        origin.latitude,
        destination.longitude,
        destination.latitude,
      ],
    );
    const z = zone.rows[0];
    if (!z)
      throw new ConflictException(
        'El destino está fuera de la zona de cobertura.',
      );
    const rates = await this.loadRates(db, staff.tenantId);
    const rate = pickCourierRate(rates, courierClientId);
    const fee = courierFee(rate, Number(z.delivery_fee), z.distance_meters);
    return {
      zone: { id: z.id, code: z.code, name: z.name },
      distanceMeters: z.distance_meters,
      eta: { minMinutes: z.eta_min_minutes, maxMinutes: z.eta_max_minutes },
      pricingMode: rate?.pricingMode ?? 'ZONE',
      fee,
    };
  }

  async quote(staff: Staff, input: CourierRequestInput) {
    await this.assertDeliveryProduct(this.databaseService, staff);
    const clientId = optionalId(input?.courierClientId, 'courierClientId');
    const pickup = optionalPoint(
      input?.pickupLatitude,
      input?.pickupLongitude,
      'pickup',
    );
    const destination = {
      latitude: requireCoordinate(input?.latitude, 'latitude', -90, 90),
      longitude: requireCoordinate(input?.longitude, 'longitude', -180, 180),
    };
    const q = await this.quoteWith(
      this.databaseService,
      staff,
      clientId,
      pickup,
      destination,
    );
    return { ...q, zone: { code: q.zone.code, name: q.zone.name } };
  }

  async createRequest(staff: Staff, input: CourierRequestInput) {
    const body = input ?? {};
    const clientId = optionalId(body.courierClientId, 'courierClientId');
    const recipientName = text(body.recipientName, 'recipientName', 120, true)!;
    const recipientPhone = text(
      body.recipientPhone,
      'recipientPhone',
      32,
      true,
    )!;
    const addressText = text(body.addressText, 'addressText', 500, true)!;
    const addressReference = text(
      body.addressReference,
      'addressReference',
      500,
    );
    const destination = {
      latitude: requireCoordinate(body.latitude, 'latitude', -90, 90),
      longitude: requireCoordinate(body.longitude, 'longitude', -180, 180),
    };
    const collectAmount = money(body.collectAmount ?? 0, 'collectAmount');
    if (collectAmount > 0)
      throw new ConflictException(
        'El cobro contra entrega para envíos llega en la siguiente fase. Registra el envío sin monto a cobrar.',
      );
    const feeOverride =
      body.feeOverride === undefined ||
      body.feeOverride === null ||
      body.feeOverride === ''
        ? null
        : money(body.feeOverride, 'feeOverride');
    const packageDescription = text(
      body.packageDescription,
      'packageDescription',
      500,
    );
    const notes = text(body.notes, 'notes', 500);

    return this.databaseService.withTransaction(async (client) => {
      await this.assertDeliveryProduct(client, staff);
      let courier: ClientRow | null = null;
      if (clientId) {
        const c = await client.query<ClientRow>(
          `select ${CLIENT_COLUMNS} from public.courier_clients where tenant_id=$1::uuid and id=$2::uuid`,
          [staff.tenantId, clientId],
        );
        courier = c.rows[0] ?? null;
        if (!courier) throw new NotFoundException('Cliente no encontrado.');
        if (courier.status !== 'ACTIVE')
          throw new ConflictException('El cliente está inactivo.');
      }
      const pickup =
        optionalPoint(body.pickupLatitude, body.pickupLongitude, 'pickup') ??
        (courier?.pickup_latitude && courier.pickup_longitude
          ? {
              latitude: Number(courier.pickup_latitude),
              longitude: Number(courier.pickup_longitude),
            }
          : null);
      const pickupName =
        text(body.pickupName, 'pickupName', 120) ?? courier?.name ?? null;
      const pickupPhone =
        text(body.pickupPhone, 'pickupPhone', 32) ?? courier?.phone ?? null;
      const pickupAddress =
        text(body.pickupAddress, 'pickupAddress', 500) ??
        courier?.pickup_address ??
        null;
      const pickupReference =
        text(body.pickupReference, 'pickupReference', 500) ??
        courier?.pickup_reference ??
        null;

      const q = await this.quoteWith(
        client,
        staff,
        clientId,
        pickup,
        destination,
      );
      const fee = feeOverride ?? q.fee;

      const order = await client.query<{
        id: string;
        order_number: string;
        tracking_token: string;
      }>(
        `insert into public.orders (tenant_id, branch_id, order_type, status, payment_status, order_origin, currency,
                                    subtotal, discount_total, delivery_fee, total, customer_name, customer_phone, delivery_address, customer_notes)
         values ($1::uuid,$2::uuid,'DELIVERY','CONFIRMED','NOT_REQUIRED','COURIER_REQUEST','BOB',0,0,0,0,$3,$4,$5,$6)
         returning id::text, order_number::text, tracking_token::text`,
        [
          staff.tenantId,
          staff.branchId,
          recipientName,
          recipientPhone,
          addressText,
          notes,
        ],
      );
      const o = order.rows[0];
      const delivery = await this.deliveryCheckout.createDeliveryForOrder(
        client,
        {
          tenantId: staff.tenantId,
          branchId: staff.branchId,
          orderId: o.id,
          quote: {
            zoneId: q.zone.id,
            zone: { code: q.zone.code, name: q.zone.name },
            deliveryFee: fee,
            minimumOrder: 0,
            route: { distanceMeters: q.distanceMeters, durationSeconds: 0 },
            eta: q.eta,
          },
          recipientName,
          recipientPhone,
          addressText,
          addressReference,
          latitude: destination.latitude,
          longitude: destination.longitude,
        },
      );
      await client.query(
        `update public.deliveries set courier_client_id=$3::uuid, pickup_name=$4, pickup_phone=$5, pickup_address=$6,
                pickup_reference=$7, pickup_latitude=$8, pickup_longitude=$9, package_description=$10, collect_amount=0
          where tenant_id=$1::uuid and id=$2::uuid`,
        [
          staff.tenantId,
          delivery.id,
          clientId,
          pickupName,
          pickupPhone,
          pickupAddress,
          pickupReference,
          pickup?.latitude ?? null,
          pickup?.longitude ?? null,
          packageDescription,
        ],
      );
      // No kitchen: the request is ready for dispatch immediately (fires auto-dispatch).
      await client.query(
        "update public.orders set status='READY' where tenant_id=$1::uuid and id=$2::uuid",
        [staff.tenantId, o.id],
      );
      return {
        orderId: o.id,
        orderNumber: Number(o.order_number),
        trackingToken: o.tracking_token,
        deliveryId: delivery.id,
        zone: { code: q.zone.code, name: q.zone.name },
        distanceMeters: q.distanceMeters,
        fee,
        eta: q.eta,
      };
    });
  }

  async listRequests(staff: Staff, limitInput?: unknown) {
    await this.assertDeliveryProduct(this.databaseService, staff);
    const limit = Math.min(Math.max(Number(limitInput) || 50, 1), 200);
    const r = await this.databaseService.query<{
      order_number: string;
      tracking_token: string;
      delivery_id: string;
      delivery_status: string;
      client_name: string | null;
      recipient_name: string;
      address_text: string;
      fee: string;
      collect_amount: string;
      created_at: string;
    }>(
      `select o.order_number::text, o.tracking_token::text, d.id::text as delivery_id, d.status as delivery_status,
              c.name as client_name, d.recipient_name, d.address_text, d.quoted_delivery_fee::text as fee,
              d.collect_amount::text, d.created_at::text
         from public.deliveries d
         join public.orders o on o.tenant_id=d.tenant_id and o.branch_id=d.branch_id and o.id=d.order_id
         left join public.courier_clients c on c.tenant_id=d.tenant_id and c.id=d.courier_client_id
        where d.tenant_id=$1::uuid and d.branch_id=$2::uuid and o.order_origin='COURIER_REQUEST'
        order by d.created_at desc limit $3`,
      [staff.tenantId, staff.branchId, limit],
    );
    return {
      requests: r.rows.map((x) => ({
        orderNumber: Number(x.order_number),
        trackingToken: x.tracking_token,
        deliveryId: x.delivery_id,
        deliveryStatus: x.delivery_status,
        clientName: x.client_name,
        recipientName: x.recipient_name,
        addressText: x.address_text,
        fee: Number(x.fee),
        collectAmount: Number(x.collect_amount),
        createdAt: x.created_at,
      })),
    };
  }
}
