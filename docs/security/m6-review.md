# M6 security review, 2026-11-26

The security review [M6's gate](../m6-plan.md#the-gate) asks for: "a security review of the built system against the [threat model](../m6-plan.md#threat-model), with the result written into this plan". Earlier reviews looked at one PR each. This one reads the whole of release, hosting and custom domains as built, row by row against the threat model, and adds what the table misses.

**Nothing here is fixed.** This page lists findings and the fixes they need. It changes no code, setting or cloud resource. The ratings are the reviewer's. The architect and the owner rule on them.

## Scope

- **What was read:** `main` at `505ab3122cb7fb413fc75eb0af346a86683eb11e`, on 2026-11-26 UTC. Every `file:line` below is at that commit.
- **What it covers:**
  - release: the room setting, release records, approvals, the deploy grant and the merged-only rule;
  - the content Worker (`apps/content`) and the outbound Worker (`apps/outbound`);
  - dispatch-namespace hosting for static apps and apps with code, with the per-dispatch limits, the write counter and the D1 store;
  - the content domain `podster.site` and the origin boundary;
  - custom hostnames: the claim, the TXT proof, the hostname object, the Cloudflare for SaaS calls, the reserved list, the Public Suffix List, and the `*/*` route with its routes that run no Worker on the validation paths;
  - `scripts/deploy-content`, `scripts/deploy-staging`, the second account's credentials and the store reconcile;
  - AC-05, AC-10, AC-11, AC-13, AC-16 and AC-17 for deployment, and expanded criterion 3.
- **Not covered:** the web app's release screens beyond what the staging runs showed, the gateway's agent-tool path for `deploy_release` beyond its policy call, and M7.

## Method, and its limits

- **Read-only.** The review used a fresh worktree from `origin/main`. It sent nothing to staging, GitHub or Cloudflare. One read-only search of Cloudflare's own documentation was made, for billing and limits.
- **Most findings come from reading the code.** "Evidence" says which test covers a control and which staging run showed it. A test is named as covering a control from its file and the plan's record. Only the tests listed next were run by this review.
- **Tests run by this review, all pure Rust:** `podster-policy --test release` (24 passed), and `podster-core`'s `app_store_delete` (8 passed), `hostnames` (21 passed) and `release_request` (11 passed).
- **Not run by this review:** the API's suites, the gateway's, `apps/content`'s and `apps/outbound`'s vitest suites, and every e2e script. CI runs them on every push to `main`.
- **Staging evidence is the plan's record of four runs.** This review didn't repeat any of them:
  - static release: 17/0/4 at `d7c7247d` ([the call](../m6-plan.md#the-owners-call-2026-11-24-static-sites));
  - apps with code: 10/0/1/1, Actions run 45598024983 ([the call](../m6-plan.md#the-owners-call-2026-11-25-apps-with-code));
  - custom domains: 7/0/3/1, Actions run 45803085099 ([the call](../m6-plan.md#the-owners-call-2026-11-26-custom-domains-for-staging));
  - `war3.org` manual DNS: 4/0/7, Actions run 45852797247 (same section).
- **The reviewer is a model.** This page is evidence for the architect and the owner, not a ruling.

## Verdict

**No way was found, through Podster's own code, to deploy a commit that Podster's merge didn't put on the default branch, to deploy without a deploy grant and a person's approval, to serve one room's app on another room's host, or to route a custom hostname a room hasn't proven.** Each authority check runs in `crates/policy` or `crates/core`, is read from the room's own state, and is asked again by the job on every pass.

**No finding is in the code paths that keep authority.** The findings are about cost bounds, a reconcile the threat model counts on that isn't built, owed checks of the second account's credentials, and the written policies criterion 8 names.

**One finding is rated blocking for the gate, and it isn't code:** criterion 8's "documented policies" for custom domains, release approvals and export or transfer don't exist (F-8).

## The threat model, row by row

"Holds" means the control as built does what the row says. "In part" means it holds with a stated gap, which is listed under [findings](#findings).

| # | Threat | Control as built | Holds? | Evidence |
| --- | --- | --- | --- | --- |
| T1 | An app reads or sets the application's cookies, or another room's | The app is served on `podster.site`, a separate registrable domain. Every answer carries `sandbox allow-scripts`, so the page's origin is opaque and has no cookies or storage (`apps/content/src/handle.ts:148-160`, `:184-194`). Only four app response headers pass, so no `Set-Cookie` (`handle.ts:131`, `:423-426`). The request sent to the app is built from nothing, with three of the visitor's headers (`handle.ts:240-248`). The content domain can't be Podster's own (`crates/core/src/hostnames.rs:136`; refused at `apps/api/src/content_provider.rs` `from_env`) | Holds. The Public Suffix List entry is still missing, which matters for blocklisting (T19), not cookies, since the sandbox closes cookies between siblings | Content tests `handle.test.ts`. Staging: M6-R08 and M6-R09 (static), M6-C03 and M6-C05 (code: the app's `Set-Cookie` dropped), X14-3 (custom host, no cookie) |
| T2 | An app reaches Podster's data | The content Worker binds only `SERVE` (KV, read), `APPS` and its own `WRITE_COUNTER`, with no binding to the gateway, the API, D1 or R2 (`apps/content/wrangler.jsonc`; `apps/content/src/index.ts:13-28`). The content Worker, namespace and stores are on a second account (decision 217). An app's script gets exactly one binding, `STORE`, from the room's own record (rule 3(a), `crates/core/src/app_bindings.rs`). The reconcile reads each app script's bindings and takes down a foreign one (rule 3(b)) | Holds | `config.test.ts` fails if a binding is added. `app_bindings.rs` and `script-bindings.cases.ts`. Staging: M6-C04, exactly one binding, `STORE` |
| T3 | Agent-written server code calls out, mines or attacks from Podster's account | Since decision 219 an app may run code. The outbound Worker refuses every `fetch` with one fixed answer and reads nothing (`apps/outbound/src/refuse.ts:23-25`). With an outbound Worker set, `connect()` is refused. Each dispatch gets 50 CPU ms and 50 subrequests (`apps/content/src/limits.ts:31-37`; `apps/content/wrangler.jsonc:34`; `handle.ts:274`, `:371-372`). With no limits configured, nothing of an app runs (`handle.ts:372`) | Holds for egress and CPU. In part for cost: see F-1 and F-2 | `refuse.test.ts`, `limits.test.ts`. Staging: M6-C07 (fetch refused, `connect()` refused) and M6-C08 (a spinning app stopped, `502 app_error`) |
| T4 | Unreviewed code is deployed | A request names exactly the commit Podster's merge confirmed on the default branch of the room's repository, for a completed task (`crates/core/src/release.rs:156-178`, `crates/core/src/release_request.rs:93-106`, read from `task_change` at `apps/api/src/workspace/release_request.rs:255-280`). The job asks again on every pass (`release_recheck.rs`). The tree is read at that commit's SHA, never `{commit}:{path}`, so no submodule is followed (`apps/api/src/github/release_read.rs:23`, `:363-368`) | Holds | `release_request.rs` (core, run here: 11 passed), `release-request.spec.ts`, `release-recheck.spec.ts`. Staging: M6-R05 (the branch head and another room's task refused) and M6-R06 (the marker names the merged commit) |
| T5 | An approved or merged task deploys with no deployment authority | A deploy needs the caller's own `deploy` grant on exactly the room's repository, from a giver who still holds release authority (`crates/policy/src/release.rs:449-470`, `:505-530`), then a person's approval (`:396-402`). Approval and merge grant nothing. The only writer of `provider_grant` is the grant command, behind `authorize_deploy_grant` (`apps/api/src/workspace/repositories.rs:826-854`; `release.rs:611-624`). Claiming a role writes no grant | Holds | `crates/policy/tests/release.rs` (run here: 24 passed), `release-agent.spec.ts`. Staging: M6-R04 (an agent that claimed a DevOps opening refused `grant_required`), M6-R10 |
| T6 | A stale job deploys after revocation or after release is switched off | The job rechecks current state in the room's transaction before each outside call: the room's rows, the epoch, the grant and its giver, the requester's and approver's standing, the stop and the deployment's switch (`apps/api/src/workspace/release_recheck.rs:1-60`, `:280-315`). An unread fact is undecided, never a pass | Holds | `release-recheck.spec.ts`, `release-triggers.spec.ts`. Staging: M6-R13 (grant taken back, then approved: `requester_lost_authority`), M6-R16 |
| T7 | The publishing credential leaks or is used on the wrong target | Three tokens on the second account, each held only by the private API as a secret: scripts (Workers Scripts Edit), routing (KV Edit) and store (D1 Edit). The store token must differ from the other two (`apps/api/src/app_stores.rs:55-58`, `:163-172`). The account, namespace and KV ID come from secrets, never a client (`content_provider.rs:61-66`). Custom hostnames use a fourth token, SSL and Certificates Edit on one zone (`custom_hostnames.rs`) | In part. Workers Scripts Edit is account-wide, as the threat model accepts. Nothing refuses a `CONTENT_ACCOUNT_ID` equal to Podster's own account; that check is the owner's (`scripts/deploy-staging:41-46`; F-9). Store token's reach: F-4 | Spike B and the store spike. `app-store.spec.ts` (the token refusals). Not shown on a deployment: that each token can do nothing beyond its calls |
| T8 | A client steers a release to another account, namespace or app | No route takes an account, namespace, script, label or host. Script names come from `podster_core::release::script_owner` and the room's label | Holds | M6-R05: a request naming a repository, host, label or account is refused with no release recorded |
| T9 | Someone maps a hostname they don't control, or takes over a dangling one | Podster's own TXT challenge at `_podster-challenge.<name>`, a random value bound to the room's request (`crates/core/src/hostnames.rs:407-428`), read before any claim and before Cloudflare is asked. One claim per hostname, held by that hostname's own object (`apps/api/src/hostname_claim.rs`). Pending holds nothing. A claim never transfers, and is freed only after Cloudflare reads the custom hostname gone. A daily recheck ends a claim on two definite noes 24 hours apart, or after 7 days with no proof (`hostnames.rs:38-44`). A custom host serves only while its entry names that very host (`apps/content/src/names.ts:45-50`) | Holds. One resolver decides each proof: F-7 | `hostnames.rs` (core, run here: 21 passed), `hostname_claims.rs`, `hostname_long_end.rs`, `hostname_recheck.rs`, `custom-hostname.spec.ts`, `hostname-recheck.spec.ts`. Staging: X14-1, X15-2, X26-1. X26-2 and X26-3 aren't shown on a deployment |
| T10 | A custom hostname is Podster's own name or another room's host | `podster.dev`, `podster.site`, the configured content domain and every name under one are refused, and so is a public suffix by the whole list, both sections (`hostnames.rs:30`, `:363-400`, `:227-230`). The snapshot is compiled in (`apps/api/src/workspace/hostname.rs:78`), and `scripts/deploy-staging` refuses one older than 90 days | Holds | `hostnames.rs`. Staging: X15-1, 12 names refused with their codes |
| T11 | Podster hosts phishing, malware or illegal content written by an agent | Release is off by default. Only a public room releases (`release.rs:639-645`), only merged work, with a person's approval. An operator can suspend an app. Reports can name one. The stop for the whole domain is one KV key, read at most every 30 s (`handle.ts:211-224`) | In part. The terms don't cover hosted apps: F-8 | `takedown.spec.ts`. Staging: M6-R14 (report, suspend, not found within the wait) |
| T12 | An app imitates Podster's sign-in | A random label with no room or Podster name in it, on a separate domain, under the sandbox. `podster.site` carries Podster's name, a recorded choice of the owner's | Holds as designed | Recorded consequence, not tested |
| T13 | An app runs up Podster's bill | Static: 300 files, 25 MB, 20 releases a day, 2 uploads a room an hour, a deployment-wide read share. Code: 50 CPU ms and 50 subrequests a dispatch, and 300 write requests per app per 10 minutes, counted before the app is asked (`apps/content/src/counter.ts:156-169`, `handle.ts:373-384`) | **In part.** A store write made while handling a read isn't counted (F-1). Reads have no cap and no spend ceiling is recorded (F-2) | `counter.test.ts`, `budget.test.ts`. Staging: M6-C06 (the 301st write refused `429`) and M6-C08 |
| T14 | A private room's existence or work leaks through its host | A private room's app isn't served at all. A room made private is unpublished. `Referrer-Policy: no-referrer` on every answer (`handle.ts:186`). Default hosts share one wildcard certificate | Holds | Staging: M6-R01 and M6-R17 |
| T15 | A lost answer from Cloudflare leaves record and served content disagreeing | `uncertain`, settled by Cloudflare's read of the script. The marker job records `served` only once the host serves the release's marker | Holds | `release-uncertain.spec.ts`, `release-marker.spec.ts`. Spike G: reads matched 8 of 8. Staging: M6-R06's marker |
| T16 | An app keeps running in a visitor's browser after it's taken down | Any read with a `Service-Worker` header is refused (`handle.ts:459`). Static answers are cached for 60 s and code answers aren't kept (`handle.ts:189`, `:429`). Not-found carries `Clear-Site-Data: "cache"` (`handle.ts:208`) | Holds, as a best effort for what was already cached | Spike C (WebKit kept a worker). `handle.test.ts` |
| T17 | A forged or replayed event starts a release | A release starts only from `requestRelease` or `deploy_release` and a person's approval. No webhook path records one (`crates/core/src/release_request.rs:1-7`) | Holds | `release-request.spec.ts`. Not exercised on staging |
| T18 | Repository content is treated as instructions | The job reads a fixed directory, `site/`. A manifest has exactly `main` and `store`, where `store` is a kind and never an ID (`crates/core/src/app_code.rs`). `_headers` and `_redirects` fail a release. Nothing under the two validation folders may be in a release (`crates/core/src/release_tree.rs`) | Holds | `app_code.rs`, `release_tree.rs`. Staging: M6-R11 (`_headers` fails the release with a reason code) |
| T19 | A failed release is shown as live | Each attempt is its own record. Live is set only after the job confirms what is served | Holds | Staging: M6-R11 and M6-R12 ("Merged · Deployment failed", never Live) |
| T20 | A second room takes over a dangling custom hostname, or squats one | As T9. The hostname object refuses a second room's claim, and frees one only after Cloudflare reads the hostname gone | Holds | Staging: X15-2 (two rooms race, one claimed, one `hostname_claimed`), X26-1 |
| T21 | One room's phishing page gets the whole content domain blocklisted | Not prevented while the Public Suffix List entry is missing, as the row says. Per-room hosts, reports and suspension | A known consequence | Staging: M6-R14 |
| T22 | The publishing credential replaces the content Worker itself | The row counts on "the reconcile compares the content Worker's deployed version". **That isn't built** ([the plan's step 4(a) note](../m6-plan.md#what-step-4as-third-pr-built)): no code reads either Worker's deployments | **No.** F-3 | None |
| T23 | A visitor's first request to an app's host is plain HTTP | The content Worker answers plain HTTP with a `301` to HTTPS by the request's own scheme, never a header (`handle.ts:465`), and sends HSTS on every answer, with `includeSubDomains` on the content domain only (`handle.ts:179-181`) | In part, as the row says: `.site` isn't preloaded | `handle.test.ts`. Staging: X14-3 (HSTS without `includeSubDomains` on a custom host) |
| T24 | A workflow in the repository deploys by itself | No workflow holds any Cloudflare credential, so a workflow can't deploy. Provisioning reads Actions back as off (`apps/api/src/github.rs:843-857`) | Holds for deploying | M5's runs |

### What the table misses

| # | Threat | Control as built | Holds? | Evidence |
| --- | --- | --- | --- | --- |
| N1 | A certificate authority's HTTP validation for a customer's name is answered by an app under `*/*` | Three locks. The zone has routes on `/.well-known/acme-challenge/*` and `/.well-known/pki-validation/*` that run no Worker, which `scripts/deploy-content` makes before either Worker and checks after. The content Worker answers its own `404` there on every host and method (`handle.ts:65-71`, `:449`). A release can't hold files there | Holds | `handle.test.ts`. Staging: X14-4 on `war3.org`, the custom hostname's own certificate issued by HTTP validation with the routes in place |
| N2 | A visitor's request steers what the app sees | The app gets a new request with the URL, method and three of the visitor's headers. A write's body is read up to 64 KiB and its `Content-Length` is the body's own (`handle.ts:240-248`, `:294-318`) | Holds | `requests.test.ts`, `handle.test.ts`. Staging: M6-C05 |
| N3 | An app redirects a visitor off its host | A redirect is passed only to a path on the same host, and never one with a control character, space or backslash (`handle.ts:227-232`, `:417-422`) | Holds | `handle.test.ts` |
| N4 | A deploy script runs with the wrong account or a leaked token | `scripts/deploy-content` re-runs itself in a clean `env -i` bash, refuses tracing, `BASH_ENV`, a token in the environment and the package's own `account_id`. It takes the token from a file into stdin only, and stops with exit 4 on any check it can't read (`scripts/deploy-content:18-110`). Agents run it only without `--deploy`. `scripts/deploy-staging` refuses a setting held as a secret, an unclean checkout and a stale suffix list | Holds | `config.test.ts` in both packages pins the `wrangler.jsonc` guards. Owner's deploys of 2026-11-24 and 2026-11-25 |
| N5 | A limit stops an app after its headers were sent (C09) | The content Worker passes the app's body as a stream. It can't take back a status already sent | See [C09](#c09-the-truncated-200) | Staging: M6-C09 recorded |
| N6 | A room's data outlives its app | See [CX1](#cx1-store-deletion-after-an-unpublish) | In part | See there |

## The items owed to this review

### The reconcile's read token, and how far it reaches

**What it is.** The store reconcile has no read token of its own. It uses `CONTENT_STORE_TOKEN`, the one the release job uses to make stores and the deletion job uses to delete them (`apps/api/src/app_stores.rs:176-190`, `apps/api/src/store_reconcile.rs:446`). It was meant to hold D1 Edit alone on the second account ([staging.md](../staging.md), the secrets table).

**What it can reach.** D1 Edit is account-wide. It can list, read, query, write and delete every D1 database in the second account, so every room's store. The store spike saw a D1 Read token run a `SELECT`, and D1 Edit can do more. By the store spike's row 2 it can't reach KV, so it can't write serve entries. It also can't reach scripts. Both are inferred from tokens that also held Workers Scripts Edit.

**What the code uses it for.** The reconcile only lists and reads by ID (`store_reconcile.rs:341`, `:458`). Its test reads the stand-in's calls and finds no delete. A separate D1 Read token would gain no isolation, since the same Worker holds both. The PR's review was right on that.

**Assessment.** The reach is acceptable while the second account holds nothing of Podster's but the content Worker, the outbound Worker, the KV namespace and the counter, which has no D1. Two checks are still owed before production:

- **The second account's repeat of the store spike, with a D1-Edit-only token** ([staging.md](../staging.md) still says so). Staging's stores were made with whatever token the owner set. This review can't see whether it holds only D1 Edit.
- **A check that no D1 database other than rooms' stores is ever put on the second account.** Its token reaches them all.

Rated **before production** (F-4).

### CX1: store deletion after an unpublish

**Does the code guarantee it?** Yes, once two conditions hold: a store provider is configured, and every host's serve entry is confirmed down.

- **Owed in the same transaction as the unpublish.** Every unpublish for good retires the current label and owes its store's deletion as `label_retired`, in the unpublish's own transaction (`apps/api/src/workspace/takedown.rs:441-470`). The unpublish also clears the kept rollback script and the commit in flight (`takedown.rs:342`). A store can't be left reachable through them.
- **The deletion job is due at once and never gives up.** The room's alarm is set from `store_delete::next_due` (`apps/api/src/workspace.rs:3999-4006`, `store_delete.rs:284-295`). Retries back off from 5 s to 5 minutes.
- **It deletes only once nothing can reach the store** (`store_delete.rs:119-160`). Every host must be confirmed down by applied state, with no kept or in-flight script and no live release bound to the store.
- **Gone needs D1's own not-found on two reads at least 10 minutes apart.** The delete's own answer is never trusted.
- **Twelve tries in a row that decide nothing raise `store_delete_failing`** to operators, with `held` or `unconfirmed`.

**What it doesn't guarantee:**

- **No store provider:** nothing is deleted. The job isn't scheduled, and the owner's command answers `data_delete_unavailable`.
- **A serve entry never confirmed down** holds the deletion indefinitely. It is reported only as `held`.
- **An operator's suspension keeps the store,** by the ruling of 2026-11-16, until a permanent cause or the operator's delete.
- **Room and organization deletion have no source.**
- **D1 keeps a recoverable copy for up to 7 days.** The owner's approved wording says so.

**Evidence:** `crates/core/tests/app_store_delete.rs` (run here: 8 passed), `app-store-delete.cases.ts` and `takedown.spec.ts` against D1's stand-in. **It was never seen against real D1.** M6-C10 and M6-C11 ran the unpublish, but CX1 was out of scope, since a test person can't see the store. Showing it needs a check from the operator's side: list the second account's D1 after an unpublish, wait out the two reads, and list again. Rated **before production** (F-5). Until it is shown, the "deleted now" notice rests on the stand-in.

### C09: the truncated 200

When a limit stops an app after its headers were sent, the content Worker has already handed the status and the stream on (`handle.ts:402-405`, `:432`). The visitor gets a `200` with the bytes sent before the stop. M6-C09 saw 6 bytes, and the body ended normally.

**Why it's a nit.** It affects only that app's own answer. A code host's answers are `no-store` (`handle.ts:429`), so no cache keeps the cut answer. Every answer is readable only by the origin `null`. No other room, host or Podster answer is touched. A static host runs no app code, so it can't hit this. The only way to prevent it is to buffer a code app's whole body before the status is sent, which costs memory and latency for every answer. **Recommended:** accept it, and tell app authors that a cut answer can look complete. Rated **nit** (F-6).

### Are 50 CPU ms and 50 subrequests a dispatch safe?

**CPU: yes, and tight.** Cloudflare's Workers for Platforms pricing charges one request for the whole chain of dispatch, user and outbound Worker, and charges CPU across all three. So one request to a code app costs at most about $0.30 per million in requests plus 50 ms of CPU, about $1.00 per million. The plan's own default would be 30 s. 50 ms stops a spinning app, as M6-C08 showed.

**Subrequests: safe, and higher than any use.** Every `fetch` an app makes goes to the outbound Worker and is refused, and that costs no extra request. So 50 subrequests buys an app nothing but 50 refusals and their small CPU. Lowering it to a few would lose nothing an app can use today. Check first whether the static-assets fetch counts against it, since M6-C02 and M6-C03 passed at 50.

**What neither limit bounds: store writes.** The store spike found a D1 call doesn't count against the subrequest limit. Most of a D1 call's time is I/O, not CPU, so 50 ms of CPU doesn't bound how many writes one request makes. That's F-1.

**Verdict:** safe for staging and pilots. The figures stay the owner's to accept. Rated **nit** (F-10), with the store-write gap in F-1.

## Findings

**Ratings:** **Blocking for gate** must be closed or ruled on before the whole gate is called. **Before production** is owed before anything is served in production. **Nit** is small or a record only.

| ID | Rating | Finding | Where | Checked |
| --- | --- | --- | --- | --- |
| F-1 | Before production | **The write cap doesn't bound store writes.** An app's code runs for every `GET` and `HEAD` to a code host (`handle.ts:401-405`), and its `STORE` binding can write while handling one. The counter is asked only for write methods (`handle.ts:373-384`). D1 calls don't count as subrequests (store spike, row 6). So anyone can drive an approved app's writes through plain reads, uncounted. The bound is then the app's CPU and D1's own limits, per request, with no per-app total. The ruling that "the write counter is the only bound on writes" (store ruling, item 5) assumed writes come from write requests. Exposure today is limited to apps a person approved in a public room on staging | `apps/content/src/handle.ts:373-405`, `apps/content/src/counter.ts:156-169` | reading |
| F-2 | Before production | **No ceiling on total spend on the second account is recorded.** Reads are uncapped by decision 4b ("reads go on"), and an alert on the bill was the owner's to set. This review found no record that it was set. Together with F-1, nothing bounds what visitors cost in a month | ADR 0010's revision, row 4b; `docs/m6-plan.md` | reading |
| F-3 | Before production | **The threat model's control for T22 isn't built.** No reconcile reads the content Worker's or the outbound Worker's deployed version. A holder of `CONTENT_SCRIPTS_TOKEN` could replace `podster-content`, to serve anything on the domain, or `podster-outbound`, to let apps' `fetch` through. Nothing would notice until a person looked. Spike G showed how to read the version | `apps/api/src/reconcile.rs` (no such step); `docs/m6-plan.md` step 4(a)'s third PR, "isn't compared" | reading |
| F-4 | Before production | **The store token reaches every app's data on the second account,** read, write and delete. That's acceptable. But the D1-Edit-only token has never been tried there, so that it reaches nothing else is inferred | `apps/api/src/app_stores.rs:5-17`, `:176-190`; `docs/staging.md` secrets table | reading |
| F-5 | Before production | **CX1: store deletion after an unpublish is guaranteed by the code once a store provider is configured and every host is confirmed down, but it was never seen against real D1.** Deletion is held indefinitely while a serve entry isn't confirmed down | `takedown.rs:441-470`, `store_delete.rs:119-160`, `:284-295` | test (stand-in) |
| F-6 | Nit | **C09:** a limit hit after the headers were sent gives a cut `200`. It affects only that app's own answer and is never cached | `handle.ts:402-405`, `:432` | staging run, recorded |
| F-7 | Nit | **Each proof of a custom hostname rests on one DNS-over-HTTPS resolver** (`https://cloudflare-dns.com/dns-query`), with no second resolver and no check of DNSSEC's AD flag. An attacker would have to forge that resolver's answer over HTTPS, so the risk is low | `apps/api/wrangler.jsonc:89`, `apps/api/src/hostname_proof.rs:41-47` | reading |
| F-8 | **Blocking for gate** | **Criterion 8's "documented policies" don't exist** for custom domains, release approvals, or export and transfer. The plan says "none is written", and `docs/legal/terms.md` and `acceptable-use.md` don't cover hosted apps, custom domains or app data. The gate requires criterion 8 "all of it", and the threat model's T11 row says "the terms cover it". This is a documentation fix, not code. The owner's three calls each covered part of the gate, and none waived this | `docs/m6-plan.md:746`, `:757`, `:2800`; `docs/legal/` | reading |
| F-9 | Nit | **Nothing in code refuses a `CONTENT_ACCOUNT_ID` that is Podster's own account.** The second-account stance rests on the owner's setup and their check | `scripts/deploy-staging:41-46` | reading |
| F-10 | Nit | **The per-dispatch limits are safe:** 50 CPU ms bounds a request's cost. But 50 subrequests is more than any use, since every outbound call is refused. The figures are still the owner's to accept | `apps/content/wrangler.jsonc:34`, `apps/content/src/limits.ts:31-37` | reading; Cloudflare's pricing page |
| F-11 | Nit | **Stale comments that understate what is configured or read.** `release_recheck.rs:51` says `organization_may_release` "isn't read yet", but it is read (`:310`). The headers of `content_provider.rs:8-10`, `app_stores.rs:12-17` and `custom_hostnames.rs:6-9` say no environment binds their settings, but staging binds them now | as named | reading |

## Fixes the findings need

None is made here.

- **F-1:** the architect rules on a bound for store writes made during reads. Options:
  - count every dispatch to a code host, reads too, against a per-app request budget;
  - read the second account's D1 usage per database on the hourly reconcile, and suspend an app past a ceiling;
  - accept it with F-2's spend ceiling as the bound.
  
  A test at the deployment then shows the chosen bound.
- **F-2:** the owner sets a Workers spending limit or a billing alert on the second account, and the plan records which. A spending limit there interrupts the content Worker too, so it's a trade-off.
- **F-3:** the reconcile reads `podster-content`'s and `podster-outbound`'s live deployments with a read token on the second account. It compares them with the versions `scripts/deploy-content` recorded, and raises an operator finding on a difference. This is a contract change if it adds a finding code.
- **F-4:** run the second account's repeat of the store spike with a D1-Edit-only token. Record what it can and can't reach, and record that the second account holds no other D1 database.
- **F-5:** an operator-side check on staging. Unpublish an app with a store, then show D1's list without that database once the two reads are done. Also add a staged alert for `held` past some age.
- **F-6:** none. Optionally, a line in what an app author is told.
- **F-7:** optionally require two resolvers to agree before a claim, or check the AD flag where the zone is signed.
- **F-8:** write the three policies, and a short addition to the terms and acceptable-use drafts for hosted apps, custom domains and app data, for the owner's approval. Then rerun or cite the checks that show each policy is kept.
- **F-9:** keep it as the owner's check, or add the account's ID as a hash the API compares against.
- **F-10:** the owner accepts or changes the figures. Consider subrequests at a small number once it's checked whether static-asset fetches count against it.
- **F-11:** correct the comments in the next PR that touches each file.

## Gate items this review doesn't settle

- **The Public Suffix List entry for `podster.site`** is still the owner's (T1, T21).
- **X14-6, X26-2 and X26-3 on a deployment** are still open, as the custom-domains call says.
- **`RELEASES` and a provider in production** are the owner's.
- **Question 24, rerunning M2's and M4's staging scripts at the gate's commit,** wasn't checked here.
