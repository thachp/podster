import { createHash, createVerify, generateKeyPairSync } from "node:crypto";

// A stand-in for the part of GitHub the release job's read uses (M6 step 5): the read-only App's installation token,
// two tree reads and raw blobs, and nothing else. It is apart from `fake-github.ts`, which stands in for the other
// three Apps: this App has its own ID, installation and key, and a call that isn't this App's is left to that file.
// Everything it holds is in memory, in the test run's own process.

export const FAKE_RELEASE = { appId: 777004, installationId: 888004 };
const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
/** As GitHub hands an App's key out: PKCS#1 PEM. */
export const FAKE_RELEASE_KEY_PEM = pair.privateKey.export({ type: "pkcs1", format: "pem" }) as string;

type Tree = { tree: unknown[]; truncated?: boolean };
type Repo = { trees: Record<string, Tree>; blobs: Record<string, string> };
/** What a test makes go wrong. Each is one thing GitHub, or something in its place, could answer. */
type Faults = {
  /** The token call: a status, or a token that isn't exactly what was asked for. */
  token?: number | "another_repo" | "more_permissions" | "no_token";
  /** A tree read, by the sha asked for: a status, an answer too long to parse, or one that isn't a tree. */
  tree?: Record<string, number | "too_long" | "not_a_tree">;
  /** A blob read, by its sha: a status, bytes that aren't the file's, or more bytes than a file may have. */
  blob?: Record<string, number | "other_bytes" | "too_long">;
  /** What revoking the token answers. 204 unless set. */
  revoke?: number;
};
let repos = new Map<number, Repo>();
let faults: Faults = {};
let calls: { method: string; path: string; accept: string | null; auth: "app" | "token" | "bad" }[] = [];
let tokens = new Map<string, { repo: number; permissions: Record<string, string>; revoked: boolean }>();
let minted: unknown[] = [];
/** Blob reads under way at once, and the most there ever were: the job fetches ten at a time. */
let blobsUnderWay = 0;
let mostBlobsAtOnce = 0;

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const decode = (part: string) => JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
/** Whether a bearer is this App's own JWT: its ID, RS256, ten minutes at most, signed with its key. */
function ownJwt(bearer: string): boolean {
  const [header, claims, signature] = bearer.split(".");
  if (!header || !claims || !signature) return false;
  try {
    const { alg, typ } = decode(header);
    const { iss, iat, exp } = decode(claims);
    const now = Math.floor(Date.now() / 1000);
    if (alg !== "RS256" || typ !== "JWT" || iss !== String(FAKE_RELEASE.appId)) return false;
    if (typeof iat !== "number" || typeof exp !== "number" || exp - iat > 600 || iat > now || exp < now) return false;
    return createVerify("RSA-SHA256").update(`${header}.${claims}`).verify(pair.publicKey, Buffer.from(signature, "base64url"));
  } catch {
    return false;
  }
}
/** Git's name for a file's bytes: the SHA-1 of `blob <length>\0` and then the bytes. */
export const blobSha = (bytes: Uint8Array) => createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");

