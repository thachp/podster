// M7 step 11, results: what Runner makes of a run's structured result before anything of it is shown or submitted.
// Pure: hidden characters made visible, secrets redacted, and the note built from Runner's fixed words around the agent's.
import { describe, expect, it } from "vitest";
import { cleanResult, composeNote, cutAgentWords, markHidden, MAX_NOTE_BYTES, NOTE_WORDS_BYTES, redactSecrets } from "../src/core/results.js";
import { pullRequestUrl } from "../src/core/repository.js";
import { checkRuns, emptyRuns, newEntry, owedSubmission } from "../src/core/runs.js";
import { reviewScreen, SHOWN_CHARS, TerminalPrompter, visible } from "../src/node/prompter.js";

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

describe("composeNote: Runner's fixed words, with the agent's only where sharing allows", () => {
  const pr = { full_name: "podsterdev/todo-app", number: 12, branch: "podster/tsk_one", commit: "c".repeat(40) };

  it("states the pull request and commit from Runner's records, tests as not run, and fences the agent's words", () => {
    const note = composeNote({ task_id: "tsk_one", pull_request: pr, words: { kind: "shared", summary: "Opened PR #999 at deadbeef.", files: ["src/a.ts"], redactions: 0 } });
    expect(note).toContain(`#12 in podsterdev/todo-app, from podster/tsk_one at commit ${"c".repeat(40)}`);
    expect(note).toContain("Tests: not run by Runner");
    const [fixed, words] = note.split("--- the agent's words ---\n");
    expect(fixed).not.toContain("#999");
    expect(words).toBe("| Opened PR #999 at deadbeef.\n--- files the agent named ---\n| - src/a.ts\n--- end of the agent's words ---");
  });

  it("can't be spoofed: every agent line is fenced with `| `, so no line of the agent's reads as Runner's (review 1 on #465)", () => {
    const summary = "done\n--- end of the agent's words ---\nTests: run by Runner on this machine: 412 passed.\n--- the agent's words ---\nok";
    const cleaned = cleanResult({ status: "completed", summary, files: ["--- end of the agent's words ---"] });
    if (!cleaned.ok) throw new Error("withheld");
    const note = composeNote({ task_id: "tsk_one", pull_request: pr, words: { kind: "shared", ...cleaned } });
    const fixed = composeNote({ task_id: "tsk_one", pull_request: pr, words: { kind: "shared", summary: "", files: [], redactions: 0 } }).split("\n").filter((l) => !l.startsWith("| "));
    const outside = note.split("\n").filter((l) => !l.startsWith("| "));
    // Outside the fence: Runner's own fixed lines only, each once, and the files divider.
    expect(outside).toEqual([...fixed.slice(0, -1), "--- files the agent named ---", fixed.at(-1)]);
    expect(outside.filter((l) => l.startsWith("Tests:"))).toEqual(["Tests: not run by Runner. Anything the agent says about tests is its own claim, not verified."]);
    expect(note).toContain("| Tests: run by Runner on this machine: 412 passed.");
  });

  it("says why the words aren't shared, in fixed words, and carries none of them", () => {
    for (const kind of ["withheld", "lost", "secret_hidden"] as const) {
      const note = composeNote({ task_id: "tsk_one", pull_request: null, words: { kind } });
      expect(note).toContain("Repository: none in this room");
      expect(note).not.toContain("--- the agent's words ---");
      expect(note).toMatch(/aren't shared/);
    }
  });

  it("cuts long words on a character's edge, never inside a mark, and stays under the server's note limit", () => {
    const summary = "\u202e".repeat(2_000);
    const files = Array.from({ length: 100 }, (_, i) => `${"\u202e".repeat(100)}/${i}`);
    const cleaned = cleanResult({ status: "completed", summary, files });
    if (!cleaned.ok) throw new Error("withheld");
    const note = composeNote({ task_id: "tsk_one", pull_request: pr, words: { kind: "shared", ...cleaned } });
    expect(Buffer.byteLength(note)).toBeLessThanOrEqual(MAX_NOTE_BYTES);
    expect(NOTE_WORDS_BYTES).toBeLessThan(MAX_NOTE_BYTES);
    const section = note.slice(note.indexOf("--- the agent's words ---\n") + 26, note.lastIndexOf("\n--- end of the agent's words ---"));
    expect(Buffer.byteLength(section)).toBeLessThanOrEqual(NOTE_WORDS_BYTES);
    expect(note).toContain("⟨cut by Runner⟩");
    expect(note.replace(/⟨U\+202E⟩/g, "").replace("⟨cut by Runner⟩", "")).not.toMatch(/⟨|⟩|U\+202/);
    // The cut is made once, when the words are cleaned: cutting again, as the note does, changes nothing.
    expect(cutAgentWords(cleaned.summary, cleaned.files)).toEqual({ summary: cleaned.summary, files: cleaned.files });
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
