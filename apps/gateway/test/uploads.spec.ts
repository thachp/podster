import { describe, expect, it } from "vitest";
import { allowedPassthrough } from "../src/index";
import { handleUpload } from "../src/uploads";
import { CAPABILITIES, jsonSchema, toApiCall } from "../src/capabilities";

const PATH = "/v1/uploads/ws_1/obj_1";
const ask = async (init: RequestInit, { path = PATH, allowed = true, api = (async () => new Response('{"ok":true}', { status: 200 })) as (r: Request) => Promise<Response> } = {}) => {
  const seen: Request[] = [];
  const texts: string[] = [];
  // As the API does, this reads what it's given before it answers.
  const fetcher = { fetch: async (request: Request) => { seen.push(request); texts.push(await request.text()); return api(request); } } as unknown as Fetcher;
  const request = new Request(`https://gateway.test${path}`, init);
  const response = await handleUpload(request, new URL(request.url), fetcher, async () => allowed);
  return { response, seen, texts };
};
const TOKEN = `Bearer upl_${"a".repeat(64)}`;
const chunked = () => new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode("hello")); c.close(); } });

describe("the upload path", () => {
  it("leaves every other path alone", async () => {
    const { response, seen } = await ask({ method: "PUT", body: "x" }, { path: "/v1/uploads/ws_1" });
    expect(response).toBeNull();
    expect(seen).toEqual([]);
  });

  it("isn't reachable through the dashboard's path, which would read the whole file into memory", () => {
    expect(allowedPassthrough("/v1/uploads/ws_1/obj_1")).toBe(false);
    expect(allowedPassthrough("/v1/workspaces/ws_1/uploads")).toBe(true);
  });

  it("only takes PUT", async () => {
    const { response, seen } = await ask({ method: "GET" });
    expect(response?.status).toBe(405);
    expect(response?.headers.get("allow")).toBe("PUT");
    expect(seen).toEqual([]);
  });

  it("passes the bytes on, with the token and nothing else from the sender", async () => {
    const { response, seen, texts } = await ask({ method: "PUT", body: "hello", headers: { authorization: TOKEN, cookie: "session=secret", "x-podster-assertion": "forged", "x-podster-caller": "forged" } });
    expect(response?.status).toBe(200);
    expect(seen).toHaveLength(1);
    expect(seen[0].url).toBe(`https://api.internal${PATH}`);
    expect(seen[0].method).toBe("PUT");
    expect([...seen[0].headers.keys()].filter((name) => name !== "content-type")).toEqual(["authorization"]);
    expect(seen[0].headers.get("authorization")).toBe(TOKEN);
    expect(texts).toEqual(["hello"]);
  });

  it("doesn't need a declared length, because the API counts what arrives", async () => {
    const { response, texts } = await ask({ method: "PUT", body: chunked(), duplex: "half", headers: { authorization: TOKEN } } as RequestInit);
    expect(response?.status).toBe(200);
    expect(texts).toEqual(["hello"]);
  });

  it("answers early to a declared length over the limit, without reaching the API", async () => {
    const { response, seen } = await ask({ method: "PUT", headers: { "content-length": "100000001" }, body: chunked(), duplex: "half" } as RequestInit);
    expect(response?.status).toBe(413);
    expect(((await response?.json()) as any).error.code).toBe("file_too_large");
    expect(seen).toEqual([]);
  });

  it.each([
    ["no token", undefined],
    ["another scheme", `Basic upl_${"a".repeat(64)}`],
    ["a short token", "Bearer upl_abc"],
    ["upper-case hex", `Bearer upl_${"A".repeat(64)}`],
    ["a byte too many", `${TOKEN}0`],
    ["a non-ASCII byte", `${TOKEN}\xff`],
  ])("goes no further with %s", async (_name, authorization) => {
    const { response, seen } = await ask({ method: "PUT", body: "x", headers: authorization ? { authorization } : {} });
    expect(response?.status).toBe(404);
    expect(((await response?.json()) as any).error.code).toBe("upload_not_found");
    expect(seen).toEqual([]);
  });

  it("can't have someone guessing use up the limit of the person whose upload it is", async () => {
    const counts = new Map<string, number>();
    const limited = async (key: string) => {
      const count = (counts.get(key) ?? 0) + 1;
      counts.set(key, count);
      return count <= 120;
    };
    const fetcher = { fetch: async () => new Response("{}") } as unknown as Fetcher;
    const send = async (authorization: string, ip: string) => {
      const request = new Request(`https://gateway.test${PATH}`, { method: "PUT", body: "x", headers: { authorization, "cf-connecting-ip": ip } });
      return (await handleUpload(request, new URL(request.url), fetcher, limited))?.status;
    };
    const guess = `Bearer upl_${"b".repeat(64)}`;
    for (let i = 0; i < 130; i++) await send(guess, "203.0.113.9");
    expect(await send(guess, "203.0.113.9")).toBe(429);
    expect(await send(TOKEN, "198.51.100.7")).toBe(200);
    expect(await send(TOKEN, "203.0.113.9")).toBe(200);
    expect([...counts.keys()].join()).not.toContain("a".repeat(64));
  });

  const refusesEarly = {
    fetch: async (forwarded: Request) => {
      await forwarded.body!.getReader().read();
      return new Response('{"error":{"code":"upload_mismatch"}}', { status: 422 });
    },
  } as unknown as Fetcher;
  const MEGABYTE = 1024 * 1024;

  it("reads the rest of a body the API refused early, so the sender gets to read the answer", async () => {
    let sent = 0;
    const longer = new ReadableStream({ pull(c) { sent += 1; if (sent > 20) c.close(); else c.enqueue(new Uint8Array(MEGABYTE)); } });
    const request = new Request(`https://gateway.test${PATH}`, { method: "PUT", body: longer, duplex: "half", headers: { authorization: TOKEN } } as RequestInit);
    const response = await handleUpload(request, new URL(request.url), refusesEarly, async () => true);
    expect(response?.status).toBe(422);
    expect(sent).toBe(21);
  });

  it.each([[404, "upload_not_found"], [403, "access_revoked"], [409, "invalid_transition"]])("doesn't read on for a %s, which a made-up token can get, so it costs nothing to refuse", async (status, code) => {
    let sent = 0;
    const endless = new ReadableStream({ pull(c) { sent += 1; c.enqueue(new Uint8Array(MEGABYTE)); } });
    const answers = { fetch: async (forwarded: Request) => {
      await forwarded.body!.getReader().read();
      return new Response(JSON.stringify({ error: { code } }), { status });
    } } as unknown as Fetcher;
    const request = new Request(`https://gateway.test${PATH}`, { method: "PUT", body: endless, duplex: "half", headers: { authorization: TOKEN } } as RequestInit);
    const response = await handleUpload(request, new URL(request.url), answers, async () => true);
    expect(response?.status).toBe(status);
    expect(sent).toBeLessThan(10);
  });

  it("stops reading at the file limit, however much a sender keeps sending", async () => {
    let sent = 0;
    const endless = new ReadableStream({ pull(c) { sent += 1; c.enqueue(new Uint8Array(MEGABYTE)); } });
    const request = new Request(`https://gateway.test${PATH}`, { method: "PUT", body: endless, duplex: "half", headers: { authorization: TOKEN } } as RequestInit);
    const response = await handleUpload(request, new URL(request.url), refusesEarly, async () => true);
    expect(response?.status).toBe(422);
    const soFar = sent;
    expect(soFar).toBeLessThan(120);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(sent - soFar).toBeLessThan(5);
  }, 15_000);

  it("answers after a few seconds if a sender stalls once refused", async () => {
    const stalled = new ReadableStream({ start(c) { c.enqueue(new Uint8Array(10)); } });
    const request = new Request(`https://gateway.test${PATH}`, { method: "PUT", body: stalled, duplex: "half", headers: { authorization: TOKEN } } as RequestInit);
    const response = await handleUpload(request, new URL(request.url), refusesEarly, async () => true);
    expect(response?.status).toBe(422);
  }, 15_000);

  it("counts a whole IPv6 /64 as one sender, so rotating addresses in it doesn't escape the limit", async () => {
    const keys: string[] = [];
    const fetcher = { fetch: async () => new Response("{}") } as unknown as Fetcher;
    for (const ip of ["2001:db8:1:2::1", "2001:db8:1:2:aaaa::9"]) {
      const request = new Request(`https://gateway.test${PATH}`, { method: "PUT", body: "x", headers: { authorization: TOKEN, "cf-connecting-ip": ip } });
      await handleUpload(request, new URL(request.url), fetcher, async (key) => (keys.push(key), true));
    }
    expect(keys[0]).toBe(keys[1]);
  });

  it("stops at the rate limit, and says when to come back", async () => {
    const { response, seen } = await ask({ method: "PUT", body: "x", headers: { authorization: TOKEN } }, { allowed: false });
    expect(response?.status).toBe(429);
    expect(response?.headers.get("retry-after")).toBe("60");
    expect(seen).toEqual([]);
  });

  it("passes on the API's answer, and gives a clear one if it's unreachable", async () => {
    const refused = await ask({ method: "PUT", body: "x", headers: { authorization: TOKEN } }, { api: async () => new Response('{"error":{"code":"upload_mismatch"}}', { status: 422 }) });
    expect(refused.response?.status).toBe(422);
    const down = await ask({ method: "PUT", body: "x", headers: { authorization: TOKEN } }, { api: async () => { throw new Error("gone"); } });
    expect(down.response?.status).toBe(502);
  });
});

describe("files on a submission, as capabilities", () => {
  const capability = (name: string) => CAPABILITIES.find((c) => c.name === name)!;

  it("create_upload passes task_id on, and only the fields it defines", () => {
    const call = toApiCall(capability("create_upload"), { workspace_id: "w", name: "a.txt", size: 3, sha256: "0".repeat(64), task_id: "tsk_1", uploaded_by: "evil", idempotency_key: "k" });
    expect(JSON.parse(call.body!)).toEqual({ name: "a.txt", size: 3, sha256: "0".repeat(64), task_id: "tsk_1" });
  });

  it("submit_task takes files as { id, label? } and passes them on", () => {
    const schema = jsonSchema(capability("submit_task")) as any;
    expect(schema.properties.files.items.properties).toEqual({ id: { type: "string" }, label: { type: "string" } });
    expect(schema.properties.files.items.required).toEqual(["id"]);
    const call = toApiCall(capability("submit_task"), { workspace_id: "w", task_id: "t", version: 2, files: [{ id: "obj_1" }, { id: "obj_2", label: "Report" }], idempotency_key: "k" });
    expect(JSON.parse(call.body!)).toEqual({ version: 2, files: [{ id: "obj_1" }, { id: "obj_2", label: "Report" }] });
  });
});
