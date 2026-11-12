#!/usr/bin/env node
// M6 spike B: what a Cloudflare API token that can publish to the dispatch namespace can also reach.
//
// Spike only. It holds tokens that can change every Worker on the account, so:
// - every request goes through `send`, and `send` asks guard.mjs first. Nothing but a GET leaves this
//   process unless it names a script matching ^spike-m6-b-[a-z0-9-]{1,40}$;
// - a token is read into memory from the owner's file, sent in a header and nowhere else. It is never
//   printed, logged, written or put on a command line;
// - what is recorded is a status, Cloudflare's error codes and messages, and counts. Never a body, and
//   for anything that would be Podster's data, the status and codes alone.
// See README.md.

import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { childEnv } from "../../e2e/child-env.mjs";
import { NAMESPACE, allow, allowedName } from "./guard.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const API = "https://api.cloudflare.com/client/v4";
const ACCOUNT = process.env.CLOUDFLARE_ACCOUNT_ID ?? "";
const TOKENS_FILE = process.env.SPIKE_TOKENS_FILE ?? join(homedir(), ".podster", "m6-staging", "spike-tokens.env");
const RESULTS = join(HERE, "results", "results.jsonl");
const CANARY = "spike-m6-b-canary";
const PODSTER_WORKER = "podster-api-staging"; // read with GET only, and only its status is kept
const ZONES = ["opster.dev", "podster.dev"];
const WHICH = { read: "CF_SPIKE_TOKEN_SCRIPTS_READ", narrow: "CF_SPIKE_TOKEN_NARROW", edit: "CF_SPIKE_TOKEN_SCRIPTS_EDIT" };

if (!/^[0-9a-f]{32}$/.test(ACCOUNT)) {
  console.error("Set CLOUDFLARE_ACCOUNT_ID to the ID of the Cloudflare account that holds podster.dev. Refusing to run without it.");
  process.exit(2);
}

// ---- secrets, held in memory only ----

const secrets = new Set();

