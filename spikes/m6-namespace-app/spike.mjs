#!/usr/bin/env node
// M6 spike A: a room's app in a Workers for Platforms dispatch namespace.
//
// Every call to Cloudflare's API goes through a `wrangler` command and its own login.
// This script never reads, holds or prints a token, and never turns wrangler's log sanitizing off.
// See README.md.

import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, existsSync, rmSync, appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { childEnv } from "../../e2e/child-env.mjs";
import { NAMESPACE, allowedName, guard, deleteArgument } from "./guard.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ACCOUNT = process.env.CLOUDFLARE_ACCOUNT_ID;
const DISPATCH = "spike-m6-dispatch";
const WORK = join(HERE, ".wrangler", "spike");
const LEDGER = join(WORK, "ledger.json");
const BASE_FILE = join(WORK, "base-url");
const RESULTS = join(WORK, "results.jsonl");

// The ID of the Cloudflare account that holds podster.dev. It stays out of this repository.
if (!ACCOUNT || !/^[0-9a-f]{32}$/.test(ACCOUNT)) {
  console.error("Set CLOUDFLARE_ACCOUNT_ID to the ID of the Cloudflare account that holds podster.dev. Refusing to run without it.");
  process.exit(2);
}
mkdirSync(WORK, { recursive: true });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const ledger = () => (existsSync(LEDGER) ? JSON.parse(readFileSync(LEDGER, "utf8")) : { created: [], deleted: [] });
const note = (kind, name) => {
  const l = ledger();
  if (!l[kind].includes(name)) l[kind].push(name);
  writeFileSync(LEDGER, JSON.stringify(l, null, 2));
};
const base = () => readFileSync(BASE_FILE, "utf8").trim();
// The account ID and the workers.dev subdomain name the account, so neither reaches the output or a
// file that is kept. The ID is in every API path wrangler logs and in one of the probe's targets.
const redact = (text) => {
  const named = text.replaceAll(ACCOUNT, "<account>");
  return existsSync(BASE_FILE) ? named.replaceAll(new URL(base()).host.split(".")[1], "<subdomain>") : named;
};
const record = (what, data) => {
  const line = redact(JSON.stringify({ at: new Date().toISOString(), what, ...data }));
  appendFileSync(RESULTS, line + "\n");
  console.log(redact(JSON.stringify({ what, ...data }, null, 2)));
};

// Runs one wrangler command with debug logging, and returns its exit code, its output
// lines with the time each arrived, and the API calls its log names (method, path, status).
//
// Wrangler gets the allow-listed environment of e2e/child-env.mjs and its own settings, plus exactly
// one name of Cloudflare's, the account ID, which is an ID and not a credential: the same narrow
// exception e2e/m5-tails.mjs makes. Nothing else of this process's environment reaches it, so a
// WRANGLER_LOG_SANITIZE or a token set in the caller's shell doesn't either. Wrangler finds its own
// login under HOME.
function wrangler(args) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const child = spawn(join(HERE, "node_modules", ".bin", "wrangler"), args, {
      cwd: HERE,
      env: {
        ...childEnv({ WRANGLER_LOG: "debug", WRANGLER_SEND_METRICS: "false", NO_COLOR: "1", FORCE_COLOR: "0", CI: "1" }),
        CLOUDFLARE_ACCOUNT_ID: ACCOUNT,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const lines = [];
    let pending = "";
    const take = (chunk) => {
      pending += chunk;
      const parts = pending.split("\n");
      pending = parts.pop();
      for (const text of parts) lines.push({ at: Date.now(), text });
    };
    child.stdout.on("data", take);
    child.stderr.on("data", take);
    child.on("close", (code) => {
      if (pending) lines.push({ at: Date.now(), text: pending });
      const calls = [];
      for (const line of lines) {
        const request = line.text.match(/START CF API REQUEST: (\w+) https:\/\/api\.cloudflare\.com\/client\/v4(\S+)/);
        if (request) calls.push({ method: request[1], path: request[2], sentAt: line.at });
        const response = line.text.match(/START CF API RESPONSE: (.*) (\d{3})$/);
        if (response && calls.length) {
          const last = calls[calls.length - 1];
          last.status = Number(response[2]);
          last.answeredAt = line.at;
          last.ms = line.at - last.sentAt;
        }
      }
      const errors = lines
        .map((l) => l.text)
        .filter((t) => /\[ERROR\]|\[code: \d+\]|✘/.test(t))
        .map((t) => t.trim().slice(0, 300));
      resolve({ code, startedAt, endedAt: Date.now(), ms: Date.now() - startedAt, lines, calls, errors });
    });
  });
}

