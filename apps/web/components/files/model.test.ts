import { describe, expect, it } from "vitest";
import { toResult } from "@/lib/gateway/result";
import { explainLink, explainUpload, mayManageAssets } from "./model";

describe("refusals", () => {
  it("says what each upload refusal means", () => {
    expect(explainUpload("file_too_large", 413)).toMatch(/over 100 MB/);
    expect(explainUpload("executable_refused", 415)).toMatch(/programs, installers/);
    expect(explainUpload("room_quota_exceeded", 409)).toMatch(/5 GB/);
    expect(explainUpload("participant_quota_exceeded", 409)).toMatch(/1 GB.*Nothing was uploaded/);
    expect(explainUpload("rate_limited", 429, 12)).toMatch(/Wait 12 seconds/);
    expect(explainUpload("rate_limited", 429)).toMatch(/Wait a minute/);
    expect(explainUpload("something_new", 415)).toMatch(/isn't accepted/);
  });

  it("says what each attach refusal means", () => {
    expect(explainLink("file_not_available", 409)).toMatch(/scanning or ready/);
    expect(explainLink("task_closed", 409)).toMatch(/completed or canceled/);
    expect(explainLink("file_removed", 409)).toMatch(/was removed from the workroom/);
    expect(explainLink("limit_exceeded", 409)).toMatch(/50 files/);
    expect(explainLink("rate_limited", 429, 1)).toMatch(/Wait 1 second and/);
    expect(explainLink("whatever", 429, 3)).toMatch(/Wait 3 seconds/);
  });

  it("carries the server's retry-after, in whole seconds only", async () => {
    const limited = (value: string) => new Response(JSON.stringify({ error: { code: "rate_limited" } }), { status: 429, headers: { "retry-after": value } });
    expect(await toResult(limited("30"))).toEqual({ ok: false, status: 429, code: "rate_limited", retryAfter: 30 });
    expect(await toResult(limited("soon"))).toEqual({ ok: false, status: 429, code: "rate_limited" });
  });
});

it("offers upload controls only to the roles that may upload", () => {
  expect(["owner", "admin", "member"].every(mayManageAssets)).toBe(true);
  expect([undefined, "guest", "none"].some(mayManageAssets)).toBe(false);
});
