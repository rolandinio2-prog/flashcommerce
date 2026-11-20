import { posCartRevision } from './pos-cart-revision';
import { assertPosCartAccess } from './pos-cart-access';
import { normalizePosCheckout, type PosCheckoutInput } from './pos-checkout';
import { assertDeliveryQrPaid } from '../payments/delivery-payment-policy';
import { lockBranchAdmission } from '../branch-operations/service-policy';
import type { StaffSessionPrincipal } from '../staff/staff.types';
import { sauceOrderItems } from '../cart/sauce-pricing';
import { prepareRiceItems } from '../cart/rice-choice';
import { recoveryPhone, recoveryPhoneAliases, sameRecoveryPhone, RECOVERY_PAGE_SIZE, RECOVERY_UUID } from './recovery-access';
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
import { issueQuote, requireQuoteToken, verifyQuote } from './checkout-quote';
import { DatabaseService } from '../database/database.service';
import { DeliveryService } from '../delivery/delivery.service';
import type {
  CreatedDelivery,
  DeliveryCheckoutQuote,
  DeliveryCheckoutRouteSnapshot,
} from '../delivery/delivery.types';
import {
  type TableContextPayload,
  verifyTableContextToken,
} from '../tables/table-context-token';

// =========================================================
// ORDER TYPES
// =========================================================

type OrderType = 'DINE_IN' | 'TAKEAWAY' | 'PICKUP' | 'DELIVERY';

// =========================================================
// DATOS PARA CREAR UN PEDIDO
//
// Este contrato también es utilizado por OrderController.
// Los campos de fulfillment siguen siendo opcionales en V0.1.
// =========================================================

export interface CreateOrderInput {
  requireRecoveryProfile?: boolean;
  deliveryQuoteToken?: string;
  cartToken?: string;
  orderType?: string;

  scheduledFor?: string;

  customerName?: string;
  customerPhone?: string;

  tableCode?: string;
  tableContextToken?: string;
  reservationTrackingToken?: string;
  additionalToTrackingToken?: string;

  deliveryAddress?: string;
  deliveryLatitude?: unknown;
  deliveryLongitude?: unknown;
  deliveryReference?: string;

  customerNotes?: string;
}

export interface CustomerRecoveryEnrollInput {
  trackingToken?: string;
  phone?: string;
  pin?: string;
}

export interface CustomerRecoveryLoginInput {
  tenantCode?: string;
  phone?: string;
  pin?: string;
}

// =========================================================
// ORDER STATUS
// =========================================================

type OrderStatus =
  'PENDING' | 'CONFIRMED' | 'PREPARING' | 'READY' | 'COMPLETED' | 'CANCELLED';

type OrderPaymentStatus =
  | 'NOT_REQUIRED'
  | 'PENDING'
  | 'AWAITING_CONFIRMATION'
  | 'PAID'
  | 'FAILED'
  | 'EXPIRED'
  | 'CANCELLED'
  | 'REFUND_PENDING'
  | 'REFUNDED'
  | 'REVIEW_REQUIRED';

type OrderOrigin =
  | 'LEGACY'
  | 'PUBLIC_MENU'
  | 'TABLE_QR'
  | 'BRANCH_QR'
  | 'OPS_STAFF'
  | 'RESERVATION_PREORDER'
  | 'RESERVATION_CHECKIN';

const ORDER_STATUS_TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  PENDING: ['CONFIRMED', 'CANCELLED'],
  CONFIRMED: ['PREPARING', 'CANCELLED'],
  PREPARING: ['READY'],
  READY: ['COMPLETED'],
  COMPLETED: [],
  CANCELLED: [],
};

const ORDER_TYPES: OrderType[] = ['DINE_IN', 'TAKEAWAY', 'PICKUP', 'DELIVERY'];

// =========================================================
// DATABASE ROW TYPES
// =========================================================

interface CartRow {
  id: string;
  tenant_id: string;
  branch_id: string;
  status: string;
  currency: string;
  expires_at: string | Date;
  tenant_code: string;
  branch_code: string;
}

interface CheckoutItemRow {
  sauce_included_quantity: number | null;
  rice_choice: string;
  requires_rice: boolean;
  product_id: string;
  sku: string | null;
  name: string;
  quantity: number;
  price: string | null;
  currency: string | null;
  is_available: boolean | null;
  available_quantity: number | null;
}

interface CreatedOrderRow {
  id: string;
  order_number: string;
  tracking_token: string;
  order_group_id: string | null;

  order_type: OrderType;
  status: OrderStatus;
  payment_status: OrderPaymentStatus;
  order_origin: OrderOrigin;
  currency: string;

  subtotal: string;
  discount_total: string;
  delivery_fee: string;
  total: string;

  // Fulfillment V0.1
  scheduled_for: string | Date | null;
  customer_name: string | null;
  customer_phone: string | null;
  table_code: string | null;
  delivery_address: string | null;
  customer_notes: string | null;

  reservation_id: string | null;

  created_at: string | Date;
}

interface TrackingOrderRow {
  id: string;
  order_number: string;
  tracking_token: string;
  order_group_id: string | null;
  order_type: OrderType;
  status: OrderStatus;
  payment_status: OrderPaymentStatus;
  order_origin: OrderOrigin;
  currency: string;

  subtotal: string;
  discount_total: string;
  delivery_fee: string;
  total: string;

  scheduled_for: string | Date | null;
  customer_name: string | null;
  customer_phone: string | null;
  table_code: string | null;
  delivery_address: string | null;
  customer_notes: string | null;

  reservation_id: string | null;
  reservation_code: string | null;
  reservation_reserved_for: string | Date | null;

  created_at: string | Date;

  tenant_code: string;
  tenant_name: string;

  branch_code: string;
  branch_name: string;
}

interface TrackingItemRow {
  product_id: string | null;
  sku_snapshot: string | null;
  name_snapshot: string;
  quantity: number;
  unit_price: string;
  line_total: string;
  currency: string;
}

interface TrackingHistoryRow {
  status: OrderStatus;
  changed_at: string | Date;
}

interface OpsOrderRow {
  id: string;
  order_number: string;
  tracking_token: string;
  order_type: OrderType;
  status: OrderStatus;
  payment_status: OrderPaymentStatus;
  order_origin: OrderOrigin;
  currency: string;
  total: string;

  // =======================================================
  // FULFILLMENT PARA KDS
  // =======================================================

  scheduled_for: string | Date | null;
  customer_name: string | null;
  customer_phone: string | null;
  table_code: string | null;
  delivery_address: string | null;
  customer_notes: string | null;

  reservation_id: string | null;
  reservation_code: string | null;
  reservation_reserved_for: string | Date | null;

  // =======================================================
  // TABLES V0.3 PARA KDS
  // =======================================================

  table_session_id: string | null;

  table_session_status: 'OPEN' | 'CLOSED' | null;

  table_session_closed_at: string | Date | null;

  operational_delivery_id: string | null;
  operational_delivery_status: string | null;
  operational_assignment_id: string | null;
  operational_assignment_status: string | null;
  operational_assignment_accepted_at: string | Date | null;
  operational_driver_id: string | null;
  operational_driver_code: string | null;
  operational_driver_name: string | null;

  operational_delivery_role:
    | 'PRIMARY'
    | 'ADDITIONAL'
    | null;

  operational_delivery_member_count: number | null;

  created_at: string | Date;
  updated_at: string | Date;

  items: Array<{
    productId: string | null;
    sku: string | null;
    name: string;
    quantity: number;
    unitPrice: number;
    lineTotal: number;
  }>;
}

// =========================================================
// TABLES V0.2
// Tipos internos utilizados durante checkout DINE_IN.
//
// IMPORTANTE:
// Estas interfaces deben estar FUERA de OpsOrderRow.
// =========================================================

interface CheckoutDiningTableRow {
  id: string;
  code: string;
  name: string;
  is_active: boolean;
}

interface OpenTableSessionRow {
  id: string;
}

interface AdditionalOrderContextRow {
  id: string;
  order_group_id: string;
  table_session_id: string;
  table_code: string;
}

interface AdditionalDeliveryPreflightRow {
  tenant_id: string;
  branch_id: string;
  order_id: string;
  order_group_id: string;

  customer_name: string | null;
  customer_phone: string | null;

  delivery_id: string;
  delivery_tracking_token: string;
  delivery_status: string;

  address_text: string;
  address_reference: string | null;

  destination_latitude: string;
  destination_longitude: string;
}

interface AdditionalDeliveryOrderContextRow
  extends AdditionalDeliveryPreflightRow {
  has_active_assignment: boolean;
}

interface CreatedTableSessionRow {
  id: string;
}

interface ReservationOrderContextRow {
  id: string;
  reservation_code: string;
  tracking_token: string;
  status: 'PENDING' | 'CONFIRMED';
  reserved_for: string | Date;
  reserved_until: string | Date;
  customer_name: string;
  customer_phone: string;
  table_id: string;
  table_code: string;
  table_name: string;
  table_is_active: boolean;
}

// =========================================================
// TABLES V0.3
// Tipos utilizados para cerrar una sesión desde Operaciones.
// =========================================================

interface CloseTableOrderRow {
  id: string;
  order_number: string;
  order_type: OrderType;

  tenant_id: string;
  branch_id: string;

  table_session_id: string | null;
}

interface CloseTableSessionRow {
  id: string;
  status: 'OPEN' | 'CLOSED';

  table_id: string;
  table_code: string;
  table_name: string;
}

interface ClosedTableSessionRow {
  id: string;
  status: 'OPEN' | 'CLOSED';

  closed_at: string | Date;
  updated_at: string | Date;
}

@Injectable()
export class OrderService {
  constructor(
    private readonly databaseService: DatabaseService,
    private readonly deliveryService: DeliveryService,
  ) {}

  // =======================================================
  // 1. CREAR PEDIDO
  //
  // Convierte un carrito OPEN en una Order PENDING.
  // También guarda los datos de Fulfillment V0.1.
  // =======================================================

  async quoteDelivery(input: CreateOrderInput) {
    if (input.orderType !== 'DELIVERY') throw new BadRequestException('Solo se cotizan envíos DELIVERY.');
    const result = await this.checkout(input, undefined, true);
    if (result.kind !== 'quote') throw new Error('Quote invariant failed');
    return result.quote;
  }

  async createOrder(input: CreateOrderInput, customerRecoverySessionToken?: string | null) {
    const result = await this.checkout(input, customerRecoverySessionToken, false);
    if (result.kind !== 'order') throw new Error('Order invariant failed');
    return result.order;
  }

  async createPosOrder(input:PosCheckoutInput,staff:StaffSessionPrincipal):Promise<unknown> {
    const value=normalizePosCheckout(input);
    const replay=async()=>{
      const result=await this.databaseService.query<{order_id:string;tracking_token:string;checkout_hash:string}>('select o.id::text as order_id,o.tracking_token::text,d.checkout_hash from public.pos_drafts d join public.carts c on c.id=d.cart_id join public.orders o on o.id=d.order_id where c.cart_token=$1::uuid and d.tenant_id=$2::uuid and d.branch_id=$3::uuid and d.staff_user_id=$4::uuid',[value.cartToken,staff.tenantId,staff.branchId,staff.userId]);
      const row=result.rows[0];if(!row)return null;
      if(row.checkout_hash!==value.intentHash)throw new ConflictException('El pedido ya fue creado con otros datos.');
      return {...await this.getOrderTracking(row.tracking_token),id:row.order_id};
    };
    const saved=await replay();if(saved)return saved;
    try {
      const result=await this.checkout(value,undefined,false,{staff,intentHash:value.intentHash,expectedTotal:value.expectedTotal,expectedRevision:value.expectedRevision});
      if(result.kind!=='order')throw new Error('POS invariant');return result.order;
    } catch(error){
      // Only read a committed concurrent result; never retry checkout writes.
      if(error instanceof ConflictException){const saved=await replay();if(saved)return saved;}
      throw error;
    }
  }

