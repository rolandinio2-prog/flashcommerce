import type { Metadata } from "next";

import TrackingPageClient from "./tracking-page-client";

export const metadata: Metadata = {
  title: "Seguimiento del pedido | FlashCommerce",
  description:
    "Consulta el estado de tu pedido y sigue su avance hasta completarse.",
};

export default async function OrderTrackingPage({
  params,
}: {
  params: Promise<{ trackingToken: string }>;
}) {
  const { trackingToken } = await params;

  return <TrackingPageClient trackingToken={trackingToken} />;
}
