/**
 * Runner pairing, the gateway's half (M7 step 5(b); decision 222; the M7 plan's rulings P1 and P2). The gateway
 * authenticates and translates; the pairing session on the new agent's Principal decides (step 5(a)).
 *
 * - **Start** (`POST /api/pairing`, the person's session, our own origin): the Agent Auth plugin's `createHost` with no
 *   key and Runner's fixed allowlist, then the API's `startPairing` with the organization the person acts in, that host
 *   and its one-time enrollment token as the code. None of those come from the client: its body may hold a `name` and
 *   nothing else. The agent's ID and the code go back in the response body, never in a URL. A refused start retires the
 *   host it made, so no usable token is left behind.
 * - **Read, cancel, activate** (`/api/pairing/{agent}…`): the person's own, through these handlers only. The dashboard's
 *   passthrough refuses every `/v1/pairing` path (`allowedPassthrough`). A cancel retires the plugin host still waiting.
 * - **Redeem** (`POST /pairing/{agent}/redeem`, the gateway's own host, no session): Runner's code, with a host JWT
 *   (`typ: host+jwt`, EdDSA) signed by the key it carries as `host_public_key`, naming the session's agent as its subject
 *   and the gateway as its audience, with its own `jti`, and expiring at most 300 seconds ahead. A per-network limiter
 *   counts first and refuses when it can't count. A key any plugin host already holds is refused, unless this session's
 *   own host took it on an earlier try. Then the API's `redeemPairing`, under the `pairing_redeem` assertion that names
 *   the session, the key's RFC 7638 thumbprint, the proof's ID and expiry and the SHA-256 of the exact body sent. Only
 *   after its 200 does the plugin's `enrollHost` bind the key to that session's host, so a retry after a lost answer,
 *   with a fresh proof, finds the host already holding the key and answers the same.
 *
 * The plugin's own `/host/*` routes stay private. Logs carry IDs and fixed outcomes only: never a code, a proof or a key.
 */
import { calculateJwkThumbprint, decodeJwt, decodeProtectedHeader, importJWK, jwtVerify } from "jose";
import { mintPairingRedeem, type Identity } from "./assertion";
import { capabilitiesFor } from "./capabilities";
import { callApi, clientKey, createAuth, denied, json, rateLimited, withinLimit, type Env } from "./index";

/**
 * What Runner's agent may be given (decision 230): what it uses, and never `merge_task`, `deploy_release` or anything that
 * makes or assigns work. A capability this deployment doesn't list, such as `get_repo_access` with managed repositories
 * off, is left out. *Proposed:* Runner's later steps may narrow it.
 */
export const RUNNER_CAPABILITIES = [
  "get_identity", "list_workspaces", "get_workspace", "get_workroom_brief", "list_activity", "read_inbox", "ack_inbox", "list_tasks", "get_task",
  "accept_task", "decline_task", "release_task", "send_message", "list_messages", "submit_task", "create_upload", "get_asset_link", "list_assets", "get_repo_access",
] as const;

/** Redemptions one network may make, per minute and per day, counted exactly. */
export const REDEEM_PER_MINUTE = 10;
export const REDEEM_PER_DAY = 100;
/** The furthest ahead a proof may expire, in seconds, as `podster_assertion::MAX_PROOF_LIFETIME_SECS` requires. */
const MAX_PROOF_SECONDS = 300;
const CLOCK_SKEW_SECONDS = 5;
const MAX_PROOF_JTI_BYTES = 128;
const MAX_JWT_BYTES = 4096;
const MAX_BODY_BYTES = 1024;
const MAX_NAME_BYTES = 200;
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
const log = (agent: string, outcome: string) => console.log(JSON.stringify({ at: "pairing.redeem", agent, outcome }));
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

type Counter = { idFromName(name: string): unknown; get(id: never): { take(perMinute: number, perDay: number): Promise<number> } };

/** The per-network limit on redemptions, exact and failing closed: a counter that can't count refuses. */
export async function redeemLimit(counter: Counter, network: string): Promise<Response | null> {
  let retryAfter: unknown;
  try {
    retryAfter = await counter.get(counter.idFromName(`pairing-redeem:${network}`) as never).take(REDEEM_PER_MINUTE, REDEEM_PER_DAY);
  } catch {
    retryAfter = undefined;
  }
  if (typeof retryAfter !== "number" || !Number.isSafeInteger(retryAfter) || retryAfter < 0) {
    console.error(JSON.stringify({ at: "pairing.redeem", outcome: "limiter_unavailable" }));
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
  const limited = await redeemLimit(env.STRICT_COUNTER as unknown as Counter, clientKey(request));
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
    if (holding.every((row) => row.id === hostId && row.status === "active")) return noStore(json(answer));
    log(agent, "key_enrolled");
    return denied("not_allowed", 403);
  }
  if (waiting?.id !== hostId) {
    log(agent, "host_not_waiting");
    return denied("not_allowed", 403);
  }
  try {
    const enrolled = await createAuth(env).api.enrollHost({ body: { token: code, public_key: { ...proof.key.jwk, kid: proof.key.thumbprint } } });
    if ((enrolled as { hostId?: unknown })?.hostId !== hostId) {
      log(agent, "enrolled_elsewhere");
      return denied("upstream_unavailable", 502);
    }
  } catch {
    // The session holds the key; a retry with a fresh proof enrolls it.
    log(agent, "enroll_failed");
    return denied("upstream_unavailable", 502);
  }
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
  if (!action) return request.method === "GET" ? relay(await callApi(env, identity, { method: "GET", path: `/v1/pairing/${agent}` })) : denied("not_found", 404);
  if (request.method !== "POST") return denied("not_found", 404);
  if (action === "cancel") {
    const response = await callApi(env, identity, { method: "POST", path: `/v1/pairing/${agent}/cancel`, body: "{}" });
    const answer = await response.json<Record<string, unknown>>().catch(() => null);
    if (!answer) return denied("upstream_unavailable", 502);
    if (response.status === 200 && answer.status === "canceled" && typeof answer.plugin_host_id === "string") await retireHost(env, answer.plugin_host_id);
    return noStore(json(answer, response.status));
  }
  const body = await objectBody(request, ["key_thumbprint"]);
  const thumbprint = body?.key_thumbprint;
  if (typeof thumbprint !== "string" || !BASE64URL_32.test(thumbprint)) return denied("invalid_argument", 400);
  if (!(await withinLimit(env.RL_SENSITIVE, `pairing-activate:${identity.id}`))) return rateLimited();
  return relay(await callApi(env, identity, { method: "POST", path: `/v1/pairing/${agent}/activate`, body: JSON.stringify({ key_thumbprint: thumbprint }) }));
}

async function relay(response: Response) {
  const answer = await response.json().catch(() => null);
  return answer === null ? denied("upstream_unavailable", 502) : noStore(json(answer, response.status));
}

/** `POST /api/pairing`: a new plugin host with no key, then the session, with nothing from the client but a name. */
async function start(request: Request, env: Env, identity: Identity & { kind: "person" }): Promise<Response> {
  const body = await objectBody(request, ["name"]);
  if (!body) return denied("invalid_argument", 400);
  const name = body.name === undefined ? undefined : typeof body.name === "string" ? body.name.trim() : null;
  if (name === null || (name !== undefined && (name.length === 0 || new TextEncoder().encode(name).length > MAX_NAME_BYTES))) return denied("invalid_argument", 400);
  if (!(await withinLimit(env.RL_SENSITIVE, `pairing-start:${identity.id}`))) return rateLimited();

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
