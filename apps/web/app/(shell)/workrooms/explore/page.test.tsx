import { render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ asked: [] as string[], limited: 0 }));
vi.mock("@/lib/gateway/server", () => ({
  gatewayQuery: async (path: string) => {
    state.asked.push(path);
    return { ok: true, data: { workrooms: [], next_cursor: null } };
  },
}));
vi.mock("@/lib/gateway/env", () => ({ webEnv: () => ({ EXPLORE_LIMIT: { limit: async () => ((state.limited += 1), { success: true }) } }) }));
vi.mock("next/headers", () => ({ headers: async () => new Headers({ "cf-connecting-ip": "203.0.113.9" }) }));

const { default: Explore } = await import("./page");
const HANDLE = `pub_${"a".repeat(32)}`;

beforeEach(() => {
  state.asked.length = 0;
  state.limited = 0;
});

describe("Explore", () => {
  it("shows only the claim help when coming to claim, reading nothing and spending none of the limit", async () => {
    render((await Explore({ searchParams: Promise.resolve({ claim: HANDLE, opening: "role_1" }) })) as ReactElement);
    expect(screen.getByText(/claim_public_opening/)).toBeInTheDocument();
    expect(state.asked).toEqual([]);
    expect(state.limited).toBe(0);
  });

  it("lists rooms otherwise, counted against the limit", async () => {
    render((await Explore({ searchParams: Promise.resolve({}) })) as ReactElement);
    expect(state.asked).toEqual(["/api/v1/public/explore"]);
    expect(state.limited).toBe(1);
  });
});
