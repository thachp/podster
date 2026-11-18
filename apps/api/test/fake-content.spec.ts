import { describe, expect, it } from "vitest";
import { CONTENT_PARTITIONS, FAKE_CONTENT, fakeContent } from "./fake-content";

// The content provider's stand-in keeps one partition for each spec file that owns one (the plan's owed per-file
// isolation, S3 and 8c). A partition is found by the dispatch namespace or the KV namespace a call names, which only
// that file's test project binds, and is driven through its own control host. So no spec file can reset, read or fault
// another's scripts, entries, lists or calls. This file imports the stand-in itself, a module of its own in this
// runtime, and calls it directly: it never touches the instance the Worker's calls reach.

const partitions = Object.entries(CONTENT_PARTITIONS);
const [[, a], [, b]] = partitions;
type Partition = typeof a;
const API = `https://api.cloudflare.com/client/v4/accounts/${FAKE_CONTENT.account}`;
const scriptUrl = (p: Partition, name: string) => `${API}/workers/dispatch/namespaces/${p.namespace}/scripts/${name}`;
const entryUrl = (p: Partition, host: string) => `${API}/storage/kv/namespaces/${p.kvNamespace}/values/${host}`;
const scripts = { authorization: `Bearer ${FAKE_CONTENT.scriptsToken}` };
const routing = { authorization: `Bearer ${FAKE_CONTENT.routingToken}` };
async function call(url: string, init?: RequestInit) {
  const res = await fakeContent(new Request(url, init));
  if (!res) throw new Error(`the stand-in didn't answer ${url}`);
  return res;
}
const control = async (p: Partition, path: string, body?: unknown) =>
  (await call(`https://${p.control}${path}`, body === undefined ? undefined : { method: "POST", body: JSON.stringify(body) })).json() as Promise<any>;
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
    expect((await call(entryUrl(b, "put-b.apps-test.example"), { method: "PUT", headers: routing, body: "only-b.rel" })).status).toBe(200);

    const stateA = await control(a, "/state");
    const stateB = await control(b, "/state");
    expect([stateA.scripts, stateA.entries]).toEqual([["only-a.rel"], { "seeded-a.apps-test.example": "only-a.rel" }]);
    expect([stateB.scripts, stateB.entries]).toEqual([["only-b.rel"], { "put-b.apps-test.example": "only-b.rel" }]);
    expect(stateA.calls).toEqual([]);
    expect(stateB.calls).toEqual([{ op: "entry.put", name: "put-b.apps-test.example", status: 200 }]);

    // A read of a script by one partition's namespace sees only that partition's.
    const read = async (p: Partition, name: string) => ((await (await call(scriptUrl(p, name), { headers: scripts })).json()) as any).result.script;
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
    const scriptList = async (p: Partition) => ((await (await call(`${API}/workers/dispatch/namespaces/${p.namespace}/scripts`, { headers: scripts })).json()) as any).result.map((s: any) => s.id);
    const keyList = async (p: Partition) => ((await (await call(`${API}/storage/kv/namespaces/${p.kvNamespace}/keys`, { headers: routing })).json()) as any).result.map((k: any) => k.name);
    expect([await scriptList(a), await keyList(a)]).toEqual([["list-a.rel"], ["list-a.apps-test.example"]]);
    expect([await scriptList(b), await keyList(b)]).toEqual([["list-b.rel"], ["list-b.apps-test.example"]]);
  });

  it("holds a fault and a gate to the partition that set it", async () => {
    await fresh();
    await control(a, "/fault", { op: "entry.get", times: 1, status: 503 });
    const get = (p: Partition) => call(entryUrl(p, "fault.apps-test.example"), { headers: routing });
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

  it("records a call to a namespace no partition holds as unexpected, in the default partition", async () => {
    await fresh();
    expect((await call(`${API}/workers/dispatch/namespaces/no-such-namespace/scripts/x.rel`, { headers: scripts })).status).toBe(404);
    expect((await control(a, "/state")).calls).toEqual([{ op: "script.get", name: "unexpected GET /client/v4/accounts/<id>/workers/dispatch/namespaces/no-such-namespace/scripts/x.rel", status: 404 }]);
    expect((await control(b, "/state")).calls).toEqual([]);
  });
});
