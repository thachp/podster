// Loaded with `node --import` by help-check.mjs before a script runs with --help. It cuts the script off from other
// programs and the network: starting a child process, a fetch, a socket, an HTTP request or a name lookup is written
// to the file HELP_CHECK_LOG names, and then throws. A script that catches the error is still caught, by the file.
// It's a net, not a sandbox: see help-check.mjs's KNOWN GAPS.
import childProcess from "node:child_process";
import dgram from "node:dgram";
import dns from "node:dns";
import { appendFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
import net from "node:net";
import tls from "node:tls";

const log = process.env.HELP_CHECK_LOG;

function refuse(what) {
  return function refused() {
    try {
      if (log) appendFileSync(log, `${what}\n`);
    } catch {
      // The run still fails: the call throws below.
    }
    throw new Error(`help-check: ${what} during --help`);
  };
}

for (const name of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"]) childProcess[name] = refuse(`child_process.${name}`);
for (const name of ["connect", "createConnection"]) {
  net[name] = refuse(`net.${name}`);
  tls[name] = refuse(`tls.${name}`);
}
net.Socket.prototype.connect = refuse("net.Socket connect");
for (const [label, module] of [["http", http], ["https", https]]) {
  module.request = refuse(`${label}.request`);
  module.get = refuse(`${label}.get`);
}
for (const name of ["lookup", "resolve", "resolve4", "resolve6"]) dns[name] = refuse(`dns.${name}`);
dns.promises.lookup = refuse("dns.promises.lookup");
dgram.createSocket = refuse("dgram.createSocket");
globalThis.fetch = refuse("fetch");
globalThis.WebSocket = refuse("WebSocket");
// Named imports of a builtin (`import { spawn } from "node:child_process"`) see the replacements only after this.
syncBuiltinESMExports();
