import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

const at = (path: string) => fileURLToPath(new URL(path, import.meta.url));

// Component tests in jsdom. They stand in for the router, so they don't prove vinext's: the local run in README does that.
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": at("./"),
      "next/navigation": at("./test/next-navigation.ts"),
      "next/link": at("./test/next-link.tsx"),
      "next/headers": at("./test/next-headers.ts"),
      // vinext's own, so middleware's tests run what the Worker runs.
      "next/server": at("./node_modules/vinext/dist/shims/server.js"),
    },
  },
  test: { environment: "jsdom", setupFiles: ["./test/setup.ts"], include: ["**/*.test.{ts,tsx}"], exclude: ["node_modules", "dist"] },
});
