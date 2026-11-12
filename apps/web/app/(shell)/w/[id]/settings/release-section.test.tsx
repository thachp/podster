import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setUrl } from "@/test/next-navigation";
import { ReleaseSection } from "./release-section";
import { describeHostname, explainReleaseRefusal, holdsName, hostnameProblem, releaseAvailability, releaseView, UNAVAILABLE, type AppHostname, type HostnameRequest, type Prerequisites, type ReleaseConfig } from "./release-model";

const config = (over: Partial<ReleaseConfig> = {}): ReleaseConfig => ({ enabled: false, approval_policy: "person", environments: ["production"], default_host: null, custom_host: null, version: 4, set_by: null, updated_at: null, ...over });
const request = (over: Partial<HostnameRequest> = {}): HostnameRequest => ({
  id: "hr_1",
  hostname: "app.example.com",
  state: "pending",
  challenge_name: "_podster-challenge.app.example.com",
  challenge_value: "c2b1f0e9d8",
  requested_by: "per_owner",
  requested_at: Date.UTC(2026, 10, 12),
  expires_at: Date.UTC(2026, 10, 15),
  end_reason: null,
  ...over,
});
const ready: Prerequisites = { isPublic: true, repositoryReady: true };

const sent: { method: string; url: string; body: unknown; key: string | null }[] = [];
let reply: { status: number; body: unknown };

beforeEach(() => {
  setUrl("/w/ws_1/settings");
  sent.length = 0;
  reply = { status: 200, body: config({ enabled: true, version: 5 }) };
  vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
    sent.push({ method: init.method ?? "GET", url, body: init.body ? JSON.parse(String(init.body)) : null, key: new Headers(init.headers).get("idempotency-key") });
    return new Response(JSON.stringify(reply.body), { status: reply.status });
  });
});
afterEach(() => vi.unstubAllGlobals());

const show = (view: ReturnType<typeof releaseView>, { hostname = { request: null } as AppHostname | null | "failed", mayConfigure = true, archived = false, setByName = null as string | null, requestedByName = null as string | null } = {}) =>
  render(<ReleaseSection roomId="ws_1" view={view} hostname={hostname} mayConfigure={mayConfigure} archived={archived} setByName={setByName} requestedByName={requestedByName} />);

const confirm = async (open: string, button: string) => {
  await userEvent.click(screen.getByRole("button", { name: open }));
  await userEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: button }));
};

describe("the section's state, from the server's reads", () => {
  it("is Unavailable while the deployment answers release's routes as missing ones, and a failed read is a failure, not off", () => {
    expect(releaseView({ kind: "off" }, ready)).toMatchObject({ state: "unavailable", label: "Unavailable", text: UNAVAILABLE });
    expect(releaseView({ kind: "failed" }, ready)).toEqual({ state: "failed" });
  });

  it("reads 409 release_not_available as Unavailable, like the missing route's 404, and nothing else that isn't an answer", () => {
    expect(releaseAvailability({ ok: false, status: 409, code: "release_not_available" })).toEqual({ kind: "off" });
    expect(releaseAvailability({ ok: false, status: 404, code: "not_found" })).toEqual({ kind: "off" });
    for (const failure of [{ status: 409, code: "version_conflict" }, { status: 404, code: "workspace_not_found" }, { status: 403, code: "access_revoked" }, { status: 0, code: "read_failed" }]) expect(releaseAvailability({ ok: false, ...failure }).kind).toBe("failed");
  });

  it("is Not configured when release is off and nothing the page read stands in its way", () => {
    expect(releaseView({ kind: "on", data: config() }, ready)).toMatchObject({ state: "not-configured", label: "Not configured", missing: [] });
  });

  it("is Needs approval when release is off and the room is private or its repository isn't ready, naming each and who resolves it", () => {
    const view = releaseView({ kind: "on", data: config() }, { isPublic: false, repositoryReady: false });
    expect(view).toMatchObject({ state: "needs-approval", label: "Needs approval" });
    expect(view.state === "needs-approval" && view.missing).toEqual(["The workroom has to be public. Its owner makes it public under Visibility.", "Its repository has to be Ready. The owner or an admin sets it up under Repository."]);
    // What the page couldn't read is never taken as in place.
    expect(releaseView({ kind: "on", data: config() }, { isPublic: null, repositoryReady: null })).toMatchObject({ state: "needs-approval" });
  });

  it("is Ready when release is on, whatever else is read, and says that publishes nothing by itself", () => {
    const view = releaseView({ kind: "on", data: config({ enabled: true }) }, { isPublic: false, repositoryReady: null });
    expect(view).toMatchObject({ state: "ready", label: "Ready" });
    expect(view.state === "ready" && view.text).toMatch(/Switching it on published nothing/);
  });
});

