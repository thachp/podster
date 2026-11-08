import { describe, expect, it } from "vitest";
import { INCOMPLETE_HEADER, MAX_LIST_ROOMS, listTasks, type ApiReads, type ReadNotes } from "../src/a2a/reads";

/** `ListTasks` past the room cap, with the API stubbed, because one organization can't hold that many rooms. */
const hex = (n: number) => n.toString(16).padStart(32, "0");
function stub(rooms: number): { api: ApiReads; asked: string[] } {
  const asked: string[] = [];
  const api: ApiReads = {
    listWorkspaces: async () => ({ status: 200, body: { workspaces: Array.from({ length: rooms }, (_, i) => ({ workspace_id: `ws_${hex(i)}` })) } }),
    listTasks: async (ws) => {
      asked.push(ws);
      return { status: 200, body: { tasks: [{ id: `tsk_${hex(asked.length)}`, status: "offered" }], next_cursor: null } };
    },
    getTask: async () => ({ status: 404, body: { error: { code: "task_not_found" } } }),
  };
  return { api, asked };
}

describe("ListTasks past the room cap", () => {
  it("lists at most the cap's rooms, and notes that the list is incomplete", async () => {
    const { api, asked } = stub(MAX_LIST_ROOMS + 3);
    const notes: ReadNotes = {};
    let token = "";
    for (let i = 0; i < 10; i++) {
      const page = await listTasks(api, "agt_x", { pageSize: 50, ...(token ? { pageToken: token } : {}) } as never, notes);
      token = page.nextPageToken;
      if (!token) break;
    }
    expect(new Set(asked).size).toBe(MAX_LIST_ROOMS);
    expect(notes.incompleteRooms).toBe(true);
    expect(INCOMPLETE_HEADER).toBe("Podster-List-Incomplete");
  });

  it("says nothing at or under the cap", async () => {
    const notes: ReadNotes = {};
    await listTasks(stub(MAX_LIST_ROOMS).api, "agt_x", { pageSize: 50 } as never, notes);
    expect(notes.incompleteRooms).toBeUndefined();
  });
});
