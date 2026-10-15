import type { NextConfig } from "next";

const config: NextConfig = {
  // Receipt uploads go through a server action; allow phone-photo sizes (the API enforces its own limit).
  experimental: { serverActions: { bodySizeLimit: "6mb" } },
  poweredByHeader: false,
};

export default config;
