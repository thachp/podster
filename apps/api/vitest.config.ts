import { coreSets } from "../../packages/contracts/core-sets.mjs";
import { createHmac, generateKeyPairSync } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";
import { CONTENT_PARTITIONS, type ContentPartition, FAKE_CONTENT, fakeContent, GATE_LIMIT_MS } from "./test/fake-content.ts";
import { FAKE_AGENT_KEY_PEM, FAKE_APP_KEY_PEM, FAKE_GITHUB, FAKE_MERGE_KEY_PEM, fakeGithub } from "./test/fake-github.ts";
import { FAKE_RELEASE, FAKE_RELEASE_KEY_PEM, fakeGithubRelease } from "./test/fake-github-release.ts";
import { FAKE_RESOLVER, fakeResolver } from "./test/fake-resolver.ts";
import { FAKE_HOSTNAMES, fakeHostnames } from "./test/fake-hostnames.ts";
import { FAKE_STORES, fakeStores } from "./test/fake-stores.ts";
import { A2A_SDK_CONTROL_HOST, A2A_SDK_HOST, a2aSdkBase, a2aSdkControl } from "./test/a2a-sdk-endpoint.ts";
import { stagingRequestersProblem, validRequesters } from "../../scripts/requesters-rule.mjs";
import { assertApiBuild } from "../../scripts/build-api-worker.mjs";

// wrangler.jsonc's `main` is build/index.js, which npm's pretest builds with failpoints. Anything else that writes there
// (wrangler deploy, e2e/run-local.mjs, a plain worker-build) leaves a build the failpoint tests fail on confusingly, so
// a build with other features, or changed since it was made, stops the run here instead.
assertApiBuild(new URL("./build/", import.meta.url), ["failpoints"], "npm run pretest (in apps/api)");

// A throwaway key per run. Tests sign as the gateway, and the Worker verifies with the public half.
const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const pub = publicKey.export({ format: "jwk" });

// Wake's outbound requests land here, so tests can see them and choose how the far end answers.
const hookRequests: { host: string; path: string; signature: string | null; agent: string | null; authorization: string | null; a2aVersion: string | null; body: string }[] = [];

// GetTask and CancelTask answers a test scripts for each remote task ID (M3 step 13). Each read takes the next one, and the
// last repeats. An answer is a JSON-RPC `result`, or `{ error }`, or `{ raw }` for a body sent as is, or `{ httpStatus }`.
const scripts = new Map<string, unknown[]>();
function scripted(key: string) {
  const answers = scripts.get(key);
  if (!answers?.length) return undefined;
  return answers.length > 1 ? answers.shift() : answers[0];
}

// An A2A endpoint's answers to SendMessage, chosen by path (M3 step 12).
function a2aAnswer(path: string, body: string) {
  const parsed = (() => { try { return JSON.parse(body); } catch { return {}; } })();
  const id = parsed.id ?? null;
  const rpc = (result: unknown) => new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), { headers: { "content-type": "application/json" } });
  if (parsed.method === "GetTask" || parsed.method === "CancelTask") {
    const answer: any = scripted(parsed.method === "GetTask" ? parsed.params?.id : `${parsed.params?.id}:cancel`);
    if (answer?.raw !== undefined) return new Response(answer.raw, { headers: { "content-type": "application/json" } });
    if (answer?.error) return new Response(JSON.stringify({ jsonrpc: "2.0", id, error: answer.error }));
    if (answer?.httpStatus) return new Response(null, { status: answer.httpStatus });
    return rpc(answer ?? { id: parsed.params?.id, status: { state: parsed.method === "CancelTask" ? "TASK_STATE_CANCELED" : "TASK_STATE_SUBMITTED" } });
  }
  // A server that ignores returnImmediately and answers once its work is done (decision 174), with or without artifacts.
  if (path.startsWith("/a2a/blocking-empty")) return rpc({ task: { id: `remote-${path.split("/").pop()}`, contextId: "c", status: { state: "TASK_STATE_COMPLETED", message: { role: "ROLE_AGENT", parts: [{ text: "Task completed successfully" }] } } } });
  if (path.startsWith("/a2a/blocking")) return rpc({ task: { id: `remote-${path.split("/").pop()}`, contextId: "c", status: { state: "TASK_STATE_COMPLETED" }, artifacts: [{ name: "Reply", parts: [{ text: "Done at once." }, { url: "https://example.com/blocked" }] }] } });
  if (path.startsWith("/a2a/message")) return rpc({ message: { messageId: "m-1", role: "ROLE_AGENT", parts: [{ text: "Noted." }] } });
  if (path.startsWith("/a2a/error")) return new Response(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32001, message: "no" } }));
  if (path.startsWith("/a2a/big")) return rpc({ task: { id: "remote-big", status: { state: "TASK_STATE_SUBMITTED" } }, padding: "x".repeat(70 * 1024) });
  if (path.startsWith("/a2a/bad-id")) return rpc({ task: { id: "has a space", status: { state: "TASK_STATE_SUBMITTED" } } });
  if (path.startsWith("/a2a/nothing")) return rpc({});
  return rpc({ task: { id: `remote-${path.split("/").pop()}`, contextId: "c", status: { state: "TASK_STATE_SUBMITTED" } } });
}

