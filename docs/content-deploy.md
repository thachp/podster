# Deploying the content Worker

The content Worker, `apps/content`, serves rooms' apps on the content domain ([ADR 0010](adr/0010-release-and-the-content-domain.md), [M6 plan, step 4(b)](m6-plan.md#step-4b-the-content-worker-the-build-plan)). It deploys to **the second Cloudflare account** ([decision 217](spec/PRODUCT.md#decisions-needed)), never to the one that holds `podster.dev`. It deploys only through `scripts/deploy-content`. **First real deploy, 2026-11-22,** from `main` at `177043db`: one probe, the unknown host, failed with HTTP `522` while the route took effect, and passed when checked by hand moments later. That is why the script now [waits for the route](#after-a-deploy) before its probes.

**The outbound Worker deploys with it, first** (added 2026-11-24). `apps/outbound`, the Worker that refuses every request an app's code makes ([ADR 0010's revision](adr/0010-revision-apps-are-workers.md), question 8 and section 6), deploys through the same script, to the same account, as `podster-outbound`: no route, no `workers.dev` address, no preview address and no binding. The content Worker's dispatch binding `APPS` then names it as the namespace's outbound Worker, which is what stops an app's code from opening sockets. **It always deploys:** no flag or configuration key leaves it out, since the revision says "an outbound Worker always". If its deploy fails, or Cloudflare's list of scripts doesn't show it afterwards, the content Worker isn't deployed. This replaces the revision's "the owner's setup, from a configuration outside this folder": that configuration is now the one this script builds and deletes, never committed, and the owner only reruns the same command.

