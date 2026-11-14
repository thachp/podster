import { env, runInDurableObject, SELF } from "cloudflare:test";
import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";

// M6 step 5, the release job's read (ADR 0010, "The release job", steps 2 to 4): reading the release directory, `site`,
// at one exact commit, with the read-only App's token for that one repository. The room's upload command drives the
// read (`release-upload.spec.ts`); here a test-only path runs it alone, and each test reads what came of it. GitHub is the stand-in in
// `fake-github-release.ts`: what was asked of it, with which token, is read from its own log.
//
// Nothing here uploads, and nothing is written to any room.

const BINDINGS = env as any;
const stub = () => BINDINGS.WORKSPACE.get(BINDINGS.WORKSPACE.idFromName("ws_release_read_probe"));
const moderation = () => BINDINGS.MODERATION.get(BINDINGS.MODERATION.idFromName("moderation"));
const inModeration = <T>(fn: (sql: any) => T) => runInDurableObject(moderation(), (_: any, state: any) => fn(state.storage.sql)) as Promise<T>;
/** The stand-in's controls, for this file's own repository: other spec files use it at the same time, with theirs. */
const control = (path: string, body?: unknown) => fetch(`https://github-release-fake.example.com${path}?repo=${REPO}`, body === undefined ? undefined : { method: "POST", body: JSON.stringify(body) });
type Call = { method: string; path: string; accept: string | null; auth: string };
type State = { calls: Call[]; minted: any[]; mostBlobsAtOnce: number; tokens: { repo: number; permissions: Record<string, string>; revoked: boolean }[] };
const state = async () => (await (await control("/state")).json()) as State;
/** Another repository's ID, which the stand-in holds nothing for. Its world is this file's too. */
const elsewhere = (path: string) => fetch(`https://github-release-fake.example.com${path}?repo=${REPO + 1}`, { method: "POST", body: "{}" });

const REPO = 987650777;
const COMMIT = "c0".repeat(20);
const DIRECTORY = "d1".repeat(20);
const sha = (n: number) => n.toString(16).padStart(40, "0");
const bytes = (text: string) => new TextEncoder().encode(text);
const blobSha = (content: Uint8Array) => createHash("sha1").update(`blob ${content.length}\0`).update(content).digest("hex");
let releases = 0;
const newRelease = () => `rel_${(++releases).toString(16).padStart(32, "0")}`;

type Entry = { path: string; mode: string; type: string; sha: string; size?: number };
/** A repository as GitHub would answer for it: the commit's top tree, the release directory's own tree, and the files. */
function repository(files: Record<string, string>, extra: { top?: Entry[]; directory?: Entry[] } = {}) {
  const blobs: Record<string, string> = {};
  const directory: Entry[] = [];
  const folders = new Set<string>();
  for (const [path, text] of Object.entries(files)) {
    const content = bytes(text);
    const id = blobSha(content);
    blobs[id] = Buffer.from(content).toString("base64");
    const parts = path.split("/");
    for (let i = 1; i < parts.length; i += 1) folders.add(parts.slice(0, i).join("/"));
    directory.push({ path, mode: "100644", type: "blob", sha: id, size: content.length });
  }
  let n = 0;
  for (const folder of folders) directory.push({ path: folder, mode: "040000", type: "tree", sha: sha(0xf000 + ++n) });
  const top: Entry[] = extra.top ?? [
    { path: "README.md", mode: "100644", type: "blob", sha: sha(1), size: 10 },
    { path: "site", mode: "040000", type: "tree", sha: DIRECTORY },
    { path: "src", mode: "040000", type: "tree", sha: sha(2) },
  ];
  return { repo: REPO, trees: { [COMMIT]: { tree: top }, [DIRECTORY]: { tree: [...directory, ...(extra.directory ?? [])] } }, blobs };
}
const seed = (repo: ReturnType<typeof repository>) => control("/seed", repo);
/** One whole read, through the test-only path. */
const read = async (over: Partial<{ release_id: string; repo_id: number; commit_sha: string; settings: Record<string, string | null>; clock_step_ms: number }> = {}) =>
  (await (await stub().fetch("https://do/internal/test-release-read", { method: "POST", body: JSON.stringify({ release_id: newRelease(), repo_id: REPO, commit_sha: COMMIT, ...over }) })).json()) as any;
