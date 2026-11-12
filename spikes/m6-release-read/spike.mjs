#!/usr/bin/env node
// M6 spikes E and F: what reading a release from GitHub really answers, and what Actions does when it's off.
// Runs against one e2e-m5-* TEST repository in the staging organization only. Nothing builds on this file.
//
//   M6_REPO=e2e-m5-... node spike.mjs fixture   build the fixture locally and push it to NON-default branches
//   M6_REPO=e2e-m5-... node spike.mjs read      spike E: read it back with a token cut down to Contents read
//   M6_REPO=e2e-m5-... node spike.mjs actions   spike F: read the Actions setting, try to add a workflow, look for runs
//   M6_REPO=e2e-m5-... node spike.mjs limits    which request count a new token's headers report
//
// It creates no App, changes no App's permissions and no repository's settings, and never writes to a default
// branch. Every token is minted for this run, cut down at mint time to one permission and the named repository,
// held in memory only, and never printed or written. Results hold status codes, counts, sizes and GitHub's own
// messages.

import { execFileSync, spawn } from "node:child_process";
import { createHash, createPrivateKey, createSign } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const API = "https://api.github.com";
const here = dirname(fileURLToPath(import.meta.url));
const BRANCH = "spike/m6-release-read";
const ROOT = "m6-spike-e";
const FIXTURE_FILE = join(here, "fixture.json");

// ---------- pure helpers, tested offline in spike.test.mjs ----------

export function appJwt(appId, pem, now = Math.floor(Date.now() / 1000)) {
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const body = `${enc({ alg: "RS256", typ: "JWT" })}.${enc({ iat: now - 60, exp: now + 540, iss: String(appId) })}`;
  return `${body}.${createSign("RSA-SHA256").update(body).sign(createPrivateKey(pem)).toString("base64url")}`;
}

/** Only an acceptance run's leftover repository, so a typo can't point this at a real one. */
export const repoAllowed = (name) => /^e2e-m5-[0-9a-z-]+$/.test(name ?? "");

/** A mint is refused here unless it names its permissions and its repositories: an empty body would get everything the App has. */
export function mintBody(permissions, repositories) {
  if (!permissions || Object.keys(permissions).length === 0) throw new Error("refusing to mint a token with no permissions named");
  if (!Array.isArray(repositories) || repositories.length === 0 || !repositories.every(repoAllowed)) throw new Error("refusing to mint a token that isn't limited to test repositories");
  return { permissions, repositories };
}

/** Git's own order for a tree's entries: by the name's bytes, a directory's as if it ended in a slash. */
export function treeOrder(a, b) {
  const key = (e) => Buffer.concat([e.name, Buffer.from(e.mode === "40000" ? "/" : "")]);
  return Buffer.compare(key(a), key(b));
}

/** A tree object's bytes. Entries are { mode, name: Buffer, sha }. */
export function treeBytes(entries) {
  return Buffer.concat([...entries].sort(treeOrder).flatMap((e) => [Buffer.from(`${e.mode} `), e.name, Buffer.from([0]), Buffer.from(e.sha, "hex")]));
}

/** The sha Git gives a blob, so a fetched file can be checked against the tree that named it. */
export const gitBlobSha = (bytes) => createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");

/** Deterministic bytes of a given length that compress well, so a large file is a small push. */
export function patterned(length, seed) {
  const block = Buffer.alloc(1024);
  let x = seed >>> 0;
  for (let i = 0; i < block.length; i++) {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    block[i] = x >>> 24;
  }
  const out = Buffer.alloc(length);
  for (let at = 0; at < length; at += block.length) block.copy(out, at, 0, Math.min(block.length, length - at));
  return out;
}

/**
 * What the release job would decide about one tree entry, as ADR 0010 proposes it. Used to show the rules against
 * what GitHub really answers; the real rules belong in crates/core.
 */
export function entryProblem(entry) {
  if (entry.mode === "120000") return "symlink";
  if (entry.mode === "160000" || entry.type === "commit") return "submodule";
  if (entry.type === "tree") return null;
  if (entry.type !== "blob") return "unknown_kind";
  if (entry.mode !== "100644" && entry.mode !== "100755") return "unknown_mode";
  if (typeof entry.size !== "number") return "no_size";
  const path = entry.path;
  if (path.includes("�")) return "not_utf8";
  if (Buffer.byteLength(path) > 1024) return "path_too_long";
  for (const segment of path.split("/")) {
    if (segment === "" || segment === "." || segment === "..") return "bad_segment";
    if (Buffer.byteLength(segment) > 255) return "segment_too_long";
    if (segment.includes("\\")) return "backslash";
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u001f\u007f]/.test(segment)) return "control_character";
  }
  return null;
}

export function argsProblem(argv) {
  const modes = ["fixture", "read", "actions", "limits"];
  if (argv.length !== 1 || !modes.includes(argv[0])) return `usage: M6_REPO=e2e-m5-... node spike.mjs ${modes.join("|")}`;
  return null;
}

// ---------- GitHub ----------

