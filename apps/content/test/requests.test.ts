import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import * as rules from "../src/requests";
import { allowedMethods, bodyWithinCap, checkPreflight, checkRequest, CODE_METHODS, forwardedHeaders, type HostKind, isJsonContentType, JSON_TYPE, MAX_WRITE_BODY_BYTES, parseContentLength, REFUSAL_STATUS, type RequestFacts, WRITE_METHODS } from "../src/requests";

// The content Worker's copy of `podster_core::app_requests` (ADR 0010's revision, sections 3.4 and 3.5). The Rust
// module is the rule; `src/requests.ts` is a mirror, because the Worker is TypeScript. The first block keeps the two
// in step by reading the Rust source; the rest runs core's own cases (`crates/core/tests/app_requests.rs`) against the
// mirror, each boundary both ways.

const RUST = readFileSync(new URL("../../../crates/core/src/app_requests.rs", import.meta.url), "utf8");

// The Rust source is read by plain string scanning, line by line, and the only regular expressions used are anchored
// character classes with a single quantifier: nothing here can backtrack.

/** The source's lines, each with its ends trimmed. */
const linesOf = (source: string) => source.split("\n").map((line) => line.trim());
const isDigits = (text: string) => /^[0-9_]+$/.test(text);
const isName = (text: string) => /^[A-Za-z0-9_]+$/.test(text);

/** Every string literal in `text`, in order, or null if a quote is left open or a literal holds a backslash. */
function stringLiterals(text: string): string[] | null {
  const found: string[] = [];
  let at = text.indexOf('"');
  while (at !== -1) {
    const close = text.indexOf('"', at + 1);
    if (close === -1) return null;
    const literal = text.slice(at + 1, close);
    if (literal.includes("\\")) return null;
    found.push(literal);
    at = text.indexOf('"', close + 1);
  }
  return found;
}

/** A Rust constant's value: a string, a list of strings, or a product of integers. Anything else fails the test. */
function rustValue(source: string): unknown {
  const text = source.trim();
  const unreadable = `unreadable: ${text}`;
  if (text.startsWith("[")) {
    if (!text.endsWith("]")) return unreadable;
    return stringLiterals(text) ?? unreadable;
  }
  if (text.startsWith('"')) {
    const literals = stringLiterals(text);
    return literals !== null && literals.length === 1 && text === `"${literals[0]}"` ? literals[0] : unreadable;
  }
  const factors = text.split("*").map((part) => part.trim());
  if (factors.every(isDigits)) return factors.reduce((product, part) => product * Number(part.replaceAll("_", "")), 1);
  return unreadable;
}

/** Every `pub const` at the start of a line, with its value, which may run over several lines to its `;`. */
function rustConstantsOf(source: string): Record<string, unknown> {
  const constants: Record<string, unknown> = {};
  const lines = source.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    if (!lines[index].startsWith("pub const ")) continue;
    let text = lines[index];
    while (!text.trimEnd().endsWith(";") && index + 1 < lines.length) text += `\n${lines[(index += 1)]}`;
    const colon = text.indexOf(":");
    const equals = text.indexOf("=");
    const name = text.slice("pub const ".length, colon);
    if (colon === -1 || equals < colon || !isName(name)) constants[`unreadable ${index}`] = `unreadable: ${text}`;
    else constants[name] = rustValue(text.trimEnd().slice(equals + 1, -1));
  }
  return constants;
}

/** How many lines start a `pub const`, counted apart from the reader above. */
const constantLines = (source: string) => source.split("\n").filter((line) => line.startsWith("pub const ")).length;

const rustConstants = rustConstantsOf(RUST);
const tsConstants = Object.fromEntries(Object.entries(rules).filter(([name]) => /^[A-Z0-9_]+$/.test(name) && name !== "REFUSAL_STATUS").map(([name, value]) => [name, Array.isArray(value) ? [...value] : value]));

/** Each variant's code, from a `code()` arm such as `Enum::Variant => "code",`, by enum. */
function rustCodes(enumName: string): Record<string, string> {
  const codes: Record<string, string> = {};
  const prefix = `${enumName}::`;
  for (const line of linesOf(RUST)) {
    if (!line.startsWith(prefix) || !line.endsWith('",')) continue;
    const arrow = line.indexOf(' => "');
    if (arrow === -1) continue;
    const variant = line.slice(prefix.length, arrow);
    const code = line.slice(arrow + ' => "'.length, -'",'.length);
    expect(isName(variant) && /^[a-z_]+$/.test(code), line).toBe(true);
    codes[variant] = code;
  }
  return codes;
}

