import { env, runInDurableObject, SELF } from "cloudflare:test";
import { importJWK, SignJWT } from "jose";
import { beforeAll, describe, expect, it } from "vitest";

// Files on a submission (M2 step 6): uploading one for a task, submitting it, who sees it, and approving exactly what was pinned.

const BINDINGS = env as any;
let key: any;
type Who = { id: string; kind?: "agent" | "person"; org: string; adminOrgs?: string[]; gen?: number };
const OWNER: Who = { id: "per_sf_owner", kind: "person", org: "org_sf", adminOrgs: ["org_sf"] };
const MEMBER: Who = { id: "agt_sf_member", org: "org_sf" };
const GUEST: Who = { id: "agt_sf_guest", org: "org_sf_guest" };
const OTHER_GUEST: Who = { id: "agt_sf_other", org: "org_sf" };
const orgAdmin = (org: string): Who => ({ id: `per_sf_admin_${org}`, kind: "person", org, adminOrgs: [org] });

async function assertion(who: Who) {
  const now = Math.floor(Date.now() / 1000);
  const isAgent = (who.kind ?? "agent") === "agent";
  return new SignJWT({ kind: who.kind ?? "agent", org: who.org, ...(isAgent ? { gen: who.gen ?? 1 } : { orgs: [who.org], admin_orgs: who.adminOrgs ?? [] }) })
    .setProtectedHeader({ alg: "EdDSA", kid: "test" }).setIssuer("podster-gateway").setSubject(who.id).setAudience("podster-api")
    .setIssuedAt(now).setExpirationTime(now + 60).setJti(crypto.randomUUID()).sign(key);
}

let counter = 0;
async function api(who: Who, method: string, path: string, body?: unknown) {
  const headers: Record<string, string> = { "x-podster-assertion": await assertion(who), "content-type": "application/json" };
  if (method !== "GET") headers["idempotency-key"] = `sf-key-${++counter}`;
  const res = await SELF.fetch(`https://api.internal${path}`, { method, headers, body: method === "GET" ? undefined : JSON.stringify(body ?? {}) });
  const text = await res.text();
  const parsed = text ? JSON.parse(text) : null;
  return { status: res.status, body: parsed, code: parsed?.error?.code };
}

beforeAll(async () => {
  key = await importJWK(JSON.parse(BINDINGS.TEST_SIGNING_JWK), "EdDSA");
  for (const statement of BINDINGS.TEST_D1_SCHEMA.split(";").map((x: string) => x.trim()).filter(Boolean)) await BINDINGS.DB.prepare(statement).run();
  for (const who of [MEMBER, GUEST, OTHER_GUEST]) {
    const res = await SELF.fetch(`https://api.internal/v1/agents/${who.id}`, { method: "PUT", headers: { "x-podster-assertion": await assertion(orgAdmin(who.org)) }, body: JSON.stringify({ org_id: who.org, name: who.id }) });
    if (res.status !== 200) throw new Error(`register ${who.id}: ${res.status}`);
  }
});

const version = async (id: string) => (await api(OWNER, "GET", `/v1/workspaces/${id}`)).body.policy_version;
const encoder = new TextEncoder();
const sha256 = async (data: Uint8Array) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", data))].map((b) => b.toString(16).padStart(2, "0")).join("");
const TEXT = encoder.encode("The finished report.\n".repeat(40));
const inRoom = <T>(id: string, fn: (sql: any) => T) => runInDurableObject(BINDINGS.WORKSPACE.get(BINDINGS.WORKSPACE.idFromName(id)), (_: any, state: any) => fn(state.storage.sql));
const setState = (id: string, object: string, state: string) => inRoom(id, (sql) => sql.exec("UPDATE stored_object SET state = ? WHERE id = ?", state, object));

