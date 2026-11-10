/**
 * GitHub's webhook deliveries (M5 step 5, ADR 0009, which is proposed). The gateway checks who sent one and passes on what
 * it's about; it decides nothing.
 *
 * - **Who sent it:** `X-Hub-Signature-256` is an HMAC-SHA256 of the raw body under `GITHUB_WEBHOOK_SECRET`, compared in
 *   constant time by `crypto.subtle.verify`. With no usable secret the route refuses everything, as a path that isn't there.
 * - **What goes on:** the delivery ID, the event's kind, GitHub's repository ID, pull request numbers and one commit SHA.
 *   With them goes the SHA-256 of the raw body: GitHub's signature covers the body and not the delivery ID, so the room
 *   treats the same body as the same delivery. No title, body, branch name, URL, login or state: a delivery is a nudge,
 *   and what Podster records comes from its own read of GitHub, never from here. The payload is read once and dropped.
 * - **How:** over the service binding, with an assertion that names no one and binds the exact body sent. The API finds
 *   the room and the room checks the repository against its own link.
 *
 * Logs carry the delivery ID and a fixed code, and only for a delivery whose signature was good.
 */
import { mintProviderDelivery } from "./assertion";

export const GITHUB_WEBHOOK_PATH = "/webhooks/github";
/**
 * GitHub caps a payload at 25 MB. The events used here are far smaller, and a bigger body is refused without reading past
 * the limit. That delivery's nudge is lost, and the room's polling is what notices the change.
 */
export const MAX_WEBHOOK_BYTES = 256 * 1024;
/** A shorter secret doesn't count as one. */
const MIN_SECRET_LENGTH = 32;
/** GitHub gives a delivery ten seconds. */
const API_TIMEOUT_MS = 5_000;
/** The events M5 uses. A `ping` is answered and goes no further. */
const EVENTS = new Set(["pull_request", "check_run", "status"]);
const SIGNATURE = /^sha256=([0-9a-f]{64})$/;
const DELIVERY_ID = /^[A-Za-z0-9_-]{1,64}$/;
const COMMIT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const MAX_PULL_REQUESTS = 10;

type WebhookEnv = { API: Fetcher; ASSERTION_SIGNING_JWK: string; GITHUB_WEBHOOK_SECRET?: string };
/** What the API is sent, and all it's sent. */
export type Nudge = { delivery_id: string; body_sha256: string; event: string; repository_id: number; pull_requests: number[]; head_sha?: string };

const answer = (body: unknown, status: number) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "x-content-type-options": "nosniff", "cache-control": "no-store" } });
const refuse = (code: string, status: number) => answer({ error: { code, message: code } }, status);
const hex = (bytes: Uint8Array) => [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
const id = (value: unknown): number | null => (typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null);
const commit = (value: unknown): string | undefined => (typeof value === "string" && COMMIT.test(value) ? value : undefined);

/** Reads the stream as well as trusting the header, because a chunked body has no length. */
async function bounded(request: Request, limit: number): Promise<Uint8Array<ArrayBuffer> | null> {
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
  return body;
}

/** Whether the signature is this body's HMAC under the secret. `verify` compares in constant time. */
export async function signedBy(secret: string, signatureHex: string, body: Uint8Array<ArrayBuffer>): Promise<boolean> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  const signature = new Uint8Array(32);
  for (let i = 0; i < 32; i++) signature[i] = Number.parseInt(signatureHex.slice(i * 2, i * 2 + 2), 16);
  return crypto.subtle.verify("HMAC", key, signature, body);
}

/**
 * The IDs and the commit a delivery is about, or null if it names no repository, or nothing to look up. Each field is
 * taken by name and checked for its type, so nothing else in the payload can come along.
 */
