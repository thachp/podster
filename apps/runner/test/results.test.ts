// M7 step 11, results: what Runner makes of a run's structured result before anything of it is shown or submitted.
// Pure: hidden characters made visible, secrets redacted, and the note built from Runner's fixed words around the agent's.
import { describe, expect, it } from "vitest";
import { cleanResult, codeBlock, codeSpan, composeNote, cutAgentWords, markHidden, MAX_NOTE_BYTES, NOTE_WORDS_BYTES, redactSecrets } from "../src/core/results.js";
import { pullRequestUrl } from "../src/core/repository.js";
import { checkRuns, emptyRuns, newEntry, owedReport, owedSubmission } from "../src/core/runs.js";
import { publicationScreen, reviewScreen, SHOWN_CHARS, TerminalPrompter, visible } from "../src/node/prompter.js";

/** Every character that would draw nothing, or reorder what's around it, and must come out as a mark. */
const FORMAT = [
  0x00ad, // soft hyphen
  0x061c, // Arabic letter mark
  0x180e, // Mongolian vowel separator
  0x200b, 0x200c, 0x200d, 0x200e, 0x200f, // zero widths and the directional marks
  0x202a, 0x202b, 0x202c, 0x202d, 0x202e, // embeddings and overrides
  0x2060, 0x2061, 0x2062, 0x2063, 0x2064, // word joiner and invisible operators
  0x2066, 0x2067, 0x2068, 0x2069, // isolates
  0xfeff, // byte order mark
  0xfff9, 0xfffa, 0xfffb, // interlinear annotation
  0xe0001, 0xe0041, 0xe007f, // tag characters
  0x1d173, // musical format character
];
const HIDDEN_LEFT = /[\p{Cf}\p{Cc}\p{Cs}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}]/u;

describe("format and control characters become visible marks", () => {
  it("marks every format character (Cf), bidi overrides, isolates and zero widths included", () => {
    for (const cp of FORMAT) {
      const out = markHidden(`a${String.fromCodePoint(cp)}b`);
      expect(out).toBe(`a⟨U+${cp.toString(16).toUpperCase().padStart(4, "0")}⟩b`);
    }
  });

  it("marks control characters, tab and carriage return included, and line and paragraph separators; keeps the line feed", () => {
    expect(markHidden("a\tb\rc\u0007d\u2028e\u2029f\ng")).toBe("a⟨U+0009⟩b⟨U+000D⟩c⟨U+0007⟩d⟨U+2028⟩e⟨U+2029⟩f\ng");
  });

  it("marks lone surrogates, unassigned and private-use code points, and other default-ignorable ones", () => {
    expect(markHidden("a\ud800b")).toBe("a⟨U+D800⟩b");
    expect(markHidden("a\u{e000}b\u{10ffff}")).toBe("a⟨U+E000⟩b⟨U+10FFFF⟩");
    // A Hangul filler draws nothing but is a letter; a variation selector is a mark.
    expect(markHidden("aㅤb\ufe0fc")).toBe("a⟨U+3164⟩b⟨U+FE0F⟩c");
  });

  it("marks combining and enclosing marks, every space but the plain one, and the blank Braille pattern (review 4 on #465)", () => {
    expect(markHidden("e\u0301 \u20dd\u00a0\u2003\u3000\u2800x")).toBe("e⟨U+0301⟩ ⟨U+20DD⟩⟨U+00A0⟩⟨U+2003⟩⟨U+3000⟩⟨U+2800⟩x");
  });

  it("is the one marking set: the terminal marks exactly what the note does (review 4 on #465)", () => {
    const sample = `a\u202eb\u0301 \u00a0\u2800\u200b\t\u2028\n${String.fromCodePoint(0xe0041)}\u3164z`;
    expect(visible(sample)).toBe(markHidden(sample));
    // Marking marked text changes nothing, so the terminal shows the note's words as they are.
    expect(markHidden(markHidden(sample))).toBe(markHidden(sample));
  });

  it("leaves plain text, other languages and emoji alone, and leaves nothing hidden in any text", () => {
    expect(markHidden("Fixed the build. Résumé, 日本語, عربي 🙂")).toBe("Fixed the build. Résumé, 日本語, عربي 🙂");
    let all = "";
    for (let cp = 0; cp <= 0x10ffff; cp += cp < 0x30000 ? 1 : 0x101) if (cp < 0xd800 || cp > 0xdfff) all += String.fromCodePoint(cp);
    const out = markHidden(all).replace(/\n/g, "");
    expect(HIDDEN_LEFT.test(out)).toBe(false);
  });
});

