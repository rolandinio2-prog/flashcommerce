import { posCartRevision } from './pos-cart-revision';
import { assertPosCartAccess } from './pos-cart-access';
import { normalizePosCheckout, type PosCheckoutInput } from './pos-checkout';
import { lockBranchAdmission } from '../branch-operations/service-policy';
import { type StaffSessionPrincipal } from '../staff/staff.types';
import { sauceOrderItems } from '../cart/sauce-pricing';
import { prepareRiceItems } from '../cart/rice-choice';
import { reserveOrderStock } from './stock-reservation';
import { sameRecoveryPhone } from './recovery-access';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { issueQuote, requireQuoteToken, verifyQuote } from './checkout-quote';
import { DatabaseService } from '../database/database.service';
import { DeliveryService } from '../delivery/delivery.service';
import {
  type CreatedDelivery,
  type DeliveryCheckoutQuote,
  type DeliveryCheckoutRouteSnapshot,
} from '../delivery/delivery.types';
import {
  type TableContextPayload,
  verifyTableContextToken,
} from '../tables/table-context-token';
import {
  type OrderType,
  type CreateOrderInput,
  type OrderStatus,
  type OrderPaymentStatus,
  type OrderOrigin,
  ORDER_TYPES,
  type CartRow,
  type CheckoutItemRow,
  type CreatedOrderRow,
  type CheckoutDiningTableRow,
  type OpenTableSessionRow,
  type AdditionalOrderContextRow,
  type AdditionalDeliveryPreflightRow,
  type AdditionalDeliveryOrderContextRow,
  type CreatedTableSessionRow,
  type ReservationOrderContextRow,
} from './order.types';
import { OrderTrackingService } from './order-tracking.service';
import { CustomerRecoveryService } from './customer-recovery.service';

@Injectable()
export class CheckoutService {
  constructor(
    private readonly databaseService: DatabaseService,
    private readonly deliveryService: DeliveryService,
    private readonly orderTracking: OrderTrackingService,
    private readonly customerRecovery: CustomerRecoveryService,
  ) {}

  // =======================================================
  // 1. CREAR PEDIDO
  //
  // Convierte un carrito OPEN en una Order PENDING.
  // También guarda los datos de Fulfillment V0.1.
  // =======================================================

  async quoteDelivery(input: CreateOrderInput) {
    if (input.orderType !== 'DELIVERY')
      throw new BadRequestException('Solo se cotizan envíos DELIVERY.');
    const result = await this.checkout(input, undefined, true);
    if (result.kind !== 'quote') throw new Error('Quote invariant failed');
    return result.quote;
  }

  async createOrder(
    input: CreateOrderInput,
    customerRecoverySessionToken?: string | null,
  ) {
    const result = await this.checkout(
      input,
      customerRecoverySessionToken,
      false,
    );
    if (result.kind !== 'order') throw new Error('Order invariant failed');
    return result.order;
  }

  async createPosOrder(
    input: PosCheckoutInput,
    staff: StaffSessionPrincipal,
  ): Promise<unknown> {
    const value = normalizePosCheckout(input);
    const replay = async () => {
      const result = await this.databaseService.query<{
        order_id: string;
        tracking_token: string;
        checkout_hash: string;
      }>(
        'select o.id::text as order_id,o.tracking_token::text,d.checkout_hash from public.pos_drafts d join public.carts c on c.id=d.cart_id join public.orders o on o.id=d.order_id where c.cart_token=$1::uuid and d.tenant_id=$2::uuid and d.branch_id=$3::uuid and d.staff_user_id=$4::uuid',
        [value.cartToken, staff.tenantId, staff.branchId, staff.userId],
      );
      const row = result.rows[0];
      if (!row) return null;
      if (row.checkout_hash !== value.intentHash)
        throw new ConflictException('El pedido ya fue creado con otros datos.');
      return {
        ...(await this.orderTracking.getOrderTracking(row.tracking_token)),
        id: row.order_id,
      };
    };
    const saved = await replay();
    if (saved) return saved;
    try {
      const result = await this.checkout(value, undefined, false, {
        staff,
        intentHash: value.intentHash,
        expectedTotal: value.expectedTotal,
        expectedRevision: value.expectedRevision,
      });
      if (result.kind !== 'order') throw new Error('POS invariant');
      return result.order;
    } catch (error) {
      // Only read a committed concurrent result; never retry checkout writes.
      if (error instanceof ConflictException) {
        const saved = await replay();
        if (saved) return saved;
      }
      throw error;
    }
  }

