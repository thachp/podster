import { describe, expect, it } from "vitest";
import { commitUrl, explainPreviewRefusal, explainPublishRefusal, failureWords, hostLink, mergedCommit, parsePreview, previewRead, previewState, shortBuild, type Preview, type PreviewRelease } from "./preview-model";

// M8 step 11: the preview read, its states and refusals, as the Ship panel says them.

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const BUILD_A = `bld_${"1a".repeat(16)}`;
const release = (over: Partial<PreviewRelease> = {}): PreviewRelease => ({ id: `rel_${"0a".repeat(16)}`, task_id: "tsk_a", commit_sha: SHA_A, state: "served", build_id: BUILD_A, storage_warning: false, requested_by: "per_o", requested_at: 1, served_at: Date.UTC(2026, 10, 27, 9), failure_code: null, finished_at: 2, ...over });
const preview = (over: Partial<Preview> = {}): Preview => ({ state: "active", serving: release(), replacement: null, default_host: "p-7f3k2q9m.podster.site", custom_host: null, ...over });

describe("the preview read", () => {
  it("reads each answer by its code, and never takes a failure or an odd shape for no preview", () => {
    expect(previewRead({ ok: true, data: { preview: null } })).toEqual({ kind: "read", preview: null });
    expect(previewRead({ ok: true, data: { preview: preview() } })).toEqual({ kind: "read", preview: preview() });
    expect(previewRead({ ok: false, status: 404, code: "not_found" })).toEqual({ kind: "unavailable" });
    expect(previewRead({ ok: false, status: 409, code: "previews_off" })).toEqual({ kind: "off" });
    expect(previewRead({ ok: false, status: 403, code: "not_allowed" })).toEqual({ kind: "hidden" });
    expect(previewRead({ ok: false, status: 503, code: "standing_unknown" })).toEqual({ kind: "failed" });
    expect(previewRead({ ok: false, status: 0, code: "read_failed" })).toEqual({ kind: "failed" });
    expect(parsePreview({})).toEqual({ kind: "failed" });
    expect(parsePreview({ preview: { ...preview(), state: "serving" } })).toEqual({ kind: "failed" });
    expect(parsePreview({ preview: preview({ serving: release({ build_id: "bld_short" }) }) })).toEqual({ kind: "failed" });
    expect(parsePreview({ preview: preview({ serving: release({ commit_sha: "abc" }) }) })).toEqual({ kind: "failed" });
    expect(parsePreview({ preview: preview({ custom_host: { hostname: "x.example.com", setup_status: "live" as never } }) })).toEqual({ kind: "failed" });
  });
});

describe("the state chip", () => {
  it("says None, Building, Ready, Replacing, Replacement failed, Failed and Deleting from the read alone", () => {
    expect(previewState(null)).toMatchObject({ state: "none", label: "None", tone: "neutral" });
    expect(previewState(preview({ serving: null, replacement: release({ state: "uploading", build_id: null }) }))).toMatchObject({ state: "building", label: "Building" });
    expect(previewState(preview())).toMatchObject({ state: "ready", label: "Ready", tone: "green" });
    for (const state of ["queued", "uploading", "uncertain", "live"] as const) expect(previewState(preview({ replacement: release({ state, commit_sha: SHA_B }) })).state).toBe("replacing");
    expect(previewState(preview({ replacement: release({ state: "failed", commit_sha: SHA_B, failure_code: "release_marker_missing" }) }))).toMatchObject({ state: "replacement-failed", label: "Replacement failed", tone: "amber" });
    expect(previewState(preview({ serving: null, replacement: release({ state: "failed" }) }))).toMatchObject({ state: "first-failed", label: "Failed", tone: "amber" });
    expect(previewState(preview({ state: "deleting" }))).toMatchObject({ state: "deleting", label: "Deleting" });
  });

  it("is amber only when something failed, the shell's one colour for needing someone", () => {
    const tones = [null, preview(), preview({ replacement: release({ state: "queued" }) }), preview({ state: "deleting" })].map((p) => previewState(p).tone);
    expect(tones).not.toContain("amber");
  });
});

describe("what the card shows", () => {
  it("shortens a build to bld_ and 8 characters, and says failures in words, or as a code only when it is one", () => {
    expect(shortBuild(BUILD_A)).toBe("bld_1a1a1a1a");
    expect(failureWords("release_marker_missing")).toMatch(/didn't answer on the preview host/);
    expect(failureWords("some_new_code")).toBe("reason code some_new_code");
    expect(failureWords("<b>no</b>")).toBe("Podster didn't say why");
    expect(failureWords(null)).toBe("Podster didn't say why");
  });

  it("links a host only when it is a plain DNS name, and a commit only in a well-formed repository", () => {
    expect(hostLink("p-7f3k2q9m.podster.site")).toBe("https://p-7f3k2q9m.podster.site/");
    for (const bad of [null, "javascript:alert(1)", "evil.example/x", "a b.example", "localhost", "EVIL.example", "x.example:8080"]) expect(hostLink(bad)).toBeNull();
    expect(commitUrl("podsterdev/hello", SHA_A)).toBe(`https://github.com/podsterdev/hello/commit/${SHA_A}`);
    expect(commitUrl("not a repo", SHA_A)).toBeNull();
    expect(commitUrl(null, SHA_A)).toBeNull();
    expect(commitUrl("podsterdev/hello", "abc")).toBeNull();
  });

  it("offers a task's commit only once Podster's merge succeeded with one", () => {
    expect(mergedCommit({ change: { merge_state: "succeeded", merge_sha: SHA_A } })).toBe(SHA_A);
    expect(mergedCommit({ change: { merge_state: "requested", merge_sha: null } })).toBeNull();
    expect(mergedCommit({ change: { merge_state: "succeeded", merge_sha: "abc" } })).toBeNull();
    expect(mergedCommit({ change: null })).toBeNull();
    expect(mergedCommit({})).toBeNull();
  });
});

describe("refusals, each saying nothing changed", () => {
  it.each([
    ["not_allowed", /owner and admins, as people/],
    ["previews_off", /switched off/],
    ["preview_in_flight", /still being made/],
    ["preview_limit", /20 asks for a day/],
    ["commit_not_releasable", /merge confirmed/],
    ["reviewer_rule_changed", /review rule changed/],
    ["release_off", /Release is off in this workroom/],
    ["workspace_archived", /archived/],
    ["standing_unknown", /couldn't check/],
  ])("preview %s", (code, words) => {
    expect(explainPreviewRefusal(code, 409)).toMatch(words);
    expect(explainPreviewRefusal(code, 409)).toMatch(/Nothing changed\./);
  });

  it.each([
    ["release_needs_public_room", /Only a public workroom can publish/],
    ["grant_required", /deployment grant/],
    ["preview_not_served", /never reached the preview/],
    ["preview_build_missing", /didn't record a build/],
    ["preview_commit_mismatch", /isn't the one asked for/],
    ["release_pending", /already waiting/],
    ["release_limit", /20 asks/],
    ["preview_in_flight", /still being made/],
  ])("publish %s", (code, words) => {
    expect(explainPublishRefusal(code, 409)).toMatch(words);
    expect(explainPublishRefusal(code, 409)).toMatch(/Nothing (new )?was asked for\.$/);
  });
});
