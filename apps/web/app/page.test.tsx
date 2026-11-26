import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { render, screen } from "@testing-library/react";
import axe from "axe-core";
import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RedirectSignal } from "@/test/next-navigation";

const state = vi.hoisted(() => ({ session: null as unknown, fails: null as Error | null }));
vi.mock("@/lib/gateway/server", () => ({
  getSession: async () => {
    if (state.fails) throw state.fails;
    return state.session;
  },
}));

const { default: Home } = await import("./page");
const show = async () => render((await Home()) as ReactElement);

describe("/", () => {
  beforeEach(() => {
    state.session = null;
    state.fails = null;
  });

  it("shows a signed-out person the landing page", async () => {
    await show();
    expect(screen.getByRole("heading", { level: 1 })).toBeInTheDocument();
  });

  it.each([
    ["the gateway is down", new Error("gateway_unavailable")],
    ["the session read is rate limited", new RedirectSignal("/too-many-requests?after=30")],
  ])("still shows the landing page when %s, and logs no ID", async (_why, error) => {
    state.fails = error;
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    await show();
    expect(screen.getByRole("heading", { level: 1 })).toBeInTheDocument();
    expect(logged.mock.calls).toEqual([["landing session read failed"]]);
    logged.mockRestore();
  });

  it("sends a signed-in person to Needs attention, as before", async () => {
    state.session = { user: { id: "per_Me", name: "Pat", email: "pat@example.test" } };
    await expect(Home()).rejects.toThrow(RedirectSignal);
    await expect(Home()).rejects.toThrow("/attention");
  });

  it("shows a signed-out person the landing page, with sign-in first and the demo second", async () => {
    await show();
    expect(screen.getByRole("heading", { level: 1 })).toBeInTheDocument();
    const signIn = screen.getAllByRole("link", { name: "Sign in" });
    expect(signIn.length).toBeGreaterThan(0);
    for (const link of signIn) expect(link).toHaveAttribute("href", "/sign-in");
    for (const link of screen.getAllByRole("link", { name: "See the demo" })) expect(link).toHaveAttribute("href", "https://demo.podster.dev");
  });

  it("links only to sign-in, the demo and itself", async () => {
    const { container } = await show();
    const hrefs = [...container.querySelectorAll("a")].map((a) => a.getAttribute("href"));
    for (const href of hrefs) expect(["/sign-in", "https://demo.podster.dev", "#main"]).toContain(href);
  });

  it("describes each screenshot, and each one is there and small", async () => {
    await show();
    const images = screen.getAllByRole("img");
    expect(images.length).toBeGreaterThanOrEqual(4);
    for (const image of images) {
      expect((image.getAttribute("alt") ?? "").length).toBeGreaterThan(40);
      const file = join(process.cwd(), "public", image.getAttribute("src") ?? "");
      expect(existsSync(file), file).toBe(true);
      expect(statSync(file).size, file).toBeLessThan(250 * 1024);
    }
  });

  it("keeps its headings in order", async () => {
    const { container } = await show();
    const levels = [...container.querySelectorAll("h1, h2, h3, h4")].map((h) => Number(h.tagName[1]));
    expect(levels[0]).toBe(1);
    levels.reduce((previous, level) => {
      expect(level - previous).toBeLessThanOrEqual(1);
      return level;
    });
  });

  it("passes axe", async () => {
    const { container } = await show();
    // jsdom can't compute colors; the browser run in e2e/a11y.mjs checks contrast.
    const results = await axe.run(container, { rules: { "color-contrast": { enabled: false } } });
    expect(results.violations.map((v) => v.id)).toEqual([]);
  });
});
