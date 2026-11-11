// A stand-in for GitHub's REST API, for the provisioning tests (M5 step 4). It runs in the test runner, as the Workers'
// outbound service, so no test or CI run ever reaches GitHub. It checks what the real one would: the App's JWT is RS256
// under the provisioning App's key, names that App and lives under ten minutes, and every other call carries a token this
// fake issued. A test scripts how it misbehaves through `github-fake.example.com`, and reads back every call it saw.
// It keeps no token or key in what it reports, except the agent-token App's tokens (M5 step 6), which a test must see
// to show that none of them reaches a store, a log or an error, and which are made-up test values.
import { createVerify, generateKeyPairSync } from "node:crypto";

export const FAKE_GITHUB = { orgLogin: "podster-test-org", orgId: 4242, provisionAppId: 777001, installationId: 888001, mergeAppId: 777003, agentAppId: 777002, agentInstallationId: 888002, mergeInstallationId: 888003, mergeBotId: 990003 };
const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
/** As GitHub hands an App's key out: PKCS#1 PEM. */
export const FAKE_APP_KEY_PEM = privateKey.export({ type: "pkcs1", format: "pem" }) as string;
// The agent-token App has a key of its own, so a token minted with the provisioning App's key is refused.
const agentPair = generateKeyPairSync("rsa", { modulusLength: 2048 });
export const FAKE_AGENT_KEY_PEM = agentPair.privateKey.export({ type: "pkcs1", format: "pem" }) as string;
// And the merge App (M5 step 7b) a third, with its own installation.
const mergePair = generateKeyPairSync("rsa", { modulusLength: 2048 });
export const FAKE_MERGE_KEY_PEM = mergePair.privateKey.export({ type: "pkcs1", format: "pem" }) as string;

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
  /** A status for revoking a token, if not 204. The token then stays live. */
  revoke?: number;
};
/**
 * The agent-token App's side (M5 step 6), kept apart from everything above so specs running in parallel can't reset it:
 * each test registers a repository of its own, and its script and tokens are that repository's.
 * `mode` is how the answer differs from what was asked: wide (every repository), extra_permission, other_repo,
 * no_repositories, long_life (two hours), slow (answers after 200 ms), hang (no answer in time), or gate (answers only
 * once the test releases it through `/agent-release`, having seen it waiting through `/agent-gate`, so a test can do
 * something while a mint is under way without sleeping). `revoke` is a status for revoking, if not 204, and `mint` one
 * for the token request itself, if not 201.
 */
type AgentScript = {
  mode?: string; revoke?: number; pulls?: Record<string, Pull | null>; pullRead?: number; mint?: number;
  /** The merge App's side (M5 step 7b). `mergeMint` is a status for its token request, if not 201, and `status` one for setting a commit status. */
  mergeMint?: number; status?: number;
  /** How the merge call goes: ok; lost (merges, then answers 500); error (answers 500, merges nothing); refuse (405, as the rules would); moved (the head changes first, so 409); merged_by_other (someone merges another head first, so 200). */
  merge?: string;
  /** What comparing with the default branch says, whatever is there: a status such as "ahead", or a number for a failed read. */
  compare?: string | number;
  /** Commits the default branch holds. A merge adds the pull request's head. */
  has?: string[];
};
/** Commit statuses set on a test's repository, and every call a merge App token made about it. */
const statuses = new Map<number, { sha: string; state: string; context: string }[]>();
const mergeCalls: { repo: number; method: string; path: string; permissions: Record<string, string>; status: number; body: unknown }[] = [];
/**
 * Repositories as provisioning left them, for the merge job's readiness read-back (M5 step 7b): Actions off, the two
 * rulesets, an initial commit. Each is one test's own, with its own script, and apart from the provisioning spec's
 * repositories, tokens and call log, which that spec resets while others run.
 */
