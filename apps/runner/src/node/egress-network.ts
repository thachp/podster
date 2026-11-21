/**
 * A run's egress: the internal network and proxy container that let a task's container reach exactly the hosts its
 * room's run policy lists (the owner's approval of 2026-11-20). `DockerSandbox` opens them before the task's container
 * when the run's network is an allowlist, and removes them with it.
 *
 * - **Two networks, per run.** The internal one is `--internal`, so Docker gives it no route out, and its bridge has no
 *   address on the host (`inhibit_ipv4`), so no gateway either; its only containers are the task's and the proxy. The outbound one is an ordinary bridge network of the run's own, whose only container
 *   is the proxy, so no other container on the machine shares the proxy's route out (not Docker's default bridge), and
 *   Docker's resolver forwards the proxy's lookups. Both carry the run's and home's labels and the role
 *   `egress-network`, so the stray sweep at startup finds them, and Claude Code's driver, which removes its own role
 *   `network`, never touches them.
 * - **The proxy** (`egress-proxy.ts`) starts on the internal network with the alias `egress`, listening only on its own
 *   address there, and only then joins the outbound network. Its image is pinned by its image ID and
 *   holds Node only; the program is Runner's own built `egress-proxy.js`, given as an argument with the subnet and the
 *   room's hosts (no secret). It has the task container's hardening with tighter limits, no mount and a lifetime of the
 *   run's.
 * - **The task's container** joins only the internal network and gets the proxy's address through Runner's fixed
 *   environment (`EGRESS_ENV`). Docker's resolver on an internal network answers only the names of its containers.
 *
 * Every Docker failure is a fixed code with its step and exit code. Logs carry the run's ID, hosts and codes only.
 */
import { readFile } from "node:fs/promises";
import { EGRESS_ALIAS } from "../core/run-interface.js";
import type { Logger } from "../core/runtime.js";
import { dockerFailure, LABEL_HOME, LABEL_ROLE, LABEL_RUN, LIMITS, REMOVAL_CHECK_MS, REMOVAL_CHECKS, type DockerCli } from "./docker-sandbox.js";
import { isHostName, PROXY_REFUSALS, type ProxyRefusal } from "./egress-proxy.js";

export const ROLE_PROXY = "egress";
export const ROLE_NETWORK = "egress-network";

/** The names of a run's egress network and proxy container. */
export function egressNames(ref: string) {
  const r = ref.toLowerCase();
  return { network: `podster-egress-net-${r}`, out: `podster-egress-out-${r}`, proxy: `podster-egress-${r}` };
}

/** The proxy's own limits: smaller than the task container's. **Proposed** figures. */
export const PROXY_CONTAINER = Object.freeze({ pids: 64, memory: "256m", cpus: "1", ready_checks: 40, ready_check_ms: 250, log_bytes: 256 * 1024, log_entries: 100, log_max_size: "1m", log_max_files: "2" });

const labels = (ref: string, home_label: string, role: string) => ["--label", `${LABEL_RUN}=${ref}`, "--label", `${LABEL_HOME}=${home_label}`, "--label", `${LABEL_ROLE}=${role}`];

/** `docker network create` for the run's internal network, or its outbound one (the proxy's alone). */
export function egressNetworkArgs(ref: string, home_label: string, which: "internal" | "out"): string[] {
  const names = egressNames(ref);
  // The internal network's bridge gets no address on the host (`inhibit_ipv4`), so it has no gateway: a task can reach
  // the proxy and nothing on the machine, not even a service listening on all of the host's addresses.
  return which === "internal"
    ? ["network", "create", "--internal", "--opt", "com.docker.network.bridge.inhibit_ipv4=true", ...labels(ref, home_label, ROLE_NETWORK), names.network]
    : ["network", "create", ...labels(ref, home_label, ROLE_NETWORK), names.out];
}

/** The one IPv4 subnet `docker network inspect` printed for the run's network, or null. */
export function subnetOf(stdout: string): string | null {
  const found = stdout.split(/\s+/).filter((s) => /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\/\d{1,2}$/.test(s));
  return found.length === 1 ? found[0] : null;
}

/**
 * `docker run` for the proxy: on the run's internal network as `egress`, hardened, with no mount and no environment of
 * Runner's, running Runner's program over the room's hosts. Every host is checked again here, so nothing but a host name
 * is ever an argument.
 */
