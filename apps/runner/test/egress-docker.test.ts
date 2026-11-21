// The egress proxy on a real Docker Engine (the owner's approval of 2026-11-20). It never runs in the default config:
// set RUNNER_EGRESS_DOCKER=1 to run it on this machine (`npx vitest run --config vitest.linux.config.ts` with it), and
// CI's Linux job runs it with RUNNER_LINUX_DOCKER=1 next to S-47's proof. It reaches registry.npmjs.org over the
// internet, so it needs a network, and calls no provider.
//
// It builds the proxy image, opens a run through `DockerSandbox` exactly as Runner does (the internal network, the
// proxy, the task's container with Runner's fixed environment), and from INSIDE the task's container proves:
// - a listed host is reachable through the proxy, with TLS verified end to end (registry.npmjs.org's /-/ping answers);
// - an unlisted host, plain HTTP to a listed host, and a listed host on another port are refused by the proxy;
// - there is no direct route: a TCP connection to a public address fails, and Docker's resolver answers no outside name;
// - the proxy listens only on the run's internal network: a container on its outbound network can't reach it;
// - nothing on the machine is reachable from the internal network: it has no gateway and (on Linux) its bridge has no
//   host address, and ports 22, 80, 443, 3128, 5432 and a port this test listens on, on all of the host's addresses,
//   fail at every host address Docker gives its networks; on Linux a control shows that listener is reachable from an
//   ordinary network, so the probe isn't blind;
// - the task's resolver forwards outside names only to an address that is never routed (192.0.2.1);
// then that the proxy logged the decisions, and that `kill` leaves no container or network of the home.
// The first checks use the proxy's image as the task image, for its `node` (the official Node 22 binary, with its
// bundled CA certificates). The third opens a run on Runner's real task image and runs `npm install` from
// registry.npmjs.org through the proxy.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripTypeScriptTypes } from "node:module";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RunFacts } from "../src/core/policy.js";
import { containerSpec } from "../src/core/run-interface.js";
import type { LogFields } from "../src/core/runtime.js";
import { dockerCli, dockerHost, DockerSandbox, findDocker, homeLabel, IMAGE_ID, LABEL_HOME, type DockerCli } from "../src/node/docker-sandbox.js";
import { egressNames, loadProxyProgram } from "../src/node/egress-network.js";
import { ensureFolder } from "../src/node/safe-fs.js";

const ON = process.env.RUNNER_EGRESS_DOCKER === "1" || (process.platform === "linux" && process.env.RUNNER_LINUX_DOCKER === "1");
const REF = "egress-check-1";
const LISTED = "registry.npmjs.org";
const apps = new URL("../", import.meta.url).pathname;

/** Runs in the task's container with Node 22, reading only Runner's fixed HTTPS_PROXY. Prints one `key=value` line. */
const CLIENT = `
import net from "node:net";
import tls from "node:tls";
import dns from "node:dns/promises";
const [mode, host, port] = process.argv.slice(2);
const proxy = new URL(process.env.HTTPS_PROXY);
const done = (line) => { console.log(line); process.exit(0); };
setTimeout(() => done("result=timeout"), 20000);
function viaProxy(head) {
  return new Promise((resolve) => {
    const s = net.connect(Number(proxy.port), proxy.hostname);
    let buf = "";
    s.on("data", (d) => {
      buf += d.toString("latin1");
      const end = buf.indexOf("\\r\\n\\r\\n");
      if (end >= 0) { s.removeAllListeners("data"); resolve({ s, status: buf.split(" ")[1] }); }
    });
    s.on("error", (e) => resolve({ s: null, status: "error:" + e.code }));
    s.on("close", () => resolve({ s: null, status: "closed:" + buf.split(" ")[1] }));
    s.write(head);
  });
}
if (mode === "tls") {
  const { s, status } = await viaProxy("CONNECT " + host + ":443 HTTP/1.1\\r\\nHost: " + host + ":443\\r\\n\\r\\n");
  if (status !== "200") done("result=" + status);
  const t = tls.connect({ socket: s, servername: host });
  let out = "";
  t.on("secureConnect", () => t.write("GET /-/ping HTTP/1.1\\r\\nHost: " + host + "\\r\\nConnection: close\\r\\n\\r\\n"));
  t.on("data", (d) => { out += d; if (out.includes("\\r\\n")) done("result=" + out.split("\\r\\n")[0].replaceAll(" ", "_") + ",authorized=" + t.authorized); });
  t.on("error", (e) => done("result=tls_error:" + e.code));
} else if (mode === "connect") {
  done("result=" + (await viaProxy("CONNECT " + host + ":" + port + " HTTP/1.1\\r\\n\\r\\n")).status);
} else if (mode === "get") {
  done("result=" + (await viaProxy("GET http://" + host + "/ HTTP/1.1\\r\\nHost: " + host + "\\r\\n\\r\\n")).status);
} else if (mode === "direct") {
  const s = net.connect({ host, port: Number(port) });
  s.setTimeout(5000, () => done("result=timeout"));
  s.on("connect", () => done("result=connected"));
  s.on("error", (e) => done("result=error:" + e.code));
} else if (mode === "probe") {
  const tries = host.split(",").flatMap((h) => port.split(",").map((p) => [h, Number(p)]));
  const out = await Promise.all(tries.map(([h, p]) => new Promise((res) => {
    const s = net.connect({ host: h, port: p });
    s.setTimeout(3000, () => (s.destroy(), res(h + ":" + p + "=timeout")));
    s.on("connect", () => (s.destroy(), res(h + ":" + p + "=connected")));
    s.on("error", (e) => res(h + ":" + p + "=" + e.code));
  })));
  done("result=" + out.join(","));
} else if (mode === "dns") {
  try { done("result=" + (await dns.lookup(host)).address); } catch (e) { done("result=error:" + e.code); }
}
`;

