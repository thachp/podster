// The local diagnostics file (the owner's request of 2026-11-20): mode 600 in a 700 folder, bounded and rotated, every
// text redacted, the Docker detail kept, and `why`'s lookup by task.
import { existsSync, mkdtempSync, readFileSync, statSync, symlinkSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DetailedError } from "../src/core/errors.js";
import { cutEdge, diagnosticLine, FileDiagnostics, MAX_FIELD_BYTES, MAX_FILE_BYTES, scrub, whyCommand, whyLines } from "../src/node/diagnostics.js";
import { holdSecret } from "../src/core/known-secrets.js";
import { runLogger } from "../src/node/explaining-log.js";
import { chmodSync, linkSync, writeFileSync } from "node:fs";

const home = () => mkdtempSync(join(tmpdir(), "runner-diag-"));
const NOW = 1_800_000_000_000;

describe("the diagnostics file", () => {
  it("is made 0700/0600 in Runner's home and holds one redacted JSON line per failure, with Docker's exit code and error tail", () => {
    const h = home();
    const d = new FileDiagnostics(h, () => NOW);
    const error = new DetailedError("container_failed", { exit_code: 125, stderr: `${"noise\n".repeat(2000)}docker: token=ghp_abcdefghijklmnopqrstuvwxyz0123456789 failed` });
    d.record({ at: "adapter.run", code: "container_failed", workspace: "ws_room_one", task: "tsk_one", run_ref: "run_1", error });
    expect(statSync(join(h, "logs")).mode & 0o777).toBe(0o700);
    expect(statSync(d.file).mode & 0o777).toBe(0o600);
    const line = JSON.parse(readFileSync(d.file, "utf8").trim());
    expect(line).toMatchObject({ time: new Date(NOW).toISOString(), at: "adapter.run", code: "container_failed", workspace: "ws_room_one", task: "tsk_one", run_ref: "run_1", message: "container_failed", exit_code: 125 });
    expect(line.stderr_tail.endsWith("failed")).toBe(true);
    expect(Buffer.byteLength(line.stderr_tail)).toBeLessThanOrEqual(MAX_FIELD_BYTES + 5);
    expect(line.stderr_tail).toContain("[redacted]");
    expect(JSON.stringify(line)).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123456789");
    expect(typeof line.stack).toBe("string");
  });

  it("redacts and bounds a raw message, and keeps IDs only when they're IDs", () => {
    const text = diagnosticLine({ at: "lifecycle.tick", code: "Not A Code", task: "../etc", error: new Error(`key sk-ant-abcdefghijk1234 ${"x".repeat(10_000)}`) }, NOW);
    const line = JSON.parse(text);
    expect(line.code).toBe("unknown");
    expect(line.task).toBeUndefined();
    expect(line.message).toContain("[redacted]");
    expect(line.message).not.toContain("sk-ant-abcdefghijk1234");
    expect(Buffer.byteLength(line.message)).toBeLessThanOrEqual(MAX_FIELD_BYTES + 5);
    expect(scrub("short")).toBe("short");
  });

  it("rotates past its size bound and keeps at most three files", () => {
    const h = home();
    const d = new FileDiagnostics(h, () => NOW);
    const big = new Error("y".repeat(3_000));
    for (let i = 0; i < 1_200; i++) d.record({ at: "adapter.run", code: "container_failed", task: `tsk_${i}`, error: big });
    for (const path of [d.file, `${d.file}.1`, `${d.file}.2`]) {
      expect(existsSync(path)).toBe(true);
      expect(statSync(path).size).toBeLessThanOrEqual(MAX_FILE_BYTES);
    }
    expect(existsSync(`${d.file}.3`)).toBe(false);
    expect(d.lastFor("tsk_1199")).toMatchObject({ task: "tsk_1199", code: "container_failed" });
    expect(d.lastFor("tsk_0")).toBeNull();
  });

  it("answers the newest failure for a task, and never follows a link planted as the file; a failed write never throws", () => {
    const h = home();
    const d = new FileDiagnostics(h, () => NOW);
    d.record({ at: "adapter.run", code: "container_failed", task: "tsk_one" });
    d.record({ at: "lifecycle.run", code: "result_file_outside_folder", task: "tsk_one" });
    expect(d.lastFor("tsk_one")).toMatchObject({ code: "result_file_outside_folder" });
    expect(d.lastFor("tsk_two")).toBeNull();
    const other = home();
    mkdirSync(join(other, "logs"));
    symlinkSync(join(other, "elsewhere"), join(other, "logs", "errors.jsonl"));
    const linked = new FileDiagnostics(other, () => NOW);
    expect(() => linked.record({ at: "adapter.run", code: "container_failed" })).not.toThrow();
    expect(existsSync(join(other, "elsewhere"))).toBe(false);
  });
});

