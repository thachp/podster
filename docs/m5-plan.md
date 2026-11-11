# M5 plan

**Status, 2026-11-10 UTC: Proposed, and implementation has started.** The owner told the architect on 2026-11-10 to start M5's implementation. That isn't an approval of this plan's proposals or of ADR 0009, which stays proposed, and nothing under [what needs the owner's yes](#what-needs-the-owners-yes) is answered by it. Step 2 is built, as its row in the [build order](#build-order) says: the room's state and a read of it, with no agent capability and no call to GitHub. Step 1 is drafted: [ADR 0009](adr/0009-managed-repositories.md) is written as a proposal, not accepted, and [the spike has run](../spikes/m5-github/README.md#results-2026-11-10) twice against the test organization, without webhooks. The spike's merge-restriction run is in [its own results](../spikes/m5-github/README.md#results-merge-restriction). The ADR's choices are proposals, recorded as [decisions 179 to 189](spec/PRODUCT.md#m5-proposals-november-10-2026). The gate, M5-03, M5-06, M5-12, the threat model, steps 4, 6 and 7 and questions 2, 3, 6, 7 and 11 below are reworded to match the ADR, and the ADR lists [where the spike disagreed with this plan](adr/0009-managed-repositories.md#where-the-specs-and-the-spike-disagree). The architect drafted this plan from the specs. Its [questions](#questions-for-the-architect) carry the architect's proposed answers, which aren't recorded as decisions in `PRODUCT.md` yet. Items marked **owner's yes** create an account or a cloud resource, cost money, set a secret, or are legal text, so the architect can't settle them alone.

**Staging switched on, 2026-11-11.** The owner said "let's unblock m5 staging". On that word `MANAGED_REPOSITORIES` is `true` in the staging variables of both Workers, beside the organization (`podsterdev`) and the three Apps' IDs and installation IDs, and the five secrets are the owner's to set: [staging.md](staging.md#managed-repositories-on-staging). Production, which doesn't exist, and the local defaults stay off. Sentences below that say the switch is "set nowhere" were true when written. Nothing has run against GitHub from the deployed product, so no acceptance test counts as passed. A takedown process for public repositories, which this plan says needs the owner, wasn't answered by those words and is still open ([what needs the owner's yes](#what-needs-the-owners-yes)). The operator's reset that step 4 said was owed first is [ruled on below](#owed-before-production). `e2e/journey.mjs` takes `--managed-repositories-on` for a deployment with the switch on: AC-17 and M1-CLAIM then want exactly `merge_task` as the one tool named for a merge, refused with `self_merge` for an agent with no grant in a room with no repository, and without the flag they want no such tool, as before.

It covers [M5 Managed repositories](spec/PRODUCT.md#product-direction-and-delivery-scope): a GitHub App, a repository linked to a room, review bound to a commit, and merge. Its gate is [expanded criterion 7](spec/PRODUCT.md#expanded-workroom-acceptance-criteria) for repositories. It starts from the [managed repositories design](spec/ARCHITECTURE.md#managed-repositories-and-merge-m5), which is itself proposed, and from decisions 10, 18 and 25, which are proposals too. Decision 10 leaves agent access to the M5 ADR.

M5 is the first time Podster holds authority over something outside itself and hands part of it to agents. So the plan proves on GitHub what a token can and can't do before any feature code.

## Where M3 and M4 stand

M5 starts while two earlier gates are still open. Neither blocks M5's planning or its spike, and `PRODUCT.md` already says M5 can ship later for engineering rooms.

- **M3's gate** isn't called. It still waits on the owner's approval of fasta2a and the compatibility kit. **2026-11-11:** the owner called it met, accepting local runs for outbound to LangGraph, fasta2a, `CancelTask` delivery and the Python client ([decision 193](spec/PRODUCT.md#decisions-needed)).
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
| 4 | **Provisioning:** room setup records a request; a job creates the repository, sets its protections and records the verified repository ID. Pending, ready, failed and uncertain states for the request, and ready, degraded and suspended for the link. An unknown outcome is a failed setup: nothing is adopted by name, and a retry uses a new server-generated name. | A failed setup blocks coding tasks in that room, not other work. **Owed here, from step 5's review:** provisioning owns `repo_room_index`. It writes a room's row when the link is made, repairs a row that's lost or held by another room, and removes the row when a link ends. Step 5 only writes the row once, from the room's alarm, and a room that loses to an existing row is marked and never retries, so a dead room's row can block its successor's webhooks until this step fixes it. The lookup never authorizes, so what's lost is nudges, and polling still observes state. **Built, 2026-11-10,** and checked locally only, against a fake GitHub: the owner's request and retry commands, the organization's delegation, the job with its read-back, and the routing row's repair. **Nothing ran against GitHub.** Switching Actions off per repository, the read-back by repository ID and the App's token have never been tried there, and are spike items owed before staging. **It adds one room migration,** four columns on `repo_request`, and no D1 migration. **Managed repositories have a switch of their own, `MANAGED_REPOSITORIES`, off everywhere.** **Ruled by the architect on 2026-11-10; for the owner to review:** the organization's provisioning delegation is set by a Podster operator, because every person administers their own personal organization, so an admin-set flag would let anyone create repositories in the managed organization. [What was built and what wasn't](#step-4-what-was-built) is below. |
| 5 | **Webhooks:** the gateway verifies GitHub's signature and passes a normalized observation to the room's Durable Object, which records it with its observation time. A job polls when state looks stale. | A new public route on the gateway. It authenticates the sender and decides nothing. **Built, 2026-11-10, in part,** and checked locally only: the route, the signature check, the nudge and the routing lookup. **The job that polls isn't built,** because it reads GitHub, and no step before 6 holds a token to read with. Only the decision of when a change is stale and the hourly read cap are built, as pure functions nothing calls yet. It adds a room migration and a D1 migration. **A delivery passes only IDs, the event's kind and one commit onward, and writes only `nudged_at`.** The head, checks and merge state are read from GitHub by steps 6 to 8; the brief for this step listed more fields, and the narrower reading was ruled right. **Ruled by the architect on 2026-11-10; for the owner to review:** recording a nudge is bookkeeping, not a command, so it needs no event, outbox row or idempotency record. The later read that records what GitHub says is a command, and commits state, event and outbox together. [What was built and what wasn't](#step-5-what-was-built) is below. |
| 5b | **Grant and revoke commands:** the routes in `apps/api` that give and take back a `push` or `merge` grant on the room's repository, with their contract entries. They call step 3's decisions, and the removal and ownership commands call its two revocation decisions. | **Ruled by the architect on 2026-11-10:** its own step, before step 6, since step 6 can't issue a token without a grant. Person-facing only, with no agent tool. A contract PR, so it merges one at a time with the others. **Built, 2026-11-10,** and checked locally only: give, take back and list grants, and both cascades. [What was built and the judgment calls](#step-5b-what-was-built) are below. |
| 6 | **`get_repo_access`:** the private Rust API mints a token for one repository after rechecking the task and its run, the fixed deadline and budget, the agent's assignment and connection, room access, the exact repository and installation, the grant and the provider permissions. Renewal runs the same checks. | Tokens never reach events, logs, D1 or the gateway's storage. The room's Durable Object holds each one sealed for at most its hour, for revocation only, as ADR 0009 proposes. AC-27. This step adds the capability and its route to the contract. **Open ruling for this step:** whether `get_repo_access` takes an idempotency key. A stored answer would hold the token, which must rest nowhere but the sealed copy, and no key leaves a retry to the one-live-token rule. **It must run `check_grant` with the delegation holder from current authority,** through `owner_authority_holds`, and never reuse the `state` that step 5b's list shows: that field is for display and can lag an owner's departure. **Built, 2026-11-10,** and checked locally only, against a fake GitHub: the capability and route, the agent-token App's mint and revoke, the sealed hold, coalescing, the revocation cascades and the alarm. **Nothing ran against GitHub.** **It adds one room migration,** two tables, and no D1 migration. **Six rulings, (a) to (f), each ruled by the architect on 2026-11-10; for the owner to review,** are in [what was built](#step-6-what-was-built). **Needs the owner before it can run anywhere:** the agent-token App's private key as `GITHUB_AGENT_APP_KEY`, its App ID and installation ID, `REPO_TOKEN_KEY` on the API Worker (with the optional `REPO_TOKEN_KEY_PREVIOUS` only while rotating), and `MANAGED_REPOSITORIES` switched on in both Workers. |
| 7a | **A task's pull request:** `submit_task` on a linked task names its pull request, and the private Rust API reads it from GitHub before accepting the submission. Approval reads it again and records the reviewed commit and base. A refresh job re-reads a change that's stale and records what it saw. | **Ruled by the architect on 2026-11-10: step 7 is split.** `merge_task` merges "the reviewed commit of the task's pull request", and until this step nothing tied a task to a pull request or recorded what Podster saw of it. 7a builds that link and that read, so 7b has reviewed values to compare against. No new capability, one field on `submit_task`, one room migration. **Built, 2026-11-10,** and checked locally only. [What was built, the judgment calls and what 7b can rely on](#step-7a-what-was-built) are below. |
| 7b | **`merge_task`:** the job rechecks authority, re-reads the pull request's base, head repository and head commit and refuses on any difference from the reviewed values, marks the reviewed commit, merges with its `sha` as a merge commit, confirms the default branch contains it, and records success or failure. A changed commit leads to a follow-up task, as decision 25 proposes. | Under ADR 0009's two rulesets, only the merge App can update the default branch. A retry reads the pull request's merged state, since a second merge call answers `200`. This step adds the capability and its route to the contract. **It must deliberately revisit AC-17's assertion in `e2e/journey.mjs`,** which fails today if any tool an agent sees is named for merge or deploy. A merge tool will exist from this step on. The property to keep is that approval alone never merges, and only an authorized `merge_task` does. That change gets a deeper review. **Order of checks:** the route must run policy's `authorize_merge`, which hides a task the caller can't see, before core's `check_merge_authority`, because core answers `task_not_linked` and `repo_not_ready` before it looks at the grant. The same holds for step 6 with `authorize_repo_access` and `decide_access`. **Built, 2026-11-11,** behind `MANAGED_REPOSITORIES` and checked locally only. [What was built, why marking before merging is safe, the judgment calls and what needs the owner](#step-7b-what-was-built) are below. AC-17's assertion in `e2e/journey.mjs` wasn't edited: **ruled by the architect on 2026-11-10,** the gateway lists `merge_task` only when its own switch is on, so the journey, with both off, still finds no merge tool. |
| 8 | **`get_task_release_status`:** checks and merge state, each with its own observation time. | Reports that no release exists; M6 adds releases. This step adds the capability and its route to the contract. **Built, 2026-11-11,** behind `MANAGED_REPOSITORIES` and checked locally only. [What was built and what needs the owner](#step-8-what-was-built) is below. |
| 9 | **Screens**, in two PRs: (a) the Git option in room setup and the repository's state; (b) grants in Manage access and a task's change and merge state. | Unavailable grants show as unavailable, never silently provisioned. **Before the screens (ruled by the architect, 2026-11-10):** the room's repository read and grants list now follow `MANAGED_REPOSITORIES` as the commands do, answering as a missing route while it's off, because the web app must learn "off" from the server and never from a client-side flag. The read adds `attempts_left`, and `delegated` for the owner by current standing alone, absent when the organization's record can't be read; both display only. Every managed-repository command, `get_repo_access` included, answers exactly as a missing route while off, malformed bodies included, and a task read has no `change`. **The organization's provisioning-delegation routes are the exception:** they answer whether the switch is on or off, because an operator must be able to set the delegation before the feature is switched on, they're for an operator and the organization's admins only, and they reveal nothing about any room. Ruled by the architect on 2026-11-11; for the owner to review. **Built, 2026-11-11, in one PR,** and checked locally only, with the switch off and the screens tested on what the reads return: **(a)** the room's repository in Workroom Settings, with its state in words, the owner's name field and a confirmation stating that the repository is public, that a pushed task branch is public at once, and that Podster never deletes it, a retry with the attempts left, and the missing delegation said plainly; **(b)** repository grants on Team, with the list, the owner's grant form with an optional expiry of at most a year, and take-back for those allowed; and a task's pull request and merge stage as a read-only **Release** panel in the task Sheet. Each screen learns that managed repositories are off from the server: the read answers as a missing route, and nothing shows. **Built after step 7b (#261), 2026-11-11, in a second PR:** a task's merge state, with when it was asked for, ended and seen, and the merge control for a holder of a live merge grant who isn't the assignee, behind a confirmation naming the reviewed commit and the default branch, with every `mergeTask` refusal and every `merge_reason`, the job's authority refusals included, as a sentence. Asking again after a merge ended is a new intent with its own idempotency key. The read has no field for the job's phase, so a request in progress shows as "Merge requested" and doesn't tell marking from merging. **The Git option in room setup isn't built:** before a room exists no read can say whether managed repositories are on, so an option there would either show while they're off or need a new read; the owner asks from Settings once the room exists. **The operator's recheck isn't built either:** the operators' page has no read that says whether managed repositories are on or which rooms are degraded, so a control there would show while they're off and need a hand-typed room ID. Both deferrals were accepted by the architect on 2026-11-11. **So `recheckRepository` has no web caller yet,** and **a list of degraded rooms on `/moderation` is owed before production**, so an operator can find one to recheck without a hand-typed ID. **Still to come:** a task's checks and release status, with step 8; the Git option in room *setup*, since a repository is asked for from Settings once the room exists; and marking a public-claim participant unavailable before it's chosen, which needs a field the room read doesn't have, so the API's `grantee_public` refusal is shown instead, saying to choose a participant who joined by invitation (ruled by the architect on 2026-11-11). **Carry-over, built 2026-11-11:** a `public_claim` flag on each member in the room read, told only to those who manage access (`policy::repositories::sees_join_source`, from the caller's current role; absent, not false, for anyone else). It's decided by the same predicate as the `grantee_public` refusal, a public joiner still in the guest role it gave, and it's sent whether managed repositories are on or off, since it only says how someone joined. The grant form lists those participants as unavailable and never offers them. The flag authorizes nothing: granting still checks the room's own row and answers `grantee_public`, which the form still shows. No migration: `joined_via` was already stored. A holder who doesn't manage access can't take back their own grant from the web app yet, because the command needs the room's policy version, which only managers read. **Can't be checked until the switch is on:** every screen against real reads, and the accessibility run over them. |
| 10 | **Staging run and security review,** then the gate call. | A script against staging with test people, in `podsterdev`. **The script is written, 2026-11-11, and hasn't run against staging:** `e2e/m5-staging.mjs`, 31 checks, 3 sign-ups a run. Only its pure parts and its dry run were checked, locally and in CI. [What it checks, what it costs and what it leaves out](#step-10-the-staging-script) is below. The security review isn't started. |

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
  - *Superseded on 2026-11-11 by [decision 194](spec/PRODUCT.md#decisions-needed): a person who is the room's owner or a room admin gives a grant, and `no_provider_delegation` is gone ([below](#self-serve-repositories-what-was-built)).* **Giving** a grant is the room owner's alone. It needs room authority, which a human owner or admin has, and the repository's delegation, which only the owner holds, as a person whose owner authority still holds. So an admin gets `no_provider_delegation` (AC-10), and someone with a delegation who doesn't administer the room gets `not_allowed` (AC-11).
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

### Step 4: what was built

**Built:**

- **A switch of its own.** The Worker variable `MANAGED_REPOSITORIES`, off unless it is exactly `true`, set nowhere in `apps/api/wrangler.jsonc`, with a test that fails if any environment sets it. Both commands and the job check it. Off, the two routes answer not-found and a pending request ends `failed` with `managed_repositories_off`. **Setting an App's key isn't the owner's yes. This variable is,** and switching it on for staging needs the owner in that session, because every repository is public.
- **The organization's provisioning delegation** (AC-10, M5-14). It is authority, so it lives in the private Rust API: in the `Principal` object named for the organization, which already holds the organization's rooms. `PUT /v1/orgs/{org}/provisioning-delegation` gives it or takes it back, for an organization the API has seen a room of, and every change is kept with who made it, there and in the operators' record of their actions. `GET` reads it, for an operator or the organization's admins.
- **The owner's two commands.** `POST /v1/workspaces/{ws}/repository` records the room's one request, with a name and a visibility, and `POST .../repository/retry` puts a failed or uncertain setup back to pending. Both are for the room's owner, as a person, and both are refused with `not_delegated` unless the organization holds the delegation, before anything reaches GitHub. Each commits its state, audit entry, event and stored answer in one transaction. Any field beyond the name and the visibility is refused, so a caller can't name an organization, an installation or an App (M5-04).
- **The job,** run by the room's alarm while a request is pending. In order:
  1. It rechecks authority from current state: the configuration is complete, the organization still holds the delegation, the room isn't archived and the person who asked is still its owner.
  2. It records the attempt, with the name it is about to send, before the creation call goes out.
  3. It creates the repository in the configured organization with an initial commit, and holds the ID from GitHub's answer only if the owner in that answer is the configured organization.
  4. It reads the repository back, adds only what's missing (Actions off, the review ruleset, the update ruleset), and reads everything back again.
  5. It asks for the delegation once more. The organization's object answers outside the room's transaction, so this is as late as it can be asked.
  6. Only if that second read is exactly right does it link the repository and mark the request ready, in one transaction with its audit entry and event, which rechecks the owner and the archive.
- **The states.** A request is `pending`, then `ready`, `failed` or `uncertain`, each of the last two with a reason code. A link is made `ready`; this step writes no `degraded` or `suspended`.
- **Tokens as narrow and short-lived as their work.** The installation's own token, which can administer every repository, is minted for the creation call alone and revoked as soon as that call is answered. Setup and the read-back use a second token narrowed to the one repository, revoked when the job ends, on every way out. A retry on a held repository never mints the broad one. A token that can't be revoked, the broad one included, is counted and logged by the room's and request's IDs, and lives out its hour.
- **Unknown outcome (M5-03).** A creation call with no answer, a server error, or an answer with no ID leaves the request `uncertain`. So does a job that died after recording an attempt, and so does **anything that goes wrong after the creation call and before its outcome is on record**: while the attempt's row still says `started`, a repository may exist, so the request ends `uncertain` whatever the job thought went wrong, and the attempt keeps the name an operator would look for.
- **A call that was never sent doesn't burn its name.** With no token, no creation call goes out. The attempt is recorded as `not_sent`, and a retry sends the same name.
- **Retries are limited.** Setup runs at most five times for a room, and then a retry is refused with `retry_limit_reached`. Between runs a retry waits a minute, doubling up to an hour (`retry_too_soon`). The job never re-runs by itself: a request leaves `pending` every time. If the room can't even write that, the job stays away for 5 seconds, doubling up to 5 minutes, and the creation call isn't sent again. That wait is kept in `repo_request`, so a restart of the room doesn't forget it. **The job holds itself to the five runs too:** a request that comes back without a retry ends with `retry_limit_reached` and sends nothing to GitHub.
- **Reserved names, proposed:** `podster`, `podsterdev`, `security`, `admin`, `api`, `www`, `docs`, `status`, `support`, `billing`, `legal`, `abuse`, anything starting with `podster-`, and anything starting with a dot, whatever the case. Refused with `name_reserved`. Nothing is looked up by name. A retry sends a new name the server makes, the chosen name and six hex digits, and never one an earlier call carried. Whatever the first call made stays where it is, untouched.
- **A held repository.** When GitHub's answer did arrive and setup failed afterwards, a retry finishes setup on that same ID and makes no second repository.
- **Never repaired.** Setup adds what's missing and never edits or removes. A ruleset that's present and inactive, differs, or has an extra bypass actor fails the setup, and fails it again on a retry, until someone with authority at GitHub puts it right.
- **The GitHub boundary,** `apps/api/src/github.rs`: one trait, `Provider`, with three calls (create, read back, apply one setup step), and one real implementation that signs an App JWT with the provisioning App's key, trades it for an installation token and makes the REST calls. The token lives in that struct for one job. No token or key reaches an event, a log, D1, the room's tables or the gateway, and a failure carries a status or a fixed word, never GitHub's text.
- **Configuration,** all from the Worker and none from a caller: `GITHUB_ORG_LOGIN`, `GITHUB_ORG_ID`, `GITHUB_PROVISION_APP_ID`, `GITHUB_PROVISION_INSTALLATION_ID` and `GITHUB_MERGE_APP_ID` as variables, and `GITHUB_PROVISION_APP_KEY` as a secret. **With any of them unset the job refuses before any call,** and the request ends `failed` with `provisioning_not_configured`. That is what staging shows until the owner sets them.
- **The routing row** (owed from step 5's review). A room still writes its own row from its alarm once its link exists. If another room's row is in the way, that room is now asked whether the repository is really its own: a stale or squatted row is replaced, and a row its room confirms is left.
- **In `crates/core`,** `provisioning.rs`: how a creation answer is read, the retry name, and the read-back's verdict with a reason for each way it can be wrong. **In `crates/egress`,** `app_key.rs`: turning GitHub's PKCS#1 key into the form the runtime's RSA takes, and the JWT's signing input.

**Judgment calls, for the review:**

- ***Superseded on 2026-11-11 by the owner's decision, [below](#self-serve-repositories-what-was-built):* A Podster operator gives the delegation, not the organization's own admin. Ruled by the architect on 2026-11-10; for the owner to review:** the organization's provisioning delegation is set by a Podster operator, because every person administers their own personal organization, so an admin-set flag would let anyone create repositories in the managed organization. The brief for this step had said an organization admin sets it.
- **An organization is "known" if its own object holds a room for it,** or, for rooms from before that record was kept, if the listing has one. So an operator can't delegate to an organization before its first room exists. Both paths are tested: the object's own record with the listing emptied, which is what a deployment uses, and the listing for organizations whose record test builds skip.
- **The delegation's last recheck is just before the linking transaction, not inside it.** The organization's object can only be asked asynchronously, and a room's transaction is synchronous. So a delegation taken back in the moment between that answer and the link's commit doesn't stop that one link. The re-review noted it and accepted it.
- **The retry limit counts runs of the job,** in a new column, not creation attempts, so resuming on a held repository counts too.
- **The first creation call sends the chosen name,** as M5-01 and ADR 0009 say, and only a retry sends a server-made one. The brief said every name is server-generated.
- **Private is refused,** with `private_unavailable`, as ADR 0009's working assumption has it. Nothing reads the organization's plan.
- **The job runs in the room's alarm,** not on a queue. A queue would be a new cloud resource.
- **The fake is at the HTTP boundary, not behind the trait.** `apps/api` only builds for Wasm, so a Rust fake couldn't be linked into the tests. The tests run the real client against a fake GitHub that the test runtime puts in place of the network. That also checks the App JWT's signature and every request's shape. The trait is still the only way the job reaches GitHub.
- **Only the provisioning App's key is used.** ADR 0009 lists "all three installations cover the repository" under readiness. Checking that needs the other two Apps' keys, which would put all three keys in the provisioning path. It is left to steps 6 and 7, where each App first mints a token for the repository.
- **A repository is addressed as `/repositories/{id}`** after creation, never by name. The spike addressed by name.
- **Any ruleset beyond the two is a failure,** including one inherited from the organization, since the read can't tell what it does to the merge path.
- **The pull request rule's own parameters aren't judged,** only that the rule is there. Review is checked in Rust, not by GitHub.
- **A link's row is never removed,** because nothing in M5 ends a link yet. The step that adds takedown or deletion removes the routing row with it.
- **A 422 that doesn't blame the name is `provider_refused`,** not `name_taken`.
- **Events name the person who asked as their actor** for the job's outcomes, since the room has no system actor.
- **The delegation being taken back doesn't touch a repository already linked.** It stops new requests and any job that hasn't called GitHub yet.

**Not built, and left to the step named:**

- **Blocking a coding task's commands.** `get_repo_access` and `merge_task` are what a failed setup blocks, and they are steps 6 and 7. Step 3's `task_block` is ready for them. Today a failed setup leaves the request's state and reason for the room's people, and blocks nothing else, which M5-15 asks for.
- **Drift:** the scheduled read-back, and `degraded`. Before each merge it is step 7's.
- **The Git option in room setup and the repository's state on screen:** step 9(a).
- **Orphans listed for the operators.** The attempts table has every name a call carried. No screen or route lists them.
- **An operator's reset.** A room at its retry limit, or one whose repository has a rule that's present and wrong, stays blocked for good: there is no cancel and no reset. Operators can't address a private room by decision 158, so a reset needs its own small design. Owed before staging is switched on. **Ruled by the architect, 2026-11-11:** staging is switched on without it, and it stays [owed before production](#owed-before-production).
- **An open question for a later step, from the re-review:** whether an owner who leaves their organization and rejoins before the room hears of it could regain live grants or the delegation. How authority is resolved across that gap is outside this step and step 5b. **Step 6 adds:** a repository token already held while the room hasn't heard of the owner's departure lasts until it hears, or at most the token's hour.
- **All three installations covering the repository** isn't part of readiness here. Owed to steps 6 and 7, where each App first mints a token for it.
- **The staging variables.** Nothing was added to `wrangler.jsonc`. The organization's ID and the provisioning App's installation ID aren't recorded anywhere this step could read.

**Unverified against GitHub, each a spike item owed before staging:**

1. Switching Actions off on one repository with the provisioning App's token, and reading that back.
2. Every call by `/repositories/{id}`: the repository, its branch, its Actions setting, and creating and reading rulesets.
3. The App JWT made here, and its installation token, against the real API. The fake checks the signature with the matching public key, which shows the signing is right and not that GitHub accepts it.
4. What GitHub answers for a taken name. The code takes a `422` whose errors name the `name` field.
5. Whether a ruleset's detail read lists organization rulesets, and whether the pull request rule's parameters are accepted as sent.
6. Whether the default branch is readable immediately after an `auto_init` 201. If not, a new repository fails with `no_initial_commit` and needs a retry.
7. Whether `bypass_actors` appears when a ruleset is read through `/repositories/{id}`. If not, every setup fails closed with `bypass_differs`.
8. Narrowing an installation token with `repository_ids` for a repository made seconds earlier, and revoking a narrowed token. The spike revoked a token and saw it refused; it didn't narrow one this way.

**Needs the owner:**

- The provisioning App's private key as the secret `GITHUB_PROVISION_APP_KEY` on the private API Worker, and later the other two Apps' keys for steps 6 and 7.
- The five variables above, for staging: the organization's login and ID, the provisioning App's ID and installation ID, and the merge App's ID.
- **`MANAGED_REPOSITORIES` set to `true` for staging,** in that session. This is the owner's yes to public repositories under Podster's organization; the key and the variables aren't.
- Public managed repositories on staging. That they may be public was confirmed by the owner on 2026-11-11: "okay with public repo, MIT project". Those words don't switch `MANAGED_REPOSITORIES` on or set the Apps' keys, and takedown.md's staging exception doesn't cover repositories, so the takedown process still needs the owner.
- An operator to give a test organization the delegation on staging.

**Checked:** locally only, as the PR lists. Nothing ran against GitHub or a deployment, so M5-01 to M5-04, M5-14 and M5-15 don't count as passed.

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
- **A stronger migration assertion.** `apps/api/test/provider-deliveries.spec.ts`'s migration test no longer looks at `repo_link.indexed_at` after migrating, because the room's alarm may fill it at once. The step that next touches that file should assert it is null or a number.

**Checked:** locally only, as the PR lists. Nothing ran against a deployment, so M5-11 and M5-16 don't count as passed.

Steps 3, 5 and 9(a) can run side by side after step 2. Steps 4 to 7 are security-sensitive: a provisioning credential, a new public route, token issuing and merge. Each gets the deeper review the owner has already agreed for security-sensitive steps; anything deeper than that is asked first.

### Step 5b: what was built

Three person-only routes on the room's Durable Object, the two cascades, and their contract entries. No migration: step 2's `provider_grant` holds everything.

**Built:**

- **`POST /v1/workspaces/{ws}/repository/grants`, `grantRepositoryAction`:** `{ policy_version, principal_id, action, expires_at? }`.
  - *Superseded on 2026-11-11 by [decision 194](spec/PRODUCT.md#decisions-needed): the room's owner or a room admin, as a person; anyone else in the room `not_allowed` ([below](#self-serve-repositories-what-was-built)).* Only the room's owner, as a person whose owner authority holds. An admin gets `no_provider_delegation`, and anyone else in the room `not_allowed`.
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
  - Handing the room over ends every grant the new owner didn't give (`owner_changed`). The transfer before it already ended earlier owners' grants, so handing it away and back leaves none live.
  - Recovering the room ends every grant (`owner_changed`), even when it names the former owner again: rejoining never restores earlier authority (ruled by the architect, 2026-11-10).
  - Each cascade commits with its removal or transfer or not at all: a failpoint test checks both.
- **Two policy additions**, since no decision covered them:
  - `denied_change_name` names the two commands, so refusals are kept as denials.
  - `can_see_event` shows a grant's events only to a human owner or admin, the holder and whoever acted, as `sees_grant` does for the list. A member who sees the whole room doesn't learn who holds a grant. The activity query filters the same way, so a guest holder sees their own grant's events.
  - `sees_every_grant` names who sees all of them, and `is_authority_refusal` counts `grant_not_found` for taking one back. Someone probing grant IDs they may not see leaves a denial, and gets the same answer whether or not the grant exists.

**Judgment calls:**

- **Agents call none of these, even to revoke their own grant.** That needs the owner or an organization's admin until an agent route exists.
- **An organization's admin revokes only from inside the room.** One outside it recovers the room instead, which ends the former owner's grants. Meanwhile none of them counts, since the delegation holder is gone.
- **Both commands take `policy_version`,** as every access change here does. Each audit entry moves it.
- **An expiry is optional.** When given, it's after now and at most a year ahead (ruled by the architect, 2026-11-10). Anything else is `invalid_argument`.
- **The list is its own route, not part of the repository read.** That read is for people who see the whole room, and a grant's holder sees their own without that.
- **`state` in the list is for display only.** It takes the delegation holder from the room's record: the owner, unless the room records that they left. So it can say `live` for a grant whose giver has left before the room is told. A command takes the holder from resolved authority instead, and step 6 must too.
- **An owner leaving their organization revokes no rows.** Ownership hasn't moved, and `check_grant` already refuses such grants as `grant_stale` until recovery ends them.
- **A stored answer replays only to someone still allowed:** to grant, or to take that grant back.

**Not built, and left to the steps named:** using a grant (tokens, step 6; merges, step 7), and the screens for grants (step 9(b)).

**Checked:** the workspace's Rust tests, the API's and the gateway's suites, the contract check and the local journey, all locally. Nothing ran against a deployment.

### Step 6: what was built

**Built, 2026-11-10,** and checked locally only, against a fake GitHub. Nothing ran against GitHub or a deployment, so no acceptance test counts as passed.

- **`POST /v1/workspaces/{ws}/tasks/{t}/repo-access`, `getRepoAccess`, and the agent capability `get_repo_access`.** The body is empty, and any field is `invalid_argument`: the repository is the room's link, and the organization, installation and permissions are configuration. The answer is `{ token, expires_at, repository, clone_url, permissions, authority_ends_at }`.
- **Order.** `authorize_repo_access` first, so a task the caller can't see is `task_not_found`, then `decide_access`. A first pass on the room's records refuses early without asking anyone. Then the room asks two `Principal`s, and decides again on their answers, inside the transaction:
  - whether the room's owner has left the room's organization since they became owner. A departed owner holds no delegation, so every grant is `grant_stale`. This is current authority, never the grant list's `state`.
  - whether the person who linked the agent's credential has left the agent's organization since. If so, `controller_departed`.
  - An answer that isn't a clear yes or no is `standing_unknown` (503), and nothing is minted.
- **Minting** goes through a new `TokenIssuer` trait in `apps/api/src/github.rs`, beside the provisioning `Provider`, with the agent-token App: `repository_ids: [link's ID]` and `TokenPermissions::AGENT` only. GitHub's answer must pass `minted_token_matches` and expire within an hour and a minute, or the token is revoked and the call refused `provider_mismatch`.
- **One room migration,** forward-only, two tables:
  - `repo_token`: one row per token the room holds or still has to revoke. **The token is only in `sealed`,** AES-256-GCM under `REPO_TOKEN_KEY`, with `repo-token:{room}:{repository}:{grant}:{agent}:{task}` as associated data. No column holds a token readable without the key. Two partial unique indexes allow one held token and one lease per agent and task.
  - `repo_token_mint`: when each mint was asked for, by which agent, for the caps. No token.
- **The agent-token App's configuration:** `GITHUB_AGENT_APP_ID` and `GITHUB_AGENT_INSTALLATION_ID` as variables, and `GITHUB_AGENT_APP_KEY` as a secret, alongside step 4's. None is set anywhere, and a test checks the Worker's configuration names none of them.
- **The gateway** lists `get_repo_access` only when its own `MANAGED_REPOSITORIES` is exactly `true`, through `capabilitiesFor`, on MCP and Agent Auth alike. It isn't set in `apps/gateway/wrangler.jsonc`, and a test checks that. Listing authorizes nothing.
- **The local rehearsal:** `e2e/run-local.mjs` runs the journey unchanged with both switches off, then a second throwaway stack with both on for `e2e/repo-access-check.mjs`. A local stack can't reach GitHub, so no link can exist there, and its refusals come before the grant check. The grant and standing refusals are shown against the fake.

**Rulings, each ruled by the architect on 2026-11-10; for the owner to review:**

- **(a) The switch.** Everything sits behind `MANAGED_REPOSITORIES`. With the API's off, the route answers `not_found` as for any route that doesn't exist, whatever the body. The gateway lists the tool only when its own variable of the same name is exactly `true`. A mismatch fails closed: the gateway on and the API off is `not_found`; the gateway off and the API on is an unknown tool.
- **(b) The sealed hold.** Each token is kept sealed in the room's Durable Object for at most its hour, solely to revoke it, under a new 64-hex secret, `REPO_TOKEN_KEY`, on the API Worker, which the owner sets. Unset, the command refuses `repo_access_unavailable` before minting. Never in events, logs, D1, the outbox, the idempotency store, an error or the gateway: a test reads every room table, every D1 table, every log line and every error answer for each token minted.
- **(c) No idempotency record.** The command is idempotent by coalescing instead. One live token per agent and task under the same grant. A repeat call gets the held token until 5 minutes before its expiry, then a new one, and the old one is revoked. Decide and take a lease in one transaction, mint, then commit the sealed token, the old one's revocation and an event of IDs together. If that commit fails or decides differently, the new token is revoked at once. A concurrent call sees the lease and is refused `repo_access_busy` (409), so two live tokens can't be minted.
- **(d) Revocation.** One function, `store::mark_stale_repo_tokens`, marks every held token whose authority has ended, from current state, in the transaction of whatever ended it. It's called when a grant is revoked, so also on removal and ownership change; when a participant is removed, so also on withdrawal and global disconnect; on every task decision, so a task that ends or goes to someone else; when the room is archived; when the room records its owner left the organization; and by the alarm. A refusal at request time revokes the held token too. The alarm revokes with `DELETE /installation/token`. A `204` or `401` deletes the row. Anything else is retried, from 1 minute doubling to 15, until the token would have expired anyway, when the row is dropped. A failed revocation never holds up the cascade's own transaction.
- **(e) Deadline and budget: explicitly none.** A task has no server-side deadline and no budget today: `due_at` is informational ([task planning](spec/TASK-PLANNING.md)), and RUNNER.md lists server-trusted deadlines as unresolved. So the room passes `Deadline::NoDeadline` and `Budget::NoBudget` on purpose, and the answer's `authority_ends_at` is null. No budget model was invented. `deadline_unknown` and `budget_unknown` stay in the core decision, tested there, for when one exists. An unreadable standing refuses as `standing_unknown`.
- **(f) Caps, proposed.** At most one live token per agent and task. At most 10 mints an hour per agent in a room and 60 an hour per room, counted when the lease is taken, failed mints included; over either is `rate_limited` (429). An agent renewing one task's token needs about one an hour. The installation's 5,000 requests an hour are shared by every room, and a cap across rooms isn't built.

**A decision added to `crates/core`,** since none covered it: `AccessCheck::controller_holds`, refused as `controller_departed`. An agent acts for the person who linked its credential, so once they've left its organization it gets nothing new. A credential with no linker is refused the same way. Nothing in `crates/policy` changed.

**Judgment calls:**

- **No command marks a task as linked yet.** `has_linked_repository` is false on every task the API creates, so on a deployment every request answers `task_not_linked` until a later step decides which tasks are coding tasks. The tests write the flag, as step 5b's write links. **This needs a ruling before the feature can do anything.** **Answered in [step 7a](#step-7a-what-was-built):** a task made while the switch is on and the room's repository is ready is linked.
- **`connected` is passed as true.** The API refuses a disconnected agent before the room sees the request, and a disconnect removes the agent from the room, which is `access_revoked`.
- **A refusal's codes and statuses:** a grant, `not_allowed`, `public_participant` and `controller_departed` are 403; a task or repository that isn't ready is 409; an unknown standing, an unconfigured App or an unset key is 503; GitHub not answering is `provider_unavailable` and a mismatch is `provider_mismatch`, both 502.
- **A concurrent call is refused, not made to wait.** It can ask again and gets the held token.
- **The event is `repo_access.issued`,** with the agent as actor, the grant as subject and the task, and no recipients. Whoever can see the task can read it. Revocations record no event of their own: the cascade that caused one has its own.
- **A linking person's departure is caught at the next call.** The room isn't told when the person who linked an agent leaves their organization, so a token the agent already holds is refused and revoked at its next call, and otherwise lives out at most its hour.
- **The lease lasts 30 seconds,** longer than a call to GitHub can take. One left by a Worker that died is cleared when it's over.

**The security review's findings, fixed on 2026-11-10** (the review found nothing high):

- **M1, a grant that lapses mid-token.** The alarm now wakes for a held token at the earlier of its own expiry and its grant's, and the reconcile revokes it then. The wake is set before the token is answered: an alarm can't be set inside the room's synchronous transaction, so it's set straight after the commit, and the runtime holds the answer until it's stored. If it can't be set, the token is revoked and the call refused.
- **A previous secret that's set but malformed** (from the re-review): rows the current key can't open then wait and are retried, reported as `key_invalid`, and never dropped as unrevocable, so a typo while rotating can't lose tokens. Only when no previous secret is set at all may such a row be recorded as unrevocable and dropped. A request for such a row's task answers `repo_access_unavailable` until the secret is fixed.
- **M2, rotating the sealing key.** **Ruled by the architect on 2026-11-10; for the owner to review:** a second, optional secret, `REPO_TOKEN_KEY_PREVIOUS`, in the same format, is tried only to open a sealed token, and only when the current key can't. Sealing always uses the current key. A row that opens with neither, while a current key is set, is recorded as `repo_token.unrevocable` (an event and a log line with the row's ID only) and dropped. At a request the agent then gets a new token, not an error. With no key set at all, rows wait: that's configuration missing, not a key gone. The log says only `current` or `previous` about a key. The procedure is in [staging.md](staging.md#the-repository-token-keys).
- **L1(a), the switch.** The alarm marks every held token for revocation once it sees `MANAGED_REPOSITORIES` off. **It isn't prompt:** nothing wakes a room when the switch flips, so a room revokes at its next alarm. That's at the latest its earliest held token's expiry, or its grant's, so the bound is one hour. The revokes need the agent-token App's ID, installation ID and key, and `REPO_TOKEN_KEY`, so all of them must stay set for at least 65 minutes after the switch goes off. Remove them sooner and those tokens can't be revoked, and live out their hour.
- **L2, three Apps.** The agent-token configuration is refused when its App ID equals the provisioning or merge App's, its installation is provisioning's, or its key is provisioning's. The provisioning configuration refuses the same way.
- **L3.** Authority ending while a token is minted (the agent removed, the room archived) is answered as that refusal, not a 500, and the token is revoked.
- **L4.** The grant is chosen deterministically: a live one on the room's repository, then any live one, then the newest.
- **L5.** The lease row, written before the mint, is kept as `mint_unknown` with an event when the call never came back, or when GitHub's answer was lost or unreadable. It records a token that may be live and can't be revoked, since the room never had it, and goes when any such token would have expired, an hour on. It never blocks a new token.

**Gaps, acknowledged, each bounded by a token's hour:**

- **A token minted and never held** can't be revoked: the room never had it. Its lease is kept as a `mint_unknown` record for its hour (L5).
- **The linking person's departure** isn't pushed to rooms. A held token is refused and revoked at the agent's next call, and otherwise lives out at most its hour.
- **An owner's departure the room hasn't been told of yet.** Every request asks the owner's `Principal`, so nothing new is minted. A token already held lasts until the room hears, or at most its hour. See also the open question in step 5b about an owner who leaves and rejoins before the room hears of it.
- **No cap across rooms** on the agent-token App's installation, whose 5,000 requests an hour every room shares.
- **What a token can do once issued isn't measured** (M5-06, M5-07's second half). That needs GitHub.

**Unverified against GitHub:** narrowing a token with `repository_ids` and `permissions` on the agent-token App; the answer's `permissions`, `repositories` and `expires_at` fields, which `minted_token_matches` and the expiry check rely on; `DELETE /installation/token` with an agent token; and that a second revoke answers `401`. The fake answers as the documentation says.

**Tests:** in `apps/api/test/repo-access.spec.ts`, against the fake: M5-05 (no grant, nothing asked of GitHub), M5-07's renewal refusal, coalescing and renewal, concurrent calls, every refusal named in the step's brief, a hidden room and task answering as missing ones, each kind of mismatched token, a commit failure, each revocation trigger, a failed revocation retried, and the store sweep. M5-06, M5-08 and M5-09 aren't this step's: M5-06 needs GitHub, and M5-08 and M5-09 are step 7's. The gateway's suite checks the switch and its configuration.

**Not built, and left to the steps named:** marking which tasks are linked (a ruling first), the merge path and AC-17's revisit (step 7), the release status (step 8), and the screens (step 9).

**Checked:** the workspace's formatting, lints and Rust tests, the API's and the gateway's suites, the contract check, and `e2e/run-local.mjs`, all locally: the journey with both switches off passed 52 of 52, AC-17 and M1-CLAIM included and unchanged, and the on-state check passed 4 of 4. Nothing ran against GitHub or a deployment.

### Step 7a: what was built

**Built, 2026-11-10.** Everything sits behind `MANAGED_REPOSITORIES`, which is set nowhere. With it off a submission and an approval are exactly what they were, and `e2e/journey.mjs` passes unchanged. **Nothing here merges anything.**

- **Which tasks are linked.** A task made while the switch is on and the room's repository is ready gets `has_linked_repository`, for its whole life. No other task does: one made before the repository was ready is never asked for a commit or a pull request, and is never blocked by the repository's state (M5-15).
- **Linking at submission.** On a linked task `submit_task` takes `commit_sha`, as step 3 decided, and now a `pr_number`. Before the submission is accepted, the private Rust API reads that pull request from GitHub. It refuses unless the pull request is in the room's repository, by repository ID (`pull_request_not_found`, also for a number that doesn't exist); its head is in that same repository, never a fork, including a fork that's gone (`pull_request_from_fork`); its base is the repository's default branch (`pull_request_wrong_base`); it's open (`pull_request_not_open`); it isn't still marked as a draft (`pull_request_draft`); and its head is `commit_sha` (`commit_changed`, from `core::decide`). The task's `task_change` is written in the submission's own transaction: the pull request number, the head seen, the head's repository ID, the base branch, the base commit, the state and the time.
- **One pull request, one task.** A pull request another task holds is `pull_request_in_use`. A task keeps the pull request it first named: a later submission may name a new head of it, and a different number is `pull_request_changed`. Neither costs a read.
- **Review pins the commit.** `verify_task` on such a task makes the API read the pull request again. The approval is refused with `commit_changed` if the head is no longer the submission's commit, with the same refusals as above if the pull request is no longer one the task may have, and with `change_not_found` if the submission has no pull request on record. An approval records `reviewed_commit_sha` and `reviewed_base_sha` from that read. Approval is one task event and asks for no merge (AC-17, M5-08).
- **The read** is `PullReader::read_pull` in `apps/api/src/github.rs`, beside `Provider` and `TokenIssuer`. **Ruled by the architect:** it uses the agent-token App, with a token minted for that read alone, narrowed to the one repository with `pull_requests` and `metadata` at `read` and nothing else, so it can't read the repository's contents, and revoked when the read ends. What GitHub says it minted must be exactly that. Never the provisioning App, and never the merge App. A token that comes back wider than asked is revoked unused. It keeps the pull request's number, the two repository IDs, the head and base commits, the base branch, the state, whether it's a draft, and for a merge its commit and GitHub's ID for the account that merged.
- **The refresh job** is the poll step 5 left open. The room's alarm re-reads each change that's stale by step 5's decision: a delivery newer than the last read, or the poll wait over, from 1 minute doubling to 1 hour while nothing changes. At most 5 changes an alarm, and 60 reads an hour for the repository; over that the read is dropped and the next poll catches up. Only for a task that's submitted or approved, in a room whose repository is ready, and not once the change is seen merged. A closed pull request is read only when a delivery names it.
- **Recording an observation is a command (ruled by the architect):** the row, an event and its outbox rows commit in one transaction. The events carry the task's ID and a state or reason code: `task_change.linked`, `task_change.observed`, `task_change.commit_changed` and `task_change.merge_observed`.
- **A head that moves after review** is recorded and changes nothing else: the task stays completed, `reviewed_commit_sha` stays what was reviewed, and one `task_change.commit_changed` event goes to the room's owner and admins and the task's requester and reviewer. **It's sticky:** `commit_changed_at` is set when the refresh first sees the head off the reviewed commit and is never cleared, even if the branch is later put back. **Step 7b refuses to merge when it's set.** The way on is a follow-up task (decision 25).
- **A merge Podster didn't ask for** is recorded with `classify_observed_merge`: `merge_reason` is `unrequested_merge` or `unreviewed_merge`, with the merge commit, the merger's ID and the time, and one `task_change.merge_observed` event to the room's owner and admins. `merge_state` isn't touched, so it's never a success. A merge Podster did ask for is left to 7b's merge job: 7a writes nothing about it, so `merge_observed_at` always means a merge Podster didn't ask for.
- **For people:** the task read (`getTask`) answers a `change` object, null for a task with none: IDs, commit IDs, states and times, with `commit_changed`, `pr_draft`, `watched`, `head_in_repository` and `base_is_default`. **Ruled by the architect:** it's shown to people in the room who see the task, other than guests, and to the task's own assignee and reviewer. Another agent, a guest and a public-claim participant get null even where they may read the task, and it's on no public page. The rule is `podster_policy::repositories::sees_task_change`, which step 3 had as "whoever sees the task".
- **The contract:** `pr_number` on `SubmitTask`, the `TaskChange` schema, and thirteen codes added to the error list. **No new capability or tool.** The gateway offers and passes on `pr_number` only while its own `MANAGED_REPOSITORIES` is exactly `true`.
- **One room migration,** forward-only: `task_change` gets `observed_base_sha`, `read_at`, `unchanged_reads`, `merged_by_id`, `read_failures`, `not_found_reads`, `unwatched_at`, `commit_changed_at` and `pr_draft`; `repo_link` gets `read_failures` and `reads_not_before`; and a new table, `repo_read`, counts reads for the caps, with the caller of each command's read. Step 2's columns had nowhere to keep the base seen at submission, the time of a failed read, either backoff, the sticky mark, the draft flag or who merged. No D1 migration.

**Decisions added to `crates/core`,** in a new `task_change` module, since none covered them: `check_pull` and `check_pull_number` (what may be a task's change), `watched` (which changes the job reads) and `observe` (what a fresh read changes). `repo_access` gets `TokenPermissions::READER`. Nothing in `crates/policy` changed.

**Judgment calls:**

- **A task is linked at creation, not at submission.** The brief's rule is "a room whose repository link allows work". Read at creation it gives a task one answer for its whole life, which `get_repo_access` needs before any submission. Read at submission, a task made before the repository was ready would be asked for a pull request its agent could never have had a token to open.
- **A different pull request number on a resubmission is refused.** The first one's record, and anything seen on it since, is never replaced. An agent whose pull request was closed reopens it; otherwise the work needs a new task.
- **No checks or statuses are read.** The agent-token App holds contents, pull requests and metadata, and no statuses or checks. `checks_state` and its columns stay null. **Step 8 needs the owner to add `statuses: read` and `checks: read` to that App**, and the read then asks for them.
- **A base branch's name is kept only when it's the default branch,** which the room already holds. A pull request retargeted elsewhere is kept as `base_ref` null with a read on record, shown as `base_is_default: false`. A branch name is the pull request's own text.
- **A read that finds nothing new records no event.** It moves the observation times and counts toward the poll's backoff. An event per poll would fill the room's history with nothing.
- **Reads for commands have their own caps, proposed:** 60 an hour for the room, apart from the refresh job's 60, and 20 an hour for any one caller, so an assignee sending wrong commits can't hold up the reviewer's approval. Over either, `rate_limited` (429).
- **The command's read comes before its transaction.** The room first checks, on what it holds, that the caller could make the command at all, so a caller who'd be refused costs no call to GitHub, and a replayed command reads nothing. The transaction then decides again from current state. If the room changed while GitHub was answering so that the read no longer fits, the command is refused `pull_request_unread` (409) and can be sent again.
- **A refused approval records nothing,** because its transaction rolls back. A head that moved before review reaches the record through the refresh job.
- **A submission made while the switch was off has no pull request on record,** and with the switch back on its approval is refused `change_not_found`. The reviewer sends it back and the agent submits again with the number.
- **The A2A paths can't submit or approve a linked task.** They send no commit, so `core::decide` refuses them as before this step.
- **Observation events are from `system`,** like a global disconnect's.
- **A pull request's answer may be up to 1 MB,** where other answers stop at 256 KB, so a long description can't make a pull request unreadable. The description is never kept.
- **A token GitHub doesn't confirm revoking** lives out its hour: read-only, on one repository. It's logged as `task_change.token_unrevoked` with the room's and the task's IDs.

**What 7b can rely on:** a linked task approved while the switch was on has a `task_change` row with its `pr_number`, `provider_repo_id`, `reviewed_commit_sha` and `reviewed_base_sha`, written in the approval's transaction from a read made for that approval, and never moved afterwards. `commit_changed_at`, once set, means the head has been off the reviewed commit, and 7b refuses. `PullReader` and `PullSeen` give it a read to compare against, though the merge job should read with its own App. `merge_state` is still `not_requested` everywhere: nothing in 7a sets it. A row whose `merge_reason` is already `unrequested_merge` or `unreviewed_merge` is a pull request someone else merged.

**The security review's findings, fixed on 2026-11-10** (the review found nothing high):

- **M1, a read that keeps failing.** A failed read by the refresh job now waits a minute, doubling to an hour, counted in `task_change.read_failures`, and no longer resets the poll's own backoff. A delivery doesn't cut the wait short. **After 5 reads in a row that find no such pull request, proposed,** the job stops watching the change (`unwatched_at`) and records `task_change.unwatched` for the room's owner and admins; a later submission or approval reads it again and watches it again. A `401` or `403`, which is a key or a permission and would fail every change the same way, makes the whole room's reads wait instead, with the same doubling, in `repo_link.read_failures` and `reads_not_before`, and stops that alarm's other reads. A read that works clears either.
- **M2, `commit_changed` is sticky,** as above.
- **L3.** A base branch name over 255 bytes reads as "not the default branch", so `pull_request_wrong_base`, not a failed read.
- **L4.** An approval takes its pull request only from a row for the room's linked repository, and its update names that repository and pull request.
- **L5, drafts. Ruled by the architect:** a draft is refused at submission and at approval with `pull_request_draft`. One that goes back to draft after approval is recorded as a change of state, shown as `pr_draft`, and un-approves nothing. Only the flag is kept.
- **L6.** The reader token no longer asks for `contents`.
- **L7.** The per-caller cap, above.
- **L9.** `core::decide` runs once without the read before anything about the pull request is checked, so a stale or malformed command is answered as that (`version_conflict` included) and never with a pull-request refusal. The first look had already kept such a command from costing a read.
- **L10.** Who is shown a task's change, above.
- **L11.** A requested merge is left to 7b, above.
- **`pull_request_unread` is tested,** by changing the task's record while the fake holds its answer at a gate the test opens.

**The re-review's findings, fixed on 2026-11-10:**

- **A failed token request never unwatches a change.** Only GitHub's own answer that the pull request isn't there counts towards the five. A `401` or `403` at either stage, or a `404` when asking for the token, which is the installation gone, is the room's credential failing: the room's reads wait, no change is touched, and one `repository.read_refused` event with the fixed code `provider_credential_failed` goes to the room's owner and admins for each run of refusals. Any other failed token request is that change's own failed read.
- **A delivery puts a given-up change back under watch.** A nudge that names the change clears `unwatched_at` and the not-found count, so a pull request that reappears is read again, also on a completed task.
- **Events follow the same rule as the change.** `task_change.*` events are shown, in a task's history and in the room's activity, only to those `sees_task_change` allows; `can_see_event` decides. The notices go to the room's human owner and admins, the reviewer, and the requester only if they're a person and no guest.
- **Tests no longer rest on a sleep or on the order of the room's own alarm.** The fake holds a mint at a gate until the test releases it, for this step's race test and for step 6's test of authority ending during a mint. That test's ordering is now fixed. It still needs the mint released within the test build's 400 ms call timeout, so a runner that stalls for longer can still answer `provider_unavailable`.

**Gaps, acknowledged:**

- **No cap across rooms** on these reads, as for step 6's mints. Each read is three calls to GitHub (mint, read, revoke) against the agent-token App's installation, whose 5,000 requests an hour every room shares.
- **A linked task approved while the switch was off has no `reviewed_commit_sha`.** Step 7b must refuse to merge it, and it needs a fresh review.
- **A push between a command's read and its commit isn't seen by that command.** The row records the head that was read, and the refresh job records the newer one. After an approval that sets `commit_changed_at`.

**Left to 7b:** `merge_task`, its capability and route, the mark and the merge, `merge.requested`, `merge.succeeded` and `merge.failed`, and AC-17's revisit in `e2e/journey.mjs`. **Left to 8:** checks and statuses, and `get_task_release_status`. **Left to 9:** showing a task's change on a screen.

**Unverified against GitHub:** the pull request read's fields (`state`, `merged`, `merge_commit_sha`, `merged_by.id`, `head.sha`, `head.repo.id`, `base.ref`, `base.sha`, `base.repo.id`), and that `head.repo` is null for a deleted fork; addressing a pull request as `/repositories/{id}/pulls/{number}`; minting a `read`-only token from the agent-token App, whose installation holds `write`; whether that App could read statuses and checks if asked; and how large a pull request's answer can be. The fake answers as the documentation says.

**Checked:** locally only, as the PR lists. Nothing ran against GitHub or a deployment, so M5-08 doesn't count as passed.

### Step 7b: what was built

**Built, 2026-11-11.** Everything sits behind `MANAGED_REPOSITORIES`, which is set nowhere. With it off the route answers as one that doesn't exist, the gateway lists no merge tool, and `e2e/journey.mjs` passes unchanged, AC-17 included. **This is the one place Podster changes a repository's default branch.**

**The command, `merge_task`** (`POST /v1/workspaces/{ws}/tasks/{t}/merge`, `{ submission_no, commit_sha }`), for a person or an agent. It records that a merge was asked for and calls GitHub for nothing. The state, a `merge.requested` event, its outbox rows and the idempotency record commit in one transaction, and the room's alarm is armed. It refuses unless:

- the caller can see the task (`task_not_found` otherwise, before anything else is said);
- the caller isn't the submitter, the task's assignee, or controlled by the same person as the submitter (`self_merge`, ruling A). A caller or submitter whose controlling person nobody can name is refused the same way;
- the caller holds a `merge` grant that counts: live, on the room's repository, from whoever holds the delegation now (`grant_required`, `grant_expired`, `grant_stale`), and isn't in the room through a public claim;
- the task is linked (`task_not_linked`) in a room whose repository is ready (`repo_not_ready`), approved (`not_approved`) as the submission and commit named (`submission_mismatch`, `commit_changed`);
- the approval recorded a reviewed commit from Podster's own read (`review_required` for one made while the switch was off), the head has never been seen off it (`commit_changed`, sticky), and the change is still watched (`change_unwatched`);
- no merge is under way (`merge_already_requested`) or done (`already_merged`);
- fewer than 20 merge requests were made in the room in the last hour (`rate_limited`), and fewer than 10 for this task in its whole life (`merge_request_limit`), **both proposed.** Every request is logged and counts, a repeated one for the same task included, and asking again never resets either. `core::merge_request_allowed` decides. The body takes the two fields and no other (`invalid_argument`);
- the merge App is configured (`merge_unavailable`), checked last, so nothing is recorded that the job could never carry out.

**The controlling person** is from the gateway's assertion: a person is their own, and an agent's is whoever linked its credential. A submission now records its submitter and that person on the task's change, and a merge request records the requester's. The job compares those records and never asks again.

**The job** runs from the room's alarm, at most two merges an alarm. Alarms are at-least-once, so each pass starts from what the room holds and what GitHub shows, and writes down what it's about to do before each call that changes anything on GitHub:

1. **The pass is counted first,** with the time of the next one (5 seconds doubling to 5 minutes), in the transaction that decides authority. So a pass that dies, or that waits because the owner's standing couldn't be read, is still counted. After 5 passes, **proposed,** the merge fails `merge_attempts_exhausted` and a person asks again.
2. **Authority again.** A room archived or suspended since the request does nothing more on a repository: the merge fails `workspace_archived` or `room_suspended`. Then `core::check_merge_authority` on current rows: the requester still in the room, the grant still live and its giver still holding the delegation, the task still approved, the change still standing as reviewed. Anything else ends the merge as failed with that refusal's code.
3. **Readiness.** The provisioning App, narrowed to the repository, reads its protections back, and provisioning's own `verify_ready` judges them: both rulesets present, active and exactly as set, the bypass list exactly the merge App, Actions off. It also compares the default branch GitHub reports with the one the link holds, since the rules protect whatever the default branch is now. A different one fails the merge `default_branch_changed`. The merge App makes the same comparison with its own reads: with the pull request before the mark, immediately before the merge call, where a different or unreadable default means no call is made, and in the read after it. **A definite difference** sets the link `degraded` with the reason, records `repository.degraded`, and fails the merge `repo_not_ready`; nothing is marked. **Anything that isn't a definite answer** (a server error, a limit, a refusal, no reply, an unreadable body) is a read that couldn't be made: the pass waits, counted, and the link is untouched.
4. **The pull request and the default branch,** read with the merge App's read-only token. The head must be the reviewed commit (`commit_changed`, which also sets `commit_changed_at`), in the room's repository (`head_repo_changed`), on the default branch (`base_changed`), open (`pull_request_closed`) and no draft (`pull_request_draft`). One already merged before the job ever asked GitHub for a merge is someone else's (`merged_elsewhere`). `core::decide_merge_step` decides.
5. **Mark.** In one transaction, authority, the change's standing and the room are decided again from current rows, and `merge_marked_at` is written. A grant revoked, a requester removed, or a room archived or suspended while GitHub was answering ends the merge there. Then the `podster/review` status is set to success on exactly the reviewed commit, with a merge App token that can set statuses and nothing else, then `merge_mark_set_at` is written.
6. **Merge.** The same again: authority decided from current rows and `merge_called_at` and the base commit seen (`merge_base_sha`) written, in one transaction. Then `PUT /pulls/{n}/merge` with `sha` the reviewed commit and `merge_method: merge`, with a merge App token for contents and pull requests. Then the pull request and the default branch are read again with that token. **Only that read says what happened:** success is the pull request read as merged, with the reviewed commit as its head and the default branch holding it. `core::merge_call` reads the call's status only as a hint: `409` is a head that moved, `405` or another refusal is `provider_refused`, and a timeout or a `5xx` is unknown, which means read again.
7. **The outcome** is one transaction: `core::merge_transition`, which takes success only with the proof `decide_merge_step` gives; the row; a `merge.succeeded` or `merge.failed` event with a reason code, for the room's human owner and admins and whoever asked; and the outbox. A merged change isn't watched any more.

**Why marking before merging is safe, and what dying leaves behind.** The spike showed that with the two rulesets only the merge App's token updates the default branch, and only for a commit that App marked. So a mark alone moves nothing: an agent's token can't merge a marked commit, on the paths tried, and the merge App's key is held only by this job. That leaves the job's own restarts:

- **Before the mark.** Nothing was set. The next pass does steps 2 to 4 again.
- **After the mark, before the merge call.** A status sits on the reviewed commit. The next pass does steps 2 to 4 again before it marks or merges, so a merge is never made on authority or a head from an earlier pass. If authority has gone or the head has moved, the merge fails and the status stays where it is, on a commit nobody else can merge. A new head has no status.
- **After the merge call, its answer never seen.** `merge_called_at` is on record, so the next pass reads first. Merged, with the reviewed commit and the default branch holding it, is success with no second call. Still open, it does steps 2 to 6 again. It never asks for a second merge without having read the pull request as open. On the last pass allowed it only reads.
- **Once a call is on record, nothing ends the merge without a read of what that call did.** Authority lost, the room archived or suspended, the repository no longer ready, the passes used up: each reads the pull request and the default branch first, with the merge App's read-only token. If the reviewed commit is merged and on the default branch, that's this request's success, even if authority ended a moment later: the call was authorized, from current rows, in the transaction that recorded it. If GitHub can't be read, the merge isn't ended as failed or exhausted: it becomes `outcome_unknown`, with one `merge.outcome_unknown` event, and the job goes on reading every 15 minutes until a read settles it, as succeeded if the call merged the reviewed commit and as failed with the reason it was about to end with otherwise. No new merge can be asked for meanwhile.

**Tokens.** Four per clean pass, each minted for the one repository, checked to be exactly as narrow as asked and revoked on every way out: the provisioning App's for the read-back; the merge App's read-only one (`contents` and `pull_requests` read); its marking one (`statuses` write only); and its merging one (`contents` and `pull_requests` write), which also makes the reads after the call. One that comes back wider is revoked unused. None is stored, logged, or put in an event, D1, the outbox or an error. A token GitHub doesn't confirm revoking is logged as `merge.token_unrevoked` with IDs.

**The merge App's configuration:** `GITHUB_MERGE_APP_ID`, which provisioning already reads, and two new names, the variable `GITHUB_MERGE_INSTALLATION_ID` and the secret `GITHUB_MERGE_APP_KEY`. All unset everywhere. It's refused as not configured when its App ID, installation or key is the provisioning App's or the agent-token App's.

**The gateway** lists `merge_task` only when its own `MANAGED_REPOSITORIES` is exactly `true`, as for `get_repo_access`, and passes on the submission number and the commit and nothing that could name a repository or a pull request.

**One room migration,** forward-only, appended after step 7a's, which is deployed to staging and wasn't edited. `task_change` gets `submitter_id`, `submitter_person`, `merge_requester_person`, `merge_attempts`, `merge_next_at`, `merge_step`, `merge_marked_at`, `merge_mark_set_at`, `merge_called_at` and `merge_finished_at`, and a new table, `merge_request`, logs each request for the caps. No D1 migration.

**Decisions added to `crates/core`,** in `repo_merge`, since none covered them: `check_change_standing` (the reviewed commit on record, no changed commit, still watched), `merge_call` (a status as a hint), `MergeAuthorized::when_called`, the caps (`merge_request_allowed`), the `outcome_unknown` state and its transitions, `provisioning::decide_recheck`, the refusals `review_required` and `change_unwatched`, and the failures `pull_request_draft`, `merged_elsewhere`, `repo_not_ready`, `merge_attempts_exhausted`, `workspace_archived`, `room_suspended` and `default_branch_changed`. `repo_access` gets the merge App's three permission sets. In `crates/policy`, `authorize_recheck` is new, and `can_see_event` shows `merge.*` events to those shown the task's change and to whoever asked for the merge.

**Judgment calls:**

- **A pull request found merged before the job asked for anything is `merged_elsewhere`,** whatever commit it was of. After the job has asked, a merged pull request with the reviewed commit as its head, and the default branch holding it, is this request's success. If someone else merged that same commit in the instant between the job's read and its call, that's counted as success too: the reviewed commit is what's on the default branch either way. Who merged is kept as GitHub's ID for the account, and isn't compared, because the merge App's account ID isn't something Podster holds.
- **A changed commit found by the job is sticky** like one the refresh finds: `commit_changed_at` is set, and the merge can't be asked for again.
- **A merge whose requester lost authority after its call went out is recorded as what the call did.** `core::MergeAuthorized::when_called` rebuilds the authorization the call was made under, from the room's record of that call, only to ask `decide_merge_step` whether it merged. It never justifies a new mark or a new call.
- **A re-request keeps the earlier request's mark and call times.** A merge that request made, and that only shows now, is still read as Podster's own.
- **Nothing un-degrades by itself. Ruled by the architect:** rules that changed mean someone with admin rights touched the repository, so a person looks. An operator's `POST /v1/moderation/repositories/{ws}/recheck` is its own command: `podster_policy::repositories::authorize_recheck` decides who may ask, the same read-back is made, and `podster_core::provisioning::decide_recheck` decides what it does. Only a degraded link read back exactly right becomes `ready` again, with `repository.ready_again`, its outbox rows and the idempotency record in one transaction, and an entry in the operators' record. Still wrong, it answers what differs; no definite answer, it changes nothing.
- **`405` doesn't degrade the link by itself.** The protections were read back as right in that same pass, so the refusal is recorded as `provider_refused` and can be asked for again.
- **An unknown owner standing counts as a pass,** with the same backoff, and so ends within the cap.
- **A change with no submitter on record,** as one from before this step, refuses every requester as `self_merge`: nobody can be shown not to be them.
- **A task with no change at all** answers `self_merge` for the same reason, since policy runs first.
- **The requester of a merge sees its events,** as actor or as subject, while they can see the task. An agent with a merge grant is seldom the task's assignee or reviewer.
- **The merge's times:** `merge_finished_at` is new, for either outcome. `merge_observed_at` stays what step 7a made it: a merge Podster didn't ask for.

**Provisioning's read-back had the same flaw as the merge job's, in a milder form.** A failed read of the Actions setting was taken as "Actions may be on" and failed the setup as `actions_unreadable`. It's now a read that couldn't be made, `read_back_failed`, which the owner can retry. At provisioning there's no stored default branch to compare: the link takes the one that read reports.

**From step 7a's review, in this PR:** the room's activity list now narrows `task_change.*` and `merge.*` events in its query, so a viewer not shown them doesn't get short pages; the specs' `minting()` gives up after five seconds with "no mint reached the gate"; a stale comment in `changes.rs` is fixed; and two test steps were reordered so the fake's answer is set before the row that makes a read due.

**Gaps, acknowledged:**

- **No cap across rooms** on the three Apps' shared 5,000 requests an hour each, as for steps 6 and 7a. A clean merge is about 20 calls.
- **The window between the job's read and its merge call** is covered by `sha` on the call: GitHub refuses if the head moved. A base that moves in that window still merges, as ADR 0009 proposes, with the base seen recorded.
- **The local rehearsal merges against a fake, not GitHub.** `e2e/merge-check.mjs` runs on the real gateway and API with the test suite's fake GitHub served on the same machine. An operator delegates, the owner asks, and the room's job provisions the repository through the fake. Then, each with its exact answer: an approved task nobody asks about isn't merged; the submitter, another agent of its owner and that owner, each holding a merge grant, are refused `self_merge`; an agent of another person with no grant is refused `grant_required`; and with the grant its `merge_task` leads to exactly one merge call, for the reviewed commit, which the task records. Then four things GitHub's rules refused in the spike, as the fake holds to them: an agent's token can't commit to the default branch (`409`), move its ref (`422`) or merge (`405`); a commit with no review status isn't merged (`provider_refused`); a status from another App doesn't count (`provider_refused`); and a head moved after review isn't merged (`commit_changed`, with no merge call). For that stack only, the API is built with a `rehearsal` feature that fixes GitHub's address, at build time, to an address checked to be `http://127.0.0.1:<port>`. No variable, secret or request can redirect a deployed Worker, and `run-local.mjs` puts the plain release build back afterwards. `e2e/managed-off-check.mjs` shows the off state: no managed-repository tool, and both routes answering as a task verb that doesn't exist.
- **Not tested:** an owner standing that can't be read, which needs the owner's `Principal` to be unreachable.

**Unverified against GitHub:** minting a merge App token with `statuses: write` alone, and whether that's enough for the status call; the merge call's answers beyond what the spike saw (`200`, `405`, `409`); the compare call (`/compare/{branch}...{sha}`, `behind` or `identical` meaning the default branch holds the commit) and its permission; how soon after a merge the pull request reads as merged and the default branch shows the commit; that `merged_by` is present; and everything step 7a lists. The fake answers as the documentation and the spike say.

**Left to 8:** checks and statuses, and `get_task_release_status`, which is also how an agent that asked for a merge will read its outcome without the room's activity. **Left to 9:** asking for a merge from a screen, and showing its state.

**Checked:** locally only, as the PR lists. Nothing ran against GitHub or a deployment, so M5-09 and M5-10 don't count as passed.

### Step 8: what was built

**Built, 2026-11-11.** Behind `MANAGED_REPOSITORIES`, which is on for staging since 2026-11-11 (PR #268) and set nowhere else. With it off the route answers as a read that doesn't exist and the gateway lists no such tool.

- **The read, `get_task_release_status`** (`GET /v1/workspaces/{ws}/tasks/{t}/release-status`), for a person or an agent: the task's checks and its merge, apart, each as Podster last observed it and with that observation's time, and `release.exists: false`, since M5 has no releases. **Nothing is fetched on the read.** `core::release_status::report` builds the two from the room's own rows, and neither is inferred from the other: a failed check stays a failed check beside a merge that succeeded, and a failed merge beside checks that pass (M5-12).
- **Who may read it, and how much:** `policy::authorize_release_status`. It shows exactly what the caller's view of the task's change shows, no more. Whoever is shown the change gets all of it. Whoever asked for the merge and isn't shown the change gets the merge alone, with the pull request and the checks null. Anyone else who can read the task gets `not_allowed`, the same with or without a pull request on record, and anyone who can't gets `task_not_found`.
- **Checks are observed by the refresh job,** after its read of the pull request, for the head it just saw: the commit's combined status and its check runs, with a token from the agent-token App for that one repository with `statuses`, `checks` and `metadata` at `read` and nothing else, revoked when the read ends. `core::release_status::summarize_checks` sums them up: `failure` if any failed, else `pending` if any is unfinished, else `success`, or `none`. A word nobody knows is never a pass. Only the state, three counts, the time and the commit they were read for are kept. **Checks are never shown beside a commit they weren't read for:** they're cleared when the head moves, and the read reports them only if their commit is the head on record. A context, a name, a description or a URL never leaves `crate::github`. A change of state records `task_change.checks_observed`. A read that fails leaves what was held, with its older time.
- **Checks are read only where the App has been given them.** The agent-token App holds no statuses or checks permission today, and a token for them can't be minted. So the job asks for them only when the Worker's `GITHUB_AGENT_APP_READS_CHECKS` is exactly `true`, which is set nowhere. Until then `checks.state` is null, which says only that Podster hasn't read them.
- **The gateway** lists `get_task_release_status` only when its own switch is exactly `true`, and a call to it while off answers as a call to a tool that doesn't exist.
- **No migration.** Step 2's `checks_state`, `checks_json` and `checks_observed_at` hold it.

**Judgment calls:**

- **A new variable name, `GITHUB_AGENT_APP_READS_CHECKS`,** rather than trying a token the App can't mint on every refresh.
- **The checks read counts against the repository's hourly read cap,** like the pull request read before it. Over the cap the checks wait.
- **`merge.observed_at` is the time of what the state says:** the end of a requested merge, the request while it's under way or unknown, or the sighting of a merge nobody asked Podster for.
- **A task with no pull request on record answers with nulls,** not a refusal.

**Carry-overs from step 7b's reviews, in the same PR, each with a test:**

- A merge that landed is recorded as merged only once the default branch has been read. Until then the job waits and reads again. The pass that made the call and a later pass that only reads take the same decision, `core::decide_landed`, so a changed default branch degrades the link in both.
- The owner's standing is asked of their `Principal` again before the intent to mark and before the intent to merge.
- **Reads for an unknown outcome stop.** Fifteen minutes doubling to six hours, at most 12 reads, **both proposed.** In a room that's archived or suspended they stop at once. The state stays `outcome_unknown`, the step says the job has stopped, one `merge.outcome_unknown_final` event is recorded, and a person may ask for the merge again, which begins with a read (`core::requestable_state`). **It isn't stranded there. Ruled by the architect:** step 7a's ordinary watch settles any merge whose outcome is unknown, whether the job is still counting its reads or has stopped, in the transaction of its own observation. The watch may well see the merge first, and it stops watching a merged pull request. When its normal read shows the pull request merged with the reviewed commit as its head, from the room's repository, into the link's default branch, the merge is recorded as succeeded; closed unmerged, or merged at another commit, as failed (`core::settle_unknown_from_watch`, which is `decide_landed` on what that read carries). The job's next read finds it settled and does nothing. No extra read, no merge call and no token beyond the watch's own. **If the default branch the pull request's answer names for its repository isn't the link's,** the watch records no merge into a branch that isn't the default: it degrades the link and leaves the outcome to the job's fuller read or a new request. If the answer names none, nothing is settled.
- `e2e/repo-access-check.mjs` expects one exact code for each refusal.
- **With the switch off, nobody is shown a change's or a merge's events,** in a task's history or in the activity. On, those not shown the change don't see them either, as step 7b built.
- **The activity list narrows those events in its query,** for both cases, so no page comes up short.

**Accepted, not changed (ruled by the architect):**

- The owner's and admins' `events` feed still lists merge event types while the switch is off. It carries IDs only, and it's their oversight record.
- A person merging exactly the reviewed commit by hand, after the job recorded its intent to merge, is recorded as this request's success, as the job's own read already has it: the reviewed commit is what's on the default branch.
- When the watch sees a merge of a commit nobody reviewed on a change whose request then fails, `merge_reason` becomes `unreviewed_merge`, over the reason the request was about to end with. It's the more important fact.

**What needs the owner:** adding `statuses: read` and `checks: read` to the agent-token App, and then setting `GITHUB_AGENT_APP_READS_CHECKS`. M5-12 on staging also needs a test status posted by a test App or token, as ADR 0009 says.

**Unverified against GitHub:** minting a token with `statuses` and `checks` read from the agent-token App; the combined status and check-runs answers' fields; how many of each a commit can have beyond the first 100, which are all that's counted.

**Checked:** locally only, as the PR lists. Nothing ran against GitHub or a deployment, so M5-12 doesn't count as passed.

### Step 10: the staging script

**Written, 2026-11-11. It has not run against staging, so nothing below has passed.** `e2e/m5-staging.mjs` walks one room through the whole flow on staging, against real GitHub in `podsterdev`, and [staging.md](staging.md#m5s-staging-run) says how to run it. Its first run is the architect's to schedule, around M4's rerun, since both draw on the test sign-up's 40 people a day.

- **It accepts staging's gateway and nothing else.** There's no local rehearsal of the script itself. `e2e/merge-check.mjs` and `e2e/repo-access-check.mjs` stay the local rehearsals, against the fake GitHub.
- **Sign-ups: 2 a run,** the fewest it can take: the room's owner, and a second person who is the room's admin. *Until 2026-11-11 it took 3, with a test operator who gave the delegation; [decision 194](spec/PRODUCT.md#decisions-needed) ended that, and no operator takes part.* The room is in an organization the owner makes for the run, which the second person joins. The five agents are made under those two people.
- **The organization on GitHub is pinned in code** to `podsterdev`: the script refuses to run on a configuration naming another, and fails a repository staging links anywhere else. The self-test checks that `apps/api/wrangler.jsonc` names `podsterdev` for staging.
- **The daily cap isn't shown on staging.** Its refusal only comes after 5 accepted requests, which would be 5 real public repositories a run that nothing can delete. `apps/api`'s tests and the local rehearsal's `AC-10c` show it against the fake.
- **One exact answer per assertion:** a status and a code for a person, and a code for an agent, since MCP carries no HTTP status. No check accepts one of several answers. The statuses GitHub itself gives the agent's token (`409`, `422`, `405`, `403`, `401`) are the ones [the spike](../spikes/m5-github/README.md#results-merge-restriction) saw.
- **The token** goes to `git` in a child process with `e2e/child-env.mjs`'s allow-listed environment and a home directory of its own, under one name in that environment. It's never printed, never on a command line and never written to a file. The script holds no App key.
- **A check that can't run says `SKIP`,** with its reason, and is counted. The run exits 0 only if nothing failed. Before the gate is called, a skip needs its own answer.
- **It can't clean up GitHub.** Podster has no delete, so each run leaves one public repository, `e2e-m5-<time>-<4 hex>`, with two pull requests. The script prints the name for the owner to archive or delete, as soon as any request for it is accepted or goes unanswered, and again at the end.
- **What M5-G1 leaves in the room:** person review switched on, a publicly claimable opening named Observer, and the claimant as a participant through its public claim. The room is made private again, and the delegation is taken back.

| Check | What it shows on staging | From |
| --- | --- | --- |
| M5-00 | Managed repositories are on, and a room that hasn't asked has no repository | M5-01 |
| M5-14 | No operator approves first: the organization, which nobody set a delegation for, holds it, and the room's owner and admin are told so. *Until 2026-11-11: without the delegation the owner's request was refused `403 not_delegated`; an operator's take-back is in `apps/api`'s tests and the rehearsal's `AC-10d`.* | M5-14, decision 194 |
| M5-04 | A request naming an organization or an installation is refused `400 invalid_argument` | M5-04 |
| M5-01 | A room admin's request, a person who isn't the owner, is recorded `pending` under their name and becomes a `ready` repository within the wait, with GitHub's ID, under `podsterdev` | M5-01, AC-10 |
| M5-02 | GitHub shows the repository public, under `podsterdev` by its ID, while the room is private | M5-02 |
| M5-01b | GitHub shows exactly two rulesets on the default branch, both active: one with `pull_request` and `podster/review` required from the merge App, one with `update` | ADR 0009 |
| M5-A1 | An agent can't be made a room admin, `400 invalid_argument`, and is offered no tool to ask for a repository or give a grant | AC-10 |
| M5-05 | `get_repo_access` with no grant is refused `grant_required`, with no token in the answer | M5-05 |
| M5-G2 | The room admin's `push` grant is given, recorded as theirs and listed `live` | Step 5b, AC-11 |
| M5-06a | The token is for the room's repository, with exactly contents, pull requests and metadata, for at most an hour, and asking again returns the same one | M5-06 |
| M5-06b | It pushes a task branch with `git` over HTTPS and opens a pull request | M5-06 |
| M5-06c | `git push` to the default branch is refused by GitHub, and the branch doesn't move | M5-06, the gate |
| M5-06d | Through the API it can't commit to the default branch (`409`), move its ref (`422`) or merge its pull request (`405`) | M5-06 |
| M5-06e | It can't set `podster/review` or change the repository's settings (`403` each) | M5-06 |
| M5-08a | The submission records its commit, and the task's change shows the pull request as Podster read it | M5-08 |
| M5-07a | After the submission a new token is refused `task_not_active`, and GitHub answers `401` for the old one within the wait | M5-07 |
| M5-10a | A merge-grant holder asking before approval is refused `not_approved` | M5-10 |
| M5-10b | After approval, the submitter and the person who controls it, each holding a merge grant, are refused `self_merge` (`403` for the person) | M5-10 |
| M5-10c | An agent another person controls, with the task approved and no merge grant, is refused `grant_required`. Staging has never exercised this | M5-10 |
| M5-G3 | A merge grant past its expiry is refused `grant_expired`. The script waits until the API lists it `expired`, by the API's clock, before it asks. If that wait runs out, clean-up takes the grant back, so no live merge grant is left | Step 5b |
| M5-10d | Approval and every refusal merged nothing: the merge is `not_requested` and the default branch hasn't moved | AC-17 |
| M5-09a | The grant holder's `merge_task` is recorded `requested`, and the merge `succeeded` within the wait | M5-09 |
| M5-09b | On GitHub the default branch's tip is the recorded merge commit, whose parents are the old tip and exactly the reviewed commit | M5-09 |
| M5-09c | The reviewed commit carries exactly one `podster/review` status, a success, created by the merge App | ADR 0009 |
| M5-09d | Asking again is refused `already_merged` | Step 7b |
| M5-11a | A commit pushed to a reviewed branch is seen by Podster within the wait. The time is printed; the script can't tell a webhook from the poll | M5-11 |
| M5-09e | That moved head isn't merged: `merge_task` is refused `commit_changed`, the task stays completed, and GitHub shows the pull request open | M5-09 |
| M5-12 | Release status says what the task's change says, reports checks only beside the commit they were read for, and says no release exists. Skipped while the route answers as a missing one | M5-12, step 8 |
| M5-V1 | An agent that reads the task and isn't shown its change gets a null change, as for a task with none | Step 7a |
| M5-V2 | A guest not party to the task gets `task_not_found` from `get_task`, `get_repo_access` and `merge_task`, as for a task that doesn't exist | Steps 6 and 7b |
| M5-G4 | A `push` grant taken back is refused `grant_required`, and GitHub answers `401` for the token it backed within the wait | M5-07 |
| M5-G1 | A grant to a public-claim participant is refused `400 grantee_public`. Skipped while `PUBLIC_ROOMS` is off | Step 5b |

**What it leaves out, each still owed before the gate or covered elsewhere:**

- **"Nothing reaches GitHub" can't be seen from outside.** M5-05 and M5-14 each say a refused call sends GitHub nothing. The script sees only Podster's refusal, and for M5-14 that the room records no request. Whether a call went out is shown only by the API's tests against the fake.
- **"A room without Git creates none"** (the rest of M5-01) is only M5-00: Podster's own read of a room that hasn't asked says it has no request and no repository. The script doesn't look in `podsterdev` for a repository that shouldn't be there.
- **M5-03 and M5-15:** a timed-out, failed or retried setup. The script never breaks GitHub to cause one.
- **The rest of M5-06:** another repository, a workflow file and creating a ruleset. **The rest of M5-07:** a removed agent, and how long its token works. **The rest of M5-08:** approval refused after the branch advances. **The rest of M5-09:** a request that lands before Podster notices the moved head and fails in the job, which is M5-S7viii locally.
- **M5-11's bad signature and M5-16:** `scripts/staging-probes` checks an unsigned delivery. A replayed or misdirected delivery needs the webhook secret, which the script never holds.
- **The rest of M5-12:** a failed check and a failed merge. **M5-13:** the Workers' logs, which M4's script reads with `wrangler tail` and this one doesn't.
- **Bypass lists.** GitHub shows them to administrators only, so M5-01b sees the rules and not who may bypass them.
- **The operator's recheck,** the [operator's reset](#owed-before-production), and anything in production.
### Self-serve repositories: what was built

**Built, 2026-11-11, from the owner's decision that day ([decision 194](spec/PRODUCT.md#decisions-needed)).** The owner's words: "who are the operators? an admin of a workroom should be able to connect to repo .. it doesn't have to be only an operators somewehre". Asked two questions, the owner chose "No gate, with limits" for an operator's approval of an organization, and "Owner and admins" for who in a workroom asks for the repository and gives grants. This replaces step 4's ruling of 2026-11-10 that only an operator gives the delegation. Everything is still behind `MANAGED_REPOSITORIES`.

- **Every organization holds the delegation by default.** No record means held (`core::provisioning::organization_delegated`). `PUT /v1/orgs/{org}/provisioning-delegation` stays an operator's alone and now matters only to take it back and to restore it. **No migration:** only an operator's `PUT` ever wrote a record, so a stored `granted: false` is an operator's explicit take-back and stays one.
- **Caps, proposed.** One repository per room, as before. At most 5 accepted requests in any 24 hours for an organization (`core::provisioning::repository_request_allowed`), counted in the organization's own `Principal` in the call that reads the delegation, and refused `repository_request_limit` (429) with nothing recorded.
  - **The same cap holds for one person asking, in the person's own `Principal`.** One person can create any number of organizations: the gateway's `POST /api/orgs` has no limit, and every person has a personal one. So an organization's cap alone holds nothing.
  - **A room is counted once, and never un-counted.** A replay, a second request for a room that has one and a retry of its setup cost nothing, and a request the room refuses for itself is never counted. The protocol, and when a count comes out too high, are [below](#self-serve-repositories-what-was-built) under "How a request is counted".
- **A person who is the room's owner or a room admin runs its repository** (`policy::authorize_repository_admin`, `holds_repository_delegation`): asks for it, retries its setup, gives grants and takes any back. Never an agent, whatever role is stored for it, and a participant there through a public claim is a guest, so never passes. `no_provider_delegation` is gone from the contract: an admin isn't refused any more, and everyone else is `not_allowed`.
- **A grant counts only while its giver is still the owner or an admin.** At every use, for a token and at each step of a merge, the room reads the giver's current row and asks the giver's own `Principal` whether they've left the organization their role is held in (`Workspace::giver_read`, `standing_giver`, `policy::delegation_holder`). If that can't be read, nothing is minted or merged (`standing_unknown`, or the merge job waits, counted).
  - **An admin's grants end in the change that demotes or removes them** (`giver_lost_authority`), so making them an admin again restores nothing, as rejoining restores nothing elsewhere.
  - **Unchanged:** a transfer or recovery of ownership still ends every grant the new owner didn't give, including an admin's.
- **Unchanged and still tested:** `self_merge` (an admin who controls the submitting agent can grant themselves or their other agent a merge and still can't merge that work), `grantee_public`, expiry, take-back, what the release status and a task's change show to whom, and `delegated` in the room's repository read, now for the owner and admins and still left out when unknown.
- **The setup job** ends a pending request `requester_lost_authority` when whoever asked is no longer the room's owner or an admin. `requester_not_owner` stays in rows from before.
- **What follows from "Owner and admins" and "No gate, with limits", stated plainly:**
  - **In a room whose owner has left, its admins can still ask for the repository and give grants.** Before 2026-11-11 nobody could until ownership was recovered.
  - **An admin who grants a principal an action the owner already granted them replaces the owner's row with their own.** That grant then ends if that admin is demoted or removed, though the owner gave it first.
  - **An operator's take-back stops new requests and retries of setup, and a setup job that hasn't linked its repository yet (`not_delegated`), and nothing else.** Nothing is counted for a refused request. Repositories already linked, their tokens, grants and merges keep working. **Ruled by the architect, 2026-11-11; for the owner to review:** the owner's words were only that an operator "can take the ability away from an organization".
  - **There is no cap across sign-ups.** The cap is 5 accepted requests for one person in a rolling 24 hours, so N sign-ups get 5N. Nothing holds people acting together, or one person with many accounts. Owed to M7's security review.
  - **How a request is counted.** A request is counted like this, and never un-counted (ruled by the architect on 2026-11-11, after three reviews each found a way to record a request that no count held):
    - **One place per room, in each object.** The organization's object and the asker's own each keep one row per room, stamped with when it was last asked for. Asking is "insert if absent, otherwise stamp again with now", in one transaction with the delegation read in the organization's object, by that object's own clock. It's held if the room already has a place there, or if fewer than 5 other rooms were stamped in the last 24 hours.
    - **There is no release.** A request that fails after it was counted leaves its room counted until 24 hours pass with nobody asking for that room again; every held ask stamps the place with now. The organization is asked first, then the person; if the person's object refuses or can't answer, the organization's place for that room stays.
    - **The room's transaction records only if this very call was told "held" by both objects,** for the caller it resolves inside the transaction and the organization the room is in then. Otherwise it refuses with `delegation_unavailable`, retryable.
    - **So a count is only ever too high.** The cases: a call refused in its transaction (the caller demoted meanwhile, a second call for a room that just got its request, a failed write); the person's cap or an unreachable person's object after the organization counted; and, for two people asking for one room at once, the person who didn't record. Each ages out 24 hours after the last ask for that room, and only if nobody asks for it again: every held ask stamps the place with now, so asking again keeps it.
    - **Accepted consequence: one person can fill an organization's five places with nothing recorded.** The organization is reserved before the person. So a person already at their own cap, who is owner or admin of more rooms in an organization, can ask for five of those rooms: each ask takes the organization's place, the person's own object refuses, and nothing is recorded. Asking again within each 24 hours keeps the places, and meanwhile no other room of that organization can ask. It needs authority in each of those rooms, so it isn't a way for someone without authority to block others. Accepted by the review of 2026-11-11; owed to M7's security review.
    - **Only someone with authority can use a place up.** A reserve is reached only by a person who is the room's owner or an admin at the look before it, so nobody burns another organization's places without already running a room in it.
    - **What the cap bounds, honestly:** rooms asked for, not calls to GitHub. A counted request can run setup up to 5 times, and each run whose outcome is unknown may leave a repository under a new name. So the worst case is 25 repositories on GitHub for an organization in a day, if every outcome is unknown; the ordinary case is 5. Owed to M7's security review.

- **The rehearsal:** `e2e/repo-admin-check.mjs`, run by `e2e/run-local.mjs` on the switched-on stack: AC-10 and AC-11 under the new rule, the cap and the take-back, each refusal one exact code. `e2e/merge-check.mjs` no longer has an operator delegate first. `e2e/journey.mjs` had no AC-10 or AC-11 check and is unchanged.
- **The staging script,** `e2e/m5-staging.mjs`, follows the rule: no operator and 2 sign-ups, the room's admin asks for the repository and gives the push grant, and an agent can't be made an admin. It also pins `podsterdev` in code, and takes back M5-G3's short merge grant if its expiry was never seen ([step 10](#step-10-the-staging-script)). It hasn't run against staging.

## Owed before production

Not needed for staging, but owed before any production launch and before any real pilot uses managed repositories.

| Item | Where it was deferred |
| --- | --- |
| **A security review of the repository caps and the operator's take-back.** With no operator's approval first ([decision 194](spec/PRODUCT.md#decisions-needed)), the daily caps (5 accepted requests for an organization and for a person, both proposed) and an operator taking managed repositories away from an organization are what hold abuse of Podster's GitHub organization. Review both in M7's security review: the numbers, a cap across organizations and people acting together, and how an operator learns there's something to take back. | [Self-serve repositories](#self-serve-repositories-what-was-built), 2026-11-11 |
| **An operator's reset for a room's repository setup.** A room has one repository request. Once its setup job has run 5 times (`MAX_SETUP_RUNS`), or the repository it holds has a rule that's present and wrong, which setup never repairs, the request stays `failed` or `uncertain`: at the limit the owner's retry is refused, and a retry on a wrong rule fails the same way until the limit. Nothing cancels the request or resets its count. The operator's recheck from step 7b doesn't cover it: that only turns a linked repository that was `degraded` back to `ready` when it reads back exactly right, and never touches a request, its count or a repository that was never linked. Today the room's other work goes on, and it can't get a repository. **Ruled by the architect, 2026-11-11:** staging is switched on without it, because staging has test people only and a stuck room is abandoned for a new one | [Step 4](#step-4-what-was-built) |

## What needs the owner's yes

- **A GitHub organization for managed repositories.** **Answered by the owner on 2026-11-10:** "podsterx no longer exist.. the organization is now https://github.com/organizations/podsterdev/settings/apps you can create the app there". Earlier the same day the owner had said that `podsterx` was for tests and tests never ran against `podsterdev`. **The architect's reading, not the owner's words:** the new sentence replaces that one, and with no production deployment, `podsterdev` serves staging. Its ownership and legal terms are still open, and may need a lawyer. **Open, and the architect's, not the owner's:** before any production deployment, whether staging and production share `podsterdev` or get separate organizations or Apps.
- **Step 7b's configuration, all unset everywhere:** the merge App's key as the secret `GITHUB_MERGE_APP_KEY`, with `GITHUB_MERGE_APP_ID` and `GITHUB_MERGE_INSTALLATION_ID`. With them and the switch, Podster can change a managed repository's default branch.
- **Step 6's configuration, all unset everywhere:** `REPO_TOKEN_KEY` on the API Worker, 64 hex characters; the optional `REPO_TOKEN_KEY_PREVIOUS`, set only while rotating; the agent-token App's key as the secret `GITHUB_AGENT_APP_KEY`, with `GITHUB_AGENT_APP_ID` and `GITHUB_AGENT_INSTALLATION_ID`; and `MANAGED_REPOSITORIES` set to `true` on both Workers. See [staging.md](staging.md#the-repository-token-keys).
- **The GitHub Apps:** three, as ADR 0009 proposes: one that provisions, one that issues agent tokens, and one that merges. **Done on 2026-11-10:** the owner said "you can create the app there", and the architect created and installed three in `podsterdev`, in the owner's browser. Any change to their permissions is the owner's yes. The spike's two Apps on `podsterx` aren't used again; that organization's state was unconfirmed after the owner said it no longer exists.
- **Public managed repositories on staging.** **Confirmed by the owner on 2026-11-11:** "okay with public repo, MIT project", which the architect reads as confirming both that managed repositories may be public and that Podster's own code is MIT-licensed. Still owed: the words don't switch `MANAGED_REPOSITORIES` on or set the Apps' keys, and takedown.md's staging exception covers `PUBLIC_ROOMS`, not repositories, so the takedown process for public repositories still needs the owner.
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
| A signed body about a change the room doesn't know is sent again and again. The room keeps no memory of such a delivery, so each replay is taken as new | Accepted. Each replay costs one D1 read and one call to the room, writes nothing, and is bounded only by the gateway's per-client rate limit. Remembering them would let a busy repository fill the room's table, which is the worse of the two. |
| A holder of the webhook secret learns which repository IDs are managed, because an unknown repository answers faster than a routed one | Accepted. The answer's body and status are the same, and only someone who can already sign deliveries can measure it. |
| An agent pushes a workflow that runs with the repository's own token and merges or sets the required status | The agent's token can't write workflows, which the spike saw once, and ADR 0009 proposes that the provisioning App switches Actions off on each repository it creates and reads that back. That is proposed and not currently true: Actions were on in a new repository in `podsterdev`, and switching them off wasn't tried. A workflow already in a repository wasn't tested. |
| A public repository publishes agent content under Podster's organization | ADR 0009 proposes public as the working assumption, said plainly and confirmed at setup, because the Free plan has no branch rules for private repositories. It also proposes that pull requests from forks are never task changes, and an operator takedown. Public repositories exist on staging only, until takedown.md covers repositories and its contact is real. The owner confirmed the public scope on 2026-11-11: "okay with public repo, MIT project". |
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
