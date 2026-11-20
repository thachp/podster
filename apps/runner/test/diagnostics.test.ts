// The local diagnostics file (the owner's request of 2026-11-20): mode 600 in a 700 folder, bounded and rotated, every
// text redacted, the Docker detail kept, and `why`'s lookup by task.
import { existsSync, mkdtempSync, readFileSync, statSync, symlinkSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DetailedError } from "../src/core/errors.js";
import { diagnosticLine, FileDiagnostics, MAX_FIELD_BYTES, MAX_FILE_BYTES, scrub } from "../src/node/diagnostics.js";

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
