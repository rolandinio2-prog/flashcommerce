import type { StaffRole } from '../staff/staff.types';

// Shared by HTTP authorization and the capabilities returned to UI.
// Service availability is separate from permission; disabling a service must
// never prevent completion of existing business (see the modular contract).
const ALL: readonly StaffRole[] = [
  'ADMIN',
  'MANAGER',
  'CASHIER',
  'KITCHEN',
  'WAITER',
];
const FRONT: readonly StaffRole[] = ['ADMIN', 'MANAGER', 'CASHIER', 'WAITER'];
const CASH: readonly StaffRole[] = ['ADMIN', 'MANAGER', 'CASHIER'];
export const OPERATIONS_POLICY = {
  'configuration.read': {
    module: 'configuration',
    roles: ['ADMIN'] as readonly StaffRole[],
  },
  'configuration.write': {
    module: 'configuration',
    roles: ['ADMIN'] as readonly StaffRole[],
  },
  'access.read': { module: 'core', roles: ALL },
  'orders.create': { module: 'orders', roles: CASH },
  'orders.read': { module: 'orders', roles: ALL },
  'orders.status': { module: 'orders', roles: ALL },
  'tables.read': { module: 'tables', roles: FRONT },
  'tables.manage': { module: 'tables', roles: FRONT },
  'reservations.read': { module: 'reservations', roles: FRONT },
  'reservations.manage': { module: 'reservations', roles: FRONT },
  'delivery.read': { module: 'delivery', roles: CASH },
  'delivery.assign': { module: 'delivery', roles: CASH },
  'delivery.monitor': { module: 'delivery', roles: CASH },
  'payments.close': { module: 'payments', roles: CASH },
  'payments.read': { module: 'payments', roles: CASH },
  'payments.cash': { module: 'payments', roles: CASH },
  'payments.settle': { module: 'payments', roles: CASH },
  'payments.reconcile': { module: 'payments', roles: CASH },
  'payments.mock': {
    module: 'payments',
    roles: ['ADMIN'] as readonly StaffRole[],
  },
} as const;
export type Operation = keyof typeof OPERATIONS_POLICY;
export type OperationalModule = (typeof OPERATIONS_POLICY)[Operation]['module'];
export const OPERATION_KEY = 'flashcommerce.operation.v1';
export const ORDER_STATUSES_BY_ROLE: Record<StaffRole, readonly string[]> = {
  ADMIN: ['CONFIRMED', 'PREPARING', 'READY', 'COMPLETED', 'CANCELLED'],
  MANAGER: ['CONFIRMED', 'PREPARING', 'READY', 'COMPLETED', 'CANCELLED'],
  CASHIER: ['CONFIRMED', 'PREPARING', 'READY', 'COMPLETED', 'CANCELLED'],
  KITCHEN: ['PREPARING', 'READY'],
  WAITER: ['COMPLETED'],
};
export function getOperationsCapabilities(role: StaffRole) {
  return {
    permissions: (Object.keys(OPERATIONS_POLICY) as Operation[]).filter(
      (action) => OPERATIONS_POLICY[action].roles.includes(role),
    ),
    orderStatuses: ORDER_STATUSES_BY_ROLE[role] ?? [],
  };
}
