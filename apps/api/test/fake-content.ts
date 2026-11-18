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
// **A script's bindings** (rule 3(b), S5 of the store plan) answer at `…/scripts/<name>/bindings`, with the scripts
// token only, as the store spike read them: `result` an array of bindings, `[]` for a script nothing was seeded for,
// and `404` with code 10007 for a script that isn't there. The spike kept only each entry's `type` and `name`; the
// rest of an entry (a D1 binding's `id`, a KV binding's `namespace_id`, a Durable Object's `class_name`) is the
// upload metadata's shape, assumed. A test seeds a script's list as it wants it read, malformed included.
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

/**
 * One partition of the stand-in for each spec file that must never meet another's state (the plan's owed per-file
 * isolation): its own dispatch namespace, its own serve entries' KV namespace and its own control host. A call is held
 * to the partition its path's namespace names, and `vitest.config.ts` gives each such spec file a test project of its
 * own that binds only its partition's namespaces. Every other spec file shares the default partition, as before. The
 * account, the tokens and the domain are the same for all, so nothing else in a build differs.
 *
 * What stays shared: the upload part and the app hosts below, which were already kept by script and by host.
 */
export const CONTENT_PARTITIONS = {
  default: { namespace: FAKE_CONTENT.namespace, kvNamespace: FAKE_CONTENT.kvNamespace, control: "content-fake.example.com" },
  "serve-entry": { namespace: "podster-test-apps-serve-entry", kvNamespace: "d2".repeat(16), control: "serve-entry.content-fake.example.com" },
  "custom-routing": { namespace: "podster-test-apps-custom-routing", kvNamespace: "d3".repeat(16), control: "custom-routing.content-fake.example.com" },
  "custom-marker": { namespace: "podster-test-apps-custom-marker", kvNamespace: "d4".repeat(16), control: "custom-marker.content-fake.example.com" },
} as const;
export type ContentPartition = keyof typeof CONTENT_PARTITIONS;

type Op = "script.get" | "script.delete" | "script.list" | "script.bindings" | "entry.put" | "entry.get" | "entry.delete" | "entry.list";
/**
 * How one kind of call misbehaves, for its next `times` calls. `lost` does the work and then answers nothing useful;
 * `stale` answers a read with the opposite of what is held. **There is no scripted delay:** a test that wants a call
 * held while it changes the room sets a gate and lets it go, so nothing here waits on the clock.
 */
type Fault = { op: Op; times: number; status?: number; lost?: boolean; stale?: boolean; flip?: boolean };

/**
 * A gate holds the next call of one kind until the test lets it go, and tells the test when that call has arrived. So
 * a test can change the room while a call is out, at exactly that point, with no clock involved.
 */
type Gate = { op: Op | UploadOp | "marker"; taken: boolean; expired: boolean; arrived: Promise<void>; markArrived: () => void; released: Promise<void>; release: () => void };
/** Everything a partition holds: what a reset clears, a state read reads, and the lists answer from. */
type State = {
  scripts: Set<string>;
  /** What a script's bindings read answers as its `result`, by script; anything a test seeds, as it is. */
  bindings: Map<string, unknown>;
  entries: Map<string, string>;
  calls: { op: Op; name: string; status: number }[];
  faults: Fault[];
  /** When set, the scripts' list says there are this many more scripts than it holds. */
  scriptsUnlisted: number;
  /** When set, the keys' list answers with no `result_info` at all. */
  keysNoInfo: boolean;
  gates: Gate[];
};
const empty = (): State => ({ scripts: new Set(), bindings: new Map(), entries: new Map(), calls: [], faults: [], scriptsUnlisted: 0, keysNoInfo: false, gates: [] });
const states = new Map<string, State>(Object.keys(CONTENT_PARTITIONS).map((name) => [name, empty()]));
const stateOf = (name: string) => states.get(name)!;
const partitionNamed = (field: "namespace" | "kvNamespace" | "control", value: string) =>
  Object.entries(CONTENT_PARTITIONS).find(([, p]) => p[field] === value)?.[0];