describe("review of #489", () => {
  it("redacts the exact secrets Runner holds, such as a bare 64-hex broker token, until they're released", () => {
    const token = "a".repeat(32) + "0123456789abcdef0123456789abcdef";
    const release = holdSecret(token);
    expect(scrub(`refused with ${token} in the header`)).toBe("refused with [redacted] in the header");
    release();
    expect(scrub(`refused with ${token}`)).toContain(token);
  });

  it("redacts the partial word at the edge of error output Docker cut at its cap", () => {
    expect(cutEdge("docker: Error: token ghs_abc")).toBe("docker: Error: token [cut: partial word redacted]");
    const line = JSON.parse(diagnosticLine({ at: "adapter.run", code: "container_failed", error: new DetailedError("container_failed", { exit_code: 125, stderr: "failed: key sk-ant-ab", cut: true }) }, NOW));
    expect(line.stderr_tail).toBe("failed: key [cut: partial word redacted]");
    // Not cut: the last word stays.
    expect(JSON.parse(diagnosticLine({ at: "adapter.run", code: "container_failed", error: new DetailedError("container_failed", { stderr: "it failed" }) }, NOW)).stderr_tail).toBe("it failed");
  });

  it("makes an existing file private before the first write, and refuses a hard-linked file", () => {
    const h = home();
    mkdirSync(join(h, "logs"), { mode: 0o700 });
    const file = join(h, "logs", "errors.jsonl");
    writeFileSync(file, "");
    chmodSync(file, 0o644);
    new FileDiagnostics(h, () => NOW).record({ at: "adapter.run", code: "container_failed", task: "tsk_one" });
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const other = home();
    mkdirSync(join(other, "logs"), { mode: 0o700 });
    writeFileSync(join(other, "target"), "");
    linkSync(join(other, "target"), join(other, "logs", "errors.jsonl"));
    new FileDiagnostics(other, () => NOW).record({ at: "adapter.run", code: "container_failed" });
    expect(readFileSync(join(other, "target"), "utf8")).toBe("");
    // A symlinked logs folder is refused before anything is changed through it.
    const victim = home();
    chmodSync(victim, 0o755);
    const linkedHome = home();
    symlinkSync(victim, join(linkedHome, "logs"));
    new FileDiagnostics(linkedHome, () => NOW).record({ at: "adapter.run", code: "container_failed" });
    expect(statSync(victim).mode & 0o777).toBe(0o755);
    expect(existsSync(join(victim, "errors.jsonl"))).toBe(false);
    // Reads refuse a symlinked folder.
    const third = home();
    symlinkSync(join(h, "logs"), join(third, "logs"));
    expect(new FileDiagnostics(third).lastFor("tsk_one")).toBeNull();
  });
});

describe("podster why", () => {
  it("refuses a task that isn't an ID, and says when nothing is recorded", () => {
    const said: string[] = [];
    expect(whyCommand(home(), "../tsk", (l) => void said.push(l))).toBe(2);
    expect(whyCommand(home(), undefined, (l) => void said.push(l))).toBe(2);
    expect(said).toEqual(["Name a task: `why <tsk_…>`.", "Name a task: `why <tsk_…>`."]);
    const h = home();
    const out: string[] = [];
    expect(whyCommand(h, "tsk_one", (l) => void out.push(l))).toBe(0);
    expect(out[0]).toBe(`No failure is recorded for tsk_one in ${join(h, "logs", "errors.jsonl")}.`);
  });

  it("prints the explanation and the entry with control, format and bidi characters made visible; bad shapes read invalid", () => {
    const h = home();
    const d = new FileDiagnostics(h, () => NOW);
    d.record({ at: "adapter.run", code: "egress_proxy_unavailable", task: "tsk_one", error: new Error("evil \u202e\u0085\u2066 text \u001b[2J") });
    const out: string[] = [];
    expect(whyCommand(h, "tsk_one", (l) => void out.push(l))).toBe(0);
    expect(out[0]).toBe(`${new Date(NOW).toISOString()} at adapter.run: The room's policy lists network hosts, but this Runner has no egress proxy to hold them, so the run didn't start. Start Runner with \`run\`, which builds and pins its egress proxy image, or set rooms[].network to [] in policy.json. (code egress_proxy_unavailable)`);
    const printed = out.join("\n");
    expect(/[\u007f-\u009f\u202a-\u202e\u2066-\u2069\u001b]/.test(printed)).toBe(false);
    expect(printed).toContain("⟨U+202E⟩");
    const lines = whyLines("tsk_one", { time: "yesterday\u202e", at: "Not An At", code: "Bad Code", task: "tsk_one" }, "/f");
    expect(lines[0]).toBe("invalid at invalid: Runner has no explanation for this code. The diagnostics file has the details. (code invalid)");
  });
});

describe("run's logger", () => {
  it("explains failures on the terminal, naming this home's diagnostics file", () => {
    const h = home();
    const lines: string[] = [];
    const { log, diagnostics } = runLogger(h, (l) => void lines.push(l));
    expect(diagnostics.file).toBe(join(h, "logs", "errors.jsonl"));
    log("lifecycle.run", "run_failed", { task: "tsk_one", code: "exec_exited" });
    expect(lines[1]).toBe(`  why: The agent's run failed before it gave a result. The details file has the driver's code; the task is released, and offered again by the room. (code exec_exited; details: ${diagnostics.file})`);
  });
});