export function normalize(deliveryId: string, bodySha256: string, event: string, payload: unknown): Nudge | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as Record<string, any>;
  const repository = id(p.repository?.id);
  if (!repository) return null;
  let numbers: unknown[] = [];
  let sha: string | undefined;
  if (event === "pull_request") {
    numbers = [p.pull_request?.number ?? p.number];
    sha = commit(p.pull_request?.head?.sha);
  } else if (event === "check_run") {
    const listed: unknown = p.check_run?.pull_requests;
    // Only pull requests into this repository. One into another repository isn't this room's.
    numbers = Array.isArray(listed) ? listed.filter((pr) => id(pr?.base?.repo?.id) === repository).map((pr) => pr?.number) : [];
    sha = commit(p.check_run?.head_sha);
  } else if (event === "status") {
    sha = commit(p.sha);
  } else {
    return null;
  }
  const pullRequests = [...new Set(numbers.map(id).filter((n): n is number => n !== null))].slice(0, MAX_PULL_REQUESTS);
  if (pullRequests.length === 0 && !sha) return null;
  return { delivery_id: deliveryId, body_sha256: bodySha256, event, repository_id: repository, pull_requests: pullRequests, ...(sha ? { head_sha: sha } : {}) };
}

const log = (delivery: string, outcome: string) => console.log(JSON.stringify({ at: "github.webhook", delivery, outcome }));

/** Null for any other path. */
export async function handleGithubWebhook(request: Request, url: URL, env: WebhookEnv): Promise<Response | null> {
  if (url.pathname !== GITHUB_WEBHOOK_PATH) return null;
  // No secret, no route: nothing can be told apart from a path that doesn't exist, and nothing is read.
  const secret = env.GITHUB_WEBHOOK_SECRET;
  if (!secret || secret.length < MIN_SECRET_LENGTH) return refuse("not_found", 404);
  if (request.method !== "POST") return refuse("method_not_allowed", 405);
  const signature = SIGNATURE.exec(request.headers.get("x-hub-signature-256") ?? "")?.[1];
  if (!signature) return refuse("invalid_signature", 401);
  const body = await bounded(request, MAX_WEBHOOK_BYTES);
  if (!body) return refuse("body_too_large", 413);
  if (!(await signedBy(secret, signature, body))) return refuse("invalid_signature", 401);

  // From here the sender is GitHub, under this secret. What it sent still decides nothing.
  const delivery = request.headers.get("x-github-delivery") ?? "";
  if (!DELIVERY_ID.test(delivery)) return refuse("invalid_delivery", 400);
  const event = request.headers.get("x-github-event") ?? "";
  if (event === "ping") {
    log(delivery, "ping");
    return answer({ ok: true }, 200);
  }
  if (!EVENTS.has(event)) {
    log(delivery, "event_not_used");
    return refuse("event_not_used", 422);
  }
  let payload: unknown;
  try {
    payload = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
  } catch {
    log(delivery, "invalid_payload");
    return refuse("invalid_payload", 400);
  }
  const nudge = normalize(delivery, hex(new Uint8Array(await crypto.subtle.digest("SHA-256", body))), event, payload);
  if (!nudge) {
    log(delivery, "invalid_payload");
    return refuse("invalid_payload", 400);
  }

  const sent = JSON.stringify(nudge);
  const digest = hex(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(sent))));
  const assertion = await mintProviderDelivery("github", delivery, digest, env.ASSERTION_SIGNING_JWK);
  let response: Response;
  try {
    response = await env.API.fetch(new Request("https://api.internal/v1/provider/github/deliveries", { method: "POST", headers: { "x-podster-assertion": assertion, "content-type": "application/json" }, body: sent, signal: AbortSignal.timeout(API_TIMEOUT_MS) }));
  } catch (error) {
    const timedOut = (error as Error)?.name === "TimeoutError";
    log(delivery, timedOut ? "upstream_timeout" : "upstream_unavailable");
    return refuse("upstream_unavailable", timedOut ? 504 : 502);
  }
  await response.body?.cancel();
  if (response.status !== 202) {
    log(delivery, "upstream_refused");
    // GitHub shows a failed delivery and may be asked to send it again. Nothing of the API's answer goes back.
    return refuse("upstream_unavailable", response.status === 504 ? 504 : 502);
  }
  log(delivery, "accepted");
  return answer({ accepted: true }, 202);
}
