import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import fixture from "../../../packages/contracts/serve-entry.fixture.json";
import { sandboxPolicy } from "../src/handle";
import * as preview from "../src/preview";
import { accessOriginFromSetting, base64url, checkClaims, constantTimeEqual, type Claims, type Presented, cookiePairs, fromBase64url, gateCookies, isPodsterPath, isStateHash, nextRound, payloadJson, PREVIEW_SANDBOX, previewEntry, previewSandboxPolicy, publicKeysFromSetting, readPayload, readState, refusalCode, returnPathOk, stateHash, verifiedClaims, webCryptoKeys, writeAllowed, writeState } from "../src/preview";

// `src/preview.ts` is a mirror of `podster_core::preview_access` and of `serve_entry`'s preview form (M8 step 8). The
// first block binds it to the Rust source, constant by constant, so neither can change alone; the rest runs core's own
// cases against the copy, and the fixture's vectors, which core and the API's tests read too.

const RUST = readFileSync(new URL("../../../crates/core/src/preview_access.rs", import.meta.url), "utf8");
const RUST_PREVIEW = readFileSync(new URL("../../../crates/core/src/preview.rs", import.meta.url), "utf8");
const RUST_ENTRY = readFileSync(new URL("../../../crates/core/src/serve_entry.rs", import.meta.url), "utf8");
const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const RUST_TREE = readFileSync(new URL("../../../crates/core/src/release_tree.rs", import.meta.url), "utf8");

const rustConst = (source: string, name: string) => {
  const line = source.split("\n").find((l) => l.startsWith(`pub const ${name}: `));
  if (!line) throw new Error(`${name} isn't in the Rust source`);
  return line.slice(line.indexOf("=") + 1, line.lastIndexOf(";")).trim();
};
/** A Rust constant's value: a string literal's text, or an integer expression of literals and constants named here. */
const rustValue = (source: string, name: string, known: Record<string, number> = {}): string | number => {
  const text = rustConst(source, name);
  if (text.startsWith('"')) return JSON.parse(text);
  const expression = text.replace(/[A-Z][A-Z0-9_]+/g, (word) => String(known[word] ?? NaN)).replace(/_/g, "");
  if (!/^[0-9 *+/()-]+$/.test(expression)) throw new Error(`${name}: ${text}`);
  return Function(`return (${expression});`)() as number;
};

