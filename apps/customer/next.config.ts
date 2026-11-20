import type { NextConfig } from "next";

const configuredInternalApiBase =
  process.env.FLASH_API_INTERNAL_URL?.trim();

const internalApiBase = (
  configuredInternalApiBase ||
  process.env.FLASH_API_URL?.trim() ||
  "http://127.0.0.1:3001"
).replace(/\/+$/, "");

const nextConfig: NextConfig = {
  output: "standalone",
  allowedDevOrigins: ["192.168.0.17", "127.0.0.1", "localhost"],

  async redirects() {
    return [
      {
        source: "/",
        has: [
          {
            type: "host",
            value: "ops.fastpay.com.bo",
          },
        ],
        destination: "/ops",
        permanent: false,
      },
      {
        source: "/",
        has: [
          {
            type: "host",
            value: "admin.fastpay.com.bo",
          },
        ],
        destination: "/admin",
        permanent: false,
      },
    ];
  },

  async rewrites() {
    return [
      {
        source: "/t/:token",
        has: [
          {
            type: "host",
            value: "q.fastpay.com.bo",
          },
        ],
        destination: `${internalApiBase}/api/v1/tables/public-qr/:token`,
      },
      {
        source: "/api/v1/:path*",
        destination: `${internalApiBase}/api/v1/:path*`,
      },
    ];
  },
};

export default nextConfig;