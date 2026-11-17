# M6 step 6: the remaining unpublish triggers and the reconcile's cron

**Status, 2026-11-13: Proposed, by the architect's session. The five questions below were answered by the architect on 2026-11-13; each answer was decided by the architect, confirmed by the owner on 2026-11-14 ([the owner's words](m6-plan.md#confirmed-by-the-owner-2026-11-14)), and is recorded under its question. Where a ruling changed the proposal, the sections below follow the ruling.** Built on `main` at `6a7789d`, after decision 218's release switch (#344, #350, #353, #356).

**What this covers:** the [`RELEASE_PATH_COMPLETE`](m6-plan.md#the-gate-on-the-release-path) items that step 6 owns:
- every unpublish trigger in [ADR 0010's list](adr/0010-release-and-the-content-domain.md#unpublishing) that isn't built yet;
- the reconcile's cron entry.

**What it leaves out:**
- **`deploy_release`, approval by a person, and rollback** are the rest of build-order step 6. They drive the release job, whose tree read and upload are held until [ADR 0010's proposed revision](adr/0010-revision-apps-are-workers.md) is accepted, so they follow it.
- **The revision's stage-1 items**: an app's store, its deletion at an unpublish or a room's deletion, and the reconcile of stores. They depend on the owner's eleven stage-1 decisions.

Nothing below depends on those decisions.

## Questions for the architect, and the rulings

1. **Which repository states unpublish?** ADR 0010 says "its link is no longer ready". Today only `degraded` is ever written: the daily read-back finds a protection or setting differs. `degraded` goes back to `ready` when an operator's recheck finds it fixed. `suspended` exists in core with no writer. *Corrected on 2026-11-13: a repository "found gone" is detected, by the daily read-back and an operator's recheck, which degrade the link as `repository_gone` after two looks a minute apart; this first said nothing detected it.*
   - **Proposed:** unpublish on `degraded` and `suspended`, as written. An unpublish retires the label, so a transient settings change costs the room its address.
   - **Decided by the architect on 2026-11-13, confirmed by the owner on 2026-11-14 ([the owner's words](m6-plan.md#confirmed-by-the-owner-2026-11-14)): as ADR 0010 is written, unpublish on `degraded` and `suspended`.** Narrowing a trigger that an accepted ADR states isn't the architect's to do. The alternative was put to the owner, in [the owner's table](m6-plan.md#for-the-owner), with its cost: a transient settings change costs the room its address for good. **Answered by the owner on 2026-11-14: unpublish, as ADR 0010 says, behind the outage guard.** **The choice is one predicate in core, tested both ways,** so the owner's answer is a one-line change.
   - **Decided by the architect on 2026-11-14, confirmed by the owner on 2026-11-14 ([the owner's words](m6-plan.md#confirmed-by-the-owner-2026-11-14)): a guard against an outage reading as every repository gone, both of the owner's table's (a) and (b).** It adds caution and loosens nothing. A GitHub incident, or the provisioning App's installation suspended or removed, could make every repository answer 404, degrade every link as `repository_gone` and retire every app's address for good.
     - **The installation check.** A repository read as gone counts toward the two looks a minute apart only while the App's own installation reads healthy: GitHub's "Get an installation" answers `200`, names this installation, and its `suspended_at` is null (`core::installation_read`, `core::gone_may_count`). Suspended, removed or unreadable, the read is undecided, as one that couldn't be made: no sighting is kept, nothing is degraded or unpublished, the room logs its ID and a code, and operators are told by one finding for the deployment, `installation_unconfirmed`. The room reads again on its next due read.
     - **The ceiling on unpublishes, *Proposed*.** At most `REPO_UNPUBLISH_CEILING` (5) rooms' apps come down as `repo_not_ready` in `REPO_UNPUBLISH_WINDOW_MS` (an hour), or `REPO_UNPUBLISH_CEILING_PERCENT` (10%) of the rooms with apps, rounded up, whichever is smaller, and never fewer than one. **Each room decides this on its own link, with no shared pass,** so the ceiling lives in the `Moderation` object, which every room can ask: a room asks it before it unpublishes for this cause, and it decides in one transaction of its own, so two rooms can't both take the last place. Past the ceiling the room is held, and so is every later one: degraded, its tokens revoked, its app still up. Operators are told by a finding for each held room, `repo_unpublish_held`, by the room's ID, so they know what to recheck. An operator's repository recheck of a held room confirms it and it comes down; a room whose cause cleared, its link ready again or its app down another way, leaves the hold. Once none is held the trip clears. Nothing that came down comes back.
     - **Nothing of it is kept in memory** (from the first review of the guard's PR). Whether an unpublish is owed is worked out from the room's rows on every alarm: a link off ready with something up. When an ask doesn't end it (held, undecided, no answer, or a granted unpublish that failed), the time the room asks again is kept in the object's durable storage, which needs no schema step, and the room's alarm stays armed while anything is owed or that time is kept. An ask with no answer, an undecided one and a failed unpublish are each told to operators by the room's ID, `repo_unpublish_stalled`, and taken away at the ceiling's next answer to that room.
   - **Decided by the architect on 2026-11-14, from the first review of the guard's PR, confirmed by the owner on 2026-11-14 ([the owner's words](m6-plan.md#confirmed-by-the-owner-2026-11-14)):**
     1. **The count is a true rolling hour.** Clearing a trip, by an operator's confirmation or a healed room saying it no longer waits, never forgets the hour's grants: it only lets held rooms proceed within what the hour still has.
     2. **A place granted and then not used, because the link healed before the unpublish, stays counted for the hour.** That fails safe.
     3. **A replayed operator recheck still confirms.** Answered from its stored idempotency record, it asks the ceiling again from the room's current rows, so a first confirmation whose ask failed isn't lost.
     4. **The unpublish checks the link again after the ceiling's grant,** in its own transaction: a link that healed in between means no unpublish. A test holds the room at a gate between the two.
     5. **The runbook says it:** an operator's recheck of a held room unpublishes at once if the link is still not ready ([`docs/staging.md`](staging.md#operators)).
     - **What changed to make room for it:** degrading no longer unpublishes in its own transaction. The link is degraded and tokens marked there, as before; the unpublish follows in the same alarm pass or request, in a transaction of its own after the ceiling's answer, which checks again that the link is still off ready and something is still up. Like the deployment's switch, it fires only when something is up, so a room with nothing up records no unpublish. Every other trigger is unchanged and still acts at once.
2. **The deployment's own switch.** Turning `RELEASES` off is a deploy. Today the scheduled handler returns at once while `RELEASES` is off, so after the switch nothing would wake a room to take its app down, and rooms' release commands are refused at the Worker before they reach the room.
   - **Proposed:** the handler runs whenever a content provider is configured, whatever `RELEASES` says. A woken room reads the switch and unpublishes.
   - **This makes the deployment switch permanent for every app that was up:** labels are retired, and turning `RELEASES` back on restores nothing, as ADR 0010 says. The stop for the whole content domain stays the reversible control.
   - **Decided by the architect on 2026-11-13, confirmed by the owner on 2026-11-14 ([the owner's words](m6-plan.md#confirmed-by-the-owner-2026-11-14)): confirmed, both.** The handler runs whenever a content provider is configured, whatever `RELEASES` says, and turning the deployment's switch off is permanent for every app that was up. Where an operator reads it before flipping: [`docs/staging.md`, "Switching release off for the deployment"](staging.md#switching-release-off-for-the-deployment).
   - **Decided by the architect on 2026-11-13, from the first review of step 6's second PR, confirmed by the owner on 2026-11-14 ([the owner's words](m6-plan.md#confirmed-by-the-owner-2026-11-14)): the deployment's setting has three readings,** so a configuration slip can't take every app down for good. Exactly `true` is on. Exactly `false` is off, and only that unpublishes. Anything else, unset, empty or malformed, is undecided: new releases and commits are refused as when off, nothing is unpublished, and each reconcile pass logs one code and tells operators once, `release_setting_undecided`. One pure function in core, `deployment_release`, decides it for every reader. A typo, an environment that omits it, a rollback to a version from before it was set, and a dashboard value removed by the next deploy each take nothing down.
3. **"Nobody who may release now remains"** is marked *Assumed, for the owner* in ADR 0010.
   - **Proposed:** leave it unbuilt in step 6 and owed to the owner, since it is the owner's assumption.
   - If you rule it in, the proposed test is "no person who is the room's owner or one of its admins (decision 215) is in the room and still in their organization". The room evaluates it on its own rows at:
     - a removal or role change;
     - a grant's revocation;
     - a departure, which already reaches every room through the organization's sweep (`/internal/org-departure`).
   - That needs no new notice machinery.
   - **Decided by the architect on 2026-11-13, confirmed by the owner on 2026-11-14 ([the owner's words](m6-plan.md#confirmed-by-the-owner-2026-11-14)): ruled in, as the interim rule until the owner answers.** The owner's table says the app comes down when no person who may release remains, and that this "is also what holds until the owner answers"; leaving it unbuilt would leave apps up with nobody answerable. The test is the one above, evaluated on the room's own rows at the three points above.
   - **Decided by the architect on 2026-11-13, on the first review of 6d, confirmed by the owner on 2026-11-14 ([the owner's words](m6-plan.md#confirmed-by-the-owner-2026-11-14)): held first, unpublished only once a window passes.** In a room with no admin, the owner's departure retired the app before an organization's admin could name a new owner through recovery, so routine offboarding became irreversible. Now nobody left stops the app being served at once, so answerability holds, but reversibly: the app is held, a reversible stop like an operator's suspension of an app, with its own cause, and nothing is retired. Recovery naming a new owner, or an admin added, within the window lifts it. The app was only held, so it is served again as it was, and a new release still goes through the whole recheck. If the window passes with nobody, the room's alarm unpublishes the app for good as `no_releaser`, by the clock it runs at. **The window is *Proposed* at 7 days,** one constant, on the owner's table as theirs to change. The owner's confirmation covers the hold and its window, and the figure stays *Proposed*.
4. **Room deleted and organization deleted have no source.** Nothing deletes either.
   - **Proposed:** the flip list's "every unpublish trigger" means every trigger whose fact has a source.
   - Whatever first deletes a room or an organization owes its trigger. The flip list says so by name.
   - **Decided by the architect on 2026-11-13, confirmed by the owner on 2026-11-14 ([the owner's words](m6-plan.md#confirmed-by-the-owner-2026-11-14)): agreed.** [The flip list](m6-plan.md#the-gate-on-the-release-path) names both as owed.
5. **The cron entry is a change to `apps/api/wrangler.jsonc`.** It is deployed to staging by `scripts/deploy-staging`, so it is a change to a deployed Worker's configuration, though not a new resource.
   - **Proposed:** add both schedules in the PR that changes the handler's gate (question 2). With no provider configured, which is staging today, every pass reads nothing and says so.
   - The cost is 13 invocations an hour into the `Moderation` object.
   - **Decided by the architect on 2026-11-13, confirmed by the owner on 2026-11-14 ([the owner's words](m6-plan.md#confirmed-by-the-owner-2026-11-14)): ruled in, and the architect tells the owner.** It is a schedule on an existing Worker deployed by the approved script, not a new or billed resource. **One condition:** with no provider configured, the handler returns before it touches any Durable Object, so no call reaches `Moderation` and staging today costs only the cron's own invocation. A test shows it. Both schedules go in the PR that changes the handler's gate.

## The triggers, one by one

**Built:**
- the app suspended by an operator (step 4(a));
- release taken from the organization (decision 218).

**State:** "room" means room state in the room's own Durable Object, written in a room transaction.

| Trigger (core's `UnpublishTrigger`) | Authority | Where its state lives | How the room learns of it | Proposed |
| --- | --- | --- | --- | --- |
| `RoomArchived`, `workspace_archived` | Owner or admin, `ManageRoom` | Room: `workspace.status` | Its own command, `handle_set_room_status` | Fire in the same transaction when it archives. Unarchiving restores nothing |
| `RoomMadePrivate`, `release_needs_public_room` | Owner or a human admin (decision 149) | Room: `workspace.visibility` | Its own command, the make-private branch in `visibility.rs` | Fire in the same transaction |
| `PublicSurfaceSuspended`, `public_surface_suspended` | A Podster operator (M4) | Room: `workspace.suspended_at` | Its own command, `moderation.rs`, reached through the operator's suspension | Fire in the same transaction. Lifting restores nothing |
| `RepositoryNotReady`, `repo_not_ready` | The daily read-back (`degraded`); an operator (`suspended`, no writer yet) | Room: `repo_link.status` | The room's own write in `merges.rs` | On `degraded` and `suspended` (ruling 1), decided by one predicate in core. *Since 2026-11-14:* in a transaction of its own after the one that moves the link off `ready`, once the deployment's ceiling grants it, and only with something up (ruling 1's guard) |
| `ReleaseOffInRoom`, `release_off` | Owner or admin, as a person (decision 215) | Room: `release_config.enabled` | `setReleaseConfig`, built in 6c | Switching off fires in its transaction. *Built in 6c* |
| `ReleaseOffForDeployment`, `release_off_for_deployment` | The owner, by deploy | The `RELEASES` Worker variable | **From outside:** the room reads `releases::switched_on` at the walk's question and at release commands | Fire on the room's own read, only when the room has something to take down (below) |
| `NoReleaserLeft`, `no_releaser` | None; it is a consequence | Room rows, plus each person's organization | Room commands and the departure sweep | The interim rule (ruling 3): fire when no person who is the room's owner or an admin is in the room and still in their organization. *Built in 6d: it fires only when a command leaves nobody, and only a departure can today* |
| `RoomDeleted`, `OrganizationDeleted` | Nothing deletes either | No source | None | Owed by whatever first deletes either (ruling 4) |

**`release_off`, as built in 6c: switching off needs the caller's own `Principal` to answer.** Before switching release off, the room asks the caller's own `Principal` whether they are still in the organization their place here is held in. If it gives no answer, the switch is refused with `standing_unknown` (503), and nothing comes down: a room's owner can't take their app down this way while that object is unreachable, which is the object that knows whether they have left their organization. Archiving the room or making it private still works then, and each unpublishes, and so does an operator's release switch for the organization.

**The `unpublish` table's CHECK already admits every cause above** (room schema step 37). None of this needs a room schema step.

## What is shared with the switch's machinery

There is one way to unpublish, and one way to wake.

- **One function fires a trigger,** `takedown::unpublish_for(sql, trigger, now)` (Proposed name). It wraps `unpublish_app` with the audit (`app.unpublished` as Podster with `cause`) and the event to the room's managers, which `release_switch::apply` writes today. It is moved there, not copied: the switch and every trigger above call it.
- **After a transaction that fired, the room runs `release_commit::bookkeeping` and arms,** as `apply_switch` does now. Every trigger here is fired by a request that isn't a read, so the room's `fetch` arms afterwards in any case. That is what restores a lost wake for the switch (#356).
- **Outside facts are read where the switch is read, and only there:**
  - every reconcile question, `takedown_check`, which is the walk's wake;
  - every release command, `release_reads`.

  `read_and_apply_switch` becomes the room's one "read what's outside and apply it" step, with the deployment's switch beside the organization's. No new notice loop is built: the organization's notices exist because an organization has a list of rooms, and the deployment has only the walk.
- **Firing once.**
  - A room-local trigger fires on its own state change. The command refuses a no-op, or does nothing when nothing changes.
  - The switch keeps its generation in `release_switch_applied`.
  - **Proposed for the deployment's switch:** fire only when the room has something to take down: a host whose desired script is set, a kept script, a release in flight, or a release that hasn't ended. This needs no stored marker. While `RELEASES` is off, no release can start, and when it is on again, nothing comes back.
- **Each trigger is shown by the tests the switch has.** Each test shows:
  - what comes down;
  - the audit and the event;
  - the queued release ended `release_epoch_moved`;
  - that the same fact again changes nothing;
  - for the outside fact, the walk's wake and a release command.

## The reconcile's walk, as built

- **Two passes,** run in the `Moderation` object by the Worker's scheduled handler: entries every 5 minutes (`*/5 * * * *`), scripts every hour (`0 * * * *`).
- **Each pass:**
  - reads one page of the provider's keys, or `SCRIPT_BATCH` (100) scripts;
  - wakes `WAKE_BATCH` (50) rooms of the app-label lookup table from where the last pass stopped, through `/internal/takedown-check`, within `WAKE_BUDGET_MS` (10 s);
  - starts nothing new after `PASS_BUDGET_MS` (20 s).
- **Cursors are kept in `reconcile_pass`.** The walk covers only rooms with a label, which are the only ones with anything to take down.
- **With L labels,** a room is woken within about ⌈L/50⌉ passes, out of 13 an hour.
- **What changes in step 6 (Proposed):**
  - the handler's gate becomes "a provider is configured" (ruling 2), and with none it returns before calling any Durable Object (ruling 5);
  - both schedules go into `apps/api/wrangler.jsonc` (ruling 5);
  - the walk's question already applies the switch, and gains the deployment's switch.

## PR order

**Proposed.** Each PR is one PR, in this order:

1. **6a, room-local triggers.** No schema step, no contract change.
   - `takedown::unpublish_for`, moved out of the switch.
   - Archive, make private, the public surface's suspension, and the repository's link per question 1, each firing in its own transaction.
   - Tests as above.
2. **6b, the deployment's switch and the cron.** No schema step, no contract change.
   - The room's outside read gains `RELEASES`.
   - The handler's gate.
   - Both cron entries (ruling 5), and a test that with no provider the handler calls no Durable Object.
   - Tests that the walk takes a room down after `RELEASES` goes off, and does nothing for a room with nothing up.
3. **6c, the contract.** Alone in its turn.
   - `setReleaseConfig` built, switching off fires `release_off`.
   - The summaries of archive, make private, the operator's room suspension and `setReleaseDelegation` say what each now unpublishes. `setReleaseDelegation` also loses "again until the room acknowledges" and names `release_switch_notice_misdirected`, which #356 left owed.
   - It waits for the open contract PR, if any, to merge.
4. **6d:** `NoReleaserLeft`, the interim rule (ruling 3). No schema step.

**After 6d:**
- `RoomDeleted` and `OrganizationDeleted` go with whatever first deletes either (ruling 4).
- `deploy_release`, approval and rollback go with the release job.

The flip list in `m6-plan.md` is updated in each PR for what it closes.

## The rest of step 6: requests, approval and rollback

**Proposed, 2026-11-16, by the architect's session.** Built on `main` at `0dbd963e`, after 6a–6d, the contract PR, the release job (step 5), release status (#407), the approvals list (#408) and the Release panel (#409). Every PR here is behind `RELEASES`, with `RELEASE_PATH_COMPLETE` false throughout: none flips it, and while it is false a deployment with release on and a provider configured refuses every one of these commands as a route that isn't built.

**What is left.** ADR 0010's "a `deploy_release` command, then a person's approval", and rollback. Today nothing writes a release row but the tests, so the job (step 5), the status (step 7) and the screens (step 10) have nothing to act on outside a test. `approveRelease` and `declineRelease` answer `release_not_available`, and the web panel's buttons call them.

**The order.** Each is one PR, in this order. Each that changes `packages/contracts` takes its own contract turn.

| PR | What | Contract | Room schema step |
| --- | --- | --- | --- |
| **6e** | **A person asks for a release** of a task's merged commit: `requestRelease`, `POST /v1/workspaces/{ws}/releases`, person-only. It records one release `awaiting_approval`, with a label made if the room has none current, and starts nothing. *Built in this PR: [below](#what-6e-built).* | Yes: the route, its body, five error codes | No |
| **6f** | **A person approves or declines** (`approveRelease`, `declineRelease`, already in the contract as not built). Approval: `authorize_approval`, then core's whole recheck on fresh outside reads (the stop, the deployment, the organization's switch and delegation, the approver's, the requester's and the giver's own records), then `Approve`, so the release is `queued` and the driver takes it. Decline: `authorize_decline`, then `Decline`, `declined`, nothing uploaded. **Also the app's address,** which nothing makes yet: the label's row in D1's lookup table (`app_label.indexed_at`, with an upkeep that retries), and the default host's serve row, both before a release can be queued. | Yes: both summaries say built | Probably none: `app_label.indexed_at` and `serve_state` exist |
| **6g** | **An agent asks: the `deploy_release` capability.** The release keeps the person who controls the agent (`requester_person`), so the recheck can ask whether that person still holds and whether the agent is still connected; today it fails an agent's release as `requester_lost_authority`. The gateway's MCP tool and A2A skill. | Yes: the capability, and `check.mjs`'s rule that no capability reaches a release is narrowed to this one | Yes: `release.requester_person` |
| **6h** | **Rollback.** A person asks to roll back to an earlier release of the room. Its own record, approved as any release is. If it is the kept release and Cloudflare's own read says its script still exists, approval leads to core's `rollback` switch, with no upload; otherwise it is a new release of that commit, uploaded again. | Yes: the route | Likely: the record of which release it rolls back to |

**Open questions, each with the recommended answer, all Proposed.**

1. **When is an app's label made?** *Recommended, and built in 6e:* at the request, in its transaction, when the room has no current label: the first request ever, or the first since an unpublish retired the last. A release row needs one (`release.label` is `NOT NULL`). A label made for a request nobody approves is never served, and its address is shown only to the room's owner and admins in the release configuration. **Its row in D1's lookup table and the default host's serve row are owed to 6f,** before anything can be queued: nothing is up under a label that isn't indexed, so no takedown can need it before then.
2. **May an agent ask in 6e?** *Recommended, and built:* no. The rows keep who asked and not who controls them, so the job's recheck can't tell whether an agent's controlling person still holds, and fails the release at its first pass. Asking stays person-only, at the Worker and in the room (`authorize_release_request`), until 6g records that person. AC-17 holds meanwhile: no agent sees a deploy tool.
3. **The same commit asked for twice.** *Recommended, and built:* refused `release_pending` (409) while a release of that commit is awaiting approval, queued, uploading or uncertain. Once it ends it may be asked for again. A commit that is live or served may be asked for again too; that is a re-upload, which nothing needs to forbid.
4. **Does a request read the content domain's stop?** *Recommended, and built:* no. A request publishes nothing, and approval and every pass of the job read the stop. A stopped domain still lets a person ask; nothing they ask for can go further while it is stopped.
5. **The daily cap.** *Recommended, and built:* core's existing rule, 20 asks a rolling day in the room, declined and failed ones included, counted from the room's own release rows, refused `release_limit` (429). The edge is pinned to the millisecond in core.
6. **Who is told of a request.** *Recommended, and built:* the room's owner and its admins who are people, who are those who may approve (an agent holding the admin role isn't told), by the event `release.requested` about the release's ID; the requester by the answer. The task's other parties aren't told.
7. **Does the owner or an admin need a grant to ask?** *Recommended, and built:* yes, as anyone does. ADR 0010 says who asks is whoever holds a live `deploy` grant; approving needs no grant. Self-approval stays allowed (decided on the review of PR #309, for the owner to review).
8. **Approving a release whose request is now stale** (6f). *Recommended:* approval runs core's whole recheck on fresh reads first. A fact that was read and fails ends the release `failed` with its code, as the job would, and answers it; an unread fact is `standing_unknown` and writes nothing. Nothing doomed is queued.
9. **Rollback's route** (6h). *Recommended:* its own, `POST /v1/workspaces/{ws}/releases/{release}/rollback`, person-only, since its checks differ (the kept script's read), and its record names the release it rolls back to.
10. **When `deploy_release` is listed to agents** (6g). *Recommended:* only while the API answers the release routes, that is with `RELEASES` exactly `true`, read by the gateway from the API rather than from a variable of its own, so the two can't disagree. Until `RELEASE_PATH_COMPLETE` flips, a deployment that lists it answers `release_not_available`.

**Required of the later PRs, from the deep security review of 6e (PR #410), 2026-11-16.** These are conditions on those PRs, not open questions.

- **6f, approval:**
  - it passes `release_path_open`;
  - it reads every outside fact again: the stop, the deployment, the organization's switch and delegation, and the approver's, requester's and giver's records;
  - it asserts the release's `release_epoch` and `config_version` are still the room's current ones.
  - **It writes the D1 index row and the default host's serve row so that a failed or refused approval leaves them harmless:** an index row only routes a question, and a serve row with no script serves nothing.
  - **Its indexing upkeep covers labels made before 6f.** 6e makes a label wherever `RELEASES` is on with no provider, which is test builds today, so a label may exist with `indexed_at` null.
- **6g, an agent's request:** on every pass of the job, the agent's current linker and linker generation must equal the recorded `requester_person`. Anything else fails the release.
- **6h, rollback:**
  - the rollback's requester needs their own live `deploy` grant;
  - the switch with no upload requires the room's current label, its current epoch, no suspension and no open takedown finding, core's `releasable_commit` and the reviewer rule, and a fresh read from Cloudflare at the switch;
  - a re-upload counts toward the room's daily cap and the read budget.
- **Events for a person to decide on go to people only.** 6e's `release.requested` uses `roles::room_approvers`, which leaves out an agent holding the admin role. `release.config_set` (step 6's contract PR) still uses the unfiltered `roles::room_managers`, and **should move to `room_approvers` in its own PR, with a test.**

**For the owner, with no recommendation from the architect's session:**

- **A one-person release.** Once 6g lets an agent ask, may the person who controls that agent approve its request? A person may already approve a release they asked for themselves (decided on the review of PR #309, for the owner to review). This would let one person both ask, through their agent, and approve: the release counterpart of AC-17's `self_review` for merges. **The owner's to decide.**

**Recorded, not decided here:**

- **`organization_exists` is hard-coded `true`,** inherited from `release_recheck::room_facts`. Nothing deletes an organization. Whatever first does owes that fact a source (ruling 4 above), and 6e's request reads it as the job does.
- **A reverted commit stays releasable.** `releasable_commit` asks only whether Podster's merge put the commit on the default branch and confirmed it there. A later revert on that branch doesn't change that. Whether it should is **undecided**.

### What 6e built

**A person's request for a release,** built on 2026-11-16 as 6e above, behind `RELEASES`, with `RELEASE_PATH_COMPLETE` still false. One contract change, no room schema step and no D1 migration.

- **The route:** `requestRelease`, `POST /v1/workspaces/{ws}/releases`, `{ task_id, commit_sha }` and optionally `environment: "production"`, and nothing else. Person-only in `capabilities.yaml`; no capability reaches it. It answers the contract's `Release`.
- **Who:** `podster_policy::release::authorize_release_request`: `may_ask_for_release` (in the room, a person) on the room's rows before anything is read outside it, then `authorize_deploy_release` (where release may happen at all, a public room first, then the live `deploy` grant from someone who still holds authority, not through a public claim), then the requester's own `Principal` saying they are still in their organization. A task the caller can't see is `task_not_found`.
- **What:** `podster_core::release_request::request_release`, in the order its module gives.
- **Fail closed:** the deployment's setting, the organization's switch and delegation, the requester's and the giver's records are read before the transaction; a fact read and failing refuses, one that couldn't be read with nothing failing is `standing_unknown` and writes nothing. *From the reviews of #410:* who is asking and where (`release_request::standing`) is decided wholly before the task named is looked at and before an unread fact decides, so a member with no grant naming a missing task gets `grant_required`, and a private room whose organization can't be read gets `release_needs_public_room`. The same `standing` is the replay check, so a retry under the same key after the grant was revoked, or the room made private, is refused by the code that holds now and writes nothing.
- **The gate:** the request passes `release_path_open` before it reads anything outside the room, so with release on and a provider configured it is `release_not_available` and writes nothing. A test shows it, and that the constant is still false.
- **Nothing starts:** the release is `awaiting_approval`, which the driver never takes (`job_owns`). A test runs the room's job twice with release on and finds it untouched, and `approveRelease` still answers `release_not_available`.
- **Written in one transaction with the idempotency record:** the release; a new label if none is current; the audit `release.requested`; the event `release.requested` to the owner and the admins who are people (`roles::room_approvers`). Logs: none beyond the gate's own line by its code.
- **Tests:** `crates/core/tests/release_request.rs`, the policy's in `crates/policy/tests/release.rs`, and `apps/api/test/release-request.spec.ts`.

## Not settled here

- **How long a room keeps serving after `RELEASES` goes off.** Up to one lap of the walk. That is ⌈L/50⌉ × 5 minutes at worst, sooner for rooms the entries pass asks about directly.
- **Whether an unpublish by any trigger should also tell operators.** Today only the switch and an operator's own acts are on their record. **Proposed:** no; the room's audit and event are the record.
