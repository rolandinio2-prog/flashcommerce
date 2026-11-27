import AdminHomeClient from "./components/admin-home-client";

export default function AdminPage() {
  return (
    <>
      <AdminHomeClient
        tenantCode="POLLO001"
        branchCode="SUC001"
      />
    </>
  );
}