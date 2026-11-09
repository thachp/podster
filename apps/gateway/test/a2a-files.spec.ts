import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { handleA2aDownload } from "../src/downloads";
import { agentOnBoth, call, connect, dash, setUpSchemas, signUp, type Person } from "./oauth-helpers";

/**
 * `GET /a2a/files/{workspace}/{file}` (M3, ADR 0007): an input file an A2A offer links to, for an agent that holds only an
 * `/a2a` token. Only that audience opens it, and the API decides what the agent may have, on the same `/v1/files` path.
 */

type Agent = Awaited<ReturnType<typeof agentOnBoth>>;
const e = env as any;
const reply = async (res: Response) => ({ status: res.status, code: ((await res.json()) as any).error?.code as string });
const bearer = (token?: string): Record<string, string> => (token ? { authorization: `Bearer ${token}` } : {});
const a2aFile = (room: string, file: string, token?: string, init: RequestInit = {}) => call(`/a2a/files/${room}/${file}`, { headers: bearer(token), ...init });
const v1File = (room: string, file: string, token?: string) => call(`/v1/files/${room}/${file}`, { headers: bearer(token) });

let owner: Person;
let agent: Agent;
let room: string;

beforeAll(async () => {
  await setUpSchemas();
  owner = await signUp();
  agent = await agentOnBoth(owner);
  room = (await dash(owner, "POST", "/v1/workspaces", { name: "A2A files" })).body.id;
  const version = (await dash(owner, "GET", `/v1/workspaces/${room}`)).body.policy_version;
  expect((await dash(owner, "POST", `/v1/workspaces/${room}/members`, { principal_id: agent.id, kind: "agent", org_id: owner.org, role: "guest", policy_version: version })).status).toBe(200);
});

describe("the audience", () => {
  it("takes an /a2a token through to the API, which answers for the file", async () => {
    expect(await reply(await a2aFile(room, "obj_unknown", agent.a2a))).toEqual({ status: 404, code: "file_not_found" });
  });

  it("refuses an /mcp token, a legacy token with no audience, an Agent Auth-shaped JWT, junk and none, all as no credential", async () => {
    const legacy = await connect(owner, null, "mcp");
    for (const token of [agent.mcp, legacy.access, "aaa.bbb.ccc", "not-a-token", undefined]) {
      expect(await reply(await a2aFile(room, "obj_unknown", token)), String(token).slice(0, 12)).toEqual({ status: 401, code: "invalid_credential" });
    }
  });

  it("keeps /v1/files closed to an /a2a token, as before", async () => {
    expect((await reply(await v1File(room, "obj_unknown", agent.a2a))).status).toBe(401);
    expect(await reply(await v1File(room, "obj_unknown", agent.mcp))).toEqual({ status: 404, code: "file_not_found" });
  });

  it("answers only GET, and only the exact path", async () => {
    const posted = await a2aFile(room, "obj_unknown", agent.a2a, { method: "POST" });
    expect(posted.status).toBe(405);
    expect(posted.headers.get("allow")).toBe("GET");
    for (const path of [`/a2a/files/${room}`, `/a2a/files/${room}/obj_x/more`, `/a2a/files/${room}/obj%2F..`]) {
      expect((await call(path, { headers: bearer(agent.a2a) })).status, path).not.toBe(200);
    }
  });
});

describe("what the API decides", () => {
  it("answers a file the agent can't see as it answers one that doesn't exist", async () => {
    // An input asset the owner started that isn't linked to any of the guest's tasks, so the guest can't see it.
    const started = await dash(owner, "POST", `/v1/workspaces/${room}/uploads`, { name: "secret.txt", size: 4, sha256: "0".repeat(64) });
    expect(started.status, JSON.stringify(started.body)).toBe(200);
    const hidden = await reply(await a2aFile(room, started.body.id, agent.a2a));
    const missing = await reply(await a2aFile(room, `obj_${"0".repeat(32)}`, agent.a2a));
    expect(hidden).toEqual(missing);
    expect(missing.status).toBe(404);
  });

  it("answers a room the agent isn't in as the room answers an outsider", async () => {
    const other = (await dash(owner, "POST", "/v1/workspaces", { name: "Not the agent's" })).body.id;
    expect((await reply(await a2aFile(other, "obj_unknown", agent.a2a))).status).toBe(404);
  });

  it("stops working once the agent is disconnected", async () => {
    const gone = await agentOnBoth(owner);
    const version = (await dash(owner, "GET", `/v1/workspaces/${room}`)).body.policy_version;
    await dash(owner, "POST", `/v1/workspaces/${room}/members`, { principal_id: gone.id, kind: "agent", org_id: owner.org, role: "guest", policy_version: version });
    expect((await reply(await a2aFile(room, "obj_unknown", gone.a2a))).status).toBe(404);
    await dash(owner, "POST", `/agents/${gone.id}/disconnect`);
    expect([401, 403]).toContain((await a2aFile(room, "obj_unknown", gone.a2a)).status);
  });
});

describe("serving", () => {
  const identity = { kind: "agent", id: "agt_x", org: "org_x", generation: 1 } as const;
  const fake = (answer: Response) => {
    const seen: string[] = [];
    return { seen, env: { ASSERTION_SIGNING_JWK: e.ASSERTION_SIGNING_JWK, API: { fetch: async (req: Request) => (seen.push(new URL(req.url).pathname), answer) } as unknown as Fetcher } };
  };
  const run = (env: any, path = "/a2a/files/ws_a/obj_b") =>
    handleA2aDownload(new Request(`https://gateway.test${path}`, { headers: { authorization: "Bearer t" } }), new URL(`https://gateway.test${path}`), env, async () => identity, async () => true);

  it("asks the API for the same /v1/files path, and passes only its file headers, no-store, attachment and nosniff", async () => {
    const { seen, env } = fake(new Response("bytes", { headers: {
      "content-type": "text/plain", "content-disposition": 'attachment; filename="a.txt"', "x-content-type-options": "nosniff",
      "cache-control": "no-store", "set-cookie": "x=1", "x-internal": "1",
    } }));
    const res = (await run(env))!;
    expect(seen).toEqual(["/v1/files/ws_a/obj_b"]);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("bytes");
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="a.txt"');
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(res.headers.get("x-internal")).toBeNull();
  });

  it("refuses an answer that isn't an attachment with nosniff", async () => {
    const { env } = fake(new Response("<html>", { headers: { "content-type": "text/html" } }));
    expect((await run(env))!.status).toBe(502);
  });

  it("ignores anything that isn't its path", async () => {
    const { env } = fake(new Response("x"));
    expect(await run(env, "/a2a")).toBeNull();
    expect(await run(env, "/v1/files/ws_a/obj_b")).toBeNull();
  });
});
