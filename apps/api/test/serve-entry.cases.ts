import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

// M6 stage 1: the serve entry's mark that the script it names carries code (`podster_core::serve_entry`). The
// provider writes the mark only when told a release carries code: since S3 of the store plan, the applier tells it so
// for a script the room recorded as code before writing it, and a static entry is exactly as before (`takedown.spec.ts`
// holds a written entry to the fixture, and shows the applier's kinds). Here the provider's
// write and read are reached through the test-only route `/test/serve-entry`, against the content provider's stand-in
// (`fake-content.ts`), and held to the fixture that core and the content Worker are tested against.
//
// *Since S3:* these cases are registered inside `takedown.spec.ts` (`serveEntryCases`), as `custom-routing.cases.ts`'s
// are. Both reset and seed the stand-in's serve entries, which live in the test runner, so as two spec files run side by
// side one read the other's reset (an entry seeded here read `absent`). In one file they run in turn.

const BINDINGS = env as any;
const FAKE = JSON.parse(BINDINGS.TEST_FAKE_CONTENT) as { domain: string };
const FIXTURE = JSON.parse(BINDINGS.TEST_SERVE_FIXTURE) as {
  code_mark: string;
  custom_entry_host: string;
  valid_script_names: string[];
  invalid_script_names: string[];
  valid_custom_entries: string[];
  invalid_custom_entries: string[];
  valid_code_entries: string[];
  invalid_code_entries: string[];
  static_entries_not_marked: string[];
  valid_code_custom_entries: string[];
  invalid_code_custom_entries: string[];
};

const fake = (path: string, body: unknown = {}) => fetch(`https://content-fake.example.com${path}`, { method: "POST", body: JSON.stringify(body) }).then((res) => res.json() as Promise<any>);
const entries = async () => (await fake("/state")).entries as Record<string, string>;
async function provider(body: Record<string, unknown>) {
  const res = await SELF.fetch("https://api.internal/test/serve-entry", { method: "POST", body: JSON.stringify(body) });
  expect(res.status).toBe(200);
  return (await res.json()) as { written?: boolean; entry?: string; script?: string | null };
}
const labelOf = (script: string) => script.slice(0, script.indexOf("."));
const defaultHost = (script: string) => `${labelOf(script)}.${FAKE.domain}`;
const CUSTOM = FIXTURE.custom_entry_host;