// A nudge endpoint's answers (M7 step 13), chosen by path. A challenge is answered with the proof, an HMAC under the
// signing secret a test scripted for that path as `proof:<path>`, as a Runner holding the secret would. `/nudge/echo`
// answers with the challenge itself and `/nudge/wrong` with a proof under another secret, as a server that doesn't hold
// it would. `/nudge/flaky` proves control and then fails every nudge. Anything else answers a nudge with a message.
function nudgeAnswer(path: string, body: string) {
  const parsed = (() => { try { return JSON.parse(body); } catch { return {}; } })();
  const id = parsed.id ?? null;
  const rpc = (result: unknown) => new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), { headers: { "content-type": "application/json" } });
  if (parsed.method === "podster.dev/verifyEndpoint") {
    const { agent_id, version, challenge } = parsed.params ?? {};
    if (path.startsWith("/nudge/echo")) return rpc({ proof: challenge });
    const secret = path.startsWith("/nudge/wrong") ? "a2asec_not_this_one" : String(scripted(`proof:${path}`) ?? "");
    return rpc({ proof: createHmac("sha256", secret).update(`podster-endpoint-proof/1.${agent_id}.${version}.${challenge}`).digest("hex") });
  }
  if (path.startsWith("/nudge/flaky")) return new Response("no", { status: 503 });
  return rpc({ message: { messageId: "m-nudge", role: "ROLE_AGENT", parts: [{ text: "Fetching." }] } });
}

// Uploads, in test builds only: the Worker calls `/receiving/<object>` each time it starts reading an upload's bytes, past the
// room's begin step and the uploader's first check. A test reads `/count/<object>`, then waits on `/wait/<object>/<n>`, a request
// of its own that answers once the Worker has started reading n times, so it acts while the bytes arrive instead of sleeping.
// `/cancel/<object>` answers every wait on that object, for a test whose upload was refused before any reading.
const uploadReadings = new Map<string, number>();
const uploadWaits: { object: string; count: number; open: () => void }[] = [];
async function uploadGate(url: URL) {
  const [, step, object, wanted] = url.pathname.split("/");
  const count = () => uploadReadings.get(object) ?? 0;
  const answer = () => new Response(JSON.stringify({ count: count() }), { headers: { "content-type": "application/json" } });
  const wake = (all: boolean) => {
    for (const wait of uploadWaits.filter((w) => w.object === object && (all || w.count <= count()))) {
      uploadWaits.splice(uploadWaits.indexOf(wait), 1);
      wait.open();
    }
  };
  if (step === "receiving") {
    uploadReadings.set(object, count() + 1);
    wake(false);
  } else if (step === "wait" && count() < Number(wanted)) {
    await new Promise<void>((open) => uploadWaits.push({ object, count: Number(wanted), open }));
  } else if (step === "cancel") {
    wake(true);
  }
  return answer();
}

