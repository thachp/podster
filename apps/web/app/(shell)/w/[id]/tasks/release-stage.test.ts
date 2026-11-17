import { describe, expect, it } from "vitest";
import { deploymentStage, parseTaskRelease, releaseHeadline, releaseSwitchedOn, RELEASE_STATUS_STATES, type TaskRelease } from "./release-stage";

const MERGED = "a1b2c3d4e5f6a7b8c9d0a1b2c3d4e5f6a7b8c9d0";
const OTHER = "ffffffffffffffffffffffffffffffffffffffff";
const URL = "https://k3v9q2.apps.example/";
const release = (over: Partial<TaskRelease> = {}): TaskRelease => ({ exists: true, release_id: `rel_${"a1".repeat(16)}`, commit_sha: MERGED, state: "served", observed_at: 5, failure_code: null, served: true, result_url: URL, ...over });
const merged = { merge_state: "succeeded" as const, merge_sha: MERGED };
const ok = <T,>(data: T) => ({ ok: true as const, data });
const no = (status: number, code: string) => ({ ok: false as const, status, code });

describe("whether release is switched on, from the room's release-config read", () => {
  it("is off only for the unknown route's own answer, on for any answer the route gives, and unknown otherwise", () => {
    expect(releaseSwitchedOn(no(404, "not_found"))).toBe(false);
    expect(releaseSwitchedOn(ok({}))).toBe(true);
    // A member isn't shown the configuration, but the route answered, so release is on for the deployment.
    expect(releaseSwitchedOn(no(403, "not_allowed"))).toBe(true);
    for (const failed of [no(500, "error"), no(429, "rate_limited"), no(404, "workspace_not_found"), no(403, "access_revoked"), no(401, "unauthenticated")]) expect(releaseSwitchedOn(failed), failed.code).toBeNull();
  });
});

describe("a task's release, read for shape (review standard 3)", () => {
  it("takes null, { exists: false } and a whole release, and refuses anything else", () => {
    expect(parseTaskRelease({ release: null })).toEqual({ kind: "hidden" });
    expect(parseTaskRelease({ release: { exists: false } })).toEqual({ kind: "none" });
    expect(parseTaskRelease({ release: release() })).toEqual({ kind: "release", release: release() });
    for (const bad of [null, {}, { release: undefined }, { release: { exists: true } }, { release: release({ served: "yes" as unknown as boolean }) }, { release: release({ state: "live" as never }) }, { release: release({ result_url: 3 as unknown as string }) }, { release: release({ commit_sha: "main" }) }, { release: { exists: "false" } }, "x"]) {
      expect(parseTaskRelease(bad), JSON.stringify(bad)).toEqual({ kind: "malformed" });
    }
  });
});

describe("the deployment stage (DESIGN.md's release stages, UI-02)", () => {
  it("is Unavailable while release is off for the deployment, whatever the status says, with no link", () => {
    const stage = deploymentStage({ switchedOn: false, read: { kind: "release", release: release() }, ...merged });
    expect([stage.label, stage.link]).toEqual(["Unavailable", null]);
    expect(stage.text).not.toMatch(/\blive\b/i);
  });

  it("is never Live and never links unless the release is served, in every state", () => {
    for (const state of RELEASE_STATUS_STATES) {
      for (const result_url of [URL, null]) {
        const stage = deploymentStage({ switchedOn: true, read: { kind: "release", release: release({ state, served: false, result_url }) }, ...merged });
        expect(stage.label, state).not.toBe("Live");
        expect(stage.link, state).toBeNull();
      }
    }
    // Not knowing whether release is on doesn't make anything live either.
    expect(deploymentStage({ switchedOn: null, read: { kind: "release", release: release({ served: false }) }, ...merged }).label).not.toBe("Live");
  });

  it("is Live only while served, linking only to the address for this task's merged commit", () => {
    const live = deploymentStage({ switchedOn: true, read: { kind: "release", release: release() }, ...merged });
    expect([live.label, live.link, live.commit, live.observedAt]).toEqual(["Live", URL, MERGED, 5]);
    // Served, but for a commit that isn't this task's merge: Live may be true of the app, but no link is offered here.
    expect(deploymentStage({ switchedOn: true, read: { kind: "release", release: release({ commit_sha: OTHER }) }, ...merged }).link).toBeNull();
    expect(deploymentStage({ switchedOn: true, read: { kind: "release", release: release() }, merge_state: "succeeded", merge_sha: null }).link).toBeNull();
    // Served with no address, and an address that isn't https, give no link.
    expect(deploymentStage({ switchedOn: true, read: { kind: "release", release: release({ result_url: null }) }, ...merged })).toMatchObject({ label: "Live", link: null });
    expect(deploymentStage({ switchedOn: true, read: { kind: "release", release: release({ result_url: "javascript:alert(1)" }) }, ...merged }).link).toBeNull();
    expect(deploymentStage({ switchedOn: true, read: { kind: "release", release: release({ result_url: "http://k3v9q2.apps.example/" }) }, ...merged }).link).toBeNull();
  });

  it("says a later attempt failed while the earlier one of the commit is still served", () => {
    const stage = deploymentStage({ switchedOn: true, read: { kind: "release", release: release({ state: "failed", failure_code: "upload_failed" }) }, ...merged });
    expect(stage.label).toBe("Live");
    expect(stage.text).toMatch(/latest attempt failed/);
  });

  it("names each stage by DESIGN.md's labels", () => {
    const at = (over: Partial<TaskRelease>) => deploymentStage({ switchedOn: true, read: { kind: "release", release: release({ served: false, result_url: null, ...over }) }, ...merged }).label;
    expect(at({ state: "awaiting_approval" })).toBe("Waiting for approval");
    for (const state of ["queued", "uploading", "uncertain", "awaiting_confirmation"] as const) expect(at({ state }), state).toBe("Deploying");
    expect(at({ state: "failed", failure_code: "upload_failed" })).toBe("Deployment failed");
    expect(at({ state: "declined" })).toBe("Declined");
    expect(at({ state: "replaced" })).toBe("Replaced");
    expect(at({ state: "unpublished" })).toBe("Unpublished");
    expect(at({ state: "served" })).toBe("Not live");
  });

  it("waits for the merge, is Off when nothing was asked for, and says when it couldn't read or isn't shown", () => {
    expect(deploymentStage({ switchedOn: true, read: null, merge_state: "requested", merge_sha: null }).label).toBe("Waiting for merge");
    expect(deploymentStage({ switchedOn: true, read: { kind: "none" }, ...merged }).label).toBe("Off");
    expect(deploymentStage({ switchedOn: true, read: { kind: "hidden" }, ...merged }).label).toBe("Not shown to you");
    expect(deploymentStage({ switchedOn: true, read: { kind: "malformed" }, ...merged }).label).toBe("Couldn't check");
    expect(deploymentStage({ switchedOn: true, read: { kind: "failed" }, ...merged }).label).toBe("Couldn't check");
    expect(deploymentStage({ switchedOn: null, read: null, ...merged }).label).toBe("Couldn't check");
  });

  it("puts the merge and the deployment side by side, as Merged · Deployment failed (UI-02)", () => {
    const failed = deploymentStage({ switchedOn: true, read: { kind: "release", release: release({ state: "failed", served: false, result_url: null, failure_code: "upload_failed" }) }, ...merged });
    expect(releaseHeadline("Merged", failed)).toBe("Merged · Deployment failed");
  });
});
