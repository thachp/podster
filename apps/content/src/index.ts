// The content Worker's entry (M6 step 4(b), ADR 0010). Its bindings are the serve entries, to read, the dispatch
// namespace, and its own write counter's namespace (stage 1, S6); its variables are the content domain's name, the
// write cap's two settings and the dispatch limits' two settings. It holds no binding to the gateway, the API, D1 or R2, and no secret. It logs one line for
// a dispatch that failed, its class and the release's ID, and nothing else of a request.
//
// **Previews** (M8 step 8) need three more, each read by name and each absent until the owner's wizard sets it
// (decision 258): the preview namespace's binding `PREVIEW_APPS`, the public keys `PREVIEW_PUBLIC_KEYS` and the
// application host's origin `PREVIEW_ACCESS_ORIGIN`. Any one missing or malformed and previews are off: every preview
// host is not-found. They are public: the keys can check a token and never make one.
import { capFromSettings } from "./budget";
import { WriteCounter, writeCounter } from "./counter";
import { CODE_APPS_ENABLED, handle, type Previews, type StopMemory } from "./handle";
import { limitsFromSettings } from "./limits";
import { accessOriginFromSetting, publicKeysFromSetting, webCryptoKeys } from "./preview";

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
  /** The preview namespace (M8 step 8): bound only once the owner's wizard made it. */
  PREVIEW_APPS?: DispatchNamespace;
  /** The public keys a preview token is checked with: `<kid>:<64 hex>[,<kid>:<64 hex>]`. */
  PREVIEW_PUBLIC_KEYS?: unknown;
  /** The application host's origin, `https://<host>`, where a viewer with no session is sent for a ticket. */
  PREVIEW_ACCESS_ORIGIN?: unknown;
}

// One for each running copy of the Worker: what it last read of the stop.
const stop: StopMemory = { read: null };

// One for each running copy: previews as last read from the configuration, kept while its three settings are the same,
// so each public key is imported once.
let previewsKept: { binding: unknown; keys: unknown; origin: unknown; domain: string; previews: Previews | null } | null = null;

/** Previews, all three configured, or null. */
function previewsFrom(env: Env, domain: string): Previews | null {
  const kept = previewsKept;
  if (kept && kept.binding === env.PREVIEW_APPS && kept.keys === env.PREVIEW_PUBLIC_KEYS && kept.origin === env.PREVIEW_ACCESS_ORIGIN && kept.domain === domain) return kept.previews;
  const namespace = env.PREVIEW_APPS;
  const keys = publicKeysFromSetting(env.PREVIEW_PUBLIC_KEYS);
  const accessOrigin = accessOriginFromSetting(env.PREVIEW_ACCESS_ORIGIN, domain);
  const previews: Previews | null =
    namespace === undefined || namespace === null || keys === null || accessOrigin === null
      ? null
      : { apps: { get: (name, args, options) => namespace.get(name, args, options) }, keys: webCryptoKeys(keys), accessOrigin };
  previewsKept = { binding: env.PREVIEW_APPS, keys: env.PREVIEW_PUBLIC_KEYS, origin: env.PREVIEW_ACCESS_ORIGIN, domain, previews };
  return previews;
}

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    const domain = typeof env.CONTENT_DOMAIN === "string" ? env.CONTENT_DOMAIN : "";
    return handle(request, {
      entries: { get: (key, options) => env.SERVE.get(key, options) },
      apps: { get: (name, args, options) => env.APPS.get(name, args, options) },
      now: () => Date.now(),
      wait: (ms) => new Promise((done) => setTimeout(done, ms)),
      stop,
      // Anything but a string is no domain, and then every host is not-found.
      domain,
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
      // Previews: the preview namespace, the public keys and the application host's origin, or null while any is unset.
      previews: previewsFrom(env, domain),
      random: () => crypto.getRandomValues(new Uint8Array(32)),
    });
  },
} satisfies ExportedHandler<Env>;
