import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StartPairing } from "./start-pairing";

const CODE = "c0dE_c0dE_c0dE_c0dE_c0dE_c0dE_c0dE_c0dE_c0d";
const GATEWAY = "https://gateway.example.test";
const COMMAND = `node build/node/cli.js pair --gateway ${GATEWAY} --agent agt_1`;
const started = (agentId = "agt_1") => vi.fn(async () => new Response(JSON.stringify({ agent_id: agentId, org_id: "org_a", name: "Mac", status: "pending", key_thumbprint: null, expires_at: 1, code: CODE }), { status: 200 }));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** A storage that records every write, standing in for the browser's. */
function watchedStorage() {
  const writes: string[] = [];
  const storage = { length: 0, clear() {}, getItem: () => null, key: () => null, removeItem() {}, setItem: (key: string, value: string) => void writes.push(`${key}=${value}`) };
  return { storage, writes };
}

async function start(user = userEvent.setup()) {
  await user.click(screen.getByRole("button", { name: "Start pairing" }));
  await screen.findByText(CODE);
  return user;
}

describe("StartPairing", () => {
  it("starts with only a name, shows the code once, and sends the person on with no code in the link", async () => {
    const fetcher = started();
    vi.stubGlobal("fetch", fetcher);
    render(<StartPairing gateway={GATEWAY} />);
    await userEvent.type(screen.getByLabelText("Name for the agent"), "Mac");
    await userEvent.click(screen.getByRole("button", { name: "Start pairing" }));
    expect(await screen.findByText(CODE)).toBeInTheDocument();
    expect(JSON.parse(String((fetcher.mock.calls[0] as unknown[])[1] && ((fetcher.mock.calls[0] as unknown[])[1] as RequestInit).body))).toEqual({ name: "Mac" });
    const link = screen.getByRole("link", { name: "Continue to confirm" });
    expect(link.getAttribute("href")).toBe("/pairing/agt_1");
    expect(link.getAttribute("href")).not.toContain(CODE);
  });

  it("shows the agent ID and Runner's pair command beside the code, with the code kept out of both", async () => {
    vi.stubGlobal("fetch", started());
    render(<StartPairing gateway={GATEWAY} />);
    await start();
    expect(screen.getByLabelText("Agent ID")).toHaveTextContent(/^agt_1$/);
    expect(screen.getByLabelText("Command for Runner")).toHaveTextContent(COMMAND);
    expect(screen.getByLabelText("Command for Runner").textContent).not.toContain(CODE);
    expect(screen.getByLabelText("Code for Runner")).toHaveTextContent(CODE);
    // The code is copied by hand only: no button puts it anywhere.
    expect(screen.queryByRole("button", { name: /Copy code/i })).toBeNull();
  });

  it("copies the agent ID and the command exactly, never the code", async () => {
    const user = userEvent.setup();
    const writeText = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
    vi.stubGlobal("fetch", started());
    render(<StartPairing gateway={GATEWAY} />);
    await start(user);
    await user.click(screen.getByRole("button", { name: "Copy Agent ID" }));
    await user.click(screen.getByRole("button", { name: "Copy Command for Runner" }));
    expect(writeText.mock.calls).toEqual([["agt_1"], [COMMAND]]);
    expect(await screen.findAllByText("Copied.")).not.toHaveLength(0);
  });

  it("keeps the code out of the page's address and the browser's storage", async () => {
    const local = watchedStorage();
    const session = watchedStorage();
    vi.stubGlobal("localStorage", local.storage);
    vi.stubGlobal("sessionStorage", session.storage);
    vi.stubGlobal("fetch", started());
    render(<StartPairing gateway={GATEWAY} />);
    await start();
    expect(window.location.href).not.toContain(CODE);
    expect(local.writes).toEqual([]);
    expect(session.writes).toEqual([]);
    expect(document.cookie).not.toContain(CODE);
  });

  it("shows no command for an agent ID that isn't plainly an ID, so nothing odd lands in a shell", async () => {
    vi.stubGlobal("fetch", started("agt_1; rm -rf ~"));
    render(<StartPairing gateway={GATEWAY} />);
    await start();
    expect(screen.queryByLabelText("Command for Runner")).toBeNull();
    expect(screen.getByLabelText("Agent ID")).toHaveTextContent("agt_1; rm -rf ~");
  });

  it("shows a refusal in fixed words", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: { code: "not_allowed" } }), { status: 403 })));
    render(<StartPairing gateway={GATEWAY} />);
    await userEvent.click(screen.getByRole("button", { name: "Start pairing" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("wasn't allowed");
  });
});