describe("bound to the Rust source", () => {
  it("has core's constants, each exactly", () => {
    const ttl = { TICKET_TTL_MS: rustValue(RUST, "TICKET_TTL_MS") as number, SESSION_MAX_TTL_MS: rustValue(RUST, "SESSION_MAX_TTL_MS") as number };
    const expected: Record<string, string | number> = {
      TICKET_TTL_MS: ttl.TICKET_TTL_MS,
      SESSION_MAX_TTL_MS: ttl.SESSION_MAX_TTL_MS,
      MARKER_TTL_MS: rustValue(RUST, "MARKER_TTL_MS"),
      SESSION_COOKIE: rustValue(RUST, "SESSION_COOKIE"),
      STATE_COOKIE: rustValue(RUST, "STATE_COOKIE"),
      STATE_COOKIE_MAX_AGE_S: rustValue(RUST, "STATE_COOKIE_MAX_AGE_S"),
      SESSION_COOKIE_MAX_AGE_S: rustValue(RUST, "SESSION_COOKIE_MAX_AGE_S", ttl),
      LOOP_GUARD_ROUNDS: rustValue(RUST, "LOOP_GUARD_ROUNDS"),
      LOOP_GUARD_WINDOW_MS: rustValue(RUST, "LOOP_GUARD_WINDOW_MS"),
      MAX_RETURN_PATH_LEN: rustValue(RUST, "MAX_RETURN_PATH_LEN"),
      SESSION_ID_PREFIX: rustValue(RUST, "SESSION_ID_PREFIX"),
      MAX_KEY_ID_LEN: rustValue(RUST, "MAX_KEY_ID_LEN"),
      TOKEN_SIGNING_PREFIX: rustValue(RUST, "TOKEN_SIGNING_PREFIX"),
      ENTER_PATH: rustValue(RUST, "ENTER_PATH"),
      SLOT_ID_PREFIX: rustValue(RUST_PREVIEW, "SLOT_ID_PREFIX"),
      MAX_ACCESS_EPOCH: rustValue(RUST_PREVIEW, "MAX_ACCESS_EPOCH"),
      PREVIEW_MARK: rustValue(RUST_ENTRY, "PREVIEW_MARK"),
      MARKER_PATH: rustValue(RUST_TREE, "MARKER_PATH"),
    };
    for (const [name, value] of Object.entries(expected)) expect((preview as Record<string, unknown>)[name], name).toBe(value);
    expect(fixture.preview_mark).toBe(preview.PREVIEW_MARK);
  });

  it("refuses for core's reasons, by core's codes", () => {
    const names = [...RUST.slice(RUST.indexOf("pub enum TokenRefusal")).slice(0, 2000).matchAll(/^    ([A-Z][A-Za-z]+),$/gm)].map((match) => match[1]);
    expect(names).toEqual(["WrongType", "WrongAudience", "WrongSlot", "Expired", "EpochBelow", "StateMismatch", "MarkerOnly", "Malformed"]);
    expect(RUST).toContain('TokenRefusal::Expired => "preview_session_expired",');
    expect(RUST).toContain('_ => "preview_access_required",');
    for (const name of names) expect(refusalCode(name as never), name).toBe(name === "Expired" ? "preview_session_expired" : "preview_access_required");
    // Core's check is in this order; the copy checks in the same order (each case below changes one claim).
    const order = ["Malformed", "WrongType", "WrongAudience", "WrongSlot", "Expired", "EpochBelow", "StateMismatch|MarkerOnly"];
    const body = RUST.slice(RUST.indexOf("pub fn check_claims("), RUST.indexOf("// The two cookies"));
    const at = order.map((name) => Math.min(...name.split("|").map((n) => body.indexOf(`TokenRefusal::${n}`))));
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    expect(at.every((n) => n > 0)).toBe(true);
  });

  it("reads a payload in exactly the form core writes", () => {
    // Core's own test of the form, its key order and its format strings.
    expect(RUST).toContain(`r#"{{"typ":"{}","kid":"{}","aud":"{}","pvw":"{}""#`);
    expect(RUST).toContain(`json.push_str(&format!(r#","sid":"{sid}""#));`);
    expect(RUST).toContain(`r#","ep":{},"iat":{},"exp":{}"#`);
    expect(RUST).toContain(`json.push_str(&format!(r#","st":"{st}""#));`);
    const claims: Claims = { typ: "ticket", kid: "k1", aud: "abc.apps.example", pvw: `pvw_${"0".repeat(32)}`, sid: `pvs_${"1".repeat(32)}`, ep: 3, iat: 1_800_000_000_000, exp: 1_800_000_060_000, st: "47DEQpj8HBSa-_TImW-5JCeuQeRkm5NMpJWZG3hSuFU" };
    const json = payloadJson(claims);
    expect(json).toBe(`{"typ":"ticket","kid":"k1","aud":"abc.apps.example","pvw":"pvw_${"0".repeat(32)}","sid":"pvs_${"1".repeat(32)}","ep":3,"iat":1800000000000,"exp":1800000060000,"st":"47DEQpj8HBSa-_TImW-5JCeuQeRkm5NMpJWZG3hSuFU"}`);
    expect(readPayload(json)).toEqual(claims);
    const marker: Claims = { ...claims, typ: "marker", sid: null, st: null };
    expect(payloadJson(marker)).toBe(`{"typ":"marker","kid":"k1","aud":"abc.apps.example","pvw":"pvw_${"0".repeat(32)}","ep":3,"iat":1800000000000,"exp":1800000060000}`);
    expect(readPayload(payloadJson(marker))).toEqual(marker);
    // Any other spelling of the same claims is no payload.
    for (const other of [json.replaceAll('"ep":3', '"ep":3.0'), json.replaceAll('"ep":3', '"ep": 3'), `${json.slice(0, -1)},"x":1}`, `${json} `, json.replaceAll('"typ":"ticket"', '"typ":"Ticket"'), payloadJson({ ...claims, typ: "marker" }), payloadJson({ ...marker, typ: "session" }), json.replaceAll('"ep":3', '"ep":-1'), json.replaceAll("k1", "k 1"), json.replaceAll("abc.apps.example", "ABC.apps.example")]) {
      expect(readPayload(other), other).toBeNull();
    }
  });
});

