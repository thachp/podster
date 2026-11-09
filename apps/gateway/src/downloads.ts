/**
 * A file's bytes on their way from the API, which decides everything. There's no download token or signed URL. An agent shows its own
 * credential each time and a person their session, so the gateway checks who they are and the API checks what they may have, on every
 * download. Only the API's own file headers pass, and the body is never read here.
 */
import { mintAssertion, type Identity } from "./assertion";
import { clientKey } from "./index";

const FILE_PATH = /^\/v1\/files\/[\w-]+\/[\w-]+$/;
/** The same file under the A2A resource (M3, ADR 0007): only an `/a2a`-audience token opens it. */
const A2A_FILE_PATH = /^\/a2a\/files\/([\w-]+)\/([\w-]+)$/;
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

type Identify = (token: string) => Promise<Identity | Response | null>;

/** The path for agents. `identify` reads the credential fresh, and answers `null` if it isn't one, or a refusal if it has ended. */
export async function handleAgentDownload(request: Request, url: URL, env: FileEnv, identify: Identify, withinLimit: (key: string) => Promise<boolean>): Promise<Response | null> {
  if (!isFilePath(url.pathname)) return null;
  return download(request, url.pathname, env, identify, withinLimit);
}

/**
 * `GET /a2a/files/{workspace}/{file}`: the same download for an agent that holds only an `/a2a` token. `identify` accepts
 * nothing else, so the audiences stay apart (#157): an `/mcp` token doesn't work here, and an `/a2a` token doesn't work at
 * `/v1/files`. The API runs the same file and visibility checks, on the same `/v1/files` path, and its headers pass the same way.
 */
export async function handleA2aDownload(request: Request, url: URL, env: FileEnv, identify: Identify, withinLimit: (key: string) => Promise<boolean>): Promise<Response | null> {
  const match = url.pathname.match(A2A_FILE_PATH);
  if (!match) return null;
  return download(request, `/v1/files/${match[1]}/${match[2]}`, env, identify, withinLimit);
}

async function download(request: Request, apiPath: string, env: FileEnv, identify: Identify, withinLimit: (key: string) => Promise<boolean>): Promise<Response> {
  if (request.method !== "GET") return answer("not_found", 405, { allow: "GET" });
  const token = request.headers.get("authorization")?.match(BEARER)?.[1];
  if (!token) return answer("invalid_credential", 401);
  // Reading a credential costs a lookup, so guessing is counted by client before any of that, whatever token it sends, so fresh junk
  // tokens don't each get a fresh allowance. A bucket per token as well would add nothing, as the client's runs out first.
  if (!(await withinLimit(`download:${clientKey(request)}`))) return limited();
  const identity = await identify(token);
  if (!identity) return answer("invalid_credential", 401);
  if (identity instanceof Response) return identity;
  // Before an Agent Auth token is spent, so an agent that was limited can retry with the same one.
  if (!(await withinLimit(`agent:${identity.id}`))) return limited();
  return serveFile(env, identity, apiPath);
}
