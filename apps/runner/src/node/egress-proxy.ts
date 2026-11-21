/**
 * Runner's egress proxy (the owner's approval of 2026-11-20): the one way out of a task's container when its room's run
 * policy lists hosts in `rooms[].network`. It runs in its own container per run (`egress-network.ts`), on the run's
 * internal Docker network, whose only other peer is the task's container, and on a second network of the run's own, with
 * a route out, that nothing else joins. This file is the whole program: Runner hands its built text to `node` in the proxy's image as an argument,
 * so the code that decides is exactly the code these tests run, and the image holds only Node, no program and no secret.
 * It imports nothing but Node's own modules, so it runs alone.
 *
 * What it allows, and nothing else:
 * - **HTTPS `CONNECT` only**, to port **443** only: `CONNECT host:443 HTTP/1.1`. Any other method, plain HTTP among
 *   them (an absolute-form `GET http://…`), and any other port is refused. The tunnel carries TLS end to end: the proxy
 *   never sees inside it and holds no certificate.
 * - **Exact host names** from the room's list, compared in lower case. No wildcard, no suffix match, no IP literal
 *   (IPv4, IPv6 or bracketed), no trailing dot.
 * - **Public addresses only.** The proxy resolves the name itself and refuses it if ANY address it resolves to is
 *   private, loopback, link-local (cloud metadata among them), shared, multicast, reserved, documentation, or an IPv6
 *   form that embeds or translates IPv4 (mapped, NAT64, 6to4, Teredo). It then connects to an address it checked, never
 *   to the name again, so a second answer can't swap in a LAN address (DNS rebinding).
 * - **Bounded:** a request head of at most `PROXY_LIMITS.head_bytes`, read within `head_ms`; a connect within
 *   `connect_ms`; a tunnel idle for `idle_ms` is closed; at most `tunnels` at once. Its container's own lifetime is the
 *   run's.
 * - **Bound to the internal network only:** it listens on its own address in the subnet Runner names, which it has
 *   from its start, before Runner attaches its route out. So nothing on that other network can reach it.
 *
 * Its log is one JSON line per decision on standard output: `ready`, `allowed` with the host, or `refused` with a fixed
 * code and the host only when the host is a valid name. Never a path, URL, header, body or address. Runner reads these
 * lines back by the run's ID when it removes the proxy, and checks each again before logging it.
 */
import { BlockList, connect as netConnect, createServer, isIP, type Server, type Socket } from "node:net";
import { lookup } from "node:dns/promises";
import { networkInterfaces } from "node:os";

/** The proxy's port, inside the run's internal network. */
export const PROXY_PORT = 3128;
/** **Proposed** figures. */
export const PROXY_LIMITS = Object.freeze({ head_bytes: 8 * 1024, head_ms: 10_000, connect_ms: 10_000, resolve_ms: 10_000, idle_ms: 120_000, tunnels: 64, addresses: 64, hosts: 50 });

/** Why the proxy refused a connection: a fixed code, logged as it is. */
export type ProxyRefusal =
  | "method_not_allowed"
  | "request_invalid"
  | "port_not_allowed"
  | "ip_literal"
  | "host_invalid"
  | "host_not_listed"
  | "address_not_public"
  | "resolve_failed"
  | "connect_failed"
  | "too_many_tunnels"
  | "head_too_large"
  | "head_timeout";
export const PROXY_REFUSALS: readonly ProxyRefusal[] = Object.freeze(["method_not_allowed", "request_invalid", "port_not_allowed", "ip_literal", "host_invalid", "host_not_listed", "address_not_public", "resolve_failed", "connect_failed", "too_many_tunnels", "head_too_large", "head_timeout"]);