const kinds = (calls: Call[]) => calls.map((call) => `${call.method} ${call.path.replace(/[0-9a-f]{40}/, "<sha>").replace(String(REPO), "<repo>")}`);

const SITE = { "index.html": "<p>one</p>\n", "app.js": "export const one = 1;\n", "css/site.css": "p { color: red }\n", "data/list.json": '["a"]\n', "notes": "plain\n" };

beforeEach(async () => {
  await control("/reset", {});
  await moderation().fetch("https://do/release-reads", { method: "POST", body: JSON.stringify({ release_id: `rel_${"0".repeat(32)}`, reads: 1 }) });
  await inModeration((sql) => sql.exec("DELETE FROM release_reads"));
});

describe("reading a release from the room's repository", () => {
  it("reads the release directory at the commit in two tree reads and one read for each file, with a token for that repository alone", async () => {
    await seed(repository(SITE));
    const release = newRelease();
    const answer = await read({ release_id: release });
    // The files, in path order, each with its size, the type it is served with, and its manifest hash.
    expect(answer.files.map((file: any) => [file.path, file.size, file.type])).toEqual([
      ["app.js", 22, "text/javascript; charset=utf-8"],
      ["css/site.css", 17, "text/css; charset=utf-8"],
      ["data/list.json", 6, "application/json"],
      ["index.html", 11, "text/html; charset=utf-8"],
      ["notes", 6, "application/octet-stream"],
    ]);
    for (const file of answer.files) expect(file.hash, file.path).toMatch(/^[0-9a-f]{32}$/);
    expect([answer.total_bytes, answer.fetched_bytes, answer.reads]).toEqual([62, 62, 7]);
    const seen = await state();
    // One token, for this repository only, to read contents and metadata and nothing else.
    expect(seen.minted).toEqual([{ repository_ids: [REPO], permissions: { contents: "read", metadata: "read" } }]);
    // Exactly: the token, the commit's top tree, the directory's own tree recursively, one raw read a file, the revoke.
    expect(kinds(seen.calls).sort()).toEqual([
      "DELETE /installation/token",
      "GET /repositories/<repo>/git/trees/<sha>",
      "GET /repositories/<repo>/git/trees/<sha>?recursive=1",
      ...Array(5).fill("GET /repositories/<repo>/git/blobs/<sha>"),
      "POST /app/installations/888004/access_tokens",
    ].sort());
    // The commit's tree is asked for by the commit's sha, never recursively; only the directory's own is.
    expect(seen.calls.filter((call) => call.path.includes("/git/trees/")).map((call) => call.path)).toEqual([`/repositories/${REPO}/git/trees/${COMMIT}`, `/repositories/${REPO}/git/trees/${DIRECTORY}?recursive=1`]);
    // Files are asked for as their own bytes. Nothing names the repository by a name, and nothing asks for anything else.
    expect(seen.calls.filter((call) => call.path.includes("/git/blobs/")).every((call) => call.accept === "application/vnd.github.raw+json")).toBe(true);
    expect(seen.calls.every((call) => !call.path.includes("/repos/") && !call.path.includes("contents"))).toBe(true);
    // The token is gone when the read is over.
    expect(seen.tokens).toEqual([{ repo: REPO, permissions: { contents: "read", metadata: "read" }, revoked: true }]);
    // And its reads are reserved from the deployment's budget, under the release's own ID.
    expect(await inModeration((sql) => sql.exec("SELECT release_id, reads FROM release_reads").toArray())).toEqual([{ release_id: release, reads: 7 }]);
  });

  it("gives a file the type its own extension says, never the provider's, and a hash that changes with the bytes or the type", async () => {
    // The stand-in gives every file `text/html; charset=utf-16be`. None of that is read.
    await seed(repository({ "a.html": "same bytes", "a.txt": "same bytes", "b.html": "same bytes", "c.html": "other bytes" }));
    const first = await read();
    const by = Object.fromEntries(first.files.map((file: any) => [file.path, file]));
    expect([by["a.html"].type, by["a.txt"].type]).toEqual(["text/html; charset=utf-8", "text/plain; charset=utf-8"]);
    expect(by["a.html"].hash).toBe(by["b.html"].hash);
    expect(by["a.html"].hash).not.toBe(by["a.txt"].hash);
    expect(by["a.html"].hash).not.toBe(by["c.html"].hash);
    // The same directory read again gives the same hashes.
    const again = await read();
    expect(again.files).toEqual(first.files);
    // What a hash is: the first 32 hexadecimal characters of SHA-256 over the type, a zero byte and **the file's own
    // bytes.** Git's blob sha, which is a SHA-1, is no part of it.
    const expected = createHash("sha256").update("text/html; charset=utf-8").update(Buffer.from([0])).update(bytes("same bytes")).digest("hex").slice(0, 32);
    expect(by["a.html"].hash).toBe(expected);
    const overTheBlobSha = createHash("sha256").update(blobSha(bytes("same bytes"))).update(Buffer.from([0])).update("text/html; charset=utf-8").digest("hex").slice(0, 32);
    expect(by["a.html"].hash).not.toBe(overTheBlobSha);
  });

  it("fetches ten files at a time and no more", async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 25; i += 1) files[`f${String(i).padStart(2, "0")}.txt`] = `file ${i}\n`;
    await seed(repository(files));
    const answer = await read();
    expect([answer.files.length, answer.reads]).toEqual([25, 27]);
    const most = (await state()).mostBlobsAtOnce;
    expect(most).toBeGreaterThan(1);
    expect(most).toBeLessThanOrEqual(10);
  });
});

