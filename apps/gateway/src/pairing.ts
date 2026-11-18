/**
 * Runner pairing, the gateway's half (M7 step 5(b); decision 222; the M7 plan's rulings P1 and P2). The gateway
 * authenticates and translates; the pairing session on the new agent's Principal decides (step 5(a)).
 *
 * - **Start** (`POST /api/pairing`, the person's session, our own origin): the Agent Auth plugin's `createHost` with no
 *   key and Runner's fixed allowlist, then the API's `startPairing` with the organization the person acts in, that host
 *   and its one-time enrollment token as the code. None of those come from the client: its body may hold a `name` and
 *   nothing else. Each person's starts are counted exactly before any host is made, failing closed. The agent's ID and
 *   the code go back in the response body, never in a URL. A refused start retires the host it made, so no usable token
 *   is left behind.
 * - **Read, cancel, activate** (`/api/pairing/{agent}…`): the person's own, through these handlers only. The dashboard's
 *   passthrough refuses every `/v1/pairing` path (`allowedPassthrough`). Whenever one of them finds the session canceled,
 *   expired or locked, the session's plugin host is ended: retired if it still waits, and revoked with its agents if it
 *   holds the session's key (ruling M1). An expired session nobody touches has its host ended by the sweep below.
 * - **Redeem** (`POST /pairing/{agent}/redeem`, the gateway's own host, no session): Runner's code, with a host JWT
 *   (`typ: host+jwt`, EdDSA) signed by the key it carries as `host_public_key`, naming the session's agent as its subject
 *   and the gateway as its audience, with its own `jti`, and expiring at most 300 seconds ahead. A per-network limiter
 *   counts first and refuses when it can't count. A key any plugin host already holds is refused, unless this session's
 *   own host took it on an earlier try. Then the API's `redeemPairing`, under the `pairing_redeem` assertion that names
 *   the session, the key's RFC 7638 thumbprint, the proof's ID and expiry and the SHA-256 of the exact body sent. Only
 *   after its 200 does the plugin's `enrollHost` bind the key to that session's host, so a retry after a lost answer,
 *   with a fresh proof, finds the host already holding the key and answers the same. After enrolling, exactly one host
 *   must hold the key, the session's own; otherwise every host holding it is revoked, the session is canceled through
 *   the API as its starter, and Runner is refused (ruling M2). A redeemed session whose host can't take the key is
 *   canceled the same way, so it can never be activated.
 *
 * - **Confirm and link** (M7 step 5(c)): `…/activate` reads what the plugin holds for the session's own host (its owner,
 *   state, key, how many hosts hold that key, and its agents) and sends those facts with the person's thumbprint. The API
 *   decides by the binding rule and, in one transaction, activates the session and records the one plugin agent it links.
 *   Only then does the directory get `podster_agent` and `identity_link`, as the claim writes them after `registerAgent`,
 *   so the agent shows in its organization and can act within its host's capabilities, Runner's allowlist.
 * - **Sweep** (M7 step 5(c)): the cron asks the API, as the owner of each plugin host no link uses, for that person's
 *   sessions past their expiry, ends the host of each that wasn't activated, and settles them.
 *
 * The plugin's own `/host/*` routes stay private. Logs carry IDs and fixed outcomes only: never a code, a proof or a key.
 */
import { calculateJwkThumbprint, decodeJwt, decodeProtectedHeader, importJWK, jwtVerify } from "jose";
import { mintPairingRedeem, type Identity } from "./assertion";
import { capabilitiesFor } from "./capabilities";
import { callApi, clientKey, createAgent, createAuth, denied, json, linkOnce, personIdentity, rateLimited, withinLimit, type Env } from "./index";

/**
 * The plugin host's default capabilities for Runner's agent (decision 230): what it uses, and never `merge_task`,
 * `deploy_release` or anything that makes or assigns work. `get_repo_access` is withheld until step 10's repository path
 * brings it back under its own rules (ruled 2026-11-18, L1): a contents-write token can commit straight to the default
 * branch where rulesets aren't available, which amounts to merging. These are a budget, not a ceiling: anything more goes
 * through the person's claim. A capability this deployment doesn't list is left out.
 */
