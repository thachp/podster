import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StartPairing } from "./start-pairing";

const CODE = "c0dE_c0dE_c0dE_c0dE_c0dE_c0dE_c0dE_c0dE_c0d";
afterEach(() => vi.unstubAllGlobals());

describe("StartPairing", () => {
  it("starts with only a name, shows the code once, and sends the person on with no code in the link", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ agent_id: "agt_1", org_id: "org_a", name: "Mac", status: "pending", key_thumbprint: null, expires_at: 1, code: CODE }), { status: 200 }));
    vi.stubGlobal("fetch", fetcher);
    render(<StartPairing />);
    await userEvent.type(screen.getByLabelText("Name for the agent"), "Mac");
    await userEvent.click(screen.getByRole("button", { name: "Start pairing" }));
    expect(await screen.findByText(CODE)).toBeInTheDocument();
    expect(JSON.parse(String((fetcher.mock.calls[0] as unknown[])[1] && ((fetcher.mock.calls[0] as unknown[])[1] as RequestInit).body))).toEqual({ name: "Mac" });
    const link = screen.getByRole("link", { name: "Continue to confirm" });
    expect(link.getAttribute("href")).toBe("/pairing/agt_1");
    expect(link.getAttribute("href")).not.toContain(CODE);
  });

  it("shows a refusal in fixed words", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: { code: "not_allowed" } }), { status: 403 })));
    render(<StartPairing />);
    await userEvent.click(screen.getByRole("button", { name: "Start pairing" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("wasn't allowed");
  });
});
