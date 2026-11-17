// A stand-in for D1's REST API, the databases that are rooms' app stores (M6 stage 1). It runs in the test runner, as
// the Workers' outbound service, so no test or CI run ever reaches Cloudflare's API.
//
// **What it answers is partly a record and partly an assumption.** The store spike (`spikes/m6-store`) saw a create, a
// `POST` to `/accounts/<account>/d1/database` with `{"name": …}` answered `200` with `result.uuid` and `result.name`;
// the list, a `GET` of that path with `page` and `per_page=100`, of entries with `uuid` and `name`; a delete answered
// `200`; and a read or a second delete of a deleted database answered `404` with code `7404`. A read of a database that
// is there, and the list's `result_info`, follow Cloudflare's usual envelope here and are assumptions. A token without
// D1's permission is answered as the spike saw it: `401` with code `10000`.
//
// The account holds one list of databases, which only `app-store.spec.ts` uses, so its tests reset it. A test scripts
// how a call misbehaves through `stores-fake.example.com`, seeds databases that aren't Podster's, and reads back every
// call it saw. Calls are recorded by kind, by whether the store token sent them, and by name or ID, never with a token.

import { FAKE_CONTENT } from "./fake-content.ts";

/** Test values only. No real token has this form's value. */
export const FAKE_STORES = {
  token: "test-store-token-000000000000",
};

type Op = "create" | "read" | "delete" | "list";
/**
 * How one kind of call misbehaves, for its next `times` calls. Each that says it "does the work" changes the account as
 * the call asked, so only a later read or list can tell what happened.
 *
 * - `lost`: does the work and answers 502 with a page that isn't JSON.
 * - `created201`: does the work and answers 201 with the usual body.
 * - `noSuccess`: does the work and leaves `success` out.
 * - `successText`: does the work and answers `"success": "true"`, a string.
 * - `otherName`: does the work and answers with another name.
 * - `upperId`: does the work and answers with the ID in capitals.
 * - `notJson`: does the work and answers 200 with a body that isn't JSON.
 * - `huge`: does the work and answers with a body longer than any the client reads.
 * - `redirect`: does nothing and answers 302 to an answer that would count, if followed.
 * - `refused`: a create does nothing and answers 403 with code 10000, as a token without D1's permission is told.
 * - `notFoundOtherCode`: a read answers 404 with code 7403.
 * - `notFoundTwoCodes`: a read answers 404 with codes 7404 and 1000.
 * - `notFoundSuccessMissing`: a read answers 404 with code 7404 and no `success`.
 * - `codeText`: a read answers 404 with code `"7404"`, a string.
 * - `otherId`: a read answers 200 describing another ID.
 * - `noInfo`: a list page answers with no `result_info`.
 * - `totalDrift`: a list page past the first says one more in all than the first did.
 * - `badEntry`: a list page holds one entry whose `uuid` isn't a UUID.
 * - `shortPage`: a list page holds one entry fewer than it should.
 * - `huge` on the list: every page full, of a total far longer than any list the client reads.
 */
type FaultKind =
  | "lost" | "created201" | "noSuccess" | "successText" | "otherName" | "upperId" | "notJson" | "huge" | "redirect" | "refused"
  | "notFoundOtherCode" | "notFoundTwoCodes" | "notFoundSuccessMissing" | "codeText" | "otherId"
  | "noInfo" | "totalDrift" | "badEntry" | "shortPage";
type Fault = { op: Op; kind: FaultKind; times: number };

let databases: { uuid: string; name: string }[] = [];
let calls: { op: Op; token: "store" | "other"; key: string }[] = [];
let faults: Fault[] = [];

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const envelope = (result: unknown, extra: Record<string, unknown> = {}) => ({ success: true, errors: [], messages: [], result, ...extra });
const failure = (status: number, codes: unknown[], extra: Record<string, unknown> = {}) =>
  json({ success: false, errors: codes.map((code) => ({ code, message: "error" })), messages: [], result: null, ...extra }, status);
const notFound = () => failure(404, [7404]);
const describe = (db: { uuid: string; name: string }) => ({ uuid: db.uuid, name: db.name, created_at: "2026-11-17T00:00:00.000Z", version: "production", num_tables: 0, file_size: 12288 });

function takeFault(op: Op) {
  const fault = faults.find((f) => f.op === op && f.times > 0);
  if (!fault) return undefined;
  fault.times -= 1;
  return fault.kind;
}

/** A described database's answer, shaped by a fault that does the work. */
function answered(fault: FaultKind | undefined, db: { uuid: string; name: string }) {
  const result = describe(db);
  if (fault === "lost") return new Response("<html>bad gateway</html>", { status: 502 });
  if (fault === "created201") return json(envelope(result), 201);
  if (fault === "noSuccess") return json({ errors: [], messages: [], result });
  if (fault === "successText") return json({ success: "true", errors: [], messages: [], result });
  if (fault === "otherName") return json(envelope({ ...result, name: `${db.name}x` }));
  if (fault === "upperId") return json(envelope({ ...result, uuid: db.uuid.toUpperCase() }));
  if (fault === "otherId") return json(envelope({ ...result, uuid: crypto.randomUUID() }));
  if (fault === "notJson") return new Response("ok", { status: 200 });
  if (fault === "huge") return json(envelope(result, { padding: "x".repeat(300 * 1024) }));
  return json(envelope(result));
}

