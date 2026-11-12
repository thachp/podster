# M6 spike C: the content domain and its hosts

**Status, 2026-11-12 UTC: run once, from 09:28 to 09:32 UTC, and cleaned up.** Every resource it created is deleted, confirmed by listing; the owner's wildcard DNS record and the architect's namespace are left. Nothing builds on this folder. Its results are below and in the [M6 plan](../../docs/m6-plan.md#spike-c-results); what they change in [ADR 0010](../../docs/adr/0010-release-and-the-content-domain.md) is proposed there, not written into the ADR.

It answers risks 6, 12 and 13 of the [M6 plan](../../docs/m6-plan.md#risks-to-test), and ADR 0010's open items 8 and 10:

- one wildcard route and one certificate serve arbitrary per-room hosts under `opster.dev`;
- a page on one host can't read or set `podster.dev`'s cookies;
- what one host's page can do to a sibling's, since `opster.dev` isn't on the Public Suffix List, and whether the dispatch Worker's headers close it: a sandboxing CSP and `Set-Cookie` stripped;
- whether refusing service-worker scripts stops registration, and what `Clear-Site-Data` on the not-found answer clears.

## What exists before it runs

- **The owner's wildcard DNS record** on `opster.dev`, added on 2026-11-12: `*` `AAAA` `100::`, proxied. Not this spike's; it stays.
- **The dispatch namespace** `podster-staging-apps`, created by the architect. Not this spike's; it stays.
- `opster.dev` is zone `73b83ff0bd4033b94710ce77a71bea74`, on the same account as `podster.dev`, on the Free plan.

## What it creates, all temporary, all named `spike-m6-c-…`

| Resource | Made by | Deleted by |
| --- | --- | --- |
| Worker `spike-m6-c-dispatch`, the namespace's dispatch Worker, with no binding but the namespace, no secret and no `workers.dev` address | `wrangler deploy` (below) | `cleanup.mjs --delete` |
| Route `*.opster.dev/*` to that Worker | the same deploy | `cleanup.mjs --delete`, before the Worker |
| Namespace scripts `spike-m6-c-a` and `spike-m6-c-b` (the probe app) and `spike-m6-c-plain` (an ordinary static app), static assets and no bindings | `upload.mjs` | `cleanup.mjs --delete` |

Every create and delete is appended to `results/ledger.jsonl`, names and IDs only. `cleanup.mjs` touches only names starting `spike-m6-c-` and routes whose script is `spike-m6-c-dispatch`, so spike A's resources and anything of Podster's are out of its reach. Nothing here touches `podster.dev`, Podster's own Workers, D1, KV, queues, R2 or secrets.

## Hosts

A host is `<mode><label>.opster.dev`, one level deep, and the label picks the script `spike-m6-c-<label>`. One app is served three ways, so each header can be compared with its absence:

| Prefix | What the dispatch Worker adds |
| --- | --- |
| none | Nothing: the app's answer as the namespace gave it |
| `w-` | Refuses a request carrying `Service-Worker: script`, and anything but `GET` and `HEAD` |
| `h-` | All of `w-`, plus a sandboxing CSP without `allow-same-origin` that names the host, `Set-Cookie` removed, ADR 0010's fixed headers, `no-transform` and `Access-Control-Allow-Origin: *` |

In every mode it answers two paths itself: `/__gone`, the not-found answer with `Clear-Site-Data: "cache", "cookies", "storage"`, and `/__echo-cookie`, the names, never the values, of the cookies a request carried. The logic is in [`dispatch/src/route.js`](dispatch/src/route.js), with no Cloudflare import, and `spike.test.mjs` checks it offline.

## Running it

Only after the lead's go. It needs the gateway's `wrangler` installed (`cd apps/gateway && npm ci`) and its existing login.

```bash
cd spikes/m6-content-domain && node --test spike.test.mjs
```

```bash
cd apps/gateway && CI=true CLOUDFLARE_ACCOUNT_ID=d8dfeaad2beaa38306233d81b93217d8 npx wrangler deploy --config ../../spikes/m6-content-domain/dispatch/wrangler.jsonc
```

```bash
cd spikes/m6-content-domain && node upload.mjs --label a --app probe --assets-only --headers-in-config && node upload.mjs --label b --app probe --assets-only --headers-in-config && node upload.mjs --label plain --app plain --assets-only --headers-in-config
```

`upload.mjs` takes `--assets-only` and `--headers-in-config` to follow whatever spike A found about scripts and `_headers`.

```bash
cd spikes/m6-content-domain && node hosts.mjs
```

```bash
cd spikes/m6-content-domain && node browser.mjs --browser=chromium
```

```bash
cd spikes/m6-content-domain && node cleanup.mjs --delete
```

`cleanup.mjs` without `--delete` only lists. With it, it deletes, lists again and exits 0 only when nothing of this spike's is left.

## Which facts come from where

- **`hosts.mjs`, headers only:** certificates on random first-level hosts and on a second-level one; the route on arbitrary hosts; an unknown label; `_headers`' `Set-Cookie` with and without the hardened headers; the service-worker and method refusals; that a Podster-looking cookie and an `Authorization` header change nothing.
- **`browser.mjs`, in a real browser** (Playwright's Chromium, and Firefox or WebKit if installed), with the allow-listed environment from `e2e/child-env.mjs`: a `podster.dev` cookie seeded into the browser's own jar and never sent anywhere; cookies set on `opster.dev` from one host and read, sent and overwritten by a sibling; what the sandboxing CSP refuses; service-worker registration; what `Clear-Site-Data` clears on its own host and on a sibling's; what the sandbox breaks in an ordinary static app.

## Results

**Run on 2026-11-12, 09:28 to 09:32 UTC,** on the account that holds `podster.dev`, from the owner's Mac. The dispatch Worker was deployed three times while the run went on; every result below is from its last version, `bda214b0-09f2-438d-93c0-9560ebc5df73`, and the recorded files in [`results/`](results) are that version's. It built on [spike A](../m6-namespace-app/README.md): the apps were uploaded assets-only, and `_headers` went in `assets.config`, as wrangler sends it.

**Which header came from where.** Every test of the dispatch Worker's headers used the dispatch Worker (`route.js`). The one header test of the app's own headers, `/hdr`'s `Set-Cookie` and `X-Spike-From-Headers`, used the probe app's `_headers`, sent deliberately in `assets.config`.

### Shown by headers only (`hosts.mjs`, Node's `fetch` and TLS)

| What | Answer |
| --- | --- |
| A certificate for random first-level hosts | Yes. One Let's Encrypt certificate, names `*.opster.dev` and `opster.dev` only, for every host tried |
| A second-level host, `x.<random>.opster.dev` | TLS handshake failure. Hosts must be one level deep |
| One route, `*.opster.dev/*`, on arbitrary hosts | Reached the dispatch Worker every time, about 140 to 250 ms from the Mac |
| A label with no script | The namespace's `fetch` rejected with "Worker not found.", as spike A found; the spike's Worker answered 502 |
| A host outside the label rule (`bad_label`) | The dispatch Worker's own 404 |
| The app's `_headers`, sent in `assets.config` | Applied: `/hdr` carried its `Set-Cookie` and `X-Spike-From-Headers`. The rule matches the served path, `/hdr`, and not the file's name, `/hdr.html`; the first upload used the file's name and the rule didn't apply |
| The hardened mode, which removes `Set-Cookie` by name | `Set-Cookie` gone, and **`X-Spike-From-Headers` still passed through.** Removing headers by name isn't an allow-list |
| A request with `Service-Worker: script` | 403 in the `w-` and `h-` modes; the same path without that header 200 |
| `POST` in the hardened mode | 405 |
| The not-found answer | 404 with `Clear-Site-Data: "cache", "cookies", "storage"` and `no-store` |
| A Podster-looking session cookie and an `Authorization` header | The same answer as without |
| **Cloudflare's Web Analytics beacon** | **Injected into every app's HTML** when the request's `Accept` is `text/html`, as browsers send it, and not with `*/*`: the same zone behaviour M4 found on `podster.dev`. With `no-transform` in the dispatch Worker's `Cache-Control`, it wasn't injected for either |

**Uploads, timed by the script:** a first upload of 4 or 5 files took 4.6 to 5.1 seconds, in five calls. **The second app had the same files as the first and still had to send all of them:** a session names the files its own script lacks, so files aren't shared between scripts. Uploading the same files again to the same script took two calls and about 2 seconds, with no file sent. A replace was seen on the first or second read, within about 2 seconds; a change of the dispatch Worker was seen within about 2 seconds. Each `wrangler deploy` of the dispatch Worker replaced its route, under a new ID.

### Shown in a browser (`browser.mjs`)

Playwright 1.64.1's own builds of Chromium, Firefox and WebKit, headless, each test in a fresh profile, with the allow-listed environment from `e2e/child-env.mjs`. Not branded Chrome, Firefox or Safari, and no mobile browser.

| What | Chromium | Firefox | WebKit |
| --- | --- | --- | --- |
| A `podster.dev` cookie in the browser's jar, read or sent on `a.opster.dev` | No | No | No |
| `document.cookie = "…; domain=podster.dev"` from `a.opster.dev` | Silently ignored; the jar unchanged | Same | Same |
| A `domain=opster.dev` cookie set by script on `a`, read by script on `b` and sent to `b` | Yes | Yes | Yes |
| `b` overwrites that cookie, and `a` then reads `b`'s value | Yes | Yes | Yes |
| `localStorage` shared between `a` and `b` | No | No | No |
| A hardened page's origin | `null` | `null` | `null` |
| On a hardened page: `document.cookie`, `localStorage`, the Cache API, registering a service worker | Each refused, `SecurityError` | Same | Same |
| A hardened page's `_headers` `Set-Cookie` | Stripped; no cookie | Same | Same |
| A service worker registered on a raw host | Registered, and served the next load | Registered; **not seen serving the next load** | Registered, and served the next load |
| Registering where the dispatch Worker refuses the script (`w-`) | Refused, `TypeError`; none registered | Same | Same |
| `Clear-Site-Data` on the not-found answer: the host's own cookie, `localStorage`, Cache API | Cleared | Cleared | Cleared |
| … the service worker | Unregistered | Unregistered | **Still registered and still serving** |
| … a `domain=opster.dev` cookie | Cleared | **Kept** | **Kept** |
| … the sibling host `b`'s own cookie | **Cleared** | Kept | Kept |
| An ordinary static app (module script, `fetch` of JSON, CSS, an image, `history`) without the sandbox | All work | All work | All work |
| The same app under the first sandboxing CSP: `'self'` sources and no CORS header | **Broken:** its module script was refused, since a sandboxed page's origin is `null` | Same | Same |
| The same app under the final CSP: the host named instead of `'self'`, and `Access-Control-Allow-Origin: *` | Script, `fetch`, CSS, image and `history` work; `localStorage`, `sessionStorage` and IndexedDB refused | Same | Same |

**Not shown:** whether a hardened page's own `fetch` carries the parent-domain cookie. The spike's `/__echo-cookie` sent no CORS header, so the sandboxed page's `fetch` of it failed with `TypeError` in all three: a gap in the test, not a finding. Firefox's service worker not serving the next load may be Playwright's Firefox and not Firefox; it wasn't looked into.

### Resources

| Resource | Created | Deleted |
| --- | --- | --- |
| Worker `spike-m6-c-dispatch`, versions `2b5e41fd-…`, `0fb7fbeb-…` and `bda214b0-…` | 09:28:03 UTC | 09:31:58 UTC |
| Route `*.opster.dev/*` on that Worker, ID `cca5e9fcf7ea494b9d67c1c14fe2e0c4`, replaced on each redeploy, last `9691d560a94e4e779bbfddd381a2e3cc` | 09:28:04 UTC | 09:31:57 UTC |
| Namespace scripts `spike-m6-c-a`, `spike-m6-c-b` and `spike-m6-c-plain`, each uploaded twice | 09:28:15 UTC | 09:31:57 UTC |

**Confirmed by listing after the delete:** the namespace's script list held no `spike-m6-c-` script and its `script_count` was 0; the zone had no Worker route; the account's Workers were Podster's six, with no `spike-m6` one; the hosts answered 522 again. **Left on purpose:** the owner's wildcard DNS record and the architect's namespace `podster-staging-apps`. **Only read:** the zone's details and routes, the namespace, and the account's list of Workers. The ledger is [`results/ledger.jsonl`](results/ledger.jsonl), names and IDs only; the second upload of each script is logged as "created", since the script reports what the API did and the API doesn't say "replaced".
