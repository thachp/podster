// Runner's egress proxy (the owner's approval of 2026-11-20): a room's tasks reach exactly the hosts its run policy
// lists, over HTTPS CONNECT on port 443, at public addresses only, through a proxy container on the run's internal
// network. The proxy's decisions run here on loopback with a stand-in resolver and dialer; the sandbox's Docker steps
// on a fake docker. The real proof on Docker is test/egress-docker.test.ts.
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { connect, createServer, type AddressInfo, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { RunFacts } from "../src/core/policy.js";
import { checkContainerSpec, containerSpec, CONTAINER_ENV, EGRESS_ENV, runFrame } from "../src/core/run-interface.js";
import { logLine } from "../src/core/runtime.js";
import { DockerSandbox, homeLabel, LABEL_HOME, LABEL_ROLE, LABEL_RUN, runArgs, type DockerCli } from "../src/node/docker-sandbox.js";
import { egressNames, loadProxyProgram, proxyRunArgs, subnetOf, tallyProxyLog } from "../src/node/egress-network.js";
import { addressIn, checkAddresses, createEgressProxy, isPublicAddress, parseConnect, type ProxyEvent } from "../src/node/egress-proxy.js";

const IMAGE = `sha256:${"a".repeat(64)}`;
const PROXY_IMAGE = `sha256:${"e".repeat(64)}`;
const CAPS = { spend_micro_usd: 1_000_000, run_time_ms: 600_000, turns: 10, output_tokens: 10_000, max_tokens: 4_096 };

const temps: string[] = [];
const servers: Server[] = [];
async function temp() {
  const dir = await mkdtemp(join(tmpdir(), "runner-egress-"));
  temps.push(dir);
  return dir;
}
afterEach(async () => {
  for (const s of servers.splice(0)) s.close();
  for (const dir of temps.splice(0)) await rm(dir, { recursive: true, force: true });
});

const facts = (root: string, network: string[] = []): RunFacts =>
  ({
    adapter: "claude_agent_sdk",
    tools: ["read", "search", "write", "edit", "shell"],
    shell: true,
    network,
    result_tool: "StructuredOutput",
    workspace_root: root,
    task_folder: join(root, "ws_room", "tsk_one"),
    caps: { ...CAPS },
    outputs: "hold",
    policy_revision: 1,
    room_visibility: "private",
    prompt_inputs: ["title"],
    repository: null,
  }) as unknown as RunFacts;

describe("the proxy's request check", () => {
  it("passes only CONNECT host:443 with HTTP/1.1 or 1.0, lower-casing the host", () => {
    expect(parseConnect("CONNECT registry.npmjs.org:443 HTTP/1.1\r\nHost: registry.npmjs.org:443")).toEqual({ ok: true, host: "registry.npmjs.org" });
    expect(parseConnect("CONNECT Registry.NPMJS.org:443 HTTP/1.0")).toEqual({ ok: true, host: "registry.npmjs.org" });
  });

  const refused: [string, string, string, string | null][] = [
    ["plain HTTP, absolute form", "GET http://registry.npmjs.org/ HTTP/1.1", "method_not_allowed", null],
    ["plain HTTP, origin form", "GET / HTTP/1.1", "method_not_allowed", null],
    ["another method", "POST registry.npmjs.org:443 HTTP/1.1", "method_not_allowed", null],
    ["port 80", "CONNECT registry.npmjs.org:80 HTTP/1.1", "port_not_allowed", "registry.npmjs.org"],
    ["port 8443", "CONNECT registry.npmjs.org:8443 HTTP/1.1", "port_not_allowed", "registry.npmjs.org"],
    ["port 0443", "CONNECT registry.npmjs.org:0443 HTTP/1.1", "port_not_allowed", "registry.npmjs.org"],
    ["no port", "CONNECT registry.npmjs.org HTTP/1.1", "request_invalid", null],
    ["a port that isn't a number", "CONNECT registry.npmjs.org:https HTTP/1.1", "request_invalid", "registry.npmjs.org"],
    ["an IPv4 literal", "CONNECT 104.16.0.35:443 HTTP/1.1", "ip_literal", null],
    ["a bracketed IPv6 literal", "CONNECT [2606:4700::6810:1023]:443 HTTP/1.1", "ip_literal", null],
    ["a bare IPv6 literal", "CONNECT ::1:443 HTTP/1.1", "ip_literal", null],
    ["a decimal IPv4 trick", "CONNECT 2130706433:443 HTTP/1.1", "host_invalid", null],
    ["a wildcard", "CONNECT *.npmjs.org:443 HTTP/1.1", "host_invalid", null],
    ["a trailing dot", "CONNECT registry.npmjs.org.:443 HTTP/1.1", "host_invalid", null],
    ["user info", "CONNECT user@registry.npmjs.org:443 HTTP/1.1", "host_invalid", null],
    ["a single label", "CONNECT egress:443 HTTP/1.1", "host_invalid", null],
    ["HTTP/2 or junk", "CONNECT registry.npmjs.org:443 HTTP/2", "request_invalid", null],
    ["extra spaces", "CONNECT  registry.npmjs.org:443 HTTP/1.1", "request_invalid", null],
    ["nothing", "", "request_invalid", null],
  ];
  it.each(refused)("refuses %s", (_what, head, code, host) => {
    expect(parseConnect(head)).toEqual({ ok: false, code, host });
  });
});

describe("the proxy's address check", () => {
  const notPublic = [
    "127.0.0.1", "127.8.9.10", "0.0.0.0", "10.0.0.1", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "100.64.0.1", "100.100.100.200",
    "192.0.0.1", "192.0.2.1", "198.18.0.1", "198.51.100.1", "203.0.113.1", "224.0.0.1", "239.255.255.250", "240.0.0.1", "255.255.255.255", "192.88.99.1",
    "::", "::1", "fe80::1", "fc00::1", "fd00:ec2::254", "ff02::1", "::ffff:127.0.0.1", "::ffff:8.8.8.8", "64:ff9b::7f00:1", "2002:7f00:1::1", "2001::1", "2001:db8::1", "100::1",
    "not-an-address", "",
  ];
  const isPublic = ["104.16.0.35", "8.8.8.8", "1.1.1.1", "172.15.255.255", "172.32.0.1", "100.63.255.255", "2606:4700::6810:1023", "2a03:2880:f12f:83:face:b00c::25de"];

  it.each(notPublic)("refuses %s", (address) => expect(isPublicAddress(address)).toBe(false));
  it.each(isPublic)("allows %s", (address) => expect(isPublicAddress(address)).toBe(true));

  it("refuses a name whose answers include any private address, and orders IPv4 first", () => {
    expect(checkAddresses(["104.16.0.35", "10.0.0.5"])).toEqual({ ok: false, code: "address_not_public" });
    expect(checkAddresses(["2606:4700::6810:1023", "::ffff:192.168.1.1"])).toEqual({ ok: false, code: "address_not_public" });
    expect(checkAddresses([])).toEqual({ ok: false, code: "resolve_failed" });
    expect(checkAddresses(Array.from({ length: 65 }, (_, i) => `104.16.0.${i + 1}`))).toEqual({ ok: false, code: "resolve_failed" });
    expect(checkAddresses(["2606:4700::6810:1023", "104.16.0.35"])).toEqual({ ok: true, addresses: ["104.16.0.35", "2606:4700::6810:1023"] });
  });

  it("finds its own address in the run's subnet only, and none when it's ambiguous or the subnet is bad", () => {
    const ifs = (addresses: string[]) => ({ eth0: addresses.map((address) => ({ address, family: "IPv4", internal: false, netmask: "", mac: "", cidr: null })) }) as never;
    expect(addressIn("172.18.0.0/16", ifs(["172.18.0.3", "172.17.0.2"]))).toBe("172.18.0.3");
    expect(addressIn("172.18.0.0/16", ifs(["172.17.0.2"]))).toBeNull();
    expect(addressIn("172.18.0.0/16", ifs(["172.18.0.3", "172.18.0.4"]))).toBeNull();
    for (const bad of ["", "172.18.0.0", "172.18.0.0/33", "0.0.0.0/0", "300.1.1.1/16", "::/0"]) expect(addressIn(bad, ifs(["172.18.0.3"]))).toBeNull();
  });
});

/** An upstream on loopback that answers each connection with a fixed greeting, then echoes. */
async function upstream(): Promise<{ port: number; got: string[] }> {
  const got: string[] = [];
  const server = createServer((s) => {
    s.write("hello-from-upstream\n");
    s.on("data", (d) => got.push(d.toString()));
    s.pipe(s);
  });
  servers.push(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return { port: (server.address() as AddressInfo).port, got };
}

/** The proxy on loopback, with a stand-in resolver and a dialer that sends every checked address to `to`. */
async function proxy(opts: { hosts: string[]; answers: Record<string, string[]>; to: number; limits?: Record<string, number> }) {
  const events: ProxyEvent[] = [];
  const dialed: string[] = [];
  const server = createEgressProxy({
    hosts: opts.hosts,
    resolve: async (host) => {
      if (!(host in opts.answers)) throw new Error("ENOTFOUND");
      return opts.answers[host];
    },
    dial: (address) => (dialed.push(address), connect({ host: "127.0.0.1", port: opts.to })),
    log: (e) => events.push(e),
    limits: opts.limits,
  });
  servers.push(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return { port: (server.address() as AddressInfo).port, events, dialed, server };
}

/** Waits until the server holds exactly `n` connections, at most 3 seconds. */
async function waitConnections(server: Server, n: number) {
  for (let i = 0; i < 150; i++) {
    const count = await new Promise<number>((r) => server.getConnections((_e, c) => r(c)));
    if (count === n) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`connections never reached ${n}`);
}

/** Sends `head`, and reads what comes back until the proxy closes or `until` matches. */
function ask(port: number, head: string, then?: (s: Socket) => void, until?: RegExp): Promise<string> {
  return new Promise((resolve) => {
    const s = connect({ host: "127.0.0.1", port });
    let text = "";
    // Never longer than this: what arrived is the answer, and a hang reads as a mismatch, not a timeout.
    setTimeout(() => (s.destroy(), resolve(text)), 4_000).unref();
    s.on("data", (d) => {
      text += d.toString();
      if (text.includes("\r\n\r\n") && then) {
        const t = then;
        then = undefined;
        t(s);
      }
      if (until && until.test(text)) s.destroy(), resolve(text);
    });
    s.on("close", () => resolve(text));
    s.on("error", () => resolve(text));
    s.write(head);
  });
}

describe("the proxy, end to end on loopback", () => {
  it("tunnels to a listed host, at the address it checked, and logs only the host", async () => {
    const up = await upstream();
    const p = await proxy({ hosts: ["registry.npmjs.org"], answers: { "registry.npmjs.org": ["104.16.0.35"] }, to: up.port });
    const text = await ask(p.port, "CONNECT registry.npmjs.org:443 HTTP/1.1\r\nHost: registry.npmjs.org:443\r\n\r\n", (s) => s.write("tls-bytes"), /tls-bytes/);
    expect(text).toMatch(/^HTTP\/1\.1 200 Connection Established\r\n\r\n/);
    expect(text).toContain("hello-from-upstream");
    expect(text).toContain("tls-bytes");
    expect(p.dialed).toEqual(["104.16.0.35"]);
    expect(p.events).toEqual([{ e: "allowed", host: "registry.npmjs.org" }]);
  });

  it("carries bytes the client sent right after the head", async () => {
    const up = await upstream();
    const p = await proxy({ hosts: ["registry.npmjs.org"], answers: { "registry.npmjs.org": ["104.16.0.35"] }, to: up.port });
    const text = await ask(p.port, "CONNECT registry.npmjs.org:443 HTTP/1.1\r\n\r\nearly-bytes", undefined, /early-bytes/);
    expect(text).toContain("early-bytes");
  });

  const cases: [string, string, Record<string, string[]>, RegExp, ProxyEvent][] = [
    ["an unlisted host", "CONNECT example.com:443 HTTP/1.1\r\n\r\n", { "example.com": ["93.184.215.14"] }, /^HTTP\/1\.1 403 /, { e: "refused", code: "host_not_listed", host: "example.com" }],
    ["a subdomain of a listed host", "CONNECT evil.registry.npmjs.org:443 HTTP/1.1\r\n\r\n", {}, /^HTTP\/1\.1 403 /, { e: "refused", code: "host_not_listed", host: "evil.registry.npmjs.org" }],
    ["plain HTTP to a listed host", "GET http://registry.npmjs.org/ HTTP/1.1\r\nHost: registry.npmjs.org\r\n\r\n", {}, /^HTTP\/1\.1 405 /, { e: "refused", code: "method_not_allowed" }],
    ["a listed host on port 80", "CONNECT registry.npmjs.org:80 HTTP/1.1\r\n\r\n", {}, /^HTTP\/1\.1 403 /, { e: "refused", code: "port_not_allowed", host: "registry.npmjs.org" }],
    ["an IP literal", "CONNECT 104.16.0.35:443 HTTP/1.1\r\n\r\n", {}, /^HTTP\/1\.1 403 /, { e: "refused", code: "ip_literal" }],
    ["a listed host that resolves to loopback", "CONNECT registry.npmjs.org:443 HTTP/1.1\r\n\r\n", { "registry.npmjs.org": ["127.0.0.1"] }, /^HTTP\/1\.1 403 /, { e: "refused", code: "address_not_public", host: "registry.npmjs.org" }],
    ["a listed host that resolves to the LAN", "CONNECT registry.npmjs.org:443 HTTP/1.1\r\n\r\n", { "registry.npmjs.org": ["192.168.1.10"] }, /^HTTP\/1\.1 403 /, { e: "refused", code: "address_not_public", host: "registry.npmjs.org" }],
    ["a listed host that resolves to cloud metadata", "CONNECT registry.npmjs.org:443 HTTP/1.1\r\n\r\n", { "registry.npmjs.org": ["169.254.169.254"] }, /^HTTP\/1\.1 403 /, { e: "refused", code: "address_not_public", host: "registry.npmjs.org" }],
    ["a listed host whose answers mix public and private", "CONNECT registry.npmjs.org:443 HTTP/1.1\r\n\r\n", { "registry.npmjs.org": ["104.16.0.35", "10.1.2.3"] }, /^HTTP\/1\.1 403 /, { e: "refused", code: "address_not_public", host: "registry.npmjs.org" }],
    ["a listed host that doesn't resolve", "CONNECT registry.npmjs.org:443 HTTP/1.1\r\n\r\n", {}, /^HTTP\/1\.1 502 /, { e: "refused", code: "resolve_failed", host: "registry.npmjs.org" }],
  ];
  it.each(cases)("refuses %s, connecting nowhere", async (_what, head, answers, status, event) => {
    const up = await upstream();
    const p = await proxy({ hosts: ["registry.npmjs.org"], answers, to: up.port });
    const text = await ask(p.port, head);
    expect(text).toMatch(status);
    expect(text).not.toContain("hello-from-upstream");
    expect(p.dialed).toEqual([]);
    expect(p.events).toEqual([event]);
    // The log never carries a path, URL or address.
    expect(JSON.stringify(p.events)).not.toMatch(/http:|\/|\d+\.\d+\.\d+\.\d+/);
  });

  it("refuses a head that is too large, and more tunnels than its limit", async () => {
    const up = await upstream();
    const p = await proxy({ hosts: ["registry.npmjs.org"], answers: { "registry.npmjs.org": ["104.16.0.35"] }, to: up.port, limits: { tunnels: 1 } });
    expect(await ask(p.port, `CONNECT registry.npmjs.org:443 HTTP/1.1\r\nX: ${"a".repeat(9000)}`)).toMatch(/^HTTP\/1\.1 431 /);
    // The refused connection is gone on the proxy's side before the next is counted.
    await waitConnections(p.server, 0);
    const held = connect({ host: "127.0.0.1", port: p.port });
    await once(held, "connect");
    await waitConnections(p.server, 1);
    expect(await ask(p.port, "CONNECT registry.npmjs.org:443 HTTP/1.1\r\n\r\n")).toMatch(/^HTTP\/1\.1 503 /);
    held.destroy();
    expect(p.events.map((e) => e.e === "refused" && e.code)).toEqual(["head_too_large", "too_many_tunnels"]);
  });

  it("refuses to start over anything but host names", () => {
    for (const hosts of [[], ["*"], ["127.0.0.1"], ["Registry.npmjs.org"], ["registry.npmjs.org:443"]]) expect(() => createEgressProxy({ hosts })).toThrow("egress_hosts_invalid");
  });
});

describe("the task container's network and environment", () => {
  it("adds the proxy's fixed environment only when the room lists hosts, and says so in the frame", async () => {
    const root = await temp();
    const none = containerSpec("run-1", facts(root));
    expect(none.network).toEqual({ kind: "none" });
    expect(none.env).toEqual({ ...CONTAINER_ENV });
    const listed = containerSpec("run-1", facts(root, ["registry.npmjs.org"]));
    expect(listed.network).toEqual({ kind: "allowlist", hosts: ["registry.npmjs.org"] });
    expect(listed.env).toEqual({ ...CONTAINER_ENV, ...EGRESS_ENV });
    expect(EGRESS_ENV).toEqual({
      HTTPS_PROXY: "http://egress:3128",
      https_proxy: "http://egress:3128",
      HTTP_PROXY: "http://egress:3128",
      http_proxy: "http://egress:3128",
      NO_PROXY: "localhost,127.0.0.1,::1",
      no_proxy: "localhost,127.0.0.1,::1",
    });
    expect(checkContainerSpec(listed)).toBeNull();
    // The proxy's environment without an allowlist, or an allowlist without it, isn't the fixed one.
    expect(checkContainerSpec({ ...none, env: listed.env })).toBe("env_not_allowed");
    expect(checkContainerSpec({ ...listed, env: none.env })).toBe("env_not_allowed");
    expect(checkContainerSpec({ ...listed, env: { ...listed.env, HTTPS_PROXY: "http://evil:1" } })).toBe("env_not_allowed");
    expect(checkContainerSpec({ ...listed, network: { kind: "allowlist", hosts: [] } })).toBe("spec_invalid");
    const frame = runFrame({ tools: ["read", "shell"], shell: true, network: ["registry.npmjs.org"] });
    expect(frame).toContain("Network: only HTTPS, on port 443, to exactly these hosts: registry.npmjs.org.");
  });

  it("joins only the run's internal network, with a resolver that answers nothing outside it; never host or bridge", async () => {
    const spec = containerSpec("Run-1", facts(await temp(), ["registry.npmjs.org"]));
    const args = runArgs(spec, { image: IMAGE, uid: 501, gid: 20, home_label: "h" });
    const flag = (name: string) => args.filter((_, i) => args[i - 1] === name);
    expect(flag("--network")).toEqual(["podster-egress-net-run-1"]);
    // An upstream resolver that is never routed and isn't loopback (TEST-NET-1).
    expect(flag("--dns")).toEqual(["192.0.2.1"]);
    expect(flag("--env").sort()).toEqual([
      "HOME=/work/.cache/home", "HTTPS_PROXY=http://egress:3128", "HTTP_PROXY=http://egress:3128", "LANG=C.UTF-8", "NO_PROXY=localhost,127.0.0.1,::1", "PATH=/usr/local/bin:/usr/bin:/bin", "WRANGLER_SEND_METRICS=false",
      "http_proxy=http://egress:3128", "https_proxy=http://egress:3128", "no_proxy=localhost,127.0.0.1,::1",
    ]);
    expect(args.join(" ")).not.toMatch(/--network (host|bridge|none)|--cap-add|--privileged/);
  });
});

describe("the proxy's container", () => {
  const base = { ref: "run-1", image: PROXY_IMAGE, uid: 501, gid: 20, home_label: "h", max_seconds: 660, program: "export function main() {}", subnet: "172.18.0.0/16", hosts: ["registry.npmjs.org"] };

  it("is hardened, pinned, on the internal network as `egress`, with no mount or environment, running Runner's program over the hosts", () => {
    const args = proxyRunArgs(base);
    const flag = (name: string) => args.filter((_, i) => args[i - 1] === name);
    expect(flag("--pull")).toEqual(["never"]);
    expect(flag("--user")).toEqual(["501:20"]);
    expect(flag("--cap-drop")).toEqual(["ALL"]);
    expect(flag("--security-opt")).toEqual(["no-new-privileges"]);
    expect(args).toContain("--read-only");
    expect(flag("--network")).toEqual(["podster-egress-net-run-1"]);
    expect(flag("--network-alias")).toEqual(["egress"]);
    expect(flag("--label")).toEqual([`${LABEL_RUN}=run-1`, `${LABEL_HOME}=h`, `${LABEL_ROLE}=egress`]);
    expect(flag("--env")).toEqual([]);
    expect(args.join(" ")).not.toMatch(/--mount|--volume|-v |docker\.sock|--publish|-p |--cap-add|--privileged|--network host/);
    // Its log is bounded on the host's disk.
    expect(flag("--log-driver")).toEqual(["json-file"]);
    expect(flag("--log-opt")).toEqual(["max-size=1m", "max-file=2"]);
    expect(args.slice(args.indexOf(PROXY_IMAGE))).toEqual([PROXY_IMAGE, "timeout", "660", "node", "--input-type=module", "-e", base.program, "172.18.0.0/16", "registry.npmjs.org"]);
  });

  it("refuses anything but host names and one IPv4 subnet as arguments", () => {
    expect(() => proxyRunArgs({ ...base, hosts: ["--inspect=0.0.0.0"] })).toThrow("egress_hosts_invalid");
    expect(() => proxyRunArgs({ ...base, hosts: [] })).toThrow("egress_hosts_invalid");
    expect(() => proxyRunArgs({ ...base, subnet: "172.18.0.0/16 --x" })).toThrow("egress_subnet_invalid");
    expect(subnetOf("172.18.0.0/16 fd00::/64 ")).toBe("172.18.0.0/16");
    expect(subnetOf("172.18.0.0/16 172.19.0.0/16")).toBeNull();
    expect(subnetOf("")).toBeNull();
  });

  it("loads Runner's built program and appends only the call that starts it", async () => {
    const file = join(await temp(), "egress-proxy.js");
    await writeFile(file, "export function main(argv) {}\n");
    expect(await loadProxyProgram(file)).toBe("export function main(argv) {}\n\nmain(process.argv.slice(1));\n");
    await writeFile(file, "console.log(1)\n");
    await expect(loadProxyProgram(file)).rejects.toThrow("egress_program_invalid");
  });

  it("logs back only the proxy's own shapes, counted, with valid hosts and fixed codes", () => {
    const lines = [
      '{"e":"ready"}',
      '{"e":"allowed","host":"registry.npmjs.org"}',
      '{"e":"allowed","host":"registry.npmjs.org"}',
      '{"e":"refused","code":"host_not_listed","host":"example.com"}',
      '{"e":"refused","code":"method_not_allowed"}',
      '{"e":"refused","code":"host_not_listed","host":"https://x/y"}',
      '{"e":"refused","code":"made_up","host":"example.com"}',
      '{"e":"allowed","host":"registry.npmjs.org","path":"/secret"}',
      "not json",
      '["allowed"]',
    ].join("\n");
    expect(tallyProxyLog(lines)).toEqual([
      { outcome: "host_allowed", host: "registry.npmjs.org", code: null, count: 2 },
      { outcome: "host_refused", host: "example.com", code: "host_not_listed", count: 1 },
      { outcome: "host_refused", host: null, code: "method_not_allowed", count: 1 },
    ]);
  });

  it("lets Runner's log carry a host name and a run's ID, never a URL, path or address", () => {
    expect(JSON.parse(logLine("adapter.egress", "host_allowed", { run: "run-1", host: "registry.npmjs.org", count: 2 }))).toEqual({ at: "adapter.egress", outcome: "host_allowed", run: "run-1", host: "registry.npmjs.org", count: 2 });
    for (const host of ["https://registry.npmjs.org", "registry.npmjs.org/-/x", "10.0.0.1", "Registry.npmjs.org", "a b"]) expect(JSON.parse(logLine("adapter.egress", "host_refused", { host }))).toEqual({ at: "adapter.egress", outcome: "host_refused" });
  });
});

/** A fake docker for the sandbox's egress steps: containers and networks by name and labels, as Docker 28 behaves. */
function fakeDocker(opts: { fail?: string; logs?: string; version?: string; taskRmFails?: boolean } = {}) {
  type C = { id: string; name: string; labels: string[]; networks: Set<string> };
  const containers: C[] = [];
  const networks = new Map<string, string[]>();
  const calls: string[][] = [];
  let seq = 0;
  const ok = (stdout = "", code = 0) => ({ code, stdout, stderr: "", cut: false });
  const labelsOf = (args: string[]) => args.filter((_, i) => args[i - 1] === "--label");
  const match = (labels: string[], name: string, filters: string[]) => filters.every((f) => (f.startsWith("label=") ? labels.includes(f.slice(6)) : new RegExp(f.slice(5)).test(`/${name}`)));
  const docker: DockerCli = async (args) => {
    calls.push(args);
    const step = `${args[0]} ${args[1] ?? ""}`;
    if (opts.fail && step.startsWith(opts.fail)) return ok("", 1);
    if (args[0] === "version") return ok(`${opts.version ?? "28.5.1"}\n`);
    const filters = args.filter((_, i) => args[i - 1] === "--filter");
    if (args[0] === "run") {
      const net = args[args.indexOf("--network") + 1];
      containers.push({ id: (++seq).toString(16).padStart(64, "0"), name: args[args.indexOf("--name") + 1], labels: labelsOf(args), networks: new Set([net]) });
      return ok();
    }
    if (args[0] === "exec") return ok(args.join(" ").includes("/proc/1/task/1/children") ? "7\n" : "");
    if (args[0] === "logs") return ok(opts.logs ?? '{"e":"ready"}\n');
    if (args[0] === "ps") return ok(containers.filter((c) => match(c.labels, c.name, filters)).map((c) => c.id).join("\n"));
    if (args[0] === "rm" && opts.taskRmFails && args.slice(2).some((id) => containers.find((c) => c.id === id)?.name.startsWith("podster-run-"))) return ok("", 125);
    if (args[0] === "rm") {
      for (const id of args.slice(2)) containers.splice(containers.findIndex((c) => c.id === id), 1);
      return ok();
    }
    if (step === "network create") return networks.set(args.at(-1) as string, labelsOf(args)), ok();
    if (step === "network inspect" && args.includes("{{range .Containers}}{{.Name}} {{end}}")) return ok(containers.filter((c) => c.networks.has(args.at(-1) as string)).map((c) => c.name).join(" "));
    if (step === "network inspect") return ok("172.18.0.0/16 ");
    if (step === "network disconnect") return containers.find((c) => c.name === args.at(-1))?.networks.delete(args.at(-2) as string), ok();
    if (step === "network connect") return containers.find((c) => c.name === args.at(-1))?.networks.add(args.at(-2) as string), ok();
    if (step === "network ls") return ok([...networks].filter(([n, l]) => match(l, n, filters)).map(([n]) => n).join("\n"));
    if (step === "network rm") {
      const name = args.at(-1) as string;
      if (containers.some((c) => c.networks.has(name))) return ok("", 1);
      networks.delete(name);
      return ok();
    }
    return ok();
  };
  return { docker, calls, containers, networks };
}

describe("the sandbox with a room that lists hosts", () => {
  const sandboxOf = (d: ReturnType<typeof fakeDocker>, log: Parameters<typeof logLine>[] = []) =>
    new DockerSandbox({ docker: d.docker, image: IMAGE, uid: 501, gid: 20, home: "/h", every: () => () => undefined, wait: async () => undefined, proxy: { image: PROXY_IMAGE, program: async () => "export function main() {}\nmain(process.argv.slice(1));\n" }, log: (at, outcome, fields) => void log.push([at, outcome, fields]) });

  it("opens the internal and outbound networks, then the proxy listening on the internal one, then its route out, then the task's container on the internal network only", async () => {
    const d = fakeDocker();
    const sandbox = sandboxOf(d);
    await sandbox.open(containerSpec("run-1", facts(await temp(), ["registry.npmjs.org"])), new AbortController().signal);
    const names = egressNames("run-1");
    const steps = d.calls.map((c) => (c[0] === "network" ? `network ${c[1]}` : c[0]));
    expect(steps.slice(0, 8)).toEqual(["version", "network create", "network create", "network inspect", "run", "logs", "network connect", "run"]);
    const labelled = ["--label", `${LABEL_RUN}=run-1`, "--label", `${LABEL_HOME}=${homeLabel("/h")}`, "--label", `${LABEL_ROLE}=egress-network`];
    // The internal network has no address on the host, so no gateway to reach the machine through.
    expect(d.calls[1]).toEqual(["network", "create", "--internal", "--opt", "com.docker.network.bridge.inhibit_ipv4=true", ...labelled, names.network]);
    expect(d.calls[2]).toEqual(["network", "create", ...labelled, names.out]);
    expect(d.calls[3]).toEqual(["network", "inspect", "--format", "{{range .IPAM.Config}}{{.Subnet}} {{end}}", names.network]);
    expect(d.calls[4]).toContain(names.proxy);
    expect(d.calls[6]).toEqual(["network", "connect", names.out, names.proxy]);
    // Never Docker's default bridge or the host's network.
    expect(d.calls.flat().filter((a) => a === "bridge" || a === "host")).toEqual([]);
    const task = d.containers.find((c) => c.name === "podster-run-run-1");
    expect([...(task?.networks ?? [])]).toEqual([names.network]);
    expect([...(d.containers.find((c) => c.name === names.proxy)?.networks ?? [])]).toEqual([names.network, names.out]);
  });

  it("removes the task's container, then logs the proxy's decisions and removes it, then the network; gone means all three", async () => {
    const d = fakeDocker({ logs: '{"e":"ready"}\n{"e":"allowed","host":"registry.npmjs.org"}\n{"e":"refused","code":"host_not_listed","host":"example.com"}\n' });
    const logged: Parameters<typeof logLine>[] = [];
    const sandbox = sandboxOf(d, logged);
    await sandbox.open(containerSpec("run-1", facts(await temp(), ["registry.npmjs.org"])), new AbortController().signal);
    expect(await sandbox.gone("run-1")).toBe(false);
    await sandbox.kill("run-1");
    expect(d.containers).toEqual([]);
    expect(d.networks.size).toBe(0);
    expect(await sandbox.gone("run-1")).toBe(true);
    expect(logged).toEqual([
      ["adapter.egress", "host_allowed", { run: "run-1", count: 1, host: "registry.npmjs.org" }],
      ["adapter.egress", "host_refused", { run: "run-1", count: 1, host: "example.com", code: "host_not_listed" }],
    ]);
  });

  it.each(["network create", "network inspect", "run", "network connect"])("cleans up what it made when `%s` fails, and opens no task container", async (fail) => {
    const d = fakeDocker({ fail });
    const sandbox = sandboxOf(d);
    await expect(sandbox.open(containerSpec("run-1", facts(await temp(), ["registry.npmjs.org"])), new AbortController().signal)).rejects.toThrow(/^docker_egress_[a-z_]+_1$/);
    expect(d.containers).toEqual([]);
    expect(d.networks.size).toBe(0);
    expect(d.calls.some((c) => c[0] === "run" && c.includes("podster-run-run-1"))).toBe(false);
  });

  it("refuses every allowlist run on a Docker Engine older than 26, before making anything, and checks once per process", async () => {
    for (const version of ["25.0.5", "20.10.24"]) {
      const d = fakeDocker({ version });
      await expect(sandboxOf(d).open(containerSpec("run-1", facts(await temp(), ["registry.npmjs.org"])), new AbortController().signal)).rejects.toThrow(/^docker_engine_too_old$/);
      expect(d.calls).toEqual([["version", "--format", "{{.Server.Version}}"]]);
    }
    const bad = fakeDocker({ version: "dev" });
    await expect(sandboxOf(bad).open(containerSpec("run-1", facts(await temp(), ["registry.npmjs.org"])), new AbortController().signal)).rejects.toThrow(/^docker_version_0$/);
    const d = fakeDocker({ version: "26.0.0" });
    const sandbox = sandboxOf(d);
    for (const ref of ["run-1", "run-2"]) await sandbox.open(containerSpec(ref, facts(await temp(), ["registry.npmjs.org"])), new AbortController().signal);
    expect(d.calls.filter((c) => c[0] === "version")).toHaveLength(1);
    // A room with no hosts never asks.
    const none = fakeDocker({ version: "20.10.0" });
    await sandboxOf(none).open(containerSpec("run-3", facts(await temp())), new AbortController().signal);
    expect(none.calls.some((c) => c[0] === "version")).toBe(false);
  });

  it("removes the proxy and both networks even when the task container's removal fails, then reports that failure", async () => {
    const d = fakeDocker({ taskRmFails: true });
    const sandbox = sandboxOf(d);
    await sandbox.open(containerSpec("run-1", facts(await temp(), ["registry.npmjs.org"])), new AbortController().signal);
    await expect(sandbox.kill("run-1")).rejects.toThrow(/^docker_rm_125$/);
    expect(d.containers.map((c) => c.name)).toEqual(["podster-run-run-1"]);
    // Both networks went too: removing one with the task still attached disconnects it first.
    expect(d.networks.size).toBe(0);
    expect(await sandbox.gone("run-1")).toBe(false);
  });

  it("gives up with egress_proxy_not_ready when the proxy never says it's listening, and cleans up", async () => {
    const d = fakeDocker({ logs: "" });
    await expect(sandboxOf(d).open(containerSpec("run-1", facts(await temp(), ["registry.npmjs.org"])), new AbortController().signal)).rejects.toThrow("egress_proxy_not_ready");
    expect(d.containers).toEqual([]);
    expect(d.networks.size).toBe(0);
  });

  it("reaps a previous process's egress networks of this home at startup, with its containers", async () => {
    const d = fakeDocker();
    const sandbox = sandboxOf(d);
    for (const ref of ["run-2", "run-3"]) await sandbox.open(containerSpec(ref, facts(await temp(), ["registry.npmjs.org"])), new AbortController().signal);
    // Another home's network and Claude Code's own network stay.
    d.networks.set("podster-net-run-2", [`${LABEL_RUN}=run-2`, `${LABEL_HOME}=${homeLabel("/h")}`, `${LABEL_ROLE}=network`]);
    d.networks.set("other-home", [`${LABEL_HOME}=other`, `${LABEL_ROLE}=egress-network`]);
    expect(await sandbox.reapAll()).toBe(4);
    expect([...d.networks.keys()].sort()).toEqual(["other-home", "podster-net-run-2"]);
  });
});
