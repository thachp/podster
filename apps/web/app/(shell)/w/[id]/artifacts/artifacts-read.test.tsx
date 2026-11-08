import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayResult } from "@/lib/gateway/result";
import { setUrl } from "@/test/next-navigation";

/** A server component, so it's called and its result rendered. The gateway is the only thing replaced. */
const replies = new Map<string, GatewayResult<unknown>>();
const queries = vi.hoisted(() => [] as string[]);
let identity: GatewayResult<unknown>;

vi.mock("@/lib/gateway/server", () => ({
  gatewayQuery: async (path: string) => {
    queries.push(path);
    return replies.get(path.split("?")[0]) ?? { ok: false, status: 404, code: "not_found" };
  },
  getIdentity: async () => identity,
  getOrganizations: async () => ({ ok: true, data: { organizations: [] } }),
}));
vi.mock("@/lib/workroom", () => ({ loadWorkroom: async () => ({ id: "ws_1", name: "Launch room", owner: "per_o", status: "active", policy_version: 3, members: [] }), canManageWorkroom: () => true, isArchived: () => false }));
vi.mock("../tasks/go-to-sign-in", () => ({ goToSignIn: vi.fn() }));

const { ArtifactsRead } = await import("./artifacts-read");

const READY = { id: "out_1", title: "Design doc", description: null, status: "ready", current: { task_id: "tsk_9", submission_no: 2 } };

beforeEach(() => {
  setUrl("/w/ws_1/artifacts");
  replies.clear();
  queries.length = 0;
  identity = { ok: true, data: { id: "per_me", orgs: [], admin_orgs: [] } };
});

describe("the Artifacts page's reads", () => {
  it("reads the outputs and no output's history, however many are Ready", async () => {
    replies.set("/api/v1/workspaces/ws_1/outputs", { ok: true, data: { outputs: Array.from({ length: 12 }, (_, index) => ({ ...READY, id: `out_${index}`, title: `Output ${index}` })), ready: 12, total: 12 } });
    render(await ArtifactsRead({ id: "ws_1" }));
    expect(screen.getByText("12 of 12 outputs ready")).toBeInTheDocument();
    expect(queries.filter((path) => path.includes("/versions"))).toEqual([]);
  });

  it("says a rate-limited read is that, and offers to try again, rather than the error page", async () => {
    replies.set("/api/v1/workspaces/ws_1/outputs", { ok: false, status: 429, code: "rate_limited" });
    render(await ArtifactsRead({ id: "ws_1" }));
    expect(screen.getByRole("alert")).toHaveTextContent(/Too many requests just now/);
    expect(screen.getByRole("button", { name: "try again" })).toBeInTheDocument();
  });

  it("says any other failed read couldn't refresh", async () => {
    replies.set("/api/v1/workspaces/ws_1/outputs", { ok: false, status: 503, code: "upstream_unavailable" });
    render(await ArtifactsRead({ id: "ws_1" }));
    expect(screen.getByRole("alert")).toHaveTextContent(/Couldn't refresh/);
  });
});
