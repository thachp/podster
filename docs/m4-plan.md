# M4 plan

**Status, 2026-11-08 UTC:** the architect accepted all 26 [questions](#questions-for-the-architect) as proposed, now [decisions 146 to 171](spec/PRODUCT.md#m4-decisions-november-8-2026), and none of the alternatives. The order of the steps is still **Proposed**, and nothing is built. Items marked **owner's yes** loosen the security stance, need a cloud change, or are legal text, so the architect can't settle them alone. The design is [ADR 0008](adr/0008-public-read-surface.md), accepted by the architect on 2026-11-08 with the changes an independent review asked for. Those changes are in this plan, and in decisions 155, 158, 162, 163 and 166.

It covers [M4 Public workrooms](spec/PRODUCT.md#product-direction-and-delivery-scope): Explore, the public read surface, public claims and abuse controls. Its gate is [expanded criterion 2](spec/PRODUCT.md#expanded-workroom-acceptance-criteria) and an abuse review. It starts from the [proposed public rules](spec/PRODUCT.md#public-and-private-participation) and the [discovery design](spec/ARCHITECTURE.md#workroom-roles-and-discovery-m1-m4). No public-room code exists. Room visibility, `publicly_claimable`, the participation policy and `public_workroom_index` are all designed and none is built.

M4 is the first time anything in Podster can be read without signing in. So the plan settles what is public, and how a public read is kept away from private state, before any code.

## What M4 includes

- **Visibility:** an owner makes a room public after a preview of exactly what becomes visible. An owner or admin can make it private again.
- **The public read surface:** one page per public room that anyone can open by link, built from a fixed list of fields.
- **Explore:** a list of public rooms for signed-in people and agents, filtered by topic and open role and sorted by publish date. There's no free-text search in M4, because the index holds no text. Each result is read from its room's current state.
- **Public claims:** an agent whose owner allows it claims an open public role without an invitation, under limits.
- **Abuse controls:** rate limits, per-agent, per-organization and per-room claim limits, per-person claim limits, an owner's block on an organization, reporting, Podster operator suspension, and an audit trail with reason codes.

Not in M4: public files of any kind, previews, deployed apps, the separate content domain, search-engine indexing, reputation, and public rooms in production. M4 ends on staging, like M1 to M3.

## The gate

From the specs. Nothing may say public rooms work until all of these pass on staging:

- **Expanded criterion 2:** a public room accepts a valid agent's claim without a manual invitation, concurrent claims can't overfill a role, and a private room rejects uninvited participants and stays out of unauthorized discovery.
- **Expanded criterion 3, for public claims:** a claim grants only its opening's preset, and a task still needs explicit acceptance.
- **Expanded criterion 8, the abuse part:** abuse controls pass their documented policy before launch.
- **Access tests:** AC-08, AC-09, AC-23, AC-26 and AC-28, on a deployment.
- **M4's own tests,** [below](#acceptance-tests).
- **The abuse review:** the [threat model](#threat-model) walked against the built system, every mitigation checked on staging or listed as owed, with the result written into this plan.

The architect proposes the gate call. Because it ends with the public surface switched on, the call goes to the owner (question 25).

## What M4 needs from earlier milestones

| M4 needs | From | Status on `main`, 2026-11-08 | Used by M4 step |
| --- | --- | --- | --- |
| No M3 contract or migration PR in flight when an M4 one merges | M3 steps 12 to 14 | In progress in another session | Every C or M step |
| A2A working, so public claimants can work over both protocols | M3's gate | Steps 12 to 16 not done | 13 |
| Openings, invited claims, presets, the lead and removal rules | M1 | Built, passed on staging with test people | 2, 9 |
| Expected outputs and their status | M2 | Built, M2 met on staging | 2, 7 |
| Inert Markdown rendering and the app's CSP | M1, M2 | Built in `apps/web` | 11 |
| Opaque list cursors | [#169](https://github.com/thachp/podster/pull/169) | Merged | 7, 8 |
| The exact `StrictCounter` limiter | Gateway | Built | 8, 9, 10 |

[`PRODUCT.md`](spec/PRODUCT.md#product-direction-and-delivery-scope) says A2A comes before public rooms so public claiming launches with both protocols. So M4's code can be built beside M3's last steps, taking turns on contract and migration PRs, and M4's staging gate waits for M3's (question 24).

## Deferred to "before public rooms"

Earlier rulings left these for M4. Each needs an answer before the gate, and most are questions below.

| Item | Where it was deferred | Question or step |
| --- | --- | --- |
| Export and legal terms for uploads, and legal review of the upload policy | [Decision 59](spec/PRODUCT.md#decisions-needed) | 22, step 3 |
| A Podster operator's takedown route, with operators named in the API's configuration | [Decision 92](spec/PRODUCT.md#decisions-needed) | 13, step 10. Operators are built in M4, but removing file bytes isn't one of their M4 powers, because M4 has no public files. The file route stays owed before public files exist |
| Guest uploads counting toward the room's quota | [Decision 96](spec/PRODUCT.md#decisions-needed) | 16, step 12. **Accepted per decision 161 and built in step 12:** a public participant may hold at most 1 GB of the room's files |
| A2A egress: a resolved-address check, since anyone could register an endpoint | [Decision 134](spec/PRODUCT.md#decisions-needed) | 23, step 12. [Decision 168](spec/PRODUCT.md#decisions-needed) keeps wake's rules for M4 and puts this check before production, where it's listed under [Owed before production](#owed-before-production) |
| Which second A2A implementation counts | [Decision 143](spec/PRODUCT.md#decisions-needed) | Step 12, no change proposed |
| Who can claim a lead opening publicly | [Decisions 3 and 5](spec/PRODUCT.md#decisions-needed), the M1 note | 8 |
| A forged `cf-connecting-ip` | [M2 plan](m2-plan.md#checks-the-spike-left-open), [M3 plan](m3-plan.md#owed-before-production-that-m3-touches) | Step 14. Public limits rest on it |
| Per-room fairness in the scan queue. One Container scans in arrival order with `max_concurrency` 1. Within M4's limits one room can queue up to 50 files of 100 MB (its 5 GB), and a stranger 10 of them (1 GB). The hour's capacity depends on how long a 100 MB scan takes, which isn't timed yet: at 30 s a scan it's 120, so three full rooms could push a fourth room's scan past the hour, where it fails closed. The fix is a per-room share, such as a cap on each room's queued scans with the hour counted from when a scan is queued (a room schema change), or more Containers (billed, the owner's yes) | [M2 gate note](spec/PRODUCT.md#m2-gate-november-8-2026) | **Built at step 14, in code:** a room has at most 4 files on the shared scan queue at once. The room puts them there itself, from its alarm, oldest arrival first, and the others wait in the room in `scanning`. A file's hour starts when it's queued, and one that waits a day for its turn fails closed. So one busy room only delays itself, and a quiet room's file goes on the queue at once. No schema change: a waiting file has no `scanning_since` yet. The scan's own time under load is still untimed |
| A discovery-index reconcile. A D1 row lost while the room's `written` cache still matches is never rewritten. It fails closed: the room page and Explore answer not-found for that room, and nothing else is blocked | Step 6's deeper review, [#187](https://github.com/thachp/podster/pull/187) | **Built in step 12:** a periodic check from each room's alarm, every 6 hours, comparing the row's content. A room public before that deploy starts checking at its next wake |
| Seal or accept the Explore cursor. It names the last candidate a page took, publish time and handle, including one its room refused. From step 10, a suspended room's handle can appear in a cursor. Sealing it needs a new API secret, which is the owner's call | Step 7's deeper review, [#188](https://github.com/thachp/podster/pull/188) | Before `PUBLIC_ROOMS` is switched on, at step 14 |
| Measure the Cache API's hit rate and expiry for public views on staging, through the `PublicReads` RPC entrypoint. The tests use an in-memory store | Step 7's deeper review, [#188](https://github.com/thachp/podster/pull/188) | Before step 14 |

## Owed before production

Not needed before `PUBLIC_ROOMS` is switched on at step 14, but owed before any production launch.

| Item | Where it was deferred |
| --- | --- |
| Retention and a total cap for the `Moderation` object's reports and operator actions. Until then they're kept with no limit beyond each person's 10 reports a day | Step 10's deeper review, [#191](https://github.com/thachp/podster/pull/191) (L5) |
| Idempotency keys on operator actions. Suspend and lift are idempotent by their effect, and each is recorded as intent first, but a retry records a second row | Step 10's deeper review (L6) |
| A2A egress: a resolved-address check, since anyone can register an endpoint. Public rooms don't change who can, so it stays as wake's rules for M4 | Decision 168, step 12 |
| Purging the public page cache on suspension. Until then a suspended room's cached view can stay up to 30 seconds, as on unpublish (decision 150) | Step 10's deeper review (L7) |

## Build order

C changes `packages/contracts`, and M adds a D1 migration, a Durable Object schema change or a new Durable Object class. C and M PRs merge one at a time, and take turns with M3's steps 12 to 14. The order is **Proposed**.

| Step | Work | C | M | After | Runs beside |
| --- | --- | --- | --- | --- | --- |
| 0 | This plan and ADR 0008 | | | **Done** ([#172](https://github.com/thachp/podster/pull/172)) | |
| 1 | The architect's rulings, recorded as decisions. ADR 0008 accepted. The owner's yes, or no, on each item [listed below](#what-needs-the-owners-yes) | | | 0. **Done:** decisions 146 to 171, and ADR 0008 accepted after its review | |
| 2 | Pure rules, with no I/O. In `crates/policy`, a new `public.rs`: the `PublicWorkroomView` struct built field by field from room state, who may publish and unpublish, public claim eligibility, and the hash of a view that publishing names. The public caller is its own type, not a sentinel identity, so every handler that takes an identity refuses it at compile time. In `crates/core`, the public claim limits. A golden test pins the view's field names | | | 1 | 3 |
| 3 | Legal and policy text: terms, acceptable use, a takedown contact, and decision 59's export answer. Docs only, written for the owner. **Approved by the owner** on 2026-11-09, in [`docs/legal/`](legal/README.md). A real takedown contact is still owed before `PUBLIC_ROOMS` is switched on | | | 1 | 2, 4 to 10 |
| 4 | **Participation policy** on the `Principal`: `invitations_only`, the default, or `public_claims`. Set by an authorized person of the agent's organization, through `PUT /v1/agents/{agent}/participation-policy`, which is listed and not built. `register_room` checks it before a public claim. Audited | Yes | Yes, `Principal` schema | 2 | 5 |
| 5 | **Room visibility:** `visibility`, `public_handle`, `published_at`, `topic`, `public_claims_paused` on the room, and `publicly_claimable` on `work_role`. A `set_visibility` command that names the hash of the exact view the owner previewed, refused if the room's current view hashes differently, with `room.published` and `room.unpublished` events and audit rows. A preview read that returns the exact view that would be shown. A `PUBLIC_ROOMS` flag, off by default, refuses publishing and answers every public read not-found | Yes | Yes, room schema | 2 | 4 |
| 6 | **Discovery index:** the `public_workroom_index` D1 migration, projected from room events by `seq`. It holds handles and sort or filter keys only, such as topic, whether an opening is open, and publish date. Never names, goals or other text. Two flags: `resolvable` (public under a handle and not suspended) for the public read, and `listed` (resolvable and not archived, decision 152) for Explore. A row that stops being resolvable is kept as a tombstone with the last handle from the room's audit. It's a list of candidates, never a decider. **Accepted:** every event in a public room marks the row due and the alarm recomputes it, which never misses a change. Revisit at step 8, when public claimants join and events grow. **At step 8:** narrowed by a denylist. Task and message events (`task.*`) no longer mark the row, since none can change an index key; every other event still does. A room has at most 50 members and 20 public claims an hour, the alarm builds the row from those bounded rows, and D1 is written only when a key changed | | Yes, D1 | 5 | 9 |
| 7 | **Public read route:** `GET /v1/public/workrooms/{handle}` in `apps/api`, answering from current room state, and the only route that accepts the public caller. It finds the room from index rows that are `resolvable`, so an archived public room still answers. `GET /v1/public/explore`, for signed-in callers only (decision 155): it takes a page of candidates from the index's `listed` rows, confirms each is public with its room, reads its fields from the room's current state, and drops anything not confirmed. In the gateway, a `PublicReads` entrypoint bound only to `apps/web`, the 30-second cache, and the capabilities `discover_workrooms` and `get_public_workroom` for signed-in agents. Explore's cursor is a publish time and a handle, so a D1 migration orders by those instead of the room ID. **Merge criteria:** the canary test and the route-list test both pass in CI | Yes | | 5, 6 | 9 |
| 8 | **Public claims:** joining and claiming in one room transaction, as `guest` with the opening's preset. Presets limited to Public participant and Guest. The lead never publicly claimable. Limits per room in the room, and per agent, per linking person and per organization, at once and an hour, each in its own `Principal`, all in Rust. Each count is reserved before the room decides and confirmed or given back by its answer. ([Decision 173](spec/PRODUCT.md#decisions-needed): first planned with the hourly counts in the gateway's `StrictCounter`.) The person is the one who linked the agent, across all their organizations. The owner's pause switch, and the owner's block on an organization's public claims. AC-08, AC-23 and AC-28 | Yes | Yes, room schema: how a member joined | 4, 5 | 9, 10 |
| 9 | **Owner controls in public rooms:** see and end public claims, remove and block an agent, block an organization from public claims, pause claims, and person review on and locked while public. **Built:** `getPublicClaims` lists each public claimant still a guest, with the opening it holds, and the room's claims this hour. `endPublicClaims` ends every public claim while the room stays public, and blocking an organization can end its claims with `end_claims`. Ending one claim (`endRoleClaim`), removing an agent and keeping it out until cleared (`removeMember`), the pause, the organization block and the locked person review were already in from steps 5 and 8 | Yes | | 5, 8 | 10 |
| 10 | **Moderation:** one `Moderation` Durable Object for reports and operator actions. A signed-in person reports a public room or agent. Operators, named as person IDs in the API's configuration and checked in Rust to be callers of kind person, can suspend or lift a room's public surface and an agent's public claims. Removing file bytes isn't an M4 operator power (decision 158). Every action carries a reason code and is audited. Suspending and lifting must commit through `record_event` in the room, so its index row updates. **Built:** `createReport` (reason codes `spam`, `abuse`, `illegal`, `impersonation`, `privacy`, `other`; a room public now; any agent ID, so a report reveals nothing about who is in a room), `listReports` for operators, showing neither the reporter nor the room's internal ID, and suspend and lift for a room, found by its handle on the index even after it went private, and for an agent's public claims, kept on its `Principal`. A room's suspension is a room migration, audited and announced as Podster, so the operator's ID stays in `Moderation`'s log, which records each action as intent before it's carried out and its outcome after. An operator can also suspend the room a report was about, found from the report on the server, after its handle changed. `OPERATORS` is unset everywhere until the owner names them | Yes | Yes, new DO class and room schema | 5 | 8, 9 |
| 11 | **Screens**, in three PRs. (a) Visibility in Workroom Settings with its preview and confirmation, the Create flow's visibility and public-claim switches, and the participation policy on the Agent Sheet. (b) The public room page, served with no JavaScript under its own CSP and with a body identical for signed-in and signed-out viewers (decision 163), and Explore. The per-client limit on the signed-out page, in `apps/web`, ships in this PR, before `PUBLIC_ROOMS` goes on. One Explore request can read up to 20 rooms, so its limit counts that. (c) Report, and the operator's queue. **(c) built:** each public page links to `/report`, which sends a report with a reason, an optional agent ID and a note, under one idempotency key per intent. `/moderation` is the operators' queue, with suspend and lift for the reported room, found from the report, and for the reported agent's public claims, each with a reason. For anyone but an operator it isn't there. **(b) built:** `/p/{handle}` is a route handler that writes plain HTML with no script from the `PublicReads` view, under its own CSP and the public headers on every answer, 404 and 429 included, with a stylesheet from `/p-assets/style` and `robots.txt` allowing crawling. Markdown goes through the app's inert parser and a small writer that keeps only its allowed elements, showing link hosts and never loading images. "Claim with an agent" links to Explore, which says what the agent calls. Explore lists confirmed rooms, filtered by topic and open roles. Two rate-limit bindings, per client as the gateway's `clientKey` counts one (an IPv6 /64 as one client, Cloudflare's Worker address per calling zone): 120 pages a minute, and 6 Explore pages a minute, a twentieth, since each reads up to 20 rooms. Both fail open. Coming to claim, Explore shows only the help and reads nothing. After the deeper review: a fixed formatting budget, so a field is formatted as Markdown only if it's at most 2 KB with at most 256 `*` and `_`, and only while the page's formatted fields stay within 8 KB, and anything else is plain text. Pages are cached in the web Worker for 30 seconds by handle and a hash of the view. The worst room the limits allow, for each delimiter pattern the re-review found costly, renders in about 15 ms warm and 36 ms cold, where it took 4 to 7 s | | | (a) 4, 5. (b) 7. (c) 10 | Each beside the others |
| 12 | **Revisits:** a per-claimant upload limit in public rooms (decisions 96 and 161: at most 1 GB of the room's files per public participant, owed before `PUBLIC_ROOMS` is switched on), A2A egress (decision 134), the scan queue under public load. **Built:** a public participant, one that joined by a public claim and still holds that guest role, may hold at most 1 GB of the room's files, counted as the room's 5 GB is and checked when an upload starts and again when its bytes arrive, or `participant_quota_exceeded` (409). One the owner promoted and then demoted back to guest stays uncapped, since it no longer joined by a public claim: the owner's call, recorded for the owner's review of decision 161. The discovery-index reconcile: every room with a discovery row reads it from D1 every 6 hours, from its own alarm, compares it field by field with what it last wrote, and on any difference deletes it and writes it again, so a drifted row fails closed. A room's first check is at a random time within the 6 hours. A failed check waits 5 s, doubling up to 30 minutes, with up to a fifth more at random. A confirmed tombstone is checked weekly, which still repairs one that drifted or was deleted, until the room writes something else. The schedule is kept in the room's key-value storage, so it needs no schema change. `PUT visibility` replays a stored answer only to someone who may still manage the room. A2A egress stays as decision 168 ruled, with no code change. The scan queue's fairness, or a load run, stays a gate item before step 14 | Maybe | | 8 | 11 |
| 13 | **Both protocols:** a public participant takes an offer and submits over A2A, with one task history (criterion 4). **Built:** no code change was needed. `public-a2a.spec.ts` runs M4-17 locally: in one public room, one public participant's offer goes out once over A2A however often the job is redelivered, and its read-back accepts and submits as the agent, marked `a2a_remote`, with a redelivered read adding nothing. Another, with no endpoint, accepts and submits through the API an MCP client calls. Each task has one history, and each participant sees only its own task. M4-17's staging run is owed after M3's gate | | | 8, M3's gate | 11 |
| 14 | **Staging run:** `e2e/m4-staging.mjs` for every [acceptance test](#acceptance-tests), then the abuse review, then the gate call. M4-17 there must drive a real MCP client through the gateway's `/mcp`, not the private API | | | All, M3's gate, the owner's yes to switch `PUBLIC_ROOMS` on | |

**What runs in parallel:** steps 2 and 3. Steps 4 and 5 are in different Durable Objects, so they're built side by side and merged one at a time. Steps 8, 9 and 10 once 5 is in. The three screen PRs, each once its API step is in.

**Steps that get a deeper security pass,** beyond the quick diff review, each asked before it runs: 5, because it decides what becomes public. 7, because it adds the first unauthenticated read. 8, because it lets strangers into rooms. 10, because it adds operator authority. 11(b), because it renders room text on the app origin for anyone. This follows [decision 127](spec/PRODUCT.md#decisions-needed)'s pattern for M3 (question 21).

The gateway only translates. Rust decides what is public, from the room's current state, and decides every claim. New Rust goes in new modules (`crates/policy/src/public.rs`, `apps/api/src/workspace/public.rs`, `apps/api/src/moderation.rs`), new gateway code in `apps/gateway/src/public/`, and each touches `lib.rs`, `workspace.rs` and `index.ts` by a line or two. Each capability updates contracts in its own PR.

## What needs the owner's yes

The architect can rule on the questions. These can't be settled without the owner, because they loosen the security stance, change cloud configuration, name people with new authority, or are legal text:

- **Switching `PUBLIC_ROOMS` on in staging** at step 14. It's the first unauthenticated read surface. Until then, the flag stays off everywhere and public reads answer not-found.
- **Legal text** at step 3: terms, acceptable use, the takedown contact and decision 59's export answer. It's the owner's to approve, and it may need a lawyer.
- **Naming operators** at step 10. An operator can suspend any room's public surface and any agent's public claims. The staging list is person IDs in the API's configuration.
- **Each deeper security pass,** asked before it runs, as `CLAUDE.md` says.
- **Any looser alternative** in the questions below, if the architect prefers it. These are marked "owner's yes" in the table: questions 3, 5, 8, 9, 10, 11, 12, 15, 18 and 19.
- **The gate call,** question 25.
- **Production.** Nothing in M4 goes to production. A public launch needs M1 to M4 passed, real people, the legal text and the owner.

## Cloud resources

**None is needed by the proposal,** and this plan creates nothing.

- Step 6 adds a migration to the existing D1 database. Step 10 adds a Durable Object class to the existing API Worker. Steps 7 and 11 add a rate-limit binding and a service binding entrypoint in `wrangler.jsonc`, which are configuration, not new billed resources. All of these deploy with the merged step, which staging deploys already allow.
- **Only if a looser or heavier alternative is chosen,** each needing the owner's yes:
  - A cookie-less host for public pages, such as `public-staging.podster.dev`: a new route and DNS record (question 18).
  - A Cloudflare API token to purge the cache on unpublish: a new secret (question 5).
  - A Turnstile site key for anonymous reports: a new resource and secret (question 15).
  - A new sender such as `abuse@podster.dev` for report notices: an Email Service change (question 15).
  - Bot Management or paid WAF rules: billed. Not proposed.

## Acceptance tests

Each runs from `e2e/m4-staging.mjs` against staging, with test people, by the agent. The owner won't run checks by hand, so a check that can't run that way is recorded as a gap. They run with `PUBLIC_ROOMS` on, which needs the owner's yes.

| ID | Scenario | Expected | How it's verified on staging |
| --- | --- | --- | --- |
| M4-01 | A room is seeded with a unique canary string in every private field: task titles, instructions, messages, artifact labels and links, asset and file names, submission notes, member and agent names, organization names, emails, invitation tokens, and every internal ID. Removed expected outputs and closed openings carry canaries too | The public page, the public JSON and Explore contain no canary. The JSON's field names equal the contract's list exactly | The script seeds the room, fetches every public response signed out, and searches each body and header for every canary |
| M4-02 | Signed out, open a private room's handle, a random handle, a handle from before a republish, a deleted room's, a suspended room's, and a room's internal `workspace_id` | The same not-found page, status and headers in every case, and no Durable Object state created (AC-26) | The script compares status, body length and header names across all six. Timing is recorded, not asserted |
| M4-03 | The owner makes a public room private | Its page is not-found from every request within 30 seconds, it leaves Explore, and current public participants keep access. Republishing gives a new handle, and the old one stays not-found | The script polls the old handle every second from two connections and records when each first answers not-found |
| M4-04 | 20 agents claim the last opening of a public role at once | Exactly one claim succeeds, the rest get `role_full`, and no invitation was needed (AC-08, criterion 2) | Parallel claims through MCP and Agent Auth. The 20 agents need 20 distinct linking people, since one person's agents share a limit of 3 at once |
| M4-05 | An agent with the default participation policy claims, then its owner allows public claims | The first is refused, the second succeeds, and the room owner approved nothing (AC-23) | Script, with the policy changed by a test person |
| M4-06 | A room removes a public claimant, who claims again. Separately, an owner withdraws their agent, which claims again | Refused until an owner or admin clears the removal. After the withdrawal, refused until its owner consents again (AC-28) | Script |
| M4-07 | A public claim's request adds admin, review or task scopes, or names a Member or lead opening | The claim gets only its opening's preset. A Member or lead opening isn't claimable publicly. The claimant can't create tasks, review, or act on a task it wasn't offered (criterion 3) | Script, then a read of the claimant's grant and refused task commands |
| M4-08 | An uninvited agent and a signed-in stranger look for a private room in Explore, `discover_workrooms` and by ID | Absent from every list and not-found by ID (AC-09, criterion 2) | Script, with a private room whose name is a canary |
| M4-09 | An agent passes its simultaneous public claim limit, its hourly limit, its organization's hourly limit, its linking person's hourly and at-once limits across organizations, and a room its hourly limit. Separately, the room owner blocks an organization | Each gets `limit_exceeded`, and the blocked organization's agents are refused. Invited claims in private rooms aren't counted | Script. The exact counters are asserted. The approximate per-client limits are recorded, as earlier staging runs did |
| M4-10 | One client requests public pages quickly | Refused past the limit with `429`, and other clients keep working | Script. The first refusal's request number is recorded, since the binding is approximate |
| M4-11 | Every public response, including not-found and `429` | Carries `X-Robots-Tag: noindex, nofollow`, `Cache-Control: no-store`, `X-Frame-Options: DENY` and `Referrer-Policy`. The page's own CSP has `script-src 'none'`, `form-action 'none'` and `frame-ancestors 'none'`, and the page has no script element or inline handler. `robots.txt` matches the ruling | Script checks headers on each response |
| M4-12 | The owner writes HTML, script, `javascript:` and `data:` links, remote images, iframes, lookalike names and very deep nesting into the public fields | Shown inert, as DESIGN.md section 8 says, with links showing their host | Script checks the served HTML has no live element from the payloads. The browser check is a gap unless it runs headless |
| M4-13 | Requests for one handle with cookies, `Authorization`, extra query strings, odd `Host` and `X-Forwarded-*` headers, and the owner's own signed-in session | Every response is byte for byte the same page, signed in or out, since the page has no personalized parts (decision 163). A signed-in owner's view is never cached, and a cached public view never reaches a member's normal room page | Script compares bodies across all variants, then loads the owner's room page |
| M4-14 | A test person reports a public room. A test operator suspends it, and later lifts the suspension | The page is not-found within 30 seconds, claims are refused, the owner sees "Suspended by Podster" and can't republish, and a non-operator, or an operator ID used by a caller that isn't a person, calling the operator routes is refused | Script, with a test operator in staging's configuration |
| M4-15 | The public assertion kind is sent to every API route but the room page's, Explore included. The public JSON is requested on the gateway's public hostname | Every other route refuses it. The gateway's public hostname has no public read route, since only `apps/web` reaches it by binding | API tests list every route. The script probes the gateway hostname |
| M4-16 | Logs during the whole run | App logs carry IDs, outcomes and reason codes only. No brief text, report note, IP address or token. Cloudflare's own request logs record `/p/{handle}` URLs, which is accepted because a handle is public by design | The script tails `wrangler tail` for the run and searches it for every canary and its own IP address |
| M4-17 | A public participant accepts an offer and submits over A2A, and another over MCP, in one public room | One task history, with no competing tasks from duplicate deliveries (criterion 4) | Step 13's run, after M3's gate |

## Threat model

Each threat maps to the step that mitigates it and the test that checks it. ADR 0008 has the design behind each mitigation.

| Threat | What it looks like | Mitigation | Step | Test |
| --- | --- | --- | --- | --- |
| **Enumeration of private rooms** | Guessing handles or room IDs on the public route, or comparing errors and timing | Public handles are a separate 128-bit random ID, never the `workspace_id`. The public route takes only handles. A handle missing from the index, or on a row that isn't resolvable, answers not-found without reaching a room. Every not-found looks the same | 5, 6, 7 | M4-02, M4-08 |
| **Enumeration of public rooms** | Paging Explore to list every public room | Expected, since they're public. Explore needs sign-in (decision 155), pages hold 20, cursors are opaque, and listing is rate limited. The index holds no text, so a stale row can't show anything | 7, 11 | M4-08, M4-10 |
| **Scraping** | Bulk fetching public pages or Explore | Per-client rate limits in `apps/web` and per-credential ones for agents, the 30-second cache shielding rooms, `noindex`, and nothing on the surface that isn't already meant to be public | 7, 11 | M4-10, M4-11 |
| **IDOR through public IDs** | Using a public handle or opening ID to reach a room's private routes, or a public opening ID with another room | Public IDs only select. Every room route still checks membership. A claim checks in the room that the opening belongs to it and is publicly claimable now. The internal `workspace_id` never appears publicly | 2, 7, 8 | M4-01, M4-07, M4-15 |
| **Reaching private state** | A new column or table leaking into the public view, or a member's view served to a stranger | The view is a fixed struct built field by field, with no generic serialization of rows. A golden test pins its field names and a canary test checks contents. The public query reads only named columns of the room, its openings, claim counts and outputs. Explore reads each result from its room, not from the index. The gateway copies only the contract's fields. The canary and route-list tests are step 7's merge criteria | 2, 6, 7 | M4-01 |
| **Cache poisoning** | A cached response carrying one viewer's data, or a crafted request changing what others get | The view is the same for every caller, so there's nothing per viewer to cache. The cache key is only the normalized handle. Cookies, `Authorization`, other query strings and forwarded headers are ignored. Only a successful public view is cached, never an error. Browsers are told `no-store` | 7 | M4-13 |
| **Stale public after unpublish** | A page, an Explore card or a cached copy staying visible after going private | The room answers not-found at once. The index row stops being resolvable by `seq`, and Explore drops any result its room doesn't confirm. The cache holds a view for at most 30 seconds, the one bounded exception to only current state deciding. Browsers keep nothing. Republishing makes a new handle. Copies others made earlier, search engines and archives are out of Podster's control, and the confirmation says so | 5, 6, 7, 11 | M4-03 |
| **Spam claims and Sybil agents** | Many cheap agents filling openings or flooding a room | The agent's owner must opt in, every agent belongs to a person's organization, claims are limited per agent, organization, linking person and room, the owner can pause claims, remove and block an agent, and block an organization, presets are narrow, and person review is locked on in public rooms. Operators can suspend an agent's public claims. An attacker can use up a room's hourly limit and keep real claimants out for that hour. The owner's answers are pausing and blocking | 4, 8, 9, 10 | M4-05, M4-06, M4-09, M4-14 |
| **Hostile content and moderation** | Spam, abuse or illegal text in a public brief | Reports and operator suspension, reason-coded and audited. Legal text says what's allowed and how to report | 3, 10, 11 | M4-14 |
| **XSS from room text** | Script in a brief or role text running in a viewer's session | Public fields are written by the room's owner and admins, not agents, in M4. They're still shown through the inert renderer, on a page with no JavaScript and its own CSP with `script-src 'none'`, so a renderer bug can't run as a signed-in viewer on the app origin. The body is the same for every viewer | 11 | M4-12, M4-13 |
| **Escalation through a claim** | A claim requesting scopes, a Member or lead opening, or review | Scopes come from the opening's preset in the room. Public openings take only Public participant or Guest. The lead can't be claimed publicly. A claim accepts no task | 2, 8 | M4-07 |
| **Log leakage** | Briefs, search text, report notes or addresses in logs | App logs carry request, room, event and actor IDs, outcomes and reason codes only. Rate-limit keys are never logged. Platform logs record `/p/{handle}` URLs, which is accepted because a handle is public | All, checked at 14 | M4-16 |
| **Public assertion misuse** | The anonymous assertion used for a member route, or minted from client input | The gateway mints it only in `PublicReads`, with no subject. The public caller is its own type, so only the room page's route can take it, and a route-list test checks every route | 2, 7 | M4-15 |
| **Uploads by strangers** | Public claimants filling a room's 5 GB or the scan queue | A per-claimant limit in public rooms (question 16, built in step 12), the existing 10 unsubmitted files per task, and per-room fairness in the scan queue, built at step 14 | 12, 14 | Step 12's and step 14's tests |
| **Forged client address** | Spoofing `cf-connecting-ip` to dodge per-client limits | Checked on staging at step 14. Exact limits per agent, organization and room don't depend on it | 14 | M4-09, M4-10 |

## Questions for the architect

The architect accepted every proposal on 2026-11-08, and none of the alternatives. Each row links to its decision, which is the record. The alternatives are kept to show what was ruled out. "Owner's yes" means the alternative loosens the stance, so choosing it later still needs the owner.

| # | Question | Proposed | Alternative | Decision |
| --- | --- | --- | --- | --- |
| 1 | What does a public room show, field by field? | The table [below](#what-a-public-room-shows). Name, goal, context, topic, workflow, role openings with counts, expected outputs with status, participant count, review policy, status and publish date. No tasks, threads, activity, members, names, organizations, files, artifacts or other IDs | PRODUCT.md's proposal, which adds assets marked public | [146](spec/PRODUCT.md#decisions-needed) |
| 2 | Which ID does the public surface use? | A separate public handle, `pub_` and 128 random bits, made each time the room goes public. The `workspace_id` never appears | The `workspace_id`, which is also random. Simpler, but it ties public links to the internal ID for good, and a republish can't break old links | [147](spec/PRODUCT.md#decisions-needed) |
| 3 | Who can make a room public? | The owner only. Going public adds exposure, so it sits with ownership. The publish names a hash of the exact view the owner previewed | The owner or a human admin, as PRODUCT.md proposes. Owner's yes | [148](spec/PRODUCT.md#decisions-needed) |
| 4 | Who can make it private again, and can it be undone? | The owner or a human admin, at any time, since it only reduces exposure. Republishing is allowed and makes a new handle | Owner only both ways | [149](spec/PRODUCT.md#decisions-needed) |
| 5 | What happens to cached copies on unpublish? | The room answers not-found at once. The gateway's cache holds a view for at most 30 seconds, browsers keep nothing, and the confirmation says "may stay visible for up to a minute, and copies others already made can't be recalled" | Purge across Cloudflare with an API token, which needs a new secret and the owner's yes. Or no cache at all, which leaves rooms open to load | [150](spec/PRODUCT.md#decisions-needed) |
| 6 | What happens to existing public claims on unpublish? | They stay, as PRODUCT.md proposes. The confirmation lists them and offers "also end public claims", which ends them through the departure rules | End every public claim automatically. Safer for the room, but surprising to participants doing work. Not looser, so no owner's yes | [151](spec/PRODUCT.md#decisions-needed) |
| 7 | Can archived public rooms be read? | Yes, labeled Archived, with no claims, and gone from Explore | Not-found, as if private | [152](spec/PRODUCT.md#decisions-needed) |
| 8 | Can a lead opening be claimed publicly? | Never in M4. A lead gets the Coordinator preset, which sees the whole room | The owner can switch it on per opening, as PRODUCT.md proposes. Owner's yes | [153](spec/PRODUCT.md#decisions-needed) |
| 9 | Which presets can a public opening use? | Public participant, the default, or Guest. Member and Coordinator can't be publicly claimable | Any preset. Owner's yes | [154](spec/PRODUCT.md#decisions-needed) |
| 10 | Does Explore need sign-in? | Yes, in M4. People sign in and agents use `discover_workrooms`. Only a room's own page opens signed out, by link, and only its route accepts the public caller. The index holds handles and sort or filter keys only, and each result is confirmed public and read from its room's current state | Explore signed out too. Wider reach, and easier scraping. Owner's yes | [155](spec/PRODUCT.md#decisions-needed) |
| 11 | Search engines and indexing | `noindex, nofollow` on every public response and page, with no owner switch in M4. `robots.txt` allows crawling, so crawlers can see the `noindex` | An owner switch to allow indexing per room. Owner's yes | [156](spec/PRODUCT.md#decisions-needed) |
| 12 | Public files | None in M4. Assets and artifacts stay private, even if marked public, and `asset.visibility` stays `room` | Signed-out download of ready input assets marked public, as attachments. Owner's yes | [157](spec/PRODUCT.md#decisions-needed) |
| 13 | Operators and their powers | Person IDs in the API's configuration, checked in Rust, as decision 92 says. They see only the public view and the report. They must be callers of kind person, checked in Rust. They can suspend a room's public surface, suspend an agent's public claims, and lift either. Removing file bytes isn't an M4 power, since M4 has no public files. They can't read private rooms, end claims or change access | Operators can also end claims and remove members in public rooms | [158](spec/PRODUCT.md#decisions-needed) |
| 14 | How a public claim differs from an invited one | No invitation or room approval. The agent's owner must allow public claims. Only publicly claimable openings in public, unarchived, unpaused rooms. Joins as `guest` with Public participant or Guest. Counted against public limits. Removal and withdrawal rules as for invited claims. Person review is locked on while the room is public | Same as invited claims apart from needing no invitation | [159](spec/PRODUCT.md#decisions-needed) |
| 15 | Who can report, and how? | Signed-in people only, about a public room or an agent seen in one, with a reason code and a note of at most 1 KB. 10 reports a day per person. Operators see them in a queue in the app. No email | Signed-out reports with Turnstile, and email to operators. Both need new resources and the owner's yes | [160](spec/PRODUCT.md#decisions-needed) |
| 16 | Uploads by public claimants (decision 96's revisit) | They count toward the room's 5 GB, as now, and each public participant may hold at most 1 GB of the room's files | Leave decision 96 as it is | [161](spec/PRODUCT.md#decisions-needed) |
| 17 | Claim limits | Per agent, at most 3 public claims at once across rooms and 5 public claims an hour. Per person who linked the agent, across all their organizations, 3 at once and 5 an hour. Per organization, 20 an hour. Per room, 20 public claims an hour. All exact. Invited claims aren't counted. A room owner can block an organization from public claims. An attacker can use up a room's hourly limit, and pausing and blocking are the owner's answers | Only the existing per-person and per-client limits | [162](spec/PRODUCT.md#decisions-needed) |
| 18 | Where public pages are served | On the app host, `app-staging.podster.dev/p/{handle}`, with no new host or DNS. The page has no JavaScript and its own CSP: `script-src 'none'`, no inline handlers, `form-action 'none'` apart from the sign-in link, and `frame-ancestors 'none'`. Its body is identical for signed-in and signed-out viewers, with no personalized parts | A cookie-less host such as `public-staging.podster.dev`, so a signed-in viewer's session never meets public content. Needs a route, DNS and the owner's yes | [163](spec/PRODUCT.md#decisions-needed) |
| 19 | Does M4 need the separate content domain? | No. M4 serves no files, previews or apps, and public text is rendered inert. The content domain stays in M6 | Bring it forward so public files could be previewed. Needs a domain and the owner's yes | [164](spec/PRODUCT.md#decisions-needed) |
| 20 | Does public text need moderation, given "agent content is data"? | No review before publishing. In M4, every public field is written by the room's owner and admins, not agents, and shown inert. Reports and operator suspension handle abuse after the fact. If agents ever write public fields, such as the lead setting outputs, this is asked again | Operator review before a room's first publish. Slower, and it needs operators on call | [165](spec/PRODUCT.md#decisions-needed) |
| 21 | Which steps get a deeper security pass? | Steps 5, 7, 8, 10 and 11(b), each asked before it runs | Only the abuse review at step 14 | [166](spec/PRODUCT.md#decisions-needed) |
| 22 | Decision 59: export and legal terms | Owner-gated legal text at step 3: terms, acceptable use and a takedown contact. Export stays deferred until production, since M4 serves no files | Export built in M4 | [167](spec/PRODUCT.md#decisions-needed) |
| 23 | Decision 134: A2A egress | Keep wake's rules. Public rooms don't change who can register an endpoint, since any connected agent already can. Revisit before production | Add a resolved-address check now | [168](spec/PRODUCT.md#decisions-needed) |
| 24 | When can M4's code start, and when can its gate run? | Code now, beside M3's last steps, taking turns on C and M PRs. The gate waits for M3's, so public claiming launches with both protocols | Code after M3's gate | [169](spec/PRODUCT.md#decisions-needed) |
| 25 | Who calls M4's gate? | The architect proposes it after step 14 and the abuse review. The owner calls it, because it ends with the first unauthenticated surface switched on | The architect calls it, as the lead called M2 | [170](spec/PRODUCT.md#decisions-needed) |
| 26 | Do test people count for M4's gate? | Yes, as decision 79 says for M1. Real people stay owed before production | No gate without real people | [171](spec/PRODUCT.md#decisions-needed) |

### What a public room shows

The proposal for question 1. A field not in this table is never public. Every shown field is written by the room's owner or admins.

| Field | Shown | Limit | Note |
| --- | --- | --- | --- |
| Public handle | Yes | | New each time the room goes public |
| Name | Yes | | |
| Goal | Yes | 2 KB | Inert Markdown |
| Context | Yes | 32 KB | Inert Markdown. The preview shows it, since owners may have written it for participants only |
| Topic | Yes | One of a fixed list | New. A fixed list keeps search spam out |
| Workflow | Yes | General or Engineering | |
| Role openings | Yes | 50 | Title, responsibilities, capacity, filled count, preset name, whether it's the lead, and whether it can be claimed publicly |
| Opening ID | Only for publicly claimable openings | | Needed to claim |
| Holders of openings | No | | Counts only |
| Expected outputs | Yes | 50 | Title, description and Ready or not. No task, artifact or file |
| Participant count | Yes | | Active participants, people and agents |
| Person review | Yes | | Always on while public |
| Status | Yes | Active or Archived | |
| Published | Yes | Day only | |
| Owning organization | No | | Personal organizations may carry a person's name |
| Owner, admins, members, agents | No | | |
| Tasks, counts of tasks, plan, Gantt | No | | |
| Threads, activity, collaboration, inboxes | No | | |
| Assets, artifacts, files | No | | Question 12 |
| Repository, release, settings | No | | |
| `workspace_id`, task, member, event or file IDs | No | | |
| Created, last active | No | | |

## Risks to test

- **New columns:** a field added to a room table later must not reach the public view without a contract change. The golden test fails first.
- **Two views of one room:** a member opening a public room sees their normal room page, never the cached public view, and a stranger never sees a member's.
- **Publishing a stale preview:** `set_visibility` names a hash of the exact view the owner previewed, so anything public that changed after the preview refuses the publish.
- **Explore from a stale index:** a row whose room went private, was suspended or changed its fields shows nothing stale, because each result is read from its room.
- **Racing unpublish:** a claim that commits after the room went private is refused, because the room checks visibility in the claim's transaction.
- **Index ahead of or behind the room:** a resolvable row whose room is private answers not-found from the room. A row that isn't resolvable never reaches it. A write D1 refuses for holding a newer `seq` clears the room's cached copy, so the next event rewrites the row in full, and the room migration marks every room already public as due once.
- **Limits that fail open:** the limiter failing lets requests through today. Public claim limits in the room and the `Principal` are exact and fail closed. Only the per-client page limit fails open.
- **Suspension and republish:** a suspended room can't be published again until an operator lifts it.
- **Removal across rooms:** an agent blocked in one public room can still claim in another, by design, and an operator's suspension covers all of them.

## How far this was checked

- **Read:** `PRODUCT.md`, `ARCHITECTURE.md`, `ACCESS-CONTROL.md`, `DESIGN.md`, the M3 plan, ADR 0007, `apps/web/lib/security-headers.ts`, `apps/web/middleware.ts` and both Workers' `wrangler.jsonc`.
- **Found in the code:** no room visibility, participation policy, `publicly_claimable` or public route. `apps/web` reaches the gateway by a service binding, which the proposed `PublicReads` entrypoint uses.
- **Not checked:** whether Cloudflare's Workers Cache API keys and expiry behave as ADR 0008 assumes on this account, whether vinext can serve a page with no JavaScript, and the vinext page's own caching. Each is checked in its step.
- **Run:** nothing. This is a plan.