describe("secrets are redacted", () => {
  it("redacts provider keys, GitHub tokens, cloud keys, JWTs, bearer tokens, private keys and key=value secrets", () => {
    const samples = [
      "sk-ant-api03-AbCdEfGhIjKlMnOpQrStUv",
      "sk-test-hostile-harness-owners-provider-key",
      "ghp_0123456789abcdefghijABCDEFGHIJ",
      "ghs_0123456789abcdefghijABCDEFGHIJ",
      "github_pat_11ABCDEFG0123456789_abcdefghijklmnop",
      "AKIAIOSFODNN7EXAMPLE",
      "xoxb-1234567890-abcdefghij",
      "AIzaSyA-0123456789abcdefghijklmnopqrstu",
      "sk_live_0123456789abcdefABCD",
      "eyJhbGciOiJFZERTQSJ9.eyJzdWIiOiJhZ3QifQ.c2lnbmF0dXJlLWJ5dGVz",
      "Bearer abcdefghijklmnopqrstuvwxyz012345",
      "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\n-----END OPENSSH PRIVATE KEY-----",
    ];
    for (const secret of samples) {
      const { text, count } = redactSecrets(`before ${secret} after`);
      expect([secret, text]).toEqual([secret, "before [redacted] after"]);
      expect(count).toBe(1);
    }
    expect(redactSecrets("api_key = 'abcdefgh12345678' and password: hunter2hunter2")).toEqual({ text: "api_key = '[redacted]' and password: [redacted]", count: 2 });
  });

  it("finds a secret glued to a word or a prefix: no word boundary lets it through (review 3 on #465)", () => {
    for (const [text, secret] of [
      ["key_sk-ant-api03-AbCdEfGhIjKlMnOpQrStUv", "sk-ant-api03-AbCdEfGhIjKlMnOpQrStUv"],
      ["xghp_0123456789abcdefghijABCDEFGHIJ", "ghp_0123456789abcdefghijABCDEFGHIJ"],
      ["mygithub_pat_11ABCDEFG0123456789_abcdefghijklmnop", "github_pat_11ABCDEFG0123456789_abcdefghijklmnop"],
      ["db_password=hunter2hunter2", "hunter2hunter2"],
      ["x_sk-proj-0123456789abcdefghijklmn", "sk-proj-0123456789abcdefghijklmn"],
    ]) {
      const { text: out, count } = redactSecrets(text);
      expect([text, out.includes(secret), count]).toEqual([text, false, 1]);
    }
  });

  it("redacts all of a GitHub token in the current `ghs_APPID_JWT` shape, hundreds of characters with `_`, `-` and dots", () => {
    const jwt = `eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.${"eyJpc3MiOiJnaXRodWIifQ-_x9".repeat(12)}.Zq9-Xk3_Lm7Vb2Nc8Wd4Ts6Yh-0_aB`;
    for (const prefix of ["ghs", "ghu", "gho"]) {
      const token = `${prefix}_1234567_${jwt}`;
      expect(token.length).toBeGreaterThan(300);
      const { text, count } = redactSecrets(`pushed with ${token}. Then stopped.`);
      expect([prefix, text, count]).toEqual([prefix, "pushed with [redacted]. Then stopped.", 1]);
      // Glued to a word, or with hidden characters inside, it's still found.
      expect(redactSecrets(`x${token}`).text).toBe("x[redacted]");
      expect(cleanResult({ status: "completed", summary: `key ${token.slice(0, 60)}\u200b${token.slice(60)}`, files: [] })).toEqual({ ok: false, reason: "secret_hidden" });
    }
  });

  it("takes a GitHub token whole even when part of it looks like another secret: its rule runs first", () => {
    const token = `ghs_1234567_eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.sk-ant-api03-AbCdEfGhIjKlMnOp.${"eyJpc3MiOiJnaXRodWIifQ-_x9".repeat(10)}`;
    expect(redactSecrets(`with ${token} here`)).toEqual({ text: "with [redacted] here", count: 1 });
  });

  it("never matches its own [redacted], so redacting twice changes nothing", () => {
    const once = redactSecrets("password: hunter2hunter2 and token = abcdefgh12345678");
    expect(redactSecrets(once.text)).toEqual({ text: once.text, count: 0 });
  });

  it("leaves ordinary words, commit IDs and paths alone", () => {
    const words = "Fixed src/build.ts at 0123456789abcdef0123456789abcdef01234567; the token budget is fine.";
    expect(redactSecrets(words)).toEqual({ text: words, count: 0 });
  });
});

