// The content Worker's entry (M6 step 4(b), ADR 0010). Its only two bindings are the serve entries, to read, and the
// dispatch namespace, and its one variable is the content domain's name. It holds no binding to the gateway, the API,
// D1 or R2, and no secret. It logs nothing for a request.
import { handle, type StopMemory } from "./handle";

interface Env {
  SERVE: KVNamespace;
  APPS: DispatchNamespace;
  /** The content domain, as the private API has it: an app's default host is `<label>.<this>`. */
  CONTENT_DOMAIN?: unknown;
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
    });
  },
} satisfies ExportedHandler<Env>;
