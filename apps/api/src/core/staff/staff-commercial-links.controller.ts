import { Controller, Get, Header, Req, UseGuards } from '@nestjs/common';
import { StaffRoles } from './staff-roles.decorator';
import { StaffRoleGuard } from './staff-role.guard';
import { StaffSessionGuard } from './staff-session.guard';
import type { StaffAuthenticatedRequest } from './staff.types';
import { StaffCommercialLinksService } from './staff-commercial-links.service';

@Controller('staff/commercial-links')
@UseGuards(StaffSessionGuard, StaffRoleGuard)
@StaffRoles('ADMIN', 'MANAGER')
export class StaffCommercialLinksController {
  constructor(private readonly links: StaffCommercialLinksService) {}
  @Get()
  @Header('Cache-Control', 'no-store')
  getLinks(@Req() request: StaffAuthenticatedRequest) {
    return this.links.getLinks(request.staff);
  }
}
