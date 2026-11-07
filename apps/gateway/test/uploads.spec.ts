import { describe, expect, it } from "vitest";
import { allowedPassthrough } from "../src/index";
import { handleUpload } from "../src/uploads";

const PATH = "/v1/uploads/ws_1/obj_1";
const ask = async (init: RequestInit, { path = PATH, allowed = true, api = (async () => new Response('{"ok":true}', { status: 200 })) as (r: Request) => Promise<Response> } = {}) => {
  const seen: Request[] = [];
  const fetcher = { fetch: async (request: Request) => { seen.push(request); return api(request); } } as unknown as Fetcher;
  const request = new Request(`https://gateway.test${path}`, init);
  const response = await handleUpload(request, new URL(request.url), fetcher, async () => allowed);
  return { response, seen };
};
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
    const { response, seen } = await ask({ method: "PUT", body: "hello", headers: { authorization: "Bearer upl_x", cookie: "session=secret", "x-podster-assertion": "forged", "x-podster-caller": "forged" } });
    expect(response?.status).toBe(200);
    expect(seen).toHaveLength(1);
    expect(seen[0].url).toBe(`https://api.internal${PATH}`);
    expect(seen[0].method).toBe("PUT");
    expect([...seen[0].headers.keys()].filter((name) => name !== "content-type")).toEqual(["authorization"]);
    expect(seen[0].headers.get("authorization")).toBe("Bearer upl_x");
    expect(await seen[0].text()).toBe("hello");
  });

  it("doesn't need a declared length, because the API counts what arrives", async () => {
    const { response, seen } = await ask({ method: "PUT", body: chunked(), duplex: "half" } as RequestInit);
    expect(response?.status).toBe(200);
    expect(await seen[0].text()).toBe("hello");
  });

  it("answers early to a declared length over the limit, without reaching the API", async () => {
    const { response, seen } = await ask({ method: "PUT", headers: { "content-length": "100000001" }, body: chunked(), duplex: "half" } as RequestInit);
    expect(response?.status).toBe(413);
    expect(((await response?.json()) as any).error.code).toBe("file_too_large");
    expect(seen).toEqual([]);
  });

  it("stops at the rate limit, and says when to come back", async () => {
    const { response, seen } = await ask({ method: "PUT", body: "x" }, { allowed: false });
    expect(response?.status).toBe(429);
    expect(response?.headers.get("retry-after")).toBe("60");
    expect(seen).toEqual([]);
  });

  it("passes on the API's answer, and gives a clear one if it's unreachable", async () => {
    const refused = await ask({ method: "PUT", body: "x" }, { api: async () => new Response('{"error":{"code":"upload_mismatch"}}', { status: 422 }) });
    expect(refused.response?.status).toBe(422);
    const down = await ask({ method: "PUT", body: "x" }, { api: async () => { throw new Error("gone"); } });
    expect(down.response?.status).toBe(502);
  });
});
