import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SheetLink } from "@/components/sheet/target-sheet";
import { setUrl } from "@/test/next-navigation";
import type { UploadResult } from "@/lib/uploads/client";
import { approvalBlocker, verifyProblem } from "./task-files-model";
import type { Room, Task, TaskDetail, TaskFile } from "./task-model";
import { Details, TaskSheet } from "./task-sheet";

vi.mock("./go-to-sign-in", () => ({ goToSignIn: vi.fn() }));

type Upload = { workspace: string; file: File; taskId?: string; finish: (result: UploadResult) => void };
let uploads: Upload[];
vi.mock("@/lib/uploads/client", () => ({
  MAX_UPLOAD_BYTES: 100_000_000,
  uploadFile: (workspace: string, file: File, options: { taskId?: string; onProgress?: (progress: unknown) => void } = {}) =>
    new Promise<UploadResult>((finish) => {
      options.onProgress?.({ phase: "hashing" });
      uploads.push({ workspace, file, taskId: options.taskId, finish });
    }),
}));

const ROOM: Room = {
  id: "ws_1",
  name: "Billing",
  owner: "per_o",
  members: [
    { principal_id: "per_me", kind: "person", org_id: "org_a", role: "member" },
    { principal_id: "agt_a", kind: "agent", org_id: "org_b", role: "member" },
  ],
};

const task = (over: Partial<Task> = {}): Task => ({ id: "tsk_1", title: "Design the API", instructions: "Write it", acceptance_criteria: null, requester: "per_r", assignee: "agt_a", reviewer: "per_me", status: "submitted", version: 5, due_at: null, follow_up_of: null, submission_no: 1, needs_attention: false, ...over });

const file = (over: Partial<TaskFile> = {}): TaskFile => ({ id: "obj_1", submission_no: 1, label: "Design doc", name: "design.pdf", size: 2_400_000, sha256: "a".repeat(64), media_type: "application/pdf", state: "ready", download_path: "/v1/files/ws_1/obj_1", from: { id: "agt_a", org: "org_b" }, external: true, created_at: 2, ...over });

const detail = (over: Partial<Task> = {}, rest: Partial<TaskDetail> = {}): TaskDetail => ({
  task: task(over),
  submissions: [{ submission_no: 1, task_version: 4, note: "Here it is", commit_sha: null, from: { id: "agt_a", org: "org_b" }, external: true, created_at: 2 }],
  artifacts: [],
  files: [file()],
  messages: [],
  history: [],
  ...rest,
});

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const refused = (status: number, code: string) => json(status, { error: { code, message: code } });

type Call = { url: string; method: string; body: unknown; key: string | null };
let calls: Call[];
let answer: (url: string, method: string) => Response | Promise<Response>;

beforeEach(() => {
  calls = [];
  uploads = [];
  setUrl("/w/ws_1/tasks?task=tsk_1");
  answer = () => json(200, detail());
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    calls.push({ url, method, body: init?.body ? JSON.parse(init.body as string) : undefined, key: new Headers(init?.headers).get("idempotency-key") });
    return answer(url, method);
  });
});
afterEach(() => vi.useRealTimers());

const commands = () => calls.filter((call) => call.method !== "GET");

const open = async (me = "per_me") => {
  render(
    <>
      <main id="main-content" tabIndex={-1}>
        <SheetLink param="task" target="tsk_1">
          Open
        </SheetLink>
      </main>
      <TaskSheet me={me} names={{ agt_a: "Architect" }} room={ROOM} resolve={(target) => ({ workspace: ROOM.id, task: target })} />
    </>,
  );
  await screen.findByRole("heading", { name: "Design the API" });
};