/** Each refusal's status, from `status()`'s arms, such as `A | B => 403,`, an arm's variants on one or more lines. */
function rustStatuses(source: string): Record<string, number> {
  const body = source.slice(source.indexOf("pub fn status(self)"), source.indexOf("/// The methods a host takes"));
  expect(body.length).toBeGreaterThan(0);
  const statuses: Record<string, number> = {};
  let pending: string[] = [];
  for (const line of linesOf(body)) {
    if (!line.startsWith("RequestRefusal::") && !line.startsWith("| RequestRefusal::")) continue;
    const arrow = line.indexOf("=>");
    const left = arrow === -1 ? line : line.slice(0, arrow);
    for (const part of left.split("|").map((piece) => piece.trim()).filter((piece) => piece !== "")) {
      expect(part.startsWith("RequestRefusal::") && isName(part.slice("RequestRefusal::".length)), line).toBe(true);
      pending.push(part.slice("RequestRefusal::".length));
    }
    if (arrow === -1) continue;
    const status = line.slice(arrow + 2).trim().replace(/,$/, "");
    expect(/^[0-9]{3}$/.test(status), line).toBe(true);
    for (const variant of pending) statuses[variant] = Number(status);
    pending = [];
  }
  expect(pending).toEqual([]);
  return statuses;
}

describe("the mirror keeps step with crates/core", () => {
  it("has every constant of app_requests.rs, with the same value, and no other", () => {
    // The reader found them all: a change of form in the Rust file fails here rather than passing with fewer.
    expect(Object.keys(rustConstants).length).toBe(11);
    expect(Object.keys(rustConstants).length).toBe(constantLines(RUST));
    for (const [name, value] of Object.entries(rustConstants)) expect(String(value).startsWith("unreadable"), name).toBe(false);
    expect(tsConstants).toEqual(rustConstants);
    expect(MAX_WRITE_BODY_BYTES).toBe(65_536);
  });

  it("has every refusal code and status, and no other", () => {
    const requestCodes = rustCodes("RequestRefusal");
    expect(Object.keys(requestCodes).length).toBe(6);
    // Statuses, from `status()`: each arm names one or more variants, and every variant has one.
    const byVariant = rustStatuses(RUST);
    expect(Object.keys(byVariant).sort()).toEqual(Object.keys(requestCodes).sort());
    const statuses = Object.fromEntries(Object.entries(byVariant).map(([variant, status]) => [requestCodes[variant], status]));
    expect(REFUSAL_STATUS).toEqual(statuses);
    expect(Object.keys(statuses).sort()).toEqual(Object.values(requestCodes).sort());
    // The preflight's codes, against every code the mirror can give.
    const preflightCodes = Object.values(rustCodes("PreflightRefusal")).sort();
    expect(preflightCodes).toEqual(["preflight_header", "preflight_method", "preflight_no_method", "preflight_not_code"]);
    const given = new Set<string>();
    for (const [kind, method, headers] of [["static", "POST", null], ["code", null, null], ["code", "TRACE", null], ["code", "POST", "x"]] as [HostKind, string | null, string | null][]) {
      const checked = checkPreflight(kind, method, headers);
      if (!checked.ok) given.add(checked.refusal);
    }
    expect([...given].sort()).toEqual(preflightCodes);
  });

  it("shows the reader would see a drift: a changed constant fails the comparison", () => {
    // A control for the check above: the same comparison, against the Rust source with one figure changed.
    const changed = RUST.replace("pub const MAX_WRITE_BODY_BYTES: u64 = 64 * 1024;", "pub const MAX_WRITE_BODY_BYTES: u64 = 64 * 1025;");
    expect(changed).not.toBe(RUST);
    expect(rustConstantsOf(changed)).not.toEqual(tsConstants);
    // And a changed list, a changed string, and a constant added on the Rust side, each caught the same way.
    for (const [from, to] of [['"GET", "HEAD"]', '"GET", "HEAD", "PUT"]'], ['pub const JSON_TYPE: &str = "application/json";', 'pub const JSON_TYPE: &str = "application/jsonx";'], ["pub const JSON_TYPE", "pub const EXTRA: &str = \"x\";\npub const JSON_TYPE"]]) {
      const drifted = RUST.replace(from, to);
      expect(drifted, from).not.toBe(RUST);
      expect(rustConstantsOf(drifted), from).not.toEqual(tsConstants);
    }
    // The status reader sees a changed status, and an arm split over two lines reads the same.
    const read = { MethodNotAllowed: 405, ServiceWorker: 403, Upgrade: 403, NotJson: 415, BadLength: 400, TooLarge: 413 };
    expect(rustStatuses(RUST)).toEqual(read);
    const changedStatus = RUST.replace("RequestRefusal::TooLarge => 413,", "RequestRefusal::TooLarge => 414,");
    expect(changedStatus).not.toBe(RUST);
    expect(rustStatuses(changedStatus)).toEqual({ ...read, TooLarge: 414 });
    const split = RUST.replace("RequestRefusal::ServiceWorker | RequestRefusal::Upgrade => 403,", "RequestRefusal::ServiceWorker\n            | RequestRefusal::Upgrade => 403,");
    expect(split).not.toBe(RUST);
    expect(rustStatuses(split)).toEqual(read);
  });
});

