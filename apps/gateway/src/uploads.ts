import { clientKey } from "./index";

/**
 * The bytes of an upload, on their way to the API, which decides everything. The token is what `create_upload` returned, so
 * this needs no session or credential of its own. It only checks the token's shape, so anything else goes no further and
 * can't reach a log, and a Durable Object isn't woken for it.
 *
 * A declared length is only for an early answer. A chunked upload carries none, and the API counts what really arrives.
 */
const UPLOAD_PATH = /^\/v1\/uploads\/([\w-]+)\/([\w-]+)$/;
const TOKEN_HEADER = /^Bearer upl_[0-9a-f]{64}$/;
const MAX_FILE_BYTES = 100_000_000;
const DISCARD_LIMIT_MS = 5_000;

const answer = (code: string, status: number, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify({ error: { code, message: code } }), { status, headers: { "content-type": "application/json", ...headers } });

/**
 * The request's body, passed on by hand. The API can answer before the sender has finished, as it does to a file longer than
 * announced, and sending that answer ends the request. Handing the body straight to the API, or piping it, leaves what's left to
 * fail where nothing can catch it, on every such refusal. And a sender still writing when the connection closes never reads the
 * answer. So `finish` reads and discards the rest first, for only so long, and the API's side only ever sees an end.
 */
function bytesOf(request: Request) {
  if (!request.body) return { body: null, finish: async () => {} };
  const { readable, writable } = new IdentityTransformStream();
  const reader = request.body.getReader();
  const writer = writable.getWriter();
  let answered = false;
  let stopWaiting = () => {};
  const stopped = new Promise<void>((resolve) => (stopWaiting = resolve));
  const read = (async () => {
    try {
      for (let discarded = 0; discarded <= MAX_FILE_BYTES; ) {
        const { done, value } = await reader.read();
        if (done) break;
        if (answered) discarded += value.byteLength;
        // Once the API has answered, nothing is reading this any more, so a write might never finish.
        else await Promise.race([writer.write(value).catch(() => {}), stopped]);
      }
    } catch {
      // The sender went away. An ordinary end is enough, as the API counts too few bytes and keeps nothing.
    }
    void writer.close().catch(() => {});
  })();
  return {
    body: readable,
    finish: async () => {
      answered = true;
      stopWaiting();
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([read, new Promise((resolve) => (timer = setTimeout(resolve, DISCARD_LIMIT_MS)))]);
      clearTimeout(timer);
      void reader.cancel().catch(() => {});
    },
  };
}

export async function handleUpload(request: Request, url: URL, api: Fetcher, withinLimit: (key: string) => Promise<boolean>): Promise<Response | null> {
  const path = url.pathname.match(UPLOAD_PATH);
  if (!path) return null;
  if (request.method !== "PUT") return answer("not_found", 405, { allow: "PUT" });
  if (Number(request.headers.get("content-length") ?? 0) > MAX_FILE_BYTES) return answer("file_too_large", 413);
  const token = request.headers.get("authorization") ?? "";
  if (!TOKEN_HEADER.test(token)) return answer("upload_not_found", 404);
  // By who's sending and with what, so that someone guessing at an upload can't use up the limit of the person it belongs to.
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  const hashed = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  if (!(await withinLimit(`upload:${clientKey(request)}:${hashed}`))) return answer("rate_limited", 429, { "retry-after": "60" });
  const headers = new Headers({ authorization: token });
  try {
    // No timeout, as a large file on a slow connection takes as long as it takes, and it ends if the sender goes away.
    const { body, finish } = bytesOf(request);
    const response = await api.fetch(new Request(`https://api.internal${url.pathname}`, { method: "PUT", headers, body }));
    await finish();
    return new Response(response.body, { status: response.status, headers: { "content-type": "application/json" } });
  } catch {
    return answer("upstream_unavailable", 502);
  }
}