const callSummary = (run) => run.calls.map((c) => `${c.method} ${c.path} -> ${c.status} (${c.ms} ms)`);

// Uploads only what `deleteUser` can delete again: the same guard.
async function deployUser(config, name) {
  guard(name, NAMESPACE);
  const run = await wrangler(["deploy", "-c", config, "--dispatch-namespace", NAMESPACE, "--name", name]);
  if (run.code === 0) note("created", `${NAMESPACE}/${name}`);
  return run;
}

// Wrangler 4.157.0 has no command that deletes a script in a dispatch namespace. Its
// `delete` puts the name into the API path unescaped, so a name that climbs one segment
// reaches DELETE /workers/dispatch/namespaces/<namespace>/scripts/<name> under wrangler's
// own login. A release job would call that endpoint directly.
//
// The same trick with another name could reach a Worker on the account: `--name spike-m6-../x`
// would be DELETE …/scripts/x after the path is normalized. So `deleteArgument` (guard.mjs) throws,
// before wrangler is started, unless the name matches ^spike-m6-[a-z0-9-]{1,50}$ exactly and the
// namespace is the literal `podster-staging-apps`.
async function deleteUser(name) {
  const run = await wrangler(["delete", "--force", "--name", deleteArgument(name, NAMESPACE)]);
  if (run.code === 0) note("deleted", `${NAMESPACE}/${name}`);
  return run;
}

async function get(path, init = {}) {
  const started = Date.now();
  const response = await fetch(base() + path, { redirect: "manual", ...init });
  const body = await response.text();
  const headers = {};
  for (const name of [
    "content-type", "cache-control", "etag", "location", "set-cookie", "content-security-policy",
    "x-spike-header", "x-spike-nested", "x-spike-dispatch", "x-content-type-options", "referrer-policy", "allow",
  ]) {
    if (response.headers.has(name)) headers[name] = response.headers.get(name);
  }
  return { status: response.status, ms: Date.now() - started, headers, body: body.slice(0, 400), at: Date.now() };
}