  private async checkout(input: CreateOrderInput, customerRecoverySessionToken: string | null | undefined, quoteOnly: boolean,pos?:{staff:StaffSessionPrincipal;intentHash:string;expectedTotal:number;expectedRevision:string}) {
    // Quote mode must never enter reservation/table-session mutation paths.
    if (quoteOnly && (input.orderType !== 'DELIVERY' || input.tableCode || input.tableContextToken || input.reservationTrackingToken)) {
      throw new BadRequestException('Contexto no válido para cotizar un envío.');
    }
    if (input.orderType === 'DELIVERY' && !quoteOnly) requireQuoteToken(input.deliveryQuoteToken);
    if (typeof input.cartToken !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.cartToken.trim())) {
      throw new BadRequestException('cartToken must be a valid UUID');
    }
    const customerRecoverySession =
      customerRecoverySessionToken
        ? await this.findCustomerRecoverySessionByToken(
            customerRecoverySessionToken,
          )
        : null;
    // ----------------------------------------------------
    // 1.1. Extraer y normalizar datos del request.
    // ----------------------------------------------------

    const cartToken = input.cartToken;

    const requestedOrderType = input.orderType;

    let customerName = input.customerName?.trim() || null;

    let customerPhone = input.customerPhone?.trim() || null;

    let tableCode = input.tableCode?.trim() || null;

    const tableContextToken = input.tableContextToken?.trim() || null;

    const reservationTrackingToken =
      input.reservationTrackingToken?.trim() || null;

    const additionalToTrackingToken =
      input.additionalToTrackingToken?.trim() || null;

    let deliveryAddress = input.deliveryAddress?.trim() || null;

    let deliveryReference = input.deliveryReference?.trim() || null;

    let deliveryLatitude = input.deliveryLatitude;

    let deliveryLongitude = input.deliveryLongitude;

    // DELIVERY ADDITIONAL V1
    //
    // A missing destination means "reuse the source Delivery".
    // If any destination component is supplied, it is treated
    // as an explicit requested destination and must not be
    // silently overwritten by the source order.
    const hasRequestedDeliveryDestination =
      deliveryAddress !== null ||
      deliveryReference !== null ||
      (
        deliveryLatitude !== undefined &&
        deliveryLatitude !== null &&
        deliveryLatitude !== ''
      ) ||
      (
        deliveryLongitude !== undefined &&
        deliveryLongitude !== null &&
        deliveryLongitude !== ''
      );

    const customerNotes = input.customerNotes?.trim() || null;

    // ----------------------------------------------------
    // 1.2. Normalizar scheduledFor.
    // ----------------------------------------------------

    let scheduledFor: string | null = null;

    if (input.scheduledFor?.trim()) {
      const parsedScheduledFor = new Date(input.scheduledFor);

      if (Number.isNaN(parsedScheduledFor.getTime())) {
        throw new BadRequestException('scheduledFor must be a valid date-time');
      }

      scheduledFor = parsedScheduledFor.toISOString();
    }

    // ----------------------------------------------------
    // 1.3. Validaciones generales.
    // ----------------------------------------------------

    if (!cartToken?.trim()) {
      throw new BadRequestException('cartToken is required');
    }

    if (!requestedOrderType?.trim()) {
      throw new BadRequestException('orderType is required');
    }

    const orderType = requestedOrderType.trim() as OrderType;

    if (!ORDER_TYPES.includes(orderType)) {
      throw new BadRequestException('Invalid orderType');
    }

    let tableContext: TableContextPayload | null = null;

    if (tableContextToken) {
      if (orderType !== 'DINE_IN') {
        throw new BadRequestException(
          'tableContextToken is only valid for DINE_IN orders',
        );
      }

      tableContext = verifyTableContextToken(tableContextToken);

      if (!tableContext) {
        throw new BadRequestException(
          'tableContextToken is invalid or expired',
        );
      }

      if (tableCode && tableCode !== tableContext.tableCode) {
        throw new BadRequestException(
          'tableCode does not match tableContextToken',
        );
      }

      tableCode = tableContext.tableCode;
    }

    if (reservationTrackingToken) {
      if (orderType !== 'DINE_IN') {
        throw new BadRequestException(
          'reservationTrackingToken is only valid for DINE_IN orders',
        );
      }

      if (tableContextToken) {
        throw new BadRequestException(
          'reservationTrackingToken cannot be combined with tableContextToken',
        );
      }
    }

    if (additionalToTrackingToken) {
      if (
        orderType !== 'DINE_IN' &&
        orderType !== 'DELIVERY'
      ) {
        throw new BadRequestException(
          'additionalToTrackingToken is only valid for DINE_IN or DELIVERY orders',
        );
      }

      if (
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
          additionalToTrackingToken,
        )
      ) {
        throw new BadRequestException(
          'additionalToTrackingToken must be a valid UUID',
        );
      }

