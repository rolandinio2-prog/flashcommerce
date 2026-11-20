import type { Metadata } from "next";

import "./globals.css";
import DriverPageZoomGuard from "./components/driver-page-zoom-guard";

export const metadata: Metadata = {
  title: "FastPay | Repartidor",
  description: "Gestión de recogidas y entregas",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="es" data-driver-page-zoom="fixed">
      <body><DriverPageZoomGuard />{children}</body>
    </html>
  );
}