describe("Unavailable", () => {
  it("shows the state and offers nothing: no control, no field, no link, no custom domain", () => {
    show(releaseView({ kind: "off" }, ready));
    expect(screen.getByText("Unavailable")).toBeInTheDocument();
    expect(screen.getByText(UNAVAILABLE)).toBeInTheDocument();
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.queryByText("Custom domain")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("a failed read says so, rather than Unavailable", () => {
    show(releaseView({ kind: "failed" }, ready));
    expect(screen.getByRole("alert")).toHaveTextContent("Couldn't refresh.");
    expect(screen.queryByText("Unavailable")).toBeNull();
  });
});

describe("switching release on and off", () => {
  it("Not configured offers Switch release on, confirmed, sent with the version read and a key", async () => {
    show(releaseView({ kind: "on", data: config() }, ready));
    expect(screen.getByText("Not configured")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Switch release on" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent("This publishes nothing by itself.");
    expect(dialog).toHaveTextContent("A released app is public");
    await userEvent.click(within(dialog).getByRole("button", { name: "Switch release on" }));
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toMatchObject({ method: "PUT", url: "/api/v1/workspaces/ws_1/release-config", body: { enabled: true, expected_version: 4 } });
    expect(sent[0]?.key).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("Needs approval marks the control disabled but keeps it focusable, described by what's missing, and it opens nothing and sends nothing", async () => {
    show(releaseView({ kind: "on", data: config() }, { isPublic: false, repositoryReady: true }));
    const button = screen.getByRole("button", { name: "Switch release on" });
    expect(button).toHaveAttribute("aria-disabled", "true");
    expect(button).not.toHaveAttribute("disabled");
    expect(button).toHaveAccessibleDescription(/The workroom has to be public/);
    await userEvent.tab();
    expect(button).toHaveFocus();
    await userEvent.click(button);
    await userEvent.keyboard("{Enter}");
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(sent).toHaveLength(0);
  });

  it("Ready offers Switch release off, saying it unpublishes, and sends enabled false", async () => {
    show(releaseView({ kind: "on", data: config({ enabled: true, version: 9 }) }, ready));
    expect(screen.getByText("Ready")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Switch release off" }));
    expect(await screen.findByRole("alertdialog")).toHaveTextContent("The app stops being served now");
    await userEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Switch release off" }));
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toMatchObject({ method: "PUT", body: { enabled: false, expected_version: 9 } });
  });

  it("explains a refusal in words, and says nothing changed", async () => {
    reply = { status: 409, body: { error: { code: "release_needs_public_room", message: "x" } } };
    show(releaseView({ kind: "on", data: config() }, ready));
    await confirm("Switch release on", "Switch release on");
    expect(await screen.findByRole("alert")).toHaveTextContent("Only a public workroom can release.");
  });

  it("a stale version is a conflict, not a refusal", async () => {
    reply = { status: 409, body: { error: { code: "version_conflict", message: "x" } } };
    show(releaseView({ kind: "on", data: config() }, ready));
    await confirm("Switch release on", "Switch release on");
    expect(await screen.findByRole("alert")).toHaveTextContent("Release settings changed while you were looking.");
  });

  it("someone who may not configure, or an archived room, sees the state and no control", () => {
    const first = show(releaseView({ kind: "on", data: config({ enabled: true }) }, ready), { mayConfigure: false, hostname: { request: request() } });
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.getByText("Only this workroom's owner and admins can change release.")).toBeInTheDocument();
    first.unmount();
    show(releaseView({ kind: "on", data: config() }, ready), { archived: true });
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByText("This workroom is archived, so release can't be changed.")).toBeInTheDocument();
  });

  it("shows the app's address as text, never a link, since these reads don't say a release is served", () => {
    show(releaseView({ kind: "on", data: config({ enabled: true, default_host: "k3v9q2.apps.example" }) }, ready), { hostname: { request: request({ state: "claimed" }) } });
    expect(screen.getByText("k3v9q2.apps.example")).toBeInTheDocument();
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.getByText(/An address is live only once a release is served there/)).toBeInTheDocument();
  });
});

describe("the custom domain", () => {
  const on = () => releaseView({ kind: "on", data: config({ enabled: true }) }, ready);

  it("with none, offers a hostname field that catches a typo before anything is sent", async () => {
    show(on());
    const field = screen.getByLabelText("Hostname");
    await userEvent.type(field, "https://app.example.com");
    await userEvent.tab();
    expect(screen.getByText(/Enter the hostname only/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Ask for this domain" })).toBeDisabled();
    expect(sent).toHaveLength(0);
  });

  it("asks for a name, confirmed, and says nothing is held until the record is read", async () => {
    reply = { status: 200, body: { request: request() } };
    show(on());
    await userEvent.type(screen.getByLabelText("Hostname"), "app.example.com");
    await userEvent.click(screen.getByRole("button", { name: "Ask for this domain" }));
    expect(await screen.findByRole("alertdialog")).toHaveTextContent("Nothing is held until Podster reads it");
    await userEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Ask for the record" }));
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toMatchObject({ method: "PUT", url: "/api/v1/workspaces/ws_1/app-hostname", body: { hostname: "app.example.com" } });
    expect(sent[0]?.key).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("explains the hostname rules' own refusals", async () => {
    reply = { status: 409, body: { error: { code: "hostname_suspended", message: "x" } } };
    show(on());
    await userEvent.type(screen.getByLabelText("Hostname"), "app.example.com");
    await confirm("Ask for this domain", "Ask for the record");
    expect(await screen.findByRole("alert")).toHaveTextContent("A Podster operator has suspended that name");
  });

  it("pending: shows the TXT record to publish, as text, and offers to drop the request, but no second name", async () => {
    show(on(), { hostname: { request: request() } });
    expect(screen.getByText("Waiting for proof")).toBeInTheDocument();
    expect(screen.getByText("TXT")).toBeInTheDocument();
    expect(screen.getByText("_podster-challenge.app.example.com")).toBeInTheDocument();
    expect(screen.getByText("c2b1f0e9d8")).toBeInTheDocument();
    expect(screen.queryByLabelText("Hostname")).toBeNull();
    expect(screen.queryByRole("link")).toBeNull();
    await confirm("Drop this request", "Drop the request");
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toMatchObject({ method: "DELETE", url: "/api/v1/workspaces/ws_1/app-hostname" });
    expect(sent[0]?.key).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("claimed: says so, hides the record, and removing says serving stops first", async () => {
    show(on(), { hostname: { request: request({ state: "claimed" }) } });
    expect(screen.getByText("Claimed")).toBeInTheDocument();
    expect(screen.queryByText("c2b1f0e9d8")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Remove this domain" }));
    expect(await screen.findByRole("alertdialog")).toHaveTextContent("The app stops being served on this name first");
  });

  it("ending holds the room's one name with no control; a refused one says why and offers a new request", () => {
    const first = show(on(), { hostname: { request: request({ state: "ending" }) } });
    expect(screen.getByText("Being removed")).toBeInTheDocument();
    expect(screen.getAllByRole("button").map((button) => button.textContent)).toEqual(["Switch release off"]);
    expect(screen.queryByLabelText("Hostname")).toBeNull();
    first.unmount();
    show(on(), { hostname: { request: request({ state: "refused", end_reason: "hostname_claimed" }) } });
    expect(screen.getByText(/Another workroom holds this name/)).toBeInTheDocument();
    expect(screen.getByLabelText("Hostname")).toBeInTheDocument();
  });

  it("a failed hostname read is a failure, not none", () => {
    show(on(), { hostname: "failed" });
    expect(screen.getByRole("alert")).toHaveTextContent("Couldn't refresh.");
    expect(screen.queryByLabelText("Hostname")).toBeNull();
  });
});

describe("the hostname rules in words", () => {
  it("catches the obvious before sending, and leaves the rest to the API", () => {
    expect(hostnameProblem("app.example.com")).toBeNull();
    expect(hostnameProblem("App.Example.com.")).toBeNull();
    expect(hostnameProblem("bücher.example")).toBeNull();
    expect(hostnameProblem("")).toBe("Enter a hostname.");
    expect(hostnameProblem("*.example.com")).toMatch(/Wildcard/);
    expect(hostnameProblem("192.0.2.1")).toMatch(/not an IP address/);
    expect(hostnameProblem("[2001:db8::1]")).toMatch(/not an IP address/);
    expect(hostnameProblem("localhost")).toMatch(/full hostname/);
    expect(hostnameProblem("app..example.com")).toMatch(/1 to 63/);
    expect(hostnameProblem("-app.example.com")).toMatch(/letters, digits and hyphens/);
    expect(hostnameProblem("example.com/path")).toMatch(/hostname only/);
  });

  it("names an unknown reason or refusal by its code rather than guessing", () => {
    expect(describeHostname(request({ state: "ended", end_reason: "something_new" })).text).toContain("Reason code: something_new.");
    expect(explainReleaseRefusal("release_not_available")).toMatch(/isn't available/);
    expect(explainReleaseRefusal("not_allowed")).toMatch(/owner and admins/);
  });

  it("pending, claimed and ending hold the room's one name; the rest don't", () => {
    expect(["pending", "claimed", "ending"].map((state) => holdsName(request({ state: state as HostnameRequest["state"] })))).toEqual([true, true, true]);
    expect(["refused", "expired", "ended"].map((state) => holdsName(request({ state: state as HostnameRequest["state"] })))).toEqual([false, false, false]);
    expect(holdsName(null)).toBe(false);
  });
});

describe("who is named", () => {
  it("names who changed release and who asked for a hostname only by the names the server resolved, never by a bare ID", () => {
    const first = show(releaseView({ kind: "on", data: config({ enabled: true, set_by: "per_heir", updated_at: Date.UTC(2026, 10, 12) }) }, ready), { hostname: { request: request({ requested_by: "per_owner" }) }, setByName: "Heir", requestedByName: "you" });
    expect(screen.getByText("2026-11-12 by Heir")).toBeInTheDocument();
    expect(screen.getByText("2026-11-12 by you")).toBeInTheDocument();
    first.unmount();
    show(releaseView({ kind: "on", data: config({ enabled: true, set_by: "per_stranger", updated_at: Date.UTC(2026, 10, 12) }) }, ready), { hostname: { request: request({ requested_by: "per_stranger" }) } });
    expect(screen.queryByText(/per_stranger/)).toBeNull();
    expect(screen.getAllByText("2026-11-12")).toHaveLength(2);
  });
});
