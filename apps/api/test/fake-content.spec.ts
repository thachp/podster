import { describe, expect, it } from "vitest";
import { CONTENT_PARTITIONS, type ContentPartition, FAKE_CONTENT, fakeContent } from "./fake-content";

// The content provider's stand-in keeps one partition for each spec file that owns one (the plan's owed per-file
// isolation, S3 and 8c). A partition is found by the dispatch namespace or the KV namespace a call names, which only
// that file's test project binds, and is driven through its own control host. So no spec file can reset, read or fault
// another's scripts, entries, lists or calls. Each project's outbound service tells the stand-in which partition is
// calling, so a call to any other partition's namespace, or to none, is unexpected and told to the caller's partition.
// This file imports the stand-in itself, a module of its own in this runtime, and calls it directly, saying which
// partition is calling: it never touches the instance the Worker's calls reach.

const partitions = Object.entries(CONTENT_PARTITIONS);
const [[, a], [, b]] = partitions;
type Partition = typeof a;
const nameOf = (p: Partition) => partitions.find(([, q]) => q === p)![0] as ContentPartition;
const API = `https://api.cloudflare.com/client/v4/accounts/${FAKE_CONTENT.account}`;
const scriptUrl = (p: Partition, name: string) => `${API}/workers/dispatch/namespaces/${p.namespace}/scripts/${name}`;
const entryUrl = (p: Partition, host: string) => `${API}/storage/kv/namespaces/${p.kvNamespace}/values/${host}`;
const scripts = { authorization: `Bearer ${FAKE_CONTENT.scriptsToken}` };
const routing = { authorization: `Bearer ${FAKE_CONTENT.routingToken}` };
/** A call made from `from`'s project. */
async function call(from: Partition, url: string, init?: RequestInit) {
  const res = await fakeContent(new Request(url, init), nameOf(from));
  if (!res) throw new Error(`the stand-in didn't answer ${url}`);
  return res;
}
const control = async (p: Partition, path: string, body?: unknown) =>
  (await call(p, `https://${p.control}${path}`, body === undefined ? undefined : { method: "POST", body: JSON.stringify(body) })).json() as Promise<any>;
const fresh = async () => { for (const [, p] of partitions) await control(p, "/reset"); };

