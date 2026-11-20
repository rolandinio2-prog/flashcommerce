import OpsSessionClient from './components/ops-session-client';

export default function OpsPage() {
  return (
    <OpsSessionClient
      tenantCode="POLLO001"
      branchCode="SUC001"
    />
  );
}
