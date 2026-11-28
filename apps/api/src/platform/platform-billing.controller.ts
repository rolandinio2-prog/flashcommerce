import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Put,
  Req,
  UseGuards,
} from '@nestjs/common';

import { PlatformBillingService } from './platform-billing.service';
import {
  PlatformSessionGuard,
  type PlatformRequest,
} from './platform-session.guard';

/** R4b: product prices and each business's manual subscription (platform console). */
@Controller('platform')
@UseGuards(PlatformSessionGuard)
export class PlatformBillingController {
  constructor(private readonly billing: PlatformBillingService) {}

  @Get('billing/prices')
  prices() {
    return this.billing.getPrices();
  }

  @Put('billing/prices')
  setPrices(
    @Req() req: PlatformRequest,
    @Body() body: { prices?: Record<string, unknown> },
  ) {
    return this.billing.setPrices(req.platform!, body);
  }

  /** Runs the overdue check now (it also runs hourly). Returns how many businesses were suspended. */
  @Post('billing/run-suspensions')
  @HttpCode(200)
  async run() {
    return { suspended: await this.billing.suspendOverdue() };
  }

  @Get('tenants/:id/subscription')
  subscription(@Param('id') id: string) {
    return this.billing.subscription(id);
  }

  @Put('tenants/:id/subscription')
  assign(
    @Req() req: PlatformRequest,
    @Param('id') id: string,
    @Body()
    body: {
      paidUntil?: unknown;
      monthlyPriceOverride?: unknown;
      notes?: unknown;
    },
  ) {
    return this.billing.assign(req.platform!, id, body);
  }

  @Delete('tenants/:id/subscription')
  exempt(@Req() req: PlatformRequest, @Param('id') id: string) {
    return this.billing.exempt(req.platform!, id);
  }

  @Post('tenants/:id/subscription/payments')
  pay(
    @Req() req: PlatformRequest,
    @Param('id') id: string,
    @Body()
    body: {
      months?: unknown;
      amount?: unknown;
      method?: unknown;
      reference?: unknown;
    },
  ) {
    return this.billing.recordPayment(req.platform!, id, body);
  }

  @Post('tenants/:id/subscription/payments/:paymentId/void')
  @HttpCode(200)
  voidPayment(
    @Req() req: PlatformRequest,
    @Param('id') id: string,
    @Param('paymentId') paymentId: string,
    @Body() body: { reason?: unknown },
  ) {
    return this.billing.voidPayment(req.platform!, id, paymentId, body);
  }
}
