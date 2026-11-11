import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setUrl } from "@/test/next-navigation";
import { RepositorySection } from "./repository-section";
import { availability, explainGrantRefusal, explainRepositoryRefusal, nameProblem, PUBLIC_WARNING, reasonSentence, repositoryUrl, type RepoLink, type RepoRequest, type RoomRepository } from "./repository-model";

const request = (over: Partial<RepoRequest> = {}): RepoRequest => ({ id: "rr_1", state: "pending", name: "engineering", visibility: "public", reason: null, requested_by: "per_owner", requested_at: Date.UTC(2026, 10, 10), updated_at: Date.UTC(2026, 10, 10), attempts_left: 4, ...over });
const link = (over: Partial<RepoLink> = {}): RepoLink => ({ id: "rl_1", provider: "github", provider_repo_id: 42, full_name: "podsterdev/engineering", visibility: "public", default_branch: "main", status: "ready", status_reason: null, created_at: 1, verified_at: Date.UTC(2026, 10, 10), updated_at: 1, ...over });

const sent: { method: string; url: string; body: unknown; key: string | null }[] = [];
let reply: { status: number; body: unknown };

beforeEach(() => {
  setUrl("/w/ws_1/settings");
  sent.length = 0;
  reply = { status: 200, body: { request: request(), repository: null } };
  vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
    sent.push({ method: init.method ?? "GET", url, body: JSON.parse(String(init.body)), key: new Headers(init.headers).get("idempotency-key") });
    return new Response(JSON.stringify(reply.body), { status: reply.status });
  });
});
afterEach(() => vi.unstubAllGlobals());

const show = (state: RoomRepository, { isOwner = true, archived = false } = {}) => render(<RepositorySection roomId="ws_1" state={state} isOwner={isOwner} archived={archived} />);

describe("the switch, as the server says it", () => {
  it("reads only a missing route's answer as off; anything else that isn't an answer is a failure", () => {
    expect(availability({ ok: false, status: 404, code: "not_found" })).toEqual({ kind: "off" });
    expect(availability({ ok: true, data: { request: null, repository: null } })).toMatchObject({ kind: "on" });
    for (const failure of [{ status: 404, code: "workspace_not_found" }, { status: 403, code: "not_allowed" }, { status: 500, code: "error" }, { status: 429, code: "rate_limited" }]) expect(availability({ ok: false, ...failure }).kind).toBe("failed");
  });
});