export function proxyRunArgs(o: { ref: string; image: string; uid: number; gid: number; home_label: string; max_seconds: number; program: string; subnet: string; hosts: readonly string[] }): string[] {
  if (o.hosts.length === 0 || !o.hosts.every(isHostName)) throw new Error("egress_hosts_invalid");
  if (subnetOf(o.subnet) !== o.subnet) throw new Error("egress_subnet_invalid");
  const names = egressNames(o.ref);
  return [
    "run", "--detach", "--pull", "never",
    "--name", names.proxy,
    ...labels(o.ref, o.home_label, ROLE_PROXY),
    "--user", `${o.uid}:${o.gid}`,
    "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges",
    "--read-only",
    "--pids-limit", String(PROXY_CONTAINER.pids),
    "--memory", PROXY_CONTAINER.memory,
    "--memory-swap", PROXY_CONTAINER.memory,
    "--cpus", PROXY_CONTAINER.cpus,
    "--ulimit", "nofile=1024:1024",
    "--ulimit", "core=0",
    "--ipc", "none",
    // Its decision log is bounded on the host's disk, whatever a flood of refused connections writes.
    "--log-driver", "json-file",
    "--log-opt", `max-size=${PROXY_CONTAINER.log_max_size}`,
    "--log-opt", `max-file=${PROXY_CONTAINER.log_max_files}`,
    "--network", names.network,
    "--network-alias", EGRESS_ALIAS,
    "--init",
    o.image,
    "timeout", String(o.max_seconds),
    "node", "--input-type=module", "-e", o.program,
    o.subnet, ...o.hosts,
  ];
}

/** Runner's built proxy program, with the call that starts it. Read when a run first needs it. */
export async function loadProxyProgram(path: URL | string = new URL("./egress-proxy.js", import.meta.url)): Promise<string> {
  const text = await readFile(path, "utf8");
  if (!/export function main\(/.test(text)) throw new Error("egress_program_invalid");
  return `${text}\nmain(process.argv.slice(1));\n`;
}

export type EgressOpts = { docker: DockerCli; image: string; program: () => Promise<string>; uid: number; gid: number; home_label: string; wait: (ms: number) => Promise<void> };

const run = (docker: DockerCli, args: string[], signal?: AbortSignal, maxOutputBytes = 64 * 1024) => docker(args, { signal, timeoutMs: LIMITS.docker_ms, maxOutputBytes });

/**
 * Opens the run's network and proxy, and waits until the proxy says it's listening. On any failure what it made is
 * left for `closeEgress`, which the sandbox's `kill` runs, and a fixed code is thrown.
 */
export async function openEgress(o: EgressOpts, ref: string, hosts: readonly string[], max_seconds: number, signal: AbortSignal): Promise<void> {
  const names = egressNames(ref);
  const program = await o.program();
  const step = async (name: string, args: string[], max?: number) => {
    if (signal.aborted) throw new Error("halted");
    const r = await run(o.docker, args, signal, max);
    if (r.code !== 0) throw dockerFailure(name, r.code);
    return r;
  };
  await step("egress_network_create", egressNetworkArgs(ref, o.home_label, "internal"));
  await step("egress_out_create", egressNetworkArgs(ref, o.home_label, "out"));
  const inspected = await step("egress_network_inspect", ["network", "inspect", "--format", "{{range .IPAM.Config}}{{.Subnet}} {{end}}", names.network], 4096);
  const subnet = subnetOf(inspected.stdout);
  if (!subnet) throw new Error("egress_subnet_invalid");
  await step("egress_run", proxyRunArgs({ ref, image: o.image, uid: o.uid, gid: o.gid, home_label: o.home_label, max_seconds, program, subnet, hosts }), 4096);
  // Listening on the internal network first, at an address it found alone there; only then a route out.
  await waitReady(o, names.proxy, signal);
  await step("egress_connect", ["network", "connect", names.out, names.proxy]);
}

async function waitReady(o: EgressOpts, proxy: string, signal: AbortSignal) {
  for (let check = 0; check < PROXY_CONTAINER.ready_checks; check++) {
    if (signal.aborted) throw new Error("halted");
    const r = await run(o.docker, ["logs", proxy], signal, 4096);
    if (r.code === 0 && r.stdout.split("\n").some((l) => l.trim() === '{"e":"ready"}')) return;
    await o.wait(PROXY_CONTAINER.ready_check_ms);
  }
  throw new Error("egress_proxy_not_ready");
}

/** One kind of decision the proxy logged, how often. */
export type EgressTally = { outcome: "host_allowed" | "host_refused"; host: string | null; code: ProxyRefusal | null; count: number };

/**
 * The proxy's decisions from its log lines, checked again and counted: each line exactly one of the proxy's own shapes,
 * with a host that is a host name and a code from its fixed list. Anything else is dropped. At most
 * `PROXY_CONTAINER.log_entries` kinds.
 */
export function tallyProxyLog(stdout: string): EgressTally[] {
  const tally = new Map<string, EgressTally>();
  for (const line of stdout.split("\n")) {
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof event !== "object" || event === null || Array.isArray(event)) continue;
    const e = event as Record<string, unknown>;
    const keys = Object.keys(e).sort().join(",");
    let entry: Omit<EgressTally, "count"> | null = null;
    if (e.e === "allowed" && keys === "e,host" && isHostName(e.host)) entry = { outcome: "host_allowed", host: e.host, code: null };
    else if (e.e === "refused" && (keys === "code,e" || keys === "code,e,host") && (PROXY_REFUSALS as readonly unknown[]).includes(e.code) && (keys === "code,e" || isHostName(e.host))) {
      entry = { outcome: "host_refused", host: keys === "code,e" ? null : (e.host as string), code: e.code as ProxyRefusal };
    }
    if (!entry) continue;
    const key = `${entry.outcome} ${entry.host ?? ""} ${entry.code ?? ""}`;
    const seen = tally.get(key);
    if (seen) seen.count += 1;
    else if (tally.size < PROXY_CONTAINER.log_entries) tally.set(key, { ...entry, count: 1 });
  }
  return [...tally.values()];
}

