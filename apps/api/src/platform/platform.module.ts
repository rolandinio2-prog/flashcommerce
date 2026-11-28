import { Module } from '@nestjs/common';

import { StaffModule } from '../core/staff/staff.module';
import { PlatformAuthService } from './platform-auth.service';
import { PlatformBillingController } from './platform-billing.controller';
import { PlatformBillingService } from './platform-billing.service';
import { PlatformController } from './platform.controller';
import { PlatformSessionGuard } from './platform-session.guard';
import { PlatformTenantsService } from './platform-tenants.service';

/** FlashCommerce Cloud platform console: onboarding and products (R4a), subscriptions (R4b). */
@Module({
  imports: [StaffModule],
  controllers: [PlatformController, PlatformBillingController],
  providers: [
    PlatformAuthService,
    PlatformTenantsService,
    PlatformBillingService,
    PlatformSessionGuard,
  ],
})
export class PlatformModule {}