const secrets = [];
const scrub = (text) => secrets.reduce((t, s) => t.split(s).join("[removed]"), String(text ?? ""));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let requests = 0;

function limits(headers) {
  const n = (name) => (headers.get(name) === null ? null : Number(headers.get(name)));
  return { limit: n("x-ratelimit-limit"), remaining: n("x-ratelimit-remaining"), used: n("x-ratelimit-used"), resource: headers.get("x-ratelimit-resource"), reset: n("x-ratelimit-reset"), retry_after: headers.get("retry-after") };
}

/**
 * One call. `as` is "json" (parsed), "bytes" (a Buffer) or "count" (streamed: length and sha256 only, with the first
 * 200 bytes kept). Never throws on a status.
 */
async function gh(path, { token, method = "GET", body, accept = "application/vnd.github+json", as = "json", headers = {}, redirect = "follow" } = {}) {
  const started = Date.now();
  requests += 1;
  const res = await fetch(path.startsWith("http") ? path : `${API}${path}`, {
    method,
    redirect,
    headers: { accept, "x-github-api-version": "2022-11-28", "user-agent": "m6-spike", ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { "content-type": "application/json" } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const out = { status: res.status, limits: limits(res.headers), content_type: res.headers.get("content-type"), etag: res.headers.get("etag"), location: res.headers.get("location") };
  if (as === "count" && res.ok) {
    const hash = createHash("sha256");
    let bytes = 0;
    let head = Buffer.alloc(0);
    for await (const chunk of res.body) {
      if (head.length < 200) head = Buffer.concat([head, Buffer.from(chunk)]).subarray(0, 200);
      bytes += chunk.length;
      hash.update(chunk);
    }
    Object.assign(out, { bytes, sha256: hash.digest("hex"), head: head.toString("latin1") });
  } else {
    const buffer = Buffer.from(await res.arrayBuffer());
    out.bytes = buffer.length;
    if (as === "bytes" && res.ok) out.buffer = buffer;
    else {
      try {
        out.body = JSON.parse(buffer.toString("utf8"));
      } catch {
        out.text = buffer.toString("utf8").slice(0, 300);
      }
    }
  }
  out.ms = Date.now() - started;
  return out;
}

const said = (res) => scrub(res.body?.message ?? res.text ?? "");
const brief = (res) => ({ status: res.status, ...(res.status >= 400 ? { message: said(res) } : {}) });

function staging() {
  const text = readFileSync(join(here, "../../apps/api/wrangler.jsonc"), "utf8");
  const value = (name) => {
    const found = [...text.matchAll(new RegExp(`"${name}":\\s*"([^"]+)"`, "g"))].map((m) => m[1]);
    if (new Set(found).size !== 1) throw new Error(`${name} isn't set exactly once in apps/api/wrangler.jsonc`);
    return found[0];
  };
  const app = (kind) => ({ appId: value(`GITHUB_${kind}_APP_ID`), installationId: value(`GITHUB_${kind}_INSTALLATION_ID`) });
  return { org: value("GITHUB_ORG_LOGIN"), agent: app("AGENT"), provision: app("PROVISION") };
}

async function mint(config, kind, permissions, repositories) {
  const pem = readFileSync(join(process.env.M6_KEYS ?? join(homedir(), ".podster/m5-staging"), `${kind}.pem`), "utf8");
  const jwt = appJwt(config[kind].appId, pem);
  secrets.push(jwt);
  const res = await gh(`/app/installations/${config[kind].installationId}/access_tokens`, { token: jwt, method: "POST", body: mintBody(permissions, repositories) });
  if (res.status !== 201) return { token: null, record: { asked: permissions, ...brief(res) } };
  secrets.push(res.body.token);
  return {
    token: res.body.token,
    record: { asked: permissions, status: 201, granted: res.body.permissions, repository_selection: res.body.repository_selection, repositories: (res.body.repositories ?? []).map((r) => r.name), lifetime_minutes: Math.round((Date.parse(res.body.expires_at) - Date.now()) / 60000) },
  };
}

/** Runs `worker` over `items`, `width` at a time. */
async function pool(items, width, worker) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(width, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await worker(items[i], i);
    }
  }));
  return out;
}

// ---------- git, for the fixture ----------