export function serveEntryCases() {
describe("the provider's serve entry", () => {
  beforeEach(async () => { await fake("/reset"); });

  it("writes a static entry exactly as before, and marks one only when told its release carries code", async () => {
    for (const script of FIXTURE.valid_script_names) {
      const host = defaultHost(script);
      expect(await provider({ op: "write", host, script, code: false }), script).toEqual({ written: true });
      expect((await entries())[host]).toBe(script);
      expect(await provider({ op: "read", host })).toEqual({ entry: "present", script });
      expect(await provider({ op: "write", host, script, code: true }), script).toEqual({ written: true });
      expect((await entries())[host]).toBe(`${FIXTURE.code_mark}${script}`);
      expect(FIXTURE.valid_code_entries).toContain(`${FIXTURE.code_mark}${script}`);
      expect(await provider({ op: "read", host })).toEqual({ entry: "code", script });
    }
    for (const value of FIXTURE.valid_custom_entries) {
      const script = value.slice(0, value.indexOf("@"));
      expect(await provider({ op: "write", host: CUSTOM, script, code: false })).toEqual({ written: true });
      expect((await entries())[CUSTOM]).toBe(value);
      expect(await provider({ op: "read", host: CUSTOM })).toEqual({ entry: "present", script });
      expect(await provider({ op: "write", host: CUSTOM, script, code: true })).toEqual({ written: true });
      expect((await entries())[CUSTOM]).toBe(`${FIXTURE.code_mark}${value}`);
      expect(FIXTURE.valid_code_custom_entries).toContain(`${FIXTURE.code_mark}${value}`);
      expect(await provider({ op: "read", host: CUSTOM })).toEqual({ entry: "code", script });
    }
  });

  it("writes nothing, marked or not, for a name Podster doesn't make or another label's host", async () => {
    const script = FIXTURE.valid_script_names[1];
    for (const code of [false, true]) {
      for (const name of FIXTURE.invalid_script_names) expect(await provider({ op: "write", host: defaultHost(script), script: name, code }), JSON.stringify(name)).toEqual({ written: false });
      expect(await provider({ op: "write", host: `other.${FAKE.domain}`, script, code })).toEqual({ written: false });
    }
    expect(await entries()).toEqual({});
  });

  it("reads each of the fixture's vectors as core does: static, with code, or foreign", async () => {
    const host = `k3v9q2.${FAKE.domain}`;
    const read = async (key: string, value: string) => {
      await fake("/seed", { entries: { [key]: value } });
      return provider({ op: "read", host: key });
    };
    for (const value of [...FIXTURE.valid_script_names, ...FIXTURE.static_entries_not_marked]) expect(await read(host, value), value).toEqual({ entry: "present", script: value });
    for (const value of FIXTURE.valid_code_entries) expect(await read(host, value), value).toEqual({ entry: "code", script: value.slice(FIXTURE.code_mark.length) });
    for (const value of [...FIXTURE.invalid_script_names, ...FIXTURE.invalid_code_entries, ...FIXTURE.valid_code_custom_entries]) {
      expect(await read(host, value), JSON.stringify(value)).toEqual({ entry: "foreign", script: null });
    }
    for (const value of FIXTURE.valid_custom_entries) expect(await read(CUSTOM, value), value).toEqual({ entry: "present", script: value.slice(0, value.indexOf("@")) });
    for (const value of FIXTURE.valid_code_custom_entries) expect(await read(CUSTOM, value), value).toEqual({ entry: "code", script: value.slice(FIXTURE.code_mark.length, value.indexOf("@")) });
    for (const value of [...FIXTURE.invalid_custom_entries, ...FIXTURE.invalid_code_custom_entries, ...FIXTURE.valid_code_entries]) {
      expect(await read(CUSTOM, value), JSON.stringify(value)).toEqual({ entry: "foreign", script: null });
    }
  });

  it("is written with a kind by the applier alone, with the kind the room recorded for the script, and by this route", () => {
    // *Widened by S3 of the store plan:* the applier now writes code entries, so the guard reads every source of the
    // API, not only the provider's.
    const sources = JSON.parse(BINDINGS.TEST_API_SOURCES) as Record<string, string>;
    // The files that name the provider's one write of an entry: where it is defined, with this test-only route, and the
    // applier. No other file of the API writes an entry at all, marked or not.
    const callers = Object.entries(sources).filter(([, source]) => source.includes("write_entry_as(")).map(([path]) => path).sort();
    expect(callers).toEqual(["content_provider.rs", "workspace/takedown.rs"]);
    // No call anywhere but this route names the code kind itself: the applier's kind is the room's record's.
    const route = /provider\.write_entry_as\(host, script, kind\)/;
    for (const [path, source] of Object.entries(sources)) {
      const calls = [...source.matchAll(/write_entry_as\(([^)]*)\)/g)].map((match) => match[1]);
      expect(calls.filter((args) => /\bCode\b/.test(args)), path).toEqual([]);
    }
    // In the provider, beside its definition, only this route calls it, in test builds alone.
    const provider = sources["content_provider.rs"];
    expect(provider.split("write_entry_as(").length - 1).toBe(2);
    const at = provider.search(route);
    expect(at).toBeGreaterThan(0);
    expect(provider.lastIndexOf('#[cfg(feature = "failpoints")]', at)).toBeGreaterThan(provider.lastIndexOf("\n}\n", at));
    // The applier writes each entry with the kind the room recorded for its script, and with nothing else.
    const applier = sources["workspace/takedown.rs"];
    const applied = [...applier.matchAll(/write_entry_as\(([^)]*)\)/g)].map((match) => match[1].replace(/\s+/g, " ").trim());
    expect(applied).toEqual(["host, script, want.kind", "host, script, kind"]);
    expect(applier).toContain("Some(script) => release_commit::script_kind(sql, script)?,");
    expect(applier).toContain("custom_write(sql, env, provider, host, script, want.kind)");
    // No attribute keeps the write alive in a build where nothing calls it.
    expect(provider).not.toMatch(/dead_code[^\n]*\n\s*pub\(crate\) async fn write_entry_as/);
  });
});
}
