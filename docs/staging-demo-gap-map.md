# Staging baseline and demo gap map

*Issue #578. Checked 2026-11-24, 16:00–16:30 UTC; signed-in checklist run 18:21 UTC the same day ([S0](#signed-in-check-s0-2026-11-24)).* This maps the [demo](https://demo.podster.dev) (`apps/demo/index.html`) to what staging runs. The demo's states are mock data, not evidence. Where the demo and `docs/spec/` differ, the spec wins.

Source claims are true at `98fd1b73` (main's tip when written) unless a row says otherwise. Staging runs `a5f42b4a` (below). The only change between the two is `apps/demo/` (#575, #576, #577), so a source claim at `98fd1b73` is also true of what staging runs, apart from the demo itself.

## Labels

| Label | Meaning |
| --- | --- |
| **observed on staging** | Seen on the deployed hosts or in the deployed Workers' metadata, on 2026-11-24 |
| **source only** | Built at `a5f42b4a`, but not seen working on staging in this check |
| **mock only / deferred** | Only the demo has it. No route or contract exists, or the spec defers it |
| **blocked** | Needs a check that couldn't run. The next check is named |

## Deployed revisions

Read with `wrangler deployments list` and `wrangler versions view` (4.157.0) on the account that holds `podster.dev`. Nothing was deployed or changed.

| Worker | Host | Version ID | Deployed (UTC) | Commit | Evidence |
| --- | --- | --- | --- | --- | --- |
| `podster-api-staging` | private, service binding only | `ee44f557-832a-49b2-93d9-1006f91fcc8a` | 2026-11-24 12:03:30 | `a5f42b4a` (inferred) | observed on staging |
| `podster-gateway-staging` | `gateway-staging.podster.dev` | `428983f2-ac5f-4f36-9e57-6ccd23daf65f` | 2026-11-24 12:03:38 | `a5f42b4a` (inferred) | observed on staging |
| `podster-web-staging` | `app-staging.podster.dev` | `27477806-f947-4349-8dd9-c6c71f69de9a` | 2026-11-24 12:03:57 | `a5f42b4a` (inferred) | observed on staging |
| `podster-demo` | `demo.podster.dev` | `b425660c-d7c8-4ba5-ad0b-ea9f7b219b1f` | 2026-11-24 13:47:50 | `063ce68e` or later (not recorded) | observed on staging |

**How the commit is inferred.** Versions carry no tag or message, and no route reports a commit. `scripts/deploy-staging` deploys only origin/main's tip after main's CI passes, API then gateway then web. Main's CI for `a5f42b4a` finished at 12:01:25Z. The next merge (`ecf4cb5f`) landed at 13:13Z. So the 12:03Z deploy can only be `a5f42b4a`. **Next check:** slice S1 below makes this direct.

### Feature availability (deployed metadata, names only)

| Feature | Setting on the deployed version | Evidence |
| --- | --- | --- |
| Sign-in providers | web `SIGN_IN_PROVIDERS` = `github,email`; `/sign-in` shows GitHub and email, no Google or X | observed on staging |
| Email sign-in | gateway `ENABLE_EMAIL_SIGNIN` = `true` | observed on staging |
| Test sign-up | gateway `ENABLE_E2E_SIGNUP` = `true`, `E2E_SIGNUP_SECRET` set | observed on staging |
| Public rooms, Explore | API `PUBLIC_ROOMS` = `true`; `EXPLORE_CURSOR_KEY` set | observed on staging |
| Managed repositories | API and gateway `MANAGED_REPOSITORIES` = `true`; `REPOSITORY_REQUESTERS` = `operators,test-people`; the three App keys set | observed on staging |
| GitHub webhook | `GITHUB_WEBHOOK_SECRET` set; the probe gets 401 `invalid_signature` | observed on staging |
| Release (M6) | API `RELEASES` = `true`; all 12 release secrets are present by name (`CONTENT_*`, `CUSTOM_HOSTNAME_*`, `GITHUB_RELEASE_*`). `RELEASE_PATH_COMPLETE` is `true` in source | observed on staging (settings). Release working end to end: **blocked**, since `e2e/m6-release-staging.mjs` has never run past its first sign-up |
| Operators | `OPERATORS` set | observed on staging |

`docs/staging.md` still says none of the 12 release secrets is set "as of 2026-11-23". The metadata shows all 12 names now. That doc's update is left to its owner.

### Probes

`scripts/staging-probes --webhook-secret-set`: 4 of 4 passed. Without the flag the webhook probe fails, as it should once the secret is set.

## Why signed-in staging was blocked

*Resolved by S0 at 18:21Z: see [below](#signed-in-check-s0-2026-11-24).* The test sign-up (`POST /api/auth/sign-up/e2e`) answered **429 with `retry-after: 6758`** at 16:21Z. Its limit of 40 people a day was used up, so it opens again at about 18:14Z. No test person, room or fixture was made. Following the issue, this map is source-backed for signed-in rows. The [verification checklist](#verification-checklist) lists what to run once sign-up works.

## Route and contract matrix

Web routes are under `apps/web/app`. Gateway paths are the browser's `/api/...` on the app host, forwarded to the gateway and then to Rust. Operation names are from `packages/contracts/openapi.yaml`.

### Creator

| # | Step | Demo behavior | Web route | Gateway / API contract | Role or policy | Evidence | Missing UI, state or data | Label |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| C1 | Welcome: sign in | GitHub, email link | `/sign-in`, `/sign-in/email` | Better Auth on the gateway | anyone | `/sign-in` 200 with GitHub and email | none | **observed on staging** |
| C2 | Welcome: other providers | Google, X, adding an email after X | none | Gateway supports Google if `GOOGLE_CLIENT_*` are set; nothing for X | anyone | `/sign-in` shows neither | Google: provider secrets (owner). X: no source | **mock only / deferred** |
| C3 | Welcome: "what do you want to do first" | Choose creator or contributor | none; `/` redirects to `/attention` | none needed | signed in | `/` 307 → `/attention` | A first-run choice screen | **mock only / deferred** |
| C4 | Workroom setup | One form: owner org, goal, files, roles with counts, review and results | `/workrooms/new` (`create-form.tsx`) | `createWorkspace`, `setWorkspaceBrief`, `createRole`, `createUpload` + `linkFile`, `setReviewPolicy`; later `requestRepository`, `setReleaseConfig` | creating: an admin of the acting org (`/v1/me`); the rest: room owner or admin | anonymous 307 → `/sign-in`. S0: `/workrooms/new` 200 signed in; `createWorkspace` 200 via the API (the form wasn't submitted) | Team presets ("Small/Full team"), files and results in the same form, repository and release choices at creation | **source only** |
| C5 | Fresh room: Planner's first plan | Ask Planner, approve a plan, assign first task | none | Tasks: `createTask`; order: `setTaskPlan`. No "proposed plan" object | requester or human admin plans | none | A plan-proposal state that a person approves. Needs a spec ruling | **mock only / deferred** |
| C6 | Today | Cards: ready for review, agent question, plan, permission request, approved-not-live | `/attention` ("Needs attention") | `readInbox`, `ackInbox`, `listTasks` per room (≤20 rooms), `listReleaseApprovals`, `getTaskReleaseStatus` | signed in; each room read is authorized | anonymous 307 → `/sign-in`. S0: `/attention` 200 signed in, with no cards to show | Cross-room "reviews for me" query (`apps/web/README.md`); a "question" state on tasks; egress permission requests (Runner-local, RUNNER.md) | **source only** |
| C7 | Board / List / Timeline | Stage columns, sortable list, timeline with forecast, drag to reorder | `/w/[id]/tasks?view=list\|board\|gantt` | `listTasks`, `getPlan`, `setPlanStart`, `setTaskPlan` | any member reads; planning per ACCESS-CONTROL rows 48–49 | anonymous 307 → `/sign-in`. S0: `view=list`, `board`, `gantt` each 200; `listTasks`, `getPlan` 200 | Demo stages differ from the spec's five kernel columns; "Timeline" vs spec's "Gantt"; drag isn't in the first version (TASK-PLANNING); tasks have no created time, so no age | **source only** |
| C8 | Task sheet | Task page and sheet, files, messages | `?task=<id>` on the tasks route (`task-sheet.tsx`) | `getTask`, `updateTask`, `assignTask`, `setReviewer`, `sendMessage`, `listMessages`, `linkFile` | per task visibility | S0: `?task={id}` 200; `getTask` 200 | Paging older messages; clearing `due_at` | **source only** |
| C9 | Review: approve or ask changes | Criteria ticks, review agent notes, approve, request changes | task sheet (`task-actions.tsx`) | `verifyTask` (binds `submission_no` and `commit_sha`), `requestChanges` | the task's reviewer | S0: the Sheet renders (200); `verifyTask` and `requestChanges` not run, nothing was submitted | Per-criterion ticks kept across rounds (no state); review agent notes as a separate kind | **source only** |
| C10 | Review: live preview and code view | Try the app, see the diff | none | none (no preview release; diff lives on GitHub) | n/a | none | Preview environment per submission; diff read | **mock only / deferred** |
| C11 | Merge | "Approved. It's in your code now" | task sheet (`task-merge.tsx`) | `mergeTask`, `grantRepositoryAction` (`merge`), `getRepository` | a live `merge` grant; `self_review` / `self_merge` rules | `e2e/m5-staging.mjs` passed on staging on 2026-11-11 at `e6592b8`; not rerun at `a5f42b4a`. S0: `getRepository` 200 for the owner of a room with no repository; a member's `grantRepositoryAction` 403 `not_allowed`; no merge run | The demo merges on approval. Podster never does (AC-17) | **source only** |
| C12 | Ship: release | "Ready to release", live, history | `/w/[id]/settings` (`release-section.tsx`), `/attention` (`release-approvals.tsx`), task sheet (`task-release-stage.tsx`) | `getReleaseConfig`, `setReleaseConfig`, `requestRelease`, `approveRelease`, `declineRelease`, `listReleaseApprovals`, `getTaskReleaseStatus`, app hostname ops | config and approve: room owner or admin, as a person; room must be public | settings observed. S0: `/w/{ws}/settings` 200; `getReleaseConfig` 200 (off, version 0), `listReleaseApprovals` 200, `getTaskReleaseStatus` 200 for the owner; a member's `setReleaseConfig` 403 `not_allowed`. Flow not run | A Ship page; a list of past releases (no read exists) | **blocked** (next: `m6-release-staging.mjs`) |
| C13 | Ship: roll back, failed health check | Go back to release N; health check fails | none | `rollbackRelease` exists, with no UI; no health-check state (static release) | room owner or admin | none | Rollback button; health check isn't in M6 | **mock only / deferred** |

### Contributor

| # | Step | Demo behavior | Web route | Gateway / API contract | Role or policy | Evidence | Missing UI, state or data | Label |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| K1 | Welcome | "Bring a coding agent" choice | none | none | signed in | as C3 | as C3 | **mock only / deferred** |
| K2 | Today: "Allow run" | Approve a run, see time, tokens, hosts | none | none: approval is on the owner's machine (RUNNER.md, decision 29) | the agent's owner, locally | none | Dashboard approval is only a proposed option in RUNNER.md | **mock only / deferred** |
| K3 | Today: role invitation | "Accept with QA Agent" | none | `inviteToRole` (owner side), `claimRole` / `declineRoleInvite` are agent capabilities; `readAgentInbox` lets an org admin see the invite | the agent claims; a person can't claim for it | none | A person accepting for their agent needs a spec ruling and a contract (AC-09) | **mock only / deferred** |
| K4 | Pairing | Pick SDK, name, pair Runner, key in keychain, ask-first, limits | `/pairing/new`, `/pairing/[agent]`, `/agents` ("Add an agent") | `startPairing`, `cancelPairing` (person); `redeemPairing`, `activatePairing` (Runner) | signed-in person in their org | anonymous 307 → `/sign-in`. S0: `/pairing/new` 200 signed in; nothing paired | Run policy and limits are Runner-local and should stay so | **source only** |
| K5 | Role openings | "Find an opening" | `/w/[id]/team` (`role-openings.tsx`) | `listRoles`, `createRole`, `inviteToRole`, `withdrawRoleInvite` | room owner or admin manages | S0: `/w/{ws}/team` 200; `listRoles` 200 | Matching an opening to "your agent that fits" | **source only** |
| K6 | Explore | Open roles in public rooms, "fits", Claim | `/workrooms/explore`, public page `/p/[handle]` | `explorePublicWorkrooms` (signed in), `getPublicWorkroom`, `claimPublicOpening` (agent capability) | Explore needs a session; claims need the agent's participation policy | API 401 `sign_in_required` signed out; `/p/<unknown>` 404 no-store; `PUBLIC_ROOMS` on. S0: `/workrooms/explore` 200 signed in | "Fits" needs agent skill data; Claim from the web isn't possible (agent claims) | **source only** |
| K7 | Run status, live log | Running on a machine, log lines, stop, limit hit | none | none; Podster sees accept, submit and messages only | the agent's owner | none | Runner-local status. Logs stay on the machine and Podster logs IDs only | **mock only / deferred** |
| K8 | Your agents | List, agent page | `/agents`, `/agents/connect` | `GET /api/agents`, `getAgent`, `disconnectAgent`, `reconnectAgent`, `readAgentInbox` | org members list; `getAgent` org admins | anonymous 307 → `/sign-in`. S0: `/agents` 200 signed in, no agents | Rename, last active, room count (README "Still missing") | **source only** |
| K9 | Track record | Approved results, first-try rate | none | none | n/a | none | CONTRIBUTORS-AND-LIMITS: future, unimplemented, gated | **mock only / deferred** |
| K10 | Spend | Weekly spend, caps by agent and room | none | none; budgets are Runner-local (RUNNER.md) | the agent's owner | none | Out of scope (#578: no budget work) | **mock only / deferred** |

**Counts:** 23 rows. Observed on staging 1, source only 10, mock only / deferred 11, blocked 1. Many source-only rows have a signed-out part that was observed (the redirect or 401). S0 then saw their signed-in pages answer 200 (statuses only; see [S0](#signed-in-check-s0-2026-11-24)). Labels are unchanged: a page that renders isn't the step working end to end.

## Access boundaries

### Anonymous, wrong organization, revoked

| Actor | Expected | Evidence |
| --- | --- | --- |
| Anonymous, gateway or app `/api/*` | 401 `sign_in_required`, before any room is read | **observed on staging**: `/v1/me`, `/v1/workspaces/{ws}`, room create, `release-config`, `verify`, `merge`, `releases`, `/v1/pairing`, `/api/agents`, `/v1/public/explore`, `/v1/public/workrooms/{handle}`, `/api/capabilities`, and the app host's `/api/v1/me` |
| Anonymous, app pages | 307 to `/sign-in`; unknown public page 404 with `no-store`, no script | **observed on staging**: `/attention`, `/w/{ws}/tasks`, `/workrooms/new`, `/workrooms/explore`, `/pairing/new`, `/agents`, `/p/pub_…` |
| Signed in, another organization | `workspace_not_found` (404), the same as a random ID, for reads and writes; an `x-podster-org` the person isn't in is refused by the gateway (AC-26, AC-36) | **observed on staging** (S0): with no org header, room, tasks and release-config each 404 `workspace_not_found`, the same as a random room ID. With the room's org header, which B isn't in, the gateway answers 403 `not_allowed` before the room is read. That differs from the checklist's "each `workspace_not_found`" but is this row's AC-36 refusal, and it doesn't say whether the room exists |
| Revoked member | Next read or write answers the room's own refusal (`workspace_not_found` or `access_revoked`); queued work rechecks authority (AC-13, AC-27) | **observed on staging** (S0): after the owner revoked B, B's room read, task read and task create each 403 `access_revoked` |
| Agent, any role label | Never sets release config, never approves a release or rolls back (`not_allowed`); asks for a release only with its own live `deploy` grant, never through a public claim | **source only** (S0 used no agent) |

### Approval, merge and release are three separate decisions

| Step | Operation | Who | What it does | Does not |
| --- | --- | --- | --- | --- |
| Task approval | `verifyTask` | the task's reviewer | Completes the task for one submission and commit (`commit_changed` if the branch moved) | Merge or release anything |
| Merge | `mergeTask` | a participant with a live `merge` grant from the room's owner or admin | Records a merge request; a job merges the approved commit | Happen on approval alone (AC-17). `self_review` / `self_merge` refuse self-reviewed work, except the private-room rule (decision 186, amended 2026-11-20) |
| Release | `requestRelease` → `approveRelease` | asked by a person, or an agent with a `deploy` grant; approved by the room's owner or admin, as a person | Publishes a merged commit of a public room with release on | Start without approval. Rollback is a new release that also needs approval |

The demo's "Approved. It's in your code now" blends approval and merge. The UI must show them as two steps.

## Follow-up slices

Each is one PR. Web slices keep same-origin `/api/*` calls, the gateway's session and org checks, and Rust's authorization. Runner approval and credentials stay local.

| # | Slice | Reuses | Depends on | One acceptance check |
| --- | --- | --- | --- | --- |
| S0 | Run the signed-in checklist below and record it (evidence PR, non-`docs/` branch if a script is added under `e2e/`) | test sign-up, existing routes | sign-up window | Every **blocked** row and the signed-in half of each **source only** row has a staging result |
| S1 | `scripts/deploy-staging` tags each Worker version with the commit (`--tag`/`--message`) | wrangler; no new route | none | After the next deploy, `wrangler versions view` names the commit for API, gateway and web |
| S2 | First-run choice: build or bring an agent, routing to `/workrooms/new` or `/pairing/new` | `getMe`, `/orgs` | none | A new test person sees the choice once; each button lands on its route; a returning person lands on `/attention` |
| S3 | Today: "Needs attention" shows review-ready, approved-not-live and flagged cards | `readInbox`, `listTasks`, `listReleaseApprovals`, `getTaskReleaseStatus` | S0 | A submitted task where the viewer reviews shows as a card that opens its Sheet |
| S4 | Cross-room "reviews for me" read (contract + API) | read model only, never authorizes | S3; contract PRs merge one at a time | With 25 rooms, the one review in room 25 appears |
| S5 | Workroom setup in one guided form | `createWorkspace`, `setWorkspaceBrief`, `createRole`, `createUpload`/`linkFile`, `setReviewPolicy` | none | One submit leaves a room whose read shows the goal, 2 openings and person review on |
| S6 | Task views take the demo's visual rules (monochrome, orange = needs you), spec column names kept | `listTasks`, `getPlan` | owner adds the demo's rules to DESIGN.md | `node run-a11y.mjs` passes and TP-01 holds |
| S7 | Review shows approve and merge as two steps, with the commit and PR link | `getTask` `change`, `verifyTask`, `mergeTask` | none | After approval, the Sheet shows "Approved, not merged" until `merge.succeeded` |
| S8 | Ship tab: release state, approvals and rollback button | `getReleaseConfig`, `listReleaseApprovals`, `getTaskReleaseStatus`, `rollbackRelease` | S0's release run; a release-history read is a contract change | In a local run, Rollback creates a release awaiting approval and shows the server's answer |
| S9 | Contributor Today: role invitations for my agents (read only) | `readAgentInbox`, `GET /api/agents` | none | An org admin sees their agent's `role.invited` with room and role IDs |
| S10 | Accepting a role for my agent | none yet | spec ruling (AC-09) first | Deferred until ruled |
| S11 | Google sign-in on staging | gateway's Google support | owner's provider secrets | `/sign-in` shows Google and one sign-in completes |

Deferred, not sliced: Planner plan proposals (C5), previews and diffs (C10), health checks (C13), run status (K7, Runner-local), track record (K9) and spend (K10).

## Verification checklist

Run once the test sign-up opens again (2 people, the gateway host, cookies never printed):

1. Person A: `GET /api/v1/me`, `GET /api/orgs`, `POST /api/orgs` (a new org), `POST /api/v1/workspaces` in it, `POST .../tasks` naming A as reviewer.
2. A reads: room, brief, roles, tasks, plan, activity, release-config, release-approvals, repository, task, task release-status. Each should be 200, or the documented refusal.
3. A opens on the app host, with `podster-org`: `/attention`, `/workrooms/new`, `/workrooms/explore`, `/w/{ws}/tasks?view=list|board|gantt`, `?task={id}`, `/w/{ws}/settings`, `/w/{ws}/team`, `/agents`, `/pairing/new`. Each should be 200.
4. Person B (another org) reads A's room, tasks and release-config, with and without A's org header. Each should be `workspace_not_found`, the same as a random room ID.
5. A invites B to the org (`POST /api/orgs/{org}/invitations`), B accepts, A adds B as a member. B reads the room (200). B's `PUT release-config` and repository grant should be `not_allowed`.
6. A revokes B. B's room read, task read and task create should be refused with the room's own answer.
7. Sign both out. Record IDs only.

## Signed-in check (S0), 2026-11-24

Run from 18:21Z to 18:22Z with 2 disposable test people from the test sign-up, against the gateway host for `/api/*` and the app host for pages. All 7 steps ran. Only statuses, error codes and IDs were recorded; no cookie, secret or invitation token was printed or kept.

**Deployed versions, read just before** with `wrangler deployments list` (4.157.0), read only: API `ee44f557-832a-49b2-93d9-1006f91fcc8a`, gateway `428983f2-ac5f-4f36-9e57-6ccd23daf65f`, web `27477806-f947-4349-8dd9-c6c71f69de9a`, the same as [above](#deployed-revisions). The demo had moved on: `podster-demo` is `c7a93221-db93-405b-94d9-c07968f90466`, deployed 18:03:37Z. The demo isn't part of this check.

**IDs.** Person A `per_e2e_372f652eef5544339d3747a614e83b1c` (personal org `org_72c2928bf6764447a3d278e98680124c`); person B `per_e2e_bc4378975a484dfd9ab2c21324e2aef3`; A's new org `org_42a6e8a00db4476eb4098ff70d368fc7`; room `ws_032114632b8847528f861b3f872650ef`; task `tsk_b5f6ba14b14747d3bd3dfafff37a9657`; invitation `oin_9273a74660c34d4bbc5a856d4281e66c`. They stay on staging, as other test runs' do.

| Step | What | Result | As expected |
| --- | --- | --- | --- |
| 1 | A: `GET /api/v1/me`, `GET /api/orgs`, `POST /api/orgs`, `POST /api/v1/workspaces` in the new org, `POST .../tasks` naming A as reviewer | all 200; the task names A as reviewer | yes |
| 2 | A reads room, brief, roles, tasks, plan, activity, release-config, release-approvals, repository, task, task release-status | all 11 are 200. release-config: off, version 0. The room has no repository | yes |
| 3 | A on the app host with `podster-org`: `/attention`, `/workrooms/new`, `/workrooms/explore`, `/w/{ws}/tasks?view=list\|board\|gantt`, `?task={id}`, `/w/{ws}/settings`, `/w/{ws}/team`, `/agents`, `/pairing/new` | all 11 are 200, none redirected. Statuses only: page content wasn't inspected | yes |
| 4 | B, in another org, reads A's room, tasks and release-config | without an org header: each 404 `workspace_not_found`, the same as a random room ID. With A's org header: each 403 `not_allowed` from the gateway | **differs**: see below |
| 5 | A invites B to the org, B accepts, A adds B to the room as a member; B reads the room; B's `PUT release-config` and repository grant | invite 200, accept 200 (member), add 200, B's room read 200; `PUT release-config` 403 `not_allowed`; repository grant (push, to B) 403 `not_allowed` | yes |
| 6 | A revokes B from the room; B reads the room and the task, and creates a task | revoke 200; each 403 `access_revoked` | yes |
| 7 | Sign both out | both 200; `GET /api/v1/me` then 401 for each | yes |

**Finding, step 4.** The checklist expected `workspace_not_found` with A's org header too. The gateway refuses an `x-podster-org` the person isn't in with 403 `not_allowed` before any room is read (`personIdentity` in `apps/gateway/src/index.ts`), as the access table's AC-36 note says. That answer doesn't depend on the room, so it leaks nothing about it. The checklist's wording was wrong, not staging.

**Not covered.** Page content, the forms' own submits and any browser run; review, merge and release flows (C9, C11, C12 stay as labeled, and C12's next check is still `m6-release-staging.mjs`); agents (the agent row and K-rows that need one). S0 removed B from the room only: B is still a member of A's org. Sign-ups used: 2 of the day's 40.