/** A room with a member and two guests, and a task the owner offered to GUEST, which GUEST accepted. */
async function accepted() {
  const id: string = (await api(OWNER, "POST", "/v1/workspaces", { name: "Submissions" })).body.id;
  for (const [who, role] of [[MEMBER, "member"], [OTHER_GUEST, "guest"]] as const) {
    const r = await api(OWNER, "POST", `/v1/workspaces/${id}/members`, { principal_id: who.id, kind: "agent", org_id: who.org, role, policy_version: await version(id) });
    expect(r.status, `add ${who.id}: ${JSON.stringify(r.body)}`).toBe(200);
  }
  // The assignee is another organization's agent, so its organization's admin can oversee it.
  const invited = await api(OWNER, "POST", `/v1/workspaces/${id}/invitations`, { role: "guest", invited_org_id: GUEST.org, policy_version: await version(id) });
  expect(invited.status, JSON.stringify(invited.body)).toBe(200);
  const joined = await api(orgAdmin(GUEST.org), "POST", "/v1/invitations/accept", { token: invited.body.token, org_id: GUEST.org, agents: [GUEST.id] });
  expect(joined.status, JSON.stringify(joined.body)).toBe(200);
  const task = await api(OWNER, "POST", `/v1/workspaces/${id}/tasks`, { title: "Write it", instructions: "Write the report.", assignee: GUEST.id });
  expect(task.status, JSON.stringify(task.body)).toBe(200);
  const taskPath = `/v1/workspaces/${id}/tasks/${task.body.id}`;
  expect((await api(GUEST, "POST", `${taskPath}/accept`, { version: 1 })).status).toBe(200);
  return { id, task: task.body.id as string, taskPath };
}

/** Starts an upload and sends its bytes. The scanner isn't under test, so `state` is set directly afterwards. */
async function upload(who: Who, id: string, opts: { task?: string; state?: string; data?: Uint8Array } = {}) {
  const data = opts.data ?? TEXT;
  const made = await api(who, "POST", `/v1/workspaces/${id}/uploads`, { name: "report.txt", size: data.length, sha256: await sha256(data), ...(opts.task ? { task_id: opts.task } : {}) });
  expect(made.status, JSON.stringify(made.body)).toBe(200);
  const sent = await SELF.fetch(`https://api.internal${made.body.upload_path}`, { method: "PUT", headers: { authorization: `Bearer ${made.body.token}` }, body: data as any });
  expect(sent.status, await sent.clone().text()).toBe(200);
  await sent.text();
  await setState(id, made.body.id, opts.state ?? "ready");
  return made.body.id as string;
}

const download = async (who: Who, id: string, object: string) =>
  SELF.fetch(`https://api.internal/v1/files/${id}/${object}`, { headers: { "x-podster-assertion": await assertion(who) } });
const taskVersion = async (taskPath: string) => (await api(OWNER, "GET", taskPath)).body.task.version as number;
const submit = async (taskPath: string, body: Record<string, unknown>) => api(GUEST, "POST", `${taskPath}/submit`, { version: await taskVersion(taskPath), ...body });

