export type StaffRole =
  | 'ADMIN'
  | 'MANAGER'
  | 'CASHIER'
  | 'KITCHEN'
  | 'WAITER';

export interface StaffSessionPrincipal {
  sessionId: string;
  userId: string;
  tenantId: string;
  tenantCode: string;
  branchId: string;
  branchCode: string;
  userCode: string;
  firstName: string;
  lastName: string;
  displayName: string;
  role: StaffRole;
  passwordChangeRequired: boolean;
  expiresAt: string;
}

export interface StaffAuthenticatedRequest {
  headers: Record<string, string | string[] | undefined>;
  staff: StaffSessionPrincipal;
}