describe.runIf(ON)("the egress proxy on a real Docker Engine", () => {
  let home = "";
  let work = "";
  let docker: DockerCli;
  let image = "";
  let sandbox: DockerSandbox;
  let programFile = "";
  let facts: RunFacts;
  const logged: [string, string, LogFields | undefined][] = [];
  const uid = process.getuid?.() ?? -1;
  const gid = process.getgid?.() ?? -1;
  const signal = new AbortController().signal;
  const run = (args: string[], timeoutMs = 120_000) => docker(args, { timeoutMs, maxOutputBytes: 1024 * 1024 });
  const inTask = async (args: string) => {
    const out = await sandbox.exec(REF, { call_id: "c", tool: "shell", command: `node --use-bundled-ca /work/client.mjs ${args}` }, signal);
    return out.text.match(/result=(\S+)/)?.[1] ?? `unparsed:${out.text.slice(0, 200)}`;
  };

  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), "reg-"));
    work = await mkdtemp(join(tmpdir(), "rew-"));
    await chmod(home, 0o700);
    await chmod(work, 0o700);
    const program = findDocker() ?? "";
    expect(program).not.toBe("");
    docker = dockerCli(program, { config_dir: await ensureFolder(home, join(home, "docker-config")), host: dockerHost(process.env, process.platform) });
    const built = await docker(["build", "-q", join(apps, "proxy-image")], { timeoutMs: 15 * 60_000, maxOutputBytes: 64 * 1024 });
    expect(built.code).toBe(0);
    image = built.stdout.trim();
    expect(image).toMatch(IMAGE_ID);
    // Runner's built program when the package is built (CI builds it first); else this source with its types stripped.
    const builtProgram = join(apps, "build", "node", "egress-proxy.js");
    programFile = builtProgram;
    if (!existsSync(builtProgram)) {
      const source = await readFile(join(apps, "src", "node", "egress-proxy.ts"), "utf8");
      programFile = join(home, "egress-proxy.js");
      // The source is erasable syntax only (tsconfig's erasableSyntaxOnly), so stripping its types is its build.
      await writeFile(programFile, stripTypeScriptTypes(source));
    }
    sandbox = new DockerSandbox({ docker, image, uid, gid, home, proxy: { image, program: () => loadProxyProgram(programFile) }, log: (at, outcome, fields) => void logged.push([at, outcome, fields]) });
    facts = {
      adapter: "claude_agent_sdk",
      tools: ["read", "search", "write", "edit", "shell"],
      shell: true,
      network: [LISTED],
      result_tool: "StructuredOutput",
      workspace_root: work,
      task_folder: join(work, "ws_room", "tsk_one"),
      caps: { spend_micro_usd: 1_000_000, run_time_ms: 600_000, turns: 10, output_tokens: 10_000, max_tokens: 4_096 },
      outputs: "hold",
      policy_revision: 1,
      room_visibility: "private",
      prompt_inputs: ["title"],
      repository: null,
    } as unknown as RunFacts;
    await sandbox.open(containerSpec(REF, facts), signal);
    const wrote = await sandbox.exec(REF, { call_id: "c", tool: "write", path: "client.mjs", content: CLIENT }, signal);
    expect(wrote.ok).toBe(true);
  }, 20 * 60_000);

  afterAll(async () => {
    await sandbox?.kill(REF).catch(() => undefined);
    if (home) await rm(home, { recursive: true, force: true });
    if (work) await rm(work, { recursive: true, force: true });
  });

  it("reaches a listed host through the proxy with TLS verified end to end, and nothing else, with no direct route", async () => {
    expect(await inTask(`tls ${LISTED}`)).toBe("HTTP/1.1_200_OK,authorized=true");
    expect(await inTask("connect example.com 443")).toBe("403");
    expect(await inTask(`connect ${LISTED} 80`)).toBe("403");
    expect(await inTask(`get ${LISTED}`)).toBe("405");
    expect(await inTask("connect 104.16.0.35 443")).toBe("403");
    // No route out but the proxy, and Docker's resolver answers no outside name.
    expect(await inTask("direct 1.1.1.1 443")).toMatch(/^(error:(ENETUNREACH|EHOSTUNREACH|ECONNREFUSED)|timeout)$/);
    expect(await inTask(`dns ${LISTED}`)).toMatch(/^error:/);
    // The task container's only network is the run's internal one.
    const names = egressNames(REF);
    const nets = await run(["inspect", "--format", "{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}", `podster-run-${REF}`]);
    expect(nets.stdout.trim()).toBe(names.network);
    const internal = await run(["network", "inspect", "--format", "{{.Internal}}", names.network]);
    expect(internal.stdout.trim()).toBe("true");
    // The proxy listens only on its internal address: a container on its outbound network can't reach it there.
    const outIp = (await run(["inspect", "--format", `{{(index .NetworkSettings.Networks "${names.out}").IPAddress}}`, names.proxy])).stdout.trim();
    expect(outIp).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
    const probe = await run(["run", "--rm", "--network", names.out, "--label", `${LABEL_HOME}=${homeLabel(home)}`, "--pull", "never", image, "node", "-e", `const s=require("net").connect(3128,"${outIp}");s.setTimeout(5000,()=>{console.log("timeout");process.exit(0)});s.on("connect",()=>{console.log("connected");process.exit(0)});s.on("error",e=>{console.log(e.code);process.exit(0)})`]);
    expect(probe.stdout.trim()).toMatch(/^(ECONNREFUSED|timeout|EHOSTUNREACH)$/);
  }, 5 * 60_000);

  it("reaches nothing on the machine through the internal network, and forwards no DNS query anywhere routed", async () => {
    const names = egressNames(REF);
    const fmt = (net: string, f: string) => run(["network", "inspect", "--format", f, net]).then((r) => r.stdout.trim());
    // No gateway on the internal network, and on Linux no host address on its bridge.
    expect(await fmt(names.network, "{{range .IPAM.Config}}{{.Gateway}}{{end}}")).toBe("");
    expect(await fmt(names.network, '{{index .Options "com.docker.network.bridge.inhibit_ipv4"}}')).toBe("true");
    if (process.platform === "linux") {
      const id = (await fmt(names.network, "{{.Id}}")).slice(0, 12);
      expect(execFileSync("ip", ["-4", "-o", "addr", "show", "dev", `br-${id}`], { encoding: "utf8" }).trim()).toBe("");
    }
    // A service on all of the host's addresses, on a port of this test's own.
    const listener = createServer((c) => c.end("host\n"));
    listener.listen(0, "0.0.0.0");
    await new Promise((r) => listener.once("listening", r));
    const high = (listener.address() as AddressInfo).port;
    try {
      // Every host address Docker gives: the outbound network's gateway and the default bridge's, and any the internal
      // network's subnet has left free at .1.
      const gateways = [await fmt(names.out, "{{range .IPAM.Config}}{{.Gateway}}{{end}}"), await fmt("bridge", "{{range .IPAM.Config}}{{.Gateway}}{{end}}")].filter((g) => /^\d+\.\d+\.\d+\.\d+$/.test(g));
      expect(gateways.length).toBeGreaterThan(0);
      const held = (await fmt(names.network, "{{range .Containers}}{{.IPv4Address}} {{end}}")).split(/\s+/).map((a) => a.split("/")[0]);
      const first = (await fmt(names.network, "{{range .IPAM.Config}}{{.Subnet}}{{end}}")).replace(/\.\d+\/\d+$/, ".1");
      const targets = [...gateways, ...(held.includes(first) ? [] : [first])];
      const ports = [22, 80, 443, 3128, 5432, high];
      const result = await inTask(`probe ${targets.join(",")} ${ports.join(",")}`);
      const outcomes = result.split(",");
      expect(outcomes).toHaveLength(targets.length * ports.length);
      for (const o of outcomes) expect(o).toMatch(/=(timeout|ENETUNREACH|EHOSTUNREACH|ECONNREFUSED)$/);
      // The probe isn't blind: on Linux, from an ordinary network, the same listener answers at that network's gateway.
      if (process.platform === "linux") {
        const control = await run(["run", "--rm", "--network", names.out, "--label", `${LABEL_HOME}=${homeLabel(home)}`, "--pull", "never", image, "node", "-e", `const s=require("net").connect(${high},"${gateways[0]}");s.setTimeout(5000,()=>{console.log("timeout");process.exit(0)});s.on("data",d=>{console.log(String(d).trim());process.exit(0)});s.on("error",e=>{console.log(e.code);process.exit(0)})`]);
        expect(control.stdout.trim()).toBe("host");
      }
    } finally {
      listener.close();
    }
    // The task's resolver answers only the internal network's names, and its only upstream is never routed.
    const conf = await sandbox.exec(REF, { call_id: "c", tool: "shell", command: "cat /etc/resolv.conf" }, signal);
    expect(conf.text).toMatch(/^nameserver 127\.0\.0\.11$/m);
    expect(conf.text).toMatch(/ExtServers: \[192\.0\.2\.1\]/);
    expect(conf.text).not.toMatch(/^nameserver (?!127\.0\.0\.11$)/m);
    expect(await inTask("dns exfil-check-podster.example.com")).toMatch(/^error:/);
  }, 5 * 60_000);

  it("logs the proxy's decisions by host and code when the run ends, and leaves no container or network of the home", async () => {
    await sandbox.kill(REF);
    expect(await sandbox.gone(REF)).toBe(true);
    const egress = logged.filter(([at]) => at === "adapter.egress").map(([, outcome, f]) => [outcome, f?.host ?? null, f?.code ?? null]);
    expect(egress).toContainEqual(["host_allowed", LISTED, null]);
    expect(egress).toContainEqual(["host_refused", "example.com", "host_not_listed"]);
    expect(egress).toContainEqual(["host_refused", null, "method_not_allowed"]);
    expect(egress).toContainEqual(["host_refused", null, "ip_literal"]);
    expect(JSON.stringify(logged)).not.toMatch(/http:|\/-\/ping|1\.1\.1\.1|104\.16/);
    const label = `label=${LABEL_HOME}=${homeLabel(home)}`;
    expect((await run(["ps", "--all", "--quiet", "--filter", label])).stdout.trim()).toBe("");
    expect((await run(["network", "ls", "--quiet", "--filter", label])).stdout.trim()).toBe("");
  }, 5 * 60_000);

  it("runs `npm install` of a pinned package from registry.npmjs.org in Runner's real task image, through the proxy", async () => {
    const built = await docker(["build", "-q", join(apps, "sandbox")], { timeoutMs: 15 * 60_000, maxOutputBytes: 64 * 1024 });
    expect(built.code).toBe(0);
    const taskImage = built.stdout.trim();
    expect(taskImage).toMatch(IMAGE_ID);
    const ref = "egress-npm-1";
    const npmSandbox = new DockerSandbox({ docker, image: taskImage, uid, gid, home, proxy: { image, program: () => loadProxyProgram(programFile) } });
    const npmFacts = { ...facts, task_folder: join(work, "ws_room", "tsk_npm") } as RunFacts;
    try {
      await npmSandbox.open(containerSpec(ref, npmFacts), signal);
      const manifest = JSON.stringify({ name: "egress-check", version: "1.0.0", private: true, dependencies: { "is-number": "7.0.0" } });
      expect((await npmSandbox.exec(ref, { call_id: "c", tool: "write", path: "package.json", content: manifest }, signal)).ok).toBe(true);
      const install = await npmSandbox.exec(ref, { call_id: "c", tool: "shell", command: "npm install --no-package-lock --loglevel=error && node -e 'console.log(\"is-number=\" + require(\"is-number\")(7))'" }, signal);
      expect(install.text).toContain("is-number=true");
      expect(install.ok).toBe(true);
    } finally {
      await npmSandbox.kill(ref);
    }
    expect(await npmSandbox.gone(ref)).toBe(true);
  }, 20 * 60_000);
});