**The catch-all route, `*/*`, joins `*.<content domain>/*`** (added 2026-11-25, when the owner switched custom domains on; [M6 step 8c](m6-plan.md#what-8c-built-routing-a-custom-hostname)). A custom hostname of Cloudflare for SaaS carries the customer's own name, so no route on `*.<content domain>` matches it; it reaches a Worker only through a route that matches every host entering the zone. Cloudflare's [Workers as your fallback origin](https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/start/advanced-settings/worker-as-origin/) recommends exactly that: `*/*` on the SaaS zone, with no route per hostname, and a more specific route can override it. **This is security-sensitive:** `*/*` hands the content Worker every host on the zone, the content domain itself, `fallback.<content domain>` and any custom hostname, live or not. What keeps it from widening what is served is the Worker's own rule, tested in `apps/content/test/handle.test.ts`: it serves only an app's default host with its entry and a custom hostname whose entry names it, and answers everything else with its own `404`, with no app asked. It is the narrowest set that works: a route per custom hostname would need a deploy for every claim, and `*/*` is bound to the content zone by `zone_name`, so it takes no other zone's traffic. `*.<content domain>/*` stays, so the declared routes are exactly what the zone holds: wrangler replaces a script's routes only with a token that can read every zone, and with this zone-scoped token it [adds routes and leaves the old ones](#the-routes-on-the-content-zone).

**Two routes that run no Worker keep a certificate authority's validation off `*/*`** (added 2026-11-25, from the security review of PR 603): `*/.well-known/acme-challenge/*` and `*/.well-known/pki-validation/*`. Cloudflare warns that a Worker on `*/*` intercepts HTTP certificate validation ([edge certificates](https://developers.cloudflare.com/ssl/edge-certificates/changing-dcv-method/troubleshooting/), [custom hostnames](https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/security/certificate-management/issue-and-validate/validate-certificates/troubleshooting/)). Through the content Worker that could reach an app, and an app that answered a validation could have a certificate issued for a customer's name. A route with no Worker "will act to negate any less specific patterns" ([routes](https://developers.cloudflare.com/workers/configuration/routing/routes/)), so Cloudflare's edge answers its own validation there. Wrangler only makes routes that run its own Worker, so the script makes these with the zone's routes API, `POST /zones/<zone>/workers/routes` with a `pattern` and no `script`, which is optional ([create route](https://developers.cloudflare.com/api/resources/workers/subresources/routes/methods/create/)). That takes Workers Routes Write on the zone, which the token's Workers Routes Edit already grants. It is one of the script's two writes outside wrangler (the other is the rate limiting rule, below), made before either Worker deploys, and only for a route the zone lacks. Two more locks stand behind it:
- **The content Worker** answers its own `404` for any path at or under those two folders, on every host, over HTTP and HTTPS, before its redirect to HTTPS, and never asks an app (`isValidationPath` in `apps/content/src/handle.ts`).
- **A release** may hold no file there (`VALIDATION_DIRECTORIES` in `crates/core/src/release_tree.rs`, refused as `release_refused_name`).

**One WAF rate limiting rule on the zone is the request-rate abuse control for apps** (approved by the owner on 2026-11-26, as one free-plan rule; [why](m6-plan.md#a-rate-limit-on-the-content-zone-approved-2026-11-26)). Every app's default host and every custom hostname enters through the content domain's zone, so one rule there covers them all. Before either Worker, the script makes sure the zone's `http_ratelimit` entry point ruleset ([Rulesets API](https://developers.cloudflare.com/waf/rate-limiting-rules/create-api/)) holds this rule, identified by its `ref`:

| Field | Value | Why |
| --- | --- | --- |
| `ref` | `podster_content_rate_limit` | How the script finds its own rule, and leaves every other alone |
| `description` | `Podster: requests per IP to every app and custom hostname, managed by scripts/deploy-content` | So the dashboard says whose it is |
| `expression` | `(not starts_with(http.request.uri.path, "/.well-known/acme-challenge/") and not starts_with(http.request.uri.path, "/.well-known/pki-validation/"))` | Every path but the two certificate validation folders, so issuing or renewing a certificate is never limited. The free plan allows the path field only and no regex (`matches` is Business and up) |
| `ratelimit.characteristics` | `["cf.colo.id", "ip.src"]` | Counted per IP; `cf.colo.id` is required with it, and IP is the only characteristic the free plan has |
| `ratelimit.requests_per_period` | `300` | The owner's starting figure |
| `ratelimit.period` | `10` | The only period the free plan has |
| `action` | `block` | The owner's choice |
| `ratelimit.mitigation_timeout` | `10` | The only mitigation timeout the free plan has, so the shortest |

The free plan's figures are from Cloudflare's [rate limiting rules](https://developers.cloudflare.com/waf/rate-limiting-rules/#availability) page, read 2026-11-26: one rule per zone, IP as the only characteristic, a 10 s period and a 10 s mitigation timeout, the path field only, no custom counting expression and no cache exclusion. **Not yet confirmed by a run:** that Cloudflare stores the expression exactly as sent. If it rewrites it, the next report says `different`, and a deploy's check after says the rule isn't in place as deployed (exit 4).

- **The report** reads the entry point (`GET /zones/<zone>/rulesets/phases/http_ratelimit/entrypoint`) and says whether the rule is **missing**, **matching** or **different**. A `404` from Cloudflare is no entry point yet, so missing. A rule of anyone else's is left alone and counted. **If this script's rule is missing and another rule is there, it refuses:** the free plan allows one, and the script never changes or removes another's rule. Two rules with its `ref` refuse too.
- **A deploy** writes only when the rule isn't matching, and only this rule, after the no-Worker routes and before either Worker: `POST /zones/<zone>/rulesets` making the entry point with the rule when the zone has none, `POST .../rulesets/<ruleset>/rules` adding it to an existing one, or `PATCH .../rulesets/<ruleset>/rules/<rule>` updating it by its own ID. Each answer must be the ruleset holding the rule exactly as sent; anything else stops with exit 3, and neither Worker is deployed.
- **After a deploy** it reads the entry point again: the rule must be there exactly as deployed, or the run fails with exit 4. A flood actually blocked is NOT SHOWN: no probe sends 300 requests in 10 s.
- **The token permission.** It takes **Zone → Zone WAF → Edit** on the content domain's zone ([Terraform's rate limiting page](https://developers.cloudflare.com/terraform/additional-configurations/rate-limiting-rules/) names `Zone WAF Write`). If the token can't read the rules, the report refuses with HTTP `401` or `403` and names that permission. If it can read but not write, the deploy stops at the write with exit 3, names the permission, and deploys neither Worker.

The zone's own names are matched by `*.<content domain>/*`, a more specific host than `*/`, so on a default host the content Worker's `404` is what answers; the zone's own certificate covers those names and isn't validated on them over HTTP.

`scripts/deploy-staging` doesn't know either package, and neither `apps/content/wrangler.jsonc` nor `apps/outbound/wrangler.jsonc` can deploy anything anywhere ([why](m6-plan.md#step-4b-the-content-worker-the-build-plan)).

## What it defends against

**Accidents in the owner's shell:**
- a stray exported function or alias from dotfiles;
- tracing left on;
- a proxy variable or a `.curlrc`;
- a leftover token variable;
- the wrong account in the environment.

**It does not defend against someone who already controls the owner's account, files or `PATH`.** Such a person can replace the programs this script runs, and no script can stop that.

## Who runs it

- **Without `--deploy`,** it only reports. It runs every check below, reads Cloudflare's API with the token, prints what it would deploy, both Workers, and changes nothing. **An agent runs it only like this, and only when the owner asks.**
- **With `--deploy`,** it deploys the outbound Worker, then the content Worker, and then checks both and probes the content domain. It needs a person at a terminal: stdin and stdout must be terminals, and the owner types the content domain to confirm. No flag or environment variable skips that.

## Before the first deploy: the owner's open items

Each is the owner's, on the second account. The script's read-only checks find most of them missing or present, so a run without `--deploy` doubles as this checklist.

| Item | Checked by the script |
| --- | --- |
| **The content domain active on that account.** `podster.site` was registered on 2026-11-12 and can't move before 2026-11-22. | Yes: one zone of that name, `active`, on the configured account |
| **Workers for Platforms** on that account ($25 a month), possibly Workers Paid first, and **the dispatch namespace** | The namespace, yes |
| **The serve entries' KV namespace** | Yes |
| **The wildcard DNS record** for `*.` the content domain, proxied, and the redirect from HTTP to HTTPS | Only after a deploy, by the probes |
| **The deploy token,** below | Partly: see what it can't read |
| **Spike G** (`spikes/m6-spike-g`), **after this deploy and before `RELEASES` or the provider settings.** *Changed 2026-11-22 by the architect's ruling; it said "run first".* The content Worker deploys first: it serves nothing until a serve entry exists, and `RELEASES` stays off on the API. Spike G then runs against it on the second account, since what it measures is the deployed content Worker reading serve entries *(Ran on 2026-11-23: [results](../spikes/m6-spike-g/RESULTS.md).)* | No |

None of these comes with a deploy: the six provider settings on the API, the two cron entries, and `RELEASES`. Each is a separate yes. Spike G's results come before any of them.

## The two files

Both live outside every repository, in a directory of mode 0700, each file of mode 0600 and owned by the owner. The script refuses anything else, and refuses a link.

```bash
mkdir -p ~/.config/podster && chmod 700 ~/.config/podster
```

- **`~/.config/podster/content-token`:** the token, exactly one line, with or without a final newline, and nothing after it. Every byte must be a letter, a digit, `-` or `_`: a NUL or a carriage return is refused. Write it with an editor or a paste into the file, never with `echo` on a command line, where it would land in the shell's history.

  ```bash
  touch ~/.config/podster/content-token && chmod 600 ~/.config/podster/content-token
  ```

- **`~/.config/podster/content-deploy.json`:** the deploy-time configuration, exactly these four keys. The ID shapes are checked; the values are the owner's and are never committed.

  ```json
  {
    "account_id": "<the second account's ID, 32 hexadecimal characters>",
    "content_domain": "podster.site",
    "kv_namespace_id": "<the serve entries' KV namespace ID>",
    "dispatch_namespace": "<the dispatch namespace's name>"
  }
  ```

The script builds wrangler's two configurations from that file, from `apps/content/wrangler.jsonc` and from `apps/outbound/wrangler.jsonc`. Both are written to a temporary folder, used, and deleted. The content Worker's routes are `*.<content domain>/*` and `*/*`, both on that zone, and its dispatch binding is `{ "binding": "APPS", "namespace": <the namespace>, "outbound": { "service": "podster-outbound" } }`, the shape in Cloudflare's [outbound Workers](https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/configuration/outbound-workers/) and [wrangler configuration](https://developers.cloudflare.com/workers/wrangler/configuration/#dispatch-namespace-bindings-workers-for-platforms) pages, with no `parameters`. The outbound Worker's has no route and no binding. Both public addresses are off for both.

**The outbound Worker's committed file supplies only** its name, `podster-outbound`, its entry point and its compatibility date. The file must hold exactly those, its placeholder account and both public addresses off; anything else in it, a route, a binding, a variable, another name or an address switched on, is refused before anything changes. Its package must pass the same checks as the content Worker's: no `.wrangler/deploy/config.json`, no `.env` file of any name, and its own pinned wrangler at 4.157.0, which is the one that deploys it.

The committed file supplies only:

- the Worker's name, entry point and compatibility date;
- **the write counter** (M6 stage 1, S6): the binding `WRITE_COUNTER` to this Worker's own class `WriteCounter`, and the one migration, `v1`, which makes it a SQLite-backed class;
- **the write cap's two settings,** `WRITE_BUDGET_WRITES` and `WRITE_BUDGET_WINDOW_MS`, the owner's 300 writes per 600,000 ms;
- **the dispatch's two limits** for an app with code, `APP_LIMIT_CPU_MS` and `APP_LIMIT_SUBREQUESTS`, 50 and 50: the architect's figures of 2026-11-25 for pilots, for the owner to review, not measured by any spike. Each must be a decimal string the content Worker's `limitsFromSettings` takes (CPU 1 to 300,000 ms, the platform's maximum, and subrequests 0 to 999,999,999), or the script refuses before anything changes. After a deploy it checks, from `podster-content`'s deployed settings, that both are there as plain text with exactly those figures; missing or different is a failure (exit 4).

Each of these is taken only in exactly that shape: another binding, another class, a binding to another Worker's class, another migration, or a setting the content Worker wouldn't take as a cap (a decimal string, writes 0 to 4,294,967,295 and the window 1 to 9,223,372,036,854,775,807 ms, as `capFromSettings` reads them) is refused before anything changes. So the first deploy makes the counter's class on the second account, and the report run prints the cap it would deploy. Without the counter and its cap, every write to an app with code would be refused `503 write_budget_unknown`; while the code-apps switch is off, nothing writes at all.

## The token

**A token of its own, for this deploy only,** not the publishing credential the API will use, and not any token of the account that holds `podster.dev`.

**What the script can and can't check about it:**

- **Can:** that it is active; that it sees exactly one account, the configured one; that it sees no zone named `podster.dev`; and that it can't read API tokens, its own included. A token that can read tokens is refused, since that is more than a deploy needs.
- **Can't:** its other permissions. A token can only read its own permissions if it can read tokens, which is the one thing it mustn't do. So the owner grants exactly what's listed here, and the script's checks catch some mistakes, not all.

**Permissions to grant.** *Proposed, from Cloudflare's permission names; not yet confirmed by a run.* The first report run confirms them: a missing one shows as a refused read, naming what it couldn't read.

| Scope | Permission | Why |
| --- | --- | --- |
| The second account only | Workers Scripts: Edit | Upload both Workers, the content Worker and `podster-outbound`, and read the dispatch namespace, the account's list of scripts, `podster-outbound`'s `workers.dev` setting and `podster-content`'s settings. *Proposed:* also the write counter's migration, since a Durable Object class is made by the Worker's own upload; the report run can't show this, only the first deploy can |
| The second account only | Workers KV Storage: Read | The script's check that the KV namespace exists. The deploy itself only binds it by ID |
| The content domain's zone only | Workers Routes: Edit | The routes `*.<content domain>/*` and `*/*`, and the two that run no Worker on the validation paths, made with `POST /zones/<zone>/workers/routes` |
| The content domain's zone only | Zone: Read | The script's check that the zone is active on the account |
| The content domain's zone only | Zone WAF: Edit | The zone's one rate limiting rule (added 2026-11-26): reading its `http_ratelimit` entry point, and creating or updating the script's own rule. **Add it to an existing token before the next run:** without it the report refuses and names it |

**The outbound Worker needs no new permission** (read 2026-11-24, not yet confirmed by a run). Workers Scripts is an account-scoped permission: Edit covers every Worker script on the account, so it uploads a second Worker as it does the first, and the reads of a script's settings and `workers.dev` setting take Workers Scripts Read, which Edit includes ([permissions](https://developers.cloudflare.com/fundamentals/api/reference/permissions/)). Naming it as outbound is part of the content Worker's own upload. Listing the routes on the content zone takes Workers Routes, already granted on that zone. **So the owner adds nothing to the token.** If the first run shows otherwise, a refused read or a failed upload names what was missing.

**Reading the account's custom domains** (`GET /accounts/<account>/workers/domains`, added 2026-11-24 after PR 589's review): Cloudflare's pages read for this don't name the permission that reads that list. They say that adding or removing a custom domain takes Zone → Workers Routes → Write on the affected zone ([Workers authorization](https://developers.cloudflare.com/workers/authorization/workers/#routes-and-custom-domains)). The token already holds Workers Scripts Edit on the account and Workers Routes Edit on the content zone. **Whether those are enough to read the list is unconfirmed.** If they aren't, the script says NOT SHOWN for that check: a report still exits 0 but never says "every check passed", and a deploy ends with exit 4, not verified. The error Cloudflare returns then names what's missing. Widening the token is the owner's call, and nothing here recommends it before that run.

**Nothing else:** no other account, no other zone, no API Tokens permission, no DNS, no billing. Give it an expiry date and, if the owner wants, an IP filter.

**How the script keeps the token:**

- **No shell variable ever holds it.** The token is read from its file only where it is handed to a child, so a traced command has nothing to expand. It is never a command's argument, never printed, and never written to a file by the script.
- **Bash only, 3.2 or later.** macOS's `/bin/bash` 3.2 is supported, and the self-test runs under it on macOS and under CI's bash on Linux. Run by `sh`, by `dash`, or by bash in POSIX mode, which is what `sh` is on macOS, it refuses with exit 2 before any of its bash-only lines.
- **A clean process first.** Before anything else, the script starts itself again as `/bin/bash` under `/usr/bin/env -i`.
  - **What the new process has:** only `HOME`, `TERM`, `PATH`, `SSH_AUTH_SOCK` and a few results about the caller's environment. No exported function, alias, `BASH_ENV`, `SHELLOPTS`, `CLOUDFLARE_*` or proxy variable crosses.
  - **Before that exec:** the script runs only what a function or alias can't replace. It sets `POSIXLY_CORRECT`, under which special builtins are found before functions. It uses `case` instead of `[`, and puts a backslash on each command word. It unsets any function named `echo`, the one ordinary command it uses there.
  - **Results carried over:** whether a token or key variable was set, whether tracing or `BASH_ENV` was on, and `CLOUDFLARE_ACCOUNT_ID`, which is an ID and not a secret.
  - **Checked after:** the new process confirms it holds exactly those variables and no function. A caller who sets the marker to skip the exec is refused.
  - **The results must all be there.** With the marker, every carried result must be present and in its form (each flag 0 or 1, a bash version), or it refuses with exit 1 and one line naming what is missing.
  - **It execs once.** A process that has the exec's results but not its marker refuses, exit 1, and never execs again. So a lost marker stops the script instead of making it start over and over.
  - **Needs:** `/usr/bin/env` and `/bin/bash`. Missing either, the exec fails and nothing runs.
  - **Owners who use `GH_TOKEN`:** it isn't carried over, so `gh` must be logged in under `HOME`. Otherwise the CI check fails and the script refuses.
- **Tracing is refused.** The script stops before reading anything if it runs under `bash -x` or `-v`, if `SHELLOPTS` turns on `xtrace` or `verbose`, or if `BASH_ENV` is set. It then switches both off.
- **curl** gets the `Authorization` header on stdin (`--config -`), built from the file inside the pipe. Every curl, the probes' included, runs with `-q` first, so no `.curlrc` is read, under `env -i` with only `PATH` and an empty home. So no proxy variable, no `CURL_HOME` and nothing else of the caller's reaches it.
- **wrangler** runs under `env -i` with an allow-list: `PATH`, a temporary home, configuration, cache and log folder, `CI`, metrics off, and the token. A small shell reads the token on its stdin, from the file, and exports it to wrangler alone. So no wrangler login, no `CLOUDFLARE_ACCOUNT_ID`, no exported function and nothing else of the shell reaches it. The temporary folder is deleted when the script ends.
- **wrangler reads no `.env`.** Wrangler 4.157.0 loads `.env` and `.env.local` from its working directory into its own environment on every command, whatever git ignores. Its source has no variable that switches that off: `CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV` governs only `wrangler dev`'s variables. What does switch it off is `--env-file`: given, it replaces those defaults. So wrangler runs from an empty folder of the script's own, with `--env-file` at an empty file. And a `.env` file of any name in `apps/content` is refused all the same.
- If any answer from Cloudflare, or wrangler's output or log, holds the token, the script redacts it and fails.
- It refuses to start if `CLOUDFLARE_API_TOKEN` or `CLOUDFLARE_API_KEY` is set in the shell, so the file's is the only credential, and if `WRANGLER_LOG` is `debug`.

**Every answer must have the expected shape.** Each read from Cloudflare's API must be exactly one JSON document, `success: true`, with a `result` of exactly the expected type, and the fields the script uses must be there.
- **Lists:** a list must be a list.
- **Names:** the content domain's zone must carry that name, compared without regard to case, and each namespace answer must name that namespace.
- **Whether the token can read tokens:** judged on the answer's shape as well as its status. A 200 must be a success with a result. A 401 or 403 must be Cloudflare's own refusal, with `success: false` and a list of errors. Anything else refuses, so an unexpected answer is never taken as "no zone" or "one account".

**Not the account that holds `podster.dev`.** The script refuses a configured account equal to `CLOUDFLARE_ACCOUNT_ID`, compared without regard to case, or equal to an account a wrangler login cached in this checkout's other apps. Wrangler keeps the account a login chose in `node_modules/.cache/wrangler/wrangler-account*.json` or `.wrangler/cache/`, with no token in it, and in `WRANGLER_CACHE_DIR` if that is set. **What it can't see:** a login that cached nothing in this checkout. Reading the login itself would mean reading its token, which the script never does.

## Running it

Both paths must be absolute; a relative one is refused. From a checkout detached at `origin/main`'s tip, with nothing changed, after `ci.yml` has passed on main for that commit:

```bash
git fetch origin && git checkout --detach origin/main
```

```bash
scripts/deploy-content --token-file ~/.config/podster/content-token --config-file ~/.config/podster/content-deploy.json
```

That only reports. To deploy, the owner adds `--deploy` at a terminal and types the content domain when asked:

```bash
scripts/deploy-content --token-file ~/.config/podster/content-token --config-file ~/.config/podster/content-deploy.json --deploy
```

`scripts/deploy-content --help` lists every refusal. Exit codes: 0 reported, or deployed and verified; 1 refused, nothing changed; 2 wrong usage; 3 the deploy failed part-way, and the output says which Worker was deployed; 4 deployed but a probe or check failed or was NOT SHOWN, so the Workers are deployed and **not verified**. A check that couldn't be made is never a pass: the last line then counts the NOT SHOWN checks and never says "every probe passed".

**What the report reads, besides what it read before** (added 2026-11-24): the account's list of Worker scripts, so it says whether `podster-outbound` exists yet, and the routes on the content domain's zone. **A route on that zone that runs `podster-outbound` is refused:** a deploy with no route leaves a script's existing routes alone, so one made by hand would outlive every deploy. The content domain's zone must come with its ID, which the routes are read by. **It also reads the account's custom domains, and a custom domain that runs `podster-outbound` is refused** for the same reason: a deploy with none leaves an existing one alone. If they can't be read, the report says NOT SHOWN (above).

### The routes on the content zone

Added 2026-11-25, with `*/*`. Before anything changes, the report reads the zone's routes and refuses:

- **a route that runs any Worker but `podster-content`** (`podster-outbound` keeps its own message). Under `*/*` a more specific route wins, so another Worker's route there would take those hosts, a customer's name among them, from the content Worker.
- **a route of `podster-content`'s under any pattern but the two this script deploys.** It was made outside the script, which wouldn't track it. Add no route by hand in the dashboard.

**The two no-Worker routes are added if missing,** each answer checked to be that very route with no Worker; anything else stops the run with exit 3 before either Worker deploys. If Cloudflare refuses a pattern of that form, it is the same exit 3, and nothing was deployed.

**Any other route that runs no Worker is left alone.** It only hands its hosts back to the zone, which has no origin of its own, so it narrows what reaches the Worker and serves nothing. Wrangler 4.157.0 sends a script's routes with `PUT .../workers/scripts/<name>/routes`, which replaces them; with a token that can't read every zone it falls back to adding each route on its zone and leaves the script's old ones in place, with a warning.

An error the script doesn't handle, such as an unbound variable, never exits 0: it says it stopped, and in which phase.

**Stopped by a signal** (129 SIGHUP, 130 SIGINT, 143 SIGTERM), it says where it was:
- while checking, nothing changed;
- during the outbound Worker's deploy, `podster-outbound` may or may not be deployed and the content Worker wasn't;
- during the content Worker's deploy, `podster-outbound` is deployed and the content Worker may or may not be, so check the account before running it again;
- **between the two deploys** (the check that `podster-outbound` is on the account, or a leak in that answer), the content Worker was **not** deployed, and the output says so.

**If `podster-outbound` deploys and the content Worker's deploy then fails (exit 3),** the content Worker deployed before, if there is one, keeps serving as it was deployed. Every deploy by this script names `podster-outbound` on the dispatch binding; a content Worker deployed before that (before 2026-11-24) had no outbound binding, and was acceptable only because its `CODE_APPS_ENABLED` (`apps/content/src/handle.ts`) was false, so no app's code ran. *Since 2026-11-25 the switch is on in the source, so a content Worker deployed from it serves apps with code; it is deployed only through this script, so always with the outbound binding.* The script says so; fix the cause and run it again.
- during the probes, the Workers are deployed and not verified.

The temporary folder is deleted in every case.

## After a deploy

**First it waits up to 30 s for the route** (added 2026-11-22). The first real deploy, on 2026-11-22, failed its first probe with HTTP `522`: the new route `*.<content domain>/*` hadn't taken effect, and the same check passed by hand seconds later. So the script now sends the unknown-host request on its own first, and again every 2 s while the answer is no answer, `520` to `529` or `530`. The clock bounds the wait, not a count of tries: each try gives curl 5 s, so one slow `522` can't use up the window, and a try starts only if it ends within 30 s of the first. Any other answer ends the wait at once, the Worker's own `404` and a wrong answer alike: a wrong answer is never asked again, and the probes below judge it. If the route never answers in time, the probes run anyway and fail as before. No probe's pass criteria changed.

Then the script probes one random host on the content domain, signed out, with `scripts/content-probes` (which also [runs on its own](#the-probes-from-ci)):

- **An unknown host** gets the Worker's own `404`, `not_found`, with its fixed headers: `nosniff`, `no-referrer`, HSTS, `no-store`, and the sandbox policy.
- **Plain HTTP** gets a `301` to the same host and path over HTTPS. That can be the zone's redirect or the Worker's own: both must send the same place.
- **A POST** gets `405`, allowing `GET, HEAD`.
- **A request with a `Service-Worker` header** gets `403`.
- **The content domain itself** serves nothing: no answer, or any answer that isn't a success. Since 2026-11-25 `*/*` covers it, and the Worker answers its own `404`.
- **Not shown, and the script prints so:** a host two labels deep. The zone's certificate covers one level, so HTTPS there can't be probed.

**Then it checks the outbound Worker by Cloudflare's API,** with the token, each a pass, a failure or NOT SHOWN; either of the last two ends with exit 4:

- **`podster-outbound` exists** on the account.
- **It has no `workers.dev` address and no preview address,** from `GET /accounts/<account>/workers/scripts/podster-outbound/subdomain`. If that answer doesn't say whether previews are on, the script says that one is NOT SHOWN, and exits 4.
- **No route on the content domain's zone runs it.** Routes on other zones aren't read: the token sees no other zone, and can make routes on none.
- **`podster-content`'s routes on that zone are exactly `*.<content domain>/*` and `*/*`, the zone holds `*/.well-known/acme-challenge/*` and `*/.well-known/pki-validation/*` running no Worker, and no route there runs another Worker** (added 2026-11-25). A route missing, a third one, one twice, a validation route that runs a Worker, or another Worker's route is a failure, with exit 4. **This check reports; it can't prevent.** A route someone adds on the zone while the deploy runs is caught here, after the fact, and the owner removes it.
- **`podster-content`'s deployed binding `APPS` names it as outbound,** from `GET /accounts/<account>/workers/scripts/podster-content/settings`, where wrangler 4.157.0 reads a dispatch binding's outbound Worker as `outbound.worker.service`. **If those settings can't be read in that shape, the script says NOT SHOWN, never a pass, and exits 4,** and the owner checks the binding in the dashboard.
- **No custom domain on the account runs it,** from `GET /accounts/<account>/workers/domains`, where each entry names its Worker as `service` (the list endpoint wrangler 4.157.0's Cloudflare client calls). If the list can't be read, that's NOT SHOWN, with exit 4.
- **Not shown, and the script prints so:** a custom hostname reaching `podster-content` through `*/*`. That needs an active custom hostname, which this script never makes.
- **Not shown, and the script prints so:** an app's `fetch` refused by the outbound Worker. That needs an app with code, and none exists yet; it is [the revision's gate](adr/0010-revision-apps-are-workers.md) item, still owed, with the socket test.

**What it can't check until the release job (step 5) exists:**

- an app actually served;
- a dispatch to a real script;
- the domain-wide stop's effect;
- how long a takedown takes.

These are spike G's and the first release's to show. *(2026-11-23: spike G showed a dispatch to a real script, the stop's effect and a takedown's time at one location ([results](../spikes/m6-spike-g/RESULTS.md)). An app released through the job is still the first release's to show.)*

## The probes from CI

The probes above are `scripts/content-probes`, and they need no token. The owner's machine is on a network with a web filter that blocks the content domain, so after a deploy from there the probes fail, and a deploy ends with exit 4 though nothing may be wrong. So the owner approved, on 2026-11-25, running the probes from GitHub Actions instead, whose network reaches the content domain:

```bash
gh workflow run content-probes.yml
gh run watch
```

`.github/workflows/content-probes.yml` only ever starts by hand, and carries no secret: `gh workflow run --ref <branch>` can run a branch's copy, and that copy gets no secret either. It checks out the repository with no stored credential and runs `scripts/content-probes` with no argument, so it probes `podster.site`, the domain committed in the script (`apps/content/wrangler.jsonc` holds only a placeholder). It has no input, no secret, no token and no environment, and one run waits for another. It doesn't wait for a route: run it once the deploy is done. A run that passes shows the probes passed; it doesn't show the API checks that `scripts/deploy-content` makes after them, which need the token, so a deploy's exit 4 still says which of those failed or were NOT SHOWN.

`scripts/content-probes --help` lists the probes. Run by hand it takes the domain as an argument, and `--wait-for-route` waits for a new route as a deploy does. Exit codes: 0 every probe passed, 1 a probe failed, 2 wrong usage or a refused domain. The two-labels-deep line is NOT SHOWN and doesn't change the exit code.

## An open question for the owner: deploy with the stop set?

The domain-wide stop is one key in the serve entries' KV namespace. While it is set, the content Worker refuses every host.

**Should the first deploy go out with the stop already set,** so the Worker serves nothing until the owner lifts it?

- **The architect recommends yes:** nothing is served until the owner decides to serve.
- **The script does nothing either way.** Setting the key is a write to KV with a publishing credential, which this script doesn't hold.
- **The probes pass either way:** with the stop set, an unknown host still gets the Worker's not-found.

## Owed

- A read-only check that the account's Worker names are exactly the expected set, as for staging ([docs/staging.md](staging.md#setting-a-secret-one-form-only)).
- Confirming the permission table above at the first report run, and that it holds for the outbound Worker at the first deploy.
- **The rate limiting rule, live** (added 2026-11-26): that Cloudflare takes it on the free plan as written, keeps the expression as sent, and that a flood from one IP is blocked while a certificate's validation isn't. Watch the zone's Security events after the first deploy that adds it.
- The test at the deployment that an app's `fetch` and socket both fail through `podster-outbound`, once an app with code exists.
- **Certificate validation with `*/*` in place, live.** The two no-Worker routes (above, under the catch-all route) send a certificate authority's HTTP validation to Cloudflare's edge, and the content Worker answers those paths its own `404` if one ever reaches it. Podster creates custom hostnames with `ssl: http`, and a renewal may use HTTP whatever was chosen at issuance ([renewals](https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/security/certificate-management/issue-and-validate/renew-certificates/)), so the routes are what must hold. Whether Cloudflare's edge then completes the validation is unshown until the first real custom hostname: watch its `ssl.status` reach `active`.
- Reading wrangler's account-precedence again with every wrangler upgrade ([why](m6-plan.md#step-4b-the-content-worker-the-build-plan)). The script pins 4.157.0 and refuses another.
