// Pure checks for step 9(b)'s real-run isolation probe inside Claude Code's container (the review of #460 at
// 1335df4a, M1): reachability is proved by connecting, and mounts against an exact expected set.
import type { DockerResult } from "../src/node/docker-sandbox.js";

/** Every mount Claude Code's container may have, by its mount point. */
const EXPECTED = new Set(["/", "/proc", "/dev", "/dev/pts", "/dev/mqueue", "/sys", "/sys/fs/cgroup", "/tmp", "/work", "/claude/home", "/claude/config", "/etc/resolv.conf", "/etc/hostname", "/etc/hosts"]);
/** The tmpfs mounts it must have: its scratch, its working folder, and its home and config, none from the host. */
const REQUIRED_TMPFS = ["/tmp", "/work", "/claude/home", "/claude/config"];
/** Docker's own masked and read-only paths under /proc and /sys. */
const MASKED = /^\/(proc\/(acpi|asound|bus|fs|irq|kcore|keys|latency_stats|timer_list|timer_stats|sched_debug|scsi|sys|sysrq-trigger|interrupts)|sys\/(firmware|devices\/virtual\/powercap))$/;
/** File systems that carry a host folder into Docker Desktop's VM: never allowed. */
const HOST_FS = /^(virtiofs|fakeowner|grpcfuse|osxfs|9p|fuse(\..*)?|nfs\d?|cifs|smb\d?)$/;

/** What in `/proc/mounts` isn't exactly expected; empty when the mounts are exactly the expected set. */
export function unexpectedMounts(procMounts: string): string[] {
  const out: string[] = [];
  const types = new Map<string, string>();
  for (const line of procMounts.split("\n").map((l) => l.trim()).filter((l) => l !== "")) {
    const [, rawTarget = "", fstype = ""] = line.split(/\s+/);
    const target = rawTarget.replace(/\\040/g, " ");
    if (HOST_FS.test(fstype)) {
      out.push(`${fstype}:${target}`);
      continue;
    }
    if (!EXPECTED.has(target) && !MASKED.test(target)) out.push(target);
    types.set(target, fstype);
  }
  for (const target of REQUIRED_TMPFS) {
    if (!types.has(target)) out.push(`missing:${target}`);
    else if (types.get(target) !== "tmpfs") out.push(`not_tmpfs:${target}`);
  }
  return out;
}

/** socat made the connection. */
export const connected = (r: DockerResult) => r.code === 0;

/** The relay forwarded to Runner's listener, which answered 401: by its status line only. */
export const answeredUnauthorized = (r: DockerResult) => /^HTTP\/1\.[01] 401 /.test(r.stdout);
