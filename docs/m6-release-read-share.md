# M6: a cross-room share of the release read budget

**Status: design only, its four questions ruled on 2026-11-14.** The design stays **Proposed** until it is built. It answers one item on
[the gate on the release path](m6-plan.md#the-gate-on-the-release-path): "a cross-room share of the read budget"
([ruling 3 on the driver](m6-plan.md#what-the-third-pr-built-the-driver)). No code changes with this document.
Line numbers are on `main` at `6c2d12b2`.

## The architect's rulings, 2026-11-14

1. **The owner is the unit.** It is the room's organization, else its owner person, else the room itself. Reads are
   charged to whoever owned the room when they were reserved. They stay charged there if ownership changes later. A
   change of owner needs a person, so this can't be gamed cheaply. *Decided by the architect, for the owner to
   review.*
2. **The share is 1,204 reads an hour per owner,** so each owner keeps exactly two full attempts, the same as the
   driver's per-room bound. **The consequence is accepted:** once two owners have used their whole share, they leave
   592 reads, and a third owner's full-size release waits up to the rest of the hour. **Owed before production:**
   measure contention, then revisit the share or add a held-back reserve. *Decided by the architect, for the owner to
   review.*
3. **Both checks.** The share is checked while the release is `queued`, to save the attempt and the slot. That check
   is only an optimisation. It is enforced again at the reservation, inside `Moderation`'s transaction, which is the
   only place that decides. *Decided by the architect, for the owner to review.*
4. **Fair queueing is deferred.** It is owed only if the measurement in ruling 2 shows starvation. *Decided by the
   architect, for the owner to review.*

## 1. The budget today

- **The figure:** `MAX_RELEASE_READS_PER_HOUR = 3_000` and `READ_WINDOW_MS` (one hour) in
  `crates/core/src/release.rs:18-20`. The decision is `read_budget_wait` (`crates/core/src/release.rs:1647`), using
  `reads_fit` (`:1634`). It counts every release's reservation in the rolling hour. It does not know which room or
  organization made a reservation.
- **Where it lives:** the deployment's one `Moderation` Durable Object (`id_from_name("moderation")`), table
  `release_reads (release_id, reads, reserved_at)` (`apps/api/src/moderation.rs:47-53`). It is reached only through
  `POST /release-reads` inside the object (`apps/api/src/moderation.rs:740-745`). No public route reaches it.
- **Where it is reserved:** `reserve` in `apps/api/src/github/release_read.rs:478`, called by the room's upload at
  `apps/api/src/workspace/release_upload.rs:407`, before the token, for the two tree reads (`TREE_READS`). It is
  called again at `:130` for the files, `file_reads(plan.count(), FETCH_PASSES)`. The reservation is therefore
  already sized from the tree, at most 602 reads for one attempt (`MAX_ATTEMPT_READS`,
  `crates/core/src/release_driver.rs:61`).
- **Where it is refused:** `reserve_reads` (`apps/api/src/moderation.rs:970`) answers `{"fits": false, "retry_at"}`
  at `:1020`. `reserve` turns that into `ReadFailure::Budget` (`release_read.rs:517`), and the upload waits with
  `release_reads_budget` and that `retry_at` (`release_upload.rs:440-444`).
- **What bounds a room:** `upload_slot` (`crates/core/src/release_driver.rs:183`, applied in the lease at
  `apps/api/src/workspace/release_driver.rs:337-353`) allows at most 2 upload attempts begun per room in an hour, so
  one room can hold at most 1,204 reads (`MAX_ROOM_READS_PER_HOUR`, `crates/core/src/release_driver.rs:64`).
- **The gap:** nothing bounds rooms in total. Three rooms, or one organization with three rooms, can fill the hour.
  Every other room's attempt is then refused at the reservation. **That refusal costs the release more than a wait:**
  the lease has already counted a driver attempt (cap 8, `MAX_DRIVE_ATTEMPTS`) and taken one of the room's two upload
  slots. The release is already `uploading`, so its upload's hour is running. A release that is starved long enough
  ends with `release_attempts_exhausted` or at its upload's hour, and its content was never at fault.

## 2. Options

Rust decides every one of these. The counter is state in a Durable Object and is read in the same object that
decides. A read model or D1 is never consulted.

| Option | Guarantees | Costs |
| --- | --- | --- |
| **A. Per-owner share** (organization, else person, else room) | One owner with any number of rooms holds at most its share of the hour. | No guarantee when many owners are active at once, because it is still first come, first served under the total. The room must send its owner key with each reservation. |
| **B. Per-room share with a deployment cap** | Already partly true: 2 attempts per room per hour. A hard per-room read cap could replace the attempt count. | Adds nothing across rooms. An organization opens more rooms (bounded only by its room limit) and multiplies its share. It does not close the gap. |
| **C. Fair queueing in the budget's object** | A refused release is put in a line, and the next reads that free up go to the oldest waiting owner below its share. A busy owner cannot keep cutting in. | A waiters table, its expiry, and a "may I take this" answer that depends on others. It is harder to test exactly, and it needs a call back or a poll for the waiter. It also adds load to the busiest object. |
| **D. Reservation by release size** | Releases are charged what they read, not a worst case. | **Already built:** each attempt reserves 2, then `files x 2`. It is not a fairness mechanism by itself, but it makes A's share go further for small sites. |

**Where the counter lives.** The budget's home stays the `Moderation` object. The per-owner counter must be decided in
the **same object and the same transaction** as the deployment total. Otherwise the two can disagree, and a release
could fit its owner's share but overrun the total, or the reverse. A Principal object per organization would be one
more round trip, and it would need a two-phase hold across objects. So the counter is **rows in the existing object,
not a new object.** It can still move into a budget object of its own later, as `m6-plan.md` already anticipates,
and it would move with the total.

**How it is stored.** `Moderation` has no schema versioning. Its tables are `CREATE TABLE IF NOT EXISTS`, so a new
column on `release_reads` would never appear in the live object. Add a **new table** instead:
`release_read_owner (release_id PRIMARY KEY, owner_key)`. It is written in the same transaction as the reservation.
Alternatively, create a `release_reads2` table and stop using the old one, which still holds at most an hour of rows.

## 3. Recommendation (**Proposed**)

**Option A, with D as built, and C deferred.** The new constants go in `crates/core/src/release_driver.rs`, next to
the room bound:

```text
MAX_OWNER_READS_PER_HOUR = MAX_ROOM_READS_PER_HOUR      // 1,204: an organization gets what one room gets
const assert: MAX_OWNER_READS_PER_HOUR >= MAX_ATTEMPT_READS          // an owner can always make one full attempt
const assert: MAX_RELEASE_READS_PER_HOUR - MAX_OWNER_READS_PER_HOUR >= MAX_ATTEMPT_READS  // never one owner alone
READ_SHARE_WAITING = "release_reads_share"              // its own code
```

- **Core:** `read_share_wait(held_by_owner, held_all, needed, now) -> Result<(), Option<i64>>` is pure. It is the
  later of the two times `read_budget_wait` gives, once for the owner's rows against the owner share and once for all
  rows against the total. If `needed` exceeds the share, the answer is `None` (never fits), and the existing assertions
  already rule that out for any attempt.
- **Enforcement (authority):** `reserve_reads` takes `owner_key` from the room and decides with `read_share_wait` in
  its one transaction. Only the room's Rust sets the key, from `workspace.owner_org_id` or the owner person, over a
  service binding. No client value reaches it.
- **Waiting without burning the attempt cap.** Before the lease, while the head release is `queued` (step `Start`),
  the driver's pass asks `Moderation` one more read-only question: `/release-reads/share`, with the owner key and
  `MAX_ATTEMPT_READS`. It asks this the same way it already reads the deployment switch and the provider before the
  transaction. If there is no room, the job is set to `next_attempt_at = retry_at` with code `release_reads_share`,
  as `DRIVE_IDLE_MS` already does for release being off. **No driver attempt is counted, no upload slot is taken, and
  the upload's hour has not begun,** because `Start` is what makes a release `uploading`. This answer does not
  authorize anything. The reservation still decides, and a race lost there still waits as `release_reads_budget`
  does today. It costs one attempt, rarely.
- **Tie to the marker job.** `m6-plan.md` ruling 7 already owes "a release waiting on another's flight waits under a
  code of its own, and is not ended by the cap." Build both as one mechanism: a set of **wait codes that count no
  attempt** (`release_in_flight`, `release_reads_share`), decided in core as `waits_uncounted(code)`, and applied in
  the lease before `may_lease`. The two items share the code path and its tests.
- **What a waiting release shows:** its job's code, `release_reads_share`, and `next_attempt_at`. Nothing more is
  told to the room's people in stage 1. The code is internal (`// codes: reasons`) until a route answers with it.

**What it guarantees.** No owner holds more than 1,204 of the 3,000. At least three owners can be releasing in the same
hour. A starved release waits while `queued` and is never ended by the share. **What it does not guarantee:** when four
or more owners are active, a given owner may wait an hour or more, first come, first served. That is option C's job.

## 4. Proof, steps and order

**Tests that would prove it.**

- *Cargo, `crates/core/tests/release_driver.rs`:* `read_share_wait` at the owner edge (1,204 fits, 1,205 waits until
  the owner's oldest row leaves the hour) and at the total edge with other owners. The later of the two times wins.
  Both compile-time assertions are present. `waits_uncounted` covers both codes and no others.
- *`apps/api/test/app-reports.spec.ts`, the budget's describe block:* two releases of one owner past 1,204 are refused
  while another owner's release still fits. The total still binds across owners. A reservation's owner is the one
  first recorded, whatever a later `more: true` says. The share question writes nothing. All of this runs with the
  object's test clock.
- *`apps/api/test/release-driver.spec.ts`:* three rooms of one organization each run a full-size release. The third
  waits as `release_reads_share` while `queued`, with `attempts` unchanged, no `release_upload_attempt` row and no
  upload started. A room of a second organization releases at once. Once the hour passes, the third proceeds.
  Mutations: counting the attempt, taking the slot, or checking after `Start` each fail a test.
- *Source check,* as the gate's other checks do: the owner key passed to `/release-reads` comes from the room's
  `workspace` row, not from a request body.

**Steps needed.** No room schema step: the job's code and `next_attempt_at` already exist in `release_job`. No D1
migration. No contract change: the route is internal, and the code is a `reasons` code. One **Moderation table**
(`release_read_owner`) is created with `IF NOT EXISTS`.

**PR order.**

1. Core: `MAX_OWNER_READS_PER_HOUR`, `read_share_wait`, `waits_uncounted`, the assertions and cargo tests. This step
   is pure and ships alone.
2. Moderation: the `release_read_owner` table, owner-aware `reserve_reads`, the read-only share question, and their
   spec. `reserve` sends the owner key.
3. Driver: the share check while `queued`, uncounted waits in the lease, and the driver spec. Build this together
   with, or right after, the marker job's `release_in_flight` wait, so that ruling 7 and this item close on one path.
4. The gate list in `m6-plan.md` marks this item built. `RELEASE_PATH_COMPLETE` still flips only in its own last PR.

Each is security-sensitive by the plan's rule for step 5, and each gets the usual quick diff review. None of this has
been run, and nothing here is shown on staging.
