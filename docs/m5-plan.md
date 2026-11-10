# M5 plan

**Status, 2026-11-10 UTC: Proposed, and implementation has started.** The owner told the architect on 2026-11-10 to start M5's implementation. That isn't an approval of this plan's proposals or of ADR 0009, which stays proposed, and nothing under [what needs the owner's yes](#what-needs-the-owners-yes) is answered by it. Step 2 is built, as its row in the [build order](#build-order) says: the room's state and a read of it, with no agent capability and no call to GitHub. Step 1 is drafted: [ADR 0009](adr/0009-managed-repositories.md) is written as a proposal, not accepted, and [the spike has run](../spikes/m5-github/README.md#results-2026-11-10) twice against the test organization, without webhooks. The spike's merge-restriction run is in [its own results](../spikes/m5-github/README.md#results-merge-restriction). The ADR's choices are proposals, recorded as [decisions 179 to 189](spec/PRODUCT.md#m5-proposals-november-10-2026). The gate, M5-03, M5-06, M5-12, the threat model, steps 4, 6 and 7 and questions 2, 3, 6, 7 and 11 below are reworded to match the ADR, and the ADR lists [where the spike disagreed with this plan](adr/0009-managed-repositories.md#where-the-specs-and-the-spike-disagree). The architect drafted this plan from the specs. Its [questions](#questions-for-the-architect) carry the architect's proposed answers, which aren't recorded as decisions in `PRODUCT.md` yet. Items marked **owner's yes** create an account or a cloud resource, cost money, set a secret, or are legal text, so the architect can't settle them alone.

It covers [M5 Managed repositories](spec/PRODUCT.md#product-direction-and-delivery-scope): a GitHub App, a repository linked to a room, review bound to a commit, and merge. Its gate is [expanded criterion 7](spec/PRODUCT.md#expanded-workroom-acceptance-criteria) for repositories. It starts from the [managed repositories design](spec/ARCHITECTURE.md#managed-repositories-and-merge-m5), which is itself proposed, and from decisions 10, 18 and 25, which are proposals too. Decision 10 leaves agent access to the M5 ADR.

M5 is the first time Podster holds authority over something outside itself and hands part of it to agents. So the plan proves on GitHub what a token can and can't do before any feature code.

## Where M3 and M4 stand

M5 starts while two earlier gates are still open. Neither blocks M5's planning or its spike, and `PRODUCT.md` already says M5 can ship later for engineering rooms.

- **M3's gate** isn't called. It still waits on the owner's approval of fasta2a and the compatibility kit.
- **M4's gate** isn't called. Step 14's code is merged and on staging at `17563d1`, and `EXPLORE_CURSOR_KEY` is set. The staging run hasn't happened. On 2026-11-10 the owner had `PUBLIC_ROOMS` switched on for staging; the test operator isn't in `OPERATORS` yet, and the takedown contact is a placeholder.

Contract and migration PRs still merge one at a time, so M5's step 2 waits for any M3 or M4 PR that changes them.

## What M5 includes

- **A repository per Git-enabled room:** when an authorized person sets up a room that needs Git, Podster's server creates a repository in a dedicated Podster-managed GitHub organization and links it to that room. Rooms that don't need Git get none.
- **Repository visibility of its own:** it doesn't follow the room's visibility. [ADR 0009](adr/0009-managed-repositories.md#visibility-and-the-plan) proposes public as the working assumption while the organization is on GitHub's Free plan, said plainly at setup, with private shown as unavailable until the owner buys a plan.
- **Grants:** an agent or reviewer gets repository access only through an explicit grant for that repository and those actions, made by someone who holds the delegation.
- **Agent access:** `get_repo_access` returns a short-lived token for that one repository, with the least permissions the task needs.
- **Review bound to a commit:** a submission on a linked task records its commit, and approval fails if the commit has changed.
- **Merge as its own step:** `merge_task` merges exactly the reviewed commit, through a job that rechecks authority. Approval and merge are separate events, and a failed merge is a visible state.
- **Status:** `get_task_release_status` reports checks and merge independently, including failure.
- **Screens:** the Git option in room setup, the repository's state in the room, grants in Manage access, and a task's change and merge state.

Not in M5: deployment and release (M6), Runner and its local clone (M7), linking a repository that already exists, forks, any provider other than GitHub, and anything in production. M5 ends on staging, like M1 to M4.

## The gate

From the specs. Nothing may say managed repositories work until all of these pass on staging:

- **Expanded criterion 7, for repositories:** engineering work links a managed repository with separately configured visibility, and checks and merge are reported independently, including failure. The deployment half is M6's. M5 shows only that with deployment disabled, nothing is published.
- **Access tests** that name repositories, grants or merge, on a deployment: AC-05 for provider-resource IDs, AC-10, AC-11, AC-13, AC-16 for a provider's refusal, AC-17, AC-27 and AC-31.
- **The token boundary, proven on GitHub:** a token from `get_repo_access` can't merge to the default branch, can't reach another repository, and can't administer the repository. The spike saw all three, the first only under [ADR 0009's two rulesets](adr/0009-managed-repositories.md#the-merge-path) and only on the paths it tried: the merge call, a commit through the contents API and a ref update through the API. The gate needs it shown again on staging, with `git push` over HTTPS added.
- **M5's own tests,** [below](#acceptance-tests).
- **A security review** of the built system against the [threat model](#threat-model), with the result written into this plan.

The architect proposes the gate call, for the owner to review.

## What M5 needs from earlier milestones

- **M0:** the task lifecycle, the revocation fence, the outbox and its jobs, and idempotency.
- **M1:** room roles, the lead, scoped access, and Manage access, where grants will appear.
- **M2:** numbered submissions and exact-version review. Commit pinning follows the same rule for code.
- **`crates/egress`:** the outbound request policy and signing. Every call to GitHub goes through it.
- **Nothing from M3 or M4.** An A2A agent or a public participant gets no repository authority from its protocol or its claim (AC-24). M5 adds no public surface.

## Build order

**Proposed.** Each step is one PR unless it says otherwise. Steps 2 onward wait for the spike's result.

| Step | What | Notes |
| --- | --- | --- |
| 1 | **ADR 0009 and the spike.** The ADR settles everything the architecture leaves "open for the ADR". The spike ran against `podsterx` and then `podsterdev`, and answers the [risks](#risks-to-test). | **Drafted, 2026-11-10.** [ADR 0009](adr/0009-managed-repositories.md) is a proposal: it settles or leaves open each item by name, and it proposes the merge path from the spike's [merge-restriction run](../spikes/m5-github/README.md#results-merge-restriction). [The spike ran](../spikes/m5-github/README.md#results-2026-11-10) against `podsterx` and answered every risk except webhooks (risk 8). Its [three-Apps run](../spikes/m5-github/README.md#results-three-apps) was on `podsterdev`. The spike's code stays in `spikes/` and nothing builds on it. |
| 2 | **Contracts and migration:** `repo_link`, `provider_grant`, `task_change` and a provisioning request, with `get_repo_access`, `get_task_release_status` and `merge_task` in `capabilities.yaml` and their routes in `openapi.yaml`. The room's Durable Object owns all four as state, because grants are authority. D1 gets at most a projection for lists, which never authorizes. | One contract and migration PR at a time. **Built, 2026-11-10, in part,** and checked locally only: the room's five tables and the person-only repository read. **The three capabilities and their routes aren't in it.** `get_repo_access` ships with step 6, `merge_task` with step 7 and `get_task_release_status` with step 8, each as its own contract change with its code. [What was built and what wasn't](#step-2-what-was-built) is below. |
| 3 | **Decisions in `crates/core` and `crates/policy`:** grant checks, `commit_sha` required on `submit_task` and `verify_task` for a linked task, `commit_changed`, and merge as its own state. Pure, with no I/O. | AC-31 is decided here, and AC-17's rule that approval alone never merges. **Built, 2026-11-10,** as pure decisions with their tests, checked locally only. Nothing calls them yet. **Granting is the room owner's alone:** an admin has room authority and not the repository's delegation. **Revoking** is the owner's, an organization admin's, or the holder's for their own. [What was built, the architect's rulings and what later steps own](#step-3-what-was-built) is below. |
| 4 | **Provisioning:** room setup records a request; a job creates the repository, sets its protections and records the verified repository ID. Pending, ready, failed and uncertain states for the request, and ready, degraded and suspended for the link. An unknown outcome is a failed setup: nothing is adopted by name, and a retry uses a new server-generated name. | A failed setup blocks coding tasks in that room, not other work. **Owed here, from step 5's review:** provisioning owns `repo_room_index`. It writes a room's row when the link is made, repairs a row that's lost or held by another room, and removes the row when a link ends. Step 5 only writes the row once, from the room's alarm, and a room that loses to an existing row is marked and never retries, so a dead room's row can block its successor's webhooks until this step fixes it. The lookup never authorizes, so what's lost is nudges, and polling still observes state. |
| 5 | **Webhooks:** the gateway verifies GitHub's signature and passes a normalized observation to the room's Durable Object, which records it with its observation time. A job polls when state looks stale. | A new public route on the gateway. It authenticates the sender and decides nothing. **Built, 2026-11-10, in part,** and checked locally only: the route, the signature check, the nudge and the routing lookup. **The job that polls isn't built,** because it reads GitHub, and no step before 6 holds a token to read with. Only the decision of when a change is stale and the hourly read cap are built, as pure functions nothing calls yet. It adds a room migration and a D1 migration. **A delivery passes only IDs, the event's kind and one commit onward, and writes only `nudged_at`.** The head, checks and merge state are read from GitHub by steps 6 to 8; the brief for this step listed more fields, and the narrower reading was ruled right. **Ruled by the architect, 2026-11-10:** recording a nudge is bookkeeping, not a command, so it needs no event, outbox row or idempotency record. The later read that records what GitHub says is a command, and commits state, event and outbox together. [What was built and what wasn't](#step-5-what-was-built) is below. |
| 5b | **Grant and revoke commands:** the routes in `apps/api` that give and take back a `push` or `merge` grant on the room's repository, with their contract entries. They call step 3's decisions, and the removal and ownership commands call its two revocation decisions. | **Ruled by the architect on 2026-11-10:** its own step, before step 6, since step 6 can't issue a token without a grant. Person-facing only, with no agent tool. A contract PR, so it merges one at a time with the others. **Built, 2026-11-10,** and checked locally only: give, take back and list grants, and both cascades. [What was built and the judgment calls](#step-5b-what-was-built) are below. |
| 6 | **`get_repo_access`:** the private Rust API mints a token for one repository after rechecking the task and its run, the fixed deadline and budget, the agent's assignment and connection, room access, the exact repository and installation, the grant and the provider permissions. Renewal runs the same checks. | Tokens never reach events, logs, D1 or the gateway's storage. The room's Durable Object holds each one sealed for at most its hour, for revocation only, as ADR 0009 proposes. AC-27. This step adds the capability and its route to the contract. **Open ruling for this step:** whether `get_repo_access` takes an idempotency key. A stored answer would hold the token, which must rest nowhere but the sealed copy, and no key leaves a retry to the one-live-token rule. |
| 7 | **`merge_task`:** the job rechecks authority, re-reads the pull request's base, head repository and head commit and refuses on any difference from the reviewed values, marks the reviewed commit, merges with its `sha` as a merge commit, confirms the default branch contains it, and records success or failure. A changed commit leads to a follow-up task, as decision 25 proposes. | Under ADR 0009's two rulesets, only the merge App can update the default branch. A retry reads the pull request's merged state, since a second merge call answers `200`. This step adds the capability and its route to the contract. **It must deliberately revisit AC-17's assertion in `e2e/journey.mjs`,** which fails today if any tool an agent sees is named for merge or deploy. A merge tool will exist from this step on. The property to keep is that approval alone never merges, and only an authorized `merge_task` does. That change gets a deeper review. **Order of checks:** the route must run policy's `authorize_merge`, which hides a task the caller can't see, before core's `check_merge_authority`, because core answers `task_not_linked` and `repo_not_ready` before it looks at the grant. The same holds for step 6 with `authorize_repo_access` and `decide_access`. |
| 8 | **`get_task_release_status`:** checks and merge state, each with its own observation time. | Reports that no release exists; M6 adds releases. This step adds the capability and its route to the contract. |
| 9 | **Screens**, in two PRs: (a) the Git option in room setup and the repository's state; (b) grants in Manage access and a task's change and merge state. | Unavailable grants show as unavailable, never silently provisioned. |
| 10 | **Staging run and security review,** then the gate call. | A script against staging with test people, in `podsterdev`. |

### Step 2: what was built

**Built:**

- **The room's state.** One forward-only migration of the room's Durable Object adds five tables, all empty until a later step writes them:
  - `repo_request`: the room's one request, with its state (`pending`, `ready`, `failed`, `uncertain`), the chosen name and visibility, a reason code, and the repository ID once GitHub has answered.
  - `repo_request_attempt`: one row for each creation call, with the name it sent and its outcome. A retry under a new server-generated name adds a row and overwrites none, so the operators keep the list of names an orphan could have.
  - `repo_link`: the room's one repository, with GitHub's repository ID and the organization's ID, the default branch, its status (`ready`, `degraded`, `suspended`) and when its rules were last read back.
  - `provider_grant`: one row for each principal, repository and action (`push` or `merge`), with who delegated it and when it expires or was revoked. A principal holds at most one grant that isn't revoked for an action.
  - `task_change`: one row for each task, with its pull request number and state, the reviewed commit and the base it was reviewed on, the observed head and the repository it's in, the base branch, the base observed at the merge, and checks and merge state, each with its own observation time. Checks and the pull request's state are null until Podster has read them.
- **The read.** `GET /v1/workspaces/{ws}/repository` answers the room's request and repository from its own tables, for a person who sees the whole room. An agent is refused. It authorizes nothing. It's in `openapi.yaml` with its schemas, and it isn't an agent capability.
- **In `crates/core`,** the names of those states, the rule that only a ready link allows a token or a merge, and what counts as a full commit ID. Nothing calls the last two yet.

**Not built, and left to the step named:**

- **`get_repo_access`, `merge_task` and `get_task_release_status`:** steps 6, 7 and 8. None is in `capabilities.yaml`, `openapi.yaml`, the gateway or the API. A first version of this step listed them as capabilities that always refused. `e2e/journey.mjs` rejects any merge or deploy tool an agent can see (AC-17), and the architect ruled that the assertion stands: no agent sees a merge tool before the merge path and its checks exist.
- Any call to GitHub, any token, any merge, any provisioning job, the webhook route and every screen: steps 4 to 9.
- **A way to ask for a repository.** The contract has the request's state and no command that records one. Step 4 adds it with its code. Step 9(a) needs that command's shape before it can build the Git option.
- **Grant checks, the submitter rule and commit pinning for a linked task:** step 3. No route reads or writes a grant yet. An expired grant still counts as the principal's one grant until it's revoked. So step 3 must revoke an expired grant when it grants again.
- **The organization's provisioning delegation** (AC-10, M5-14). The specs put it at the organization, outside the room: ACCESS-CONTROL.md asks for a "current GitHub organization-specific provisioning delegation" and says setup "requires existing organization/installation delegation", and the architecture calls App installation and credential provisioning "separate setup". So `provider_grant` holds only `push` and `merge` on a room's repository, each with who delegated it. No spec says where the organization's delegation is stored. Step 4 decides that, outside the room, and checks it before a request is recorded.
- **A size cap on `checks_json`.** Check names come from the provider. The step that first writes the column, 5 or 8, must cap its size.
- **A pull request number on `submit_task`.** ADR 0009 has the assigned agent name the pull request there. `SubmitTask` is unchanged, and the step that records a `task_change` adds it.
- **Storage for sealed tokens and for accepted webhook deliveries.** Each comes with the step that uses it, 6 and 5, as earlier milestones added storage with the code that used it.
- **A D1 projection.** ADR 0009 allows a lookup from a repository ID to its room, to route a webhook. Step 5 adds it if it needs it. Nothing reads D1 for repositories today.

**Checked:** the workspace's Rust tests, the API's and the gateway's suites, the contract check and the local journey, all locally. Nothing ran against a deployment, so no acceptance test counts as passed.

### Step 3: what was built

Pure decisions in `crates/core` and `crates/policy`, with no I/O, no clock and no randomness. No route, migration or contract changed, so nothing calls them yet.

**Built:**

- **Grants** (`core::repo_grants`, `policy::repositories`).
  - **Giving** a grant is the room owner's alone. It needs room authority, which a human owner or admin has, and the repository's delegation, which only the owner holds, as a person whose owner authority still holds. So an admin gets `no_provider_delegation` (AC-10), and someone with a delegation who doesn't administer the room gets `not_allowed` (AC-11).
  - **Taking one back** follows ruling C below: the room's owner, a person who administers the room's organization, or the holder for their own.
  - A grant goes to a current participant, person or agent. It may carry an expiry, which must be in the future.
  - Granting again after an expiry, with a new expiry, or over a row an earlier owner gave, revokes the old row and adds one in the same transaction, since step 2's index counts an expired row as the principal's one grant. Granting the same thing again changes nothing.
  - A grant counts only while it's live, held by that principal, for exactly that action on exactly the room's own repository, and given by whoever holds the delegation now: `grant_required`, `grant_expired` or `grant_stale` otherwise (AC-05, ruling B).
  - Two decisions name the grants to revoke: every grant a removed participant holds, and, when ownership moves, every grant the new owner didn't give. The commands that call them are in `apps/api` and aren't changed here.
  - Someone in the room through a public claim uses no grant, checked at every use and not only when granting: `public_participant`.
- **Commit pinning** (`core::decide`). On a linked task, `submit_task` and `verify_task` take only a full commit ID. Approval fails with `commit_changed` when its commit isn't the submission's or the observed head has moved (AC-31, M5-08). Approval is one event and asks for no merge (AC-17).
- **Merge** (`core::repo_merge`).
  - Asking for a merge needs a requester who is still in the room and connected, a ready repository, a requester not controlled by the submitter's person (`self_merge`, ruling A), a `merge` grant that counts, and the approved submission with its commit. Who is asking and the grant are checked before the task's review, so an approved task without the grant is refused like any other (AC-17, M5-10).
  - The same check runs again in the job. A requester removed from the room since asking fails the merge with `access_revoked`, though their grant row survives.
  - The merge state moves `not_requested` or `failed` to `requested`, and `requested` to `succeeded` or `failed`.
  - **Success is bound to an observation.** Only the authority check makes the proof the job's step decision needs, and only that step decision makes the proof the move to `succeeded` needs, for that same task. So no success is recorded without a recheck and a read of GitHub behind it.
  - The job's next step comes from a fresh read of the pull request. Any difference in base branch, head repository or head commit fails the merge with nothing marked. A moved base still merges and is reported. Success is read only from the pull request's merged state and the default branch holding the reviewed commit, never from the merge call's answer.
  - A changed head is `merge.failed` with `commit_changed` (M5-09), and asking again is then refused: the way on is a follow-up task (decision 25). Other failures can be asked for again.
  - A merge GitHub shows that Podster didn't ask for, or of a commit nobody approved, gets its own reason code. The approved commit is read from the task itself, never handed in.
- **An agent's token** (`core::repo_access`): the pure part of `get_repo_access`. It checks the agent, its room access and connection, its assignment, the linked and accepted task, the ready repository, the deadline, the budget and a `push` grant that counts. A refusal means nothing is asked of GitHub (M5-05). A renewal is the same decision (M5-07, AC-27).
  - The room's held token is returned until 5 minutes before it expires, and only under the grant row it was minted for. After a re-grant a new one is minted. So an agent has one live token for a task.
  - The deadline is one of three: a time, explicitly none, or unknown. Unknown refuses, `deadline_unknown`. The budget is the same, `budget_unknown`.
  - GitHub's answer must name exactly the one repository and the three permissions asked for.
- **Setup rules** (`core::repositories`): only a ready link lets coding work go on, and a failed, uncertain, pending, degraded or suspended one answers `repo_not_ready` with its reason. A task with no linked repository is never blocked (M5-15). A retry resumes on a repository whose ID Podster holds, and otherwise needs a new, valid name that no earlier attempt sent (M5-03). A repository's name is validated as ADR 0009 says.
- **Visibility** (`policy::repositories`): the room's repository is seen by a person who sees the whole room, a grant by a human owner or admin and by its holder, and a task's change by whoever sees the task.

**Order of checks, for steps 6 and 7.** A route runs the policy function, `authorize_repo_access` or `authorize_merge`, before the core decision. Policy answers `task_not_found` to a caller who can't see the task. The core decisions answer `task_not_linked` and `repo_not_ready` before they look at a grant, so run alone they'd tell such a caller something about the task.

**Rulings, proposed by the architect on 2026-11-10.** They aren't in `PRODUCT.md` yet.

- **A. The submitter rule compares controlling people, not IDs.** A person controls themselves, and an agent is controlled by the person who owns it. A merger's controlling person must differ from the submitter's. So the submitting agent's owner, and any other agent of that owner, are refused with `self_merge`, as the submitter is. This is what M5-10's "a reviewer can't merge their own work" means: a reviewer may merge what they approved only with a merge grant and only if a different person controls them. Someone whose controlling person the room can't name is refused.
- **B. A grant rests on its giver.** It counts at use only if whoever gave it, the row's `delegated_by`, is still the current delegation holder and that holder's authority still holds. A room whose ownership moves has no usable grants until the new owner grants again, and the old rows are revoked.
- **C. Who takes a grant back.** The room's owner may revoke any grant. A person who administers the room's organization may revoke any grant, so one can be pulled when the owner has left. A grant's holder may drop their own. Nobody else, and an agent never revokes another principal's grant.
- **D. Removing a participant revokes their grants.** Someone who comes back holds nothing until they're granted again.

**Choices made where the specs were open,** each the reading closest to ADR 0009:

1. The delegation is the current room owner's alone. No spec lets an owner pass it on, so an admin can't grant.
2. A grant can be given while the link is degraded or suspended, since nothing uses it until the link is ready. With no link it's refused, `repo_not_linked`.
3. `get_repo_access` is for agents only, and only for the task's assignee while the task is accepted.
4. A held token is replaced 5 minutes before its expiry. ADR 0009 says "near expiry" and gives no number.
5. `merge_task` doesn't consult the last observed head. The job's own read decides, so a moved head is a recorded `merge.failed`, as M5-09 asks, and never a refused request.
6. After a `commit_changed` failure, `merge_task` on that task is refused for good, even if the branch is later put back.
7. A merged pull request counts as success only once the default branch is seen to hold the reviewed commit. Until then the job reads again.
8. `grantee_public`, when granting, isn't counted as a refusal of authority: the giver has the authority and named the wrong grantee. `public_participant`, at use, is.

**Left as a named refusal, because no spec decides it:**

- **A grant to someone in the room through a public claim** is refused, `grantee_public`, and such a participant uses none, `public_participant`. AC-24 says a claim brings no repository authority, and nothing says whether an explicit grant may.

**Gaps, passed to the steps that need them:**

- **The deadline and the budget.** No spec says what a task's fixed deadline is on the server or where a budget is kept, and RUNNER.md lists server-trusted deadlines as unresolved. Step 6 must rule on both, and must pass "explicitly none" on purpose: until it does, the honest input is unknown, which refuses every token.
- **Who controls an agent.** Ruling A needs the owning person of each agent, read by the room. Steps 5b and 7 must supply it from the agent's `Principal`.
- **How many times the merge job reads again** before giving up isn't decided here. Step 7 owns the cap.

**Not built, and left to the step named:**

- **Step 4:** the command that records a request, the organization's provisioning delegation, the provisioning job and its creation-answer handling, generating a retry's name, and whether a blocked coding task can still be created or accepted.
- **Step 5b:** the commands that give and take back a grant, with their routes and contract entries. Also calling the two revocation decisions from the removal and ownership commands in `apps/api`.
- **Step 6:** the capability and route, reading the inputs from the room and the agent's `Principal`, minting, sealing, the alarm, revocation on a refusal, and the idempotency ruling.
- **Step 7:** the capability and route, recording `task_change` and its pull request, the outbox job that calls GitHub, the events, and AC-17's assertion in `e2e/journey.mjs`.
- **Step 8:** the status read.
- **Steps 5 and 7:** recording an observed merge with its reason code.

**Checked:** the workspace's formatting, lints and Rust tests, and the API's suite, locally. Nothing ran against a deployment, so no acceptance test counts as passed.

### Step 5: what was built

**Built:**

- **The gateway's route, `POST /webhooks/github`,** on the gateway's own host and never the application's. It checks `X-Hub-Signature-256`, an HMAC-SHA256 of the raw body under `GITHUB_WEBHOOK_SECRET`, in constant time. It refuses a missing, malformed, doubled or wrong signature (`401`), a body over 256 KB (`413`, without reading past the limit; that delivery's nudge is lost, and the staleness poll is what notices the change), any method but `POST`, a delivery ID that isn't a short plain one, and any event but `pull_request`, `check_run` and `status` (`422`). A signed `ping` is answered and goes no further. **With the secret unset, or shorter than 32 characters, it refuses everything** with the same `404` as a path that isn't there. No deployment has the secret, so the route is closed everywhere today.
- **It sits behind the gateway's per-client rate limit,** like every other route, before the signature is looked at.
- **What it passes on:** the delivery ID, the SHA-256 of the raw body, the event's kind, GitHub's repository ID, up to ten pull request numbers and one commit SHA. Nothing a person typed: no title, body, branch name, URL, login or state. It logs the delivery ID and a fixed code, and only once the signature is known to be good.
- **A new assertion from the gateway to the API,** `kind: provider_delivery`, which names no one and carries the SHA-256 of the exact body sent. `crates/assertion` verifies it for the one new API route, `POST /v1/provider/github/deliveries`, and every other route refuses it. That route refuses an identity's assertion and the public page's.
- **The routing lookup,** `repo_room_index` in the API's D1 database: provider, repository ID and room ID. It authorizes nothing. A room writes its own row once, from its alarm, after its link exists, and a repository ID another room already holds stays with that room.
- **The room's side.** The room's own `repo_link` decides whose repository a delivery is for; anything else is dropped with nothing written. A delivery that names a pull request or a commit of a task's change sets `task_change.nudged_at`, and that is all it does. Such a delivery is taken once and remembered 7 days, in a new `provider_delivery` table, pruned when a delivery arrives and by the room's alarm. Rulings from the deeper review:
  - **Once means by its ID or by the hash of its body.** GitHub's signature covers the body and not `X-GitHub-Delivery`, so one captured delivery could be sent again under any number of new IDs. The same body is the same delivery.
  - **A delivery about nothing the room knows leaves no row,** so a busy repository's checks and statuses for other commits can't fill the table.
  - **A full table never loses a nudge.** At 10,000 remembered deliveries the room still marks the change and doesn't remember the delivery. Its replay then costs at most one more read, which the per-repository read cap bounds.
- **In `crates/core`,** as pure functions: what makes a nudge well-formed, the order in which the room refuses one, when a change is stale (never read, nudged since its last read, or its polling wait is over, backing off from 1 minute to 1 hour), and the cap of 60 reads an hour for one repository. The last two aren't called by anything yet.
- **The contract:** the route in `openapi.yaml`, under a new `provider_only` list in `capabilities.yaml`, which `check.mjs` holds to the delivery assertion. No agent capability and no tool.

**Choices made where the specs disagreed or were silent, each the reading closest to ADR 0009:**

- **A delivery records no state.** The plan's row says the room "records" a normalized observation, and ADR 0009 says a delivery is a nudge and what's recorded is what Podster's own read returned. So the head, checks, merge and pull request columns are untouched by a delivery, and only `nudged_at` is written. The commit a delivery names is used to find which change to read again, never stored as its head.
- **No state, merged flag or base branch is passed on,** although a normalized observation could carry them. ADR 0009 lists IDs and commit SHAs only and says no branch names, and nothing here would use them.
- **The installation ID isn't passed on,** though ADR 0009 lists it. The room's link doesn't hold one to check it against. The step that stores it can add it.
- **No event, outbox row or audit entry for a nudge,** as the architect ruled: it's a mark that a read is due, which no participant sees, like `indexed_at`. The delivery's row and `nudged_at` commit in one transaction.
- **The read isn't queued.** `nudged_at` is the durable mark that a read is due, and the stale decision reads it.
- **`ping` is answered `200`** after its signature checks out, so setting up the App's webhook doesn't show a failed delivery. It reaches nothing.
- **Every delivery that passes the assertion gets the same `202`** from the API, whether a room took it or not, so the answer says nothing about which repositories are managed.
- **The pure decisions are in a new file in `crates/core`,** `provider_deliveries.rs`, with one line added to `lib.rs`, since `crates/core` is where decisions go. Step 3 works in that crate at the same time, in other files.

**Not built, and left to the step named:**

- **Any read of GitHub, the polling job and the count of reads against the cap:** steps 6 to 8, which hold the tokens. Until one of them reads, a nudge marks a change and nothing acts on the mark.
- **Writing, repairing and removing routing rows properly:** step 4, as its row now says. Today a lost row, or one another room holds, means that room's deliveries are dropped and polling is what catches up. It fails closed.
- **Deploy order.** The API must not be deployed before D1 migration `0007_repo_room_index.sql` is applied to its database: the delivery route reads that table, and fails closed without it. `docs/staging.md` says so.
- **The webhook secret, and switching webhooks on for the staging Apps.** The owner sets `GITHUB_WEBHOOK_SECRET` on the gateway with `wrangler secret put`, and the Apps' webhook URL and events are a change to the Apps, which is the owner's yes. Nothing was set or changed.
- **A second secret for rotation.** ADR 0009 has the gateway accept the old and new secrets for an overlap. One secret is read today.
- **Which events GitHub actually sends, how late, and what a redelivery looks like** (risk 8) are still unverified. Nothing here ran against GitHub.
- **A size cap on `checks_json`** is still owed by the step that first writes that column, which is now step 8.

**Checked:** locally only, as the PR lists. Nothing ran against a deployment, so M5-11 and M5-16 don't count as passed.

Steps 3, 5 and 9(a) can run side by side after step 2. Steps 4 to 7 are security-sensitive: a provisioning credential, a new public route, token issuing and merge. Each gets the deeper review the owner has already agreed for security-sensitive steps; anything deeper than that is asked first.

### Step 5b: what was built

Three person-only routes on the room's Durable Object, the two cascades, and their contract entries. No migration: step 2's `provider_grant` holds everything.

**Built:**

- **`POST /v1/workspaces/{ws}/repository/grants`, `grantRepositoryAction`:** `{ policy_version, principal_id, action, expires_at? }`.
  - Only the room's owner, as a person whose owner authority holds. An admin gets `no_provider_delegation`, and anyone else in the room `not_allowed`.
  - The grantee must be a current participant, `grantee_not_participant`, and not a public participant, `grantee_public`.
  - With no link it answers `repo_not_linked`. A degraded or suspended link still takes a grant.
  - Granting the same again changes nothing. A new expiry, an expired row or an earlier owner's row is revoked and replaced in the same transaction.
  - Audited as `repo_grant.given`, which moves the policy version, and the participant is told.
- **`DELETE /v1/workspaces/{ws}/repository/grants/{grant}`, `revokeRepositoryGrant`:** `{ policy_version }`.
  - Allowed for the owner, a person in the room who administers its organization, or the holder for their own.
  - A grant the caller may not see answers `grant_not_found`, as a missing one does. A second revocation changes nothing.
  - Works in an archived room. Audited as `repo_grant.revoked`, and the holder is told.
- **`GET /v1/workspaces/{ws}/repository/grants`, `listRepositoryGrants`:** the grants that aren't revoked.
  - A human owner or admin sees all of them, and anyone else their own (`sees_grant`).
  - `state` is `live`, `expired` or `stale`. It's for showing, and authorizes nothing.
- **Cascades (rulings B and D).** Each runs in the command's own transaction, with an audit entry and an event for every row.
  - Every removal runs through `remove_member`, including an agent's withdrawal and global disconnect, so each one ends the participant's grants (`member_removed`). The removed participant is told only of the removal.
  - Handing the room over, and recovering it, end every grant the new owner didn't give (`owner_changed`). Recovery also ends what the former owner held, since they have no place in the room afterwards.
- **Two policy additions**, since no decision covered them:
  - `denied_change_name` names the two commands, so refusals are kept as denials.
  - `can_see_event` shows a grant's events only to a human owner or admin, the holder and whoever acted, as `sees_grant` does for the list. A member who sees the whole room doesn't learn who holds a grant.

**Judgment calls:**

- **Agents call none of these, even to revoke their own grant.** That needs the owner or an organization's admin until an agent route exists.
- **An organization's admin revokes only from inside the room.** One outside it recovers the room instead, which ends the former owner's grants. Meanwhile none of them counts, since the delegation holder is gone.
- **Both commands take `policy_version`,** as every access change here does. Each audit entry moves it.
- **The list is its own route, not part of the repository read.** That read is for people who see the whole room, and a grant's holder sees their own without that.
- **`state` in the list takes the delegation holder from the room's record:** the owner, unless the room records that they left. A command takes it from the caller's resolved authority instead.
- **An owner leaving their organization revokes no rows.** Ownership hasn't moved, and `check_grant` already refuses such grants as `grant_stale` until recovery ends them.
- **A replay of a stored grant answer goes only to someone who may still grant.** A revocation's answer replays like any other command's.

**Not built, and left to the steps named:** using a grant (tokens, step 6; merges, step 7), and the screens for grants (step 9(b)).

**Checked:** the workspace's Rust tests, the API's and the gateway's suites, the contract check and the local journey, all locally. Nothing ran against a deployment.

## What needs the owner's yes

- **A GitHub organization for managed repositories.** **Answered by the owner on 2026-11-10:** "podsterx no longer exist.. the organization is now https://github.com/organizations/podsterdev/settings/apps you can create the app there". Earlier the same day the owner had said that `podsterx` was for tests and tests never ran against `podsterdev`. **The architect's reading, not the owner's words:** the new sentence replaces that one, and with no production deployment, `podsterdev` serves staging. Its ownership and legal terms are still open, and may need a lawyer. **Open, and the architect's, not the owner's:** before any production deployment, whether staging and production share `podsterdev` or get separate organizations or Apps.
- **The GitHub Apps:** three, as ADR 0009 proposes: one that provisions, one that issues agent tokens, and one that merges. **Done on 2026-11-10:** the owner said "you can create the app there", and the architect created and installed three in `podsterdev`, in the owner's browser. Any change to their permissions is the owner's yes. The spike's two Apps on `podsterx` aren't used again; that organization's state was unconfirmed after the owner said it no longer exists.
- **Public managed repositories on staging.** takedown.md's staging exception covers `PUBLIC_ROOMS`, not repositories.
- **Secrets:** each App's private key, the webhook secret and the token-sealing key. The owner sets them with `wrangler secret put`; the architect gives the exact command.
- **Money:** a GitHub plan, if private repositories need one for branch rules. See [cloud resources](#cloud-resources).
- **Any looser alternative** in the questions below.
- **Each deeper security pass** beyond the ones already agreed for security-sensitive steps.
- **The gate call's review,** and anything in production.

## Cloud resources

**The proposal needs resources outside Cloudflare, which no earlier milestone did.**

- **GitHub:** one organization, `podsterdev`, and its three Apps, as above. **Possibly billed.** The spike found that the Free plan refuses a ruleset on a private repository, so private managed repositories with protected branches need a paid plan. Nothing has been bought. [ADR 0009](adr/0009-managed-repositories.md#visibility-and-the-plan) proposes public repositories as the working assumption until the owner decides.
- **Cloudflare:** no new billed resource is proposed. Step 2 adds Durable Object state through the room's own forward-only migrations, and at most a projection table in the API's existing D1 database. Step 5 adds a route to the existing gateway Worker. Provisioning and merge jobs use the existing outbox; a dedicated queue is only proposed if the spike shows the outbox can't carry them, and that would need the owner's yes.
- **Secrets:** each App's private key and the token-sealing key on the private API Worker only, and the webhook secret on the gateway. The owner sets them.

## Acceptance tests

**Proposed.** Each runs from a script against staging, with test people and staging's organization, `podsterdev`. The owner won't run checks by hand, so a check that can't run that way is recorded as a gap.

| Test | What it shows |
| --- | --- |
| M5-01 | Setting up a Git-enabled room creates one repository in the configured organization, with the chosen name and visibility, and the room records GitHub's repository ID. A room without Git creates none. |
| M5-02 | A repository's visibility is what was chosen at setup, whatever the room's visibility is. |
| M5-03 | A timeout during creation leaves the request uncertain, which blocks coding tasks like a failed setup. No repository is adopted by a matching name. A retry uses a new server-generated name, and nothing is deleted. When GitHub's answer did arrive, the repository is known by its recorded ID and no second one is made. |
| M5-04 | A client-supplied organization or installation is ignored or refused. |
| M5-05 | `get_repo_access` without a grant is denied and no token is requested from GitHub. |
| M5-06 | A token from `get_repo_access` can push a task branch and open a pull request. It can't merge to the default branch, even a commit the merge App has marked, by the merge call, a commit through the API, a ref update or `git push`. It can't reach another repository, change settings or rules, add or change a workflow, or set the required status. |
| M5-07 | After the agent is revoked, the task ends or the deadline passes, renewal is denied. What the already-issued token can still do, and for how long, is measured and written down. |
| M5-08 | A submission records its commit. After the branch advances, approval fails with `commit_changed`. |
| M5-09 | `merge_task` merges the reviewed commit. With a changed head it records `merge.failed` with `commit_changed`, and the task stays completed. |
| M5-10 | An approved task without a separate merge grant can't be merged, and a reviewer can't merge their own work. That means controlling people: nobody merges work whose submitter answers to the same person they do, so a reviewer merges only with the grant and only if a different person controls them ([ruling A](#step-3-what-was-built)). |
| M5-11 | A webhook with a bad signature is refused. A lost webhook is repaired by polling. |
| M5-12 | Checks and merge are reported separately, each with its time, including a failed check and a failed merge. With Actions off, which is proposed and not currently true, the failed check is a test status posted by a test App or token. |
| M5-13 | Logs from every Worker during the run hold IDs and reason codes only: no token, no repository content. |
| M5-14 | Setting up a Git-enabled room without the organization's provisioning delegation is denied, and no request reaches GitHub (AC-10). |
| M5-15 | A failed setup blocks coding tasks in that room and nothing else. It never falls back to another organization and never deletes a repository. |
| M5-16 | A replayed webhook delivery, or one naming a repository other than the room's linked one, changes nothing. |

## Threat model

**Draft, to be walked against the built system at step 10.**

| Threat | Proposed mitigation |
| --- | --- |
| An agent merges unreviewed code with its push token | Two rulesets on the default branch: a required status that only the merge App can set, on the exact commit it marks, with no bypass; and an update restriction that only the merge App bypasses. Whether a commit was reviewed is checked in Rust before the mark, after the job re-reads the pull request. Seen once each on the paths the spike tried; `git push` wasn't tried. |
| A token is used after its authority ends | One-hour tokens, every issuance rechecked, each token held sealed so it can be revoked on the events that end authority, and any residual lifetime disclosed. |
| A token reaches a log, an event or another agent | Minted and returned by the private Rust API only; held sealed in the room's Durable Object for at most an hour, for revocation, and nowhere else; the log check in M5-13. |
| A client steers provisioning to another organization | Organization and installation come from trusted configuration only. |
| A repository with a matching name is adopted | Ownership is the recorded GitHub repository ID, never a name. |
| A forged or replayed webhook changes state | Signature check at the gateway, and each delivery ID accepted once. Rust checks the observed repository ID against the room's link. Observations are records, and GitHub stays the source of truth for merge and checks. |
| One captured delivery is sent again under new delivery IDs, or a busy repository's events fill the room's memory of deliveries, so real nudges are lost | The room takes a delivery once by its ID or by the hash of the signed body, keeps nothing for a delivery about no known change, and when it holds 10,000 still marks the change without remembering the delivery. Checked locally. |
| A stale or squatted `repo_room_index` row suppresses a room's webhooks | The lookup never authorizes, so nothing is gained but silence, and polling still observes state. Polling isn't built until steps 6 to 8, and repairing the row is step 4's. |
| A holder of the webhook secret learns which repository IDs are managed, because an unknown repository answers faster than a routed one | Accepted. The answer's body and status are the same, and only someone who can already sign deliveries can measure it. |
| An agent pushes a workflow that runs with the repository's own token and merges or sets the required status | The agent's token can't write workflows, which the spike saw once, and ADR 0009 proposes that the provisioning App switches Actions off on each repository it creates and reads that back. That is proposed and not currently true: Actions were on in a new repository in `podsterdev`, and switching them off wasn't tried. A workflow already in a repository wasn't tested. |
| A public repository publishes agent content under Podster's organization | ADR 0009 proposes public as the working assumption, said plainly and confirmed at setup, because the Free plan has no branch rules for private repositories. It also proposes that pull requests from forks are never task changes, and an operator takedown. Public repositories exist on staging only, until the owner confirms the public scope, takedown.md covers repositories and its contact is real. |
| A room admin grants access they don't hold | Policy checks the granter's delegation for that repository and action (AC-10, AC-11). |
| A stale job acts after revocation | Each job rechecks current authority before its external call (AC-13, AC-27). |
| Repository content is treated as instructions | Agent content is data. Podster stores commit IDs, check names and states, not content. |
| The managed organization is compromised or its App key leaks | Least permissions per App; three Apps, so the provisioning key is never in the token-issuing path; rules read back on a schedule and before each merge; and the rotation and response in [ADR 0009](adr/0009-managed-repositories.md#key-rotation-and-compromise). A leaked provisioning key can still remove rules and delete repositories, and the private API Worker holds every key. The runbook is owed before the gate. |

## Questions for the architect

**Proposed answers by the architect. None is recorded as a decision yet.** "Owner's yes" marks an alternative that costs money, loosens the stance or creates an account.

| # | Question | Proposed | Alternative |
| --- | --- | --- | --- |
| 1 | Which repositories does M5 manage? | Only ones the server creates in the dedicated organization. | Linking an existing repository under its real owner's delegation. Later, with its own design. |
| 2 | One App or two? | Three, as ADR 0009 proposes: one provisions, one issues agent tokens, one merges. The status pin and the update bypass rest on the merge App's own identity, and the token-issuing App holds no Administration. Verified as a set, once, on `podsterdev`, on the calls [the spike's three-Apps run](../spikes/m5-github/README.md#results-three-apps) made. | Two, with provisioning and agent tokens in one App, as the spike ran. One App with branch rules alone needs the owner's yes, because a push token may then merge. |
| 3 | Default repository visibility | Public while the organization is on the Free plan, confirmed explicitly at setup, as ADR 0009's working assumption. | Private, which needs a paid plan and the owner's yes. Following the room's visibility isn't proposed. |
| 4 | Who can merge? | A person or agent with an explicit merge grant on that repository, and only after approval. Never the submitter, which is a new rule beyond AC-17. | Any approver. Owner's yes. |
| 5 | Token lifetime and renewal | One hour, renewed on demand with a full recheck and no fresh approval, as the architecture proposes. | Shorter tokens through a broker. Decided with M7. |
| 6 | Merge method | Merge commits, the only method the spike ran, which keep the reviewed commit in the default branch's history. | Squash, once it has been tried against the rules. |
| 7 | How commits attribute an agent | Left open by ADR 0009. For now Podster's own records carry attribution and the merge commit carries no Podster ID, since a trailer in a public repository would publish one. | The App authors the merge with the agent's ID in a trailer. A machine account per agent isn't proposed. |
| 8 | A changed commit after approval | A follow-up task with its own review, as decision 25 proposes. | Re-review on the same task. Not proposed: the architecture makes a completed task terminal. |
| 9 | Where provider jobs run | The existing outbox, with a recheck before each external call. | A dedicated queue. Owner's yes, as a new resource. |
| 10 | Deletion, export and transfer of a repository | Not built in M5. A removed room leaves its repository in place, archived, until the ADR's policy is approved. | Deleting with the room. Owner's yes; it destroys work. |
| 11 | Private repositories on a free plan | Not offered: the spike showed the Free plan refuses rules on them. | Buying a plan. Owner's yes. |
| 12 | Calling M5's gate | The architect proposes it after the staging run and the security review, for the owner to review. | |

## Risks to test

The spike at step 1 answers these before any feature code. Risks 1 to 10 ran on `podsterx`, the test organization at the time:

1. Can an App token create a repository in an organization, and with which permissions?
2. Does a newly created repository fall under the App's installation at once, so a token can be scoped to it?
3. Can an installation token be limited to one repository and to a chosen subset of permissions?
4. With contents write, can that token merge a pull request into a protected default branch? Does a required status tied to the merge App stop it?
5. Do branch rules and rulesets apply to private repositories on the organization's plan?
6. Does GitHub's merge refuse a head that differs from the given `sha`, and what does it return when the base has moved?
7. What can be revoked: one token, or only the installation? How long does a revoked or expired token keep working?
8. Which webhooks arrive for checks and merges, how late, and what does a redelivery look like?
9. Do GitHub's rate limits fit the polling the design needs?
10. Can a workflow pushed on a task branch run, and can its token merge, set the required status or bypass a rule? Which organization settings stop that?

Added by ADR 0009. Risks 11 and 13 ran once on 2026-11-10, on a public repository in `podsterdev`; the answers are in [the spike's three-Apps results](../spikes/m5-github/README.md#results-three-apps):

11. With three Apps, is a repository that the provisioning App creates at once under the other two installations, and does a token from an App with no Administration behave as the spike's scoped token did? **Seen once: yes to both.** Each of the other two Apps minted a token for the new repository on the first try. The agent-token App's token, cut down or not, was refused every administrative call and the merge of a marked commit. `git push` wasn't tried.
12. After a lost creation answer, can an orphan repository be recognized by a marker Podster wrote at creation, without trusting its name? **Not run.**
13. Can an App's token read back rulesets, their bypass lists and the organization's Actions setting, and with which permissions? **Seen once, in part.** The provisioning App's token, with Administration, read both rulesets and their bypass lists. The other two Apps' tokens read the rules without the bypass lists. The provisioning App read the repository's Actions setting, which was on, and got `403` on the organization's, since it holds no organization permission. ADR 0009 proposes that the provisioning App switches Actions off per repository and reads that back, which wasn't tried.

## How far this was checked

- Written from `PRODUCT.md`, `ARCHITECTURE.md`, `ACCESS-CONTROL.md` and `RUNNER.md` as they stand on `main` at `17563d1`.
- **This plan's own claims about GitHub were written before the spike** and aren't corrected here. What GitHub was seen to do is in [the spike's results](../spikes/m5-github/README.md#results-2026-11-10), and [ADR 0009](adr/0009-managed-repositories.md#not-verified) lists what's still unverified.
- When this plan was written, no code, contract, migration or cloud resource had been created or changed. Step 2 has since added a room migration and one read to the contract, and still no cloud resource.
- The Runner sections of the specs that lean on M5 are proposals and weren't reconciled with this plan. [#227](https://github.com/thachp/podster/pull/227), open now, proposes Runner as an A2A server and may change what M7 needs from M5.