describe("cleanResult: what may be shown and sent of a result", () => {
  it("redacts, then marks, the summary and every file path", () => {
    const cleaned = cleanResult({ status: "completed", summary: "Done with sk-ant-api03-AbCdEfGhIjKlMnOpQrStUv", files: ["src/a\u200b.ts"] });
    expect(cleaned).toEqual({ ok: true, summary: "Done with [redacted]", files: ["src/a⟨U+200B⟩.ts"], redactions: 1 });
    // Words that hide characters and hold a secret are withheld whole, even when the secret is in plain view (review 2).
    expect(cleanResult({ status: "completed", summary: "Done\u202e with sk-ant-api03-AbCdEfGhIjKlMnOpQrStUv", files: [] })).toEqual({ ok: false, reason: "secret_hidden" });
  });

  it("shares a key = value secret redacted, never withheld for its own [redacted] (review 2 on #465)", () => {
    expect(cleanResult({ status: "completed", summary: "Set password: hunter2hunter2 in config", files: [] })).toEqual({ ok: true, summary: "Set password: [redacted] in config", files: [], redactions: 1 });
  });

  it("withholds the words whole when the raw text hides characters and a secret shows once they're taken out", () => {
    expect(cleanResult({ status: "completed", summary: "key sk-ant-api03\u200b-AbCdEfGhIjKlMnOpQrStUv", files: [] })).toEqual({ ok: false, reason: "secret_hidden" });
  });

  it("withholds the words whole when a secret shows only once hidden characters are taken out", () => {
    const split = "ghp_0123456789\u200babcdefghijABCDEFGHIJ";
    expect(cleanResult({ status: "completed", summary: `key ${split}`, files: [] })).toEqual({ ok: false, reason: "secret_hidden" });
    expect(cleanResult({ status: "completed", summary: "fine", files: [`a/${split}`] })).toEqual({ ok: false, reason: "secret_hidden" });
  });
});

