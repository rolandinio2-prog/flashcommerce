import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
} from '@nestjs/common';

import { DeliveryService } from './delivery.service';
import type { DeliveryQuoteInput } from './delivery.types';

@Controller('delivery')
export class DeliveryController {
  constructor(
    private readonly deliveryService: DeliveryService,
  ) {}

  @Post('quote')
  @HttpCode(HttpStatus.OK)
  quoteDelivery(
    @Body() body: DeliveryQuoteInput,
  ) {
    return this.deliveryService.quoteDelivery(body);
  }
}