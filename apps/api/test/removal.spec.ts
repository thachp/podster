import { env, runInDurableObject, SELF } from "cloudflare:test";
import { importJWK, SignJWT } from "jose";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { alarmPass, alarmQuiet } from "./alarm.ts";

const BINDINGS = env as any;
let key: any;
type Who = { id: string; kind?: "agent" | "person"; org: string; adminOrgs?: string[]; gen?: number };
const OWNER: Who = { id: "per_rm_owner", kind: "person", org: "org_rm", adminOrgs: ["org_rm"] };
const ADMIN: Who = { id: "per_rm_admin", kind: "person", org: "org_rm" };
const PERSON_MEMBER: Who = { id: "per_rm_member", kind: "person", org: "org_rm" };
const MEMBER: Who = { id: "agt_rm_member", org: "org_rm" };
const GUEST: Who = { id: "agt_rm_guest", org: "org_rm" };
const INVITED: Who = { id: "agt_rm_invited", org: "org_rm_other" };
const STRANGER: Who = { id: "agt_rm_stranger", org: "org_rm_x" };
const orgAdmin = (org: string): Who => ({ id: `per_rm_admin_${org}`, kind: "person", org, adminOrgs: [org] });

async function assertion(who: Who) {
  const now = Math.floor(Date.now() / 1000);
  const isAgent = (who.kind ?? "agent") === "agent";
  return new SignJWT({ kind: who.kind ?? "agent", org: who.org, ...(isAgent ? { gen: who.gen ?? 1 } : { orgs: [who.org], admin_orgs: who.adminOrgs ?? [] }) })
    .setProtectedHeader({ alg: "EdDSA", kid: "test" }).setIssuer("podster-gateway").setSubject(who.id).setAudience("podster-api")
    .setIssuedAt(now).setExpirationTime(now + 60).setJti(crypto.randomUUID()).sign(key);
}

let counter = 0;
async function api(who: Who, method: string, path: string, body?: unknown, key?: string) {
  const headers: Record<string, string> = { "x-podster-assertion": await assertion(who), "content-type": "application/json" };
  if (method !== "GET") headers["idempotency-key"] = key ?? `rm-key-${++counter}`;
  const res = await SELF.fetch(`https://api.internal${path}`, { method, headers, body: method === "GET" ? undefined : JSON.stringify(body ?? {}) });
  const text = await res.text();
  const parsed = text ? JSON.parse(text) : null;
  return { status: res.status, body: parsed, code: parsed?.error?.code };
}

beforeAll(async () => {
  key = await importJWK(JSON.parse(BINDINGS.TEST_SIGNING_JWK), "EdDSA");
  for (const statement of BINDINGS.TEST_D1_SCHEMA.split(";").map((x: string) => x.trim()).filter(Boolean)) await BINDINGS.DB.prepare(statement).run();
  for (const who of [MEMBER, GUEST, INVITED, STRANGER]) {
    const res = await SELF.fetch(`https://api.internal/v1/agents/${who.id}`, { method: "PUT", headers: { "x-podster-assertion": await assertion(orgAdmin(who.org)) }, body: JSON.stringify({ org_id: who.org, name: who.id }) });
    if (res.status !== 200) throw new Error(`register ${who.id}: ${res.status}`);
  }
});

const version = async (id: string) => (await api(OWNER, "GET", `/v1/workspaces/${id}`)).body.policy_version;
const encoder = new TextEncoder();
const sha256 = async (data: Uint8Array) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", data))].map((b) => b.toString(16).padStart(2, "0")).join("");
const TEXT = encoder.encode("<script>alert(1)</script>\n".repeat(40));
const inRoom = (id: string, fn: (sql: any) => unknown) => runInDurableObject(BINDINGS.WORKSPACE.get(BINDINGS.WORKSPACE.idFromName(id)), (_: any, state: any) => fn(state.storage.sql));

/** Every room a test makes, quieted after it so that no alarm of it runs into the next test. */
const madeRooms: string[] = [];
afterEach(async () => {
  for (const id of madeRooms.splice(0)) await alarmQuiet(BINDINGS.WORKSPACE.get(BINDINGS.WORKSPACE.idFromName(id)));
});

async function room() {
  const id: string = (await api(OWNER, "POST", "/v1/workspaces", { name: "Files" })).body.id;
  madeRooms.push(id);
  // Adding a person through the API needs the gateway's word on their organization, which isn't under test here.
  await inRoom(id, (sql) => {
    for (const [who, role] of [[ADMIN, "admin"], [PERSON_MEMBER, "member"]] as const) sql.exec("INSERT INTO member (principal_id, kind, org_id, role, added_by, added_at, join_generation) VALUES (?, 'person', ?, ?, ?, 0, 1)", who.id, who.org, role, OWNER.id);
  });
  for (const [who, role] of [[MEMBER, "member"], [GUEST, "guest"]] as const) {
    const r = await api(OWNER, "POST", `/v1/workspaces/${id}/members`, { principal_id: who.id, kind: "agent", org_id: who.org, role, policy_version: await version(id) });
    expect(r.status, `add ${who.id}: ${JSON.stringify(r.body)}`).toBe(200);
  }
  // The member person gets the agent member's access, so they see the whole room and only their role keeps them from removing.
  await inRoom(id, (sql) => sql.exec("INSERT INTO access_grant (principal_id, tasks, artifacts, conversations, review, granted_by, updated_at) SELECT ?, tasks, artifacts, conversations, review, granted_by, updated_at FROM access_grant WHERE principal_id = ?", PERSON_MEMBER.id, MEMBER.id));
  const invited = await api(OWNER, "POST", `/v1/workspaces/${id}/invitations`, { role: "guest", invited_org_id: INVITED.org, policy_version: await version(id) });
  expect(invited.status, JSON.stringify(invited.body)).toBe(200);
  const joined = await api(orgAdmin(INVITED.org), "POST", "/v1/invitations/accept", { token: invited.body.token, org_id: INVITED.org, agents: [INVITED.id] });
  expect(joined.status, JSON.stringify(joined.body)).toBe(200);
  return id;
}

/** A file that really arrived, in the state asked for. The scanner's route isn't what's under test, so this sets the state directly. */
async function file(id: string, state = "ready", name = "notes.txt", data: Uint8Array = TEXT) {
  const made = await api(OWNER, "POST", `/v1/workspaces/${id}/uploads`, { name, size: data.length, sha256: await sha256(data) });
  expect(made.status, JSON.stringify(made.body)).toBe(200);
  const sent = await SELF.fetch(`https://api.internal${made.body.upload_path}`, { method: "PUT", headers: { authorization: `Bearer ${made.body.token}` }, body: data as any });
  expect(sent.status).toBe(200);
  await sent.text();
  await inRoom(id, (sql) => sql.exec("UPDATE stored_object SET state = ? WHERE id = ?", state, made.body.id));
  return made.body.id as string;
}
const download = async (who: Who, id: string, object: string) =>
  SELF.fetch(`https://api.internal/v1/files/${id}/${object}`, { headers: { "x-podster-assertion": await assertion(who) } });
const refusal = async (res: Response) => ({ status: res.status, code: ((await res.json()) as any).error?.code });

const stub = (id: string) => BINDINGS.WORKSPACE.get(BINDINGS.WORKSPACE.idFromName(id));
const row = (id: string, object: string): Promise<any> => inRoom(id, (sql) => sql.exec("SELECT * FROM stored_object WHERE id = ?", object).toArray()[0]) as Promise<any>;
const remove = (who: Who, id: string, object: string) => api(who, "POST", `/v1/workspaces/${id}/files/${object}/remove`);
/** One whole run of the room's alarm, now, whether or not one was set, and after any the runtime had under way. */
const alarm = (id: string) => alarmPass(stub(id));
/** Forces a sweep pass. */
const sweep = async (id: string) => {
  await inRoom(id, (sql) => sql.exec("UPDATE storage_sweep SET due_at = 0"));
  await alarm(id);
};
const audits = (id: string, action: string): Promise<any[]> => inRoom(id, (sql) => sql.exec("SELECT * FROM audit_event WHERE action = ?", action).toArray()) as Promise<any[]>;

