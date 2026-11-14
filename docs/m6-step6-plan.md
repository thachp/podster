# M6 step 6: the remaining unpublish triggers and the reconcile's cron

**Status, 2026-11-13: Proposed, by the architect's session. The five questions below were answered by the architect on 2026-11-13; each answer is decided by the architect, for the owner to review, and recorded under its question. Where a ruling changed the proposal, the sections below follow the ruling.** Built on `main` at `6a7789d`, after decision 218's release switch (#344, #350, #353, #356).

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
   - **Decided by the architect on 2026-11-13, for the owner to review: as ADR 0010 is written, unpublish on `degraded` and `suspended`.** Narrowing a trigger that an accepted ADR states isn't the architect's to do. The alternative is a question for the owner, in [the owner's table](m6-plan.md#for-the-owner), with its cost: a transient settings change costs the room its address for good. **The choice is one predicate in core, tested both ways,** so the owner's answer is a one-line change.
2. **The deployment's own switch.** Turning `RELEASES` off is a deploy. Today the scheduled handler returns at once while `RELEASES` is off, so after the switch nothing would wake a room to take its app down, and rooms' release commands are refused at the Worker before they reach the room.
   - **Proposed:** the handler runs whenever a content provider is configured, whatever `RELEASES` says. A woken room reads the switch and unpublishes.
   - **This makes the deployment switch permanent for every app that was up:** labels are retired, and turning `RELEASES` back on restores nothing, as ADR 0010 says. The stop for the whole content domain stays the reversible control.
   - **Decided by the architect on 2026-11-13, for the owner to review: confirmed, both.** The handler runs whenever a content provider is configured, whatever `RELEASES` says, and turning the deployment's switch off is permanent for every app that was up. Where an operator reads it before flipping: [`docs/staging.md`, "Switching release off for the deployment"](staging.md#switching-release-off-for-the-deployment).
   - **Decided by the architect on 2026-11-13, for the owner to review, from the first review of step 6's second PR: the deployment's setting has three readings,** so a configuration slip can't take every app down for good. Exactly `true` is on. Exactly `false` is off, and only that unpublishes. Anything else, unset, empty or malformed, is undecided: new releases and commits are refused as when off, nothing is unpublished, and each reconcile pass logs one code and tells operators once, `release_setting_undecided`. One pure function in core, `deployment_release`, decides it for every reader. A typo, an environment that omits it, a rollback to a version from before it was set, and a dashboard value removed by the next deploy each take nothing down.
3. **"Nobody who may release now remains"** is marked *Assumed, for the owner* in ADR 0010.
   - **Proposed:** leave it unbuilt in step 6 and owed to the owner, since it is the owner's assumption.
   - If you rule it in, the proposed test is "no person who is the room's owner or one of its admins (decision 215) is in the room and still in their organization". The room evaluates it on its own rows at:
     - a removal or role change;
     - a grant's revocation;
     - a departure, which already reaches every room through the organization's sweep (`/internal/org-departure`).
   - That needs no new notice machinery.
   - **Decided by the architect on 2026-11-13, for the owner to review: ruled in, as the interim rule until the owner answers.** The owner's table says the app comes down when no person who may release remains, and that this "is also what holds until the owner answers"; leaving it unbuilt would leave apps up with nobody answerable. The test is the one above, evaluated on the room's own rows at the three points above.
   - **Decided by the architect on 2026-11-13, on the first review of 6d, for the owner to review: held first, unpublished only once a window passes.** In a room with no admin, the owner's departure retired the app before an organization's admin could name a new owner through recovery, so routine offboarding became irreversible. Now nobody left stops the app being served at once, so answerability holds, but reversibly: the app is held, a reversible stop like an operator's suspension of an app, with its own cause, and nothing is retired. Recovery naming a new owner, or an admin added, within the window lifts it. The app was only held, so it is served again as it was, and a new release still goes through the whole recheck. If the window passes with nobody, the room's alarm unpublishes the app for good as `no_releaser`, by the clock it runs at. **The window is *Proposed* at 7 days,** one constant, on the owner's table as theirs to change.
4. **Room deleted and organization deleted have no source.** Nothing deletes either.
   - **Proposed:** the flip list's "every unpublish trigger" means every trigger whose fact has a source.
   - Whatever first deletes a room or an organization owes its trigger. The flip list says so by name.
   - **Decided by the architect on 2026-11-13, for the owner to review: agreed.** [The flip list](m6-plan.md#the-gate-on-the-release-path) names both as owed.
5. **The cron entry is a change to `apps/api/wrangler.jsonc`.** It is deployed to staging by `scripts/deploy-staging`, so it is a change to a deployed Worker's configuration, though not a new resource.
   - **Proposed:** add both schedules in the PR that changes the handler's gate (question 2). With no provider configured, which is staging today, every pass reads nothing and says so.
   - The cost is 13 invocations an hour into the `Moderation` object.
   - **Decided by the architect on 2026-11-13, for the owner to review: ruled in, and the architect tells the owner.** It is a schedule on an existing Worker deployed by the approved script, not a new or billed resource. **One condition:** with no provider configured, the handler returns before it touches any Durable Object, so no call reaches `Moderation` and staging today costs only the cron's own invocation. A test shows it. Both schedules go in the PR that changes the handler's gate.

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
| `RepositoryNotReady`, `repo_not_ready` | The daily read-back (`degraded`); an operator (`suspended`, no writer yet) | Room: `repo_link.status` | The room's own write in `merges.rs` | Fire in the transaction that moves the link off `ready`, on `degraded` and `suspended` (ruling 1), decided by one predicate in core |
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

## Not settled here

- **How long a room keeps serving after `RELEASES` goes off.** Up to one lap of the walk. That is ⌈L/50⌉ × 5 minutes at worst, sooner for rooms the entries pass asks about directly.
- **Whether an unpublish by any trigger should also tell operators.** Today only the switch and an operator's own acts are on their record. **Proposed:** no; the room's audit and event are the record.
