import { describe, expect, it } from "vitest";
import { allowedPassthrough, passthroughHeaders } from "../src/index";

// The dashboard's passthrough to the API translates only: a custom hostname's "Check now" (2026-11-27) is one more room
// path the API decides, and its refusal to be asked again too soon keeps the API's `Retry-After`, and nothing else.
describe("the dashboard passthrough's headers", () => {
  it("passes a custom hostname's Check now through to the API", () => {
    expect(allowedPassthrough("/v1/workspaces/ws_1/app-hostname/check")).toBe(true);
  });

  it("keeps Retry-After on a 429 only, in whole seconds, and drops every other header the API set", () => {
    const answer = (status: number, headers: Record<string, string>) => new Response("{}", { status, headers });
    expect(passthroughHeaders(answer(429, { "retry-after": "17", "x-other": "1", "set-cookie": "a=b" }))).toEqual({ "content-type": "application/json", "retry-after": "17" });
    expect(passthroughHeaders(answer(200, { "retry-after": "17" }))).toEqual({ "content-type": "application/json" });
    expect(passthroughHeaders(answer(409, { "retry-after": "17" }))).toEqual({ "content-type": "application/json" });
    for (const odd of ["", "1.5", "-1", "Wed, 21 Oct 2026 07:28:00 GMT", "123456"]) {
      expect(passthroughHeaders(answer(429, { "retry-after": odd })), JSON.stringify(odd)).toEqual({ "content-type": "application/json" });
    }
  });
});
