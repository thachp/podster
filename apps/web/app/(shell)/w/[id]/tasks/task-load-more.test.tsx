import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setUrl } from "@/test/next-navigation";
import { summaryOf, type Room, type Task } from "./task-model";
import { rememberPlace } from "./task-pages";
import { advanceFirstPage, endOfListText, MAX_PUSHED_OFF, mergeTasks, soFarText, type FirstPageHistory } from "./task-views";
import { TasksScreen } from "./tasks-screen";
import { useLoadOnScroll } from "./task-pages";
import { StrictMode } from "react";

const signIn = vi.hoisted(() => vi.fn());
vi.mock("./go-to-sign-in", () => ({ goToSignIn: signIn }));

const task = (id: string, over: Partial<Task> = {}): Task => ({ id, title: `Title ${id}`, instructions: "I", acceptance_criteria: null, requester: "per_me", assignee: null, reviewer: "per_o", status: "open", version: 1, due_at: null, follow_up_of: null, submission_no: 0, needs_attention: false, ...over });
const room = (role = "member"): Room => ({ id: "ws_1", name: "Billing", owner: "per_o", members: [{ principal_id: "per_me", kind: "person", org_id: "org_a", role }] });

type Reply = { status?: number; tasks?: Task[]; next_cursor?: string | null };
let reads: string[];
let replies: Record<string, Reply | (() => Promise<Reply>)>;
let signals: AbortSignal[];
/** Where the bottom of the list sits in the window. Only this test's scrolling changes it. */
let bottomTop: number;

/** The reader moves, or a correction runs, which a browser reports the same way. */
const scrollTo = (top: number) => {
  bottomTop = top;
  fireEvent.scroll(window);
};
const scrolledDown = (y: number) => Object.defineProperty(window, "scrollY", { value: y, configurable: true });
const settled = () => act(() => new Promise((resolve) => setTimeout(resolve, 10)));

beforeEach(() => {
  setUrl("/w/ws_1/tasks");
  reads = [];
  replies = {};
  signals = [];
  bottomTop = 5000;
  signIn.mockClear();
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(() => ({ top: bottomTop, bottom: bottomTop, left: 0, right: 0, width: 0, height: 0, x: 0, y: bottomTop, toJSON: () => ({}) }));
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    const query = url.split("?")[1] ?? "";
    reads.push(query);
    if (init?.signal) signals.push(init.signal);
    const reply = replies[query] ?? { status: 503 };
    const { status = 200, tasks = [], next_cursor = null } = typeof reply === "function" ? await reply() : reply;
    return new Response(JSON.stringify(status === 200 ? { tasks, next_cursor } : { error: { code: "error" } }), { status });
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  scrolledDown(0);
});

const screenWith = (tasks = [task("a")], cursor: string | null = "tsk_c50", role = "member") => <TasksScreen room={room(role)} tasks={tasks} cursor={cursor} me="per_me" names={{}} />;
const show = (tasks = [task("a")], cursor: string | null = "tsk_c50") => render(screenWith(tasks, cursor));
const button = () => screen.getByRole("button", { name: /Load more|Loading more/ });
const row = (name: string) => screen.getByRole("link", { name });

