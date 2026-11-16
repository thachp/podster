// A stand-in for Cloudflare for SaaS's custom hostnames (M6 step 8b, ADR 0010's "Custom domains", steps 5 and 6). It
// runs in the test runner, as the Workers' outbound service, so no test or CI run ever reaches Cloudflare's API.
//
// **Every answer here is an assumption, not a record.** No spike has made a custom hostname. It answers the way
// `src/custom_hostnames.rs` expects, from Cloudflare's documented API: a create is a `POST` to
// `/zones/<zone>/custom_hostnames` answered with the new hostname's `id`, `hostname` and `status` in the usual envelope;
// a read is that path's list with `?hostname=`, which the documentation calls a search, so this one matches any name
// containing it, a page at a time by `page` and `per_page`, with `result_info.total_count`; a delete is a `DELETE` of `/<id>`. A second create of one name is
// refused, with the code the documentation lists for a duplicate. Spike D or a later one must confirm these before a
// provider is configured.
//
// Everything is kept by hostname, so spec files running at the same time never see each other's. A test scripts how a
// call misbehaves through `hostnames-fake.example.com`, sets what Cloudflare holds for a name, and reads back every call
// it saw for that name. Calls are recorded by kind and name, never with a token.

/** Test values only. No real zone or token has this form's values. */
export const FAKE_HOSTNAMES = {
  zone: "e7".repeat(16),
  token: "test-hostnames-token-0000000000",
};

type Op = "create" | "read" | "delete";
/**
 * How one kind of call for one name misbehaves, for its next `times` calls. `lost` does the work and answers 502;
 * `failed` does nothing and answers 500; `kept` answers a delete with success and keeps the hostname; `partial` answers
 * a read with a total that says there is another page; `shape` answers a read with no `result_info`; `huge` answers each
 * page with a full page of other names, out of a total of a hundred pages.
 */
type Fault = { op: Op; hostname: string; times: number; kind: "lost" | "failed" | "kept" | "partial" | "shape" | "huge" };

const held = new Map<string, { id: string; status: string }>();
const calls: { op: Op; hostname: string }[] = [];
const faults: Fault[] = [];

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const envelope = (result: unknown, extra: Record<string, unknown> = {}) => ({ success: true, errors: [], messages: [], result, ...extra });
const failure = (status: number, code: number, message: string) => json({ success: false, errors: [{ code, message }], messages: [], result: null }, status);

function takeFault(op: Op, hostname: string) {
  const fault = faults.find((f) => f.op === op && f.hostname === hostname && f.times > 0);
  if (!fault) return undefined;
  fault.times -= 1;
  return fault.kind;
}

export async function fakeHostnames(request: Request): Promise<Response | undefined> {
  const url = new URL(request.url);
  if (url.hostname === "hostnames-fake.example.com") {
    const name = url.searchParams.get("hostname") ?? "";
    if (url.pathname === "/fault") { faults.push((await request.json()) as Fault); return json({ ok: true }); }
    if (url.pathname === "/set") {
      const { status } = (await request.json()) as { status: string | null };
      if (status === null) held.delete(name);
      else held.set(name, { id: held.get(name)?.id ?? crypto.randomUUID(), status });
      return json({ ok: true });
    }
    if (url.pathname === "/state") return json({ held: held.get(name) ?? null, calls: calls.filter((c) => c.hostname === name).map((c) => c.op) });
    return json({ error: "unknown" }, 404);
  }
  const base = `/client/v4/zones/${FAKE_HOSTNAMES.zone}/custom_hostnames`;
  if (url.hostname !== "api.cloudflare.com" || !url.pathname.startsWith(base)) return undefined;
  if (request.headers.get("authorization") !== `Bearer ${FAKE_HOSTNAMES.token}`) return failure(403, 10000, "Authentication error");
  const rest = url.pathname.slice(base.length);
  if (request.method === "POST" && rest === "") {
    const body = (await request.json()) as { hostname?: string; ssl?: { method?: string; type?: string } };
    const hostname = body.hostname ?? "";
    calls.push({ op: "create", hostname });
    if (body.ssl?.method !== "http" || body.ssl?.type !== "dv") return failure(400, 1400, "ssl");
    const fault = takeFault("create", hostname);
    if (fault === "failed") return failure(500, 1000, "failed");
    if (held.has(hostname)) return failure(409, 1406, "Duplicate custom hostname found.");
    const made = { id: crypto.randomUUID(), status: "pending" };
    held.set(hostname, made);
    if (fault === "lost") return new Response("bad gateway", { status: 502 });
    return json(envelope({ id: made.id, hostname, status: made.status, ssl: { method: "http", type: "dv", status: "initializing" } }));
  }
  if (request.method === "GET" && rest === "") {
    const hostname = url.searchParams.get("hostname") ?? "";
    calls.push({ op: "read", hostname });
    const fault = takeFault("read", hostname);
    if (fault === "failed" || fault === "lost") return failure(500, 1000, "failed");
    const perPage = Number(url.searchParams.get("per_page") ?? 20);
    const page = Number(url.searchParams.get("page") ?? 1);
    // `huge`: the search matches far more than any read takes, every page full of other names.
    if (fault === "huge") {
      const result = Array.from({ length: perPage }, (_, n) => ({ id: crypto.randomUUID(), hostname: `x${page}y${n}.${hostname}`, status: "active" }));
      return json(envelope(result, { result_info: { page, per_page: perPage, count: perPage, total_count: perPage * 100 } }));
    }
    const all = [...held.entries()].filter(([name]) => name.includes(hostname)).map(([name, h]) => ({ id: h.id, hostname: name, status: h.status }));
    const found = all.slice((page - 1) * perPage, page * perPage);
    if (fault === "shape") return json({ success: true, errors: [], messages: [], result: found });
    const total = all.length + (fault === "partial" ? 1 : 0);
    return json(envelope(found, { result_info: { page, per_page: perPage, count: found.length, total_count: total } }));
  }
  if (request.method === "DELETE" && rest.startsWith("/")) {
    const id = rest.slice(1);
    const entry = [...held.entries()].find(([, h]) => h.id === id);
    const hostname = entry?.[0] ?? "";
    calls.push({ op: "delete", hostname });
    if (!entry) return failure(404, 1436, "The custom hostname was not found.");
    const fault = takeFault("delete", hostname);
    if (fault === "failed") return failure(500, 1000, "failed");
    if (fault !== "kept") held.delete(hostname);
    if (fault === "lost") return new Response("bad gateway", { status: 502 });
    return json(envelope({ id }));
  }
  return failure(404, 7003, "Could not route");
}