export async function fakeGithubRelease(request: Request): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.hostname === "github-release-fake.example.com") {
    if (url.pathname === "/reset") { repos = new Map(); faults = {}; calls = []; tokens = new Map(); minted = []; blobsUnderWay = 0; mostBlobsAtOnce = 0; return json({ ok: true }); }
    if (url.pathname === "/seed") {
      const { repo, trees, blobs } = (await request.json()) as { repo: number; trees: Record<string, Tree>; blobs: Record<string, string> };
      repos.set(repo, { trees, blobs });
      return json({ ok: true });
    }
    if (url.pathname === "/fault") { faults = (await request.json()) as Faults; return json({ ok: true }); }
    if (url.pathname === "/state") return json({ calls, minted, mostBlobsAtOnce, tokens: [...tokens.values()].map(({ repo, permissions, revoked }) => ({ repo, permissions, revoked })) });
    return json({ message: "no such control" }, 404);
  }
  if (url.hostname !== "api.github.com") return null;
  const bearer = request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
  const path = url.pathname + url.search;
  const held = tokens.get(bearer);
  const log = (auth: "app" | "token" | "bad") => calls.push({ method: request.method, path, accept: request.headers.get("accept"), auth });

  // The token call, for this App's installation only.
  if (url.pathname === `/app/installations/${FAKE_RELEASE.installationId}/access_tokens`) {
    const own = request.method === "POST" && ownJwt(bearer);
    log(own ? "app" : "bad");
    if (!own) return json({ message: "Bad credentials" }, 401);
    const body = (await request.json()) as { repository_ids?: number[]; permissions?: Record<string, string> };
    minted.push(body);
    if (typeof faults.token === "number") return json({ message: "SECRET-PROVIDER-TEXT" }, faults.token);
    const repo = body.repository_ids?.[0] ?? 0;
    const token = `ghs_release_${crypto.randomUUID().replaceAll("-", "")}`;
    const granted = faults.token === "more_permissions" ? { ...body.permissions, pull_requests: "write" } : { ...body.permissions };
    const named = faults.token === "another_repo" ? repo + 1 : repo;
    tokens.set(token, { repo: named, permissions: granted, revoked: false });
    return json({ ...(faults.token === "no_token" ? {} : { token }), expires_at: new Date(Date.now() + 3_600_000).toISOString(), permissions: granted, repository_selection: "selected", repositories: [{ id: named }] }, 201);
  }
  // Everything else here is asked with one of this App's tokens. Anything not asked with one is not this file's.
  if (!held) return null;
  log(held.revoked ? "bad" : "token");
  if (held.revoked) return json({ message: "Bad credentials" }, 401);
  if (url.pathname === "/installation/token" && request.method === "DELETE") {
    if (faults.revoke && faults.revoke !== 204) return json({ message: "SECRET-PROVIDER-TEXT" }, faults.revoke);
    held.revoked = true;
    return new Response(null, { status: 204 });
  }
  if (request.method !== "GET") return json({ message: "Resource not accessible by integration" }, 403);
  const tree = url.pathname.match(/^\/repositories\/(\d+)\/git\/trees\/([0-9a-f]{40})$/);
  const blob = url.pathname.match(/^\/repositories\/(\d+)\/git\/blobs\/([0-9a-f]{40})$/);
  const repo = Number((tree ?? blob)?.[1]);
  // A token reaches the one repository it was minted for, and reads only.
  if (!(tree || blob) || repo !== held.repo || !repos.has(repo)) return json({ message: "Not Found" }, 404);
  if (tree) {
    const fault = faults.tree?.[tree[2]];
    if (typeof fault === "number") return json({ message: "SECRET-PROVIDER-TEXT" }, fault);
    if (fault === "not_a_tree") return json({ sha: tree[2], url: "x" });
    const found = repos.get(repo)!.trees[tree[2]];
    if (!found) return json({ message: "Not Found" }, 404);
    // Asked for recursively or not, this stand-in answers what the test seeded under that sha.
    const answer = { sha: tree[2], tree: found.tree, truncated: found.truncated ?? false };
    return json(fault === "too_long" ? { ...answer, padding: "x".repeat(1_000_001) } : answer);
  }
  // Counted while the answer is held for one turn of the event loop, so reads sent together are seen together.
  blobsUnderWay += 1;
  mostBlobsAtOnce = Math.max(mostBlobsAtOnce, blobsUnderWay);
  await new Promise((turn) => setImmediate(turn));
  blobsUnderWay -= 1;
  const fault = faults.blob?.[blob![2]];
  if (typeof fault === "number") return json({ message: "SECRET-PROVIDER-TEXT" }, fault);
  const stored = repos.get(repo)!.blobs[blob![2]];
  if (stored === undefined) return json({ message: "Not Found" }, 404);
  // The file's own bytes only for the raw type, as the job asks. A type no file should be given, to show it is never read.
  if (request.headers.get("accept") !== "application/vnd.github.raw+json") return json({ message: "this stand-in answers raw reads only" }, 415);
  const bytes = fault === "too_long" ? new Uint8Array(5_000_001) : fault === "other_bytes" ? new TextEncoder().encode("not the file") : Buffer.from(stored, "base64");
  return new Response(bytes, { headers: { "content-type": "text/html; charset=utf-16be" } });
}
