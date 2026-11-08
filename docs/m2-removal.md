# M2 step 8: removal and retention

**Proposed, and built locally, undeployed.** The pure rules and the API side are built to the owner's rulings below, except two alarm steps that wait on other work. Rules: [upload policy](spec/UPLOAD-POLICY.md#keeping-and-removing-files). Decisions: [56 and 57](spec/PRODUCT.md#decisions-needed). Design: [ADR 0006](adr/0006-uploads-and-scanning.md#removal). Order: [M2 plan](m2-plan.md#build-order).

## What's built: the pure rules

- **Removed state.** `ObjectState::Removed` in `crates/core/src/files.rs` is a new state that nothing leaves.
  - A scan report leaves it unchanged, early or late.
  - An upload attempt gets `invalid_transition`.
  - The scan deadline doesn't move it.
  - It's never available, so `may_download` refuses it for every view.
  - Every match on the state is exhaustive, so code that forgets it doesn't compile.
- **Removal and its windows,** in `crates/core/src/removal.rs`:
  - **`remove_file`:** works from any state and keeps the state the file had reached. A second removal answers `AlreadyRemoved` and changes nothing.
  - **`holds_space`:** says what counts toward the quota. An unfinished upload counts until its grant expires, a stored file counts by its size, and a removed file counts nothing.
  - **`is_abandoned`:** an unfinished upload's row can go **an hour after its grant expires**. An attempt that began just before expiry can run 30 minutes, plus 30 seconds for the room to answer, so clearing the row sooner could refuse an upload that was on time.
  - **`delete_stored_bytes`:** decides about each key found in storage.
    - Bytes a file refers to stay.
    - A removed file's bytes go at once.
    - Bytes nothing refers to go once they're **an hour old**.
    - Bytes timestamped in the future are kept.
    - A key outside `rooms/{room}/objects/{object}/{attempt}` is never deleted.
- **Who may remove,** in `crates/policy/src/files.rs`: `authorize_file_removal` allows the room's owner or a human admin.
  - An agent stored as an admin counts as a guest.
  - The uploader gets no say over their own file.
  - Someone who can't see the file gets `Hidden`, so a file ID can't be probed.

"Who may remove" is in `crates/policy`, not `crates/core`, because the permission matrix lives there.

## The API side, built

### Removing a file

`POST /v1/workspaces/{ws}/files/{object}/remove` is an ordinary command with an idempotency key. It's a session route through the gateway for the dashboard. In one transaction it does this:

1. Resolve the caller and work out their view of the file, using the same function as downloads.
2. `authorize_file_removal`, then `remove_file`.
3. Set `state = 'removed'`, `removed_at`, `removed_by`, `removed_by_kind` and `removed_from` on `stored_object`. The name, size, hash, uploader and timestamps stay.
4. Audit `object.removed`, record the event `object.removed` with IDs only, and store the idempotency record.

The same transaction makes the storage sweep due at once, and the sweep deletes the bytes. Every delete from storage happens there, where a failure is simply tried again a minute later. The answer is the file's record with `state: removed`.

**Related behavior:**
- **Downloads** answer `file_removed` (410) from current state, using #123's check.
- **A submission holding a removed file** can't be approved, because approval already needs every file available. The assignee submits again.
- **An approved submission** keeps its approval and shows the file was removed.

**No agent capability.** No agent may remove a file, since an agent stored as an admin counts as a guest. A `remove_file` tool would refuse every call, so the contract change is the route alone. If the owner wants agents to see removals, `list_assets` shows `removed`.

### Quota

`room_used` excludes `removed`, matching `holds_space`, and a test keeps the SQL and the Rust in step.

### The sweep, in the room's alarm

**Rows.** Rows that `is_abandoned` are deleted, with `object.upload_abandoned` audited by ID. The alarm is armed for the earliest `upload_expires_at` plus the grace, next to #125's scan deadline.

