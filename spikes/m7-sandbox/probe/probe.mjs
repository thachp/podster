// The isolation probe: a "task command" that tries to reach what it shouldn't. It runs inside a task
// container as the task's user, either straight from `docker exec` or as a child of Claude Code's Bash
// tool. It prints one JSON object. Environment values and /proc environ contents are included only so the
// host can check them for the provider key; the host records booleans and names, never the values.
// Usage: node probe.mjs <otherTaskHostDir> <brokerHostPort> <hostIp> <hostHome>

import fs from "node:fs";
import net from "node:net";
import dns from "node:dns/promises";

// With no arguments it reads them from /work/probe-args.json, so a model-run command carries no host path.
const argv = process.argv.length > 2 ? process.argv.slice(2) : JSON.parse(fs.readFileSync("/work/probe-args.json", "utf8"));
const [otherTaskDir = "", brokerPort = "0", hostIp = "192.168.65.254", hostHome = "/Users/x"] = argv;
const out = { identity: {}, env: {}, files: {}, procs: {}, writes: {}, net: {}, dns: {}, broker: {}, mounts: [] };

const status = fs.readFileSync("/proc/self/status", "utf8");
for (const k of ["Uid", "Gid", "CapEff", "CapBnd", "NoNewPrivs", "Seccomp"]) {
  const m = status.match(new RegExp(`^${k}:\\s*(.*)$`, "m"));
  out.identity[k] = m ? m[1].trim() : null;
}
out.env = { ...process.env };

const tryRead = (p) => {
  try {
    const st = fs.statSync(p);
    if (st.isDirectory()) return { ok: true, kind: "dir", entries: fs.readdirSync(p).length };
    fs.readFileSync(p);
    return { ok: true, kind: "file" };
  } catch (e) {
    return { ok: false, code: e.code };
  }
};
const home = hostHome;
for (const p of [
  "/Users", home, `${home}/.podster`, `${home}/.podster/anthropic-spike-b.key`, `${home}/.ssh`, `${home}/.claude`,
  "/host_mnt", "/root", "/home", "/home/task", "/var/run/docker.sock", "/run/docker.sock",
  otherTaskDir, "/work-b", "/opt/claude/claude", "/work",
]) out.files[p] = tryRead(p);
// Claude Code's own state inside the container, if it runs here.
out.files["/home/task/.claude"] = tryRead("/home/task/.claude");

const pids = fs.readdirSync("/proc").filter((d) => /^\d+$/.test(d));
out.procs.count = pids.length;
out.procs.environ = {};
out.procs.otherTaskMarkerSeen = false;
for (const pid of pids) {
  try {
    const cmd = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8");
    if (cmd.includes("31337")) out.procs.otherTaskMarkerSeen = true;
  } catch {}
  try {
    out.procs.environ[pid] = fs.readFileSync(`/proc/${pid}/environ`, "utf8");
  } catch (e) {
    out.procs.environ[pid] = `unreadable:${e.code}`;
  }
}

for (const p of ["/etc/probe", "/usr/probe", "/probe-root", "/work/.probe-write", "/tmp/probe", "/opt/claude/probe"]) {
  try {
    fs.writeFileSync(p, "x");
    fs.rmSync(p);
    out.writes[p] = true;
  } catch (e) {
    out.writes[p] = e.code;
  }
}

try {
  out.mounts = fs.readFileSync("/proc/self/mountinfo", "utf8").split("\n").filter(Boolean).map((l) => l.split(" ")[4]);
} catch {}

for (const h of ["api.anthropic.com", "example.com", "host.docker.internal", "relay"]) {
  try {
    out.dns[h] = (await dns.lookup(h)).address ? "resolved" : "none";
  } catch (e) {
    out.dns[h] = e.code;
  }
}

const tcp = (host, port) =>
  new Promise((resolve) => {
    const s = net.connect({ host, port: Number(port), timeout: 2500 });
    s.on("connect", () => (s.destroy(), resolve("open")));
    s.on("timeout", () => (s.destroy(), resolve("timeout")));
    s.on("error", (e) => resolve(e.code));
  });
for (const [h, p] of [
  ["1.1.1.1", 443], ["8.8.8.8", 53], ["169.254.169.254", 80],
  ["host.docker.internal", 22], ["host.docker.internal", brokerPort], ["172.17.0.1", brokerPort],
  [hostIp, brokerPort], ["relay", 8080],
]) out.net[`${h}:${p}`] = await tcp(h, p);

if (out.net["relay:8080"] === "open") {
  const call = async (method, path, body) => {
    try {
      const r = await fetch(`http://relay:8080${path}`, {
        method,
        headers: { "content-type": "application/json", "anthropic-version": "2023-06-01", "x-api-key": "probe" },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(20000),
      });
      return r.status;
    } catch (e) {
      return e.name;
    }
  };
  out.broker.getModels = await call("GET", "/v1/models");
  out.broker.otherModel = await call("POST", "/v1/messages", { model: "claude-opus-5-5", max_tokens: 1, messages: [{ role: "user", content: "x" }] });
  out.broker.allowedModel = await call("POST", "/v1/messages", { model: "claude-haiku-5-5", max_tokens: 1, messages: [{ role: "user", content: "x" }] });
}

process.stdout.write(JSON.stringify(out));