describe("forms", () => {
  it("compares a state hash in constant time, as core does, and exactly", () => {
    expect(RUST).toContain("constant_time_eq(sent.as_bytes(), signed.as_bytes())");
    expect(read("src/preview.ts")).toContain("!constantTimeEqual(presented.stateHash, claims.st)");
    for (const [a, b, same] of [["", "", true], ["abc", "abc", true], ["abc", "abd", false], ["xbc", "abc", false], ["ab", "abc", false]] as const) expect(constantTimeEqual(a, b), `${a} ${b}`).toBe(same);
  });

  it("reads base64url in its one canonical spelling only", () => {
    for (const length of [0, 1, 2, 3, 31, 32, 33, 64]) {
      const bytes = Uint8Array.from({ length }, (_, i) => (i * 37 + 11) & 255);
      const text = base64url(bytes);
      expect(text, String(length)).toBe(Buffer.from(bytes).toString("base64url"));
      expect(fromBase64url(text), String(length)).toEqual(bytes);
    }
    for (const bad of ["A", "AB=", "AB+C", "AB/C", "A B", "AF"]) expect(fromBase64url(bad), bad).toBeNull();
  });

  it("holds a state hash to core's canonical form", () => {
    expect(isStateHash("47DEQpj8HBSa-_TImW-5JCeuQeRkm5NMpJWZG3hSuFU")).toBe(true);
    for (const bad of ["", "47DEQpj8HBSa-_TImW-5JCeuQeRkm5NMpJWZG3hSuF", "47DEQpj8HBSa-_TImW-5JCeuQeRkm5NMpJWZG3hSuFUU", "47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU", "47DEQpj8HBSa-_TImW-5JCeuQeRkm5NMpJWZG3hSuFV", "47DEQpj8HBSa-_TImW-5JCeuQeRkm5NMpJWZG3hSuF "]) expect(isStateHash(bad), bad).toBe(false);
  });

  it("hashes the state's random part to a canonical state hash, as SHA-256 in base64url", async () => {
    const random = "A".repeat(42) + "E";
    const hash = await stateHash(random);
    expect(hash).toBe(createHash("sha256").update(random).digest("base64url"));
    expect(isStateHash(hash)).toBe(true);
  });

  it("reads a return path as core does", () => {
    for (const good of ["/", "/a", "/a/b?c=d", "/?x=%2F", "/a#frag", `/${"a".repeat(2047)}`]) expect(returnPathOk(good), good).toBe(true);
    for (const bad of ["", "a", "//evil.example", "/\\evil.example", "https://evil.example/", "/a\nb", "/a\rb", "/a\u0000", " /a", "/a b", "\\/a", `/${"a".repeat(2048)}`, "/é"]) expect(returnPathOk(bad), JSON.stringify(bad)).toBe(false);
  });

  it("knows Podster's prefix in any case, and nothing that only begins like it", () => {
    for (const path of ["/__podster", "/__podster/", "/__podster/enter", "/__PODSTER/enter", "/__Podster/a/b"]) expect(isPodsterPath(path), path).toBe(true);
    for (const path of ["/", "/__podsterx", "/__podster.json", "/_podster/enter", "/a/__podster/enter", "/%5F%5Fpodster/enter"]) expect(isPodsterPath(path), path).toBe(false);
  });
});