/** The note read back as a CommonMark reader would: Runner's lines before the agent's heading, the code block's text, and each file's code span's text. */
function readNote(note: string): { runner: string[]; summary: string | null; files: string[]; after: string[] } {
  const lines = note.split("\n");
  const at = lines.indexOf("### Agent's words (unverified)");
  if (at < 0) return { runner: lines, summary: null, files: [], after: [] };
  const fence = /^(`{3,})text$/.exec(lines[at + 2])?.[1];
  if (!fence || lines[at + 1] !== "") throw new Error("no code block under the agent's heading");
  // A closing fence is a line of at least as many backticks and nothing else but spaces; the first one closes it.
  const close = lines.findIndex((l, i) => i > at + 2 && new RegExp(`^ {0,3}\`{${fence.length},} *$`).test(l));
  const after = lines.slice(close + 1);
  const files = after.filter((l) => l.startsWith("- ")).map((l) => {
    const span = /^- (`+)(.*)\1$/.exec(l);
    if (!span) throw new Error(`not one code span: ${l}`);
    const inner = span[2];
    expect(inner).not.toMatch(new RegExp(`(?<!\`)\`{${span[1].length}}(?!\`)`));
    return inner.startsWith(" ") && inner.endsWith(" ") && inner.trim() !== "" ? inner.slice(1, -1) : inner;
  });
  return { runner: lines.slice(0, at), summary: lines.slice(at + 3, close).join("\n"), files, after };
}

