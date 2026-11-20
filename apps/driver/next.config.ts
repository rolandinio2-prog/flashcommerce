import type { NextConfig } from "next";

const configuredInternalApiBase =
  process.env.FLASH_API_INTERNAL_URL?.trim();

const internalApiBase = (
  configuredInternalApiBase || "http://127.0.0.1:3001"
).replace(/\/+$/, "");

const nextConfig: NextConfig = {
  output: "standalone",
  async rewrites() {
    return [
      {
        source: "/api/v1/:path*",
        destination: `${internalApiBase}/api/v1/:path*`,
      },
    ];
  },
};

export default nextConfig;