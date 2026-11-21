import { NotFoundException } from '@nestjs/common';
import type { DatabaseService } from '../database/database.service';
import type { StaffSessionPrincipal } from '../staff/staff.types';

export async function assertPosCartAccess(
  db: Pick<DatabaseService, 'query'>,
  cartId: string,
  staff?: StaffSessionPrincipal,
) {
  const found = await db.query<{
    tenant_id: string;
    branch_id: string;
    staff_user_id: string;
  }>(
    'select tenant_id::text,branch_id::text,staff_user_id::text from public.pos_drafts where cart_id=$1::uuid',
    [cartId],
  );
  const row = found.rows[0];
  if (!row && !staff) return; // Customer carts retain their existing capability contract.
  if (
    !row ||
    !staff ||
    row.tenant_id !== staff.tenantId ||
    row.branch_id !== staff.branchId ||
    row.staff_user_id !== staff.userId
  ) {
    throw new NotFoundException('Cart not found');
  }
}
