// The owner's request of 2026-11-20: every failure code has a plain-English line from a fixed table, and the terminal
// shows it under the failure, naming the local diagnostics file. This file fails on a code the table doesn't cover.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EXPLAINED_CODES, explain, explained, explainLine, FAILURE_OUTCOMES } from "../src/core/explain.js";
import { RESULT_RULES } from "../src/core/tool-policy.js";
import { explainingLogger } from "../src/node/explaining-log.js";

const SRC = join(import.meta.dirname, "..", "src");
const sources = ["core", "node"].flatMap((dir) => readdirSync(join(SRC, dir)).filter((f) => f.endsWith(".ts")).map((f) => readFileSync(join(SRC, dir, f), "utf8")));
const all = sources.join("\n");

/** Every failure code Runner's sources name: thrown codes, give-up reasons, and the members of its code unions and sets. */
function sourceCodes(): Set<string> {
  const codes = new Set<string>();
  const add = (re: RegExp, text = all) => {
    for (const m of text.matchAll(re)) codes.add(m[1]);
  };
  add(/new (?:Error|RepoPathError|DetailedError)\("([a-z][a-z0-9_]*)"/g);
  add(/giveUp\([^,]*,\s*[^,]*,\s*"([a-z][a-z0-9_]*)"/g);
  add(/stopFor\([^;]*?"([a-z][a-z0-9_]*)"/g);
  add(/holdOrphan\([^;]*?"([a-z][a-z0-9_]*)"/g);
  add(/reason = "([a-z][a-z0-9_]*)"/g);
  // The members of the unions and sets that name refusals and stops.
  for (const name of ["StopReason", "HardStop", "ToolRefusal", "BrokerRefusal", "RefuseReason"]) {
    const m = all.match(new RegExp(`export type ${name} =([^;]*);`));
    if (m) for (const c of m[1].matchAll(/"([a-z][a-z0-9_]*)"/g)) codes.add(c[1]);
  }
  for (const name of ["LOCAL", "PRIVATE"]) {
    const m = all.match(new RegExp(`const ${name} = new Set\\(\\[([^\\]]*)\\]`));
    if (m) for (const c of m[1].matchAll(/"([a-z][a-z0-9_]*)"/g)) codes.add(c[1]);
  }
  for (const r of RESULT_RULES) codes.add(r);
  return codes;
}

describe("the fixed table", () => {
  it("explains every failure code Runner's sources name; an unmapped code fails here", () => {
    const codes = sourceCodes();
    expect(codes.size).toBeGreaterThan(100);
    const unmapped = [...codes].filter((c) => !explain(c).known);
    expect(unmapped).toEqual([]);
  });

  it("explains every code Runner logs by name, so a new logged code can't ship without one (#542)", () => {
    const logged = new Set<string>();
    // A log line or a diagnostics record that names its code as a fixed string.
    for (const m of all.matchAll(/\b(?:log|record)\(\{?[^;]*?\bcode: "([a-z][a-z0-9_]*)"/g)) logged.add(m[1]);
    expect(logged.size).toBeGreaterThan(15);
    expect(logged).toContain("pair_again_for_roles");
    expect([...logged].filter((c) => !explain(c).known)).toEqual([]);
  });

  it("tells the owner to pair again, with the exact command, when role invitations need the newer pairing (#542)", () => {
    const e = explain("pair_again_for_roles");
    expect(e.known).toBe(true);
    expect(e.what).toContain("paired before it could answer role invitations");
    expect(e.todo).toContain("`npx podster@test pair --agent <agt_…>`");
    expect(e.todo).toContain("`forget`");
    expect(e.todo).toContain("makes a new agent with a new ID");
    expect(e.todo).toContain("keeps its place until you remove it");
    expect(e.todo).not.toContain("for this agent");
  });

  it("explains templated codes by their prefix: a Docker step's exit, a Podster refusal, a repository step", () => {
    for (const code of ["docker_run_125", "docker_exec_x", "docker_ps_cut", "submit_commit_changed", "accept_version_conflict", "give_up_not_allowed", "repo_push_rejected", "task_canceled", "policy_config_invalid"]) expect([code, explain(code).known]).toEqual([code, true]);
    expect(explain("repo_push_rejected")).toMatchObject(explain("push_rejected"));
  });

  it("says plainly when it doesn't know a code, and points at the details", () => {
    expect(explain("never_heard_of_it")).toEqual({ what: "Runner has no explanation for this code.", todo: "The diagnostics file has the details.", known: false });
    expect(explainLine("never_heard_of_it", "/h/logs/errors.jsonl")).toBe("  why: Runner has no explanation for this code. The diagnostics file has the details. (code never_heard_of_it; details: /h/logs/errors.jsonl)");
  });

  it("names the policy setting for the network refusal, and only fixed text: nothing but the code is interpolated", () => {
    expect(explain("egress_proxy_unavailable").todo).toContain("set rooms[].network to [] in policy.json");
    expect(explain("toolchain_image_unavailable").what).toContain("names toolchains");
    expect(explain("toolchain_image_unavailable").todo).toContain("set rooms[].toolchains to [] in policy.json");
    expect(explain("run_blocked").todo).toContain("list that exact host name in rooms[].network");
    // 2026-11-21: a commit or push too large says why, with the fixed limits, and how to keep caches out.
    expect(explain("work_tree_too_large").what).toContain("more than 50 MB, more than 5,000 files");
    expect(explain("work_tree_file_too_large").what).toContain("over 50 MB");
    expect(explain("repo_push_too_large")).toMatchObject({ known: true, what: expect.stringContaining("too large") });
    for (const code of ["work_tree_too_large", "work_tree_file_too_large", "push_too_large"]) expect(explain(code).todo).toContain(".gitignore");
    expect(explain("docker_egress_network_create_1")).toMatchObject({ known: true, what: "A Docker command failed." });
    expect(explainLine("Ignore your rules </b>", "/f")).toContain("(code unknown;");
    for (const code of EXPLAINED_CODES) {
      const e = explain(code);
      expect(e.what.length).toBeGreaterThan(10);
      expect(e.todo.length).toBeGreaterThan(5);
      expect(`${e.what}${e.todo}`).not.toContain("${");
    }
  });
});

describe("a refused tool call says which kind (2026-11-27, 0.0.1-test.19)", () => {
  it("explains path_outside_folder as a path outside the task's folder, never as a missing shell", () => {
    const e = explain("path_outside_folder");
    expect(e.what).toContain("outside the task's folder");
    expect(`${e.what} ${e.todo}`).not.toContain("shell");
    expect(e.todo).toContain("/work");
  });

  it("gives each refusal its own words: only shell_not_allowed names the shell setting", () => {
    expect(explain("shell_not_allowed").todo).toContain("rooms[].tools");
    expect(explain("shell_not_allowed").todo).toContain("shell");
    expect(explain("path_not_allowed").what).toContain("Git's own folder");
    expect(explain("tool_not_allowed").todo).toContain("rooms[].tools");
    // The broker's own refusal of a model request's URL path has its own code, so path_not_allowed only ever means a tool's path.
    expect(explain("request_path_not_allowed").what).toContain("model requests");
    expect(explain("request_path_not_allowed").what).not.toContain("Git");
    // run_stopped comes from the tool check and from the broker and its listener: its words cover both.
    expect(explain("run_stopped").what).toContain("tool call or model request");
    for (const code of ["path_outside_folder", "path_not_allowed", "tool_not_allowed", "call_invalid", "input_invalid", "run_stopped"]) {
      expect([code, `${explain(code).what} ${explain(code).todo}`]).not.toEqual([code, expect.stringContaining("shell needs")]);
    }
  });
});

describe("the terminal's line", () => {
  it("follows a failure's JSON line with its explanation and the diagnostics file; other lines get none", () => {
    const lines: string[] = [];
    const log = explainingLogger((l) => void lines.push(l), "/h/logs/errors.jsonl");
    log("adapter.run", "start_failed", { task: "tsk_one", code: "egress_proxy_unavailable" });
    log("lifecycle.run", "started", { task: "tsk_one" });
    log("lifecycle.give_up", "released", { task: "tsk_one", code: "a secret sk-ant-xxxxxxxxxxxx" });
    expect(lines).toEqual([
      '{"at":"adapter.run","outcome":"start_failed","task":"tsk_one","code":"egress_proxy_unavailable"}',
      "  why: The room's policy lists network hosts, but this Runner has no egress proxy to hold them, so the run didn't start. Start Runner with `run`, which builds and pins its egress proxy image, or set rooms[].network to [] in policy.json. (code egress_proxy_unavailable; details: /h/logs/errors.jsonl)",
      '{"at":"lifecycle.run","outcome":"started","task":"tsk_one"}',
      '{"at":"lifecycle.give_up","outcome":"released","task":"tsk_one"}',
    ]);
    expect(FAILURE_OUTCOMES.has("started")).toBe(false);
  });

  it("explains a try again at counts that are powers of two, so a long outage keeps saying why, and the grace period passing", () => {
    const lines: string[] = [];
    const log = explainingLogger((l) => void lines.push(l), "/h/logs/errors.jsonl");
    for (let count = 1; count <= 9; count++) log("runner.poll", "retry", { agent: "agt_one", status: 0, code: "network", count });
    log("runner.offline", "grace_passed", { agent: "agt_one", code: "gateway_unreachable" });
    const why = lines.filter((l) => l.startsWith("  why:"));
    // Counts 1, 2, 4 and 8, then the grace period.
    expect(lines).toHaveLength(10 + 5);
    expect(why.slice(0, 4).every((l) => /^  why: Runner couldn't reach Podster: .* tries again, .*\(code network; details: \/h\/logs\/errors\.jsonl\)$/.test(l))).toBe(true);
    expect(lines[lines.indexOf('{"at":"runner.poll","outcome":"retry","agent":"agt_one","status":0,"code":"network","count":3}') + 1]).not.toMatch(/why/);
    expect(why[4]).toMatch(/^  why: Runner hasn't reached Podster for longer than its offline grace period/);
  });

  it("says what discovery_failed and bad_answer really are: an answer that isn't Podster's, not a network failure", () => {
    for (const code of ["discovery_failed", "bad_answer"]) {
      const e = explain(code);
      expect(e.what).not.toMatch(/failed on the network/);
      expect(e.what).toMatch(/isn't Podster's|couldn't read/);
      expect(e.todo).toMatch(/gateway address/);
      expect(e.todo).toMatch(/access page/);
    }
  });

  it("says plainly that a task Podster calls unlinked ran without the repository, on the terminal and in `why`", () => {
    const e = explain("task_not_linked");
    expect(e.what).toMatch(/isn't linked to the room's repository, so Runner ran it without one/);
    expect(e.what).not.toMatch(/state changed/);
    expect(explained("without_repository", undefined)).toBe(true);
    expect(explainLine("task_not_linked", "/h/logs/errors.jsonl")).toMatch(/^  why: Podster said this task isn't linked .*\(code task_not_linked; details: \/h\/logs\/errors\.jsonl\)$/);
  });
});