function gitTools(dir) {
  const env = { PATH: process.env.PATH, HOME: dir, LC_ALL: "C", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0", GIT_AUTHOR_NAME: "m6-spike", GIT_AUTHOR_EMAIL: "m6-spike@podster.invalid", GIT_AUTHOR_DATE: "2026-11-12T00:00:00Z", GIT_COMMITTER_NAME: "m6-spike", GIT_COMMITTER_EMAIL: "m6-spike@podster.invalid", GIT_COMMITTER_DATE: "2026-11-12T00:00:00Z" };
  const run = (args, input) => execFileSync("git", args, { cwd: dir, env, input, maxBuffer: 1 << 28 }).toString().trim();
  const blob = (bytes) => run(["hash-object", "-w", "--stdin"], Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes));
  // --literally: the tree is exactly these bytes, with none of git's own checks, so GitHub's are the ones seen.
  const tree = (entries) => run(["hash-object", "-w", "-t", "tree", "--literally", "--stdin"], treeBytes(entries.map((e) => ({ ...e, name: Buffer.isBuffer(e.name) ? e.name : Buffer.from(e.name) }))));
  const commit = (treeSha, message) => run(["commit-tree", treeSha, "-m", message]);
  const askpass = join(dir, "askpass.sh");
  writeFileSync(askpass, '#!/bin/sh\ncase "$1" in Username*) echo x-access-token ;; *) printf "%s\\n" "$M6_GIT_ANSWER" ;; esac\n', { mode: 0o700 });
  const push = (url, refspec, credential) =>
    new Promise((resolve) => {
      const child = spawn("git", ["-c", "credential.helper=", "push", url, refspec], { cwd: dir, env: { ...env, GIT_ASKPASS: askpass, M6_GIT_ANSWER: credential }, stdio: ["ignore", "pipe", "pipe"] });
      let err = "";
      child.stderr.on("data", (d) => (err += d));
      child.on("close", (code) => resolve({ exit: code, said: scrub(err).split("\n").filter((l) => /remote:|rejected|error|fatal|\[new branch\]/.test(l)).map((l) => l.trim()).slice(0, 8) }));
    });
  return { run, blob, tree, commit, push };
}

const FILES = [["empty.bin", 0], ["1k.bin", 1024], ["1m.bin", 1 << 20], ["5m.bin", 5 << 20], ["5m-plus-1.bin", (5 << 20) + 1], ["25m.bin", 25 << 20], ["99m.bin", 99 << 20]];
const BIG_DIRS = 101;
const BIG_FILES = 1200;
const STEPS = [10, 20, 30, 40, 60];
const FLAT = 40000;

