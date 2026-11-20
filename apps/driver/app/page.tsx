import { DriverSessionClient } from "./components/driver-session-client";

const driverTenantCode =
  process.env.NEXT_PUBLIC_FLASH_TENANT_CODE?.trim().toUpperCase() || "POLLO001";

export default function DriverPage() {
  return <DriverSessionClient tenantCode={driverTenantCode} />;
}