const commands = {
  // Deploys the dispatch Worker to its workers.dev address. `outbound` names it as its own outbound Worker.
  // To go back from `outbound` to plain, delete the Worker first (`cleanup`, or `wrangler delete`):
  // wrangler 4.157.0 reports the binding as "inherited" on a redeploy and the outbound Worker stays.
  async dispatch(variant) {
    const config = variant === "outbound" ? "dispatch/wrangler.outbound.jsonc" : "dispatch/wrangler.jsonc";
    const run = await wrangler(["deploy", "-c", config]);
    const url = run.lines.map((l) => l.text.match(/https:\/\/spike-m6-dispatch\.[a-z0-9-]+\.workers\.dev/)).find(Boolean);
    if (run.code === 0) note("created", `account/${DISPATCH}`);
    if (url) writeFileSync(BASE_FILE, url[0]);
    record("dispatch-deploy", { variant: variant ?? "plain", exit: run.code, ms: run.ms, calls: callSummary(run), errors: run.errors });
  },

  // Items 1, 2, 3 and 9: serving, assets only, _headers and _redirects, and a missing script.
  async serve() {
    for (const [config, name] of [
      ["apps/site/wrangler.jsonc", "spike-m6-a-site"],
      ["apps/assets-only/wrangler.jsonc", "spike-m6-a-assets-only"],
      ["apps/headers/wrangler.jsonc", "spike-m6-a-headers"],
    ]) {
      const run = await deployUser(config, name);
      record("upload", { name, exit: run.code, ms: run.ms, calls: callSummary(run), errors: run.errors });
    }
    await sleep(3000);
    const checks = [
      ["site", "/spike-m6-a-site/"],
      ["site", "/spike-m6-a-site/index.html"],
      ["site", "/spike-m6-a-site/style.css"],
      ["site", "/spike-m6-a-site/marker.txt"],
      ["site", "/spike-m6-a-site/sub/page"],
      ["site", "/spike-m6-a-site/sub/_headers"],
      ["site", "/spike-m6-a-site/.well-known/podster-release.json"],
      ["site", "/spike-m6-a-site/no-such-file"],
      ["site HEAD", "/spike-m6-a-site/marker.txt", { method: "HEAD" }],
      ["site POST to a file", "/spike-m6-a-site/marker.txt", { method: "POST", body: "x" }],
      ["assets-only", "/spike-m6-a-assets-only/"],
      ["assets-only", "/spike-m6-a-assets-only/marker.txt"],
      ["assets-only", "/spike-m6-a-assets-only/no-such-file"],
      ["assets-only POST to a file", "/spike-m6-a-assets-only/marker.txt", { method: "POST", body: "x" }],
      ["assets-only POST to nothing", "/spike-m6-a-assets-only/no-such-file", { method: "POST", body: "x" }],
      ["headers", "/spike-m6-a-headers/index.html"],
      ["headers", "/spike-m6-a-headers/"],
      ["headers", "/spike-m6-a-headers/target"],
      ["headers", "/spike-m6-a-headers/_headers"],
      ["headers", "/spike-m6-a-headers/_redirects"],
      ["headers", "/spike-m6-a-headers/go"],
      ["headers", "/spike-m6-a-headers/moved"],
      ["headers", "/spike-m6-a-headers/rewritten"],
      ["headers, dispatch Worker sets its own last", "/spike-m6-a-headers/?__fix"],
      ["missing script", "/spike-m6-a-never-existed/"],
      ["missing script, odd name", "/Spike_M6.Never~Existed/"],
    ];
    for (const [label, path, init] of checks) {
      const answer = await get(path, init);
      record("request", { label, method: init?.method ?? "GET", path, status: answer.status, ms: answer.ms, headers: answer.headers, body: answer.body.slice(0, 160) });
    }
  },

  // Item 4: what code in the namespace can reach. `probe outbound` expects the dispatch Worker deployed
  // with `dispatch outbound`; `probe again` asks the probe already uploaded.
  async probe(variant) {
    if (variant !== "outbound" && variant !== "again") {
      const run = await deployUser("apps/probe/wrangler.jsonc", "spike-m6-a-probe");
      record("upload", { name: "spike-m6-a-probe", exit: run.code, ms: run.ms, calls: callSummary(run), errors: run.errors });
      await sleep(3000);
    }
    const targets = [
      "https://example.com/",
      "https://example.org/",
      `${base()}/`,
      `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/workers/dispatch/namespaces`,
      "http://127.0.0.1/",
      "http://10.0.0.1/",
    ];
    const query = targets.map((t) => `t=${encodeURIComponent(t)}`).join("&") + "&tcp=example.com:80&tcp=neverssl.com:80";
    for (const mode of variant === "outbound" ? ["block", "pass"] : [null]) {
      const response = await fetch(`${base()}/spike-m6-a-probe/?${query}${mode ? `&__outbound=${mode}` : ""}`);
      const text = await response.text();
      const answer = { status: response.status };
      let body = text.slice(0, 400);
      try {
        body = JSON.parse(text);
      } catch {}
      record("probe", { outbound: mode ?? "none configured", status: answer.status, report: body });
    }
  },

  // Item 6: how long an upload, a replace and a delete take to show at the workers.dev address.
  async timing(roundsText) {
    const rounds = Number(roundsText ?? 5);
    for (let round = 1; round <= rounds; round++) {
      const name = `spike-m6-a-t${round}-${randomBytes(3).toString("hex")}`;
      const dir = join(WORK, name);
      mkdirSync(join(dir, "public"), { recursive: true });
      writeFileSync(join(dir, "wrangler.jsonc"), JSON.stringify({ name, compatibility_date: "2026-11-01", assets: { directory: "public" } }));
      const path = `/${name}/marker.txt`;

      // Polls the address about every 100 ms while `action` runs and until `seen` first holds,
      // then for 5 more seconds, counting any answer that goes back to the old state.
      const watch = async (action, seen) => {
        const samples = [];
        let stop = false;
        const poller = (async () => {
          while (!stop) {
            try {
              const answer = await get(`${path}?n=${Date.now()}`);
              samples.push({ at: answer.at, ok: seen(answer), status: answer.status });
            } catch {
              samples.push({ at: Date.now(), ok: false, status: 0 });
            }
            await sleep(100);
          }
        })();
        const run = await action();
        const deadline = Date.now() + 120_000;
        while (!samples.some((s) => s.ok) && Date.now() < deadline) await sleep(50);
        await sleep(5000);
        stop = true;
        await poller;
        const first = samples.find((s) => s.ok);
        const write = [...run.calls].reverse().find((c) => /\/scripts\/[^/]+$/.test(c.path) && (c.method === "PUT" || c.method === "DELETE"));
        return {
          exit: run.code,
          wrangler_ms: run.ms,
          api_call: write ? `${write.method} -> ${write.status} in ${write.ms} ms` : null,
          upload_calls_ms: run.calls.filter((c) => c.method !== "GET").reduce((sum, c) => sum + (c.ms ?? 0), 0),
          shown_after_api_answer_ms: first && write ? first.at - write.answeredAt : null,
          shown_after_command_start_ms: first ? first.at - run.startedAt : null,
          old_state_seen_after_first_new: first ? samples.filter((s) => s.at > first.at && !s.ok).length : null,
          samples: samples.length,
          errors: run.errors,
        };
      };

      const marker = (version) => `spike-m6-a ${name} ${version}\n`;
      writeFileSync(join(dir, "public", "marker.txt"), marker("v1"));
      const upload = await watch(() => deployUser(join(dir, "wrangler.jsonc"), name), (a) => a.status === 200 && a.body === marker("v1"));
      record("timing", { round, step: "upload", name, ...upload });

      writeFileSync(join(dir, "public", "marker.txt"), marker("v2"));
      const replace = await watch(() => deployUser(join(dir, "wrangler.jsonc"), name), (a) => a.status === 200 && a.body === marker("v2"));
      record("timing", { round, step: "replace", name, ...replace });

      const remove = await watch(() => deleteUser(name), (a) => a.status !== 200);
      const after = await get(path);
      record("timing", { round, step: "delete", name, ...remove, answer_after: { status: after.status, body: after.body.slice(0, 200) } });

      const gone = await wrangler(["dispatch-namespace", "get", `${NAMESPACE}/scripts/${name}`]);
      record("read-after-delete", { name, exit: gone.code, calls: callSummary(gone), script_is_null: gone.lines.some((l) => /script: null/.test(l.text)) });
      const again = await deleteUser(name);
      record("delete-again", { name, exit: again.code, calls: callSummary(again), errors: again.errors });
      rmSync(dir, { recursive: true, force: true });
    }
  },

  // Item 8: which script names the upload accepts. Each is a tiny assets-only Worker, deleted at once.
  async names(only) {
    const dir = join(WORK, "names");
    mkdirSync(join(dir, "public"), { recursive: true });
    writeFileSync(join(dir, "public", "index.html"), "name test\n");
    writeFileSync(join(dir, "wrangler.jsonc"), JSON.stringify({ name: "spike-m6-n", compatibility_date: "2026-11-01", assets: { directory: "public" } }));
    const pad = (length) => ("spike-m6-n-" + "a".repeat(5000)).slice(0, length);
    const all = [
      ["63 characters", pad(63)],
      ["64 characters", pad(64)],
      ["65 characters", pad(65)],
      ["100 characters", pad(100)],
      ["255 characters", pad(255)],
      ["256 characters", pad(256)],
      ["512 characters", pad(512)],
      ["1024 characters", pad(1024)],
      ["2048 characters", pad(2048)],
      ["4096 characters", pad(4096)],
      ["upper case", "spike-m6-n-UPPER"],
      ["underscore", "spike-m6-n_under"],
      ["double hyphen", "spike-m6-n--double"],
      ["trailing hyphen", "spike-m6-n-trailing-"],
      ["dot", "spike-m6-n.dot"],
      ["tilde", "spike-m6-n~tilde"],
      ["colon", "spike-m6-n:colon"],
      ["plus", "spike-m6-n+plus"],
    ];
    // `names long` runs only the length cases past 256.
    const cases = only === "long" ? all.filter(([label]) => /^(512|1024|2048|4096) /.test(label)) : all;
    for (const [label, name] of cases) {
      // The run of 2026-11-12 uploaded and deleted every case, before the guard was this narrow.
      // Now a name the guard refuses is skipped: it couldn't be deleted again through this runner.
      if (!allowedName(name)) {
        record("name", { label, length: name.length, skipped: "the guard refuses this name, so it isn't uploaded" });
        continue;
      }
      const run = await deployUser(join(dir, "wrangler.jsonc"), name);
      const result = { label, length: name.length, name: name.length > 40 ? `${name.slice(0, 16)}…(${name.length})` : name, exit: run.code, calls: callSummary(run), errors: run.errors };
      if (run.code === 0) {
        await sleep(2500);
        const served = await get(`/${encodeURIComponent(name)}/`);
        result.served = { status: served.status, body: served.body.slice(0, 80) };
        if (name !== name.toLowerCase()) {
          const lower = await get(`/${encodeURIComponent(name.toLowerCase())}/`);
          result.served_lower_case = { status: lower.status, body: lower.body.slice(0, 80) };
        }
        const removed = await deleteUser(name);
        result.deleted = { exit: removed.code, calls: callSummary(removed), errors: removed.errors };
      }
      record("name", result);
    }
    rmSync(dir, { recursive: true, force: true });
  },

  // Reads the namespace and lists what the ledger says was created and not yet deleted.
  async status() {
    const run = await wrangler(["dispatch-namespace", "get", NAMESPACE]);
    const count = run.lines.map((l) => l.text.match(/script_count: (\d+)/)).find(Boolean);
    const l = ledger();
    record("status", { namespace: NAMESPACE, script_count: count ? Number(count[1]) : null, calls: callSummary(run), created: l.created, deleted: l.deleted, left: l.created.filter((n) => !l.deleted.includes(n)) });
  },

  // Deletes every script the ledger names, then the dispatch Worker, then reads the namespace.
  async cleanup() {
    const l = ledger();
    for (const entry of l.created.filter((n) => n.startsWith(`${NAMESPACE}/`) && !l.deleted.includes(n))) {
      const name = entry.slice(NAMESPACE.length + 1);
      const run = await deleteUser(name);
      record("cleanup", { name: entry, exit: run.code, calls: callSummary(run), errors: run.errors });
    }
    if (l.created.includes(`account/${DISPATCH}`) && !l.deleted.includes(`account/${DISPATCH}`)) {
      const run = await wrangler(["delete", "--force", "--name", DISPATCH]);
      if (run.code === 0) note("deleted", `account/${DISPATCH}`);
      record("cleanup", { name: `account/${DISPATCH}`, exit: run.code, calls: callSummary(run), errors: run.errors });
    }
    await commands.status();
  },

  // Item 5, the bodies of the upload's calls, has no command here any more. The run of 2026-11-12 read
  // them from wrangler's debug log with its sanitizing turned off, and that also left the login's bearer
  // token in wrangler's own log files under ~/.wrangler/logs. Sanitizing must never be turned off. The
  // shapes as recorded, with placeholders, are in README.md.

  // Reads through wrangler: `read scripts` lists the namespace's scripts, `read scripts/<name>` one script.
  // `wrangler dispatch-namespace get` puts its argument into the API path as it is.
  async read(subpath) {
    if (subpath !== "scripts") {
      const [first, name, ...more] = String(subpath).split("/");
      if (first !== "scripts" || more.length) throw new Error("usage: read scripts | read scripts/<name>");
      guard(name, NAMESPACE);
    }
    const run = await wrangler(["dispatch-namespace", "get", `${NAMESPACE}/${subpath}`]);
    const start = run.lines.findIndex((l) => /^[\[{]/.test(l.text));
    const body = start < 0 ? [] : run.lines.slice(start).map((l) => l.text).filter((t) => !/Logs were written|^$/.test(t));
    record("read", { path: `${NAMESPACE}/${subpath}`, exit: run.code, calls: callSummary(run), body: body.join("\n").slice(0, 3000), errors: run.errors });
    return body.join("\n");
  },

  // One script by name: `delete spike-m6-…`.
  async delete(name) {
    const run = await deleteUser(name);
    record("delete", { name, exit: run.code, calls: callSummary(run), errors: run.errors });
  },
};

const [command, ...rest] = process.argv.slice(2);
if (!commands[command]) {
  console.error(`usage: node spike.mjs <${Object.keys(commands).join("|")}>`);
  process.exit(2);
}
await commands[command](...rest);
