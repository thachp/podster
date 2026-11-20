import { useEffect, useState } from "react";
import { fireEvent } from "@testing-library/react";
import { createRoot, hydrateRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useEarlyInput } from "./use-early-input";

const seen = vi.fn();

/**
 * Resolves on the next commit of a component that calls `useCommitted`. Its effect runs after the hook's own, declared before it, so
 * by then the hook has queued what it hands over. No wall-clock wait: a loaded machine can take longer than any margin to hydrate.
 */
let onCommit: (() => void) | null = null;
const nextCommit = () => new Promise<void>((resolve) => (onCommit = resolve));
function useCommitted() {
  useEffect(() => {
    const resolve = onCommit;
    onCommit = null;
    resolve?.();
  });
}

/**
 * Waits for the commit `start` causes, then runs the hook's queued hand-overs, each a timeout of its own, until none is left.
 * React's own scheduler keeps the real timers it took when it loaded, so only the hook's timeouts are the test's.
 */
async function committed(start: () => void) {
  const commit = nextCommit();
  start();
  await commit;
  vi.runAllTimers();
}

function Form({ on = true }: { on?: boolean }) {
  const early = useEarlyInput();
  useCommitted();
  const [state, setState] = useState({ name: "Server", note: "", pick: "a", tick: false });
  const change = (next: Partial<typeof state>) => {
    seen(next);
    setState({ ...state, ...next });
  };
  return (
    <form ref={on ? early : null} data-state={JSON.stringify(state)}>
      <input aria-label="name" value={state.name} onChange={(event) => change({ name: event.target.value })} />
      <textarea aria-label="note" value={state.note} onChange={(event) => change({ note: event.target.value })} />
      <select aria-label="pick" value={state.pick} onChange={(event) => change({ pick: event.target.value })}>
        <option value="a">A</option>
        <option value="b">B</option>
      </select>
      <input aria-label="tick" type="checkbox" checked={state.tick} onChange={(event) => change({ tick: event.target.checked })} />
    </form>
  );
}

// Not act's timing, which would hold every update until the end and hide what each step sees.
const flag = globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean };

let root: Root | undefined;
let host: HTMLElement;

/** The server's HTML, with what happens before scripts arrive, then hydrated. */
async function hydrate(early: (control: Record<string, HTMLInputElement>) => void, on = true) {
  host = document.body.appendChild(document.createElement("div"));
  host.innerHTML = renderToString(<Form on={on} />);
  const get = (label: string) => host.querySelector(`[aria-label="${label}"]`) as HTMLInputElement;
  early({ name: get("name"), note: get("note"), pick: get("pick"), tick: get("tick") });
  await committed(() => {
    root = hydrateRoot(host, <Form on={on} />);
  });
  return JSON.parse(host.querySelector("form")!.dataset.state!);
}

beforeEach(() => {
  flag.IS_REACT_ACT_ENVIRONMENT = false;
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
});

afterEach(() => {
  vi.useRealTimers();
  onCommit = null;
  root?.unmount();
  host.remove();
  seen.mockClear();
  flag.IS_REACT_ACT_ENVIRONMENT = true;
});

describe("useEarlyInput", () => {
  it("hands React everything filled in before hydration, through the form's own handlers", async () => {
    const state = await hydrate((c) => {
      c.name.value = "Typed early";
      c.note.value = "A note";
      c.pick.value = "b";
      c.tick.checked = true;
    });
    expect(state).toEqual({ name: "Typed early", note: "A note", pick: "b", tick: true });
  });

  it("does nothing when nothing was touched", async () => {
    await hydrate(() => {});
    expect(seen).not.toHaveBeenCalled();
  });

  it("leaves React's state behind without it", async () => {
    const state = await hydrate((c) => {
      c.name.value = "Typed early";
    }, false);
    expect(state.name).toBe("Server");
    expect(seen).not.toHaveBeenCalled();
  });

  describe("after the page has hydrated", () => {
    const control = (label: string) => host.querySelector(`[aria-label="${label}"]`) as HTMLInputElement;
    // Nothing here should queue a hand-over, and anything that did runs before the test looks.
    const trigger = () => {
      window.dispatchEvent(new Event("load"));
      window.dispatchEvent(new Event("pageshow"));
      vi.runAllTimers();
    };

    it("doesn't send a change again when someone has typed, ticked and picked", async () => {
      await hydrate(() => {});
      fireEvent.change(control("name"), { target: { value: "Typed later" } });
      fireEvent.click(control("tick"));
      fireEvent.change(control("pick"), { target: { value: "b" } });
      vi.runAllTimers();
      seen.mockClear();
      trigger();
      expect(seen).not.toHaveBeenCalled();
    });

    it("doesn't send what it already handed over a second time", async () => {
      await hydrate((c) => {
        c.tick.checked = true;
        c.pick.value = "b";
      });
      seen.mockClear();
      trigger();
      expect(seen).not.toHaveBeenCalled();
    });

    it("doesn't take a value the server later changed for someone's choice", async () => {
      host = document.body.appendChild(document.createElement("div"));
      function Driven({ tick, pick }: { tick: boolean; pick: string }) {
        const early = useEarlyInput();
        useCommitted();
        return (
          <form ref={early}>
            <input aria-label="tick" type="checkbox" checked={tick} onChange={(event) => seen({ tick: event.target.checked })} />
            <select aria-label="pick" value={pick} onChange={(event) => seen({ pick: event.target.value })}>
              <option value="a">A</option>
              <option value="b">B</option>
            </select>
          </form>
        );
      }
      host.innerHTML = renderToString(<Driven tick={false} pick="a" />);
      await committed(() => {
        root = hydrateRoot(host, <Driven tick={false} pick="a" />);
      });
      await committed(() => root!.render(<Driven tick pick="b" />));
      trigger();
      expect(seen).not.toHaveBeenCalled();
    });
  });

  it("does nothing to a form mounted after the page has loaded, whatever its starting choice", async () => {
    host = document.body.appendChild(document.createElement("div"));
    root = createRoot(host);
    function Picked() {
      const early = useEarlyInput();
      useCommitted();
      return (
        <form ref={early}>
          <select aria-label="pick" value="b" onChange={(event) => seen({ pick: event.target.value })}>
            <option value="a">A</option>
            <option value="b">B</option>
          </select>
          <input aria-label="tick" type="checkbox" checked onChange={(event) => seen({ tick: event.target.checked })} />
        </form>
      );
    }
    await committed(() => root!.render(<Picked />));
    expect(seen).not.toHaveBeenCalled();
  });
});
