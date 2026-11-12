# M6 spike C: the content domain and its hosts

**Status, 2026-11-12 UTC: prepared, not run.** Nothing here has touched Cloudflare. It waits for spike A to finish and clean the namespace, and for the lead's go. Nothing builds on this folder. Its results go into the [M6 plan](../../docs/m6-plan.md#the-spikes), and what they change in [ADR 0010](../../docs/adr/0010-release-and-the-content-domain.md) is proposed there, not written into the ADR.

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
| `h-` | All of `w-`, plus a sandboxing CSP without `allow-same-origin`, `Set-Cookie` removed, and ADR 0010's fixed headers |

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
cd spikes/m6-content-domain && node upload.mjs --label a --app probe && node upload.mjs --label b --app probe && node upload.mjs --label plain --app plain
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

None yet.