describe("the content provider's stand-in, one partition per spec file", () => {
  it("names at least two partitions, the default first, each with its own namespaces and control host", () => {
    expect(partitions.length).toBeGreaterThanOrEqual(2);
    expect(partitions[0][0]).toBe("default");
    expect(a).toEqual({ namespace: FAKE_CONTENT.namespace, kvNamespace: FAKE_CONTENT.kvNamespace, control: "content-fake.example.com" });
    for (const field of ["namespace", "kvNamespace", "control"] as const) {
      expect(new Set(partitions.map(([, p]) => p[field])).size, field).toBe(partitions.length);
    }
    for (const [, p] of partitions) {
      // What the provider module accepts: a namespace's name, and 32 lower-case hexadecimal digits for KV's.
      expect(p.namespace).toMatch(/^[a-z0-9_-]{1,63}$/);
      expect(p.kvNamespace).toMatch(/^[0-9a-f]{32}$/);
      expect(p.control.endsWith("content-fake.example.com")).toBe(true);
    }
  });

  it("keeps each partition's entries, scripts and calls to itself, and a reset of one leaves the other", async () => {
    await fresh();
    await control(a, "/seed", { scripts: ["only-a.rel"], entries: { "seeded-a.apps-test.example": "only-a.rel" } });
    await control(b, "/seed", { scripts: ["only-b.rel"] });
    expect((await call(b, entryUrl(b, "put-b.apps-test.example"), { method: "PUT", headers: routing, body: "only-b.rel" })).status).toBe(200);

    const stateA = await control(a, "/state");
    const stateB = await control(b, "/state");
    expect([stateA.scripts, stateA.entries]).toEqual([["only-a.rel"], { "seeded-a.apps-test.example": "only-a.rel" }]);
    expect([stateB.scripts, stateB.entries]).toEqual([["only-b.rel"], { "put-b.apps-test.example": "only-b.rel" }]);
    expect(stateA.calls).toEqual([]);
    expect(stateB.calls).toEqual([{ op: "entry.put", name: "put-b.apps-test.example", status: 200 }]);

    // A read of a script by one partition's namespace sees only that partition's.
    const read = async (p: Partition, name: string) => ((await (await call(p, scriptUrl(p, name), { headers: scripts })).json()) as any).result.script;
    expect([await read(a, "only-a.rel"), await read(a, "only-b.rel")]).toEqual([{ id: "only-a.rel", tag: "tag-test" }, null]);
    expect([await read(b, "only-b.rel"), await read(b, "only-a.rel")]).toEqual([{ id: "only-b.rel", tag: "tag-test" }, null]);

    await control(b, "/reset");
    expect(await control(a, "/state")).toMatchObject({ scripts: ["only-a.rel"], entries: { "seeded-a.apps-test.example": "only-a.rel" } });
    expect(await control(b, "/state")).toMatchObject({ scripts: [], entries: {}, calls: [] });
  });

  it("answers each partition's two lists from its own scripts and keys", async () => {
    await fresh();
    await control(a, "/seed", { scripts: ["list-a.rel"], entries: { "list-a.apps-test.example": "list-a.rel" } });
    await control(b, "/seed", { scripts: ["list-b.rel"], entries: { "list-b.apps-test.example": "list-b.rel" } });
    const scriptList = async (p: Partition) => ((await (await call(p, `${API}/workers/dispatch/namespaces/${p.namespace}/scripts`, { headers: scripts })).json()) as any).result.map((s: any) => s.id);
    const keyList = async (p: Partition) => ((await (await call(p, `${API}/storage/kv/namespaces/${p.kvNamespace}/keys`, { headers: routing })).json()) as any).result.map((k: any) => k.name);
    expect([await scriptList(a), await keyList(a)]).toEqual([["list-a.rel"], ["list-a.apps-test.example"]]);
    expect([await scriptList(b), await keyList(b)]).toEqual([["list-b.rel"], ["list-b.apps-test.example"]]);
  });

  it("holds a fault and a gate to the partition that set it", async () => {
    await fresh();
    await control(a, "/fault", { op: "entry.get", times: 1, status: 503 });
    const get = (p: Partition) => call(p, entryUrl(p, "fault.apps-test.example"), { headers: routing });
    expect((await get(b)).status).toBe(404);
    expect((await get(a)).status).toBe(503);
    // A gate set in one partition holds that partition's next call, and never the other's.
    const { id } = await control(b, "/gate", { op: "entry.get" });
    expect((await get(a)).status).toBe(404);
    const held = get(b);
    await control(b, `/arrived?id=${id}`);
    await control(b, `/release?id=${id}`);
    expect((await held).status).toBe(404);
    expect((await control(b, "/state")).expiredGates).toBe(0);
  });

  it("tells a call to a namespace no partition holds as unexpected, to the partition that made it", async () => {
    await fresh();
    for (const from of [a, b]) {
      expect((await call(from, `${API}/workers/dispatch/namespaces/no-such-namespace/scripts/x.rel`, { headers: scripts })).status).toBe(404);
    }
    const unexpected = { op: "script.get", name: "unexpected GET /client/v4/accounts/<id>/workers/dispatch/namespaces/no-such-namespace/scripts/x.rel", status: 404 };
    expect((await control(a, "/state")).calls).toEqual([unexpected]);
    expect((await control(b, "/state")).calls).toEqual([unexpected]);
  });

  it("tells a call to another partition's namespaces as unexpected to the caller, and leaves the other's state alone", async () => {
    await fresh();
    await control(a, "/seed", { scripts: ["only-a.rel"], entries: { "seeded-a.apps-test.example": "only-a.rel" } });
    // From b's project: a's script, a's entry written and read, and a's two lists.
    expect((await call(b, scriptUrl(a, "only-a.rel"), { headers: scripts })).status).toBe(404);
    expect((await call(b, scriptUrl(a, "only-a.rel"), { method: "DELETE", headers: scripts })).status).toBe(404);
    expect((await call(b, entryUrl(a, "seeded-a.apps-test.example"), { method: "PUT", headers: routing, body: "from-b.rel" })).status).toBe(404);
    expect((await call(b, entryUrl(a, "seeded-a.apps-test.example"), { headers: routing })).status).toBe(404);
    expect((await call(b, `${API}/workers/dispatch/namespaces/${a.namespace}/scripts`, { headers: scripts })).status).toBe(404);
    expect((await call(b, `${API}/storage/kv/namespaces/${a.kvNamespace}/keys`, { headers: routing })).status).toBe(404);
    const told = (await control(b, "/state")).calls as { op: string; name: string; status: number }[];
    expect(told.length).toBe(6);
    expect(told.every((c) => c.name.startsWith("unexpected ") && c.status === 404)).toBe(true);
    expect(await control(a, "/state")).toMatchObject({ scripts: ["only-a.rel"], entries: { "seeded-a.apps-test.example": "only-a.rel" }, calls: [] });
  });

  it("tells an unmatched path or method as unexpected to the partition that made it", async () => {
    await fresh();
    expect((await call(b, `${API}/workers/dispatch/namespaces/${b.namespace}/scripts/x.rel`, { method: "PATCH", headers: scripts })).status).toBe(405);
    expect((await call(b, `${API}/workers/elsewhere`, { headers: scripts })).status).toBe(404);
    expect((await control(b, "/state")).calls).toEqual([
      { op: "script.get", name: `unexpected PATCH /client/v4/accounts/<id>/workers/dispatch/namespaces/${b.namespace}/scripts/x.rel`, status: 405 },
      { op: "script.get", name: "unexpected GET /client/v4/accounts/<id>/workers/elsewhere", status: 404 },
    ]);
    expect((await control(a, "/state")).calls).toEqual([]);
  });

  it("scripts no delay: a fault answers at once, and a hold is a gate the test lets go", async () => {
    await fresh();
    // `delayMs` is gone: a fault that names only one is no fault, and the call is answered as it would have been.
    await control(a, "/fault", { op: "entry.get", times: 1, delayMs: 60_000 });
    expect((await call(a, entryUrl(a, "nodelay.apps-test.example"), { headers: routing })).status).toBe(404);
  });
});
