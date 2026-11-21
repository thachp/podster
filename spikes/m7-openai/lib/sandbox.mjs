// The task container, as Runner's is: the SDK never runs anything; allowed tool calls run here. One container per
// task: user 1000, all capabilities dropped, no-new-privileges, read-only root, no network, the task folder at /work,
// no home, key or Docker socket mounted. The docker CLI is a third-party program, so it gets the allow-listed
// environment from e2e/child-env.mjs plus a throwaway DOCKER_CONFIG holding `{}`.
//
// Used only by spike.mjs's real scenarios; the tests use an in-memory session instead.

import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, existsSync, realpathSync, lstatSync } from "node:fs";
import { join, resolve, sep, dirname } from "node:path";
import { childEnv } from "../../../e2e/child-env.mjs";

export const IMAGE = "node:22-bookworm-slim";
const EXEC_TIMEOUT_MS = 60_000;

export function dockerEnv(scratch) {
  const cfg = join(scratch, "dockercfg");
  mkdirSync(cfg, { recursive: true });
  if (!existsSync(join(cfg, "config.json"))) writeFileSync(join(cfg, "config.json"), "{}");
  return childEnv({ DOCKER_CONFIG: cfg, DOCKER_HOST: `unix://${process.env.HOME}/.docker/run/docker.sock` });
}

function docker(env, args, { allowFail = false } = {}) {
  const r = spawnSync("docker", args, { env, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  if (r.status !== 0 && !allowFail) throw new Error(`docker ${args[0]} failed (${r.status})`);
  return r;
}

/** Start a task's container. Returns its name. */
export function startTaskContainer(env, { name, taskDir }) {
  docker(env, ["rm", "-f", name], { allowFail: true });
  docker(env, [
    "run", "-d", "--rm", "--name", name, "--network", "none", "--user", "1000:1000", "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges", "--read-only", "--tmpfs", "/tmp:rw,size=64m", "--pids-limit", "128",
    "--memory", "512m", "-e", "HOME=/tmp", "-v", `${taskDir}:/work`, "-w", "/work", IMAGE, "sleep", "infinity",
  ]);
  return name;
}

export function removeContainer(env, name) {
  docker(env, ["rm", "-f", name], { allowFail: true });
}

/** Run one allowed command in the container. Output is stdout and stderr together, with the exit status. */
export function execIn(env, name, command) {
  return new Promise((done) => {
    const p = spawn("docker", ["exec", name, "sh", "-c", command], { env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (out += d));
    const t = setTimeout(() => p.kill("SIGKILL"), EXEC_TIMEOUT_MS);
    p.on("close", (status) => {
      clearTimeout(t);
      done(`${out}\n[exit ${status}]`);
    });
  });
}

/** A path inside the task folder, or null. The policy has already refused absolute paths and `..`. */
function inside(taskDir, rel) {
  const root = realpathSync(taskDir);
  const full = resolve(root, rel);
  if (!full.startsWith(root + sep)) return null;
  const parent = dirname(full);
  if (!existsSync(parent)) return null;
  const realParent = realpathSync(parent);
  if (realParent !== root && !realParent.startsWith(root + sep)) return null; // a linked folder out of the task
  try {
    if (lstatSync(full).isSymbolicLink()) return null; // any link, dangling or not
  } catch {
    // does not exist yet
  }
  return full;
}

/** The session's tool runner for one task. */
export function taskTools(env, { name, taskDir }) {
  return async ({ name: tool, input }) => {
    if (tool === "shell") return execIn(env, name, input.command);
    const full = inside(taskDir, input.path);
    if (!full) return "path refused";
    if (tool === "read_file") return existsSync(full) ? readFileSync(full, "utf8") : "no such file";
    if (tool === "write_file") {
      writeFileSync(full, input.content);
      return "written";
    }
    return "unknown tool";
  };
}