export const RUNNER_CAPABILITIES = [
  "get_identity", "list_workspaces", "get_workspace", "get_workroom_brief", "list_activity", "read_inbox", "ack_inbox", "list_tasks", "get_task",
  "accept_task", "decline_task", "release_task", "send_message", "list_messages", "submit_task", "create_upload", "get_asset_link", "list_assets",
] as const;

/** Redemptions one network may make, per minute and per day, counted exactly. */
export const REDEEM_PER_MINUTE = 10;
export const REDEEM_PER_DAY = 100;
/** Starts one person may make, per minute and per day, counted exactly before any plugin host is made. The API's own
 * count, 5 an hour, still decides; this only keeps refused starts from making host rows. */
export const START_PER_MINUTE = 5;
export const START_PER_DAY = 30;
/** The furthest ahead a proof may expire, in seconds, as `podster_assertion::MAX_PROOF_LIFETIME_SECS` requires. */
const MAX_PROOF_SECONDS = 300;
const CLOCK_SKEW_SECONDS = 5;
const MAX_PROOF_JTI_BYTES = 128;
const MAX_JWT_BYTES = 4096;
const MAX_BODY_BYTES = 1024;
const MAX_NAME_BYTES = 200;
/** As `podster_core::pairing::MAX_HOST_AGENTS`: more agents than this on a host is never one to link. */
const MAX_HOST_AGENTS = 5;
const API_TIMEOUT_MS = 25_000;
const DEFAULT_HOST_NAME = "Runner";

const ID = "[A-Za-z0-9_-]{1,128}";
const REDEEM_PATH = new RegExp(`^/pairing/(${ID})/redeem$`);
const PERSON_PATH = new RegExp(`^/api/pairing(?:/(${ID})(?:/(cancel|activate))?)?$`);
const CODE = /^[A-Za-z0-9_-]{32,128}$/;
const BASE64URL_32 = /^[A-Za-z0-9_-]{43}$/;
const KEY_MEMBERS = new Set(["kty", "crv", "x", "kid", "alg", "use"]);

const noStore = (response: Response) => {
  response.headers.set("cache-control", "no-store");
  return response;
};
const logAt = (at: string, agent: string | undefined, outcome: string) => console.log(JSON.stringify({ at, ...(agent === undefined ? {} : { agent }), outcome }));
const log = (agent: string, outcome: string) => logAt("pairing.redeem", agent, outcome);
const hex = (bytes: ArrayBuffer) => [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
const base64url = (bytes: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const digest = (value: string) => crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

/** Reads at most `limit` bytes, as the stream arrives, so a chunked body has a bound too. */
async function boundedText(request: Request, limit: number): Promise<string | null> {
  if (Number(request.headers.get("content-length") ?? 0) > limit) return null;
  const reader = request.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = reader ? await reader.read() : { done: true as const, value: undefined };
    if (done || !value) break;
    size += value.length;
    if (size > limit) {
      await reader?.cancel();
      return null;
    }
    chunks.push(value);
  }
  const body = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    body.set(chunk, at);
    at += chunk.length;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(body);
  } catch {
    return null;
  }
}

/** A JSON object whose members are all among `allowed`, or null. An empty body is `{}`. */
async function objectBody(request: Request, allowed: string[]): Promise<Record<string, unknown> | null> {
  const text = await boundedText(request, MAX_BODY_BYTES);
  if (text === null) return null;
  if (text.trim() === "") return {};
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isObject(body) || Object.keys(body).some((key) => !allowed.includes(key))) return null;
  return body;
}

/** The plugin keeps an enrollment token as the base64url SHA-256 of its text. */
const pluginTokenHash = async (code: string) => base64url(await digest(code));

