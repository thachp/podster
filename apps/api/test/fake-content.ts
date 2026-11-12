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

type Op = "script.get" | "script.delete" | "entry.put" | "entry.get" | "entry.delete";
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

export async function fakeContent(request: Request): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.hostname === "content-fake.example.com") {
    if (url.pathname === "/reset") {
      scripts = new Set();
      entries = new Map();
      calls = [];
      faults = [];
      return json({ ok: true });
    }
    if (url.pathname === "/seed") {
      const body = (await request.json()) as { scripts?: string[]; entries?: Record<string, string> };
      for (const name of body.scripts ?? []) scripts.add(name);
      for (const [host, value] of Object.entries(body.entries ?? {})) entries.set(host, value);
      return json({ ok: true });
    }
    if (url.pathname === "/fault") {
      faults.push((await request.json()) as Fault);
      return json({ ok: true });
    }
    if (url.pathname === "/state") return json({ scripts: [...scripts].sort(), entries: Object.fromEntries([...entries].sort()), calls });
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

  if (script) {
    const name = decodeURIComponent(script[1]);
    const op: Op | null = request.method === "GET" ? "script.get" : request.method === "DELETE" ? "script.delete" : null;
    if (!op) return failure(405, 10405, "Method not allowed");
    // The scripts token only: the routing token can't touch a script.
    if (bearer !== `Bearer ${FAKE_CONTENT.scriptsToken}`) return answer(op, name, failure(403, 10000, "Authentication error"));
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
