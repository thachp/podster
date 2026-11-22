import { describe, expect, it } from "vitest";
import { addableAgents, explainRefusal, isExternal, relationship, toPending } from "./model";

describe("agents that can be added directly", () => {
  const agent = (id: string, org_id: string, revoked_at: number | null = null) => ({ id, name: id, org_id, revoked_at });

  it("lists only the room's own organization, and nothing disconnected", () => {
    expect(addableAgents([agent("agt_1", "org_a"), agent("agt_2", "org_b"), agent("agt_3", "org_a", 5)], "org_a")).toEqual([{ id: "agt_1", name: "agt_1", org_id: "org_a" }]);
  });
});

describe("toPending", () => {
  it("maps a row of the invitation list", () => {
    expect(toPending({ id: "ivt_1", invited_org_id: "org_b", role: "member", created_by: "per_a", created_at: 1, expires_at: 2 })).toEqual({ id: "ivt_1", role: "member", invitedOrg: "org_b", createdBy: "per_a", createdAt: 1, expiresAt: 2, workRole: null });
  });
});

describe("relationship", () => {
  const viewer = { id: "per_me", orgs: ["org_a"], adminOrgs: [] };

  it("names the owner, who has no member row", () => expect(relationship({ owner: "per_me", members: [] }, viewer)).toBe("Owner"));
  it("uses the viewer's own row", () => expect(relationship({ owner: "per_x", members: [{ principal_id: "per_me", kind: "person", org_id: "org_a", role: "admin" }] }, viewer)).toBe("Admin"));
});

describe("isExternal", () => {
  it("is relative to the viewer's organizations", () => {
    expect(isExternal("org_a", { orgs: ["org_a"] })).toBe(false);
    expect(isExternal("org_b", { orgs: ["org_a"] })).toBe(true);
  });
});

describe("explainRefusal", () => {
  it("sends cross-organization additions to an invitation", () => expect(explainRefusal("invitation_required")).toMatch(/invitation/));
  it("says a person must join the organization first", () => expect(explainRefusal("not_in_organization")).toMatch(/organization/));
  // An invitation brings in agents only, so it isn't the way to add a person from elsewhere (issue 521).
  it("doesn't send a person to an invitation", () => expect(explainRefusal("invitation_required")).toMatch(/agents\. A person has to join this workroom's organization first/));
  it("says an archived room can't change", () => expect(explainRefusal("workspace_archived")).toMatch(/archived/));
  it("never admits more than a refusal for anything it doesn't know", () => expect(explainRefusal("workspace_not_found")).toBe(explainRefusal("something_else")));
});
