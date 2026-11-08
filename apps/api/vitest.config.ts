import { generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// A throwaway key per run. Tests sign as the gateway, and the Worker verifies with the public half.
const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const pub = publicKey.export({ format: "jwk" });

// Wake's outbound requests land here, so tests can see them and choose how the far end answers.
const hookRequests: { path: string; signature: string | null; agent: string | null; body: string }[] = [];
async function fakeHook(request: Request) {
  const url = new URL(request.url);
  if (url.hostname === "hook-log.example.com") return new Response(JSON.stringify(hookRequests));
  hookRequests.push({ path: url.pathname, signature: request.headers.get("x-podster-signature"), agent: request.headers.get("user-agent"), body: await request.text() });
  if (url.pathname.startsWith("/hang")) await new Promise((resolve) => setTimeout(resolve, 5000));
  if (url.pathname.startsWith("/fail")) return new Response("no", { status: 500 });
  if (url.pathname.startsWith("/redirect")) return new Response(null, { status: 302, headers: { location: "https://elsewhere.example.com/" } });
  return new Response("ok");
}

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        outboundService: fakeHook,
        queueProducers: { WAKE: { queueName: "podster-wake-test" }, SCAN: { queueName: "podster-scan-test" } },
        // The test pool can't run the real consumer. This one records what actually crosses the queue.
        workers: [
          {
            name: "wake-queue-recorder",
            modules: true,
            script: `export default { async queue(batch) { for (const message of batch.messages) { await fetch("https://hook-record.example.com/__queue", { method: "POST", body: JSON.stringify(message.body) }); message.ack(); } } };`,
            compatibilityDate: "2026-08-01",
            outboundService: fakeHook,
            queueConsumers: { "podster-wake-test": { maxBatchTimeout: 0.05 }, "podster-scan-test": { maxBatchTimeout: 0.05 } },
          },
        ],
        bindings: {
          ASSERTION_KEYS: JSON.stringify({ test: pub.x }),
          SCANNER_SECRET: "test-scanner-secret",
          // A test value only. The real key is the owner's to set (decision 122).
          A2A_TOKEN_KEY: "0f".repeat(32),
          TEST_WRANGLER: readFileSync(new URL("./wrangler.jsonc", import.meta.url), "utf8"),
          TEST_D1_SCHEMA: ["0001_membership_index.sql", "0002_room_status.sql", "0003_membership_by_org.sql", "0004_ownerless_rooms.sql"].map((name) => readFileSync(new URL(`./migrations/${name}`, import.meta.url), "utf8")).join("\n").replace(/--.*$/gm, ""),
          TEST_SIGNING_JWK: JSON.stringify(privateKey.export({ format: "jwk" })),
        },
      },
    }),
  ],
  test: { testTimeout: 30000 },
});
