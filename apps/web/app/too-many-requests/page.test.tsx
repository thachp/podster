import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/gateway/env", () => ({ webEnv: () => ({ GATEWAY: { fetch: vi.fn() }, APP_URL: "https://app.test" }) }));
const { default: TooManyRequests } = await import("./page");

const show = async (query: Record<string, string>) => render(await TooManyRequests({ searchParams: Promise.resolve(query) }));

afterEach(() => vi.useRealTimers());

describe("the rate-limit page", () => {
  it("says how long to wait, and links back to where the person was", async () => {
    await show({ after: "30", next: "/w/ws_1/tasks?view=board" });
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Too many requests just now");
    expect(screen.getByText("Try again in 30 seconds.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Try again" })).toHaveAttribute("href", "/w/ws_1/tasks?view=board");
  });

  it("counts down, and says once that it's time", async () => {
    vi.useFakeTimers();
    await show({ after: "2", next: "/attention" });
    expect(screen.getByRole("status")).toBeEmptyDOMElement();
    await act(async () => vi.advanceTimersByTime(1000));
    expect(screen.getByText("Try again in 1 second.")).toBeInTheDocument();
    await act(async () => vi.advanceTimersByTime(1000));
    expect(screen.getByRole("status")).toHaveTextContent("You can try again now.");
  });

  it.each([
    ["another host", { after: "5", next: "https://evil.example/x" }],
    ["itself", { after: "5", next: "/too-many-requests?after=5" }],
    ["nothing", { after: "5" }],
  ])("sends the way back somewhere safe when given %s", async (_name, query) => {
    await show(query as Record<string, string>);
    expect(screen.getByRole("link", { name: "Try again" })).toHaveAttribute("href", "/attention");
  });

  it.each([{ after: "soon" }, { after: "99999" }, {}])("caps or drops a wait it can't trust: %o", async (query) => {
    await show(query as Record<string, string>);
    const said = screen.getByText(/Try again in/).textContent ?? "";
    expect(said === "Try again in a minute." || said === "Try again in 300 seconds.").toBe(true);
  });
});
