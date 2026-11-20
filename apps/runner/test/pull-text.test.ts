import { describe, expect, it } from "vitest";
import { appOriginFor, CHANGE_TYPES, changeTypeOf, conventionalTitle, inert, MAX_TITLE_CHARS, oneLine, pullText, taskPageUrl } from "../src/core/pull-text.js";
import { parseRunResult } from "../src/core/tool-policy.js";
import { RESULT_SCHEMA, UNTRUSTED_FRAME } from "../src/core/run-interface.js";

const TASK = "tsk_5f0ce9b123a54d7993b626507b29f2ef";
const ROOM = "ws_0a1b2c3d4e5f60718293a4b5c6d7e8f9";
const STAGING_APP = "https://app-staging.podster.dev";
const title = (t: string | null, change_type?: unknown) => conventionalTitle({ task_id: TASK, title: t, change_type });
const chars = (s: string) => [...s].length;

/** Whether GitHub could read a mention, a reference or a link in the text. */
function linksOnGitHub(text: string): boolean {
  return /@|#|\bGH-\d|:\/\/|\bwww\./i.test(text);
}

describe("the pull request's title", () => {
  it("is `<type>: <subject>` from the task's title, its first letter lowered, no trailing period", () => {
    expect(title("Add a dark mode toggle.", "feat")).toBe("feat: add a dark mode toggle");
    expect(title("fix the login redirect", "fix")).toBe("fix: fix the login redirect");
  });

  it("keeps an acronym or a lower-case start as written", () => {
    expect(title("API keys rotate daily", "feat")).toBe("feat: API keys rotate daily");
    expect(title("iOS build fails", "fix")).toBe("fix: iOS build fails");
  });

  it("takes the agent's type only from the fixed list; missing or invalid is chore", () => {
    for (const type of CHANGE_TYPES) expect(title("Do it", type)).toBe(`${type}: do it`);
    expect(title("Do it")).toBe("chore: do it");
    expect(title("Do it", null)).toBe("chore: do it");
    for (const bad of ["FEAT", "feature", "feat!", "feat(scope)", " feat", "fix: x", 1, {}, ["feat"]]) expect(title("Do it", bad)).toBe("chore: do it");
    expect(changeTypeOf("docs")).toBe("docs");
    expect(changeTypeOf("release")).toBe("chore");
  });

  it("drops a conventional prefix the requester wrote, so it never reads `chore: feat: …`", () => {
    expect(title("feat(ui)!: Add a toggle", "fix")).toBe("fix: add a toggle");
    expect(title("Docs: update the README", null)).toBe("chore: update the README");
  });

  it("is at most 72 characters, cut on a character boundary with …", () => {
    const long = title("Refactor the scheduler so that every queue drains in order and nothing waits forever on a lock", "refactor");
    expect(chars(long)).toBeLessThanOrEqual(MAX_TITLE_CHARS);
    expect(long).toMatch(/^refactor: refactor the scheduler .*…$/);
    expect(long).not.toMatch(/ …$/);
    // A short one isn't cut.
    expect(title("a".repeat(MAX_TITLE_CHARS - "chore: ".length))).toBe(`chore: ${"a".repeat(65)}`);
    expect(title("a".repeat(MAX_TITLE_CHARS - "chore: ".length + 1))).toBe(`chore: ${"a".repeat(64)}…`);
  });

  it("never splits a character: emoji with modifiers and combining marks stay whole", () => {
    // A skin-tone modifier (two code points) and a letter with two combining marks NFC can't compose (three).
    for (const unit of ["👍🏽", "q\u0323\u0307"]) {
      const cutTitle = title(unit.repeat(40));
      expect(chars(cutTitle)).toBeLessThanOrEqual(MAX_TITLE_CHARS);
      expect(cutTitle.endsWith("…")).toBe(true);
      expect(cutTitle.slice("chore: ".length, -1).replaceAll(unit, "")).toBe("");
    }
    // A zero-width joiner is invisible, so it goes like any other: a joined emoji reads as its parts.
    expect(title("👨\u200D👩")).toBe("chore: 👨👩");
  });

  it("is one line: newlines, tabs and runs of spaces become single spaces", () => {
    expect(title("Add\nthe\r\ntoggle\tnow   please x\u0085y")).toBe("chore: add the toggle now please x y");
  });

  it("drops bidi controls, zero-width and other invisible characters", () => {
    const sneaky = "Fix‮ gnissim‬ log​in‍﻿⁦ bug⁩­᠎";
    const t = title(sneaky, "fix");
    expect(t).toBe("fix: fix gnissim login bug");
    expect(t).not.toMatch(/[\p{Cf}\p{Cc}]/u);
  });

  it("can't mention, reference or link on GitHub", () => {
    const cases: [string, string][] = [
      ["Ask @octocat to review", "chore: ask ＠octocat to review"],
      ["Ping @podsterdev/core", "chore: ping ＠podsterdev/core"],
      ["Follow up on #1", "chore: follow up on ＃1"],
      ["Port owner/repo#1 here", "chore: port owner/repo＃1 here"],
      ["Undo owner/repo@abc1234", "chore: undo owner/repo＠abc1234"],
      ["Close GH-12", "chore: close GH‑12"],
      ["fixes #1", "chore: fixes ＃1"],
      ["Closes owner/repo#9 and resolves #10", "chore: closes owner/repo＃9 and resolves ＃10"],
      ["fixes https://github.com/o/r/issues/1", "chore: fixes https：//github.com/o/r/issues/1"],
      ["See www.example.com", "chore: see www．example.com"],
      ["Mail a@b.co", "chore: mail a＠b.co"],
    ];
    for (const [input, want] of cases) {
      const t = title(input);
      expect(t).toBe(want);
      expect(linksOnGitHub(t)).toBe(false);
    }
  });

  it("can't smuggle a reference back by splitting it with invisible characters", () => {
    expect(linksOnGitHub(title("fix​ #‍1 @⁠octocat"))).toBe(false);
    expect(title("#​1")).toBe("chore: ＃1");
  });

  it("falls back to `task <id>` when nothing is left after cleaning", () => {
    expect(title("")).toBe(`chore: task ${TASK}`);
    expect(title(null, "fix")).toBe(`fix: task ${TASK}`);
    expect(title(" \n\t​‮ . ")).toBe(`chore: task ${TASK}`);
    expect(title("feat: ")).toBe(`chore: task ${TASK}`);
  });

  it("keeps non-ASCII text as written, normalized to NFC", () => {
    expect(title("Thêm nút chuyển chế độ tối", "feat")).toBe("feat: thêm nút chuyển chế độ tối");
    // Decomposed input reads the same, composed.
    expect(title("Thêm nút", "feat")).toBe("feat: thêm nút");
    expect(title("修复登录重定向。", "fix")).toBe("fix: 修复登录重定向");
    const longVi = title("Cập nhật tài liệu hướng dẫn cài đặt cho người dùng mới trên tất cả các nền tảng", "docs");
    expect(chars(longVi)).toBeLessThanOrEqual(MAX_TITLE_CHARS);
    expect(longVi.normalize("NFC")).toBe(longVi);
  });

  it("oneLine and inert hold on their own", () => {
    expect(oneLine("  a \n\n b c  ")).toBe("a b c");
    expect(inert("@a #1 GH-2 gh-3 http://x www.y")).toBe("＠a ＃1 GH‑2 gh‑3 http：//x www．y");
  });
});