**Bytes.** The alarm lists `rooms/{room}/objects/`, then reads `object_key` and state for each listed key, then deletes whatever `delete_stored_bytes` says.
- **Order:** the listing has to come first. A key is recorded before any of its bytes are written, so a key that's listed already has its row.
- **Bounded work:** a few pages per pass, with a cursor kept for the next one.

**When the bytes sweep runs.** It runs only when something might have left bytes behind:
- an hour after an upload attempt begins;
- after a removal whose delete failed;
- after abandoned rows are cleared;
- once, an hour after the schema migration runs, in a room that already holds files. This covers what staging already holds, and a new room starts with nothing due.

If it keeps bytes that are too young, it runs again when the youngest one is an hour old. A room with nothing new never lists storage.

**Where unreferenced bytes come from:**
- `upload_outcome_unknown`;
- a Worker that died between storing a file and the room's answer;
- a failed delete after a refusal;
- an attempt replaced by a newer one;
- an abandoned upload.

All of these start with an attempt the room recorded. That's why scheduling from `begin` covers them.

### Migration and contract

- **Room schema,** a forward-only entry in `apps/api/src/store.rs`:
  - `removed_at`, `removed_by`, `removed_by_kind` and `removed_from` on `stored_object`;
  - an index for the abandoned-row sweep;
  - one row for the bytes sweep's due time and cursor.
- **D1:** no change unless a listing reads files. #123 and #125 add none.
- **Contracts:** the route in `openapi.yaml` and the `file_removed` refusal. No capability.

### New modules

`apps/api/src/workspace/removal.rs` holds the command and the sweep. Edits to `workspace.rs` stay small: the route, one arm in `arm`, and one call in `alarm`. `objects.rs` changes only `room_used`. `store.rs` gets one schema entry and `lib.rs` one route.

## Rulings

The owner ruled "as recommended", recorded as [decisions 92 to 98](spec/PRODUCT.md#decisions-needed):

- **No operator route in this change (92).** It gets its own change before any public room, as another `Remover` kind calling `removal::remove`.
- **Removal works in an archived room (93).** This is built.
- **Blocked and failed files (94).** Their bytes are removed by the system 7 days after the verdict. The rule is `unusable_file_due` in core. Its alarm step needs #125's `scanned_at`, so it lands after #125.
- **No self-cancel (95).**
- **Unsubmitted files (98).** Files uploaded for a task and never submitted are removed by the system 24 hours after the task leaves Accepted. The rule is `unsubmitted_file_due` in core. The hook is agreed with step 6 part 2, whose migration adds what this reads:
  - `stored_object.for_task`;
  - a `submission_file` table, where "named by a submission" means one of its rows has the file's `object_id`;
  - `task.left_accepted_at`, which `store::save_task` sets on leaving Accepted and clears on coming back.

  The alarm step lands after both migrations.

## What the deeper pass should cover

Removal deletes data, so this needs more than the usual diff review.

- **Authority:**
  - Members, guests, Coordinators and agents stored as owner or admin are refused.
  - A hidden file answers like a missing one, and oversight never removes anything.
  - An idempotent replay after the caller lost access is refused, because authority is checked before the stored answer.
- **The sweep never deletes bytes a file refers to:**
  - Listing before reading state is the order that makes this hold. Requests can run in the room while it awaits R2, so test a `begin` and a `complete` landing during the listing.
  - No key under another room is ever deleted, including room IDs that are prefixes of each other.
  - Pagination ends.
  - The work per pass is bounded.
- **Races with removal:**
  - An upload attempt in flight.
  - A scan in flight: the scanner reads deleted bytes, reports `unreadable`, and the file stays removed.
  - A download streaming as the bytes go. Copies already taken can't be recalled, as the policy says.
- **Quota:** a removed file frees its space at once, and the SQL and `holds_space` agree.
- **Records:** logs and events carry IDs only, the record and hash stay after removal, and the migration is forward-only.
- **On staging:** remove a ready file, a scanning one and an unfinished upload. Then check that R2 no longer holds their keys, that the download answers `file_removed`, and that an orphan left by a stopped upload is gone after the grace.
