import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PairingView } from "../model";
import { ConfirmPairing } from "./confirm-pairing";

const THUMB = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_abcde";
const view = (over: Partial<PairingView> = {}): PairingView => ({ agent_id: "agt_1", org_id: "org_a", name: "Laptop runner", status: "redeemed", key_thumbprint: THUMB, expires_at: Date.now() + 60_000, runner_ready: true, ...over });
const answer = (status: number, body: unknown) => vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify(body), { status }));

afterEach(() => vi.unstubAllGlobals());

describe("ConfirmPairing", () => {
  it("shows the agent and the whole thumbprint to compare, and no code", () => {
    const { container } = render(<ConfirmPairing initial={{ ...view(), code: "should-never-show" } as PairingView} />);
    expect(container).toHaveTextContent("Laptop runner");
    expect(container.querySelector("code")?.textContent?.replaceAll(" ", "")).toBe(THUMB);
    expect(container).not.toHaveTextContent("should-never-show");
    expect(screen.getByRole("button", { name: "Confirm this key" })).not.toHaveFocus();
  });

  it("keeps a name as text", () => {
    const { container } = render(<ConfirmPairing initial={view({ name: "<b>Podster</b>" })} />);
    expect(container.querySelector("b")).toBeNull();
    expect(container).toHaveTextContent("<b>Podster</b>");
  });

  it("confirms with exactly the thumbprint shown, through activate, and shows the server's result", async () => {
    const fetcher = answer(200, view({ status: "activated", plugin_agent_id: "plug_1" }));
    vi.stubGlobal("fetch", fetcher);
    render(<ConfirmPairing initial={view()} />);
    await userEvent.click(screen.getByRole("button", { name: "Confirm this key" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Runner is connected as Laptop runner");
    expect(fetcher.mock.calls[0][0]).toBe("/api/pairing/agt_1/activate");
    expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body))).toEqual({ key_thumbprint: THUMB });
  });

  it("can't confirm until Runner has registered its agent, or before it sent a key", () => {
    const { unmount } = render(<ConfirmPairing initial={view({ runner_ready: false })} />);
    expect(screen.getByRole("button", { name: "Confirm this key" })).toBeDisabled();
    expect(screen.getByText(/Waiting for Runner to finish setting up/)).toBeInTheDocument();
    unmount();
    render(<ConfirmPairing initial={view({ status: "pending", key_thumbprint: null, runner_ready: false })} />);
    expect(screen.queryByRole("button", { name: "Confirm this key" })).toBeNull();
    expect(screen.getByText(/Waiting for Runner to send its key/)).toBeInTheDocument();
  });

  it("shows a refusal in fixed words and keeps the screen", async () => {
    vi.stubGlobal("fetch", answer(403, { error: { code: "not_allowed", message: "<script>x</script>" } }));
    render(<ConfirmPairing initial={view()} />);
    await userEvent.click(screen.getByRole("button", { name: "Confirm this key" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("The key may not match");
    expect(screen.getByRole("button", { name: "Confirm this key" })).toBeEnabled();
  });

  it("cancels, and says nothing was connected", async () => {
    const fetcher = answer(200, view({ status: "canceled" }));
    vi.stubGlobal("fetch", fetcher);
    render(<ConfirmPairing initial={view()} />);
    await userEvent.click(screen.getByRole("button", { name: "Cancel pairing" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Nothing was connected");
    expect(fetcher.mock.calls[0][0]).toBe("/api/pairing/agt_1/cancel");
  });

  it.each(["expired", "canceled", "locked"] as const)("an ended session (%s) offers nothing to confirm", (status) => {
    render(<ConfirmPairing initial={view({ status })} />);
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByRole("status")).toHaveTextContent("Nothing was connected");
  });
});
