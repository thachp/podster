// The content Worker's entry (M6 step 4(b), ADR 0010). Its only two bindings are the serve entries, to read, and the
// dispatch namespace. It holds no binding to the gateway, the API, D1 or R2, no variable and no secret.
import { handle, type StopMemory } from "./handle";

interface Env {
  SERVE: KVNamespace;
  APPS: DispatchNamespace;
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
      log: (status, code) => console.log(JSON.stringify({ status, code })),
    });
  },
} satisfies ExportedHandler<Env>;
