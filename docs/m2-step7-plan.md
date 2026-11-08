# M2 step 7: expected outputs

Step 7 of the [M2 plan](m2-plan.md). A task may name one expected output, and approving the submission that delivers it makes the output Ready. Decisions: [47 and 54](spec/PRODUCT.md#decisions-needed). Design: [ADR 0006](adr/0006-uploads-and-scanning.md#expected-outputs).

**Status, 2026-11-07:** everything here is **proposed**. Part 1, the pure rules, is written and tested. Part 2, the API, gateway and contracts, waits for step 6 ([#131](https://github.com/thachp/podster/pull/131)) and goes after steps 5 and 8 in the contract and migration order.

## Part 1: pure rules

Two new modules. The only change to existing files is a `pub mod` line in each crate's `lib.rs`.

### `crates/core/src/expected_outputs.rs`

- **Limits.** A room has at most 50 outputs. A title is at most 200 bytes and a description at most 4 KB, the same as a work role.
- **`decide_define`, `decide_edit`, `decide_remove`.** Each refuses in an archived room.
  - A title can't be blank. A description is optional but can't be blank if given.
  - Renaming a Ready output is allowed: what was approved is the submission, not the wording.
  - Removing keeps the row, as planned lines do, so a finished task that named it still points at something. It's refused with `output_in_use` while a task that isn't completed or canceled names it, or once it was ever Ready.
- **`decide_link`.** Which output a task names, or none. Also used when a task is created naming one.
  - It can change only while the task is open, offered or accepted. Otherwise `invalid_transition`: a reviewer approves a submission for the output it named when submitted, and a finished task's approval has already counted or never will.
  - Asking for what it already names is `Unchanged` in any status, so a retry gets the same answer.
  - An output the room doesn't have, or removed, is `output_not_found`.
- **`version_from_approval`.** Takes the task as `decide` returned it for `Verify`. It records a version only for a completed task with an approved submission that names an output and carries at least one artifact, link or file. The version replaces the output's current one. The room runs commands one at a time, so the approval being recorded is the latest.
- **`output_status`.** Ready if it has a current version, else In review if a task naming it is submitted, else Not started (DESIGN.md's three states). A follow-up in review doesn't take Ready away.
- **`current_files_available`.** False if any stored file of the current version is removed, no longer Ready, or missing. A version with only links is available.
- **`ready_count`.** "n of m outputs ready" for step 10's cards.

What doesn't move a current version:

- **Request changes:** nothing is recorded. The task goes back to Accepted, so it stops counting as in review.
- **Cancel:** nothing is recorded. A canceled task keeps naming its output as history and never counts as in review.
- **A file blocked or removed after approval:** the version stays, as ADR 0006 keeps the approval. A screen shows it beside Ready.

### `crates/policy/src/outputs.rs`

- **`authorize_manage_outputs`:** human owner or admin. An agent stored as an admin counts as a guest, and the lead comes later (decision 54).
- **`authorize_output_link`:** `authorize_task(.., Update)`, so the requester or a human admin. Someone who can't see the task gets `Hidden`. When creating a task, naming an output needs only the right to create it, because the creator is the requester.
- **`sees_outputs`:** every participant.
- **`sees_output_task`:** `can_see_task`, so an output never names a task hidden from someone limited to their own.

Tests: 23 in `crates/core/tests/expected_outputs.rs` and 5 in `crates/policy/tests/outputs.rs`. They build tasks through `decide_create` and `decide`, not struct literals, so they keep compiling when step 6 adds `Task::submission_files`.

## Part 2: API, gateway and contracts, after #131

### Storage: room schema entries in `store.rs`, forward-only

```sql
CREATE TABLE expected_output (id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT, created_by TEXT NOT NULL, created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL, removed_at INTEGER, removed_by TEXT,
  current_task_id TEXT, current_submission_no INTEGER, current_approved_at INTEGER);
ALTER TABLE task ADD COLUMN expected_output_id TEXT;
CREATE INDEX task_expected_output ON task (expected_output_id) WHERE expected_output_id IS NOT NULL;
```

- The current version sits on the output row, because only the latest approval counts. Past versions are each naming task's `approved_submission_no`, which can't change.
- **The link isn't a field of `core::Task`.** Adding one would touch every `Task` literal, including `crates/core/tests/transitions.rs`, which step 6 also edits. The new module reads and writes the column, and `save_task` never touches it.
- No D1 migration. Cards (step 10) decide whether D1 needs a count.

### Command path: new `apps/api/src/workspace/outputs.rs`

- **Define, rename, remove:** new room routes, each `authorize_manage_outputs`, then `decide_*`. Each commits the row, an event and the idempotency record in one transaction. Events: `output.defined`, `output.updated`, `output.removed`, carrying the output ID only, with no title. Recipients: none, since it's room-level. Whether these reach inboxes is a question below.
- **Naming an output on a task:** a new `PUT /tasks/:id/expected-output` with `{ output_id | null }`. It runs `authorize_output_link`, then `decide_link` with the output's existence read from rows where `removed_at IS NULL`. Event `task.output_changed`, with the task as subject and the requester, assignee and reviewer as recipients, minus the actor. It doesn't bump `task.version`, as plan edits don't, and it's refused once the task is submitted, so a race with review can't move what a reviewer approves.
- **`create_task`:** an optional `expected_output_id`, checked with `decide_link(.., Open, None, ..)` after `decide_create`, and written in the same transaction. About 3 lines in `workspace.rs`.
- **Verify hook:** about 4 lines in `handle_task_command` after `decide` succeeds for `Verify`. They call `outputs::record_approval(sql, &decision.task, artifacts, now)`, which reads the task's `expected_output_id` and calls `version_from_approval`. If that returns a version, it updates the output row in the same transaction. `artifacts` is links plus `submission_files` for that submission. No new event: `task.completed` already says it, and a listing derives Ready.
- **Removal of the output's files (step 8):** nothing to do. The version stays, and reads call `current_files_available`.

### Queries

- **`GET /outputs`** for every participant (`sees_outputs`): id, title, description, status, and `files_available` when Ready. `current` with task ID and submission number only when `sees_output_task` for that task. The status is computed from the naming tasks' statuses on each read, not stored, so it can't drift.
- **Task read:** `expected_output: { id, title } | null`.
- **Read-only oversight:** outputs carry no bytes, so the same answer as the agent's own, filtered through its task visibility.

### Contracts and capabilities, in the same PR

- `openapi.yaml`: `listOutputs`, `defineOutput`, `updateOutput`, `removeOutput`, `setTaskOutput`, plus `expected_output_id` on `createTask` and `expected_output` on task reads. New 409 codes: `too_many_outputs`, `output_in_use`, `output_not_found`.
- `capabilities.yaml`: `list_outputs` (query) and `set_task_output` (command). No agent capability for define, rename or remove, since agents can't do them yet.
- Gateway: entries in `capabilities.ts`. `index.ts` is untouched unless the person routes need a line there.
- Step 9c's Artifacts tab and step 10's cards read `GET /outputs`.

### Edits to conflict-prone files

`workspace.rs`: `mod outputs;`, the route table entries, about 3 lines in create and 4 in Verify. `store.rs`: the schema entry. `lib.rs` in `apps/api`: none expected.

### Tests

- `apps/api/test/outputs.spec.ts`:
  - define, rename and remove, with each refusal
  - naming an output, and each status that refuses it
  - approval makes it Ready, and a follow-up's later approval becomes current
  - request changes and cancel leave it alone
  - a note-only approval doesn't make it Ready
  - a guest sees the title and status but not a hidden task's ID
  - an agent admin is refused define
  - an archived room refuses changes
- The existing suites, unchanged apart from new fields.

## Security-sensitive

1. **`sees_output_task` on every read.** A mistake leaks a hidden task's ID, or that it exists, to someone limited to their own tasks.
2. **Status for guests.** "In review" tells a guest that some task naming an output is submitted, even one hidden from them. Decision 54 says all participants see status, so this is allowed, but it's a deliberate small disclosure.
3. **The Verify hook** must run in the same transaction as the approval, after `decide` and step 6's file check. It must never run on a refused approval.
4. **Agent content.** Titles and descriptions are text people and screens show. They never become instructions or permissions, and events and logs carry IDs only.

## Gaps for the lead, each with a recommendation

1. **Does a note-only approval make an output Ready?** The glossary says Ready needs "an approved artifact version". *Recommend:* no. It needs at least one link or file. Built that way, and easy to flip.
2. **Removing an output.** Decision 54 says owners and admins "define" outputs, and doesn't say whether they can remove them. *Recommend:* a soft removal that keeps the row, refused once Ready or while a live task names it. Built that way.
3. **Changing a task's output after submission.** *Recommend:* refused once submitted, and on finished tasks. Built that way.
4. **A Ready output whose file was later blocked or removed.** *Recommend:* stays Ready, with `files_available: false` shown beside it, matching ADR 0006's "keeps its approval". The alternative is falling back to an earlier approval, which needs a history table and is more surprising.
5. **Inbox events for output changes.** *Recommend:* `task.output_changed` goes to the task's parties. Define, rename and remove go to nobody's inbox and appear in activity only. Outputs are the room's goal, but inbox noise for every rename isn't worth it.
6. **Limits:** 50 per room, 200-byte titles and 4 KB descriptions. These are choices, not rulings.