describe("the serve entry's preview form, by the fixture's vectors", () => {
  it("reads every valid preview entry, and refuses every invalid one and every production one", () => {
    expect(fixture.valid_preview_entries.length).toBeGreaterThanOrEqual(5);
    for (const value of fixture.valid_preview_entries) {
      const read = previewEntry(value);
      const [, slot, epoch, ...rest] = value.split(":");
      const form = rest.join(":");
      expect(read, value).toEqual({ slot, epoch: Number(epoch), kind: form.startsWith("code:") ? "code" : "static", script: form.replace(/^code:/, "") });
    }
    for (const value of [...fixture.invalid_preview_entries, ...fixture.valid_script_names, ...fixture.valid_code_entries, ...fixture.valid_custom_entries, ...fixture.valid_preview_custom_entries]) {
      expect(previewEntry(value), JSON.stringify(value)).toBeNull();
    }
  });
});

describe("core's cases, against the copy", () => {
  const HOST = "abc.apps.example";
  const SLOT = `pvw_${"0".repeat(32)}`;
  const ST = "47DEQpj8HBSa-_TImW-5JCeuQeRkm5NMpJWZG3hSuFU";
  const NOW = 1_800_000_000_000;
  const ticket: Claims = { typ: "ticket", kid: "k1", aud: HOST, pvw: SLOT, sid: `pvs_${"1".repeat(32)}`, ep: 3, iat: NOW, exp: NOW + 60_000, st: ST };
  const at = (now = NOW + 1): Presented => ({ host: HOST, now, entrySlot: SLOT, entryEpoch: 3, stateHash: ST, path: "/__podster/enter", method: "POST" });

  it("passes a fresh ticket, and refuses one claim changed at a time with core's reason", () => {
    expect(checkClaims(ticket, "ticket", at())).toBeNull();
    const cases: [Claims, string, Presented][] = [
      [{ ...ticket, exp: ticket.iat }, "Malformed", at()],
      [{ ...ticket, exp: ticket.iat + 60_001 }, "Malformed", at()],
      [{ ...ticket, sid: null }, "Malformed", at()],
      [{ ...ticket, st: "x" }, "Malformed", at()],
      [ticket, "WrongType", at()],
      [{ ...ticket, aud: "abd.apps.example" }, "WrongAudience", at()],
      [{ ...ticket, pvw: `pvw_${"f".repeat(32)}` }, "WrongSlot", at()],
      [ticket, "Expired", at(NOW + 60_000)],
      [{ ...ticket, ep: 2 }, "EpochBelow", at()],
      [ticket, "StateMismatch", { ...at(), stateHash: null }],
      [ticket, "StateMismatch", { ...at(), stateHash: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" }],
    ];
    for (const [claims, reason, presented] of cases) expect(checkClaims(claims, reason === "WrongType" ? "session" : "ticket", presented), reason).toBe(reason);
    // A host entry naming a slot of no form honours nothing.
    expect(checkClaims(ticket, "ticket", { ...at(), entrySlot: "pvw_x" })).toBe("WrongSlot");
    // A marker token, for the marker's path with GET only.
    const marker: Claims = { ...ticket, typ: "marker", sid: null, st: null };
    expect(checkClaims(marker, "marker", { ...at(), path: "/.well-known/podster-release.json", method: "GET", stateHash: null })).toBeNull();
    for (const [path, method] of [["/", "GET"], ["/.well-known/podster-release.json", "HEAD"], ["/.well-known/podster-release.json/", "GET"]]) expect(checkClaims(marker, "marker", { ...at(), path, method }), `${method} ${path}`).toBe("MarkerOnly");
    expect(checkClaims({ ...marker, st: ST }, "marker", at())).toBe("Malformed");
  });

  it("reads only the two exact names, ignores case variants and nameless cookies, and refuses a second of an exact name", () => {
    expect(gateCookies([["__Host-podster_preview", "s"], ["__Host-podster_preview_state", "t"]])).toEqual({ session: "s", state: "t" });
    expect(gateCookies([["__HOST-podster_preview", "x"], ["__host-podster_preview_state", "y"], ["", "z"], ["__Host-podster_preview", "s"]])).toEqual({ session: "s", state: null });
    for (const name of ["__Host-podster_preview", "__Host-podster_preview_state"]) {
      expect(gateCookies([[name, "a"], ["x", "y"], [name, "b"]]), name).toBe("duplicate");
      expect(gateCookies([[name, "a"], [name, "a"]]), name).toBe("duplicate");
    }
    // The header, as a browser sends it: a pair with no `=` is a nameless cookie; the first `=` ends a name.
    expect(cookiePairs("a=1; lone; =v; b = 2 ;__Host-podster_preview=x=y")).toEqual([["a", "1"], ["", "lone"], ["", "v"], ["b", "2"], ["__Host-podster_preview", "x=y"]]);
    expect(cookiePairs(null)).toEqual([]);
  });

  it("allows reads, and a write only with Sec-Fetch-Site same-origin, Origin only when that header is absent", () => {
    for (const method of ["GET", "HEAD", "OPTIONS"]) expect(writeAllowed(method, "cross-site", null, HOST), method).toBe(true);
    for (const method of ["POST", "PUT", "PATCH", "DELETE", "get", "PROPFIND"]) {
      expect(writeAllowed(method, "same-origin", null, HOST), method).toBe(true);
      expect(writeAllowed(method, "same-origin", "null", HOST), method).toBe(true);
      for (const site of ["same-site", "cross-site", "none", "Same-Origin", ""]) expect(writeAllowed(method, site, `https://${HOST}`, HOST), `${method} ${site}`).toBe(false);
      expect(writeAllowed(method, null, `https://${HOST}`, HOST), method).toBe(true);
      for (const origin of [null, "null", `http://${HOST}`, `https://${HOST}.`, `https://x.${HOST}`, `https://${HOST}:443`]) expect(writeAllowed(method, null, origin, HOST), `${method} ${origin}`).toBe(false);
    }
    expect(writeAllowed("POST", null, "https://", "")).toBe(false);
  });

  it("stops the flow after its second round within a minute, as core's next_round", () => {
    expect(nextRound(null, NOW)).toEqual({ count: 1, firstAt: NOW });
    expect(nextRound({ count: 1, firstAt: NOW }, NOW + 59_999)).toEqual({ count: 2, firstAt: NOW });
    expect(nextRound({ count: 2, firstAt: NOW }, NOW + 59_999)).toBe("stop");
    expect(nextRound({ count: 2, firstAt: NOW }, NOW + 60_000)).toEqual({ count: 1, firstAt: NOW + 60_000 });
    expect(nextRound({ count: 2, firstAt: NOW + 10_000 }, NOW)).toBe("stop");
  });

  it("writes the state cookie's round record beside its random part, and reads back only that form", () => {
    const random = "A".repeat(42) + "E";
    for (const state of [{ random, rounds: null }, { random, rounds: { count: 1, firstAt: NOW } }, { random, rounds: { count: 2, firstAt: 0 } }]) expect(readState(writeState(state))).toEqual(state);
    for (const bad of ["", "A".repeat(42) + "F", "A".repeat(44), `${random}.3.${NOW}`, `${random}.0.${NOW}`, `${random}.1`, `${random}.1.01`, `${random}.1.-1`, `${random} `, `${random}.1.${NOW}.x`]) expect(readState(bad), bad).toBeNull();
  });
});

describe("signatures and configuration", () => {
  it("verifies Ed25519 over the label and the payload with the public key its kid names, and nothing else", async () => {
    const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
    const hex = Buffer.from(await crypto.subtle.exportKey("raw", pair.publicKey)).toString("hex");
    const claims: Claims = { typ: "session", kid: "k1", aud: "abc.apps.example", pvw: `pvw_${"0".repeat(32)}`, sid: `pvs_${"1".repeat(32)}`, ep: 3, iat: 1, exp: 2, st: "47DEQpj8HBSa-_TImW-5JCeuQeRkm5NMpJWZG3hSuFU" };
    const payload = Buffer.from(payloadJson(claims)).toString("base64url");
    const sign = async (message: string) => base64url(new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, pair.privateKey, new TextEncoder().encode(message))));
    const good = `${payload}.${await sign(`podster-preview-token/v1.${payload}`)}`;
    const keys = webCryptoKeys(publicKeysFromSetting(`k1:${hex}`) as Map<string, Uint8Array<ArrayBuffer>>);
    expect(await verifiedClaims(good, keys)).toEqual(claims);
    // Signed without the label, under another key ID, with another key, or with parts added: nothing.
    expect(await verifiedClaims(`${payload}.${await sign(payload)}`, keys)).toBeNull();
    expect(await verifiedClaims(good, webCryptoKeys(publicKeysFromSetting(`k2:${hex}`) as Map<string, Uint8Array<ArrayBuffer>>))).toBeNull();
    expect(await verifiedClaims(good, webCryptoKeys(publicKeysFromSetting(`k1:${"ab".repeat(32)}`) as Map<string, Uint8Array<ArrayBuffer>>))).toBeNull();
    for (const bad of [`${good}.x`, `.${good}`, payload, `${payload}.`, `${good}=`, good.replace(".", "..")]) expect(await verifiedClaims(bad, keys), bad.slice(-10)).toBeNull();
    // Two keys, the current and the one before, each by its own ID.
    const both = webCryptoKeys(publicKeysFromSetting(`k0:${"ab".repeat(32)},k1:${hex}`) as Map<string, Uint8Array<ArrayBuffer>>);
    expect(await verifiedClaims(good, both)).toEqual(claims);
  });

  it("reads the public keys only in their form: one or two, distinct IDs, 64 hex each", () => {
    const hex = "ab".repeat(32);
    expect([...(publicKeysFromSetting(`k1:${hex}`) ?? new Map()).keys()]).toEqual(["k1"]);
    expect([...(publicKeysFromSetting(`k1:${hex},k2:${hex.toUpperCase()}`) ?? new Map()).keys()]).toEqual(["k1", "k2"]);
    for (const bad of [undefined, null, 1, "", hex, `:${hex}`, `k 1:${hex}`, `k1:${hex.slice(2)}`, `k1:${hex}ab`, `k1:${hex},k1:${hex}`, `k1:${hex},k2:${hex},k3:${hex}`, `k1:${hex}, k2:${hex}`, `k1:${hex},`, `${"k".repeat(65)}:${hex}`, `k1:${hex.replace("a", "g")}`]) {
      expect(publicKeysFromSetting(bad), JSON.stringify(bad)).toBeNull();
    }
  });

  it("reads the application host's origin as exactly https and a host, never on the content domain", () => {
    expect(accessOriginFromSetting("https://app-staging.podster.dev", "podster.site")).toBe("https://app-staging.podster.dev");
    for (const bad of [undefined, "", "http://app.example", "https://app.example/", "https://app.example:443", "https://APP.example", "https://user@app.example", "https://podster.site", "https://x.podster.site", "https://1.2.3.4", "app.example"]) {
      expect(accessOriginFromSetting(bad, "podster.site"), String(bad)).toBeNull();
    }
  });
});

describe("the preview policy", () => {
  it("is production's, directive for directive, with the one sandbox that gives the page its origin", () => {
    const origin = "https://abc.apps.example";
    const policy = previewSandboxPolicy(sandboxPolicy(origin));
    expect(policy.split("; ").slice(1)).toEqual(sandboxPolicy(origin).split("; ").slice(1));
    expect(policy.split("; ")[0]).toBe(PREVIEW_SANDBOX);
    expect(PREVIEW_SANDBOX).toBe(`sandbox allow-scripts ${["allow", "same", "origin"].join("-")}`);
    // The production policy is untouched by it.
    expect(sandboxPolicy(origin).split("; ")[0]).toBe("sandbox allow-scripts");
    expect(() => previewSandboxPolicy("default-src 'none'")).toThrow();
  });
});
