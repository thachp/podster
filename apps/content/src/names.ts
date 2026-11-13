// The two names the content Worker reads, and their forms. Both are decided in Rust, by the private API, which is
// the only writer of the serve entries' namespace: `podster_core::release::script_owner` for a script's name, and
// `apps/api/src/content_provider.rs` for the stop key and for what a host may look like. This is a second check of
// what was read, never the authority. `packages/contracts/serve-entry.fixture.json` holds the vectors both sides
// are tested against.

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
