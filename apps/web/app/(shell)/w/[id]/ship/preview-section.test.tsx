import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setUrl } from "@/test/next-navigation";
import { OPENING_NEEDS_ACCESS, PREVIEW_HIDDEN, PREVIEW_HOSTNAME_PENDING, PREVIEW_UNAVAILABLE, PREVIEWS_ARENT_PRODUCTION, PREVIEWS_OFF, PRIVATE_CANT_PUBLISH, STORAGE_WARNING, type Preview, type PreviewRead, type PreviewRelease } from "./preview-model";
import { PreviewSection, type PreviewSectionProps } from "./preview-section";

// M8 step 11: the Ship panel's preview card in apps/web, wired to getPreview, requestPreview, deletePreview and
// requestRelease with from_preview. Controls show only where the API's answers allow them.

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const BUILD_A = `bld_${"1a".repeat(16)}`;
const REL_A = `rel_${"0a".repeat(16)}`;
const release = (over: Partial<PreviewRelease> = {}): PreviewRelease => ({ id: REL_A, task_id: "tsk_a", commit_sha: SHA_A, state: "served", build_id: BUILD_A, storage_warning: false, requested_by: "per_o", requested_at: 1, served_at: Date.UTC(2026, 10, 27, 9), failure_code: null, finished_at: 2, ...over });
const preview = (over: Partial<Preview> = {}): Preview => ({ state: "active", serving: release(), replacement: null, default_host: "p-7f3k2q9m.podster.site", custom_host: null, ...over });
const read = (p: Preview | null): PreviewRead => ({ kind: "read", preview: p });

const sent: { method: string; url: string; body: unknown; key: string | null }[] = [];
let replies: Record<string, { status: number; body: unknown }>;

beforeEach(() => {
  setUrl("/w/ws_1/ship");
  sent.length = 0;
  replies = {};
  vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? "GET";
    sent.push({ method, url, body: init.body ? JSON.parse(String(init.body)) : null, key: new Headers(init.headers).get("idempotency-key") });
    const reply = replies[`${method} ${url}`] ?? { status: 200, body: {} };
    return new Response(JSON.stringify(reply.body), { status: reply.status });
  });
});
afterEach(() => vi.unstubAllGlobals());

const show = (over: Partial<PreviewSectionProps> = {}) =>
  render(<PreviewSection roomId="ws_1" read={read(preview())} manages isPublic archived={false} repository="podsterdev/hello" tasks={[{ id: "tsk_a", title: "Ship the todo app" }, { id: "tsk_b", title: "Add a filter" }]} taskTitles={{ tsk_a: "Ship the todo app", tsk_b: "Add a filter" }} {...over} />);

const confirm = async (open: string, button: string) => {
  await userEvent.click(screen.getByRole("button", { name: open }));
  await userEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: button }));
};

