# M2 step 8: removal and retention

**Proposed.** The pure rules are built. The API, gateway and contract side below isn't, and waits for downloads ([#123](https://github.com/thachp/podster/pull/123)) and scanning ([#125](https://github.com/thachp/podster/pull/125)) to merge. Rules: [upload policy](spec/UPLOAD-POLICY.md#keeping-and-removing-files). Decisions: [56 and 57](spec/PRODUCT.md#decisions-needed). Design: [ADR 0006](adr/0006-uploads-and-scanning.md#removal). Order: [M2 plan](m2-plan.md#build-order).

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

## The API side, proposed

### Removing a file

`POST /v1/workspaces/{ws}/files/{object}/remove` is an ordinary command with an idempotency key. It's a session route through the gateway for the dashboard. In one transaction it does this:

1. Resolve the caller and work out their view of the file, using the same function as downloads.
2. `authorize_file_removal`, then `remove_file`.
3. Set `state = 'removed'`, `removed_at`, `removed_by`, `removed_by_kind` and `removed_from` on `stored_object`. The name, size, hash, uploader and timestamps stay.
4. Audit `object.removed`, record the event `object.removed` with IDs only, and store the idempotency record.

After the commit, delete `object_key` from R2. A failed delete is only logged, because the sweep deletes a removed file's bytes on its next pass. The answer is the file's record with `state: removed`.

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
- once, when the schema migration runs, which covers what staging already holds.

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

## Rulings needed

Each is the owner's call. A recommendation follows each.

1. **What a "Podster operator" is (decision 57).** Nothing in Podster has that identity today, and the ADR already says a takedown "has to be a recorded command and not a change to the database by hand."
   - **Recommendation:** build owner and admin removal now, and give the operator's takedown its own PR later.
   - In that PR, operators would be a list of person IDs in the API's configuration that the owner sets. Rust would check it, and the operator would get a separate route that leaves the same record with `removed_by_kind: operator`.
   - It's needed before public rooms, not for private pilots.
2. **Removal in an archived room.** Archiving keeps files, and most commands stop in an archived room.
   - **Recommendation:** allow removal anyway. A takedown is the one exception to keeping files, and archiving shouldn't shield harmful content.
3. **Blocked and failed files.** Today they keep their bytes and count toward the 5 GB for the room's life, yet nobody can ever download them.
   - **Recommendation:** remove their bytes automatically 7 days after the verdict, with the same tombstone and `removed_by_kind: system`, which frees their space. The 7 days leave time to look into a reported false positive.
   - The other option is to keep them, which is what decision 56 says today.
4. **Cancelling your own unfinished upload.** The policy names only owners and admins.
   - **Recommendation:** don't add this in M2. An abandoned upload frees its space when its grant expires, within the hour.

**Defaults if there's no ruling:** no operator route, refused in an archived room, blocked and failed files kept, and no self-cancel. That's the narrowest choice in each case. Each later ruling only adds behavior.

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
