// A stand-in for the provider that serves rooms' apps (M6 step 4(a), ADR 0010). It runs in the test runner, as the
// Workers' outbound service, so no test or CI run ever reaches Cloudflare's API.
//
// **Scripts answer exactly as spike A recorded** (spikes/m6-namespace-app/README.md, and spike B for the delete's
// path): reading a script that was deleted, or never existed, answers 200 with `"script": null` beside the
// namespace's own fields; an existing one comes back as an object there; deleting one that is there answers 200; and
// deleting it again answers 404 with code 10007.
//
// **Serve entries are an assumption, not a record.** No spike has run the KV REST calls. This stand-in answers the
// way `src/content_provider.rs` expects: a write and a delete answer 200 with `"success": true`, a read answers 200
// with the value, and a read of a missing key answers 404 with code 10009. Spike G must confirm those before a
// provider is configured.
//
// **The two lists are for the reconciles** (third PR). The scripts' list answers as spike A saw it: one array, each
// script an object with `id`, and a `has_assets` that is wrong on purpose, as it was. **The keys' list is an
// assumption,** from Cloudflare's documented KV list: `result` an array of `{ name }`, and `result_info.cursor` for
// the next page, empty at the end. A test can make the scripts' list claim there is more than it holds.
//
// A test scripts how it misbehaves through `content-fake.example.com`, and reads back what it holds and every call it
// saw. Calls are recorded by kind and name, never with a token.

/** Test values only. No real account, namespace or token has this form's values. */
export const FAKE_CONTENT = {
  account: "c0".repeat(16),
  namespace: "podster-test-apps",
  kvNamespace: "d1".repeat(16),
  domain: "apps-test.example",
  scriptsToken: "test-scripts-token-0000000000",
  routingToken: "test-routing-token-0000000000",
};

type Op = "script.get" | "script.delete" | "script.list" | "entry.put" | "entry.get" | "entry.delete" | "entry.list";
/**
 * How one kind of call misbehaves, for its next `times` calls. `lost` does the work and then answers nothing useful;
 * `stale` answers a read with the opposite of what is held; `delayMs` alone answers properly, late, so a test can
 * change the room while the call is out.
 */
type Fault = { op: Op; times: number; status?: number; lost?: boolean; stale?: boolean; delayMs?: number };

let scripts = new Set<string>();
let entries = new Map<string, string>();
let calls: { op: Op; name: string; status: number }[] = [];
let faults: Fault[] = [];
/** When set, the scripts' list says there are this many more scripts than it holds. */
let scriptsUnlisted = 0;
/** When set, the keys' list answers with no `result_info` at all. */
let keysNoInfo = false;
/**
 * A gate holds the next call of one kind until the test lets it go, and tells the test when that call has arrived. So
 * a test can change the room while a call is out, at exactly that point, with no clock involved.
 */