describe("removing a file", () => {
  it("keeps the record and hash, ends downloads, and deletes the bytes on the next sweep", async () => {
    const id = await room();
    const object = await file(id);
    const before = await row(id, object);
    const policy = await version(id);
    const removed = await remove(OWNER, id, object);
    expect(removed.status, JSON.stringify(removed.body)).toBe(200);
    expect(removed.body).toMatchObject({ id: object, state: "removed", size: TEXT.length, sha256: before.sha256, removed_by: OWNER.id });
    expect(typeof removed.body.removed_at).toBe("number");
    // A file's removal changes nobody's access, so an admin's open form still holds.
    expect(await version(id)).toBe(policy);
    const after = await row(id, object);
    expect(after).toMatchObject({ state: "removed", removed_by_kind: "person", removed_from: "ready", name: before.name, sha256: before.sha256, uploaded_by: before.uploaded_by });
    expect(await refusal(await download(OWNER, id, object))).toEqual({ status: 410, code: "file_removed" });
    const read = await api(MEMBER, "GET", `/v1/workspaces/${id}/files/${object}`);
    expect(read.body).toMatchObject({ state: "removed", download_path: null, removed_by: OWNER.id });
    // The removal made the sweep due at once, so the room's own alarm may already have run it.
    await alarm(id);
    expect(await BINDINGS.ASSETS.head(before.object_key)).toBeNull();
    const [audit] = await audits(id, "object.removed");
    expect(audit).toMatchObject({ actor_id: OWNER.id, target_id: object });
    expect(audit.prior_json + audit.new_json).not.toContain("notes");
    const events: any[] = await inRoom(id, (sql) => sql.exec("SELECT * FROM event WHERE type = 'object.removed'").toArray()) as any[];
    expect(events).toHaveLength(1);
    expect(JSON.stringify(events)).not.toContain("notes.txt");
    expect(JSON.stringify(events)).not.toContain(before.object_key);
  });

  it("lets a human admin remove, and nobody else, answering someone who can't see it as if it didn't exist", async () => {
    const id = await room();
    const object = await file(id);
    expect((await remove(PERSON_MEMBER, id, object)).code).toBe("not_allowed");
    expect((await remove(MEMBER, id, object)).code).toBe("not_allowed");
    expect(await remove(GUEST, id, object)).toMatchObject({ status: 404, code: "file_not_found" });
    expect(await remove(INVITED, id, object)).toMatchObject({ status: 404, code: "file_not_found" });
    expect(await remove(STRANGER, id, object)).toMatchObject({ status: 404, code: "workspace_not_found" });
    expect(await remove(GUEST, id, "obj_nothing")).toMatchObject({ status: 404, code: "file_not_found" });
    expect((await row(id, object)).state).toBe("ready");
    const done = await remove(ADMIN, id, object);
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect((await row(id, object)).removed_by).toBe(ADMIN.id);
  });

  it("doesn't let an agent stored as an admin remove, since it counts as a guest and sees no file", async () => {
    const id = await room();
    const object = await file(id);
    await inRoom(id, (sql) => sql.exec("UPDATE member SET role = 'admin' WHERE principal_id = ?", MEMBER.id));
    expect(await remove(MEMBER, id, object)).toMatchObject({ status: 404, code: "file_not_found" });
    expect((await row(id, object)).state).toBe("ready");
  });

  it("won't replay a stored answer to a remover who has since lost the right, or can no longer see the file", async () => {
    const id = await room();
    const object = await file(id);
    const key = `rm-replay-${++counter}`;
    const first = await api(ADMIN, "POST", `/v1/workspaces/${id}/files/${object}/remove`, {}, key);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect((await api(ADMIN, "POST", `/v1/workspaces/${id}/files/${object}/remove`, {}, key)).body).toEqual(first.body);
    // Demoted to a member who still sees the whole room: refused.
    await inRoom(id, (sql) => {
      sql.exec("UPDATE member SET role = 'member' WHERE principal_id = ?", ADMIN.id);
      sql.exec("INSERT INTO access_grant (principal_id, tasks, artifacts, conversations, review, granted_by, updated_at) SELECT ?, tasks, artifacts, conversations, review, granted_by, updated_at FROM access_grant WHERE principal_id = ?", ADMIN.id, MEMBER.id);
    });
    expect(await api(ADMIN, "POST", `/v1/workspaces/${id}/files/${object}/remove`, {}, key)).toMatchObject({ status: 403, code: "not_allowed" });
    // Narrowed so the file is out of sight: the same answer as a file that doesn't exist.
    await inRoom(id, (sql) => sql.exec("DELETE FROM access_grant WHERE principal_id = ?", ADMIN.id));
    expect(await api(ADMIN, "POST", `/v1/workspaces/${id}/files/${object}/remove`, {}, key)).toMatchObject({ status: 404, code: "file_not_found" });
  });

  it("answers an owner who can't see a file, such as another person's unsubmitted task file, as if it didn't exist", async () => {
    const id = await room();
    const object = await file(id);
    const task = await api(OWNER, "POST", `/v1/workspaces/${id}/tasks`, { title: "Work", instructions: "Do it", assignee: MEMBER.id });
    expect(task.status, JSON.stringify(task.body)).toBe(200);
    await inRoom(id, (sql) => sql.exec("UPDATE stored_object SET for_task = ?, uploaded_by = ? WHERE id = ?", task.body.id, MEMBER.id, object));
    for (const who of [OWNER, ADMIN]) expect(await remove(who, id, object)).toMatchObject({ status: 404, code: "file_not_found" });
    expect((await row(id, object)).state).toBe("ready");
  });

  it("changes nothing the second time", async () => {
    const id = await room();
    const object = await file(id);
    const first = await remove(OWNER, id, object);
    const second = await remove(ADMIN, id, object);
    expect(second.status).toBe(200);
    expect(second.body).toEqual(first.body);
    expect(await audits(id, "object.removed")).toHaveLength(1);
  });

  it("works from every state, and ends an unfinished upload with it", async () => {
    const id = await room();
    for (const state of ["scanning", "blocked", "failed"]) {
      const object = await file(id, state);
      expect((await remove(OWNER, id, object)).body.state).toBe("removed");
      expect((await row(id, object)).removed_from).toBe(state);
    }
    const made = await api(OWNER, "POST", `/v1/workspaces/${id}/uploads`, { name: "late.txt", size: TEXT.length, sha256: await sha256(TEXT) });
    expect((await remove(OWNER, id, made.body.id)).body.state).toBe("removed");
    const sent = await SELF.fetch(`https://api.internal${made.body.upload_path}`, { method: "PUT", headers: { authorization: `Bearer ${made.body.token}` }, body: TEXT as any });
    expect(sent.status).toBe(404);
    await sent.text();
    expect(await BINDINGS.ASSETS.list({ prefix: `rooms/${id}/objects/${made.body.id}/` })).toMatchObject({ objects: [] });
  });

  it("works in an archived room (decision 93), for the same people only", async () => {
    const id = await room();
    const object = await file(id);
    expect((await api(OWNER, "POST", `/v1/workspaces/${id}/archive`, { policy_version: await version(id) })).status).toBe(200);
    expect((await remove(PERSON_MEMBER, id, object)).code).toBe("not_allowed");
    const done = await remove(ADMIN, id, object);
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect((await row(id, object)).state).toBe("removed");
  });

  it("gives the space back at once", async () => {
    const id = await room();
    const object = await file(id);
    // The rest of the room's 5 GB, filled with records only, so a byte more doesn't fit.
    await inRoom(id, (sql) => sql.exec("INSERT INTO stored_object (id, name, size, sha256, state, token_hash, uploaded_by, created_at, upload_expires_at) VALUES ('obj_filler', 'f', ?, ?, 'ready', '', ?, 0, 0)", 5_000_000_000 - TEXT.length, "0".repeat(64), OWNER.id));
    const tiny = new Uint8Array([1]);
    const refused = await api(OWNER, "POST", `/v1/workspaces/${id}/uploads`, { name: "one.bin", size: 1, sha256: await sha256(tiny) });
    expect(refused.code).toBe("room_quota_exceeded");
    expect((await remove(OWNER, id, object)).status).toBe(200);
    const fits = await api(OWNER, "POST", `/v1/workspaces/${id}/uploads`, { name: "one.txt", size: 1, sha256: await sha256(tiny) });
    expect(fits.status, JSON.stringify(fits.body)).toBe(200);
  });
});