const STATUS: Record<ProxyRefusal, string> = {
  method_not_allowed: "405 Method Not Allowed",
  request_invalid: "400 Bad Request",
  port_not_allowed: "403 Forbidden",
  ip_literal: "403 Forbidden",
  host_invalid: "403 Forbidden",
  host_not_listed: "403 Forbidden",
  address_not_public: "403 Forbidden",
  resolve_failed: "502 Bad Gateway",
  connect_failed: "502 Bad Gateway",
  too_many_tunnels: "503 Service Unavailable",
  head_too_large: "431 Request Header Fields Too Large",
  head_timeout: "408 Request Timeout",
};

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const TLD = /^[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
/** A lower-case DNS host name with at least two labels: the same shape the run policy accepts. */
export function isHostName(v: unknown): v is string {
  if (typeof v !== "string" || v.length > 253) return false;
  const labels = v.split(".");
  return labels.length >= 2 && labels.every((l) => LABEL.test(l)) && TLD.test(labels[labels.length - 1]);
}

export type Target = { ok: true; host: string } | { ok: false; code: ProxyRefusal; host: string | null };

/**
 * The request head's target, or why it's refused. Only `CONNECT host:443 HTTP/1.1` (or `HTTP/1.0`) passes; the host
 * is lower-cased and must be a host name, never an IP literal. Headers after the request line are ignored.
 */
export function parseConnect(head: string): Target {
  const line = head.split("\r\n", 1)[0];
  const parts = line.split(" ");
  if (parts.length !== 3 || !/^HTTP\/1\.[01]$/.test(parts[2])) return { ok: false, code: "request_invalid", host: null };
  if (parts[0] !== "CONNECT") return { ok: false, code: "method_not_allowed", host: null };
  const target = parts[1];
  if (target.startsWith("[")) return { ok: false, code: "ip_literal", host: null };
  const colon = target.lastIndexOf(":");
  if (colon <= 0) return { ok: false, code: "request_invalid", host: null };
  const host = target.slice(0, colon).toLowerCase();
  const port = target.slice(colon + 1);
  if (isIP(host) !== 0 || host.includes(":")) return { ok: false, code: "ip_literal", host: null };
  const named = isHostName(host) ? host : null;
  if (!/^\d{1,5}$/.test(port)) return { ok: false, code: "request_invalid", host: named };
  if (port !== "443") return { ok: false, code: "port_not_allowed", host: named };
  if (!named) return { ok: false, code: "host_invalid", host: null };
  return { ok: true, host: named };
}

/** Whether the room's list names this host exactly. */
export const isListed = (host: string, hosts: readonly string[]) => hosts.includes(host);

const NOT_PUBLIC_V4: readonly [string, number][] = [
  ["0.0.0.0", 8], // this network
  ["10.0.0.0", 8], // private
  ["100.64.0.0", 10], // shared address space (carrier-grade NAT; some clouds' metadata)
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local, cloud metadata (169.254.169.254)
  ["172.16.0.0", 12], // private
  ["192.0.0.0", 24], // IETF protocol assignments
  ["192.0.2.0", 24], // documentation
  ["192.88.99.0", 24], // 6to4 relay anycast
  ["192.168.0.0", 16], // private
  ["198.18.0.0", 15], // benchmarking
  ["198.51.100.0", 24], // documentation
  ["203.0.113.0", 24], // documentation
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved, and the broadcast address
];
/** IPv6 is allowed only in global unicast, 2000::/3, and not in these parts of it. */
const NOT_PUBLIC_V6: readonly [string, number][] = [
  ["2001::", 23], // IETF protocol assignments, Teredo (2001::/32) and ORCHID among them
  ["2001:db8::", 32], // documentation
  ["2002::", 16], // 6to4, which embeds an IPv4 address
  ["3fff::", 20], // documentation
];
const v4Blocked = new BlockList();
for (const [net, prefix] of NOT_PUBLIC_V4) v4Blocked.addSubnet(net, prefix, "ipv4");
const v6Global = new BlockList();
v6Global.addSubnet("2000::", 3, "ipv6");
const v6Blocked = new BlockList();
for (const [net, prefix] of NOT_PUBLIC_V6) v6Blocked.addSubnet(net, prefix, "ipv6");

/**
 * Whether an address is one the proxy may connect to: public IPv4 outside every range in `NOT_PUBLIC_V4`, or IPv6 in
 * global unicast outside `NOT_PUBLIC_V6`. Loopback, private, link-local, unique-local, multicast, IPv4-mapped (::ffff:),
 * NAT64 (64:ff9b::) and anything that isn't an address are refused.
 */
export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !v4Blocked.check(address, "ipv4");
  if (family === 6) return v6Global.check(address, "ipv6") && !v6Blocked.check(address, "ipv6");
  return false;
}

