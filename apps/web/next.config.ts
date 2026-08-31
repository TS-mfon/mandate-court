import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  poweredByHeader: false,
  typedRoutes: true,
  experimental: { useTypeScriptCli: false },
};

export default nextConfig;
