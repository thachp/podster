import { act, createEvent, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Button } from "@/components/ui/button";
import type { GatewayResult } from "@/lib/gateway/result";
import { back, currentUrl, dropHeldNavigation, navigate, routerCalls, setHoldNavigation, settleNavigation, setUrl } from "@/test/next-navigation";
import { SheetLink, TargetSheet, type SheetBinding } from "./target-sheet";

type Item = { id: string; title: string; version: number };

const ITEMS: Record<string, Item> = {
  a: { id: "a", title: "Agent A", version: 3 },
  b: { id: "b", title: "Agent B", version: 7 },
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const resolved = (id: string) => Promise.resolve(ITEMS[id] ?? null);

function Editor({ data, setDirty }: { data: Item; setDirty: (dirty: boolean) => void }) {
  const [value, setValue] = useState("");
  return (
    <label>
      Notes for {data.id}
      <input
        value={value}
        onChange={(event) => {
          setValue(event.target.value);
          setDirty(true);
        }}
      />
    </label>
  );
}

function Screen({
  load = resolved,
  command = async () => ({ ok: true, data: {} }),
}: {
  load?: (id: string, init: { signal: AbortSignal }) => Promise<Item | null>;
  command?: (binding: SheetBinding) => Promise<GatewayResult<unknown>>;
}) {
  return (
    <>
      <main id="main-content" tabIndex={-1}>
        <SheetLink param="agent" target="a">
          Open A
        </SheetLink>
        <SheetLink param="agent" target="b">
          Open B
        </SheetLink>
      </main>
      <TargetSheet<Item> param="agent" noun="agent" load={load} title={(item) => item.title} description={() => "Workroom: Developer Platform"} version={(item) => item.version}>
        {({ data, setDirty, run, saving, close }) => (
          <>
            <Editor key={data.id} data={data} setDirty={setDirty} />
            <Button disabled={saving} onClick={() => void run(command)}>
              Save changes
            </Button>
            <Button
              disabled={saving}
              onClick={async () => {
                const result = await run(command);
                if (result?.ok) close();
              }}
            >
              Save and close
            </Button>
          </>
        )}
      </TargetSheet>
    </>
  );
}

const title = (name: string) => screen.findByRole("heading", { name });

describe("TargetSheet", () => {
  beforeEach(() => setUrl("/agents"));

  describe("URL state", () => {
    it("stays closed without a target", () => {
      render(<Screen />);
      expect(screen.queryByRole("dialog")).toBeNull();
    });

    it("opens from a deep link, as on reload (UI-05)", async () => {
      setUrl("/agents?agent=a&view=all");
      render(<Screen />);
      expect(await title("Agent A")).toBeInTheDocument();
      expect(screen.getByText("Workroom: Developer Platform")).toBeInTheDocument();
    });

    it("opens from a link that keeps other parameters, and Back closes it", async () => {
      setUrl("/agents?view=all");
      render(<Screen />);
      await userEvent.click(screen.getByRole("link", { name: "Open A" }));
      expect(currentUrl()).toBe("/agents?view=all&agent=a");
      await title("Agent A");
      act(() => back());
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    });

    it("opens and closes by moving the URL alone, so the page behind isn't rendered again and its reads aren't spent", async () => {
      setUrl("/agents?view=all");
      render(<Screen />);
      await userEvent.click(screen.getByRole("link", { name: "Open A" }));
      await title("Agent A");
      await userEvent.keyboard("{Escape}");
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      await userEvent.click(screen.getByRole("link", { name: "Open B" }));
      await title("Agent B");
      act(() => back());
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      expect(currentUrl()).toBe("/agents?view=all");
      expect(routerCalls.push).toBe(0);
      expect(routerCalls.refresh).toBe(0);
    });

    it("leaves a press for a new tab to the browser", () => {
      render(<Screen />);
      const event = createEvent.click(screen.getByRole("link", { name: "Open A" }), { metaKey: true });
      fireEvent(screen.getByRole("link", { name: "Open A" }), event);
      expect(event.defaultPrevented).toBe(false);
      expect(currentUrl()).toBe("/agents");
      expect(screen.getByRole("link", { name: "Open A" })).toHaveAttribute("href", "/agents?agent=a");
    });

    it("still refreshes the list once when a command is followed at once by closing, whose URL move discards a pending refresh", async () => {
      setUrl("/agents?agent=a");
      render(<Screen />);
      await title("Agent A");
      await userEvent.click(screen.getByRole("button", { name: "Save and close" }));
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      expect(currentUrl()).toBe("/agents");
      await act(async () => new Promise((resolve) => setTimeout(resolve, 50)));
      expect(routerCalls.refreshed).toBe(1);
    });

    it("still refreshes the list once when a command ends access and the Sheet closes as gone", async () => {
      setUrl("/agents?agent=a");
      let allowed = true;
      render(<Screen load={async (id) => (allowed ? ITEMS[id] : null)} command={async () => ((allowed = false), { ok: true, data: {} })} />);
      await title("Agent A");
      await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
      expect(await screen.findByRole("alert")).toHaveTextContent("We can't find that");
      await act(async () => new Promise((resolve) => setTimeout(resolve, 50)));
      expect(routerCalls.refreshed).toBe(1);
    });

    it("doesn't refresh the list on a close with no command", async () => {
      setUrl("/agents?agent=a");
      render(<Screen />);
      await title("Agent A");
      await userEvent.keyboard("{Escape}");
      await act(async () => new Promise((resolve) => setTimeout(resolve, 50)));
      expect(routerCalls.refresh).toBe(0);
    });

    it("closing clears only its own parameter", async () => {
      setUrl("/agents?view=all&agent=a");
      render(<Screen />);
      await title("Agent A");
      await userEvent.keyboard("{Escape}");
      expect(currentUrl()).toBe("/agents?view=all");
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    });

    it("shows one message for a missing or hidden target, and leaks no title (UI-05)", async () => {
      setUrl("/agents?agent=hidden");
      render(<Screen load={async () => null} />);
      const notice = await screen.findByRole("alert");
      expect(notice).toHaveTextContent("We can't find that. It may not exist, or you may not have access to it.");
      expect(notice).not.toHaveTextContent("hidden");
      expect(currentUrl()).toBe("/agents");
      expect(screen.queryByRole("dialog")).toBeNull();
    });

    it("doesn't reopen or refetch while the URL catches up after not-found (UI-05)", async () => {
      setUrl("/agents?agent=hidden");
      setHoldNavigation(true);
      const load = vi.fn(async () => null);
      render(<Screen load={load} />);
      expect(await screen.findByRole("alert")).toHaveTextContent("We can't find that.");
      await act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
      expect(load).toHaveBeenCalledTimes(1);
      expect(screen.getByRole("alert")).toHaveTextContent("We can't find that.");
      expect(currentUrl()).toBe("/agents?agent=hidden");
      await act(async () => settleNavigation());
      expect(currentUrl()).toBe("/agents");
      expect(load).toHaveBeenCalledTimes(1);
      expect(screen.getByRole("alert")).toHaveTextContent("We can't find that.");
    });

    describe("while closing is still reaching the URL", () => {
      const closeSlowly = async () => {
        render(<Screen />);
        await userEvent.click(screen.getByRole("link", { name: "Open B" }));
        await title("Agent B");
        setHoldNavigation(true);
        await userEvent.keyboard("{Escape}");
        await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
        expect(currentUrl()).toBe("/agents?agent=b");
      };

      it("opens again when the same target's link is pressed, and pressing it isn't lost", async () => {
        await closeSlowly();
        await userEvent.click(screen.getByRole("link", { name: "Open B" }));
        act(() => dropHeldNavigation());
        expect(await title("Agent B")).toHaveFocus();
        expect(currentUrl()).toBe("/agents?agent=b");
      });

      it("shows what's there now when it opens again, not a discarded draft", async () => {
        render(<Screen />);
        await userEvent.click(screen.getByRole("link", { name: "Open B" }));
        await title("Agent B");
        await userEvent.type(screen.getByRole("textbox"), "typed");
        setHoldNavigation(true);
        await userEvent.keyboard("{Escape}");
        await userEvent.click(await screen.findByRole("button", { name: /Discard/ }));
        await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
        await userEvent.click(screen.getByRole("link", { name: "Open B" }));
        act(() => dropHeldNavigation());
        await title("Agent B");
        expect(screen.getByRole("textbox")).toHaveValue("");
      });

      it("doesn't open for a press that goes to a new tab", async () => {
        await closeSlowly();
        fireEvent.click(screen.getByRole("link", { name: "Open B" }), { metaKey: true });
        await act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
        expect(screen.queryByRole("dialog")).toBeNull();
      });

      it("still closes when another link, carrying the old URL, replaces the closing", async () => {
        await closeSlowly();
        act(() => {
          navigate("/agents?agent=b&view=board");
          dropHeldNavigation();
        });
        await waitFor(() => expect(currentUrl()).toBe("/agents?view=board"));
        expect(screen.queryByRole("dialog")).toBeNull();
      });

      it("looks again when a target found gone is pressed before the URL has caught up", async () => {
        setUrl("/agents?agent=hidden");
        setHoldNavigation(true);
        const load = vi.fn(async () => null);
        const Hidden = () => (
          <>
            <SheetLink param="agent" target="hidden">Open hidden</SheetLink>
            <Screen load={load} />
          </>
        );
        render(<Hidden />);
        expect(await screen.findByRole("alert")).toBeInTheDocument();
        await userEvent.click(screen.getByRole("link", { name: "Open hidden" }));
        act(() => dropHeldNavigation());
        await waitFor(() => expect(load).toHaveBeenCalledTimes(2));
      });

      it("can open again after the close has landed", async () => {
        await closeSlowly();
        await act(async () => settleNavigation());
        expect(currentUrl()).toBe("/agents");
        setHoldNavigation(false);
        await userEvent.click(screen.getByRole("link", { name: "Open B" }));
        expect(await title("Agent B")).toHaveFocus();
      });
    });

    it("can open the same target again after not-found", async () => {
      setUrl("/agents?agent=a");
      const load = vi.fn<(id: string) => Promise<Item | null>>().mockResolvedValueOnce(null).mockResolvedValue(ITEMS.a);
      render(<Screen load={load} />);
      await screen.findByRole("alert");
      await act(async () => back());
      await waitFor(() => expect(currentUrl()).toBe("/agents?agent=a"));
      expect(await title("Agent A")).toBeInTheDocument();
    });

    it("closes the same way when access ends while it's open", async () => {
      setUrl("/agents?agent=a");
      let allowed = true;
      render(<Screen load={async (id) => (allowed ? ITEMS[id] : null)} command={async () => ((allowed = false), { ok: true, data: {} })} />);
      await title("Agent A");
      await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
      expect(await screen.findByRole("alert")).toHaveTextContent("We can't find that");
      expect(screen.queryByText("Agent A")).toBeNull();
    });
  });

  describe("focus", () => {
    it("moves to the title on open", async () => {
      setUrl("/agents?agent=a");
      render(<Screen />);
      expect(await title("Agent A")).toHaveFocus();
    });

    it("stays inside while open", async () => {
      setUrl("/agents?agent=a");
      render(<Screen />);
      const dialog = await screen.findByRole("dialog");
      await title("Agent A");
      for (let i = 0; i < 6; i += 1) {
        await userEvent.tab();
        expect(dialog).toContainElement(document.activeElement as HTMLElement);
      }
    });

    it("returns to the one pressed when two controls open the same target", async () => {
      const Twice = () => (
        <>
          <SheetLink param="agent" target="b">First way</SheetLink>
          <SheetLink param="agent" target="b">Second way</SheetLink>
          <Screen />
        </>
      );
      render(<Twice />);
      await userEvent.click(screen.getByRole("link", { name: "Second way" }));
      await title("Agent B");
      await userEvent.keyboard("{Escape}");
      await waitFor(() => expect(screen.getByRole("link", { name: "Second way" })).toHaveFocus());
    });

    it("returns to the launching control on Escape", async () => {
      render(<Screen />);
      await userEvent.click(screen.getByRole("link", { name: "Open B" }));
      await title("Agent B");
      await userEvent.keyboard("{Escape}");
      await waitFor(() => expect(screen.getByRole("link", { name: "Open B" })).toHaveFocus());
    });

    it("returns to the launching control from the close button", async () => {
      render(<Screen />);
      await userEvent.click(screen.getByRole("link", { name: "Open A" }));
      await title("Agent A");
      await userEvent.click(screen.getByRole("button", { name: "Close" }));
      await waitFor(() => expect(screen.getByRole("link", { name: "Open A" })).toHaveFocus());
    });

    it("after a reload, still finds the row that opens it", async () => {
      setUrl("/agents?agent=b");
      render(<Screen />);
      await title("Agent B");
      await userEvent.keyboard("{Escape}");
      await waitFor(() => expect(screen.getByRole("link", { name: "Open B" })).toHaveFocus());
    });

    it("falls back to the main content when the launcher has gone", async () => {
      setUrl("/agents?agent=a");
      render(
        <>
          <main id="main-content" tabIndex={-1} />
          <TargetSheet<Item> param="agent" load={resolved} title={(item) => item.title} description={() => "Room"}>
            {() => null}
          </TargetSheet>
        </>,
      );
      await title("Agent A");
      await userEvent.keyboard("{Escape}");
      await waitFor(() => expect(document.getElementById("main-content")).toHaveFocus());
    });
  });

  describe("binding to the original target (AC-21)", () => {
    it("a stale response never shows on a newly selected target", async () => {
      const responses: Record<string, ReturnType<typeof deferred<Item | null>>> = { a: deferred(), b: deferred() };
      setUrl("/agents?agent=a");
      render(<Screen load={(id) => responses[id].promise} />);
      await act(async () => navigate("/agents?agent=b"));
      await act(async () => responses.b.resolve(ITEMS.b));
      await title("Agent B");
      await act(async () => responses.a.resolve(ITEMS.a));
      expect(screen.getByRole("heading", { name: "Agent B" })).toBeInTheDocument();
      expect(screen.queryByText("Agent A")).toBeNull();
    });

    it("aborts the request it no longer needs", async () => {
      const signals: Record<string, AbortSignal> = {};
      setUrl("/agents?agent=a");
      render(
        <Screen
          load={(id, { signal }) => {
            signals[id] = signal;
            return resolved(id);
          }}
        />,
      );
      await title("Agent A");
      expect(signals.a.aborted).toBe(false);
      await act(async () => navigate("/agents?agent=b"));
      await title("Agent B");
      expect(signals.a.aborted).toBe(true);
    });

    it("a late failure for the old target doesn't touch the new one", async () => {
      const first = deferred<Item | null>();
      setUrl("/agents?agent=a");
      render(<Screen load={(id) => (id === "a" ? first.promise : resolved(id))} />);
      await act(async () => navigate("/agents?agent=b"));
      await title("Agent B");
      await act(async () => first.reject(new Error("late")));
      expect(screen.queryByRole("alert")).toBeNull();
    });

    it("a late not-found for the old target doesn't close the new one", async () => {
      const first = deferred<Item | null>();
      setUrl("/agents?agent=a");
      render(<Screen load={(id) => (id === "a" ? first.promise : resolved(id))} />);
      await act(async () => navigate("/agents?agent=b"));
      await title("Agent B");
      await act(async () => first.resolve(null));
      expect(screen.getByRole("heading", { name: "Agent B" })).toBeInTheDocument();
      expect(currentUrl()).toBe("/agents?agent=b");
    });

    it("a save in flight keeps its target and version, and finishes before the Sheet moves on", async () => {
      const save = deferred<GatewayResult<unknown>>();
      const command = vi.fn((_: SheetBinding) => save.promise);
      setUrl("/agents?agent=a");
      render(<Screen command={command} />);
      await title("Agent A");
      await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
      expect(command).toHaveBeenCalledWith({ target: "a", version: 3 });

      await act(async () => navigate("/agents?agent=b"));
      expect(screen.getByRole("heading", { name: "Agent A" })).toBeInTheDocument();
      expect(screen.queryByRole("heading", { name: "Agent B" })).toBeNull();

      await act(async () => save.resolve({ ok: true, data: {} }));
      await title("Agent B");
      expect(command).toHaveBeenCalledTimes(1);
      expect(screen.queryByRole("alert")).toBeNull();
    });

    it("a save that fails after a switch holds its own target until it's been seen", async () => {
      const save = deferred<GatewayResult<unknown>>();
      setUrl("/agents?agent=a");
      render(<Screen command={() => save.promise} />);
      await title("Agent A");
      await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
      await act(async () => navigate("/agents?agent=b"));
      await act(async () => save.resolve({ ok: false, status: 403, code: "not_allowed" }));
      expect(await screen.findByRole("alert")).toHaveTextContent("That didn't save, and nothing changed.");
      expect(screen.getByRole("heading", { name: "Agent A" })).toBeInTheDocument();
      expect(screen.queryByRole("heading", { name: "Agent B" })).toBeNull();

      await userEvent.click(screen.getByRole("button", { name: "Close" }));
      await title("Agent B");
      expect(screen.queryByRole("alert")).toBeNull();
    });

    it("a draft keeps the version it was read at, so a newer reload can't let it overwrite", async () => {
      const load = vi.fn<(id: string) => Promise<Item | null>>().mockResolvedValueOnce(ITEMS.a).mockRejectedValueOnce(new Error("down")).mockResolvedValue({ ...ITEMS.a, title: "Agent A newer", version: 9 });
      const command = vi.fn(async (_: SheetBinding): Promise<GatewayResult<unknown>> => ({ ok: true, data: {} }));
      setUrl("/agents?agent=a");
      render(<Screen load={load} command={command} />);
      await title("Agent A");
      // A save, then a refresh that fails, leaves Try again on screen.
      await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
      await screen.findByRole("button", { name: "Try again" });
      await userEvent.type(screen.getByRole("textbox"), "x");
      await userEvent.click(screen.getByRole("button", { name: "Try again" }));
      await title("Agent A newer");
      command.mockResolvedValue({ ok: false, status: 409, code: "version_conflict" });
      await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
      expect(command).toHaveBeenLastCalledWith({ target: "a", version: 3 });
      expect(await screen.findByRole("alert")).toHaveTextContent("This agent changed while you were editing.");
      expect(screen.getByRole("textbox")).toHaveValue("x");
    });

    it("can't close while a save is in flight, so its result isn't lost", async () => {
      const save = deferred<GatewayResult<unknown>>();
      setUrl("/agents?agent=a");
      render(<Screen command={() => save.promise} />);
      await title("Agent A");
      await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
      await userEvent.keyboard("{Escape}");
      expect(screen.getByRole("heading", { name: "Agent A" })).toBeInTheDocument();
      expect(currentUrl()).toBe("/agents?agent=a");
      await act(async () => save.resolve({ ok: false, status: 403, code: "not_allowed" }));
      expect(await screen.findByRole("alert")).toHaveTextContent("That didn't save, and nothing changed.");
    });

    it("ignores a repeated save", async () => {
      const save = deferred<GatewayResult<unknown>>();
      const command = vi.fn(() => save.promise);
      setUrl("/agents?agent=a");
      let trigger!: () => void;
      render(
        <TargetSheet<Item> param="agent" load={resolved} title={(item) => item.title} description={() => "Room"}>
          {({ run }) => {
            trigger = () => void run(command);
            return null;
          }}
        </TargetSheet>,
      );
      await title("Agent A");
      await act(async () => {
        trigger();
        trigger();
      });
      expect(command).toHaveBeenCalledTimes(1);
      await act(async () => save.resolve({ ok: true, data: {} }));
    });

    it("a successful save reloads the server's state and refreshes the list behind", async () => {
      let version = 3;
      setUrl("/agents?agent=a");
      const load = vi.fn(async () => ({ ...ITEMS.a, title: `Agent A v${version}`, version }));
      render(<Screen load={load} command={async () => ((version = 4), { ok: true, data: {} })} />);
      await title("Agent A v3");
      await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
      await title("Agent A v4");
      expect(routerCalls.refresh).toBe(1);
    });
  });

  describe("unsaved edits", () => {
    const edit = async () => {
      await userEvent.type(screen.getByRole("textbox"), "x");
      expect(await screen.findByRole("status")).toHaveTextContent("Unsaved changes");
    };

    it("Escape asks first, and keeping them changes nothing", async () => {
      const command = vi.fn(async () => ({ ok: true as const, data: {} }));
      setUrl("/agents?agent=a");
      render(<Screen command={command} />);
      await title("Agent A");
      await edit();
      await userEvent.keyboard("{Escape}");
      expect(await screen.findByRole("alertdialog")).toHaveTextContent("Your changes to “Agent A” won't be saved.");
      await userEvent.click(screen.getByRole("button", { name: "Keep editing" }));
      expect(screen.getByRole("textbox")).toHaveValue("x");
      expect(currentUrl()).toBe("/agents?agent=a");
      expect(command).not.toHaveBeenCalled();
    });

    it("discarding closes without saving (AC-20)", async () => {
      const command = vi.fn(async () => ({ ok: true as const, data: {} }));
      setUrl("/agents?agent=a");
      render(<Screen command={command} />);
      await title("Agent A");
      await edit();
      await userEvent.click(screen.getByRole("button", { name: "Close" }));
      await userEvent.click(await screen.findByRole("button", { name: "Discard changes" }));
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      expect(currentUrl()).toBe("/agents");
      expect(command).not.toHaveBeenCalled();
    });

    it("Back to another target asks first, and staying restores the URL", async () => {
      setUrl("/agents?agent=a");
      render(<Screen />);
      await title("Agent A");
      await edit();
      await act(async () => navigate("/agents?agent=b"));
      await screen.findByRole("alertdialog");
      expect(screen.getByRole("textbox", { hidden: true })).toHaveValue("x");
      await userEvent.click(screen.getByRole("button", { name: "Keep editing" }));
      expect(currentUrl()).toBe("/agents?agent=a");
      expect(screen.getByRole("heading", { name: "Agent A" })).toBeInTheDocument();
      expect(screen.getByRole("textbox")).toHaveValue("x");
    });

    it("Escape on the question keeps the edits", async () => {
      setUrl("/agents?agent=a");
      render(<Screen />);
      await title("Agent A");
      await edit();
      await userEvent.keyboard("{Escape}");
      await screen.findByRole("alertdialog");
      await userEvent.keyboard("{Escape}");
      await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
      expect(screen.getByRole("textbox")).toHaveValue("x");
      expect(currentUrl()).toBe("/agents?agent=a");
    });

    it("discarding on a switch opens the new target with nothing carried over", async () => {
      setUrl("/agents?agent=a");
      render(<Screen />);
      await title("Agent A");
      await edit();
      await act(async () => navigate("/agents?agent=b"));
      await userEvent.click(await screen.findByRole("button", { name: "Discard changes" }));
      await title("Agent B");
      expect(screen.getByRole("textbox")).toHaveValue("");
      expect(screen.queryByText("Unsaved changes")).toBeNull();
    });
  });

  describe("conflicts and failures", () => {
    it("keeps input on a version conflict, and offers the latest", async () => {
      setUrl("/agents?agent=a");
      const load = vi.fn(resolved);
      render(<Screen load={load} command={async () => ({ ok: false, status: 409, code: "version_conflict" })} />);
      await title("Agent A");
      await userEvent.type(screen.getByRole("textbox"), "mine");
      await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
      expect(await screen.findByRole("alert")).toHaveTextContent("This agent changed while you were editing. Your changes aren't saved.");
      expect(screen.getByRole("textbox")).toHaveValue("mine");
      expect(screen.getByRole("status")).toHaveTextContent("Unsaved changes");
      await userEvent.click(screen.getByRole("button", { name: "Review latest" }));
      await waitFor(() => expect(load).toHaveBeenCalledTimes(2));
    });

    it.each([
      ["a server error", async () => ({ ok: false as const, status: 502, code: "bad_gateway" })],
      ["a lost response", async () => Promise.reject(new TypeError("fetch failed"))],
    ])("can't say nothing changed after %s", async (_what, command) => {
      setUrl("/agents?agent=a");
      render(<Screen command={command} />);
      await title("Agent A");
      await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
      const alert = await screen.findByRole("alert");
      expect(alert).toHaveTextContent("We can't tell whether this saved.");
      expect(alert).not.toHaveTextContent("nothing changed");
    });

    it("says a session that ended isn't a refusal", async () => {
      setUrl("/agents?agent=a");
      render(<Screen command={async () => ({ ok: false, status: 401, code: "sign_in_required" })} />);
      await title("Agent A");
      await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
      expect(await screen.findByRole("alert")).toHaveTextContent("You've been signed out, so this didn't save.");
    });

    it("says a denied save didn't happen", async () => {
      setUrl("/agents?agent=a");
      render(<Screen command={async () => ({ ok: false, status: 403, code: "not_allowed" })} />);
      await title("Agent A");
      await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
      expect(await screen.findByRole("alert")).toHaveTextContent("That didn't save, and nothing changed.");
      expect(routerCalls.refresh).toBe(0);
    });

    it("offers a retry when a read fails, and shows no title", async () => {
      setUrl("/agents?agent=a");
      const load = vi.fn<(id: string) => Promise<Item | null>>().mockRejectedValueOnce(new Error("down")).mockResolvedValue(ITEMS.a);
      render(<Screen load={load} />);
      expect(await title("Couldn't load this")).toBeInTheDocument();
      await userEvent.click(screen.getByRole("button", { name: "Try again" }));
      expect(await title("Agent A")).toBeInTheDocument();
    });

    it("keeps prior data when a refresh fails", async () => {
      setUrl("/agents?agent=a");
      const load = vi.fn<(id: string) => Promise<Item | null>>().mockResolvedValueOnce(ITEMS.a).mockRejectedValue(new Error("down"));
      render(<Screen load={load} />);
      await title("Agent A");
      await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
      expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't refresh.");
      expect(screen.getByRole("heading", { name: "Agent A" })).toBeInTheDocument();
    });
  });

  it("refuses to open a Sheet from inside a Sheet", async () => {
    setUrl("/agents?agent=a");
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(() =>
      render(
        <TargetSheet<Item> param="agent" load={async () => ITEMS.a} title={(item) => item.title} description={() => "Room"}>
          {() => (
            <SheetLink param="other" target="x">
              Another
            </SheetLink>
          )}
        </TargetSheet>,
      ),
    ).not.toThrow();
    // React rethrows the render error from the load's update.
    await expect(act(async () => new Promise((resolve) => setTimeout(resolve, 0)))).rejects.toThrow("A Sheet can't open another Sheet");
    error.mockRestore();
  });

  it("words a failure with the command's own explanation, and a thrown command as unknown", async () => {
    const user = userEvent.setup();
    setUrl("/a?agent=a");
    let attempt = 0;
    render(
      <TargetSheet<Item> param="agent" load={resolved} title={(data) => data.title} description={() => "Room"} version={(data) => data.version}>
        {({ run }) => (
          <Button
            onClick={() =>
              void run(
                async () => {
                  attempt += 1;
                  if (attempt === 2) throw new TypeError("network");
                  return { ok: false, status: 422, code: "self_sign_off" };
                },
                (code, status) => `Explained ${code} ${status}`,
              )
            }
          >
            Do it
          </Button>
        )}
      </TargetSheet>,
    );
    await user.click(await screen.findByRole("button", { name: "Do it" }));
    expect(await screen.findByText("Explained self_sign_off 422")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Do it" }));
    expect(await screen.findByText("Explained unknown 0")).toBeInTheDocument();
  });

  it("holds the Sheet open for an unversioned draft without pinning the version, and refresh reads again", async () => {
    const user = userEvent.setup();
    setUrl("/a?agent=a");
    let version = 3;
    const seen: (number | null)[] = [];
    render(
      <TargetSheet<Item> param="agent" load={async () => ({ ...ITEMS.a, version })} title={(data) => data.title} description={() => "Room"} version={(data) => data.version}>
        {({ setUnsaved, refresh, binding, dirty }) => {
          seen.push(binding.version);
          return (
            <>
              <Button onClick={() => setUnsaved(true)}>Type</Button>
              <Button onClick={refresh}>Read again</Button>
              <span>{dirty ? "dirty" : "clean"}</span>
            </>
          );
        }}
      </TargetSheet>,
    );
    await user.click(await screen.findByRole("button", { name: "Type" }));
    expect(screen.getByText("Unsaved changes")).toBeInTheDocument();
    expect(screen.getByText("clean")).toBeInTheDocument();
    version = 4;
    await user.click(screen.getByRole("button", { name: "Read again" }));
    // Commands would carry the newer version. A real edit would still answer to 3.
    await waitFor(() => expect(seen.at(-1)).toBe(4));
    await user.keyboard("{Escape}");
    expect(await screen.findByText("Discard unsaved changes?")).toBeInTheDocument();
  });

  it("reads the target again after an unknown outcome, and not after a refusal", async () => {
    const user = userEvent.setup();
    setUrl("/a?agent=a");
    const load = vi.fn(resolved);
    let result: GatewayResult<unknown> = { ok: false, status: 400, code: "invalid_argument" };
    render(
      <TargetSheet<Item> param="agent" load={load} title={(data) => data.title} description={() => "Room"}>
        {({ run }) => <Button onClick={() => void run(async () => result)}>Do it</Button>}
      </TargetSheet>,
    );
    await user.click(await screen.findByRole("button", { name: "Do it" }));
    await screen.findByText(/That didn't save/);
    expect(load).toHaveBeenCalledTimes(1);
    result = { ok: false, status: 502, code: "bad_gateway" };
    await user.click(screen.getByRole("button", { name: "Do it" }));
    await screen.findByText(/We can't tell/);
    await waitFor(() => expect(load).toHaveBeenCalledTimes(2));
    expect(routerCalls.refresh).toBeGreaterThan(0);
  });

  it("clears a failure once the draft it was about is gone", async () => {
    const user = userEvent.setup();
    setUrl("/a?agent=a");
    render(
      <TargetSheet<Item> param="agent" load={resolved} title={(data) => data.title} description={() => "Room"}>
        {({ run, setDirty }) => (
          <>
            <Button onClick={() => setDirty(true)}>Type</Button>
            <Button onClick={() => void run(async () => ({ ok: false, status: 502, code: "bad_gateway" }), () => "Save again")}>Save</Button>
            <Button onClick={() => setDirty(false)}>Drop</Button>
          </>
        )}
      </TargetSheet>,
    );
    await user.click(await screen.findByRole("button", { name: "Type" }));
    await user.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByText("Save again");
    await user.click(screen.getByRole("button", { name: "Drop" }));
    expect(screen.queryByText("Save again")).toBeNull();
  });

  it("asks the browser before leaving with a draft or a command in flight, and not otherwise", async () => {
    const user = userEvent.setup();
    setUrl("/a?agent=a");
    const leave = () => {
      const event = new Event("beforeunload", { cancelable: true });
      window.dispatchEvent(event);
      return event.defaultPrevented;
    };
    render(
      <TargetSheet<Item> param="agent" load={resolved} title={(data) => data.title} description={() => "Room"}>
        {({ setUnsaved, setSending }) => (
          <>
            <Button onClick={() => setUnsaved(true)}>Type</Button>
            <Button onClick={() => setUnsaved(false)}>Clear</Button>
            <Button onClick={() => setSending(true)}>Send</Button>
          </>
        )}
      </TargetSheet>,
    );
    await user.click(await screen.findByRole("button", { name: "Type" }));
    expect(leave()).toBe(true);
    await user.click(screen.getByRole("button", { name: "Clear" }));
    expect(leave()).toBe(false);
    await user.click(screen.getByRole("button", { name: "Send" }));
    expect(leave()).toBe(true);
  });

  it("won't close while a command outside run is in flight", async () => {
    const user = userEvent.setup();
    setUrl("/a?agent=a");
    render(
      <TargetSheet<Item> param="agent" load={resolved} title={(data) => data.title} description={() => "Room"}>
        {({ setSending, setUnsaved }) => (
          <Button
            onClick={() => {
              setUnsaved(true);
              setSending(true);
            }}
          >
            Send
          </Button>
        )}
      </TargetSheet>,
    );
    await user.click(await screen.findByRole("button", { name: "Send" }));
    await user.keyboard("{Escape}");
    expect(screen.queryByText("Discard unsaved changes?")).toBeNull();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  describe("after an unknown outcome", () => {
    const leave = () => {
      const event = new Event("beforeunload", { cancelable: true });
      window.dispatchEvent(event);
      return event.defaultPrevented;
    };

    function Commands({ results, load = resolved }: { results: GatewayResult<unknown>[]; load?: typeof resolved }) {
      const queue = [...results];
      return (
        <TargetSheet<Item> param="agent" load={load} title={(data) => data.title} description={() => "Room"}>
          {({ run, setDirty }) => (
            <>
              <Button onClick={() => setDirty(true)}>Type</Button>
              <Button onClick={() => setDirty(false)}>Drop</Button>
              <Button onClick={() => void run(async () => queue.shift()!, (code, status) => `Explained ${code} ${status}`)}>Do it</Button>
            </>
          )}
        </TargetSheet>
      );
    }
    const LOST: GatewayResult<unknown> = { ok: false, status: 502, code: "bad_gateway" };
    const DENIED: GatewayResult<unknown> = { ok: false, status: 403, code: "not_allowed" };
    const doIt = () => userEvent.click(screen.getByRole("button", { name: "Do it" }));

    it("won't let a later refusal's explanation speak for the earlier attempt, and reads again", async () => {
      setUrl("/a?agent=a");
      const load = vi.fn(resolved);
      render(<Commands results={[LOST, DENIED]} load={load} />);
      await screen.findByRole("button", { name: "Do it" });
      await doIt();
      expect(await screen.findByText("Explained unknown 502")).toBeInTheDocument();
      await waitFor(() => expect(load).toHaveBeenCalledTimes(2));
      await doIt();
      expect(await screen.findByText(/We still can't tell whether your earlier change saved/)).toBeInTheDocument();
      expect(screen.queryByText(/Explained not_allowed/)).toBeNull();
      await waitFor(() => expect(load).toHaveBeenCalledTimes(3));
    });

    it("doesn't read again when signed out, which would send the person away from their draft", async () => {
      setUrl("/a?agent=a");
      const load = vi.fn(resolved);
      render(<Commands results={[LOST, { ok: false, status: 401, code: "sign_in_required" }]} load={load} />);
      await screen.findByRole("button", { name: "Do it" });
      await doIt();
      await waitFor(() => expect(load).toHaveBeenCalledTimes(2));
      await doIt();
      expect(await screen.findByText(/You've been signed out, so we still can't tell/)).toBeInTheDocument();
      expect(load).toHaveBeenCalledTimes(2);
    });

    it("goes back to explaining refusals once a command succeeds", async () => {
      setUrl("/a?agent=a");
      render(<Commands results={[LOST, { ok: true, data: {} }, DENIED]} />);
      await screen.findByRole("button", { name: "Do it" });
      await doIt();
      await screen.findByText("Explained unknown 502");
      await doIt();
      await waitFor(() => expect(screen.queryByText("Explained unknown 502")).toBeNull());
      await doIt();
      expect(await screen.findByText("Explained not_allowed 403")).toBeInTheDocument();
    });

    it("explains a first refusal, a limit and an archived room with the command's own words", async () => {
      setUrl("/a?agent=a");
      render(<Commands results={[{ ok: false, status: 429, code: "rate_limited" }, { ok: false, status: 409, code: "workspace_archived" }]} />);
      await screen.findByRole("button", { name: "Do it" });
      await doIt();
      expect(await screen.findByText("Explained rate_limited 429")).toBeInTheDocument();
      await doIt();
      expect(await screen.findByText("Explained workspace_archived 409")).toBeInTheDocument();
    });

    it("still guards a draft, and stays unsure after the draft is dropped", async () => {
      setUrl("/a?agent=a");
      render(<Commands results={[LOST, DENIED]} />);
      await userEvent.click(await screen.findByRole("button", { name: "Type" }));
      await doIt();
      await screen.findByText("Explained unknown 502");
      await waitFor(() => expect(leave()).toBe(true));
      await userEvent.keyboard("{Escape}");
      expect(await screen.findByText("Discard unsaved changes?")).toBeInTheDocument();
      await userEvent.click(screen.getByRole("button", { name: "Keep editing" }));
      await userEvent.click(screen.getByRole("button", { name: "Drop" }));
      expect(screen.queryByText("Explained unknown 502")).toBeNull();
      await waitFor(() => expect(leave()).toBe(false));
      await doIt();
      expect(await screen.findByText(/We still can't tell whether your earlier change saved/)).toBeInTheDocument();
    });
  });
});
