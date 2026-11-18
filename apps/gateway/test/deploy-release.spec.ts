import { env } from "cloudflare:test";
import { decodeJwt } from "jose";
import { beforeAll, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { CAPABILITIES, capabilitiesFor, RELEASE_ROUTES_FAILURE_TTL_MS, RELEASE_ROUTES_PATH, RELEASE_ROUTES_TTL_MS, releaseRoutesAnswered, toApiCall } from "../src/capabilities";
import { A2A_CAPABILITIES, LIFECYCLE_METHODS } from "../src/a2a/lifecycle";
import worker, { a2aCapability, isPublicAuthRoute, type Env } from "../src/index";
import { agentOnBoth, BASE, mcpTool, setUpSchemas, signUp, type Person } from "./oauth-helpers";

/**
 * M6 step 6, 6g: an agent asks for a release, the `deploy_release` capability, as an MCP tool and the A2A lifecycle
 * method `DeployRelease`. Both reach `requestRelease` and nothing else, and both exist only while the API itself says it
 * answers the release routes (`/release-routes`), read from the API, never from a variable of the gateway's own. The room
 * decides every call (`apps/api/test/release-agent.spec.ts` shows it on the real rows); here a stand-in API answers one
 * state, MCP and A2A each ask it, and the test compares what each sent and what each answered.
 */

type Agent = Awaited<ReturnType<typeof agentOnBoth>>;
const e = env as unknown as Env & { TEST_CAPABILITIES: string; TEST_GATEWAY_SOURCES: string };
const URI = "https://podster.dev/a2a/lifecycle/v1";
const ON = { "A2A-Extensions": URI };
const METHOD = "podster.lifecycle.v1.DeployRelease";
const reason = (body: any) => body?.error?.data?.[0]?.reason as string | undefined;
const codeOf = (body: any) => body?.error?.data?.[0]?.metadata?.code as string | undefined;
const key = () => crypto.randomUUID();
const hex = () => crypto.randomUUID().replace(/-/g, "");
const ctx = { waitUntil() {}, passThroughOnException() {} } as never;
const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const refusalOf = (status: number, code: string) => reply(status, { error: { code, message: code } });

const WS = `ws_${hex()}`;
const TASK = `tsk_${hex()}`;
const SHA = "c".repeat(40);
const RELEASE = { id: `rel_${hex()}`, commit_sha: SHA, environment: "production", state: "awaiting_approval", requested_by: "agt_x", requested_at: 1, approved_by: null, approved_at: null, declined_by: null, declined_at: null, result_url: null, failure_code: null, finished_at: null, rollback_to: null };

/**
 * A stand-in API. `routes` is how it answers the gateway's read of whether it answers the release routes; every other
 * request is recorded and answered by `answer`.
 */
function standIn(answer: (method: string, path: string) => Response, routes: () => Response = () => reply(200, { answered: true })) {
  const seen: { method: string; path: string; body: string; key: string | null; sub: string | undefined }[] = [];
  const asked: string[] = [];
  const api = {
    fetch: async (request: Request) => {
      const url = new URL(request.url);
      if (url.pathname === RELEASE_ROUTES_PATH) {
        asked.push(request.method);
        // No assertion: the read names no one.
        expect(request.headers.get("x-podster-assertion")).toBeNull();
        return routes();
      }
      const assertion = request.headers.get("x-podster-assertion");
      seen.push({ method: request.method, path: url.pathname + url.search, body: await request.text(), key: request.headers.get("idempotency-key"), sub: assertion ? decodeJwt(assertion).sub : undefined });
      return answer(request.method, url.pathname);
    },
  } as unknown as Fetcher;
  return { seen, asked, env: { ...e, API: api } };
}

async function viaMcp(token: string, name: string, args: Record<string, unknown>, environment: object) {
  const res = await worker.fetch(new Request(`${BASE}/mcp`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) }), environment as never, ctx);
  const parsed = await res.json<any>();
  const text = parsed.result?.content?.[0]?.text;
  return parsed.result?.isError ? { code: text as string, data: undefined as any, raw: parsed } : { code: undefined, data: text ? JSON.parse(text) : undefined, raw: parsed };
}
async function tools(token: string, environment: object) {
  const res = await worker.fetch(new Request(`${BASE}/mcp`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) }), environment as never, ctx);
  return ((await res.json<any>()).result.tools as { name: string }[]).map((t) => t.name);
}
async function viaA2a(token: string, method: string, params: unknown, environment: object, headers: Record<string, string> = ON) {
  const res = await worker.fetch(new Request(`${BASE}/a2a`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "A2A-Version": "1.0", ...headers }, body: JSON.stringify({ jsonrpc: "2.0", id: 9, method, params }) }), environment as never, ctx);
  return { res, body: await res.json<any>() };
}
const card = async (environment: object) => (await (await worker.fetch(new Request(`${BASE}/.well-known/agent-card.json`), environment as never, ctx)).json<any>()).capabilities.extensions[0].params.methods as string[];