describe("the room's sweep", () => {
  it("plans one sweep an hour after migrating a room that holds files, and none for a room that doesn't", async () => {
    const undoRemoval = (id: string) => runInDurableObject(stub(id), (_: any, state: any) => {
      // The migrations after this one come off first: submitted files' flag, then expected outputs.
      // M4 step 8's public claims, the newest migration, then step 6's discovery outbox, step 5's room visibility, step 13b's change requests, step 13's read-back and step 12's A2A attempts.
      // M5 step 6's agent tokens, the newest migration, come off first.
      // M5 step 7a's read bookkeeping, the newest migration, comes off first.
      // M5 step 7b's merge bookkeeping, the newest migration, comes off first.
      // The newest step, the M5 security review's two columns, comes off first.
      // M6 step 2's release tables, the newest migration, come off first.
      // M6 step 4(a)'s applier and script-delete tables, the newest migration, come off first.
      // The record of release bookkeeping that keeps failing, the newest migration, comes off first.
      // Decision 218's applied release switch, the newest migration, comes off first.
      state.storage.sql.exec("DROP TABLE release_switch_applied");
      state.storage.sql.exec("UPDATE schema_version SET version = version - 1");
      state.storage.sql.exec("DROP TABLE release_bookkeeping");
      state.storage.sql.exec("UPDATE schema_version SET version = version - 1");
      for (const table of ["serve_apply", "script_delete"]) state.storage.sql.exec(`DROP TABLE ${table}`);
      state.storage.sql.exec("UPDATE schema_version SET version = version - 1");
      for (const table of ["release_config", "serve_state", "unpublish", "release", "app_label", "hostname_request"]) state.storage.sql.exec(`DROP TABLE ${table}`);
      state.storage.sql.exec("UPDATE schema_version SET version = version - 1");
      state.storage.sql.exec("ALTER TABLE repo_link DROP COLUMN gone_seen_at");
      state.storage.sql.exec("ALTER TABLE repo_request DROP COLUMN limited_since");
      state.storage.sql.exec("ALTER TABLE repo_request DROP COLUMN limited_call");
      state.storage.sql.exec("UPDATE schema_version SET version = version - 1");
      // The step that keeps an approval's reviewer (A1, decision 195) comes off next.
      state.storage.sql.exec("ALTER TABLE task_change DROP COLUMN reviewer_person");
      state.storage.sql.exec("ALTER TABLE task_change DROP COLUMN reviewer_id");
      state.storage.sql.exec("UPDATE schema_version SET version = version - 1");
      state.storage.sql.exec("DROP TABLE merge_request");
      state.storage.sql.exec("ALTER TABLE task_change DROP COLUMN merge_finished_at");
      state.storage.sql.exec("ALTER TABLE task_change DROP COLUMN merge_called_at");
      state.storage.sql.exec("ALTER TABLE task_change DROP COLUMN merge_mark_set_at");
      state.storage.sql.exec("ALTER TABLE task_change DROP COLUMN merge_marked_at");
      state.storage.sql.exec("ALTER TABLE task_change DROP COLUMN merge_step");
      state.storage.sql.exec("ALTER TABLE task_change DROP COLUMN merge_next_at");
      state.storage.sql.exec("ALTER TABLE task_change DROP COLUMN merge_attempts");
      state.storage.sql.exec("ALTER TABLE task_change DROP COLUMN merge_requester_person");
      state.storage.sql.exec("ALTER TABLE task_change DROP COLUMN submitter_person");
      state.storage.sql.exec("ALTER TABLE task_change DROP COLUMN submitter_id");
      state.storage.sql.exec("UPDATE schema_version SET version = version - 1");
      state.storage.sql.exec("DROP TABLE repo_read");
      state.storage.sql.exec("ALTER TABLE repo_link DROP COLUMN reads_not_before");
      state.storage.sql.exec("ALTER TABLE repo_link DROP COLUMN read_failures");
      state.storage.sql.exec("ALTER TABLE task_change DROP COLUMN pr_draft");
      state.storage.sql.exec("ALTER TABLE task_change DROP COLUMN commit_changed_at");
      state.storage.sql.exec("ALTER TABLE task_change DROP COLUMN unwatched_at");
      state.storage.sql.exec("ALTER TABLE task_change DROP COLUMN not_found_reads");
      state.storage.sql.exec("ALTER TABLE task_change DROP COLUMN read_failures");
      state.storage.sql.exec("ALTER TABLE task_change DROP COLUMN merged_by_id");
      state.storage.sql.exec("ALTER TABLE task_change DROP COLUMN unchanged_reads");
      state.storage.sql.exec("ALTER TABLE task_change DROP COLUMN read_at");
      state.storage.sql.exec("ALTER TABLE task_change DROP COLUMN observed_base_sha");
      state.storage.sql.exec("UPDATE schema_version SET version = version - 1");
      state.storage.sql.exec("DROP TABLE repo_token_mint");
      state.storage.sql.exec("DROP TABLE repo_token");
      state.storage.sql.exec("UPDATE schema_version SET version = version - 1");
      // M5 step 4's retry columns go with the request table below, then M5 step 5's webhook deliveries come off, then M5 step 2's managed repositories, then M4 step 10's operator suspension.
      state.storage.sql.exec("UPDATE schema_version SET version = version - 1");
      state.storage.sql.exec("DROP TABLE provider_delivery");
      state.storage.sql.exec("UPDATE schema_version SET version = version - 1");
      state.storage.sql.exec("DROP TABLE task_change");
      state.storage.sql.exec("DROP TABLE provider_grant");
      state.storage.sql.exec("DROP TABLE repo_link");
      state.storage.sql.exec("DROP TABLE repo_request_attempt");
      state.storage.sql.exec("DROP TABLE repo_request");
      state.storage.sql.exec("UPDATE schema_version SET version = version - 1");
      state.storage.sql.exec("ALTER TABLE workspace DROP COLUMN suspension_reason");
      state.storage.sql.exec("ALTER TABLE workspace DROP COLUMN suspended_at");
      state.storage.sql.exec("UPDATE schema_version SET version = version - 1");
      state.storage.sql.exec("DROP TABLE public_claim_block");
      state.storage.sql.exec("DROP INDEX role_claim_public");
      state.storage.sql.exec("ALTER TABLE role_claim DROP COLUMN public");
      state.storage.sql.exec("ALTER TABLE member DROP COLUMN joined_via");
      state.storage.sql.exec("UPDATE schema_version SET version = version - 1");
      state.storage.sql.exec("DROP TABLE public_index_outbox");
      state.storage.sql.exec("UPDATE schema_version SET version = version - 1");
      state.storage.sql.exec("ALTER TABLE work_role DROP COLUMN publicly_claimable");
      state.storage.sql.exec("ALTER TABLE workspace DROP COLUMN public_claims_paused");
      state.storage.sql.exec("ALTER TABLE workspace DROP COLUMN topic");
      state.storage.sql.exec("ALTER TABLE workspace DROP COLUMN published_at");
      state.storage.sql.exec("ALTER TABLE workspace DROP COLUMN public_handle");
      state.storage.sql.exec("ALTER TABLE workspace DROP COLUMN visibility");
      state.storage.sql.exec("UPDATE schema_version SET version = version - 1");
      state.storage.sql.exec("ALTER TABLE a2a_attempt DROP COLUMN kind");
      state.storage.sql.exec("ALTER TABLE a2a_attempt DROP COLUMN remote_context_id");
      state.storage.sql.exec("ALTER TABLE a2a_attempt DROP COLUMN reference_task_id");
      state.storage.sql.exec("ALTER TABLE a2a_attempt DROP COLUMN reference_context_id");
      state.storage.sql.exec("UPDATE schema_version SET version = version - 1");
          state.storage.sql.exec("DROP INDEX a2a_attempt_reads");
      state.storage.sql.exec("DROP INDEX a2a_attempt_cancels");
      state.storage.sql.exec("DROP TABLE a2a_held");
      state.storage.sql.exec("ALTER TABLE event DROP COLUMN origin");
      state.storage.sql.exec("ALTER TABLE event DROP COLUMN origin_ref");
      state.storage.sql.exec("ALTER TABLE audit_event DROP COLUMN origin");
      state.storage.sql.exec("ALTER TABLE audit_event DROP COLUMN origin_ref");
      state.storage.sql.exec("ALTER TABLE message DROP COLUMN origin");
      state.storage.sql.exec("ALTER TABLE a2a_attempt DROP COLUMN reading_ended");
      state.storage.sql.exec("ALTER TABLE a2a_attempt DROP COLUMN read_until");
      state.storage.sql.exec("ALTER TABLE a2a_attempt DROP COLUMN next_read_at");
      state.storage.sql.exec("ALTER TABLE a2a_attempt DROP COLUMN read_no");
      state.storage.sql.exec("ALTER TABLE a2a_attempt DROP COLUMN read_queued");
      state.storage.sql.exec("ALTER TABLE a2a_attempt DROP COLUMN read_queued_at");
      state.storage.sql.exec("ALTER TABLE a2a_attempt DROP COLUMN last_read_no");
      state.storage.sql.exec("ALTER TABLE a2a_attempt DROP COLUMN last_state");
      state.storage.sql.exec("ALTER TABLE a2a_attempt DROP COLUMN working_seen");
      state.storage.sql.exec("ALTER TABLE a2a_attempt DROP COLUMN read_ended_reason");
      state.storage.sql.exec("ALTER TABLE a2a_attempt DROP COLUMN cancel_state");
      state.storage.sql.exec("UPDATE schema_version SET version = version - 1");
      state.storage.sql.exec("DROP TABLE a2a_attempt");
      state.storage.sql.exec("UPDATE schema_version SET version = version - 1");
      state.storage.sql.exec("DROP INDEX stored_object_unsubmitted");
      state.storage.sql.exec("ALTER TABLE stored_object DROP COLUMN submitted_at");
      state.storage.sql.exec("UPDATE schema_version SET version = version - 1");
      state.storage.sql.exec("DROP INDEX task_expected_output");
      state.storage.sql.exec("ALTER TABLE task DROP COLUMN expected_output_id");
      state.storage.sql.exec("DROP TABLE expected_output_version");
      state.storage.sql.exec("DROP TABLE expected_output");
      state.storage.sql.exec("UPDATE schema_version SET version = version - 1");
      state.storage.sql.exec("DROP TABLE storage_sweep");
      state.storage.sql.exec("DROP INDEX stored_object_abandoned");
      state.storage.sql.exec("DROP INDEX stored_object_purge");
      for (const column of ["removed_at", "removed_by", "removed_by_kind", "removed_from", "attempt_started_at", "purge_due_at"]) state.storage.sql.exec(`ALTER TABLE stored_object DROP COLUMN ${column}`);
      state.storage.sql.exec("UPDATE schema_version SET version = version - 1");
    });
    const due = async (id: string) => ((await inRoom(id, (sql) => sql.exec("SELECT due_at FROM storage_sweep").toArray()[0])) as any).due_at;
    const withFiles = await room();
    await file(withFiles);
    const empty = await room();
    await undoRemoval(withFiles);
    await undoRemoval(empty);
    const before = Date.now();
    expect((await api(OWNER, "GET", `/v1/workspaces/${withFiles}`)).status).toBe(200);
    expect((await api(OWNER, "GET", `/v1/workspaces/${empty}`)).status).toBe(200);
    expect(await due(withFiles)).toBeGreaterThanOrEqual(Math.floor(before / 1000) * 1000 + 60 * 60 * 1000);
    expect(await due(withFiles)).toBeLessThanOrEqual(Date.now() + 60 * 60 * 1000);
    expect(await due(empty)).toBeNull();
  });

  it("purges a removed file's own prefix at once, even when the room-wide sweep is pages past its key", async () => {
    const id = await room();
    const object = await file(id);
    const key = (await row(id, object)).object_key;
    // An older attempt of the same file, left behind, is under the same prefix and goes too.
    const older = `rooms/${id}/objects/${object}/older-attempt`;
    await BINDINGS.ASSETS.put(older, new Uint8Array([1]));
    // More than three pages of fresh strays that sort after the file, so the file's key is on page 1.
    const strays = Array.from({ length: 3100 }, (_, i) => `rooms/${id}/objects/z${String(i).padStart(5, "0")}/a`);
    for (let i = 0; i < strays.length; i += 100) await Promise.all(strays.slice(i, i + 100).map((k) => BINDINGS.ASSETS.put(k, new Uint8Array([1]))));
    // A pass lists the file's key on page 1 and moves its cursor on, before the file is removed.
    await sweep(id);
    expect((await remove(OWNER, id, object)).status).toBe(200);
    await alarm(id);
    expect(await BINDINGS.ASSETS.head(key)).toBeNull();
    expect(await BINDINGS.ASSETS.head(older)).toBeNull();
    expect(await BINDINGS.ASSETS.head(strays[0])).not.toBeNull();
    const after: any = await row(id, object);
    // Its attempt began just now, so a purge is due again once that attempt can't still be writing.
    expect(after.purge_due_at).toBe(after.attempt_started_at + 60 * 60 * 1000);
    for (let i = 0; i < strays.length; i += 500) await BINDINGS.ASSETS.delete(strays.slice(i, i + 500));
  }, 60_000);

  it("keeps a forced pass from putting the sweep off past the newest attempt, as a replaced one may still be writing", async () => {
    const id = await room();
    const object = await file(id);
    const started = (await row(id, object)).attempt_started_at;
    expect(typeof started).toBe("number");
    // A replaced attempt's bytes land after any pass that ran before it finished. A pass forced now finds nothing to keep.
    await sweep(id);
    const { due_at }: any = await inRoom(id, (sql) => sql.exec("SELECT due_at FROM storage_sweep").toArray()[0]);
    expect(due_at).toBe(started + 60 * 60 * 1000);
  });

  it("keeps a dropped row's schedule through a pass forced before it, so a late attempt's bytes still get swept", async () => {
    const id = await room();
    const made = await api(ADMIN, "POST", `/v1/workspaces/${id}/uploads`, { name: "mid.txt", size: TEXT.length, sha256: await sha256(TEXT) });
    expect(made.status).toBe(200);
    const before = Date.now();
    expect((await api(OWNER, "DELETE", `/v1/workspaces/${id}/members/${ADMIN.id}`, { policy_version: await version(id) })).status).toBe(200);
    expect(await row(id, made.body.id)).toBeUndefined();
    // A pass forced now finds no row with that attempt, and must still leave the sweep due once it can't be writing.
    await sweep(id);
    const { due_at, settles_at }: any = await inRoom(id, (sql) => sql.exec("SELECT due_at, settles_at FROM storage_sweep").toArray()[0]);
    expect(settles_at).toBeGreaterThanOrEqual(before + 60 * 60 * 1000);
    expect(due_at).toBe(settles_at);
  });

  it("starts a room's high-water mark at its migration, for attempts begun before it", async () => {
    const id = await room();
    const before = Date.now();
    const { settles_at }: any = await inRoom(id, (sql) => sql.exec("SELECT settles_at FROM storage_sweep").toArray()[0]);
    expect(settles_at).toBeGreaterThanOrEqual(Math.floor((before - 60_000) / 1000) * 1000 + 60 * 60 * 1000);
    expect(settles_at).toBeLessThanOrEqual(Date.now() + 60 * 60 * 1000);
  });

  it("looks again an hour after someone's uploads are dropped as they leave", async () => {
    const id = await room();
    const made = await api(ADMIN, "POST", `/v1/workspaces/${id}/uploads`, { name: "mid.txt", size: TEXT.length, sha256: await sha256(TEXT) });
    expect(made.status, JSON.stringify(made.body)).toBe(200);
    await inRoom(id, (sql) => sql.exec("UPDATE storage_sweep SET due_at = NULL"));
    const before = Date.now();
    const gone = await api(OWNER, "DELETE", `/v1/workspaces/${id}/members/${ADMIN.id}`, { policy_version: await version(id) });
    expect(gone.status, JSON.stringify(gone.body)).toBe(200);
    expect(await row(id, made.body.id)).toBeUndefined();
    const { due_at }: any = await inRoom(id, (sql) => sql.exec("SELECT due_at FROM storage_sweep").toArray()[0]);
    expect(due_at).toBeGreaterThanOrEqual(before + 60 * 60 * 1000);
    expect(due_at).toBeLessThanOrEqual(Date.now() + 60 * 60 * 1000);
  });

  it("leaves a room that hasn't migrated yet to its next request, and its alarm still runs", async () => {
    const id = await room();
    const object = await file(id);
    await runInDurableObject(stub(id), (_: any, state: any) => {
      // The migrations after this one come off first: submitted files' flag, then expected outputs.
      // M4 step 8's public claims, the newest migration, then step 6's discovery outbox, step 5's room visibility, step 13b's change requests, step 13's read-back and step 12's A2A attempts.
      // M5 step 6's agent tokens, the newest migration, come off first.
      // M5 step 7a's read bookkeeping, the newest migration, comes off first.
      // M5 step 7b's merge bookkeeping, the newest migration, comes off first.
      // The newest step, the M5 security review's two columns, comes off first.
      // M6 step 2's release tables, the newest migration, come off first.
      // M6 step 4(a)'s applier and script-delete tables, the newest migration, come off first.
      // The record of release bookkeeping that keeps failing, the newest migration, comes off first.
      // Decision 218's applied release switch, the newest migration, comes off first.
      state.storage.sql.exec("DROP TABLE release_switch_applied");
      state.storage.sql.exec("UPDATE schema_version SET version = version - 1");
      state.storage.sql.exec("DROP TABLE release_bookkeeping");
      state.storage.sql.exec("UPDATE schema_version SET version = version - 1");
      for (const table of ["serve_apply", "script_delete"]) state.storage.sql.exec(`DROP TABLE ${table}`);
      state.storage.sql.exec("UPDATE schema_version SET version = version - 1");
      for (const table of ["release_config", "serve_state", "unpublish", "release", "app_label", "hostname_request"]) state.storage.sql.exec(`DROP TABLE ${table}`);
      state.storage.sql.exec("UPDATE schema_version SET version = version - 1");
      state.storage.sql.exec("ALTER TABLE repo_link DROP COLUMN gone_seen_at");
      state.storage.sql.exec("ALTER TABLE repo_request DROP COLUMN limited_since");
      state.storage.sql.exec("ALTER TABLE repo_request DROP COLUMN limited_call");
      state.storage.sql.exec("UPDATE schema_version SET version = version - 1");
      // The step that keeps an approval's reviewer (A1, decision 195) comes off next.
      state.storage.sql.exec("ALTER TABLE task_change DROP COLUMN reviewer_person");
      state.storage.sql.exec("ALTER TABLE task_change DROP COLUMN reviewer_id");
      state.storage.sql.exec("UPDATE schema_version SET version = version - 1");
      state.storage.sql.exec("DROP TABLE merge_request");
      state.storage.sql.exec("ALTER TABLE task_change DROP COLUMN merge_finished_at");
      state.storage.sql.exec("ALTER TABLE task_change DROP COLUMN merge_called_at");
      state.storage.sql.exec("ALTER TABLE task_change DROP COLUMN merge_mark_set_at");
      state.storage.sql.exec("ALTER TABLE task_change DROP COLUMN merge_marked_at");
      state.storage.sql.exec("ALTER TABLE task_change DROP COLUMN merge_step");
      state.storage.sql.exec("ALTER TABLE task_change DROP COLUMN merge_next_at");
      state.storage.sql.exec("ALTER TABLE task_change DROP COLUMN merge_attempts");
      state.storage.sql.exec("ALTER TABLE task_change DROP COLUMN merge_requester_person");
      state.storage.sql.exec("ALTER TABLE task_change DROP COLUMN submitter_person");
      state.storage.sql.exec("ALTER TABLE task_change DROP COLUMN submitter_id");
      state.storage.sql.exec("UPDATE schema_version SET version = version - 1");
      state.storage.sql.exec("DROP TABLE repo_read");
      state.storage.sql.exec("ALTER TABLE repo_link DROP COLUMN reads_not_before");
      state.storage.sql.exec("ALTER TABLE repo_link DROP COLUMN read_failures");
      state.storage.sql.exec("ALTER TABLE task_change DROP COLUMN pr_draft");
      state.storage.sql.exec("ALTER TABLE task_change DROP COLUMN commit_changed_at");
      state.storage.sql.exec("ALTER TABLE task_change DROP COLUMN unwatched_at");
      state.storage.sql.exec("ALTER TABLE task_change DROP COLUMN not_found_reads");
      state.storage.sql.exec("ALTER TABLE task_change DROP COLUMN read_failures");
      state.storage.sql.exec("ALTER TABLE task_change DROP COLUMN merged_by_id");
      state.storage.sql.exec("ALTER TABLE task_change DROP COLUMN unchanged_reads");
      state.storage.sql.exec("ALTER TABLE task_change DROP COLUMN read_at");
      state.storage.sql.exec("ALTER TABLE task_change DROP COLUMN observed_base_sha");
      state.storage.sql.exec("UPDATE schema_version SET version = version - 1");
      state.storage.sql.exec("DROP TABLE repo_token_mint");
      state.storage.sql.exec("DROP TABLE repo_token");
      state.storage.sql.exec("UPDATE schema_version SET version = version - 1");
      // M5 step 4's retry columns go with the request table below, then M5 step 5's webhook deliveries come off, then M5 step 2's managed repositories, then M4 step 10's operator suspension.
      state.storage.sql.exec("UPDATE schema_version SET version = version - 1");
      state.storage.sql.exec("DROP TABLE provider_delivery");
      state.storage.sql.exec("UPDATE schema_version SET version = version - 1");
      state.storage.sql.exec("DROP TABLE task_change");
      state.storage.sql.exec("DROP TABLE provider_grant");
      state.storage.sql.exec("DROP TABLE repo_link");
      state.storage.sql.exec("DROP TABLE repo_request_attempt");
      state.storage.sql.exec("DROP TABLE repo_request");
      state.storage.sql.exec("UPDATE schema_version SET version = version - 1");
      state.storage.sql.exec("ALTER TABLE workspace DROP COLUMN suspension_reason");
      state.storage.sql.exec("ALTER TABLE workspace DROP COLUMN suspended_at");
      state.storage.sql.exec("UPDATE schema_version SET version = version - 1");
      state.storage.sql.exec("DROP TABLE public_claim_block");
      state.storage.sql.exec("DROP INDEX role_claim_public");
      state.storage.sql.exec("ALTER TABLE role_claim DROP COLUMN public");
      state.storage.sql.exec("ALTER TABLE member DROP COLUMN joined_via");
      state.storage.sql.exec("UPDATE schema_version SET version = version - 1");
      state.storage.sql.exec("DROP TABLE public_index_outbox");
      state.storage.sql.exec("UPDATE schema_version SET version = version - 1");
      state.storage.sql.exec("ALTER TABLE work_role DROP COLUMN publicly_claimable");
      state.storage.sql.exec("ALTER TABLE workspace DROP COLUMN public_claims_paused");
      state.storage.sql.exec("ALTER TABLE workspace DROP COLUMN topic");
      state.storage.sql.exec("ALTER TABLE workspace DROP COLUMN published_at");
      state.storage.sql.exec("ALTER TABLE workspace DROP COLUMN public_handle");
      state.storage.sql.exec("ALTER TABLE workspace DROP COLUMN visibility");
      state.storage.sql.exec("UPDATE schema_version SET version = version - 1");
      state.storage.sql.exec("ALTER TABLE a2a_attempt DROP COLUMN kind");
      state.storage.sql.exec("ALTER TABLE a2a_attempt DROP COLUMN remote_context_id");
      state.storage.sql.exec("ALTER TABLE a2a_attempt DROP COLUMN reference_task_id");
      state.storage.sql.exec("ALTER TABLE a2a_attempt DROP COLUMN reference_context_id");
      state.storage.sql.exec("UPDATE schema_version SET version = version - 1");
          state.storage.sql.exec("DROP INDEX a2a_attempt_reads");
      state.storage.sql.exec("DROP INDEX a2a_attempt_cancels");
      state.storage.sql.exec("DROP TABLE a2a_held");
      state.storage.sql.exec("ALTER TABLE event DROP COLUMN origin");
      state.storage.sql.exec("ALTER TABLE event DROP COLUMN origin_ref");
      state.storage.sql.exec("ALTER TABLE audit_event DROP COLUMN origin");
      state.storage.sql.exec("ALTER TABLE audit_event DROP COLUMN origin_ref");
      state.storage.sql.exec("ALTER TABLE message DROP COLUMN origin");
      state.storage.sql.exec("ALTER TABLE a2a_attempt DROP COLUMN reading_ended");
      state.storage.sql.exec("ALTER TABLE a2a_attempt DROP COLUMN read_until");
      state.storage.sql.exec("ALTER TABLE a2a_attempt DROP COLUMN next_read_at");
      state.storage.sql.exec("ALTER TABLE a2a_attempt DROP COLUMN read_no");
      state.storage.sql.exec("ALTER TABLE a2a_attempt DROP COLUMN read_queued");
      state.storage.sql.exec("ALTER TABLE a2a_attempt DROP COLUMN read_queued_at");
      state.storage.sql.exec("ALTER TABLE a2a_attempt DROP COLUMN last_read_no");
      state.storage.sql.exec("ALTER TABLE a2a_attempt DROP COLUMN last_state");
      state.storage.sql.exec("ALTER TABLE a2a_attempt DROP COLUMN working_seen");
      state.storage.sql.exec("ALTER TABLE a2a_attempt DROP COLUMN read_ended_reason");
      state.storage.sql.exec("ALTER TABLE a2a_attempt DROP COLUMN cancel_state");
      state.storage.sql.exec("UPDATE schema_version SET version = version - 1");
      state.storage.sql.exec("DROP TABLE a2a_attempt");
      state.storage.sql.exec("UPDATE schema_version SET version = version - 1");
      state.storage.sql.exec("DROP INDEX stored_object_unsubmitted");
      state.storage.sql.exec("ALTER TABLE stored_object DROP COLUMN submitted_at");
      state.storage.sql.exec("UPDATE schema_version SET version = version - 1");
      state.storage.sql.exec("DROP INDEX task_expected_output");
      state.storage.sql.exec("ALTER TABLE task DROP COLUMN expected_output_id");
      state.storage.sql.exec("DROP TABLE expected_output_version");
      state.storage.sql.exec("DROP TABLE expected_output");
      state.storage.sql.exec("UPDATE schema_version SET version = version - 1");
      state.storage.sql.exec("DROP TABLE storage_sweep");
      state.storage.sql.exec("DROP INDEX stored_object_abandoned");
      state.storage.sql.exec("DROP INDEX stored_object_purge");
      for (const column of ["removed_at", "removed_by", "removed_by_kind", "removed_from", "attempt_started_at", "purge_due_at"]) state.storage.sql.exec(`ALTER TABLE stored_object DROP COLUMN ${column}`);
      state.storage.sql.exec("UPDATE schema_version SET version = version - 1");
    });
    await alarm(id);
    expect((await remove(OWNER, id, object)).body.state).toBe("removed");
  });

  it("keeps every file's bytes, and keeps fresh bytes nobody refers to until they're an hour old", async () => {
    const id = await room();
    const object = await file(id);
    const kept = (await row(id, object)).object_key;
    const stray = `rooms/${id}/objects/obj_stray/attempt`;
    await BINDINGS.ASSETS.put(stray, new Uint8Array([1, 2, 3]));
    const strayAt = (await BINDINGS.ASSETS.head(stray)).uploaded.getTime();
    await sweep(id);
    expect(await BINDINGS.ASSETS.head(kept)).not.toBeNull();
    expect(await BINDINGS.ASSETS.head(stray)).not.toBeNull();
    const due: any = await inRoom(id, (sql) => sql.exec("SELECT due_at, cursor FROM storage_sweep").toArray()[0]);
    // The next pass comes when the stray is old enough, or when the file's own attempt has settled, whichever is sooner.
    const started = (await row(id, object)).attempt_started_at;
    expect(due).toEqual({ due_at: Math.min(strayAt, started) + 60 * 60 * 1000, cursor: null });
    expect((await download(OWNER, id, object)).status).toBe(200);
  });

  it("never lists or deletes outside its own room, even a room whose ID starts the same", async () => {
    const id = await room();
    const object = await file(id);
    const other = `rooms/${id}x/objects/${object}/attempt`;
    await BINDINGS.ASSETS.put(other, new Uint8Array([1]));
    await remove(OWNER, id, object);
    await sweep(id);
    expect(await BINDINGS.ASSETS.head(other)).not.toBeNull();
    await BINDINGS.ASSETS.delete(other);
  });

  it("clears an upload an hour after its grant ends, and not before", async () => {
    const id = await room();
    const made = await api(OWNER, "POST", `/v1/workspaces/${id}/uploads`, { name: "never.txt", size: 3, sha256: await sha256(new Uint8Array([1, 2, 3])) });
    const now = Date.now();
    await inRoom(id, (sql) => sql.exec("UPDATE stored_object SET upload_expires_at = ? WHERE id = ?", now - 60 * 60 * 1000 + 60_000, made.body.id));
    await alarm(id);
    expect(await row(id, made.body.id)).toBeDefined();
    await inRoom(id, (sql) => sql.exec("UPDATE stored_object SET upload_expires_at = ? WHERE id = ?", now - 60 * 60 * 1000 - 1, made.body.id));
    const policy = await version(id);
    await alarm(id);
    expect(await row(id, made.body.id)).toBeUndefined();
    expect(await version(id)).toBe(policy);
    const [audit] = await audits(id, "object.upload_abandoned");
    expect(audit).toMatchObject({ actor_id: "podster", actor_kind: "system", target_id: made.body.id });
  });

  it("asks for a sweep an hour after an upload attempt begins", async () => {
    const id = await room();
    await inRoom(id, (sql) => sql.exec("UPDATE storage_sweep SET due_at = NULL"));
    const before = Date.now();
    await file(id);
    const { due_at }: any = await inRoom(id, (sql) => sql.exec("SELECT due_at FROM storage_sweep").toArray()[0]);
    expect(due_at).toBeGreaterThanOrEqual(before + 60 * 60 * 1000);
    expect(due_at).toBeLessThanOrEqual(Date.now() + 60 * 60 * 1000);
  });
});

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const keysUnder = async (prefix: string) => (await BINDINGS.ASSETS.list({ prefix })).objects.map((o: any) => o.key as string);

