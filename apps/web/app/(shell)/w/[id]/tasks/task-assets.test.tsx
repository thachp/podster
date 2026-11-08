import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RoomFile } from "@/components/files/model";
import { TaskAssets } from "./task-assets";

type Sent = { method: string; url: string };
let sent: Sent[] = [];
let files: RoomFile[] = [];
let listStatus = 200;
let pageSize = 50;
let narrowed = false;

const file = (over: Partial<RoomFile> = {}): RoomFile => ({ id: "obj_1", name: "spec.pdf", size: 1200, sha256: "a".repeat(64), media_type: "application/pdf", state: "ready", download_path: "/v1/files/ws_1/obj_1", linked_tasks: ["tsk_1"], ...over });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

beforeEach(() => {
  sent = [];
  files = [file(), file({ id: "obj_2", name: "notes.txt", state: "scanning", download_path: null })];
  listStatus = 200;
  pageSize = 50;
  narrowed = false;
  vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
    sent.push({ method: init.method ?? "GET", url });
    if (url.includes("/files?")) {
      if (listStatus !== 200) return json({ error: { code: "upstream_unavailable" } }, listStatus);
      // As the API pages: the cursor is the last file returned, by its ID.
      const after = new URL(url, "http://local").searchParams.get("cursor");
      const from = after ? files.findIndex((file) => file.id === after) + 1 : 0;
      const page = files.slice(from, from + pageSize);
      return json({ files: page, next_cursor: from + pageSize < files.length ? page.at(-1)!.id : null, ...(narrowed ? {} : { quota: { used: 0, limit: 5_000_000_000 } }) });
    }
    const one = files.find((known) => url.endsWith(`/files/${known.id}`));
    if (one) return json(one);
    if ((init.method ?? "GET") === "GET" && url.includes("/files/obj_")) return json({ error: { code: "file_not_found" } }, 404);
    return json({ linked: false });
  });
});
afterEach(() => vi.unstubAllGlobals());

const show = (canManage = false, archived = false) => render(<TaskAssets workspace="ws_1" taskId="tsk_1" canManage={canManage} archived={archived} />);

describe("a task's attached files", () => {
  it("reads only this task's files and shows each one's state, with a download only when ready", async () => {
    show();
    const list = await screen.findByRole("list", { name: "Attached files" });
    expect(sent[0]?.url).toBe("/api/v1/workspaces/ws_1/files?task_id=tsk_1&cursor=");
    expect(within(list).getByText("Ready")).toBeInTheDocument();
    expect(within(list).getByText("Scanning")).toBeInTheDocument();
    expect(within(list).getAllByRole("button", { name: /^Download/ })).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Download spec.pdf" })).toBeInTheDocument();
  });

  it("gives an assignee no remove control", async () => {
    show(false);
    await screen.findByRole("list", { name: "Attached files" });
    expect(screen.queryByRole("button", { name: /Remove from task/ })).not.toBeInTheDocument();
  });

  it("lets someone who may attach remove a file, and reads again", async () => {
    show(true);
    await screen.findByRole("list", { name: "Attached files" });
    files = [files[1]!];
    await userEvent.click(screen.getByRole("button", { name: "Remove from task: spec.pdf" }));
    expect(await screen.findByText(/Removed spec\.pdf from this task/)).toBeInTheDocument();
    expect(sent.find((request) => request.method === "DELETE")?.url).toBe("/api/v1/workspaces/ws_1/files/obj_1/links/tsk_1");
    await vi.waitFor(() => expect(screen.queryByText("spec.pdf")).not.toBeInTheDocument());
  });

  it("offers a member narrowed to some tasks no removal, only the download", async () => {
    // Detaching follows attaching's rule, and only someone who sees the whole room gets `quota`.
    narrowed = true;
    show(true);
    await screen.findByRole("list", { name: "Attached files" });
    expect(screen.queryByRole("button", { name: /Remove from task/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Download spec.pdf" })).toBeInTheDocument();
  });

  it("offers no removal in an archived room", async () => {
    show(true, true);
    await screen.findByRole("list", { name: "Attached files" });
    expect(screen.queryByRole("button", { name: /Remove from task/ })).not.toBeInTheDocument();
  });

  it("reads every page, however few files each one holds", async () => {
    // A narrowed reader's pages can hold fewer than 50, so how far to read comes from the API, not from counting.
    pageSize = 1;
    show();
    const list = await screen.findByRole("list", { name: "Attached files" });
    await vi.waitFor(() => expect(within(list).getAllByRole("listitem")).toHaveLength(2));
    expect(screen.queryByRole("button", { name: "Load more files" })).not.toBeInTheDocument();
    expect(sent.filter((request) => request.url.includes("/files?")).map((request) => request.url.split("cursor=")[1])).toEqual(["", files[0].id]);
  });

  it("stops at a page with no cursor, rather than reading on", async () => {
    vi.stubGlobal("fetch", async (url: string) => {
      sent.push({ method: "GET", url });
      return json({ files });
    });
    show();
    await screen.findByRole("list", { name: "Attached files" });
    expect(sent.filter((request) => request.url.includes("/files?"))).toHaveLength(1);
  });

  it("says a file that went while it was being downloaded has gone, in the notice", async () => {
    show();
    await screen.findByRole("list", { name: "Attached files" });
    files = [files[1]!];
    await userEvent.click(screen.getByRole("button", { name: "Download spec.pdf" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("spec.pdf isn't there any more");
    expect(alert.closest("[tabindex='-1']")).toHaveFocus();
    expect(screen.queryByText("spec.pdf", { selector: "span" })).not.toBeInTheDocument();
  });

  it("says when there are none, and when the read failed", async () => {
    files = [];
    const { unmount } = show();
    expect(await screen.findByText("No files attached.")).toBeInTheDocument();
    unmount();
    listStatus = 502;
    show();
    expect(await screen.findByText("Couldn't load the attached files.")).toBeInTheDocument();
    expect(screen.queryByText("No files attached.")).not.toBeInTheDocument();
  });
});