describe("Load more", () => {
  it("shows no button when one page was everything", () => {
    show([task("a")], null);
    expect(screen.queryByRole("button", { name: "Load more" })).not.toBeInTheDocument();
    expect(screen.queryByText(/End of the list/)).not.toBeInTheDocument();
  });

  it("keeps going to the end, then moves focus to the line that replaces the button", async () => {
    const user = userEvent.setup();
    replies["cursor=tsk_c50&order=newest"] = { tasks: [task("b")], next_cursor: "tsk_c100" };
    replies["cursor=tsk_c100&order=newest"] = { tasks: [task("c")], next_cursor: null };
    show();
    await user.click(button());
    expect(await screen.findByRole("link", { name: "Title b" })).toBeInTheDocument();
    expect(button()).toHaveFocus();
    expect(screen.getByText(/2 tasks loaded so far/)).toBeInTheDocument();
    await user.click(button());
    const done = await screen.findByText(/End of the list when it loaded: 3 tasks/);
    await waitFor(() => expect(done).toHaveFocus());
    expect(reads).toEqual(["cursor=tsk_c50&order=newest", "cursor=tsk_c100&order=newest"]);
    expect(screen.getByRole("progressbar")).toBeInTheDocument();
  });

  it("reads one page at a time, however often it's pressed", async () => {
    const user = userEvent.setup();
    let finish: (reply: Reply) => void = () => undefined;
    replies["cursor=tsk_c50&order=newest"] = () => new Promise((resolve) => (finish = resolve));
    show();
    await user.click(button());
    await user.click(button());
    expect(button()).toHaveAttribute("aria-disabled", "true");
    expect(button()).toHaveFocus();
    expect(reads).toEqual(["cursor=tsk_c50&order=newest"]);
    await act(async () => finish({ tasks: [task("b")], next_cursor: "tsk_c100" }));
    expect(await screen.findByRole("link", { name: "Title b" })).toBeInTheDocument();
  });

  it("never lists a task twice, and an older read can't undo a newer one", () => {
    expect(mergeTasks([task("a", { title: "Old", version: 2 })], [task("a", { title: "Older", version: 1 }), task("b")]).map((t) => [t.id, t.title])).toEqual([["a", "Old"], ["b", "Title b"]]);
    expect(mergeTasks([task("a", { title: "Old" })], [task("a", { title: "New", version: 2 })]).map((t) => t.title)).toEqual(["New"]);
  });

  it("puts a new page below what's there, in the order the read gave", async () => {
    const user = userEvent.setup();
    replies["cursor=tsk_c50&order=newest"] = { tasks: [task("b")], next_cursor: null };
    show();
    await user.click(button());
    const later = await screen.findByRole("link", { name: "Title b" });
    expect(row("Title a").compareDocumentPosition(later) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("shows a room that fits on a page in the order the read gave, which is newest first", () => {
    show([task("new"), task("old")], null);
    expect(row("Title new").compareDocumentPosition(row("Title old")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("holds no instructions or criteria for a row, which the Sheet reads for itself", () => {
    const summary = summaryOf(task("a", { instructions: "long", acceptance_criteria: "long" }));
    expect(summary).not.toHaveProperty("instructions");
    expect(summary).not.toHaveProperty("acceptance_criteria");
  });

  it("says what its count covers, and gets one right", () => {
    expect(endOfListText(1, false)).toContain("1 task.");
    expect(endOfListText(0, false)).toBe("End of the list when it loaded.");
    expect(endOfListText(1, true)).toContain("1 task waiting for your review");
    expect(endOfListText(0, true)).toContain("nothing waiting for your review");
    expect(soFarText(1, false)).toContain("1 task loaded");
    expect(soFarText(2, true)).toContain("2 tasks waiting for your review so far");
  });
});

describe("loading as the reader scrolls", () => {
  it("reads once for a reader already near the bottom when it starts, and doesn't run on from there", async () => {
    scrolledDown(4000);
    bottomTop = 100;
    replies["cursor=tsk_c50&order=newest"] = { tasks: [task("b")], next_cursor: "tsk_c100" };
    show();
    expect(await screen.findByRole("link", { name: "Title b" })).toBeInTheDocument();
    await settled();
    expect(reads).toEqual(["cursor=tsk_c50&order=newest"]);
  });

  it("doesn't read when it starts for a reader far from the bottom", async () => {
    scrolledDown(100);
    show();
    await settled();
    expect(reads).toEqual([]);
  });

  it("makes one read when the button is pressed as it starts", async () => {
    scrolledDown(4000);
    bottomTop = 100;
    replies["cursor=tsk_c50&order=newest"] = { tasks: [task("b")], next_cursor: "tsk_c100" };
    show();
    fireEvent.click(button());
    expect(await screen.findByRole("link", { name: "Title b" })).toBeInTheDocument();
    await settled();
    expect(reads).toEqual(["cursor=tsk_c50&order=newest"]);
  });

  it("looks only once, so a list that gains a next page later doesn't read without a move", async () => {
    scrolledDown(4000);
    bottomTop = 100;
    const load = vi.fn();
    const Probe = ({ cursor }: { cursor: string | null }) => {
      const bottom = useLoadOnScroll({ cursor, status: "idle", load, tasks: [] }, false);
      return <div ref={bottom} />;
    };
    const { rerender } = render(<Probe cursor="tsk_c50" />);
    await settled();
    expect(load).toHaveBeenCalledTimes(1);
    rerender(<Probe cursor={null} />);
    await settled();
    rerender(<Probe cursor="tsk_c100" />);
    await settled();
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("still looks if the list's bottom goes away and comes back before the look could run", async () => {
    scrolledDown(4000);
    bottomTop = 100;
    const load = vi.fn();
    const Probe = ({ cursor }: { cursor: string | null }) => {
      const bottom = useLoadOnScroll({ cursor, status: "idle", load, tasks: [] }, false);
      return <div ref={bottom} />;
    };
    const { rerender } = render(<Probe cursor="tsk_c50" />);
    rerender(<Probe cursor={null} />);
    rerender(<Probe cursor="tsk_c100" />);
    await settled();
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("still looks, once, when React runs its effects twice", async () => {
    scrolledDown(4000);
    bottomTop = 100;
    const load = vi.fn();
    const Probe = () => {
      const bottom = useLoadOnScroll({ cursor: "tsk_c50", status: "idle", load, tasks: [] }, false);
      return <div ref={bottom} />;
    };
    render(
      <StrictMode>
        <Probe />
      </StrictMode>,
    );
    await settled();
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("doesn't read when it starts with a Sheet open over the list", async () => {
    scrolledDown(4000);
    bottomTop = 100;
    setUrl("/w/ws_1/tasks?task=tsk_a");
    show();
    await settled();
    expect(reads.filter((query) => query.startsWith("cursor="))).toEqual([]);
  });

  it("reads nothing until they move", async () => {
    bottomTop = 100;
    replies["cursor=tsk_c50&order=newest"] = { tasks: [task("b")], next_cursor: "tsk_c100" };
    show();
    await settled();
    expect(reads).toEqual([]);
  });

  it("gives one scroll one page, even when that page lands above them and they're still at the bottom", async () => {
    replies["cursor=tsk_c50&order=newest"] = { tasks: [task("b")], next_cursor: "tsk_c100" };
    replies["cursor=tsk_c100&order=newest"] = { tasks: [task("c")], next_cursor: "tsk_c150" };
    show();
    scrollTo(500);
    expect(await screen.findByRole("link", { name: "Title b" })).toBeInTheDocument();
    // The correction's own scroll event, which leaves them exactly where they were.
    scrollTo(500);
    scrollTo(498);
    await settled();
    expect(reads).toEqual(["cursor=tsk_c50&order=newest"]);
    scrollTo(400);
    expect(await screen.findByRole("link", { name: "Title c" })).toBeInTheDocument();
    expect(reads).toEqual(["cursor=tsk_c50&order=newest", "cursor=tsk_c100&order=newest"]);
  });

  it("reads again when a jump back to the bottom follows a page that landed below them", async () => {
    replies["cursor=tsk_c50&order=newest"] = { tasks: [task("b")], next_cursor: "tsk_c100" };
    replies["cursor=tsk_c100&order=newest"] = { tasks: [task("c")], next_cursor: "tsk_c150" };
    show();
    scrollTo(500);
    // The new rows push the bottom away before the page finishes showing.
    bottomTop = 3000;
    expect(await screen.findByRole("link", { name: "Title b" })).toBeInTheDocument();
    await settled();
    // One jump, such as the End key, lands exactly where the last scroll did.
    scrollTo(500);
    expect(await screen.findByRole("link", { name: "Title c" })).toBeInTheDocument();
    expect(reads).toEqual(["cursor=tsk_c50&order=newest", "cursor=tsk_c100&order=newest"]);
  });

  it("doesn't read when they scroll up, or while still far from the bottom", async () => {
    replies["cursor=tsk_c50&order=newest"] = { tasks: [task("b")], next_cursor: "tsk_c100" };
    show();
    scrollTo(4000);
    await settled();
    expect(reads).toEqual([]);
    scrollTo(500);
    await screen.findByRole("link", { name: "Title b" });
    scrollTo(700);
    await settled();
    expect(reads).toEqual(["cursor=tsk_c50&order=newest"]);
  });

  it("doesn't read behind an open Sheet", async () => {
    setUrl("/w/ws_1/tasks?task=a");
    show();
    scrollTo(500);
    await settled();
    expect(reads.filter((query) => query.startsWith("cursor="))).toEqual([]);
  });

  it("stops after a failure, so the next read is the person's", async () => {
    show();
    scrollTo(500);
    expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't load more tasks");
    scrollTo(400);
    await settled();
    expect(reads).toEqual(["cursor=tsk_c50&order=newest"]);
  });
});

describe("focus when the list ends", () => {
  it("moves from the button when a scroll ended the list while it held focus", async () => {
    replies["cursor=tsk_c50&order=newest"] = { tasks: [task("b")], next_cursor: null };
    show();
    button().focus();
    scrollTo(500);
    const done = await screen.findByText(/End of the list/);
    expect(done).toHaveFocus();
  });

  it("stays on a row when the list ends, even after the button has been pressed", async () => {
    const user = userEvent.setup();
    replies["cursor=tsk_c50&order=newest"] = { tasks: [task("b")], next_cursor: "tsk_c100" };
    replies["cursor=tsk_c100&order=newest"] = { tasks: [task("c")], next_cursor: null };
    show();
    await user.click(button());
    await screen.findByRole("link", { name: "Title b" });
    row("Title a").focus();
    scrollTo(500);
    await screen.findByText(/End of the list/);
    expect(row("Title a")).toHaveFocus();
  });

  it("goes to the page when a read removes the focused button and nothing replaces it", () => {
    const main = document.createElement("main");
    main.id = "main-content";
    main.tabIndex = -1;
    document.body.appendChild(main);
    const { rerender } = show([task("a")], "tsk_c50");
    button().focus();
    rerender(screenWith([task("a")], null));
    expect(main).toHaveFocus();
    main.remove();
  });

  it("follows a task to its new group, instead of falling to the page", () => {
    const { rerender } = show([task("a"), task("b")], null);
    row("Title b").focus();
    rerender(screenWith([task("a"), task("b", { status: "completed", version: 2 })], null));
    expect(row("Title b")).toHaveFocus();
  });

  it("leaves focus alone when it's somewhere else", () => {
    const { rerender } = show([task("a")], null);
    const filter = screen.getByRole("checkbox", { name: "Needs my review" });
    filter.focus();
    rerender(screenWith([task("a", { status: "completed", version: 2 })], null));
    expect(filter).toHaveFocus();
  });
});

describe("failures", () => {
  it("keeps what's loaded through an outage or a rate limit, and can try again", async () => {
    const user = userEvent.setup();
    replies["cursor=tsk_c50&order=newest"] = { status: 429 };
    show();
    await user.click(button());
    expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't load more tasks");
    expect(row("Title a")).toBeInTheDocument();
    replies["cursor=tsk_c50&order=newest"] = { tasks: [task("b")], next_cursor: null };
    await user.click(button());
    expect(await screen.findByRole("link", { name: "Title b" })).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("signs in again on a 401, keeping nothing new", async () => {
    const user = userEvent.setup();
    replies["cursor=tsk_c50&order=newest"] = { status: 401 };
    show();
    await user.click(button());
    await waitFor(() => expect(signIn).toHaveBeenCalled());
  });

  it("calls a bad request a failed read, not lost access", async () => {
    const user = userEvent.setup();
    replies["cursor=tsk_c50&order=newest"] = { status: 400 };
    show();
    await user.click(button());
    expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't load more tasks");
    expect(row("Title a")).toBeInTheDocument();
  });

  it.each([403, 404])("takes everything off the screen on a %i, and Try again's good read brings the list back", async (status) => {
    const user = userEvent.setup();
    replies["cursor=tsk_c50&order=newest"] = { status };
    const { rerender } = show();
    await user.click(button());
    await waitFor(() => expect(screen.queryByRole("link", { name: "Title a" })).not.toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
    rerender(screenWith([task("a")], "tsk_c50"));
    expect(await screen.findByRole("link", { name: "Title a" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Try again" })).not.toBeInTheDocument();
  });

  it("drops the read when the person leaves", async () => {
    const user = userEvent.setup();
    replies["cursor=tsk_c50&order=newest"] = () => new Promise(() => undefined);
    const { unmount } = show();
    await user.click(button());
    await waitFor(() => expect(signals).toHaveLength(1));
    unmount();
    expect(signals[0].aborted).toBe(true);
  });
});

describe("when the viewer's view of the room narrows", () => {
  const loaded = async () => {
    const user = userEvent.setup();
    replies["cursor=tsk_c50&order=newest"] = { tasks: [task("later")], next_cursor: null };
    const view = show([task("a"), task("b")], "tsk_c50");
    await user.click(button());
    await screen.findByRole("link", { name: "Title later" });
    return view;
  };

  it("drops later pages when the first page stops being the same one", async () => {
    const { rerender } = await loaded();
    rerender(screenWith([task("b")], "tsk_c50"));
    expect(screen.queryByRole("link", { name: "Title later" })).not.toBeInTheDocument();
    expect(button()).toBeInTheDocument();
  });

  it("drops later pages when the viewer's role changes, though the first page looks the same", async () => {
    const { rerender } = await loaded();
    rerender(screenWith([task("a"), task("b")], "tsk_c50", "guest"));
    expect(screen.queryByRole("link", { name: "Title later" })).not.toBeInTheDocument();
  });

  it("keeps them when new tasks join the first page or a task on it changes", async () => {
    const { rerender } = await loaded();
    rerender(screenWith([task("c"), task("a", { status: "completed", version: 2 }), task("b")], "tsk_c50"));
    expect(row("Title later")).toBeInTheDocument();
    expect(row("Title c")).toBeInTheDocument();
  });

  it("keeps a row a new task pushed off the first page, which no later page would have", async () => {
    const { rerender } = await loaded();
    rerender(screenWith([task("c"), task("a")], "tsk_c50"));
    expect(row("Title c")).toBeInTheDocument();
    expect(row("Title a")).toBeInTheDocument();
    expect(row("Title b")).toBeInTheDocument();
    expect(row("Title later")).toBeInTheDocument();
    // Pushed off again, and still in reading order.
    rerender(screenWith([task("d"), task("c")], "tsk_c50"));
    const links = screen.getAllByRole("link", { name: /^Title / }).map((link) => link.textContent);
    expect(links).toEqual(["Title d", "Title c", "Title a", "Title b", "Title later"]);
  });

  it("starts over rather than holding pushed-off rows without limit, and until then loses none", () => {
    const page = (newest: number) => [task(`t${newest}`), task(`t${newest - 1}`)];
    let seen: FirstPageHistory = { rows: page(1), role: "member", generation: 0, pushedOff: [] };
    for (let newest = 2; seen.generation === 0; newest += 1) {
      const next = advanceFirstPage(seen, page(newest), "member");
      if (next.generation === 0) {
        // Everything ever shown is on the page or held: t0 up to the newest.
        expect(next.pushedOff).toHaveLength(newest - 1);
        expect(next.pushedOff.at(-1)?.id).toBe("t0");
      }
      seen = next;
    }
    expect(seen.generation).toBe(1);
    expect(seen.pushedOff).toEqual([]);
    expect(seen.rows.map((row) => row.id)).toEqual(page(MAX_PUSHED_OFF + 2).map((row) => row.id));
  });

  it("starts over when more tasks arrive between reads than a first page holds, which is safe if abrupt", () => {
    const seen: FirstPageHistory = { rows: [task("a"), task("b")], role: "member", generation: 0, pushedOff: [] };
    expect(advanceFirstPage(seen, [task("x"), task("y")], "member")).toMatchObject({ generation: 1, pushedOff: [] });
  });

  it("drops later pages when a first page of the same size has different rows", async () => {
    const { rerender } = await loaded();
    rerender(screenWith([task("x"), task("y")], "tsk_c50"));
    expect(screen.queryByRole("link", { name: "Title later" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Title a" })).not.toBeInTheDocument();
  });
});

describe("Needs my review in a room past one page", () => {
  const mine = task("mine", { status: "submitted", reviewer: "per_me" });
  const theirs = task("theirs", { status: "submitted", reviewer: "per_o", requester: "per_me" });
  const QUERY = "cursor=&status=submitted&mine=true&order=newest";

  it("asks the server, and shows only reviews that are the viewer's", async () => {
    setUrl("/w/ws_1/tasks?review=mine");
    replies[QUERY] = { tasks: [mine, theirs], next_cursor: null };
    show();
    expect(await screen.findByRole("link", { name: "Title mine" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Title theirs" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Title a" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Load more" })).not.toBeInTheDocument();
    expect(screen.getByText(/1 task waiting for your review\./)).toBeInTheDocument();
    expect(reads).toEqual([QUERY]);
  });

  it("costs no read in a room that fits on a page", async () => {
    setUrl("/w/ws_1/tasks?review=mine");
    show([task("a"), mine], null);
    expect(row("Title mine")).toBeInTheDocument();
    await settled();
    expect(reads).toEqual([]);
  });

  it("asks again when the page reads again, so a new review shows and an old answer doesn't stay", async () => {
    setUrl("/w/ws_1/tasks?review=mine");
    replies[QUERY] = { tasks: [], next_cursor: null };
    const { rerender } = show();
    expect(await screen.findByText(/No submissions are waiting/)).toBeInTheDocument();
    replies[QUERY] = { tasks: [mine], next_cursor: null };
    rerender(screenWith([task("a")], "tsk_c50"));
    expect(await screen.findByRole("link", { name: "Title mine" })).toBeInTheDocument();
    expect(reads).toEqual([QUERY, QUERY]);
  });

  it("keeps a later page through a re-read, so a row someone opened from it isn't lost", async () => {
    const user = userEvent.setup();
    setUrl("/w/ws_1/tasks?review=mine");
    const second = task("second", { status: "submitted", reviewer: "per_me" });
    replies[QUERY] = { tasks: [mine], next_cursor: "tsk_c7" };
    replies["cursor=tsk_c7&status=submitted&mine=true&order=newest"] = { tasks: [second], next_cursor: null };
    const { rerender } = show();
    await screen.findByRole("link", { name: "Title mine" });
    await user.click(button());
    const row2 = await screen.findByRole("link", { name: "Title second" });
    row2.focus();
    rerender(screenWith([task("a")], "tsk_c50"));
    await waitFor(() => expect(reads.filter((query) => query === QUERY)).toHaveLength(2));
    await settled();
    expect(row("Title second")).toHaveFocus();
    // It had reached the end, and still has, so nothing offers to read that page again.
    expect(screen.queryByRole("button", { name: "Load more" })).not.toBeInTheDocument();
  });

  it("never loses a row when a task joins the list and the first page ends sooner", async () => {
    const user = userEvent.setup();
    setUrl("/w/ws_1/tasks?review=mine");
    const newer = task("newer", { status: "submitted", reviewer: "per_me" });
    const between = task("between", { status: "submitted", reviewer: "per_me" });
    const later = task("later", { status: "submitted", reviewer: "per_me" });
    replies[QUERY] = { tasks: [mine, between], next_cursor: "tsk_c7" };
    replies["cursor=tsk_c7&status=submitted&mine=true&order=newest"] = { tasks: [later], next_cursor: null };
    const { rerender } = show();
    await screen.findByRole("link", { name: "Title between" });
    await user.click(button());
    await screen.findByRole("link", { name: "Title later" });
    // A page holds the same number of rows, so the new one pushes "between" off the end of the first page.
    replies[QUERY] = { tasks: [newer, mine], next_cursor: "tsk_c8" };
    replies["cursor=tsk_c8&status=submitted&mine=true&order=newest"] = { tasks: [between, later], next_cursor: null };
    rerender(screenWith([task("a")], "tsk_c50"));
    await screen.findByRole("link", { name: "Title newer" });
    // The way back to it is the cursor the new first page gave, not a gap nothing would fetch.
    await user.click(button());
    expect(await screen.findByRole("link", { name: "Title between" })).toBeInTheDocument();
    expect(reads.at(-1)).toBe("cursor=tsk_c8&status=submitted&mine=true&order=newest");
    expect(screen.getByRole("link", { name: "Title later" })).toBeInTheDocument();
  });

  it("keeps later pages when the first page reaches past where they start, without listing a row twice", async () => {
    const user = userEvent.setup();
    setUrl("/w/ws_1/tasks?review=mine");
    const second = task("second", { status: "submitted", reviewer: "per_me" });
    replies[QUERY] = { tasks: [mine], next_cursor: "tsk_c7" };
    replies["cursor=tsk_c7&status=submitted&mine=true&order=newest"] = { tasks: [second], next_cursor: "tsk_c3" };
    const { rerender } = show();
    await screen.findByRole("link", { name: "Title mine" });
    await user.click(button());
    await screen.findByRole("link", { name: "Title second" });
    // "mine" left the list, so the first page now runs further down.
    replies[QUERY] = { tasks: [second], next_cursor: "tsk_c6" };
    rerender(screenWith([task("a")], "tsk_c50"));
    await waitFor(() => expect(reads.filter((query) => query === QUERY)).toHaveLength(2));
    await settled();
    expect(screen.getAllByRole("link", { name: "Title second" })).toHaveLength(1);
    expect(button()).toBeInTheDocument();
    replies["cursor=tsk_c3&status=submitted&mine=true&order=newest"] = { tasks: [], next_cursor: null };
    await user.click(button());
    await waitFor(() => expect(reads.at(-1)).toBe("cursor=tsk_c3&status=submitted&mine=true&order=newest"));
  });

  it("finds a new review after the list has reached its end", async () => {
    const user = userEvent.setup();
    setUrl("/w/ws_1/tasks?review=mine");
    const second = task("second", { status: "submitted", reviewer: "per_me" });
    replies[QUERY] = { tasks: [mine], next_cursor: "tsk_c7" };
    replies["cursor=tsk_c7&status=submitted&mine=true&order=newest"] = { tasks: [second], next_cursor: null };
    const { rerender } = show();
    await screen.findByRole("link", { name: "Title mine" });
    await user.click(button());
    await screen.findByText(/End of the list/);
    replies[QUERY] = { tasks: [task("arrived", { status: "submitted", reviewer: "per_me" })], next_cursor: "tsk_c8" };
    rerender(screenWith([task("a")], "tsk_c50"));
    expect(await screen.findByRole("link", { name: "Title arrived" })).toBeInTheDocument();
  });

  it("drops later pages when the first page now ends the list", async () => {
    const user = userEvent.setup();
    setUrl("/w/ws_1/tasks?review=mine");
    const second = task("second", { status: "submitted", reviewer: "per_me" });
    replies[QUERY] = { tasks: [mine], next_cursor: "tsk_c7" };
    replies["cursor=tsk_c7&status=submitted&mine=true&order=newest"] = { tasks: [second], next_cursor: "tsk_c9" };
    const { rerender } = show();
    await screen.findByRole("link", { name: "Title mine" });
    await user.click(button());
    await screen.findByRole("link", { name: "Title second" });
    replies[QUERY] = { tasks: [mine], next_cursor: null };
    rerender(screenWith([task("a")], "tsk_c50"));
    await waitFor(() => expect(screen.queryByRole("link", { name: "Title second" })).not.toBeInTheDocument());
  });

  it("asks again each time the filter is turned on, and the room's own pages carry on between", async () => {
    const user = userEvent.setup();
    setUrl("/w/ws_1/tasks?review=mine");
    replies[QUERY] = { tasks: [mine], next_cursor: null };
    replies["cursor=tsk_c50&order=newest"] = { tasks: [task("b")], next_cursor: null };
    show();
    await screen.findByRole("link", { name: "Title mine" });
    const filter = screen.getByRole("checkbox", { name: "Needs my review" });
    await user.click(filter);
    await user.click(button());
    expect(await screen.findByRole("link", { name: "Title b" })).toBeInTheDocument();
    await user.click(filter);
    await waitFor(() => expect(reads).toEqual([QUERY, "cursor=tsk_c50&order=newest", QUERY]));
  });

  it("never says more shown than loaded", async () => {
    setUrl("/w/ws_1/tasks?review=mine");
    replies[QUERY] = { tasks: [mine, task("mine2", { status: "submitted", reviewer: "per_me" })], next_cursor: null };
    show();
    await screen.findByRole("link", { name: "Title mine2" });
    expect(screen.getByText(/List view, showing 2 waiting for your review\./)).toHaveAttribute("aria-live", "polite");
  });
});

describe("announcing", () => {
  it("says a page arrived, once, and a later read of the first page doesn't say it again", async () => {
    const user = userEvent.setup();
    replies["cursor=tsk_c50&order=newest"] = { tasks: [task("b"), task("c")], next_cursor: "tsk_c100" };
    const { rerender } = show();
    await user.click(button());
    const live = await screen.findByText(/2 more tasks loaded/);
    expect(live).toHaveAttribute("aria-live", "polite");
    expect(live).toHaveTextContent("List view, showing 3 of 3 loaded tasks.");
    rerender(screenWith([task("a")], "tsk_c50"));
    await waitFor(() => expect(live).not.toHaveTextContent("more tasks loaded"));
  });

  it("gets one right, and stops saying it after a view change", async () => {
    const user = userEvent.setup();
    replies["cursor=tsk_c50&order=newest"] = { tasks: [task("b")], next_cursor: "tsk_c100" };
    show();
    await user.click(button());
    const live = await screen.findByText(/1 more task loaded/);
    await user.click(screen.getByRole("link", { name: "Board" }));
    await waitFor(() => expect(live).not.toHaveTextContent("more task loaded"));
    expect(live).toHaveTextContent("Board view, showing 2 of 2 loaded tasks.");
  });
});

describe("keeping the reader's place", () => {
  const placed = (top: number) => {
    const el = document.createElement("a");
    el.setAttribute("data-sheet-launcher", "task:x");
    document.body.appendChild(el);
    el.getBoundingClientRect = () => ({ top, bottom: top + 20 }) as DOMRect;
    return el;
  };

  it("scrolls by however far rows above moved what the reader was looking at", () => {
    const scrollBy = vi.spyOn(window, "scrollBy").mockImplementation(() => undefined);
    const el = placed(100);
    const restore = rememberPlace();
    el.getBoundingClientRect = () => ({ top: 700, bottom: 720 }) as DOMRect;
    restore?.();
    expect(scrollBy).toHaveBeenCalledWith(0, 600);
    el.remove();
  });

  it("leaves it alone when a browser has already held it still", () => {
    const scrollBy = vi.spyOn(window, "scrollBy").mockImplementation(() => undefined);
    const el = placed(100);
    rememberPlace()?.();
    expect(scrollBy).not.toHaveBeenCalled();
    el.remove();
  });
});

describe("a task past the first page", () => {
  const detail = (over: Partial<Task>) => ({ task: task("b", over), submissions: [{ submission_no: 1, task_version: 2, note: "N", commit_sha: null, from: { id: "agt_a", org: "org_b" }, external: true, created_at: 1 }], artifacts: [], messages: [], history: [], visible: { submissions: "all", conversation: "all" } });

  it("shows what the Sheet just read, because later pages aren't read again", async () => {
    const user = userEvent.setup();
    replies["cursor=tsk_c50&order=newest"] = { tasks: [task("b")], next_cursor: null };
    show();
    await user.click(button());
    await screen.findByRole("link", { name: "Title b" });
    expect(screen.getByRole("heading", { name: /^Open/ })).toBeInTheDocument();
    vi.stubGlobal("fetch", async (url: string) => new Response(JSON.stringify(detail({ status: "completed", version: 5 })), { status: url.includes("/tasks/b") ? 200 : 503 }));
    await user.click(row("Title b"));
    await waitFor(() => expect(screen.getByRole("heading", { name: /^Completed/, hidden: true })).toBeInTheDocument());
  });

  it("takes a command's own answer, so closing before the read after it can't leave the old status", async () => {
    const user = userEvent.setup();
    replies["cursor=tsk_c50&order=newest"] = { tasks: [task("b", { status: "submitted", reviewer: "per_me", submission_no: 1 })], next_cursor: null };
    show();
    await user.click(button());
    await screen.findByRole("link", { name: "Title b" });
    const under = detail({ status: "submitted", reviewer: "per_me", submission_no: 1, version: 3 });
    let reads = 0;
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      if (init?.method === "POST") return new Response(JSON.stringify(task("b", { status: "completed", reviewer: "per_me", submission_no: 1, version: 4 })), { status: 200 });
      // The read after the command never comes back, as when the Sheet closes and aborts it.
      if (url.includes("/tasks/b") && reads++ > 0) return new Promise<Response>(() => undefined);
      return new Response(JSON.stringify(under), { status: 200 });
    });
    await user.click(row("Title b"));
    await user.click(await screen.findByRole("button", { name: /Approve submission 1/, hidden: true }));
    await waitFor(() => expect(screen.getByRole("heading", { name: /^Completed/, hidden: true })).toBeInTheDocument());
  });
});

describe("progress and Blocked from the plan", () => {
  const summary = (over: object = {}) => ({ whole: true, countsEvery: true, edgesEvery: true, all: { completed: 3, active: 8 }, review: { completed: 0, active: 2 }, blocked: {}, ...over });
  const withPlan = (plan: unknown, tasks = [task("a"), task("b")], cursor: string | null = "tsk_c50") => <TasksScreen room={room()} tasks={tasks} cursor={cursor} me="per_me" names={{}} plan={plan as never} />;

  it("gives the whole room's count past the loaded pages, with a bar, and doesn't jump as pages load", async () => {
    const user = userEvent.setup();
    replies["cursor=tsk_c50&order=newest"] = { tasks: [task("c")], next_cursor: null };
    render(withPlan(summary()));
    expect(screen.getByRole("progressbar", { name: "Progress" })).toHaveAttribute("aria-valuenow", "38");
    expect(screen.getByText("3 of 8 completed · 38%")).toBeInTheDocument();
    expect(screen.queryByText(/partial/)).toBeNull();
    await user.click(button());
    await screen.findByRole("link", { name: "Title c" });
    expect(screen.getByText("3 of 8 completed · 38%")).toBeInTheDocument();
  });

  it("stays partial when the plan read failed or stopped short, and says Blocked couldn't be checked", () => {
    const first = render(withPlan(null));
    expect(screen.getByText(/Loaded tasks only · partial/)).toBeInTheDocument();
    expect(screen.queryByRole("progressbar")).toBeNull();
    expect(screen.getByText("Couldn't check which tasks are blocked.")).toBeInTheDocument();
    first.unmount();
    render(withPlan(summary({ countsEvery: false, edgesEvery: false })));
    expect(screen.getByText(/Loaded tasks only · partial/)).toBeInTheDocument();
    expect(screen.getByText("Blocked covers only the tasks this read reached.")).toBeInTheDocument();
  });

  it("counts what's on screen for a room that fits on a page, which already has the person's own changes", () => {
    render(withPlan(summary(), [task("a", { status: "completed" }), task("b")], null));
    expect(screen.getByText("1 of 2 completed · 50%")).toBeInTheDocument();
  });

  it("labels a member narrowed to their own tasks by what the server said, not their role", () => {
    render(withPlan(summary({ whole: false, edgesEvery: false })));
    expect(screen.getByRole("progressbar", { name: "Progress for tasks you can see" })).toBeInTheDocument();
  });

  it("counts Needs my review apart from the room", () => {
    setUrl("/w/ws_1/tasks?review=mine");
    replies["cursor=&status=submitted&mine=true&order=newest"] = { tasks: [], next_cursor: null };
    render(withPlan(summary()));
    expect(screen.getByRole("progressbar", { name: "Progress for filtered tasks" })).toHaveAttribute("aria-valuetext", "0 of 2 completed, 0%");
  });

  it("shows Blocked in the list and on the board as a note, keeping the task's own state and adding no column", () => {
    const blocked = { b: "Blocked: waiting on “Title a”" };
    const first = render(withPlan(summary({ blocked })));
    expect(screen.getByText("Blocked: waiting on “Title a”")).toBeInTheDocument();
    first.unmount();
    setUrl("/w/ws_1/tasks?view=board");
    render(withPlan(summary({ blocked })));
    expect(screen.getByText("Blocked: waiting on “Title a”")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: /^Blocked/ })).toBeNull();
    expect(screen.getAllByRole("heading", { level: 2 })).toHaveLength(5);
  });

  it("finds Blocked for a row from a later page, or one pushed off the first page, by its ID wherever it sits", async () => {
    const user = userEvent.setup();
    const blocked = { later: "Blocked: waiting on “Title a”", b: "Blocked: waiting on “Title later”" };
    replies["cursor=tsk_c50&order=newest"] = { tasks: [task("later")], next_cursor: null };
    const { rerender } = render(withPlan(summary({ blocked })));
    await user.click(button());
    await screen.findByRole("link", { name: "Title later" });
    // A new task pushes "b" off the first page.
    rerender(withPlan(summary({ blocked }), [task("new"), task("a")]));
    expect(screen.getAllByRole("link", { name: /^Title / }).map((link) => link.textContent)).toEqual(["Title new", "Title a", "Title b", "Title later"]);
    expect(screen.getByText("Blocked: waiting on “Title a”")).toBeInTheDocument();
    expect(screen.getByText("Blocked: waiting on “Title later”")).toBeInTheDocument();
    expect(screen.getByText("3 of 8 completed · 38%")).toBeInTheDocument();
  });

  it("drops Blocked from a task that has since finished", () => {
    render(withPlan(summary({ blocked: { a: "Blocked: waiting on “Other”" } }), [task("a", { status: "completed" }), task("b")]));
    expect(screen.queryByText(/Blocked: waiting/)).toBeNull();
  });
});