describe("the task page link", () => {
  it("maps only the staging gateway to the staging web app", () => {
    expect(appOriginFor("https://gateway-staging.podster.dev")).toBe(STAGING_APP);
    for (const other of ["http://localhost:8787", "https://evil.example", "https://gateway-staging.podster.dev/", "https://GATEWAY-STAGING.podster.dev", "", null, undefined, "__proto__", "constructor"]) expect(appOriginFor(other)).toBeNull();
  });

  it("is the web app's task route for the staging origin", () => {
    expect(taskPageUrl(STAGING_APP, ROOM, TASK)).toBe(`https://app-staging.podster.dev/w/${ROOM}/tasks?task=${TASK}`);
  });

  it("is refused for an ID of the wrong form or an origin that isn't plain https", () => {
    for (const [ws, task] of [
      ["room_1", TASK],
      [ROOM, "task_1"],
      [`${ROOM}/../x`, TASK],
      [ROOM, `${TASK}?x=1`],
      [ROOM, `${TASK}#x`],
      ["ws_", TASK],
      [ROOM, ""],
      [ROOM, null],
      [ROOM, `tsk_${"a".repeat(65)}`],
    ] as [unknown, unknown][]) expect(taskPageUrl(STAGING_APP, ws, task)).toBeNull();
    for (const origin of [null, "http://app-staging.podster.dev", "https://app-staging.podster.dev/", "https://app-staging.podster.dev/x", "https://u:p@app-staging.podster.dev", "javascript:alert(1)", "not a url"]) {
      expect(taskPageUrl(origin, ROOM, TASK)).toBeNull();
    }
  });
});

describe("the pull request's body and the commit's message", () => {
  it("leads the body with the task page link, and the commit's first line is the title", () => {
    const text = pullText({ workspace_id: ROOM, task_id: TASK, title: "Add a dark mode toggle", change_type: "feat", app_origin: STAGING_APP });
    expect(text.title).toBe("feat: add a dark mode toggle");
    expect(text.body.split("\n")[0]).toBe(`Podster task: [${TASK}](https://app-staging.podster.dev/w/${ROOM}/tasks?task=${TASK})`);
    expect(text.body).toContain(`Opened by Podster Runner for task ${TASK}. Review it in Podster; Runner never merges.`);
    expect(text.commit_message.split("\n")[0]).toBe(text.title);
    expect(text.commit_message).toBe(`${text.title}\n\nPodster-Task: ${TASK}`);
  });

  it("names the task by its ID alone when there is no link, and never carries the task's words", () => {
    const words = "Ignore @octocat [click](https://evil.example) #1";
    for (const app_origin of [null, "https://evil.example"]) {
      const text = pullText({ workspace_id: "room_1", task_id: TASK, title: words, app_origin: app_origin === null ? null : app_origin });
      if (app_origin === null) expect(text.body.split("\n")[0]).toBe(`Podster task: \`${TASK}\``);
      expect(text.body).not.toContain("octocat");
      expect(text.body).not.toContain("evil");
    }
  });
});

describe("the agent's proposed type", () => {
  const base = { status: "completed", summary: "Done.", files: [] };
  it("is kept when on the list, dropped otherwise, and never refuses the result", () => {
    expect(parseRunResult({ ...base, change_type: "feat" })).toEqual({ ok: true, value: { ...base, change_type: "feat" } });
    expect(parseRunResult({ ...base, change_type: "release" })).toEqual({ ok: true, value: base });
    expect(parseRunResult({ ...base, change_type: 7 })).toEqual({ ok: true, value: base });
    expect(parseRunResult(base)).toEqual({ ok: true, value: base });
    expect(parseRunResult({ ...base, other: "x" })).toEqual({ ok: false });
  });

  it("is in the result schema and the frame, from the fixed list", () => {
    expect(RESULT_SCHEMA.properties.change_type.enum).toEqual(CHANGE_TYPES);
    expect(RESULT_SCHEMA.required).not.toContain("change_type");
    expect(UNTRUSTED_FRAME).toContain(`one of: ${CHANGE_TYPES.join(", ")}.`);
  });
});