describe("the card's states", () => {
  it("says why there's no card when the read isn't an answer about a preview, and offers nothing", () => {
    for (const [r, text] of [
      [{ kind: "unavailable" }, PREVIEW_UNAVAILABLE],
      [{ kind: "off" }, PREVIEWS_OFF],
      [{ kind: "hidden" }, PREVIEW_HIDDEN],
    ] as const) {
      const { container, unmount } = show({ read: r });
      expect(container).toHaveTextContent(text);
      expect(screen.queryByRole("button")).toBeNull();
      expect(screen.queryByRole("link")).toBeNull();
      unmount();
    }
    const { container } = show({ read: { kind: "failed" } });
    expect(container.textContent).not.toMatch(/None|Ready/);
  });

  it("None: no link and nothing to publish, and the owner or an admin may make one", () => {
    show({ read: read(null) });
    expect(screen.getByText("None")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Open preview" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Publish this build" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Delete preview" })).toBeNull();
    expect(screen.getByLabelText("Make a preview of a finished task")).toBeInTheDocument();
  });

  it("Ready: the commit linked to the repository, the build short with the full ID on hover, the link, the access line and the differences", () => {
    show({ read: read(preview({ serving: release({ storage_warning: true }) })) });
    expect(screen.getByText("Ready")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Commit aaaaaaa in the repository" })).toHaveAttribute("href", `https://github.com/podsterdev/hello/commit/${SHA_A}`);
    expect(screen.getByText("bld_1a1a1a1a")).toHaveAttribute("title", BUILD_A);
    expect(screen.getByRole("button", { name: "Copy the full build ID" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open preview" })).toHaveAttribute("href", "https://p-7f3k2q9m.podster.site/");
    expect(document.body).toHaveTextContent(OPENING_NEEDS_ACCESS);
    expect(document.body).toHaveTextContent(PREVIEWS_ARENT_PRODUCTION);
    expect(document.body).toHaveTextContent(STORAGE_WARNING);
    expect(screen.getByText("Commit").nextElementSibling).toHaveTextContent("aaaaaaa · Ship the todo app");
  });

  it("shows no storage warning for a build without one", () => {
    show();
    expect(document.body).not.toHaveTextContent(STORAGE_WARNING);
  });

  it("Building: the commit on its way, no link, and no second ask while it's in flight", () => {
    show({ read: read(preview({ serving: null, replacement: release({ state: "uploading", build_id: null }) })) });
    expect(screen.getByText("Building")).toBeInTheDocument();
    expect(document.body).toHaveTextContent("It isn't served yet");
    expect(screen.queryByRole("link", { name: "Open preview" })).toBeNull();
    expect(screen.queryByLabelText(/finished task/)).toBeNull();
  });

  it("Replacing: the current build still served and linked, with the new commit named and no second ask", () => {
    show({ read: read(preview({ replacement: release({ id: `rel_${"0b".repeat(16)}`, commit_sha: SHA_B, state: "queued", build_id: null }) })) });
    expect(screen.getByText("Replacing")).toBeInTheDocument();
    expect(document.body).toHaveTextContent("The preview still shows aaaaaaa until the new build answers");
    expect(screen.getByRole("link", { name: "Open preview" })).toBeInTheDocument();
    expect(screen.queryByLabelText(/finished task/)).toBeNull();
  });

  it("Replacement failed: the plan's sentence, with the last working preview still served", () => {
    show({ read: read(preview({ replacement: release({ id: `rel_${"0b".repeat(16)}`, commit_sha: SHA_B, state: "failed", build_id: null, failure_code: "release_marker_missing" }) })) });
    expect(screen.getByText("Replacement failed")).toBeInTheDocument();
    expect(document.body).toHaveTextContent("Replacing with bbbbbbb failed: the new build didn't answer on the preview host in time. The preview still shows aaaaaaa.");
    expect(screen.getByRole("link", { name: "Open preview" })).toBeInTheDocument();
    expect(screen.getByLabelText("Replace the preview with a finished task")).toBeInTheDocument();
  });

  it("Deleting: nothing to open, ask or publish", () => {
    show({ read: read(preview({ state: "deleting" })) });
    expect(screen.getByText("Deleting")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Open preview" })).toBeNull();
    expect(screen.queryAllByRole("button").map((button) => button.getAttribute("aria-label") ?? button.textContent)).toEqual(["Copy the full build ID"]);
    expect(screen.queryByLabelText(/finished task/)).toBeNull();
  });

  it("shows a custom preview hostname only as the read gives it, links it only once active, and marks where its controls go", () => {
    const { unmount } = show({ read: read(preview({ custom_host: { hostname: "preview.example.com", setup_status: "proof_pending" } })) });
    const section = screen.getByRole("region", { name: "Custom preview hostname" });
    expect(section).toHaveTextContent("preview.example.com · Waiting for proof");
    expect(within(section).queryByRole("link")).toBeNull();
    expect(section).toHaveTextContent(PREVIEW_HOSTNAME_PENDING);
    unmount();
    show({ manages: false, read: read(preview({ custom_host: { hostname: "preview.example.com", setup_status: "active" } })) });
    expect(within(screen.getByRole("region", { name: "Custom preview hostname" })).getByRole("link", { name: "preview.example.com" })).toHaveAttribute("href", "https://preview.example.com/");
    expect(document.body).not.toHaveTextContent(PREVIEW_HOSTNAME_PENDING);
  });
});

describe("controls follow the API's answers", () => {
  it("someone the release configuration didn't answer sees the preview, its link and Publish, and no make, replace or delete", () => {
    show({ manages: false, isPublic: null });
    expect(screen.getByRole("link", { name: "Open preview" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Delete|Replace|Make/ })).toBeNull();
    expect(screen.queryByLabelText(/finished task/)).toBeNull();
    expect(screen.getByRole("button", { name: "Publish this build" })).toBeInTheDocument();
  });

  it("a member's publish is decided by the API, and its refusal said inline", async () => {
    replies["POST /api/v1/workspaces/ws_1/releases"] = { status: 403, body: { error: { code: "grant_required" } } };
    show({ manages: false, isPublic: null });
    await confirm("Publish this build", "Ask to publish");
    expect(await screen.findByRole("alert")).toHaveTextContent(/deployment grant.*Nothing was asked for\./);
  });

  it("a private room says why it can't publish, in place of the button", () => {
    show({ isPublic: false });
    expect(screen.queryByRole("button", { name: "Publish this build" })).toBeNull();
    expect(document.body).toHaveTextContent(PRIVATE_CANT_PUBLISH);
  });

  it("an unread visibility still offers publish, for the API to decide, and claims nothing about the room", () => {
    show({ isPublic: null });
    expect(screen.getByRole("button", { name: "Publish this build" })).toBeInTheDocument();
    expect(document.body).not.toHaveTextContent(PRIVATE_CANT_PUBLISH);
  });

  it("an archived room offers no new preview or publish, and still lets the preview be deleted", () => {
    show({ archived: true });
    expect(screen.queryByLabelText(/finished task/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Publish this build" })).toBeNull();
    expect(screen.getByRole("button", { name: "Delete preview" })).toBeInTheDocument();
  });

  it("a build with no ID recorded can't be published", () => {
    show({ read: read(preview({ serving: release({ build_id: null }) })) });
    expect(screen.queryByRole("button", { name: "Publish this build" })).toBeNull();
  });
});

describe("the commands", () => {
  it("replaces the preview with a finished task's merged commit, read from the task, once, with a key", async () => {
    replies["GET /api/v1/workspaces/ws_1/tasks/tsk_b"] = { status: 200, body: { task: { id: "tsk_b" }, change: { merge_state: "succeeded", merge_sha: SHA_B } } };
    show();
    await userEvent.selectOptions(screen.getByLabelText("Replace the preview with a finished task"), "tsk_b");
    expect(await screen.findByRole("link", { name: "Commit bbbbbbb in the repository" })).toBeInTheDocument();
    await confirm("Replace preview", "Replace preview");
    const ask = sent.filter((s) => s.method === "POST");
    expect(ask).toEqual([{ method: "POST", url: "/api/v1/workspaces/ws_1/tasks/tsk_b/preview", body: { commit_sha: SHA_B }, key: expect.any(String) }]);
    expect(await screen.findByText(/keeps serving the current build/)).toBeInTheDocument();
  });

  it("offers nothing for a task with no merged commit", async () => {
    replies["GET /api/v1/workspaces/ws_1/tasks/tsk_b"] = { status: 200, body: { task: { id: "tsk_b" }, change: { merge_state: "requested", merge_sha: null } } };
    show({ read: read(null) });
    await userEvent.selectOptions(screen.getByLabelText("Make a preview of a finished task"), "tsk_b");
    expect(await screen.findByText(/hasn't recorded a merged commit/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Make a preview" })).toBeNull();
  });

  it.each([
    ["preview_in_flight", /still being made/],
    ["preview_limit", /20 asks for a day/],
    ["commit_not_releasable", /merge confirmed/],
    ["not_allowed", /owner and admins, as people/],
  ])("says the refusal %s beside the control, and that nothing changed", async (code, words) => {
    replies["GET /api/v1/workspaces/ws_1/tasks/tsk_b"] = { status: 200, body: { change: { merge_state: "succeeded", merge_sha: SHA_B } } };
    replies["POST /api/v1/workspaces/ws_1/tasks/tsk_b/preview"] = { status: code === "not_allowed" ? 403 : code === "preview_limit" ? 429 : 409, body: { error: { code } } };
    show();
    await userEvent.selectOptions(screen.getByLabelText("Replace the preview with a finished task"), "tsk_b");
    await screen.findByRole("link", { name: "Commit bbbbbbb in the repository" });
    await confirm("Replace preview", "Replace preview");
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(words);
    expect(alert).toHaveTextContent("Nothing changed.");
  });

  it("deletes the preview with no body, and says a refusal inline", async () => {
    replies["DELETE /api/v1/workspaces/ws_1/preview"] = { status: 403, body: { error: { code: "not_allowed" } } };
    show();
    await confirm("Delete preview", "Delete preview");
    expect(sent.filter((s) => s.method === "DELETE")).toEqual([{ method: "DELETE", url: "/api/v1/workspaces/ws_1/preview", body: {}, key: expect.any(String) }]);
    expect(await screen.findByRole("alert")).toHaveTextContent(/owner and admins, as people.*Nothing changed\./);
  });

  it("publishes this build by asking for a release of the preview's own task and commit, naming the preview release", async () => {
    replies["POST /api/v1/workspaces/ws_1/releases"] = { status: 200, body: { id: `rel_${"0c".repeat(16)}`, state: "awaiting_approval" } };
    show();
    await confirm("Publish this build", "Ask to publish");
    expect(sent.filter((s) => s.method === "POST")).toEqual([{ method: "POST", url: "/api/v1/workspaces/ws_1/releases", body: { task_id: "tsk_a", commit_sha: SHA_A, from_preview: REL_A }, key: expect.any(String) }]);
    expect(await screen.findByText(/Build bld_1a1a1a1a waits for the owner or an admin/)).toBeInTheDocument();
  });

  it.each([
    ["grant_required", 403, /deployment grant/],
    ["release_needs_public_room", 409, /Only a public workroom can publish/],
    ["preview_not_served", 409, /never reached the preview/],
  ])("says the publish refusal %s inline", async (code, status, words) => {
    replies["POST /api/v1/workspaces/ws_1/releases"] = { status, body: { error: { code } } };
    show();
    await confirm("Publish this build", "Ask to publish");
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(words);
    expect(alert).toHaveTextContent("Nothing was asked for.");
  });
});

describe("agent content stays text", () => {
  it("renders a task title and a hostname as text, never as markup", () => {
    const { container } = show({
      read: read(preview({ custom_host: { hostname: "<img src=x onerror=alert(1)>.example.com", setup_status: "active" } })),
      taskTitles: { tsk_a: '<script>alert(1)</script><a href="javascript:alert(1)">x</a>' },
      tasks: [{ id: "tsk_a", title: "<b>bold</b>" }],
    });
    expect(container.querySelector("script, img, b")).toBeNull();
    expect(container.querySelector('a[href^="javascript"]')).toBeNull();
    expect(container).toHaveTextContent("<script>alert(1)</script>");
    expect(within(screen.getByRole("region", { name: "Custom preview hostname" })).queryByRole("link")).toBeNull();
    expect(screen.getByRole("option", { name: "<b>bold</b>" })).toBeInTheDocument();
  });

  it("has no accessibility violations", async () => {
    const { container } = show({ read: read(preview({ serving: release({ storage_warning: true }), custom_host: { hostname: "preview.example.com", setup_status: "active" } })) });
    const results = await axe.run(container, { rules: { "color-contrast": { enabled: false } } });
    expect(results.violations).toEqual([]);
  });
});

describe("the default host", () => {
  it("is never a link unless it is a plain DNS name", async () => {
    show({ read: read(preview({ default_host: "javascript:alert(1)" })) });
    await waitFor(() => expect(screen.queryByRole("link", { name: "Open preview" })).toBeNull());
    expect(document.body).toHaveTextContent("javascript:alert(1)");
  });
});