type ReadyScript = { readRepo?: number; actionsRead?: number; hideBypass?: boolean; token?: number };
const readyRepos = new Map<number, Repo & { script: ReadyScript }>();
const readyTokens = new Map<string, number[]>();
const readyIssued = new Set<string>();
const readyReads: { repo: number; path: string; scope: number[] }[] = [];
const readyRulesets = (): Ruleset[] => [
  { id: 1, name: "podster-review", target: "branch", enforcement: "active", conditions: { ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] } }, bypass_actors: [], source_type: "Repository",
    rules: [{ type: "pull_request", parameters: { required_approving_review_count: 0, dismiss_stale_reviews_on_push: false, require_code_owner_review: false, require_last_push_approval: false, required_review_thread_resolution: false } },
      { type: "required_status_checks", parameters: { strict_required_status_checks_policy: false, required_status_checks: [{ context: "podster/review", integration_id: FAKE_GITHUB.mergeAppId }] } }] },
  { id: 2, name: "podster-update", target: "branch", enforcement: "active", conditions: { ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] } }, bypass_actors: [{ actor_id: FAKE_GITHUB.mergeAppId, actor_type: "Integration", bypass_mode: "always" }], source_type: "Repository",
    rules: [{ type: "update" }] },
];
/** Mints held by `mode: "gate"`, by repository, until a test releases them. */
const gates = new Map<number, (() => void)[]>();
/**
 * A pull request of a test's repository, for the server's own read (M5 step 7a). `head_repo` and `base_repo` default to
 * the repository itself; `head_repo: null` is a fork that's gone. `as_number` answers with another number than asked.
 * `padding` makes the description that many bytes long. A null entry removes the pull request.
 */
type Pull = { head_sha: string; base_sha: string; base_ref?: string; head_repo?: number | null; base_repo?: number; state?: "open" | "closed"; merged?: boolean; merge_commit_sha?: string; merged_by?: number; as_number?: number; padding?: number; draft?: boolean };
/** Every read an agent-token App token made, by repository: what it asked for and what the token could do. */
const agentReads: { repo: number; path: string; permissions: Record<string, string>; status: number }[] = [];
type AgentToken = { token: string; repo: number[] | "all"; permissions: Record<string, string>; asked: unknown; forRepo: number; app: "agent" | "merge" };
const agentRepos = new Map<number, AgentScript>();
const agentTokens: AgentToken[] = [];
const agentLive = new Set<string>();
/** `scope` is what the call's token could reach: the whole installation, or these repositories. */
type Call = { method: string; path: string; body: unknown; auth: "app" | "token" | "bad" | "none"; scope?: "all" | number[] };

let repos = new Map<number, Repo>();
let tokens = new Map<string, "all" | number[]>();
let calls: Call[] = [];
let script: Script = {};
let nextId = 9000;
let nextRuleset = 100;
let creations = 0;

