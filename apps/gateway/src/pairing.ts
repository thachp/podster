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
 * - **Sweep** (M7 step 5(c), rulings M1, L1 and L2 on #453): the gateway's own `pairing_host` table, written when a session
 *   starts, drives it. Oldest first and a bounded batch of people per run, it asks the API under its service assertion,
 *   which names only the person, for their sessions past expiry, ends the host of each that wasn't activated, and settles
 *   them. One person's failure is logged and put back, waiting longer with each failure, never the run's end.
 *
 * The plugin's own `/host/*` routes stay private. Logs carry IDs and fixed outcomes only: never a code, a proof or a key.
 */
import { calculateJwkThumbprint, decodeJwt, decodeProtectedHeader, importJWK, jwtVerify } from "jose";
import { mintPairingRedeem, mintPairingSweep, type Identity } from "./assertion";
import { capabilitiesFor } from "./capabilities";
import { callApi, clientKey, createAgent, createAuth, denied, json, linkOnce, personIdentity, rateLimited, withinLimit, type Env } from "./index";

/**
 * The plugin host's default capabilities for Runner's agent (decision 230): what it uses, and never `merge_task`,
 * `deploy_release` or anything that makes or assigns work. `get_repo_access` was withheld until M7 step 10's repository
 * path (ruled 2026-11-18, L1), since a contents-write token can commit straight to the default branch where rulesets
 * aren't available; it is back under that path's own rules, which Runner enforces on the owner's machine (only the
 * repository the owner scoped, only where GitHub shows the default branch under ADR 0009's rules, one task branch, no
 * merge call, the token never in a container). The API's own checks (a ready link, a live push grant, an accepted
 * task) are unchanged. These are a budget, not a ceiling: anything more goes through the person's claim. A capability
 * this deployment doesn't list is left out, so `get_repo_access` only where managed repositories are switched on.
 * `set_a2a_endpoint` and `verify_a2a_endpoint` are Runner's inbound nudge (M7 step 14): registering an endpoint grants
 * nothing, and a nudge endpoint sends nothing until a person who administers the agent's organization switches it on.
 */
export const RUNNER_CAPABILITIES = [
  "get_identity", "list_workspaces", "get_workspace", "get_workroom_brief", "list_activity", "read_inbox", "ack_inbox", "list_tasks", "get_task",
  "accept_task", "decline_task", "release_task", "send_message", "list_messages", "submit_task", "create_upload", "get_asset_link", "list_assets",
  "get_repo_access", "set_a2a_endpoint", "verify_a2a_endpoint",
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
  // Ended for good: the sweep needn't ask about it again.
  await env.DB.prepare(`DELETE FROM pairing_host WHERE host_id = ? AND linked_agent_id IS NULL`).bind(hostId).run();
}

/** Whether a plugin agent is on a host a pairing made: such a host's agents are linked only by its starter's confirmation. */
export async function onPairingHost(env: Pick<Env, "DB">, pluginAgent: string) {
  return (await env.DB.prepare(`SELECT 1 AS n FROM pairing_host WHERE host_id = (SELECT hostId FROM agent WHERE id = ?)`).bind(pluginAgent).first()) !== null;
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
  if (!action) return request.method === "GET" ? relay(env, await callApi(env, identity, { method: "GET", path: `/v1/pairing/${agent}` }), identity.id) : denied("not_found", 404);
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
  const linked = await finishLink(env, identity.id, answer);
  if (linked === "linked_elsewhere") return denied("already_linked", 409);
  return noStore(json({ ...answer, runner_ready: true, connected: linked === "linked" }));
}

/**
 * An activated session's directory rows (ruling M2 on #453): written after the API's activation, and again on any later
 * read of it, so a write that failed once is finished by a reload. A plugin agent already linked to another agent is
 * refused with fixed words and its IDs logged, and the session is left as it is.
 */
async function finishLink(env: Env, starter: string, answer: Record<string, unknown>): Promise<"linked" | "unfinished" | "linked_elsewhere"> {
  const agent = typeof answer.agent_id === "string" ? answer.agent_id : undefined;
  let linked: boolean;
  try {
    linked = await linkDirectory(env, starter, answer);
  } catch {
    logAt("pairing.link", agent, "unfinished");
    return "unfinished";
  }
  if (!linked) {
    console.log(JSON.stringify({ at: "pairing.link", agent, plugin_agent: answer.plugin_agent_id, outcome: "linked_elsewhere" }));
    return "linked_elsewhere";
  }
  if (typeof answer.plugin_host_id === "string") await env.DB.prepare(`UPDATE pairing_host SET linked_agent_id = ? WHERE host_id = ?`).bind(answer.plugin_agent_id, answer.plugin_host_id).run();
  logAt("pairing.link", agent, "linked");
  return "linked";
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

/** People one sweep run asks about, at most: those never tried or waiting least first, then oldest due. */
export const SWEEP_PEOPLE = 25;
/** A person whose turn went through but who still has due rows waits this long. */
const SWEEP_RETRY_MS = 60 * 60 * 1000;
/**
 * A person whose turn failed waits two hours, doubling with each failure in a row to a day at most (ruling on #453's
 * re-review). Longer than the cron's hour from the first failure, so people who keep failing fall behind everyone new.
 */
export function sweepBackoffMs(failures: number) {
  return Math.min(2 * 60 * 60 * 1000 * 2 ** Math.max(0, Math.min(failures, 20) - 1), 24 * 60 * 60 * 1000);
}
/** As `podster_api::principal::pairing::SWEEP_BATCH`: sessions the API answers for one person in one sweep, at most. */
const SWEEP_BATCH = 50;
/** A row the API no longer lists is taken as ended only this long after its expiry, so clocks that differ can't end a live one. */
const ORPHANED_AFTER_MS = 24 * 60 * 60 * 1000;

/** The API's sweep routes, under the service assertion naming only `person` (L1), with the exact body. */
async function sweepCall(env: Env, person: string, path: string, body: unknown) {
  const text = JSON.stringify(body);
  const assertion = await mintPairingSweep(person, hex(await digest(text)), env.ASSERTION_SIGNING_JWK);
  return env.API.fetch(new Request(`https://api.internal${path}`, { method: "POST", headers: { "x-podster-assertion": assertion, "content-type": "application/json" }, body: text, signal: AbortSignal.timeout(API_TIMEOUT_MS) }));
}

/** One person's turn in the sweep. Answers how many hosts it ended. Throws on anything it can't read. */
async function sweepPerson(env: Env, person: string, now: number) {
  const response = await sweepCall(env, person, "/v1/pairing/sweep", {});
  const answer = await response.json<{ sessions?: Record<string, unknown>[] }>().catch(() => null);
  if (response.status !== 200 || !Array.isArray(answer?.sessions)) throw new Error("sweep_unavailable");
  const settled: string[] = [];
  let ended = 0;
  for (const session of answer.sessions) {
    const agent = typeof session.agent_id === "string" ? session.agent_id : null;
    if (!agent) continue;
    const status = typeof session.status === "string" && /^[a-z]+$/.test(session.status) ? session.status : "unknown";
    if (status === "missing") {
      if (typeof session.plugin_host_id === "string") await retireHost(env, session.plugin_host_id);
      await env.DB.prepare(`DELETE FROM pairing_host WHERE agent_id = ? AND linked_agent_id IS NULL`).bind(agent).run();
    } else if (["canceled", "expired", "locked"].includes(status)) {
      await settleSession(env, session);
      ended++;
    } else if (status === "activated") {
      // Activated: nothing to end. Its link is finished by the starter's next read (M2); here it's only marked.
      await env.DB.prepare(`UPDATE pairing_host SET linked_agent_id = COALESCE(linked_agent_id, ?) WHERE agent_id = ?`).bind(typeof session.plugin_agent_id === "string" ? session.plugin_agent_id : agent, agent).run();
    } else continue;
    logAt("pairing.sweep", agent, status);
    settled.push(agent);
  }
  if (settled.length > 0) {
    const done = await sweepCall(env, person, "/v1/pairing/sweep/settled", { agent_ids: settled });
    await done.body?.cancel();
  }
  // A row the API no longer lists, long past its expiry, ended without the sweep: its host goes too.
  if (answer.sessions.length < SWEEP_BATCH) {
    const listed = new Set(answer.sessions.map((s) => s.agent_id));
    const { results } = await env.DB.prepare(`SELECT host_id, agent_id FROM pairing_host WHERE person_id = ? AND linked_agent_id IS NULL AND expires_at <= ?`).bind(person, now - ORPHANED_AFTER_MS).all<{ host_id: string; agent_id: string }>();
    for (const row of results) {
      if (listed.has(row.agent_id)) continue;
      const host = await env.DB.prepare(`SELECT kid FROM agentHost WHERE id = ?`).bind(row.host_id).first<{ kid: string | null }>();
      if (host?.kid) await revokeHost(env, row.host_id, host.kid);
      await retireHost(env, row.host_id);
      await env.DB.prepare(`DELETE FROM pairing_host WHERE host_id = ?`).bind(row.host_id).run();
      logAt("pairing.sweep", row.agent_id, "orphaned");
    }
  }
  // Whatever is still due waits its turn, so the people behind this one are reached. The turn went through, so failures reset.
  await env.DB.prepare(`UPDATE pairing_host SET next_sweep_at = ?, sweep_failures = 0 WHERE person_id = ? AND linked_agent_id IS NULL AND expires_at <= ?`).bind(now + SWEEP_RETRY_MS, person, now).run();
  return ended;
}

/**
 * The expiry sweep (M7 step 5(c)), from the cron. The people with sessions past expiry in the gateway's own `pairing_host`,
 * oldest first, at most `SWEEP_PEOPLE` a run (M1). Each has the hosts of their sessions that weren't activated ended, as a
 * person's touch would: retired if waiting, revoked with their unlinked agents if they hold the session's key. A person
 * whose turn fails is logged by ID and put back, and the run goes on (L2).
 */
export async function sweepPairings(env: Env, now = Date.now()) {
  const { results } = await env.DB.prepare(
    `SELECT person_id, MIN(next_sweep_at) AS waited, MIN(expires_at) AS first FROM pairing_host WHERE linked_agent_id IS NULL AND expires_at <= ? AND next_sweep_at <= ? GROUP BY person_id ORDER BY waited, first, person_id LIMIT ?`,
  ).bind(now, now, SWEEP_PEOPLE).all<{ person_id: string }>();
  let ended = 0;
  for (const { person_id: person } of results) {
    try {
      ended += await sweepPerson(env, person, now);
    } catch {
      console.log(JSON.stringify({ at: "pairing.sweep", person, outcome: "failed" }));
      try {
        const row = await env.DB.prepare(`SELECT MAX(sweep_failures) AS failures FROM pairing_host WHERE person_id = ?`).bind(person).first<{ failures: number | null }>();
        const failures = (row?.failures ?? 0) + 1;
        await env.DB.prepare(`UPDATE pairing_host SET next_sweep_at = ?, sweep_failures = ? WHERE person_id = ?`).bind(now + sweepBackoffMs(failures), failures, person).run();
      } catch {
        // Unrecorded, this person comes round again next run; the others in this run still get their turn.
      }
    }
  }
  return ended;
}

/**
 * Passes the API's answer on. A session it shows ended has its plugin host ended too (M1). A session it shows redeemed
 * also says whether Runner has registered the one agent the confirmation will link, `runner_ready`, for the screen only:
 * the API's binding rule decides at confirmation.
 */
async function relay(env: Env, response: Response, starter?: string) {
  const answer = await response.json<Record<string, unknown>>().catch(() => null);
  if (answer === null) return denied("upstream_unavailable", 502);
  if (response.status === 200) await settleSession(env, answer);
  // The starter's read of an activated session finishes its link, if a write was lost (M2).
  if (response.status === 200 && starter && answer.status === "activated" && typeof answer.plugin_agent_id === "string") {
    const linked = await finishLink(env, starter, answer);
    answer.connected = linked === "linked";
    if (linked === "linked_elsewhere") answer.link_problem = "already_linked";
  }
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
  // The sweep's own record of who started it (M1). Without it the host could outlive its session, so it's retired instead.
  try {
    await env.DB.prepare(`INSERT INTO pairing_host (host_id, person_id, agent_id, expires_at) VALUES (?, ?, ?, ?)`).bind(hostId, identity.id, answer.agent_id, Number(answer.expires_at)).run();
  } catch {
    logAt("pairing.start", answer.agent_id, "unrecorded");
    await retireHost(env, hostId);
    return denied("upstream_unavailable", 502);
  }
  return noStore(json({ ...answer, code }));
}