let owner: Person;
let agent: Agent;
beforeAll(async () => {
  await setUpSchemas();
  owner = await signUp();
  agent = await agentOnBoth(owner);
});

describe("deploy_release is listed only while the API answers the release routes", () => {
  it("is a tool, a method on the card, and an A2A method only on the API's own exact yes", async () => {
    const on = standIn(() => reply(200, RELEASE));
    expect(await tools(agent.mcp, on.env)).toContain("deploy_release");
    expect(await card(on.env)).toContain(METHOD);
    // Every other answer is no: off, a value that isn't exactly true, a body of another shape, an error, no answer.
    const noes: [string, () => Response][] = [
      ["answered false", () => reply(200, { answered: false })],
      ["answered \"true\"", () => reply(200, { answered: "true" })],
      ["answered 1", () => reply(200, { answered: 1 })],
      ["no field", () => reply(200, {})],
      ["not JSON", () => new Response("true", { status: 200 })],
      ["a 404", () => refusalOf(404, "not_found")],
      ["a 500 saying yes", () => reply(500, { answered: true })],
      ["a throw", () => { throw new Error("down"); }],
    ];
    for (const [why, routes] of noes) {
      const off = standIn(() => reply(200, RELEASE), routes);
      expect(await tools(agent.mcp, off.env), why).not.toContain("deploy_release");
      expect(await card(off.env), why).not.toContain(METHOD);
      // Called by name, it answers as a tool or a method that doesn't exist, and nothing reaches the API's routes.
      const overMcp = await viaMcp(agent.mcp, "deploy_release", { workspace_id: WS, task_id: TASK, commit_sha: SHA, idempotency_key: key() }, off.env);
      expect(overMcp.raw.result?.isError ?? Boolean(overMcp.raw.error), why).toBe(true);
      for (const headers of [ON, {}]) {
        const asked = await viaA2a(agent.a2a, METHOD, { id: `${WS}:${TASK}`, commitSha: SHA, requestId: key() }, off.env, headers);
        const none = await viaA2a(agent.a2a, "podster.lifecycle.v1.NoSuchMethod", { id: `${WS}:${TASK}` }, off.env, headers);
        expect(asked.body, why).toEqual(none.body);
        expect(asked.body.error, why).toEqual({ code: -32601, message: "Method not found" });
      }
      expect(off.seen, why).toEqual([]);
      // The control: the API was asked whether it answers them, so a gateway that didn't ask would have listed nothing too.
      expect(off.asked.length, why).toBeGreaterThan(0);
    }
  });

  it("is an Agent Auth capability on the same yes, and only then", async () => {
    const listed = async (environment: object) => {
      const res = await worker.fetch(new Request(`${BASE}/api/auth/capability/list`), environment as never, ctx);
      expect(res.status).toBe(200);
      return JSON.stringify(await res.json());
    };
    expect(await listed(standIn(() => reply(200, RELEASE)).env)).toContain("deploy_release");
    for (const routes of [() => reply(200, { answered: false }), () => refusalOf(500, "internal_error")]) {
      const off = standIn(() => reply(200, RELEASE), routes);
      const list = await listed(off.env);
      expect(list).not.toContain("deploy_release");
      // The control: the list is there, with the other capabilities in it.
      expect(list).toContain("get_task");
    }
  });

  it("reads the real API, which answers the release routes nowhere today, so no agent is offered a deploy tool", async () => {
    expect(await tools(agent.mcp, e)).not.toContain("deploy_release");
    expect(await card(e)).not.toContain(METHOD);
    // The gateway has no variable of its own for this: setting one changes nothing.
    expect(await tools(agent.mcp, { ...e, RELEASES: "true" })).not.toContain("deploy_release");
    expect((await mcpTool(agent.mcp, "deploy_release", { workspace_id: WS, task_id: TASK, commit_sha: SHA, idempotency_key: key() })).code).toBeDefined();
  });

  it("names only the room, the task and the commit, and reaches requestRelease alone", () => {
    expect(capabilitiesFor({}).map((c) => c.name)).not.toContain("deploy_release");
    expect(capabilitiesFor({}, { releases: true }).map((c) => c.name)).toContain("deploy_release");
    const deploy = capabilitiesFor({}, { releases: true }).find((c) => c.name === "deploy_release")!;
    expect([deploy.kind, deploy.method, deploy.path, deploy.idempotent ?? false, Object.keys(deploy.fields ?? {})]).toEqual(["command", "POST", "/v1/workspaces/{workspace_id}/releases", false, ["workspace_id", "task_id", "commit_sha"]]);
    // Nothing else an agent sends reaches the API: not an environment, an approver, a label or a script.
    expect(toApiCall(deploy, { workspace_id: "w", task_id: "t", commit_sha: SHA, environment: "staging", approved_by: "per_x", label: "l", idempotency_key: "k" })).toEqual({ method: "POST", path: "/v1/workspaces/w/releases", body: JSON.stringify({ task_id: "t", commit_sha: SHA }), idempotencyKey: "k" });
    // The contract says the same: one capability, a command, reaching requestRelease, and on /a2a as DeployRelease.
    const contract = parse(e.TEST_CAPABILITIES);
    expect(contract.capabilities.deploy_release).toEqual({ kind: "command", operation: "requestRelease" });
    expect(contract.a2a[METHOD]).toBe("deploy_release");
    expect(LIFECYCLE_METHODS[METHOD]).toBe("deploy_release");
    expect(A2A_CAPABILITIES as readonly string[]).toContain("deploy_release");
    // No other capability reaches a release.
    expect(CAPABILITIES.filter((c) => /\/releases(\/|$)/.test(c.path)).map((c) => c.name)).toEqual(["deploy_release"]);
    // An /a2a token reaches it only while it's listed.
    expect(() => a2aCapability({}, "deploy_release")).toThrow();
    expect(a2aCapability({}, "deploy_release", { releases: true }).name).toBe("deploy_release");
  });
});

