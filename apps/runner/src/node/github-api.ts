/**
 * Runner's GitHub calls (M7 step 10): the broker's side of the repository path, on the host, with the task's token. Only
 * `API_ORIGIN`, only the requests `GITHUB` in `core/repository.ts` builds, `redirect: "error"` so the token never follows
 * a redirect, no proxy or TLS trust from the environment (as the provider transport, M3 on #460), a bounded answer, and a
 * time limit. A `401` means the token no longer works, which is how a revocation shows: `token_revoked`.
 *
 * The token is never logged, returned or put in an error; nor is anything GitHub answers, beyond the checked fields the
 * caller reads.
 */
import { API_ORIGIN, RepoPathError, type GitHubRequest } from "../core/repository.js";
import { transportEnvRefusal } from "./provider-transport.js";

export type GitHubAnswer = { status: number; body: unknown };
export type GitHubCall = (request: GitHubRequest, token: string, signal?: AbortSignal) => Promise<GitHubAnswer>;

export const MAX_GITHUB_ANSWER = 1024 * 1024;
export const GITHUB_TIMEOUT_MS = 30_000;
const TOKEN = /^[A-Za-z0-9_]{20,255}$/;

async function bounded(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > MAX_GITHUB_ANSWER) {
      await reader.cancel();
      throw new RepoPathError("github_answer_too_large");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** GitHub's API, for real. Refuses to be made when the environment would choose a proxy or a certificate. */
export function githubApi(fetchImpl: typeof fetch = fetch, env: NodeJS.ProcessEnv = process.env, execArgv: readonly string[] = process.execArgv): GitHubCall {
  const refusal = transportEnvRefusal(env, execArgv);
  if (refusal) throw new Error(`Runner won't reach GitHub with this environment (${refusal}).`);
  return async (request, token, signal) => {
    if (!TOKEN.test(token)) throw new RepoPathError("access_invalid");
    if (!request.path.startsWith("/repos/") || request.path.includes("..") || /[\s#]/.test(request.path)) throw new RepoPathError("request_invalid");
    const url = new URL(request.path, API_ORIGIN);
    if (url.origin !== API_ORIGIN) throw new RepoPathError("request_invalid");
    const timeout = AbortSignal.timeout(GITHUB_TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: request.method,
        redirect: "error",
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${token}`,
          "user-agent": "podster-runner",
          "x-github-api-version": "2022-11-28",
          ...(request.body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: request.body === undefined ? undefined : JSON.stringify(request.body),
      });
    } catch {
      throw new RepoPathError("github_unreachable", true);
    }
    const text = await bounded(response);
    if (response.status === 401) throw new RepoPathError("token_revoked");
    let body: unknown = null;
    try {
      body = text === "" ? null : JSON.parse(text);
    } catch {
      body = null;
    }
    return { status: response.status, body };
  };
}
