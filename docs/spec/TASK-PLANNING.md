# Task planning: List, Board and Gantt

Status: **approved product direction; implementation handoff** · Owner: Patrick Thach · 2026-11-05, with engineering choices accepted on 2026-11-06 as [decisions 62 to 73](PRODUCT.md#decisions-needed), and more on 2026-11-07 as [decisions 85 to 87](PRODUCT.md#decisions-needed)

Companions: [Product](PRODUCT.md), [Design](DESIGN.md), [Access control](ACCESS-CONTROL.md), [Architecture](ARCHITECTURE.md), [mockup index](../mockups/README.md).

Patrick approved two static concepts and requested documentation so Claude can implement them. This brief records that direction; it does not claim that any of it shipped in M0. No interactive prototype was built. **Accepted** below marks engineering choices the owner has now settled, and only what the contract section says is built. **Proposed** marks what's left to settle in review. Existing lifecycle and access-control requirements remain authoritative.

## Approved experience and references

Within each workroom's **Tasks** tab, provide switchable **List / Board / Gantt** views of the same authorized task set, overall progress, an estimated project duration/forecast when supportable, and Jira-like click-to-open task details. Reuse Podster's current shadcn Sidebar, white/indigo semantic tokens and right-side Task Sheet. Do not introduce a new task system or a separate detail modal.

![Approved Board concept with the existing-style task Sheet](../mockups/podster-board-task-detail.png)

![Approved Gantt concept with dependency and forecast presentation](../mockups/podster-gantt-forecast.png)

These originals are visual references, not pixel-level scheduling specifications. Billing titles, IDs, counts, dates and people are illustrative; they are not Podster's real schedule or a request to implement billing. The image's full-page expansion and dependency links must follow existing Sheet rules; do not infer permission or feature availability from a drawn control. The text below governs calculations and behavior where pixels differ.

## Shared view and detail behavior

- One permission-filtered task collection, filter model and selection drives all three views. Preserve the existing **Needs my review** filter and any implemented filters; expose only filters backed by actual authorized data. Do not invent roles or timestamps absent from the response.
- Persist view and active filters in the URL alongside `task`, preserving unrelated query parameters. Encoding: `view=list|board|gantt` and `review=mine`, with all three built; default to List for missing/invalid view values. Reload and Back/Forward must restore view, filters and selection. Do not keep filters solely inside `TaskList` local state.
- Switching view keeps the selected task and Sheet open. Filtering out its launcher may keep the authorized task selected; explain that it is outside the current filter. Closing returns focus to its launcher in the current view, or the Tasks heading/main content if no launcher remains.
- Cards, list-row titles and Gantt row/bar targets are real keyboard-operable links to the same `?task=<id>` Sheet, including open-in-new-tab behavior. Selecting an already selected task must not create duplicate Sheets, reset edits or duplicate a mutation.
- Reuse `TaskSheet` → `TargetSheet` with `param="task"`, `size="lg"`, fixed task/workroom target and **Details / Discussion / Activity**. No target dropdown or nested Sheet. A dependency link inside a Sheet must close/resolve dirty state before navigating to the other task; it must not nest a Sheet.
- Preserve focus trap, visible focus, Escape/close behavior, unsaved-discard confirmation and pending-save protection. Close never silently saves. Repeated selection, rapid navigation and slow responses cannot apply data or actions to another task. Preserve target/version binding and abort/stale-load protection.
- Review still names the exact submission being approved/requested changes on. Only current server authority enables an action. Missing and hidden targets use the same generic not-found treatment; failures must not expose cached private titles or edges after access changes.
- After confirmed edits/review, refresh all three projections and their aggregates from the server. Keep prior authorized data on refresh failure with a stale/error label; do not display a failed read as an empty room or count unknown saves as success.

## Board

| Kernel state | Column |
| --- | --- |
| `open` | Open |
| `offered` | Awaiting acceptance |
| `accepted` | Accepted |
| `submitted` | Awaiting review |
| `completed` | Completed |
| `canceled` | Canceled, optional and hidden by default |

Keep the five primary columns in this order, including empty columns. Column counts describe the displayed authorized scope; label partial counts. **Blocked** is a secondary planning indicator on a card, never a new kernel state/column. Accepted means commitment, not proof that execution started. Submission remains Awaiting review until the named reviewer approves.

Compact cards show task ID/title, assignee or Unassigned, relevant reviewer (especially Awaiting review), a known estimate with units, and an authorized dependency marker. Unknown estimates say **Not estimated**. Use plain attributed content and current name-visibility helpers; do not invent presence, availability, role authority, percent effort complete or human-readable IDs unsupported by the API. BIL-101-style IDs are demo labels; use canonical IDs unless an explicit display-ID contract is added.

First version is read-only grouping with existing lifecycle actions in the Sheet. No drag-to-complete, drag lifecycle shortcuts, sprint planning, bulk selection, velocity or automatic assignment follows from the Scrum analogy.

## Progress and scope

For a complete authorized in-scope set, `progress = completed_count / non_canceled_count`. Completed means reviewer-approved kernel `completed`, not submitted, merged or deployed. Exclude canceled tasks from numerator and denominator even when shown. Round the percentage to the nearest integer, halves upward; retain the exact counts in accessible text. With zero non-canceled tasks, show **No tasks in scope**, 0 of 0 and no percentage (not 100%).

The default summary covers the workroom tasks the viewer is authorized to see. When a filter applies, label **Progress for filtered tasks**. A limited viewer gets **Progress for tasks you can see**, never a claim of room-wide progress. Distinguish a task filter from an authorization boundary.

The current loader can return `more=true`: a page is not a workroom aggregate. Obtain a complete authorized aggregate with matching filters/snapshot, or explicitly show **Loaded tasks only · partial** and loaded counts. Never use the first page's numerator against a global denominator. The same rule applies to column counts, duration, dependency graph and forecast. Do not fetch hidden tasks to fill totals or leak hidden counts via subtraction. Suppress an overall forecast if completeness cannot be established safely.

## Gantt and bounded forecast

Rows use the same tasks, order and selection identity as the other views. Show ID/title, text state, assignee where known and estimate with units beside a calendar scale. Render finish-to-start arrows only for edges the viewer may read; identify predecessors in a text/list equivalent. Add a timezone-labeled Today marker and distinguish weekends with a label/legend, not color alone. Show planned bars, forecast finish and critical paths only when their inputs support them. Do not render unknown spans as zero-duration finished bars or imply factual execution start times from acceptance.

Provide an accessible table/list with task, status, estimate, authorized predecessor names and planned/forecast dates. On mobile default to this alternative; a wide timeline can scroll inside its region without making the whole page scroll sideways. All row/bar selections work by keyboard, have text names and visible focus. Critical-path emphasis needs text/icon labeling in addition to color; reduced motion and screen-reader announcements follow DESIGN.md.

**Forecast is an estimate, not a delivery commitment.** It is separate from informational `due_at`; never move due dates or promise a finish by reading them. Show the time the plan last changed ([decision 68](PRODUCT.md#decisions-needed)), calendar/timezone and assumptions with the result.

**Accepted ([decision 85](PRODUCT.md#decisions-needed)):** a completed task with no estimate is left out and named on screen, because its plan can't be edited any more and would otherwise withhold the room's forecast for good, and a finish date shouldn't look complete without it.

**Chosen where the decisions leave it open, in the code as built:** an unfinished task that follows such a task is withheld as missing an estimate, and an edge between two finished tasks that nobody can edit is ignored. A start date on a weekend is accepted and kept as entered, and the forecast gives the Monday it really begins as `begins_on`. A start date can be changed but not cleared. At most 20 tied paths are listed, with `critical_paths_cut`, and each task's `critical` stays exact. A baseline reads no clock, so it doesn't move with today's date. `plan_changed_at` is when estimates, dependencies or the start last changed, and the forecast also reflects current task status and which tasks exist when it's read: canceling a task can shorten it, creating an unestimated one can withhold it, and completing that one can bring it back, all without moving `plan_revision`. Moving the revision on lifecycle changes would make plan edits conflict with unrelated task activity, so neither value can key a cached forecast, and the forecast's assumptions say so ([decision 86](PRODUCT.md#decisions-needed)). Agents' default `get_plan` includes the forecast ([decision 87](PRODUCT.md#decisions-needed)). Someone who can't have a forecast gets no start date either, and the same answer whatever the room holds.

**Accepted first version ([decisions 67 to 73](PRODUCT.md#decisions-needed)):** a deterministic, read-only baseline over a complete authorized same-workroom DAG, labeled "Baseline plan", with one start date and timezone per room set by the owner or a human admin, a fixed Mon–Fri working-day calendar and whole working-day durations from 1 to 260. Blank means **Not estimated**, and there's no zero. The Gantt is table first, drawn with CSS grid and SVG and no library. Display the chosen IANA timezone, skip weekends, and state that holidays aren't taken into account and that there's no resource leveling. Planning start is a local calendar date, not a timezone-shifted UTC midnight. Inclusive date spans finish at the end of their last working day; successors start on the next working day. Today uses that same timezone. Do not infer a start from task creation, acceptance or `due_at`.

Independent paths may run in parallel; forecast duration is the longest dependency path, never the sum of every estimate. This first scenario does not promise simultaneous tasks assigned to one agent can actually run concurrently: show **No capacity/resource leveling**. Display all tied critical paths where calculable. Slack means latest allowed start/finish within the scenario without moving its finish, not evidence of an agent's actual availability.

Separate the static baseline scenario from a live remaining-work forecast. A baseline must be labeled as such; it must not silently advance with today's date. For a live forecast, unfinished tasks require explicit current remaining-duration information and an as-of date; a total original estimate is not automatically remaining work. Submitted work may have zero execution remaining but still has review wait. Accepted work is not automatically partly done.

Acceptance/review waits must be explicit assumptions. **Accepted ([decision 69](PRODUCT.md#decisions-needed)):** baseline durations include acceptance and approval time, as the image says, and the input and the forecast both say so. Do not double-count them. If those waits or remaining durations are unknown/stale, show **Forecast unavailable** or a clearly qualified scenario with the omitted assumptions, not a confidently dated live finish. Never default unknown waits to zero behind the scenes.

Missing estimates/start/calendar, stale remaining-work information, cycles, unresolved canceled predecessors or an incomplete/redacted graph suppress the affected reliable forecast and critical-path claims. Show a generic authorized explanation and known per-task information; never identify a hidden predecessor or reveal its count/duration through an error or finish date. The first version leaves out a visible-subset scenario ([decision 73](PRODUCT.md#decisions-needed)). If one is added later, it needs an explicit **Visible subset scenario; not overall finish** label and no hidden-derived inputs.

## Dependencies and authority

Dependencies are planning relationships, not execution orchestration. Use same-workroom directed acyclic edges only; reject self-links, duplicate edges, cross-workroom targets and cycles atomically. A predecessor is satisfied only by reviewer-approved `completed`, not accepted/submitted or external merge status.

A canceled predecessor is **unresolved**, never silently treated as completed or removed. Show the authorized conflict and withhold the affected finish until an authorized planner explicitly removes/replaces the edge. Keep cancellation/history auditable. Exclude canceled tasks from progress without erasing their planning consequences.

Read/write authorization must apply to the edge and both endpoints on every request and after membership changes. Hidden/private tasks must not leak through dependency badges, IDs, counts, arrows, audit details, aggregates, forecast times or critical-path lengths. A read model never grants access. If an authorized projection cannot safely attest complete forecast inputs, return an unavailable result without hidden-derived metadata.

**Accepted write policy ([decisions 62 and 63](PRODUCT.md#decisions-needed)):** the task's requester or a human room admin may edit its planning metadata and dependencies, and only if they see the whole room, because refusing a cycle could otherwise reveal a hidden link. Agents get this under the same rule; agent ownership or a work role alone grants nothing. A dependency belongs to its successor. Edits are refused if the successor is terminal or the room is archived, allowed in `submitted`, and a canceled predecessor can be removed. A plan edit never re-offers a task. Write the policy tests before exposing editing controls.

Planning edges do not launch/wake agents, change assignees/execution ownership, grant review/merge/deploy rights or silently add a server lifecycle gate to accept/submit/verify. Lifecycle changes would need a separate approved design. Rust authorizes, the private API remains service-only, the gateway authenticates/translates, and core/policy remain pure.

## Required data and contracts (documentation only)

Current task contracts do not provide a full planning model. Do not fake production estimates/edges in the UI or broaden `update_task` ad hoc. [Decisions 64 to 66](PRODUCT.md#decisions-needed) accept one `plan_revision` per room that leaves `task.version` alone, one `set_task_plan` command (at most 50 predecessors per task and 5,000 edges across unfinished tasks, audited, waking nobody), and one plan read whose `complete` is false for anyone who doesn't see the whole room and for rooms over 3,000 tasks. Those are built, locally only, with their endpoints in [ARCHITECTURE.md](ARCHITECTURE.md), and the Task Sheet can read and edit them. The room's start date and the baseline forecast are built too, and locally only: `PUT /v1/workspaces/{ws}/plan/start` and `forecast` in the plan read, in `crates/core/src/baseline.rs`. The Gantt reads this forecast, and shows it as a table, a panel and a timeline drawn with CSS grid and SVG, with the table as the accessible source. The table below is what those have to cover, and live-forecast fields wait for [decision 68](PRODUCT.md#decisions-needed)'s later step:

| Need | Proposed contract responsibility |
| --- | --- |
| Planning metadata | Optional duration/remaining duration with units, as-of date, author/source, planning start and calendar/timezone reference; validate bounds and distinguish unknown from zero |
| Dependency edges | Stable predecessor/successor IDs, workroom, version and audit identity; atomic DAG validation and current endpoint authorization |
| Concurrency | Task/planning version plus graph revision; reject stale graph writes even when endpoint task versions have not changed; preserve user input on conflict |
| Commands | Idempotency keys, replay behavior and transactionally consistent state/event/outbox/idempotency records; audit actor, old/new values and reason where applicable |
| Projections | Authorized tasks/edges, scoped aggregates, completeness and freshness flags, source revisions; no hidden-derived totals or permissions inferred from projection |
| Forecast | Calendar and start assumptions, the time the plan last changed, baseline versus remaining scenario, completeness, unavailable reason and tied critical paths; stable deterministic output |

Any implementation adds reviewed schemas/contracts and forward-only migrations with the code in a coordinated change, following CLAUDE.md's single-owner rule for contracts/migrations. Settle nullability and endpoint names in that PR. No contract or migration is changed by this handoff.

## Code map verified on main

Baseline inspected: `84c7c0c`; code pointers rechecked against `4e784b9` (2026-11-05 refresh of `origin/main`, with no intervening application/contract changes). Recheck before implementing; these are pointers, not instructions to replace working behavior.

| Existing source | Reuse / gap |
| --- | --- |
| `apps/web/components/shell/app-shell.tsx` | Actual shadcn Sidebar, bottom profile and responsive inset |
| `apps/web/app/globals.css` | White/indigo and status semantic variables; no raw component colors |
| `apps/web/app/(shell)/w/[id]/tasks/page.tsx`, `load-tasks.ts` | Authorized server data and pagination boundary; `more` is explicit |
| `apps/web/app/(shell)/w/[id]/tasks/tasks-screen.tsx` | Current NewTask + TaskList + single TaskSheet composition; host view switch here |
| `apps/web/app/(shell)/w/[id]/tasks/task-list.tsx`, `task-model.ts`, `task-bits.tsx` | Existing review filter, canonical status/name helpers; lift shared filters, preserve content safety |
| `apps/web/app/(shell)/w/[id]/tasks/task-sheet.tsx`, `task-actions.tsx` | Details/Discussion/Activity and exact-submission review; keep lifecycle controls here |
| `apps/web/components/sheet/target-sheet.tsx`, `target-sheet.test.tsx` | URL selection, fixed target, focus, dirty state and stale-request protection |
| `apps/api/src/workspace.rs`, `crates/core`, `crates/policy` | Authoritative state, pure decisions and permissions; review actual extension points |
| `packages/contracts/openapi.yaml`, `capabilities.yaml` | Extend only during implementation with matching server/client changes |

## Implementation sequence

1. Recheck current code and permissions. Write a small contract/design amendment from decisions 62 to 73 before persistence work; coordinate ownership of migrations/contracts, taking turns with M2 under [decision 60](PRODUCT.md#decisions-needed).
2. Add meaningful pure forecast/DAG tests and policy denial tests, then implement validated data/commands and authorized complete projections. No browser-to-private-API route. Keep unsupported forecasting explicitly unavailable.
3. Lift shared filters/URL view state; ship synchronized List/Board backed by actual authorized task states and complete or labeled-partial progress. Reuse the existing Sheet and lifecycle actions.
4. Add the accessible Gantt/table and deterministic baseline scenario. Add live remaining-work forecasting only once its freshness/wait data is supportable. No bar dragging/rescheduling in the bounded first version.
5. Run focused component, core/policy, contract and integration checks appropriate to the implementation; manually test keyboard/mobile and real staging behavior under a separately authorized deployment. Record actual results rather than marking the scenarios below passed in advance.

## Demo fixture and acceptance scenarios

Fixture only: eight non-canceled tasks, BIL-101 through BIL-108. The first three are reviewer-approved; BIL-104 is submitted, BIL-105 and BIL-106 accepted, BIL-107 offered and BIL-108 open. Thus `3 / 8 = 37.5%`, displayed **38%**. Mockup Today is Thursday, November 5, 2026. November 2–13 inclusive contains **10 Mon–Fri working days**. These dates are not Podster's actual project schedule.

A precise baseline example (all intervals inclusive; declared durations include wait allowances):

| Task | Duration | Predecessors | Earliest baseline span |
| --- | --- | --- | --- |
| BIL-101 | 1d | None | Nov 2 |
| BIL-102 | 2d | None | Nov 2–3 |
| BIL-103 | 1d | 101 | Nov 3 |
| BIL-104 | 2d | 103 | Nov 4–5 |
| BIL-105 | 2d | 102 | Nov 4–5 |
| BIL-106 | 4d | 104, 105 | Nov 6–11, skipping Nov 7–8 |
| BIL-107 | 2d | 106 | Nov 12–13 |
| BIL-108 | 1d | 106 | Nov 12 |

Both `101 → 103 → 104 → 106 → 107` and `102 → 105 → 106 → 107` tie at ten working days. Sum of all durations is 15d, not project duration. The PNG shows BIL-108 on Nov 13: that is one day of scheduled slack, not its earliest start; reproducing that date requires an explicit not-before date or scheduling choice outside the bounded earliest-start model. The image's single emphasized chain is not a unique-critical-path algorithm. Do not regenerate the approved images to correct those conceptual pixels.

All feature checks below are **not run**; they are implementation acceptance criteria.

| ID | Scenario | Required result |
| --- | --- | --- |
| TP-01 | Switch List/Board/Gantt with review filter and selected task; reload, Back, Forward | Same authorized tasks, counts, URL state and single selected Sheet |
| TP-02 | Open row/card/bar, open in new tab; close via Escape, repeat selection, filter launcher away | Same fixed task, keyboard focus correct or safe fallback; no nested/duplicate Sheet |
| TP-03 | Slow A load/save, select B; dirty draft; stale version/submission | No cross-target update, lost input or accidental approval; existing exact-submission guards hold |
| TP-04 | Offered/accepted/submitted/completed/canceled and blocked task | Canonical columns; blocked secondary; only approved task increments completion; no drag completion |
| TP-05 | 3 approved / 8 active; zero active; canceled included in display | 38%; zero has no percentage; canceled excluded from denominator |
| TP-06 | Filter, `more=true`, read failure, limited member, access revoked mid-view | Accurate scope/partial/stale labels; no fake global aggregate or hidden data in any view |
| TP-07 | Fixture, parallel paths, tied critical paths, weekend boundary, timezone midnight | Nov 13 finish, ten working days, both ties; dates stable in chosen calendar; never summed to 15d |
| TP-08 | Unknown estimate/start/wait, stale remaining work, cycle or canceled predecessor | Reliable forecast/critical path unavailable with safe reason; task details remain useful |
| TP-09 | Self/duplicate/cross-room/cyclic edges; stale graph revision; replay write | Atomic rejection, version conflict or idempotent original result; correct audit and no partial edge |
| TP-10 | Private endpoint, restricted viewer, hidden predecessor, forged read-model permission | Denied by Rust; no hidden ID/count/title/timing leak; private API remains service-only |
| TP-11 | Keyboard/screen reader, 375px viewport, long title, reduced motion | Every task opens; readable alternative and text states; focus visible; no page-wide overflow |
| TP-12 | Approve exact submission, refresh all views; request changes; uncertain save | Consistent canonical server state/progress, no optimistic completion or forecast commitment |

## Remaining engineering decisions

The owner settled these on 2026-11-06 as [decisions 62 to 73](PRODUCT.md#decisions-needed). Dependencies need decisions 62 to 66, and the Gantt also needs 67 to 71. Live forecasting, holidays and capacity leveling wait for real use. The contract PR settled the field nullability and endpoint names: `GET /plan` and `PUT /tasks/{t}/plan`, with `duration_days` null or left out for not estimated, which erases any estimate because the command replaces. The 5,000-edge limit counts unfinished tasks' edges, because a finished task's can't be edited and would otherwise fill a room for good, and an edit is refused if its predecessors have over 25,000 ancestor edges when any is being added, to bound the cycle check ([decisions 74 and 75](PRODUCT.md#decisions-needed)). `get_plan` also takes `scope=unfinished` ([decision 77](PRODUCT.md#decisions-needed)), which lists only unfinished tasks and always has `complete` false, because a whole read can be too large for an agent's tool result. A finished task's plan can only lose a canceled predecessor. `task.plan_changed` shows only to someone who sees the whole room.
