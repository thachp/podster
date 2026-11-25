# M6 spike H: the four items before code is turned on

**Status, 2026-11-24: ran twice** (runs `0d096b` and `295346`, 05:34 to 05:38 UTC on 2026-11-25), each exiting 0 with nothing left. Every property below held in both; item 3 has no positive control. The answers are in [the plan](../../docs/m6-plan.md#spike-h-results-2026-11-24); every line is in `results/run.jsonl`, one summary a run in `results/summary-<run>.json`.

It answers the four "before code is turned on" items that keep `CODE_RELEASES_COMPLETE` (`crates/core/src/app_code.rs`) false: [the gate for apps with code](../../docs/m6-plan.md#the-gate-for-apps-with-code-2026-11-23). Nothing builds on this folder. Results: [`results/`](results/) and the dated note in the plan.

## What it asks, and how

| # | Item | How |
| --- | --- | --- |
| 1 | **The marker's order:** is the static marker served before an app's script can answer its path? | Script `a` holds the marker (`/.well-known/podster-release.json`) and a page as assets, and one module that answers **every** path it is given, the marker's included, with JSON naming itself. It is written exactly as S3 writes a release with code: the API's fixed `ASSETS_CONFIG`, no binding, the API's query. Its host is read through the deployed content Worker with the marker job's own request (the exact path, `accept` and `cache-control: no-cache`) ten times, and once as `HEAD`. Asserted: every read is the asset's bytes; a path with no file reaches the module (so the module was live and would have answered); and a **control**, script `b`, the same with `run_worker_first: true` added (which Podster never sends), has its module answer the marker's path, so the test can see a module win when it does. Eight other spellings of the path are recorded, not judged: the marker job never asks them |
| 2 | **A real script's bindings with its store** | A throwaway D1 database is made with the store token. Script `d` is written bound to it exactly as `bindings_json` writes it (`{"type":"d1","name":"STORE","id":…}`), and its bindings are read with the scripts token at `…/scripts/<name>/bindings`, the path the reconcile reads, on its first read (in the 2026-11-24 runs about 15 to 19 s after the write, since the other scripts are written in between, so a shorter lag isn't tested) and again 10 s later. Asserted: exactly one entry, type `d1`, name `STORE`, the database's ID; the module, served, sees only `STORE` in its environment and reads `select 7` from it; and script `a`, with no binding, lists `[]` |
| 3 | **`fetch` and `connect()` through the outbound Worker** | Script `a`'s `/spike-h/outbound`, served through the content Worker, whose dispatch names `podster-outbound` as outbound, makes three `fetch`es (HTTPS, plain HTTP, a Cloudflare host) and three `connect()`s from `cloudflare:sockets` to hosts not behind Cloudflare (`google.com:80`, `8.8.8.8:53`, `neverssl.com:80`), writing a request and waiting for a byte. Asserted: each `fetch` gets exactly the outbound Worker's `403` and its fixed body; no socket opens or reads a byte. **A limit of that judge:** a socket that only timed out at `opened` would pass it too, so it can't tell a refusal from a host that never answered. In the 2026-11-24 runs every socket failed at once with the platform's own error, so the verdict holds for them |
| 4 | **The script write's query with modules** | The same module written four times, once under each query: both (`a`, the API's), none (`n`), `excludeScript=true` alone (`e`), `bindings_inherit=strict` alone (`s`). Asserted for each: the write is taken (`200`, success, the script's name), the module reads back from `…/content` with its tag, and its host serves that module. Then script `d` is written again with no binding under no query, bound again, and written again with no binding under strict: asserted each time that the host serves the new write (by its tag) with an empty environment and the bindings read `[]`, so no old binding survives a re-write. Recorded, not judged: what each write's answer holds, and an `inherit` binding on a script with no earlier version (`i`) under strict and under no query |

## What it can't show

- **The content Worker's code-apps switch is off,** so a host whose serve entry carries the code mark is answered `503 code_apps_off` and its script is never asked. The spike writes its serve entries **unmarked**, so the deployed content Worker dispatches `GET` and `HEAD` to each script as it does a static host's, through the same dispatch binding and outbound Worker. A write (`POST`) to an app isn't sent, and what the content Worker will do once it serves apps with code isn't built, so it isn't tested.
- **No positive control for sockets.** A dispatch without the outbound Worker would need a dispatch Worker of the spike's own, which this run doesn't make. Spike A, on the first account, saw a socket to a host not behind Cloudflare work with no outbound Worker and stop working with one.
- **One machine, one Cloudflare location, one day.** Platform behaviour may change; nothing here pins it.
- **The marker job's request is reproduced from a laptop,** not sent by the API's Worker. The path and headers are `content_provider::fetch_marker`'s.

## What it makes, and what it never touches

`node spike.mjs plan` prints the list with no network and no token. Every name carries the run's six hex digits:

- **One D1 database,** `spike-h-<run>` (not `podster-store-…`, so the store reconcile never counts it).
- **Up to seven dispatch scripts,** `spikeh<run><a|b|d|n|e|s|i>.rel_<32 hex>`, each with two assets and one module; script `d` is written four times under its one name.
- **Up to six serve entries,** `spikeh<run><a|b|d|n|e|s>.podster.site`, each naming its script, unmarked.

`guard.mjs` refuses anything else, reads included: the stop key is only read; no other key, script, Worker, database or zone is written; the two deployed Workers are only read for their deployments. It never deploys `podster-content` or `podster-outbound`.

**Clean-up,** on every way out: the serve entries first, then every spike script (listed and named), then the database. After 5 s each is read back (a key `404`/10009; a script `200` with `"script": null` or `404`/10007; a database `404`) and the three listings are read again. Exit 3 if anything is left. `node spike.mjs cleanup …` does the same on its own.

**Staging's reconciles may see the spike's names while it runs.** The second account's namespace and serve entries are staging's. The 5-minute reconcile of serve entries and the hourly one of scripts tell operators of an entry or script with no room and never remove it; a run lasts a few minutes.

## The tokens

Each is read from a file whose **path** is given on the command line, a plain file of mode 600 holding one token. The run of 2026-11-24 used the three release tokens the owner made for staging's content provider, since spike G's own tokens had been deleted, and no new token was made:

| Option | Token | Permission (per `docs/staging.md`) |
| --- | --- | --- |
| `--scripts-token-file` | `CONTENT_SCRIPTS_TOKEN`'s | Account: Workers Scripts: Edit, second account |
| `--kv-token-file` | `CONTENT_ROUTING_TOKEN`'s | Account: Workers KV Storage: Edit, second account |
| `--store-token-file` | `CONTENT_STORE_TOKEN`'s | Account: D1: Edit, second account |

`--config` is `~/.config/podster/content-deploy.json`: the account, the KV namespace, the dispatch namespace and `podster.site`. Nothing prints a token, an account or namespace ID, the namespace's name, or any 32-hex ID, UUID or JWT.

## Run it

```bash
node --test spikes/m6-spike-h/spike.test.mjs
```

```bash
cd spikes/m6-spike-h && node spike.mjs run --config <dir>/content-deploy.json --scripts-token-file <dir>/content-scripts.token --kv-token-file <dir>/content-routing.token --store-token-file <dir>/content-store.token
```

Bounds: 15 minutes, 300 API calls, 800 reads of the content domain; the clean-up 5 minutes and 120 calls. **Spend:** nothing beyond the subscriptions; a few hundred requests and a handful of KV writes, far inside Workers for Platforms' and Workers Paid's monthly amounts, and one empty D1 database for a few minutes.
