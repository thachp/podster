#!/usr/bin/env node
// CI's copy of the toolchain downloads that Maven Central serves, for Runner's real-Docker test
// (test/toolchains-docker.test.ts with RUNNER_TOOLCHAIN_FILES). Maven Central answers 429 to the shared egress of
// hosted CI (CI run 45600622961), and Sonatype asks tools to cache instead of fetching on every run, so CI's `runner`
// job keeps the tarball in actions/cache, keyed by its pinned SHA-512, and fetches it from Maven Central only on a miss.
//
//   node scripts/toolchain-files.mjs key           prints `key=maven-<the pinned SHA-512>`, for $GITHUB_OUTPUT
//   node scripts/toolchain-files.mjs fetch <dir>   makes sure <dir> holds the tarball with that SHA-512
//
// The address and the SHA-512 are read from toolchains/java/Dockerfile (its `ARG MAVEN_URL=` default and the sum its
// build checks), so they can't drift from what Runner builds. A file already in <dir> is used only if it hashes to the
// pin; otherwise it is fetched again. A fetch is tried at most three times, waiting what a 429 or 503's Retry-After
// asks (at most two minutes) or 30 s, and the result is kept only if it hashes to the pin. Nothing else is written.
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

const DOCKERFILE = fileURLToPath(new URL("../toolchains/java/Dockerfile", import.meta.url));
const MAX_BYTES = 64 * 1024 * 1024;
const TRIES = 3;
const MAX_WAIT_MS = 120_000;
const DEFAULT_WAIT_MS = 30_000;

const usage = "usage: node scripts/toolchain-files.mjs key | fetch <dir>";

/** Maven's pinned address and SHA-512, from the Java Dockerfile. */
export async function pinned(dockerfile = DOCKERFILE) {
  const text = await readFile(dockerfile, "utf8");
  const url = /^ARG MAVEN_URL=(https:\/\/repo\.maven\.apache\.org\/\S+\/([A-Za-z0-9._-]+))$/m.exec(text);
  const sha512 = /^ +([0-9a-f]{128}) maven\.tar\.gz > sums512 \\$/m.exec(text);
  if (!url || !sha512) throw new Error(`${dockerfile} has no ARG MAVEN_URL on Maven Central, or no pinned SHA-512 for maven.tar.gz`);
  return { url: url[1], name: url[2], sha512: sha512[1] };
}

const hashOf = (bytes) => createHash("sha512").update(bytes).digest("hex");

/** Seconds or an HTTP date, as Retry-After gives it, bounded. */
function waitFor(response) {
  const after = response.headers.get("retry-after");
  if (after === null) return DEFAULT_WAIT_MS;
  const ms = /^\d+$/.test(after.trim()) ? Number(after.trim()) * 1000 : Date.parse(after) - Date.now();
  return Number.isFinite(ms) ? Math.min(Math.max(ms, 1000), MAX_WAIT_MS) : DEFAULT_WAIT_MS;
}

async function download(url) {
  for (let i = 1; ; i++) {
    const response = await fetch(url, { redirect: "follow", headers: { "user-agent": "podster-ci-toolchain-cache" } });
    if (response.ok) {
      if (!response.url.startsWith("https://")) throw new Error("the download was redirected off https");
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.byteLength > MAX_BYTES) throw new Error("the download is larger than expected");
      return bytes;
    }
    await response.body?.cancel();
    const again = (response.status === 429 || response.status >= 500) && i < TRIES;
    if (!again) throw new Error(`the download answered ${response.status} on try ${i}`);
    const ms = response.status === 429 || response.status === 503 ? waitFor(response) : DEFAULT_WAIT_MS;
    console.log(`toolchain files - ${response.status} on try ${i}, waiting ${Math.round(ms / 1000)} s`);
    await sleep(ms);
  }
}

async function fetchInto(dir) {
  const pin = await pinned();
  const path = join(dir, pin.name);
  const kept = await readFile(path).catch(() => null);
  if (kept && hashOf(kept) === pin.sha512) {
    console.log(`toolchain files - ${pin.name} cached, SHA-512 matches the pin`);
    return;
  }
  await mkdir(dir, { recursive: true });
  const bytes = await download(pin.url);
  if (hashOf(bytes) !== pin.sha512) throw new Error(`${pin.name} doesn't hash to the pinned SHA-512`);
  const part = `${path}.part`;
  await writeFile(part, bytes, { mode: 0o644 });
  await rename(part, path).catch(async (error) => {
    await rm(part, { force: true });
    throw error;
  });
  console.log(`toolchain files - ${pin.name} fetched from Maven Central, SHA-512 matches the pin`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [command, dir] = process.argv.slice(2);
  try {
    if (command === "key" && dir === undefined) console.log(`key=maven-${(await pinned()).sha512}`);
    else if (command === "fetch" && dir) await fetchInto(dir);
    else {
      console.log(usage);
      process.exit(command === "--help" ? 0 : 2);
    }
  } catch (error) {
    console.error(`toolchain files - ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
