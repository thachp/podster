import { afterEach, describe, expect, it, vi } from "vitest";
import { TaskState } from "@a2a-js/sdk";
import { PodsterA2AHandler } from "../src/a2a/handler";
import { INCOMPLETE_HEADER, MAX_LIST_CALLS, MAX_LIST_ROOMS, UpstreamError, listTasks, type ApiReads, type ReadNotes } from "../src/a2a/reads";

/** `ListTasks` and its limits with the API stubbed, for cases a real room can't reach: 51 rooms, a 5xx, a page that moves. */
const hex = (n: number) => n.toString(16).padStart(32, "0");
const ws = (n: number) => `ws_${hex(n)}`;
const tsk = (n: number) => `tsk_${hex(n)}`;

type Page = { status: number; body: any };
function stub(rooms: string[], page: (room: string, query: { cursor?: number; status?: string }, call: number) => Page) {
  const asked: { room: string; cursor?: number; status?: string }[] = [];
  let listed = 0;
  const api: ApiReads = {
    listWorkspaces: async () => (listed++, { status: 200, body: { workspaces: rooms.map((id) => ({ workspace_id: id })) } }),
    listTasks: async (room, query) => (asked.push({ room, cursor: query.cursor, status: query.status }), page(room, query, asked.length)),
    getTask: async () => ({ status: 404, body: { error: { code: "task_not_found" } } }),
  };
  return { api, asked, listed: () => listed };
}
const onePerRoom = (room: string): Page => ({ status: 200, body: { tasks: [{ id: tsk(parseInt(room.slice(3), 16) + 1), status: "offered" }], next_cursor: null } });
const list = (api: ApiReads, params: object, notes: ReadNotes = {}) => listTasks(api, "agt_x", params as never, notes);

afterEach(() => vi.restoreAllMocks());

describe("the room cap", () => {
  it("lists at most the cap's rooms, and notes that the list is incomplete", async () => {
    const { api, asked } = stub(Array.from({ length: MAX_LIST_ROOMS + 3 }, (_, i) => ws(i)), onePerRoom);
    const notes: ReadNotes = {};
    let token = "";
    for (let i = 0; i < 10; i++) {
      const page = await list(api, { pageSize: 50, ...(token ? { pageToken: token } : {}) }, notes);
      token = page.nextPageToken;
      if (!token) break;
    }
    expect(new Set(asked.map((a) => a.room)).size).toBe(MAX_LIST_ROOMS);
    expect(notes.incompleteRooms).toBe(true);
    expect(INCOMPLETE_HEADER).toBe("Podster-List-Incomplete");
  });

  it("says nothing at or under the cap", async () => {
    const notes: ReadNotes = {};
    await list(stub(Array.from({ length: MAX_LIST_ROOMS }, (_, i) => ws(i)), onePerRoom).api, { pageSize: 50 }, notes);
    expect(notes.incompleteRooms).toBeUndefined();
  });

  it("reads rooms in ID order, whatever order the room list gives", async () => {
    const { api, asked } = stub([ws(3), ws(1), ws(2)], onePerRoom);
    await list(api, {});
    expect(asked.map((a) => a.room)).toEqual([ws(1), ws(2), ws(3)]);
  });
});

describe("what one request costs", () => {
  it("answers a state no Podster task has without asking any room", async () => {
    const s = stub([ws(1)], onePerRoom);
    expect((await list(s.api, { status: TaskState.TASK_STATE_FAILED })).tasks).toEqual([]);
    expect(s.listed()).toBe(0);
    expect(s.asked).toEqual([]);
  });

  it("passes the filter's statuses down to the API, one at a time", async () => {
    const s = stub([ws(1)], (_room, q) => ({ status: 200, body: { tasks: [{ id: q.status === "open" ? tsk(1) : tsk(2), status: q.status }], next_cursor: null } }));
    const page = await list(s.api, { status: TaskState.TASK_STATE_SUBMITTED });
    expect(s.asked.map((a) => a.status)).toEqual(["open", "offered"]);
    expect(page.tasks).toHaveLength(2);
  });

  it("stops after MAX_LIST_CALLS API reads, with a token to go on from", async () => {
    const s = stub([ws(1)], (_room, q) => ({ status: 200, body: { tasks: [], next_cursor: (q.cursor ?? 10_000) - 1 } }));
    const page = await list(s.api, {});
    expect(s.asked).toHaveLength(MAX_LIST_CALLS);
    expect(page.nextPageToken).not.toBe("");
    await list(s.api, { pageToken: page.nextPageToken });
    expect(s.asked[MAX_LIST_CALLS].cursor).toBe(s.asked[MAX_LIST_CALLS - 1].cursor! - 1);
  });
});

