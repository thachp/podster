import type { NextConfig } from "next";
import { SECURITY_HEADERS } from "./lib/security-headers";

const nextConfig: NextConfig = {
  async headers() {
    return [
      {
        // Not `/api/`: vinext lets these replace a route handler's own headers, which would undo a download's. Those routes add
        // the same headers themselves, where the gateway sent none.
        source: "/((?!api/).*)",
        headers: SECURITY_HEADERS.map(([key, value]) => ({ key, value })),
      },
      {
        // Says how long one person should wait, and where they were, so nothing should keep it.
        source: "/too-many-requests",
        headers: [{ key: "Cache-Control", value: "no-store" }],
      },
    ];
  },
};

export default nextConfig;