describe("DeployRelease over A2A asks what MCP's deploy_release asks, and answers alike", () => {
  const both = async (answer: () => Response) => {
    const mcp = standIn(answer);
    const a2aSide = standIn(answer);
    const requestId = key();
    const overMcp = await viaMcp(agent.mcp, "deploy_release", { workspace_id: WS, task_id: TASK, commit_sha: SHA, idempotency_key: `a2a-lc:${requestId}` }, mcp.env);
    const overA2a = await viaA2a(agent.a2a, METHOD, { id: `${WS}:${TASK}`, commitSha: SHA, requestId }, a2aSide.env);
    return { overMcp, overA2a, mcpSeen: mcp.seen, a2aSeen: a2aSide.seen, requestId };
  };

  it("sends the same request and gives the same release", async () => {
    const { overMcp, overA2a, mcpSeen, a2aSeen, requestId } = await both(() => reply(200, RELEASE));
    expect(overMcp.data).toEqual(RELEASE);
    expect(overA2a.body.result).toEqual(RELEASE);
    expect(overA2a.res.headers.get("A2A-Extensions")).toBe(URI);
    expect(a2aSeen).toEqual(mcpSeen);
    expect(a2aSeen).toEqual([{ method: "POST", path: `/v1/workspaces/${WS}/releases`, body: JSON.stringify({ task_id: TASK, commit_sha: SHA }), key: `a2a-lc:${requestId}`, sub: agent.id }]);
  });

  it("answers every refusal the room gives with MCP's code, and a task the agent can't act on as a missing one", async () => {
    const named: [number, string][] = [
      [403, "agent_not_connected"], [403, "public_participant"], [403, "grant_required"], [403, "grant_expired"], [403, "grant_stale"],
      [409, "release_off_for_deployment"], [409, "release_not_delegated"], [409, "release_needs_public_room"], [409, "workspace_archived"], [409, "public_surface_suspended"], [409, "app_suspended"], [409, "repo_not_ready"], [409, "release_off"],
      [409, "commit_not_releasable"], [409, "reviewer_rule_changed"], [409, "no_releaser"], [409, "release_pending"], [429, "release_limit"], [409, "release_not_available"],
      [404, "not_found"], [400, "invalid_argument"], [422, "idempotency_mismatch"],
    ];
    for (const [status, code] of named) {
      const { overMcp, overA2a, mcpSeen, a2aSeen } = await both(() => refusalOf(status, code));
      expect([overMcp.code, codeOf(overA2a.body)], code).toEqual([code, code]);
      expect(reason(overA2a.body), code).toBe(["invalid_argument", "idempotency_mismatch"].includes(code) ? "INVALID_PARAMS" : "UNSUPPORTED_OPERATION");
      expect(a2aSeen, code).toEqual(mcpSeen);
    }
    for (const [status, code] of [[404, "task_not_found"], [404, "workspace_not_found"], [403, "not_allowed"], [403, "access_revoked"], [403, "agent_disconnected"]] as const) {
      const { overMcp, overA2a } = await both(() => refusalOf(status, code));
      expect([overMcp.code, reason(overA2a.body), codeOf(overA2a.body)], code).toEqual([code, "TASK_NOT_FOUND", undefined]);
    }
    for (const [status, code] of [[429, "rate_limited"], [503, "standing_unknown"], [502, "upstream_unavailable"]] as const) {
      const { overMcp, overA2a } = await both(() => refusalOf(status, code));
      expect([overMcp.code, overA2a.body.error.code, overA2a.body.error.message, codeOf(overA2a.body)], code).toEqual([code, -32603, "Internal error", code]);
    }
  });

  it("passes on only the contract's fields, and a body of another shape is an internal error", async () => {
    const extra = await both(() => reply(200, { ...RELEASE, label: "secretlabel", script_name: "s" }));
    expect(extra.overA2a.body.result).toEqual(RELEASE);
    const broken = await both(() => reply(200, { id: RELEASE.id }));
    expect(broken.overA2a.body.error).toEqual({ code: -32603, message: "Internal error" });
  });

  it("takes the task, the commit and a requestId, and nothing else; refuses the extension unnamed; and asks nothing then", async () => {
    const quiet = standIn(() => reply(200, RELEASE));
    for (const extra of [{ environment: "production" }, { approvedBy: "per_x" }, { label: "l" }, { tenant: "x" }]) {
      expect(reason((await viaA2a(agent.a2a, METHOD, { id: `${WS}:${TASK}`, commitSha: SHA, requestId: key(), ...extra }, quiet.env)).body), JSON.stringify(extra)).toBe("INVALID_PARAMS");
    }
    for (const params of [{ id: `${WS}:${TASK}`, requestId: key() }, { id: `${WS}:${TASK}`, commitSha: 7, requestId: key() }, { id: `${WS}:${TASK}`, commitSha: SHA }, { id: `${WS}:${TASK}`, commitSha: SHA, requestId: "has space" }]) {
      expect(reason((await viaA2a(agent.a2a, METHOD, params, quiet.env)).body), JSON.stringify(params)).toBe("INVALID_PARAMS");
    }
    for (const id of ["not-an-id", undefined]) expect(reason((await viaA2a(agent.a2a, METHOD, { id, commitSha: SHA, requestId: key() }, quiet.env)).body), String(id)).toBe("TASK_NOT_FOUND");
    expect(reason((await viaA2a(agent.a2a, METHOD, { id: `${WS}:${TASK}`, commitSha: SHA, requestId: key() }, quiet.env, {})).body)).toBe("EXTENSION_SUPPORT_REQUIRED");
    expect(quiet.seen).toEqual([]);
  });
});