export async function fakeStores(request: Request): Promise<Response | undefined> {
  const url = new URL(request.url);
  if (url.hostname === "stores-fake.example.com") {
    if (url.pathname === "/reset") { databases = []; calls = []; faults = []; return json({ ok: true }); }
    if (url.pathname === "/fault") { faults.push((await request.json()) as Fault); return json({ ok: true }); }
    if (url.pathname === "/seed") {
      const { count, prefix } = (await request.json()) as { count: number; prefix: string };
      for (let n = 0; n < count; n++) databases.push({ uuid: crypto.randomUUID(), name: `${prefix}${n}` });
      return json({ ok: true });
    }
    if (url.pathname === "/state") return json({ databases, calls });
    if (url.pathname === "/echo") return json(envelope(describe({ uuid: url.searchParams.get("uuid") ?? "", name: url.searchParams.get("name") ?? "" })));
    return json({ error: "unknown" }, 404);
  }
  const base = `/client/v4/accounts/${FAKE_CONTENT.account}/d1/database`;
  if (url.hostname !== "api.cloudflare.com" || (url.pathname !== base && !url.pathname.startsWith(`${base}/`))) return undefined;
  const store = request.headers.get("authorization") === `Bearer ${FAKE_STORES.token}`;
  const rest = url.pathname.slice(base.length);
  const op: Op = request.method === "POST" ? "create" : request.method === "DELETE" ? "delete" : rest === "" ? "list" : "read";
  const key = op === "create" ? String(((await request.clone().json().catch(() => ({}))) as { name?: unknown }).name ?? "") : rest.slice(1);
  calls.push({ op, token: store ? "store" : "other", key });
  if (!store) return failure(401, [10000]);
  const fault = takeFault(op);
  // A redirect to an answer that would count if the client followed it: the database asked for, described as made or
  // present, though nothing was done.
  if (fault === "redirect") {
    const known = databases.find((db) => db.uuid === rest.slice(1));
    const echo = new URLSearchParams({ uuid: known?.uuid ?? crypto.randomUUID(), name: known?.name ?? key });
    return new Response(null, { status: 302, headers: { location: `https://stores-fake.example.com/echo?${echo}` } });
  }
  if (op === "create" && rest === "") {
    if (fault === "refused") return failure(403, [10000]);
    const body = (await request.json()) as Record<string, unknown>;
    if (Object.keys(body).length !== 1 || typeof body.name !== "string") return failure(400, [7400]);
    if (databases.some((db) => db.name === body.name)) return failure(400, [7502]);
    const db = { uuid: crypto.randomUUID(), name: body.name };
    databases.push(db);
    return answered(fault, db);
  }
  if (op === "list") {
    const perPage = Number(url.searchParams.get("per_page") ?? 100);
    const page = Number(url.searchParams.get("page") ?? 1);
    if (fault === "lost") return new Response("<html>bad gateway</html>", { status: 502 });
    if (fault === "huge") {
      const result = Array.from({ length: perPage }, (_, n) => describe({ uuid: crypto.randomUUID(), name: `other-${page}-${n}` }));
      return json(envelope(result, { result_info: { page, per_page: perPage, count: perPage, total_count: perPage * 100 } }));
    }
    let found = databases.slice((page - 1) * perPage, page * perPage).map(describe);
    if (fault === "shortPage") found = found.slice(1);
    if (fault === "badEntry" && found.length > 0) found = [{ ...found[0], uuid: "not-a-uuid" }, ...found.slice(1)];
    if (fault === "noInfo") return json(envelope(found));
    const total = databases.length + (fault === "totalDrift" && page > 1 ? 1 : 0);
    return json(envelope(found, { result_info: { page, per_page: perPage, count: found.length, total_count: total } }));
  }
  const at = databases.findIndex((db) => db.uuid === rest.slice(1));
  if (op === "read") {
    if (fault === "notFoundOtherCode") return failure(404, [7403]);
    if (fault === "notFoundTwoCodes") return failure(404, [7404, 1000]);
    if (fault === "codeText") return failure(404, ["7404"]);
    if (fault === "notFoundSuccessMissing") return json({ errors: [{ code: 7404, message: "error" }], messages: [], result: null }, 404);
    if (at < 0) return fault === "lost" ? new Response("<html>bad gateway</html>", { status: 502 }) : notFound();
    return answered(fault, databases[at]);
  }
  if (op === "delete") {
    if (at < 0) return notFound();
    databases.splice(at, 1);
    if (fault === "lost") return new Response("<html>bad gateway</html>", { status: 502 });
    return json(envelope(null));
  }
  return failure(404, [7003]);
}