  private async checkout(
    input: CreateOrderInput,
    customerRecoverySessionToken: string | null | undefined,
    quoteOnly: boolean,
    pos?: {
      staff: StaffSessionPrincipal;
      intentHash: string;
      expectedTotal: number;
      expectedRevision: string;
    },
  ) {
    // Quote mode must never enter reservation/table-session mutation paths.
    if (
      quoteOnly &&
      (input.orderType !== 'DELIVERY' ||
        input.tableCode ||
        input.tableContextToken ||
        input.reservationTrackingToken)
    ) {
      throw new BadRequestException(
        'Contexto no válido para cotizar un envío.',
      );
    }
    if (input.orderType === 'DELIVERY' && !quoteOnly)
      requireQuoteToken(input.deliveryQuoteToken);
    if (
      typeof input.cartToken !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        input.cartToken.trim(),
      )
    ) {
      throw new BadRequestException('cartToken must be a valid UUID');
    }
    const customerRecoverySession = customerRecoverySessionToken
      ? await this.customerRecovery.findCustomerRecoverySessionByToken(
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
      (deliveryLatitude !== undefined &&
        deliveryLatitude !== null &&
        deliveryLatitude !== '') ||
      (deliveryLongitude !== undefined &&
        deliveryLongitude !== null &&
        deliveryLongitude !== '');

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
      if (orderType !== 'DINE_IN' && orderType !== 'DELIVERY') {
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
        if (!pos && !customerName)
          throw new BadRequestException(
            'customerName is required for TAKEAWAY',
          );
        if (
          !pos &&
          (!customerPhone ||
            !/^[0-9]{7,15}$/.test(customerPhone.replace(/\D/g, '')))
        )
          throw new BadRequestException(
            'A valid customerPhone is required for TAKEAWAY',
          );
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

    let additionalDeliveryPreflight: AdditionalDeliveryPreflightRow | null =
      null;

    if (orderType === 'DELIVERY' && additionalToTrackingToken) {
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

      additionalDeliveryPreflight = sourceResult.rows[0] ?? null;

      if (!additionalDeliveryPreflight) {
        throw new ConflictException(
          'Additional delivery source must have a dispatchable DELIVERY payment contract',
        );
      }

      customerName = customerName ?? additionalDeliveryPreflight.customer_name;

      customerPhone =
        customerPhone ?? additionalDeliveryPreflight.customer_phone;

      if (!hasRequestedDeliveryDestination) {
        deliveryAddress = additionalDeliveryPreflight.address_text;

        deliveryReference = additionalDeliveryPreflight.address_reference;

        deliveryLatitude = Number(
          additionalDeliveryPreflight.destination_latitude,
        );

        deliveryLongitude = Number(
          additionalDeliveryPreflight.destination_longitude,
        );
      }
    }

    if (orderType === 'DELIVERY') {
      if (!customerName) {
        throw new BadRequestException('customerName is required for DELIVERY');
      }

      if (!customerPhone) {
        throw new BadRequestException('customerPhone is required for DELIVERY');
      }

      if (!deliveryAddress) {
        throw new BadRequestException(
          'deliveryAddress is required for DELIVERY',
        );
      }
    }

    let deliveryRouteSnapshot: DeliveryCheckoutRouteSnapshot | null = null;

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

      await assertPosCartAccess(client, cart.id, pos?.staff);
      if (
        pos &&
        (cart.tenant_id !== pos.staff.tenantId ||
          cart.branch_id !== pos.staff.branchId)
      )
        throw new NotFoundException('Cart not found');
      await lockBranchAdmission(client, cart.tenant_id, cart.branch_id, [
        'ORDERING',
        orderType,
      ]);

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

      let additionalDeliveryContext: AdditionalDeliveryOrderContextRow | null =
        null;

      let joinAdditionalToExistingDelivery = false;

      if (additionalToTrackingToken && orderType === 'DELIVERY') {
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
            [additionalToTrackingToken, cart.tenant_id, cart.branch_id],
          );

        additionalDeliveryContext = additionalDeliveryResult.rows[0] ?? null;

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

        customerName = customerName ?? additionalDeliveryContext.customer_name;

        customerPhone =
          customerPhone ?? additionalDeliveryContext.customer_phone;

        if (!hasRequestedDeliveryDestination) {
          deliveryAddress = additionalDeliveryContext.address_text;

          deliveryReference = additionalDeliveryContext.address_reference;

          deliveryLatitude = Number(
            additionalDeliveryContext.destination_latitude,
          );

          deliveryLongitude = Number(
            additionalDeliveryContext.destination_longitude,
          );
        }

        const effectiveLatitude = Number(deliveryLatitude);

        const effectiveLongitude = Number(deliveryLongitude);

        const sourceLatitude = Number(
          additionalDeliveryContext.destination_latitude,
        );

        const sourceLongitude = Number(
          additionalDeliveryContext.destination_longitude,
        );

        // Conservative V1:
        // the physical Delivery still owns one recipient.
        // A changed recipient therefore gets a separate
        // Delivery until the Driver bundle UI is fully
        // member-aware.
        const sameRecipient =
          (customerName ?? '').trim().toLowerCase() ===
            (additionalDeliveryContext.customer_name ?? '')
              .trim()
              .toLowerCase() &&
          (customerPhone ?? '').trim() ===
            (additionalDeliveryContext.customer_phone ?? '').trim();

        const sameAddress =
          (deliveryAddress ?? '').trim().toLowerCase() ===
          additionalDeliveryContext.address_text.trim().toLowerCase();

        const sameCoordinates =
          Number.isFinite(effectiveLatitude) &&
          Number.isFinite(effectiveLongitude) &&
          Number.isFinite(sourceLatitude) &&
          Number.isFinite(sourceLongitude) &&
          Math.abs(effectiveLatitude - sourceLatitude) <= 0.000001 &&
          Math.abs(effectiveLongitude - sourceLongitude) <= 0.000001;

        joinAdditionalToExistingDelivery =
          additionalDeliveryContext.delivery_status === 'CREATED' &&
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

      if (additionalToTrackingToken && orderType === 'DINE_IN') {
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
            [additionalToTrackingToken, cart.tenant_id, cart.branch_id],
          );

        additionalOrderContext = additionalOrderResult.rows[0] ?? null;

        if (!additionalOrderContext) {
          throw new ConflictException(
            'Additional order source must be a paid DINE_IN order with an open table session',
          );
        }

        if (tableCode && tableCode !== additionalOrderContext.table_code) {
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
            `Reservation cannot receive a preorder from ${String(reservationContext.status)}`,
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
      if (pos && posCartRevision(items) !== pos.expectedRevision)
        throw new ConflictException(
          'Los productos cambiaron. Revisa el carrito.',
        );
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
          (quantitiesByProduct.get(item.product_id) ?? 0) >
            item.available_quantity
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

      const pricedOrderItems = sauceOrderItems(
        cart.tenant_code,
        cart.branch_code,
        items,
      );
      const subtotal = pricedOrderItems.reduce(
        (total, item) => total + Number(item.price) * item.quantity,
        0,
      );
      const discountTotal = 0;

      let deliveryQuote: DeliveryCheckoutQuote | null = null;

      let deliveryFee = 0;

      if (orderType === 'DELIVERY') {
        if (!deliveryRouteSnapshot) {
          throw new Error('Delivery route snapshot invariant failed');
        }

        deliveryQuote = await this.deliveryService.quoteDeliveryForCheckout(
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

        deliveryFee = joinAdditionalToExistingDelivery
          ? 0
          : deliveryQuote.deliveryFee;
      }

      const total = subtotal - discountTotal + deliveryFee;

      if (orderType === 'DELIVERY' && deliveryQuote && deliveryRouteSnapshot) {
        // Same locked cart, current prices, zone rules and JOIN decision for preview and confirmation.
        // Route travel time is an estimate; only the origin/destination and commercial terms are bound.
        const context = JSON.stringify({
          cart: [cart.id, cart.tenant_id, cart.branch_id, cart.currency],
          items: items
            .map((item) => [
              item.product_id,
              item.rice_choice,
              item.quantity,
              Number(item.price),
              item.currency,
            ])
            .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
          destination: [
            deliveryAddress,
            deliveryReference,
            deliveryLatitude,
            deliveryLongitude,
          ],
          recipient: [customerName, customerPhone],
          origin: deliveryRouteSnapshot.origin,
          additional: [
            additionalToTrackingToken,
            additionalDeliveryContext?.delivery_id ?? null,
            joinAdditionalToExistingDelivery,
          ],
          zone: [
            deliveryQuote.zoneId,
            deliveryQuote.zone.code,
            deliveryQuote.minimumOrder,
          ],
          totals: [subtotal, discountTotal, deliveryFee, total],
        });
        if (quoteOnly)
          return {
            kind: 'quote' as const,
            quote: {
              ...issueQuote(context),
              coverage: true as const,
              tenant: cart.tenant_code,
              branch: cart.branch_code,
              currency: cart.currency,
              zone: deliveryQuote.zone,
              minimumOrder: deliveryQuote.minimumOrder,
              subtotal,
              discountTotal,
              deliveryFee,
              total,
              eta: deliveryQuote.eta,
              deliveryMode: joinAdditionalToExistingDelivery
                ? ('JOINED_EXISTING' as const)
                : ('SEPARATE_DELIVERY' as const),
            },
          };
        // Failure rolls back; it never silently creates an order at a different price.
        verifyQuote(input.deliveryQuoteToken, context);
      }
      if (quoteOnly) throw new Error('Delivery quote invariant failed');

      // Gate 7B.1: una reserva confirmada ya no confirma por si sola
      // el pedido. Todo pedido nuevo espera confirmacion de pago.
      if (
        pos &&
        Math.round(total * 100) !== Math.round(pos.expectedTotal * 100)
      )
        throw new ConflictException('El total cambió. Revisa el carrito.');
      const initialOrderStatus: OrderStatus = 'PENDING';
      const initialPaymentStatus: OrderPaymentStatus = 'PENDING';

      const orderOrigin: OrderOrigin = pos
        ? 'OPS_STAFF'
        : reservationContext
          ? 'RESERVATION_PREORDER'
          : tableContext
            ? 'TABLE_QR'
            : 'PUBLIC_MENU';

      // --------------------------------------------------
      // 1.5.5. Crear Order + Fulfillment + Table Session.
      // --------------------------------------------------

      if (
        input.requireRecoveryProfile &&
        (!customerRecoverySession ||
          customerRecoverySession.tenant_id !== cart.tenant_id ||
          !sameRecoveryPhone(
            customerPhone,
            customerRecoverySession.phone_normalized,
          ))
      ) {
        throw new UnauthorizedException(
          'Recovery session required before checkout',
        );
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
          sameRecoveryPhone(
            customerPhone,
            customerRecoverySession.phone_normalized,
          )
            ? customerRecoverySession.customer_account_id
            : null,
          additionalToTrackingToken,
        ],
      );

      const order = orderResult.rows[0];

      // Reservar unidades de productos con inventario controlado. El UPDATE
      // condicionado en la base serializa compradores simultaneos: si otro
      // pedido tomo las ultimas unidades, este checkout se revierte completo.
      await reserveOrderStock(client, {
        tenantId: cart.tenant_id,
        branchId: cart.branch_id,
        orderId: order.id,
        quantities: quantitiesByProduct,
        names: new Map(items.map((item) => [item.product_id, item.name])),
      });

      if (pos)
        await client.query(
          'update public.pos_drafts set order_id=$2::uuid,checkout_hash=$3 where cart_id=$1::uuid',
          [cart.id, order.id, pos.intentHash],
        );

      let createdDelivery: CreatedDelivery | null = null;

      if (orderType === 'DELIVERY') {
        if (
          !deliveryQuote ||
          !customerName ||
          !customerPhone ||
          !deliveryAddress
        ) {
          throw new Error('Delivery checkout invariant failed');
        }

        if (joinAdditionalToExistingDelivery && additionalDeliveryContext) {
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
            id: additionalDeliveryContext.delivery_id,

            trackingToken: additionalDeliveryContext.delivery_tracking_token,

            status: 'CREATED',
          };
        } else {
          createdDelivery = await this.deliveryService.createDeliveryForOrder(
            client,
            {
              tenantId: cart.tenant_id,
              branchId: cart.branch_id,

              orderId: order.id,

              quote: deliveryQuote,

              recipientName: customerName,
              recipientPhone: customerPhone,

              addressText: deliveryAddress,
              addressReference: deliveryReference,

              latitude: deliveryLatitude as number,

              longitude: deliveryLongitude as number,
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

      return {
        kind: 'order' as const,
        order: {
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
            orderType === 'DELIVERY' && additionalToTrackingToken
              ? {
                  mode: joinAdditionalToExistingDelivery
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
        },
      };
    });
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
    const cartResult = await this.databaseService.query<CartRow>(
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
      [cartToken],
    );

    const cart = cartResult.rows[0];

    if (!cart) {
      throw new NotFoundException('Cart not found');
    }

    if (cart.status !== 'OPEN') {
      throw new ConflictException(`Cart is not open: ${cart.status}`);
    }

    if (new Date(cart.expires_at).getTime() <= Date.now()) {
      throw new ConflictException('Cart has expired');
    }

    const itemsResult = await this.databaseService.query<CheckoutItemRow>(
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
      [cart.tenant_id, cart.id, cart.branch_id],
    );

    const items = itemsResult.rows;
    const quantitiesByProduct = prepareRiceItems(items);

    if (items.length === 0) {
      throw new BadRequestException('Cart is empty');
    }

    for (const item of items) {
      if (!item.is_available || item.price === null || item.currency === null) {
        throw new ConflictException(`${item.name} is no longer available`);
      }

      if (
        item.available_quantity !== null &&
        (quantitiesByProduct.get(item.product_id) ?? 0) >
          item.available_quantity
      ) {
        throw new ConflictException(
          `${item.name}: only ${item.available_quantity} units are available`,
        );
      }

      if (item.currency !== cart.currency) {
        throw new ConflictException(`${item.name} has a different currency`);
      }
    }

    const pricedOrderItems = sauceOrderItems(
      cart.tenant_code,
      cart.branch_code,
      items,
    );
    const subtotal = pricedOrderItems.reduce(
      (total, item) => total + Number(item.price) * item.quantity,
      0,
    );

    return this.deliveryService.prepareDeliveryCheckoutRoute({
      tenantId: cart.tenant_id,

      branchId: cart.branch_id,

      latitude,
      longitude,

      subtotal,
    });
  }
}
