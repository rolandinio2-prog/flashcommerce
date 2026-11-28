import { apiRequest } from "../../../lib/flash-api";

export type PlatformProduct = "COMMERCE" | "DELIVERY";
export type TenantStatus = "ACTIVE" | "SUSPENDED" | "INACTIVE";

export interface PlatformOperator {
  userId: string;
  email: string;
  displayName: string;
  passwordChangeRequired: boolean;
}
export interface TenantSummary {
  id: string;
  code: string;
  name: string;
  status: TenantStatus;
  createdAt: string;
  branchCount: number;
  products: PlatformProduct[];
  staffCount: number;
}
export interface TenantDetail {
  id: string;
  code: string;
  name: string;
  status: TenantStatus;
  createdAt: string;
  products: Record<PlatformProduct, boolean>;
  branches: { id: string; code: string; name: string; status: string; timezone: string; staffCount: number }[];
  audit: { action: string; details: Record<string, unknown>; at: string; actor: string | null }[];
}
export interface InitialAdmin {
  tenantCode: string;
  branchCode: string;
  userCode: string;
  temporaryPassword: string;
  displayName: string;
}
export interface AdminPerson {
  firstName: string;
  lastName: string;
  identityDocument?: string;
  phone?: string;
  email?: string;
}

const BASE = "/api/v1/platform";
const json = (method: string, body?: unknown, headers?: Record<string, string>): RequestInit => ({
  method,
  body: body === undefined ? undefined : JSON.stringify(body),
  headers,
});

export const platformApi = {
  me: () => apiRequest<{ operator: PlatformOperator }>(`${BASE}/auth/me`),
  login: (email: string, password: string) =>
    apiRequest<{ operator: PlatformOperator }>(`${BASE}/auth/login`, json("POST", { email, password })),
  logout: () => apiRequest<{ ok: true }>(`${BASE}/auth/logout`, json("POST", {})),
  bootstrap: (opsKey: string, email: string, displayName: string) =>
    apiRequest<{ email: string; temporaryPassword: string }>(
      `${BASE}/auth/bootstrap`,
      json("POST", { email, displayName }, { "x-ops-key": opsKey }),
    ),
  changePassword: (currentPassword: string, newPassword: string) =>
    apiRequest<{ ok: true }>(`${BASE}/auth/change-password`, json("POST", { currentPassword, newPassword })),
  listTenants: () => apiRequest<{ tenants: TenantSummary[] }>(`${BASE}/tenants`),
  getTenant: (id: string) => apiRequest<TenantDetail>(`${BASE}/tenants/${id}`),
  createTenant: (body: {
    code: string;
    name: string;
    branchCode: string;
    branchName: string;
    timezone: string;
    products: PlatformProduct[];
    admin: AdminPerson;
  }) => apiRequest<TenantDetail & { initialAdmin: InitialAdmin }>(`${BASE}/tenants`, json("POST", body)),
  createInitialAdmin: (id: string, admin: AdminPerson) =>
    apiRequest<InitialAdmin>(`${BASE}/tenants/${id}/initial-admin`, json("POST", admin)),
  setStatus: (id: string, status: TenantStatus, reason: string) =>
    apiRequest<TenantDetail>(`${BASE}/tenants/${id}/status`, json("PATCH", { status, reason })),
  setProducts: (id: string, products: PlatformProduct[]) =>
    apiRequest<TenantDetail>(`${BASE}/tenants/${id}/products`, json("PUT", { products })),
};