describe("removal by the rules (decisions 94 and 98)", () => {
  it("removes a blocked or failed file's bytes 7 days after its verdict, as the system, and not a moment before", async () => {
    const id = await room();
    const now = Date.now();
    const blocked = await file(id, "blocked");
    const young = await file(id, "blocked");
    const timedOut = await file(id, "failed");
    const ready = await file(id, "ready");
    await inRoom(id, (sql) => {
      sql.exec("UPDATE stored_object SET scanned_at = ? WHERE id = ?", now - 7 * DAY_MS - 1000, blocked);
      sql.exec("UPDATE stored_object SET scanned_at = ? WHERE id = ?", now - 7 * DAY_MS + 60_000, young);
      // No verdict arrived, so the hour's end is when it failed.
      sql.exec("UPDATE stored_object SET scanned_at = NULL, scanning_since = ? WHERE id = ?", now - 7 * DAY_MS - HOUR_MS - 1000, timedOut);
      sql.exec("UPDATE stored_object SET scanned_at = ? WHERE id = ?", now - 30 * DAY_MS, ready);
    });
    const key = (await row(id, blocked)).object_key;
    await alarm(id);
    expect(await row(id, blocked)).toMatchObject({ state: "removed", removed_by: "podster", removed_by_kind: "system", removed_from: "blocked" });
    expect(await row(id, timedOut)).toMatchObject({ state: "removed", removed_from: "failed" });
    expect((await row(id, young)).state).toBe("blocked");
    expect((await row(id, ready)).state).toBe("ready");
    expect(await BINDINGS.ASSETS.head(key)).toBeNull();
    const [audit] = (await audits(id, "object.removed")).filter((a) => a.target_id === blocked);
    expect(audit).toMatchObject({ actor_id: "podster", actor_kind: "system" });
  });

  it("clears a file uploaded for a task but never submitted, a day after the task left Accepted", async () => {
    const id = await room();
    const now = Date.now();
    const made = async (left: number | null, named = false) => {
      const t = await api(OWNER, "POST", `/v1/workspaces/${id}/tasks`, { title: "Work", instructions: "Do it", assignee: MEMBER.id });
      expect(t.status, JSON.stringify(t.body)).toBe(200);
      return { task: t.body.id as string, object: await file(id), left, named };
    };
    const stale = await made(now - DAY_MS - 1000);
    const fresh = await made(now - DAY_MS + 60_000);
    const stillAccepted = await made(null);
    const submitted = await made(now - 10 * DAY_MS, true);
    // Every task's clock, every file's task and the submission go in one step, as a submission writes its files with it. A room
    // alarm can fire between steps, and would rightly clear a file that's overdue and not yet named.
    await inRoom(id, (sql) => {
      for (const { task, object, left, named } of [stale, fresh, stillAccepted, submitted]) {
        sql.exec("UPDATE task SET left_accepted_at = ? WHERE id = ?", left, task);
        sql.exec("UPDATE stored_object SET for_task = ?, uploaded_by = ? WHERE id = ?", task, MEMBER.id, object);
        if (named) sql.exec("INSERT INTO submission_file (task_id, submission_no, object_id, sha256, size, label, submitted_by, submitted_org, created_at) VALUES (?, 1, ?, ?, 1, 'x', ?, ?, 0)", task, object, "0".repeat(64), MEMBER.id, MEMBER.org);
      }
    });
    await alarm(id);
    expect(await row(id, stale.object)).toMatchObject({ state: "removed", removed_by: "podster", removed_by_kind: "system", removed_from: "ready" });
    for (const kept of [fresh, stillAccepted, submitted]) expect((await row(id, kept.object)).state).toBe("ready");
  });

  it("raises the high-water mark when it clears an abandoned upload, as every other drop does", async () => {
    const id = await room();
    const made = await api(OWNER, "POST", `/v1/workspaces/${id}/uploads`, { name: "never.txt", size: 3, sha256: await sha256(new Uint8Array([1, 2, 3])) });
    await inRoom(id, (sql) => {
      sql.exec("UPDATE stored_object SET upload_expires_at = ? WHERE id = ?", Date.now() - 2 * HOUR_MS, made.body.id);
      sql.exec("UPDATE storage_sweep SET settles_at = 0");
    });
    const before = Date.now();
    await alarm(id);
    expect(await row(id, made.body.id)).toBeUndefined();
    const { settles_at }: any = await inRoom(id, (sql) => sql.exec("SELECT settles_at FROM storage_sweep").toArray()[0]);
    expect(settles_at).toBeGreaterThanOrEqual(before + HOUR_MS);
  });
});

