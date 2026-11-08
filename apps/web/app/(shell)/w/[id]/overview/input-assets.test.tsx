import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RoomFile } from "@/components/files/model";
import { InputAssets, type TaskChoice } from "./input-assets";

const upload = vi.hoisted(() => ({ uploadFile: vi.fn() }));
vi.mock("@/lib/uploads/client", () => upload);
const signIn = vi.hoisted(() => ({ goToSignIn: vi.fn() }));
vi.mock("@/app/(shell)/w/[id]/tasks/go-to-sign-in", () => signIn);

type Sent = { method: string; url: string; body: unknown; key: string | null };
let sent: Sent[] = [];
let files: RoomFile[] = [];
let answer: (request: Sent) => Response | undefined;

const file = (over: Partial<RoomFile> = {}): RoomFile => ({ id: "obj_1", name: "brief.pdf", size: 2_500_000, sha256: "a".repeat(64), media_type: "application/pdf", state: "ready", download_path: "/v1/files/ws_1/obj_1", linked_tasks: [], ...over });
const tasks: TaskChoice[] = [
  { id: "tsk_open", title: "Write the plan", status: "open" },
  { id: "tsk_done", title: "Old work", status: "completed" },
];
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers });

beforeEach(() => {
  sent = [];
  files = [file()];
  answer = () => undefined;
  upload.uploadFile.mockReset();
  signIn.goToSignIn.mockReset();
  vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
    const request = { method: init.method ?? "GET", url, body: init.body ? JSON.parse(String(init.body)) : undefined, key: new Headers(init.headers).get("idempotency-key") };
    sent.push(request);
    const special = answer(request);
    if (special) return special;
    if (request.method === "GET" && url.includes("/files?")) return json({ files, next_cursor: null, quota: WHOLE_ROOM });
    const one = files.find((known) => url.endsWith(`/files/${known.id}`));
    if (request.method === "GET" && one) return json(one);
    return json({ linked: true });
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** `quota` comes only to someone who sees the whole room. */
const WHOLE_ROOM = { used: 0, limit: 5_000_000_000 };
const show = (props: Partial<React.ComponentProps<typeof InputAssets>> = {}) => render(<InputAssets workspace="ws_1" initial={{ files, next_cursor: null, quota: WHOLE_ROOM }} tasks={tasks} tasksComplete canManage archived={false} {...props} />);
const row = (name: string) => screen.getByRole("listitem", { name });

describe("the list", () => {
  it("shows each file's name, size and state, and never calls a file safe", () => {
    files = [file(), file({ id: "obj_2", name: "draft.docx", state: "scanning", download_path: null }), file({ id: "obj_3", name: "bad.zip", state: "blocked", download_path: null }), file({ id: "obj_4", name: "slow.mp4", state: "failed", download_path: null })];
    show();
    expect(within(row("brief.pdf")).getByText("Ready")).toBeInTheDocument();
    expect(within(row("brief.pdf")).getByText("No known malware found.")).toBeInTheDocument();
    expect(within(row("brief.pdf")).getByText(/2\.5 MB/)).toBeInTheDocument();
    expect(within(row("draft.docx")).getByText("Scanning")).toBeInTheDocument();
    expect(within(row("bad.zip")).getByText("Blocked")).toBeInTheDocument();
    expect(within(row("slow.mp4")).getByText("Scan failed")).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/\b(safe|virus-free)\b/i);
    // Only a ready file offers a download.
    expect(screen.getAllByRole("button", { name: /^Download/ })).toHaveLength(1);
    expect(screen.getByText(/workroom holds up to 5 GB/)).toBeInTheDocument();
  });

  it("shows a file's name as inert text", () => {
    files = [file({ name: "[click me](https://evil.example) <b>x</b>" })];
    show();
    expect(screen.queryByRole("link", { name: /click me/ })).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "[click me](https://evil.example) <b>x</b>" })).toBeInTheDocument();
  });

  it("names the tasks a file is attached to, linking to each", () => {
    files = [file({ linked_tasks: ["tsk_open", "tsk_hidden"] })];
    show();
    expect(screen.getByRole("link", { name: "Write the plan" })).toHaveAttribute("href", "/w/ws_1/tasks?task=tsk_open");
    expect(screen.getByRole("link", { name: "Task tsk_hidden" })).toBeInTheDocument();
  });

  it("offers no upload or attach to someone who can't", () => {
    files = [file({ linked_tasks: ["tsk_open"] })];
    show({ canManage: false });
    expect(screen.queryByLabelText("Asset upload")).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/Attach to a task/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Remove/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Download brief.pdf" })).toBeInTheDocument();
  });

  it("offers nothing new in an archived room", () => {
    show({ archived: true });
    expect(screen.queryByLabelText("Asset upload")).not.toBeInTheDocument();
    expect(screen.getByText(/archived, so nothing new/)).toBeInTheDocument();
  });

  it("reads again when the server's read failed, and says so if that fails too", async () => {
    answer = (request) => (request.url.includes("/files?") ? json({ error: { code: "upstream_unavailable" } }, 502) : undefined);
    show({ initial: null });
    expect(await screen.findByText("Couldn't load the files.")).toBeInTheDocument();
    expect(screen.queryByText(/No input assets/)).not.toBeInTheDocument();
  });
});

