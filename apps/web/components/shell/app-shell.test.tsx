import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { routerCalls, setUrl } from "@/test/next-navigation";
import { AppShell } from "./app-shell";
import { visibleWorkroomTabs } from "./nav";

const profile = { name: "Pat", email: "pat@example.test", organizations: [{ id: "org_1", name: "Acme" }, { id: "org_2", name: "Beta" }], currentOrg: "org_2" };
const shell = (unread: number | null = 0) => render(<AppShell unread={unread} profile={profile}>content</AppShell>);

beforeEach(() => {
  setUrl("/attention");
  vi.stubGlobal("fetch", vi.fn(async () => new Response("null")));
});

describe("AppShell", () => {
  it("has the four primary items, in order", () => {
    shell();
    const names = within(screen.getByRole("list", { name: "Primary" })).getAllByRole("link").map((link) => link.textContent);
    expect(names).toEqual(["Needs attention", "Workrooms", "Agents", "Settings"]);
  });

  it("marks where you are, including inside a workroom", () => {
    setUrl("/w/ws_1/tasks");
    shell();
    expect(screen.getByRole("link", { name: "Workrooms" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: "Needs attention" })).not.toHaveAttribute("aria-current");
  });

  it("anchors the profile button in the footer, after the navigation", () => {
    shell();
    const footer = screen.getByTestId("sidebar-footer");
    const button = within(footer).getByRole("button", { name: /^Profile menu:/ });
    expect(screen.getByRole("list", { name: "Primary" }).compareDocumentPosition(button) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("the profile menu has what the spec lists, and no billing", async () => {
    shell();
    await userEvent.click(screen.getByRole("button", { name: /^Profile menu:/ }));
    const menu = await screen.findByRole("menu");
    for (const item of ["Acme", "Beta", "Account", "Notifications", "Log out"]) expect(within(menu).getByText(item)).toBeInTheDocument();
    expect(within(menu).queryByText("Billing")).toBeNull();
    expect(within(menu).getByLabelText("Current organization").closest('[role="menuitem"]')).toHaveTextContent("Beta");
  });

  it("drops a selected organization the person is no longer in, so room reads work again", () => {
    document.cookie = "podster-org=org_gone; path=/";
    const before = routerCalls.refresh;
    render(<AppShell unread={0} profile={profile} staleOrg>content</AppShell>);
    expect(document.cookie).not.toContain("podster-org=org_gone");
    expect(routerCalls.refresh).toBe(before + 1);
  });

  it("logging out forgets an invitation kept in this tab", async () => {
    sessionStorage.setItem("podster-org-invitation", "oin_1.secret");
    shell();
    await userEvent.click(screen.getByRole("button", { name: /^Profile menu:/ }));
    await userEvent.click(await screen.findByText("Log out"));
    expect(sessionStorage.getItem("podster-org-invitation")).toBeNull();
  });

  it("switching organization only sets a selector", async () => {
    shell();
    await userEvent.click(screen.getByRole("button", { name: /^Profile menu:/ }));
    await userEvent.click(await screen.findByText("Acme"));
    expect(document.cookie).toContain("podster-org=org_1");
    document.cookie = "podster-org=; max-age=0; path=/";
  });

  it("shows an unread count only when it knows one", () => {
    const { unmount } = shell(3);
    expect(screen.getByRole("link", { name: /Needs attention/ }).closest("li")).toHaveTextContent("3 unread");
    unmount();
    shell(null);
    expect(screen.queryByText(/unread/)).toBeNull();
  });

  it("offers a way past the navigation", () => {
    shell();
    expect(screen.getByRole("link", { name: "Skip to content" })).toHaveAttribute("href", "#main-content");
    expect(screen.getByRole("main")).toHaveAttribute("id", "main-content");
  });
});

describe("workroom tabs", () => {
  it("lists them in order, with Settings only for those who may manage", () => {
    expect(visibleWorkroomTabs(true).map((tab) => tab.label)).toEqual(["Overview", "Tasks", "Team", "Collaboration", "Activity", "Artifacts", "Ship", "Settings"]);
    expect(visibleWorkroomTabs(false).map((tab) => tab.label)).not.toContain("Settings");
  });
});