/** The owner's token file, parsed here. Refused unless only its owner can read it. */
function readTokens() {
  if (statSync(TOKENS_FILE).mode & 0o077) throw new Error("the token file must be mode 600");
  const found = {};
  for (const line of readFileSync(TOKENS_FILE, "utf8").split("\n")) {
    const match = line.match(/^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (match) found[match[1]] = match[2].replace(/^(["'])(.*)\1$/, "$2");
  }
  const tokens = {};
  for (const [which, key] of Object.entries(WHICH)) {
    if (!found[key]) throw new Error(`the token file has no ${key}`);
    tokens[which] = found[key];
    secrets.add(found[key]);
  }
  return { tokens, narrowName: found.CF_SPIKE_NARROW_PERMISSION_NAME ?? null };
}

let cachedLogin;
/** Wrangler's own login, for the canary, the look-ups a spike token can't make and the clean-up. As spike C read it. */
function login() {
  if (!cachedLogin) {
    const out = execFileSync(join(HERE, "node_modules", ".bin", "wrangler"), ["auth", "token", "--json"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      // The allow-listed environment of e2e/child-env.mjs, plus exactly one name of Cloudflare's: the account ID.
      env: { ...childEnv({ WRANGLER_SEND_METRICS: "false", NO_COLOR: "1", CI: "1" }), CLOUDFLARE_ACCOUNT_ID: ACCOUNT },
    });
    cachedLogin = JSON.parse(out).token;
    if (!cachedLogin) throw new Error("wrangler has no login");
    secrets.add(cachedLogin);
  }
  return cachedLogin;
}

// ---- the one request function ----

const zoneIds = new Map(); // zone name -> ID, in memory only

/** Takes every secret and every ID that names the account or a zone out of a text before it is kept or shown. */
function redact(text) {
  let out = String(text);
  for (const secret of secrets) out = out.replaceAll(secret, "<token>");
  out = out.replaceAll(ACCOUNT, "<account>");
  for (const [name, id] of zoneIds) out = out.replaceAll(id, `<zone ${name}>`);
  return out
    .replace(/\b[0-9a-f]{32}\b/g, "<id>")
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[a-z]{2,}/g, "<email>")
    .replace(/[a-z0-9-]+\.workers\.dev/g, "<subdomain>.workers.dev");
}

/**
 * Sends one request and returns { status, body }. `allow` throws before anything is sent unless the request is a
 * GET, or names a spike script. A redirect is an error, so a token can't follow one to another host.
 */
async function send(bearer, method, path, { json, form } = {}) {
  const url = allow(method, API + path, ACCOUNT);
  const headers = { authorization: `Bearer ${bearer}` };
  let body;
  if (json !== undefined) [headers["content-type"], body] = ["application/json", JSON.stringify(json)];
  if (form !== undefined) body = form;
  const response = await fetch(url, { method, headers, body, redirect: "error" });
  const text = await response.text();
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {}
  return { status: response.status, body: parsed, text };
}

function record(entry) {
  mkdirSync(dirname(RESULTS), { recursive: true });
  const line = redact(JSON.stringify({ at: new Date().toISOString(), ...entry }));
  appendFileSync(RESULTS, line + "\n");
  console.log(line);
}

const errorsOf = (body) => (body && Array.isArray(body.errors) ? body.errors.map((e) => ({ code: e.code, message: String(e.message ?? "").slice(0, 160) })) : []);
const countOf = (body) => (body && Array.isArray(body.result) ? body.result.length : null);

/**
 * One recorded call. `keep` picks what may be kept besides the status and Cloudflare's error codes:
 * "count" for the length of a list, a function for something read from the body, nothing for Podster's data.
 */
async function call(who, bearer, op, method, path, { json, form, keep } = {}) {
  let answer;
  try {
    answer = await send(bearer, method, path, { json, form });
  } catch (error) {
    record({ token: who, op, method, path, refused_or_failed: String(error.message).slice(0, 200) });
    return { status: 0, body: null, text: "" };
  }
  const errors = errorsOf(answer.body);
  const entry = { token: who, op, method, path, status: answer.status, codes: errors.map((e) => e.code) };
  // A refusal's text is Cloudflare's own, so it is kept whatever was asked for.
  if (errors.length && answer.status >= 400) entry.messages = errors.map((e) => e.message);
  if (keep) {
    if (keep === "count") entry.count = countOf(answer.body);
    else if (typeof keep === "function") Object.assign(entry, keep(answer));
  }
  record(entry);
  return answer;
}

// ---- what is uploaded ----

const moduleCode = (marker) => `export default { fetch() { return new Response(${JSON.stringify(marker + "\n")}); } };\n`;

/** A plain module Worker with no bindings: the script upload's multipart body. */
function scriptForm(marker) {
  const form = new FormData();
  form.append("metadata", new Blob([JSON.stringify({ main_module: "index.js", compatibility_date: "2026-11-01" })], { type: "application/json" }));
  form.append("index.js", new Blob([moduleCode(marker)], { type: "application/javascript+module" }), "index.js");
  return form;
}

const account = `/accounts/${ACCOUNT}`;
const inNamespace = (name) => `${account}/workers/dispatch/namespaces/${NAMESPACE}/scripts/${name}`;
const atAccount = (name) => `${account}/workers/scripts/${name}`;
const markerIn = (answer) => (answer.text.match(/spike-m6-b marker: [a-z-]+/) ?? [null])[0];

/** Makes the canary again, with wrangler's login: an ordinary Worker on the account, with nothing bound to it. */
async function ensureCanary() {
  const put = await call("login", login(), "canary: create or reset", "PUT", atAccount(CANARY), { form: scriptForm("spike-m6-b marker: original"), keep: () => ({}) });
  if (put.status !== 200) throw new Error("the canary couldn't be made with wrangler's login");
  await call("login", login(), "canary: is workers.dev on", "GET", `${atAccount(CANARY)}/subdomain`, { keep: (a) => ({ enabled: a.body?.result?.enabled ?? null }) });
}

async function findZones() {
  const answer = await call("login", login(), "look up the zones", "GET", `/zones?account.id=${ACCOUNT}`, { keep: "count" });
  for (const zone of answer.body?.result ?? []) if (ZONES.includes(zone.name)) zoneIds.set(zone.name, zone.id);
}

// ---- one token ----

async function runToken(which, bearer) {
  const t = (op, method, path, options) => call(which, bearer, op, method, path, options);
  const own = `spike-m6-b-${which}`;
  const fresh = `spike-m6-b-new-${which}`;

  // a. Is it active, and does it expire?
  const verified = (a) => ({ token_status: a.body?.result?.status ?? null, expiry_present: Boolean(a.body?.result?.expires_on), not_before_present: Boolean(a.body?.result?.not_before) });
  const verify = await t("a. verify (user token)", "GET", "/user/tokens/verify", { keep: verified });
  // What the token was given, if anything here may read it: the names of its permission groups and how wide its
  // resources are. The token's ID is used in memory and redacted from what is kept.
  const tokenId = verify.body?.result?.id;
  const granted = (a) => ({
    policies: (a.body?.result?.policies ?? []).map((p) => ({
      effect: p.effect,
      permission_groups: (p.permission_groups ?? []).map((g) => g.name),
      resources: Object.keys(p.resources ?? {}).map((r) => r.replace(/\.[0-9a-f]{32}$/, ".<one>")),
    })),
  });
  if (/^[0-9a-f]{32}$/.test(tokenId ?? "")) {
    await t("a. read its own permissions", "GET", `/user/tokens/${tokenId}`, { keep: granted });
    await call("login", login(), `a. read the ${which} token's permissions`, "GET", `/user/tokens/${tokenId}`, { keep: granted });
  }
  await t("a. verify (account token)", "GET", `${account}/tokens/verify`, { keep: verified });

  // b. The namespace.
  await t("b. namespace: read", "GET", `${account}/workers/dispatch/namespaces/${NAMESPACE}`, { keep: (a) => ({ script_count: a.body?.result?.script_count ?? null }) });
  await t("b. namespace: list scripts", "GET", `${account}/workers/dispatch/namespaces/${NAMESPACE}/scripts`, { keep: "count" });
  await t("b. namespace: start an assets upload session", "POST", `${inNamespace(own)}/assets-upload-session`, {
    json: { manifest: { "/index.html": { hash: "0123456789abcdef0123456789abcdef".split("").reverse().join(""), size: 11 } } },
    keep: (a) => ({ session_given: Boolean(a.body?.result?.jwt) }),
  });
  const uploaded = await t("b. namespace: upload a script", "PUT", inNamespace(own), { form: scriptForm(`spike-m6-b marker: by-${which}`), keep: () => ({}) });
  if (uploaded.status !== 200) {
    // So that the read and the delete below act on a script that exists.
    await call("login", login(), `b. namespace: upload ${own} for the token to read and delete`, "PUT", inNamespace(own), { form: scriptForm("spike-m6-b marker: original"), keep: () => ({}) });
  }
  await t("b. namespace: replace the script, which exists", "PUT", inNamespace(own), { form: scriptForm(`spike-m6-b marker: replaced-by-${which}`), keep: () => ({}) });
  await t("b. namespace: read the script", "GET", inNamespace(own), { keep: () => ({}) });
  await t("b. namespace: read the script's content", "GET", `${inNamespace(own)}/content`, { keep: (a) => ({ marker: markerIn(a) }) });
  await t("b. namespace: delete the script", "DELETE", `${inNamespace(own)}?force=true`, { keep: () => ({}) });
  const left = await call("login", login(), `b. namespace: is ${own} still there`, "GET", inNamespace(own), { keep: () => ({}) });
  if (left.status === 200) await call("login", login(), `b. namespace: delete ${own}`, "DELETE", `${inNamespace(own)}?force=true`, { keep: () => ({}) });

  // c. The canary: an ordinary Worker on the account, standing in for Podster's own.
  await ensureCanary();
  await t("c. canary: read settings", "GET", `${atAccount(CANARY)}/settings`, { keep: () => ({}) });
  await t("c. canary: read content", "GET", `${atAccount(CANARY)}/content/v2`, { keep: (a) => ({ marker: markerIn(a) }) });
  await t("c. canary: list versions", "GET", `${account}/workers/scripts/${CANARY}/versions`, { keep: () => ({}) });
  await t("c. canary: list cron triggers", "GET", `${atAccount(CANARY)}/schedules`, { keep: () => ({}) });
  await t("c. canary: list secrets", "GET", `${atAccount(CANARY)}/secrets`, { keep: "count" });
  await t("c. canary: list tails", "GET", `${atAccount(CANARY)}/tails`, { keep: () => ({}) });
  await t("c. canary: replace content", "PUT", atAccount(CANARY), { form: scriptForm(`spike-m6-b marker: replaced-by-${which}`), keep: () => ({}) });
  await call("login", login(), "c. canary: which content is it now", "GET", `${atAccount(CANARY)}/content/v2`, { keep: (a) => ({ marker: markerIn(a) }) });
  await t("c. canary: delete", "DELETE", `${atAccount(CANARY)}?force=true`, { keep: () => ({}) });
  await call("login", login(), "c. canary: is it still there", "GET", `${atAccount(CANARY)}/settings`, { keep: () => ({}) });

  // d. A new ordinary Worker on the account.
  await t("d. account: create a new Worker", "PUT", atAccount(fresh), { form: scriptForm(`spike-m6-b marker: by-${which}`), keep: () => ({}) });
  const made = await call("login", login(), `d. account: is ${fresh} there`, "GET", `${atAccount(fresh)}/settings`, { keep: () => ({}) });
  if (made.status === 200) await call("login", login(), `d. account: is workers.dev on for ${fresh}`, "GET", `${atAccount(fresh)}/subdomain`, { keep: (a) => ({ enabled: a.body?.result?.enabled ?? null }) });
  await t("d. account: delete the new Worker", "DELETE", `${atAccount(fresh)}?force=true`, { keep: () => ({}) });
  const still = await call("login", login(), `d. account: is ${fresh} still there`, "GET", `${atAccount(fresh)}/settings`, { keep: () => ({}) });
  if (still.status === 200) await call("login", login(), `d. account: delete ${fresh}`, "DELETE", `${atAccount(fresh)}?force=true`, { keep: () => ({}) });

  // e. What else it can read. GET only. Where the answer would be Podster's data, the status and codes alone are kept.
  await t("e. list the account's Workers", "GET", `${account}/workers/scripts`);
  await t(`e. ${PODSTER_WORKER}: read settings`, "GET", `${atAccount(PODSTER_WORKER)}/settings`);
  await t(`e. ${PODSTER_WORKER}: list secrets' names`, "GET", `${atAccount(PODSTER_WORKER)}/secrets`);
  await t(`e. ${PODSTER_WORKER}: read content`, "GET", `${atAccount(PODSTER_WORKER)}/content/v2`);
  await t("e. list zones", "GET", "/zones", { keep: "count" });
  for (const name of ZONES) {
    const id = zoneIds.get(name);
    if (!id) {
      record({ token: which, op: `e. ${name}: not tried, the zone's ID wasn't found` });
      continue;
    }
    await t(`e. ${name}: list Workers routes`, "GET", `/zones/${id}/workers/routes`);
    await t(`e. ${name}: list DNS records`, "GET", `/zones/${id}/dns_records`);
    await t(`e. ${name}: list custom hostnames`, "GET", `/zones/${id}/custom_hostnames`);
  }
  await t("e. list D1 databases", "GET", `${account}/d1/database`);
  await t("e. list KV namespaces", "GET", `${account}/storage/kv/namespaces`);
  await t("e. list queues", "GET", `${account}/queues`);
  await t("e. list R2 buckets", "GET", `${account}/r2/buckets`);
  await t("e. list Durable Object namespaces", "GET", `${account}/workers/durable_objects/namespaces`);
  await t("e. read the workers.dev subdomain", "GET", `${account}/workers/subdomain`);
  await t("e. list dispatch namespaces", "GET", `${account}/workers/dispatch/namespaces`, { keep: "count" });
  await t("e. list Workers custom domains", "GET", `${account}/workers/domains`);
  await t("e. list Pages projects", "GET", `${account}/pages/projects`);
  await t("e. list Hyperdrive configurations", "GET", `${account}/hyperdrive/configs`);
  await t("e. list Secrets Store stores", "GET", `${account}/secrets_store/stores`);
  await t("e. read the account", "GET", account);
  await t("e. list the account's members", "GET", `${account}/members`);
  await t("e. list the user's API tokens", "GET", "/user/tokens");
  await t("e. list the account's API tokens", "GET", `${account}/tokens`);
}

// ---- clean-up, with wrangler's login ----

async function cleanup() {
  const listed = async (label, path) => {
    const answer = await send(login(), "GET", path);
    const names = (answer.body?.result ?? []).map((s) => s.id ?? s.script?.id ?? s.script_name ?? s.name).filter((n) => typeof n === "string");
    return { status: answer.status, names };
  };
  const scriptsPath = `${account}/workers/dispatch/namespaces/${NAMESPACE}/scripts`;
  for (const [where, list, path] of [
    ["namespace", scriptsPath, inNamespace],
    ["account", `${account}/workers/scripts`, atAccount],
  ]) {
    const before = await listed(where, list);
    for (const name of before.names.filter(allowedName)) {
      await call("login", login(), `clean-up: delete ${name} (${where})`, "DELETE", `${path(name)}?force=true`, { keep: () => ({}) });
    }
  }
  const namespace = await send(login(), "GET", `${account}/workers/dispatch/namespaces/${NAMESPACE}`);
  const inside = await listed("namespace", scriptsPath);
  const workers = await listed("account", `${account}/workers/scripts`);
  record({
    op: "clean-up: confirmed by listing",
    namespace: NAMESPACE,
    namespace_status: namespace.status,
    script_count: namespace.body?.result?.script_count ?? null,
    namespace_list_status: inside.status,
    namespace_list_length: inside.names.length,
    account_list_status: workers.status,
    account_workers: workers.names.length,
    account_workers_named_spike_m6: workers.names.filter((n) => n.startsWith("spike-m6")).length,
    account_workers_not_named_podster: workers.names.filter((n) => !n.startsWith("podster-")).length,
  });
}

const commands = {
  /** Everything, for the three tokens in turn, the control first. `run edit` runs one. */
  async run(only) {
    const { tokens, narrowName } = readTokens();
    record({ op: "start", narrow_permission_as_the_owner_typed_it: narrowName, tokens: Object.keys(tokens) });
    await findZones();
    for (const which of Object.keys(WHICH)) if (!only || only === which) await runToken(which, tokens[which]);
    await cleanup();
  },
  cleanup,
};

const [command, ...rest] = process.argv.slice(2);
if (!commands[command]) {
  console.error(`usage: node spike.mjs <${Object.keys(commands).join("|")}>`);
  process.exit(2);
}
await commands[command](...rest);
