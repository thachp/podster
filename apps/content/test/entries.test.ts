import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import fixture from "../../../packages/contracts/serve-entry.fixture.json";
import { CODE_MARK, customEntryKind, defaultEntryKind } from "../src/names";

// The serve entry's mark that a script has code (M6 stage 1, ADR 0010's revision, section 4). The rule is
// `podster_core::serve_entry`; `src/names.ts` holds a copy, because the Worker is TypeScript. The first block binds the
// copy to the Rust source; the rest reads the fixture's vectors, which core and the API's tests read too.

const RUST = readFileSync(new URL("../../../crates/core/src/serve_entry.rs", import.meta.url), "utf8");
const HOST = fixture.custom_entry_host;

describe("the mark, bound to the Rust source", () => {
  it("is core's constant and the fixture's", () => {
    const lines = RUST.split("\n").filter((line) => line.startsWith("pub const CODE_MARK: &str = "));
    expect(lines).toEqual([`pub const CODE_MARK: &str = "${CODE_MARK}";`]);
    expect(fixture.code_mark).toBe(CODE_MARK);
  });

  it("is taken off as core takes it off: once, from the start only, and only there", () => {
    // Core reads the mark in exactly one place, by `strip_prefix`, and marks a value in exactly one place, before it.
    // Counted by the mark itself, so other prefixes in the file (the preview form's, M8) don't count, and any second
    // site that takes the code mark off or puts it on, by these calls or by naming the constant anywhere else, does.
    expect(RUST.split("strip_prefix(CODE_MARK").length - 1).toBe(1);
    expect(RUST).toContain("match value.strip_prefix(CODE_MARK) {");
    expect(RUST.split('format!("{CODE_MARK}').length - 1).toBe(1);
    expect(RUST).toContain('HostKind::Code => format!("{CODE_MARK}{value}"),');
    // Outside comments, CODE_MARK appears only in its own declaration and those two sites.
    const code = RUST.split("\n").filter((line) => !line.trimStart().startsWith("//")).join("\n");
    expect(code.split("CODE_MARK").length - 1).toBe(3);
    for (const word of ["trim", "to_lowercase", "to_ascii_lowercase", "rsplit", "find(CODE_MARK", "replace"]) expect(RUST, word).not.toContain(word);
  });
});

describe("a default host's entry", () => {
  it("reads every static vector as before: static, the same script", () => {
    expect(fixture.valid_script_names.length).toBeGreaterThanOrEqual(4);
    for (const value of [...fixture.valid_script_names, ...fixture.static_entries_not_marked]) expect(defaultEntryKind(value), value).toEqual({ kind: "static", script: value });
    for (const value of fixture.invalid_script_names) {
      expect(defaultEntryKind(value), JSON.stringify(value)).toBeNull();
      expect(defaultEntryKind(`${CODE_MARK}${value}`), JSON.stringify(value)).toBeNull();
    }
  });

  it("reads a marked script as one with code, and refuses every ambiguous or malformed mark", () => {
    expect(fixture.valid_code_entries.length).toBeGreaterThanOrEqual(4);
    for (const value of fixture.valid_code_entries) expect(defaultEntryKind(value), value).toEqual({ kind: "code", script: value.slice(CODE_MARK.length) });
    expect(fixture.invalid_code_entries.length).toBeGreaterThanOrEqual(20);
    for (const value of fixture.invalid_code_entries) expect(defaultEntryKind(value), JSON.stringify(value)).toBeNull();
  });
});

describe("a custom hostname's entry", () => {
  it("reads every static vector as before, for its own host only", () => {
    for (const value of fixture.valid_custom_entries) expect(customEntryKind(HOST, value), value).toEqual({ kind: "static", script: value.slice(0, value.indexOf("@")) });
    for (const value of fixture.invalid_custom_entries) {
      expect(customEntryKind(HOST, value), JSON.stringify(value)).toBeNull();
      expect(customEntryKind(HOST, `${CODE_MARK}${value}`), JSON.stringify(value)).toBeNull();
    }
  });

  it("reads a marked entry as one with code, and refuses every ambiguous or malformed mark, and the default form", () => {
    expect(fixture.valid_code_custom_entries.length).toBeGreaterThanOrEqual(2);
    for (const value of fixture.valid_code_custom_entries) expect(customEntryKind(HOST, value), value).toEqual({ kind: "code", script: value.slice(CODE_MARK.length, value.indexOf("@")) });
    expect(fixture.invalid_code_custom_entries.length).toBeGreaterThanOrEqual(20);
    for (const value of [...fixture.invalid_code_custom_entries, ...fixture.valid_code_entries]) expect(customEntryKind(HOST, value), JSON.stringify(value)).toBeNull();
    // And a custom form, with code, is never a default host's entry.
    for (const value of fixture.valid_code_custom_entries) expect(defaultEntryKind(value), value).toBeNull();
  });
});