describe("scanning", () => {
  it("says Scanning until the API gives a verdict, then announces it", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    files = [file({ state: "scanning", download_path: null })];
    show();
    expect(within(row("brief.pdf")).getByText("Scanning")).toBeInTheDocument();
    await act(() => vi.advanceTimersByTimeAsync(10_000));
    expect(within(row("brief.pdf")).getByText("Scanning")).toBeInTheDocument();
    files = [file({ state: "ready" })];
    await act(() => vi.advanceTimersByTimeAsync(10_000));
    expect(within(row("brief.pdf")).getByText("Ready")).toBeInTheDocument();
    expect(screen.getByText(/brief\.pdf: Ready\. No known malware found\./)).toBeInTheDocument();
    const reads = sent.length;
    await act(() => vi.advanceTimersByTimeAsync(30_000));
    expect(sent.length).toBe(reads);
  });
});

describe("downloads", () => {
  it("reads the file again first, and says why when it can't be downloaded now", async () => {
    show();
    files = [file({ state: "blocked", download_path: null })];
    await userEvent.click(screen.getByRole("button", { name: "Download brief.pdf" }));
    expect(await screen.findByText(/can't be downloaded now\. Its state is Blocked/)).toBeInTheDocument();
  });

  it("keeps saying a gone file is gone after its row goes, with focus on the notice", async () => {
    files = [file(), file({ id: "obj_2", name: "notes.txt" })];
    show();
    answer = (request) => (request.url.endsWith("/files/obj_1") ? json({ error: { code: "file_not_found" } }, 404) : undefined);
    await userEvent.click(screen.getByRole("button", { name: "Download brief.pdf" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("brief.pdf isn't there any more, or your access no longer includes it.");
    expect(screen.queryByRole("listitem", { name: "brief.pdf" })).not.toBeInTheDocument();
    expect(alert.closest("[tabindex='-1']")).toHaveFocus();
    expect(row("notes.txt")).toBeInTheDocument();
  });

  it("sends a signed-out person to sign in, rather than calling the file gone", async () => {
    show();
    answer = (request) => (request.url.endsWith("/files/obj_1") ? json({ error: { code: "unauthenticated" } }, 401) : undefined);
    await userEvent.click(screen.getByRole("button", { name: "Download brief.pdf" }));
    await vi.waitFor(() => expect(signIn.goToSignIn).toHaveBeenCalledTimes(1));
    expect(row("brief.pdf")).toBeInTheDocument();
    expect(screen.queryByText(/isn't there any more/)).not.toBeInTheDocument();
  });

  it("starts an attachment download through this host's /api", async () => {
    const clicked: string[] = [];
    const original = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) {
      clicked.push(`${this.getAttribute("href")} download=${this.hasAttribute("download")}`);
    };
    try {
      show();
      await userEvent.click(screen.getByRole("button", { name: "Download brief.pdf" }));
      await vi.waitFor(() => expect(clicked).toEqual(["/api/v1/files/ws_1/obj_1 download=true"]));
    } finally {
      HTMLAnchorElement.prototype.click = original;
    }
  });
});

describe("attaching", () => {
  it("attaches to an open task, never a finished one, and reads the list again", async () => {
    show();
    const select = screen.getByLabelText(/Attach to a task/);
    expect(within(select).queryByRole("option", { name: "Old work" })).not.toBeInTheDocument();
    await userEvent.selectOptions(select, "tsk_open");
    files = [file({ linked_tasks: ["tsk_open"] })];
    await userEvent.click(screen.getByRole("button", { name: "Attach" }));
    expect(await screen.findByText(/Attached brief\.pdf to Write the plan/)).toBeInTheDocument();
    const post = sent.find((request) => request.method === "POST");
    expect(post).toMatchObject({ url: "/api/v1/workspaces/ws_1/files/obj_1/links", body: { task_id: "tsk_open" } });
    expect(post?.key).toBeTruthy();
    expect(await screen.findByRole("link", { name: "Write the plan" })).toBeInTheDocument();
  });

  it.each([
    ["task_closed", 409, /completed or canceled/],
    ["file_not_available", 409, /scanning or ready/],
    ["limit_exceeded", 409, /50 files/],
  ])("explains %s", async (code, status, text) => {
    answer = (request) => (request.method === "POST" ? json({ error: { code } }, status) : undefined);
    show();
    await userEvent.selectOptions(screen.getByLabelText(/Attach to a task/), "tsk_open");
    await userEvent.click(screen.getByRole("button", { name: "Attach" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(text);
  });

  it("gives the wait a rate limit asks for", async () => {
    answer = (request) => (request.method === "POST" ? json({ error: { code: "rate_limited" } }, 429, { "retry-after": "20" }) : undefined);
    show();
    await userEvent.selectOptions(screen.getByLabelText(/Attach to a task/), "tsk_open");
    await userEvent.click(screen.getByRole("button", { name: "Attach" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Wait 20 seconds and try again.");
  });

  it("after a lost answer, tries again with the same key", async () => {
    let first = true;
    answer = (request) => {
      if (request.method !== "POST") return undefined;
      if (first) {
        first = false;
        return json({ error: { code: "upstream_unavailable" } }, 502);
      }
      return undefined;
    };
    show();
    await userEvent.selectOptions(screen.getByLabelText(/Attach to a task/), "tsk_open");
    await userEvent.click(screen.getByRole("button", { name: "Attach" }));
    await userEvent.click(await screen.findByRole("button", { name: "Try again" }));
    expect(await screen.findByText(/Attached brief\.pdf/)).toBeInTheDocument();
    const posts = sent.filter((request) => request.method === "POST");
    expect(posts).toHaveLength(2);
    expect(posts[0]?.key).toBe(posts[1]?.key);
  });

  it("isn't offered for a blocked file", () => {
    files = [file({ state: "blocked", download_path: null })];
    show();
    expect(screen.queryByLabelText(/Attach to a task/)).not.toBeInTheDocument();
    expect(screen.getByText(/Only a file that's scanning or ready can be attached/)).toBeInTheDocument();
  });

  it("removes an attachment and moves focus to the result", async () => {
    files = [file({ linked_tasks: ["tsk_open"] })];
    show();
    files = [file()];
    await userEvent.click(screen.getByRole("button", { name: "Remove brief.pdf from Write the plan" }));
    const notice = await screen.findByText(/Removed brief\.pdf from Write the plan/);
    expect(sent.find((request) => request.method === "DELETE")?.url).toBe("/api/v1/workspaces/ws_1/files/obj_1/links/tsk_open");
    expect(notice.closest("[tabindex='-1']")).toHaveFocus();
    expect(await screen.findByText("No tasks you can see.")).toBeInTheDocument();
  });
});

describe("uploading", () => {
  const choose = async (name = "notes.txt", size = 10) => {
    const chosen = new File(["x".repeat(size)], name, { type: "text/plain" });
    await userEvent.upload(screen.getByLabelText("Asset upload"), chosen);
    return chosen;
  };

  it("uploads through the browser client, then says it's scanning, not ready", async () => {
    upload.uploadFile.mockImplementation(async (_ws: string, _file: File, options: { onProgress: (progress: unknown) => void }) => {
      options.onProgress({ phase: "sending", sent: 5, total: 10 });
      return { ok: true, data: { id: "obj_2", state: "scanning", size: 10, sha256: "b".repeat(64) } };
    });
    show();
    const chosen = await choose();
    files = [file(), file({ id: "obj_2", name: "notes.txt", state: "scanning", download_path: null })];
    await userEvent.click(screen.getByRole("button", { name: "Upload" }));
    expect(await screen.findByText(/Uploaded notes\.txt\. It's being scanned now/)).toBeInTheDocument();
    expect(upload.uploadFile).toHaveBeenCalledWith("ws_1", chosen, expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(await screen.findByRole("listitem", { name: "notes.txt" })).toHaveTextContent("Scanning");
  });

  it("refuses a file over 100 MB before reading it", async () => {
    show();
    const big = new File(["x"], "huge.mov");
    Object.defineProperty(big, "size", { value: 100_000_001 });
    await userEvent.upload(screen.getByLabelText("Asset upload"), big);
    expect(screen.getByText(/over 100 MB/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Upload" })).toBeDisabled();
  });

  it.each([
    ["file_too_large", 413, /over 100 MB/],
    ["executable_refused", 415, /programs, installers/],
    ["room_quota_exceeded", 409, /doesn't have space/],
  ])("explains %s, with nothing to retry", async (code, status, text) => {
    upload.uploadFile.mockResolvedValue({ ok: false, status, code });
    show();
    await choose();
    await userEvent.click(screen.getByRole("button", { name: "Upload" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(text);
    expect(within(alert).queryByRole("button", { name: "Try again" })).not.toBeInTheDocument();
  });

  it("waits out a rate limit's retry-after, saying so, before sending again", async () => {
    const retry = vi.fn(async () => ({ ok: true, data: { id: "obj_2", state: "scanning", size: 10, sha256: "b".repeat(64) } }));
    upload.uploadFile.mockResolvedValue({ ok: false, status: 429, code: "rate_limited", retry, retryAfter: 15 });
    show();
    await choose();
    await userEvent.click(screen.getByRole("button", { name: "Upload" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Wait 15 seconds and try again.");
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(retry).toHaveBeenCalledTimes(1);
    expect(await screen.findByText(/Uploaded notes\.txt/)).toBeInTheDocument();
  });

  it("holds Try again until a refused reservation's retry-after passes, at most 300 seconds", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    upload.uploadFile.mockResolvedValueOnce({ ok: false, status: 429, code: "rate_limited", retryAfter: 15 });
    show();
    await user.upload(screen.getByLabelText("Asset upload"), new File(["x"], "notes.txt", { type: "text/plain" }));
    await user.click(screen.getByRole("button", { name: "Upload" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Wait 15 seconds and try again.");
    expect(screen.getByRole("button", { name: "Try again in 15 seconds" })).toBeDisabled();
    await act(() => vi.advanceTimersByTimeAsync(14_000));
    expect(screen.getByRole("button", { name: "Try again in 15 seconds" })).toBeDisabled();
    await act(() => vi.advanceTimersByTimeAsync(1_000));
    upload.uploadFile.mockResolvedValueOnce({ ok: false, status: 429, code: "rate_limited", retryAfter: 9_000 });
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(upload.uploadFile).toHaveBeenCalledTimes(2);
    expect(await screen.findByRole("button", { name: "Try again in 300 seconds" })).toBeDisabled();
    await act(() => vi.advanceTimersByTimeAsync(300_000));
    expect(screen.getByRole("button", { name: "Try again" })).toBeEnabled();
  });

  it("can be canceled", async () => {
    upload.uploadFile.mockImplementation(
      (_ws: string, _file: File, options: { signal: AbortSignal }) => new Promise((done) => options.signal.addEventListener("abort", () => done({ ok: false, status: 0, code: "upload_canceled" }))),
    );
    show();
    await choose();
    await userEvent.click(screen.getByRole("button", { name: "Upload" }));
    await userEvent.click(await screen.findByRole("button", { name: "Cancel upload" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/Upload canceled/);
  });
});

describe("quota", () => {
  it("shows the room's use when the API sends it", () => {
    show({ initial: { files, next_cursor: null, quota: { used: 1_250_000_000, limit: 5_000_000_000 } } });
    expect(screen.getByText(/1\.3 GB of 5 GB used/)).toBeInTheDocument();
    expect(screen.getByRole("meter", { name: "Workroom storage used" })).toBeInTheDocument();
  });

  it("shows no figure without one, only the limit, and offers a narrowed member no upload or attach", () => {
    // Only someone who sees the whole room gets `quota`, so a member without it is narrowed to some tasks.
    files = [file({ linked_tasks: ["tsk_open"] })];
    show({ initial: { files, next_cursor: null } });
    expect(screen.queryByText(/ used,/)).not.toBeInTheDocument();
    expect(screen.queryByRole("meter")).not.toBeInTheDocument();
    expect(screen.getByText(/workroom holds up to 5 GB/)).toBeInTheDocument();
    expect(screen.queryByLabelText("Asset upload")).not.toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: /Attach to a task/ })).not.toBeInTheDocument();
    expect(screen.queryByText(/Upload one above/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Remove/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Download brief.pdf" })).toBeInTheDocument();
  });
});
