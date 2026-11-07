import { describe, expect, it } from "vitest";
import { allowedPassthrough } from "../src/index";
import { handleAgentDownload, isFilePath, serveFile } from "../src/downloads";
import type { Identity } from "../src/assertion";

const AGENT: Identity = { kind: "agent", id: "agt_1", org: "org_1", generation: 1 };
const PATH = "/v1/files/ws_1/obj_1";
const JWK = JSON.stringify({ crv: "Ed25519", kty: "OKP", d: "nWGxne_9WmC6hEr0kuwsxERJxWl7MmkZcDusAxyuf2A", x: "11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo", kid: "test" });
const ATTACHED = { "content-type": "text/plain; charset=utf-8", "content-disposition": `attachment; filename="a.txt"; filename*=UTF-8''a.txt`, "x-content-type-options": "nosniff", "cache-control": "private, no-store", "content-security-policy": "default-src 'none'; sandbox", "content-length": "5" };
const envWith = (answer: () => Response | Promise<Response>) => {
  const seen: Request[] = [];
  return { seen, env: { ASSERTION_SIGNING_JWK: JWK, API: { fetch: async (request: Request) => { seen.push(request); return answer(); } } as unknown as Fetcher } };
};
const ask = (init: RequestInit = {}, path = PATH) => new Request(`https://gateway.test${path}`, init);
const allow = async () => true;
const bearer = { headers: { authorization: "Bearer a.b.c" } };

describe("the agents' download path", () => {
  it("leaves every other path alone", async () => {
    const { env } = envWith(() => new Response("x"));
    const request = ask({}, "/v1/files/ws_1");
    expect(await handleAgentDownload(request, new URL(request.url), env, async () => AGENT, allow)).toBeNull();
  });

  it("only takes GET", async () => {
    const { env, seen } = envWith(() => new Response("x"));
    const request = ask({ method: "POST", ...bearer });
    const res = await handleAgentDownload(request, new URL(request.url), env, async () => AGENT, allow);
    expect(res?.status).toBe(405);
    expect(seen).toEqual([]);
  });

  it("refuses with no credential or one that isn't, without reaching the API", async () => {
    const { env, seen } = envWith(() => new Response("x"));
    for (const init of [{}, { headers: { authorization: "Basic abc" } }, { headers: { authorization: "Bearer a b" } }, bearer]) {
      const request = ask(init);
      const res = await handleAgentDownload(request, new URL(request.url), env, async () => null, allow);
      expect(res?.status).toBe(401);
    }
    expect(seen).toEqual([]);
  });

  it("passes on a credential's refusal, without reaching the API", async () => {
    const { env, seen } = envWith(() => new Response("x"));
    const request = ask(bearer);
    const res = await handleAgentDownload(request, new URL(request.url), env, async () => new Response("{}", { status: 403 }), allow);
    expect(res?.status).toBe(403);
    expect(seen).toEqual([]);
  });

  it("counts guesses before reading a credential, and an agent before spending its token", async () => {
    const { env, seen } = envWith(() => new Response("x"));
    let read = 0;
    const identify = async () => { read++; return AGENT; };
    const first = ask(bearer);
    const guessing = await handleAgentDownload(first, new URL(first.url), env, identify, async () => false);
    expect(guessing?.status).toBe(429);
    expect(read).toBe(0);
    const second = ask(bearer);
    const busy = await handleAgentDownload(second, new URL(second.url), env, identify, async (key) => !key.startsWith("agent:"));
    expect(busy?.status).toBe(429);
    expect(busy?.headers.get("retry-after")).toBe("60");
    expect(seen).toEqual([]);
  });

  it("sends only a fresh assertion, nothing from the caller", async () => {
    const { env, seen } = envWith(() => new Response("hello", { headers: ATTACHED }));
    const request = ask({ headers: { authorization: "Bearer a.b.c", cookie: "session=secret", "x-podster-assertion": "forged", range: "bytes=0-1" } });
    const res = await handleAgentDownload(request, new URL(request.url), env, async () => AGENT, allow);
    expect(res?.status).toBe(200);
    expect(seen[0].url).toBe(`https://api.internal${PATH}`);
    expect(seen[0].headers.get("x-podster-assertion")).not.toBe("forged");
    expect(seen[0].headers.get("x-podster-assertion")).toBeTruthy();
    for (const name of ["authorization", "cookie", "range"]) expect(seen[0].headers.get(name), name).toBeNull();
  });
});

describe("serving a file", () => {
  it("streams the bytes with the file headers and nothing else the API said", async () => {
    const { env } = envWith(() => new Response("hello", { headers: { ...ATTACHED, "set-cookie": "a=b", "x-internal": "1" } }));
    const res = await serveFile(env, AGENT, PATH);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("hello");
    for (const [name, value] of Object.entries(ATTACHED)) expect(res.headers.get(name), name).toBe(value);
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(res.headers.get("x-internal")).toBeNull();
  });

  it("won't pass a 200 that isn't a nosniff attachment", async () => {
    const answers: Record<string, string>[] = [{ "content-type": "text/html" }, { "content-disposition": "inline", "x-content-type-options": "nosniff" }, { "content-disposition": ATTACHED["content-disposition"] }];
    for (const headers of answers) {
      const { env } = envWith(() => new Response("<script>", { headers }));
      const res = await serveFile(env, AGENT, PATH);
      expect(res.status).toBe(502);
      expect(await res.text()).not.toContain("<script>");
    }
  });

  it("labels a refusal as JSON whatever came back", async () => {
    const { env } = envWith(() => new Response('{"error":{"code":"file_not_found"}}', { status: 404, headers: { "content-type": "text/html", "content-disposition": "inline" } }));
    const res = await serveFile(env, AGENT, PATH);
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(res.headers.get("content-disposition")).toBeNull();
  });

  it("answers clearly when the API can't be reached", async () => {
    const { env } = envWith(() => { throw new Error("gone"); });
    expect((await serveFile(env, AGENT, PATH)).status).toBe(502);
  });
});

describe("the path's shape", () => {
  it("is only the exact path, and the dashboard's general route never reads a file into memory", () => {
    expect(isFilePath(PATH)).toBe(true);
    for (const path of ["/v1/files/ws_1", "/v1/files/ws_1/obj_1/x", "/v1/files/../x/y", "/v1/files//obj"]) expect(isFilePath(path), path).toBe(false);
    expect(allowedPassthrough(PATH)).toBe(false);
    expect(allowedPassthrough("/v1/workspaces/ws_1/files/obj_1")).toBe(true);
  });
});
