export type OpsEntryParams = Record<string, string | string[] | undefined>;

export type OpsEntryContext =
  | { valid: true; tenantCode: string; branchCode: string }
  | { valid: false; message: string };

// URL context chooses the login destination; the authenticated API remains authoritative.
export function resolveOpsEntryContext(params: OpsEntryParams): OpsEntryContext {
  const tenant = params.tenantCode;
  const branch = params.branchCode;
  if (tenant === undefined && branch === undefined) {
    return { valid: true, tenantCode: 'POLLO001', branchCode: 'SUC001' };
  }
  if (typeof tenant !== 'string' || typeof branch !== 'string') {
    return { valid: false, message: 'Indica un negocio y una sucursal para ingresar.' };
  }
  const tenantCode = tenant.trim().toUpperCase();
  const branchCode = branch.trim().toUpperCase();
  const codePattern = /^[A-Z0-9_-]{2,50}$/;
  if (!codePattern.test(tenantCode) || !codePattern.test(branchCode)) {
    return { valid: false, message: 'Revisa los códigos del negocio y la sucursal.' };
  }
  return { valid: true, tenantCode, branchCode };
}
