import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';

import { DeliveryAddressService } from './delivery-address.service';
import type {
  DeliveryAddressAutocompleteInput,
  DeliveryAddressGeocodeInput,
  DeliveryAddressResolveInput,
} from './delivery-address.types';
import { DeliveryService } from './delivery.service';
import type { DeliveryQuoteInput } from './delivery.types';

@Controller('delivery')
export class DeliveryController {
  constructor(
    private readonly deliveryService: DeliveryService,
    private readonly deliveryAddressService: DeliveryAddressService,
  ) {}

  @Post('quote')
  @HttpCode(HttpStatus.OK)
  quoteDelivery(
    @Body() body: DeliveryQuoteInput,
  ) {
    return this.deliveryService.quoteDelivery(body);
  }

  @Post('address/autocomplete')
  @Throttle({
    default: {
      limit: 30,
      ttl: 60_000,
      blockDuration: 60_000,
    },
  })
  @HttpCode(HttpStatus.OK)
  autocompleteAddress(
    @Body() body: DeliveryAddressAutocompleteInput,
  ) {
    return this.deliveryAddressService.autocomplete(body);
  }

  @Post('address/resolve')
  @Throttle({
    default: {
      limit: 20,
      ttl: 60_000,
      blockDuration: 60_000,
    },
  })
  @HttpCode(HttpStatus.OK)
  resolveAddress(
    @Body() body: DeliveryAddressResolveInput,
  ) {
    return this.deliveryAddressService.resolve(body);
  }

  @Post('address/geocode')
  @Throttle({
    default: {
      limit: 10,
      ttl: 60_000,
      blockDuration: 60_000,
    },
  })
  @HttpCode(HttpStatus.OK)
  geocodeAddress(
    @Body() body: DeliveryAddressGeocodeInput,
  ) {
    return this.deliveryAddressService.geocode(body);
  }
}