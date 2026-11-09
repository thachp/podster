import { env, runInDurableObject, SELF } from "cloudflare:test";
import { importJWK, SignJWT } from "jose";
import { beforeAll, describe, expect, it } from "vitest";

// An agent's participation policy (M4 step 4): on its Principal, invitations only by default, set only by a person who
// administers its organization, audited, reset by a disconnect, and checked before a public claim (decision 159).

const BINDINGS = env as any;
let key: any;
type Who = { id: string; kind?: "agent" | "person"; org: string; adminOrgs?: string[]; gen?: number };
const ORG = "org_pp";
const ADMIN: Who = { id: "per_pp_admin", kind: "person", org: ORG, adminOrgs: [ORG] };
const OTHER_ADMIN: Who = { id: "per_pp_other_admin", kind: "person", org: "org_pp_other", adminOrgs: ["org_pp_other"] };

async function assertion(who: Who) {
  const now = Math.floor(Date.now() / 1000);
  const isAgent = (who.kind ?? "agent") === "agent";
  return new SignJWT({ kind: who.kind ?? "agent", org: who.org, ...(isAgent ? { gen: who.gen ?? 1 } : { orgs: [who.org], admin_orgs: who.adminOrgs ?? [] }) })
    .setProtectedHeader({ alg: "EdDSA", kid: "test" }).setIssuer("podster-gateway").setSubject(who.id).setAudience("podster-api")
    .setIssuedAt(now).setExpirationTime(now + 60).setJti(crypto.randomUUID()).sign(key);
}