describe("a room that doesn't answer", () => {
  it("passes over a room that now refuses the caller", async () => {
    const s = stub([ws(1), ws(2)], (room) => (room === ws(1) ? { status: 403, body: { error: { code: "access_revoked" } } } : onePerRoom(room)));
    expect((await list(s.api, {})).tasks.map((t) => t.id)).toEqual([`${ws(2)}:${tsk(3)}`]);
  });

  it("fails the read on a 5xx, a 429 or a 400, so a list is never silently short", async () => {
    for (const status of [500, 503, 429, 400]) {
      const s = stub([ws(1), ws(2)], (room) => (room === ws(1) ? { status, body: "<html>oops</html>" } : onePerRoom(room)));
      await expect(list(s.api, {})).rejects.toBeInstanceOf(UpstreamError);
    }
  });

  it("answers a fixed 'Internal error' and logs only IDs and the status", async () => {
    const logged: string[] = [];
    vi.spyOn(console, "error").mockImplementation((line) => void logged.push(String(line)));
    const s = stub([ws(1)], () => ({ status: 502, body: "secret upstream body" }));
    const handler = new PodsterA2AHandler("https://gateway.test", { agentId: "agt_x", api: s.api });
    const error = await handler.listTasks({} as never).catch((e) => e);
    expect(error.message).toBe("Internal error");
    expect(logged).toEqual([JSON.stringify({ event: "a2a.internal_error", operation: "ListTasks", agent: "agt_x", status: 502 })]);
  });
});

describe("paging", () => {
  const twoOnAPage = (room: string): Page => ({ status: 200, body: { tasks: [{ id: tsk(1), status: "offered" }, { id: tsk(2), status: "offered" }], next_cursor: null } });

  it("goes on after the last task it sent, and starts the page again if that task has moved", async () => {
    let moved = false;
    const s = stub([ws(1)], (room) => (moved ? { status: 200, body: { tasks: [{ id: tsk(2), status: "offered" }], next_cursor: null } } : twoOnAPage(room)));
    const first = await list(s.api, { pageSize: 1 });
    expect(first.tasks.map((t) => t.id)).toEqual([`${ws(1)}:${tsk(1)}`]);
    const second = await list(s.api, { pageSize: 1, pageToken: first.nextPageToken });
    expect(second.tasks.map((t) => t.id)).toEqual([`${ws(1)}:${tsk(2)}`]);
    moved = true;
    const again = await list(s.api, { pageSize: 1, pageToken: first.nextPageToken });
    // tsk(1) left the page, so the page starts over: tsk(2) is sent, and nothing is skipped.
    expect(again.tasks.map((t) => t.id)).toEqual([`${ws(1)}:${tsk(2)}`]);
  });

  it("refuses a token with a cursor no room could have, or the wrong shape", async () => {
    const s = stub([ws(1)], twoOnAPage);
    const make = (c: object) => btoa(JSON.stringify(c)).replace(/=+$/, "");
    for (const bad of [{ v: 2, ws: ws(1), s: 0, c: 2 ** 53, after: "", f: "*" }, { v: 2, ws: ws(1), s: 5, c: 0, after: "", f: "*" }, { v: 2, ws: ws(1), s: 0, c: 0, after: "nope", f: "*" }, { v: 1, ws: ws(1), c: 0, skip: 0, f: "*" }]) {
      await expect(list(s.api, { pageToken: make(bad) })).rejects.toThrow(/pageToken/);
    }
  });

  it("falls back to the default page size for a size that isn't a number", async () => {
    const s = stub([ws(1)], twoOnAPage);
    expect((await list(s.api, { pageSize: Number.NaN })).pageSize).toBe(50);
    expect((await list(s.api, { pageSize: 0 })).pageSize).toBe(50);
    expect((await list(s.api, { pageSize: 999 })).pageSize).toBe(50);
  });
});