/** `partition` is the calling project's partition of the content provider's stand-in (`pool` below). */
async function fakeHook(request: Request, partition: ContentPartition) {
  // GitHub, for provisioning (M5 step 4): a fake, so nothing ever reaches the real one. Its calls carry tokens, so they
  // stay out of the hook log.
  // The release job's read-only App is a stand-in of its own, asked first: what isn't that App's is left to the other.
  const releaseRead = await fakeGithubRelease(request);
  if (releaseRead) return releaseRead;
  const github = await fakeGithub(request);
  if (github) return github;
  // Cloudflare for SaaS's custom hostnames (M6 step 8b): a stand-in, asked before the content provider's, so nothing
  // ever reaches Cloudflare's API.
  const hostnames = await fakeHostnames(request);
  if (hostnames) return hostnames;
  // D1, the rooms' app stores (M6 stage 1): a stand-in, asked before the content provider's, so nothing ever reaches
  // Cloudflare's API.
  const stores = await fakeStores(request);
  if (stores) return stores;
  // The provider that serves rooms' apps (M6 step 4(a)): a stand-in, so nothing ever reaches Cloudflare's API.
  const content = await fakeContent(request, partition);
  if (content) return content;
  // The resolver a room's proof job reads a custom hostname's challenge from (M6 step 8): a stand-in, so nothing ever
  // asks a real one.
  const resolved = await fakeResolver(request);
  if (resolved) return resolved;
  const url = new URL(request.url);
  if (url.hostname === "upload-gate.example.com") return uploadGate(url);
  if (url.hostname === "hook-log.example.com") return new Response(JSON.stringify(hookRequests));
  // The independent A2A server's controls, for a2a-nudge-interop.spec.ts (M7 step 15). Kept out of the hook log.
  if (url.hostname === A2A_SDK_CONTROL_HOST) return a2aSdkControl(request);
  if (url.hostname === "a2a-script.example.com") {
    const { key, answers } = await request.json() as { key: string; answers: unknown[] };
    scripts.set(key, answers);
    return new Response("ok");
  }
  const body = await request.text();
  hookRequests.push({ host: url.hostname, path: url.pathname, signature: request.headers.get("x-podster-signature"), agent: request.headers.get("user-agent"), authorization: request.headers.get("authorization"), a2aVersion: request.headers.get("a2a-version"), body });
  if (url.hostname === "langgraph.example.com") return independent(process.env.PODSTER_LANGGRAPH_URL, request, url, body);
  if (url.hostname === "fasta2a.example.com") return independent(process.env.PODSTER_FASTA2A_URL, request, url, body);
  // The A2A project's own SDK server, in this process on 127.0.0.1, so this one runs in every `npm test` (M7 step 15).
  if (url.hostname === A2A_SDK_HOST) return independent(await a2aSdkBase(), request, url, body);
  if (url.pathname.startsWith("/hang")) await new Promise((resolve) => setTimeout(resolve, 5000));
  if (url.pathname.startsWith("/fail")) return new Response("no", { status: 500 });
  if (url.pathname.startsWith("/redirect")) return new Response(null, { status: 302, headers: { location: "https://elsewhere.example.com/" } });
  if (url.pathname.startsWith("/a2a")) return a2aAnswer(url.pathname, body);
  if (url.pathname.startsWith("/nudge")) return nudgeAnswer(url.pathname, body);
  return new Response("ok");
}

// An independent A2A server, when a2a-langgraph.spec.ts or a2a-fasta2a.spec.ts runs against one (decision 143). The API sends
// to a made-up public name, langgraph.example.com or fasta2a.example.com, which passes egress policy as any agent's endpoint
// would, and only this test runtime forwards it to the local server named by PODSTER_LANGGRAPH_URL or PODSTER_FASTA2A_URL.
// Podster's own egress rules are unchanged.
async function independent(base: string | undefined, request: Request, url: URL, body: string) {
  if (!base || !/^http:\/\/127\.0\.0\.1:\d+$/.test(base)) return new Response("no independent A2A server for this run", { status: 502 });
  const headers: Record<string, string> = {};
  for (const name of ["content-type", "a2a-version", "x-podster-signature", "authorization", "user-agent"]) {
    const value = request.headers.get(name);
    if (value) headers[name] = value;
  }
  return fetch(`${base}${url.pathname}`, { method: request.method, headers, body: request.method === "GET" ? undefined : body, redirect: "manual" });
}