/** Retires a plugin host still waiting for enrollment, so its token can never be used. One already enrolled is left. */
const retireHost = (env: Env, id: string) =>
  env.DB.prepare(`UPDATE agentHost SET status = 'rejected', enrollmentTokenHash = NULL, enrollmentTokenExpiresAt = NULL, updatedAt = ? WHERE id = ? AND status = 'pending_enrollment'`).bind(new Date().toISOString(), id).run();

/**
 * Revokes a plugin host that holds a key, and its unlinked agents, and takes the key off them, so neither can act and the
 * key can pair again. Before step 5(c) no agent on a pairing host is linked; once (c) links one, ending it is (c)'s, through
 * the disconnect. `holds` names the key: by thumbprint only (the session's own host, M1), or by its public part too (M2).
 */
async function revokeHost(env: Env, id: string, thumbprint: string, x?: string) {
  const now = new Date().toISOString();
  const holds = x === undefined ? `kid = ?` : `(kid = ? OR instr(publicKey, ?) > 0)`;
  const key = x === undefined ? [thumbprint] : [thumbprint, `"x":"${x}"`];
  await env.DB.batch([
    // Never an agent Podster has linked: ending a link is the disconnect's alone, which moves the agent's generation.
    env.DB.prepare(`UPDATE agent SET status = 'revoked', publicKey = '', kid = NULL, updatedAt = ? WHERE hostId = ? AND id NOT IN (SELECT external_id FROM identity_link WHERE provider = 'agent_auth') AND EXISTS (SELECT 1 FROM agentHost WHERE id = ? AND ${holds})`).bind(now, id, id, ...key),
    env.DB.prepare(`UPDATE agentHost SET status = 'revoked', publicKey = '', kid = NULL, enrollmentTokenHash = NULL, enrollmentTokenExpiresAt = NULL, updatedAt = ? WHERE id = ? AND ${holds}`).bind(now, id, ...key),
  ]);
}

/**
 * What a person's touch does with the session it read (M1): a canceled, expired or locked session ends its plugin host.
 * One still waiting is retired; one holding the session's thumbprint is revoked with its agents. A live session, or a
 * host holding any other key, is left alone.
 */
export async function settleSession(env: Env, view: Record<string, unknown> | null) {
  const hostId = view?.plugin_host_id;
  if (typeof hostId !== "string" || !["canceled", "expired", "locked"].includes(view?.status as string)) return;
  if (typeof view?.key_thumbprint === "string") await revokeHost(env, hostId, view.key_thumbprint);
  await retireHost(env, hostId);
}

/** Cancels a session through the API as its starter, the person who owns its plugin host, so it can't be activated. */
async function cancelAsStarter(env: Env, hostId: string, agent: string) {
  const owner = await env.DB.prepare(`SELECT userId FROM agentHost WHERE id = ?`).bind(hostId).first<{ userId: string | null }>();
  const starter = owner?.userId ? await personIdentity(env, new Request(env.BASE_URL), owner.userId) : null;
  const canceled = starter ? await callApi(env, starter, { method: "POST", path: `/v1/pairing/${agent}/cancel`, body: "{}" }) : null;
  await canceled?.body?.cancel();
  if (canceled?.status !== 200) log(agent, "cancel_failed");
}

/**
 * After `enrollHost` (M2): exactly one plugin host may hold the key, and it must be the session's. Otherwise every host
 * holding it now is revoked with its agents (none did before this call, or the redeem was refused), the session's own host
 * is ended, the session is canceled, and Runner is refused. Null when all is well.
 */
export async function confirmEnrollment(env: Env, key: HostKey, hostId: string, agent: string): Promise<Response | null> {
  const holders = await hostsHolding(env, key);
  if (holders.length === 1 && holders[0].id === hostId && holders[0].status === "active") return null;
  log(agent, "enrollment_mismatch");
  for (const holder of holders) await revokeHost(env, holder.id, key.thumbprint, key.jwk.x);
  await retireHost(env, hostId);
  await cancelAsStarter(env, hostId, agent);
  return denied("not_allowed", 403);
}

