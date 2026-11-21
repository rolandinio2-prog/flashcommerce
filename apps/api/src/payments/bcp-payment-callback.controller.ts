import {
  Body,
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Post,
} from '@nestjs/common';

import { PaymentsService, type BcpQrCallbackInput } from './payments.service';

@Controller('payments/bcp')
export class BcpPaymentCallbackController {
  constructor(private readonly paymentsService: PaymentsService) {}

  @Post('callback')
  @HttpCode(HttpStatus.OK)
  handleCallback(
    @Headers('authorization')
    authorization: string | undefined,

    @Body()
    body: BcpQrCallbackInput,
  ) {
    return this.paymentsService.handleBcpQrCallback(authorization, body);
  }
}