async function fixture(config, repo) {
  const dir = mkdtempSync(join(tmpdir(), "m6-spike-"));
  try {
    const g = gitTools(dir);
    g.run(["init", "-q", "--bare", "."]);
    const file = (mode, name, sha) => ({ mode, name, sha });
    const text = (s) => g.blob(s);
    const one = text("x\n");
    const index = text("<!doctype html><title>m6 spike</title>\n");

    // app/: what a release directory might hold, and what it must not.
    const defaultHead = (await gh(`/repos/${config.org}/${repo}/commits/HEAD`, {})).body?.sha;
    if (!/^[0-9a-f]{40}$/.test(defaultHead ?? "")) throw new Error("couldn't read the default branch's head for the submodule entry");
    const app = [
      file("100644", "index.html", index),
      file("100755", "run.sh", text("#!/bin/sh\necho hi\n")),
      file("120000", "link", text("index.html")),
      file("120000", "link-out", text("../../../../etc/passwd")),
      file("160000", "sub", defaultHead),
      file("100644", "with space.txt", one),
      file("40000", "ünï", g.tree([file("100644", "文件.txt", one)])),
      file("100644", ".hidden", one),
      file("40000", ".well-known", g.tree([file("100644", "podster-release.json", text("{}\n"))])),
      file("100644", "_headers", text("/*\n  X-Spike: 1\n")),
      file("100644", "back\\slash.txt", one),
      file("100644", "tab\there.txt", one),
      file("100644", "new\nline.txt", one),
      file("100644", "Case.txt", one),
      file("100644", "case.txt", one),
      file("100644", "café.txt", one),
      file("100644", "café.txt", one),
      file("100644", Buffer.concat([Buffer.from("latin1-"), Buffer.from([0xe9]), Buffer.from(".txt")]), one),
      file("100644", "...", one),
      file("100644", " lead and trail ", one),
      file("100644", "-dash", one),
      file("100644", "a?b#c%20d&e.txt", one),
      file("100644", "s".repeat(255), one),
      file("100644", "t".repeat(300), one),
      file("40000", "emptydir", g.tree([])),
    ];
    // A path over 1,024 bytes: five 250-byte directories deep.
    let deep = g.tree([file("100644", "f.txt", one)]);
    for (let i = 0; i < 5; i++) deep = g.tree([file("40000", "d".repeat(250), deep)]);
    app.push(file("40000", "deep", deep));
    const appSha = g.tree(app);

    // rel300/: a release at the proposed cap, 300 different files.
    const rel300 = g.tree(Array.from({ length: 300 }, (_, i) => file("100644", `f${String(i).padStart(3, "0")}.txt`, text(`file ${i}\n`))));

    // big/: 101 directories of 1,200 files. Every directory is the same tree, so it is two objects.
    const sub = g.tree(Array.from({ length: BIG_FILES }, (_, i) => file("100644", `f${String(i).padStart(4, "0")}.txt`, one)));
    const dirs = (n) => g.tree(Array.from({ length: n }, (_, i) => file("40000", `d${String(i).padStart(3, "0")}`, sub)));
    const big = dirs(BIG_DIRS);
    const steps = g.tree(STEPS.map((n) => file("40000", `k${String(n).padStart(3, "0")}`, dirs(n))));
    // flat/: one directory of 40,000 files.
    const flat = g.tree(Array.from({ length: FLAT }, (_, i) => file("100644", `f${String(i).padStart(5, "0")}.txt`, one)));

    // files/: sizes around the proposed 5 MB and 25 MB caps, and just under GitHub's 100 MB.
    const sized = FILES.map(([name, length], i) => {
      const bytes = patterned(length, i + 1);
      return { name, length, sha256: createHash("sha256").update(bytes).digest("hex"), sha: g.blob(bytes) };
    });
    const files = g.tree(sized.map((f) => file("100644", f.name, f.sha)));

    const top = g.tree([file("40000", "app", appSha), file("40000", "rel300", rel300), file("40000", "big", big), file("40000", "steps", steps), file("40000", "flat", flat), file("40000", "files", files)]);
    const rootTree = g.tree([file("40000", ROOT, top)]);
    const commit = g.commit(rootTree, "m6 spike E: fixture for reading a release (test data, not a release)");

    const { token, record } = await mint(config, "agent", { contents: "write" }, [repo]);
    if (!token) throw new Error(`couldn't mint the write token: ${JSON.stringify(record)}`);
    const url = `https://github.com/${config.org}/${repo}.git`;
    const out = { repo: `${config.org}/${repo}`, written_at: new Date().toISOString(), write_token: record, default_branch_head_at_the_time: defaultHead, pushes: [] };
    const pushed = await g.push(url, `${commit}:refs/heads/${BRANCH}`, token);
    out.pushes.push({ branch: BRANCH, commit, ...pushed });
    if (pushed.exit !== 0) throw new Error(`the fixture's push was refused: ${JSON.stringify(pushed)}`);

    // What git itself forbids in a tree. Each is its own orphan commit on its own branch; GitHub should refuse each.
    const bad = {
      "dot-dot": [file("100644", "..", one)],
      dot: [file("100644", ".", one)],
      "dot-git": [file("40000", ".git", g.tree([file("100644", "config", one)]))],
      "dot-git-upper": [file("40000", ".GIT", g.tree([file("100644", "config", one)]))],
      "slash-in-name": [file("100644", "a/b", one)],
      "empty-name": [file("100644", "", one)],
      "same-name-twice": [file("100644", "twice", one), file("100644", "twice", index)],
      "gitmodules-symlink": [file("120000", ".gitmodules", text("x"))],
      "file-over-100-mb": [file("100644", "101m.bin", g.blob(patterned(101 << 20, 9)))],
    };
    for (const [name, entries] of Object.entries(bad)) {
      const branch = `spike/m6-refused-${name}`;
      const c = g.commit(g.tree([file("40000", ROOT, g.tree(entries))]), `m6 spike E: a tree GitHub should refuse (${name})`);
      out.pushes.push({ branch, commit: c, expected: "refused", ...(await g.push(url, `${c}:refs/heads/${branch}`, token)) });
    }

    // The same forbidden names through the git data API, which makes an object and no branch.
    out.api_trees = {};
    const api = `/repos/${config.org}/${repo}/git/trees`;
    for (const path of ["..", "a/../b", ".git/config", "./a", "a//b", "ok/fine.txt"]) {
      const res = await gh(api, { token, method: "POST", body: { tree: [{ path, mode: "100644", type: "blob", content: "x\n" }] } });
      out.api_trees[path] = { ...brief(res), ...(res.body?.sha ? { made_tree: res.body.sha, entries: res.body.tree?.map((e) => e.path) } : {}) };
    }

    out.fixture = { branch: BRANCH, commit, root_tree: rootTree, trees: { app: appSha, rel300, big, steps, flat, files, big_subdirectory: sub }, files: sized, shape: { big: `${BIG_DIRS} directories of ${BIG_FILES} files`, steps: STEPS, flat: FLAT } };
    writeFileSync(FIXTURE_FILE, `${JSON.stringify(out, null, 2)}\n`);
    return out;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---------- spike E: the reads ----------

async function read(config, repo, other) {
  const fx = JSON.parse(readFileSync(FIXTURE_FILE, "utf8")).fixture;
  const base = `/repos/${config.org}/${repo}`;
  const R = { repo: `${config.org}/${repo}`, commit: fx.commit, run_at: new Date().toISOString() };

  const reader = await mint(config, "agent", { contents: "read" }, [repo]);
  const meta = await mint(config, "agent", { metadata: "read" }, [repo]);
  R.tokens = { contents_read: reader.record, metadata_only: meta.record };
  if (!reader.token) throw new Error("couldn't mint the read token");
  const t = reader.token;
  const tree = (sha, { recursive = false, token = t } = {}) => gh(`${base}/git/trees/${sha}${recursive ? "?recursive=1" : ""}`, { token });
  const start = (await gh("/rate_limit", { token: t })).body?.resources?.core;
  R.rate_limit_at_start = start;

  // 1. Contents read alone, at an exact commit.
  const commit = await gh(`${base}/git/commits/${fx.commit}`, { token: t });
  const root = await tree(fx.commit);
  const topTree = await tree(root.body?.tree?.find((e) => e.path === ROOT)?.sha);
  const appEntry = topTree.body?.tree?.find((e) => e.path === "app");
  const appTree = await tree(appEntry?.sha, { recursive: true });
  const indexEntry = appTree.body?.tree?.find((e) => e.path === "index.html");
  const blobJson = await gh(`${base}/git/blobs/${indexEntry?.sha}`, { token: t });
  const blobRaw = await gh(`${base}/git/blobs/${indexEntry?.sha}`, { token: t, accept: "application/vnd.github.raw+json", as: "bytes" });
  const none = {};
  R.q1 = {
    with_contents_read: {
      commit: { ...brief(commit), tree_matches: commit.body?.tree?.sha === fx.root_tree },
      tree_by_commit_sha: { ...brief(root), sha_answered: root.body?.sha, entries: root.body?.tree?.map((e) => `${e.mode} ${e.type} ${e.path}`) },
      tree_by_commit_and_path: await gh(`${base}/git/trees/${fx.commit}:${ROOT}/app?recursive=1`, { token: t }).then((r) => ({ ...brief(r), is_the_directorys_tree: r.body?.sha === fx.trees.app, entries: r.body?.tree?.length })),
      tree_by_commit_and_path_of_a_symlink: brief(await gh(`${base}/git/trees/${fx.commit}:${ROOT}/app/link`, { token: t })),
      // The submodule entry names a commit that is in this repository: the default branch's head when the fixture was made.
      tree_by_commit_and_path_of_a_submodule: await gh(`${base}/git/trees/${fx.commit}:${ROOT}/app/sub`, { token: t }).then((r) => ({ ...brief(r), sha_answered: r.body?.sha, entries: r.body?.tree?.map((e) => e.path) })),
      tree_by_commit_and_path_of_a_file: brief(await gh(`${base}/git/trees/${fx.commit}:${ROOT}/app/index.html`, { token: t })),
      tree_by_commit_and_path_missing: brief(await gh(`${base}/git/trees/${fx.commit}:${ROOT}/nothing-here`, { token: t })),
      release_directory_recursive: { ...brief(appTree), truncated: appTree.body?.truncated, entries: appTree.body?.tree?.length },
      blob_json: { ...brief(blobJson), encoding: blobJson.body?.encoding, size: blobJson.body?.size },
      blob_raw: { status: blobRaw.status, content_type: blobRaw.content_type, bytes: blobRaw.bytes, git_sha_matches_tree: blobRaw.buffer ? gitBlobSha(blobRaw.buffer) === indexEntry?.sha : null },
      repository_itself: brief(await gh(base, { token: t })),
      installation_repositories: await gh("/installation/repositories", { token: t }).then((r) => ({ ...brief(r), total_count: r.body?.total_count, names: r.body?.repositories?.map((x) => x.name) })),
      write_a_blob: brief(await gh(`${base}/git/blobs`, { token: t, method: "POST", body: { content: "x", encoding: "utf-8" } })),
      write_a_ref: brief(await gh(`${base}/git/refs`, { token: t, method: "POST", body: { ref: "refs/heads/spike/m6-read-token-wrote", sha: fx.commit } })),
      pulls: brief(await gh(`${base}/pulls?per_page=1`, { token: t })),
      actions_permissions: brief(await gh(`${base}/actions/permissions`, { token: t })),
      rulesets: brief(await gh(`${base}/rulesets`, { token: t })),
    },
    with_metadata_only: meta.token
      ? { tree: brief(await tree(appEntry?.sha, { recursive: true, token: meta.token })), blob: brief(await gh(`${base}/git/blobs/${indexEntry?.sha}`, { token: meta.token })), write_a_blob: brief(await gh(`${base}/git/blobs`, { token: meta.token, method: "POST", body: { content: "x", encoding: "utf-8" } })) }
      : "no such token could be minted",
    with_no_credential: { tree: brief(await gh(`${base}/git/trees/${appEntry?.sha}`, none)), blob: brief(await gh(`${base}/git/blobs/${indexEntry?.sha}`, none)) },
    another_repository_with_this_token: other
      ? { which: other, repository: brief(await gh(`/repos/${config.org}/${other}`, { token: t })), tree: brief(await gh(`/repos/${config.org}/${other}/git/trees/HEAD`, { token: t })), write_a_blob: brief(await gh(`/repos/${config.org}/${other}/git/blobs`, { token: t, method: "POST", body: { content: "x", encoding: "utf-8" } })) }
      : "no second test repository exists",
  };

  // 4. Kinds, modes and odd paths, as the recursive tree of app/ gives them, with what ADR 0010's rules would say.
  R.q4 = {
    entries: appTree.body?.tree?.map((e) => ({ path: e.path, mode: e.mode, type: e.type, ...(e.size === undefined ? {} : { size: e.size }), rule: entryProblem(e) })),
    symlink_blob: await gh(`${base}/git/blobs/${appTree.body?.tree?.find((e) => e.path === "link-out")?.sha}`, { token: t, accept: "application/vnd.github.raw+json", as: "bytes" }).then((r) => ({ status: r.status, bytes_are_the_target_path: r.buffer?.toString("utf8") })),
    contents_api_on_a_symlink: await gh(`${base}/contents/${ROOT}/app/link?ref=${fx.commit}`, { token: t }).then((r) => ({ ...brief(r), type: r.body?.type, path_answered: r.body?.path, size: r.body?.size, target: r.body?.target })),
    contents_api_on_a_symlink_raw: await gh(`${base}/contents/${ROOT}/app/link?ref=${fx.commit}`, { token: t, accept: "application/vnd.github.raw+json", as: "bytes" }).then((r) => ({ status: r.status, bytes: r.bytes, text: r.buffer?.toString("utf8").slice(0, 60) })),
    contents_api_on_a_submodule: await gh(`${base}/contents/${ROOT}/app/sub?ref=${fx.commit}`, { token: t }).then((r) => ({ ...brief(r), type: r.body?.type })),
    submodule_sha_as_a_blob: brief(await gh(`${base}/git/blobs/${appTree.body?.tree?.find((e) => e.path === "sub")?.sha}`, { token: t })),
  };

  // 2. Large directories.
  const shape = (r) => ({ ...brief(r), truncated: r.body?.truncated, entries: r.body?.tree?.length, blobs: r.body?.tree?.filter((e) => e.type === "blob").length, bytes: r.bytes, ms: r.ms, first: r.body?.tree?.[0]?.path, last: r.body?.tree?.at(-1)?.path });
  const stepsTree = await tree(fx.trees.steps);
  R.q2 = {
    recursive_by_size: {},
    big_recursive: shape(await tree(fx.trees.big, { recursive: true })),
    big_recursive_again: shape(await tree(fx.trees.big, { recursive: true })),
    whole_commit_recursive: shape(await tree(fx.commit, { recursive: true })),
    whole_commit_recursive_again: shape(await tree(fx.commit, { recursive: true })),
    flat_not_recursive: shape(await tree(fx.trees.flat)),
    flat_recursive: shape(await tree(fx.trees.flat, { recursive: true })),
    one_subdirectory_not_recursive: shape(await tree(fx.trees.big_subdirectory)),
    contents_api_listing_1200_files: await gh(`${base}/contents/${ROOT}/big/d000?ref=${fx.commit}`, { token: t }).then((r) => ({ ...brief(r), entries: Array.isArray(r.body) ? r.body.length : null, bytes: r.bytes })),
  };
  for (const entry of stepsTree.body?.tree ?? []) R.q2.recursive_by_size[`${Number(entry.path.slice(1))} directories of ${BIG_FILES}`] = shape(await tree(entry.sha, { recursive: true }));
  // The walk that never asks for a recursive tree: one read a directory.
  {
    const before = requests;
    const started = Date.now();
    const top = await tree(fx.trees.big);
    const subs = await pool(top.body.tree.filter((e) => e.type === "tree"), 8, (e) => tree(e.sha));
    R.q2.walk_big_one_read_a_directory = { requests: requests - before, directories: subs.length, files: subs.reduce((n, r) => n + (r.body?.tree?.filter((e) => e.type === "blob").length ?? 0), 0), any_truncated: subs.some((r) => r.body?.truncated), statuses: [...new Set(subs.map((r) => r.status))], ms: Date.now() - started, at_once: 8 };
  }

  // 3. Large files.
  const filesTree = await tree(fx.trees.files);
  R.q3 = { tree_sizes: Object.fromEntries((filesTree.body?.tree ?? []).map((e) => [e.path, e.size])), blobs: {} };
  for (const f of fx.files) {
    const json = await gh(`${base}/git/blobs/${f.sha}`, { token: t, as: f.length > 30 << 20 ? "count" : "json" });
    const decoded = json.body?.content !== undefined ? Buffer.from(json.body.content, json.body.encoding === "base64" ? "base64" : "utf8") : null;
    const raw = await gh(`${base}/git/blobs/${f.sha}`, { token: t, accept: "application/vnd.github.raw+json", as: "count" });
    R.q3.blobs[f.name] = {
      size: f.length,
      json: { ...brief(json), response_bytes: json.bytes, over_size: f.length ? Number((json.bytes / f.length).toFixed(4)) : null, encoding: json.body?.encoding ?? "not parsed: streamed and counted", content_has_newlines: json.body?.content ? json.body.content.includes("\n") : null, decodes_to_the_file: decoded ? createHash("sha256").update(decoded).digest("hex") === f.sha256 : json.sha256 ? "not decoded: streamed and counted" : null, ms: json.ms },
      raw: { ...brief(raw), content_type: raw.content_type, response_bytes: raw.bytes, is_the_file: raw.sha256 === f.sha256, ms: raw.ms },
    };
  }
  R.q3.contents_api_5m = await gh(`${base}/contents/${ROOT}/files/5m.bin?ref=${fx.commit}`, { token: t }).then((r) => ({ ...brief(r), encoding: r.body?.encoding, content_length: r.body?.content?.length, size: r.body?.size }));
  R.q3.missing_blob = brief(await gh(`${base}/git/blobs/${"0".repeat(39)}1`, { token: t }));

  // 5. What a release of 300 files costs, and what the headers say.
  const release = async (width) => {
    const before = (await gh("/rate_limit", { token: t })).body.resources.core.used;
    const made = requests;
    const started = Date.now();
    const listing = await tree(fx.trees.rel300, { recursive: true });
    const got = await pool(listing.body.tree, width, (e) => gh(`${base}/git/blobs/${e.sha}`, { token: t, accept: "application/vnd.github.raw+json", as: "bytes" }));
    const ms = Date.now() - started;
    const mine = requests - made;
    const after = (await gh("/rate_limit", { token: t })).body.resources.core.used;
    const statuses = {};
    for (const r of got) statuses[r.status] = (statuses[r.status] ?? 0) + 1;
    return { files: listing.body.tree.length, at_once: width, requests_made: mine, used_before: before, used_after: after, used_rose_by: after - before, statuses, all_match_the_tree: got.every((r, i) => r.buffer && gitBlobSha(r.buffer) === listing.body.tree[i].sha), retry_after_seen: got.some((r) => r.limits.retry_after !== null), ms, slowest_ms: Math.max(...got.map((r) => r.ms)) };
  };
  R.q5 = { release_of_300_ten_at_once: await release(10) };
  await sleep(65_000);
  R.q5.release_of_300_thirty_at_once = await release(30);
  {
    const first = await gh(`${base}/git/trees/${fx.trees.rel300}`, { token: t });
    const again = await gh(`${base}/git/trees/${fx.trees.rel300}`, { token: t, headers: { "if-none-match": first.etag ?? "" } });
    R.q5.conditional_reread = { first: first.status, etag_given: first.etag !== null, again: again.status, used_first: first.limits.used, used_again: again.limits.used };
    const metaLimit = meta.token ? (await gh("/rate_limit", { token: meta.token })).body?.resources?.core : null;
    const mine = (await gh("/rate_limit", { token: t })).body?.resources?.core;
    R.q5.two_tokens_of_one_installation = { this_token: mine, the_other_token: metaLimit, one_count: metaLimit ? metaLimit.used === mine.used && metaLimit.reset === mine.reset : null };
    const tarball = await gh(`${base}/tarball/${fx.commit}`, { token: t, redirect: "manual" });
    R.q5.tarball_of_the_commit = { status: tarball.status, to_host: tarball.location ? new URL(tarball.location).host : null, note: "not downloaded: it is the whole repository at the commit, not a directory" };
    R.q5.last_headers = again.limits;
  }
  R.rate_limit_at_end = (await gh("/rate_limit", { token: t })).body?.resources?.core;
  R.requests_made_by_this_run = requests;
  return R;
}

// ---------- spike F: Actions ----------

async function actions(config, repo, other) {
  const base = `/repos/${config.org}/${repo}`;
  const fx = existsSync(FIXTURE_FILE) ? JSON.parse(readFileSync(FIXTURE_FILE, "utf8")).fixture : null;
  const R = { repo: `${config.org}/${repo}`, run_at: new Date().toISOString() };
  const admin = await mint(config, "provision", { administration: "read" }, [repo, ...(other ? [other] : [])]);
  const writer = await mint(config, "agent", { contents: "write" }, [repo]);
  R.tokens = { provisioning_administration_read: admin.record, agent_contents_write: writer.record };
  const seen = async (token) => ({
    workflows: await gh(`${base}/actions/workflows`, { token }).then((r) => ({ ...brief(r), total_count: r.body?.total_count })),
    runs: await gh(`${base}/actions/runs`, { token }).then((r) => ({ ...brief(r), total_count: r.body?.total_count })),
  });
  R.settings = {};
  for (const name of [repo, ...(other ? [other] : [])]) {
    const b = `/repos/${config.org}/${name}`;
    R.settings[name] = {
      actions_permissions: await gh(`${b}/actions/permissions`, { token: admin.token }).then((r) => ({ ...brief(r), enabled: r.body?.enabled, allowed_actions: r.body?.allowed_actions })),
      workflow_permissions: await gh(`${b}/actions/permissions/workflow`, { token: admin.token }).then((r) => ({ ...brief(r), default_workflow_permissions: r.body?.default_workflow_permissions, can_approve_pull_request_reviews: r.body?.can_approve_pull_request_reviews })),
      default_branch_has_dot_github: await gh(`${b}/git/trees/HEAD`, { token: admin.token }).then((r) => ({ ...brief(r), found: r.body?.tree?.some((e) => e.path === ".github") })),
    };
  }
  R.organization_setting = brief(await gh(`/orgs/${config.org}/actions/permissions`, { token: admin.token }));
  R.before = await seen(writer.token);

  // Try to put a workflow on a non-default branch, each way the agent's token might.
  const workflow = "name: m6-spike-f\non: [push, workflow_dispatch]\njobs:\n  noop:\n    runs-on: ubuntu-latest\n    steps:\n      - run: 'true'\n";
  const path = ".github/workflows/m6-spike-f.yml";
  const w = writer.token;
  R.attempts = {};
  if (fx) R.attempts.contents_api_on_the_fixture_branch = brief(await gh(`${base}/contents/${path}`, { token: w, method: "PUT", body: { message: "m6 spike F: a workflow", content: Buffer.from(workflow).toString("base64"), branch: fx.branch } }));
  const blob = await gh(`${base}/git/blobs`, { token: w, method: "POST", body: { content: workflow, encoding: "utf-8" } });
  const tree = await gh(`${base}/git/trees`, { token: w, method: "POST", body: { tree: [{ path, mode: "100644", type: "blob", sha: blob.body?.sha }] } });
  const commit = tree.body?.sha ? await gh(`${base}/git/commits`, { token: w, method: "POST", body: { message: "m6 spike F: a workflow, by the git data API", tree: tree.body.sha, parents: [] } }) : null;
  const ref = commit?.body?.sha ? await gh(`${base}/git/refs`, { token: w, method: "POST", body: { ref: "refs/heads/spike/m6-actions-off-api", sha: commit.body.sha } }) : null;
  R.attempts.git_data_api = { blob: { ...brief(blob), sha: blob.body?.sha }, tree: { ...brief(tree), sha: tree.body?.sha }, commit: commit ? { ...brief(commit), sha: commit.body?.sha } : "not tried", ref: ref ? brief(ref) : "not tried" };
  {
    const dir = mkdtempSync(join(tmpdir(), "m6-spike-f-"));
    try {
      const g = gitTools(dir);
      g.run(["init", "-q", "--bare", "."]);
      const file = (mode, name, sha) => ({ mode, name, sha });
      const c = g.commit(g.tree([file("40000", ".github", g.tree([file("40000", "workflows", g.tree([file("100644", "m6-spike-f.yml", g.blob(workflow))]))]))]), "m6 spike F: a workflow, by git push");
      R.attempts.git_push = { commit: c, branch: "spike/m6-actions-off-git", ...(await g.push(`https://github.com/${config.org}/${repo}.git`, `${c}:refs/heads/spike/m6-actions-off-git`, w)) };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  R.dispatch = brief(await gh(`${base}/actions/workflows/m6-spike-f.yml/dispatches`, { token: w, method: "POST", body: { ref: fx?.branch ?? "main" } }));
  await sleep(45_000);
  R.after_45_seconds = await seen(writer.token);
  R.branches_now = await gh(`${base}/branches?per_page=100`, { token: w }).then((r) => r.body?.map?.((b) => b.name));
  return R;
}

// ---------- which count a token's headers report ----------

async function limitsOnly(config, repo, other) {
  const base = `/repos/${config.org}/${repo}`;
  const core = async (token) => (await gh("/rate_limit", { token })).body?.resources?.core;
  const R = { run_at: new Date().toISOString(), tokens: {} };
  const both = other ? [repo, other] : [repo];
  const cases = [
    ["agent_contents_read_one_repository", "agent", { contents: "read" }, [repo]],
    ["agent_metadata_only_one_repository", "agent", { metadata: "read" }, [repo]],
    ["agent_contents_read_one_repository_again", "agent", { contents: "read" }, [repo]],
    ...(other ? [["agent_contents_read_the_other_repository", "agent", { contents: "read" }, [other]], ["agent_contents_read_both_repositories", "agent", { contents: "read" }, both]] : []),
    ["provisioning_metadata_only_one_repository", "provision", { metadata: "read" }, [repo]],
    ...(other ? [["provisioning_metadata_only_both_repositories", "provision", { metadata: "read" }, both]] : []),
  ];
  for (const [name, kind, permissions, repositories] of cases) {
    const { token } = await mint(config, kind, permissions, repositories);
    const seen = { at_once: await core(token) };
    await sleep(5000);
    seen.after_5_seconds = await core(token);
    seen.one_read = (await gh(base, { token })).limits;
    seen.after_the_read = await core(token);
    R.tokens[name] = seen;
  }
  return R;
}

// ---------- run ----------

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const problem = argsProblem(process.argv.slice(2));
  const repo = process.env.M6_REPO;
  if (problem || !repoAllowed(repo)) {
    console.error(problem ?? "M6_REPO must name an e2e-m5-* test repository");
    process.exit(2);
  }
  const config = staging();
  const mode = process.argv[2];
  const other = process.env.M6_OTHER_REPO && repoAllowed(process.env.M6_OTHER_REPO) ? process.env.M6_OTHER_REPO : null;
  try {
    const result = mode === "fixture" ? await fixture(config, repo) : mode === "read" ? await read(config, repo, other) : mode === "limits" ? await limitsOnly(config, repo, other) : await actions(config, repo, other);
    const text = scrub(JSON.stringify(result, null, 2));
    if (mode !== "fixture") {
      mkdirSync(join(here, "results"), { recursive: true });
      writeFileSync(join(here, "results", `${mode}.json`), `${text}\n`);
    }
    console.log(text);
  } catch (error) {
    console.error(scrub(error?.stack ?? error));
    process.exit(1);
  }
}