describe("deletes that fail, and the limits on each alarm", () => {
  /** A removed file with extra keys under its own prefix, named so the test build fails them as asked. */
  async function removedWith(names: string[]) {
    const id = await room();
    const object = await file(id);
    const prefix = `rooms/${id}/objects/${object}/`;
    for (const name of names) await BINDINGS.ASSETS.put(prefix + name, new Uint8Array([1]));
    expect((await remove(OWNER, id, object)).status).toBe(200);
    return { id, object, prefix };
  }

  it("falls back to one key at a time when a batch fails, so the purge still finishes", async () => {
    const { id, object, prefix } = await removedWith(["failbatch-a", "failbatch-b"]);
    await alarm(id);
    expect(await keysUnder(prefix)).toEqual([]);
    const after: any = await row(id, object);
    expect(after.purge_due_at).toBe(after.attempt_started_at + HOUR_MS);
  });

  it("skips a key that won't delete, purges the rest, and tries again a minute on", async () => {
    const { id, object, prefix } = await removedWith(["a-fine", "b-stuck", "c-fine"]);
    const before = Date.now();
    await alarm(id);
    expect(await keysUnder(prefix)).toEqual([prefix + "b-stuck"]);
    const { purge_due_at }: any = await row(id, object);
    expect(purge_due_at).toBeGreaterThanOrEqual(before + 60_000);
    expect(purge_due_at).toBeLessThanOrEqual(Date.now() + 60_000);
    await BINDINGS.ASSETS.delete(prefix + "b-stuck");
  });

  it("lists at most two pages of a file per alarm, and comes back soon for the rest", async () => {
    // A test build lists ten keys a page, so 25 keys and the file's own take three pages.
    const { id, object, prefix } = await removedWith(Array.from({ length: 25 }, (_, i) => `k${String(i).padStart(2, "0")}`));
    const before = Date.now();
    await alarm(id);
    const left = await keysUnder(prefix);
    expect(left.length).toBeGreaterThan(0);
    expect(left.length).toBeLessThanOrEqual(6);
    const { purge_due_at }: any = await row(id, object);
    expect(purge_due_at).toBeGreaterThanOrEqual(before);
    expect(purge_due_at).toBeLessThan(Date.now() + 60_000);
  });

  it("in the room-wide sweep, falls back per key, skips a stuck one, and lists at most three pages", async () => {
    const id = await room();
    const removed = async (key: string) => {
      const object = await file(id);
      await BINDINGS.ASSETS.put(key, new Uint8Array([1]));
      // Its row names this key, and no purge runs, so only the sweep can delete it.
      await inRoom(id, (sql) => sql.exec("UPDATE stored_object SET object_key = ?, state = 'removed', purge_due_at = NULL WHERE id = ?", key, object));
      return key;
    };
    const batch = await removed(`rooms/${id}/objects/aa-failbatch/x`);
    const stuck = await removed(`rooms/${id}/objects/ab-stuck/x`);
    // Each file's arrival armed the alarm that takes its scan turn (M4 step 14). It runs here, before the strays exist, so the
    // forced sweep below is the only pass over them.
    await alarm(id);
    // Fresh strays after them fill more than three pages of ten.
    for (let i = 0; i < 35; i++) await BINDINGS.ASSETS.put(`rooms/${id}/objects/z${String(i).padStart(2, "0")}/a`, new Uint8Array([1]));
    const before = Date.now();
    await sweep(id);
    expect(await BINDINGS.ASSETS.head(batch)).toBeNull();
    expect(await BINDINGS.ASSETS.head(stuck)).not.toBeNull();
    const state: any = await inRoom(id, (sql) => sql.exec("SELECT cursor, cycle_due_at FROM storage_sweep").toArray()[0]);
    expect(state.cursor).not.toBeNull();
    expect(state.cycle_due_at).toBeGreaterThanOrEqual(before + 60_000);
    expect(state.cycle_due_at).toBeLessThanOrEqual(Date.now() + 60_000);
    await BINDINGS.ASSETS.delete(stuck);
  });
});

