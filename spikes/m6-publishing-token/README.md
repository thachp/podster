# M6 spike B: the publishing token's scope

**Status, 2026-11-12 UTC: run on staging's Cloudflare account between 11:21 and 11:24 UTC, with three short-lived tokens the owner made. Everything it created is deleted.** It answers spike B in the [M6 plan](../../docs/m6-plan.md#the-spikes) and risk 3, for [ADR 0010](../../docs/adr/0010-release-and-the-content-domain.md#credentials). The answers, and what they mean for one account or two, are in the plan's [spike B results](../../docs/m6-plan.md#spike-b-results). This file says how it was run, how to run it again and how to clean up.

**The question.** What is the narrowest Cloudflare API token that can upload to and delete from the dispatch namespace `podster-staging-apps`, and can that token touch the account's other Workers?

**The short answer.** Of the three tokens, only "Workers Scripts Edit" could publish and unpublish, and it could also replace, delete and create ordinary Workers on the account. The narrower token couldn't write to the namespace at all, and still replaced an ordinary Worker's code.

## What is here

| Path | What it is |
| --- | --- |
| `guard.mjs`, `guard.test.mjs` | Which requests may be sent at all, and an offline test of it |
| `spike.mjs` | The runner. `run` does everything for each token and then cleans up; `cleanup` cleans up alone |
| `results/results.jsonl` | Every call of the recorded run: who made it, the method, the path, the status and Cloudflare's error codes |
| `package.json`, `package-lock.json` | Wrangler 4.157.0, used only to read the existing login |

## The rules it runs under

**This spike holds a token that can change every Worker on the account.** So:

- **One function sends every request, and `guard.mjs` is asked first.** A GET to `https://api.cloudflare.com/client/v4/…` is allowed. Anything else is refused before it is sent unless it names a script matching `^spike-m6-b-[a-z0-9-]{1,40}$`:
  - `PUT` or `DELETE` of that script, in the namespace `podster-staging-apps` or at account level;
  - `POST` of that script's `assets-upload-session` in the namespace.

  The namespace is a literal. `PATCH`, a script's secrets, settings, routes and every other resource are refused. So is a URL that isn't already in the form it is sent in, which covers `..`, `%`, a doubled `/` and a query other than `?force=true` on a delete.
- **Podster's own Workers are read with GET only,** and only the status and Cloudflare's error codes are kept. No name of a secret, no setting and no code is recorded or printed.
- **"Can this token change Podster's Workers" is answered on a canary:** `spike-m6-b-canary`, an ordinary Worker with no binding, no route and its `workers.dev` address off, made with the existing `wrangler login`. What a token can do to the canary it can do to any Worker on the account. That is an inference: no write was sent to one of Podster's Workers.
- **Tokens stay in memory.** The runner parses the owner's file itself, sends each token in a header and nowhere else, and refuses a file that isn't mode 600. A redirect is an error, so a token can't follow one to another host.
- **Nothing that names the account is kept.** The account ID, zone IDs, any other 32-digit ID, an email and a `workers.dev` subdomain are replaced before a line is written or shown.
- **Wrangler is started once per run,** for `wrangler auth token --json`, with the allow-listed environment of [`e2e/child-env.mjs`](../../e2e/child-env.mjs) plus exactly `CLOUDFLARE_ACCOUNT_ID`. Its log sanitizing is never turned off. The login makes the canary, makes a script for a token that couldn't upload its own, looks up the zones' IDs, reads back what a token did and cleans up. As [spike C](../m6-content-domain/README.md) did.

## The tokens

Three user API tokens, made by the owner in the dashboard on 2026-11-12, each with an expiry:

| Called here | What the owner gave it |
| --- | --- |
| `edit` | Account → Workers Scripts → Edit |
| `read` | Account → Workers Scripts → Read. The control |
| `narrow` | A narrower permission the dashboard offered. The owner typed its name as "developer platform", and **its exact name isn't known here**: no token could read its own permissions, and neither could the login (403, code 9109) |

Which accounts and zones each token's resources cover also isn't known here. Only the dashboard shows it.

## What was observed

Status, and Cloudflare's error code in brackets where the answer carried one. "none" means the refusal had a message, `No access to the specified resource.`, and no code.

| | Call | `read` | `narrow` | `edit` |
| --- | --- | --- | --- | --- |
| **a. The token** | | | | |
| Verify | `GET /user/tokens/verify` | 200, active, expiry set | 200, active, expiry set | 200, active, expiry set |
| Verify as an account token | `GET /accounts/<account>/tokens/verify` | 401 (1000) | 401 (1000) | 401 (1000) |
| Read its own permissions | `GET /user/tokens/<id>` | 403 (9109) | 403 (9109) | 403 (9109) |
| **b. The namespace** | | | | |
| Read the namespace | `GET …/dispatch/namespaces/podster-staging-apps` | 200 | 200 | 200 |
| List its scripts | `GET …/scripts` | 200 | 200 | 200 |
| Start an assets upload session | `POST …/scripts/<name>/assets-upload-session` | 403 (none) | 403 (none) | **200**, a session token given |
| Upload a script | `PUT …/scripts/<name>` | 403 (none) | 403 (none) | **200** |
| Replace a script that exists | `PUT …/scripts/<name>` | 403 (none) | 403 (none) | **200** |
| Read the script | `GET …/scripts/<name>` | 200 | 200 | 200 |
| Read its code | `GET …/scripts/<name>/content` | 200 | 200 | 200 |
| Delete the script | `DELETE …/scripts/<name>?force=true` | 403 (none) | 403 (none) | **200** |
| **c. The canary, an ordinary Worker** | | | | |
| Read settings | `GET /workers/scripts/<canary>/settings` | 200 | 200 | 200 |
| Read its code | `GET …/content/v2` | 200 | 200 | 200 |
| List versions | `GET …/versions` | 200 | 200 | 200 |
| List cron triggers | `GET …/schedules` | 200 | 200 | 200 |
| List secrets | `GET …/secrets` | 200, none | 200, none | 200, none |
| List tails | `GET …/tails` | 403 (none) | 200 | 200 |
| **Replace its code** | `PUT /workers/scripts/<canary>` | 403 (none) | **200** | **200** |
| **Delete it** | `DELETE /workers/scripts/<canary>?force=true` | 403 (none) | 403 (none) | **200** |
| **d. A new ordinary Worker** | | | | |
| Create | `PUT /workers/scripts/spike-m6-b-new-<which>` | 403 (none) | 403 (none) | **200** |
| Delete | `DELETE` of the same | 403 (none) | 403 (none) | **200** |
| **e. Reading elsewhere, GET only** | | | | |
| List the account's Workers | `GET /workers/scripts` | 200 | 200 | 200 |
| `podster-api-staging`: settings | `GET …/settings` | 200 | 200 | 200 |
| `podster-api-staging`: secrets' names | `GET …/secrets` | 200 | 200 | 200 |
| `podster-api-staging`: code | `GET …/content/v2` | 200 | 200 | 200 |
| List zones | `GET /zones` | 200 | 200 | 200 |
| `opster.dev`: Workers routes | `GET /zones/<zone>/workers/routes` | 403 (none) | 200 | 403 (none) |
| `podster.dev`: Workers routes | the same | 403 (none) | 200 | 200 |
| Either zone: DNS records | `GET /zones/<zone>/dns_records` | 403 (10000) | 403 (10000) | 403 (10000) |
| Either zone: custom hostnames | `GET /zones/<zone>/custom_hostnames` | 403 (10000) | 403 (10000) | 403 (10000) |
| List D1 databases | `GET /d1/database` | 401 (10000) | 401 (10000) | 401 (10000) |
| List KV namespaces | `GET /storage/kv/namespaces` | 401 (10000) | 401 (10000) | 401 (10000) |
| List R2 buckets | `GET /r2/buckets` | 403 (10000) | 403 (10000) | 403 (10000) |
| List queues | `GET /queues` | 200 | 200 | 200 |
| List Durable Object namespaces | `GET /workers/durable_objects/namespaces` | 200 | 200 | 200 |
| List Workers custom domains | `GET /workers/domains` | 200 | 200 | 200 |
| Read the `workers.dev` subdomain | `GET /workers/subdomain` | 200 | 200 | 200 |
| List dispatch namespaces | `GET /workers/dispatch/namespaces` | 200, one | 200, one | 200, one |
| Read the account | `GET /accounts/<account>` | 200 | 200 | 200 |
| List the account's members | `GET /accounts/<account>/members` | 403 (10000) | 403 (10000) | 403 (10000) |
| Pages projects, Hyperdrive, Secrets Store | three lists | 403 (10000) | 403 (10000) | 403 (10000) |
| List API tokens | `GET /user/tokens`, `GET /accounts/<account>/tokens` | 403 (9109) | 403 (9109) | 403 (9109) |

What the table shows:

- **Only `edit` published and unpublished.** Its upload answered 200, the code read back was its own, its delete answered 200, and the namespace's `script_count` was 0 afterwards.
- **`edit` isn't limited to the namespace.** It replaced the canary's code, which the login then read back as the token's; deleted the canary; and created and deleted a new Worker on the account. Nothing in the answers separated a script in the namespace from a Worker on the account.
- **`narrow` can't publish, and can still rewrite a Worker.** It was refused every write in the namespace, with or without the script there already, and refused the create and both deletes. But it replaced the canary's code: the login read back `replaced-by-narrow`. So it is no safer for Podster's own Workers than `edit`, and no use for publishing.
- **Reading is wide for all three,** the control included: every Worker's settings, code and the names of its secrets, the queues' list, the Durable Object namespaces, the account's `workers.dev` subdomain and the zones' list. None of the three read D1, KV, R2, DNS records, custom hostnames, members or API tokens.
- **Workers routes differ by token in a way the permission names don't explain:** `narrow` listed both zones' routes, `edit` only `podster.dev`'s, `read` neither. It was the same on both runs. Each token's zone resources would explain it, and only the dashboard shows them.
- **A new Worker made through the API has its `workers.dev` address off,** as the canary has. Nothing the spike made was reachable from the internet.
- **A read of a namespace script just after its delete still answered 200,** as spike A found. The list and `script_count` are what the clean-up trusts.

**Run twice; only the second run's results are recorded.** The whole run was made at 11:21 and again at 11:22 UTC, after a first pass with the `read` token alone. The second run added seven calls, and it is the one in `results/results.jsonl`. The first run's file wasn't kept. The two were compared at the time and every call both made had the same status, but nothing here lets a reader check that.

## What wasn't shown

- **The narrow permission's exact name,** and so which documented permission it is. Nothing here could read it.
- **Whether the dashboard can limit a token to one dispatch namespace.** No API call that might say was tried. See the plan for what the owner would look at.
- **Any write to a Worker of Podster's.** By rule. "It can replace Podster's API Worker" is inferred from the canary.
- **A write to a script's secrets, settings, cron triggers, routes, custom domains or `workers.dev` address,** with any token. The guard refuses them, so what `edit` and `narrow` may do there is unknown. So is whether `narrow` can replace a Worker that has bindings.
- **An account-owned token.** All three were user tokens, and the account-token verify endpoint refused them.
- **A token limited by client IP address or to one zone,** and a token for custom hostnames or KV: the routing token of ADR 0010 is a different spike.
- **Uploading a file through the upload session.** The session was started and nothing was sent to it; spike A covers the rest with the login.
- **How long a revoked or expired token keeps working.**

## Run it again

It needs the three tokens in a file only its owner can read, with the keys `CF_SPIKE_TOKEN_SCRIPTS_EDIT`, `CF_SPIKE_TOKEN_SCRIPTS_READ` and `CF_SPIKE_TOKEN_NARROW`. The default path is `~/.podster/m6-staging/spike-tokens.env`; `SPIKE_TOKENS_FILE` names another. It also needs a `wrangler login` on the account, and the account's ID in the environment of your own shell only. Never print the file, and never pass a token as an argument.

```bash
cd spikes/m6-publishing-token && npm ci
```

```bash
node --test guard.test.mjs
```

```bash
export CLOUDFLARE_ACCOUNT_ID=<the ID of the Cloudflare account that holds podster.dev>
```

```bash
node spike.mjs run
```

`node spike.mjs run edit` runs one token. Each run appends to `results/results.jsonl` and ends with the clean-up.

## Clean up

```bash
node spike.mjs cleanup
```

It lists the namespace's scripts and the account's Workers with the login, deletes each one whose name matches `^spike-m6-b-[a-z0-9-]{1,40}$`, and lists again. It needs no spike token. The last line it records should read `script_count: 0`, `account_workers: 6` and `account_workers_named_spike_m6: 0`.

**The tokens are the owner's to delete,** in the dashboard under My Profile → API Tokens, along with `~/.podster/m6-staging/spike-tokens.env`. Their expiry isn't a reason to leave them.

## Resources

- **Created, in each of the two runs:**
  - the Worker `spike-m6-b-canary` on the account, by the login, reset before each token;
  - the namespace scripts `spike-m6-b-read` and `spike-m6-b-narrow`, by the login, and `spike-m6-b-edit`, by the `edit` token;
  - the Worker `spike-m6-b-new-edit` on the account, by the `edit` token;
  - one assets upload session, by the `edit` token. Nothing was uploaded to it, and it lapses by itself.
- **Deleted:** all of them. The `edit` token deleted its own script, the canary and the new Worker; the login deleted the rest.
- **Confirmed by listing at 11:23:32 UTC, and again at 11:26:05:** the namespace's list was empty and its `script_count` was 0; the account held six Workers, each named `podster-…`, and none named `spike-m6`.
- **Left:** the namespace `podster-staging-apps`, empty, as it was found; and the owner's three tokens.
- **Not created:** any namespace, KV namespace, D1 database, custom hostname, DNS record, route or secret. Nothing in `apps/` was deployed, and no write was sent to anything of Podster's.