/**
 * The addresses to try for a host, IPv4 first, or why none may be used. Refused if the name resolves to nothing, to too
 * many, or to ANY address that isn't public: a name that points even partly at the LAN or the machine is refused whole.
 */
export function checkAddresses(addresses: readonly string[]): { ok: true; addresses: string[] } | { ok: false; code: ProxyRefusal } {
  if (addresses.length === 0 || addresses.length > PROXY_LIMITS.addresses) return { ok: false, code: "resolve_failed" };
  if (!addresses.every(isPublicAddress)) return { ok: false, code: "address_not_public" };
  return { ok: true, addresses: [...addresses].sort((a, b) => isIP(a) - isIP(b)) };
}

/** The proxy's own address in an IPv4 subnet `a.b.c.d/n`, from its interfaces; null if none or more than one. */
export function addressIn(subnet: string, interfaces: ReturnType<typeof networkInterfaces>): string | null {
  const m = subnet.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/);
  if (!m) return null;
  const prefix = Number(m[5]);
  if (prefix < 8 || prefix > 30 || m.slice(1, 5).some((o) => Number(o) > 255)) return null;
  const net = new BlockList();
  net.addSubnet(m.slice(1, 5).join("."), prefix, "ipv4");
  const found = Object.values(interfaces)
    .flatMap((list) => list ?? [])
    .filter((i) => i.family === "IPv4" && !i.internal && net.check(i.address, "ipv4"))
    .map((i) => i.address);
  return found.length === 1 ? found[0] : null;
}

export type ProxyEvent = { e: "ready" } | { e: "allowed"; host: string } | { e: "refused"; code: ProxyRefusal; host?: string };

export type ProxyDeps = {
  hosts: readonly string[];
  /** Every address a name resolves to. */
  resolve?: (host: string) => Promise<string[]>;
  /** Opens a TCP connection to a checked address. */
  dial?: (address: string, port: number) => Socket;
  log?: (event: ProxyEvent) => void;
  limits?: Partial<typeof PROXY_LIMITS>;
};

const systemResolve = async (host: string) => (await lookup(host, { all: true, verbatim: true })).map((a) => a.address);
const systemDial = (address: string, port: number) => netConnect({ host: address, port });

/** What `promise` resolves to within `ms`, or null if it rejects or takes longer. */
function within<T>(ms: number, promise: Promise<T>): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    promise.then(
      (v) => (clearTimeout(timer), resolve(v)),
      () => (clearTimeout(timer), resolve(null)),
    );
  });
}