type Counter = { idFromName(name: string): unknown; get(id: never): { take(perMinute: number, perDay: number): Promise<number> } };

/** An exact limit that fails closed: a counter that can't count refuses. `key` names the route and who is counted. */
export async function strictLimit(counter: Counter, key: string, perMinute: number, perDay: number): Promise<Response | null> {
  let retryAfter: unknown;
  try {
    retryAfter = await counter.get(counter.idFromName(key) as never).take(perMinute, perDay);
  } catch {
    retryAfter = undefined;
  }
  if (typeof retryAfter !== "number" || !Number.isSafeInteger(retryAfter) || retryAfter < 0) {
    console.error(JSON.stringify({ at: "pairing.limit", outcome: "limiter_unavailable" }));
    const refused = denied("temporarily_unavailable", 503);
    refused.headers.set("retry-after", "60");
    return refused;
  }
  return retryAfter > 0 ? rateLimited("", String(retryAfter)) : null;
}

type HostKey = { jwk: { kty: "OKP"; crv: "Ed25519"; x: string }; thumbprint: string };

/** An Ed25519 public key, by itself: no private part, no remote key, and a `kid`, if any, that is its own thumbprint. */
async function publicHostKey(value: unknown): Promise<HostKey | null> {
  if (!isObject(value) || Object.keys(value).some((key) => !KEY_MEMBERS.has(key))) return null;
  const { kty, crv, x, kid, alg, use } = value;
  if (kty !== "OKP" || crv !== "Ed25519" || typeof x !== "string" || !BASE64URL_32.test(x)) return null;
  if (alg !== undefined && alg !== "EdDSA" && alg !== "Ed25519") return null;
  if (use !== undefined && use !== "sig") return null;
  const jwk = { kty, crv, x } as const;
  const thumbprint = await calculateJwkThumbprint(jwk, "sha256");
  if (kid !== undefined && kid !== thumbprint) return null;
  return { jwk, thumbprint };
}

type Proof = { key: HostKey; jti: string; exp: number };

/** Checks Runner's host JWT. Returns the proof, or the refusal. */
async function verifiedProof(authorization: string | null, agent: string, audience: string): Promise<Proof | Response> {
  const invalid = () => denied("invalid_jwt", 401);
  const token = /^Bearer\s+(\S+)$/i.exec(authorization ?? "")?.[1];
  if (!token || token.length > MAX_JWT_BYTES) return invalid();
  let header: ReturnType<typeof decodeProtectedHeader>;
  let unverified: ReturnType<typeof decodeJwt>;
  try {
    header = decodeProtectedHeader(token);
    unverified = decodeJwt(token);
  } catch {
    return invalid();
  }
  if (header.typ !== "host+jwt" || header.alg !== "EdDSA" || header.crit !== undefined || header.b64 !== undefined) return invalid();
  if (unverified.host_public_key === undefined) return invalid();
  const key = await publicHostKey(unverified.host_public_key);
  if (!key) return denied("invalid_public_key", 400);
  let payload: Awaited<ReturnType<typeof jwtVerify>>["payload"];
  try {
    ({ payload } = await jwtVerify(token, await importJWK(key.jwk, "EdDSA"), {
      algorithms: ["EdDSA"],
      typ: "host+jwt",
      audience,
      subject: agent,
      requiredClaims: ["jti", "iat", "exp"],
      clockTolerance: CLOCK_SKEW_SECONDS,
    }));
  } catch {
    return invalid();
  }
  const now = Math.floor(Date.now() / 1000);
  const { jti, iat, exp } = payload;
  // One audience, the gateway's, and not a list that also names it.
  if (payload.aud !== audience) return invalid();
  if (typeof jti !== "string" || jti.length === 0 || new TextEncoder().encode(jti).length > MAX_PROOF_JTI_BYTES) return invalid();
  if (typeof iat !== "number" || typeof exp !== "number" || !Number.isSafeInteger(exp) || exp <= now || exp > now + MAX_PROOF_SECONDS || iat > now + CLOCK_SKEW_SECONDS || exp - iat > MAX_PROOF_SECONDS) return invalid();
  // One audience for one use: a proof that also carries an agent's key or a remote key URL reads as a registration.
  if (payload.agent_public_key !== undefined || payload.agent_jwks_url !== undefined || payload.host_jwks_url !== undefined) return invalid();
  // The key that signed is the key that is bound, whatever the JWT's other members say.
  if (typeof header.kid === "string" && header.kid !== key.thumbprint) return invalid();
  return { key, jti, exp };
}

