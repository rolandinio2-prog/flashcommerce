import OpsDriversClient from "../../ops/components/ops-drivers-client";

export default function AdminDriversPage() {
  return (
    <OpsDriversClient
      tenantCode="POLLO001"
      branchCode="SUC001"
      returnHref="/admin"
      returnLabel="Volver a administración"
    />
  );
}