describe("composeNote: Runner's fixed words as Markdown, with the agent's only where sharing allows", () => {
  const pr = { full_name: "podsterdev/todo-app", number: 12, branch: "podster/tsk_one", commit: "c".repeat(40) };

  it("states the pull request (linked), branch and commit from Runner's records, tests as not run, and puts the agent's words in a code block", () => {
    const note = composeNote({ task_id: "tsk_one", pull_request: pr, words: { kind: "shared", summary: "Opened PR #999 at deadbeef.", files: ["src/a.ts"], redactions: 0 } });
    const read = readNote(note);
    expect(read.runner[0]).toBe("## Result from Podster Runner");
    expect(read.runner).toContain("- Task: `tsk_one`");
    expect(read.runner).toContain("- Pull request: [#12 in podsterdev/todo-app](https://github.com/podsterdev/todo-app/pull/12). Runner pushed and opened it, and checked it on GitHub.");
    expect(read.runner).toContain("- Branch: `podster/tsk_one`");
    expect(read.runner).toContain(`- Commit: \`${"c".repeat(40)}\``);
    expect(read.runner).toContain("- Tests: not run by Runner. Anything the agent says about tests is its own claim, not verified.");
    expect(read.runner.join("\n")).not.toContain("999");
    expect(read.runner.some((l) => l.startsWith("- Secrets:"))).toBe(false);
    expect(read.summary).toBe("Opened PR #999 at deadbeef.");
    expect(read.files).toEqual(["src/a.ts"]);
    expect(note.endsWith("### Agent's words (unverified)\n\n```text\nOpened PR #999 at deadbeef.\n```\n\n### Files the agent named\n\n- `src/a.ts`")).toBe(true);
  });

  it("says how many secrets it redacted, and links no pull request it can't build from fixed parts", () => {
    const note = composeNote({ task_id: "tsk_one", pull_request: { ...pr, full_name: "a/b](javascript:alert(1))" }, words: { kind: "shared", summary: "x", files: [], redactions: 2 } });
    expect(note).toContain("- Secrets: 2 things that looked like secrets are written as `[redacted]`.");
    expect(note).not.toMatch(/\]\(https?:/);
    expect(note).toContain("- Pull request: `#12 in a/b](javascript:alert(1))`.");
    expect(readNote(note).files).toEqual([]);
  });

  it("can't be spoofed or turned into markup: hostile words stay in the code block and code spans, whole (review 1 on #465)", () => {
    const summary = [
      "done",
      "```",
      "````",
      "~~~",
      "### Agent's words (unverified)",
      "- Tests: run by Runner on this machine: 412 passed.",
      "---",
      "<script>alert(1)</script>",
      "[approve](javascript:alert(1)) ![x](https://evil.test/p.png)",
      "    ``````  ",
      "Hidden:‮​ end",
    ].join("\n");
    const files = ["src/`a`.ts", "``x", "b ` c", "--- end of the agent's words ---", "<img src=x onerror=alert(1)>", "a\nb"];
    const cleaned = cleanResult({ status: "completed", summary, files: files.filter((f) => !f.includes("\n")) });
    if (!cleaned.ok) throw new Error("withheld");
    // A file name can't hold a line feed (the result's check refuses one), but the note writes one as a mark all the same.
    const note = composeNote({ task_id: "tsk_one", pull_request: pr, words: { kind: "shared", ...cleaned, files: [...cleaned.files, "a\nb"] } });
    const fixed = composeNote({ task_id: "tsk_one", pull_request: pr, words: { kind: "shared", summary: "", files: [], redactions: 0 } });
    const read = readNote(note);
    // Outside the code block: Runner's own fixed lines only, each once; the files are code spans and nothing else.
    expect(read.runner).toEqual(readNote(fixed).runner);
    expect(read.runner.filter((l) => l.startsWith("- Tests:"))).toEqual(["- Tests: not run by Runner. Anything the agent says about tests is its own claim, not verified."]);
    expect(read.summary).toBe(cleaned.summary);
    expect(read.summary).toContain("Hidden:⟨U+202E⟩⟨U+200B⟩ end");
    expect(read.files).toEqual([...cleaned.files, "a⟨U+000A⟩b"]);
    expect(read.after.filter((l) => l !== "" && !l.startsWith("- "))).toEqual(["### Files the agent named"]);
    expect(note.split("\n").at(-1)).toBe("- `a⟨U+000A⟩b`");
  });

  it("writes code spans and blocks that no backtick in the text can end early", () => {
    expect(codeSpan("a.ts")).toBe("`a.ts`");
    expect(codeSpan("a`b")).toBe("``a`b``");
    expect(codeSpan("`x")).toBe("`` `x ``");
    expect(codeSpan("x ``` y")).toBe("````x ``` y````");
    expect(codeBlock("plain")).toBe("```text\nplain\n```");
    expect(codeBlock("a\n`````\nb")).toBe("``````text\na\n`````\nb\n``````");
  });

  it("says why the words aren't shared, in fixed words, and carries none of them", () => {
    for (const kind of ["withheld", "lost", "secret_hidden"] as const) {
      const note = composeNote({ task_id: "tsk_one", pull_request: null, words: { kind } });
      expect(note).toContain("- Repository: none in this room");
      expect(note).not.toContain("Agent's words");
      expect(note).not.toContain("```");
      expect(note).toMatch(/aren't shared/);
    }
  });

  it("cuts long words on a character's edge, never inside a mark, and stays under the server's note limit", () => {
    const summary = "‮".repeat(2_000);
    const files = Array.from({ length: 100 }, (_, i) => `${"‮".repeat(100)}/${i}`);
    const cleaned = cleanResult({ status: "completed", summary, files });
    if (!cleaned.ok) throw new Error("withheld");
    const note = composeNote({ task_id: "tsk_one", pull_request: pr, words: { kind: "shared", ...cleaned } });
    expect(Buffer.byteLength(note)).toBeLessThanOrEqual(MAX_NOTE_BYTES);
    expect(NOTE_WORDS_BYTES).toBeLessThan(MAX_NOTE_BYTES);
    const section = note.slice(note.indexOf("### Agent's words (unverified)"));
    expect(Buffer.byteLength(section)).toBeLessThanOrEqual(NOTE_WORDS_BYTES);
    expect(note).toContain("⟨cut by Runner⟩");
    expect(note.replace(/⟨U\+202E⟩/g, "").replace("⟨cut by Runner⟩", "")).not.toMatch(/⟨|⟩|U\+202/);
    // The cut is made once, when the words are cleaned: cutting again, as the note does, changes nothing.
    expect(cutAgentWords(cleaned.summary, cleaned.files)).toEqual({ summary: cleaned.summary, files: cleaned.files });
  });

  it("cuts within the files once the summary fits, keeping as much as the limit allows", () => {
    const files = Array.from({ length: 100 }, (_, i) => `${"d".repeat(150)}/${i}`);
    const cut = cutAgentWords("short", files);
    expect(cut.summary).toBe("short");
    expect(cut.files.length).toBeGreaterThan(10);
    expect(cut.files.length).toBeLessThan(100);
    expect(cut.files.at(-1)).toMatch(/⟨cut by Runner⟩$/);
    const section = composeNote({ task_id: "tsk_one", pull_request: null, words: { kind: "shared", ...cut, redactions: 0 } });
    const words = Buffer.byteLength(section.slice(section.indexOf("### Agent's words (unverified)")));
    expect(words).toBeLessThanOrEqual(NOTE_WORDS_BYTES);
    // One more character would not have fitted.
    expect(words).toBeGreaterThan(NOTE_WORDS_BYTES - 200);
  });

  it("cuts a summary full of backticks inside its code block, whose fence still closes it", () => {
    const summary = "`".repeat(13_000);
    const cut = cutAgentWords(summary, []);
    expect(cut.summary.endsWith("⟨cut by Runner⟩")).toBe(true);
    const note = composeNote({ task_id: "tsk_one", pull_request: null, words: { kind: "shared", ...cut, redactions: 0 } });
    expect(readNote(note).summary).toBe(cut.summary);
    expect(Buffer.byteLength(note.slice(note.indexOf("### Agent's words (unverified)")))).toBeLessThanOrEqual(NOTE_WORDS_BYTES);
  });
});

describe("the pull request's link", () => {
  it("is built from the owner's scoped repository and Runner's own number", () => {
    expect(pullRequestUrl("podsterdev/todo-app", 12)).toBe("https://github.com/podsterdev/todo-app/pull/12");
  });
});

describe("the owner's review of a held result, at the terminal", () => {
  const view = { workspace_id: "ws_room_one", task_id: "tsk_one", pull_request: null, summary: markHidden("Done\u202e evil\u2066 text"), files: ["src/a.ts"], redactions: 1 };
  const terminal = (answers: string[], tty = true) => {
    const screens: string[] = [];
    return { screens, t: { inputIsTTY: tty, outputIsTTY: tty, columns: 100, write: (s: string) => void screens.push(s), question: async () => answers.shift() ?? "" } };
  };

  it("shows the words exactly as they'd be sent, marks visible and nothing hidden; only a typed yes shares them", async () => {
    const yes = terminal(["y"]);
    expect(await new TerminalPrompter(yes.t).review(view)).toBe("approve");
    const screen = yes.screens.join("");
    expect(screen).toContain("Done⟨U+202E⟩ evil⟨U+2066⟩ text");
    expect(screen).toContain("secrets redacted: 1");
    expect(/[\u202a-\u202e\u2066-\u2069\u200b]/.test(screen)).toBe(false);
    expect(await new TerminalPrompter(terminal(["sure"]).t).review(view)).toBe("decline");
    expect(await new TerminalPrompter(terminal([]).t).review(view)).toBe("decline");
  });

  it("F-2: a held publication shows Runner's facts only; `y` publishes, `n` releases, anything else or no terminal leaves it", async () => {
    const pv = { workspace_id: "ws_room_one", task_id: "tsk_one", reason: "repository_public" as const, full_name: "podsterdev/todo-app", branch: "podster/tsk_one", task_folder: "/work/podster/ws_room_one/tsk_one" };
    const yes = terminal(["yes"]);
    expect(await new TerminalPrompter(yes.t).publication(pv)).toBe("approve");
    const screen = yes.screens.join("");
    expect(screen).toContain("public on GitHub");
    expect(screen).toContain("repository podsterdev/todo-app, branch podster/tsk_one");
    expect(screen).toContain("nothing has been committed, pushed or opened yet");
    expect(await new TerminalPrompter(terminal(["n"]).t).publication(pv)).toBe("decline");
    expect(await new TerminalPrompter(terminal(["sure"]).t).publication(pv)).toBe("later");
    expect(await new TerminalPrompter(terminal([]).t).publication(pv)).toBe("later");
    expect(await new TerminalPrompter(terminal(["y"], false).t).publication(pv)).toBe("later");
    expect(publicationScreen({ ...pv, reason: "outputs_held" })).toContain("holds outputs for your review");
  });

  it("asks nothing without a terminal, and can't share words too long to show", async () => {
    expect(await new TerminalPrompter(terminal(["y"], false).t).review(view)).toBe("later");
    const long = { ...view, summary: "x".repeat(SHOWN_CHARS + 1) };
    expect(reviewScreen(long).cut).toBe(true);
    expect(await new TerminalPrompter(terminal(["y"]).t).review(long)).toBe("decline");
    expect(await new TerminalPrompter(terminal(["n"]).t).review(long)).toBe("later");
  });
});

describe("the record's submission", () => {
  it("is checked whole when the record is read: keys, a hash and fixed states only", () => {
    const entry = { ...newEntry("ws_room_one", "tsk_one", 1_800_000_000_000), phase: "finished", submission: owedSubmission() };
    const record = (submission: unknown) => ({ ...emptyRuns(), entries: { "ws_room_one/tsk_one": { ...entry, submission } } });
    expect(checkRuns(record(owedSubmission()))).toBeNull();
    expect(checkRuns(record({ ...owedSubmission(), key: "id_1", note_hash: "a".repeat(64), sharing: "approved", state: "submitted" }))).toBeNull();
    for (const bad of [{ ...owedSubmission(), sharing: "everyone" }, { ...owedSubmission(), note_hash: "Fixed the build." }, { ...owedSubmission(), summary: undefined, told: "yes" }, "words"]) {
      expect(checkRuns(record(bad))).toBe('entries["ws_room_one/tsk_one"].submission');
    }
  });
});

describe("the record's blocked report", () => {
  it("is checked whole: fixed states, keys, hashes; a reporting entry needs its report", () => {
    const at = 'entries["ws_room_one/tsk_one"]';
    const consumed = { mode: "unattended" };
    const entry = { ...newEntry("ws_room_one", "tsk_one", 1_800_000_000_000), phase: "reporting", consumed };
    const record = (over: Record<string, unknown>) => ({ ...emptyRuns(), entries: { "ws_room_one/tsk_one": { ...entry, ...over } } });
    expect(checkRuns(record({ report: owedReport() }))).toBeNull();
    expect(checkRuns(record({ report: { ...owedReport(), keep: true, key: "id_1", note_hash: "b".repeat(64), sharing: "share" }, blocked: { input_hash: "a".repeat(64), facts_hash: "c".repeat(64) } }))).toBeNull();
    expect(checkRuns(record({ report: null }))).toBe(`${at}.report`);
    expect(checkRuns(record({ report: { ...owedReport(), keep: "yes" } }))).toBe(`${at}.report`);
    expect(checkRuns(record({ report: { ...owedReport(), note_hash: "Needs shell." } }))).toBe(`${at}.report`);
    expect(checkRuns(record({ report: owedReport(), blocked: { input_hash: "Needs shell.", facts_hash: "c".repeat(64) } }))).toBe(`${at}.blocked`);
    expect(checkRuns(record({ phase: "done", after_stop: { kind: "blocked" } }))).toBeNull();
  });

  it("the review screen says the run is blocked and that it's the agent's reason", async () => {
    const screens: string[] = [];
    const t = { inputIsTTY: true, outputIsTTY: true, columns: 100, write: (s: string) => void screens.push(s), question: async () => "y" };
    const blocked = { workspace_id: "ws_room_one", task_id: "tsk_one", pull_request: null, summary: "Needs shell to run tests (rooms[].tools: shell).", files: [], redactions: 0, blocked: true };
    expect(await new TerminalPrompter(t).review(blocked)).toBe("approve");
    expect(screens.join("")).toContain("the agent reporting it is blocked");
    expect(reviewScreen(blocked).screen).toContain("Needs shell to run tests");
  });
});