type HostRow = { id: string; status: string };

/** Every plugin host that holds this key, by its thumbprint or its public part, whatever its state. */
const hostsHolding = async (env: Env, key: HostKey) =>
  (await env.DB.prepare(`SELECT id, status FROM agentHost WHERE kid = ? OR instr(publicKey, ?) > 0`).bind(key.thumbprint, `"x":"${key.jwk.x}"`).all<HostRow>()).results;

/** `POST /pairing/{agent}/redeem`, if this is it. */
export async function handlePairingRedeem(request: Request, url: URL, env: Env): Promise<Response | null> {
  const match = REDEEM_PATH.exec(url.pathname);
  if (!match) return null;
  if (request.method !== "POST") return denied("not_found", 404);
  const agent = match[1];
  const limited = await strictLimit(env.STRICT_COUNTER as unknown as Counter, `pairing-redeem:${clientKey(request)}`, REDEEM_PER_MINUTE, REDEEM_PER_DAY);
  if (limited) return limited;

  const proof = await verifiedProof(request.headers.get("authorization"), agent, new URL(env.BASE_URL).origin);
  if (proof instanceof Response) return proof;
  const body = await objectBody(request, ["code"]);
  const code = body?.code;
  if (typeof code !== "string" || !CODE.test(code)) return denied("invalid_argument", 400);

  // A key a host already holds is refused while this session's own host still waits: it isn't a retry of this session.
  const holding = await hostsHolding(env, proof.key);
  const waiting = await env.DB.prepare(`SELECT id FROM agentHost WHERE enrollmentTokenHash = ? AND status = 'pending_enrollment'`).bind(await pluginTokenHash(code)).first<{ id: string }>();
  if (holding.length > 0 && waiting) {
    log(agent, "key_enrolled");
    return denied("not_allowed", 403);
  }

  const sent = JSON.stringify({ code });
  const assertion = await mintPairingRedeem({ agentId: agent, keyThumbprint: proof.key.thumbprint, proofJti: proof.jti, proofExp: proof.exp, bodySha256: hex(await digest(sent)) }, env.ASSERTION_SIGNING_JWK);
  let response: Response;
  try {
    response = await env.API.fetch(new Request(`https://api.internal/v1/pairing/${agent}/redeem`, { method: "POST", headers: { "x-podster-assertion": assertion, "content-type": "application/json" }, body: sent, signal: AbortSignal.timeout(API_TIMEOUT_MS) }));
  } catch (error) {
    return denied("upstream_unavailable", (error as Error)?.name === "TimeoutError" ? 504 : 502);
  }
  const answer = await response.json<Record<string, unknown>>().catch(() => null);
  if (!answer) return denied("upstream_unavailable", 502);
  // The session's refusal, as it came: every refusal of a redemption is the same `not_allowed`.
  if (response.status !== 200) return json(answer, response.status);
  const hostId = answer.plugin_host_id;
  if (typeof hostId !== "string" || answer.key_thumbprint !== proof.key.thumbprint) return denied("upstream_unavailable", 502);

  if (holding.length > 0) {
    // Only an earlier try of this session put the key there: its own host holds it, and nothing else does.
    if (holding.length === 1 && holding[0].id === hostId && holding[0].status === "active") return noStore(json(answer));
    // Hosts that held the key before this call aren't this call's to revoke; the session just can't go on (M2).
    log(agent, "key_enrolled");
    await cancelAsStarter(env, hostId, agent);
    return denied("not_allowed", 403);
  }
  if (waiting?.id !== hostId) {
    log(agent, "host_not_waiting");
    await cancelAsStarter(env, hostId, agent);
    return denied("not_allowed", 403);
  }
  try {
    await createAuth(env).api.enrollHost({ body: { token: code, public_key: { ...proof.key.jwk, kid: proof.key.thumbprint } } });
  } catch {
    // The session holds the key; a retry with a fresh proof enrolls it.
    log(agent, "enroll_failed");
    return denied("upstream_unavailable", 502);
  }
  const mismatch = await confirmEnrollment(env, proof.key, hostId, agent);
  if (mismatch) return mismatch;
  log(agent, "redeemed");
  return noStore(json(answer));
}

