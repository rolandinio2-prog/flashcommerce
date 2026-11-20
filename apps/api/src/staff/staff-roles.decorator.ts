import { SetMetadata } from '@nestjs/common';

import { StaffRole } from './staff.types';

export const STAFF_ROLES_KEY = 'staff_roles';

export const StaffRoles = (...roles: StaffRole[]) =>
  SetMetadata(STAFF_ROLES_KEY, roles);
