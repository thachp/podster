import { render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setUrl } from "@/test/next-navigation";

const state = vi.hoisted(() => ({
  asked: [] as string[],
  identity: { ok: true, data: { id: "per_a", org_id: "org_a", orgs: ["org_a"], admin_orgs: ["org_a"], inbox_unread: 0 } } as unknown,
  releaseSwitch: { ok: false, status: 404, code: "not_found" } as unknown,
}));
vi.mock("react", async (original) => ({ ...(await original<object>()), cache: <T,>(fn: T) => fn }));
vi.mock("@/lib/gateway/server", () => ({
  gatewayQuery: async (path: string) => {
    state.asked.push(path);
    if (path.endsWith("/release-delegation")) {
      if (state.releaseSwitch === "throw") throw new Error("connection lost");
      return state.releaseSwitch;
    }
    return { ok: false, status: 404, code: "not_found" };
  },
  getIdentity: async () => state.identity,
  getOrganizations: async () => ({ ok: true, data: { organizations: [{ id: "org_a", name: "Acme", personal: 0, role: "admin" }, { id: "org/b c", name: "Odd", personal: 0, role: "admin" }] } }),
}));

const { default: NewWorkroom } = await import("./page");
const show = async () => render((await NewWorkroom()) as ReactElement);
const release = () => screen.getByRole("region", { name: "Release" });
const identity = (org_id: string, admin_orgs: string[]) => ({ ok: true, data: { id: "per_a", org_id, orgs: [org_id], admin_orgs, inbox_unread: 0 } });

describe("release at workroom setup", () => {
  beforeEach(() => {
    setUrl("/workrooms/new");
    state.asked.length = 0;
    state.identity = identity("org_a", ["org_a"]);
    state.releaseSwitch = { ok: false, status: 404, code: "not_found" };
  });

  it("reads the acting organization's release switch, and shows Unavailable while it answers as a missing route", async () => {
    await show();
    expect(state.asked).toEqual(["/api/v1/orgs/org_a/release-delegation"]);
    expect(release()).toHaveTextContent("Unavailable");
  });

  it("shows Not configured or Needs approval from the switch's answer", async () => {
    state.releaseSwitch = { ok: true, data: { granted: true, generation: 0, last_take: 0, set_by: null, set_at: null } };
    const first = await show();
    expect(release()).toHaveTextContent("Not configured");
    first.unmount();
    state.releaseSwitch = { ok: true, data: { granted: false, generation: 1, last_take: 1, set_by: "per_op", set_at: 1 } };
    await show();
    expect(release()).toHaveTextContent("Needs approval");
  });

  it("a read that throws, or a 200 of another shape, says it couldn't check, and the page still renders", async () => {
    for (const answer of ["throw", { ok: true, data: null }, { ok: true, data: {} }, { ok: true, data: { granted: "no" } }]) {
      state.releaseSwitch = answer;
      const shown = await show();
      expect(screen.getByRole("heading", { name: "Create a workroom" })).toBeInTheDocument();
      expect(release()).toHaveTextContent("Couldn't check");
      expect(release()).not.toHaveTextContent("taken release away");
      shown.unmount();
    }
  });

  it("encodes the organization's ID in the path", async () => {
    state.identity = identity("org/b c", ["org/b c"]);
    await show();
    expect(state.asked).toEqual(["/api/v1/orgs/org%2Fb%20c/release-delegation"]);
  });

  it("reads nothing for someone refused, or whose identity couldn't be read", async () => {
    state.identity = identity("org_a", []);
    const refused = await show();
    expect(state.asked).toEqual([]);
    expect(screen.queryByRole("region", { name: "Release" })).toBeNull();
    refused.unmount();
    state.identity = { ok: false, status: 500, code: "error" };
    await show();
    expect(state.asked).toEqual([]);
    expect(release()).toHaveTextContent("Couldn't check");
  });
});