/** Well under the provider module's call limit, `CALL_TIMEOUT_MS`, which a test pins against this. */
export const GATE_LIMIT_MS = 2000;
function newGate(op: Op | UploadOp | "marker"): Gate {
  let markArrived = () => {};
  let release = () => {};
  const arrived = new Promise<void>((resolve) => { markArrived = resolve; });
  const released = new Promise<void>((resolve) => { release = resolve; });
  return { op, taken: false, expired: false, arrived, markArrived, released, release };
}
/** `held` is where the gate is kept: a partition's list, which its `/reset` clears, or one upload's or host's own. */
async function passGate(op: Op | UploadOp | "marker", held: Gate[]) {
  const gate = held.find((g) => g.op === op && !g.taken);
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

function takeFault(faults: Fault[], op: Op) {
  const fault = faults.find((f) => f.op === op && f.times > 0);
  if (!fault) return undefined;
  fault.times -= 1;
  // A fault that says none of these isn't one: the call is answered as it would have been.
  return fault.lost || fault.stale || fault.flip || fault.status ? fault : undefined;
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
//
// **A read of a script this part knows** (`read`, a `GET` of the script by name, as the release job's settling makes
// it) answers from this part, as spike A recorded a read: the script as an object once it is written, `"script": null`
// before. It has faults and gates of its own, by script. Every other script's read is the scripts' part's below.
// ---------------------------------------------------------------------------------------------------------------------
type UploadOp = "session" | "bucket" | "script" | "read";
type UploadFault = {
  op: UploadOp; times: number;
  /** A status with the provider's error envelope. */
  status?: number;
  /** The work is done and the answer is lost: a `502`. */
  lost?: boolean;
  /** One way the answer isn't what it must be, the status staying a success. */
  shape?: "not_success" | "no_token" | "unknown_hash" | "hash_twice" | "empty_bucket" | "html" | "done_early" | "never_done" | "other_id" | "no_id" | "refused_but_success";
};
type Manifest = Record<string, { hash: string; size: number }>;
type Upload = {
  /** The files held under this script's name, by hash: the provider remembers them for the script. */
  held: Map<string, { type: string; base64: string }>;
  calls: { op: UploadOp; status: number; hashes?: string[]; manifest?: Manifest; query?: string; parts?: string[]; bytes?: number }[];
  faults: UploadFault[];
  /**
   * Gates on this script's calls, kept here rather than with the gates above so `/reset` never lets one go: a held
   * session is answered once it has decided what it wants, a held script's write before it is done. So a test can run
   * a second attempt, or change the room, while the first is out, at exactly that point.
   */
  gates: Gate[];
  /** The script as last written: every path with what is served there, and the metadata it was written with. */
  written?: {
    files: Record<string, { hash: string; size: number; type: string; base64: string }>; metadata: unknown; metadataText: string;
    /** The script's modules, a release with code's: by part name. Empty for a static release's. */
    modules: Record<string, { filename: string; type: string; text: string }>;
    contentType: string;
    times: number;
  };
  /** Hashes asked for in one bucket. */
  bucketSize: number;
  /** Statements a test wants run when the first bucket arrives: `{ room, statement }` is read by the test, not run here. */
};
const uploads = new Map<string, Upload>();
const upload = (script: string) => {
  let found = uploads.get(script);
  if (!found) { found = { held: new Map(), calls: [], faults: [], gates: [], bucketSize: 2 }; uploads.set(script, found); }
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

/** An upload is this part's only in the calling partition's own namespace; any other is unexpected, below. */
async function fakeUpload(request: Request, url: URL, from: ContentPartition): Promise<Response | null> {
  const bearer = request.headers.get("authorization");
  const own = `(${CONTENT_PARTITIONS[from].namespace})`;
  const session = url.pathname.match(new RegExp(`^/client/v4/accounts/${FAKE_CONTENT.account}/workers/dispatch/namespaces/${own}/scripts/([^/]+)/assets-upload-session$`));
  if (session && request.method === "POST") {
    const script = decodeURIComponent(session[2]);
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
    await passGate("session", held.gates);
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
  const script = url.pathname.match(new RegExp(`^/client/v4/accounts/${FAKE_CONTENT.account}/workers/dispatch/namespaces/${own}/scripts/([^/]+)$`));
  // A script the partition's own set holds is read below, from that set.
  if (script && request.method === "GET" && uploads.has(decodeURIComponent(script[2])) && !stateOf(from).scripts.has(decodeURIComponent(script[2]))) {
    const name = decodeURIComponent(script[2]);
    const held = upload(name);
    const done = (status: number, response: Response) => { held.calls.push({ op: "read", status }); return response; };
    if (bearer !== `Bearer ${FAKE_CONTENT.scriptsToken}`) return done(403, failure(403, 10000, "Authentication error"));
    const fault = takeUploadFault(name, "read");
    await passGate("read", held.gates);
    if (fault?.status) return done(fault.status, failure(fault.status, 10001, "SECRET-PROVIDER-TEXT"));
    if (fault?.shape === "html") return done(200, html());
    // A script object that names another script, or none: never this one.
    if (fault?.shape === "other_id") return done(200, json(envelope({ namespace_id: "ns-test", namespace_name: script[1], script: { id: `${name}x`, tag: "tag-test" } })));
    if (fault?.shape === "no_id") return done(200, json(envelope({ namespace_id: "ns-test", namespace_name: script[1], script: { tag: "tag-test" } })));
    return done(200, json(envelope({ namespace_id: "ns-test", namespace_name: script[1], script: held.written ? { id: name, tag: "tag-test" } : null })));
  }
  if (script && request.method === "PUT") {
    const name = decodeURIComponent(script[2]);
    const held = upload(name);
    const form = await request.formData();
    const parts = [...form.keys()];
    const done = (status: number, response: Response) => { held.calls.push({ op: "script", status, query: url.search, parts }); return response; };
    if (bearer !== `Bearer ${FAKE_CONTENT.scriptsToken}`) return done(403, failure(403, 10000, "Authentication error"));
    const fault = takeUploadFault(name, "script");
    await passGate("script", held.gates);
    if (fault?.status) return done(fault.status, failure(fault.status, 10001, "SECRET-PROVIDER-TEXT"));
    const part = form.get("metadata");
    const metadataText = typeof part === "string" ? part : await part!.text();
    const metadata = JSON.parse(metadataText);
    const complete = completions.get(metadata?.assets?.jwt);
    // Only a completion token for this very script, with every file its manifest names held.
    if (!complete || complete.script !== name || !Object.values(complete.manifest).every((file) => held.held.has(file.hash))) return done(400, failure(400, 10400, "the token doesn't complete this script"));
    // A release's code (S3 of the store plan): every part but the metadata is a module, kept with the name, the file
    // name and the type it came with. An entry module the parts don't hold is refused, as the platform would.
    const modules: Record<string, { filename: string; type: string; text: string }> = {};
    for (const [partName, value] of form.entries()) {
      if (partName === "metadata") continue;
      if (typeof value === "string") return done(400, failure(400, 10021, "a module must be a file part"));
      modules[partName] = { filename: (value as File).name, type: value.type, text: await value.text() };
    }
    if (metadata?.main_module !== undefined && !(metadata.main_module in modules)) return done(400, failure(400, 10021, "no such entry module"));
    const files: Record<string, { hash: string; size: number; type: string; base64: string }> = {};
    for (const [path, file] of Object.entries(complete.manifest)) files[path] = { ...file, ...held.held.get(file.hash)! };
    held.written = { files, metadata, metadataText, modules, contentType: request.headers.get("content-type") ?? "", times: (held.written?.times ?? 0) + 1 };
    if (fault?.lost) return done(502, failure(502, 10001, "the answer was lost"));
    if (fault?.shape === "html") return done(200, html());
    if (fault?.shape === "not_success") return done(200, json({ success: false, errors: [], messages: [], result: { id: name } }));
    // A refusal by its status, in a body that reads as a success: only the status says it wasn't taken.
    if (fault?.shape === "refused_but_success") return done(500, json(envelope({ id: name }), 500));
    return done(200, json(envelope({ id: fault?.shape === "other_id" ? `${name}x` : name, tag: "tag-test", has_assets: true, has_modules: false, handlers: ["fetch"] })));
  }
  return null;
}

// ---------------------------------------------------------------------------------------------------------------------
// An app's own host, as a visitor reaches it, for the release job's marker (M6 step 5, ADR 0010's step 6): only
// `/.well-known/podster-release.json` on `<label>.<domain>`. **Kept by host, apart from `/reset`,** as the upload part
// is by script: each spec file's labels carry its own tag. A host serves what a test said: the marker file of a script
// the upload part holds, as the content Worker would once a serve entry names that script; a body of its own; a status;
// or, said nothing, not-found. Every fetch is counted, and a gate can hold the next one.
// ---------------------------------------------------------------------------------------------------------------------
type MarkerHost = { script?: string; body?: string; status?: number; fetches: number; credentialed: number; gates: Gate[] };
const markerHosts = new Map<string, MarkerHost>();
const markerHost = (host: string) => {
  let found = markerHosts.get(host);
  if (!found) { found = { fetches: 0, credentialed: 0, gates: [] }; markerHosts.set(host, found); }
  return found;
};
const MARKER_FILE = "/.well-known/podster-release.json";

async function fakeAppHost(request: Request, url: URL): Promise<Response> {
  const held = markerHost(url.hostname);
  if (url.pathname !== MARKER_FILE || request.method !== "GET") return new Response("not found", { status: 404 });
  held.fetches += 1;
  if (request.headers.get("authorization") !== null || request.headers.get("cookie") !== null) held.credentialed += 1;
  await passGate("marker", held.gates);
  if (held.status !== undefined) return new Response(held.body ?? "", { status: held.status });
  if (held.body !== undefined) return new Response(held.body, { status: 200, headers: { "content-type": "application/json" } });
  const file = held.script ? uploads.get(held.script)?.written?.files[MARKER_FILE] : undefined;
  if (file) return new Response(Buffer.from(file.base64, "base64"), { status: 200, headers: { "content-type": file.type } });
  return new Response("not found", { status: 404 });
}

/**
 * `from` is the partition whose test project made the call: each project's outbound service says so
 * (`vitest.config.ts`). A provider call is answered only in that partition's own namespaces; any other, or a path or
 * method nothing answers, is told to `from` as unexpected, so a spec that reads its calls sees it.
 */
export async function fakeContent(request: Request, from: ContentPartition = "default"): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.hostname.endsWith(`.${FAKE_CONTENT.domain}`)) return fakeAppHost(request, url);
  // A custom hostname a test said serves a marker (M6 step 8e): as the content Worker would for that host once its
  // entry names a script, which here a test says outright. Only a host a test named, so no other call is taken for one.
  if (url.pathname === MARKER_FILE && markerHosts.has(url.hostname) && !partitionNamed("control", url.hostname)) return fakeAppHost(request, url);
  // The marker and upload parts are kept by host and by script, not by partition, so any control host reaches them.
  const control = partitionNamed("control", url.hostname);
  if (control && url.pathname.startsWith("/marker-")) {
    const held = markerHost(url.searchParams.get("host") ?? "");
    if (url.pathname === "/marker-serve") {
      const body = (await request.json()) as { script?: string; body?: string; status?: number };
      held.script = body.script; held.body = body.body; held.status = body.status;
      return json({ ok: true });
    }
    if (url.pathname === "/marker-state") return json({ fetches: held.fetches, credentialed: held.credentialed, expiredGates: held.gates.filter((gate) => gate.expired).length });
    if (url.pathname === "/marker-gate") { held.gates.push(newGate("marker")); return json({ id: held.gates.length - 1 }); }
    const gate = held.gates[Number(url.searchParams.get("id") ?? -1)];
    if (url.pathname === "/marker-arrived" && gate) { await gate.arrived; return json({ ok: true }); }
    if (url.pathname === "/marker-release" && gate) { gate.release(); return json({ ok: true }); }
    return json({ error: "unknown" }, 404);
  }
  if (control && url.pathname.startsWith("/upload-")) {
    const name = url.searchParams.get("script") ?? "";
    if (url.pathname === "/upload-fault") { upload(name).faults.push((await request.json()) as UploadFault); return json({ ok: true }); }
    if (url.pathname === "/upload-bucket-size") { upload(name).bucketSize = Number(url.searchParams.get("size")); return json({ ok: true }); }
    if (url.pathname === "/upload-state") {
      const held = upload(name);
      return json({ calls: held.calls, held: [...held.held.keys()].sort(), written: held.written ?? null, expiredGates: held.gates.filter((gate) => gate.expired).length });
    }
    if (url.pathname === "/upload-gate") {
      const held = upload(name);
      held.gates.push(newGate(((await request.json()) as { op: UploadOp }).op));
      return json({ id: held.gates.length - 1 });
    }
    const gate = upload(name).gates[Number(url.searchParams.get("id") ?? -1)];
    if (url.pathname === "/upload-arrived" && gate) {
      await gate.arrived;
      return json({ ok: true });
    }
    if (url.pathname === "/upload-release" && gate) {
      gate.release();
      return json({ ok: true });
    }
    return json({ error: "unknown" }, 404);
  }
  if (url.hostname === "api.cloudflare.com") {
    const uploaded = await fakeUpload(request, url, from);
    if (uploaded) return uploaded;
  }
  if (control) {
    const state = stateOf(control);
    if (url.pathname === "/reset") {
      for (const gate of state.gates) gate.release();
      states.set(control, empty());
      return json({ ok: true });
    }
    if (url.pathname === "/seed") {
      const body = (await request.json()) as { scripts?: string[]; entries?: Record<string, string>; scriptsUnlisted?: number; keysNoInfo?: boolean; bindings?: Record<string, unknown> };
      for (const [name, list] of Object.entries(body.bindings ?? {})) state.bindings.set(name, list);
      if (body.keysNoInfo !== undefined) state.keysNoInfo = body.keysNoInfo;
      if (body.scriptsUnlisted !== undefined) state.scriptsUnlisted = body.scriptsUnlisted;
      for (const name of body.scripts ?? []) state.scripts.add(name);
      for (const [host, value] of Object.entries(body.entries ?? {})) state.entries.set(host, value);
      return json({ ok: true });
    }
    if (url.pathname === "/fault") {
      state.faults.push((await request.json()) as Fault);
      return json({ ok: true });
    }
    if (url.pathname === "/gate") {
      state.gates.push(newGate(((await request.json()) as { op: Op }).op));
      return json({ id: state.gates.length - 1 });
    }
    const gate = state.gates[Number(url.searchParams.get("id") ?? -1)];
    if (url.pathname === "/arrived" && gate) {
      await gate.arrived;
      return json({ ok: true });
    }
    if (url.pathname === "/release" && gate) {
      gate.release();
      return json({ ok: true });
    }
    if (url.pathname === "/state") return json({ scripts: [...state.scripts].sort(), entries: Object.fromEntries([...state.entries].sort()), calls: state.calls, expiredGates: state.gates.filter((gate) => gate.expired).length });
    return json({ error: "unknown" }, 404);
  }
  if (url.hostname !== "api.cloudflare.com") return null;

  const bearer = request.headers.get("authorization");
  const account = `/client/v4/accounts/${FAKE_CONTENT.account}`;
  // The partition is the caller's, and only if the path names its own namespace. A path naming another partition's, or
  // none, is unexpected, and told to the caller.
  const scriptsPath = url.pathname.match(new RegExp(`^${account}/workers/dispatch/namespaces/([^/]+)/scripts(?:/([^/]+)(/bindings)?)?$`));
  const keysPath = url.pathname.match(new RegExp(`^${account}/storage/kv/namespaces/([^/]+)/(?:keys|values/([^/]+))$`));
  const { namespace, kvNamespace } = CONTENT_PARTITIONS[from];
  const partition = (scriptsPath?.[1] === namespace || keysPath?.[1] === kvNamespace) ? from : undefined;
  const { scripts, bindings, entries, calls, faults, gates } = stateOf(from);
  const unexpected = (status: number) => calls.push({ op: "script.get", name: `unexpected ${request.method} ${url.pathname.replace(/[0-9a-f]{32}/g, "<id>")}`, status });
  const script = partition && scriptsPath?.[2] !== undefined && !scriptsPath[3] ? scriptsPath : null;
  const entry = partition && keysPath?.[2] !== undefined ? keysPath : null;
  const bound = partition && scriptsPath?.[3] ? scriptsPath : null;
  const answer = (op: Op, name: string, response: Response) => {
    calls.push({ op, name, status: response.status });
    return response;
  };

  // The two lists. Each takes its own token only, as the calls on one script and one entry do.
  if (partition && url.pathname === `${account}/workers/dispatch/namespaces/${namespace}/scripts` && request.method === "GET") {
    if (bearer !== `Bearer ${FAKE_CONTENT.scriptsToken}`) return answer("script.list", "", failure(403, 10000, "Authentication error"));
    await passGate("script.list", gates);
    const fault = takeFault(faults, "script.list");
    if (fault) return answer("script.list", "", failure(fault.status ?? 500, 10001, "fault"));
    const listed = [...scripts].sort().map((id) => ({ id, tag: "tag-test", has_assets: false, deployment_id: "" }));
    const { scriptsUnlisted } = stateOf(partition);
    return answer("script.list", "", json(scriptsUnlisted ? { ...envelope(listed), result_info: { count: listed.length, total_count: listed.length + scriptsUnlisted } } : envelope(listed)));
  }
  if (partition && url.pathname === `${account}/storage/kv/namespaces/${kvNamespace}/keys` && request.method === "GET") {
    if (bearer !== `Bearer ${FAKE_CONTENT.routingToken}`) return answer("entry.list", "", failure(403, 10000, "Authentication error"));
    await passGate("entry.list", gates);
    const fault = takeFault(faults, "entry.list");
    if (fault) return answer("entry.list", "", failure(fault.status ?? 500, 10001, "fault"));
    const limit = Number(url.searchParams.get("limit") ?? 1000);
    const cursor = url.searchParams.get("cursor");
    // The cursor is the last key of the page before, behind a prefix, so it is opaque enough to need escaping.
    if (cursor !== null && !cursor.startsWith("after:")) return answer("entry.list", cursor, failure(400, 10029, "invalid cursor"));
    const rest = [...entries.keys()].sort().filter((key) => cursor === null || key > cursor.slice("after:".length));
    const page = rest.slice(0, limit);
    if (stateOf(partition).keysNoInfo) return answer("entry.list", cursor ?? "", json(envelope(page.map((name) => ({ name })))));
    return answer("entry.list", cursor ?? "", json({ ...envelope(page.map((name) => ({ name }))), result_info: { count: page.length, cursor: rest.length > page.length ? `after:${page[page.length - 1]}` : "" } }));
  }

  if (bound && request.method === "GET") {
    const name = decodeURIComponent(bound[2]);
    // The scripts token only, as every call on a script.
    if (bearer !== `Bearer ${FAKE_CONTENT.scriptsToken}`) return answer("script.bindings", name, failure(403, 10000, "Authentication error"));
    await passGate("script.bindings", gates);
    // A status fault only, taken with no delay: this read has no use for a late answer.
    const fault = faults.find((f) => f.op === "script.bindings" && f.times > 0);
    if (fault) fault.times -= 1;
    if (fault?.status) return answer("script.bindings", name, failure(fault.status, 10001, "fault"));
    if (!scripts.has(name)) return answer("script.bindings", name, failure(404, 10007, "This Worker does not exist on your account."));
    return answer("script.bindings", name, json(envelope(bindings.has(name) ? bindings.get(name) : [])));
  }

  if (script) {
    const name = decodeURIComponent(script[2]);
    const op: Op | null = request.method === "GET" ? "script.get" : request.method === "DELETE" ? "script.delete" : null;
    if (!op) { unexpected(405); return failure(405, 10405, "Method not allowed"); }
    // The scripts token only: the routing token can't touch a script.
    if (bearer !== `Bearer ${FAKE_CONTENT.scriptsToken}`) return answer(op, name, failure(403, 10000, "Authentication error"));
    await passGate(op, gates);
    const fault = takeFault(faults, op);
    if (fault && !fault.lost) return answer(op, name, failure(fault.status ?? 500, 10001, "fault"));
    if (op === "script.get") {
      const body = envelope({ namespace_id: "ns-test", namespace_name: namespace, script: scripts.has(name) ? { id: name, tag: "tag-test" } : null });
      return answer(op, name, json(body));
    }
    if (url.searchParams.get("force") !== "true") return answer(op, name, failure(400, 10400, "force is required"));
    const was = scripts.delete(name);
    if (fault?.lost) return answer(op, name, failure(fault.status ?? 502, 10001, "the answer was lost"));
    return answer(op, name, was ? json(envelope(null)) : failure(404, 10007, "This Worker does not exist on your account."));
  }

  if (entry) {
    const host = decodeURIComponent(entry[2]);
    const op: Op | null = request.method === "PUT" ? "entry.put" : request.method === "GET" ? "entry.get" : request.method === "DELETE" ? "entry.delete" : null;
    if (!op) { unexpected(405); return failure(405, 10405, "Method not allowed"); }
    // The routing token only: the scripts token can't write what a host serves.
    if (bearer !== `Bearer ${FAKE_CONTENT.routingToken}`) return answer(op, host, failure(403, 10000, "Authentication error"));
    await passGate(op, gates);
    const fault = takeFault(faults, op);
    if (fault && !fault.lost && !fault.stale && !fault.flip) return answer(op, host, failure(fault.status ?? 500, 10001, "fault"));
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
    // A read that names the same script with its kind the other way round: the code mark taken off, or put on.
    if (fault?.flip && value !== undefined) return answer(op, host, new Response(value.startsWith("code:") ? value.slice("code:".length) : `code:${value}`, { status: 200 }));
    return answer(op, host, value === undefined ? failure(404, 10009, "key not found") : new Response(value, { status: 200 }));
  }
  // Any other path on the provider's API: a wrong account, a wrong namespace, or a call nothing should make.
  unexpected(404);
  return failure(404, 7003, "No route for the URI");
}
