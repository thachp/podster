import { describe, expect, it } from "vitest";
import { safeNext } from "./safe-next";

describe("safeNext", () => {
  it.each(["/attention", "/w/ws_1/tasks?task=t_1", "/oauth/consent?client_id=x&state=y", "/claim?agent_id=a&code=b", `/oauth/consent?state=${"a".repeat(3000)}`])("keeps %s", (path) => expect(safeNext(path)).toBe(path));

  it.each([null, undefined, "", "https://evil.test", "//evil.test", "/\\evil.test", "\\\\evil.test", "javascript:alert(1)", "/sign-in?next=/attention", "/api/auth/sign-out", "/.//evil.test", "/x/..//evil.test", "/./x/../..//evil.test", "/\t/evil.test", "/\n/evil.test", "/\r/evil.test", "/\r\n/evil.test", "/" + "x".repeat(5000)])("refuses %s", (value) => expect(safeNext(value)).toBe("/attention"));

  // A line break can't reach a Location header through it, whatever comes after.
  it.each(["/w/ws_1\r\nSet-Cookie: x=1", "/w/ws_1?next=a\nb", "/w/%0d%0aSet-Cookie:x"])("keeps no line break in %j", (value) => expect(safeNext(value)).not.toMatch(/[\r\n]/));
});
