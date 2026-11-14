# M6 step 6: the remaining unpublish triggers and the reconcile's cron

**Status, 2026-11-13: Proposed, by the architect's session, for the architect (the lead session) to answer the questions below. No code is started until they are answered.** Built on `main` at `6a7789d`, after decision 218's release switch (#344, #350, #353, #356).

**What this covers:** the [`RELEASE_PATH_COMPLETE`](m6-plan.md#the-gate-on-the-release-path) items that step 6 owns:
- every unpublish trigger in [ADR 0010's list](adr/0010-release-and-the-content-domain.md#unpublishing) that isn't built yet;
- the reconcile's cron entry.

**What it leaves out:**
- **`deploy_release`, approval by a person, and rollback** are the rest of build-order step 6. They drive the release job, whose tree read and upload are held until [ADR 0010's proposed revision](adr/0010-revision-apps-are-workers.md) is accepted, so they follow it.
- **The revision's stage-1 items**: an app's store, its deletion at an unpublish or a room's deletion, and the reconcile of stores. They depend on the owner's eleven stage-1 decisions.

Nothing below depends on those decisions.

## Questions for the architect

1. **Which repository states unpublish?** ADR 0010 says "its link is no longer ready". Today only `degraded` is ever written: the daily read-back finds a protection or setting differs. `degraded` goes back to `ready` by itself when the read-back finds it fixed. `suspended` exists in core with no writer, and nothing detects "found gone".
   - **Proposed:** unpublish on `degraded` and `suspended`, as written. An unpublish retires the label, so a transient settings change costs the room its address.
   - **Alternative:** unpublish on `suspended` only. On `degraded`, refuse new releases, which the recheck already does, and leave what is up.
2. **The deployment's own switch.** Turning `RELEASES` off is a deploy. Today the scheduled handler returns at once while `RELEASES` is off, so after the switch nothing would wake a room to take its app down, and rooms' release commands are refused at the Worker before they reach the room.
   - **Proposed:** the handler runs whenever a content provider is configured, whatever `RELEASES` says. A woken room reads the switch and unpublishes.
   - **This makes the deployment switch permanent for every app that was up:** labels are retired, and turning `RELEASES` back on restores nothing, as ADR 0010 says. The stop for the whole content domain stays the reversible control.
   - Confirm both.
3. **"Nobody who may release now remains"** is marked *Assumed, for the owner* in ADR 0010.
   - **Proposed:** leave it unbuilt in step 6 and owed to the owner, since it is the owner's assumption.
   - If you rule it in, the proposed test is "no person who is the room's owner or one of its admins (decision 215) is in the room and still in their organization". The room evaluates it on its own rows at:
     - a removal or role change;
     - a grant's revocation;
     - a departure, which already reaches every room through the organization's sweep (`/internal/org-departure`).
   - That needs no new notice machinery.
4. **Room deleted and organization deleted have no source.** Nothing deletes either.
   - **Proposed:** the flip list's "every unpublish trigger" means every trigger whose fact has a source.
   - Whatever first deletes a room or an organization owes its trigger. The flip list says so by name.
5. **The cron entry is a change to `apps/api/wrangler.jsonc`.** It is deployed to staging by `scripts/deploy-staging`, so it is a change to a deployed Worker's configuration, though not a new resource.
   - **Proposed:** add both schedules in the PR that changes the handler's gate (question 2). With no provider configured, which is staging today, every pass reads nothing and says so.
   - The cost is 13 invocations an hour into the `Moderation` object.
   - Do you rule it in, or is it the owner's?

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
| `RepositoryNotReady`, `repo_not_ready` | The daily read-back (`degraded`); an operator (`suspended`, no writer yet) | Room: `repo_link.status` | The room's own write in `merges.rs` | Fire in the transaction that moves the link off `ready`, per question 1 |
| `ReleaseOffInRoom`, `release_off` | Owner or admin, as a person (decision 215) | Room: `release_config.enabled` | `setReleaseConfig`, which is in the contract and **not built** | Build the `PUT`; switching off fires in its transaction |
| `ReleaseOffForDeployment`, `release_off_for_deployment` | The owner, by deploy | The `RELEASES` Worker variable | **From outside:** the room reads `releases::switched_on` at the walk's question and at release commands | Fire on the room's own read, only when the room has something to take down (below) |
| `NoReleaserLeft`, `no_releaser` | None; it is a consequence | Room rows, plus each person's organization | Room commands and the departure sweep | Question 3 |
| `RoomDeleted`, `OrganizationDeleted` | Nothing deletes either | No source | None | Question 4 |

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
  - the handler's gate becomes "a provider is configured" (question 2);
  - both schedules go into `apps/api/wrangler.jsonc` (question 5);
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
   - The cron entries, if question 5 is ruled in.
   - Tests that the walk takes a room down after `RELEASES` goes off, and does nothing for a room with nothing up.
3. **6c, the contract.** Alone in its turn.
   - `setReleaseConfig` built, switching off fires `release_off`.
   - The summaries of archive, make private, the operator's room suspension and `setReleaseDelegation` say what each now unpublishes. `setReleaseDelegation` also loses "again until the room acknowledges" and names `release_switch_notice_misdirected`, which #356 left owed.
   - It waits for the open contract PR, if any, to merge.
4. **6d, only if question 3 is ruled in:** `NoReleaserLeft`. No schema step.

**After 6d:**
- `RoomDeleted` and `OrganizationDeleted` go with whatever first deletes either (question 4).
- `deploy_release`, approval and rollback go with the release job.

The flip list in `m6-plan.md` is updated in each PR for what it closes.

## Not settled here

- **How long a room keeps serving after `RELEASES` goes off.** Up to one lap of the walk. That is ⌈L/50⌉ × 5 minutes at worst, sooner for rooms the entries pass asks about directly.
- **Whether an unpublish by any trigger should also tell operators.** Today only the switch and an operator's own acts are on their record. **Proposed:** no; the room's audit and event are the record.
