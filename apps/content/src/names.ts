// The two names the content Worker reads, and their forms. Both are decided in Rust, by the private API, which is
// the only writer of the serve entries' namespace: `podster_core::release::script_owner` for a script's name, and
// `apps/api/src/content_provider.rs` for the stop key and for what a host may look like. This is a second check of
// what was read, never the authority. The mark that a script has code is `podster_core::serve_entry`'s.
// `packages/contracts/serve-entry.fixture.json` holds the vectors both sides are tested against.
import type { HostKind } from "./requests";

/** The key that stops the whole content domain. A host can't contain `_`, so no host is ever this key. */
export const STOP_KEY = "_stop";

/** A script's name: a label of 1 to 26 lower-case letters and digits, a `.`, then `rel_` and 32 lower-case hex digits. */
const SCRIPT_NAME = /^[a-z0-9]{1,26}\.rel_[0-9a-f]{32}$/;

export function isScriptName(value: string): boolean {
  return SCRIPT_NAME.test(value);
}

/** A label: 1 to 26 lower-case letters and digits, as `podster_core::release::is_label` has it. */
const LABEL = /^[a-z0-9]{1,26}$/;

/**
 * The label of the app whose default host this is on `domain`: `<label>.<domain>`, exactly one label deep. Null for
 * any other host: the domain itself, a deeper name, a name elsewhere, or when `domain` isn't a host at all. The same
 * rule as `default_host_label_on` in `apps/api/src/content_provider.rs`.
 */
export function defaultHostLabel(host: string, domain: string): string | null {
  if (!isHost(domain) || !isHost(host) || !host.endsWith(`.${domain}`)) return null;
  const label = host.slice(0, host.length - domain.length - 1);
  return LABEL.test(label) ? label : null;
}

/** Whether a host is `domain` itself or any name under it, at any depth. The same rule as `on_domain` in the API. */
export function onDomain(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`);
}

/** Between a custom hostname's script and its host in its serve entry (M6 step 8c). */
export const CUSTOM_ENTRY_SEPARATOR = "@";

/**
 * The script a custom hostname's serve entry names, read for exactly `host`, or null: the script's name, `@`, then the
 * host it was written under, as `podster_core::hostnames::custom_entry_script` reads it. A value under any other key,
 * or a default host's form (the script's name alone), is nothing.
 */
export function customEntryScript(host: string, value: string): string | null {
  const at = value.indexOf(CUSTOM_ENTRY_SEPARATOR);
  if (at < 0) return null;
  const script = value.slice(0, at);
  return isWrittenHost(host) && value.slice(at + 1) === host && isScriptName(script) ? script : null;
}

/**
 * Before a serve entry's value when its script's release carries code (M6 stage 1), as
 * `podster_core::serve_entry::CODE_MARK` has it. A static entry carries no mark. It ends in `:`, which no script's name
 * and no written host holds, so no static entry can begin with it.
 */
export const CODE_MARK = "code:";

/** What a confirmed serve entry names: its script, and whether that script's release carries code. */
export type EntryRead = { kind: HostKind; script: string };

/** An entry's kind, and the static form left once its mark, if any, is taken off: once, from the start only. */
function unmarked(value: string): { kind: HostKind; rest: string } {
  return value.startsWith(CODE_MARK) ? { kind: "code", rest: value.slice(CODE_MARK.length) } : { kind: "static", rest: value };
}

/**
 * A default host's entry, as `podster_core::serve_entry::default_entry_script` reads it: a script's name, after the
 * mark when it has code. Null for anything else. Which label the host takes is the caller's to check.
 */
export function defaultEntryKind(value: string): EntryRead | null {
  const { kind, rest } = unmarked(value);
  return isScriptName(rest) ? { kind, script: rest } : null;
}

/**
 * A custom hostname's entry, read for exactly `host`, as `podster_core::serve_entry::custom_entry_script_kind` reads
 * it: `customEntryScript`'s form, after the mark when it has code. Null for anything else.
 */
export function customEntryKind(host: string, value: string): EntryRead | null {
  const { kind, rest } = unmarked(value);
  const script = customEntryScript(host, rest);
  return script === null ? null : { kind, script };
}

/** A label that reads as a number, as `is_number` in `podster_core::hostnames`: decimal, or `0x` hexadecimal. */
const NUMBER_LABEL = /^(?:[0-9]+|0[xX][0-9a-fA-F]*)$/;

/**
 * A host as `podster_core::hostnames::normalize` writes one, so this never reads an entry for a name Rust never writes:
 * lower case, no trailing dot, labels of 1 to 63 letters, digits and hyphens that neither begin nor end with a hyphen,
 * not an IP address (no last label that reads as a number), and unchanged by the URL parser, which also refuses
 * punycode that doesn't decode. A second check of what was read, never the authority.
 */
export function isWrittenHost(host: string): boolean {
  if (!isHost(host)) return false;
  const labels = host.split(".");
  if (!labels.every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) return false;
  if (NUMBER_LABEL.test(labels[labels.length - 1])) return false;
  try {
    return new URL(`https://${host}/`).hostname === host;
  } catch {
    return false;
  }
}

/** The label a script's name begins with, or null if it isn't a script's name. */
export function scriptLabel(script: string): string | null {
  return isScriptName(script) ? script.slice(0, script.indexOf(".")) : null;
}

/**
 * A host as the private API writes one as a key: lower-case letters, digits, `-` and `.`, with a `.` inside it, no
 * longer than a hostname may be, and no empty label. Anything else is never looked up.
 */
export function isHost(host: string): boolean {
  return host.length >= 4 && host.length <= 253 && /^[a-z0-9.-]+$/.test(host) && host.includes(".") && !host.startsWith(".") && !host.endsWith(".") && !host.includes("..");
}