async function api(who: Who, method: string, path: string, body?: unknown) {
  const res = await SELF.fetch(`https://api.internal${path}`, {
    method,
    headers: { "x-podster-assertion": await assertion(who), "content-type": "application/json" },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
  const text = await res.text();
  const parsed = text ? JSON.parse(text) : null;
  return { status: res.status, body: parsed, code: parsed?.error?.code, text };
}

let counter = 0;
/** A newly registered agent of ORG, so each test starts from the default. */
async function newAgent(): Promise<Who> {
  const agent: Who = { id: `agt_pp_${++counter}_${crypto.randomUUID().slice(0, 8)}`, org: ORG };
  const res = await api(ADMIN, "PUT", `/v1/agents/${agent.id}`, { org_id: ORG, name: agent.id });
  expect(res.status, res.text).toBe(200);
  return agent;
}

const stub = (agent: Who) => BINDINGS.PRINCIPAL.get(BINDINGS.PRINCIPAL.idFromName(agent.id));
const path = (agent: Who) => `/v1/agents/${agent.id}/participation-policy`;
const setPolicy = (who: Who, agent: Who, body: unknown) => api(who, "PUT", path(agent), body);
const registerRoom = (agent: Who, workspace_id: string, public_claim?: boolean) =>
  stub(agent).fetch("https://principal.internal/internal/register-room", {
    method: "POST",
    body: JSON.stringify({ workspace_id, org_id: ORG, ...(public_claim === undefined ? {} : { public_claim }) }),
  });
const registered = (agent: Who) =>
  runInDurableObject(stub(agent), (_: any, state: any) => state.storage.sql.exec("SELECT workspace_id FROM room_registry").toArray().map((r: any) => r.workspace_id));

beforeAll(async () => {
  key = await importJWK(JSON.parse(BINDINGS.TEST_SIGNING_JWK), "EdDSA");
  for (const statement of BINDINGS.TEST_D1_SCHEMA.split(";").map((x: string) => x.trim()).filter(Boolean)) await BINDINGS.DB.prepare(statement).run();
});

describe("the default", () => {
  it("is invitations only, with nothing stored", async () => {
    const agent = await newAgent();
    expect((await api(agent, "GET", `/v1/agents/${agent.id}`)).body.participation_policy).toBe("invitations_only");
    expect((await api(agent, "GET", "/v1/me")).body.participation_policy).toBe("invitations_only");
    const read = await api(ADMIN, "GET", path(agent));
    expect(read.body).toEqual({ policy: "invitations_only", set_at: null, history: [] });
    // The agent reads it too, without the history.
    expect((await api(agent, "GET", path(agent))).body).toEqual({ policy: "invitations_only", set_at: null });
  });
});

describe("setting it", () => {
  it("is for a person who administers the agent's organization, and is audited", async () => {
    const agent = await newAgent();
    const set = await setPolicy(ADMIN, agent, { policy: "public_claims" });
    expect(set.status, set.text).toBe(200);
    expect(set.body.policy).toBe("public_claims");
    expect(typeof set.body.set_at).toBe("number");
    expect((await api(agent, "GET", `/v1/agents/${agent.id}`)).body.participation_policy).toBe("public_claims");
    const back = await setPolicy(ADMIN, agent, { policy: "invitations_only" });
    expect(back.body.policy).toBe("invitations_only");
    const history = (await api(ADMIN, "GET", path(agent))).body.history;
    expect(history.map((h: any) => [h.prior, h.policy, h.actor_id, h.reason])).toEqual([
      ["public_claims", "invitations_only", ADMIN.id, "owner.set"],
      ["invitations_only", "public_claims", ADMIN.id, "owner.set"],
    ]);
  });

  it("is refused to the agent itself, another organization's admin and a non-admin person", async () => {
    const agent = await newAgent();
    expect((await setPolicy(agent, agent, { policy: "public_claims" })).code).toBe("not_allowed");
    expect((await setPolicy(OTHER_ADMIN, agent, { policy: "public_claims" })).code).toBe("agent_not_found");
    const member: Who = { id: "per_pp_member", kind: "person", org: ORG, adminOrgs: [] };
    expect((await setPolicy(member, agent, { policy: "public_claims" })).code).toBe("agent_not_found");
    expect((await api(OTHER_ADMIN, "GET", path(agent))).code).toBe("agent_not_found");
    expect((await api(ADMIN, "GET", path(agent))).body.policy).toBe("invitations_only");
  });

  it("takes only a known policy and nothing else", async () => {
    const agent = await newAgent();
    for (const body of [{}, { policy: "PUBLIC_CLAIMS" }, { policy: "anyone" }, { policy: 1 }, { policy: "public_claims", scopes: "all" }, "not json", []]) {
      expect((await setPolicy(ADMIN, agent, body)).code, JSON.stringify(body)).toBe("invalid_argument");
    }
    expect((await api(ADMIN, "GET", path(agent))).body).toMatchObject({ policy: "invitations_only", history: [] });
  });

  it("keeps the newest 200 audit rows", async () => {
    const agent = await newAgent();
    for (let n = 0; n < 205; n++) await setPolicy(ADMIN, agent, { policy: n % 2 ? "invitations_only" : "public_claims" });
    const history = (await api(ADMIN, "GET", path(agent))).body.history;
    expect(history.length).toBe(200);
    expect(history[0].policy).toBe("public_claims");
  });
});

describe("disconnecting", () => {
  it("resets it to invitations only, and nothing can be set until reconnected", async () => {
    const agent = await newAgent();
    await setPolicy(ADMIN, agent, { policy: "public_claims" });
    const off = await api(ADMIN, "POST", `/v1/agents/${agent.id}/disconnect`);
    expect(off.status, off.text).toBe(200);
    const read = await api(ADMIN, "GET", path(agent));
    expect(read.body.policy).toBe("invitations_only");
    expect(read.body.history[0]).toMatchObject({ prior: "public_claims", policy: "invitations_only", actor_id: "system", reason: "disconnect" });
    expect((await setPolicy(ADMIN, agent, { policy: "public_claims" })).code).toBe("agent_disconnected");
    expect(await api(ADMIN, "POST", `/v1/agents/${agent.id}/reconnect`)).toMatchObject({ status: 200 });
    expect((await api(ADMIN, "GET", path(agent))).body.policy).toBe("invitations_only");
  });

  it("writes nothing for an agent that never allowed public claims", async () => {
    const agent = await newAgent();
    expect((await api(ADMIN, "POST", `/v1/agents/${agent.id}/disconnect`)).status).toBe(200);
    expect((await api(ADMIN, "GET", path(agent))).body.history).toEqual([]);
  });
});

describe("registering a room for a public claim", () => {
  it("is refused until the owner allows public claims, and records nothing when refused", async () => {
    const agent = await newAgent();
    const refused = await registerRoom(agent, "ws_pp_public", true);
    expect(refused.status).toBe(403);
    expect(((await refused.json()) as any).error.code).toBe("public_claims_not_allowed");
    expect(await registered(agent)).toEqual([]);

    await setPolicy(ADMIN, agent, { policy: "public_claims" });
    expect((await registerRoom(agent, "ws_pp_public", true)).status).toBe(200);
    expect(await registered(agent)).toEqual(["ws_pp_public"]);
  });

  it("doesn't change an invited join, which works under either policy", async () => {
    const agent = await newAgent();
    expect((await registerRoom(agent, "ws_pp_invited", false)).status).toBe(200);
    expect((await registerRoom(agent, "ws_pp_old_caller")).status).toBe(200);
    expect(await registered(agent)).toEqual(expect.arrayContaining(["ws_pp_invited", "ws_pp_old_caller"]));
  });
});

describe("people who don't administer the agent's organization now", () => {
  it("refuses an admin who left the organization, a demoted admin, a guest from another organization and another agent", async () => {
    const agent = await newAgent();
    const sibling = await newAgent();
    // The gateway builds each assertion from current memberships, so someone who left only administers their personal
    // organization now, and a demoted admin is a plain member.
    const departed: Who = { id: "per_pp_departed", kind: "person", org: "org_pp_departed_personal", adminOrgs: ["org_pp_departed_personal"] };
    const demoted: Who = { id: "per_pp_demoted", kind: "person", org: ORG, adminOrgs: [] };
    // A person from an invited organization who shares a room with the agent: a room grants nothing over an agent.
    const guest: Who = { id: "per_pp_guest", kind: "person", org: "org_pp_guest", adminOrgs: ["org_pp_guest"] };
    for (const who of [departed, demoted, guest, sibling]) {
      expect((await setPolicy(who, agent, { policy: "public_claims" })).code, who.id).toBe("agent_not_found");
      expect((await api(who, "GET", path(agent))).code, who.id).toBe("agent_not_found");
    }
    expect((await api(ADMIN, "GET", path(agent))).body).toMatchObject({ policy: "invitations_only", history: [] });
  });
});

describe("a disconnect while a set's body is still arriving", () => {
  /** A PUT straight to the agent's Principal with its body held open, while `meanwhile` runs, then the body finishes. */
  async function setWhile(agent: Who, meanwhile: () => Promise<void>) {
    let finish: (() => void) | undefined;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        finish = () => {
          controller.enqueue(new TextEncoder().encode(JSON.stringify({ policy: "public_claims" })));
          controller.close();
        };
      },
    });
    const pending = stub(agent).fetch(`https://principal.internal${path(agent)}`, {
      method: "PUT",
      headers: { "x-podster-caller": JSON.stringify({ id: ADMIN.id, kind: "person", org: ORG, orgs: [ORG], admin_orgs: [ORG] }) },
      body: stream,
      duplex: "half",
    } as RequestInit);
    await new Promise((resolve) => setTimeout(resolve, 50));
    await meanwhile();
    finish?.();
    const res = await pending;
    return { status: res.status, body: (await res.json()) as any };
  }

  const disconnect = async (agent: Who) => {
    const off = await api(ADMIN, "POST", `/v1/agents/${agent.id}/disconnect`);
    expect(off.status, off.text).toBe(200);
  };
  const reconnect = async (agent: Who) => expect(await api(ADMIN, "POST", `/v1/agents/${agent.id}/reconnect`)).toMatchObject({ status: 200 });

  it("refuses the set, so no consent survives the reconnect", async () => {
    const agent = await newAgent();
    const res = await setWhile(agent, () => disconnect(agent));
    expect(res.body.error?.code).toBe("agent_disconnected");
    await reconnect(agent);
    const read = await api(ADMIN, "GET", path(agent));
    expect(read.body.policy).toBe("invitations_only");
    expect(read.body.history).toEqual([]);
  });

  it("refuses it when the agent was disconnected and reconnected while it arrived", async () => {
    const agent = await newAgent();
    const res = await setWhile(agent, async () => {
      await disconnect(agent);
      await reconnect(agent);
    });
    expect(res.body.error?.code).toBe("agent_disconnected");
    expect((await api(ADMIN, "GET", path(agent))).body.policy).toBe("invitations_only");
  });

  it("still sets it when nothing changed meanwhile", async () => {
    const agent = await newAgent();
    const res = await setWhile(agent, async () => {});
    expect(res.status).toBe(200);
    expect(res.body.policy).toBe("public_claims");
  });
});
