/**
 * A file's bytes on their way from the API, which decides everything. There's no download token or signed URL. An agent shows its own
 * credential each time and a person their session, so the gateway checks who they are and the API checks what they may have, on every
 * download. Only the API's own file headers pass, and the body is never read here.
 */
import { mintAssertion, type Identity } from "./assertion";

const FILE_PATH = /^\/v1\/files\/[\w-]+\/[\w-]+$/;
const BEARER = /^Bearer ([^\s,]{1,8192})$/;
/** How long the API may take to start answering. A file takes as long as it takes after that. */
const START_TIMEOUT_MS = 10_000;
const FILE_HEADERS = ["content-type", "content-disposition", "content-length", "x-content-type-options", "cache-control", "content-security-policy", "cross-origin-resource-policy", "referrer-policy"];

const answer = (code: string, status: number, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify({ error: { code, message: code } }), { status, headers: { "content-type": "application/json", "x-content-type-options": "nosniff", ...headers } });

const limited = () => answer("rate_limited", 429, { "retry-after": "60" });

export const isFilePath = (path: string) => FILE_PATH.test(path);

type FileEnv = { API: Fetcher; ASSERTION_SIGNING_JWK: string };

export async function serveFile(env: FileEnv, identity: Identity, path: string): Promise<Response> {
  const assertion = await mintAssertion(identity, env.ASSERTION_SIGNING_JWK);
  const stop = new AbortController();
  const timer = setTimeout(() => stop.abort(), START_TIMEOUT_MS);
  let response: Response;
  try {
    response = await env.API.fetch(new Request(`https://api.internal${path}`, { method: "GET", headers: { "x-podster-assertion": assertion }, signal: stop.signal }));
  } catch {
    return answer("upstream_unavailable", stop.signal.aborted ? 504 : 502);
  } finally {
    clearTimeout(timer);
  }
  if (response.status !== 200) return new Response(response.body, { status: response.status, headers: { "content-type": "application/json", "x-content-type-options": "nosniff" } });
  // This path only ever serves attachments, whatever answered.
  if (!response.headers.get("content-disposition")?.startsWith("attachment;") || response.headers.get("x-content-type-options") !== "nosniff") {
    await response.body?.cancel();
    return answer("upstream_unavailable", 502);
  }
  const headers = new Headers();
  for (const name of FILE_HEADERS) {
    const value = response.headers.get(name);
    if (value) headers.set(name, value);
  }
  return new Response(response.body, { status: 200, headers });
}

/** The path for agents. `identify` reads the credential fresh, and answers `null` if it isn't one, or a refusal if it has ended. */
export async function handleAgentDownload(request: Request, url: URL, env: FileEnv, identify: (token: string) => Promise<Identity | Response | null>, withinLimit: (key: string) => Promise<boolean>): Promise<Response | null> {
  if (!isFilePath(url.pathname)) return null;
  if (request.method !== "GET") return answer("not_found", 405, { allow: "GET" });
  const token = request.headers.get("authorization")?.match(BEARER)?.[1];
  if (!token) return answer("invalid_credential", 401);
  // Reading a credential costs a lookup, so guessing is counted by who's sending and with what, before any of that.
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  const hashed = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  if (!(await withinLimit(`download:${request.headers.get("cf-connecting-ip") ?? "unknown"}:${hashed}`))) return limited();
  const identity = await identify(token);
  if (!identity) return answer("invalid_credential", 401);
  if (identity instanceof Response) return identity;
  // Before an Agent Auth token is spent, so an agent that was limited can retry with the same one.
  if (!(await withinLimit(`agent:${identity.id}`))) return limited();
  return serveFile(env, identity, url.pathname);
}