describe("the gateway's read of whether the API answers the release routes is cached per isolate", () => {
  /** A fake API that counts its reads and answers what `next` says; the test moves the clock. */
  const fake = (next: () => Response | Promise<Response>) => {
    const counted = { reads: 0 };
    const api = { fetch: async () => { counted.reads++; return next(); } };
    return { api, counted };
  };

  it("keeps a clean answer for its time, then reads again", async () => {
    let now = 1_000_000;
    const clock = () => now;
    let answer = true;
    const { api, counted } = fake(() => reply(200, { answered: answer }));
    expect(await releaseRoutesAnswered(api, clock)).toBe(true);
    answer = false;
    now += RELEASE_ROUTES_TTL_MS - 1;
    expect(await releaseRoutesAnswered(api, clock)).toBe(true);
    expect(counted.reads).toBe(1);
    now += 1;
    expect(await releaseRoutesAnswered(api, clock)).toBe(false);
    expect(counted.reads).toBe(2);
  });

  it("keeps a failed read as no for a shorter time, and shares a read in flight", async () => {
    let now = 5_000_000;
    const clock = () => now;
    let fail = true;
    const { api, counted } = fake(() => (fail ? reply(500, { answered: true }) : reply(200, { answered: true })));
    expect(await releaseRoutesAnswered(api, clock)).toBe(false);
    fail = false;
    now += RELEASE_ROUTES_FAILURE_TTL_MS - 1;
    expect(await releaseRoutesAnswered(api, clock)).toBe(false);
    expect(counted.reads).toBe(1);
    now += 1;
    expect(await releaseRoutesAnswered(api, clock)).toBe(true);
    expect(counted.reads).toBe(2);
    expect(RELEASE_ROUTES_FAILURE_TTL_MS).toBeLessThan(RELEASE_ROUTES_TTL_MS);
    // Many requests at once, before the first read answers: one read.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const slow = fake(async () => { await gate; return reply(200, { answered: true }); });
    const asked = Array.from({ length: 20 }, () => releaseRoutesAnswered(slow.api, clock));
    release();
    expect(await Promise.all(asked)).toEqual(Array(20).fill(true));
    expect(slow.counted.reads).toBe(1);
  });

  it("asks the API once for many card reads in an isolate", async () => {
    const stand = standIn(() => reply(200, RELEASE));
    for (let n = 0; n < 10; n++) expect(await card(stand.env)).toContain(METHOD);
    expect(stand.asked.length).toBe(1);
  });
});

