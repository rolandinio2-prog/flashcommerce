import { Module } from '@nestjs/common';

import { StaffModule } from '../core/staff/staff.module';
import { PlatformAuthService } from './platform-auth.service';
import { PlatformController } from './platform.controller';
import { PlatformSessionGuard } from './platform-session.guard';
import { PlatformTenantsService } from './platform-tenants.service';

/** R4a: FlashCommerce Cloud platform console (business onboarding and products). */
@Module({
  imports: [StaffModule],
  controllers: [PlatformController],
  providers: [
    PlatformAuthService,
    PlatformTenantsService,
    PlatformSessionGuard,
  ],
})
export class PlatformModule {}
