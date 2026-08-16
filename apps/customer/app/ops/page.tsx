import OpsOrdersClient from './components/ops-orders-client';

export default function OpsPage() {
  return (
    <OpsOrdersClient
      tenantCode="POLLO001"
      branchCode="SUC001"
    />
  );
}