describe("removal by the rules, review fixes", () => {
  it("gives a scan noticed late its full 7 days: it fails with the time it was noticed, and isn't removed in the same alarm", async () => {
    const id = await room();
    const late = await file(id, "scanning");
    // Taken before the scan is made overdue, since a room alarm already pending may notice it before the one run here.
    const before = Date.now();
    await inRoom(id, (sql) => sql.exec("UPDATE stored_object SET scanning_since = ?, scanned_at = NULL WHERE id = ?", Date.now() - 8 * DAY_MS, late));
    await alarm(id);
    const after: any = await row(id, late);
    expect(after.state).toBe("failed");
    expect(after.scanned_at).toBeGreaterThanOrEqual(before);
  });

  it("flags a submitted file the cheap query found unflagged, and never removes it", async () => {
    const id = await room();
    const t = await api(OWNER, "POST", `/v1/workspaces/${id}/tasks`, { title: "Work", instructions: "Do it", assignee: MEMBER.id });
    const object = await file(id);
    await inRoom(id, (sql) => {
      sql.exec("UPDATE task SET left_accepted_at = ? WHERE id = ?", Date.now() - 2 * DAY_MS, t.body.id);
      sql.exec("UPDATE stored_object SET for_task = ?, uploaded_by = ?, submitted_at = NULL WHERE id = ?", t.body.id, MEMBER.id, object);
      sql.exec("INSERT INTO submission_file (task_id, submission_no, object_id, sha256, size, label, submitted_by, submitted_org, created_at) VALUES (?, 1, ?, ?, 1, 'x', ?, ?, 123)", t.body.id, object, "0".repeat(64), MEMBER.id, MEMBER.org);
    });
    await alarm(id);
    expect(await row(id, object)).toMatchObject({ state: "ready", submitted_at: 123 });
  });

  it("flags files submissions already name when the migration runs", async () => {
    const id = await room();
    const t = await api(OWNER, "POST", `/v1/workspaces/${id}/tasks`, { title: "Work", instructions: "Do it", assignee: MEMBER.id });
    const named = await file(id);
    const unnamed = await file(id);
    await runInDurableObject(stub(id), (_: any, state: any) => {
      const sql = state.storage.sql;
      sql.exec("INSERT INTO submission_file (task_id, submission_no, object_id, sha256, size, label, submitted_by, submitted_org, created_at) VALUES (?, 1, ?, ?, 1, 'x', ?, ?, 456)", t.body.id, named, "0".repeat(64), MEMBER.id, MEMBER.org);
      // M4 step 8's public claims, the newest migration, then step 6's discovery outbox, step 5's room visibility, step 13b's change requests, step 13's read-back and step 12's A2A attempts.
      // M5 step 6's agent tokens, the newest migration, come off first.
      // M5 step 7a's read bookkeeping, the newest migration, comes off first.
      // M5 step 7b's merge bookkeeping, the newest migration, comes off first.
      // The newest step, the M5 security review's two columns, comes off first.
      // M6 step 2's release tables, the newest migration, come off first.
      // M6 step 4(a)'s applier and script-delete tables, the newest migration, come off first.
      // The record of release bookkeeping that keeps failing, the newest migration, comes off first.
      // Decision 218's applied release switch, the newest migration, comes off first.
      state.storage.sql.exec("DROP TABLE release_switch_applied");
      state.storage.sql.exec("UPDATE schema_version SET version = version - 1");
      state.storage.sql.exec("DROP TABLE release_bookkeeping");
      state.storage.sql.exec("UPDATE schema_version SET version = version - 1");
      for (const table of ["serve_apply", "script_delete"]) state.storage.sql.exec(`DROP TABLE ${table}`);
      state.storage.sql.exec("UPDATE schema_version SET version = version - 1");
      for (const table of ["release_config", "serve_state", "unpublish", "release", "app_label", "hostname_request"]) state.storage.sql.exec(`DROP TABLE ${table}`);
      state.storage.sql.exec("UPDATE schema_version SET version = version - 1");
      state.storage.sql.exec("ALTER TABLE repo_link DROP COLUMN gone_seen_at");
      state.storage.sql.exec("ALTER TABLE repo_request DROP COLUMN limited_since");
      state.storage.sql.exec("ALTER TABLE repo_request DROP COLUMN limited_call");
      state.storage.sql.exec("UPDATE schema_version SET version = version - 1");
      // The step that keeps an approval's reviewer (A1, decision 195) comes off next.
      state.storage.sql.exec("ALTER TABLE task_change DROP COLUMN reviewer_person");
      state.storage.sql.exec("ALTER TABLE task_change DROP COLUMN reviewer_id");
      state.storage.sql.exec("UPDATE schema_version SET version = version - 1");
      state.storage.sql.exec("DROP TABLE merge_request");
      state.storage.sql.exec("ALTER TABLE task_change DROP COLUMN merge_finished_at");
      state.storage.sql.exec("ALTER TABLE task_change DROP COLUMN merge_called_at");
      state.storage.sql.exec("ALTER TABLE task_change DROP COLUMN merge_mark_set_at");
      state.storage.sql.exec("ALTER TABLE task_change DROP COLUMN merge_marked_at");
      state.storage.sql.exec("ALTER TABLE task_change DROP COLUMN merge_step");
      state.storage.sql.exec("ALTER TABLE task_change DROP COLUMN merge_next_at");
      state.storage.sql.exec("ALTER TABLE task_change DROP COLUMN merge_attempts");
      state.storage.sql.exec("ALTER TABLE task_change DROP COLUMN merge_requester_person");
      state.storage.sql.exec("ALTER TABLE task_change DROP COLUMN submitter_person");
      state.storage.sql.exec("ALTER TABLE task_change DROP COLUMN submitter_id");
      state.storage.sql.exec("UPDATE schema_version SET version = version - 1");
      state.storage.sql.exec("DROP TABLE repo_read");
      state.storage.sql.exec("ALTER TABLE repo_link DROP COLUMN reads_not_before");
      state.storage.sql.exec("ALTER TABLE repo_link DROP COLUMN read_failures");
      state.storage.sql.exec("ALTER TABLE task_change DROP COLUMN pr_draft");
      state.storage.sql.exec("ALTER TABLE task_change DROP COLUMN commit_changed_at");
      state.storage.sql.exec("ALTER TABLE task_change DROP COLUMN unwatched_at");
      state.storage.sql.exec("ALTER TABLE task_change DROP COLUMN not_found_reads");
      state.storage.sql.exec("ALTER TABLE task_change DROP COLUMN read_failures");
      state.storage.sql.exec("ALTER TABLE task_change DROP COLUMN merged_by_id");
      state.storage.sql.exec("ALTER TABLE task_change DROP COLUMN unchanged_reads");
      state.storage.sql.exec("ALTER TABLE task_change DROP COLUMN read_at");
      state.storage.sql.exec("ALTER TABLE task_change DROP COLUMN observed_base_sha");
      state.storage.sql.exec("UPDATE schema_version SET version = version - 1");
      state.storage.sql.exec("DROP TABLE repo_token_mint");
      state.storage.sql.exec("DROP TABLE repo_token");
      state.storage.sql.exec("UPDATE schema_version SET version = version - 1");
      // M5 step 4's retry columns go with the request table below, then M5 step 5's webhook deliveries come off, then M5 step 2's managed repositories, then M4 step 10's operator suspension.
      state.storage.sql.exec("UPDATE schema_version SET version = version - 1");
      state.storage.sql.exec("DROP TABLE provider_delivery");
      state.storage.sql.exec("UPDATE schema_version SET version = version - 1");
      state.storage.sql.exec("DROP TABLE task_change");
      state.storage.sql.exec("DROP TABLE provider_grant");
      state.storage.sql.exec("DROP TABLE repo_link");
      state.storage.sql.exec("DROP TABLE repo_request_attempt");
      state.storage.sql.exec("DROP TABLE repo_request");
      state.storage.sql.exec("UPDATE schema_version SET version = version - 1");
      state.storage.sql.exec("ALTER TABLE workspace DROP COLUMN suspension_reason");
      state.storage.sql.exec("ALTER TABLE workspace DROP COLUMN suspended_at");
      state.storage.sql.exec("UPDATE schema_version SET version = version - 1");
      state.storage.sql.exec("DROP TABLE public_claim_block");
      state.storage.sql.exec("DROP INDEX role_claim_public");
      state.storage.sql.exec("ALTER TABLE role_claim DROP COLUMN public");
      state.storage.sql.exec("ALTER TABLE member DROP COLUMN joined_via");
      state.storage.sql.exec("UPDATE schema_version SET version = version - 1");
      state.storage.sql.exec("DROP TABLE public_index_outbox");
      state.storage.sql.exec("UPDATE schema_version SET version = version - 1");
      state.storage.sql.exec("ALTER TABLE work_role DROP COLUMN publicly_claimable");
      state.storage.sql.exec("ALTER TABLE workspace DROP COLUMN public_claims_paused");
      state.storage.sql.exec("ALTER TABLE workspace DROP COLUMN topic");
      state.storage.sql.exec("ALTER TABLE workspace DROP COLUMN published_at");
      state.storage.sql.exec("ALTER TABLE workspace DROP COLUMN public_handle");
      state.storage.sql.exec("ALTER TABLE workspace DROP COLUMN visibility");
      state.storage.sql.exec("UPDATE schema_version SET version = version - 1");
      state.storage.sql.exec("ALTER TABLE a2a_attempt DROP COLUMN kind");
      state.storage.sql.exec("ALTER TABLE a2a_attempt DROP COLUMN remote_context_id");
      state.storage.sql.exec("ALTER TABLE a2a_attempt DROP COLUMN reference_task_id");
      state.storage.sql.exec("ALTER TABLE a2a_attempt DROP COLUMN reference_context_id");
      state.storage.sql.exec("UPDATE schema_version SET version = version - 1");
          state.storage.sql.exec("DROP INDEX a2a_attempt_reads");
      state.storage.sql.exec("DROP INDEX a2a_attempt_cancels");
      state.storage.sql.exec("DROP TABLE a2a_held");
      state.storage.sql.exec("ALTER TABLE event DROP COLUMN origin");
      state.storage.sql.exec("ALTER TABLE event DROP COLUMN origin_ref");
      state.storage.sql.exec("ALTER TABLE audit_event DROP COLUMN origin");
      state.storage.sql.exec("ALTER TABLE audit_event DROP COLUMN origin_ref");
      state.storage.sql.exec("ALTER TABLE message DROP COLUMN origin");
      state.storage.sql.exec("ALTER TABLE a2a_attempt DROP COLUMN reading_ended");
      state.storage.sql.exec("ALTER TABLE a2a_attempt DROP COLUMN read_until");
      state.storage.sql.exec("ALTER TABLE a2a_attempt DROP COLUMN next_read_at");
      state.storage.sql.exec("ALTER TABLE a2a_attempt DROP COLUMN read_no");
      state.storage.sql.exec("ALTER TABLE a2a_attempt DROP COLUMN read_queued");
      state.storage.sql.exec("ALTER TABLE a2a_attempt DROP COLUMN read_queued_at");
      state.storage.sql.exec("ALTER TABLE a2a_attempt DROP COLUMN last_read_no");
      state.storage.sql.exec("ALTER TABLE a2a_attempt DROP COLUMN last_state");
      state.storage.sql.exec("ALTER TABLE a2a_attempt DROP COLUMN working_seen");
      state.storage.sql.exec("ALTER TABLE a2a_attempt DROP COLUMN read_ended_reason");
      state.storage.sql.exec("ALTER TABLE a2a_attempt DROP COLUMN cancel_state");
      state.storage.sql.exec("UPDATE schema_version SET version = version - 1");
      sql.exec("DROP TABLE a2a_attempt");
      sql.exec("UPDATE schema_version SET version = version - 1");
      sql.exec("DROP INDEX stored_object_unsubmitted");
      sql.exec("ALTER TABLE stored_object DROP COLUMN submitted_at");
      sql.exec("UPDATE schema_version SET version = version - 1");
    });
    expect((await api(OWNER, "GET", `/v1/workspaces/${id}`)).status).toBe(200);
    expect((await row(id, named)).submitted_at).toBe(456);
    expect((await row(id, unnamed)).submitted_at).toBeNull();
  });

  it("removes each file in its own transaction, so one that errors doesn't stop the rest", async () => {
    const id = await room();
    const good = await file(id, "blocked");
    const bad = await file(id, "blocked");
    await inRoom(id, (sql) => {
      sql.exec("UPDATE stored_object SET id = 'obj_failrule' WHERE id = ?", bad);
      // The bad one is older, so it's tried first.
      sql.exec("UPDATE stored_object SET scanned_at = ? WHERE id = ?", Date.now() - 9 * DAY_MS, "obj_failrule");
      sql.exec("UPDATE stored_object SET scanned_at = ? WHERE id = ?", Date.now() - 8 * DAY_MS, good);
    });
    await alarm(id);
    expect((await row(id, good)).state).toBe("removed");
    expect((await row(id, "obj_failrule")).state).toBe("blocked");
  });
});
