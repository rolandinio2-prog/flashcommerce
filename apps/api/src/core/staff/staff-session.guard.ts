import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';

import { StaffService } from './staff.service';
import { StaffAuthenticatedRequest } from './staff.types';

@Injectable()
export class StaffSessionGuard implements CanActivate {
  constructor(private readonly staffService: StaffService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context
      .switchToHttp()
      .getRequest<StaffAuthenticatedRequest>();

    const token = this.staffService.readSessionToken(request.headers);

    if (!token) {
      throw new UnauthorizedException('Staff authentication required');
    }

    const principal = await this.staffService.resolveSession(token);

    if (!principal) {
      throw new UnauthorizedException('Staff session is invalid or expired');
    }

    request.staff = principal;

    return true;
  }
}
