// The content Worker's entry (M6 step 4(b), ADR 0010). Its bindings are the serve entries, to read, the dispatch
// namespace, and its own write counter's namespace (stage 1, S6); its variables are the content domain's name and the
// write cap's two settings. It holds no binding to the gateway, the API, D1 or R2, and no secret. It logs nothing for
// a request.
import { capFromSettings } from "./budget";
import { WriteCounter, writeCounter } from "./counter";
import { CODE_APPS_ENABLED, handle, type StopMemory } from "./handle";

/** The write counter's class, one object for each app. The configuration declares it by this name. */
export { WriteCounter };

interface Env {
  SERVE: KVNamespace;
  APPS: DispatchNamespace;
  /** The write counter's objects: this Worker's own class, bound by no other Worker. */
  WRITE_COUNTER: DurableObjectNamespace;
  /** The content domain, as the private API has it: an app's default host is `<label>.<this>`. */
  CONTENT_DOMAIN?: unknown;
  /** The write cap: how many writes each app may make in a window. A decimal string; no default. */
  WRITE_BUDGET_WRITES?: unknown;
  /** The write cap's window, in milliseconds. A decimal string; no default. */
  WRITE_BUDGET_WINDOW_MS?: unknown;
}

// One for each running copy of the Worker: what it last read of the stop.
const stop: StopMemory = { read: null };

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    return handle(request, {
      entries: { get: (key, options) => env.SERVE.get(key, options) },
      apps: { get: (name) => env.APPS.get(name) },
      now: () => Date.now(),
      stop,
      // Anything but a string is no domain, and then every host is not-found.
      domain: typeof env.CONTENT_DOMAIN === "string" ? env.CONTENT_DOMAIN : "",
      // A host's kind comes from the mark on its serve entry, read in the handler. A host with code serves nothing
      // while the code-apps switch is off.
      // The switch, off: a constant of type `false`, and no binding or variable.
      codeApps: CODE_APPS_ENABLED satisfies false,
      // Asked only for a write to a host with code, which the switch keeps from getting this far. Either setting
      // missing or malformed is no cap, and every write is refused.
      writes: writeCounter(env.WRITE_COUNTER, capFromSettings(env.WRITE_BUDGET_WRITES, env.WRITE_BUDGET_WINDOW_MS)),
    });
  },
} satisfies ExportedHandler<Env>;