describe("a read that gives nothing to publish", () => {
  /** What came of a read, and what was asked of GitHub on the way. Every token it had is revoked or was never usable. */
  const outcome = async (over: Parameters<typeof read>[0] = {}) => {
    const answer = await read(over);
    const seen = await state();
    return { failed: answer.failed, fails: answer.fails_release, problems: answer.problems, asked: kinds(seen.calls).filter((call) => call.startsWith("GET")).map((call) => call.split("/git/")[1]?.replace("/<sha>", "") ?? call), seen };
  };

  it("waits, and reads nothing, when the token isn't exactly the one asked for", async () => {
    await seed(repository(SITE));
    for (const fault of [500, 403, 404, 422, "another_repo", "more_permissions", "no_token"] as const) {
      await control("/reset", {});
      await seed(repository(SITE));
      await control("/fault", { token: fault });
      const got = await outcome();
      expect([got.failed, got.fails, got.asked], String(fault)).toEqual(["release_read_unavailable", false, []]);
      // A token that came back for another repository, or with more than was asked, is revoked, never used.
      if (fault === "another_repo" || fault === "more_permissions") expect(got.seen.tokens.map((token) => token.revoked), String(fault)).toEqual([true]);
      // The two tree reads were reserved before the token was asked for, and nothing more.
      expect(await inModeration((sql) => sql.exec("SELECT reads FROM release_reads").toArray()), String(fault)).toEqual([{ reads: 2 }]);
      await inModeration((sql) => sql.exec("DELETE FROM release_reads"));
    }
  });

  it("fails the release when the repository doesn't have the commit, and waits when the provider gives no answer", async () => {
    await seed(repository(SITE));
    // A commit the repository doesn't have, and one that isn't a commit's name at all.
    for (const commit of ["ee".repeat(20), "not-a-sha", "C0".repeat(20)]) {
      await control("/reset", {});
      await seed(repository(SITE));
      const got = await outcome({ commit_sha: commit });
      expect([got.failed, got.fails], commit).toEqual(["release_commit_unreadable", true]);
      // **A name that isn't a commit's is never put in an address:** nothing is asked for it at all.
      expect(got.asked, commit).toEqual(commit === "ee".repeat(20) ? ["trees"] : []);
    }
    // The provider answering with a failure, a rate limit among them, with something that isn't a tree, or with a
    // `200` that isn't JSON at all, as a sign-in page put in its place would be: it waits, and the read is tried again.
    for (const fault of [500, 502, 403, 429, "not_a_tree", "html"] as const) {
      await control("/reset", {});
      await seed(repository(SITE));
      await control("/fault", { tree: { [COMMIT]: fault } });
      const got = await outcome();
      expect([got.failed, got.fails, got.asked], String(fault)).toEqual(["release_read_unavailable", false, ["trees"]]);
      expect(got.seen.tokens.map((token) => token.revoked), String(fault)).toEqual([true]);
    }
    // The same for the directory's own tree, the second read.
    await control("/reset", {});
    await seed(repository(SITE));
    await control("/fault", { tree: { [DIRECTORY]: 500 } });
    expect((await outcome()).asked).toEqual(["trees", "trees?recursive=1"]);
    // And a page in place of the directory's tree waits too: it is never a tree too large, which would end the release.
    await control("/reset", {});
    await seed(repository(SITE));
    await control("/fault", { tree: { [DIRECTORY]: "html" } });
    const page = await outcome();
    expect([page.failed, page.fails, page.asked]).toEqual(["release_read_unavailable", false, ["trees", "trees?recursive=1"]]);
  });

  it("fails the release on what the trees say, before any file is fetched", async () => {
    const cases: [string, ReturnType<typeof repository>, object | null, string, string[]][] = [
      ["no release directory", repository(SITE, { top: [{ path: "README.md", mode: "100644", type: "blob", sha: sha(1), size: 10 }] }), null, "release_directory_missing", ["trees"]],
      ["the directory's name on a file", repository(SITE, { top: [{ path: "site", mode: "100644", type: "blob", sha: sha(3), size: 5 }] }), null, "release_directory_not_a_directory", ["trees"]],
      ["the directory's name on a submodule", repository(SITE, { top: [{ path: "site", mode: "160000", type: "commit", sha: DIRECTORY }] }), null, "release_directory_not_a_directory", ["trees"]],
      ["a top tree too long to parse", repository(SITE), { tree: { [COMMIT]: "too_long" } }, "release_tree_too_large", ["trees"]],
      ["a directory tree too long to parse", repository(SITE), { tree: { [DIRECTORY]: "too_long" } }, "release_tree_too_large", ["trees", "trees?recursive=1"]],
      ["an empty directory", repository({}), null, "release_empty", ["trees", "trees?recursive=1"]],
      ["a symlink", repository(SITE, { directory: [{ path: "link", mode: "120000", type: "blob", sha: sha(4), size: 9 }] }), null, "release_symlink", ["trees", "trees?recursive=1"]],
      ["a submodule", repository(SITE, { directory: [{ path: "vendor", mode: "160000", type: "commit", sha: sha(5) }] }), null, "release_submodule", ["trees", "trees?recursive=1"]],
      ["a name the platform treats specially", repository({ ...SITE, "_headers": "/*\n  X: y\n" }), null, "release_refused_name", ["trees", "trees?recursive=1"]],
      ["a file past one file's size", repository(SITE, { directory: [{ path: "big.bin", mode: "100644", type: "blob", sha: sha(6), size: 5_000_001 }] }), null, "release_file_too_large", ["trees", "trees?recursive=1"]],
      ["a file with no size", repository(SITE, { directory: [{ path: "odd.bin", mode: "100644", type: "blob", sha: sha(7) }] }), null, "release_file_without_size", ["trees", "trees?recursive=1"]],
    ];
    for (const [what, repo, fault, code, asked] of cases) {
      await control("/reset", {});
      await seed(repo);
      if (fault) await control("/fault", fault);
      const got = await outcome();
      expect([got.failed, got.fails, got.asked], what).toEqual([code, true, asked]);
      expect(got.seen.tokens.map((token) => token.revoked), what).toEqual([true]);
      // **The two tree reads are counted, though the read ended at them.** No file's read is.
      expect(await inModeration((sql) => sql.exec("SELECT reads FROM release_reads").toArray()), what).toEqual([{ reads: 2 }]);
      await inModeration((sql) => sql.exec("DELETE FROM release_reads"));
    }
    // A truncated directory tree fails the release whatever it holds: part of a directory is never published.
    await control("/reset", {});
    const truncated = repository(SITE);
    (truncated.trees[DIRECTORY] as any).truncated = true;
    await seed(truncated);
    expect((await outcome()).failed).toBe("release_tree_too_large");
    // Every problem is found and named, not only the first.
    await control("/reset", {});
    await seed(repository({ ...SITE, "_redirects": "/a /b\n" }, { directory: [{ path: "link", mode: "120000", type: "blob", sha: sha(4), size: 9 }] }));
    expect((await outcome()).problems.sort()).toEqual(["release_refused_name", "release_symlink"]);
  });

  it("fails the release on a file that isn't what the tree said, and waits on a file that didn't come", async () => {
    const repo = repository(SITE);
    const index = blobSha(bytes(SITE["index.html"]));
    for (const [fault, code, fails] of [["other_bytes", "release_file_mismatch", true], ["too_long", "release_file_mismatch", true], [500, "release_read_unavailable", false], [404, "release_read_unavailable", false], [429, "release_read_unavailable", false]] as const) {
      await control("/reset", {});
      await seed(repo);
      await control("/fault", { blob: { [index]: fault } });
      const got = await outcome();
      expect([got.failed, got.fails], String(fault)).toEqual([code, fails]);
      expect(got.seen.tokens.map((token) => token.revoked), String(fault)).toEqual([true]);
    }
    // The tree's size is held to as well as its sha: bytes that hash right for another length never arrive, since
    // the sha covers the length, so a size the tree got wrong shows as a mismatch.
    await control("/reset", {});
    const lied = repository(SITE);
    (lied.trees[DIRECTORY].tree as Entry[]).find((entry) => entry.path === "index.html")!.size = 12;
    await seed(lied);
    expect((await outcome()).failed).toBe("release_file_mismatch");
  });

  it("reserves every read before it is made, waits when the budget has no room, and counts each attempt", async () => {
    await seed(repository(SITE));
    const others = `rel_${"9".repeat(32)}`;
    // 2,995 of the hour's 3,000 reads are held by another release. This one needs 2 for its trees, then 5.
    await moderation().fetch("https://do/release-reads", { method: "POST", body: JSON.stringify({ release_id: others, reads: 2995 }) });
    const first = newRelease();
    const got = await outcome({ release_id: first });
    expect([got.failed, got.fails, got.asked]).toEqual(["release_reads_budget", false, ["trees", "trees?recursive=1"]]);
    expect(got.seen.tokens.map((token) => token.revoked)).toEqual([true]);
    // The trees it read stay counted; the files it didn't read aren't.
    expect(await inModeration((sql) => sql.exec("SELECT release_id, reads FROM release_reads ORDER BY reads").toArray())).toEqual([{ release_id: first, reads: 2 }, { release_id: others, reads: 2995 }]);
    const waiting = await read();
    expect([waiting.failed, typeof waiting.retry_at]).toEqual(["release_reads_budget", "number"]);
    // **With no room for the trees, nothing is asked of GitHub at all:** no token, no read.
    await control("/reset", {});
    await seed(repository(SITE));
    await inModeration((sql) => sql.exec("UPDATE release_reads SET reads = 2999 WHERE release_id = ?", others));
    await inModeration((sql) => sql.exec("DELETE FROM release_reads WHERE release_id != ?", others));
    const full = await outcome();
    expect([full.failed, full.fails, full.seen.calls, full.seen.minted]).toEqual(["release_reads_budget", false, [], []]);
    // With room, a release read twice has both attempts' reads counted, in its one row: each read was really made.
    await inModeration((sql) => sql.exec("DELETE FROM release_reads"));
    const release = newRelease();
    await read({ release_id: release });
    expect(await inModeration((sql) => sql.exec("SELECT release_id, reads FROM release_reads").toArray())).toEqual([{ release_id: release, reads: 7 }]);
    await read({ release_id: release });
    expect(await inModeration((sql) => sql.exec("SELECT release_id, reads FROM release_reads").toArray())).toEqual([{ release_id: release, reads: 14 }]);
    // An earlier way of asking, with no `more`, still answers a release's reservation as it stands and adds nothing.
    const again = await moderation().fetch("https://do/release-reads", { method: "POST", body: JSON.stringify({ release_id: release, reads: 500 }) });
    expect(((await again.json()) as any).reads).toBe(14);
    expect(await inModeration((sql) => sql.exec("SELECT reads FROM release_reads").toArray())).toEqual([{ reads: 14 }]);
  });

  it("gives one attempt one deadline, by the clock it is given, and revokes its token all the same", async () => {
    await seed(repository(SITE));
    // A clock that moves on by a third of the deadline each time it is read: the attempt's start, the token, the
    // first tree. The second tree's call finds no time left, and isn't made.
    const third = 100_000;
    const late = await outcome({ clock_step_ms: third });
    expect([late.failed, late.fails, late.asked]).toEqual(["release_read_unavailable", false, ["trees"]]);
    // The revoke has its own time: a read that ran out of time still gives its token back.
    expect(late.seen.tokens.map((token) => token.revoked)).toEqual([true]);
    // A clock already past the deadline at the first call: no token is asked for at all.
    await control("/reset", {});
    await seed(repository(SITE));
    const over = await outcome({ clock_step_ms: 300_000 });
    expect([over.failed, over.fails, over.seen.calls]).toEqual(["release_read_unavailable", false, []]);
    // A clock that goes backwards past the attempt's start has no time left either.
    await control("/reset", {});
    await seed(repository(SITE));
    const backwards = await outcome({ clock_step_ms: -1 });
    expect([backwards.failed, backwards.seen.calls]).toEqual(["release_read_unavailable", []]);
    // And one that never comes near it reads everything.
    await control("/reset", {});
    await seed(repository(SITE));
    expect((await read({ clock_step_ms: 1 })).files).toHaveLength(5);
  });

  it("reads nothing, asks nothing and reserves nothing with no read-only App configured", async () => {
    await seed(repository(SITE));
    const names = ["GITHUB_RELEASE_APP_ID", "GITHUB_RELEASE_INSTALLATION_ID", "GITHUB_RELEASE_APP_KEY"];
    const cases: [string, Record<string, string | null>][] = [
      ...names.map((name): [string, Record<string, string | null>] => [`${name} unset`, { [name]: null }]),
      ["all three unset", Object.fromEntries(names.map((name) => [name, null]))],
      ["an App ID that isn't a number", { GITHUB_RELEASE_APP_ID: "seven" }],
      ["an App ID of zero", { GITHUB_RELEASE_APP_ID: "0" }],
      ["an installation that isn't a number", { GITHUB_RELEASE_INSTALLATION_ID: "-4" }],
      ["a key that isn't a key", { GITHUB_RELEASE_APP_KEY: "-----BEGIN PRIVATE KEY-----\nnot a key\n-----END PRIVATE KEY-----" }],
      ["an empty key", { GITHUB_RELEASE_APP_KEY: "" }],
    ];
    for (const [what, settings] of cases) {
      const got = await outcome({ settings });
      expect([got.failed, got.fails, got.seen.calls, got.seen.minted], what).toEqual(["release_read_not_configured", false, [], []]);
      expect(await inModeration((sql) => sql.exec("SELECT count(*) AS n FROM release_reads").one().n), what).toBe(0);
    }
    // The control: with the settings as the test Worker has them, the same read goes through.
    expect((await read({ settings: {} })).files).toHaveLength(5);
  });

  it("is unconfigured unless its App, its installation and its key are each its own, shared with none of the other three", async () => {
    await seed(repository(SITE));
    const mine = { app: "777004", installation: "888004" };
    const roles = ["PROVISION", "AGENT", "MERGE"];
    // A key of the test's own making, to give two Apps the same one.
    const pair = (await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
    const der = Buffer.from((await crypto.subtle.exportKey("pkcs8", pair.privateKey)) as ArrayBuffer).toString("base64");
    const pem = `-----BEGIN PRIVATE KEY-----\n${der.match(/.{1,64}/g)!.join("\n")}\n-----END PRIVATE KEY-----\n`;
    const shared: [string, Record<string, string>][] = [];
    for (const role of roles) {
      shared.push([`the ${role} App's ID`, { [`GITHUB_${role}_APP_ID`]: mine.app }]);
      shared.push([`the ${role} App's installation`, { [`GITHUB_${role}_INSTALLATION_ID`]: mine.installation }]);
      shared.push([`the ${role} App's key`, { [`GITHUB_${role}_APP_KEY`]: pem, GITHUB_RELEASE_APP_KEY: pem }]);
      // The same key written with other line breaks is the same key.
      shared.push([`the ${role} App's key, written another way`, { [`GITHUB_${role}_APP_KEY`]: pem.replace(/\n/g, "\r\n"), GITHUB_RELEASE_APP_KEY: pem }]);
    }
    for (const [what, settings] of shared) {
      const got = await outcome({ settings });
      expect([got.failed, got.fails, got.seen.calls, got.seen.minted], what).toEqual(["release_read_not_configured", false, [], []]);
    }
    // The control: that key for the read-only App alone is its own, so the read is configured, and goes as far as
    // GitHub, which refuses a token to a key that isn't the App's.
    await inModeration((sql) => sql.exec("DELETE FROM release_reads"));
    const own = await outcome({ settings: { GITHUB_RELEASE_APP_KEY: pem } });
    expect(own.failed).toBe("release_read_unavailable");
    expect(await inModeration((sql) => sql.exec("SELECT reads FROM release_reads").toArray())).toEqual([{ reads: 2 }]);
  });

  it("still gives the read when the token's revoke isn't confirmed, and reaches only the repository its token names", async () => {
    await seed(repository(SITE));
    await control("/fault", { revoke: 500 });
    const answer = await read();
    expect(answer.files).toHaveLength(5);
    expect((await state()).tokens.map((token) => token.revoked)).toEqual([false]);
    // Another repository's ID, which the stand-in holds nothing for: the token is for that ID, and finds nothing.
    await control("/reset", {});
    await elsewhere("/reset");
    await seed(repository(SITE));
    const other = await read({ repo_id: REPO + 1 });
    expect(other.failed).toBe("release_commit_unreadable");
    expect(((await (await elsewhere("/state")).json()) as State).minted).toEqual([{ repository_ids: [REPO + 1], permissions: { contents: "read", metadata: "read" } }]);
    expect((await state()).calls).toEqual([]);
  });
});

describe("the read's own boundaries", () => {
  it("is reached by no client, and its test-only path is in no build a deployment gets", async () => {
    for (const path of ["/internal/test-release-read", "/v1/internal/test-release-read", "/v1/workspaces/ws_release_read_probe/internal/test-release-read"]) {
      const answer = await SELF.fetch(`https://api.internal${path}`, { method: "POST", body: JSON.stringify({ release_id: newRelease(), repo_id: REPO, commit_sha: COMMIT }) });
      expect(answer.status, path).toBeGreaterThanOrEqual(400);
    }
    expect((await state()).calls).toEqual([]);
    const sources = JSON.parse(BINDINGS.TEST_API_SOURCES) as Record<string, string>;
    // The path is named in one place, under the test-only feature, and the probe itself is compiled under it too.
    const naming = Object.entries(sources).filter(([, text]) => text.includes("test-release-read")).map(([name]) => name);
    expect(naming).toEqual(["workspace.rs"]);
    const at = sources["workspace.rs"].split("\n").findIndex((line) => line.includes('"/internal/test-release-read"'));
    expect(sources["workspace.rs"].split("\n")[at - 1]).toContain('#[cfg(feature = "failpoints")]');
    expect(sources["github/release_read.rs"]).toMatch(/#\[cfg\(feature = "failpoints"\)\]\npub\(crate\) async fn probe/);
    // The room's upload command is the read's one caller, with the provider's upload, which takes the attempt's clock.
    const callers = Object.entries(sources).filter(([name, text]) => name !== "github/release_read.rs" && /release_read::(?!probe)/.test(text)).map(([name]) => name);
    expect(callers).toEqual(["content_provider/upload.rs", "workspace/release_upload.rs"]);
    expect(sources["content_provider/upload.rs"].match(/release_read::\w+/g)).toEqual(["release_read::Attempt"]);
  });

  it("names its App's three settings, which no deployment's configuration holds", async () => {
    const sources = JSON.parse(BINDINGS.TEST_API_SOURCES) as Record<string, string>;
    const names = ["GITHUB_RELEASE_APP_ID", "GITHUB_RELEASE_INSTALLATION_ID", "GITHUB_RELEASE_APP_KEY"];
    for (const name of names) expect(sources["github/release_read.rs"]).toContain(`"${name}"`);
    // The Worker's own configuration file names none of them: they are the owner's to set, and the App doesn't exist.
    const wrangler: string = BINDINGS.TEST_API_WRANGLER;
    // The file is really read: it names the Worker and its other Apps' settings are not in it either.
    expect(wrangler).toContain('"name"');
    expect(wrangler.length).toBeGreaterThan(500);
    for (const name of names) expect(wrangler).not.toContain(name);
    // And no other source file of the Worker reads them.
    for (const [file, text] of Object.entries(sources)) if (file !== "github/release_read.rs") for (const name of names) expect(text, `${file} ${name}`).not.toContain(name);
  });
});