/** The person's pairing routes, under `/api/pairing`, if this is one. `identity` is the signed-in person. */
export async function handlePairing(request: Request, url: URL, env: Env, identity: Identity): Promise<Response | null> {
  if (url.pathname !== "/api/pairing" && !url.pathname.startsWith("/api/pairing/")) return null;
  const match = PERSON_PATH.exec(url.pathname);
  if (!match || identity.kind !== "person") return denied("not_found", 404);
  const [, agent, action] = match;
  if (!agent) return request.method === "POST" ? start(request, env, identity) : denied("not_found", 404);
  if (!action) return request.method === "GET" ? relay(env, await callApi(env, identity, { method: "GET", path: `/v1/pairing/${agent}` })) : denied("not_found", 404);
  if (request.method !== "POST") return denied("not_found", 404);
  if (action === "cancel") {
    const response = await callApi(env, identity, { method: "POST", path: `/v1/pairing/${agent}/cancel`, body: "{}" });
    const answer = await response.json<Record<string, unknown>>().catch(() => null);
    if (!answer) return denied("upstream_unavailable", 502);
    if (response.status === 200) await settleSession(env, answer);
    return noStore(json(answer, response.status));
  }
  const body = await objectBody(request, ["key_thumbprint"]);
  const thumbprint = body?.key_thumbprint;
  if (typeof thumbprint !== "string" || !BASE64URL_32.test(thumbprint)) return denied("invalid_argument", 400);
  if (!(await withinLimit(env.RL_SENSITIVE, `pairing-activate:${identity.id}`))) return rateLimited();
  // The session's own host, from the starter's read: anyone else's read is refused here, as the API answers it.
  const session = await callApi(env, identity, { method: "GET", path: `/v1/pairing/${agent}` });
  const read = await session.json<Record<string, unknown>>().catch(() => null);
  if (!read) return denied("upstream_unavailable", 502);
  if (session.status !== 200 || typeof read.plugin_host_id !== "string") return noStore(json(read, session.status));
  const plugin = await pluginFacts(env, read.plugin_host_id);
  const activated = await callApi(env, identity, { method: "POST", path: `/v1/pairing/${agent}/activate`, body: JSON.stringify({ key_thumbprint: thumbprint, plugin }) });
  // A session that can't be activated any more is read again, so its host ends with it (M1).
  if (activated.status === 409) await settleSession(env, await (await callApi(env, identity, { method: "GET", path: `/v1/pairing/${agent}` })).json<Record<string, unknown>>().catch(() => null));
  if (activated.status !== 200) return relay(env, activated);
  const answer = await activated.json<Record<string, unknown>>().catch(() => null);
  if (!answer) return denied("upstream_unavailable", 502);
  const linked = await linkDirectory(env, identity.id, answer);
  logAt("pairing.link", agent, linked ? "linked" : "link_refused");
  return linked ? noStore(json({ ...answer, runner_ready: true })) : denied("not_allowed", 403);
}

/** The plugin agents a host holds that aren't revoked, oldest first, one more than a link may ever take. */
const hostAgents = async (env: Env, hostId: string) =>
  (await env.DB.prepare(`SELECT id, status FROM agent WHERE hostId = ? AND status != 'revoked' ORDER BY createdAt, id LIMIT ?`).bind(hostId, MAX_HOST_AGENTS + 1).all<{ id: string; status: string }>()).results;