const req = (method: string, more: Partial<RequestFacts> = {}): RequestFacts => ({ method, contentType: null, contentLength: null, serviceWorker: false, upgrade: false, ...more });
const write = (method: string, contentType: string, more: Partial<RequestFacts> = {}) => req(method, { contentType, ...more });
const ok = (value: string) => ({ ok: true, value });
const no = (refusal: string) => ({ ok: false, refusal });

describe("the rule, as core has it", () => {
  it("a static host takes GET and HEAD only", () => {
    for (const method of ["GET", "HEAD"]) expect(checkRequest("static", req(method))).toEqual(ok("read"));
    for (const method of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS", "TRACE", "CONNECT", "get", ""]) expect(checkRequest("static", write(method, JSON_TYPE)), method).toEqual(no("method_not_allowed"));
    expect(allowedMethods("static")).toEqual(["GET", "HEAD"]);
  });

  it("a host with code also takes JSON writes and its own preflight, and compares methods exactly", () => {
    for (const method of ["GET", "HEAD"]) expect(checkRequest("code", req(method))).toEqual(ok("read"));
    for (const method of WRITE_METHODS) expect(checkRequest("code", write(method, JSON_TYPE)), method).toEqual(ok("write"));
    expect(checkRequest("code", req("OPTIONS"))).toEqual(ok("preflight"));
    expect(allowedMethods("code")).toEqual(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"]);
    for (const method of ["patch", "Post", "delete", "put", "TRACE", "CONNECT", "PROPFIND", "options", " GET", ""]) expect(checkRequest("code", write(method, JSON_TYPE)), JSON.stringify(method)).toEqual(no("method_not_allowed"));
  });

  it("refuses a write without JSON, and takes JSON in its allowed forms", () => {
    const refused = ["text/plain", "text/plain;charset=UTF-8", "application/x-www-form-urlencoded", "multipart/form-data; boundary=x", "", "application/jsonx", "application/json5", "application/ld+json", "application/problem+json", "text/json", "application/json, text/plain", "text/plain, application/json", "text/plain; x=application/json", "application/json; charset=latin1", "application/json; charset=utf-8; x=y", "application/json; boundary=x", "application/json;", "application/ json", "application/json\u00a0", "\u00a0application/json", "application/json\n"];
    for (const method of WRITE_METHODS) {
      expect(checkRequest("code", req(method)), `${method} with no type`).toEqual(no("write_not_json"));
      for (const type of refused) expect(checkRequest("code", write(method, type)), `${method} ${JSON.stringify(type)}`).toEqual(no("write_not_json"));
    }
    for (const type of ["application/json", "Application/JSON", " application/json ", "application/json;charset=utf-8", "application/json; charset=UTF-8", "application/json ;\tcharset=utf-8", 'application/json; charset="utf-8"']) expect(isJsonContentType(type), JSON.stringify(type)).toBe(true);
  });

  it("holds the body cap at its boundary: at, one under, one over", () => {
    const withLength = (length: string) => checkRequest("code", write("POST", JSON_TYPE, { contentLength: length }));
    expect([withLength(String(MAX_WRITE_BODY_BYTES - 1)), withLength(String(MAX_WRITE_BODY_BYTES)), withLength(String(MAX_WRITE_BODY_BYTES + 1))]).toEqual([ok("write"), ok("write"), no("write_too_large")]);
    expect([withLength("0"), withLength("18446744073709551615")]).toEqual([ok("write"), no("write_too_large")]);
    expect([bodyWithinCap(MAX_WRITE_BODY_BYTES - 1), bodyWithinCap(MAX_WRITE_BODY_BYTES), bodyWithinCap(MAX_WRITE_BODY_BYTES + 1), bodyWithinCap(0)]).toEqual([true, true, false, true]);
    // A write with no length passes here, and its body is counted as it streams (the handler's test shows that).
    expect(checkRequest("code", write("PATCH", JSON_TYPE))).toEqual(ok("write"));
  });

  it("reads a Content-Length strictly, to u64's largest value and not one past it", () => {
    for (const value of ["", " 10", "10 ", "+10", "-1", "1e3", "0x10", "10, 10", "1.0", "١٠", "18446744073709551616", "000000000000000000001", "99999999999999999999"]) {
      expect(checkRequest("code", write("PUT", JSON_TYPE, { contentLength: value })), JSON.stringify(value)).toEqual(no("write_bad_length"));
    }
    expect([parseContentLength("00000000000000000001"), parseContentLength("18446744073709551615"), parseContentLength("18446744073709551614"), parseContentLength("18446744073709551616")]).toEqual([1n, 2n ** 64n - 1n, 2n ** 64n - 2n, null]);
  });

  it("refuses service workers and upgrades on every host and method, service workers first", () => {
    for (const kind of ["static", "code"] as HostKind[]) {
      for (const method of ["GET", "HEAD", "POST", "OPTIONS"]) {
        expect(checkRequest(kind, write(method, JSON_TYPE, { serviceWorker: true })), `${kind} ${method}`).toEqual(no("no_service_workers"));
        expect(checkRequest(kind, write(method, JSON_TYPE, { upgrade: true })), `${kind} ${method}`).toEqual(no("no_upgrade"));
        expect(checkRequest(kind, write(method, JSON_TYPE, { serviceWorker: true, upgrade: true }))).toEqual(no("no_service_workers"));
      }
    }
  });

  it("sends the body's headers on only with a write, and never a cookie", () => {
    expect([...forwardedHeaders("read")]).toEqual(["accept", "if-none-match", "if-modified-since"]);
    expect([...forwardedHeaders("write")]).toEqual(["accept", "if-none-match", "if-modified-since", "content-type", "content-length"]);
    expect(forwardedHeaders("preflight")).toBe(forwardedHeaders("read"));
    for (const cls of ["read", "write", "preflight"] as const) {
      for (const name of ["cookie", "authorization", "origin", "upgrade", "service-worker", "host"]) expect(forwardedHeaders(cls), name).not.toContain(name);
    }
  });

  it("allows a preflight for a host with code, with the origin null and fixed answers", () => {
    for (const method of CODE_METHODS) {
      for (const headers of [null, "content-type", "Content-Type", " content-type ,", "", "content-type,\tcontent-type"]) {
        expect(checkPreflight("code", method, headers), `${method} ${headers}`).toEqual({ ok: true, value: { allowOrigin: "null", allowMethods: "GET, HEAD, POST, PUT, PATCH, DELETE", allowHeaders: "content-type" } });
      }
    }
  });

  it("refuses a preflight otherwise", () => {
    expect([checkPreflight("static", "POST", "content-type"), checkPreflight("static", "GET", null)]).toEqual([no("preflight_not_code"), no("preflight_not_code")]);
    expect(checkPreflight("code", null, "content-type")).toEqual(no("preflight_no_method"));
    for (const method of ["OPTIONS", "TRACE", "CONNECT", "patch", "", "POST "]) expect(checkPreflight("code", method, null), JSON.stringify(method)).toEqual(no("preflight_method"));
    for (const headers of ["authorization", "cookie", "content-type,authorization", "x-custom", "content-type-x", "content-length", "content-type\u00a0", "ⅽontent-type"]) {
      expect(checkPreflight("code", "POST", headers), headers).toEqual(no("preflight_header"));
    }
  });
});