/** The proxy's decisions, logged by the run's ID. Best effort: a proxy already gone has nothing to say. */
export async function logProxyDecisions(docker: DockerCli, ref: string, log: Logger): Promise<void> {
  const r = await run(docker, ["logs", egressNames(ref).proxy], undefined, PROXY_CONTAINER.log_bytes);
  if (r.code !== 0) return;
  for (const t of tallyProxyLog(r.stdout)) log("adapter.egress", t.outcome, { run: ref, count: t.count, ...(t.host ? { host: t.host } : {}), ...(t.code ? { code: t.code } : {}) });
}

/**
 * Removes each network matching `filters`: attached containers disconnected first if `rm` refuses, then confirmed gone
 * (the ninth real run of #460: `network rm` while a container is attached answers "has active endpoints").
 */
export async function removeNetworks(docker: DockerCli, filters: string[], wait: (ms: number) => Promise<void>): Promise<void> {
  const d = (args: string[]) => run(docker, args);
  const list = async () => {
    const r = await d(["network", "ls", "--quiet", "--no-trunc", ...filters.flatMap((f) => ["--filter", f])]);
    if (r.code !== 0) throw dockerFailure("network_ls", r.code);
    if (r.cut) throw new Error("docker_network_ls_cut");
    const ids = r.stdout.split("\n").map((l) => l.trim()).filter((l) => l !== "");
    if (!ids.every((id) => /^[A-Za-z0-9_.-]{1,128}$/.test(id))) throw new Error("docker_network_ls_output");
    return ids;
  };
  for (const network of await list()) {
    let r = await d(["network", "rm", "--force", network]);
    if (r.code !== 0) {
      const attached = await d(["network", "inspect", "--format", "{{range .Containers}}{{.Name}} {{end}}", network]);
      if (attached.code !== 0) throw dockerFailure("network_inspect", attached.code);
      for (const name of attached.stdout.split(/\s+/).filter((n) => /^[A-Za-z0-9_.-]{1,128}$/.test(n))) {
        const x = await d(["network", "disconnect", "--force", network, name]);
        if (x.code !== 0) throw dockerFailure("network_disconnect", x.code);
      }
      r = await d(["network", "rm", "--force", network]);
      if (r.code !== 0) throw dockerFailure("network_rm", r.code);
    }
  }
  for (let check = 0; check < REMOVAL_CHECKS; check++) {
    if ((await list()).length === 0) return;
    await wait(REMOVAL_CHECK_MS);
  }
  throw new Error("docker_network_lingers");
}
