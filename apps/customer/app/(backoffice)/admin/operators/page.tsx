import OpsUsersClient from "../../ops/components/ops-users-client";

export default function AdminOperatorsPage() {
  return (
    <OpsUsersClient
      tenantCode="POLLO001"
      branchCode="SUC001"
      returnHref="/admin"
      returnLabel="Volver a administración"
    />
  );
}
