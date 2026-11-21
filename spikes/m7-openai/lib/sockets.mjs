// The socket check (S-53): records every outbound connection this process opens, by host and port only, through
// Node's diagnostics channels. `net.client.socket` fires for every client socket (net, tls, http, https, fetch and
// WebSocket all open one), and undici's connect channels name the host fetch asked for. A socket whose endpoint
// can't be learned is recorded as unknown and fails the check. DNS lookups (libuv's resolver) and child processes
// are outside what these channels see.

import dc from "node:diagnostics_channel";
import tls from "node:tls";

export function startSocketRecorder() {
  const sockets = []; // { kind, host, port, tls }
  const fetchConnects = []; // { host, port, protocol }

  const onSocket = ({ socket }) => {
    const rec = { kind: "tcp", host: null, address: null, port: null, tls: socket instanceof tls.TLSSocket };
    sockets.push(rec);
    socket.once("lookup", (_err, address, _family, host) => {
      rec.host ??= host ?? null;
      rec.address ??= typeof address === "string" ? address : null;
    });
    socket.once("connectionAttempt", (ip, port) => {
      rec.address ??= ip;
      rec.port ??= port;
    });
    socket.once("connect", () => {
      rec.address ??= socket.remoteAddress ?? null;
      rec.port ??= socket.remotePort ?? null;
      if (socket.remoteAddress === undefined && socket._pipeName) rec.kind = "unix";
    });
    // Captured right away too, for a socket that fails before it connects.
    queueMicrotask(() => {
      rec.host ??= socket._host ?? null;
      if (socket.servername) rec.host ??= socket.servername;
    });
  };
  const onUndici = ({ connectParams }) => {
    if (!connectParams) return;
    fetchConnects.push({ host: connectParams.hostname, port: Number(connectParams.port) || (connectParams.protocol === "https:" ? 443 : 80), protocol: connectParams.protocol });
  };

  dc.subscribe("net.client.socket", onSocket);
  dc.subscribe("undici:client:beforeConnect", onUndici);
  return {
    sockets,
    fetchConnects,
    stop() {
      dc.unsubscribe("net.client.socket", onSocket);
      dc.unsubscribe("undici:client:beforeConnect", onUndici);
    },
  };
}

/**
 * Check a recording against the allowed endpoints (`[{ host, port }]`). A fetch connection must name an allowed
 * host and port; a raw socket must have a known port, and as many raw sockets as fetch connections may be
 * accounted for by them. Anything else is unexplained.
 */
export function unexplained(recording, allowed) {
  const ok = (host, port) => allowed.some((a) => a.host === host && a.port === port);
  const bad = [];
  for (const c of recording.fetchConnects) if (!ok(c.host, c.port)) bad.push(`fetch ${c.host}:${c.port}`);
  const fetchPorts = recording.fetchConnects.map((c) => c.port);
  for (const s of recording.sockets) {
    if (s.host && ok(s.host, s.port)) continue;
    const i = fetchPorts.indexOf(s.port);
    if (s.port !== null && i >= 0) {
      fetchPorts.splice(i, 1); // a fetch socket: its host was checked above
      continue;
    }
    bad.push(`socket ${s.host ?? s.address ?? "unknown"}:${s.port ?? "unknown"}`);
  }
  return bad;
}
