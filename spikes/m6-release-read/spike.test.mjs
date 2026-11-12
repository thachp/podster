// Offline checks only. Nothing here calls GitHub.
import assert from "node:assert/strict";
import { createHash, createVerify, generateKeyPairSync } from "node:crypto";
import { test } from "node:test";
import { appJwt, argsProblem, entryProblem, gitBlobSha, mintBody, patterned, repoAllowed, treeBytes, treeOrder } from "./spike.mjs";

test("the App's JWT is signed by its key and names it", () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwt = appJwt(7, privateKey.export({ type: "pkcs8", format: "pem" }), 1000);
  const [head, body, sig] = jwt.split(".");
  assert.ok(createVerify("RSA-SHA256").update(`${head}.${body}`).verify(publicKey, sig, "base64url"));
  assert.deepEqual(JSON.parse(Buffer.from(body, "base64url")), { iat: 940, exp: 1540, iss: "7" });
});

test("only an acceptance run's repository is allowed, and a mint always names its permissions and repositories", () => {
  assert.ok(repoAllowed("e2e-m5-202611120015-ae33-7c9b19"));
  for (const name of ["podster", "e2e-m5-", "e2e-m5-x/../y", "", undefined]) assert.ok(!repoAllowed(name), String(name));
  assert.deepEqual(mintBody({ contents: "read" }, ["e2e-m5-a"]), { permissions: { contents: "read" }, repositories: ["e2e-m5-a"] });
  assert.throws(() => mintBody({}, ["e2e-m5-a"]));
  assert.throws(() => mintBody(undefined, ["e2e-m5-a"]));
  assert.throws(() => mintBody({ contents: "read" }, []));
  assert.throws(() => mintBody({ contents: "read" }, ["podster"]));
});

test("a tree's bytes are in git's order, a directory sorting as if its name ended in a slash", () => {
  const sha = "ab".repeat(20);
  const e = (mode, name) => ({ mode, name: Buffer.from(name), sha });
  const sorted = [e("100644", "a.txt"), e("40000", "a"), e("100644", "a-b")].sort(treeOrder).map((x) => x.name.toString());
  assert.deepEqual(sorted, ["a-b", "a.txt", "a"]);
  const bytes = treeBytes([e("100644", "b"), e("100644", "a")]);
  assert.equal(bytes.length, 2 * (7 + 1 + 1 + 20));
  assert.equal(bytes.subarray(0, 9).toString("latin1"), "100644 a\0");
});

test("a blob's git sha and the patterned bytes are what git and a second call give", () => {
  assert.equal(gitBlobSha(Buffer.from("")), "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391");
  assert.equal(gitBlobSha(Buffer.from("x\n")), "587be6b4c3f93f93c489c0111bba5596147a26cb");
  const a = patterned(3000, 1);
  assert.equal(a.length, 3000);
  assert.deepEqual(a, patterned(3000, 1));
  assert.notDeepEqual(a.subarray(0, 16), patterned(16, 2));
  assert.deepEqual(a.subarray(0, 1024), a.subarray(1024, 2048));
  assert.equal(createHash("sha256").update(patterned(0, 1)).digest("hex"), createHash("sha256").update("").digest("hex"));
});

test("the proposed rules, against the shapes GitHub answered", () => {
  const blob = (path, extra = {}) => ({ path, mode: "100644", type: "blob", size: 2, ...extra });
  for (const path of ["index.html", "with space.txt", ".hidden", "...", "ünï/文件.txt", "a?b#c%20d&e.txt", "s".repeat(255)]) assert.equal(entryProblem(blob(path)), null, path);
  assert.equal(entryProblem(blob("run.sh", { mode: "100755" })), null);
  assert.equal(entryProblem({ path: "d", mode: "040000", type: "tree" }), null);
  assert.equal(entryProblem(blob("link", { mode: "120000" })), "symlink");
  assert.equal(entryProblem({ path: "sub", mode: "160000", type: "commit" }), "submodule");
  assert.equal(entryProblem(blob("x", { mode: "100664" })), "unknown_mode");
  assert.equal(entryProblem({ path: "x", mode: "100644", type: "blob" }), "no_size");
  assert.equal(entryProblem(blob("latin1-�.txt")), "not_utf8");
  assert.equal(entryProblem(blob("back\\slash.txt")), "backslash");
  assert.equal(entryProblem(blob("tab\there.txt")), "control_character");
  assert.equal(entryProblem(blob("new\nline.txt")), "control_character");
  assert.equal(entryProblem(blob("t".repeat(256))), "segment_too_long");
  assert.equal(entryProblem(blob(`${"d".repeat(250)}/`.repeat(5) + "f.txt")), "path_too_long");
  for (const path of ["a/../b", "./a", "a//b"]) assert.equal(entryProblem(blob(path)), "bad_segment", path);
});

test("one mode, by name", () => {
  assert.equal(argsProblem(["read"]), null);
  assert.match(argsProblem([]), /usage/);
  assert.match(argsProblem(["read", "actions"]), /usage/);
  assert.match(argsProblem(["--merge"]), /usage/);
});
