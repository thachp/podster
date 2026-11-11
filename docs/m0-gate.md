# M0 gate

What proves each M0 requirement, and how far that proof has got. [M1's criteria on staging](#m1-criteria-on-staging) have their own section. The requirements come from [PRODUCT.md](spec/PRODUCT.md#product-direction-and-delivery-scope) and [ACCESS-CONTROL.md](spec/ACCESS-CONTROL.md#proposed-acceptance-and-denial-tests).

**M0 has passed on a deployment, with two real people.** On 2026-11-09, [the journey ran on staging](#journey-on-staging-with-two-people) with the owner and a second person, each signed in with their own GitHub account, and every check passed. The AC-19 probe passed right after on the same deployment. Before that, M0 was only accepted by the owner, on 2026-11-05, and the journey had run [with test people](#journey-on-staging-with-test-people) on 2026-11-06. The items that close on local proof by [ruling](#gate-rulings-2026-11-05-utc), and the parts the tables below mark as local only, are still local only.

Staging has also had three checks by hand, and none counts as a criterion passing: the [smoke test](#one-person-smoke-test-on-staging), [wake](#wake) and the [ownership check](#two-person-ownership-check-on-staging).

A status is one of these, and an item only moves when the run has actually happened:

- **Not covered:** no test proves it.
- **Local only:** a test passes under Miniflare or `wrangler dev`.
- **Passed on a deployment:** the test passed against a real hostname, with two separate people where people are involved. If those were [test people](#with-test-people), the status says so.

Last updated on 2026-11-09 UTC. Rows show the two-person run, at `1d28ee2`, which supersedes the test-people runs at `abe92ef` and `5ae3dad`. Every check in those runs passed again in it, and a partial item still passes only for the part its row names. The AC-19 probe last ran at `1d28ee2`. `journey` means [e2e/journey.mjs](../e2e/journey.mjs), and the ID after it is the check's ID in its output. "Partial" means the journey reaches only part of the item from outside, and the rest runs only in the named tests.

## Kernel success criteria

The November 4 staging run doesn't count here. Its driver was never committed, one person held every organization, and it predates later changes.

| Criterion | Test | Status |
| --- | --- | --- |
| 1. Two organizations, two connection methods | journey `SEP`, `C1` | Passed on a deployment, 2026-11-09 at `1d28ee2` |
| 2. Offer reaches B's inbox with no public URL | journey `C2` | Passed on a deployment, 2026-11-09 at `1d28ee2` |
| 3. Accept, message, submit | journey `C3` | Passed on a deployment, 2026-11-09 at `1d28ee2` |
| 4. Changes, resubmit, verify | journey `C4` | Passed on a deployment, 2026-11-09 at `1d28ee2` |
| 5. Same state and history after reconnecting | journey `C5`. Agent A opens a new MCP client on the same credential. Agent Auth has no connection to reopen, so agent B's "reconnect" is just its next signed call | Passed on a deployment, 2026-11-09 at `1d28ee2` |
| 6. Outsiders and guests see only their own tasks | journey `C6` | Passed on a deployment, 2026-11-09 at `1d28ee2` |
| 7. Org A revokes Org B | journey `C7`; apps/api "revoking a whole organization" | Passed on a deployment, 2026-11-09 at `1d28ee2` |
| 8. A retry creates nothing new | journey `C2` to `C4` retry each command, and `C8` counts the result | Passed on a deployment, 2026-11-09 at `1d28ee2` |
| Connected to first accepted task in under 5 tool calls | journey `P1` (3 calls) | Passed on a deployment, 2026-11-09 at `1d28ee2` |
| No mutation without its event, or the reverse | journey `P2` for concurrency. Failure mid-write needs failpoints: apps/api "rolls back task, event, outbox and idempotency when a command fails after writing" | Passed on a deployment, 2026-11-09 at `1d28ee2`, for concurrency. Failure mid-write stays local only |
| A message reaches only agents allowed to see it | journey `P3`, and the race in `C7` | Passed on a deployment, 2026-11-09 at `1d28ee2` |

## Acceptance tests

"apps/api" is `apps/api/test/kernel.spec.ts`, and "gateway" is `apps/gateway/test/gateway.spec.ts`.

| ID | Test | Status | What's missing |
| --- | --- | --- | --- |
| AC-01 | journey `AC-01`; apps/api "only people create rooms, and the creator owns it whatever the body says" | Passed on a deployment, 2026-11-09 at `1d28ee2` | |
| AC-02 | journey `AC-02`, `AC-02+`; apps/api "only the owner appoints admins, and agents can't be admins"; gateway `organizations.spec.ts` | Passed on a deployment, 2026-11-09 at `1d28ee2` | An admin appointing a real third person runs only in gateway tests, because a journey run has two people |
| AC-03 | journey `AC-03` is partial; apps/api "members, guests and agents can't use any access command", "refuses a claim without an invite", "lets only an owner or admin create and change openings" | Passed on a deployment, 2026-11-09 at `1d28ee2`, for people outside the room and agents through the public routes. An agent calling the API's own route stays local only | The journey's tool-name check exempts `list_role_openings`, `claim_role` and `release_role` by exact name. Filling an opening is an agent's own act and needs an owner's or admin's invite, and `M1-ROLES` tests it |
| AC-04 | journey `AC-04`, `M1-ACCESS`; apps/api "uses one key per route, moves the policy version, and pages the whole audit log", "lets an owner or admin apply a preset and adjust scopes, with an audit of before and after" | Passed on a deployment, 2026-11-09 at `1d28ee2` | The journey runs this as the owner. An admin changing a scope is only in apps/api tests |
| AC-05 | journey `AC-05`; apps/api "keeps rooms apart" | Passed on a deployment, 2026-11-09 at `1d28ee2`, for people's paths on lists, reads, edits and deletes. Agent, asset and provider IDs and the bulk path aren't tried | Assets and provider IDs arrive in M2 and M5 |
| AC-06 | journey `AC-06`; apps/api "the agent's own organization withdraws it without room authority, and nobody else can" | Passed on a deployment, 2026-11-09 at `1d28ee2` | |
| AC-07 | journey `AC-07` | Passed on a deployment, 2026-11-09 at `1d28ee2` | |
| AC-09 | journey `AC-09`; apps/api "an unknown room and a private room look identical to outsiders, and the unknown one stays empty" | Passed on a deployment, 2026-11-09 at `1d28ee2` | Discovery and graph data arrive in M1 and M4 |
| AC-12 | journey `AC-12`; `crates/assertion/tests/verify.rs`; apps/api "refuses forged, expired, wrong-audience and over-long assertions before routing" | Passed on a deployment, 2026-11-09 at `1d28ee2` | A2A arrives in M3 |
| AC-13 | journey `AC-13` is partial; apps/api "a stale form can't restore revoked access or apply over newer changes", "orders revocation against concurrent commands" | Passed on a deployment, 2026-11-09 at `1d28ee2`, for stale forms only. A cached assertion, and an admin revoked mid-save, stay local only | Timing against a live admin revocation can't be arranged from outside |
| AC-14 | journey `AC-14` is partial; apps/api "refuses an assertion minted before the disconnect on every route" | Passed on a deployment, 2026-11-09 at `1d28ee2`, for commands racing a global disconnect and nothing getting through afterward. An assertion minted before the disconnect stays local only | A pre-minted assertion can't be made from outside, so this half can only run in tests |
| AC-15 | journey `AC-15`; apps/api "returns the first result on retry" | Passed on a deployment, 2026-11-09 at `1d28ee2` | |
| AC-16 | apps/api "rolls back task, event, outbox and idempotency when a command fails after writing" | Local only | Failpoints never ship, so this closes on local proof ([ruling](#gate-rulings-2026-11-05-utc)). External providers arrive in M5 |
| AC-17 | journey `AC-17`; `crates/core/tests/transitions.rs` `nobody_signs_off_their_own_work` | Passed on a deployment, 2026-11-09 at `1d28ee2`, for self sign-off. Merge and deploy are shown only by no such tool being exposed: nothing tries one after approval | |
| AC-19 | [e2e/probe-api.mjs](../e2e/probe-api.mjs). See [below](#ac-19-the-apis-public-reachability) | Probe passed on a deployment, 2026-11-09 at `1d28ee2`, including `--with-posts` and the account's real Workers subdomain. An untrusted service calling the API stays local only | The deployment probes are clean but incomplete |
| AC-20 | apps/web `team/access-sheet.test.tsx` "AC-20: Cancel saves nothing", "AC-20: a stale form keeps the person's choice and offers the latest, and doesn't overwrite", "AC-20: a refusal from the server shows as a refusal, and nothing changed", "UI-05, AC-20: %s gets the generic not-found, with no title"; `components/sheet/target-sheet.test.tsx` "discarding closes without saving (AC-20)". Server half: journey `AC-13`; apps/api "a stale form can't restore revoked access" | Local only | These component tests run in jsdom with a stand-in router, so no test yet does this in a browser against the real stack |
| AC-21 | apps/web `team/access-sheet.test.tsx` "AC-21: a save stays bound to its own target after the URL moves on"; `components/sheet/target-sheet.test.tsx` "binding to the original target (AC-21)" | Local only | The same: jsdom only |
| AC-22 | journey `AC-22`; apps/api "lets only human owners and admins read the event log", "the record of denied changes" | Passed on a deployment, 2026-11-09 at `1d28ee2`, for people. An agent or plain member reading the denial record stays local only | The denial record's retention and correlation IDs are the owner's to check (gap 3) |
| AC-25 | journey `AC-25`; `transitions.rs` departure tests; apps/api "applies the departure rules to submissions, reviewers and requesters" | Passed on a deployment, 2026-11-09 at `1d28ee2` | |
| AC-26 | journey `AC-26` is partial; apps/api "an unknown room and a private room look identical to outsiders" | Passed on a deployment, 2026-11-09 at `1d28ee2`, for a real room and a random ID answering the same. That no state is created stays local only, and a deleted room can't be tried | Rooms can't be deleted, so a previously deleted ID can't be tried |
| AC-29 | journey `AC-29` is partial; apps/api "a join begun before a disconnect can't commit after the room acknowledges it, even after reconnect", "a second disconnect needs a new acknowledgment" | Passed on a deployment, 2026-11-09 at `1d28ee2`, for disconnect, reconnect, rejoin and a second disconnect. A join delayed past the fence stays local only | A delayed join needs a failpoint, so that half can only run in tests |
| AC-30 | journey `AC-30`, `AC-30+`; `crates/policy/tests/matrix.rs` `a_requester_cant_swap_the_reviewer_of_a_submitted_task`; apps/api "AC-30: creating needs an eligible reviewer", "AC-30: a departing reviewer's fallback", "AC-30: turning it on" | Passed on a deployment, 2026-11-09 at `1d28ee2` | |
| AC-32 | journey `OVERSIGHT` is partial; apps/api "an organization's oversight of its own agent" | Passed on a deployment, 2026-11-09 at `1d28ee2`, for an invited organization's admin reading only its own agent's tasks with no room role. The cases in the next column stay local only | A plain member, a removed admin and a whole-organization revocation run only in apps/api tests |
| AC-33 | journey `AC-33` is partial; apps/api "transferring and recovering a room's ownership"; gateway "doesn't give a room's owner their room back when they rejoin, until recovery names them" | Passed on a deployment, 2026-11-09 at `1d28ee2`, for transfer and handing back, a departed owner refused even after rejoining, and recovery by an organization admin who's in the room, with its audit. The cases in the next column stay local only | An admin outside the room whose owner left and no admin remains, an archived room, a retry and a partial failure run only in apps/api tests. Part of AC-33 ran by hand on staging: see [the ownership check](#two-person-ownership-check-on-staging) |

### Screens seen on staging

On 2026-11-06, at `5ae3dad`, the lead drove the screens in a browser pane as the owner, signed in with their own GitHub account. It was Chromium, with no screen reader. This is a check by hand, and it's recorded from the lead's report.

**Seen:**

- **Create screen:** made a room, `M1 Screens Check`, with a goal, context, a lead opening and a Writer opening with a count of 2, all set while creating. "Adding opening 2 of 2…" showed, then it landed on Overview.
- **Overview:** the goal, context, owner, "Lead: nobody holds it yet", and 0 people and 0 agents plus the owner.
- **Team:** Lead with Coordinator, 0 of 1, and Writer with Member, 0 of 2.
- **Activity:** created this workroom and two openings, newest first.
- **My workrooms card:** "0 of 3 roles filled", "Roles: Lead 0 of 1 · Writer 0 of 2", and the goal.
- **A room from before #94:** `Focus Check Room` reads Activity with a `subject` key on each event, all null, so the `event.subject_id` migration reached it. `get_plan` with `scope=unfinished` there returned 2 tasks, `complete` false, with a revision.
- **Task Sheet Plan section,** in that room: Show plan, then Edit plan with focus on the estimate. An estimate of 3 and an added predecessor were saved, with "Plan saved. Nobody is told…". The live status region showed "Added Hostile nesting." and "Unsaved changes". No screen reader ran, so what it would say wasn't checked. The Blocked line appeared on the List behind the Sheet without a reload, and showed on the Board too. The test plan was then cleared.
- **A loop refused in the screen:** a plain reason, focus on the message, and the draft kept.
- **Collaboration,** in `Smoke test room`: the list shows "You to Gigi, 1 offer" and "You to Smoke Agent, 1 message", the participants with last active, and the planned-relationships section, with nothing planned because that room has fewer than two openings. The map shows the same two lines with counts of 1, labelled "You to Gigi: 1 in all, 1 offer" and "You to Smoke Agent: 1 in all, 1 message". Adding, removing and hiding planned lines, and refusing a duplicate or a line to itself, were checked on staging on earlier deploys, not at this commit.
- **A real GitHub sign-in on the application host:** once, for the owner only.

**Not seen, so still open:**

- Load more on a long list, on a deployment.
- The form fixes for typing before load.
- Narrowed or guest views in a browser on a deployment, including Collaboration's. They now have [local paths only](#what-the-call-on-m1-rests-on).
- An agent in the browser.
- Firefox. Safari with VoiceOver is [done](#safari-with-voiceover).
- A second real person.

**Left behind:** `M1 Screens Check` is a leftover test room in the owner's personal organization.

**The Approved mark on the Task Sheet ([#101](https://github.com/thachp/podster/pull/101)):** on 2026-11-07 UTC, at `404dab7`, the lead saw it on staging in the Smoke room, on a task whose approved submission is also its latest. This is a check by hand, recorded from the lead's report. An approved earlier submission, which a task can't reach today, and a limited viewer have component tests only, and no browser test looks for the mark.

The seen list covers [the checklist](#the-checklist)'s steps 1 to 3. Its agent steps weren't run this way, and the journey covers those through the API.

### Safari with VoiceOver

On 2026-11-07, at `6e75834`, the owner checked staging by hand in real Safari with VoiceOver: sign-in, creating a room, the Tasks List, Board and Gantt (including saving a start date), the Task Sheet, Activity's Load more, and members and invitations. All of it was fine. It's recorded from the lead's report. Firefox hasn't been checked this way.

### What the call on M1 rests on

**The owner called M1 met on 2026-11-06, at `5ae3dad`** ([decision 80](spec/PRODUCT.md#decisions-needed)). It's met by that ruling. The rows above keep their own statuses, so "Passed through the API" and "seen by hand" don't become **Passed on a deployment**.

The call rests on:

1. **The API checks for all four criteria,** which passed on a deployment with test people. Test people count for these criteria ([decision 79](spec/PRODUCT.md#decisions-needed)). They passed again with two real people on 2026-11-09 at `1d28ee2`, in [the two-person run](#journey-on-staging-with-two-people).
2. **The screens,** [seen by hand](#screens-seen-on-staging) once, as the owner, in Chromium. The by-hand check counts for M1's screens ([decision 80](spec/PRODUCT.md#decisions-needed)).
3. **The smaller gaps, accepted for M1,** which stay open on a deployment: a claim holder on Agent Auth, presets other than Coordinator and Member held in a claim, the owner rather than a lead moving the reviewer, duplicates sent as the same request twice rather than delivered twice by a transport, a person's Activity against their inbox, and a narrowed viewer's Activity screen.

   Four of these now have checks. `M1-CLAIM-AUTH`, `M1-CLAIM-PRESETS` and `M1-PERSON-AGREE` in `e2e/journey.mjs` passed on a deployment, with two real people, on 2026-11-09 at `1d28ee2`. Two paths in `e2e/a11y.mjs`, for a guest's screens and a narrowed agent's work, pass against the local stack only. People's access follows their role, so no narrowed person exists: the narrowed viewer's Activity is an admin's oversight of a narrowed agent, and a person's limited view is a guest's. The owner moving the reviewer and duplicates from a transport have no new check.

   With these, all four presets have been held in a claim, locally. `M1-PERSON-AGREE` covers a person who sees the whole room, not a limited one. The guest path doesn't look for planned lines, so [UI-08](spec/DESIGN.md#12-design-acceptance-criteria)'s planned half still has no browser check. [#102](https://github.com/thachp/podster/pull/102) reports the local results: the journey at 52 passed on `1a9bebe`, and 94 axe runs with 0 violations on `404dab7` plus its changes.

[M1's scope](spec/PRODUCT.md#product-direction-and-delivery-scope) also names the collaboration list and map, which no criterion covers. They were [seen by hand as the owner](#screens-seen-on-staging).

**Still open, after this call:**

- Those smaller gaps, on a deployment. Of #102's checks, only the journey's three have run there, on 2026-11-09 at `1d28ee2`.
- Load more on a long list, on a deployment.
- The form fixes for typing before load.
- Narrowed or guest views in a browser on a deployment, including Collaboration's.
- An agent in the browser.

**Owed before production:**

- A second real person in the browser. The two-person kernel journey [passed on 2026-11-09](#journey-on-staging-with-two-people).
- The probes at the end of [ADR 0001](adr/0001-application-host-and-session-cookie.md#what-staging-needs). The owner's sign-in reached the application host, but no probe measured GitHub's callback or the cookie crossing the web Worker.
- Decision 23 and gap 8, which needed an OAuth sign-up to create a personal organization. [Done on 2026-11-09](#journey-on-staging-with-two-people): the second person's first sign-in was an OAuth sign-up.
- Firefox. Safari with VoiceOver is [done](#safari-with-voiceover). CI's browser checks run in Chromium. `run-a11y.mjs --browser=firefox` and `--browser=webkit` have run locally only, in Playwright's own builds, which aren't a released Firefox or Safari, and none of this is a screen-reader pass. On those runs Firefox had no failures. WebKit had one, a tab taking about 10 seconds to show 50 messages of alternating text direction, and its arrow keys don't scroll anything, so scrolling a table or the map by key is unseen there.

**UI-10 isn't an M1 criterion.** It asks for a keyboard and screen-reader pass on creating a room, reviewing a task and revoking access, and creating a room is one of M1's screens. But [M1's gate](spec/PRODUCT.md#product-direction-and-delivery-scope) names only expanded criteria 1, 3, 4 and 5, and [DESIGN.md](spec/DESIGN.md#12-design-acceptance-criteria) sets UI-10 as a design criterion, with the screen-reader pass due before launch. So it's listed under production, and it's still open.

## Journey on staging, with two people

On 2026-11-09, `e2e/journey.mjs` ran against `https://gateway-staging.podster.dev` with the owner and a second person, each signed in with their own GitHub account and pasting their own session. **52 passed, 0 failed, 0 gaps.**

- **What ran:** `main` at `1d28ee2`. The API was deployment `bbc61c80`, which is that commit's code plus the `A2A_TOKEN_KEY` secret, and the gateway was `34ade0af`.
- **When:** from 00:25:09 to 00:30:40 UTC.
- **Results file:** `"kind": "deployment"`, `"people": "session_cookies"`, `"persons_distinct": true`. It holds IDs and outcomes only, and it's gitignored, so it isn't in this repo.
- **Checks that ran:** every check from [the test-people runs](#journey-on-staging-with-test-people), plus `M1-CLAIM-AUTH`, `M1-CLAIM-PRESETS` and `M1-PERSON-AGREE`, which before had run on the local stack only. The partial checks printed the same limits as before, and the tables above carry them.
- **AC-19:** the probe ran right after with `--with-posts` and the account's Workers subdomain, on the same deployment, and passed. The subdomain stays out of this repo.
- **What it left behind:** the run's rooms, agents and events, and the two organizations it makes on the owner's account, stay on staging, because staging has no delete route.

**What it doesn't close:**

- **`D23` passes decision 23 and gap 8.** The check reads that each person has exactly one personal organization and is its admin. The owner confirmed that the second person's sign-in for this run was their first on staging, with a GitHub account new to Podster, so that organization was made by an OAuth sign-up. Migration `0003_one_personal_org.sql` is on staging too: D1 applies a database's migrations in order, and this run's organization departure, in `AC-33`, needs the later `0005_org_departure.sql`. A sign-up hook that fails during an OAuth sign-up still runs only in tests.
- **The probes at the end of [ADR 0001](adr/0001-application-host-and-session-cookie.md#what-staging-needs).** Both sessions came from a real GitHub sign-in, but no probe measured GitHub's callback or the cookie crossing the web Worker.
- **Screens.** The journey drives APIs and agents. A second person in the browser is still [not seen](#screens-seen-on-staging).

## Journey on staging, with test people

These runs came first. [The two-person run](#journey-on-staging-with-two-people) passed every check they did.


**The latest run:** on 2026-11-06, with [#94](https://github.com/thachp/podster/pull/94) deployed, the journey passed against `https://gateway-staging.podster.dev` with test people. **49 passed, 0 failed, 0 gaps.**

- **What ran:** `main` at `5ae3dad`. The API was deployment `8398ba24` and the gateway `cc42bbb8`, both confirmed with `wrangler deployments list` just before the run.
- **Results file:** `"kind": "deployment"`, `"people": "test_signup"`, `"persons_distinct": true`. It's gitignored, so it isn't in this repo.
- **Added since the run below:** `M1-CREATE`, `M1-COUNT`, `M1-CLAIM`, `M1-LEAD`, `M1-AGREE` and `M1-APART`, all passed. The [M1 table](#m1-criteria-on-staging) has what they cover.
- **The checks from the run below passed again.** The tables on this page keep the date of their first pass, at `abe92ef`, and this run didn't change what they cover. `D23` wasn't a pass of decision 23 or gap 8 here, for the reason below. [The two-person run](#journey-on-staging-with-two-people) passed them.
- **An earlier run the same day,** at `abe92ef` with the journey from `1ccd2b0`, had 49 passed, 0 failed and 1 gap, `M1-AGREE-NOTICES`. This run supersedes it, because #94 closed that gap.
- **Afterwards:** `E2E_SIGNUP_SECRET` was deleted and confirmed gone.
- **What these runs left behind:** each one's rooms, agents, test people and events stay on staging, as below.

**The first run,** below, is the one the kernel and acceptance tables record.

Earlier on 2026-11-06, with the owner's approval, `e2e/journey.mjs` ran against `https://gateway-staging.podster.dev`, using [test people](#with-test-people). **43 passed, 0 failed, 0 gaps.**

- **What ran:** `main` at `abe92ef`. The API was deployment `b17bce83` and the gateway `901136d5`, both confirmed with `wrangler deployments list` just before the run.
- **Results file:** `"kind": "deployment"`, `"people": "test_signup"`, `"persons_distinct": true`. It holds IDs and outcomes only, and it's gitignored, so it isn't in this repo.
- **Checks that ran:** `SEP`, `C1` to `C8`, `P1` to `P3`, `AC-01`, `AC-02`, `AC-02+`, `AC-03` to `AC-07`, `AC-09`, `AC-12` to `AC-15`, `AC-17`, `AC-22`, `AC-25`, `AC-26`, `AC-29`, `AC-30`, `AC-30+`, `AC-33`, `ROOM`, `OVERSIGHT`, `M1-BRIEF`, `M1-ACCESS`, `M1-ROLES`, `D4`, `D14`, `D21`, `D22` and `D23`. Several print what they leave to other tests, and the tables above carry that.
- **AC-19:** the probe ran with `--with-posts` and the account's Workers subdomain, and passed. The subdomain stays out of this repo.
- **Afterwards:** `E2E_SIGNUP_SECRET` was deleted and confirmed gone.
- **What it left behind:** the run's rooms, agents, test people and their events stay on staging, because staging has no delete route. [docs/staging.md](staging.md#test-people-for-the-journey) says how to tell them apart.

**`D23` printed ok, and that doesn't pass decision 23 or gap 8.** The check only reads that each person has one personal organization and is its admin. Test people sign up by email through the test route, and those two items need an OAuth sign-up to create that organization. So this run left them open, and [the two-person run](#journey-on-staging-with-two-people) closed them.

**Still owed before production:**

- The two-person kernel journey, with two real people and their own sign-ins. [Done on 2026-11-09](#journey-on-staging-with-two-people).
- The probes at the end of [ADR 0001](adr/0001-application-host-and-session-cookie.md#what-staging-needs). [The owner's sign-in](#screens-seen-on-staging) reached the application host, but no probe measured GitHub's callback or the cookie crossing the web Worker.
- Everything else listed under [With test people](#with-test-people), which stays open.
- Firefox. Safari with VoiceOver is [done](#safari-with-voiceover).

These runs drive APIs and agents, not screens. [The screens seen by hand](#screens-seen-on-staging) are recorded separately.

## One-person smoke test on staging

The one-person smoke test passed on staging on 2026-11-05: dashboard offer, MCP sign-in, agent work, request changes, approve, retry, self-approval refused, inert agent HTML, disconnect. One person ran it by hand, so it doesn't count as any criterion passing, and it's what [ADR 0002](adr/0002-vinext-on-workers.md) was waiting on. Nothing here recorded which commit was deployed.

## Two-person ownership check on staging

On 2026-11-05, with `main` at `84c7c0c` deployed, the project's owner ran part of AC-33 on staging by hand, through the dashboard. It used two real GitHub accounts, called A and B here, in an organization made for it. It covers ownership only, so it doesn't move AC-33 or any kernel criterion to **Passed on a deployment**. B's side was reported in chat, not captured by a tool.

**Worked:**

- A owned a room and transferred it to B, a room admin in the organization. A became a room admin. The picker and confirmation told the two accounts apart by person ID, because they have the same name.
- B, now the owner, revoked A from the room.
- A, an organization admin, removed B from the organization. The room was on the ownerless list when checked about 10 seconds later.
- With B gone, recovery refused a wrong `expected_owner` with `version_conflict`, and naming B while out of the organization with `not_in_organization`.
- B rejoined, was refused the room, and didn't see it in their list.
- A, by then outside the room, recovered it to themselves. The list dropped it, and the access history recorded each change.
- B was still refused after recovery.

**Not covered, among others:**

- An organization admin who was never in the room. A had been revoked from it, so before B left they got `access_revoked`, not not-found.
- Transfer's refusals, and recovery tried by a plain member, another organization's admin or an agent.
- Recovery in an archived room, naming a rejoined former owner, and a retry after a lost response.
- A room whose departure never arrives or arrives late, and a partial failure.
- Whether each change leaves exactly one audit entry and one event.
- These screens at phone width on staging.

## M1 criteria on staging

M1 is [expanded criteria 1, 3, 4 and 5 for private rooms](spec/PRODUCT.md#expanded-workroom-acceptance-criteria), without input assets and expected outputs ([decision 47](spec/PRODUCT.md#decisions-needed)). The [journey passed on staging with test people](#journey-on-staging-with-test-people) on 2026-11-06 at `5ae3dad`, including checks written for these criteria, and test people count for these criteria ([decision 79](spec/PRODUCT.md#decisions-needed)). [The screens were then seen by hand](#screens-seen-on-staging) at the same commit. The API checks passed again [with two real people](#journey-on-staging-with-two-people) on 2026-11-09 at `1d28ee2`. **The owner called M1 met on 2026-11-06, by ruling** ([decision 80](spec/PRODUCT.md#decisions-needed)). **No criterion is marked Passed on a deployment: the API checks passed with test people, and the screens were seen by hand once, as the owner, in Chromium.** [What the call rests on](#what-the-call-on-m1-rests-on) is at the end of this section.

| Criterion | On a deployment, with test people, 2026-11-06 at `5ae3dad` | Still open | Local proof |
| --- | --- | --- | --- |
| 1. Create a room with goal, context and roles, launching nothing | **Passed through the API.** `M1-CREATE`: a room has its goal and context, and openings with a count of 1 and 2 are added. No agent is added or told, no agent lists or reads it, and adding one agent adds only that one. Its card's counts match. `M1-BRIEF`: an agent reads the goal and context and gains nothing from them. `M1-COUNT`: a count of 2 takes two holders and refuses a third | **Open: only the owner as a person; the screens are seen by hand, not passed.** That's [the create screen with roles set while creating, Overview, Team and the card](#screens-seen-on-staging), once, in Chromium. `M1-CREATE` itself adds openings after the room exists | `create-form.test.tsx` |
| 3. A claim grants only its scope, and a task still needs accepting | **Passed through the API, for agents on MCP.** `M1-CLAIM`: holders of a Coordinator and a Member opening can't approve or send back work they aren't reviewing, have no access tool, and have the member role, not an admin's. A task offered after a claim stays offered, can't be submitted early, and needs accepting. `M1-ROLES`: a claim needs an invite and copies the preset. `M1-ACCESS`: what an agent sees follows its access | **A holder on Agent Auth:** the refusals ran over MCP only. **Other presets:** only those two were held. **Merge and deploy:** shown by no such tool existing, since neither is built. Public claims are M4 | apps/api role tests; `M1-CLAIM-AUTH` and `M1-CLAIM-PRESETS` on the local stack |
| 4. A lead coordinates through one task history, and duplicates don't compete | **Passed through the API: creating and sending back over MCP, approving over Agent Auth.** `M1-LEAD`: a lead holding the opening creates a task and sends it back over MCP. The opening then moves to an agent on Agent Auth, who approves it. So "coordinates work and review" is shown only in this split form, not by one lead doing all of it on each connection method. All parties read the same history and task. The former lead loses its access. The same request sent twice makes one task | **The reviewer's move:** a lead didn't move the reviewer; the owner did, because that's a requester's or admin's power. **Duplicates:** shown as the same request sent twice, not a transport delivering it twice. A2A is M3 | apps/api's idempotency tests |
| 5. Activity and inbox agree, and rooms stay apart | **Passed through the API, for the four agents in the run.** `M1-AGREE`: every inbox event is in the agent's Activity, in the same order. Of Activity, a limited agent sees only room notices about itself, and each was told to it unless it caused it. Task events in Activity aren't required to be in the inbox. A guest sees no task it isn't party to, in either. `M1-APART`: an agent in two rooms gets each room's goal and context only from that room, no read shows an invitation token, and one room's access or invitation opens nothing in the other | **A person's** Activity against their inbox isn't compared. **The Activity screen** was [seen by hand](#screens-seen-on-staging) as the owner only, and not as a narrowed viewer. **An existing room:** the `event.subject_id` migration was [seen on a room from before it](#screens-seen-on-staging), whose events all have a null subject. Old events stay hidden from limited agents, and a backfill wasn't done | apps/api, including an upgrade test; on the local stack, `M1-PERSON-AGREE` and the browser paths for a guest and for oversight of a narrowed agent |

**By hand isn't the same as passed.** For M1's screens, the owner ruled that the by-hand check counts toward calling M1 met ([decision 80](spec/PRODUCT.md#decisions-needed)), and it still isn't a pass. The steps below are a check by hand, like the other three on this page. Finishing them shows the product working for the people who ran them, and doesn't by itself make a criterion **Passed on a deployment**. That status means the test itself passed against a real hostname, with two separate people, so it needs [the journey on staging](#running-it-on-staging), or the owner ruling that a by-hand run counts. Record a by-hand run here with its date, commit and who ran it, and leave the statuses above alone unless one of those has happened.

### The checklist

Before starting, deploy the `main` to test and note its commit.

You need:

- **Person A:** an organization admin on `https://app-staging.podster.dev`.
- **Person B:** a second GitHub account, in another organization.
- **Agents 1 and 2:** each an MCP client, added from Agents, then Connect, using `https://gateway-staging.podster.dev/mcp`.

Write pass or fail for each step.

**Criterion 1: create a room, and nothing launches**

1. A goes to Workrooms, then Create a workroom. Enter a name, goal and context, add a lead opening called Lead and an opening called Writer with a count of 2, then create it.
2. Overview shows the goal and context, and Team shows both openings as vacant.
3. My workrooms shows the goal, "0 of 3 roles filled" and "Roles: Lead 0 of 1 · Writer 0 of 2".
4. No agent was started or told. Ask Agent 1 to call `list_workspaces`, and the room isn't there.

**Criterion 3: a claim grants only its scope**

5. On Team, A adds Agents 1 and 2 to the room as Guest.
6. A opens the lead opening and presses Invite for Agent 1, and doesn't invite Agent 2.
7. Agent 2 calls `claim_role` on the lead opening, and is refused with `not_allowed`.
8. Agent 1 calls `list_role_openings`, then `claim_role`. Team shows Coordinator for it, which is the preset every lead opening has, and nothing higher.
9. Agent 1 has no admin, access, merge or deploy tool: its tool list has no member, invite or grant commands.
10. A offers Agent 2 a task. It stays offered until Agent 2 calls `accept_task`, and Agent 1's claim assigned nothing to anyone.

**Criterion 4: the lead coordinates through one history**

11. Agent 1 calls `create_task` with Agent 2 as assignee and A as reviewer.
12. Agent 2 calls `accept_task`, `send_message` and `submit_task`.
13. A requests changes in the Task Sheet.
14. Agent 2 calls `submit_task` again.
15. A approves.
16. The Task Sheet, Agent 1's `get_task` and Agent 2's `get_task` tell the same history in the same order.
17. Agent 1 calls `create_task` twice with the same `idempotency_key`. There's one task, with the same ID both times. Some clients make the key themselves, so check the agent really repeated it.

**Criterion 5: activity and inbox agree, and rooms stay apart**

18. Agent 2 calls `read_inbox`. Its events for the task also appear in the room's Activity tab, and the inbox holds IDs only, with no task titles or message bodies.
19. A offers Agent 1 a third task, which Agent 2 isn't on. Agent 2's `list_activity` and `list_tasks` don't show it.
20. A creates a second room with a distinctive goal. Agent 2 calls `get_workroom_brief` with its ID, gets `workspace_not_found`, and the goal appears nowhere.
21. B, signed in, opens the first room's URL and gets not found, and the room isn't in B's My workrooms.
22. Agent 2 repeats step 20 with a made-up room ID, and the answer looks the same.

### What a person can't show by hand

- **The journey** covers `M1-BRIEF`, `M1-ACCESS`, `M1-ROLES` and the forged-credential and racing cases, and needs a terminal. [Running it with test people](#with-test-people) needs staging's test secret set, which the owner has to approve, and proves less.
- **Agent Auth for criterion 4.** A gateway test covers `list_activity` over both connection methods, locally. Steps 11 to 17 use MCP only.

## Accessibility (UI-10, UI-11)

[e2e/run-a11y.mjs](../e2e/run-a11y.mjs) starts the gateway, the API and the dashboard's production build, and [e2e/a11y.mjs](../e2e/a11y.mjs) drives them in Chromium. It runs in the `web` CI job. These are local results, on empty local databases seeded by the run itself, and they ran three times in a row with the same result before this was written.

**The browser in CI (2026-11-11).** The `web` job installs Chromium with [e2e/install-browser.mjs](../e2e/install-browser.mjs), not `npx playwright install --with-deps`. On 2026-11-11 the runners' Ubuntu mirror stopped resolving, apt waited ten minutes and failed the job before any check ran, on `main` and every open PR. On GitHub's Ubuntu 24.04 image the libraries Chromium needs are already installed, and apt only adds fonts. The script downloads the browser from Playwright's own host, tries the system packages three times at 90 seconds each, then starts the browser once with [e2e/browser-launch-check.mjs](../e2e/browser-launch-check.mjs).

- If the packages installed, nothing else changes.
- If they didn't and the browser can't start, the job fails with the browser's error.
- If they didn't, that's the fallback. The start-up check says which font draws each script the accessibility paths use: Arabic, Thai and Hebrew, and no others. Those paths ("unbroken scripts", "unbroken Arabic", "alternating directions") bound how long the main thread is blocked laying that text out. Text with no font is drawn as boxes and never shaped, so they would pass having measured nothing.
  - GitHub's image has fonts for Arabic (DejaVu Sans) and Hebrew (Liberation Serif) and none for Thai. For a script with none, the script copies a pinned font into the runner user's font folder and starts the browser again. The Thai one is Noto Sans Thai, a static TrueType file from `@expo-google-fonts/noto-sans-thai`, a development dependency of `e2e` at an exact version with its hash in `e2e/package-lock.json`. It is under the SIL Open Font License 1.1, whose text is in the package. It is used on the test machine only and is in nothing Podster builds or ships, so it puts no condition on Podster's MIT licence.
  - If a script is still drawn as a box, or has no pinned font, the job fails and names it.
  - Otherwise the job goes on, and its log has one line starting `WARNING browser-system-packages-not-installed`, also shown as a warning on the run's page, with each script's font and whether it came from the runner image or the pinned package.
- **A run with that line used different fonts for the non-Latin paths than a normal run**: the image's own and the pinned Thai font, not the ones apt installs. Their assertions are bounds on main-thread blocking, and they still shape real text when a real font draws it, but a timing or layout result from such a run isn't directly comparable with a normal run's. A normal run never installs the pinned font. Every run's last line from the script says which path it took: `packages`, `fallback` or `no-packages` (not Linux).

**Tabbing back over unbroken scripts wasn't really measured on CI (found 2026-11-11).** On 16 of the 18 CI runs examined that day, the two "unbroken scripts" paths (the Task Sheet's latest 20 messages and oversight's 50) kept only 3 or 4 message bodies laid out, and the bound on how long tabbing back blocks the main thread measured 0 ms. With so little laid out, there was nothing to measure, so those passes don't show the bound holds. The cause is the runner's speed: on a slower machine each of those bodies takes longer to lay out than the app's 50 ms step, so it stays skipped. It isn't the fonts, and it isn't PR #284; it happened before that change, on the normal path and on the fallback alike. Only two runs measured it: run 43021062605 (12:31Z, 13 of 20 and 14 of 50 laid out) and run 43030384220 (13:34Z, 12 of 20 and 16 of 50, 264 ms and 404 ms). From PR #285 on, a run with too few laid out prints `SKIP tab-back not measured`, and the run's summary counts it apart from passes. The next PR gives that check a thread that stays laid out on any runner, and makes it fail again.

**"Unbroken Arabic" was never measured either (found 2026-11-11).** That path keeps 0 of its 50 bodies laid out on every run read, the two runs above included, so its tab-back pass was as empty. Each body is 16 KB of one unbroken Arabic word, and laying out an unbroken run grows much faster than its length: such a body took about 90 ms on a fast Mac and 930 ms on one throttled tenfold, always over the app's 50 ms step, so the app leaves it skipped. The same amount of Arabic written as words took 7 ms. "Alternating directions" (unbroken Hebrew and Latin) is the same kind of input and kept 0 to 11.

**What PR #287 (fix/a11y-tab-back-deterministic) proves, and what it doesn't.** Three new paths use small unbroken bodies: "scripts that stay laid out" on the Task Sheet and on oversight (Arabic, Thai, and Hebrew with Latin, 1 to 2 KB a body), and "Arabic that stays laid out" on oversight (1 KB of unbroken Arabic a body). Every body in them must stay laid out, or the run fails. They show two things: the tab-back measurement is no longer vacuous, and small unbroken bodies all stay laid out on any runner. On CI they kept 20 of 20, 50 of 50 and 50 of 50, and tabbing back blocked for 0, 55 and 55 ms against the 1,000 ms bound. They don't show the bound holds near the worst case: their bodies are cheap, which is why they stay laid out. **The 16 KB paths' tab-back is not verified on most runners.** On #287's CI run all four were `SKIP`: "the Task Sheet, unbroken scripts" (3 of 20 laid out), "oversight, unbroken scripts" (3 of 50), "oversight, unbroken Arabic" (0 of 50) and "oversight, alternating directions" (0 of 50). Those paths still bound opening and reading. Every timed path also prints the scripts actually on the page, and fails if one is drawn with no font that has it. **That glyph check discriminates mainly on the fallback path.** On the normal CI path GNU Unifont is installed, and it covers very many scripts with bitmap glyphs, so "has a real glyph" there means "some installed font has it", which Unifont makes true for almost everything. The fallback path, with no system packages, is where the check actually tells a missing font apart. Its control is U+4E000, an unassigned code point no font should list; it fails if fontconfig lists one that does.

**OPEN, for the owner: long messages can stay out of the accessibility tree (found 2026-11-11).** Reported in PR #287 and confirmed by its review, which also corrected my first write-up as understating it. Not resolved by #287, and not tested with a real screen reader.

- A message body over 500 characters starts with `content-visibility: auto` (`apps/web/components/agent-content/agent-content.tsx:94-96`), so its layout is skipped until it nears the view.
- When the page is idle, each such body is timed once. One that costs over 50 ms to lay out is rejected and never timed again (`layout-reveal.ts:46-48`, `limits.ts:23-27`).
- Once 500 ms of kept layout or 1,000 ms of rejected layout is used, the remaining bodies are dropped untimed (`layout-reveal.ts:42-44`). So cheap bodies stay skipped too, and the budget comes back only when the screen unmounts (`layout-reveal.ts:71-77`).
- **Confirmed in Chromium 156:** off-screen skipped content is absent from the accessibility tree (its headings, text and links) until it's scrolled into view, and then it stays.
- So a reader moving message by message gets each one as they reach it. What's missing until then is those bodies' headings and links in element lists, and anything built from the whole tree.
- On a slow device this isn't only adversarial input: 16 KB of ordinary Arabic prose took 77 ms and Thai 92 ms to lay out at tenfold CPU throttle, both over the 50 ms step.

| Check | Result |
| --- | --- |
| axe with WCAG 2.0, 2.1 and 2.2 A and AA rules, including contrast, on 33 screens and states, each in light and dark | 66 runs, no violations, after the fixes below |
| Theme colors by contrast ratio: 4.5:1 for text, 3:1 for controls and focus rings | 56 pairs pass, after the fixes below |
| Keyboard only: review a task | Passes: focus moves into the Sheet, the approval is in a live region, and Escape returns focus to the link that opened it |
| Keyboard only: revoke access | Passes: focus moves into the Sheet and the confirmation, and ends on a status that says what happened |
| Keyboard only: create a room | Passes: focus moves to the new screen's main region, and the next Tab goes into that screen |
| Keyboard only: a refused create | Passes: focus stays on the field or button that submitted, and the reason appears in an alert. The run stages the refusal by answering the request itself |
| The checks themselves | A low-contrast element placed on the page has to trip axe, and the dark theme has to change the page's background |

Fixed here, all in shared labels and styles:

- The profile menu's `aria-label` hid its visible name from speech control (`components/shell/profile-menu.tsx`).
- The unread badge put `aria-label` on a `div`, which many screen readers ignore (`components/shell/app-shell.tsx`).
- A timestamp's `aria-label` was on `<time>`, which is just as unreliable (`app/(shell)/w/[id]/activity/time.tsx`).
- The dropdown's destructive item used a color at 2.87:1 in dark (`components/ui/dropdown-menu.tsx`). No screen uses that item yet.

What this doesn't prove:

- **No screen reader was run.** UI-10 asks for one, so it stays local only and incomplete. Focus and the alert's presence are checked, not what's actually spoken, and that includes what a screen reader says on arriving at the new room.
- **Only room creation hands focus over.** The form does it itself when the new screen replaces it. Other navigations that remove the focused control haven't been checked, and may still drop focus to the page body.
- **The dark theme isn't switched on in the product.** The run adds the class itself, and turning it on is still the owner's open design question.
- **axe couldn't decide some things, and they aren't passes.** It couldn't work out the background behind `section[aria-labelledby="agent-connection"] p` in the agent Sheet, `section[aria-labelledby="access-services"] p` in the access Sheet, and the buttons in the revoke confirmation, because they overlap other layers. It also asks a person to confirm `aria-hidden-focus` while a Sheet is open, on Radix's focus guards and the page behind. A results file lists them all under `unchecked`. The theme check covers the colors these use, but not how they stack.
- **Only what renders is checked.** Hover, focus and pressed colors, screens at 375 px wide (UI-12), and agent-written content beyond the seeded examples aren't covered. Screens with an unusual state, such as an archived room or a guest's view, aren't visited.
- **All of it is local,** so nothing here is proved on a deployment. Status: local only.

## Wake

Wake is part of M0's scope and has no AC of its own. It has merged, in PR [#22](https://github.com/thachp/podster/pull/22) and PR [#25](https://github.com/thachp/podster/pull/25). This section comes from another session's staging run on 2026-11-05 UTC, not from this driver, and the run was by hand with a temporary public receiver that has since been deleted.

**Passed on staging, on the build from `c30f51a`:**

- Delivery through the real queue arrived about 7 seconds after a task offer.
- The signature verified with the secret from `set_wake`, and failed with a wrong secret.
- The body held only `agent_id`, `unread` and `at`, with no task content.
- A second event inside a 60-second window sent nothing in the first 25 seconds, and the delayed wake arrived 65 seconds after the first.
- After `delete_wake`, a new event sent nothing in 25 seconds.
- `set_wake` refused `127.0.0.1`, `localhost`, plain `http` and a `podster.dev` hostname, each with 400 `invalid_wake_url`.

**Current build, from `d5c5ce8`:** PR #25 closes a way to skip the debounce with a failing URL. Setting or deleting a wake after a failed or unreported send now starts the window from that moment, so an agent that fixes a broken URL waits out the window before its next wake, 15 minutes by default. After that deploy, only a smoke check ran on staging: agents work over both connection methods, and `set_wake` and `delete_wake` work. Delivery wasn't repeated on this build, and the failing-URL case has automated tests only.

**Not proven:**

- A public name pointing at a private address (`127.0.0.1.nip.io`) was accepted at set time. Its send then failed and was counted, but the reason isn't confirmed, because the log capture crashed and no receiver sat at that address.
- A receiver returning errors, and a failing URL's retries running out, haven't been tested on staging.
- There's no repeatable check. Wake isn't in the journey, because a run needs a public receiver.

**The wake test, [#102](https://github.com/thachp/podster/pull/102):** `retries failures…` failed once on #98, because a hang's send is given up on at 300 ms and the test read the fake hook's log before the last attempt reached it. The test now waits up to 5 s for exactly 3 attempts. It's a test change only, with no product change, and nothing above moves.

## AC-19: the API's public reachability

`apps/api/wrangler.jsonc` sets `workers_dev: false` and `preview_urls: false` at the top level and again in `env.staging`, with no route or custom domain in either. `node probe-api.mjs --config-only` checks this on every CI run, through `run-local.mjs`.

On 2026-11-05 UTC, read-only probes of staging found no answer from the API:

| Probed | Result |
| --- | --- |
| `gateway-staging.podster.dev`: `/health`, `/v1/*`, `/internal/*`, `/test/consume-wake` | 404 from the gateway |
| The same paths under `/api` with no session | 401 `sign_in_required` |
| `api.podster.dev`, `api-staging.podster.dev`, `podster-api.podster.dev`, `podster-api-staging.podster.dev` | No connection |
| `podster-api-staging` and `podster-api` under a candidate `workers.dev` subdomain | 404 from Cloudflare |
| The API's and gateway's staging addresses under the confirmed subdomain, by another session: `/`, `/health`, `/v1/workspaces` | 404 |

What keeps this from passing:

- **The `workers.dev` evidence is limited.** Another session has since confirmed the account's subdomain from a deploy's output, and kept it out of this repo. There, the API's and gateway's staging addresses each answered 404 on `/`, `/health` and `/v1/workspaces`. That's not the API's answer, but a made-up subdomain also answers 404. Step 5 below ran with the confirmed subdomain and `--with-posts` on 2026-11-06 at `abe92ef`, and passed, and again on 2026-11-09 at `1d28ee2`.
- **An untrusted service calling the API can't be tried without deploying one.** The proof is local: assertions from any other key are refused, and [e2e/probe-selftest.mjs](../e2e/probe-selftest.mjs), which runs with `run-local.mjs`, shows the probe fails against a fake API that answers like the real one, and against a gateway nothing answers on.

Also, `apps/gateway/wrangler.jsonc` doesn't set `workers_dev` at its top level, only in `env.staging`. A production deploy from that config would get a `workers.dev` address for the gateway. That isn't the API, but it should be settled before production.

## Running it

Locally, with `worker-build` 0.8.7, `npm ci` in `apps/gateway` and `e2e`, and rustup's Rust first on your `PATH`, because a Homebrew `rustc` has no Wasm target:

```bash
cd e2e && node run-local.mjs
```

This builds the API's release build, starts it and the gateway under `wrangler dev` with throwaway keys and empty databases, then runs the journey and the probe. CI runs the same thing. A check marked `GAP` is something the product doesn't do yet. It doesn't fail the run unless you pass `--strict`.

`--rehearse-cookies` runs the path a deployed run uses, with cookies rather than sign-up, and `--rehearse-same-person` checks that it refuses one person's cookie used twice. `--rehearse-test-people` runs [the test-people path](#with-test-people) with staging's URLs, `APP_URL` and gates, on a local stack and throwaway secret. It reaches nothing remote, and CI runs it too. It's still not a deployed run: Cloudflare's real routing, limits and D1 aren't in it. So its file is `e2e/results/rehearsal-<host>-<time>.json`, with `"kind": "rehearsal"`, and never counts toward a status.

## Running it on staging

This needs two people with different GitHub accounts, about five minutes, and the steps below. Or the driver can make its own people, [with test people](#with-test-people), which proves less. Staging has no delete route. A run with pasted sign-ins makes its own organization for each person, because an organization holds at most 20 rooms, and leaves those behind too. Each run leaves about 5 rooms, 15 agents and their tasks behind, plus organizations called "Podster e2e outsiders" and "Podster e2e team" on the first person's account. It may pause for up to a minute if it reaches a rate limit.

The driver stays on the gateway's host with either kind of person, including its `POST`s to `/authorize` and `/claim`, which ADR 0001 keeps there. A session works on both hosts, and the origin it sends is the gateway's. Only sign-in itself moved to the application host.

1. **Check what's deployed.** The result only counts for the commit that's running. Deploys from different sessions overwrite each other, so check this right before the run. From `apps/api`, and then from `apps/gateway`:

   ```bash
   npx wrangler deployments list --env staging
   ```

2. **The owner signs in.** Open `https://gateway-staging.podster.dev/sign-in` and continue with GitHub. Once `APP_URL` is set, that link ends on the application host, so copy the cookie there. In the browser's developer tools, open Application, then Cookies, and copy the value of `__Secure-better-auth.session_token`. Then run this and paste `__Secure-better-auth.session_token=<value>` when it waits:

   ```bash
   read -rs PODSTER_E2E_COOKIE_A && export PODSTER_E2E_COOKIE_A
   ```

3. **The second person does the same, with their own GitHub account in their own browser.** They should send the owner their cookie privately, or type it in themselves at the owner's machine. The driver signs both sessions out when it ends and confirms they no longer work. If it warns that one may still be live, or the run was killed, run step 7. They shouldn't put it in chat or a file that lasts.

   ```bash
   read -rs PODSTER_E2E_COOKIE_B && export PODSTER_E2E_COOKIE_B
   ```

4. **Run the journey,** from the `e2e` folder. It stops before writing anything if both cookies are the same person's.

   ```bash
   npm ci && node journey.mjs --base-url https://gateway-staging.podster.dev
   ```

5. **Run the probe.** Find the account's subdomain in the Cloudflare dashboard, under Workers & Pages, where it's shown as `<subdomain>.workers.dev`. Replace `<subdomain>` below. Keep it out of the repo.

   ```bash
   node probe-api.mjs --gateway https://gateway-staging.podster.dev --workers-subdomain <subdomain> --with-posts
   ```

6. **Record the result.** The journey writes `e2e/results/gateway-staging.podster.dev-<time>.json`, which holds IDs and outcomes only. For each check that passed, change its status above to **Passed on a deployment**, with the date and commit. A "partial" item passes on a deployment only for the part that ran there, so say which.

7. **Only if a session may still be live,** end it, from the same shell:

   ```bash
   node journey.mjs --base-url https://gateway-staging.podster.dev --sign-out-only
   ```

### With test people

The owner has no second person yet, and accepted that a run this way leaves a second real sign-in untested. With `PODSTER_E2E_SIGNUP_SECRET` set, the driver signs up two new test people through [staging's test sign-up](staging.md#test-people-for-the-journey), and signs them out when it ends. It sends the secret only to `https://gateway-staging.podster.dev`, refuses any other target even with `--allow-host`, and refuses a run that also has cookies. It never prints the secret or a session, and it still refuses two sessions that are one person.

Steps 2 and 3 above are replaced by this. Paste the secret when it waits:

```bash
read -rs PODSTER_E2E_SIGNUP_SECRET && export PODSTER_E2E_SIGNUP_SECRET
```

Then do steps 1, 4, 5 and 6, and check the results file says `"kind": "deployment"`. If a run is killed outright, its sessions end by themselves within two hours, because a test session's expiry never moves, and step 7 isn't needed.

Finish by turning the route off, as soon as the run's result is recorded, from `apps/gateway`. Whether it passed or not, the route shouldn't wait on staging for the next run, which can set a new secret.

```bash
npx wrangler secret delete E2E_SIGNUP_SECRET --env staging
```

**A run this way used test people, so it doesn't prove:**

- A second real human, or their GitHub sign-in, working anything. Neither test person signed in through GitHub.
- A real sign-in on the application host: GitHub's callback, the cookie crossing the web Worker, and the other probes at the end of [ADR 0001](adr/0001-application-host-and-session-cookie.md#what-staging-needs).
- Gap 8 and decision 23 on a deployment. Those need an OAuth sign-up to create its personal organization, and test people sign up by email.

The results file says `"people": "test_signup"`. In step 6, write such a pass as **Passed on a deployment, with test people**, with the date and commit, and keep this list open. These people are in separate organizations and separate accounts, so what a run shows across organizations still holds.

## Decision audit

Each was checked against the code by a test that ran or by reading.

| Decision | Result | Evidence |
| --- | --- | --- |
| 4. Material edits need re-acceptance | Holds. Passed on a deployment, 2026-11-09 at `1d28ee2`. | journey `D4`; `decide` in `crates/core/src/lib.rs`, `Command::Update`; `transitions.rs` `material_edits_need_acceptance_again` |
| 6. Departure table | Holds. Passed on a deployment, 2026-11-09 at `1d28ee2`. | journey `AC-25`; `apply_departure` in `crates/core/src/lib.rs`; `remove_member` in `apps/api/src/workspace.rs`. The person-review part of eligibility is built in M1, locally only |
| 8. Ownership transfer and recovery | **Built.** `AC-33` passed on a deployment, 2026-11-09 at `1d28ee2`, for the part its row in [Acceptance tests](#acceptance-tests) names, on top of a [partial check by hand](#two-person-ownership-check-on-staging). The rest stays local only | journey `AC-33`; apps/api "transferring and recovering a room's ownership"; apps/web `transfer-ownership.test.tsx`, `ownerless-rooms.test.tsx`; `e2e/a11y.mjs` "transfer ownership", "recover a workroom" |
| 14. Guests creating tasks | Holds. Passed on a deployment, 2026-11-09 at `1d28ee2`. | journey `D14`; `handle_create_invitation` in `apps/api/src/workspace.rs`; `authorize_workroom` in `crates/policy/src/lib.rs` |
| 21. Person inboxes | **Built.** Reading them passed on a deployment, 2026-11-09 at `1d28ee2`. Acknowledging stays local only | The API stores and serves them, and people can read them through the gateway (journey `D21`). Acknowledging through the gateway has a gateway test only. Org admins have read-only oversight of an agent's inbox (journey `D21`, [decision 31](spec/PRODUCT.md#decisions-needed)). The Needs attention screen is `app/(shell)/attention/`, and apps/web's README lists what it can't yet show |
| 22. Who creates tasks from the dashboard | Holds for owners. Passed on a deployment, 2026-11-09 at `1d28ee2`. Admin and member people only in apps/api tests | journey `D22`; `authorize_workroom` in `crates/policy/src/lib.rs`. Gap 1 makes them reachable, and the journey doesn't yet run them |
| 23. Personal accounts | Holds. **Passed on a deployment, 2026-11-09 at `1d28ee2`.** `D23` read exactly one personal organization, with the person as its admin, for a second person whose first OAuth sign-up on staging was this run's, according to the owner. A failed write during an OAuth sign-up stays local only | journey `D23`; gateway "when the sign-up hook can't write the personal organization". Deployed sign-ups use OAuth because password sign-in only works on local hosts. No test makes the write fail during an OAuth sign-up. See gap 8 |
| 24. Taking over a task when its requester leaves | Holds for owner and admin. The Coordinator part is built in M1. Passed on a deployment, 2026-11-09 at `1d28ee2`. | journey `AC-25`, `M1-ROLES`; `authorize_requester_change` in `crates/policy/src/lib.rs`. See gap 9 |
| 32. A departed room owner who rejoins | Replaced by decision 35: rejoining gives nothing back | gateway "doesn't give a room's owner their room back when they rejoin, until recovery names them"; apps/api "takes a departed owner out of the room's work". Local only |
| 33. Who creates rooms | Holds | journey `AC-02+`; apps/api "only an admin of the organization creates a room in it"; gateway "lets only admins create rooms". `AC-02+` passed on a deployment, 2026-11-09 at `1d28ee2`. The gateway's own tests stay local only |
| 34. Org admins removing each other | Holds | gateway "lets any admin remove another". Local only |

## Backend gaps

In the order to do them, because earlier ones unblock later ones. Sizes: S is under a day, M is a few days, L is a week or more. These are estimates.

| # | Gap | Size | Where | Blocks |
| --- | --- | --- | --- | --- |
| 1 | **Built locally.** An org admin invites by a link, and a signed-in person accepts. Adding someone outside the organization to a room, or changing their role, is refused with `not_in_organization`. Leaving ends their credentials, room listings and room roles, and rejoining restores none of those, including a room they own. See [Leaving an organization](#leaving-an-organization). The screens are `settings/organization/` and `/join`. The organization's audit list has no screen. | Done, staging check open | `apps/gateway/src/organizations.ts`; `apps/api/src/workspace.rs` `org_departure`; `apps/web/app/(shell)/settings/organization/` | Nothing locally |
| 2 | **Built.** The owner can transfer a room to a human admin, and an organization admin can recover a room whose owner left, as [ADR 0005](adr/0005-ownership-transfer-and-recovery.md) describes. Org admins can list those rooms. A rejoining owner no longer gets the room back ([decision 35](spec/PRODUCT.md#decisions-needed)). Transfer is in a room's settings, and the list and recovery are in organization settings. `AC-33` passed on a deployment, 2026-11-09 at `1d28ee2`, for transfer and handing back, a departed owner refused even after rejoining, and recovery by an organization admin who's in the room. An admin outside the room with no admin left, an archived room and a retry stay local only. Removing someone doesn't name the rooms they own, because decision 40 only covers rooms whose owner has left. Personal organizations have no recovery ([ruling](#gate-rulings-2026-11-05-utc)), and the create form says so. | Deployment | `handle_transfer_owner`, `recover_owner` in `apps/api/src/workspace.rs`; `owner_authority_holds` in `crates/policy/src/lib.rs` | Decisions 8, 35 to 41 |
| 3 | **Built locally, with decisions open: each room keeps a protected record of denied changes.** It counts refusals by actor, kind and day, off the request path, within a row cap. Writes are capped and coalesced, but no sustained flood has been run, and the timing of a refusal for a real room against an unknown one hasn't been measured on a deployment. Refusals that end before a room is reached aren't in it. A restart loses up to a few seconds of counts. The retention and correlation-ID choices are the owner's. A screen isn't built. | S, for the staging measurement and the owner's check | `apps/api/src/workspace.rs` `hold_denial`, `flush_denials`; `crates/policy` `denied_change_name` | The owner's check |
| 4 | **Closed by [#26](https://github.com/thachp/podster/pull/26).** People can reach their inbox and, as org admins, an agent's. | Done | `apps/gateway/src/index.ts` | Decision 21, dashboard |
| 5 | **Closed locally: revoking a whole organization is built.** Its participants leave under the departure rules, and invitations from before then can't bring it back. A dashboard control isn't built. | Done. `C7` passed on a deployment, 2026-11-09 at `1d28ee2` | `apps/api/src/workspace.rs` `handle_revoke_organization` | Nothing locally |
| 6 | **Built: an invited organization's admins have read-only oversight of their own agents.** `OVERSIGHT` passed on a deployment, 2026-11-09 at `1d28ee2`, for an invited organization's admin reading only its own agent's tasks with no room role. Plain members stay local only. They can list the rooms those agents are in, and read what each agent sees of the tasks it's party to. That includes other organizations' submission notes, commit SHAs, artifact links and labels, the task's history with its reasons, the thread, and participants' IDs and organization IDs. It gives no room role, and they still can't read the room. It's for org admins of an invited organization, and the owner hasn't yet seen how much it shows. The screens don't use it yet. | S, for the owner's check and the screens | `apps/api/src/workspace.rs` `oversight_view`; `apps/api/src/lib.rs` `list_oversight_rooms` | Screens using it |
| 7 | **Closed locally for the rooms and invitations.** Rooms can be renamed and archived. A room's pending invitations, a link's preview and an agent's rooms can be read, and the room read has `owner_org`, `guest_can_create` and removed members. Still missing are in `apps/web/README.md`. The screens don't use these yet. | Done. `ROOM` passed on a deployment, 2026-11-09 at `1d28ee2`, for renaming, archiving, a room's pending invitations and a link's preview. An agent's rooms and the room read's other fields have no staging check | `apps/api/src/workspace.rs`, `queries`; `apps/api/src/principal.rs` | Screens using them |
| 8 | **A failed sign-up hook could leave a person with no organization.** Fixed in code: the person's next request restores it, and one index keeps it to one organization. Proven for email sign-up, locally only. **Passed on a deployment, 2026-11-09 at `1d28ee2`:** an OAuth sign-up made the second person's one personal organization on staging, which the owner confirmed was that person's first sign-in there. Migration `0003_one_personal_org.sql` is on staging, because D1 applies migrations in order and this run's organization departure needs the later `0005`. A hook that fails on staging hasn't been tried, and that recovery is proven locally. | Done | `apps/gateway/src/index.ts` `ensurePersonalOrg` | Decision 23 on a deployment |
| 9 | **Closed locally by M1: the Coordinator's takeover.** An agent with the Coordinator's scope can take over, for itself, a task flagged because its requester left. The takeover step in `M1-ROLES` passed on a deployment, 2026-11-09 at `1d28ee2`. | Done | `authorize_requester_change` in `crates/policy/src/lib.rs`; apps/api "lets the Coordinator take over a task whose requester left, for itself only" | Nothing in M0 |
| 10 | **The workspace limit is built locally. Rooms can't be deleted.** An organization has at most 20 rooms, counted in one place so concurrent creations can't pass it. Deleting a room isn't built, because it needs choices about retention, so AC-26's deleted case stays open. Email magic-link sign-in is built, locally only, and no real email has been sent ([ADR 0004](adr/0004-email-sign-in.md)). | S to M, for deletion once decided | `apps/api/src/principal.rs` `/internal/org-room-reserve` | AC-26's deleted case |

## Leaving an organization

Removing someone from an organization now reaches their rooms, as [ADR 0003](adr/0003-organization-departure.md) describes, locally only: their role ends with the departure rules, and their room invitations are withdrawn. What's still open:

- **A departed room owner stays on record as owner until recovery runs.** While they're out they aren't a participant, so their tasks follow the departure table and their inbox stops. Rejoining gives them nothing ([decision 35](spec/PRODUCT.md#decisions-needed)). The room's log records the departure, and the recovery.
- **A room with a departed owner and no admin** can't manage its access or take over tasks until an organization admin runs recovery, and a task needing attention tells nobody meanwhile. A room can't be recovered until a departure reaches it, and departures keep looking for a person's rooms for about 30 days. **If no departure has reached a room,** nobody can recover it yet. If its owner is in the organization, an organization admin can remove them again. That writes a new departure, which reaches the room if it has an index row, and recovery can then name anyone in the organization, including that person once they've rejoined. This also works for an old room made within clock skew of its owner's membership, whose `owner_since` comes from when it was made, on a different clock, so an owner who never left can be refused. New rooms take it from the assertion and can't hit this. An organization's last admin can't be removed, so another admin has to exist first. **What's truly stuck:** A room whose owner is out of the organization and doesn't rejoin, where the departure was lost. That takes index writes failing for more than 30 days, or an owner removed before departures existed, which only staging's test data can have. Any room with no index row, because a departure finds rooms from the index. An old room in a personal organization, made within clock skew, because removal is refused there. Only staging has rooms that old. Nobody can recover these rooms, they still count toward the 20, and the only way out is a change by hand. **Until a departure arrives,** the room still treats its owner as a participant, and pending invitations they made still work. An owner who has rejoined gets not-found from the room but still sees it on their list, including later renames. That's brief when a departure is on its way, and lasts indefinitely in the stuck cases.
- **If the API can't be reached,** delivery waits for the cron, which takes 50 rows an hour, oldest first. So a backlog can take several hours, and rows that keep failing can hold up the rest. Authority doesn't wait for this.
- **Very large room counts** are slow, and weren't tested beyond 130 rooms. ADR 0003 has the limits.
- **A room the index never lists** keeps the person in its member list, and their invitations there stay usable until they expire, up to 7 days. `org_since` refuses their role but doesn't cover invitations.

## Known follow-ups

- **Agent role labels from the listing index.** `membership_index` holds a kernel role and no scopes, so a list built from it can't say what an agent can really do. The agent Sheet says "Listed role" and links to the room's Team screen, where the room's owner and admins see real access. Showing scopes there needs a read-model change, which the lead session deferred on 2026-11-05. A person's role on the workrooms list is accurate, because a person's access follows their role.

## Gate rulings, 2026-11-05 UTC

The session that wrote this doc recommended these, and the owner answered "up to ur recommendation" in that session on 2026-11-05 UTC. The first four were put to the owner as questions. The Coordinator one was named only as a point the owner could agree to, so it's the least directly confirmed. Several lower what the gate requires, and decision 24 says "By M0" in PRODUCT.md, so the Coordinator row changes that decision's M0 scope, as PRODUCT.md's note on decision 24 now says too. The others still need adding to [PRODUCT.md](spec/PRODUCT.md#decisions-needed), and the owner can overrule any of them.

| Question | Ruling | Effect |
| --- | --- | --- |
| Can tests that need failpoints close on local proof? | Yes, as long as they pass in CI. This covers AC-16 and the failure half of the event property, plus the parts of AC-14 and AC-29 that can't be timed from outside | Everything else in those items still has to pass on a deployment |
| Do AC-30's person-review cases wait for M1? | Yes, with decision 5, because M0's gate covers only the features M0 includes | AC-30's swap case still has to pass on a deployment for M0 |
| How does recovery work for a personal organization? | It doesn't, in M0. The owner is its only person, and nobody at Podster overrides that. Someone who wants a successor creates the room in a team organization. The product says so when a room is created in a personal organization | Gap 2's recovery applies to team organizations only, and transfer needs an admin, so it does too |
| What does an invited organization's person see in M0? | Read-only oversight of their own agents: the rooms those agents are in, and the tasks and inboxes of those agents. It gives no room role, and nothing else in the room. This is decision 7's recommendation, brought forward | Gap 6 is that scope. It needs a new read path and doesn't add them as members |
| Does the Coordinator half of decision 24 wait for M1? | Yes, with the presets in decision 20 | Gap 9 leaves M0 |

These are rulings on what the gate requires, so no status above changes until the tests run.
