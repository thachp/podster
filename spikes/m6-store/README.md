# M6 stage 1: the store spike

**Status, 2026-11-16 UTC: run twice on the staging account, 13:39:14 to 13:40:16 and 13:41:26 to 13:43:48, by the owner's yes of 2026-11-16 ("run_store_spike: yes"). Everything it created is deleted, confirmed by listing with the read token.** It answers the spike in the [M6 plan](../../docs/m6-plan.md#first-the-spike-for-a-store-and-its-credential), for [the revision of ADR 0010](../../docs/adr/0010-revision-apps-are-workers.md#33-its-store). The answers and what they change are in the plan's [Store spike results](../../docs/m6-plan.md#store-spike-results-2026-11-16). Nothing builds on this folder.

**Beyond the approved scope.** The owner approved KV namespaces, a D1 database and scripts in the namespace, and the brief said to record the Durable Object measurement as owed rather than add a class. Each run also made **a public account-level Worker on the account's `workers.dev` address with a Durable Object class** (`SpikeCounter`), the spike's dispatch Worker, and in the second run **the apps fetched `https://example.com/`** (three `HEAD` requests each) as the subrequest limit's control. Those Workers existed from 13:39:36 to 13:40:12 UTC (run `370d26`) and from 13:41:29 to 13:43:46 UTC (run `80cd35`); each answered only requests carrying a random key held in the runner's memory. Both were deleted, their class first by a migration, and no Durable Object namespace was left (see Resources). **The runner no longer makes that Worker unless `SPIKE_STORE_PUBLIC_WORKER=owner-approved` is set, which needs the owner's own yes for that run;** without it the steps that need the apps (3 and 4 below, and `limits`) are skipped. The second account's repeat doesn't include them without that yes.

"The staging account" is the Cloudflare account that holds `podster.dev` and the dispatch namespace `podster-staging-apps`. Its ID stays out of this repository.

## What is here

| Path | What it is |
| --- | --- |
| `spike.mjs` | The runner. `run` is the whole spike; `limits` is the second, shorter run; `cleanup` deletes by listing |
| `guard.mjs`, `guard.test.mjs` | What the runner may send to Cloudflare, and an offline test of it |
| `results/results.jsonl` | Every call of both runs, redacted. Run `370d26` is `run`; run `80cd35` is `limits` |

## How it calls Cloudflare

- **One function sends every API request, and it asks `guard.mjs` first.** A `GET` may go anywhere on Cloudflare's API. Anything else must name something the spike made:
  - a script named `^spike-store-[a-z0-9-]{1,40}$`, in `podster-staging-apps` or at account level, and that script's `workers.dev` switch;
  - a KV namespace or D1 database whose ID the runner holds because a create with a spike title or name returned it, or because a listing showed it with a spike title or name;
  - a create, only when the body is exactly `{"title": <spike name>}` or `{"name": <spike name>}`;
  - a KV value, only under a spike-named key, in a namespace the spike made.
- **An upload's metadata is checked too, since 2026-11-16 after the runs.** A script's upload is refused unless every binding is a KV namespace or D1 database the spike made, or, at account level only, the staging namespace or the class `SpikeCounter`; and unless its migrations create or delete only `SpikeCounter`. Any other metadata key, binding type or migration kind is refused. `guard.test.mjs` covers a foreign KV ID, a foreign D1 ID and a class that isn't the spike's.
- **During both runs the guard checked a script's upload by its URL alone, not its metadata.** What the uploads bound came from the runner's own code, which bound only the spike's stores, the staging namespace and `SpikeCounter`; the guard would not have stopped a binding to anything else.
- **No write was sent to anything of Podster's,** by the paths recorded in `results.jsonl` and the runner's code. What a token can do to Podster's own stores is **inferred**, never observed on them. The `GET`s the runner makes are lists, kept as counts, and reads of what it made.
- **The tokens are read from the owner's files into memory** (`~/.podster/spike-store-{kv,d1,scripts,read}.token`, mode 600), sent in a header and nowhere else. The account ID comes from `CLOUDFLARE_ACCOUNT_ID`.
- **What is kept:** status, Cloudflare's codes and messages, counts, and what the spike's own apps answered. Every 32-hex ID, every UUID, the account, the `workers.dev` subdomain and the dispatch Worker's access key are redacted before anything is written or printed.
- **The apps run behind a dispatch Worker of the spike's own,** `spike-store-<run>-dispatch`, at account level on the account's `workers.dev` address, as spike A's was. It answers only a request carrying a random key the runner held in memory, and dispatches only to spike-named scripts. It holds the Durable Object class `SpikeCounter`, the stand-in for the write counter, so no real Worker got a class. The class was deleted by a migration before the Worker was.
- **The apps make no outbound request** except the subrequest limit's control in run `80cd35`: three `HEAD` requests to `https://example.com/` from each app.

## Run it again

It makes KV namespaces, D1 databases and scripts in the namespace, so it needs the owner's yes each time, and the owner's four tokens. The public dispatch Worker with its Durable Object class, and the apps' fetch of `example.com`, run only with `SPIKE_STORE_PUBLIC_WORKER=owner-approved` set, for a run the owner has said yes to by name.

```bash
node --test spikes/m6-store/guard.test.mjs
```

```bash
cd spikes/m6-store && CLOUDFLARE_ACCOUNT_ID="$(cat ~/.podster/cloudflare-account-id.staging)" node spike.mjs run
```

```bash
cd spikes/m6-store && CLOUDFLARE_ACCOUNT_ID="$(cat ~/.podster/cloudflare-account-id.staging)" node spike.mjs limits
```

Each ends with the clean-up, in a `finally`. To run it alone:

```bash
cd spikes/m6-store && CLOUDFLARE_ACCOUNT_ID="$(cat ~/.podster/cloudflare-account-id.staging)" node spike.mjs cleanup
```

It lists, with the read token (or the writing token if the read token can't list), every account Worker, namespace script, KV namespace and D1 database named `spike-store-…`, in that order, and deletes each with the token that can. An account Worker that still holds `SpikeCounter` has the class deleted by a migration first, and is then deleted with `?force=true`. **Each listing and each delete stands alone:** one that fails is recorded and the rest still run, and a closing record, `clean-up: NOT everything was deleted`, lists what it couldn't delete. It ends by listing again and recording the counts left, Durable Object namespaces included.

**A Durable Object namespace can't be deleted on its own.** Cloudflare's documentation shows no API call for it: it goes when its class is deleted by a migration on its own script, or with its script. If one is ever left after its script is gone, the clean-up reports it; a person removes it by uploading a script of that name with a migration that deletes the class, or through Cloudflare's support. None was left by either run.

*Changed after both runs, not rerun:* the reads that ask whether a deleted namespace script is there now keep whether the answer's `script` is `null` (the runs recorded only the status, which is 200 either way; see 5 below); the guard checks an upload's metadata; the clean-up stands each step alone and retires a leftover class; and the public Worker needs `SPIKE_STORE_PUBLIC_WORKER`. Only `guard.test.mjs` has run since.

## What was observed

The tokens, as the brief named them: `kv` has Workers Scripts Edit and Workers KV Storage Edit; `d1` has Workers Scripts Edit and D1 Edit; `scripts` has Workers Scripts Edit alone; `read` has Workers Scripts, KV and D1 Read. Each verified `active`, with an expiry, as a user token. None is an account-owned token (`/accounts/…/tokens/verify` answered 401, code 1000). The owner's note on scoping: "KV/D1 permission limitable to named namespaces/databases: unsure".

Status, with Cloudflare's code in brackets.

### 1. Who reaches which store

| Operation | `kv` | `d1` | `scripts` | `read` |
| --- | --- | --- | --- | --- |
| List KV namespaces | 200 | 401 (10000) | 401 (10000) | 200 |
| Make a KV namespace | **200** | 401 (10000) | 401 (10000) | 401 (10000) |
| Write a key in `kv-a`, which `kv` made | 200 | 401 (10000) | 401 (10000) | 401 (10000) |
| Read a key in `kv-a` | 200 | 401 (10000) | 401 (10000) | **200** |
| Delete `kv-b`, which `kv` made | 200 | 401 (10000) | 401 (10000) | 401 (10000) |
| Write a key in `kv-gone`, deleted | **404 (10013)** | 401 (10000) | 401 (10000) | 401 (10000) |
| List D1 databases | 401 (10000) | 200 | 401 (10000) | 200 |
| Make a D1 database | 401 (10000) | **200** | 401 (10000) | 401 (10000) |
| Insert a row in `d1-a`, which `d1` made | 403 (7403) | 200 | 403 (7403) | 400 (7500) |
| Select from `d1-a` | 403 (7403) | 200 | 403 (7403) | **200** |
| Delete `d1-b`, which `d1` made | 401 (10000) | 200 | 401 (10000) | 401 (10000) |
| Query `d1-gone`, deleted | 403 (7403) | **404 (7404)** | 403 (7403) | 404 (7404) |

- **No other token could make a KV namespace or a D1 database,** so "a store another token made" could not be built for `kv` against KV, or for `d1` against D1. Each wrote only in stores it had made itself, including its own second one.
- **The probe that stands in for it:** against a store that no longer exists, a token with the store's permission is told "not found", and every token without it "Authentication error". So the permission is checked before the store's ID is looked at. **That it holds for any ID in the account is inferred** from one deleted ID per kind (`kv-gone`, `d1-gone`, each made by the spike), not observed on any other store.
- **Before the run the account held one KV namespace and two D1 databases that aren't the spike's.** `kv` and `read` listed the first, `d1` and `read` the two. Nothing was sent to any of them. The counts were the same at the end.

### 2. Binding a store at an upload

Each token uploaded a script into `podster-staging-apps` binding, as `STORE`, a KV namespace, a D1 database, and each of those after it was deleted.

| Binding | `kv` | `d1` | `scripts` | `read` |
| --- | --- | --- | --- | --- |
| `kv-a` | 200 | 200 | **200** | 403 (none) |
| `d1-a` | 200 | 200 | **200** | 403 (none) |
| `kv-gone`, deleted | 400 (10041) | 400 (10041) | 400 (10041) | 403 (none) |
| `d1-gone`, deleted | 400 (10181) | 400 (10181) | 400 (10181) | 403 (none) |

"none" is `No access to the specified resource.` with no code. 10041 says the KV namespace wasn't found, 10181 the D1 database. The `read` token's bindings list showed `kv_namespace:STORE` or `d1:STORE` in nine of the twelve reads made straight after an upload; two answered 404 (10007) and one an empty list, which looks like the read lagging the upload.

### 3. What an app's code sees

Four apps, each uploaded by `scripts` with one store, called through the dispatch Worker:

| | `app-kv-a`, `app-kv-b` | `app-d1-a`, `app-d1-b` |
| --- | --- | --- |
| `Object.keys(env)` | `["STORE"]` | `["STORE"]` |
| The store | `KvNamespace`: `delete`, `get`, `getWithMetadata`, `list`, `put` | `D1Database`: `batch`, `dump`, `exec`, `prepare`, `query`, `withSession` |
| Its keys or rows, by marker | `a`: `marker-a` only. `b`: `marker-b` and `from-kv` only | `a`: `marker-a` only. `b`: `marker-b` only |
| Other | | Tables `_cf_KV` and `t`. `PRAGMA database_list` and `ATTACH DATABASE` refused: `D1_ERROR: not authorized: SQLITE_AUTH` |

`caches.default` was reported as an object; nothing was put in it. KV's list didn't show the app's own writes made seconds before (one key listed, after 52 writes); D1's did (53 rows: the marker and 52 writes).

### 4. The subrequest limit, and what a write costs

The dispatch Worker set `limits: { subRequests: N }` on each call.

| Under the limit | KV app | D1 app |
| --- | --- | --- |
| 3 writes, `subRequests` 1, 2 or 3 | 3 of 3 written, each time | 3 of 3 written, each time |
| 10 writes, `subRequests` 1 | **10 of 10** | **10 of 10** |
| Control: 3 `fetch()`es, `subRequests` 1 | 1, then `Too many subrequests by single Worker invocation` | the same |
| Control: 3 `fetch()`es, `subRequests` 2 | 2, then the same | the same |
| Control: 3 `fetch()`es, no limit | 3 | 3 |

One write, 20 samples each, from one client through one Cloudflare location, timed inside the Workers:

| | KV `put` | D1 `INSERT` |
| --- | --- | --- |
| The write, inside the app, median | 227 ms | 40 ms |
| The whole dispatch, median | 236 ms | 48 ms |
| Rows written, from D1's `meta` | | 2 (the row and its primary key's index) |
| D1's own `duration`, median | | 0.23 ms |
| **With the counter first:** the Durable Object's `count()`, median | 41 ms | 67 ms |
| The same, slowest of 20 | 205 ms | 313 ms |

The counter is a SQLite-backed Durable Object, one per app by name, doing a storage `get` and `put` per call.

### 5. Deleting, and telling it's gone

| | KV namespace | D1 database | Namespace script |
| --- | --- | --- | --- |
| Delete, by its own token | 200 | 200 | 200 (`scripts`) |
| Read it with `read` afterwards | 404 (10013) | 404 (7404) | **200, with `"script": null`** |
| Delete it again | 404 (10013) | 404 (7404) | not tried |
| In the list afterwards | gone | gone | gone |

A namespace script's read answers 200 with `"script": null` both for a script just deleted and for a name never used; this was checked by hand after the runs, with the read token, on one of each. The runs recorded only the 200. The account-level dispatch Worker, once deleted, read 404 (10222 in the first run, 10007 in the second).

## Resources

- **Run `370d26`:** KV namespaces `kv-a`, `kv-b`, `kv-gone`; D1 databases `d1-a`, `d1-b`, `d1-gone`; namespace scripts `bind-kv-kv`, `bind-kv-d1`, `bind-d1-kv`, `bind-d1-d1`, `bind-scripts-kv`, `bind-scripts-d1`, `app-kv-a`, `app-kv-b`, `app-d1-a`, `app-d1-b`; the account Worker `dispatch` with the class `SpikeCounter` and a `workers.dev` address. Each name carried the prefix `spike-store-370d26-`.
- **Run `80cd35`:** `kv-a`, `d1-a`, `app-kv-a`, `app-d1-a` and `dispatch` with its class, under `spike-store-80cd35-`.
- **Deleted:** all of them, each by its own call, and the clean-up found nothing left to delete. **Confirmed by listing with the read token** at 13:40:16 and 13:43:48 UTC: no KV namespace, D1 database, namespace script, account Worker or Durable Object namespace named `spike-store-…`; one KV namespace and two D1 databases on the account, as before.
- **Not touched:** any of Podster's Workers, stores, secrets, routes or DNS. No token was made.
- **Left:** the owner's four token files and `spike-store-scoping-answer.txt` under `~/.podster`, and the tokens themselves, **which the owner should now revoke and delete.**
