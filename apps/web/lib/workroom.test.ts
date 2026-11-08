import { beforeEach, describe, expect, it, vi } from "vitest";
import { NotFoundSignal, RedirectSignal } from "@/test/next-navigation";
import type { GatewayResult } from "./gateway/result";

const gatewayQuery = vi.fn<(path: string) => Promise<GatewayResult<unknown>>>();
vi.mock("./gateway/server", async () => {
  const { redirect } = await import("@/test/next-navigation");
  return { gatewayQuery: (path: string) => gatewayQuery(path), signInPath: (next: string) => `/sign-in?next=${next}`, rateLimited: async (after?: number) => redirect(`/too-many-requests?after=${after}`) };
});
// A new call each time here. React only dedupes within a server render.
vi.mock("react", async (original) => ({ ...(await original<object>()), cache: <T,>(fn: T) => fn }));

const { canManageWorkroom, loadWorkroom } = await import("./workroom");

const refusal = (status: number, code: string): GatewayResult<unknown> => ({ ok: false, status, code });

describe("loadWorkroom", () => {
  beforeEach(() => gatewayQuery.mockReset());

  it("returns a room the viewer may see", async () => {
    const room = { id: "ws_1", name: "Room", owner: "per_1", status: "active", policy_version: null };
    gatewayQuery.mockResolvedValue({ ok: true, data: room });
    await expect(loadWorkroom("ws_1")).resolves.toBe(room);
    expect(gatewayQuery).toHaveBeenCalledWith("/api/v1/workspaces/ws_1");
  });

  it.each([
    ["missing", 404, "workspace_not_found"],
    ["private", 404, "workspace_not_found"],
    ["revoked", 403, "access_revoked"],
    ["not joined", 403, "not_a_participant"],
    ["refused", 403, "not_allowed"],
    ["bad", 400, "invalid_argument"],
  ])("every %s room gets the one not-found page", async (_name, status, code) => {
    gatewayQuery.mockResolvedValue(refusal(status, code));
    await expect(loadWorkroom("ws_1")).rejects.toBeInstanceOf(NotFoundSignal);
  });

  it.each(["../../v1/me", "ws_1/tasks", "ws 1", "", "a".repeat(200)])("doesn't send %s to the gateway", async (id) => {
    await expect(loadWorkroom(id)).rejects.toBeInstanceOf(NotFoundSignal);
    expect(gatewayQuery).not.toHaveBeenCalled();
  });

  it("sends a signed-out person to sign in, whatever the room", async () => {
    gatewayQuery.mockResolvedValue(refusal(401, "sign_in_required"));
    await expect(loadWorkroom("ws_1")).rejects.toBeInstanceOf(RedirectSignal);
  });

  it.each([500, 503])("an outage (%i) isn't reported as not found", async (status) => {
    gatewayQuery.mockResolvedValue(refusal(status, "internal_error"));
    await expect(loadWorkroom("ws_1")).rejects.toThrow("gateway_unavailable");
  });

  it("sends a read refused for the rate limit to its own page with the wait, not the error page or not-found", async () => {
    gatewayQuery.mockResolvedValue({ ok: false, status: 429, code: "rate_limited", retryAfter: 20 } as GatewayResult<unknown>);
    await expect(loadWorkroom("ws_1")).rejects.toThrow("/too-many-requests?after=20");
    await expect(loadWorkroom("ws_1")).rejects.toBeInstanceOf(RedirectSignal);
  });
});

describe("canManageWorkroom", () => {
  it("follows what the server sent", () => {
    expect(canManageWorkroom({ policy_version: 2 })).toBe(true);
    expect(canManageWorkroom({ policy_version: 0 })).toBe(true);
    expect(canManageWorkroom({ policy_version: null })).toBe(false);
  });
});
