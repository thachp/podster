import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setUrl } from "@/test/next-navigation";
import { ReleaseSection } from "./release-section";
import type { DeployGrantsProps } from "./deploy-grants";
import type { RepoGrant } from "./repository-model";
import { CUSTOM_DOMAIN_UNAVAILABLE, deployGrants, describeCheck, describeHostname, DNS_DELAY_NOTE, explainDeployGrantRefusal, explainReleaseRefusal, holdsName, hostnameAvailability, hostnameProblem, releaseAvailability, releaseView, setupRelease, switchGranted, UNAVAILABLE, WHAT_AN_APP_IS, type HostnameRead, type HostnameRequest, type Prerequisites, type ReleaseConfig } from "./release-model";

const config = (over: Partial<ReleaseConfig> = {}): ReleaseConfig => ({ enabled: false, approval_policy: "person", environments: ["production"], default_host: null, custom_host: null, version: 4, set_by: null, updated_at: null, ...over });
const request = (over: Partial<HostnameRequest> = {}): HostnameRequest => ({
  id: "hr_1",
  hostname: "app.example.com",
  state: "pending",
  setup_status: "proof_pending",
  challenge_name: "_podster-challenge.app.example.com",
  challenge_value: "c2b1f0e9d8",
  cname_target: "fallback.apps.example",
  requested_by: "per_owner",
  requested_at: Date.UTC(2026, 10, 12),
  expires_at: Date.UTC(2026, 10, 15),
  end_reason: null,
  checked_at: null,
  next_check_at: Date.UTC(2026, 10, 12),
  provider_status: null,
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

const show = (view: ReturnType<typeof releaseView>, { hostname = { request: null } as HostnameRead | null, mayConfigure = true, archived = false, setByName = null as string | null, requestedByName = null as string | null } = {}) =>
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
    // Stage 1 of apps as Workers: the person is told an app runs code on a server and has a store anyone can write to.
    expect(dialog).toHaveTextContent(WHAT_AN_APP_IS);
    expect(WHAT_AN_APP_IS).toMatch(/run its own code on Podster's servers/);
    expect(WHAT_AN_APP_IS).toMatch(/a store that anyone who opens the app can write to/);
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
    // Copying a record changes nothing, so it is the only button shown.
    expect(screen.queryAllByRole("button").filter((button) => !/^Copy /.test(button.getAttribute("aria-label") ?? ""))).toEqual([]);
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
    expect(await screen.findByRole("alertdialog")).toHaveTextContent("Nothing is held until Podster reads the TXT record");
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

  it("pending: shows the TXT and CNAME records to publish, as text, and offers to drop the request, but no second name", async () => {
    show(on(), { hostname: { request: request() } });
    expect(screen.getByText("Waiting for proof")).toBeInTheDocument();
    const txt = within(screen.getByRole("region", { name: "TXT record" }));
    expect(txt.getByText("TXT")).toBeInTheDocument();
    expect(txt.getByText("_podster-challenge.app.example.com")).toBeInTheDocument();
    expect(txt.getByText("c2b1f0e9d8")).toBeInTheDocument();
    const cname = within(screen.getByRole("region", { name: "CNAME record" }));
    expect(cname.getByText("CNAME")).toBeInTheDocument();
    expect(cname.getByText("app.example.com")).toBeInTheDocument();
    expect(cname.getByText("fallback.apps.example")).toBeInTheDocument();
    expect(screen.queryByLabelText("Hostname")).toBeNull();
    expect(screen.queryByRole("link")).toBeNull();
    await confirm("Drop this request", "Drop the request");
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toMatchObject({ method: "DELETE", url: "/api/v1/workspaces/ws_1/app-hostname" });
    expect(sent[0]?.key).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("copies each record's name and value exactly, and says so", async () => {
    const user = userEvent.setup();
    const writeText = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
    show(on(), { hostname: { request: request() } });
    // Only the last one copied says so: copying another clears the one before.
    for (const what of ["TXT record name", "TXT record value", "CNAME record name", "CNAME record target"]) {
      await user.click(screen.getByRole("button", { name: `Copy ${what}` }));
      expect(await screen.findAllByText("Copied.")).toHaveLength(1);
    }
    expect(writeText.mock.calls).toEqual([["_podster-challenge.app.example.com"], ["c2b1f0e9d8"], ["app.example.com"], ["fallback.apps.example"]]);
    expect(sent).toEqual([]);
    writeText.mockRejectedValueOnce(new Error("denied"));
    await user.click(screen.getByRole("button", { name: "Copy TXT record value" }));
    expect(await screen.findByText("Couldn't copy. Select it and copy it yourself.")).toBeInTheDocument();
    expect(screen.queryByText("Copied.")).toBeNull();
  });

  it("pending: shows when Podster last checked and next will, and Check now sends a keyed command and says what it found", async () => {
    const checked = Date.UTC(2026, 10, 12, 9, 30, 5);
    show(on(), { hostname: { request: request({ checked_at: checked, next_check_at: checked + 60_000 }) } });
    expect(screen.getByText("2026-11-12 09:30:05 UTC")).toBeInTheDocument();
    expect(screen.getByText("2026-11-12 09:31:05 UTC")).toBeInTheDocument();
    reply = { status: 200, body: { request: request({ checked_at: checked + 40_000, next_check_at: checked + 100_000 }) } };
    await userEvent.click(screen.getByRole("button", { name: "Check now" }));
    expect(await screen.findByText(/didn't find your TXT record yet/)).toBeInTheDocument();
    expect(screen.getByText(DNS_DELAY_NOTE)).toBeInTheDocument();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ method: "POST", url: "/api/v1/workspaces/ws_1/app-hostname/check", body: {} });
    expect(sent[0]?.key).toMatch(/^[0-9a-f-]{36}$/);
    // Found: the request comes back claimed, and the note on DNS delay goes.
    reply = { status: 200, body: { request: request({ state: "claimed", setup_status: "provider_pending", next_check_at: null }) } };
    await userEvent.click(screen.getByRole("button", { name: "Check now" }));
    expect(await screen.findByText("Podster read your TXT record. This workroom holds the name.")).toBeInTheDocument();
    expect(screen.queryByText(DNS_DELAY_NOTE)).toBeNull();
    expect(sent[1]?.key).not.toBe(sent[0]?.key);
  });

  it("before the first look says Not yet, and Check now's refusals are explained, saying nothing changed", async () => {
    show(on(), { hostname: { request: request() } });
    expect(screen.getByText("Not yet")).toBeInTheDocument();
    reply = { status: 429, body: { error: { code: "hostname_check_too_soon", message: "x" } } };
    await userEvent.click(screen.getByRole("button", { name: "Check now" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Podster checked this request less than 30 seconds ago. Wait a moment and try again. Nothing changed.");
    expect(screen.queryByText(DNS_DELAY_NOTE)).toBeNull();
  });

  it("Waiting for DNS: shows when Podster last read Cloudflare and next will, and Check now says what Cloudflare reported, by its code", async () => {
    const checked = Date.UTC(2026, 10, 13, 8, 0, 0);
    const waiting = (over: Partial<HostnameRequest> = {}) => request({ state: "claimed", setup_status: "provider_pending", checked_at: checked, next_check_at: checked + 120_000, provider_status: "pending", ...over });
    show(on(), { hostname: { request: waiting() } });
    expect(screen.getByText("Waiting for DNS")).toBeInTheDocument();
    expect(screen.getByText("2026-11-13 08:00:00 UTC")).toBeInTheDocument();
    expect(screen.getByText("2026-11-13 08:02:00 UTC")).toBeInTheDocument();
    reply = { status: 200, body: { request: waiting({ checked_at: checked + 60_000, provider_status: "blocked" }) } };
    await userEvent.click(screen.getByRole("button", { name: "Check now" }));
    expect(await screen.findByText("Cloudflare hasn't reported the name active yet. Its status: blocked. Podster keeps checking.")).toBeInTheDocument();
    // The note on DNS delay is about the TXT record, which was read already.
    expect(screen.queryByText(DNS_DELAY_NOTE)).toBeNull();
    expect(sent[0]).toMatchObject({ method: "POST", url: "/api/v1/workspaces/ws_1/app-hostname/check", body: {} });
    reply = { status: 200, body: { request: waiting({ setup_status: "active", provider_status: "active", next_check_at: null }) } };
    await userEvent.click(screen.getByRole("button", { name: "Check now" }));
    expect(await screen.findByText("Cloudflare reports the name active. The app is served here while a release is served.")).toBeInTheDocument();
    expect(sent).toHaveLength(2);
  });

  it("offers Check now only while waiting for proof or for Cloudflare, and only to who may change release", () => {
    const first = show(on(), { hostname: { request: request() }, mayConfigure: false });
    expect(screen.queryByRole("button", { name: "Check now" })).toBeNull();
    first.unmount();
    const second = show(on(), { hostname: { request: request({ state: "claimed", setup_status: "active", next_check_at: null }) } });
    expect(screen.queryByRole("button", { name: "Check now" })).toBeNull();
    expect(screen.queryByText("Last checked")).toBeNull();
    second.unmount();
    const ending = show(on(), { hostname: { request: request({ state: "ending", setup_status: "ended", next_check_at: null }) } });
    expect(screen.queryByRole("button", { name: "Check now" })).toBeNull();
    ending.unmount();
    const dns = show(on(), { hostname: { request: request({ state: "claimed", setup_status: "provider_pending", next_check_at: null }) } });
    expect(screen.getByRole("button", { name: "Check now" })).toBeInTheDocument();
    expect(screen.getByText("Last checked")).toBeInTheDocument();
    dns.unmount();
    const notAllowed = show(on(), { hostname: { request: request({ state: "claimed", setup_status: "provider_pending" }) }, mayConfigure: false });
    expect(screen.queryByRole("button", { name: "Check now" })).toBeNull();
    notAllowed.unmount();
    show(on(), { hostname: { request: request() }, archived: true });
    expect(screen.queryByRole("button", { name: "Check now" })).toBeNull();
  });

  it("says what a check found in words, from the request as the server answered it", () => {
    expect(describeCheck(request())).toMatchObject({ notFound: true });
    expect(describeCheck(request({ state: "claimed" }))).toEqual({ text: "Podster read your TXT record. This workroom holds the name.", notFound: false });
    expect(describeCheck(request({ state: "refused", end_reason: "hostname_claimed" }))).toEqual({ text: "Podster read your TXT record, but the name couldn't be claimed. Another workroom holds this name.", notFound: false });
    expect(describeCheck(request({ state: "expired", end_reason: "hostname_request_expired" })).notFound).toBe(false);
    expect(describeCheck(null).notFound).toBe(false);
    // From waiting for Cloudflare (2026-11-27): active, still waiting by Cloudflare's code, or ended with its reason.
    const claimed = { state: "claimed" as const, setup_status: "provider_pending" as const };
    expect(describeCheck(request({ ...claimed, setup_status: "active" }), "provider_pending").text).toMatch(/^Cloudflare reports the name active\./);
    expect(describeCheck(request({ ...claimed, provider_status: null }), "provider_pending")).toEqual({ text: "Cloudflare hasn't reported the name active yet. Podster keeps checking.", notFound: false });
    expect(describeCheck(request({ state: "ending", setup_status: "ended", end_reason: "hostname_moved" }), "provider_pending").text).toBe("Cloudflare's answer ended this workroom's use of the name. The name was moved away from Podster.");
    expect(explainReleaseRefusal("hostname_not_pending")).toMatch(/Nothing changed\.$/);
  });

  it("with no CNAME target from the server, says so and invents none", () => {
    show(on(), { hostname: { request: request({ cname_target: null }) } });
    const cname = within(screen.getByRole("region", { name: "CNAME record" }));
    expect(cname.getByText(/this deployment has no app domain set up/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Copy CNAME/ })).toBeNull();
  });

  it("claimed: waits for DNS until Cloudflare reads the name active, keeps the records shown, and removing says serving stops first", async () => {
    const first = show(on(), { hostname: { request: request({ state: "claimed", setup_status: "provider_pending" }) } });
    expect(screen.getByText("Waiting for DNS")).toBeInTheDocument();
    expect(screen.getByText("c2b1f0e9d8")).toBeInTheDocument();
    expect(screen.getByText("fallback.apps.example")).toBeInTheDocument();
    first.unmount();
    show(on(), { hostname: { request: request({ state: "claimed", setup_status: "active" }) } });
    expect(screen.getByText("Active")).toBeInTheDocument();
    expect(screen.getByText(/Cloudflare reports it active/)).toBeInTheDocument();
    expect(screen.queryByRole("link")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Remove this domain" }));
    expect(await screen.findByRole("alertdialog")).toHaveTextContent("The app stops being served on this name first");
  });

  it("ending holds the room's one name with no control; a refused one says why and offers a new request", () => {
    const first = show(on(), { hostname: { request: request({ state: "ending" }) } });
    expect(screen.getByText("Being removed")).toBeInTheDocument();
    expect(screen.queryByText("c2b1f0e9d8")).toBeNull();
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
    expect(screen.queryByText("Not available yet")).toBeNull();
  });

  it("while custom domains aren't built, says they aren't available yet and offers no field or control", () => {
    show(on(), { hostname: "unavailable" });
    expect(screen.getByText("Not available yet")).toBeInTheDocument();
    expect(screen.getByText(CUSTOM_DOMAIN_UNAVAILABLE)).toBeInTheDocument();
    expect(screen.queryByLabelText("Hostname")).toBeNull();
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.getAllByRole("button").map((button) => button.textContent)).toEqual(["Switch release off"]);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("reads the custom domain's routes answering as missing, or release_not_available, as not yet available, and nothing else", () => {
    expect(hostnameAvailability({ ok: true, data: { request: null } })).toEqual({ request: null });
    expect(hostnameAvailability({ ok: false, status: 404, code: "not_found" })).toBe("unavailable");
    expect(hostnameAvailability({ ok: false, status: 409, code: "release_not_available" })).toBe("unavailable");
    for (const failure of [{ status: 404, code: "workspace_not_found" }, { status: 403, code: "access_revoked" }, { status: 409, code: "hostname_limit" }, { status: 0, code: "read_failed" }, { status: 500, code: "internal_error" }])
      expect(hostnameAvailability({ ok: false, ...failure })).toBe("failed");
  });
});

describe("what isn't available yet", () => {
  it("while release is off for the deployment, says nothing of grants, addresses or serving", () => {
    show(releaseView({ kind: "off" }, ready));
    expect(document.body.textContent).not.toMatch(/Deployment grants|App address|Live|served at|is live/);
  });
});

const deployGrant = (over: Partial<RepoGrant> = {}): RepoGrant => ({ id: "pg_d1", principal_id: "agt_1", action: "deploy", delegated_by: "per_owner", created_at: Date.UTC(2026, 10, 20), expires_at: Date.UTC(2027, 0, 31), revoked_at: null, state: "live", ...over });
const grantsProps = (over: Partial<Omit<DeployGrantsProps, "roomId">> = {}): Omit<DeployGrantsProps, "roomId"> => ({
  read: { kind: "on", grants: [deployGrant()], mayGive: true },
  policyVersion: 9,
  viewerId: "per_owner",
  members: [
    { principal_id: "agt_1", kind: "agent", org_id: "org_a", role: "member" },
    { principal_id: "agt_pub", kind: "agent", org_id: "org_b", role: "guest", public_claim: true },
    { principal_id: "per_m", kind: "person", org_id: "org_a", role: "member" },
    { principal_id: "agt_2", kind: "agent", org_id: "org_a", role: "member" },
  ],
  names: { agt_1: "Code Agent", agt_2: "Deploy Agent" },
  ...over,
});
const showGrants = (view: ReturnType<typeof releaseView>, grants: Omit<DeployGrantsProps, "roomId"> | null) =>
  render(<ReleaseSection roomId="ws_1" view={view} hostname={{ request: null }} mayConfigure archived={false} grants={grants} />);
const readyView = () => releaseView({ kind: "on", data: config({ enabled: true }) }, ready);

describe("deployment grants, from the server's reads", () => {
  const listed = { ok: true as const, data: { grants: [deployGrant(), deployGrant({ id: "pg_p", action: "push" }), deployGrant({ id: "pg_m", action: "merge" })] } };
  const where = { linked: true, policyVersion: 9, archived: false };

  it("reads no grants while release is off in the room, and offers none", () => {
    expect(deployGrants(releaseView({ kind: "on", data: config() }, ready), listed, where)).toEqual({ kind: "off" });
    expect(deployGrants(releaseView({ kind: "on", data: config() }, { isPublic: false, repositoryReady: false }), listed, where)).toEqual({ kind: "off" });
  });

  it("is unavailable where the grants read answers as a missing route or there's no linked repository, and a failed read is a failure", () => {
    expect(deployGrants(readyView(), { ok: false, status: 404, code: "not_found" }, where)).toEqual({ kind: "unavailable" });
    expect(deployGrants(readyView(), null, where)).toEqual({ kind: "unavailable" });
    expect(deployGrants(readyView(), listed, { ...where, linked: false })).toEqual({ kind: "unavailable" });
    for (const failure of [{ status: 403, code: "not_allowed" }, { status: 0, code: "read_failed" }, { status: 404, code: "workspace_not_found" }]) expect(deployGrants(readyView(), { ok: false, ...failure }, where)).toEqual({ kind: "failed" });
  });

  it("lists only deploy grants, and offers the form only where the API sent the policy version, to an unarchived room with a linked repository", () => {
    expect(deployGrants(readyView(), listed, where)).toEqual({ kind: "on", grants: [deployGrant()], mayGive: true });
    expect(deployGrants(readyView(), listed, { ...where, policyVersion: null })).toMatchObject({ mayGive: false });
    expect(deployGrants(readyView(), listed, { ...where, archived: true })).toMatchObject({ mayGive: false });
    expect(deployGrants(readyView(), listed, { ...where, linked: null })).toMatchObject({ mayGive: false });
  });

  it("explains each refusal of a deploy grant in words that say nothing changed", () => {
    for (const code of ["invalid_argument", "release_needs_public_room", "grantee_public", "grantee_not_participant", "not_allowed", "repo_not_linked", "grant_not_found"]) {
      const text = explainDeployGrantRefusal(code, 400);
      expect(text).not.toContain(code);
      expect(text).toMatch(/Nothing changed|Reload/);
    }
    expect(explainDeployGrantRefusal("release_needs_public_room")).toMatch(/Only a public workroom can release/);
    expect(explainDeployGrantRefusal("not_allowed")).toMatch(/owner and admins, as people/);
  });
});

describe("deployment grants in the section", () => {
  it("the old fixed Unavailable text is gone, and with release off in the room says why none can be given", () => {
    showGrants(releaseView({ kind: "on", data: config() }, ready), grantsProps({ read: { kind: "off" } }));
    const grants = screen.getByRole("region", { name: "Deployment grants" });
    expect(grants).toHaveTextContent("Off");
    expect(grants).toHaveTextContent("Release is off in this workroom, so nobody can be given a deployment grant.");
    expect(document.body.textContent).not.toMatch(/Nobody can be given a deployment grant on this Podster deployment yet/);
    expect(screen.queryByRole("form", { name: "Give a deployment grant" })).toBeNull();
  });

  it("says when the grants read answers as unavailable, or failed, and offers nothing", () => {
    const { unmount } = showGrants(readyView(), grantsProps({ read: { kind: "unavailable" } }));
    expect(screen.getByRole("region", { name: "Deployment grants" })).toHaveTextContent("Unavailable");
    expect(screen.queryByRole("form", { name: "Give a deployment grant" })).toBeNull();
    unmount();
    showGrants(readyView(), grantsProps({ read: { kind: "failed" } }));
    expect(screen.getByRole("region", { name: "Deployment grants" })).toHaveTextContent("Couldn't refresh.");
    expect(screen.queryByRole("form", { name: "Give a deployment grant" })).toBeNull();
  });

  it("lists a live deploy grant: who holds it, who gave it, when, and its expiry", () => {
    showGrants(readyView(), grantsProps());
    const row = within(screen.getByRole("list", { name: "Deployment grants" })).getByRole("listitem");
    expect(row).toHaveTextContent("Code Agent");
    expect(row).toHaveTextContent("Given by You on 2026-11-20 · Expires 2027-01-31");
    expect(row).toHaveTextContent("As last read: Live");
  });

  it("offers the form only where the API allows, and then only agents not there through a public claim", () => {
    const { unmount } = showGrants(readyView(), grantsProps({ read: { kind: "on", grants: [], mayGive: false } }));
    expect(screen.getByText("Nobody holds a deployment grant here.")).toBeInTheDocument();
    expect(screen.queryByRole("form", { name: "Give a deployment grant" })).toBeNull();
    unmount();
    showGrants(readyView(), grantsProps());
    const form = screen.getByRole("form", { name: "Give a deployment grant" });
    expect(within(form).getAllByRole("option").map((option) => option.textContent)).toEqual(["Choose an agent", "agt_1 · Code Agent", "agt_2 · Deploy Agent"]);
  });

  it("gives a deploy grant with the room's policy version, and explains a refusal", async () => {
    showGrants(readyView(), grantsProps());
    const form = screen.getByRole("form", { name: "Give a deployment grant" });
    await userEvent.selectOptions(within(form).getByLabelText("Agent"), "agt_2");
    await userEvent.click(within(form).getByRole("button", { name: "Give the grant" }));
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toMatchObject({ method: "POST", url: "/api/v1/workspaces/ws_1/repository/grants", body: { policy_version: 9, principal_id: "agt_2", action: "deploy" } });
    expect(await screen.findByText(/Gave Deploy Agent a deployment grant/)).toBeInTheDocument();

    reply = { status: 409, body: { error: { code: "release_needs_public_room" } } };
    await userEvent.selectOptions(within(form).getByLabelText("Agent"), "agt_1");
    await userEvent.click(within(form).getByRole("button", { name: "Give the grant" }));
    expect(await screen.findByText(explainDeployGrantRefusal("release_needs_public_room"))).toBeInTheDocument();
  });

  it("takes a deploy grant back like any other", async () => {
    reply = { status: 200, body: deployGrant({ state: "revoked", revoked_at: 1 }) };
    showGrants(readyView(), grantsProps());
    await confirm("Take back", "Take back");
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toMatchObject({ method: "DELETE", url: "/api/v1/workspaces/ws_1/repository/grants/pg_d1", body: { policy_version: 9 } });
  });
});

describe("the organization's release switch", () => {
  it("lists an operator's take as what's missing, and never lists the switch it couldn't read", () => {
    const taken = releaseView({ kind: "on", data: config() }, { ...ready, delegated: false });
    expect(taken).toMatchObject({ state: "needs-approval" });
    expect(taken.state === "needs-approval" && taken.missing).toEqual(["A Podster operator has taken release away from this workroom's organization. Only an operator can give it back."]);
    expect(releaseView({ kind: "on", data: config() }, { ...ready, delegated: null })).toMatchObject({ state: "not-configured", missing: [] });
    expect(releaseView({ kind: "on", data: config() }, { ...ready, delegated: true })).toMatchObject({ state: "not-configured" });
  });
});

describe("refusals of release's configuration, as the contract lists them", () => {
  it("explains each code setReleaseConfig can refuse with, in its own words, and says nothing changed", () => {
    const generic = explainReleaseRefusal("something_unlisted");
    for (const code of ["release_off_for_deployment", "release_not_delegated", "release_needs_public_room", "workspace_archived", "public_surface_suspended", "app_suspended", "repo_not_ready", "organization_deleted", "workspace_deleted", "not_allowed", "not_a_participant", "release_not_available"]) {
      const text = explainReleaseRefusal(code, 409);
      expect(text, code).not.toBe(generic);
      expect(text, code).toMatch(/Nothing changed\./);
    }
    // standing_unknown is a 503 that wrote nothing, so it says so, rather than "can't tell whether this saved".
    expect(explainReleaseRefusal("standing_unknown", 503)).toMatch(/Nothing changed\. Try again\./);
  });
});

describe("release at setup", () => {
  it("is Unavailable while the switch's route answers as a missing one, and never guesses from a failure", () => {
    expect(setupRelease({ ok: false, status: 404, code: "not_found" })).toBe("unavailable");
    expect(setupRelease({ ok: true, data: { granted: true, generation: 0, last_take: 0, set_by: null, set_at: null } })).toBe("not-configured");
    expect(setupRelease({ ok: true, data: { granted: false, generation: 2, last_take: 2, set_by: "per_op", set_at: 1 } })).toBe("needs-approval");
    for (const failure of [{ status: 403, code: "not_allowed" }, { status: 404, code: "organization_not_found" }, { status: 429, code: "rate_limited" }, { status: 0, code: "read_failed" }]) expect(setupRelease({ ok: false, ...failure })).toBe("unknown");
    expect(setupRelease(null)).toBe("unknown");
  });

  it("takes a 200 of any other shape as unknown, never as an operator's take, and never throws", () => {
    for (const data of [{}, null, { granted: "false" }, { granted: 0 }, { granted: null }, "granted", []]) {
      const result = { ok: true as const, data: data as never };
      expect(setupRelease(result)).toBe("unknown");
      expect(switchGranted(result)).toBeNull();
    }
    expect(switchGranted({ ok: true, data: { granted: false, generation: 1, last_take: 1, set_by: null, set_at: null } })).toBe(false);
    expect(switchGranted({ ok: false, status: 500, code: "error" })).toBeNull();
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