describe("an agent's link ends only by a disconnect, which moves its generation (the recheck relies on it)", () => {
  /** Each place in `source` matching `pattern`, by the function it's in: the nearest `function name(` or `const name =` above it. */
  const sites = (source: string, pattern: RegExp) => {
    const found: string[] = [];
    for (const match of source.matchAll(pattern)) {
      const before = source.slice(0, match.index);
      const last = [...before.matchAll(/(?:function\s+(\w+)\s*\(|^(?:export\s+)?const\s+(\w+)\s*=|^\/\/ FILE: (\S+))/gm)].at(-1);
      found.push(last ? (last[1] ?? last[2] ?? `top of ${last[3]}`) : "top");
    }
    return found.sort();
  };
  const ENDS_A_LINK = /DELETE\s+FROM\s+(identity_link|agent|agentCapabilityGrant)\b|UPDATE\s+identity_link\b|SET\s+status\s*=\s*'revoked'|\.revokeGrant\(/gi;

  it("ends links and credentials only in the disconnect's cleanup, which only the disconnect and a reconnect after one call", () => {
    const source = e.TEST_GATEWAY_SOURCES;
    expect(source).toContain("// FILE: index.ts");
    // Ending links and credentials: the cleanup alone. Two exceptions, each keeping the link: renewing a link after its
    // person left and rejoined only moves its start later, which the departure read from the recorded start catches;
    // consent replaces an OAuth grant of the same link with a new one; and the scheduled clean-up removes plugin agents
    // that nobody ever claimed, which have no link (`status = 'pending' AND userId IS NULL`); and a Runner pairing that ends
    // (M7 step 5(b), rulings M1 and M2) revokes its plugin host and the agents on it that no link names (`revokeHost`).
    expect(sites(source, ENDS_A_LINK)).toEqual(["approveConsent", "cleanUp", "renewLink", "revokeCredentials", "revokeCredentials", "revokeCredentials", "revokeCredentials", "revokeHost", "revokeHost"]);
    expect(source).toMatch(/WHERE hostId = \? AND id NOT IN \(SELECT external_id FROM identity_link WHERE provider = 'agent_auth'\)/);
    expect(source).toMatch(/SELECT id FROM agent WHERE status = 'pending' AND userId IS NULL/);
    // The cleanup is called only by `handleConnection`: after the API's disconnect moved the generation, and before a
    // reconnect of an agent the API already shows disconnected.
    expect(sites(source, /(?<!function\s)\brevokeCredentials\(/g)).toEqual(["handleConnection", "handleConnection"]);
    // The plugin's own routes that would revoke an agent, a host or a key aren't reachable.
    for (const route of ["/agent/revoke", "/host/revoke", "/agent/rotate-key", "/host/rotate-key", "/agent/reactivate"]) expect(isPublicAuthRoute(route), route).toBe(false);
  });

  it("would see a link ended anywhere else (the control)", () => {
    const planted = `// FILE: x.ts\nasync function forgetOneLink(env) { await env.DB.prepare("DELETE FROM identity_link WHERE external_id = ?").run(); }\nconst dropKey = (env) => env.DB.prepare("UPDATE agent SET status = 'revoked' WHERE id = ?");\n`;
    expect(sites(planted, ENDS_A_LINK)).toEqual(["dropKey", "forgetOneLink"]);
  });
});
