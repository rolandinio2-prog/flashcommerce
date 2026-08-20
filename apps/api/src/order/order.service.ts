import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
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
  cartToken?: string;
  orderType?: string;

  scheduledFor?: string;

  customerName?: string;
  customerPhone?: string;

  tableCode?: string;
  tableContextToken?: string;
  reservationTrackingToken?: string;

  deliveryAddress?: string;
  deliveryLatitude?: unknown;
  deliveryLongitude?: unknown;
  deliveryReference?: string;

  customerNotes?: string;
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

  async createOrder(input: CreateOrderInput) {
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

    const deliveryAddress = input.deliveryAddress?.trim() || null;

    const deliveryReference = input.deliveryReference?.trim() || null;

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

        break;
      }
    }
    // ----------------------------------------------------
    // 1.5. Transacción de checkout.
    // ----------------------------------------------------

    let deliveryRouteSnapshot:
      DeliveryCheckoutRouteSnapshot | null =
      null;

    if (orderType === 'DELIVERY') {
      deliveryRouteSnapshot =
        await this.prepareDeliveryRouteSnapshotForCheckout(
          cartToken.trim(),
          input.deliveryLatitude,
          input.deliveryLongitude,
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

        if (openSession && !tableContext) {
          throw new ConflictException(
            `${diningTable.name} is already occupied`,
          );
        }

        if (openSession) {
          // El QR contextual identifica al mismo grupo que ya
          // se encuentra en la mesa. Reutilizamos su sesión.
          tableSessionId = openSession.id;
        } else {
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
                p.sku,
                p.name,

                ci.quantity,

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

              order by ci.created_at

              for update of ci
            `,
        [cart.tenant_id, cart.id, cart.branch_id],
      );

      const items = itemsResult.rows;

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
          item.quantity > item.available_quantity
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

      const subtotal = items.reduce(
        (total, item) => total + Number(item.price) * item.quantity,
        0,
      );

      const discountTotal = 0;

      let deliveryQuote: DeliveryCheckoutQuote | null = null;

      let deliveryFee = 0;

      if (orderType === 'DELIVERY') {
        if (!deliveryRouteSnapshot) {
          throw new Error(
            'Delivery route snapshot invariant failed',
          );
        }

        deliveryQuote = await this.deliveryService.quoteDeliveryForCheckout(
          client,
          {
            tenantId: cart.tenant_id,
            branchId: cart.branch_id,

            latitude: input.deliveryLatitude,
            longitude: input.deliveryLongitude,

            subtotal,
            routeSnapshot: deliveryRouteSnapshot,
          },
        );

        deliveryFee = deliveryQuote.deliveryFee;
      }

      const total = subtotal - discountTotal + deliveryFee;

      // Gate 7B.1: una reserva confirmada ya no confirma por si sola
      // el pedido. Todo pedido nuevo espera confirmacion de pago.
      const initialOrderStatus: OrderStatus = 'PENDING';
      const initialPaymentStatus: OrderPaymentStatus = 'PENDING';

      const orderOrigin: OrderOrigin = reservationContext
        ? 'RESERVATION_PREORDER'
        : tableContext
          ? 'TABLE_QR'
          : 'PUBLIC_MENU';

      // --------------------------------------------------
      // 1.5.5. Crear Order + Fulfillment + Table Session.
      // --------------------------------------------------

      const orderResult = await client.query<CreatedOrderRow>(
        `
              insert into public.orders (
                tenant_id,
                branch_id,
                cart_id,

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
        ],
      );

      const order = orderResult.rows[0];

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

            latitude: input.deliveryLatitude as number,
            longitude: input.deliveryLongitude as number,
          },
        );
      }

      // --------------------------------------------------
      // 1.5.6. Crear snapshot de cada item.
      // --------------------------------------------------

      for (const item of items) {
        const unitPrice = Number(item.price);

        const lineTotal = unitPrice * item.quantity;

        await client.query(
          `
              insert into public.order_items (
                tenant_id,
                order_id,
                product_id,
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
                $9
              )
            `,
          [
            cart.tenant_id,
            order.id,
            item.product_id,
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
        id: order.id,

        orderNumber: order.order_number,

        trackingToken: order.tracking_token,

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

        delivery:
          createdDelivery && deliveryQuote
            ? {
                id: createdDelivery.id,
                trackingToken: createdDelivery.trackingToken,
                status: createdDelivery.status,

                zone: {
                  code: deliveryQuote.zone.code,
                  name: deliveryQuote.zone.name,
                },

                deliveryFee: deliveryQuote.deliveryFee,

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

        items: items.map((item) => ({
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
      };
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
            p.sku,
            p.name,

            ci.quantity,

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
          order by ci.created_at
        `,
        [
          cart.tenant_id,
          cart.id,
          cart.branch_id,
        ],
      );

    const items =
      itemsResult.rows;

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
        item.quantity >
          item.available_quantity
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

    const subtotal =
      items.reduce(
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

              for update
            `,
        [orderId],
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

        where t.code = $1
          and b.code = $2

          and o.status in (
            'PENDING',
            'CONFIRMED',
            'PREPARING',
            'READY'
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

        items: order.items,

        createdAt: order.created_at,

        updatedAt: order.updated_at,
      })),
    };
  }
}
