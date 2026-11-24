import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { Throttle } from '@nestjs/throttler';
import {
  RecoveryRequestGuard,
  recoveryCookieSecure,
} from './recovery-request.guard';
import { CheckoutService } from './checkout.service';
import { CustomerRecoveryService } from './customer-recovery.service';
import { OrderTrackingService } from './order-tracking.service';
import type {
  CreateOrderInput,
  CustomerRecoveryEnrollInput,
  CustomerRecoveryLoginInput,
} from './order.types';

@Controller('orders')
export class OrderController {
  constructor(
    private readonly checkout: CheckoutService,
    private readonly customerRecovery: CustomerRecoveryService,
    private readonly orderTracking: OrderTrackingService,
  ) {}

  // =======================================================
  // CREAR PEDIDO
  //
  // Recibe cartToken + orderType y, opcionalmente,
  // los datos de Fulfillment V0.1.
  // =======================================================

  @Throttle({ default: { limit: 12, ttl: 60_000 } })
  @Post('delivery-quote')
  quoteDelivery(
    @Body() body: CreateOrderInput,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    return this.checkout.quoteDelivery(body);
  }

  @Post()
  createOrder(
    @Body() body: CreateOrderInput,
    @Headers('cookie') cookieHeader?: string,
  ) {
    const recoverySessionToken =
      this.customerRecovery.extractCustomerRecoverySessionToken(cookieHeader);

    return this.checkout.createOrder(body, recoverySessionToken);
  }

  // =======================================================
  // CUSTOMER ORDER RECOVERY V1
  // =======================================================

  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @UseGuards(RecoveryRequestGuard)
  @Post('recovery/enroll')
  async enrollCustomerRecovery(
    @Body() body: CustomerRecoveryEnrollInput,
    @Res({ passthrough: true }) response: Response,
  ) {
    const result = await this.customerRecovery.enrollCustomerRecovery(body);

    response.cookie(
      this.customerRecovery.getCustomerRecoverySessionCookieName(),
      result.sessionToken,
      {
        httpOnly: true,
        sameSite: 'lax',
        secure: recoveryCookieSecure(),
        path: '/',
        maxAge: this.customerRecovery.getCustomerRecoverySessionMaxAgeMs(),
      },
    );

    return {
      authenticated: true,
      tenantCode: result.tenantCode,
      recoveredOrderCount: result.recoveredOrderCount,
    };
  }

  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @UseGuards(RecoveryRequestGuard)
  @Post('recovery/login')
  async loginCustomerRecovery(
    @Body() body: CustomerRecoveryLoginInput,
    @Res({ passthrough: true }) response: Response,
  ) {
    const result = await this.customerRecovery.loginCustomerRecovery(body);

    response.cookie(
      this.customerRecovery.getCustomerRecoverySessionCookieName(),
      result.sessionToken,
      {
        httpOnly: true,
        sameSite: 'lax',
        secure: recoveryCookieSecure(),
        path: '/',
        maxAge: this.customerRecovery.getCustomerRecoverySessionMaxAgeMs(),
      },
    );

    return {
      authenticated: true,
      tenantCode: result.tenantCode,
    };
  }

  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @UseGuards(RecoveryRequestGuard)
  @Post('recovery/register')
  async registerCustomerRecovery(
    @Body() body: CustomerRecoveryLoginInput & { fullName?: string },
    @Headers('cookie') cookieHeader: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ) {
    const result = await this.customerRecovery.registerCustomerRecovery(
      body,
      cookieHeader,
    );
    response.setHeader('Cache-Control', 'no-store');
    response.cookie(
      this.customerRecovery.getCustomerRecoverySessionCookieName(),
      result.sessionToken,
      {
        httpOnly: true,
        sameSite: 'lax',
        secure: recoveryCookieSecure(),
        path: '/',
        maxAge: this.customerRecovery.getCustomerRecoverySessionMaxAgeMs(),
      },
    );
    return { authenticated: true, tenantCode: result.tenantCode };
  }

  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @UseGuards(RecoveryRequestGuard)
  @Post('recovery/profile/name')
  updateCustomerRecoveryName(
    @Body() body: CustomerRecoveryLoginInput & { fullName?: string },
    @Headers('cookie') cookieHeader: string | undefined,
  ) {
    return this.customerRecovery.updateCustomerRecoveryName(body, cookieHeader);
  }

  @Get('recovery/profile')
  getCustomerRecoveryProfile(
    @Query('tenant') tenantCode: string,
    @Headers('cookie') cookieHeader: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    return this.customerRecovery.getCustomerRecoveryProfile(
      cookieHeader,
      tenantCode,
    );
  }

  @UseGuards(RecoveryRequestGuard)
  @Post('recovery/logout')
  async logoutCustomerRecovery(
    @Headers('cookie') cookieHeader: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ) {
    await this.customerRecovery.logoutCustomerRecovery(cookieHeader);

    response.clearCookie(
      this.customerRecovery.getCustomerRecoverySessionCookieName(),
      {
        httpOnly: true,
        sameSite: 'lax',
        secure: recoveryCookieSecure(),
        path: '/',
      },
    );

    return { authenticated: false };
  }

  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @UseGuards(RecoveryRequestGuard)
  @Post('recovery/link')
  linkCustomerRecoveryOrders(
    @Body()
    body: {
      tenantCode?: string;
      branchCode?: string;
      trackingTokens?: unknown;
    },
    @Headers('cookie') cookieHeader?: string,
  ) {
    return this.customerRecovery.linkCustomerRecoveryOrders(cookieHeader, body);
  }

  @Get('recovery/orders')
  getCustomerRecoveryOrders(
    @Query('tenant') tenantCode: string,
    @Query('branch') branchCode: string,
    @Query('cursor') cursor: string | undefined,
    @Headers('cookie') cookieHeader?: string,
  ) {
    return this.customerRecovery.getCustomerRecoveryOrders(
      cookieHeader,
      tenantCode,
      branchCode,
      cursor,
    );
  }

  // =======================================================
  // TRACKING PÚBLICO DEL PEDIDO
  // =======================================================

  @Get('track/:trackingToken')
  getOrderTracking(
    @Param('trackingToken', new ParseUUIDPipe())
    trackingToken: string,
  ) {
    return this.orderTracking.getOrderTracking(trackingToken);
  }
  // =======================================================
  // POD PUBLICO DE DELIVERY
  // =======================================================

  // =======================================================
  // UBICACION PUBLICA DE DELIVERY
  //
  // orders.tracking_token actua como capability publica.
  // No se exponen driver_id, credenciales ni el
  // deliveries.tracking_token.
  // =======================================================

  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Get('track/:trackingToken/delivery-location')
  getDeliveryLocation(
    @Param('trackingToken', new ParseUUIDPipe())
    trackingToken: string,
  ) {
    return this.orderTracking.getDeliveryLocation(trackingToken);
  }
  @Get('track/:trackingToken/delivery-pod')
  getDeliveryPod(
    @Param('trackingToken', new ParseUUIDPipe())
    trackingToken: string,
  ) {
    return this.orderTracking.getDeliveryPod(trackingToken);
  }
}