/** Each `path` and `method` in the contract, read line by line, as the route-list test has always read it. */
function contractRoutes() {
  const text = readFileSync(new URL("../../packages/contracts/openapi.yaml", import.meta.url), "utf8");
  const routes: { path: string; method: string; operation: string }[] = [];
  let path = "";
  let method = "";
  for (const line of text.split("\n")) {
    const p = line.match(/^  (\/[^:]+):\s*$/);
    if (p) { path = p[1]; continue; }
    const m = line.match(/^    (get|post|put|delete):/);
    if (m && path) method = m[1].toUpperCase();
    const op = line.match(/operationId: ([A-Za-z0-9]+)/);
    if (op && path && method) { routes.push({ path, method, operation: op[1] }); method = ""; }
  }
  const operations = text.match(/operationId: /g)?.length ?? 0;
  if (routes.length !== operations) throw new Error(`read ${routes.length} routes of ${operations} operations`);
  return routes;
}

/**
 * The Workers pool for one partition of the content provider's stand-in: the same in every way but the content
 * provider's two namespaces, which only this partition's calls name (`CONTENT_PARTITIONS` in test/fake-content.ts).
 */
const pool = (partition: ContentPartition) =>
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        outboundService: (request: Request) => fakeHook(request, partition),
        queueProducers: { WAKE: { queueName: "podster-wake-test" }, SCAN: { queueName: "podster-scan-test" }, A2A: { queueName: "podster-a2a-test" } },
        // The test pool can't run the real consumer. This one records what actually crosses the queue.
        workers: [
          {
            name: "wake-queue-recorder",
            modules: true,
            script: `export default { async queue(batch) { for (const message of batch.messages) { await fetch("https://hook-record.example.com/__queue", { method: "POST", body: JSON.stringify(message.body) }); message.ack(); } } };`,
            compatibilityDate: "2026-08-01",
            outboundService: (request: Request) => fakeHook(request, partition),
            queueConsumers: { "podster-wake-test": { maxBatchTimeout: 0.05 }, "podster-scan-test": { maxBatchTimeout: 0.05 }, "podster-a2a-test": { maxBatchTimeout: 0.05 } },
          },
        ],
        bindings: {
          ASSERTION_KEYS: JSON.stringify({ test: pub.x }),
          SCANNER_SECRET: "test-scanner-secret",
          // Test operators only (M4 step 10). Naming real ones is the owner's call.
          OPERATORS: "per_operator_one, per_operator_two",
          // Stand-ins for a setting bound as something other than a string, or as a string, under names no deployment
          // uses. A test points one room's read of REPOSITORY_REQUESTERS, MANAGED_REPOSITORIES or OPERATORS at one of
          // these. The real names stay unbound here, except OPERATORS above.
          TEST_SETTING_LIST: ["operators", "test-people"],
          TEST_SETTING_NUMBER: 7,
          TEST_SETTING_OBJECT: { operators: true, "test-people": true },
          TEST_SETTING_TRUE: true,
          TEST_SETTING_NULL: null,
          TEST_SETTING_TEXT_TRUE: "true",
          TEST_SETTING_TEXT_OPERATORS: "operators",
          TEST_SETTING_OPERATOR_LIST: ["per_operator_one"],
          // A test value only. The real key is the owner's to set (decision 122).
          A2A_TOKEN_KEY: "0f".repeat(32),
          EXPLORE_CURSOR_KEY: "a5".repeat(32),
          // Provisioning's configuration (M5 step 4), pointing at the fake. The real values and the key are the owner's to set.
          GITHUB_ORG_LOGIN: FAKE_GITHUB.orgLogin,
          GITHUB_ORG_ID: String(FAKE_GITHUB.orgId),
          GITHUB_PROVISION_APP_ID: String(FAKE_GITHUB.provisionAppId),
          GITHUB_PROVISION_INSTALLATION_ID: String(FAKE_GITHUB.installationId),
          GITHUB_MERGE_APP_ID: String(FAKE_GITHUB.mergeAppId),
          GITHUB_PROVISION_APP_KEY: FAKE_APP_KEY_PEM,
          // The agent-token App (M5 step 6), also pointing at the fake, with its own key. And a test sealing key: the real
          // ones are the owner's to set.
          GITHUB_AGENT_APP_ID: String(FAKE_GITHUB.agentAppId),
          GITHUB_AGENT_INSTALLATION_ID: String(FAKE_GITHUB.agentInstallationId),
          GITHUB_AGENT_APP_KEY: FAKE_AGENT_KEY_PEM,
          REPO_TOKEN_KEY: "3c".repeat(32),
          // The merge App (M5 step 7b), pointing at the fake, with its own installation and key. The real ones are the owner's to set.
          GITHUB_MERGE_INSTALLATION_ID: String(FAKE_GITHUB.mergeInstallationId),
          GITHUB_MERGE_APP_KEY: FAKE_MERGE_KEY_PEM,
          TEST_FAKE_GITHUB: JSON.stringify(FAKE_GITHUB),
          // The release job's read-only App (M6 step 5), pointing at its stand-in, with its own installation and key.
          // Test values: the App doesn't exist, no environment binds these names, and each is the owner's to set.
          GITHUB_RELEASE_APP_ID: String(FAKE_RELEASE.appId),
          GITHUB_RELEASE_INSTALLATION_ID: String(FAKE_RELEASE.installationId),
          GITHUB_RELEASE_APP_KEY: FAKE_RELEASE_KEY_PEM,
          // The content provider's configuration (M6 step 4(a)), pointing at the stand-in. Test values: no environment
          // binds any of these names, and the real ones are the owner's to set.
          CONTENT_ACCOUNT_ID: FAKE_CONTENT.account,
          CONTENT_DISPATCH_NAMESPACE: CONTENT_PARTITIONS[partition].namespace,
          CONTENT_KV_NAMESPACE_ID: CONTENT_PARTITIONS[partition].kvNamespace,
          CONTENT_DOMAIN: FAKE_CONTENT.domain,
          CONTENT_SCRIPTS_TOKEN: FAKE_CONTENT.scriptsToken,
          CONTENT_ROUTING_TOKEN: FAKE_CONTENT.routingToken,
          // The app stores' own credential (M6 stage 1), on the content provider's account, pointing at D1's stand-in.
          // A test value: no environment binds this name, and the real token is the owner's to make.
          CONTENT_STORE_TOKEN: FAKE_STORES.token,
          // Test builds only: the store reconcile's own account at D1's stand-in (S5's second PR), so the hourly passes
          // `takedown.spec.ts` runs never touch the databases `app-store.spec.ts` keeps beside it. A test value.
          TEST_STORE_RECONCILE_ACCOUNT: FAKE_STORES.reconcileAccount,
          // The stand-in's values as this project sees them, with its own partition's namespaces and control host.
          TEST_FAKE_CONTENT: JSON.stringify({ ...FAKE_CONTENT, ...CONTENT_PARTITIONS[partition], partition }),
          // A custom hostname's proof (M6 step 8): the resolver, pointing at its stand-in. A test value: only staging
          // binds this name, to the real resolver. The Public Suffix List is the compiled-in snapshot, as deployed.
          HOSTNAME_RESOLVER_URL: FAKE_RESOLVER.url,
          // Custom hostnames at Cloudflare (M6 step 8b), pointing at their stand-in. Test values: no environment binds
          // either name, and the real ones are the owner's to set.
          CUSTOM_HOSTNAME_ZONE_ID: FAKE_HOSTNAMES.zone,
          CUSTOM_HOSTNAME_TOKEN: FAKE_HOSTNAMES.token,
          TEST_GATE_LIMIT_MS: GATE_LIMIT_MS,
          // The provider module's source, for the test that reads its settings' names and shows no environment binds one.
          // Every Rust source file of the API, by its path under src, and its Cargo.toml, for the test that shows no
          // test-only switch is in a deployment's build.
          TEST_API_SOURCES: JSON.stringify(Object.fromEntries((readdirSync(new URL("./src", import.meta.url), { recursive: true }) as string[]).filter((name) => name.endsWith(".rs")).sort().map((name) => [name.split("\\").join("/"), readFileSync(new URL(`./src/${name}`, import.meta.url), "utf8")]))),
          TEST_API_CARGO: readFileSync(new URL("./Cargo.toml", import.meta.url), "utf8"),
          // The Worker's own configuration file, as text, for a test that it names no setting it shouldn't.
          TEST_API_WRANGLER: readFileSync(new URL("./wrangler.jsonc", import.meta.url), "utf8"),
          TEST_CONTENT_PROVIDER_SOURCE: readFileSync(new URL("./src/content_provider.rs", import.meta.url), "utf8"),
          // What the API writes into the serve entries' namespace and the content Worker reads (M6 step 4(b)): the
          // vectors apps/content and crates/core are tested against, for the test that shows the API's side agrees.
          TEST_SERVE_FIXTURE: readFileSync(new URL("../../packages/contracts/serve-entry.fixture.json", import.meta.url), "utf8"),
          // Set only by e2e/run-langgraph-check.mjs. Empty, a2a-langgraph.spec.ts skips.
          TEST_LANGGRAPH_ASSISTANT: process.env.PODSTER_LANGGRAPH_URL ? (process.env.PODSTER_LANGGRAPH_ASSISTANT ?? "") : "",
          // Set only by e2e/run-fasta2a-check.mjs: the agent's run time in seconds. Empty, a2a-fasta2a.spec.ts skips.
          TEST_FASTA2A_RUN_SECONDS: process.env.PODSTER_FASTA2A_URL ? (process.env.PODSTER_FASTA2A_RUN_SECONDS ?? "") : "",
          TEST_WRANGLER: readFileSync(new URL("./wrangler.jsonc", import.meta.url), "utf8"),
          // What scripts/deploy-staging's own rule says of that file, and of the same file with staging's list taken
          // out: the rule is JavaScript outside this package, so it runs here and the test reads its answers.
          TEST_REQUESTERS_RULE: JSON.stringify({
            real: stagingRequestersProblem(readFileSync(new URL("./wrangler.jsonc", import.meta.url), "utf8")),
            withoutList: stagingRequestersProblem(readFileSync(new URL("./wrangler.jsonc", import.meta.url), "utf8").replace(/^\s*"REPOSITORY_REQUESTERS":.*\n/m, "")),
            valid: Object.fromEntries(["operators,test-people", "test-people", "per_owner1", "", "operators,", "everyone"].map((value) => [value, validRequesters(value)])),
          }),
          TEST_D1_SCHEMA: ["0001_membership_index.sql", "0002_room_status.sql", "0003_membership_by_org.sql", "0004_ownerless_rooms.sql", "0005_public_workroom_index.sql", "0006_public_explore_order.sql", "0007_repo_room_index.sql", "0008_app_label_index.sql", "0009_app_label_approved.sql"].map((name) => readFileSync(new URL(`./migrations/${name}`, import.meta.url), "utf8")).join("\n").replace(/--.*$/gm, ""),
          TEST_SIGNING_JWK: JSON.stringify(privateKey.export({ format: "jwk" })),
          // Every route the contract lists, for the route-list test (M4 step 7), and the public view's schema.
          TEST_API_ROUTES: JSON.stringify(contractRoutes()),
          // The closed sets crates/core defines for release (M6 step 2), read by the contract package's own reader, so a
          // test can show the room's columns take exactly those.
          TEST_CORE_SETS: JSON.stringify(coreSets(new URL("../../", import.meta.url))),
          // The contract's schemas, parsed, so provenance.spec.ts can hold the room's real answer to `TaskProvenance`.
          TEST_CONTRACT_SCHEMAS: JSON.stringify({ components: { schemas: parseYaml(readFileSync(new URL("../../packages/contracts/openapi.yaml", import.meta.url), "utf8")).components.schemas } }),
          TEST_PUBLIC_VIEW_SCHEMA: readFileSync(new URL("../../packages/contracts/public-workroom-view.schema.json", import.meta.url), "utf8"),
        },
      },
    });

/**
 * The spec files that own a partition of the content provider's stand-in, each run as a project of its own so its
 * resets, seeds and reads never meet another file's. Every other spec file is in the default project and partition.
 */
const OWN_PARTITION: Record<Exclude<ContentPartition, "default">, string> = {
  "serve-entry": "test/serve-entry.spec.ts",
  "custom-routing": "test/custom-routing.spec.ts",
  "custom-marker": "test/custom-marker.spec.ts",
};
// bound-meta.ts records each test's time bound for the duration report (e2e/test-durations.mjs).
const shared = { testTimeout: 30000, setupFiles: ["./test/bound-meta.ts"] };

export default defineConfig({
  test: {
    projects: [
      { plugins: [pool("default")], test: { ...shared, name: "api", include: ["test/**/*.spec.ts"], exclude: Object.values(OWN_PARTITION) } },
      ...Object.entries(OWN_PARTITION).map(([partition, file]) => ({
        plugins: [pool(partition as ContentPartition)],
        test: { ...shared, name: partition, include: [file] },
      })),
    ],
  },
});
