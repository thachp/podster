import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";
import { remoteAgents } from "./test/remote";

export default defineConfig({
  plugins: [cloudflareTest({ wrangler: { configPath: "./wrangler.jsonc" }, miniflare: { outboundService: remoteAgents as never } })],
  test: { testTimeout: 30000 },
});