type Gate = { op: Op; taken: boolean; expired: boolean; arrived: Promise<void>; markArrived: () => void; released: Promise<void>; release: () => void };
let gates: Gate[] = [];
/** Well under the provider module's call limit, `CALL_TIMEOUT_MS`, which a test pins against this. */
export const GATE_LIMIT_MS = 2000;
function newGate(op: Op): Gate {
  let markArrived = () => {};
  let release = () => {};
  const arrived = new Promise<void>((resolve) => { markArrived = resolve; });
  const released = new Promise<void>((resolve) => { release = resolve; });
  return { op, taken: false, expired: false, arrived, markArrived, released, release };
}
async function passGate(op: Op) {
  const gate = gates.find((g) => g.op === op && !g.taken);
  if (!gate) return;
  gate.taken = true;
  gate.markArrived();
  // A gate never holds a call as long as the caller's own 5-second limit: a test that forgot to let one go gets the
  // call answered after 2 seconds, and the gate is marked, so the test can see it happened and fail on it.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<void>((resolve) => { timer = setTimeout(() => { gate.expired = true; resolve(); }, GATE_LIMIT_MS); });
  await Promise.race([gate.released, expiry]);
  clearTimeout(timer);
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const envelope = (result: unknown) => ({ success: true, errors: [], messages: [], result });
const failure = (status: number, code: number, message: string) => json({ success: false, errors: [{ code, message }], messages: [], result: null }, status);

async function takeFault(op: Op) {
  const fault = faults.find((f) => f.op === op && f.times > 0);
  if (!fault) return undefined;
  fault.times -= 1;
  if (fault.delayMs) await new Promise((resolve) => setTimeout(resolve, fault.delayMs));
  // A delay alone isn't a failure: the call is then answered as it would have been.
  return fault.lost || fault.stale || fault.status ? fault : undefined;
}

// ---------------------------------------------------------------------------------------------------------------------
// The upload of a release's files (M6 step 5), exactly as spike A recorded wrangler's three calls
// (spikes/m6-namespace-app/README.md, "The upload's calls"): the session with its manifest, the files a bucket at a
// time as base64 parts named by hash, and the script written from the completion token.
//
// **Everything here is kept by script name, apart from the scripts and entries above, and `/reset` doesn't touch
// it.** Spec files run at the same time against this one stand-in: `takedown.spec.ts` resets it and reads its whole
// state, and an upload's test must neither lose its session to that reset nor show up in that state. So a script
// written here is not in the set a read, a delete or the list above sees. Each test uploads under a name of its own.
//
// **What it answers on an error is an assumption:** no spike saw one. A fault is one thing the provider, or something
// in its place, could answer.
// ---------------------------------------------------------------------------------------------------------------------
type UploadOp = "session" | "bucket" | "script";
type UploadFault = {
  op: UploadOp; times: number;
  /** A status with the provider's error envelope. */
  status?: number;
  /** The call is answered properly, this much later: a session after it has decided what it wants, the script's write before it is done. So a test can run a second attempt while the first is out. */
  delayMs?: number;
  /** The work is done and the answer is lost: a `502`. */
  lost?: boolean;
  /** One way the answer isn't what it must be, the status staying a success. */
  shape?: "not_success" | "no_token" | "unknown_hash" | "hash_twice" | "empty_bucket" | "html" | "done_early" | "never_done" | "other_id" | "refused_but_success";
};
type Manifest = Record<string, { hash: string; size: number }>;
type Upload = {
  /** The files held under this script's name, by hash: the provider remembers them for the script. */
  held: Map<string, { type: string; base64: string }>;
  calls: { op: UploadOp; status: number; hashes?: string[]; manifest?: Manifest; query?: string; parts?: string[]; bytes?: number }[];
  faults: UploadFault[];
  /** The script as last written: every path with what is served there, and the metadata it was written with. */
  written?: { files: Record<string, { hash: string; size: number; type: string; base64: string }>; metadata: unknown; metadataText: string; times: number };
  /** Hashes asked for in one bucket. */
  bucketSize: number;
  /** Statements a test wants run when the first bucket arrives: `{ room, statement }` is read by the test, not run here. */
};
const uploads = new Map<string, Upload>();
const upload = (script: string) => {
  let found = uploads.get(script);
  if (!found) { found = { held: new Map(), calls: [], faults: [], bucketSize: 2 }; uploads.set(script, found); }
  return found;
};
const sessions = new Map<string, { script: string; manifest: Manifest; needed: string[]; got: Set<string>; bucketsSent: number; buckets: number }>();
const completions = new Map<string, { script: string; manifest: Manifest }>();
let uploadTokens = 0;
function takeUploadFault(script: string, op: UploadOp) {
  const fault = upload(script).faults.find((f) => f.op === op && f.times > 0);
  if (fault) fault.times -= 1;
  return fault;
}
const html = () => new Response("<!doctype html><title>Sign in</title>", { status: 200, headers: { "content-type": "text/html" } });

async function fakeUpload(request: Request, url: URL): Promise<Response | null> {
  const bearer = request.headers.get("authorization");
  const session = url.pathname.match(new RegExp(`^/client/v4/accounts/${FAKE_CONTENT.account}/workers/dispatch/namespaces/${FAKE_CONTENT.namespace}/scripts/([^/]+)/assets-upload-session$`));
  if (session && request.method === "POST") {
    const script = decodeURIComponent(session[1]);
    const held = upload(script);
    const done = (status: number, response: Response, manifest?: Manifest) => { held.calls.push({ op: "session", status, manifest }); return response; };
    if (bearer !== `Bearer ${FAKE_CONTENT.scriptsToken}`) return done(403, failure(403, 10000, "Authentication error"));
    if (request.headers.get("content-type") !== "application/json") return done(415, failure(415, 10415, "the session takes JSON"));
    const manifest = ((await request.json()) as { manifest: Manifest }).manifest;
    const fault = takeUploadFault(script, "session");
    if (fault?.status) return done(fault.status, failure(fault.status, 10001, "SECRET-PROVIDER-TEXT"), manifest);
    if (fault?.shape === "html") return done(200, html(), manifest);
    if (fault?.shape === "not_success") return done(200, json({ success: false, errors: [], messages: [], result: { jwt: "cfwau_x", buckets: [] } }), manifest);
    const needed = [...new Set(Object.values(manifest).map((file) => file.hash))].filter((hash) => !held.held.has(hash));
    let buckets: string[][] = [];
    for (let i = 0; i < needed.length; i += held.bucketSize) buckets.push(needed.slice(i, i + held.bucketSize));
    const n = ++uploadTokens;
    const completion = `cfwau_test-completion-${n}.${"c".repeat(40)}`;
    completions.set(completion, { script, manifest });
    // With nothing to send, the session's token is already the completion token, as spike A saw.
    const token = needed.length === 0 ? completion : `cfwau_test-session-${n}.${"s".repeat(40)}`;
    if (needed.length > 0) sessions.set(token, { script, manifest, needed, got: new Set(), bucketsSent: 0, buckets: buckets.length });
    if (fault?.shape === "unknown_hash") buckets = [["f".repeat(32)], ...buckets];
    if (fault?.shape === "hash_twice" && buckets[0]) buckets = [...buckets, [buckets[0][0]]];
    if (fault?.shape === "empty_bucket") buckets = [...buckets, []];
    if (fault?.delayMs) await new Promise((resolve) => setTimeout(resolve, fault.delayMs));
    return done(200, json({ success: true, errors: null, messages: null, result: fault?.shape === "no_token" ? { buckets } : { jwt: token, buckets } }), manifest);
  }
  if (url.pathname === `/client/v4/accounts/${FAKE_CONTENT.account}/workers/assets/upload` && request.method === "POST") {
    // The session's own token, and no other: neither of the provider's two tokens sends a file.
    const open = sessions.get(bearer?.replace(/^Bearer /, "") ?? "");
    if (!open) return failure(403, 10000, "Authentication error");
    const held = upload(open.script);
    const parts = [...(await request.formData()).entries()];
    const hashes = parts.map(([name]) => name);
    // The files' own bytes in this one request, as the base64 decodes: what the sender held to send it.
    let bytes = 0;
    for (const [, value] of parts) if (typeof value !== "string") bytes += Buffer.from(await value.text(), "base64").length;
    const done = (status: number, response: Response) => { held.calls.push({ op: "bucket", status, hashes, query: url.search, bytes }); return response; };
    if (url.searchParams.get("base64") !== "true") return done(400, failure(400, 10400, "base64 is required"));
    const fault = takeUploadFault(open.script, "bucket");
    if (fault?.status) return done(fault.status, failure(fault.status, 10001, "SECRET-PROVIDER-TEXT"));
    for (const [name, value] of parts) {
      if (!open.needed.includes(name) || typeof value === "string") return done(400, failure(400, 10400, "a part the session didn't ask for"));
      held.held.set(name, { type: value.type, base64: await value.text() });
      open.got.add(name);
    }
    open.bucketsSent += 1;
    if (fault?.lost) return done(502, failure(502, 10001, "the answer was lost"));
    if (fault?.shape === "html") return done(200, html());
    const all = open.needed.every((hash) => open.got.has(hash));
    const completion = [...completions.entries()].find(([, to]) => to.script === open.script && to.manifest === open.manifest)?.[0];
    const finished = (fault?.shape === "done_early" || all) && fault?.shape !== "never_done";
    if (finished) return done(201, json({ success: true, errors: null, messages: null, result: { jwt: completion } }, 201));
    return done(202, json({ success: true, errors: null, messages: null, result: {} }, 202));
  }
  const script = url.pathname.match(new RegExp(`^/client/v4/accounts/${FAKE_CONTENT.account}/workers/dispatch/namespaces/${FAKE_CONTENT.namespace}/scripts/([^/]+)$`));
  if (script && request.method === "PUT") {
    const name = decodeURIComponent(script[1]);
    const held = upload(name);
    const form = await request.formData();
    const parts = [...form.keys()];
    const done = (status: number, response: Response) => { held.calls.push({ op: "script", status, query: url.search, parts }); return response; };
    if (bearer !== `Bearer ${FAKE_CONTENT.scriptsToken}`) return done(403, failure(403, 10000, "Authentication error"));
    const fault = takeUploadFault(name, "script");
    if (fault?.delayMs) await new Promise((resolve) => setTimeout(resolve, fault.delayMs));
    if (fault?.status) return done(fault.status, failure(fault.status, 10001, "SECRET-PROVIDER-TEXT"));
    const part = form.get("metadata");
    const metadataText = typeof part === "string" ? part : await part!.text();
    const metadata = JSON.parse(metadataText);
    const complete = completions.get(metadata?.assets?.jwt);
    // Only a completion token for this very script, with every file its manifest names held.
    if (!complete || complete.script !== name || !Object.values(complete.manifest).every((file) => held.held.has(file.hash))) return done(400, failure(400, 10400, "the token doesn't complete this script"));
    const files: Record<string, { hash: string; size: number; type: string; base64: string }> = {};
    for (const [path, file] of Object.entries(complete.manifest)) files[path] = { ...file, ...held.held.get(file.hash)! };
    held.written = { files, metadata, metadataText, times: (held.written?.times ?? 0) + 1 };
    if (fault?.lost) return done(502, failure(502, 10001, "the answer was lost"));
    if (fault?.shape === "html") return done(200, html());
    if (fault?.shape === "not_success") return done(200, json({ success: false, errors: [], messages: [], result: { id: name } }));
    // A refusal by its status, in a body that reads as a success: only the status says it wasn't taken.
    if (fault?.shape === "refused_but_success") return done(500, json(envelope({ id: name }), 500));
    return done(200, json(envelope({ id: fault?.shape === "other_id" ? `${name}x` : name, tag: "tag-test", has_assets: true, has_modules: false, handlers: ["fetch"] })));
  }
  return null;
}

export async function fakeContent(request: Request): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.hostname === "content-fake.example.com" && url.pathname.startsWith("/upload-")) {
    const name = url.searchParams.get("script") ?? "";
    if (url.pathname === "/upload-fault") { upload(name).faults.push((await request.json()) as UploadFault); return json({ ok: true }); }
    if (url.pathname === "/upload-bucket-size") { upload(name).bucketSize = Number(url.searchParams.get("size")); return json({ ok: true }); }
    if (url.pathname === "/upload-state") {
      const held = upload(name);
      return json({ calls: held.calls, held: [...held.held.keys()].sort(), written: held.written ?? null });
    }
    return json({ error: "unknown" }, 404);
  }
  if (url.hostname === "api.cloudflare.com") {
    const uploaded = await fakeUpload(request, url);
    if (uploaded) return uploaded;
  }
  if (url.hostname === "content-fake.example.com") {
    if (url.pathname === "/reset") {
      scripts = new Set();
      entries = new Map();
      calls = [];
      faults = [];
      scriptsUnlisted = 0;
      keysNoInfo = false;
      for (const gate of gates) gate.release();
      gates = [];
      return json({ ok: true });
    }
    if (url.pathname === "/seed") {
      const body = (await request.json()) as { scripts?: string[]; entries?: Record<string, string>; scriptsUnlisted?: number; keysNoInfo?: boolean };
      if (body.keysNoInfo !== undefined) keysNoInfo = body.keysNoInfo;
      if (body.scriptsUnlisted !== undefined) scriptsUnlisted = body.scriptsUnlisted;
      for (const name of body.scripts ?? []) scripts.add(name);
      for (const [host, value] of Object.entries(body.entries ?? {})) entries.set(host, value);
      return json({ ok: true });
    }
    if (url.pathname === "/fault") {
      faults.push((await request.json()) as Fault);
      return json({ ok: true });
    }
    if (url.pathname === "/gate") {
      gates.push(newGate(((await request.json()) as { op: Op }).op));
      return json({ id: gates.length - 1 });
    }
    const gate = gates[Number(url.searchParams.get("id") ?? -1)];
    if (url.pathname === "/arrived" && gate) {
      await gate.arrived;
      return json({ ok: true });
    }
    if (url.pathname === "/release" && gate) {
      gate.release();
      return json({ ok: true });
    }
    if (url.pathname === "/state") return json({ scripts: [...scripts].sort(), entries: Object.fromEntries([...entries].sort()), calls, expiredGates: gates.filter((gate) => gate.expired).length });
    return json({ error: "unknown" }, 404);
  }
  if (url.hostname !== "api.cloudflare.com") return null;

  const bearer = request.headers.get("authorization");
  const script = url.pathname.match(new RegExp(`^/client/v4/accounts/${FAKE_CONTENT.account}/workers/dispatch/namespaces/${FAKE_CONTENT.namespace}/scripts/([^/]+)$`));
  const entry = url.pathname.match(new RegExp(`^/client/v4/accounts/${FAKE_CONTENT.account}/storage/kv/namespaces/${FAKE_CONTENT.kvNamespace}/values/([^/]+)$`));
  const answer = (op: Op, name: string, response: Response) => {
    calls.push({ op, name, status: response.status });
    return response;
  };

  // The two lists. Each takes its own token only, as the calls on one script and one entry do.
  if (url.pathname === `/client/v4/accounts/${FAKE_CONTENT.account}/workers/dispatch/namespaces/${FAKE_CONTENT.namespace}/scripts` && request.method === "GET") {
    if (bearer !== `Bearer ${FAKE_CONTENT.scriptsToken}`) return answer("script.list", "", failure(403, 10000, "Authentication error"));
    await passGate("script.list");
    const fault = await takeFault("script.list");
    if (fault) return answer("script.list", "", failure(fault.status ?? 500, 10001, "fault"));
    const listed = [...scripts].sort().map((id) => ({ id, tag: "tag-test", has_assets: false, deployment_id: "" }));
    return answer("script.list", "", json(scriptsUnlisted ? { ...envelope(listed), result_info: { count: listed.length, total_count: listed.length + scriptsUnlisted } } : envelope(listed)));
  }
  if (url.pathname === `/client/v4/accounts/${FAKE_CONTENT.account}/storage/kv/namespaces/${FAKE_CONTENT.kvNamespace}/keys` && request.method === "GET") {
    if (bearer !== `Bearer ${FAKE_CONTENT.routingToken}`) return answer("entry.list", "", failure(403, 10000, "Authentication error"));
    await passGate("entry.list");
    const fault = await takeFault("entry.list");
    if (fault) return answer("entry.list", "", failure(fault.status ?? 500, 10001, "fault"));
    const limit = Number(url.searchParams.get("limit") ?? 1000);
    const cursor = url.searchParams.get("cursor");
    // The cursor is the last key of the page before, behind a prefix, so it is opaque enough to need escaping.
    if (cursor !== null && !cursor.startsWith("after:")) return answer("entry.list", cursor, failure(400, 10029, "invalid cursor"));
    const rest = [...entries.keys()].sort().filter((key) => cursor === null || key > cursor.slice("after:".length));
    const page = rest.slice(0, limit);
    if (keysNoInfo) return answer("entry.list", cursor ?? "", json(envelope(page.map((name) => ({ name })))));
    return answer("entry.list", cursor ?? "", json({ ...envelope(page.map((name) => ({ name }))), result_info: { count: page.length, cursor: rest.length > page.length ? `after:${page[page.length - 1]}` : "" } }));
  }

  if (script) {
    const name = decodeURIComponent(script[1]);
    const op: Op | null = request.method === "GET" ? "script.get" : request.method === "DELETE" ? "script.delete" : null;
    if (!op) return failure(405, 10405, "Method not allowed");
    // The scripts token only: the routing token can't touch a script.
    if (bearer !== `Bearer ${FAKE_CONTENT.scriptsToken}`) return answer(op, name, failure(403, 10000, "Authentication error"));
    await passGate(op);
    const fault = await takeFault(op);
    if (fault && !fault.lost) return answer(op, name, failure(fault.status ?? 500, 10001, "fault"));
    if (op === "script.get") {
      const body = envelope({ namespace_id: "ns-test", namespace_name: FAKE_CONTENT.namespace, script: scripts.has(name) ? { id: name, tag: "tag-test" } : null });
      return answer(op, name, json(body));
    }
    if (url.searchParams.get("force") !== "true") return answer(op, name, failure(400, 10400, "force is required"));
    const was = scripts.delete(name);
    if (fault?.lost) return answer(op, name, failure(fault.status ?? 502, 10001, "the answer was lost"));
    return answer(op, name, was ? json(envelope(null)) : failure(404, 10007, "This Worker does not exist on your account."));
  }

  if (entry) {
    const host = decodeURIComponent(entry[1]);
    const op: Op | null = request.method === "PUT" ? "entry.put" : request.method === "GET" ? "entry.get" : request.method === "DELETE" ? "entry.delete" : null;
    if (!op) return failure(405, 10405, "Method not allowed");
    // The routing token only: the scripts token can't write what a host serves.
    if (bearer !== `Bearer ${FAKE_CONTENT.routingToken}`) return answer(op, host, failure(403, 10000, "Authentication error"));
    await passGate(op);
    const fault = await takeFault(op);
    if (fault && !fault.lost && !fault.stale) return answer(op, host, failure(fault.status ?? 500, 10001, "fault"));
    if (op === "entry.put") {
      entries.set(host, await request.text());
      if (fault?.lost) return answer(op, host, failure(fault.status ?? 502, 10001, "the answer was lost"));
      return answer(op, host, json(envelope({})));
    }
    if (op === "entry.delete") {
      entries.delete(host);
      if (fault?.lost) return answer(op, host, failure(fault.status ?? 502, 10001, "the answer was lost"));
      return answer(op, host, json(envelope({})));
    }
    // A stale read: whatever the key held is answered as missing, or the other way round, as a cache that lags would.
    const value = entries.get(host);
    if (fault?.stale) return answer(op, host, value === undefined ? new Response("stale.rel_" + "0".repeat(32), { status: 200 }) : failure(404, 10009, "key not found"));
    return answer(op, host, value === undefined ? failure(404, 10009, "key not found") : new Response(value, { status: 200 }));
  }
  // Any other path on the provider's API: a wrong account, a wrong namespace, or a call nothing should make.
  calls.push({ op: "script.get", name: `unexpected ${request.method} ${url.pathname.replace(/[0-9a-f]{32}/g, "<id>")}`, status: 404 });
  return failure(404, 7003, "No route for the URI");
}
