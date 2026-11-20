import { useSyncExternalStore } from "react";

/** A small router: the URL, and who's listening. */
let url = new URL("http://app.test/");
let forward: string[] = [];
const history: string[] = [];
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((listener) => listener());
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/** A router navigation renders the page again on the server, which spends the person's gateway rate limit. `push` counts them. */
export const routerCalls = { refresh: 0, push: 0, /** Refreshes that landed: a `pushState` before one lands discards it, as vinext does. */ refreshed: 0 };

/** Real navigation finishes later. While true, `push` and `replace` wait until `settleNavigation`. */
let holdNavigation = false;
let held: (() => void)[] = [];
/**
 * Refreshes asked for whose server round trip hasn't come back. They land only when a test calls `landRefreshes`, never on a
 * timer: a timer is a margin that a loaded machine uses up, and a refresh then lands before a close that should have discarded it.
 * vinext's `pushState` calls `discardPendingNavigation`, which drops a pending push or refresh.
 */
let pendingRefreshes = 0;
/** The server round trips of every refresh still pending come back now, so each one not discarded counts in `refreshed`. */
export const landRefreshes = () => {
  routerCalls.refreshed += pendingRefreshes;
  pendingRefreshes = 0;
};
const heldPushes = new Set<() => void>();
export const setHoldNavigation = (hold: boolean) => {
  holdNavigation = hold;
};
export const settleNavigation = () => {
  const pending = held;
  held = [];
  pending.forEach((apply) => apply());
};

/** A later navigation replaces one still in progress, so the held ones never land, as with a real router. */
export const dropHeldNavigation = () => {
  held = [];
  holdNavigation = false;
};

export function setUrl(next: string) {
  url = new URL(next, "http://app.test");
  history.length = 0;
  forward = [];
  routerCalls.refresh = 0;
  routerCalls.push = 0;
  routerCalls.refreshed = 0;
  pendingRefreshes = 0;
  holdNavigation = false;
  held = [];
  notify();
}

export const navigate = (next: string) => {
  history.push(url.pathname + url.search);
  url = new URL(next, "http://app.test");
  notify();
};

export const back = () => {
  const previous = history.pop();
  if (previous === undefined) return;
  forward.push(url.pathname + url.search);
  url = new URL(previous, "http://app.test");
  notify();
};

// vinext patches this so `useSearchParams` follows it, as Next does, and it reads nothing from the server. React may apply
// it a moment later, so a held navigation holds this too.
window.history.pushState = (_data, _unused, next) => {
  pendingRefreshes = 0;
  held = held.filter((apply) => !heldPushes.has(apply));
  heldPushes.clear();
  if (next) later(() => navigate(String(next)));
};

export const currentUrl = () => url.pathname + url.search;

const later = (apply: () => void) => (holdNavigation ? void held.push(apply) : apply());

export const useRouter = () => ({
  push: (next: string) => {
    routerCalls.push += 1;
    const apply = () => navigate(next);
    if (holdNavigation) heldPushes.add(apply);
    later(apply);
  },
  replace: (next: string) =>
    later(() => {
      url = new URL(next, "http://app.test");
      notify();
    }),
  refresh: () => {
    routerCalls.refresh += 1;
    // It lands after a server round trip, which `landRefreshes` stands for, so a `pushState` in the meantime discards it.
    pendingRefreshes += 1;
  },
});

export const usePathname = () => useSyncExternalStore(subscribe, () => url.pathname);
export const useSearchParams = () => {
  const search = useSyncExternalStore(subscribe, () => url.search);
  return new URLSearchParams(search);
};

export class NotFoundSignal extends Error {}
export class RedirectSignal extends Error {}
export const notFound = (): never => {
  throw new NotFoundSignal("not_found");
};
export const redirect = (to: string): never => {
  throw new RedirectSignal(to);
};
