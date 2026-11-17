// Spike A, part 2: the pairing probe, in the Workers runtime against the real gateway source and the release build of the
// API, the same way apps/gateway's own suite runs. It reads the gateway's files and changes none of them. Run
// `npm test` in apps/gateway once first (or `worker-build --release` in apps/api), so ../../apps/api/build exists.
import { generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const pub = publicKey.export({ format: "jwk" });
const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8").replace(/--.*$/gm, "");
const gateway = "../../apps/gateway/";
const api = "../../apps/api/";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: `${gateway}wrangler.jsonc` },
      miniflare: {
        bindings: {
          BASE_URL: "https://gateway.test",
          AUTH_SECRET: "local-test-only-not-a-real-secret-0123456789",
          ASSERTION_SIGNING_JWK: JSON.stringify({ ...privateKey.export({ format: "jwk" }), kid: "test" }),
          ENABLE_PASSWORD_SIGNIN: "true",
          STRICT_PER_MINUTE: "1000000",
          STRICT_PER_DAY: "1000000",
          TEST_DIRECTORY_SCHEMA: ["0001_directory", "0003_one_personal_org", "0004_org_invitations", "0005_org_departure"].map((m) => read(`${gateway}migrations/${m}.sql`)).join(""),
          TEST_AUTH_SCHEMA: read(`${gateway}migrations/0002_auth.sql`),
          TEST_API_SCHEMA: ["0001_membership_index", "0002_room_status", "0003_membership_by_org", "0004_ownerless_rooms", "0005_public_workroom_index", "0006_public_explore_order", "0007_repo_room_index", "0008_app_label_index", "0009_app_label_approved"].map((m) => read(`${api}migrations/${m}.sql`)).join(""),
        },
        d1Databases: { DB: "gateway-db", API_DB: "api-db" },
        ratelimits: { RL_GENERAL: { namespace_id: "9001", simple: { limit: 1_000_000, period: 60 } }, RL_ACCOUNT: { namespace_id: "9002", simple: { limit: 1_000_000, period: 60 } }, RL_SENSITIVE: { namespace_id: "9003", simple: { limit: 1_000_000, period: 60 } } },
        serviceBindings: { API: "podster-api" },
        workers: [
          {
            name: "podster-api",
            modules: [
              { type: "ESModule", path: "index.js", contents: readFileSync(new URL(`${api}build/index.js`, import.meta.url)) },
              { type: "CompiledWasm", path: "index_bg.wasm", contents: readFileSync(new URL(`${api}build/index_bg.wasm`, import.meta.url)) },
            ],
            compatibilityDate: "2026-08-01",
            bindings: { ASSERTION_KEYS: JSON.stringify({ test: pub.x }) },
            durableObjects: { WORKSPACE: { className: "Workspace", useSQLite: true }, PRINCIPAL: { className: "Principal", useSQLite: true } },
            d1Databases: { DB: "api-db" },
            queueProducers: { WAKE: { queueName: "podster-wake" } },
          },
        ],
      },
    }),
  ],
  test: { testTimeout: 30000, include: ["pairing.spec.ts"] },
});
