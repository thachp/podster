# M8 spike P1: browser facts for the preview gate

**Status, 2026-11-27: run locally, once for each engine, in Playwright's Chromium, Firefox and WebKit.** Nothing was deployed. No DNS, Cloudflare account, staging resource or secret was touched. Nothing builds on this folder: the real gate is M8 step 8. The results are in [the plan's spike P1 section](../../docs/m8-preview-plan.md#spike-p1-results-2026-11-27), and every value is in `results/<browser>.json`.

It answers the browser half of [M8 build step 2](../../docs/m8-preview-plan.md#12-build-order), the facts that [section 5](../../docs/m8-preview-plan.md#5-access-control-on-preview-hosts) of the plan reasons about without having seen them.

## How it runs, and why that's honest enough

- `server.mjs` starts one HTTPS server on `127.0.0.1` with a self-signed certificate for `*.pv.test`, `*.ap.test` and `*.other.test`, made for the run. It also starts an HTTP proxy that sends every `CONNECT` to that server. The browser is launched with the proxy and told to accept the certificate. So these are real TLS connections, with the browser's own cookie jar, SameSite logic, fetch metadata and CSP, to names that resolve nowhere.
- `.test` isn't on the Public Suffix List, so by the list's default rule `pv.test` is one registrable domain. Its hosts are then one site, as `*.podster.site` hosts are before the entry:

  | Host | Plays |
  | --- | --- |
  | `a.pv.test`, `b.pv.test` | a preview and its sibling, a hostile preview on the same domain |
  | `g.pv.test` | a preview behind a working stand-in of the plan's gate (5.3): state cookie, `303` to the application host, ticket in a fragment, the fixed exchange page under its CSP and COOP, the same-origin `POST`, and the session bound to the state on every request |
  | `app.ap.test` | the application host, another site, with a stand-in `__Host-` session cookie |
  | `x.other.test` | an unrelated site to start a flow from |

- `pure.mjs` holds the stand-in's pure pieces: exact cookie-name matching, the token checks, the return-path rule, and production's CSP copied from `apps/content/src/handle.ts`. The preview policy is that CSP plus `allow-same-origin`. Tokens here are HMAC, not the plan's Ed25519. Which signature is used isn't a browser fact. `spike.test.mjs` checks these pieces offline.
- Each browser is started with the allow-listed environment from `e2e/child-env.mjs` and an empty temporary `HOME`. Nothing is downloaded.

```bash
cd e2e && npm ci --ignore-scripts
```

```bash
node --test spikes/m8-preview-access/spike.test.mjs
```

```bash
cd spikes/m8-preview-access && for b in chromium firefox webkit; do node spike.mjs --browser=$b; done
```

## What this can't show, and what needs the owner's deploy

These are the parts left for the owner, if wanted. Each one needs a test Worker on `podster.site`, which is the content zone on the second account, as spike D had. **None of it was done here.**

1. **The real edge.** Is anything injected into the exchange page or a preview's answers (spike C saw an analytics beacon), which would break the exchange page's hash-only `script-src`? Does `no-transform` stop it? Are `Set-Cookie`, `Location` with a fragment, COOP and `Origin-Agent-Cluster` passed unchanged?
2. **Cookie bombing's size.** At what size of a domain's cookies does Cloudflare refuse a request to every `*.podster.site` host (the plan's 5.5 residual)? Only the edge can show its own header limit.
3. **A real certificate.** This run accepted a self-signed one. No result here looked like it depended on that, since the `__Host-` cookies were stored and sent as on a trusted origin, but only real TLS shows it.
4. **Safari's tracking prevention.** Playwright's WebKit isn't Safari, and ITP's bounce-tracking classification builds up over days. What's shown here is that WebKit's engine stores and sends a cookie set on a `303` partway through a cross-site redirect chain. Whether Safari classifies `app.podster.dev` or a preview host as a bounce tracker isn't shown. It needs real Safari against deployed hosts. Pointing Safari at this local proxy would change the machine's network settings, so it wasn't tried.

Nothing in 1 to 4 blocks M8 steps 3 to 7. The plan's step 12 staging run covers 1 and 3 once step 8 is deployed, so the owner may choose to skip the test Worker.

## Results

[Spike P1 results](../../docs/m8-preview-plan.md#spike-p1-results-2026-11-27) in the plan has the table, and `results/<browser>.json` has every value. In short, the three engines differ in four places:

- WebKit stores and sends a sibling's case-variant `__HOST-` cookie.
- Chromium and Firefox evict Podster's pair after 179 Secure domain cookies. WebKit didn't at 1,000.
- Firefox and WebKit send `Origin: null` on a no-CORS `POST` under `no-referrer`.
- Firefox and WebKit join sibling pages through `document.domain` unless `Origin-Agent-Cluster: ?1` is sent.

*An earlier Chromium run, before `settle` was added, read the jar while `document.cookie` writes were still landing, so its eviction counts were wrong. It isn't kept.*
