// A stand-in for GitHub's REST API, for the provisioning tests (M5 step 4). It runs in the test runner, as the Workers'
// outbound service, so no test or CI run ever reaches GitHub. It checks what the real one would: the App's JWT is RS256
// under the provisioning App's key, names that App and lives under ten minutes, and every other call carries a token this
// fake issued. A test scripts how it misbehaves through `github-fake.example.com`, and reads back every call it saw.
// It keeps no token or key in what it reports.
import { createVerify, generateKeyPairSync } from "node:crypto";

export const FAKE_GITHUB = { orgLogin: "podster-test-org", orgId: 4242, provisionAppId: 777001, installationId: 888001, mergeAppId: 777003 };
const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
/** As GitHub hands an App's key out: PKCS#1 PEM. */
export const FAKE_APP_KEY_PEM = privateKey.export({ type: "pkcs1", format: "pem" }) as string;

type Ruleset = { id: number; name: string; target: string; enforcement: string; conditions: unknown; bypass_actors?: unknown[]; rules: unknown[]; source_type: string };
type Repo = { id: number; name: string; ownerId: number; private: boolean; archived: boolean; actionsEnabled: boolean; hasCommit: boolean; defaultBranch: string; rulesets: Ruleset[] };
type Script = {
  /** One per creation call, the last repeating: ok, taken, forbidden, error500, lost (made, then a 500), hang (made, then no answer in time), wrong_owner, no_id. */
  create?: string[];
  /** The status for a token request, if not 201. */
  token?: number;
  /** A new repository's state, over GitHub's defaults: Actions on, an initial commit, no rulesets. */
  fresh?: Partial<Repo>;
  /** ok, ignore (says done, changes nothing), forbidden. */
  disableActions?: string;
  /** ok, inactive, extra_bypass, drop_review, drop_update, forbidden. */
  ruleset?: string;
  /** Leaves the bypass list out of a ruleset's detail, as GitHub does for a token that can't see it. */
  hideBypass?: boolean;
  /** A status for these reads, if not 200. */
  actionsRead?: number;
  readRepo?: number;
  nextId?: number;
};
type Call = { method: string; path: string; body: unknown; auth: "app" | "token" | "bad" | "none" };

let repos = new Map<number, Repo>();
let tokens = new Set<string>();
let calls: Call[] = [];
let script: Script = {};
let nextId = 9000;
let nextRuleset = 100;
let creations = 0;