      if (reservationTrackingToken) {
        throw new BadRequestException(
          'additionalToTrackingToken cannot be combined with reservationTrackingToken',
        );
      }
    }

    // ----------------------------------------------------
    // 1.4. VALIDACIONES POR MODALIDAD
    //
    // Estas reglas deben existir en backend aunque
    // el frontend también haga sus propias validaciones.
    // ----------------------------------------------------

    switch (orderType) {
      // ==================================================
      // DINE_IN
      // ==================================================

      case 'DINE_IN': {
        // La mesa es opcional. Si el cliente la selecciona,
        // se validará y ocupará dentro de la transacción.
        break;
      }

      // ==================================================
      // TAKEAWAY
      //
      // Por ahora no requiere datos adicionales.
      // ==================================================

      case 'TAKEAWAY': {
        if (!pos && !customerName) throw new BadRequestException('customerName is required for TAKEAWAY');
        if (!pos && (!customerPhone || !/^[0-9]{7,15}$/.test(customerPhone.replace(/\D/g, '')))) throw new BadRequestException('A valid customerPhone is required for TAKEAWAY');
        break;
      }

      // ==================================================
      // PICKUP
      // ==================================================

      case 'PICKUP': {
        if (!scheduledFor) {
          throw new BadRequestException('scheduledFor is required for PICKUP');
        }

        if (new Date(scheduledFor).getTime() <= Date.now()) {
          throw new BadRequestException(
            'scheduledFor must be in the future for PICKUP',
          );
        }

        if (!customerName) {
          throw new BadRequestException('customerName is required for PICKUP');
        }

        if (!customerPhone) {
          throw new BadRequestException('customerPhone is required for PICKUP');
        }

        break;
      }

      // ==================================================
      // DELIVERY
      // ==================================================

      case 'DELIVERY': {
        if (!additionalToTrackingToken) {
          if (!customerName) {
            throw new BadRequestException(
              'customerName is required for DELIVERY',
            );
          }

          if (!customerPhone) {
            throw new BadRequestException(
              'customerPhone is required for DELIVERY',
            );
          }

          if (!deliveryAddress) {
            throw new BadRequestException(
              'deliveryAddress is required for DELIVERY',
            );
          }
        }

        break;
      }
    }
    // ----------------------------------------------------
    // 1.5. Transacción de checkout.
    // ----------------------------------------------------

    let additionalDeliveryPreflight:
      AdditionalDeliveryPreflightRow | null =
      null;

    if (
      orderType === 'DELIVERY' &&
      additionalToTrackingToken
    ) {
      const sourceResult =
        await this.databaseService.query<AdditionalDeliveryPreflightRow>(
          `
            select
              o.tenant_id::text,
              o.branch_id::text,
              o.id::text as order_id,
              o.order_group_id::text,

              o.customer_name,
              o.customer_phone,

              d.id::text as delivery_id,
              d.tracking_token::text as delivery_tracking_token,
              d.status as delivery_status,

              d.address_text,
              d.address_reference,

              gis.ST_Y(d.destination::gis.geometry)::text
                as destination_latitude,

              gis.ST_X(d.destination::gis.geometry)::text
                as destination_longitude

            from public.orders o

            inner join public.delivery_order_memberships m
              on m.tenant_id = o.tenant_id
             and m.branch_id = o.branch_id
             and m.order_id = o.id
             and m.membership_status = 'ACTIVE'

            inner join public.deliveries d
              on d.tenant_id = m.tenant_id
             and d.branch_id = m.branch_id
             and d.id = m.delivery_id

            where o.tracking_token = $1::uuid
              and exists (
                select 1 from public.carts source_cart
                where source_cart.cart_token = $2::uuid
                  and source_cart.tenant_id = o.tenant_id
                  and source_cart.branch_id = o.branch_id
              )
              and o.order_type = 'DELIVERY'
              and (
                o.payment_status in (
                  'PAID',
                  'NOT_REQUIRED'
                )
                or (
                  m.role = 'PRIMARY'
                  and o.payment_status =
                    'AWAITING_CONFIRMATION'
                  and exists (
                    select 1

                    from public.order_payments p

                    where p.tenant_id = o.tenant_id
                      and p.branch_id = o.branch_id
                      and p.order_id = o.id
                      and p.method = 'CASH'
                      and p.provider = 'DRIVER_COD'
                      and p.status =
                        'AWAITING_CONFIRMATION'
                  )
                )
              )
              and o.status <> 'CANCELLED'

            order by
              case m.role
                when 'PRIMARY' then 0
                else 1
              end,
              m.joined_at

            limit 1
          `,
          [additionalToTrackingToken, cartToken.trim()],
        );

      additionalDeliveryPreflight =
        sourceResult.rows[0] ?? null;

      if (!additionalDeliveryPreflight) {
        throw new ConflictException(
          'Additional delivery source must have a dispatchable DELIVERY payment contract',
        );
      }

      customerName =
        customerName ??
        additionalDeliveryPreflight.customer_name;

      customerPhone =
        customerPhone ??
        additionalDeliveryPreflight.customer_phone;

      if (!hasRequestedDeliveryDestination) {
        deliveryAddress =
          additionalDeliveryPreflight.address_text;

        deliveryReference =
          additionalDeliveryPreflight.address_reference;

        deliveryLatitude =
          Number(
            additionalDeliveryPreflight.destination_latitude,
          );

        deliveryLongitude =
          Number(
            additionalDeliveryPreflight.destination_longitude,
          );
      }
    }

    if (orderType === 'DELIVERY') {
      if (!customerName) {
        throw new BadRequestException(
          'customerName is required for DELIVERY',
        );
      }

      if (!customerPhone) {
        throw new BadRequestException(
          'customerPhone is required for DELIVERY',
        );
      }

      if (!deliveryAddress) {
        throw new BadRequestException(
          'deliveryAddress is required for DELIVERY',
        );
      }
    }

    let deliveryRouteSnapshot:
      DeliveryCheckoutRouteSnapshot | null =
      null;

    if (orderType === 'DELIVERY') {
      deliveryRouteSnapshot =
        await this.prepareDeliveryRouteSnapshotForCheckout(
          cartToken.trim(),
          deliveryLatitude,
          deliveryLongitude,
        );
    }
    return this.databaseService.withTransaction(async (client) => {
      // --------------------------------------------------
      // 1.5.1. Recuperar y bloquear el carrito.
      // --------------------------------------------------

      const cartResult = await client.query<CartRow>(
        `
              select
                c.id::text,
                c.tenant_id::text,
                c.branch_id::text,
                c.status,
                c.currency,
                c.expires_at,

                t.code as tenant_code,
                b.code as branch_code

              from public.carts c

              inner join public.tenants t
                on t.id = c.tenant_id

              inner join public.branches b
                on b.tenant_id = c.tenant_id
               and b.id = c.branch_id

              where c.cart_token = $1::uuid

              for update of c
            `,
        [cartToken.trim()],
      );

      const cart = cartResult.rows[0];

      if (!cart) {
        throw new NotFoundException('Cart not found');
      }

      await assertPosCartAccess(client,cart.id,pos?.staff);
      if(pos && (cart.tenant_id!==pos.staff.tenantId || cart.branch_id!==pos.staff.branchId)) throw new NotFoundException("Cart not found");
      await lockBranchAdmission(client, cart.tenant_id, cart.branch_id, ['ORDERING', orderType]);

      if (cart.status !== 'OPEN') {
        throw new ConflictException(`Cart is not open: ${cart.status}`);
      }

      if (new Date(cart.expires_at).getTime() <= Date.now()) {
        throw new ConflictException('Cart has expired');
      }

      if (
        tableContext &&
        (tableContext.tenant !== cart.tenant_code ||
          tableContext.branch !== cart.branch_code)
      ) {
        throw new BadRequestException(
          'tableContextToken does not belong to this cart tenant and branch',
        );
      }

      // --------------------------------------------------
      // PEDIDO ADICIONAL DELIVERY V1
      //
      // El preflight prepara fulfillment/ruta.
      // La decision JOINED_EXISTING vs SEPARATE_DELIVERY
      // se toma aqui bajo lock de Order + Membership +
      // Delivery.
      // --------------------------------------------------

      let additionalDeliveryContext:
        AdditionalDeliveryOrderContextRow | null =
        null;

      let joinAdditionalToExistingDelivery = false;

      if (
        additionalToTrackingToken &&
        orderType === 'DELIVERY'
      ) {
        const additionalDeliveryResult =
          await client.query<AdditionalDeliveryOrderContextRow>(
            `
              select
                o.tenant_id::text,
                o.branch_id::text,
                o.id::text as order_id,
                o.order_group_id::text,

                o.customer_name,
                o.customer_phone,

                d.id::text as delivery_id,
                d.tracking_token::text
                  as delivery_tracking_token,

                d.status as delivery_status,

                d.address_text,
                d.address_reference,

                gis.ST_Y(d.destination::gis.geometry)::text
                  as destination_latitude,

                gis.ST_X(d.destination::gis.geometry)::text
                  as destination_longitude,

                exists (
                  select 1
                  from public.delivery_assignments a
                  where a.tenant_id = d.tenant_id
                    and a.branch_id = d.branch_id
                    and a.delivery_id = d.id
                    and a.status in (
                      'ASSIGNED',
                      'ACCEPTED'
                    )
                ) as has_active_assignment

              from public.orders o

              inner join public.delivery_order_memberships m
                on m.tenant_id = o.tenant_id
               and m.branch_id = o.branch_id
               and m.order_id = o.id
               and m.membership_status = 'ACTIVE'

              inner join public.deliveries d
                on d.tenant_id = m.tenant_id
               and d.branch_id = m.branch_id
               and d.id = m.delivery_id

              where o.tracking_token = $1::uuid
                and o.tenant_id = $2::uuid
                and o.branch_id = $3::uuid
                and o.order_type = 'DELIVERY'
                and (
                  o.payment_status in (
                    'PAID',
                    'NOT_REQUIRED'
                  )
                  or (
                    m.role = 'PRIMARY'
                    and o.payment_status =
                      'AWAITING_CONFIRMATION'
                    and exists (
                      select 1

                      from public.order_payments p

                      where p.tenant_id = o.tenant_id
                        and p.branch_id = o.branch_id
                        and p.order_id = o.id
                        and p.method = 'CASH'
                        and p.provider = 'DRIVER_COD'
                        and p.status =
                          'AWAITING_CONFIRMATION'
                    )
                  )
                )
                and o.status <> 'CANCELLED'

              order by
                case m.role
                  when 'PRIMARY' then 0
                  else 1
                end,
                m.joined_at

              limit 1

              for update of o, m, d
            `,
            [
              additionalToTrackingToken,
              cart.tenant_id,
              cart.branch_id,
            ],
          );

        additionalDeliveryContext =
          additionalDeliveryResult.rows[0] ?? null;

        if (!additionalDeliveryContext) {
          throw new ConflictException(
            'Additional delivery source must have a dispatchable DELIVERY payment contract in the same branch',
          );
        }

        if (
          !additionalDeliveryPreflight ||
          additionalDeliveryPreflight.delivery_id !==
            additionalDeliveryContext.delivery_id
        ) {
          throw new ConflictException(
            'Additional delivery source changed during checkout',
          );
        }

        // Missing fulfillment values may inherit from the
        // source. Explicit values remain authoritative for
        // the new Order and make it separate when they differ.

        customerName =
          customerName ??
          additionalDeliveryContext.customer_name;

        customerPhone =
          customerPhone ??
          additionalDeliveryContext.customer_phone;

        if (!hasRequestedDeliveryDestination) {
          deliveryAddress =
            additionalDeliveryContext.address_text;

          deliveryReference =
            additionalDeliveryContext.address_reference;

          deliveryLatitude =
            Number(
              additionalDeliveryContext.destination_latitude,
            );

          deliveryLongitude =
            Number(
              additionalDeliveryContext.destination_longitude,
            );
        }

        const effectiveLatitude =
          Number(deliveryLatitude);

        const effectiveLongitude =
          Number(deliveryLongitude);

        const sourceLatitude =
          Number(
            additionalDeliveryContext.destination_latitude,
          );

        const sourceLongitude =
          Number(
            additionalDeliveryContext.destination_longitude,
          );

        // Conservative V1:
        // the physical Delivery still owns one recipient.
        // A changed recipient therefore gets a separate
        // Delivery until the Driver bundle UI is fully
        // member-aware.
        const sameRecipient =
          (customerName ?? '').trim().toLowerCase() ===
            (
              additionalDeliveryContext.customer_name ??
              ''
            ).trim().toLowerCase() &&
          (customerPhone ?? '').trim() ===
            (
              additionalDeliveryContext.customer_phone ??
              ''
            ).trim();

        const sameAddress =
          (deliveryAddress ?? '').trim().toLowerCase() ===
          additionalDeliveryContext.address_text
            .trim()
            .toLowerCase();

        const sameCoordinates =
          Number.isFinite(effectiveLatitude) &&
          Number.isFinite(effectiveLongitude) &&
          Number.isFinite(sourceLatitude) &&
          Number.isFinite(sourceLongitude) &&
          Math.abs(
            effectiveLatitude - sourceLatitude,
          ) <= 0.000001 &&
          Math.abs(
            effectiveLongitude - sourceLongitude,
          ) <= 0.000001;

        joinAdditionalToExistingDelivery =
          additionalDeliveryContext.delivery_status ===
            'CREATED' &&
          !additionalDeliveryContext.has_active_assignment &&
          sameRecipient &&
          sameAddress &&
          sameCoordinates;
      }
      // --------------------------------------------------
      // PEDIDO ADICIONAL DINE-In V1
      //
      // El trackingToken del pedido fuente actua como
      // capability del cliente. Nunca modificamos ese pedido:
      // solamente heredamos su order_group_id y su sesion OPEN.
      // --------------------------------------------------

      let additionalOrderContext: AdditionalOrderContextRow | null = null;

      if (
        additionalToTrackingToken &&
        orderType === 'DINE_IN'
      ) {
        const additionalOrderResult =
          await client.query<AdditionalOrderContextRow>(
            `
              select
                o.id::text,
                o.order_group_id::text,
                o.table_session_id::text,
                o.table_code

              from public.orders o

              inner join public.table_sessions ts
                on ts.tenant_id = o.tenant_id
               and ts.branch_id = o.branch_id
               and ts.id = o.table_session_id

              where o.tracking_token = $1::uuid
                and o.tenant_id = $2::uuid
                and o.branch_id = $3::uuid
                and o.order_type = 'DINE_IN'
                and o.payment_status = 'PAID'
                and o.status <> 'CANCELLED'
                and o.table_session_id is not null
                and o.table_code is not null
                and ts.status = 'OPEN'

              for update of o, ts
            `,
            [
              additionalToTrackingToken,
              cart.tenant_id,
              cart.branch_id,
            ],
          );

        additionalOrderContext = additionalOrderResult.rows[0] ?? null;

        if (!additionalOrderContext) {
          throw new ConflictException(
            'Additional order source must be a paid DINE_IN order with an open table session',
          );
        }

        if (
          tableCode &&
          tableCode !== additionalOrderContext.table_code
        ) {
          throw new BadRequestException(
            'Additional order must use the same table as the source order',
          );
        }

        if (
          tableContext &&
          tableContext.tableCode !== additionalOrderContext.table_code
        ) {
          throw new BadRequestException(
            'tableContextToken does not match the additional order table',
          );
        }

        if (
          tableContext?.tableSessionId &&
          tableContext.tableSessionId !==
            additionalOrderContext.table_session_id
        ) {
          throw new ConflictException(
            'tableContextToken does not match the additional order session',
          );
        }

        tableCode = additionalOrderContext.table_code;
      }

      // --------------------------------------------------
      // RESERVATION PREORDER V0.1
      //
      // Una reserva futura autoriza un pedido DINE_IN sin
      // abrir todavia una table_session. La mesa, el horario
      // y los datos del cliente provienen de la reserva.
      // --------------------------------------------------

      let reservationContext: ReservationOrderContextRow | null = null;

      if (reservationTrackingToken) {
        const reservationResult =
          await client.query<ReservationOrderContextRow>(
            `
              select
                r.id::text,
                r.reservation_code,
                r.tracking_token::text,
                r.status,
                r.reserved_for,
                r.reserved_until,
                r.customer_name,
                r.customer_phone,
                dt.id::text as table_id,
                dt.code as table_code,
                dt.name as table_name,
                dt.is_active as table_is_active

              from public.table_reservations r

              inner join public.dining_tables dt
                on dt.tenant_id = r.tenant_id
               and dt.branch_id = r.branch_id
               and dt.id = r.table_id

              where r.tracking_token = $1::uuid
                and r.tenant_id = $2::uuid
                and r.branch_id = $3::uuid

              for update of r, dt
            `,
            [reservationTrackingToken, cart.tenant_id, cart.branch_id],
          );

        reservationContext = reservationResult.rows[0] ?? null;

        if (!reservationContext) {
          throw new NotFoundException(
            'Reservation not found for this cart tenant and branch',
          );
        }

        if (!reservationContext.table_is_active) {
          throw new ConflictException(
            `${reservationContext.table_name} is not active`,
          );
        }

        if (
          reservationContext.status !== 'PENDING' &&
          reservationContext.status !== 'CONFIRMED'
        ) {
          throw new ConflictException(
            `Reservation cannot receive a preorder from ${reservationContext.status}`,
          );
        }

        if (
          new Date(reservationContext.reserved_until).getTime() <= Date.now()
        ) {
          throw new ConflictException('The reservation window has ended');
        }

        const existingPreorderResult = await client.query<{ id: string }>(
          `
            select o.id::text

            from public.orders o

            where o.tenant_id = $1::uuid
              and o.branch_id = $2::uuid
              and o.reservation_id = $3::uuid

            limit 1
          `,
          [cart.tenant_id, cart.branch_id, reservationContext.id],
        );

        if (existingPreorderResult.rows[0]) {
          throw new ConflictException(
            'The reservation already has an advance order',
          );
        }

        if (tableCode && tableCode !== reservationContext.table_code) {
          throw new BadRequestException(
            'tableCode does not match reservationTrackingToken',
          );
        }

        tableCode = reservationContext.table_code;
        scheduledFor = new Date(reservationContext.reserved_for).toISOString();
        customerName = reservationContext.customer_name;
        customerPhone = reservationContext.customer_phone;
      }

      // --------------------------------------------------
      // TABLES V0.2
      // Crear sesión de mesa para pedidos DINE_IN.
      //
      // IMPORTANTE:
      // La mesa se bloquea con FOR UPDATE.
      //
      // Si dos clientes intentan confirmar la misma mesa,
      // solamente uno podrá completar la operación.
      // --------------------------------------------------

      let tableSessionId: string | null = null;

      if (orderType === 'DINE_IN' && tableCode && !reservationContext) {
        // ------------------------------------------------
        // 1. Buscar y BLOQUEAR la mesa seleccionada.
        // ------------------------------------------------

        const tableResult = await client.query<CheckoutDiningTableRow>(
          `
              select
                dt.id::text,
                dt.code,
                dt.name,
                dt.is_active

              from public.dining_tables dt

              where dt.tenant_id = $1::uuid
                and dt.branch_id = $2::uuid
                and dt.code = $3
                and (
                  $4::uuid is null
                  or dt.id = $4::uuid
                )

              for update
            `,
          [
            cart.tenant_id,
            cart.branch_id,
            tableCode,
            tableContext?.tableId ?? null,
          ],
        );

        const diningTable = tableResult.rows[0];

        if (!diningTable) {
          throw new BadRequestException(
            'Selected table does not exist for this branch',
          );
        }

        if (!diningTable.is_active) {
          throw new ConflictException(`${diningTable.name} is not active`);
        }

        // ------------------------------------------------
        // 2. Comprobar si ya existe una sesión OPEN.
        // ------------------------------------------------

        const openSessionResult = await client.query<OpenTableSessionRow>(
          `
              select
                ts.id::text

              from public.table_sessions ts

              where ts.tenant_id = $1::uuid
                and ts.branch_id = $2::uuid
                and ts.table_id = $3::uuid
                and ts.status = 'OPEN'

              limit 1
            `,
          [cart.tenant_id, cart.branch_id, diningTable.id],
        );

        const openSession = openSessionResult.rows[0];

        if (openSession && !tableContext && !additionalOrderContext) {
          throw new ConflictException(
            `${diningTable.name} is already occupied`,
          );
        }

        if (
          tableContext?.tableSessionId &&
          openSession?.id !== tableContext.tableSessionId
        ) {
          throw new ConflictException(
            'tableContextToken session is no longer open',
          );
        }

        if (
          additionalOrderContext &&
          openSession?.id !== additionalOrderContext.table_session_id
        ) {
          throw new ConflictException(
            'Additional order source table session is no longer open',
          );
        }

        if (openSession) {
          // El QR contextual identifica al mismo grupo que ya
          // se encuentra en la mesa. Reutilizamos su sesión.
          tableSessionId = openSession.id;
        } else {
          if (tableContext?.tableSessionId) {
            throw new ConflictException(
              'tableContextToken session is no longer open',
            );
          }

          // ----------------------------------------------
          // 3. Crear la primera sesión OPEN de la mesa.
          //
          // Si posteriormente falla la creación del pedido,
          // toda la transacción hará ROLLBACK y esta sesión
          // tampoco quedará creada.
          // ----------------------------------------------

          const sessionResult = await client.query<CreatedTableSessionRow>(
            `
                insert into public.table_sessions (
                  tenant_id,
                  branch_id,
                  table_id,
                  status
                )
                values (
                  $1::uuid,
                  $2::uuid,
                  $3::uuid,
                  'OPEN'
                )
                returning
                  id::text
              `,
            [cart.tenant_id, cart.branch_id, diningTable.id],
          );

          tableSessionId = sessionResult.rows[0].id;
        }
      }

      // --------------------------------------------------
      // 1.5.2. Leer productos y revalidar catálogo.
      // --------------------------------------------------

      const itemsResult = await client.query<CheckoutItemRow>(
        `
              select
                ci.product_id::text,
                ci.rice_choice,
                exists(select 1 from public.product_categories rc where rc.tenant_id=p.tenant_id and rc.id=p.category_id and rc.slug='pollos') as requires_rice,
                p.sku,
                p.name,

                ci.quantity,
            ci.sauce_included_quantity,

                bp.price::text as price,
                bp.currency,
                (bp.is_available and p.active) as is_available,
                bp.available_quantity

              from public.cart_items ci

              inner join public.products p
                on p.tenant_id = ci.tenant_id
               and p.id = ci.product_id

              left join public.branch_products bp
                on bp.tenant_id = ci.tenant_id
               and bp.branch_id = $3::uuid
               and bp.product_id = ci.product_id

              where ci.tenant_id = $1::uuid
                and ci.cart_id = $2::uuid

              order by ci.created_at, ci.id

              for update of ci
            `,
        [cart.tenant_id, cart.id, cart.branch_id],
      );

      const items = itemsResult.rows;
      if(pos && posCartRevision(items)!==pos.expectedRevision)throw new ConflictException("Los productos cambiaron. Revisa el carrito.");
      const quantitiesByProduct = prepareRiceItems(items);

      if (items.length === 0) {
        throw new BadRequestException('Cart is empty');
      }

      // --------------------------------------------------
      // 1.5.3. Revalidar disponibilidad, precio y cantidad.
      // --------------------------------------------------

      for (const item of items) {
        if (
          !item.is_available ||
          item.price === null ||
          item.currency === null
        ) {
          throw new ConflictException(`${item.name} is no longer available`);
        }

        if (
          item.available_quantity !== null &&
          (quantitiesByProduct.get(item.product_id) ?? 0) > item.available_quantity
        ) {
          throw new ConflictException(
            `${item.name}: only ${item.available_quantity} units are available`,
          );
        }

        if (item.currency !== cart.currency) {
          throw new ConflictException(`${item.name} has a different currency`);
        }
      }

      // --------------------------------------------------
      // 1.5.4. Calcular valores usando precio actual.
      // --------------------------------------------------

      const pricedOrderItems = sauceOrderItems(cart.tenant_code, cart.branch_code, items);
      const subtotal = pricedOrderItems.reduce((total, item) => total + Number(item.price) * item.quantity, 0);
      const discountTotal = 0;

      let deliveryQuote: DeliveryCheckoutQuote | null = null;

      let deliveryFee = 0;

      if (orderType === 'DELIVERY') {
        if (!deliveryRouteSnapshot) {
          throw new Error(
            'Delivery route snapshot invariant failed',
          );
        }

        deliveryQuote =
          await this.deliveryService.quoteDeliveryForCheckout(
            client,
            {
              tenantId: cart.tenant_id,
              branchId: cart.branch_id,

              latitude: deliveryLatitude,
              longitude: deliveryLongitude,

              subtotal,
              routeSnapshot: deliveryRouteSnapshot,
            },
          );

        deliveryFee =
          joinAdditionalToExistingDelivery
            ? 0
            : deliveryQuote.deliveryFee;
      }

      const total = subtotal - discountTotal + deliveryFee;

      if (orderType === 'DELIVERY' && deliveryQuote && deliveryRouteSnapshot) {
        // Same locked cart, current prices, zone rules and JOIN decision for preview and confirmation.
        // Route travel time is an estimate; only the origin/destination and commercial terms are bound.
        const context = JSON.stringify({
          cart: [cart.id, cart.tenant_id, cart.branch_id, cart.currency],
          items: items.map(item => [item.product_id, item.rice_choice, item.quantity, Number(item.price), item.currency])
            .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
          destination: [deliveryAddress, deliveryReference, deliveryLatitude, deliveryLongitude],
          recipient: [customerName, customerPhone],
          origin: deliveryRouteSnapshot.origin,
          additional: [additionalToTrackingToken, additionalDeliveryContext?.delivery_id ?? null, joinAdditionalToExistingDelivery],
          zone: [deliveryQuote.zoneId, deliveryQuote.zone.code, deliveryQuote.minimumOrder],
          totals: [subtotal, discountTotal, deliveryFee, total],
        });
        if (quoteOnly) return { kind: 'quote' as const, quote: {
          ...issueQuote(context), coverage: true as const,
          tenant: cart.tenant_code, branch: cart.branch_code, currency: cart.currency,
          zone: deliveryQuote.zone, minimumOrder: deliveryQuote.minimumOrder,
          subtotal, discountTotal, deliveryFee, total,
          eta: deliveryQuote.eta,
          deliveryMode: joinAdditionalToExistingDelivery ? 'JOINED_EXISTING' as const : 'SEPARATE_DELIVERY' as const,
        } };
        // Failure rolls back; it never silently creates an order at a different price.
        verifyQuote(input.deliveryQuoteToken, context);
      }
      if (quoteOnly) throw new Error('Delivery quote invariant failed');


      // Gate 7B.1: una reserva confirmada ya no confirma por si sola
      // el pedido. Todo pedido nuevo espera confirmacion de pago.
      if(pos && Math.round(total*100)!==Math.round(pos.expectedTotal*100))throw new ConflictException("El total cambió. Revisa el carrito.");
      const initialOrderStatus: OrderStatus = 'PENDING';
      const initialPaymentStatus: OrderPaymentStatus = 'PENDING';

      const orderOrigin: OrderOrigin = pos ? 'OPS_STAFF' : reservationContext
        ? 'RESERVATION_PREORDER'
        : tableContext
          ? 'TABLE_QR'
          : 'PUBLIC_MENU';

      // --------------------------------------------------
      // 1.5.5. Crear Order + Fulfillment + Table Session.
      // --------------------------------------------------

      if (input.requireRecoveryProfile && (!customerRecoverySession ||
        customerRecoverySession.tenant_id !== cart.tenant_id ||
        !sameRecoveryPhone(customerPhone, customerRecoverySession.phone_normalized))) {
        throw new UnauthorizedException('Recovery session required before checkout');
      }
      const orderResult = await client.query<CreatedOrderRow>(
        `
              insert into public.orders (
                tenant_id,
                branch_id,
                cart_id,
                order_group_id,
                customer_account_id,

                order_type,
                status,
                payment_status,
                order_origin,
                currency,

                subtotal,
                discount_total,
                delivery_fee,
                total,

                scheduled_for,
                customer_name,
                customer_phone,
                table_code,
                table_session_id,
                delivery_address,
                customer_notes,
                reservation_id
              )
              values (
                $1::uuid,
                $2::uuid,
                $3::uuid,
                coalesce($21::uuid, gen_random_uuid()),
                coalesce(
                  (
                    select source_order.customer_account_id
                    from public.orders source_order
                    where source_order.tracking_token = $23::uuid
                    limit 1
                  ),
                  $22::uuid
                ),

                $4,
                $17::varchar,
                $19::varchar,
                $20::varchar,
                $5,

                $6,
                $7,
                $8,
                $9,

                $10::timestamptz,
                $11,
                $12,
                $13,
                $14::uuid,
                $15,
                $16,
                $18::uuid
              )
              returning
                id::text,
                order_number::text,
                tracking_token::text,
                order_group_id::text,

                order_type,
                status,
                payment_status,
                order_origin,
                currency,

                subtotal::text,
                discount_total::text,
                delivery_fee::text,
                total::text,

                scheduled_for,
                customer_name,
                customer_phone,
                table_code,
                delivery_address,
                customer_notes,
                reservation_id::text,

                created_at
            `,
        [
          cart.tenant_id,
          cart.branch_id,
          cart.id,

          orderType,
          cart.currency,

          subtotal,
          discountTotal,
          deliveryFee,
          total,

          scheduledFor,
          customerName,
          customerPhone,
          tableCode,
          tableSessionId,
          deliveryAddress,
          customerNotes,
          initialOrderStatus,
          reservationContext?.id ?? null,
          initialPaymentStatus,
          orderOrigin,
          additionalOrderContext?.order_group_id ??
            additionalDeliveryContext?.order_group_id ??
            null,
          customerRecoverySession?.tenant_id === cart.tenant_id &&
          sameRecoveryPhone(customerPhone, customerRecoverySession.phone_normalized)
            ? customerRecoverySession.customer_account_id
            : null,
          additionalToTrackingToken,
        ],
      );

      const order = orderResult.rows[0];
      if(pos)await client.query("update public.pos_drafts set order_id=$2::uuid,checkout_hash=$3 where cart_id=$1::uuid",[cart.id,order.id,pos.intentHash]);

      let createdDelivery: CreatedDelivery | null = null;

      if (orderType === 'DELIVERY') {
        if (
          !deliveryQuote ||
          !customerName ||
          !customerPhone ||
          !deliveryAddress
        ) {
          throw new Error(
            'Delivery checkout invariant failed',
          );
        }

        if (
          joinAdditionalToExistingDelivery &&
          additionalDeliveryContext
        ) {
          await client.query(
            `
              insert into public.delivery_order_memberships (
                tenant_id,
                branch_id,
                delivery_id,
                order_id,
                role,
                membership_status
              )
              values (
                $1::uuid,
                $2::uuid,
                $3::uuid,
                $4::uuid,
                'ADDITIONAL',
                'PENDING'
              )
            `,
            [
              cart.tenant_id,
              cart.branch_id,
              additionalDeliveryContext.delivery_id,
              order.id,
            ],
          );

          createdDelivery = {
            id:
              additionalDeliveryContext.delivery_id,

            trackingToken:
              additionalDeliveryContext
                .delivery_tracking_token,

            status: 'CREATED',
          };
        }
        else {
          createdDelivery =
            await this.deliveryService
              .createDeliveryForOrder(
                client,
                {
                  tenantId: cart.tenant_id,
                  branchId: cart.branch_id,

                  orderId: order.id,

                  quote: deliveryQuote,

                  recipientName: customerName,
                  recipientPhone: customerPhone,

                  addressText: deliveryAddress,
                  addressReference:
                    deliveryReference,

                  latitude:
                    deliveryLatitude as number,

                  longitude:
                    deliveryLongitude as number,
                },
              );
        }
      }

      // --------------------------------------------------
      // 1.5.6. Crear snapshot de cada item.
      // --------------------------------------------------

      for (const item of pricedOrderItems) {
        const unitPrice = Number(item.price);

        const lineTotal = unitPrice * item.quantity;

        await client.query(
          `
              insert into public.order_items (
                tenant_id,
                order_id,
                product_id,
                rice_choice,
                sku_snapshot,
                name_snapshot,
                quantity,
                unit_price,
                line_total,
                currency
              )
              values (
                $1::uuid,
                $2::uuid,
                $3::uuid,
                $4,
                $5,
                $6,
                $7,
                $8,
                $9,
                $10
              )
            `,
          [
            cart.tenant_id,
            order.id,
            item.product_id,
            item.rice_choice,
            item.sku,
            item.name,
            item.quantity,
            unitPrice,
            lineTotal,
            item.currency,
          ],
        );
      }

      // --------------------------------------------------
      // 1.5.7. Marcar carrito como convertido.
      // --------------------------------------------------

      await client.query(
        `
            update public.carts
            set
              status = 'CONVERTED',
              updated_at = now()
            where tenant_id = $1::uuid
              and id = $2::uuid
          `,
        [cart.tenant_id, cart.id],
      );

      // --------------------------------------------------
      // 1.5.8. Respuesta.
      // --------------------------------------------------

      return { kind: 'order' as const, order: {
        id: order.id,

        orderNumber: order.order_number,

        trackingToken: order.tracking_token,

        orderGroup: order.order_group_id,

        orderType: order.order_type,

        status: order.status,

        paymentStatus: order.payment_status,

        orderOrigin: order.order_origin,

        currency: order.currency,

        // ----------------------------------------------
        // Fulfillment V0.1
        // ----------------------------------------------

        fulfillment: {
          scheduledFor: order.scheduled_for,

          customerName: order.customer_name,

          customerPhone: order.customer_phone,

          tableCode: order.table_code,

          deliveryAddress: order.delivery_address,

          customerNotes: order.customer_notes,
        },

        deliveryRelationship:
          orderType === 'DELIVERY' &&
          additionalToTrackingToken
            ? {
                mode:
                  joinAdditionalToExistingDelivery
                    ? 'JOINED_EXISTING'
                    : 'SEPARATE_DELIVERY',
              }
            : null,

        delivery:
          createdDelivery && deliveryQuote
            ? {
                status: createdDelivery.status,

                zone: {
                  code: deliveryQuote.zone.code,
                  name: deliveryQuote.zone.name,
                },

                deliveryFee,

                eta: {
                  minMinutes: deliveryQuote.eta.minMinutes,
                  maxMinutes: deliveryQuote.eta.maxMinutes,
                },
              }
            : null,

        reservation: reservationContext
          ? {
              id: reservationContext.id,
              reservationCode: reservationContext.reservation_code,
              trackingToken: reservationContext.tracking_token,
              reservedFor: reservationContext.reserved_for,
              table: {
                id: reservationContext.table_id,
                code: reservationContext.table_code,
                name: reservationContext.table_name,
              },
            }
          : null,

        tenant: {
          code: cart.tenant_code,
        },

        branch: {
          code: cart.branch_code,
        },

        items: pricedOrderItems.map((item) => ({
          product: {
            id: item.product_id,
            sku: item.sku,
            name: item.name,
          },

          quantity: item.quantity,

          unitPrice: Number(item.price),

          lineTotal: Number(item.price) * item.quantity,

          currency: item.currency,
        })),

        totals: {
          subtotal: Number(order.subtotal),

          discountTotal: Number(order.discount_total),

          deliveryFee: Number(order.delivery_fee),

          total: Number(order.total),
        },

        createdAt: order.created_at,
      } };
    });
  }

  // =======================================================
  // 2. TRACKING PÚBLICO DEL PEDIDO
  // =======================================================

  async getOrderTracking(trackingToken: string) {
    const orderResult = await this.databaseService.query<TrackingOrderRow>(
      `
          select
            o.id::text,
            o.order_number::text,
            o.tracking_token::text,
            o.order_group_id::text,
            o.order_type,
            o.status,
            o.payment_status,
            o.order_origin,
            o.currency,

            o.subtotal::text,
            o.discount_total::text,
            o.delivery_fee::text,
            o.total::text,

            -- ===============================================
            -- FULFILLMENT
            -- ===============================================

            o.scheduled_for,

            o.customer_name,
            o.customer_phone,
            o.table_code,
            o.delivery_address,
            o.customer_notes,

            o.reservation_id::text,
            r.reservation_code,
            r.reserved_for as reservation_reserved_for,

            o.created_at,

            t.code as tenant_code,
            t.name as tenant_name,

            b.code as branch_code,
            b.name as branch_name

          from public.orders o

          inner join public.tenants t
            on t.id = o.tenant_id

          inner join public.branches b
            on b.tenant_id = o.tenant_id
           and b.id = o.branch_id

          left join public.table_reservations r
            on r.tenant_id = o.tenant_id
           and r.branch_id = o.branch_id
           and r.id = o.reservation_id

          where o.tracking_token = $1::uuid

          limit 1
        `,
      [trackingToken],
    );

    const order = orderResult.rows[0];

    if (!order) {
      throw new NotFoundException('Order not found');
    }

    const itemsResult = await this.databaseService.query<TrackingItemRow>(
      `
          select
            oi.product_id::text,
            oi.sku_snapshot,
            oi.name_snapshot,
            oi.quantity,
            oi.unit_price::text,
            oi.line_total::text,
            oi.currency

          from public.order_items oi

          where oi.order_id = $1::uuid

          order by oi.created_at
        `,
      [order.id],
    );

    const historyResult = await this.databaseService.query<TrackingHistoryRow>(
      `
          select
            h.status,
            h.changed_at

          from public.order_status_history h

          where h.order_id = $1::uuid

          order by
            h.changed_at,
            h.id
        `,
      [order.id],
    );

    return {
      orderNumber: order.order_number,

      trackingToken: order.tracking_token,

      orderGroup: order.order_group_id,

      orderType: order.order_type,

      status: order.status,

      paymentStatus: order.payment_status,

      orderOrigin: order.order_origin,

      currency: order.currency,

      // =======================================================
      // FULFILLMENT
      // =======================================================

      fulfillment: {
        scheduledFor: order.scheduled_for,

        customerName: order.customer_name,

        customerPhone: order.customer_phone,

        tableCode: order.table_code,

        deliveryAddress: order.delivery_address,

        customerNotes: order.customer_notes,
      },

      reservation: order.reservation_id
        ? {
            id: order.reservation_id,
            reservationCode: order.reservation_code,
            reservedFor: order.reservation_reserved_for,
          }
        : null,

      tenant: {
        code: order.tenant_code,

        name: order.tenant_name,
      },

      branch: {
        code: order.branch_code,

        name: order.branch_name,
      },

      items: itemsResult.rows.map((item) => ({
        product: {
          id: item.product_id,

          sku: item.sku_snapshot,

          name: item.name_snapshot,
        },

        quantity: item.quantity,

        unitPrice: Number(item.unit_price),

        lineTotal: Number(item.line_total),

        currency: item.currency,
      })),

      totals: {
        subtotal: Number(order.subtotal),

        discountTotal: Number(order.discount_total),

        deliveryFee: Number(order.delivery_fee),

        total: Number(order.total),
      },

      tracking: historyResult.rows.map((event) => ({
        status: event.status,

        changedAt: event.changed_at,
      })),

      createdAt: order.created_at,
    };
  }

  // =======================================================
  // POD PUBLICO DE DELIVERY
  //
  // El trackingToken del pedido funciona como capability
  // publica. El codigo POD se deriva server-side y nunca
  // se almacena en PostgreSQL.
  // =======================================================

  private async prepareDeliveryRouteSnapshotForCheckout(
    cartToken: string,
    latitude: unknown,
    longitude: unknown,
  ): Promise<DeliveryCheckoutRouteSnapshot> {
    const cartResult =
      await this.databaseService.query<CartRow>(
        `
          select
            c.id::text,
            c.tenant_id::text,
            c.branch_id::text,
            c.status,
            c.currency,
            c.expires_at,

            t.code as tenant_code,
            b.code as branch_code
          from public.carts c
          inner join public.tenants t
            on t.id = c.tenant_id
          inner join public.branches b
            on b.tenant_id = c.tenant_id
           and b.id = c.branch_id
          where c.cart_token = $1::uuid
          limit 1
        `,
        [
          cartToken,
        ],
      );

    const cart =
      cartResult.rows[0];

    if (!cart) {
      throw new NotFoundException(
        'Cart not found',
      );
    }

    if (cart.status !== 'OPEN') {
      throw new ConflictException(
        `Cart is not open: ${cart.status}`,
      );
    }

    if (
      new Date(
        cart.expires_at,
      ).getTime() <= Date.now()
    ) {
      throw new ConflictException(
        'Cart has expired',
      );
    }

    const itemsResult =
      await this.databaseService.query<CheckoutItemRow>(
        `
          select
            ci.product_id::text,
            ci.rice_choice,
            exists(select 1 from public.product_categories rc where rc.tenant_id=p.tenant_id and rc.id=p.category_id and rc.slug='pollos') as requires_rice,
            p.sku,
            p.name,

            ci.quantity,
            ci.sauce_included_quantity,

            bp.price::text as price,
            bp.currency,
            bp.is_available,
            bp.available_quantity
          from public.cart_items ci
          inner join public.products p
            on p.tenant_id = ci.tenant_id
           and p.id = ci.product_id
          left join public.branch_products bp
            on bp.tenant_id = ci.tenant_id
           and bp.branch_id = $3::uuid
           and bp.product_id = ci.product_id
          where ci.tenant_id = $1::uuid
            and ci.cart_id = $2::uuid
          order by ci.created_at, ci.id
        `,
        [
          cart.tenant_id,
          cart.id,
          cart.branch_id,
        ],
      );

    const items =
      itemsResult.rows;
      const quantitiesByProduct = prepareRiceItems(items);

    if (items.length === 0) {
      throw new BadRequestException(
        'Cart is empty',
      );
    }

    for (const item of items) {
      if (
        !item.is_available ||
        item.price === null ||
        item.currency === null
      ) {
        throw new ConflictException(
          `${item.name} is no longer available`,
        );
      }

      if (
        item.available_quantity !== null &&
        (quantitiesByProduct.get(item.product_id) ?? 0) > item.available_quantity
      ) {
        throw new ConflictException(
          `${item.name}: only ${item.available_quantity} units are available`,
        );
      }

      if (
        item.currency !== cart.currency
      ) {
        throw new ConflictException(
          `${item.name} has a different currency`,
        );
      }
    }

    const pricedOrderItems = sauceOrderItems(cart.tenant_code, cart.branch_code, items);
    const subtotal =
      pricedOrderItems.reduce(
        (total, item) =>
          total +
          Number(item.price) *
            item.quantity,
        0,
      );

    return this.deliveryService
      .prepareDeliveryCheckoutRoute({
        tenantId:
          cart.tenant_id,

        branchId:
          cart.branch_id,

        latitude,
        longitude,

        subtotal,
      });
  }
  async getDeliveryLocation(
    trackingToken: string,
  ) {
    return this.deliveryService
      .getPublicDeliveryLocationByOrderTrackingToken(
        trackingToken,
      );
  }
  async getDeliveryPod(
    trackingToken: string,
  ) {
    return this.deliveryService
      .getPublicDeliveryPodByOrderTrackingToken(
        trackingToken,
      );
  }
  // =======================================================
  // 3. ACTUALIZAR ESTADO OPERATIVO
  // =======================================================

  async updateOrderStatus(
    orderId: string,
    requestedStatus: string | undefined,
    principal: Pick<StaffSessionPrincipal, 'tenantId' | 'branchId'>,
  ) {
    if (!requestedStatus?.trim()) {
      throw new BadRequestException('status is required');
    }

    const nextStatus = requestedStatus.trim().toUpperCase() as OrderStatus;

    if (
      !Object.prototype.hasOwnProperty.call(
        ORDER_STATUS_TRANSITIONS,
        nextStatus,
      )
    ) {
      throw new BadRequestException('Invalid order status');
    }

    return this.databaseService.withTransaction(async (client) => {
      const orderResult = await client.query<{
        id: string;
        order_number: string;
        tracking_token: string;
        tenant_id: string;
        branch_id: string;
        order_type: OrderType;
        status: OrderStatus;
        payment_status: OrderPaymentStatus;
        reservation_id: string | null;
        scheduled_for: string | Date | null;
      }>(
        `
              select
                id::text,
                order_number::text,
                tracking_token::text,
                tenant_id::text,
                branch_id::text,
                order_type,
                status,
                payment_status,
                reservation_id::text,
                scheduled_for

              from public.orders

              where id = $1::uuid
                and tenant_id = $2::uuid
                and branch_id = $3::uuid

              for update
            `,
        [orderId, principal.tenantId, principal.branchId],
      );

      const order = orderResult.rows[0];

      if (!order) {
        throw new NotFoundException('Order not found');
      }

      const currentStatus = order.status;

      // Idempotencia: mismo estado, sin UPDATE.
      if (currentStatus === nextStatus) {
        return {
          id: order.id,

          orderNumber: order.order_number,

          trackingToken: order.tracking_token,

          previousStatus: currentStatus,

          status: currentStatus,

          changed: false,
        };
      }

      const allowedTransitions = ORDER_STATUS_TRANSITIONS[currentStatus];

      if (!allowedTransitions.includes(nextStatus)) {
        throw new ConflictException(
          `Invalid order status transition: ${currentStatus} -> ${nextStatus}`,
        );
      }

      // A DELIVERY order can only reach COMPLETED through the
      // driver delivery lifecycle after a valid POD verification.
      // The KDS owns food preparation, but it must not complete
      // the customer order while the delivery is still active.
      if (
        order.order_type === 'DELIVERY' &&
        currentStatus === 'READY' &&
        nextStatus === 'COMPLETED'
      ) {
        throw new ConflictException(
          'Delivery orders are completed only by the driver delivery workflow',
        );
      }

      if (order.order_type === 'DELIVERY' && ['CONFIRMED', 'PREPARING', 'READY'].includes(nextStatus)) {
        await assertDeliveryQrPaid(client, {tenant_id: order.tenant_id, branch_id: order.branch_id, order_id: order.id});
      }

      const paymentVerified =
        ['PAID', 'NOT_REQUIRED'].includes(
          order.payment_status,
        );

      let explicitDriverCod = false;

      if (
        (
          nextStatus === 'CONFIRMED' ||
          nextStatus === 'PREPARING'
        ) &&
        !paymentVerified &&
        order.order_type === 'DELIVERY' &&
        order.payment_status ===
          'AWAITING_CONFIRMATION'
      ) {
        const codResult =
          await client.query<{
            eligible: boolean;
          }>(
            `
              select exists (
                select 1

                from public.order_payments p

                where p.tenant_id = $1::uuid
                  and p.branch_id = $2::uuid
                  and p.order_id = $3::uuid
                  and p.method = 'CASH'
                  and p.provider = 'DRIVER_COD'
                  and p.status =
                    'AWAITING_CONFIRMATION'
              ) as eligible
            `,
            [
              order.tenant_id,
              order.branch_id,
              order.id,
            ],
          );

        explicitDriverCod =
          codResult.rows[0]?.eligible ??
          false;
      }

      if (
        nextStatus === 'CONFIRMED' &&
        !paymentVerified &&
        !explicitDriverCod
      ) {
        throw new ConflictException(
          'Order cannot advance until payment is verified or explicit cash on delivery is selected',
        );
      }

      if (
        nextStatus === 'PREPARING' &&
        !paymentVerified &&
        !explicitDriverCod
      ) {
        throw new ConflictException(
          'Order cannot advance until payment is verified or explicit cash on delivery is selected',
        );
      }

      if (
        nextStatus === 'PREPARING' &&
        order.reservation_id &&
        order.scheduled_for &&
        new Date(order.scheduled_for).getTime() - Date.now() > 60 * 60 * 1000
      ) {
        throw new ConflictException(
          'Advance order preparation is available starting 60 minutes before the reservation',
        );
      }

      const updateResult = await client.query<{
        id: string;
        order_number: string;
        tracking_token: string;
        status: OrderStatus;
        updated_at: string | Date;
      }>(
        `
              update public.orders

              set
                status = $2,
                updated_at = now()

              where id = $1::uuid

              returning
                id::text,
                order_number::text,
                tracking_token::text,
                status,
                updated_at
            `,
        [orderId, nextStatus],
      );

      const updated = updateResult.rows[0];

      return {
        id: updated.id,

        orderNumber: updated.order_number,

        trackingToken: updated.tracking_token,

        previousStatus: currentStatus,

        status: updated.status,

        changed: true,

        updatedAt: updated.updated_at,
      };
    });
  }

  // =======================================================
  // 4. TABLES V0.3
  // CERRAR Y LIBERAR LA MESA VINCULADA A UN PEDIDO
  // =======================================================

  async closeTableSession(
    orderId: string,
    tenantCode: string | undefined,
    branchCode: string | undefined,
  ) {
    const tenant = tenantCode?.trim() || 'POLLO001';

    const branch = branchCode?.trim() || 'SUC001';

    return this.databaseService.withTransaction(async (client) => {
      // -------------------------------------------------
      // 1. Buscar y bloquear el pedido.
      //
      // Los filtros tenant + branch impiden operar sobre
      // pedidos pertenecientes a otra organización.
      // -------------------------------------------------

      const orderResult = await client.query<CloseTableOrderRow>(
        `
              select
                o.id::text,
                o.order_number::text,
                o.order_type,

                o.tenant_id::text,
                o.branch_id::text,

                o.table_session_id::text

              from public.orders o

              inner join public.tenants t
                on t.id = o.tenant_id

              inner join public.branches b
                on b.tenant_id = o.tenant_id
               and b.id = o.branch_id

              where o.id = $1::uuid
                and t.code = $2
                and b.code = $3

              for update of o
            `,
        [orderId, tenant, branch],
      );

      const order = orderResult.rows[0];

      if (!order) {
        throw new NotFoundException(
          'Order not found for this tenant and branch',
        );
      }

      if (order.order_type !== 'DINE_IN' || !order.table_session_id) {
        throw new ConflictException('Order does not have a table session');
      }

      // -------------------------------------------------
      // 2. Buscar y bloquear la sesión y la mesa.
      //
      // El bloqueo de dining_tables se coordina con el
      // bloqueo utilizado durante checkout DINE_IN.
      // -------------------------------------------------

      const sessionResult = await client.query<CloseTableSessionRow>(
        `
              select
                ts.id::text,
                ts.status,

                dt.id::text as table_id,
                dt.code as table_code,
                dt.name as table_name

              from public.table_sessions ts

              inner join public.dining_tables dt
                on dt.tenant_id = ts.tenant_id
               and dt.branch_id = ts.branch_id
               and dt.id = ts.table_id

              where ts.tenant_id = $1::uuid
                and ts.branch_id = $2::uuid
                and ts.id = $3::uuid

              for update of dt, ts
            `,
        [order.tenant_id, order.branch_id, order.table_session_id],
      );

      const session = sessionResult.rows[0];

      if (!session) {
        throw new NotFoundException('Table session not found');
      }

      if (session.status !== 'OPEN') {
        throw new ConflictException('Table session is already closed');
      }

      // -------------------------------------------------
      // 3. Cerrar la sesión.
      //
      // No actualizamos dining_tables. TablesService
      // derivará AVAILABLE al no encontrar una sesión OPEN.
      // -------------------------------------------------

      const updateResult = await client.query<ClosedTableSessionRow>(
        `
              update public.table_sessions

              set
                status = 'CLOSED',
                closed_at = now()

              where tenant_id = $1::uuid
                and branch_id = $2::uuid
                and id = $3::uuid
                and status = 'OPEN'

              returning
                id::text,
                status,
                closed_at,
                updated_at
            `,
        [order.tenant_id, order.branch_id, session.id],
      );

      const closedSession = updateResult.rows[0];

      if (!closedSession) {
        throw new ConflictException('Table session is no longer open');
      }

      return {
        tenant,
        branch,

        order: {
          id: order.id,
          orderNumber: order.order_number,
        },

        table: {
          id: session.table_id,
          code: session.table_code,
          name: session.table_name,
          availability: 'AVAILABLE',
        },

        tableSession: {
          id: closedSession.id,
          previousStatus: 'OPEN',
          status: closedSession.status,
          closedAt: closedSession.closed_at,
          updatedAt: closedSession.updated_at,
        },
      };
    });
  }

  // =======================================================
  // 4. LISTAR PEDIDOS ACTIVOS PARA KDS
  // =======================================================

  async getOperationalOrders(
    tenantCode: string | undefined,
    branchCode: string | undefined,
  ) {
    const tenant = tenantCode?.trim() || 'POLLO001';

    const branch = branchCode?.trim() || 'SUC001';

    const result = await this.databaseService.query<OpsOrderRow>(
      `
        select
          o.id::text,
          o.order_number::text,
          o.tracking_token::text,
          o.order_type,
          o.status,
          o.payment_status,
          o.order_origin,
          o.currency,
          o.total::text,

          -- ===============================================
          -- FULFILLMENT
          -- ===============================================

          o.scheduled_for,
          o.customer_name,
          o.customer_phone,
          o.table_code,
          o.delivery_address,
          o.customer_notes,

          o.reservation_id::text,
          r.reservation_code,
          r.reserved_for as reservation_reserved_for,

          o.table_session_id::text,
          ts.status as table_session_status,
          ts.closed_at as table_session_closed_at,

          o.created_at,
          o.updated_at,

          max(operational_delivery.id::text)
            as operational_delivery_id,

          max(operational_delivery.status)
            as operational_delivery_status,

          max(operational_assignment.id::text)
            as operational_assignment_id,

          max(operational_assignment.status)
            as operational_assignment_status,

          max(operational_assignment.accepted_at)
            as operational_assignment_accepted_at,

          max(operational_driver.id::text)
            as operational_driver_id,

          max(operational_driver.code)
            as operational_driver_code,

          max(operational_driver.display_name)
            as operational_driver_name,

          max(operational_delivery.membership_role)
            as operational_delivery_role,

          max(operational_delivery.member_count)
            as operational_delivery_member_count,

          coalesce(
            jsonb_agg(
              jsonb_build_object(
                'productId',
                oi.product_id::text,

                'sku',
                oi.sku_snapshot,

                'name',
                oi.name_snapshot,

                'quantity',
                oi.quantity,

                'unitPrice',
                oi.unit_price,

                'lineTotal',
                oi.line_total
              )
              order by oi.created_at
            )
            filter (
              where oi.id is not null
            ),
            '[]'::jsonb
          ) as items

        from public.orders o

        inner join public.tenants t
          on t.id = o.tenant_id

        inner join public.branches b
          on b.tenant_id = o.tenant_id
         and b.id = o.branch_id

        left join public.table_sessions ts
          on ts.tenant_id = o.tenant_id
         and ts.branch_id = o.branch_id
         and ts.id = o.table_session_id

        left join public.table_reservations r
          on r.tenant_id = o.tenant_id
         and r.branch_id = o.branch_id
         and r.id = o.reservation_id

        left join public.order_items oi
          on oi.tenant_id = o.tenant_id
         and oi.order_id = o.id

        left join lateral (
          select
            d.id,
            d.tenant_id,
            d.branch_id,
            d.status,

            m.role as membership_role,

            (
              select count(*)::integer

              from public.delivery_order_memberships bundle_member

              where bundle_member.tenant_id = d.tenant_id
                and bundle_member.branch_id = d.branch_id
                and bundle_member.delivery_id = d.id
                and bundle_member.membership_status in (
                  'PENDING',
                  'ACTIVE'
                )
            ) as member_count

          from public.delivery_order_memberships m

          inner join public.deliveries d
            on d.tenant_id = m.tenant_id
           and d.branch_id = m.branch_id
           and d.id = m.delivery_id

          where m.tenant_id = o.tenant_id
            and m.branch_id = o.branch_id
            and m.order_id = o.id
            and m.membership_status in (
              'PENDING',
              'ACTIVE'
            )

          order by
            case m.role
              when 'PRIMARY' then 0
              else 1
            end,
            m.joined_at

          limit 1
        ) operational_delivery
          on true

        left join lateral (
          select
            a.id,
            a.driver_id,
            a.status,
            a.accepted_at

          from public.delivery_assignments a

          where a.tenant_id = operational_delivery.tenant_id
            and a.branch_id = operational_delivery.branch_id
            and a.delivery_id = operational_delivery.id

          order by
            a.assignment_number desc,
            a.created_at desc

          limit 1
        ) operational_assignment
          on true

        left join public.delivery_drivers operational_driver
          on operational_driver.tenant_id = operational_delivery.tenant_id
         and operational_driver.id = operational_assignment.driver_id

        where t.code = $1
          and b.code = $2

          and o.status in (
            'PENDING',
            'CONFIRMED',
            'PREPARING',
            'READY'
          )

          and (
            o.order_type <> 'DELIVERY'
            or operational_delivery.id is null
            or operational_delivery.status not in (
              'PICKED_UP',
              'EN_ROUTE',
              'ARRIVED',
              'DELIVERED'
            )
          )

        group by
          o.id,
          o.order_number,
          o.tracking_token,
          o.order_type,
          o.status,
          o.payment_status,
          o.order_origin,
          o.currency,
          o.total,

          o.scheduled_for,
          o.customer_name,
          o.customer_phone,
          o.table_code,
          o.delivery_address,
          o.customer_notes,

          o.reservation_id,
          r.reservation_code,
          r.reserved_for,

          o.table_session_id,
          ts.status,
          ts.closed_at,

          o.created_at,
          o.updated_at

        order by
          case o.status
            when 'PENDING' then 1
            when 'CONFIRMED' then 2
            when 'PREPARING' then 3
            when 'READY' then 4
            else 5
          end,

          o.created_at asc
      `,
      [tenant, branch],
    );

    return {
      tenant,
      branch,

      total: result.rows.length,

      orders: result.rows.map((order) => ({
        id: order.id,

        orderNumber: order.order_number,

        trackingToken: order.tracking_token,

        orderType: order.order_type,

        status: order.status,

        paymentStatus: order.payment_status,

        orderOrigin: order.order_origin,

        currency: order.currency,

        total: Number(order.total),

        // ===================================================
        // FULFILLMENT PARA KDS
        // ===================================================

        fulfillment: {
          scheduledFor: order.scheduled_for,

          customerName: order.customer_name,

          customerPhone: order.customer_phone,

          tableCode: order.table_code,

          deliveryAddress: order.delivery_address,

          customerNotes: order.customer_notes,
        },

        reservation: order.reservation_id
          ? {
              id: order.reservation_id,
              reservationCode: order.reservation_code,
              reservedFor: order.reservation_reserved_for,
            }
          : null,

        // ===================================================
        // TABLES V0.3
        // Estado autoritativo de la sesión vinculada.
        // ===================================================

        tableSession:
          order.table_session_id === null || order.table_session_status === null
            ? null
            : {
                id: order.table_session_id,

                status: order.table_session_status,

                closedAt: order.table_session_closed_at,
              },

        delivery: order.operational_delivery_id
          ? {
              id: order.operational_delivery_id,
              status: order.operational_delivery_status,

              relationshipRole:
                order.operational_delivery_role,

              memberCount:
                order.operational_delivery_member_count ??
                1,

              isShared:
                (
                  order.operational_delivery_member_count ??
                  1
                ) > 1,

              assignment: order.operational_assignment_id
                ? {
                    id: order.operational_assignment_id,
                    status: order.operational_assignment_status,
                    acceptedAt:
                      order.operational_assignment_accepted_at,
                    driver: order.operational_driver_id
                      ? {
                          id: order.operational_driver_id,
                          code: order.operational_driver_code,
                          name: order.operational_driver_name,
                        }
                      : null,
                  }
                : null,
            }
          : null,

        items: order.items,

        createdAt: order.created_at,

        updatedAt: order.updated_at,
      })),
    };
  }

  // =========================================================
  // CUSTOMER ORDER RECOVERY V1
  // =========================================================

  private readonly customerRecoveryCookieName =
    'flash_customer_session';

  private readonly customerRecoverySessionMaxAgeMs =
    30 * 24 * 60 * 60 * 1000;

  getCustomerRecoverySessionCookieName(): string {
    return this.customerRecoveryCookieName;
  }

  getCustomerRecoverySessionMaxAgeMs(): number {
    return this.customerRecoverySessionMaxAgeMs;
  }

  extractCustomerRecoverySessionToken(
    cookieHeader?: string,
  ): string | null {
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

  async enrollCustomerRecovery(
    input: CustomerRecoveryEnrollInput,
  ) {
    const trackingToken =
      input.trackingToken?.trim() || '';

    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        trackingToken,
      )
    ) {
      throw new BadRequestException(
        'trackingToken must be a valid UUID',
      );
    }

    const phoneNormalized =
      this.normalizeCustomerRecoveryPhone(input.phone);

    const pin =
      this.normalizeCustomerRecoveryPin(input.pin);

    const orderResult =
      await this.databaseService.query<{
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
      throw new BadRequestException('Usa el telefono de contacto de este pedido para activar su recuperacion');
    }

    let account =
      await this.findCustomerRecoveryAccount(
        order.tenant_id,
        phoneNormalized,
      );

    if (account) {
      await this.assertCustomerRecoveryPin(
        account,
        pin,
      );
    } else {
      const created =
        await this.databaseService.query<{
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
          [
            order.tenant_id,
            phoneNormalized,
            this.hashCustomerRecoveryPin(pin),
          ],
        );

      account = created.rows[0] ?? null;

      if (!account) {
        account =
          await this.findCustomerRecoveryAccount(
            order.tenant_id,
            phoneNormalized,
          );

        if (!account) {
          throw new ConflictException(
            'Customer recovery account could not be created',
          );
        }

        await this.assertCustomerRecoveryPin(
          account,
          pin,
        );
      }
    }

    if (
      order.customer_account_id &&
      order.customer_account_id !== account.id
    ) {
      throw new ConflictException(
        'Order is already linked to another recovery account',
      );
    }

    const linked = await this.databaseService.query(
      `update public.orders set customer_account_id=$3::uuid, updated_at=now()
       where tenant_id=$1::uuid and tracking_token=$2::uuid
         and (customer_account_id is null or customer_account_id=$3::uuid)
       returning id`, [order.tenant_id, trackingToken, account.id]);
    if (linked.rows.length !== 1) throw new ConflictException('Order is already linked to another recovery account');

    const sessionToken =
      await this.createCustomerRecoverySession(
        order.tenant_id,
        account.id,
      );

    const recoveredResult =
      await this.databaseService.query<{
        count: string;
      }>(
        `
          select count(*)::text as count
          from public.orders
          where tenant_id = $1::uuid
            and customer_account_id = $2::uuid
        `,
        [
          order.tenant_id,
          account.id,
        ],
      );

    return {
      sessionToken,
      tenantCode: order.tenant_code,
      recoveredOrderCount:
        Number(recoveredResult.rows[0]?.count ?? 0),
    };
  }

  async getCustomerRecoveryProfile(cookieHeader: string | undefined, tenantCode: string) {
    const raw = this.extractCustomerRecoverySessionToken(cookieHeader);
    const session = raw ? await this.findCustomerRecoverySessionByToken(raw) : null;
    if (!session || session.tenant_code !== tenantCode) throw new UnauthorizedException('Recovery session required');
    const result = await this.databaseService.query<{full_name: string | null}>(
      'select full_name from public.customer_accounts where id=$1::uuid and tenant_id=$2::uuid',
      [session.customer_account_id, session.tenant_id]);
    return { fullName: result.rows[0]?.full_name ?? '', phone: recoveryPhone(session.phone_normalized), tenantCode };
  }

  async registerCustomerRecovery(input: CustomerRecoveryLoginInput & {fullName?: string}, cookieHeader?: string) {
    const tenantCode = typeof input.tenantCode === 'string' ? input.tenantCode.trim() : '';
    const fullName = typeof input.fullName === 'string' ? input.fullName.trim().replace(/\s+/g, ' ') : '';
    if (fullName.length < 2 || fullName.length > 120) throw new BadRequestException('Enter a full name between 2 and 120 characters');
    const phone = this.normalizeCustomerRecoveryPhone(input.phone);
    const tenant = (await this.databaseService.query<{id:string;code:string}>(
      'select id::text,code from public.tenants where code=$1 limit 1', [tenantCode])).rows[0];
    if (!tenant) throw new UnauthorizedException('Invalid recovery credentials');
    const raw = this.extractCustomerRecoverySessionToken(cookieHeader);
    const session = raw ? await this.findCustomerRecoverySessionByToken(raw) : null;
    let account = await this.findCustomerRecoveryAccount(tenant.id, phone);
    const authenticated = Boolean(account && session && session.tenant_id === tenant.id &&
      session.customer_account_id === account.id && sameRecoveryPhone(phone, session.phone_normalized));
    if (!authenticated) {
      if (!input.pin) throw new UnauthorizedException('Recovery credentials required');
      const pin = this.normalizeCustomerRecoveryPin(input.pin);
      if (!account) {
        // Never claim historical orders by phone or replace a disabled/legacy account.
        await this.databaseService.query(`insert into public.customer_accounts (tenant_id,phone_normalized,pin_hash,full_name)
          select $1::uuid,$2,$3,$4 where not exists (
            select 1 from public.customer_accounts where tenant_id=$1::uuid and phone_normalized=any($5::text[]))
          on conflict (tenant_id,phone_normalized) do nothing`,
          [tenant.id, phone, this.hashCustomerRecoveryPin(pin), fullName, recoveryPhoneAliases(phone)]);
        account = await this.findCustomerRecoveryAccount(tenant.id, phone);
      }
      if (!account) {
        this.performDummyCustomerRecoveryPinWork(pin);
        throw new UnauthorizedException('Invalid recovery credentials');
      }
      await this.assertCustomerRecoveryPin(account, pin);
    }
    if (!account) throw new UnauthorizedException('Invalid recovery credentials');
    // Registration authenticates existing accounts but never renames them.
    // An explicit, session-bound and PIN-verified action updates the name.
    const sessionToken = authenticated ? raw! : await this.createCustomerRecoverySession(tenant.id, account.id);
    return { sessionToken, tenantCode, fullName, phone };
  }

  async updateCustomerRecoveryName(input: CustomerRecoveryLoginInput & {fullName?: string}, cookieHeader?: string) {
    const tenantCode = typeof input.tenantCode === 'string' ? input.tenantCode.trim() : '';
    const raw = this.extractCustomerRecoverySessionToken(cookieHeader);
    const session = raw ? await this.findCustomerRecoverySessionByToken(raw) : null;
    const phone = this.normalizeCustomerRecoveryPhone(input.phone);
    if (!session || session.tenant_code !== tenantCode || !sameRecoveryPhone(phone, session.phone_normalized))
      throw new UnauthorizedException('Invalid recovery credentials');
    const fullName = typeof input.fullName === 'string' ? input.fullName.trim().replace(/\s+/g, ' ') : '';
    if (fullName.length < 2 || fullName.length > 120) throw new BadRequestException('Enter a full name between 2 and 120 characters');
    const pin = this.normalizeCustomerRecoveryPin(input.pin);
    const account = await this.findCustomerRecoveryAccount(session.tenant_id, phone);
    if (!account || account.id !== session.customer_account_id) throw new UnauthorizedException('Invalid recovery credentials');
    await this.assertCustomerRecoveryPin(account, pin);
    // Recheck session validity at the write, including revocation during the request.
    const changed = await this.databaseService.query(
      `update public.customer_accounts a set full_name=$1, updated_at=now()
       where a.id=$2::uuid and a.tenant_id=$3::uuid and a.status='ACTIVE'
       and exists(select 1 from public.customer_sessions s where s.customer_account_id=a.id
         and s.tenant_id=a.tenant_id and s.token_hash=$4 and s.revoked_at is null and s.expires_at>now())
       returning a.id`, [fullName, account.id, session.tenant_id, this.hashCustomerRecoverySessionToken(raw!)]);
    if (!changed.rows.length) throw new UnauthorizedException('Invalid recovery credentials');
    return {authenticated:true};
  }

  async loginCustomerRecovery(
    input: CustomerRecoveryLoginInput,
  ) {
    const tenantCode =
      input.tenantCode?.trim() || '';

    if (!tenantCode) {
      throw new BadRequestException(
        'tenantCode is required',
      );
    }

    const phoneNormalized =
      this.normalizeCustomerRecoveryPhone(input.phone);

    const pin =
      this.normalizeCustomerRecoveryPin(input.pin);

    const tenantResult =
      await this.databaseService.query<{
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
      throw new UnauthorizedException(
        'Invalid recovery credentials',
      );
    }

    const account =
      await this.findCustomerRecoveryAccount(
        tenant.id,
        phoneNormalized,
      );

    if (!account) {
      this.performDummyCustomerRecoveryPinWork(pin);
      throw new UnauthorizedException(
        'Invalid recovery credentials',
      );
    }

    await this.assertCustomerRecoveryPin(
      account,
      pin,
    );

    const sessionToken =
      await this.createCustomerRecoverySession(
        tenant.id,
        account.id,
      );

    return {
      sessionToken,
      tenantCode: tenant.code,
    };
  }

  async linkCustomerRecoveryOrders(cookieHeader: string | undefined, input: {
    tenantCode?: string; branchCode?: string; trackingTokens?: unknown;
  }) {
    const tokens = input.trackingTokens;
    if (!Array.isArray(tokens) || tokens.length > 100 || tokens.some(t => typeof t !== 'string' || !RECOVERY_UUID.test(t))) {
      throw new BadRequestException('Invalid order access list');
    }
    const raw = this.extractCustomerRecoverySessionToken(cookieHeader);
    const session = raw ? await this.findCustomerRecoverySessionByToken(raw) : null;
    if (!session || session.tenant_code !== input.tenantCode) throw new UnauthorizedException('Customer recovery session required');
    const branchCode=input.branchCode?.trim();
    if (!branchCode) throw new BadRequestException('branch required');
    return this.databaseService.withTransaction(async client => {
      const result = await client.query<{
        id: string; customer_account_id: string | null; customer_phone: string | null;
      }>(`select o.id::text, o.customer_account_id::text, o.customer_phone
        from public.orders o join public.branches b on b.id=o.branch_id and b.tenant_id=o.tenant_id
        where o.tenant_id=$1::uuid and b.code=$2 and o.tracking_token=any($3::uuid[]) for update of o`,
        [session.tenant_id, branchCode, [...new Set(tokens)]]);
      const eligible = result.rows.filter(o => sameRecoveryPhone(o.customer_phone, session.phone_normalized)
        && (!o.customer_account_id || o.customer_account_id === session.customer_account_id));
      const ids = eligible.filter(o => !o.customer_account_id).map(o => o.id);
      if (ids.length) await client.query(`update public.orders set customer_account_id=$2::uuid, updated_at=now()
        where tenant_id=$1::uuid and id=any($3::uuid[]) and customer_account_id is null`,
        [session.tenant_id, session.customer_account_id, ids]);
      return { linked: ids.length };
    });
  }

  async getCustomerRecoveryOrders(
    cookieHeader: string | undefined, tenantCodeInput: string | undefined,
    branchCodeInput: string | undefined, cursor?: string,
  ) {
    const tenantCode=tenantCodeInput?.trim() || '', branchCode=branchCodeInput?.trim() || '';
    if (!tenantCode || !branchCode) throw new BadRequestException('tenant and branch are required');
    if (cursor && !RECOVERY_UUID.test(cursor)) throw new BadRequestException('Invalid recovery cursor');
    const raw=this.extractCustomerRecoverySessionToken(cookieHeader);
    const session=raw ? await this.findCustomerRecoverySessionByToken(raw) : null;
    if (!session || session.tenant_code !== tenantCode) throw new UnauthorizedException('Customer recovery session required');
    const result=await this.databaseService.query<{id:string; tracking_token:string}>(`
      select o.id::text, o.tracking_token::text from public.orders o
      join public.branches b on b.id=o.branch_id and b.tenant_id=o.tenant_id
      where o.tenant_id=$1::uuid and o.customer_account_id=$2::uuid and b.code=$3
        and ($4::uuid is null or (o.created_at,o.id) < (
          select c.created_at,c.id from public.orders c
          where c.id=$4::uuid and c.tenant_id=o.tenant_id and c.customer_account_id=o.customer_account_id and c.branch_id=o.branch_id
        ))
      order by o.created_at desc,o.id desc limit $5`,
      [session.tenant_id, session.customer_account_id, branchCode, cursor || null, RECOVERY_PAGE_SIZE+1]);
    const page=result.rows.slice(0,RECOVERY_PAGE_SIZE);
    return {authenticated:true,tenantCode,branchCode,
      orderTrackingTokens:page.map(o=>o.tracking_token),
      nextCursor:result.rows.length>RECOVERY_PAGE_SIZE ? page[page.length-1].id : null};
  }

  async logoutCustomerRecovery(
    cookieHeader?: string,
  ) {
    const rawToken =
      this.extractCustomerRecoverySessionToken(
        cookieHeader,
      );

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

  private normalizeCustomerRecoveryPhone(
    value?: string,
  ): string {
    const normalized =
      recoveryPhone(value);

    if (
      normalized.length < 7 ||
      normalized.length > 15
    ) {
      throw new BadRequestException(
        'phone must contain between 7 and 15 digits',
      );
    }

    return normalized;
  }

  private normalizeCustomerRecoveryPin(
    value?: string,
  ): string {
    const pin = value?.trim() || '';

    if (!/^\d{6}$/.test(pin)) {
      throw new BadRequestException(
        'pin must contain exactly 6 digits',
      );
    }

    return pin;
  }

  private hashCustomerRecoveryPin(
    pin: string,
  ): string {
    const salt = randomBytes(16);

    const derived =
      scryptSync(pin, salt, 64);

    return `scrypt$${salt.toString('base64url')}$${derived.toString('base64url')}`;
  }

  private verifyCustomerRecoveryPin(
    pin: string,
    encoded: string,
  ): boolean {
    const [
      algorithm,
      saltEncoded,
      hashEncoded,
    ] = encoded.split('$');

    if (
      algorithm !== 'scrypt' ||
      !saltEncoded ||
      !hashEncoded
    ) {
      return false;
    }

    try {
      const salt =
        Buffer.from(
          saltEncoded,
          'base64url',
        );

      const expected =
        Buffer.from(
          hashEncoded,
          'base64url',
        );

      const actual =
        scryptSync(
          pin,
          salt,
          expected.length,
        );

      return (
        expected.length === actual.length &&
        timingSafeEqual(expected, actual)
      );
    } catch {
      return false;
    }
  }

  private performDummyCustomerRecoveryPinWork(
    pin: string,
  ) {
    scryptSync(
      pin,
      Buffer.alloc(16, 1),
      64,
    );
  }

  private async findCustomerRecoveryAccount(
    tenantId: string,
    phoneNormalized: string,
  ) {
    const result =
      await this.databaseService.query<{
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
        [
          tenantId,
          recoveryPhoneAliases(phoneNormalized),
        ],
      );

    if (result.rows.length > 1) throw new ConflictException('Recovery account requires administrative review');
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
    const lockedUntil =
      account.locked_until
        ? new Date(account.locked_until)
        : null;

    if (
      lockedUntil &&
      lockedUntil.getTime() > Date.now()
    ) {
      throw new HttpException(
        { message: 'Recovery temporarily locked', retryAfterSeconds: Math.max(1, Math.ceil((lockedUntil.getTime() - Date.now()) / 1000)) },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const valid =
      this.verifyCustomerRecoveryPin(
        pin,
        account.pin_hash,
      );

    if (!valid) {
      // Increment the persisted counter atomically: concurrent failures cannot overwrite one another.
      await this.databaseService.query(
        `update public.customer_accounts
         set failed_attempts=failed_attempts+1,
             locked_until=case when failed_attempts+1>=5
               then greatest(coalesce(locked_until,now()),now()+interval '15 minutes')
               else locked_until end,
             updated_at=now()
         where id=$1::uuid`, [account.id]);

      throw new UnauthorizedException(
        'Invalid recovery credentials',
      );
    }

    if (
      account.failed_attempts !== 0 ||
      account.locked_until
    ) {
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

  private hashCustomerRecoverySessionToken(
    token: string,
  ): string {
    return createHash('sha256')
      .update(token, 'utf8')
      .digest('hex');
  }

  private async createCustomerRecoverySession(
    tenantId: string,
    customerAccountId: string,
  ): Promise<string> {
    const rawToken =
      randomBytes(32).toString('base64url');

    const tokenHash =
      this.hashCustomerRecoverySessionToken(
        rawToken,
      );

    const expiresAt =
      new Date(
        Date.now() +
          this.customerRecoverySessionMaxAgeMs,
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
      [
        tenantId,
        customerAccountId,
        tokenHash,
        expiresAt.toISOString(),
      ],
    );

    return rawToken;
  }

  private async findCustomerRecoverySessionByToken(
    rawToken: string,
  ) {
    const tokenHash =
      this.hashCustomerRecoverySessionToken(
        rawToken,
      );

    const result =
      await this.databaseService.query<{
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