describe("each state, in words", () => {
  it("none requested: the owner is offered the form, and someone else is told only the owner can", () => {
    show({ request: null, repository: null, delegated: true });
    expect(screen.getByText("None")).toBeInTheDocument();
    expect(screen.getByLabelText("Repository name")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create a repository" })).toBeDisabled();
  });

  it("an admin who isn't the owner sees state only", () => {
    show({ request: null, repository: null }, { isOwner: false });
    expect(screen.queryByLabelText("Repository name")).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByText("Only this workroom's owner can create its repository.")).toBeInTheDocument();
  });

  it("setting up", () => {
    show({ request: request(), repository: null });
    expect(screen.getByText("Setting up")).toBeInTheDocument();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("ready, with the repository's name and the one link built from a valid GitHub name", () => {
    show({ request: request({ state: "ready" }), repository: link() });
    expect(screen.getByText("Ready")).toBeInTheDocument();
    const anchor = screen.getByRole("link", { name: "podsterdev/engineering" });
    expect(anchor).toHaveAttribute("href", "https://github.com/podsterdev/engineering");
    expect(anchor).toHaveAttribute("rel", "noopener noreferrer nofollow");
    expect(screen.getByText("Public on GitHub")).toBeInTheDocument();
  });

  it("failed, with the reason code as a sentence and the attempts left, and retry only for the owner", () => {
    show({ request: request({ state: "failed", reason: "name_taken", attempts_left: 3 }), repository: null });
    expect(screen.getByText("Setup failed")).toBeInTheDocument();
    expect(screen.getByText(/A repository with that name already exists/)).toBeInTheDocument();
    expect(screen.getByText(/3 attempts left\./)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry setup" })).toBeInTheDocument();
  });

  it("offers no retry when none is left, and says so", () => {
    show({ request: request({ state: "failed", reason: "ruleset_missing", attempts_left: 0 }), repository: null });
    expect(screen.queryByRole("button", { name: "Retry setup" })).toBeNull();
    expect(screen.getByText(/as many times as a workroom is allowed/)).toBeInTheDocument();
  });

  it("uncertain: says honestly a repository may or may not exist, and that an operator can check", () => {
    show({ request: request({ state: "uncertain", reason: "creation_outcome_unknown" }), repository: null }, { isOwner: false });
    expect(screen.getByText("Outcome unknown")).toBeInTheDocument();
    expect(screen.getByText(/may or may not have been created/)).toBeInTheDocument();
    expect(screen.getByText(/A Podster operator can check/)).toBeInTheDocument();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("degraded and suspended say coding tasks are blocked", () => {
    const { unmount } = show({ request: request({ state: "ready" }), repository: link({ status: "degraded", status_reason: "ruleset_differs" }) });
    expect(screen.getByText("Degraded")).toBeInTheDocument();
    expect(screen.getByText(/coding tasks are blocked/)).toBeInTheDocument();
    unmount();
    show({ request: request({ state: "ready" }), repository: link({ status: "suspended" }) });
    expect(screen.getByText("Suspended")).toBeInTheDocument();
    expect(screen.getByText(/coding tasks are blocked/)).toBeInTheDocument();
  });

  it("says plainly when the organization lacks the delegation, instead of a button that will be refused", () => {
    show({ request: null, repository: null, delegated: false });
    expect(screen.getByRole("note")).toHaveTextContent("doesn't hold the delegation for managed repositories");
    expect(screen.getByRole("note")).toHaveTextContent("A Podster operator gives it.");
    expect(screen.queryByRole("button", { name: "Create a repository" })).toBeNull();
  });

  it("says it couldn't check when the delegation is unknown, and still lets the owner ask", () => {
    show({ request: null, repository: null });
    expect(screen.getByText(/couldn't check whether this workroom's organization holds the delegation/)).toBeInTheDocument();
    expect(screen.getByLabelText("Repository name")).toBeInTheDocument();
  });

  it("offers nothing in an archived room", () => {
    show({ request: null, repository: null, delegated: true }, { archived: true });
    expect(screen.queryByLabelText("Repository name")).toBeNull();
    expect(screen.getByText(/archived, so a repository can't be created/)).toBeInTheDocument();
  });
});

describe("asking for the repository", () => {
  it("checks the name to the API's rule, and sends nothing until the confirmation is confirmed", async () => {
    show({ request: null, repository: null, delegated: true });
    const field = screen.getByLabelText("Repository name");
    await userEvent.type(field, "Bad_Name");
    await userEvent.tab();
    expect(screen.getByText(/Use lower-case letters, digits and hyphens/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create a repository" })).toBeDisabled();
    await userEvent.clear(field);
    await userEvent.type(field, "engineering");
    await userEvent.click(screen.getByRole("button", { name: "Create a repository" }));
    const dialog = await screen.findByRole("alertdialog");
    // Before anything is created: public, pushed branches public at once, never deleted.
    for (const line of PUBLIC_WARNING) expect(within(dialog).getByText(line)).toBeInTheDocument();
    expect(sent).toHaveLength(0);
    await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(sent).toHaveLength(0);
    await userEvent.click(screen.getByRole("button", { name: "Create a repository" }));
    await userEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Create public repository" }));
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toMatchObject({ method: "POST", url: "/api/v1/workspaces/ws_1/repository", body: { name: "engineering", visibility: "public" } });
    expect(sent[0]?.key).toMatch(/^[0-9a-f-]{36}$/);
    expect(await screen.findByText(/Asked for the repository/)).toBeInTheDocument();
  });

  it("shows the API's refusal when it disagrees, a reserved name included", async () => {
    reply = { status: 409, body: { error: { code: "name_reserved", message: "name_reserved" } } };
    show({ request: null, repository: null, delegated: true });
    await userEvent.type(screen.getByLabelText("Repository name"), "podster");
    await userEvent.click(screen.getByRole("button", { name: "Create a repository" }));
    await userEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Create public repository" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("That name is reserved");
  });

  it("retries with a confirmation, under one key per intent", async () => {
    reply = { status: 500, body: {} };
    show({ request: request({ state: "failed", reason: "setup_call_failed", attempts_left: 2 }), repository: null });
    await userEvent.click(screen.getByRole("button", { name: "Retry setup" }));
    await userEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Retry setup" }));
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toMatchObject({ method: "POST", url: "/api/v1/workspaces/ws_1/repository/retry", body: {} });
    // An unknown outcome: trying again repeats the same intent under the same key.
    reply = { status: 200, body: { request: request(), repository: null } };
    await userEvent.click(await screen.findByRole("button", { name: "Try again" }));
    await waitFor(() => expect(sent).toHaveLength(2));
    expect(sent[1]?.key).toBe(sent[0]?.key);
  });
});

describe("what's rendered inertly", () => {
  it("shows a hostile repository name as text, links only a valid GitHub name, and strips invisible characters", () => {
    const hostile = "<img src=x onerror=alert(1)>/[x](javascript:alert(1))";
    show({ request: request({ state: "ready" }), repository: link({ full_name: hostile, default_branch: "main‮evil" }) });
    expect(screen.getByText(hostile)).toBeInTheDocument();
    expect(screen.queryByRole("link")).toBeNull();
    expect(document.querySelector("img")).toBeNull();
    expect(screen.getByText("mainevil")).toBeInTheDocument();
  });

  it("shows a degraded link's reason through the same filter as its neighbours", () => {
    show({ request: request({ state: "ready" }), repository: link({ status: "degraded", status_reason: "ruleset_\u202Ediffers\u200B" }) });
    expect(screen.getByText("ruleset_differs")).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/[\u202E\u200B]/);
  });

  it("announces the name field's problem through a live region it's described by", async () => {
    show({ request: null, repository: null, delegated: true });
    const field = screen.getByLabelText("Repository name");
    await userEvent.type(field, "Bad_Name");
    await userEvent.tab();
    const message = screen.getByText(/Use lower-case letters, digits and hyphens/);
    expect(message).toHaveAttribute("aria-live", "polite");
    expect(field).toHaveAccessibleDescription(message.textContent!);
    expect(field).toHaveAttribute("aria-invalid", "true");
  });

  it("builds a link only from an owner/name shape", () => {
    expect(repositoryUrl("podsterdev/engineering")).toBe("https://github.com/podsterdev/engineering");
    for (const bad of ["podsterdev/../x", "https://evil.example/x", "a/b/c", "podsterdev/..", "javascript:alert(1)", "evil.example/x y", "-x/y"]) expect(repositoryUrl(bad), bad).toBeNull();
  });
});

describe("every code as a sentence", () => {
  it("names every refusal for asking, retrying, granting and taking back", () => {
    const generic = explainRepositoryRefusal("something_new");
    for (const code of ["name_reserved", "not_delegated", "private_unavailable", "repo_request_exists", "retry_limit_reached", "retry_too_soon", "repo_request_not_found", "setup_in_progress", "already_ready", "not_allowed", "not_found", "workspace_archived", "rate_limited", "invalid_argument"]) {
      const text = explainRepositoryRefusal(code);
      expect(text, code).not.toBe(generic);
      expect(text, code).toMatch(/\.$/);
    }
    const genericGrant = explainGrantRefusal("something_new");
    for (const code of ["no_provider_delegation", "grantee_not_participant", "grantee_public", "repo_not_linked", "grant_not_found", "invalid_argument", "not_allowed", "not_found", "workspace_archived"]) expect(explainGrantRefusal(code), code).not.toBe(genericGrant);
  });

  it("turns every reason code the contract lists into its own sentence", () => {
    const codes = ["managed_repositories_off", "provisioning_not_configured", "token_refused", "not_delegated", "delegation_unavailable", "room_archived", "requester_not_owner", "name_taken", "provider_refused", "wrong_owner", "creation_outcome_unknown", "read_back_failed", "setup_call_failed", "wrong_repository", "visibility_differs", "archived", "no_initial_commit", "actions_enabled", "actions_unreadable", "ruleset_missing", "ruleset_inactive", "ruleset_differs", "bypass_differs", "unexpected_ruleset", "authority_lost", "internal_error"];
    const sentences = codes.map(reasonSentence);
    expect(new Set(sentences).size).toBe(codes.length);
    // None falls back to the code itself.
    for (const [index, text] of sentences.entries()) expect(text, codes[index]).not.toContain("Setup stopped (");
    expect(reasonSentence("brand_new")).toBe("Setup stopped (brand_new).");
  });

  it("checks names as the API does", () => {
    expect(nameProblem("engineering-2")).toBeNull();
    expect(nameProblem("")).not.toBeNull();
    expect(nameProblem("-lead")).not.toBeNull();
    expect(nameProblem("a".repeat(65))).not.toBeNull();
    expect(nameProblem("a".repeat(64))).toBeNull();
    expect(nameProblem("has.dot")).not.toBeNull();
  });
});