describe("uploading a file for a submission", () => {
  it("lets the task's assignee, a guest, upload for it, and nobody else", async () => {
    const { id, task } = await accepted();
    await upload(GUEST, id, { task });
    const body = { name: "x.txt", size: TEXT.length, sha256: await sha256(TEXT), task_id: task };
    // Someone who can see the task but isn't its assignee, and a guest who can't see it at all.
    expect((await api(MEMBER, "POST", `/v1/workspaces/${id}/uploads`, body)).code).toBe("not_allowed");
    expect((await api(OTHER_GUEST, "POST", `/v1/workspaces/${id}/uploads`, body)).code).toBe("task_not_found");
    expect((await api(GUEST, "POST", `/v1/workspaces/${id}/uploads`, { ...body, task_id: "tsk_unknown" })).code).toBe("task_not_found");
    expect((await api(GUEST, "POST", `/v1/workspaces/${id}/uploads`, { ...body, task_id: 7 })).code).toBe("invalid_argument");
    // Without a task, a guest still can't upload an input asset.
    const { task_id: _, ...input } = body;
    expect((await api(GUEST, "POST", `/v1/workspaces/${id}/uploads`, input)).code).toBe("not_allowed");
  });

  it("only while the task waits for a submission", async () => {
    const { id, task, taskPath } = await accepted();
    const object = await upload(GUEST, id, { task });
    expect((await submit(taskPath, { files: [{ id: object }] })).status).toBe(200);
    const body = { name: "x.txt", size: TEXT.length, sha256: await sha256(TEXT), task_id: task };
    expect((await api(GUEST, "POST", `/v1/workspaces/${id}/uploads`, body)).code).toBe("invalid_transition");
  });

  it("stops an upload whose task was released before the bytes arrived, and counts toward the room's quota", async () => {
    const { id, task, taskPath } = await accepted();
    const made = await api(GUEST, "POST", `/v1/workspaces/${id}/uploads`, { name: "late.txt", size: TEXT.length, sha256: await sha256(TEXT), task_id: task });
    expect(made.status).toBe(200);
    const reserved = await inRoom(id, (sql) => sql.exec("SELECT size, for_task FROM stored_object WHERE id = ?", made.body.id).toArray()[0]);
    expect(reserved).toEqual({ size: TEXT.length, for_task: task });
    expect((await api(GUEST, "POST", `${taskPath}/release`, { version: await taskVersion(taskPath), reason: "Can't do it." })).status).toBe(200);
    const sent = await SELF.fetch(`https://api.internal${made.body.upload_path}`, { method: "PUT", headers: { authorization: `Bearer ${made.body.token}` }, body: TEXT as any });
    expect(sent.status).not.toBe(200);
    await sent.text();
    const after = await inRoom(id, (sql) => sql.exec("SELECT state FROM stored_object WHERE id = ?", made.body.id).toArray()[0]);
    expect(after.state).toBe("uploading");
  });
});

describe("who sees a file uploaded for a submission", () => {
  it("only its uploader until a submission names it, then as submitted work", async () => {
    const { id, task, taskPath } = await accepted();
    const object = await upload(GUEST, id, { task });
    for (const who of [OWNER, MEMBER, OTHER_GUEST]) {
      expect((await api(who, "GET", `/v1/workspaces/${id}/files/${object}`)).code, who.id).toBe("file_not_found");
      expect((await download(who, id, object)).status, who.id).toBe(404);
    }
    expect((await api(GUEST, "GET", `/v1/workspaces/${id}/files/${object}`)).body.download_path).toBe(`/v1/files/${id}/${object}`);
    // Its organization's admin sees an unsubmitted file's name and status, as for anything else the agent can see.
    expect((await api(orgAdmin(GUEST.org), "GET", `/v1/workspaces/${id}/agents/${GUEST.id}/files/${object}`)).body).toEqual({ id: object, name: "report.txt", state: "ready" });

    expect((await submit(taskPath, { files: [{ id: object, label: "Final report" }] })).status).toBe(200);
    for (const who of [OWNER, MEMBER, GUEST]) {
      const res = await download(who, id, object);
      expect(res.status, who.id).toBe(200);
      expect(new Uint8Array(await res.arrayBuffer())).toEqual(TEXT);
    }
    // Another guest isn't on the task, so it's as if the file didn't exist.
    expect((await download(OTHER_GUEST, id, object)).status).toBe(404);
    // An org admin overseeing the assignee gets its name and status, never a path.
    const overseen = await api(orgAdmin(GUEST.org), "GET", `/v1/workspaces/${id}/agents/${GUEST.id}/files/${object}`);
    expect(overseen.body).toEqual({ id: object, name: "report.txt", state: "ready" });
  });

  it("lists a submission's files on the task, with the label and the pinned hash", async () => {
    const { id, task, taskPath } = await accepted();
    const object = await upload(GUEST, id, { task });
    expect((await submit(taskPath, { files: [{ id: object, label: "Final report" }] })).status).toBe(200);
    const read = await api(OWNER, "GET", taskPath);
    expect(read.body.files).toEqual([
      expect.objectContaining({ id: object, submission_no: 1, label: "Final report", name: "report.txt", size: TEXT.length, sha256: await sha256(TEXT), state: "ready", download_path: `/v1/files/${id}/${object}`, from: { id: GUEST.id, org: GUEST.org } }),
    ]);
    // A missing label is the file's name.
    await api(OWNER, "POST", `${taskPath}/request-changes`, { submission_no: 1, reason: "One more pass." });
    const again = await upload(GUEST, id, { task });
    expect((await submit(taskPath, { files: [{ id: again }] })).status).toBe(200);
    const files = (await api(OWNER, "GET", taskPath)).body.files;
    expect(files.map((f: any) => [f.submission_no, f.label])).toEqual([[1, "Final report"], [2, "report.txt"]]);
    // Nothing about a file's name or label reaches the room's events.
    const events = await inRoom(id, (sql) => sql.exec("SELECT * FROM event").toArray());
    expect(JSON.stringify(events)).not.toMatch(/report\.txt|Final report/);
  });
});