describe("the submission file rules", () => {
  it("names what stops an approval", () => {
    expect(approvalBlocker([file()])).toBeNull();
    expect(approvalBlocker([])).toBeNull();
    expect(approvalBlocker([file(), file({ state: "blocked" })])).toMatch(/blocked/);
    expect(approvalBlocker([file({ state: "removed" })])).toMatch(/removed/);
    expect(approvalBlocker([file({ state: null })])).toMatch(/removed/);
    expect(approvalBlocker([file({ state: "scanning" })])).toMatch(/isn't ready/);
  });

  it("keeps the Sheet's own words for a lost answer", () => {
    expect(verifyProblem("unknown", 0)).toMatch(/can't tell/);
    expect(verifyProblem("file_changed", 409)).toMatch(/no longer matches/);
  });
});

describe("files on a submission", () => {
  it("shows each file's label, name, size, state and pinned hash, with a download that's an attachment", async () => {
    await open();
    const list = screen.getByRole("list", { name: "Files" });
    expect(within(list).getByText("Design doc", { selector: "p" })).toBeInTheDocument();
    expect(within(list).getByText("File name: design.pdf")).toBeInTheDocument();
    expect(within(list).getByText("2.4 MB")).toBeInTheDocument();
    expect(within(list).getByText("Ready")).toBeInTheDocument();
    expect(within(list).getByText("No known malware found.")).toBeInTheDocument();
    expect(within(list).getByTitle("a".repeat(64))).toHaveTextContent("aaaaaaaaaaaa");
    const link = within(list).getByRole("link", { name: "Download Design doc" });
    expect(link).toHaveAttribute("href", "/api/v1/files/ws_1/obj_1");
    expect(link).toHaveAttribute("download");
    expect(link).not.toHaveAttribute("target");
  });

  it.each([
    ["scanning", "Scanning"],
    ["blocked", "Blocked"],
    ["failed", "Scan failed"],
    ["removed", "Removed"],
    ["uploading", "Uploading"],
  ])("gives a %s file its label and no download", async (state, label) => {
    answer = () => json(200, detail({}, { files: [file({ state, download_path: "/v1/files/ws_1/obj_1" })] }));
    await open();
    const list = screen.getByRole("list", { name: "Files" });
    expect(within(list).getByText(label)).toBeInTheDocument();
    expect(within(list).queryByRole("link")).toBeNull();
  });

  it("keeps a hostile label and name as text, and loads nothing", async () => {
    answer = () => json(200, detail({}, { files: [file({ label: '<img src="https://evil.example/p.png"> [click](https://evil.example)', name: "<b>x</b>.pdf" })] }));
    await open();
    const list = screen.getByRole("list", { name: "Files" });
    expect(list.querySelector("img, b")).toBeNull();
    expect(within(list).getByText(/<img src=/, { selector: "p" })).toBeInTheDocument();
    expect(within(list).getAllByRole("link").map((link) => link.getAttribute("href"))).toEqual(["/api/v1/files/ws_1/obj_1"]);
  });

  it("says why a ready file has no download, without inventing one", async () => {
    answer = () => json(200, detail({}, { files: [file({ download_path: null })] }));
    await open();
    expect(screen.getByText("Your access doesn't include downloading it.")).toBeInTheDocument();
    expect(within(screen.getByRole("list", { name: "Files" })).queryByRole("link")).toBeNull();
  });

  it("shows a reviewer the files of a submission it can't otherwise read (decision 97)", async () => {
    answer = () => json(200, detail({}, { submissions: [], visible: { submissions: "own", conversation: true } }));
    await open();
    expect(screen.getByText(/As its reviewer, you see their files/)).toBeInTheDocument();
    expect(screen.getByText("Only its files are shown to you.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Download Design doc" })).toBeInTheDocument();
  });

  it("shows oversight's narrower file, which has only a name and a state, and no download", () => {
    const narrow = { id: "obj_1", submission_no: 1, name: "<b>notes</b>.txt", state: "ready", download_path: null } as TaskFile;
    render(<Details data={detail({}, { files: [narrow] })} me="per_admin" names={{}} orgNames={{}} overseen />);
    const list = screen.getByRole("list", { name: "Files" });
    expect(within(list).getByText("<b>notes</b>.txt", { selector: "p" })).toBeInTheDocument();
    expect(within(list).queryByText(/SHA-256/)).toBeNull();
    expect(within(list).queryByRole("link")).toBeNull();
    expect(within(list).getByText("Oversight shows a file's name and status, not its bytes.")).toBeInTheDocument();
  });

  it("labels a link as one that may change since approval", async () => {
    answer = () => json(200, detail({}, { artifacts: [{ id: "art_1", submission_no: 1, uri: "https://files.example.com/x", label: "The design", from: { id: "agt_a", org: "org_b" }, external: true, created_at: 2 }] }));
    await open();
    expect(within(screen.getByRole("list", { name: "Artifacts" })).getByText("External link, may change since approval")).toBeInTheDocument();
  });
});

describe("reviewing files", () => {
  it("says approval records the exact files, and approves the submission named", async () => {
    const user = userEvent.setup();
    await open();
    expect(screen.getByText(/records the exact file it was submitted with, by SHA-256/)).toBeInTheDocument();
    answer = (url, method) => (method === "POST" ? json(200, task({ status: "completed", approved_submission_no: 1 })) : json(200, detail({ status: "completed", approved_submission_no: 1 })));
    await user.click(screen.getByRole("button", { name: "Approve submission 1" }));
    await waitFor(() => expect(commands()).toHaveLength(1));
    expect(commands()[0]).toMatchObject({ url: "/api/v1/workspaces/ws_1/tasks/tsk_1/verify", body: { submission_no: 1 } });
  });

  it("won't offer approval of a submission with a blocked file, and still offers changes", async () => {
    answer = () => json(200, detail({}, { files: [file(), file({ id: "obj_2", state: "blocked", download_path: null })] }));
    await open();
    expect(screen.getByText(/blocked or couldn't be scanned, so it can't be approved/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Approve submission 1" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Request changes" })).toBeEnabled();
  });

  it.each([
    ["file_changed", 409, /no longer matches the version that was submitted/],
    ["file_removed", 409, /has been removed since it was submitted/],
    ["file_not_ready", 409, /A later scan may have blocked it/],
    ["files_not_checked", 500, /couldn't check its files, so it wasn't approved/],
  ])("says plainly why %s stopped an approval", async (code, status, words) => {
    const user = userEvent.setup();
    await open();
    answer = (url, method) => (method === "POST" ? refused(status, code) : json(200, detail()));
    await user.click(screen.getByRole("button", { name: "Approve submission 1" }));
    expect(await screen.findByText(words)).toBeInTheDocument();
    expect(screen.getByText(/wasn't approved, and nothing changed/)).toBeInTheDocument();
    expect(screen.queryByText(/can't tell/)).toBeNull();
  });
});

describe("submitting files", () => {
  const assigned = () => json(200, detail({ status: "accepted", assignee: "per_me", reviewer: "per_r", submission_no: 0 }, { submissions: [], files: [] }));
  const pick = (name = "report.pdf", size = 3) => new File(["x".repeat(size)], name, { type: "application/pdf" });

  it("offers the assignee a submission form, and nobody else", async () => {
    answer = assigned;
    await open();
    expect(screen.getByRole("form", { name: "Submit work" })).toBeInTheDocument();
    expect(screen.getByLabelText("Files (optional)")).toHaveAttribute("type", "file");
  });

  it("isn't offered to the reviewer of an accepted task", async () => {
    answer = () => json(200, detail({ status: "accepted", submission_no: 0 }, { submissions: [], files: [] }));
    await open();
    expect(screen.queryByRole("form", { name: "Submit work" })).toBeNull();
  });

  it("uploads for this task, waits out the scan, then submits the exact file", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    answer = assigned;
    await open();
    await user.upload(screen.getByLabelText("Files (optional)"), pick());
    await waitFor(() => expect(uploads).toHaveLength(1));
    expect(uploads[0]).toMatchObject({ workspace: "ws_1", taskId: "tsk_1" });
    const rows = screen.getByRole("list", { name: "Your files for this task" });
    expect(within(rows).getByText("report.pdf", { selector: "p" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Submit" })).toBeDisabled();

    let state = "scanning";
    answer = (url) => (url.includes("/files/obj_9") ? json(200, { id: "obj_9", state }) : assigned());
    await act(async () => uploads[0].finish({ ok: true, data: { id: "obj_9", state: "scanning", size: 3, sha256: "b".repeat(64) } }));
    expect(await within(rows).findByText("Scanning")).toBeInTheDocument();
    expect(screen.getByText("Wait for every file to finish uploading and scanning.")).toBeInTheDocument();

    await act(async () => vi.advanceTimersByTimeAsync(3000));
    expect(calls.some((call) => call.url === "/api/v1/workspaces/ws_1/files/obj_9")).toBe(true);
    state = "ready";
    await act(async () => vi.advanceTimersByTimeAsync(4000));
    expect(await within(rows).findByText("Ready")).toBeInTheDocument();
    expect(within(rows).getByRole("status")).toHaveTextContent("report.pdf: Ready");

    answer = (url, method) => (method === "POST" ? json(200, task({ status: "submitted", assignee: "per_me", reviewer: "per_r", submission_no: 1, version: 6 })) : assigned());
    await user.click(screen.getByRole("button", { name: "Submit with 1 file" }));
    await waitFor(() => expect(commands()).toHaveLength(1));
    expect(commands()[0]).toMatchObject({ url: "/api/v1/workspaces/ws_1/tasks/tsk_1/submit", body: { version: 5, files: [{ id: "obj_9" }] } });
    expect(commands()[0].key).toBeTruthy();
    expect(await screen.findByText("Submitted submission 1 with 1 file. It's waiting for review.")).toBeInTheDocument();
  });

  const held = (over: Partial<TaskFile> = {}): TaskFile => ({ id: "obj_h", submitted: false, submission_no: null, label: null, name: "earlier.pdf", size: 1200, sha256: "c".repeat(64), media_type: "application/pdf", state: "ready", download_path: "/v1/files/ws_1/obj_h", ...over });
  const assignedWith = (files: TaskFile[]) => () => json(200, detail({ status: "accepted", assignee: "per_me", reviewer: "per_r", submission_no: 0 }, { submissions: [], files }));

  it("lists files already uploaded for the task after a reload, without making the Sheet a draft", async () => {
    const user = userEvent.setup();
    answer = assignedWith([held(), held({ id: "obj_b", name: "bad.zip", state: "blocked", download_path: null })]);
    await open();
    const rows = screen.getByRole("list", { name: "Your files for this task" });
    expect(within(rows).getByText("earlier.pdf", { selector: "p" })).toBeInTheDocument();
    expect(within(rows).getByText("bad.zip", { selector: "p" })).toBeInTheDocument();
    expect(within(rows).getByText(/doesn't count toward your 10 files/)).toBeInTheDocument();
    // Neither is a submission, and only the form shows them while the task waits for work.
    expect(screen.queryByRole("list", { name: "Not yet submitted" })).toBeNull();
    expect(screen.queryByText("Unsaved changes")).toBeNull();
    expect(screen.queryByRole("button", { name: "Remove earlier.pdf" })).toBeNull();

    await user.click(screen.getByRole("button", { name: "Leave out earlier.pdf" }));
    expect(screen.getByRole("button", { name: "Include earlier.pdf" })).toHaveFocus();
    expect(within(rows).getByText(/still counts toward your 10 files/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Submit" })).toBeDisabled();

    await user.click(screen.getByRole("button", { name: "Include earlier.pdf" }));
    answer = (url, method) => (method === "POST" ? json(200, task({ status: "submitted", assignee: "per_me", reviewer: "per_r", submission_no: 1, version: 6 })) : assignedWith([])());
    await user.click(screen.getByRole("button", { name: "Submit with 1 file" }));
    await waitFor(() => expect(commands()).toHaveLength(1));
    expect(commands()[0].body).toMatchObject({ files: [{ id: "obj_h" }] });
  });

  it("counts files already held toward the 10", async () => {
    const user = userEvent.setup();
    answer = assignedWith(Array.from({ length: 9 }, (_, index) => held({ id: `obj_${index}`, name: `f${index}.pdf` })));
    await open();
    await user.upload(screen.getByLabelText("Files (optional)"), [pick("a.pdf"), pick("b.pdf")]);
    await waitFor(() => expect(uploads).toHaveLength(1));
    expect(screen.getByText(/only the first 1 were added/)).toBeInTheDocument();
  });

  it("shows the uploader's unsubmitted files apart from submissions once the task has moved on", async () => {
    answer = () => json(200, detail({ status: "submitted", assignee: "per_me", reviewer: "per_r" }, { files: [file(), held()] }));
    await open();
    expect(within(screen.getByRole("list", { name: "Files" })).queryByText("earlier.pdf", { selector: "p" })).toBeNull();
    expect(within(screen.getByRole("list", { name: "Not yet submitted" })).getByText("earlier.pdf", { selector: "p" })).toBeInTheDocument();
    expect(screen.getAllByText(/^Submission \d/, { selector: "p" })).toHaveLength(1);
  });

  it("keeps a file its scan blocked out of the submission, so it holds nothing back", async () => {
    const user = userEvent.setup();
    answer = assigned;
    await open();
    await user.type(screen.getByLabelText("Note (optional)"), "Done");
    await user.upload(screen.getByLabelText("Files (optional)"), pick("bad.pdf"));
    await waitFor(() => expect(uploads).toHaveLength(1));
    expect(screen.getByRole("button", { name: "Submit" })).toBeDisabled();
    await act(async () => uploads[0].finish({ ok: true, data: { id: "obj_9", state: "blocked", size: 3, sha256: "b".repeat(64) } }));
    expect(await screen.findByText("Blocked")).toBeInTheDocument();
    expect(screen.getByText(/It can't be submitted, and it doesn't count toward your 10 files/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /bad\.pdf/ })).toBeNull();
    expect(screen.getByRole("button", { name: "Submit" })).toBeEnabled();
  });

  it("removes a file that didn't upload, and puts focus back on the picker", async () => {
    const user = userEvent.setup();
    answer = assigned;
    await open();
    await user.upload(screen.getByLabelText("Files (optional)"), pick("bad.pdf"));
    await waitFor(() => expect(uploads).toHaveLength(1));
    await act(async () => uploads[0].finish({ ok: false, status: 415, code: "file_type_refused" }));
    expect(screen.getByText("Remove or leave out each file that isn't Ready before submitting.")).toBeInTheDocument();
    await user.click(await screen.findByRole("button", { name: "Remove bad.pdf" }));
    expect(screen.getByLabelText("Files (optional)")).toHaveFocus();
    expect(screen.queryByRole("list", { name: "Your files for this task" })).toBeNull();
  });

  it.each([
    ["executable_refused", 415, /Programs and files that run when opened/],
    ["limit_exceeded", 409, /already have 10 files for this task that no submission names/],
    ["room_quota_exceeded", 409, /used its 5 GB/],
    ["invalid_transition", 409, /isn't waiting for your work any more/],
  ])("says why an upload was refused: %s", async (code, status, words) => {
    const user = userEvent.setup();
    answer = assigned;
    await open();
    await user.upload(screen.getByLabelText("Files (optional)"), pick());
    await waitFor(() => expect(uploads).toHaveLength(1));
    await act(async () => uploads[0].finish({ ok: false, status, code }));
    expect(await screen.findByText(words)).toBeInTheDocument();
    expect(screen.getByText("Didn't upload")).toBeInTheDocument();
  });

  it("offers to try a failed send again, with the same upload", async () => {
    const user = userEvent.setup();
    answer = assigned;
    await open();
    await user.upload(screen.getByLabelText("Files (optional)"), pick());
    await waitFor(() => expect(uploads).toHaveLength(1));
    const retry = vi.fn(async (): Promise<UploadResult> => ({ ok: true, data: { id: "obj_9", state: "ready", size: 3, sha256: "b".repeat(64) } }));
    await act(async () => uploads[0].finish({ ok: false, status: 0, code: "network_error", retry }));
    await user.click(await screen.findByRole("button", { name: "Try again report.pdf" }));
    expect(retry).toHaveBeenCalledOnce();
    expect(await screen.findByText("Ready")).toBeInTheDocument();
  });

  it("refuses more than 10 files before uploading any past the limit", async () => {
    const user = userEvent.setup();
    answer = assigned;
    await open();
    await user.upload(screen.getByLabelText("Files (optional)"), Array.from({ length: 11 }, (_, index) => pick(`f${index}.pdf`)));
    await waitFor(() => expect(uploads).toHaveLength(10));
    expect(screen.getByText(/at most 10 files, so only the first 10 were added/)).toBeInTheDocument();
  });

  it.each([
    ["file_not_ready", 409, /hasn't finished scanning as ready/],
    ["file_removed", 409, /has been removed/],
    ["too_many_artifacts", 400, /at most 10 files and links/],
    ["file_not_found", 404, /can't be found/],
  ])("says why a submission was refused: %s", async (code, status, words) => {
    const user = userEvent.setup();
    answer = assigned;
    await open();
    await user.upload(screen.getByLabelText("Files (optional)"), pick());
    await waitFor(() => expect(uploads).toHaveLength(1));
    await act(async () => uploads[0].finish({ ok: true, data: { id: "obj_9", state: "ready", size: 3, sha256: "b".repeat(64) } }));
    answer = (url, method) => (method === "POST" ? refused(status, code) : assigned());
    await user.click(await screen.findByRole("button", { name: "Submit with 1 file" }));
    expect(await screen.findByText(words)).toBeInTheDocument();
    expect(screen.getByText(/That wasn't submitted/)).toBeInTheDocument();
  });
});
