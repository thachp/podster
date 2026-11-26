// The content Worker's entry (M6 step 4(b), ADR 0010). Its bindings are the serve entries, to read, the dispatch
// namespace, and its own write counter's namespace (stage 1, S6); its variables are the content domain's name, the
// write cap's two settings and the dispatch limits' two settings. It holds no binding to the gateway, the API, D1 or R2, and no secret. It logs one line for
// a dispatch that failed, its class and the release's ID, and nothing else of a request.
import { capFromSettings } from "./budget";
import { WriteCounter, writeCounter } from "./counter";
import { CODE_APPS_ENABLED, handle, type StopMemory } from "./handle";
import { limitsFromSettings } from "./limits";

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
  /** The CPU milliseconds each dispatch to an app with code may use. A decimal string; no default. */
  APP_LIMIT_CPU_MS?: unknown;
  /** The subrequests each dispatch to an app with code may make. A decimal string; no default. */
  APP_LIMIT_SUBREQUESTS?: unknown;
}

// One for each running copy of the Worker: what it last read of the stop.
const stop: StopMemory = { read: null };

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    return handle(request, {
      entries: { get: (key, options) => env.SERVE.get(key, options) },
      apps: { get: (name, args, options) => env.APPS.get(name, args, options) },
      now: () => Date.now(),
      wait: (ms) => new Promise((done) => setTimeout(done, ms)),
      stop,
      // Anything but a string is no domain, and then every host is not-found.
      domain: typeof env.CONTENT_DOMAIN === "string" ? env.CONTENT_DOMAIN : "",
      // A host's kind comes from the mark on its serve entry, read in the handler. A host with code serves nothing
      // while the code-apps switch is off.
      // The switch: a constant, and no binding or variable.
      codeApps: CODE_APPS_ENABLED,
      // The limits each dispatch to an app with code is given. Either setting missing or malformed is no limits, and
      // every request to a host with code that would reach its app is refused.
      limits: limitsFromSettings(env.APP_LIMIT_CPU_MS, env.APP_LIMIT_SUBREQUESTS),
      // Asked only for a write to a host with code that passes every rule. Either setting missing or malformed is no
      // cap, and every write is refused.
      writes: writeCounter(env.WRITE_COUNTER, capFromSettings(env.WRITE_BUDGET_WRITES, env.WRITE_BUDGET_WINDOW_MS)),
      // The one line logged, for a failed dispatch: its two fields, built in the handler, and nothing else.
      log: (line) => console.log(JSON.stringify({ event: line.event, release: line.release })),
    });
  },
} satisfies ExportedHandler<Env>;
