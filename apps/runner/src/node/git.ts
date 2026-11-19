/**
 * Host Git, as Runner runs it (M7 step 10; L2 on #459). Every command is an argument array with no shell, from a fixed
 * install of Git, with the allow-listed environment (`child-env.ts`) and these on top:
 *
 * - **No configuration Runner didn't write.** `GIT_CONFIG_NOSYSTEM`, `GIT_CONFIG_GLOBAL=/dev/null` and an empty `HOME` in
 *   Runner's home, so no system or user setting is read; and the repository's own configuration is in a Git folder in
 *   Runner's home, never mounted into a container, so the task can't write it. The settings that could run anything
 *   (`core.hooksPath`, `core.fsmonitor`, `core.sshCommand`, credential helpers and the rest) are set on every command
 *   line too (`hardening` in `core/repository.ts`), whatever any configuration says.
 * - **No prompt.** `GIT_TERMINAL_PROMPT=0`, so a missing credential fails rather than waits.
 * - **The token only through descriptor 3.** A command that reaches GitHub is handed the token on a pipe Runner opens as
 *   the child's descriptor 3, read only by Runner's credential helper (`apps/runner/git/credential-helper`). It is never
 *   an argument, an environment variable, a URL, a file or a setting.
 *
 * Output is bounded and never logged; a caller reads only exit codes, commit IDs and porcelain lines from it.
 */
import { spawn } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { lstat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { isPlainPath, RepoPathError } from "../core/repository.js";
import { childEnv } from "./child-env.js";

export type GitResult = { code: number; stdout: string; stderr: string };
/** Runs one Git command. `secret` goes to the child's descriptor 3 and nowhere else. */
export type GitExec = (args: string[], opts: { secret?: string; signal?: AbortSignal; timeout_ms?: number }) => Promise<GitResult>;

/** The most Runner reads of either stream; more is cut and the command fails. */
export const MAX_GIT_OUTPUT = 1024 * 1024;
export const GIT_TIMEOUT_MS = 10 * 60 * 1000;

/** Git from a fixed place, never from `PATH`. */
export function findGit(exists: (path: string) => boolean = existsSync): string | null {
  for (const path of ["/usr/bin/git", "/opt/homebrew/bin/git", "/usr/local/bin/git"]) if (exists(path)) return path;
  return null;
}

/** Runner's credential helper, shipped beside its source. Its path must be plain, so Git's shell reads it as one word. */
export const HELPER_PATH = fileURLToPath(new URL("../../git/credential-helper", import.meta.url));

/** The helper, checked: a plain path to a regular file, not a link, that only its owner can change. */
export async function checkedHelper(path = HELPER_PATH): Promise<string> {
  if (!isPlainPath(path)) throw new RepoPathError("helper_unavailable");
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o022) !== 0 || (info.mode & 0o100) === 0) throw new Error("unsafe");
  } catch {
    throw new RepoPathError("helper_unavailable");
  }
  return path;
}

/**
 * The environment of every Git command: the allow-listed basics, an empty home, no configuration but Runner's, and a
 * fixed `PATH`, so nothing Git starts by name (its own helpers, `sh` for the credential helper) comes from the owner's.
 */
export function gitEnv(home: string, from: NodeJS.ProcessEnv = process.env): Record<string, string> {
  return childEnv(
    {
      HOME: home,
      PATH: "/usr/bin:/bin",
      LC_ALL: "C",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
      GIT_ATTR_NOSYSTEM: "1",
      GIT_NO_REPLACE_OBJECTS: "1",
      GIT_PROTOCOL_FROM_USER: "0",
      GIT_CEILING_DIRECTORIES: home,
      GIT_OPTIONAL_LOCKS: "0",
    },
    from,
  );
}

/**
 * Git, run for real: `program` an absolute path from `findGit`, resolved once when this is made; `home` an empty folder
 * of Runner's, which is also every command's working folder, so no command ever runs in a task's folder, which the
 * task can write (#462's review, item 8).
 */
export function gitCli(program: string, home: string, from: NodeJS.ProcessEnv = process.env): GitExec {
  const env = gitEnv(home, from);
  if (!program.startsWith("/")) throw new RepoPathError("git_unavailable");
  let resolved: string;
  try {
    resolved = realpathSync(program);
  } catch {
    throw new RepoPathError("git_unavailable");
  }
  return (args, opts) =>
    new Promise((resolve, reject) => {
      const child = spawn(resolved, args, { cwd: home, env, stdio: ["ignore", "pipe", "pipe", opts.secret === undefined ? "ignore" : "pipe"], signal: opts.signal, timeout: opts.timeout_ms ?? GIT_TIMEOUT_MS, killSignal: "SIGKILL" });
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      let size = 0;
      let cut = false;
      const take = (into: Buffer[]) => (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_GIT_OUTPUT) {
          cut = true;
          child.kill("SIGKILL");
          return;
        }
        into.push(chunk);
      };
      child.stdout?.on("data", take(out));
      child.stderr?.on("data", take(err));
      if (opts.secret !== undefined) {
        const pipe = child.stdio[3] as NodeJS.WritableStream & { on(event: "error", fn: () => void): void };
        // A Git command that never asks for the credential leaves it unread; the pipe closes when the command ends.
        pipe.on("error", () => undefined);
        pipe.end(`${opts.secret}\n`);
      }
      child.on("error", () => reject(new RepoPathError("git_unavailable", true)));
      child.on("close", (code) => {
        if (cut) return resolve({ code: 125, stdout: "", stderr: "" });
        resolve({ code: code ?? 128, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8") });
      });
    });
}

