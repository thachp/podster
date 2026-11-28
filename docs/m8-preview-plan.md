# M8 plan: workroom previews before production

**Proposed, 2026-11-27, by the planning architect. Its owner decisions were decided the same day: the owner answered "Accept all" to eight of them, Q1 to Q10, as recommended; Q11 and Q12 followed on 2026-11-28, when the owner answered "sure" ([Owner decisions](#owner-decisions); [decisions 250 to 259](spec/PRODUCT.md#m8-preview-decisions-november-27-2026)). Nothing is built.** It answers [issue #635](https://github.com/thachp/podster/issues/635), "feat(ship): add workroom preview deployments before production". It reverses part of [decision 214](spec/PRODUCT.md#decisions-needed) and touches decisions 213 and 216, which the owner's answers in [Owner decisions](#owner-decisions) settled. The matching ADR note is [ADR 0010, revision: previews](adr/0010-revision-previews.md), accepted with them.

**Revised 2026-11-27, after the security review of this plan at `33135fc2`.** Three changes. First, no token travels in a URL's path or query: the ticket goes in a fragment, and the session is bound to the state cookie on every request ([5.3](#53-the-flow)). Second, every flow starts on the preview host, including the dashboard's Open preview. Third, the differences between a preview and production are stated, with options to narrow them ([5.2.1](#521-what-differs-between-a-preview-and-production)). The review's nits are folded in: exact cookie names, case-variant and nameless-cookie tests, same-origin writes, `Origin-Agent-Cluster`, a rate limit on `/v1/preview-access`, and a production gate on (D) or the PSL entry.

Citations are `file:line` on `main` at `55ac33ac`, decision numbers in [PRODUCT.md](spec/PRODUCT.md#decisions-needed), and Cloudflare's documentation by URL. "Seen" means a spike or staging run showed it. "Read" means documentation says it. Anything else is reasoning, and is marked as such or owed to a spike.

## Contents

1. [What the issue asks, and what stands in its way](#1-what-the-issue-asks-and-what-stands-in-its-way)
2. [Headline design](#2-headline-design)
3. [How a preview is stored and served](#3-how-a-preview-is-stored-and-served)
4. [Immutable builds, and publishing the build that was tested](#4-immutable-builds-and-publishing-the-build-that-was-tested)
5. [Access control on preview hosts](#5-access-control-on-preview-hosts)
6. [Private rooms](#6-private-rooms)
7. [A custom preview hostname](#7-a-custom-preview-hostname)
8. [Credentials and writable data](#8-credentials-and-writable-data)
9. [Contracts, events and migrations](#9-contracts-events-and-migrations)
10. [UI: the Ship panel](#10-ui-the-ship-panel)
11. [Staging acceptance test](#11-staging-acceptance-test)
12. [Build order](#12-build-order)
13. [Threat model](#13-threat-model)
14. [Owner decisions](#owner-decisions)
15. [What this plan checked, and what it didn't](#what-this-plan-checked-and-what-it-didnt)

## 1. What the issue asks, and what stands in its way

The issue's goal: a workroom owner opens and tests a hosted preview of a reviewed, merged commit before approving it for production. Its six criteria, shortened: one active preview per room, created or replaced from a merged commit, a failed replacement keeping the last working preview; a generated preview host under `podster.site` and an optional verified custom hostname; private previews behind current workroom access on both hostnames, with noindex; production untouched, retry-safe jobs, separate credentials and writable data; publishing approved by a person for the exact build tested; and a staging run proving all of it. Concurrent and per-PR previews are out of scope.

What stands today:

- **One environment, no preview.** Decision 214 (`docs/spec/PRODUCT.md:726`) set one environment, `production`, and refused "a preview environment, which would serve unreviewed agent work to the internet". Decision 219 (`:731`) kept "one environment, `production`, and no preview of unmerged code". ADR 0010's revision lists "Only a public room releases; one environment; no preview" under what doesn't change (`docs/adr/0010-revision-apps-are-workers.md:402`). The code holds it as a constant: `ENVIRONMENT = "production"` (`crates/core/src/release.rs:32`), and `requestRelease` refuses any other environment (`packages/contracts/openapi.yaml:801-808`).
  - **What the issue asks is narrower than what 214 refused.** 214 refused previews of *unmerged, unreviewed* work. The issue's preview is of a *reviewed, merged* commit, the same commits production may serve (`crates/core/src/release.rs:156-178`, `releasable_commit`). So this reverses 214's "one environment", not its "no unreviewed code". That keeps the release path's strongest control.
- **Only a public room releases.** Decisions 199 and 213 (`PRODUCT.md:711`, `:725`), ADR 0010 (`docs/adr/0010-release-and-the-content-domain.md:44-51`) and `require_public_room` (`crates/policy/src/release.rs:643`). The reason given is the one this plan must answer: "the content Worker can't tell who is asking" (`0010-release-and-the-content-domain.md:49`). Decision 213 named the candidate, "a signed, expiring link for the room's own people, which needs a design and a review of its own" (`PRODUCT.md:725`), and the owner on 2026-11-14 asked that serving a private room's app, "which needs visitor sign-in on the content Worker", be revisited as its own decision (`PRODUCT.md:800`). This plan is that design.
- **No cookie and no credential on the content domain.** "Podster sets no cookie on any content host and accepts no credential there" (`0010-release-and-the-content-domain.md:123`), and decision 210's remainder says the same (`PRODUCT.md:722`). The content Worker builds the app's request from three headers and nothing else (`apps/content/src/handle.ts:248-256`, `apps/content/src/requests.ts:31-33`), so no cookie reaches an app.
- **Every app is strictly sandboxed.** Decision 216 (`PRODUCT.md:728`). `sandboxPolicy` sets `sandbox allow-scripts` and nothing else, and a test forbids the word that gives a page its origin back (`apps/content/src/handle.ts:147-168`). This collides with any cookie gate: see [section 5.2](#52-the-collision-with-the-sandbox).
- **The content Worker is on another Cloudflare account.** Decision 217 (`PRODUCT.md:729`). Service bindings reach only Workers "on your Cloudflare account" ([service bindings](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/), read), so the content Worker can't ask the private API anything per request. It reads one KV namespace that only the API writes (`0010-release-and-the-content-domain.md:109`; `apps/content/wrangler.jsonc`).

## 2. Headline design

- **Storage:** a preview is a release record whose environment is `preview`, run by the release job unchanged in its steps, uploaded as its own user Worker into a **second dispatch namespace** that holds previews only, under a room's **preview label**, distinct from and never shared with its production label. It gets its **own store** (one D1 database per preview label), its own write budget, and its own serve entry in a form a production host can never read. One preview slot per room; replacing uploads a new script beside the current one and switches only once the new one's marker comes back, so a failed replacement leaves the last working preview serving.
- **Immutability:** every upload gets a **build ID**, a SHA-256 over the commit, the release directory's git tree, every served file's SHA-256 manifest hash, every module's SHA-256, and Podster's own upload form, with Podster's marker and binding targets left out. Publishing is a **re-upload**, not a promotion: Workers for Platforms dispatches by script name only, and a store binding is fixed at upload, so the production script must be its own upload. The production job recomputes the build ID from what it fetched and refuses to go live on any difference. The approval names the build ID, so replacing the preview can't move it.
- **Access:** a **gate in the content Worker** on preview hosts only. The private API (Rust) decides access and signs; the content Worker checks signatures with a public key and holds no secret. A visitor without a session starts on the preview host, which sets a `__Host-` **state cookie** and sends them to the application host. The API checks current access and returns a **60-second ticket bound to the host and to that state**. It reaches the preview host **only in the URL fragment**, which no server or log ever sees, and a fixed Podster page posts it back same-origin. The content Worker exchanges it for a **`__Host-` session cookie** (HttpOnly, Secure, SameSite=Lax, host-only, at most one hour) on that preview host alone. **The session is bound to the state cookie too, and both are checked on every request,** so no token that travels anywhere is usable without the browser's own state cookie. Revocation is an **access epoch** in the preview's serve entry, which the room raises whenever who may see it changes. Production hosts never set or read any cookie. The `__Host-` prefix makes the cookie safe from sibling hosts whether or not `podster.site` is on the Public Suffix List. The price: the gate only works if a preview page keeps its own origin, which **narrows decision 216 for preview hosts**, and is the owner's. **So a preview doesn't run exactly as production will:** it has an origin, browser storage and same-origin requests, where production is opaque, has no storage and answers `Access-Control-Allow-Origin: *` or `null`. [Section 5.2.1](#521-what-differs-between-a-preview-and-production) lists the differences, and the Ship panel says them.

## 3. How a preview is stored and served

### 3.1 Pieces

| Piece | Production today | Preview, proposed |
| --- | --- | --- |
| Record | `release` row, environment implied `production` (`release.rs:32`) | `release` row with `release_environment = 'preview'` (Workspace step 59, [section 9.4](#94-migrations)) |
| Label | Random, `[a-z0-9]{1,26}`, never reused (`0010-release-and-the-content-domain.md:57`, `release.rs:327-383`) | A second random label from the same space, the room's **preview label**, held in the same never-reused index (`apps/api/migrations/0008_app_label_index.sql`) with a kind column. Kept across preview replacements so bookmarks and a custom preview hostname stay; retired when the preview is deleted |
| Host | `<label>.podster.site`, one level deep, under the zone's one wildcard certificate (`0010-release-and-the-content-domain.md:67`) | `<preview label>.podster.site`, the same form. **Not** `preview-<label>`: a hyphen isn't in the label grammar (`apps/content/src/names.ts:12`, `:20`), and a second level (`x.preview.podster.site`) isn't covered by Universal SSL ([limitations](https://developers.cloudflare.com/ssl/edge-certificates/universal-ssl/limitations/), read; seen failing in spike C, `0010-release-and-the-content-domain.md:67`). The host's kind comes from its serve entry, never its name |
| Script | `<label>.rel_<id>` in the production namespace (`names.ts:12`) | `<preview label>.rel_<id>`, the same grammar, in the **preview namespace** |
| Namespace | `CONTENT_DISPATCH_NAMESPACE` | A new one, `CONTENT_PREVIEW_NAMESPACE`. Cloudflare's own guidance: "If you need to test changes safely, create a separate `staging` namespace" ([how Workers for Platforms works](https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/how-workers-for-platforms-works/), read). A cloud change, the owner's |
| Serve entry | `[code:]<script>` for a default host, `[code:]<script>@<host>` for a custom one (`names.ts`, `podster_core::serve_entry`) | A new mark, `preview:`, with the access epoch: `preview:<epoch>:[code:]<script>[@<host>]`. The content Worker dispatches a `preview:` entry **only** through the preview namespace binding and an unmarked entry **only** through the production one, so neither can name the other's script. Mirrored in `packages/contracts/serve-entry.fixture.json` |
| Store | One D1 per production label, bound as `STORE` (`apps/api/src/workspace/release_store.rs:1-12`, `crates/core/src/app_code.rs:127`) | One D1 per **preview label**, made and deleted by the same module. A Rust check refuses an upload whose store binding names another environment's store |
| Write budget | Per label (`handle.ts:386-387`) | Per preview label, so preview traffic never spends production's budget |
| Kept scripts | Live and the one before, a third while uploading (decision 202, 203) | The serving preview and, while replacing, the one uploading. No preview rollback: a new preview of the earlier commit does the same job |

### 3.2 The preview slot, and replace semantics

- **One active preview per room.** The room holds one preview slot: its label, its access epoch, and a serve state of the same shape as production's (`ServeState`, `crates/core/src/release.rs:452-470`), with one or two hosts (default, and custom when claimed). It is a second `ServeState`, never mixed into production's, so nothing a preview does can write a production host. That is a type-level separation in `crates/core`, tested.
- **Create or replace** is one command: "make this merged commit the preview". With no slot, it makes one and draws a label. With a serving preview, it records a new preview release and leaves the slot serving the old one.
- **A replacement goes live only when its marker comes back.** The release job's order is reused unchanged (`0010-release-and-the-content-domain.md:241-277`; `crates/core/src/release_marker.rs:1-16`): upload the new script, commit it live in the room's transaction, the applier switches the serve entry, the job fetches the marker through the host; seen, the release is `served` and the previous preview release `replaced`; not seen in time, `set_back` restores the entry and the new release is `failed`. **So a failed replacement leaves the last working preview serving,** and production never moves, since nothing in the preview path holds a production host.
- **One replacement in flight at a time,** by the same identity rule as production (`ServeState.in_flight`, `release.rs:436-450`). A second replace while one is in flight is refused `preview_in_flight`, not queued. Production and the preview each have their own flight, so a preview job never waits on a production one, or the reverse.
- **The marker through a gated host.** The job's marker fetch has no session. It carries a **marker token**: the same signature as a ticket, `typ: "marker"`, bound to the host and the marker path (`.well-known/podster-release.json`, `crates/core/src/release_tree.rs:18`), valid 60 seconds. The gate accepts it for that path alone, with `GET`. The marker holds only the release's ID and commit (`release_tree.rs:499-502`).
- **Deleting the preview** is a person's command: the slot's hosts go to nothing, the label retires, the scripts are deleted, the store is owed its deletion, exactly as an unpublish does for production (`release.rs:1020-1054`, decision 204). Production is untouched.

### 3.3 What deletes a preview without anyone asking

Every one of decision 204's unpublish triggers (`PRODUCT.md:716`; `release.rs:772-830`) also deletes the preview: release switched off in the room or for the deployment, the room archived or deleted, its organization deleted, its public surface or app suspended, an operator taking release from the organization (decision 218), and its repository stopped or lost. **Added for previews:** the preview switch (`PREVIEWS`) off for the deployment. **Not a trigger,** if the owner allows private previews ([Q2](#owner-decisions)): the room changing visibility. That raises the access epoch instead ([section 5.6](#56-revocation)).

Operator suspension keys on labels and hosts (decision 205, `PRODUCT.md:717`), so the preview label and preview hosts must be reachable by it. The domain-wide stop (`handle.ts:219-232`) covers preview hosts with no change.

### 3.4 The release job's reuse, and retry-safety

Nothing new runs a job. The preview is a release record with an environment, so it inherits, unchanged:

- **Records before sends.** A store's name and `create_sent_at` are written before the create goes out, and a lost answer is settled by a whole list read (`release_store.rs:7-12`, `:19-27`). An upload's lost answer moves the release to `uncertain`, settled by Cloudflare's own read of that exact script (`release.rs:186-200`, `release_uncertain.rs`).
- **A recheck on every pass,** of every outside fact (`apps/api/src/workspace/release_recheck.rs`; `RELEASE-POLICIES.md:212-217`), extended with the preview switch and the slot's identity.
- **Idempotency keys** on every command, as every route has (`openapi.yaml:807`, `#/components/parameters/idempotencyKey`).
- **Final states take no event,** so a late or duplicated job changes nothing (`release.rs:239-247`, `:286-317`).
- **Read budget and caps.** A preview takes GitHub reads from the same 3,000-an-hour deployment budget (decision 202, `PRODUCT.md:714`) and upload attempts from the room's same hourly allowance. Proposed: previews and releases share the room's 20 asks a day (`release.rs:14`), so a preview can't double a room's upload rate.

## 4. Immutable builds, and publishing the build that was tested

### 4.1 What a build is

Podster builds nothing: built files are committed (decision 220, answer 3, `PRODUCT.md:732`; `app_code.rs:15-16`). So a build is fully named by what the job fetched. The job already verifies each fetched file's length and **git blob SHA** against the tree (`release_tree.rs:370-380`, `check_fetched`), and hashes every file with **SHA-256** for the asset manifest, never relying on SHA-1 for what is served (`release_tree.rs:458-470`).

**The build ID**, proposed, computed in `crates/core` with no I/O:

```
bld_<first 32 hex of SHA-256 over>:
  podster-build/1
  form <Podster's upload form version: COMPATIBILITY_DATE, ASSETS_CONFIG, STORE_BINDING_NAME, MODULE_UPLOAD_TYPE>
  commit <40-hex commit>
  tree <git tree SHA of the release directory>
  file <served path> <manifest hash>        (sorted; every served file except Podster's marker)
  module <name> <SHA-256 of bytes>          (sorted)
  main <entry module or "-">
  store <yes|no>
```

Left out on purpose: the script name, the label, the store's database ID and Podster's marker body, which are the only things that differ between a preview upload and a production upload of the same commit. Included on purpose: Podster's own upload form, so a change to `COMPATIBILITY_DATE` (`app_code.rs:131`) between preview and publish changes the build, and publishing asks for a new preview.

### 4.2 Promotion or re-upload

**Re-upload. Promotion isn't possible as the platform stands, and wouldn't be safe if it were.**

- **No version can be selected for a user Worker.** A dispatch Worker calls a user Worker by name: `env.DISPATCHER.get("worker-name")` ([how Workers for Platforms works](https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/how-workers-for-platforms-works/), read). "Gradual Deployments is not supported yet for user Workers. Changes made to user Workers create a new version that deployed all-at-once to 100% of traffic" ([Workers for Platforms limits](https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/reference/limits/), read). **Not found** in the documentation: any API that copies or renames a user Worker, or moves one between namespaces.
- **Bindings are fixed at upload.** The store binding is part of the script's metadata (`app_code.rs:127`, `release_store.rs`). A production script must bind production's store, and a preview script the preview's, so one script can't serve both.
- **Pointing the production host at the preview's script** is refused three ways: the content Worker serves a default host only from a script under its own label (`handle.ts:519-520`), the preview script is in the other namespace, and it binds the preview store.
- **What guarantees "exact build":** both uploads are made from bytes fetched at the same commit and verified by git blob SHA against the same tree, hashed by SHA-256, and the build ID over those hashes plus Podster's upload form must match. Cloudflare's asset store is content-addressed too: an upload session returns only the hashes it doesn't already hold, "Unmodified files will not be returned in the `buckets` field ... if they have recently been uploaded" ([direct upload](https://developers.cloudflare.com/workers/static-assets/direct-upload/), read), so the production upload reuses the very objects the preview stored. That is supporting, not the control: the control is Rust comparing build IDs.

### 4.3 Publishing from a preview

- **A publish is a production release request that names a preview release,** not a commit: `from_preview: <rel_ id>`. Refused unless that preview release reached `served` (it was tested), with its build ID recorded; the commit is taken from it and still checked by `releasable_commit`. Every existing production rule applies: public room ([Q3](#owner-decisions)), grant, rechecks, caps (`RELEASE-POLICIES.md:190-217`).
- **The approval is bound to the build.** `approveRelease` takes no body today (`openapi.yaml:810-816`). For a release made from a preview it requires `{ "build": "bld_..." }`, the build ID the approver was shown, and refuses `release_build_changed` (409) if it isn't the release's. So a person approves exactly what the dialog showed.
- **Replacing the preview can't move an approval.** The production release names its preview release and build ID, both immutable. Replacing the preview makes a new preview release with its own ID; the pending publish still names the old one. Proposed: a pending publish stays valid after its preview is replaced, since that build was tested; the Ship panel says the preview now shows something else ([section 10](#10-ui-the-ship-panel)).
- **The production job recomputes the build ID** from what it fetched, after the tree check and before commit live, and fails the release `build_mismatch` on any difference. A failed publish is any failed release: the current production release stays live (`release.rs:186-200`; decision 203).
- **Publishing without a preview** stays possible, as today, unless the owner wants previews required ([Q6](#owner-decisions)).

## 5. Access control on preview hosts

### 5.1 Requirements

From the issue: current workroom access on both hostnames; anonymous visitors, wrong organizations and revoked members refused; a generated hostname grants nothing; noindex. From the specs: Rust decides authority and the gateway only authenticates and translates (`CLAUDE.md`, "Rules that must hold"); read models never authorize; the application's session never leaves `app.podster.dev`'s host (ADR 0001, `docs/adr/0001-application-host-and-session-cookie.md:13-15`); and nothing on the content domain can reach the application (`0010-release-and-the-content-domain.md:123`).

### 5.2 The collision with the sandbox

**Any cookie gate fails for a strictly sandboxed page's own requests.** Under `sandbox allow-scripts` without `allow-same-origin` the page's origin is opaque (`handle.ts:150`; seen in spike C, `0010-release-and-the-content-domain.md:152`). By the Fetch standard, a module script and a `fetch()` default to credentials mode `same-origin`, and an opaque origin is never the same origin as the host, so **no cookie is sent** on them. Classic scripts and images use `include`, but SameSite then treats the request as cross-site (the opaque top-level site matches nothing), so a `Lax` cookie isn't sent either, and a `None` cookie meets third-party cookie blocking. That is reasoning from the standards, not seen; [spike P1](#12-build-order) confirms it. Spike C also found a sandboxed app loads its own files only with `Access-Control-Allow-Origin: *` (`0010-release-and-the-content-domain.md:153`), which no credentialed request may use.

**The options:**

| | How subresources are authorized | Keeps decision 216 strict | Works on a custom hostname | What it costs |
| --- | --- | --- | --- | --- |
| **(A) Sandbox with `allow-same-origin` on preview hosts only** | The `__Host-` cookie, same-origin, on every request | No, on preview hosts | Yes | A preview page gets its origin, its own storage, and `document.cookie`, so it can set cookies for the whole of `podster.site` ([5.5](#55-the-public-suffix-list-and-cookie-tossing)) |
| (B) A per-viewer session host, `<random>.podster.site`, minted per ticket, no cookie | The host name is the bearer credential, for its lifetime | Yes | No: a custom hostname is one exact name, and wildcards are refused (decision 207) | A bearer URL that leaks through history, sync and screen sharing, which ADR 0010 already rejects as a control (`0010-release-and-the-content-domain.md:49`); a KV entry per viewer; a second scheme beside the custom hostname's |
| (C) Gate only navigations; serve subresources to anyone | Nothing | Yes | Yes | Fails the criterion: a generated host would be the grant for everything but the HTML |
| (D) A separate registrable domain for previews, with (A) | As (A) | No, on preview hosts | Yes | As (A), but a preview's domain cookies reach only other previews, never production apps. A domain purchase and a zone, the owner's |

**Recommended: (A), on staging now, with (D) put to the owner before production.** (B) is the only one that keeps 216 strict, but it rests on the control ADR 0010 refused and can't serve a custom preview hostname. (A)'s cost is bounded: see [5.5](#55-the-public-suffix-list-and-cookie-tossing).

#### 5.2.1 What differs between a preview and production

**Said plainly: under (A), a preview isn't a byte-for-byte rehearsal of production's runtime.** The build is the same ([section 4](#4-immutable-builds-and-publishing-the-build-that-was-tested)); the browser's treatment of it isn't.

| | Production host (decision 216, `handle.ts:156-202`) | Preview host, under (A) | What an app must tolerate |
| --- | --- | --- | --- |
| Page origin | Opaque (`null`) | The preview host's own | Code that reads `location.origin` or `document.domain` sees different values |
| Browser storage | None: cookies, `localStorage`, `sessionStorage`, IndexedDB, the Cache API all refused with `SecurityError` (seen in spike C, `0010-release-and-the-content-domain.md:151`) | All available, on the preview's origin | **The big one.** An app that keeps anything in the browser works in preview and breaks in production |
| The page's own requests | Cross-origin, `Origin: null`; answered `Access-Control-Allow-Origin: *` (static) or `null` (code), `handle.ts:170-175` | Same-origin, with the real `Origin`; no `Access-Control-Allow-Origin` at all | App code that checks `Origin`, or sends custom headers needing a preflight, behaves differently |
| Cookies on requests | None ever reach the app (`handle.ts:248-256`) | None reach the app either; Podster's two `__Host-` cookies stop at the content Worker | Nothing |
| Caching | `max-age=60, no-transform` on an app's answers (`handle.ts:197`) | `private, no-store` | Repeat loads are slower in preview |
| Writes | Taken under the request rules for a host with code (`apps/content/src/requests.ts`) | The same rules, and refused unless `Sec-Fetch-Site: same-origin` ([5.8](#58-headers-on-preview-hosts)) | Nothing for an app's own page |
| Service workers | Refused | Refused | Nothing |

**Options to narrow it, weighed:**

- **Serve production the same way for gated rooms.** It only applies if a private room's production app is gated, which Q3 recommends against. For public production it would give every production app its origin and storage before the Public Suffix List entry, so rooms' apps could read each other's domain cookies again: the thing decision 216 closed. **Not recommended.**
- **Keep everything else identical.** The preview CSP is production's, directive for directive, plus `allow-same-origin`; the header allow-list and refusals are the same. **Recommended, and required by step 8.**
- **A storage warning on the preview.** At preview time Rust searches the build's text files for the names `localStorage`, `sessionStorage`, `indexedDB`, `document.cookie` and `caches.open`, and the Ship panel shows "This build may use browser storage, which production apps don't have." It is a string search of agent content treated as data, never an instruction, and it never blocks. It will miss things and flag false positives, and says so. **Recommended.**
- **State the differences** in the Ship panel and the approval dialog ([section 10](#10-ui-the-ship-panel)) and in what app authors are told. **Recommended.**
- **A strict-mode preview**, served opaque with a per-viewer bearer host as in (B). It would rehearse production exactly but brings back the bearer URL. **Not now;** possible later as an opt-in.

### 5.3 The flow

Names below are proposed. `<host>` is a preview host, default or custom. **Rule: the content Worker answers every request under `/__podster/` itself, on every preview host and every production host, for every method, before the gate, before the stop and serve-entry reads where they aren't needed, and before any dispatch.** An app is never asked for that prefix. Paths it doesn't define get its own `404`, as `isValidationPath` does for the validation folders (`handle.ts:64-76`, `:489`). This is the control, because an app with code answers any path its module is asked for. Refusing the prefix in a release tree, beside `VALIDATION_DIRECTORIES` (`release_tree.rs:38`), is only a second lock that keeps static files from shadowing it in a listing. Tested by P15.

**Every flow starts on the preview host,** because only the preview host can set its state cookie. The application host never starts one: its `/preview-access` page refuses a request with no `st`, and the dashboard's **Open preview** is a plain link to `https://<host>/` ([section 10](#10-ui-the-ship-panel)).

**No token ever travels in a URL's path or query.** The query to the application host carries the host, a hash of the state and a same-host return path, none of them a credential. The ticket travels only in a URL fragment, which browsers never send to any server, so no access log, Cloudflare's included, records it, and no `Referer` carries it. Both cookie values stay in cookies.

1. **A request with no valid session.** The gate checks both `__Host-` cookies ([5.4](#54-the-ticket-the-session-and-what-the-content-worker-checks)).
   - **A top-level navigation** (`GET`, `Sec-Fetch-Mode: navigate`, or `Accept` naming `text/html` when that header is absent): if the browser has no valid state cookie, the content Worker makes a random 32-byte state and sets it as `__Host-podster_preview_state` (HttpOnly, Secure, Path=/, SameSite=Lax, Max-Age 12 hours). A state that is already there is kept, so two tabs don't undo each other. It answers `303` to `https://app.podster.dev/preview-access?host=<host>&st=<SHA-256 of state, base64url>&r=<path and query, same-host only>`.
   - **Anything else:** `401 preview_access_required`, `no-store`, never a redirect, so a page's `fetch` can't loop.
2. **The application host** (`apps/web`, which holds the person's session under ADR 0001). Signed out, it signs the person in and comes back. Signed in, it calls the gateway, which calls the API with the person's assertion: `POST /v1/preview-access { host, st, r }`. **Rate-limited,** proposed: 30 a minute for each person and 300 an hour for each room, refused `preview_access_limit` (429), the per-person count in the person's own Principal object and the per-room count in the room's own Workspace object, so neither needs a read model.
3. **The API decides, in Rust.** It finds the room by the host: a generated host by the label index (`0008_app_label_index.sql`, a read model used only to route), a custom one by its hostname object (decision 201). The room then answers from its own state alone: the host must be its current preview host, the preview must exist and not be suspended, and the caller must pass `podster_policy::preview::may_view` ([5.7](#57-who-may-view)). Unknown host, wrong room, no access and no preview all answer one code, `preview_access_refused` (404), so the route doesn't tell anyone which hosts exist. On success the room records a session row (`preview_session`: session ID, person, created, expires) and signs a ticket.
4. **The application host redirects** `303` to `https://<host>/__podster/enter#t=<ticket>&r=<path>`, to the host the API returned, never one taken from the query unchecked. The ticket is in the fragment only. The response carries `Referrer-Policy: no-referrer` and `Cache-Control: no-store`.
5. **`GET /__podster/enter`** arrives with no ticket, since the fragment isn't sent. The content Worker answers it with one fixed page of Podster's, never an app's: no sandbox, `Content-Security-Policy: default-src 'none'; script-src 'sha256-<its one inline script>'; connect-src 'self'; frame-ancestors 'none'; form-action 'none'; base-uri 'none'`, `no-store` and `no-referrer`. Its headers also carry `sandbox allow-scripts allow-same-origin` in the CSP, so the page can run its one script with its own origin and nothing else (no forms, popups or top navigation by the sandbox), and `Cross-Origin-Opener-Policy: same-origin`, so no other window keeps a handle to it. Its script reads the fragment, removes it at once with `history.replaceState`, and posts `{ t, r }` as JSON to `/__podster/enter` with `credentials: "same-origin"`.
6. **`POST /__podster/enter`, the exchange.** Refused unless `Sec-Fetch-Site: same-origin` and `Origin` is this host. The ticket must pass: signature, `aud` equal to the request's host, `typ: "ticket"`, `exp` not passed, `st` equal to the SHA-256 of this browser's state cookie, and `ep` not below the epoch in the host's serve entry. Then the Worker sets `__Host-podster_preview=<session token>` (HttpOnly, Secure, Path=/, SameSite=Lax, Max-Age at most 3,600), **whose claims carry the same `st`**, refreshes the state cookie's Max-Age, and answers `200 { r }` with `r` checked to be a path on this host (the same rule as `sameHostPath`, `handle.ts:235-240`). The page then navigates to `r`. The state cookie is **kept**, not cleared: the session is bound to it.
7. **Every later request** to `<host>` carries both cookies. The gate checks the session token **and that its `st` equals the SHA-256 of the state cookie sent with it**, before reading anything of the app. So a session token copied out of a browser, a log or a crash report is useless without that browser's state cookie, and so is a ticket.

**Nothing of this is logged.** The content Worker logs one line, for a failed dispatch only (`handle.ts:46-47`). A test holds that no `/__podster/` request writes any line. The application host's and gateway's logs carry IDs only (`CLAUDE.md`), and `/preview-access`'s query holds no secret anyway. Cloudflare's own invocation logs see URLs, and the ticket is never in one.

### 5.4 The ticket, the session and what the content Worker checks

- **Signed by the private API, verified with a public key.** Ed25519 (supported by WebCrypto in Workers). The private key is a new API secret, `PREVIEW_TICKET_KEY`, with `PREVIEW_TICKET_KEY_PREVIOUS` for rotation, as `REPO_TOKEN_KEY` rotates (`docs/staging.md:379-400`). The content Worker gets the public keys as plain variables by key ID, through `scripts/deploy-content`'s configuration. **So the content Worker still holds no secret** (`apps/content/src/index.ts:1-4`), and can't mint anything.
- **Claims,** all IDs or hashes, never content: `typ` (`ticket`, `session` or `marker`), `kid`, `aud` (the exact host), `pvw` (the preview slot's ID), `sid` (the session's ID), `ep` (the access epoch at signing), `iat`, `exp`, and for a ticket and a session alike `st` (the state hash). No person ID: the room maps `sid` to the person.
- **Cookie names match exactly, case-sensitively:** `__Host-podster_preview` and `__Host-podster_preview_state`, and nothing else. A `__host-` spelling, a cookie with no name, or a second cookie of the same name refuses the request (`401`, the flow again on a navigation), never picks one. Browsers' handling of case variants and nameless cookies differs, which spike P1 tests.
- **Lifetimes, proposed:** ticket 60 seconds; session at most 1 hour; marker 60 seconds. An expired session on a navigation goes round the flow again without a click while the person is signed in on the application host; on a `fetch` it is `401 preview_session_expired`.
- **The content Worker's check is enforcement, not a decision.** Rust decided and signed; the Worker compares bytes and numbers, as it compares a serve entry's label today (`handle.ts:519-520`). ADR 0010's "routes and never authorizes" (`0010-release-and-the-content-domain.md:109`) is restated in the revision note as "enforces only what Rust signed or wrote".
- **One KV read a request is kept:** the epoch rides in the serve entry the Worker already reads (`handle.ts:510-515`). Signature checks are CPU only.

### 5.5 The Public Suffix List, and cookie tossing

`podster.site` isn't on the Public Suffix List; the entry is still owed before production (decision 249, `PRODUCT.md:761`; `docs/security/m6-review.md:177`). Without it, a browser treats every `*.podster.site` host as one site for cookies: a cookie set with `Domain=podster.site` reaches every host (seen in spike C, `0010-release-and-the-content-domain.md:125`).

- **Host-only cookies alone aren't enough.** A sibling can't read a host-only cookie, but it can set a same-named cookie for the whole domain, and the browser sends both. A server that reads "the" cookie may read the attacker's: that is cookie tossing, and it allows session fixation.
- **The `__Host-` prefix closes it.** A browser accepts a `__Host-` cookie only with `Secure`, `Path=/` and no `Domain`, from a secure origin (RFC 6265bis, cookie name prefixes). So no sibling host can set a `__Host-podster_preview` cookie that this host receives, with or without the list's entry. The gate reads only the `__Host-` names and ignores every other cookie. **The safe choice before the entry: `__Host-` cookies only, which this plan requires.** Spike P1 checks it in Chromium, Firefox and WebKit, as spike C did for the sandbox.
- **Even a tossed or forged cookie value gives nothing:** the value is a session token whose signature, `aud`, `ep` and `st` the Worker checks, the last against a second `__Host-` cookie.
- **Two known gaps in `__Host-`, tested by spike P1:** case variants (a sibling setting `__HOST-podster_preview` or `__host-...` for the whole domain, which some browsers once accepted without the prefix's rules) and nameless cookies (a cookie with an empty name whose value is `__Host-podster_preview=...`, which a server can read as a prefixed cookie). The exact, case-sensitive match and the refusal of duplicates and nameless cookies above answer both on the server, whatever a browser does.
- **SameSite gives nothing between `*.podster.site` hosts** until the entry is on the list, since they are one site. So the gate refuses every state-changing request (anything but `GET`, `HEAD` and an allowed preflight) on a preview host unless `Sec-Fetch-Site: same-origin`, and refuses one without that header unless `Origin` is the host itself. A sibling preview can't drive another preview's writes with its viewer's session.
- **What (A) still leaves open, and why it's bounded:**
  - A preview page with its origin can set domain-wide cookies. **No app ever receives them:** the content Worker forwards no `Cookie` header to any app (`handle.ts:248-256`), and production pages are sandboxed and can't read `document.cookie` (decision 216).
  - **Jar eviction, a residual risk.** Filling the shared per-domain cookie jar can push out other hosts' cookies, so another preview's viewer is sent round the flow again: a nuisance. **And on its own host it can plant a session.** A preview app's script fills the jar until the browser evicts both of Podster's HttpOnly cookies, then sets its own `__Host-podster_preview` and `__Host-podster_preview_state` with `document.cookie` (a page may set `__Host-` cookies for its own host). If the pair is a valid one the attacker got as a member of that room, the victim's later requests to that one host run under the attacker's session. **What it gains:** little. It works only on the host whose own code is doing it, which already controls that origin and everything the victim does there. It gives no access to any other host or to the application, and it needs a pair from someone who may view that very preview. What changes is whose session the content Worker sees, and the attacker's session lasts until its hour or an epoch raise. It can't come from a sibling host, which can evict but can't set this host's `__Host-` cookies. **Recorded as a residual for staging;** it ends at the production gate, where previews need a separate registrable domain or the Public Suffix List entry ([Q9](#owner-decisions)). Spike P1 measures eviction in each browser.
  - **Cookie bombing:** enough large domain cookies make that browser's requests to every `*.podster.site` host too large for the edge. It hits only browsers that opened that preview, which are the room's own people, and the code is reviewed and merged. Accepted as a residual for staging only. **A production gate:** previews aren't served in production until either (D), a separate registrable domain for previews, or the Public Suffix List entry for the domain they're on is in place ([Q9](#owner-decisions)).
  - **A preview's own storage** (`localStorage`, IndexedDB) lives on the preview's origin, which is stable across that room's replacements and never reused by another room (labels are never reused).
- **Service workers stay refused** on every host (`handle.ts:494-499`), which holds "even if the sandbox were ever loosened".

### 5.6 Revocation

- **The access epoch.** The preview slot holds a counter. The room raises it, in the same transaction, whenever who may view can shrink: a participant removed, a role lowered, the room's owner changed, the room made private or public, a person invitation revoked, the preview deleted, an operator's suspension. The applier writes the new epoch into the preview hosts' serve entries. A session or ticket with a lower `ep` is refused, and the viewer goes round the flow again; those who still have access get a new session without a click.
- **How fast:** the Worker reads entries with a 30-second edge cache (`handle.ts:79`), and KV says changes "may take up to 60 seconds or more to be visible" elsewhere ([how KV works](https://developers.cloudflare.com/kv/concepts/how-kv-works/), read). So revocation is about a minute, not instant, and is bounded in every case by the session's hour.
- **A person leaving their organization** isn't a room event. The room already checks the gateway's assertion of a person's organizations on each request (decision 30, `PRODUCT.md:542`), so a person who left is refused at the next ticket; the open session lasts at most its hour. Proposed: the existing notice path that tells rooms of an organization departure also raises the epoch.
- **Not chosen: a call to the API on every request.** Impossible across accounts ([1](#1-what-the-issue-asks-and-what-stands-in-its-way)), and it would put the private API on the content domain's hot path.

### 5.7 Who may view

Proposed, in `crates/policy` as a pure read: a **person** whose own role in the room lets them see it, by the same rule the dashboard uses (`authorize_workroom`, `crates/policy/src/lib.rs:537`): owner, admins, members and guests. **Not:** an agent (it doesn't browse, and gets no ticket); someone in the room only through a public claim (as `may_release_now` excludes them, `RELEASE-POLICIES.md:192-195`); an organization admin's read-only oversight (decision 7, `PRODUCT.md:519`); a person from another organization with no role here. A cross-organization person with an accepted person invitation has their own role (decision 239) and may view. [Q4](#owner-decisions) asks whether a public room's preview is also gated; recommended yes.

### 5.8 Headers on preview hosts

Every answer from a preview host, the gate's own included:

- `X-Robots-Tag: noindex, nofollow, noarchive`; and `/robots.txt` answered by the content Worker itself, before the gate, with `Disallow: /`.
- `Cache-Control: private, no-store`, not production's `max-age=60, no-transform` (`handle.ts:197`). `no-transform` is kept too, against the analytics beacon spike C saw injected (`0010-release-and-the-content-domain.md:136`).
- **No `Access-Control-Allow-Origin`** on any preview answer. Same-origin requests don't need it, and leaving it out keeps other sites from reading gated content.
- `Origin-Agent-Cluster: ?1`, so the browser keeps each preview origin in its own agent cluster and `document.domain` can't join it to a sibling.
- State-changing requests refused unless same-origin ([5.5](#55-the-public-suffix-list-and-cookie-tossing)).
- Unchanged: `Referrer-Policy: no-referrer`, `nosniff`, HSTS (`handle.ts:194-196`), the header allow-list on app answers (`handle.ts:139`), `Set-Cookie` from an app never passed.
- The CSP for a preview host is `sandboxPolicy` with `allow-same-origin` added, built by a separate, named function, so the production function and its test stay exactly as they are.

### 5.9 Custom preview hostnames and access

The same flow, with `aud` the custom host and the cookie host-only on it. The customer's other subdomains can toss cookies onto it, and the `__Host-` prefix answers that as on `podster.site`. A custom hostname's certificate appears in certificate-transparency logs (`0010-release-and-the-content-domain.md:49`), so its name is public; the name grants nothing.

## 6. Private rooms

Two questions, to be kept apart:

- **Preview in a private room, behind access: in scope, recommended.** It is what the issue's third criterion is about, and the gate exists for it. The source is already public, since managed repositories are public (decision 181, `RELEASE-POLICIES.md:223`), so what the gate protects is the running app, its store's data, and the fact of what isn't released yet.
- **Production in a private room: out of scope, and still refused** `release_needs_public_room` (decision 213, `PRODUCT.md:725`). Serving a private room's production app to its own people is the same gate on production hosts, which this plan doesn't propose: production hosts keep no cookie and no credential at all. If the owner wants it later, it is its own decision on top of this one.
- **A publish from a private room's preview** is refused as any private room's release is. The room must be public to publish. So the flow for a private room is preview only, until the owner rules otherwise ([Q3](#owner-decisions)).
- **Deploy grants are given only in a public room** (`RELEASE-POLICIES.md:194`). Creating a preview needs no grant ([Q5](#owner-decisions)), so a private room's owner and admins can preview without one.

## 7. A custom preview hostname

Reuse M6's custom-domain machinery whole: Podster's room-bound TXT challenge at `_podster-challenge.<name>`, 72-hour pending that reserves nothing, one hostname object per normalized name, the daily recheck, Cloudflare for SaaS's own validation beside it, and ending by deleting the custom hostname and reading until gone before the claim is freed (decisions 201 and 207, `PRODUCT.md:713`, `:719`; `0010-release-and-the-content-domain.md:383-420`; `RELEASE-POLICIES.md:20-160`).

- **A role on each claim:** `production` or `preview`. A room may hold at most one of each, so `MAX_HOSTNAMES_PER_ROOM` (`crates/core/src/hostnames.rs:46`) becomes one per role.
- **Independent status.** The preview's claim has its own request, proof, Cloudflare status and recheck. Its DNS and TLS state show apart from production's.
- **Conflicts.** One name, one claim, whatever its role: the hostname object already holds at most one live claim (decision 201), so a name used for production can't also be a preview, in this room or another. Refusing the same name for both roles in one room is a new check in `hostnames.rs`. Podster's own names stay refused (`hostnames.rs:30`).
- **Serving.** Routing starts only when the room holds the claim and Cloudflare reports it active (`hostnames.rs:926`, `routing_may_start`); the entry is written in the preview form with the epoch, and the gate applies.
- **Removal.** Disconnecting, the claim failing its recheck, the preview being deleted, or any trigger in [3.3](#33-what-deletes-a-preview-without-anyone-asking) ends the claim by the existing order: serve entry cleared, custom hostname deleted at Cloudflare and read until gone, then freed (`hostnames.rs:728`, `may_free_claim`). Its route goes with it.
- **A preview with no slot** can't hold a claim: asking for a preview hostname before the first preview exists is refused `preview_none`.

## 8. Credentials and writable data

What "separately from production credentials and writable data" can mean here, honestly:

- **The app's side: fully separate.** A preview script gets no binding but its own `STORE` (decision 206: no secrets or bindings, `PRODUCT.md:718`), a different D1 database from production's, its own write budget, and it lives in another namespace. No production data is reachable from preview code, or the reverse. Rust refuses an upload whose store record belongs to the other environment.
- **Builds: nothing to separate.** Podster runs no build (decision 220, answer 3). The release App's read-only token, made for the one repository and never leaving the job (decision 198, `PRODUCT.md:710`), reads for both.
- **Podster's publishing tokens: shared, because Cloudflare can't scope below the account.** `CONTENT_SCRIPTS_TOKEN` is "Workers Scripts Edit", account-wide (`docs/staging.md:433`; `0010-release-and-the-content-domain.md:347`); the routing and store tokens are account-wide likewise (`docs/staging.md:434-435`). Separate preview tokens would grant exactly the same reach. The only real separation would be a third Cloudflare account for previews, with its own zone or domain. **Not recommended:** another account, another set of owner steps, and no gain against the threat that matters, which is preview code reaching production data, already closed above.
- **New secret:** `PREVIEW_TICKET_KEY` (and `_PREVIOUS`), API only, the owner's to set. **New plain settings:** `CONTENT_PREVIEW_NAMESPACE` in the API; the public keys and the preview namespace binding in the content Worker's deploy-time configuration. **New cloud resource:** the preview dispatch namespace. All the owner's (`CLAUDE.md`, "Working in parallel").
- **The F-items carry over.** F-1, reads driving uncounted store writes (`docs/security/m6-review.md:142`), applies to preview stores too; F-3's missing deployed-version check (`:144`) must also cover the preview namespace binding the content Worker gains.

## 9. Contracts, events and migrations

**`CLAUDE.md`: only one PR at a time may change `packages/contracts` or add a migration, and those merge first.** The owner's nudge of 2026-11-18 makes it a merge order, not a build order. So the contract PR (step 3) and the migration PR (step 5) are each built in parallel with others and merged alone.

### 9.1 Routes (gateway translates; the API decides)

| Route | Who | What |
| --- | --- | --- |
| `GET /v1/workspaces/{ws}/preview` | A person who may view ([5.7](#57-who-may-view)) | The slot: state, commit, task, build ID, served-at, default host, custom hostname and its status, the replacement in flight or failed with its reason |
| `POST /v1/workspaces/{ws}/tasks/{t}/preview` | Owner or admin, as a person | Create or replace from that task's merged commit. Refusals in production's order where they apply (`openapi.yaml:801-806`), plus `previews_off`, `preview_in_flight`, `preview_limit` |
| `DELETE /v1/workspaces/{ws}/preview` | Owner or admin, as a person | Delete the preview, its scripts and owe its store's deletion |
| `PUT`, `DELETE` `/v1/workspaces/{ws}/preview-hostname`, `POST .../preview-hostname/check` | Owner or admin, as a person | As `app-hostname` (`openapi.yaml:834-860`), for the preview role |
| `POST /v1/preview-access` | Any signed-in person | `{ host, st, r }` to `{ redirect }`, whose ticket is in the fragment only; `preview_access_refused` (404) for every refusal; `preview_access_limit` (429) past 30 a minute a person or 300 an hour a room. A request with no `st` is `invalid_argument`: only the preview host starts a flow |
| `POST /v1/workspaces/{ws}/releases` | As today | Gains `from_preview: rel_...` in `RequestRelease` |
| `POST /v1/workspaces/{ws}/releases/{release}/approve` | As today | Gains a body `{ build }`, required for a release made from a preview; `release_build_changed` (409) |

### 9.2 Capabilities

- **No `deploy_preview` tool in this pass** (recommended, [Q5](#owner-decisions)). A preview runs merged, reviewed code and costs a store and an upload, but the issue asks for an owner's action, and decision 230 keeps Runner's agent from releasing (`PRODUCT.md:742`).
- **`get_task_release_status`** (`packages/contracts/capabilities.yaml:68`) gains the preview's state and commit for that task, **never a host or link**: an agent gets no ticket, so a link is useless to it, and hosts stay out of agent-readable content.
- If the owner later allows agents: `deploy_preview`, needing a live `deploy` grant as `deploy_release` does (`capabilities.yaml:69-74`), never approving, absent from Runner's allowlist under decision 230.

### 9.3 Events and outbox

ID-only, as every event (`CLAUDE.md`, logs carry IDs only; decision 31): `preview.requested`, `preview.served`, `preview.failed` (with reason code), `preview.replaced`, `preview.deleted`, `preview.access_revoked` (epoch raised, no names), `preview_hostname.requested`/`.claimed`/`.ended`, and `release.requested` gaining `from_preview` and `build`. Told to the room's owner and admins who are people, as `release.*` are. No host, label or link in any event. The outbox gains nothing new: the release driver's job carries an environment, and the applier writes preview entries as it writes production's.

### 9.4 Migrations

All forward-only, each step a new table so it reruns safely, as step 58 does (`apps/api/src/store.rs:583-590`). The latest Workspace step is 58.

| Where | Step | What |
| --- | --- | --- |
| Workspace DO | 59 | `release_environment (release_id PK, environment CHECK IN ('production','preview'))`. No row means `production`, so every existing release stays production |
| Workspace DO | 60 | `preview_slot` (one row): label, access epoch, serve versions, in-flight, created, deleted |
| Workspace DO | 61 | `release_build (release_id PK, build_id, tree_sha, form_version)` and `release_from_preview (release_id PK, preview_release_id, build_id)` |
| Workspace DO | 62 | `preview_session (sid PK, person_id, created_at, expires_at)`, pruned by the alarm |
| Workspace DO | 63 | `custom_hostname_role (request_id PK, role CHECK IN ('production','preview'))`. No row means `production` |
| Hostname DO | its next step | The claim's role |
| D1 | `0010_app_label_kind.sql` | `app_label_kind (label PK, kind CHECK IN ('production','preview'))` beside `app_label_index`. A read model that only routes |

## 10. UI: the Ship panel

The demo (`apps/demo`) is the UI's source of truth since 2026-11-24, so the screen is mocked there first, then built in `apps/web`. Under **Ship** (`docs/spec/DESIGN.md:27`), proposed:

- **Production card**, as today: the served release's commit, task, when, its link.
- **Preview card**:
  - **State chip:** None, Building, Ready, Replacement failed (still serving the previous one), Deleting. Orange only when it needs the viewer (the three-pane direction's rule).
  - **Commit and task**, the short commit linking to the repository; **build** as `bld_` and its first 8 characters, with the full ID on hover and a copy button.
  - **Open preview**, a plain link to `https://<preview host>/`. The preview host starts the flow ([5.3](#53-the-flow)): it sets its state cookie and sends the person through the application host and back, with no click while they're signed in. The host is shown as text too, with "Opening this address needs access to this room".
  - **"Previews aren't production"**, a line under the link: "A preview can use browser storage and its own address. Production apps can't: they run with no cookies or browser storage." With the storage warning ([5.2.1](#521-what-differs-between-a-preview-and-production)) when the build may use storage.
  - **Custom preview hostname** row: name, DNS proof status, TLS status, Connect and Disconnect, independent of production's row.
  - **Replace preview** (pick a completed task with a merged commit) and **Delete preview**, owner and admins only.
  - **A failed replacement:** "Replacing with <commit> failed: <reason>. The preview still shows <commit>."
- **Publish this build** on a Ready preview, for those who may ask for a release, in a public room only; in a private room it shows why it can't.
- **The approval dialog** shows the build ID in full, the commit, when that build reached the preview, who asked, and, if the preview has since been replaced, "The preview now shows a different build. You are approving <bld_…>, which was tested on <date>." It also says: "This build ran in the preview with browser storage and its own origin. In production it runs sandboxed, with neither, so anything that worked only because of them will break." and repeats the storage warning if the build has one. Approve sends `build`.

## 11. Staging acceptance test

`e2e/m8-preview-staging.mjs`, with `-lib.mjs` and `-selftest.mjs`, in the style of `e2e/m6-code-app-staging.mjs` (`:1-50`): run from GitHub Actions (`.github/workflows/m8-preview-staging.yml`, by hand, environment `staging-e2e`), since the owner's machine filters `podster.site`; output IDs and codes only, hosts printed as `[preview host]` and `[app host]`, the ticket and cookies scrubbed; clean-up on every way out. Node's `fetch` with a hand-kept cookie jar shows the server's behaviour; browser behaviour is spike P1's.

**People:** four test sign-ups (of 6 a minute and 40 a day): the owner, an admin, a member who will be removed, and a person in another organization. **Rooms:** one disposable public room (for publishing), and, if the owner allows private previews, one private room for the access cases. **GitHub:** one public repository in `podsterdev`, two merged commits, A and B, each with a small app with code and a store.

| ID | What it shows |
| --- | --- |
| P01 | Signed out: capabilities list no preview tool; an unknown preview host answers the content Worker's own not-found |
| P02 | Release A to production through the existing path; production serves A's marker |
| P03 | Preview B: the slot reports Building then Ready with B's commit and a build ID; production still serves A's marker throughout |
| P04 | Anonymous: a navigation to the preview host is `303` to the app host's `/preview-access`, with a `__Host-` state cookie; a `fetch`-style request is `401`; neither shows anything of B |
| P05 | The owner completes the flow: ticket, exchange, `__Host-podster_preview` with HttpOnly, Secure, SameSite=Lax and no Domain; then B's marker, a read and a write reach the preview app; answers carry `X-Robots-Tag: noindex` and `Cache-Control: private, no-store` and no `Access-Control-Allow-Origin`, and `Origin-Agent-Cluster: ?1`; no ticket ever appears in any URL the script saw outside a fragment |
| P06 | The other organization's person: `/v1/preview-access` answers `preview_access_refused`, the same as for an unknown host |
| P07 | A ticket replayed with another state cookie, an expired ticket, a ticket for another host and a forged signature are all refused; **the session cookie's value replayed with another state cookie, or with none, is refused**; a cookie set by hand without the prefix, a `__host-` spelling, a duplicate and a nameless cookie all refuse; an exchange `POST` without `Sec-Fetch-Site: same-origin` is refused; `/v1/preview-access` without `st` is refused, and past its limit answers 429 |
| P07b | A write to the preview from a sibling host's origin (`Sec-Fetch-Site: same-site`) carrying a valid session is refused |
| P15 | On a host whose app has code and answers every path (the test app returns its own body for any request), every method to `/__podster/enter`, `/__podster/x` and `/__podster/`, on the preview host and on the production host, gets the content Worker's own answer, never the app's body |
| P08 | The member opens the preview, is removed, and within the bound (about a minute, polled to 3) is refused and can't get a new ticket |
| P09 | Data: a write on the preview isn't visible on production, and the reverse |
| P10 | Replace with a commit whose app fails its marker (a third commit, C, made to fail): the preview stays on B, production on A, the replacement `failed` |
| P11 | Custom preview hostname, on the CI-only test domain the M6 custom-domain run uses: proof, active, the flow on that host, then disconnect: the host stops serving and the route is gone |
| P12 | Publish B: the request names the preview release; approval with A's build ID is `release_build_changed`; with B's, it is approved; production then serves B's marker, and the production release records B's build ID |
| P13 | Replace the preview with A after the publish request and before approval: the approval still binds to B's build, and production ends on B |
| P14 | Delete the preview: preview hosts not-found, production still on B; the preview store gone after the takedown (read as M6-CX1 reads, `m6-code-app-staging.mjs:13-16`) |

**What it can't show:** browser cookie and sandbox behaviour (spike P1), revocation latency beyond the one sample, and the PSL-dependent cases.

## 12. Build order

Each step is one PR. **C** changes `packages/contracts`; **M** adds a migration. **Deep** marks a security-sensitive PR that, under `CLAUDE.md`, gets more than the quick diff review, asked for before it runs. Estimates are builder-days, rough.

| # | PR | C/M | Review | Est. | Needs |
| --- | --- | --- | --- | --- | --- |
| 0 | This plan and the ADR note | | quick | done | |
| 1 | Owner answers recorded as decisions 250 to 259; ADR note accepted | | quick | done | Owner: "Accept all", 2026-11-27; "sure" to Q11 and Q12, 2026-11-28 |
| 2 | **Spike P1**, browser facts on `podster.site` test hosts: cookies under `sandbox allow-scripts` with and without `allow-same-origin`; `__Host-` against a sibling's tossing in Chromium, Firefox and WebKit; **case-variant (`__HOST-`, `__host-`) and nameless-cookie tossing** from a sibling; jar eviction; SameSite on the redirect chain; the fragment surviving the `303` and `history.replaceState` removing it from history; `Origin-Agent-Cluster`; WebKit's tracking prevention on a cookie set through a redirect | | quick | 1.5 | Owner: a test Worker on the content zone, as spike D had |
| 3 | Contracts: routes, schemas, events, `get_task_release_status` fields, the serve-entry fixture's preview form | **C** | quick | 1 | 1 |
| 4 | Core and policy, pure: environment, preview slot `ServeState`, build ID, publish binding, `may_view`, ticket claims and limits, epoch rules, hostname roles | | **Deep** | 3 | 3 |
| 5 | Workspace steps 59 to 63, the hostname object's step, D1 `0010` | **M** | quick | 1 | 4 |
| 6 | API: preview requests, the job with an environment, preview store, applier writes preview entries, triggers in 3.3, reconcile over both namespaces | | **Deep** | 4 | 5 |
| 7 | API and gateway: `/v1/preview-access`, sessions, signing, epoch raises; `apps/web`'s `/preview-access` page | | **Deep** | 3 | 6 |
| 8 | Content Worker: the gate, the preview namespace binding, the preview CSP and headers, `/__podster/` with its fixed exchange page and same-origin `POST`, the session bound to the state cookie on every request, exact cookie-name matching, the same-origin rule for writes, `Origin-Agent-Cluster`, robots, marker token, no log line for any `/__podster/` request; `scripts/deploy-content` configuration (report only, as agents may run it) | | **Deep** | 3 | 3, 2 |
| 9 | Publish from a preview: `from_preview`, approval `build`, the production job's build check | | **Deep** | 2 | 6 |
| 10 | Custom preview hostname | | quick, plus a look at conflicts | 2 | 6 |
| 11 | Ship panel: demo first, then `apps/web` | | quick | 3 | 7, 9 |
| 12 | `e2e/m8-preview-staging.mjs` and its workflow; the staging run after deploy | | quick | 2 | all |
| 13 | M8 security review, `docs/security/m8-review.md`, independent of the authors | | **Deep** (asked first) | 2 | 12 |

**About 28 builder-days** before the security review's fixes, with 4 and 8 and 10 able to run beside 6 and 7. Steps 3 and 5 merge alone, in that order, after any other contract or migration PR open at the time. Deploys to staging go through `scripts/deploy-staging`; the content Worker's deploy, with its new binding and keys, is the owner's at a terminal (`CLAUDE.md`, "Scripts agents must use").

## 13. Threat model

New rows only; M6's stand (`docs/m6-plan.md:2821-2850`; `docs/security/m6-review.md:41-80`).

| Threat | Mitigation | Shown by |
| --- | --- | --- |
| A preview's address is shared or leaks, and an outsider opens it | No access without a ticket from Rust after a policy check; the host grants nothing | P04, P06 |
| A ticket or session token leaks through history, logs or a Referer | No token is ever in a URL's path or query: the ticket travels in a fragment, which no server sees, and is removed by `history.replaceState`; the session stays in a cookie. Both are bound to the browser's `__Host-` state cookie, checked on every request, so a copied value is useless elsewhere; ticket 60 seconds, session an hour; `no-referrer` on both hosts; no log line for `/__podster/` | P07 |
| A sibling preview drives another preview's writes with its viewer's session (SameSite gives nothing within `*.podster.site` before the PSL entry) | Writes refused unless `Sec-Fetch-Site: same-origin`, or `Origin` is the host | P07b |
| `/v1/preview-access` used to probe which hosts exist, or flooded | One refusal code for every case; 30 a minute a person, 300 an hour a room | P06, P07 |
| Login CSRF or fixation: an attacker makes a victim's browser take the attacker's session | The state cookie binding: a ticket works only in the browser that started the flow; `__Host-` cookies can't be set by a sibling | P07, P1 |
| Cookie tossing from a sibling host before the PSL entry | `__Host-` prefix; the gate reads only `__Host-` names; values are signed and host-bound | P1 |
| Cookie bombing or jar eviction by a preview page with its origin, including evicting Podster's cookies and planting an attacker's session on that one host | No app receives cookies; the reach is browsers that opened that preview; a planted session works only on the host whose code planted it; ends at the production gate, (D) or the PSL entry | P1 (accepted residual for staging) |
| An app with code answers `/__podster/` and fakes the exchange page | The content Worker answers the whole prefix itself before any dispatch | P15 |
| A preview page reads the session cookie | HttpOnly | P05 |
| A revoked member keeps viewing | Access epoch raised in the room's transaction; about a minute; at most the session's hour | P08 |
| Preview code reaches production data, or the reverse | Separate namespace, store, budget and entry form, checked in Rust and in the content Worker | P09 |
| A production host is made to serve a preview script | Entry forms are disjoint and dispatch through different namespace bindings; the label check stays | unit tests, P03 |
| An approval is moved to another build | Approval carries the build ID; the publish names an immutable preview release; the job recomputes the build | P12, P13 |
| The content Worker is replaced to skip the gate | As T22 today; F-3's version check must include the new binding and keys | F-3 |
| The ticket key leaks | API secret only; rotation with `_PREVIOUS`; the content Worker holds public keys only | review |
| Preview content indexed or cached by a shared cache | `noindex`, `robots.txt`, `private, no-store` | P05 |
| Phishing on a gated preview, styled as Podster's sign-in | Same as production's row, plus: only the room's own people can reach it | as M6 |

## Owner decisions

**Q1 to Q10 decided by the owner on 2026-11-27,** in the words "Accept all", to the architect's list of eight items (the architect grouped the plan's questions into eight items: Q2 with Q3, Q7 with Q8, Q10 into item 8), each as recommended below, recorded as decisions 250 to 257 in [PRODUCT.md](spec/PRODUCT.md#m8-preview-decisions-november-27-2026). The owner was told of and accepted the trade-off with them: `allow-same-origin` on preview hosts, narrowing decision 216 there only, and the jar-eviction residual on staging. Recommendations are the architect's. **Q11 and Q12 decided by the owner on 2026-11-28,** in the word "sure", as recommended (decisions 258 and 259). **Still the owner's:** which production gate under Q9.

| # | Question | Recommendation | Not taken | Decided |
| --- | --- | --- | --- | --- |
| Q1 | Reverse decision 214's "one environment" for a second environment, `preview`, of reviewed, merged commits only? | **Yes.** It keeps 214's real control, nothing unmerged or unreviewed is served, and needs no change to what is releasable | Keep one environment and close #635 | Decided, as recommended: [decision 250](spec/PRODUCT.md#decisions-needed) |
| Q2 | May a private room have a preview, behind the gate? | **Yes.** It is the issue's third criterion; the source is already public (decision 181); the gate protects the running app and its data | Previews in public rooms only | Decided, as recommended: [decision 251](spec/PRODUCT.md#decisions-needed) |
| Q3 | May a private room publish to production? | **No, unchanged** (decision 213). Publishing still needs a public room. Revisit separately if wanted | Gate production hosts too | Decided, as recommended: [decision 251](spec/PRODUCT.md#decisions-needed) |
| Q4 | Is a public room's preview gated too? | **Yes,** to people with a role in the room. A preview is unapproved work | Public room previews open to anyone | Decided, as recommended: [decision 252](spec/PRODUCT.md#decisions-needed) |
| Q5 | May agents create previews? | **Not in this pass.** People only, owner and admins, no grant needed; agents see state, not links | `deploy_preview` with a grant | Decided, as recommended: [decision 253](spec/PRODUCT.md#decisions-needed) |
| Q6 | Must production be published from a preview? | **No, optional,** so today's path keeps working; a room may require it later as a setting | Required for every release | Decided, as recommended: [decision 254](spec/PRODUCT.md#decisions-needed) |
| Q7 | The access mechanism: tickets from the API, delivered in a URL fragment; a `__Host-` session cookie bound to a `__Host-` state cookie, on preview hosts only; and preview pages given their origin (`allow-same-origin`), **narrowing decision 216 on preview hosts.** **So a preview differs from production:** it has an origin, browser storage and same-origin requests with no `Access-Control-Allow-Origin`, where production is opaque, has no storage and answers `*` or `null` ([5.2.1](#521-what-differs-between-a-preview-and-production)). An app that relies on storage works in preview and breaks in production | **Yes, on staging now,** with spike P1 first, the storage warning, and the difference stated in the Ship panel and the approval dialog. Production hosts keep the strict sandbox and no cookie. Serving production the same way is not recommended: it would reopen what 216 closed | (B) per-viewer bearer hosts; (C) gating navigations only | Decided, as recommended: [decision 255](spec/PRODUCT.md#decisions-needed) |
| Q8 | Setting this cookie on `podster.site` before the Public Suffix List entry | **Yes, on staging, `__Host-` only,** which doesn't depend on the list. Production still waits for the entry, as already owed (decision 249) | Wait for the entry | Decided, as recommended: [decision 255](spec/PRODUCT.md#decisions-needed) |
| Q9 | **A production gate:** before any preview is served in production, either a separate registrable domain for previews, option (D), or the Public Suffix List entry for the domain previews are on | **Yes, make it a gate.** Without one of them, a preview page's domain cookies reach every host, and SameSite can't tell sibling hosts apart. Which of the two is the owner's: (D) needs a domain and a zone, and the entry may be refused | Accept the residual in production; a third Cloudflare account | Decided, as recommended: [decision 256](spec/PRODUCT.md#decisions-needed) |
| Q10 | Limits and cost: one preview per room; the preview store is a second D1 per room that asks for one; previews share the room's 20 asks a day and its hourly uploads; at most one custom preview hostname; session one hour, ticket 60 s | **Yes, as written.** They sit on the second account's bill, whose spending alert F-2 still owes; the $100 a month the owner set on 2026-11-25 is for provider APIs and doesn't cover this | Separate preview caps | Decided, as recommended: [decision 257](spec/PRODUCT.md#decisions-needed) |
| Q11 | A new dispatch namespace, a ticket signing key and the content Worker's new configuration | **Yes;** the owner's cloud and secret steps, done by a wizard | Reuse the production namespace | Decided, as recommended: [decision 258](spec/PRODUCT.md#decisions-needed) |
| Q12 | A pending publish after its preview is replaced | **Stays valid** for its build, with a warning in the dialog | Cancel it on replacement | Decided, as recommended: [decision 259](spec/PRODUCT.md#decisions-needed) |

## What this plan checked, and what it didn't

- **Read:** `CLAUDE.md`; issue #635; PRODUCT.md decisions 181, 186, 197 to 220, 230, 238, 239 and 249 and the M6 decision notes; ADR 0010 and its revision on apps as Workers; `RELEASE-POLICIES.md`; `ARCHITECTURE.md`'s content origins; ADR 0001; the M6 threat model and security review; `docs/staging.md`'s content secrets.
- **Code read:** `apps/content/src/handle.ts`, `names.ts`, `requests.ts`, `index.ts` and `wrangler.jsonc`; `crates/core/src/release.rs` (states, serve state, constants), `release_tree.rs` (fetch checks, manifest hash, marker), `release_marker.rs`, `app_code.rs`, `hostnames.rs` (constants and signatures); `crates/policy/src/release.rs` (signatures); `apps/api/src/workspace/release_store.rs` (header); `apps/api/src/store.rs` (steps 54 to 58); `apps/api/migrations/0008_app_label_index.sql`; `packages/contracts/openapi.yaml` release routes and `capabilities.yaml`; `e2e/m6-code-app-staging.mjs` (header).
- **Read in Cloudflare's documentation, 2026-11-27:** Workers for Platforms architecture and limits; static assets direct upload; KV consistency and `cacheTtl`; service bindings' same-account rule.
- **Not read:** `scripts/deploy-content` in full; `apps/api/src/workspace/` release, hostname and custom hostname modules beyond names and headers; `apps/web` and `apps/demo`; ACCESS-CONTROL.md and RUNNER.md in full (RUNNER.md only through decision 230).
- **Not run:** anything. Every browser claim in section 5 is reasoning from the standards until spike P1. Nothing was deployed, written to staging or changed in any cloud account.
- **Reviewed:** not yet. This plan needs an independent review before the owner's answers are built on.
