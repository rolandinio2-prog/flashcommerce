import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { STAFF_ROLES_KEY } from './staff-roles.decorator';
import { StaffAuthenticatedRequest, StaffRole } from './staff.types';

@Injectable()
export class StaffRoleGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const allowedRoles = this.reflector.getAllAndOverride<StaffRole[]>(
      STAFF_ROLES_KEY,
      [context.getHandler(), context.getClass()],
    );

    const request = context
      .switchToHttp()
      .getRequest<StaffAuthenticatedRequest>();

    if (request.staff?.passwordChangeRequired) {
      throw new ForbiddenException(
        'A personal password must be created before using protected staff functions',
      );
    }

    if (!allowedRoles || allowedRoles.length === 0) {
      return true;
    }

    if (!request.staff || !allowedRoles.includes(request.staff.role)) {
      throw new ForbiddenException(
        'The authenticated operator is not allowed to perform this action',
      );
    }

    return true;
  }
}