/**
 * What the plugin holds for a session's host, read from its own tables, never from the client: the facts the API's binding
 * rule judges (M7 step 5(c)). The key's thumbprint is computed from the public key the host holds, not taken from its `kid`.
 */
export async function pluginFacts(env: Env, hostId: string) {
  const host = await env.DB.prepare(`SELECT userId, status, kid, publicKey FROM agentHost WHERE id = ?`).bind(hostId).first<{ userId: string | null; status: string; kid: string | null; publicKey: string | null }>();
  let parsed: unknown = null;
  try {
    parsed = host?.publicKey ? JSON.parse(host.publicKey) : null;
  } catch {
    parsed = null;
  }
  const key = parsed ? await publicHostKey(parsed) : null;
  const held = key && (host?.kid === null || host?.kid === key.thumbprint) ? key : null;
  return {
    host_id: hostId,
    host_owner: host?.userId ? `per_${host.userId}` : "",
    host_active: host?.status === "active",
    host_thumbprint: held?.thumbprint ?? "",
    hosts_holding_key: held ? (await hostsHolding(env, held)).length : 0,
    agents: (await hostAgents(env, hostId)).map((a) => ({ id: a.id, active: a.status === "active" })),
  };
}

/**
 * After the API linked a plugin agent to the paired agent: the directory's rows, as the claim writes them after
 * `registerAgent`, in one batch, by the starter. A retry after a lost write finds them and answers the same.
 */
async function linkDirectory(env: Env, starter: string, answer: Record<string, unknown>) {
  const { agent_id: agentId, org_id: org, name, plugin_agent_id: pluginAgent } = answer;
  if (typeof agentId !== "string" || typeof org !== "string" || typeof pluginAgent !== "string") return false;
  const named = typeof name === "string" && name ? name : "agent";
  return linkOnce(env, pluginAgent, agentId, () => createAgent(env, org, named, "agent_auth", pluginAgent, agentId, starter));
}

/** People whose sessions one sweep asks about, at most. Each has at most `SWEEP_BATCH` sessions answered. */
export const SWEEP_PEOPLE = 25;
/** A session's life, as the API sets it: a host younger than this can't belong to an expired session. */
const SESSION_MS = 10 * 60 * 1000;

/**
 * The expiry sweep (M7 step 5(c)), from the cron. For each person who owns a plugin host that is still waiting or active,
 * is older than a session can live, and has no linked agent, it asks the API, as that person, for their sessions past
 * their expiry. Each that wasn't activated has its host ended, as a person's touch would (M1): retired if waiting,
 * revoked with its unlinked agents if it holds the session's key. Then those sessions are settled, so they aren't asked
 * about again. A person the sweep can't act for, or an answer it can't read, is left for the next run.
 */
export async function sweepPairings(env: Env, now = Date.now()) {
  const { results } = await env.DB.prepare(
    `SELECT DISTINCT h.userId AS userId FROM agentHost h WHERE h.userId IS NOT NULL AND h.status IN ('pending_enrollment', 'active') AND h.createdAt < ? AND NOT EXISTS (SELECT 1 FROM agent a JOIN identity_link l ON l.provider = 'agent_auth' AND l.external_id = a.id WHERE a.hostId = h.id) LIMIT ?`,
  ).bind(new Date(now - SESSION_MS).toISOString(), SWEEP_PEOPLE).all<{ userId: string }>();
  let ended = 0;
  for (const { userId } of results) {
    const identity = await personIdentity(env, new Request(env.BASE_URL), userId);
    if (!identity) continue;
    const response = await callApi(env, identity, { method: "POST", path: "/v1/pairing/sweep", body: "{}" });
    const answer = await response.json<{ sessions?: Record<string, unknown>[] }>().catch(() => null);
    if (response.status !== 200 || !Array.isArray(answer?.sessions)) {
      logAt("pairing.sweep", undefined, "unavailable");
      continue;
    }
    const settled: string[] = [];
    for (const session of answer.sessions) {
      const agent = typeof session.agent_id === "string" ? session.agent_id : null;
      if (!agent) continue;
      if (session.status === "missing") {
        if (typeof session.plugin_host_id === "string") await retireHost(env, session.plugin_host_id);
      } else if (["canceled", "expired", "locked"].includes(session.status as string)) {
        await settleSession(env, session);
        ended++;
      } else if (session.status !== "activated") continue;
      logAt("pairing.sweep", agent, typeof session.status === "string" && /^[a-z]+$/.test(session.status) ? session.status : "unknown");
      settled.push(agent);
    }
    if (settled.length > 0) {
      const done = await callApi(env, identity, { method: "POST", path: "/v1/pairing/sweep/settled", body: JSON.stringify({ agent_ids: settled }) });
      await done.body?.cancel();
    }
  }
  return ended;
}