/** The proxy's server, not yet listening. Every name in `hosts` must be a host name, or it throws. */
export function createEgressProxy(deps: ProxyDeps): Server {
  const hosts = [...deps.hosts];
  if (hosts.length === 0 || hosts.length > PROXY_LIMITS.hosts || !hosts.every(isHostName)) throw new Error("egress_hosts_invalid");
  const limits = { ...PROXY_LIMITS, ...deps.limits };
  const resolve = deps.resolve ?? systemResolve;
  const dial = deps.dial ?? systemDial;
  const log = deps.log ?? (() => undefined);
  let open = 0;

  const refuse = (client: Socket, code: ProxyRefusal, host: string | null) => {
    log(host ? { e: "refused", code, host } : { e: "refused", code });
    client.end(`HTTP/1.1 ${STATUS[code]}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`);
    // Whatever else the client sends is read and dropped, so its side ends and the socket closes; a socket never read
    // from would wait unread. It goes after a second even if the client never closes its side.
    client.removeAllListeners("data");
    client.on("data", () => undefined);
    client.resume();
    setTimeout(() => client.destroy(), 1_000).unref();
  };

  async function tunnel(client: Socket, head: string, rest: Buffer) {
    const target = parseConnect(head);
    if (!target.ok) return refuse(client, target.code, target.host);
    if (!isListed(target.host, hosts)) return refuse(client, "host_not_listed", target.host);
    const resolved = await within(limits.resolve_ms, resolve(target.host));
    if (resolved === null) return refuse(client, "resolve_failed", target.host);
    const checked = checkAddresses(resolved);
    if (!checked.ok) return refuse(client, checked.code, target.host);
    if (client.destroyed) return;
    for (const address of checked.addresses) {
      const upstream = await new Promise<Socket | null>((done) => {
        const s = dial(address, 443);
        const timer = setTimeout(() => (s.destroy(), done(null)), limits.connect_ms);
        s.once("connect", () => (clearTimeout(timer), done(s)));
        s.once("error", () => (clearTimeout(timer), s.destroy(), done(null)));
      });
      if (!upstream) continue;
      if (client.destroyed) return void upstream.destroy();
      log({ e: "allowed", host: target.host });
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (rest.length > 0) upstream.write(rest);
      const close = () => (client.destroy(), upstream.destroy());
      for (const s of [client, upstream]) {
        s.setTimeout(limits.idle_ms, close);
        s.on("error", close);
        s.on("close", close);
      }
      client.pipe(upstream);
      upstream.pipe(client);
      client.resume();
      return;
    }
    refuse(client, "connect_failed", target.host);
  }

  return createServer((client) => {
    client.on("error", () => client.destroy());
    if (open >= limits.tunnels) return refuse(client, "too_many_tunnels", null);
    open += 1;
    client.once("close", () => (open -= 1));
    let buffered = Buffer.alloc(0);
    let done = false;
    const timer = setTimeout(() => {
      if (!done) {
        done = true;
        refuse(client, "head_timeout", null);
      }
    }, limits.head_ms);
    const onData = (chunk: Buffer) => {
      if (done) return;
      buffered = Buffer.concat([buffered, chunk]);
      const end = buffered.indexOf("\r\n\r\n");
      if (end < 0 && buffered.length > limits.head_bytes) {
        done = true;
        clearTimeout(timer);
        client.off("data", onData);
        return refuse(client, "head_too_large", null);
      }
      if (end < 0) return;
      done = true;
      clearTimeout(timer);
      client.off("data", onData);
      client.pause();
      if (end > limits.head_bytes) return refuse(client, "head_too_large", null);
      void tunnel(client, buffered.subarray(0, end).toString("latin1"), buffered.subarray(end + 4)).catch(() => client.destroy());
    };
    client.on("data", onData);
  });
}

/**
 * The program's entry, run in the proxy's container as `node --input-type=module -e <this file> <subnet> <host>…`: it
 * listens on its own address in `subnet` only, and logs one JSON line per decision. It exits if it can't.
 */
export function main(argv: readonly string[]): void {
  const [subnet, ...hosts] = argv;
  const write = (event: ProxyEvent) => process.stdout.write(`${JSON.stringify(event)}\n`);
  const address = addressIn(subnet ?? "", networkInterfaces());
  if (!address) {
    process.stderr.write("egress_address_unknown\n");
    process.exit(2);
  }
  const server = createEgressProxy({ hosts, log: write });
  server.on("error", () => process.exit(1));
  server.listen(PROXY_PORT, address, () => write({ e: "ready" }));
}
