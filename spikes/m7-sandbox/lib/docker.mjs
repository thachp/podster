// Docker helpers. The docker CLI is a third-party program, so it gets the allow-listed environment from
// e2e/child-env.mjs plus its own two settings: a throwaway DOCKER_CONFIG holding `{}` (the Mac's
// credential helper has hung before) and the socket. Nothing here mounts a home directory, the key or
// the Docker socket into a container.

import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { childEnv } from "../../../e2e/child-env.mjs";

export const IMAGE = "node:22-bookworm-slim";
export const INTERNAL_NET = "m7b-internal";

export function dockerEnv(scratch) {
  const cfg = join(scratch, "dockercfg");
  mkdirSync(cfg, { recursive: true });
  if (!existsSync(join(cfg, "config.json"))) writeFileSync(join(cfg, "config.json"), "{}");
  return childEnv({ DOCKER_CONFIG: cfg, DOCKER_HOST: `unix://${process.env.HOME}/.docker/run/docker.sock` });
}

export function docker(env, args, { input, allowFail = false } = {}) {
  const r = spawnSync("docker", args, { env, input, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0 && !allowFail) throw new Error(`docker ${args[0]} failed (${r.status}): ${(r.stderr ?? "").slice(0, 300)}`);
  return r;
}

/** Async docker, for anything that may call back into this process (the broker would deadlock otherwise). */
export function dockerAsync(env, args, { timeoutMs = 60_000 } = {}) {
  return new Promise((resolve) => {
    const p = spawn("docker", args, { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    p.stdout.on("data", (d) => (stdout += d));
    p.stderr.on("data", (d) => (stderr += d));
    const t = setTimeout(() => p.kill("SIGKILL"), timeoutMs);
    p.on("close", (status) => {
      clearTimeout(t);
      resolve({ status, stdout, stderr });
    });
  });
}

export function spawnDocker(env, args, opts = {}) {
  return spawn("docker", args, { env, stdio: ["pipe", "pipe", "pipe"], ...opts });
}

/** The internal network has no route out. Only the relay sits on it and on the default bridge. */
export function ensureNetworks(env) {
  if (docker(env, ["network", "inspect", INTERNAL_NET], { allowFail: true }).status !== 0)
    docker(env, ["network", "create", "--internal", INTERNAL_NET]);
}

/**
 * The relay: a plain TCP forwarder from relay:8080 on the internal network to the broker on the host.
 * It holds no key and adds nothing; the broker checks every request.
 */
export function startRelay(env, brokerPort, name = "m7b-relay") {
  docker(env, ["rm", "-f", name], { allowFail: true });
  const script =
    "const net=require('net');net.createServer(c=>{const u=net.connect(" +
    brokerPort +
    ",'host.docker.internal');c.pipe(u);u.pipe(c);c.on('error',()=>u.destroy());u.on('error',()=>c.destroy())}).listen(8080)";
  docker(env, ["run", "-d", "--name", name, "--user", "1000:1000", "--cap-drop", "ALL", "--read-only", IMAGE, "node", "-e", script]);
  docker(env, ["network", "connect", "--alias", "relay", INTERNAL_NET, name]);
  return name;
}

/**
 * A task container: non-root, no capabilities, no new privileges, read-only root, its own task folder
 * at /work and nothing else of the host's except read-only tools. `network` is "none" or the internal net.
 */
export function startTaskContainer(env, { name, taskDir, network, mounts = [] }) {
  docker(env, ["rm", "-f", name], { allowFail: true });
  const args = [
    "run", "-d", "--name", name,
    "--user", "1000:1000",
    "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges",
    "--read-only",
    "--tmpfs", "/tmp:rw,size=64m",
    "--tmpfs", "/home/task:rw,size=256m,uid=1000,gid=1000",
    "--pids-limit", "256",
    "--memory", "2g",
    "--network", network,
    "-e", "HOME=/home/task",
    "-v", `${taskDir}:/work:rw`,
    "-w", "/work",
  ];
  for (const [src, dst] of mounts) args.push("-v", `${src}:${dst}:ro`);
  args.push(IMAGE, "sleep", "infinity");
  docker(env, args);
  return name;
}

export function removeContainer(env, name) {
  docker(env, ["rm", "-f", name], { allowFail: true });
}