const json = (body: unknown, status = 200) => new Response(body === null ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const decode = (part: string) => JSON.parse(Buffer.from(part, "base64url").toString("utf8"));

/** Which App signed a valid JWT for its own installation, or null. Each App's key and installation are its own. */
function appJwtValid(bearer: string, installation: string): "provision" | "agent" | "merge" | null {
  const [header, claims, signature] = bearer.split(".");
  if (!header || !claims || !signature) return null;
  try {
    const { alg, typ } = decode(header);
    const { iss, iat, exp } = decode(claims);
    const now = Math.floor(Date.now() / 1000);
    const app = iss === String(FAKE_GITHUB.provisionAppId) && installation === String(FAKE_GITHUB.installationId) ? "provision"
      : iss === String(FAKE_GITHUB.agentAppId) && installation === String(FAKE_GITHUB.agentInstallationId) ? "agent"
      : iss === String(FAKE_GITHUB.mergeAppId) && installation === String(FAKE_GITHUB.mergeInstallationId) ? "merge" : null;
    if (alg !== "RS256" || typ !== "JWT" || !app) return null;
    if (typeof iat !== "number" || typeof exp !== "number" || exp - iat > 600 || iat > now || exp < now) return null;
    const key = app === "agent" ? agentPair.publicKey : app === "merge" ? mergePair.publicKey : publicKey;
    return createVerify("RSA-SHA256").update(`${header}.${claims}`).verify(key, Buffer.from(signature, "base64url")) ? app : null;
  } catch {
    return null;
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
      tokens = new Map();
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
    if (url.pathname === "/agent-repo") {
      const { id, ...rest } = (await request.json()) as AgentScript & { id: number };
      const before = agentRepos.get(id) ?? {};
      agentRepos.set(id, { ...before, ...rest, pulls: { ...(before.pulls ?? {}), ...(rest.pulls ?? {}) } });
      return json({ ok: true });
    }
    if (url.pathname === "/ready-repo") {
      // Makes this test's repository as provisioning would have left it, or changes it: `actionsEnabled`, `archived`,
      // `rulesets` (none, no_update, extra_bypass, inactive, extra), and a `script` for its reads.
      const { id, script: readyScript, rulesets, ...patch } = (await request.json()) as { id: number; script?: ReadyScript; rulesets?: string } & Partial<Repo>;
      const repo = readyRepos.get(id) ?? { id, name: `repo-${id}`, ownerId: FAKE_GITHUB.orgId, private: false, archived: false, actionsEnabled: false, hasCommit: true, defaultBranch: "main", rulesets: readyRulesets(), script: {} };
      Object.assign(repo, patch);
      if (readyScript) repo.script = readyScript;
      if (rulesets) {
        const made = readyRulesets();
        if (rulesets === "none") repo.rulesets = [];
        if (rulesets === "no_update") repo.rulesets = [made[0]];
        if (rulesets === "inactive") repo.rulesets = [made[0], { ...made[1], enforcement: "disabled" }];
        if (rulesets === "extra_bypass") repo.rulesets = [made[0], { ...made[1], bypass_actors: [...(made[1].bypass_actors ?? []), { actor_id: 1, actor_type: "OrganizationAdmin", bypass_mode: "always" }] }];
        if (rulesets === "extra") repo.rulesets = [...made, { ...made[1], id: 3, name: "someone-elses" }];
        if (rulesets === "ready") repo.rulesets = made;
      }
      readyRepos.set(id, repo);
      return json({ ok: true });
    }
    if (url.pathname === "/ready-reads") {
      const repo = Number(url.searchParams.get("repo"));
      return json({ reads: readyReads.filter((r) => r.repo === repo).map(({ repo: _, ...r }) => r), live: [...readyTokens.values()].filter((scope) => scope.includes(repo)).length });
    }
    if (url.pathname === "/merge-calls") {
      const repo = Number(url.searchParams.get("repo"));
      return json({ calls: mergeCalls.filter((c) => c.repo === repo).map(({ repo: _, ...c }) => c), statuses: statuses.get(repo) ?? [], pulls: agentRepos.get(repo)?.pulls ?? {}, has: agentRepos.get(repo)?.has ?? [] });
    }
    if (url.pathname === "/agent-gate") {
      return json({ waiting: gates.get(Number(url.searchParams.get("repo")))?.length ?? 0 });
    }
    if (url.pathname === "/agent-release") {
      const { id } = (await request.json()) as { id: number };
      for (const open of gates.get(id)?.splice(0) ?? []) open();
      return json({ ok: true });
    }
    if (url.pathname === "/agent-reads") {
      const repo = Number(url.searchParams.get("repo"));
      return json(agentReads.filter((r) => r.repo === repo).map(({ repo: _, ...r }) => r));
    }
    if (url.pathname === "/agent-tokens") {
      const repo = Number(url.searchParams.get("repo"));
      return json(agentTokens.filter((t) => t.forRepo === repo).map(({ forRepo: _, app: __, ...t }) => ({ ...t, live: agentLive.has(t.token) })));
    }
    if (url.pathname === "/forget-calls") {
      calls = [];
      return json({ ok: true });
    }
    return json({ calls, repos: [...repos.values()], liveTokens: [...tokens.values()] });
  }
  if (url.hostname !== "api.github.com") return null;

  const text = request.method === "GET" ? "" : await request.text();
  const body = text ? JSON.parse(text) : null;
  const bearer = request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
  const path = url.pathname;
  const tokenRoute = path.match(/^\/app\/installations\/(\d+)\/access_tokens$/);
  const app = tokenRoute && bearer ? appJwtValid(bearer, tokenRoute[1]) : null;
  const auth: Call["auth"] = !bearer ? "none" : tokenRoute ? (app ? "app" : "bad") : tokens.has(bearer) ? "token" : "bad";
  const scope = tokens.get(bearer);
  // The agent-token App's calls are its own, apart from the provisioning tests' log.
  const agentCall = app === "agent" || app === "merge" || agentLive.has(bearer) || agentTokens.some((t) => t.token === bearer);
  // A read-back of one test's own repository, by the provisioning App, is that test's and not the provisioning spec's.
  const wantedIds: unknown = body?.repository_ids;
  const readyMint = !!tokenRoute && app === "provision" && Array.isArray(wantedIds) && wantedIds.length > 0 && wantedIds.every((id) => readyRepos.has(id as number));
  const readyCall = readyMint || readyIssued.has(bearer);
  if (!agentCall && !readyCall) calls.push({ method: request.method, path, body, auth, ...(scope ? { scope } : {}) });
  const versioned = request.headers.get("x-github-api-version") === "2022-11-28" && request.headers.get("accept") === "application/vnd.github+json" && !!request.headers.get("user-agent");
  if (!versioned) return json({ message: "missing headers" }, 400);

  if (tokenRoute) {
    if (request.method !== "POST" || auth !== "app") return json({ message: "Bad credentials" }, 401);
    if (app === "agent" || app === "merge") return agentMint(body, app);
    if (readyMint) {
      const ids = wantedIds as number[];
      const refused = readyRepos.get(ids[0])?.script.token;
      if (refused && refused !== 201) return json({ message: "SECRET-PROVIDER-TEXT" }, refused);
      const token = `ghs_fake_${crypto.randomUUID().replaceAll("-", "")}`;
      readyTokens.set(token, ids);
      readyIssued.add(token);
      return json({ token, expires_at: new Date(Date.now() + 3_600_000).toISOString() }, 201);
    }
    if (script.token && script.token !== 201) return json({ message: "SECRET-PROVIDER-TEXT" }, script.token);
    const token = `ghs_fake_${crypto.randomUUID().replaceAll("-", "")}`;
    // Narrowed to the repositories asked for, as GitHub does, or good for the whole installation.
    const wanted = Array.isArray(body?.repository_ids) ? (body.repository_ids as number[]) : null;
    if (wanted && wanted.some((id) => !repos.has(id))) return json({ message: "no such repository" }, 422);
    tokens.set(token, wanted ?? "all");
    return json({ token, expires_at: new Date(Date.now() + 3_600_000).toISOString() }, 201);
  }
  if (agentLive.has(bearer) || agentTokens.some((t) => t.token === bearer)) return agentRead(request, path, bearer) ?? mergeCall(request, path, bearer, body) ?? agentRevoke(request, path, bearer);
  if (readyIssued.has(bearer)) return readyRoute(request, path, bearer);
  if (auth !== "token" || !scope) return json({ message: "Bad credentials" }, 401);
  // A token revokes itself, and is refused from then on.
  if (path === "/installation/token" && request.method === "DELETE") {
    if (script.revoke && script.revoke !== 204) return json({ message: "no" }, script.revoke);
    tokens.delete(bearer);
    return json(null, 204);
  }
  // Nothing else Podster does deletes anything. A test fails if one of these is ever seen.
  if (request.method === "DELETE" || request.method === "PATCH") return json({ message: "not here" }, 405);

  const creating = path.match(/^\/orgs\/([^/]+)\/repos$/);
  if (creating && request.method === "POST") {
    if (creating[1] !== FAKE_GITHUB.orgLogin) return json({ message: "Not Found" }, 404);
    // A token narrowed to repositories can't make one.
    if (scope !== "all") return json({ message: "Resource not accessible by integration" }, 403);
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
  // A narrowed token sees only its own repositories.
  if (scope !== "all" && !scope.includes(repo.id)) return json({ message: "Not Found" }, 404);
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

/** A token request from the agent-token App, answered as GitHub does: the permissions and repositories it granted. */
async function agentMint(body: any, app: "agent" | "merge"): Promise<Response> {
  const wanted = Array.isArray(body?.repository_ids) ? (body.repository_ids as number[]) : null;
  const script = wanted?.length === 1 ? agentRepos.get(wanted[0]) : undefined;
  if (!wanted || !script) return json({ message: "no such repository" }, 422);
  const mode = script.mode ?? "ok";
  // The gate first, so a test can change how this mint answers while it waits there.
  if (mode === "gate") await new Promise<void>((open) => gates.set(wanted[0], [...(gates.get(wanted[0]) ?? []), open]));
  const now = agentRepos.get(wanted[0]) ?? script;
  const refused = app === "merge" ? now.mergeMint : now.mint;
  if (refused && refused !== 201) return json({ message: "SECRET-PROVIDER-TEXT" }, refused);
  if (mode === "hang" || mode === "slow") await new Promise((resolve) => setTimeout(resolve, mode === "hang" ? 1500 : 200));
  const token = `ghs_fake_${crypto.randomUUID().replaceAll("-", "")}`;
  const permissions: Record<string, string> = { ...(body?.permissions ?? {}), ...(mode === "extra_permission" ? { administration: "write" } : {}) };
  const scope: number[] | "all" = mode === "wide" ? "all" : mode === "other_repo" ? [...wanted, 1] : wanted;
  agentLive.add(token);
  agentTokens.push({ token, repo: scope, permissions, asked: body, forRepo: wanted[0], app });
  const life = mode === "long_life" ? 7_200_000 : 3_600_000;
  const repositories = mode === "no_repositories" || scope === "all" ? undefined : scope.map((id) => ({ id, name: `repo-${id}` }));
  return json({ token, expires_at: new Date(Date.now() + life).toISOString(), permissions, repository_selection: scope === "all" ? "all" : "selected", ...(repositories ? { repositories } : {}) }, 201);
}

/** An agent token revoking itself. One already revoked is refused, as GitHub refuses a token it no longer knows. */
function agentRevoke(request: Request, path: string, bearer: string): Response {
  if (!agentLive.has(bearer)) return json({ message: "Bad credentials" }, 401);
  if (path !== "/installation/token" || request.method !== "DELETE") return json({ message: "not here" }, 405);
  const repo = agentTokens.find((t) => t.token === bearer)?.forRepo;
  const status = (repo !== undefined ? agentRepos.get(repo)?.revoke : undefined) ?? 204;
  if (status !== 204) return json({ message: "no" }, status);
  agentLive.delete(bearer);
  return json(null, 204);
}

/**
 * A live agent-token App token reading a pull request, as GitHub answers: only for a repository the token reaches, and
 * only with pull requests readable. The answer carries a title, a body, branch names and an author, none of which
 * Podster may keep or log. Null for anything that isn't such a read.
 */
function agentRead(request: Request, path: string, bearer: string): Response | null {
  const asked = path.match(/^\/repositories\/(\d+)\/pulls\/(\d+)$/);
  const held = agentTokens.find((t) => t.token === bearer);
  if (!asked || request.method !== "GET" || !held || !agentLive.has(bearer)) return null;
  const repo = Number(asked[1]);
  const answer = (body: unknown, status = 200) => {
    agentReads.push({ repo, path, permissions: held.permissions, status });
    return json(body, status);
  };
  const reaches = held.repo === "all" || held.repo.includes(repo);
  if (!reaches || !held.permissions.pull_requests) return answer({ message: "Resource not accessible by integration" }, 403);
  const script = agentRepos.get(repo);
  if (script?.pullRead && script.pullRead !== 200) return answer({ message: "SECRET-PROVIDER-TEXT" }, script.pullRead);
  const pull = script?.pulls?.[asked[2]];
  if (!pull) return answer({ message: "Not Found" }, 404);
  const side = (id: number | null) => (id === null ? null : { id, name: "SECRET-REPO-NAME", full_name: "SECRET-OWNER/SECRET-REPO-NAME" });
  const merged = pull.merged === true;
  return answer({
    number: pull.as_number ?? Number(asked[2]),
    state: pull.state ?? (merged ? "closed" : "open"),
    merged,
    draft: pull.draft === true,
    merge_commit_sha: merged ? (pull.merge_commit_sha ?? null) : null,
    merged_by: merged && pull.merged_by ? { id: pull.merged_by, login: "SECRET-MERGER" } : null,
    title: "SECRET-PR-TITLE",
    body: `SECRET-PR-BODY${"x".repeat(pull.padding ?? 0)}`,
    user: { id: 31337, login: "SECRET-AUTHOR" },
    labels: [{ name: "SECRET-LABEL" }],
    head: { ref: "SECRET-HEAD-BRANCH", label: "SECRET-OWNER:SECRET-HEAD-BRANCH", sha: pull.head_sha, repo: side(pull.head_repo === undefined ? repo : pull.head_repo) },
    base: { ref: pull.base_ref ?? "main", sha: pull.base_sha, repo: side(pull.base_repo ?? repo) },
  });
}

/** The provisioning App reading back one test's own repository, with a token narrowed to it. */
function readyRoute(request: Request, path: string, bearer: string): Response {
  const scope = readyTokens.get(bearer);
  if (!scope) return json({ message: "Bad credentials" }, 401);
  if (path === "/installation/token" && request.method === "DELETE") {
    readyTokens.delete(bearer);
    return json(null, 204);
  }
  // A read-back reads. Anything else from it would be a bug.
  if (request.method !== "GET") return json({ message: "not here" }, 405);
  const scoped = path.match(/^\/repositories\/(\d+)(\/.*)?$/);
  const repo = scoped ? readyRepos.get(Number(scoped[1])) : undefined;
  if (!scoped || !repo || !scope.includes(repo.id)) return json({ message: "Not Found" }, 404);
  readyReads.push({ repo: repo.id, path, scope });
  const rest = scoped[2] ?? "";
  if (rest === "") return repo.script.readRepo ? json({ message: "SECRET-PROVIDER-TEXT" }, repo.script.readRepo) : json(repoView(repo));
  if (rest === `/branches/${repo.defaultBranch}`) return repo.hasCommit ? json({ name: repo.defaultBranch, commit: { sha: "c0".repeat(20) } }) : json({ message: "Branch not found" }, 404);
  if (rest === "/actions/permissions") return repo.script.actionsRead ? json({ message: "no" }, repo.script.actionsRead) : json({ enabled: repo.actionsEnabled });
  if (rest.startsWith("/rulesets") && rest.replace(/\?.*$/, "") === "/rulesets") return json(repo.rulesets.map((r) => ({ id: r.id, name: r.name, source_type: r.source_type })));
  const one = rest.match(/^\/rulesets\/(\d+)$/);
  const found = one ? repo.rulesets.find((r) => r.id === Number(one[1])) : undefined;
  if (!found) return json({ message: "Not Found" }, 404);
  const { bypass_actors: _, ...visible } = found;
  return json(repo.script.hideBypass ? visible : found);
}

/**
 * A live token setting a commit status, merging a pull request or comparing with the default branch (M5 step 7b), as
 * GitHub answers with the two rulesets in place: only the merge App's token merges, only a commit that App marked, and
 * only while the pull request's head is the commit named. A second merge call on a merged pull request answers 200
 * again, as GitHub's does. Null for anything else.
 */
function mergeCall(request: Request, path: string, bearer: string, body: any): Response | null {
  const held = agentTokens.find((t) => t.token === bearer);
  const marking = path.match(/^\/repositories\/(\d+)\/statuses\/([0-9a-f]+)$/);
  const merging = path.match(/^\/repositories\/(\d+)\/pulls\/(\d+)\/merge$/);
  const comparing = path.match(/^\/repositories\/(\d+)\/compare\/([^.]+)\.\.\.([0-9a-f]+)$/);
  const asked = marking ?? merging ?? comparing;
  if (!asked || !held || !agentLive.has(bearer)) return null;
  const repo = Number(asked[1]);
  const answer = (payload: unknown, status = 200) => {
    mergeCalls.push({ repo, method: request.method, path, permissions: held.permissions, status, body });
    return json(payload, status);
  };
  const denied = () => answer({ message: "Resource not accessible by integration" }, 403);
  const reaches = held.repo === "all" || held.repo.includes(repo);
  if (!reaches) return denied();
  const script = agentRepos.get(repo) ?? {};
  if (marking && request.method === "POST") {
    if (held.app !== "merge" || held.permissions.statuses !== "write") return denied();
    if (script.status && script.status !== 201) return answer({ message: "SECRET-PROVIDER-TEXT" }, script.status);
    statuses.set(repo, [...(statuses.get(repo) ?? []), { sha: marking[2], state: body?.state, context: body?.context }]);
    return answer({ state: body?.state, context: body?.context, description: "SECRET-STATUS-TEXT" }, 201);
  }
  if (comparing && request.method === "GET") {
    if (!held.permissions.contents) return denied();
    if (typeof script.compare === "number") return answer({ message: "SECRET-PROVIDER-TEXT" }, script.compare);
    const has = (script.has ?? []).includes(comparing[3]);
    return answer({ status: script.compare ?? (has ? "behind" : "ahead"), commits: [{ commit: { message: "SECRET-COMMIT-MESSAGE" } }] });
  }
  if (merging && request.method === "PUT") {
    // The update rule: only the merge App may change the default branch.
    if (held.app !== "merge") return answer({ message: "Repository rule violations found" }, 405);
    if (held.permissions.contents !== "write" || held.permissions.pull_requests !== "write") return denied();
    const pull = script.pulls?.[merging[2]];
    if (!pull) return answer({ message: "Not Found" }, 404);
    if (script.merge === "error") return answer({ message: "SECRET-PROVIDER-TEXT" }, 500);
    if (script.merge === "refuse") return answer({ message: "Repository rule violations found" }, 405);
    // Someone pushes just before the call lands: GitHub refuses, since the head isn't the commit named any more.
    if (script.merge === "moved" && !pull.merged) pull.head_sha = "ee".repeat(20);
    // Someone else merges a different head just before the call lands. GitHub then answers 200 to this call too.
    if (script.merge === "merged_by_other" && !pull.merged) Object.assign(pull, { head_sha: "ee".repeat(20), merged: true, state: "closed", merge_commit_sha: "8d".repeat(20), merged_by: 31337 });
    // Already merged: GitHub says it merged, again.
    if (pull.merged) return answer({ sha: pull.merge_commit_sha, merged: true, message: "Pull Request successfully merged" });
    if ((pull.state ?? "open") !== "open" || pull.draft) return answer({ message: "Pull Request is not mergeable" }, 405);
    if (body?.sha !== pull.head_sha) return answer({ message: "Head branch was modified. Review and try the merge again." }, 409);
    if (body?.merge_method !== "merge") return answer({ message: "merge method not allowed" }, 405);
    // The review rule: a status the merge App set on exactly this commit.
    const marked = (statuses.get(repo) ?? []).some((s) => s.sha === pull.head_sha && s.state === "success" && s.context === "podster/review");
    if (!marked) return answer({ message: "Required status check \"podster/review\" is expected." }, 405);
    Object.assign(pull, { merged: true, state: "closed", merge_commit_sha: "9e".repeat(20), merged_by: FAKE_GITHUB.mergeBotId });
    agentRepos.set(repo, { ...script, has: [...(script.has ?? []), pull.head_sha] });
    if (script.merge === "lost") return answer({ message: "SECRET-PROVIDER-TEXT" }, 500);
    return answer({ sha: pull.merge_commit_sha, merged: true, message: "Pull Request successfully merged" });
  }
  return null;
}