const json = (body: unknown, status = 200) => new Response(body === null ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const decode = (part: string) => JSON.parse(Buffer.from(part, "base64url").toString("utf8"));

function appJwtValid(bearer: string, installation: string) {
  const [header, claims, signature] = bearer.split(".");
  if (!header || !claims || !signature) return false;
  try {
    const { alg, typ } = decode(header);
    const { iss, iat, exp } = decode(claims);
    const now = Math.floor(Date.now() / 1000);
    if (alg !== "RS256" || typ !== "JWT" || iss !== String(FAKE_GITHUB.provisionAppId) || installation !== String(FAKE_GITHUB.installationId)) return false;
    if (typeof iat !== "number" || typeof exp !== "number" || exp - iat > 600 || iat > now || exp < now) return false;
    return createVerify("RSA-SHA256").update(`${header}.${claims}`).verify(publicKey, Buffer.from(signature, "base64url"));
  } catch {
    return false;
  }
}

const repoView = (r: Repo) => ({ id: r.id, name: r.name, full_name: `${FAKE_GITHUB.orgLogin}/${r.name}`, private: r.private, archived: r.archived, default_branch: r.defaultBranch, owner: { id: r.ownerId, login: FAKE_GITHUB.orgLogin }, description: "SECRET-DESCRIPTION", html_url: `https://github.com/${FAKE_GITHUB.orgLogin}/${r.name}` });

/** Answers a request to GitHub or to the fake's control host, or returns null for any other host. */
export async function fakeGithub(request: Request): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.hostname === "github-fake.example.com") {
    if (url.pathname === "/reset") {
      script = (await request.json()) as Script;
      repos = new Map();
      tokens = new Set();
      calls = [];
      creations = 0;
      nextId = script.nextId ?? nextId + 1000;
      return json({ ok: true });
    }
    if (url.pathname === "/script") {
      script = { ...script, ...((await request.json()) as Script) };
      return json({ ok: true });
    }
    if (url.pathname === "/edit") {
      const { id, patch } = (await request.json()) as { id: number; patch: Partial<Repo> };
      const repo = repos.get(id);
      if (repo) Object.assign(repo, patch);
      return json({ ok: !!repo });
    }
    if (url.pathname === "/forget-calls") {
      calls = [];
      return json({ ok: true });
    }
    return json({ calls, repos: [...repos.values()] });
  }
  if (url.hostname !== "api.github.com") return null;

  const text = request.method === "GET" ? "" : await request.text();
  const body = text ? JSON.parse(text) : null;
  const bearer = request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
  const path = url.pathname;
  const tokenRoute = path.match(/^\/app\/installations\/(\d+)\/access_tokens$/);
  const auth: Call["auth"] = !bearer ? "none" : tokenRoute ? (appJwtValid(bearer, tokenRoute[1]) ? "app" : "bad") : tokens.has(bearer) ? "token" : "bad";
  calls.push({ method: request.method, path, body, auth });
  const versioned = request.headers.get("x-github-api-version") === "2022-11-28" && request.headers.get("accept") === "application/vnd.github+json" && !!request.headers.get("user-agent");
  if (!versioned) return json({ message: "missing headers" }, 400);

  if (tokenRoute) {
    if (request.method !== "POST" || auth !== "app") return json({ message: "Bad credentials" }, 401);
    if (script.token && script.token !== 201) return json({ message: "SECRET-PROVIDER-TEXT" }, script.token);
    const token = `ghs_fake_${crypto.randomUUID().replaceAll("-", "")}`;
    tokens.add(token);
    return json({ token, expires_at: new Date(Date.now() + 3_600_000).toISOString() }, 201);
  }
  if (auth !== "token") return json({ message: "Bad credentials" }, 401);
  // Nothing Podster does deletes anything. A test fails if one of these is ever seen.
  if (request.method === "DELETE" || request.method === "PATCH") return json({ message: "not here" }, 405);

  const creating = path.match(/^\/orgs\/([^/]+)\/repos$/);
  if (creating && request.method === "POST") {
    if (creating[1] !== FAKE_GITHUB.orgLogin) return json({ message: "Not Found" }, 404);
    const modes = script.create ?? ["ok"];
    const mode = modes[Math.min(creations, modes.length - 1)];
    creations += 1;
    if (mode === "forbidden") return json({ message: "SECRET-PROVIDER-TEXT" }, 403);
    if (mode === "taken" || [...repos.values()].some((r) => r.name === body?.name)) return json({ message: "Repository creation failed.", errors: [{ resource: "Repository", code: "custom", field: "name", message: "name already exists on this account" }] }, 422);
    if (mode === "error500") return json({ message: "SECRET-PROVIDER-TEXT" }, 500);
    const repo: Repo = { id: nextId++, name: body?.name, ownerId: mode === "wrong_owner" ? 1 : FAKE_GITHUB.orgId, private: body?.private === true, archived: false, actionsEnabled: true, hasCommit: body?.auto_init === true, defaultBranch: "main", rulesets: [], ...(script.fresh ?? {}) };
    repo.rulesets = structuredClone(repo.rulesets);
    repos.set(repo.id, repo);
    if (mode === "lost") return json({ message: "SECRET-PROVIDER-TEXT" }, 500);
    if (mode === "hang") await new Promise((resolve) => setTimeout(resolve, 1500));
    if (mode === "no_id") return json({ name: repo.name }, 201);
    return json(repoView(repo), 201);
  }

  const scoped = path.match(/^\/repositories\/(\d+)(\/.*)?$/);
  const repo = scoped ? repos.get(Number(scoped[1])) : undefined;
  if (!scoped || !repo) return json({ message: "Not Found" }, 404);
  const rest = scoped[2] ?? "";
  if (rest === "" && request.method === "GET") return script.readRepo ? json({ message: "SECRET-PROVIDER-TEXT" }, script.readRepo) : json(repoView(repo));
  if (rest === `/branches/${repo.defaultBranch}` && request.method === "GET") return repo.hasCommit ? json({ name: repo.defaultBranch, commit: { sha: "c0".repeat(20) } }) : json({ message: "Branch not found" }, 404);
  if (rest === "/actions/permissions" && request.method === "GET") return script.actionsRead ? json({ message: "no" }, script.actionsRead) : json({ enabled: repo.actionsEnabled });
  if (rest === "/actions/permissions" && request.method === "PUT") {
    if (script.disableActions === "forbidden") return json({ message: "no" }, 403);
    if (script.disableActions !== "ignore") repo.actionsEnabled = body?.enabled !== false;
    return json(null, 204);
  }
  if (rest === "/rulesets" && request.method === "GET") return json(repo.rulesets.map((r) => ({ id: r.id, name: r.name, source_type: r.source_type })));
  if (rest === "/rulesets" && request.method === "POST") {
    const mode = script.ruleset ?? "ok";
    if (mode === "forbidden") return json({ message: "no" }, 403);
    const isReview = (body?.rules ?? []).some((r: any) => r.type === "pull_request");
    const made: Ruleset = { id: nextRuleset++, name: body?.name, target: body?.target, enforcement: mode === "inactive" ? "disabled" : body?.enforcement, conditions: body?.conditions, bypass_actors: [...(body?.bypass_actors ?? []), ...(mode === "extra_bypass" && !isReview ? [{ actor_id: 1, actor_type: "OrganizationAdmin", bypass_mode: "always" }] : [])], rules: body?.rules, source_type: "Repository" };
    if (!(mode === "drop_review" && isReview) && !(mode === "drop_update" && !isReview)) repo.rulesets.push(made);
    return json(made, 201);
  }
  const one = rest.match(/^\/rulesets\/(\d+)$/);
  if (one && request.method === "GET") {
    const found = repo.rulesets.find((r) => r.id === Number(one[1]));
    if (!found) return json({ message: "Not Found" }, 404);
    const { bypass_actors, ...visible } = found;
    return json(script.hideBypass ? visible : found);
  }
  return json({ message: "Not Found" }, 404);
}