describe("submitting files", () => {
  it("accepts a submission of files alone, with no link or note", async () => {
    const { id, task, taskPath } = await accepted();
    const object = await upload(GUEST, id, { task });
    const done = await submit(taskPath, { files: [{ id: object }] });
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect(done.body.status).toBe("submitted");
  });

  it("refuses a file that isn't ready, isn't the submitter's for this task, or is named twice, and records nothing", async () => {
    const { id, task, taskPath } = await accepted();
    const scanning = await upload(GUEST, id, { task, state: "scanning" });
    const blocked = await upload(GUEST, id, { task, state: "blocked" });
    const input = await upload(MEMBER, id);
    const ready = await upload(GUEST, id, { task });
    expect((await submit(taskPath, { files: [{ id: scanning }] })).code).toBe("file_not_ready");
    expect((await submit(taskPath, { files: [{ id: blocked }] })).code).toBe("file_not_ready");
    expect((await submit(taskPath, { files: [{ id: input }] })).code).toBe("file_not_found");
    expect((await submit(taskPath, { files: [{ id: "obj_unknown" }] })).code).toBe("file_not_found");
    expect((await submit(taskPath, { files: [{ id: ready }, { id: ready }] })).code).toBe("duplicate_file");
    expect((await submit(taskPath, { files: [{ id: ready, label: "" }] })).code).toBe("invalid_argument");
    expect((await submit(taskPath, { files: "nope" })).code).toBe("invalid_argument");
    const read = await api(OWNER, "GET", taskPath);
    expect(read.body.task.status).toBe("accepted");
    expect(read.body.files).toEqual([]);
  });

  it("refuses a file uploaded for another task, even by the same assignee", async () => {
    const { id, taskPath } = await accepted();
    const other = await api(OWNER, "POST", `/v1/workspaces/${id}/tasks`, { title: "Other", instructions: "Other work.", assignee: GUEST.id });
    await api(GUEST, "POST", `/v1/workspaces/${id}/tasks/${other.body.id}/accept`, { version: 1 });
    const elsewhere = await upload(GUEST, id, { task: other.body.id });
    expect((await submit(taskPath, { files: [{ id: elsewhere }] })).code).toBe("file_not_found");
  });

  it("counts links and files toward one limit of 10", async () => {
    const { id, task, taskPath } = await accepted();
    const files = [await upload(GUEST, id, { task }), await upload(GUEST, id, { task })];
    const links = Array.from({ length: 9 }, (_, i) => ({ uri: `https://example.com/${i}`, label: `Link ${i}` }));
    expect((await submit(taskPath, { artifacts: links, files: files.map((f) => ({ id: f })) })).code).toBe("too_many_artifacts");
    expect((await submit(taskPath, { artifacts: links.slice(0, 8), files: files.map((f) => ({ id: f })) })).status).toBe(200);
  });
});

