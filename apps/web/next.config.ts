import type { NextConfig } from "next";
import { SECURITY_HEADERS } from "./lib/security-headers";

const nextConfig: NextConfig = {
  async headers() {
    return [
      {
        // Not `/api/`: vinext lets these replace a route handler's own headers, which would undo a download's. Those routes add
        // the same headers themselves, where the gateway sent none. Nor the public room page, its stylesheet or robots.txt,
        // which send their own: the page's CSP allows no script at all (ADR 0008).
        // Exactly those three: anything else under `/p/` or `/p-assets/`, such as `/p/x/y`, is the dashboard's and gets its headers.
        source: "/((?!api/|p/[^/]+$|p-assets/style$|robots\\.txt$).*)",
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
