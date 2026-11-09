import { generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// A throwaway key per run: the gateway signs with it, and the real API verifies with the public half.
const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const pub = publicKey.export({ format: "jwk" });
const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8").replace(/--.*$/gm, "");

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          BASE_URL: "https://gateway.test",
          AUTH_SECRET: "local-test-only-not-a-real-secret-0123456789",
          ASSERTION_SIGNING_JWK: JSON.stringify({ ...privateKey.export({ format: "jwk" }), kid: "test" }),
          ENABLE_PASSWORD_SIGNIN: "true",
          // Suites make many requests from one address. Limit tests set their own.
          STRICT_PER_MINUTE: "1000000",
          STRICT_PER_DAY: "1000000",
          GITHUB_CLIENT_ID: "test-client-id",
          GITHUB_CLIENT_SECRET: "test-client-secret",
          TEST_DIRECTORY_SCHEMA: read("./migrations/0001_directory.sql") + read("./migrations/0003_one_personal_org.sql") + read("./migrations/0004_org_invitations.sql") + read("./migrations/0005_org_departure.sql"),
          TEST_AUTH_SCHEMA: read("./migrations/0002_auth.sql"),
          TEST_API_SCHEMA: read("../api/migrations/0001_membership_index.sql") + read("../api/migrations/0002_room_status.sql") + read("../api/migrations/0003_membership_by_org.sql") + read("../api/migrations/0004_ownerless_rooms.sql") + read("../api/migrations/0005_public_workroom_index.sql"),
          TEST_WRANGLER: readFileSync(new URL("./wrangler.jsonc", import.meta.url), "utf8"),
          TEST_CAPABILITIES: readFileSync(new URL("../../packages/contracts/capabilities.yaml", import.meta.url), "utf8"),
          TEST_A2A_PROFILE: readFileSync(new URL("../../docs/spec/A2A-PROFILE.md", import.meta.url), "utf8"),
        },
        d1Databases: { DB: "gateway-db", API_DB: "api-db" },
        // Suites make many requests from one address, so limit tests pass their own limiters.
        ratelimits: { RL_GENERAL: { namespace_id: "9001", simple: { limit: 1_000_000, period: 60 } }, RL_ACCOUNT: { namespace_id: "9002", simple: { limit: 1_000_000, period: 60 } }, RL_SENSITIVE: { namespace_id: "9003", simple: { limit: 1_000_000, period: 60 } } },
        serviceBindings: { API: "podster-api" },
        workers: [
          {
            // The real Rust API, as the production build.
            name: "podster-api",
            modules: [
              { type: "ESModule", path: "index.js", contents: readFileSync(new URL("../api/build/index.js", import.meta.url)) },
              { type: "CompiledWasm", path: "index_bg.wasm", contents: readFileSync(new URL("../api/build/index_bg.wasm", import.meta.url)) },
            ],
            compatibilityDate: "2026-08-01",
            bindings: { ASSERTION_KEYS: JSON.stringify({ test: pub.x }) },
            durableObjects: {
              WORKSPACE: { className: "Workspace", useSQLite: true },
              PRINCIPAL: { className: "Principal", useSQLite: true },
            },
            d1Databases: { DB: "api-db" },
            queueProducers: { WAKE: { queueName: "podster-wake" } },
          },
        ],
      },
    }),
  ],
  test: { testTimeout: 30000 },
});
