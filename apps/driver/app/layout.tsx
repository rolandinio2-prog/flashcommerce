import type { Metadata } from "next";

import "./globals.css";

export const metadata: Metadata = {
  title: "FlashDelivery Driver",
  description: "Aplicacion operativa para repartidores FlashDelivery",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="es">
      <body>{children}</body>
    </html>
  );
}