describe("approving the exact files submitted", () => {
  it("approves a submission whose files are still ready, and records that submission", async () => {
    const { id, task, taskPath } = await accepted();
    const object = await upload(GUEST, id, { task });
    await submit(taskPath, { files: [{ id: object }] });
    const done = await api(OWNER, "POST", `${taskPath}/verify`, { submission_no: 1 });
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect(done.body).toMatchObject({ status: "completed", approved_submission_no: 1 });
  });

  it("refuses approval once a file is blocked, keeps the task waiting, and still lets the reviewer ask for changes", async () => {
    const { id, task, taskPath } = await accepted();
    const object = await upload(GUEST, id, { task });
    await submit(taskPath, { files: [{ id: object }] });
    await setState(id, object, "blocked");
    const refused = await api(OWNER, "POST", `${taskPath}/verify`, { submission_no: 1 });
    expect([refused.status, refused.code]).toEqual([409, "file_not_ready"]);
    expect((await api(OWNER, "GET", taskPath)).body.task).toMatchObject({ status: "submitted", approved_submission_no: null });
    expect((await api(OWNER, "POST", `${taskPath}/request-changes`, { submission_no: 1, reason: "A file was blocked." })).status).toBe(200);
  });

  it("refuses approval if a file's row no longer matches what was pinned", async () => {
    const { id, task, taskPath } = await accepted();
    const object = await upload(GUEST, id, { task });
    await submit(taskPath, { files: [{ id: object }] });
    await inRoom(id, (sql) => sql.exec("UPDATE stored_object SET sha256 = ? WHERE id = ?", "0".repeat(64), object));
    expect((await api(OWNER, "POST", `${taskPath}/verify`, { submission_no: 1 })).code).toBe("file_changed");
  });

  it("fails closed if the room can't prove it checked the files", async () => {
    // With the submission's file rows gone, the check sees no files, but the task says the submission had one. Core refuses.
    const { id, task, taskPath } = await accepted();
    const object = await upload(GUEST, id, { task });
    await submit(taskPath, { files: [{ id: object }] });
    await inRoom(id, (sql) => sql.exec("DELETE FROM submission_file"));
    const refused = await api(OWNER, "POST", `${taskPath}/verify`, { submission_no: 1 });
    expect([refused.status, refused.code]).toEqual([500, "files_not_checked"]);
    expect((await api(OWNER, "GET", taskPath)).body.task.status).toBe("submitted");
  });

  it("still says a stale submission number is stale", async () => {
    const { id, task, taskPath } = await accepted();
    const object = await upload(GUEST, id, { task });
    await submit(taskPath, { files: [{ id: object }] });
    expect((await api(OWNER, "POST", `${taskPath}/verify`, { submission_no: 2 })).code).toBe("submission_mismatch");
  });

  it("approves a submission of links alone as before", async () => {
    const { taskPath } = await accepted();
    await submit(taskPath, { artifacts: [{ uri: "https://example.com/pr/1", label: "PR" }] });
    expect((await api(OWNER, "POST", `${taskPath}/verify`, { submission_no: 1 })).body.status).toBe("completed");
  });
});

describe("when a task left accepted, for step 8's sweep", () => {
  const leftAt = (id: string, task: string) => inRoom(id, (sql) => sql.exec("SELECT left_accepted_at AS at FROM task WHERE id = ?", task).toArray()[0].at);

  it("is set when a task leaves accepted, and cleared when it comes back, so changes requested restarts the clock", async () => {
    const { id, task, taskPath } = await accepted();
    expect(await leftAt(id, task)).toBeNull();
    await submit(taskPath, { note: "Done." });
    expect(typeof (await leftAt(id, task))).toBe("number");
    await api(OWNER, "POST", `${taskPath}/request-changes`, { submission_no: 1, reason: "Again." });
    expect(await leftAt(id, task)).toBeNull();
    // A change that keeps the task accepted leaves it alone.
    await api(OWNER, "POST", `${taskPath}/update`, { version: await taskVersion(taskPath), title: "Renamed" });
    expect(await leftAt(id, task)).toBeNull();
    await api(GUEST, "POST", `${taskPath}/release`, { version: await taskVersion(taskPath), reason: "Can't." });
    expect(typeof (await leftAt(id, task))).toBe("number");
  });

  it("keeps the first time it left while it stays out of accepted", async () => {
    const { id, task, taskPath } = await accepted();
    await submit(taskPath, { note: "Done." });
    await inRoom(id, (sql) => sql.exec("UPDATE task SET left_accepted_at = 1 WHERE id = ?", task));
    expect((await api(OWNER, "POST", `${taskPath}/verify`, { submission_no: 1 })).status).toBe(200);
    expect(await leftAt(id, task)).toBe(1);
  });
});