/**
 * Passes the API's answer on. A session it shows ended has its plugin host ended too (M1). A session it shows redeemed
 * also says whether Runner has registered the one agent the confirmation will link, `runner_ready`, for the screen only:
 * the API's binding rule decides at confirmation.
 */
async function relay(env: Env, response: Response) {
  const answer = await response.json<Record<string, unknown>>().catch(() => null);
  if (answer === null) return denied("upstream_unavailable", 502);
  if (response.status === 200) await settleSession(env, answer);
  if (response.status === 200 && typeof answer.plugin_host_id === "string") {
    const agents = answer.status === "redeemed" || answer.status === "activated" ? await hostAgents(env, answer.plugin_host_id) : [];
    answer.runner_ready = agents.length === 1 && agents[0].status === "active";
  }
  return noStore(json(answer, response.status));
}

/** `POST /api/pairing`: a new plugin host with no key, then the session, with nothing from the client but a name. */
async function start(request: Request, env: Env, identity: Identity & { kind: "person" }): Promise<Response> {
  const body = await objectBody(request, ["name"]);
  if (!body) return denied("invalid_argument", 400);
  const name = body.name === undefined ? undefined : typeof body.name === "string" ? body.name.trim() : null;
  if (name === null || (name !== undefined && (name.length === 0 || new TextEncoder().encode(name).length > MAX_NAME_BYTES))) return denied("invalid_argument", 400);
  const limited = await strictLimit(env.STRICT_COUNTER as unknown as Counter, `pairing-start:${identity.id}`, START_PER_MINUTE, START_PER_DAY);
  if (limited) return limited;

  const listed = new Set(capabilitiesFor(env).map((c) => c.name));
  const allowlist = RUNNER_CAPABILITIES.filter((c) => listed.has(c));
  let host: { hostId?: unknown; status?: unknown; enrollmentToken?: unknown };
  try {
    host = await createAuth(env).api.createHost({ headers: request.headers, body: { name: name ?? DEFAULT_HOST_NAME, default_capabilities: allowlist } });
  } catch {
    return denied("upstream_unavailable", 502);
  }
  const { hostId, enrollmentToken: code } = host;
  if (typeof hostId !== "string") return denied("upstream_unavailable", 502);
  if (host.status !== "pending_enrollment" || typeof code !== "string" || !CODE.test(code)) {
    await retireHost(env, hostId);
    return denied("upstream_unavailable", 502);
  }
  const response = await callApi(env, identity, { method: "POST", path: "/v1/pairing", body: JSON.stringify({ org_id: identity.org, plugin_host_id: hostId, code, ...(name === undefined ? {} : { name }) }) });
  const answer = await response.json<Record<string, unknown>>().catch(() => null);
  if (response.status !== 200 || !answer || typeof answer.agent_id !== "string") {
    await retireHost(env, hostId);
    return answer && response.status !== 200 ? noStore(json(answer, response.status)) : denied("upstream_unavailable", 502);
  }
  return noStore(json({ ...answer, code }));
}
