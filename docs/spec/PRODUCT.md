# Podster — Product Spec

Status: **draft for review** · Owner: Patrick Thach · Last updated: 2026-11-08 · [Architecture](ARCHITECTURE.md) · [Design](DESIGN.md) · [Access control](ACCESS-CONTROL.md)

The project name is **Podster** and the planned domain is `podster.dev`; brand clearance is still pending. The coordination kernel's agent-facing half is built and running on a staging deployment, with wake built and deploying next, and there's no production deployment yet. The November 4 workroom direction below supersedes the earlier link-only, invitation-only product scope. Detailed API names remain the existing kernel contract until the extension contracts are designed. [Concept mockups](../mockups/README.md) illustrate the direction; they are not implemented screens.

**Reading this spec:** text marked **Proposed** is a recommendation awaiting the owner's decision, not an approved requirement. Unmarked text is the current product direction. All decisions awaiting an answer are gathered in [Decisions needed](#decisions-needed).

## One line

**Podster gives people and independently run agents a shared workroom to turn a goal into reviewed results: define roles, claim work, coordinate through durable inboxes, and optionally release an application.**

## Problem

Agents can already do real work: each has its own model, tools, MCP servers and credentials. What they cannot do is
work *with each other* in a way anyone can trust.

- **No shared place.** When a PM agent needs an architect agent, the handoff today is a person copy-pasting between two
  chat windows, or a bespoke integration between two systems that only works for those two.
- **No commitment.** A message saying "please do X" is not a promise that X will be done. Nobody can tell whether the
  other agent saw it, took it, or quietly dropped it.
- **No sign-off.** An agent saying "done" is a claim, not a result. Someone has to check the deliverable, and that check
  needs to be recorded.
- **Sessions end.** Most agents exist only while a person talks to them. Work handed to them has to wait somewhere
  durable until their next session, and they need to find it without a public URL of their own.
- **Organizations don't trust each other.** Bringing in an outside specialist agent must not hand it your repo, your
  other tasks, or your agent's credentials.

Orchestration frameworks solve this *inside* one runtime, where one party owns every agent. They don't help when the
agents are run by different people, on different platforms, at different times.

## Thesis

Agents should collaborate like a team of contractors: each keeps its own tools and runs on its own platform, and they
meet in a neutral place that records who committed to what. **Agents own execution; Podster owns coordination.**

## Who it's for

| Priority | User | How they reach us |
| --- | --- | --- |
| Primary | **AI agents** doing work for a person or organization | Hosted MCP server (`/mcp`) with one-click OAuth, or Agent Auth capabilities over HTTP |
| Primary | **People who own those agents**: set up workspaces, connect agents, approve outside access, review sensitive work | Web dashboard |
| Secondary | Developers building agent services that want to take work from others | Agent Auth capabilities; docs site |

People control ownership and access policy. For private workrooms, cross-organization admission requires the defined invitation flow. Public agents can claim available roles under the owner/admin-configured policy without creating or elevating permissions.

## Product direction and delivery scope

The product is a goal-based workroom, not only a two-agent handoff. Workrooms can support engineering, research, business tools, marketing or film projects. Roles and artifacts must remain generic enough for these different kinds of work.

The existing two-agent task lifecycle, authorization checks and durable inbox are the **coordination kernel**. They remain the first technical validation milestone. The expanded workroom experience is the target product scope, not a claim that every feature ships in that kernel milestone.

**November 5 planning direction:** Patrick approved complementary Board and Gantt views within Tasks, synchronized with List, with clickable task details, scoped progress and qualified duration forecasts. Same-workroom dependency planning is now in scope; see the [implementation handoff](TASK-PLANNING.md) and approved originals. This is future product work, not an M0 completion claim or a change to existing lifecycle/contracts. Delivery sequencing and engineering details remain proposed.

**November 5 contributor concepts:** future internal/volunteer/paid arrangements share the task lifecycle, with optional pricing, configured provider/model/version visibility on agent lists/profiles, resource limits for all types and separate financial caps for paid tasks. See [Contributors and limits](CONTRIBUTORS-AND-LIMITS.md) for the revised mockups, truthful model provenance and unresolved authorization, metering, enforcement and commercial gates. These are unimplemented future concepts; preview remains free and no delivery milestone or payment integration is committed.

**Proposed delivery milestones.** Each builds on the one before and has its own gate. Scheduling is not committed.

| Milestone | Delivers | Gate |
| --- | --- | --- |
| **M0 Kernel** | Two-agent task lifecycle, inbox and wake; workroom owner and admins; revocation fence; basic dashboard | [Kernel success criteria](#coordination-kernel-success-criteria) plus AC-01 to AC-07, AC-09, AC-12 to AC-17, AC-19 to AC-22, AC-25, AC-26, AC-29 and AC-30, for the features M0 includes. **Passed on a deployment, with two real people, on 2026-11-09, at `1d28ee2`**, apart from the parts that close on local proof or stay local only ([what ran](../m0-gate.md#journey-on-staging-with-two-people)). Before that it was accepted by the owner on 2026-11-05 |
| **M1 Private workrooms** | Goal and context, work roles and invited claims, lead, scoped access, activity, collaboration list and map | Expanded criteria 1 (without input assets and expected outputs, which M2 adds), 3, 4 and 5 for private rooms. **Met by the owner's ruling on 2026-11-06, at `5ae3dad`** ([decision 80](#decisions-needed), [what it rests on](../m0-gate.md#what-the-call-on-m1-rests-on)) |
| **M2 Assets and artifacts** ([plan](../m2-plan.md)) | Upload, scanning, expected and versioned outputs, exact-version review | The input assets and expected outputs in expanded criterion 1; expanded criterion 6; upload policy. **Met on staging with test people, by the lead's call on 2026-11-08, at `137cfd6`, for the owner to review** ([decision 145](#decisions-needed), [the run it rests on](../m2-plan.md#checks-the-spike-left-open)) |
| **M3 A2A** ([proposed plan](../m3-plan.md)) | Published profile, adapter, interoperability and authorization tests | Protocol gates below |
| **M4 Public workrooms** ([proposed plan](../m4-plan.md)) | Explore, public read surface, public claims, abuse controls | Expanded criterion 2; abuse review |
| **M5 Managed repositories** ([proposed plan](../m5-plan.md)) | GitHub App, repository link, review and merge | Expanded criterion 7 for repositories |
| **M6 Release** ([proposed plan](../m6-plan.md)) | Workroom-level deployment, separate content domain, custom domains | Expanded criteria 7 and 8 |
| **M7 Runner** (nothing published until this gate passes) | Outbound Runner, CLI adapters, local run policy and budgets | [R-01 to R-43](RUNNER.md#proposed-acceptance-criteria-not-executed), including the proposed one-agent pairing proof of concept, automatic-run flow, server-created repository/local clone workflow and GitHub access design; provider and sandbox proof of concept; security review of the threat model |

A2A precedes public rooms so that public claiming launches with both protocols. No public launch happens before M1 through M4 pass. M5 and M6 can ship later for engineering rooms. M7's outbound default needs M0. With M0 alone, results reach Podster as notes and links to where the owner hosts them, because uploads arrive in M2, and the source repository is one the owner configures. That limited proof of concept does not provision repositories; the target server-created workroom repository flow additionally requires M5. Tests marked inbound need M3, and public-room cases need M4.

## Core jobs

1. **Create a workroom:** describe a goal and context; attach input assets such as specs, documents and UI mockups.
2. **Define roles:** name each role, its responsibilities and number of openings. A role is an opening to fill, not an agent that Podster has launched.
3. **Participate:** private workrooms are invitation-only; in a public workroom, any connected agent can claim an available role opening without a separate owner-approval step.
4. **Coordinate:** a lead agent turns the goal and assets into tasks, offers work to suitable participants, and follows up on blockers and reviews. Execution remains on each agent's own platform.
5. **Commit and deliver:** agents explicitly accept or decline tasks, discuss them in task threads, and submit versioned results.
6. **Review:** a designated reviewer accepts the result or requests changes. Task review, repository merge and deployment are distinct outcomes.
7. **Catch up:** agents read their own durable attention queue across workrooms; people can inspect the shared activity history for a room.
8. **Release when enabled:** an engineering workroom can use a Podster-managed repository and an optional Cloudflare deployment workflow, configured once at workroom level.

## Coordination kernel example

```
Person (Org A) ──dashboard──▶ create workspace "Billing v2", connect PM agent
Person (Org A) ──dashboard──▶ invite Org B as guest
Person (Org B) ──dashboard──▶ accept invite, bring in its Architect agent
PM agent      ──create_task { title, instructions, criteria, assignee: architect }──▶ Podster
                                                     task: offered → Architect's inbox
          … Architect's next session …
Architect     ──read_inbox──▶ [task.offered]
Architect     ──accept_task──▶ accepted                 → PM's inbox
Architect     ──send_message / submit_task { artifacts: [PR link, design doc] }──▶ submitted → PM's inbox
          … PM's next session …
PM agent      ──read_inbox──▶ [task.accepted, task.message, task.submitted]
PM agent      ──verify_task──▶ completed                 → Architect's inbox
Both          ──get_task──▶ same state, same history
```

## Concepts

| Term | Meaning |
| --- | --- |
| **Person** | A human with a sign-in (GitHub, Google or email link). Belongs to one or more organizations. |
| **Organization** | The accountable owner of agents and workspaces. Created by a person, who is its first admin. A person without a team gets a personal organization, shown as a personal account; individuals are not a second ownership model. |
| **Agent** | A connected agent identity, owned by exactly one organization. Has a name, a description of what it does, a participation policy, and optionally a wake URL. Podster never runs it. |
| **Workroom** | A goal-based collaboration boundary: brief, input assets, role openings, participants, tasks, activity and results. Owned by one organization. The existing API and architecture call this `workspace`; that is an internal term for the same boundary. |
| **Workflow** | The room's kind of work: General or Engineering. It only controls which settings and panels appear. Engineering enables repository and deployment options. It grants nothing. |
| **Work role** | A named responsibility with a configured number of openings, such as lead coordinator, researcher, engineer, reviewer or DevOps. Separate from owner authority and authorization roles (`admin`, `member`, `guest`). |
| **Role claim** | A connected agent filling an available work-role opening. It is not acceptance of every task assigned to that role. |
| **Access scope** | What a participant can do in one workroom: tasks, artifacts, conversations and review. Presets bundle them. See [Access presets](#access-presets). |
| **Member** | An agent or person participating in a workspace. Human owner/admin authority is distinct from ordinary `member` or `guest` access. |
| **Invitation** | An offer for another organization (or one of your own agents) to join a workspace with a given authorization role and, **Proposed**, a specific work-role opening. Expires in 7 days. |
| **Task** | A unit of work with a requester, at most one assignee, a reviewer, instructions and acceptance criteria. |
| **Submission** | One numbered attempt at a task, containing a note and artifact versions. A review acts on a specific submission. |
| **Handoff** | A recorded offer, submission or change request between two participants. Collaboration views count these from task events. |
| **Thread** | The ordered messages on one task. There are no workspace-wide channels in the MVP. An agent-to-agent conversation attaches to a task, over any protocol. |
| **Asset** | An input uploaded or linked to a workroom for context, such as a spec, document or mockup. |
| **Expected output** | A result the room intends to produce. It is **ready** when an approved artifact version is linked to it. |
| **Artifact** | A versioned output: document, source code, image, video, presentation, website or application. It can include underlying downloadable files and a preview or deployed URL. The kernel stores links; the expanded product requires an upload/storage design. |
| **Event** | One recorded change (task offered, message posted, member revoked, …). Each workspace numbers its events in order. |
| **Inbox** | Per-agent queue of events that need that agent's attention, with a server-side cursor. |

## Workroom setup and discovery

The Create Workroom flow captures:

- Name, goal and supporting context.
- **Asset upload**, using that label because inputs include more than specifications.
- Work roles, responsibility descriptions and opening counts.
- Expected outputs, from M2 ([decision 47](#decisions-needed)), and review settings.
- Public or private participation.
- For engineering work: Podster-managed GitHub repository setup, repository visibility, and optional deployment settings.

GitHub and deployment controls should appear only when relevant to the workflow. Creating a workroom or defining a role does not start, run or wake an agent.

The Workrooms directory has **My workrooms** and **Explore**. Cards show the goal and filled/open roles, plus artifact progress from M2 ([decision 49](#decisions-needed)). **Proposed:** they also show visibility once public rooms arrive in M4, which the owner hasn't ruled on. Explore lists public workrooms and supports topic/available-role filtering. Private rooms must not leak through search or discovery to people or agents without access.

### Role openings and coordination

A role has a title, responsibilities and capacity. Claiming the last opening must be atomic: simultaneous claims cannot exceed capacity. Repeated requests from the same agent must not consume multiple openings. A claimed role and an accepted task are separate commitments.

The lead coordinator is accountable for interpreting the goal, preparing a plan, creating tasks, directing them to suitable roles, handling blockers and requesting review. Start with one accountable lead per workroom. A lead designation does not grant administrator, review, repository or deployment permission.

The owner or an admin marks exactly one opening as lead and may replace its holder ([decision 3](#decisions-needed)). Replacing a lead moves open coordination, such as requester duties on non-terminal tasks, only through a recorded `set_requester`, never automatically. A lead gets the Coordinator preset, and being lead adds no admin, review or deploy rights. Other project managers fill ordinary roles. Public claiming of a lead opening waits for M4. **Proposed, for M4:** a lead opening is not publicly claimable unless the owner or an admin explicitly enables it.

Openings, invited claims and the lead are built for agents, and part passed on staging with test people ([m0-gate.md](../m0-gate.md#m1-criteria-on-staging)). In a private room an agent claims only an opening an owner or admin named it for, or one named by the invitation link it first joined through, and it always claims for itself. A claim copies the opening's preset, even when that's narrower than what it had. Asking again takes no second opening. An agent holds one opening at a time for now. A release, or an owner or admin ending the claim, restores what it had, unless an owner or admin set its access meanwhile, even to the same values, and then it keeps the narrower. Changing an agent's access, ending its claim, or changing the opening's preset or lead mark withdraws pending invites, an invite from someone who's lost authority can't be claimed, and an agent coming back through a link gets none from it. Decision 42's "only needs that owner's consent" covers the owner's side: to claim again, the agent also needs a room re-add or a link, and a new invite. Marking an opening as lead forces one opening and the Coordinator preset, while it's vacant. A holder is replaced by ending the claim and naming the next agent, who then claims. These rules beyond the decisions are the safest reading, for the owner to confirm.

Human feedback can revise a task. Version checks must prevent stale submissions or approvals from silently applying to changed requirements.

Changing instructions or acceptance criteria after acceptance returns the task to `offered`, so the assignee re-accepts the changed commitment. Changes to other fields do not. Requiring a person as reviewer is a per-room setting that an owner or admin controls. It is off by default in private rooms, and on for public rooms when M4 arrives ([decision 5](#decisions-needed)). Built, and its rules part passed on staging with test people ([m0-gate.md](../m0-gate.md#m1-criteria-on-staging)). Where it's on, an agent can't be named reviewer or approve or send back work. Turning it on moves open tasks off agent reviewers by the reviewer half of the [departure rules](#when-a-participant-leaves), and turning it off moves nothing. That handling of tasks already open is the safest reading, for the owner to confirm.

### Collaboration view

The Collaboration tab shows who works with whom and what actually happened. **Planned relationships** are intended flows between work roles, set by the owner or admins ([decision 45](#decisions-needed)). The lead may set them later, with an agent tool. **Recorded activity** is derived from task events and thread messages, and labeled by event kind or task title, never by hand. Lines are descriptive only: neither kind grants access or proves delivery. Visibility follows the viewer's permissions, including counts. Podster does not report agents as online; it can show when a participant's latest recorded event happened ([decision 43](#decisions-needed)).

### Public and private participation

- **Private:** invitation-only. Keep the existing human-approved cross-organization invitation flow.
- **Public:** any connected agent can claim an available role opening. Do not require an invitation or manual owner approval for each public claim.
- Public claiming still requires a valid, accountable agent identity and available capacity. Claims do not confer administration, sign-off, repository write or deployment rights.
- Workroom visibility, repository visibility and published-result visibility are separate controls. Making a room public must not silently publish private repository contents or input assets.
- The old guest/member matrix below is a kernel baseline, not permission to grant every public participant full member access.

**Proposed public rules, to confirm before M4:**

- **Public read surface:** goal, context, role openings and capacity, expected outputs and their status, participant count and assets explicitly marked public. Tasks, threads, activity, inboxes, and the collaboration graph stay private to participants.
- **Agent-owner consent:** each agent has a participation policy, default **invitations only**. Its owner must allow public claims before it can claim. This is the "authorized by its owner" check in ACCESS-CONTROL.md, and it is different from workroom-owner approval, which public claims do not need.
- **Claim scope:** a public claim gets the opening's preset, by default **Public participant**. Claims cannot request scopes.
- **Visibility changes:** private to public shows a preview of what becomes visible and needs owner or admin confirmation. Public to private removes the room from discovery; current public participants keep access until revoked.
- **Abuse controls:** per-agent and per-organization claim rate limits, a limit on simultaneous public claims per agent, owner and admin removal, report-to-Podster and a reason-coded audit trail. Limits are set in M4.

## Membership and trust

### Owner and administrator authority

The creator is the human workroom owner by default. Only the owner and human admins they appoint can manage agent access. Ordinary members and agents cannot change permissions or elevate themselves or others. An agent's owner means an authorized person of the organization that owns it. An agent's own owner controls connecting and withdrawing that agent; workroom administration cannot override that control.

GitHub and deployment access require separate delegation from the relevant external-resource owner. A workroom admin cannot grant authority they do not hold. Public role claims fill existing openings under the configured policy, not permission changes. Lead, reviewer and DevOps are work responsibilities, not admin grants.

See [ACCESS-CONTROL.md](ACCESS-CONTROL.md) for the approved model, proposed server-side enforcement, permission matrix, denial tests and audit requirements. These are unimplemented requirements. The old kernel matrix below must be interpreted under these restrictions.

### Connecting an agent

An agent must belong to an organization before it can do anything in a workspace. Two ways in:

- **Hosted MCP** (`https://<gateway>/mcp`): on first connect the OAuth consent page asks a person to sign in, pick the
  organization, and name the agent. The grant *is* the agent: one approved connection is one agent.
- **Agent Auth**: an agent service registers itself and gets a pending identity with no organization, plus a claim link in the registration response. Until claimed it can't call any capability, and it can only check its status. The agent passes the link to its person, who signs in and assigns the agent to an organization. An agent cannot vouch for itself. The agent keeps working after the claim.

An authorized human representative of the agent-owning organization can disconnect its agent globally. This must revoke its participation across workrooms; the proposed enforcement and in-flight revocation tests in ACCESS-CONTROL.md must pass before claiming that guarantee.

### Authorization roles (kernel baseline)

| Role | Sees | Can |
| --- | --- | --- |
| `owner` | Everything in the workspace | Creator by default; appoint/remove human admins and manage scoped workroom access. External authority remains separately delegated. |
| `admin` | Everything in the workspace | Owner-appointed human; manage local agent scopes, invite/revoke, cancel tasks, rename/archive. Cannot appoint admins, elevate authority, override agent-owner disconnect or grant unavailable external authority. |
| `member` | Every task and thread | Create tasks, offer them to any member or guest, accept tasks offered to it, review when named reviewer, post on any thread |
| `guest` | Only tasks where it is requester, assignee or reviewer, and their threads | Act on those tasks; create tasks only if the admin allowed it on the invitation |

- Only the workroom owner can appoint human administrators. Agents cannot be owner/admin. Ownership moves only by an explicit transfer to a human admin, or by a recorded recovery process run by the owning organization's admin when an owner has left. It is never automatic ([decision 8](#decisions-needed)), and no implicit agent or organization-wide elevation is permitted.
- Members from another organization default to `guest`. Granting `member` to an outside organization is an explicit choice on the invitation.
- A person sees a room through their own explicit role in it, not through what their organization's agents can see, and may act as reviewer. An organization's admins keep read-only oversight of its own agents' tasks and inboxes, which gives them no room role ([decision 7](#decisions-needed)). In M0, admins of the room's own organization who aren't in the room stay refused for task oversight, and the owner's answer on whether that should change is pending. Inbox oversight and the list of an agent's rooms don't have that limit.
- People act through the same commands as agents. A person named as reviewer approves or requests changes in the dashboard. Who else can create tasks from the dashboard is decided by the same permissions: owner, admin and member people can.

#### Access presets

[Decision 20](#decisions-needed) settles these. Presets make the `Manage access` scopes testable, and map the kernel roles onto them. The owner or an admin applies a preset to an agent or to a role opening, then may adjust individual scopes. Membership and access management is never a scope and cannot be granted to an agent.

| Preset | Tasks | Artifacts | Conversations | Review |
| --- | --- | --- | --- | --- |
| **Public participant** | Own tasks | Read shared, submit on own tasks | Own task threads | None |
| **Guest** (kernel `guest`) | Own tasks | Own tasks | Own task threads | When named reviewer |
| **Member** (kernel `member`) | All; create and offer | All | All | When named reviewer |
| **Coordinator** (for the lead) | All; create and offer; take over tasks whose requester has left | All | All | When named reviewer |

"Own tasks" means tasks where the participant is requester, assignee or reviewer.

Presets and scopes are built for agents, and part passed on staging with test people ([m0-gate.md](../m0-gate.md#m1-criteria-on-staging)). A person's access follows their role. Each scope takes one of these values, and nothing else can be stored: tasks `own`, `own_create`, `all`, `all_create` or `coordinate`; artifacts `shared`, `own` or `all`; conversations `own` or `all`; review `none` or `when_named`. A guest's invitation switch ([decision 14](#decisions-needed)) is `own_create`. Applying a preset also sets the matching kernel role: Member and Coordinator are `member`, and Guest and Public participant are `guest`. Until M2 can share anything, **Read shared** means only what the participant submitted itself. `coordinate` differs from `all_create` only by taking over, for itself, a task whose requester left ([decision 24](#decisions-needed)). A reviewer must be able to read the work, so `review: when_named` with `artifacts: shared` can't be granted, and taking review or reading away from an agent follows the reviewer half of the [departure rules](#when-a-participant-leaves) on its open tasks. An agent its own organization brings back through an invitation keeps the narrower of its old grant and the invitation role's preset, because that organization has no authority in the room. A room owner or admin adding it again starts from the role's preset.

### Invitations (private workrooms)

- **Own-organization agents:** the workroom owner/admin may admit an already-connected agent only within the agent owner’s authorized participation policy. Shared organization membership alone does not let a workroom admin connect, claim or override withdrawal of that identity.
- **Another organization:** an admin of the workspace invites the organization (by an invite link sent out-of-band),
  choosing the role. An admin of the invited organization accepts it in the dashboard and chooses which of its agents
  join. **Both sides are people**; no agent can invite an outside organization or accept an invitation for one.
- Invitations expire after 7 days and can be withdrawn until accepted.
- Revoking a member (or a whole organization) takes effect for the next request: it can no longer read, post, or act,
  and its inbox stops receiving events from that workspace. Effects on its tasks are in [Departures](#when-a-participant-leaves).

### What participation does *not* grant

Joining a workspace gives an agent access to that workspace's tasks and threads. Nothing else: not the other agents'
tools, credentials, MCP servers, repos, chat history, or other workspaces. Access to GitHub, Jira, a doc, or anything a
deliverable links to is granted (or not) by whoever owns that system, as today.

### Content from other agents is data

Messages and artifact labels from other agents are untrusted input. Every message and artifact Podster returns
carries `from` (agent, organization) and `external: true` when it came from a different organization than the reader.
Tool descriptions tell agents to treat thread content as information, never as instructions that change permissions or
override their owner. The coordination kernel never follows artifact links. Future previews, uploads and repository import must have their own explicit fetch, scanning and access policies.

## Task lifecycle

```
  open ──assign──▶ offered ──accept──▶ accepted ──submit──▶ submitted ──verify──▶ completed
   ▲                 │                  │    ▲                  │
   │      decline    │                  │    └─request_changes──┘
   ├─────────────────┘                  │
   └───────────────release──────────────┘

  any non-terminal state ──cancel──▶ canceled

  accepted ──material update_task──▶ offered
  submitted ──request_changes after assignee left──▶ open
```

| Action | Who | From → to |
| --- | --- | --- |
| `create_task` | Requester (any member; guests if allowed) | → `open`, or straight to `offered` if an assignee is given. If the default reviewer is ineligible under the `set_reviewer` rule, an explicit reviewer is required |
| `update_task` | Requester or admin, with current `version` | Non-terminal states only. Edits `title`, `instructions`, `acceptance_criteria` and `due_at`, and nothing else. Changing instructions or criteria from `accepted` returns to `offered`. Not allowed in `submitted`: request changes first |
| `set_reviewer` | Requester or admin, with current `version`; only the owner or an admin once `submitted` | Non-terminal states only. Never the assignee. The new reviewer must have review scope, where scopes exist, and meet the room's person-review policy |
| `set_requester` | Owner or admin; or a Coordinator, only for itself and only when the requester has left | Non-terminal states, including `submitted` |
| `assign_task` | Requester or admin | `open` → `offered`; or re-offer from `offered` to someone else. Never the current reviewer |
| `accept_task` | The offered agent | `offered` → `accepted` |
| `decline_task` | The offered agent, with a reason | `offered` → `open` |
| `release_task` | The assignee, with a reason | `accepted` → `open` |
| `submit_task` | The assignee, with ≥ 1 artifact or a note | `accepted` → `submitted`; creates the next submission number |
| `request_changes` | The reviewer, naming the submission, with a reason | `submitted` → `accepted`, or → `open` if the assignee has left |
| `verify_task` | The reviewer, naming the submission | `submitted` → `completed` |
| `cancel_task` | Requester or admin, with a reason | any non-terminal → `canceled` |

Rules:

- **Assignment is not commitment.** An agent owns a task only after it accepts.
- **Submission is not completion.** Only the reviewer can complete a task, and only from `submitted`.
- **No self-sign-off.** The reviewer defaults to the requester and can be set to any other eligible member or person, but never to
  the assignee. Offering a task to its reviewer fails. To do so, first set a different reviewer.
- **Tasks are offered, never claimed.** Only role openings are claimed. Nobody assigns a task to itself without being
  its requester; a role claim never creates a task commitment.
- Progress is reported as thread messages, not states. There is no `in_progress`: `accepted` means "I'm on it".
- Every transition records actor, time, prior and new state, task version and reason or artifacts, as an event.
- Mutations carry an `idempotency_key`; a retry returns the first result. Edits to a task carry its `version`; a stale
  version fails with `409 version_conflict` rather than overwriting.
- `due_at` is informational in the MVP. No automatic escalation or reassignment.

### When a participant leaves

These rules apply to revocation, agent-owner withdrawal, global disconnect and a person leaving the room's organization. History and submitted artifacts are always kept.

| Departing participant | Task state | Result |
| --- | --- | --- |
| Assignee | `offered` or `accepted` | Task returns to `open`. |
| Assignee | `submitted` | Task stays `submitted` and can still be reviewed. `request_changes` returns it to `open` because nobody can resume it. |
| Reviewer | `submitted` or earlier | Reviewer falls back to the requester, if the requester has not departed, is not the assignee, and meets the same eligibility as `set_reviewer`. Otherwise the task is flagged for an owner or admin to run `set_reviewer`. The task never completes by default. |
| Requester | Non-terminal | The task is flagged for an owner, an admin or the Coordinator to take over with `set_requester`. Work already accepted continues. |

Departure also ends the participant's role claims and frees those openings. An agent removed by the room cannot re-claim a role there until an owner or admin clears the removal. An agent its own owner withdrew needs only that owner's new consent, not the room's approval. **Proposed:** the same for an agent its own owner disconnected, which the owner's decision didn't name but is likely intended, because AC-28 and M0's re-add check already treat the two alike. **Proposed:** the default participation policy refuses only public claims; invitations and owner or admin additions still work. Only agents claim roles today, as the [glossary](#concepts) says. A person's claims in [decision 42](#decisions-needed) apply only if people are later allowed to claim roles, which that decision doesn't settle.

## Assets, outputs and releases

### Assets and versioned artifacts

Workroom input assets and submitted outputs serve different purposes. Inputs explain the goal; outputs are the work being reviewed. Preserve versions and provenance so a reviewer can identify exactly which result was accepted. New versions must not silently replace a reviewed version.

Support documents, code, images, video, PowerPoint/presentations and deployed apps. A result may be presented as a website or working web application with underlying files available to download. Deployment is optional at the workroom level; do not create or publish a separate website automatically for every artifact.

The earlier link-only contract remains useful for the kernel, but is insufficient for the target **Asset upload** experience. The [upload policy](UPLOAD-POLICY.md) sets file types and limits, malware handling, retention, deletion, access and download behavior for M2, and [ADR 0006](../adr/0006-uploads-and-scanning.md) proposes the design. Export waits until before public rooms ([decision 59](#decisions-needed)). Mockup upload controls do not settle these choices.

### Podster-managed GitHub repositories

For a workroom that needs Git, Podster's server creates a repository in the configured, authorized Podster-managed GitHub organization during room setup and links it to that room. **Proposed** on November 8 as the intended flow, not decided: it goes beyond decisions 10 and 18, which are still recommendations. Its provisioning design isn't implemented. Rooms without Git create no repository. When a coding agent accepts an eligible task, Runner clones the linked repository locally and Claude Code works inside that isolated copy. The repository is created once for the room, not again for each task. Agents work through pull requests and review. Repository visibility is configured separately from room visibility, with private proposed unless an authorized setup choice explicitly selects public. Workroom-creation authority and organization-specific GitHub provisioning delegation are both required; missing setup is shown as blocked, not silently created by Runner. Export or transfer should be supported; exact ownership, transfer, deletion and account arrangements remain to be designed. Bringing an existing repository is a possible later extension.

The spec does not authorize creation of a GitHub organization, repository, credentials or installations. Runtime permissions and setup consent must be configured separately from a role claim. Creation-capable server credentials stay separate from Runner's repository-scoped clone/push access. See the proposed [server provisioning and local clone flow](RUNNER.md#workroom-repository-and-local-task-copy), including ready-state, retry and isolation gates.

### Review, merge and optional Cloudflare deployment

Deployment is a **workroom-level option**, with a default URL and optional custom-domain mapping in the design. A human owner or admin configures the release workflow once, and a DevOps role can propose its settings; task agents do not recreate infrastructure for every submission. Enabling it is a product setting, not proof that accounts, domain ownership, credentials or an authorized pipeline exist.

For engineering task details, show the linked PR, branch/commit, required checks, reviewer, merge status, deployment status and preview/live URL when available.

- **Approve** records review of a specific submission. It does not itself mean the PR merged or the app is live.
- **Merge** changes the repository target branch. It requires repository permission and current checks/review for the exact commit.
- **Approve and merge** may be offered to an authorized reviewer. If merging triggers deployment, disclose that consequence at the action.
- **Deploy** releases the merged version only when the workroom's configured release policy allows it. Record commit, environment and result separately from task completion.
- Report failures accurately, for example **Merged, deployment failed**. Do not show a live release solely because a task is completed or a PR was merged.

Release environments, approval policy, retry/rollback behavior, branch protection, credential handling, custom-domain validation and budget controls are unresolved implementation requirements. No integration, deployment or domain mapping is established by these mockups.

## Capabilities (existing kernel API surface)

Each one is an Agent Auth capability and a tool on the hosted MCP server; both run the same code path. The REST routes
underneath are an internal contract between services, not a public product in the MVP.

| Capability | Input | Output |
| --- | --- | --- |
| `get_identity` | — | agent, organization, `inbox_unread`, `wake` |
| `list_workspaces` | — | workspaces this agent is in, with role |
| `get_workspace` | `workspace_id` | workspace, members visible to this agent |
| `create_task` | `workspace_id`, `title`, `instructions`, `acceptance_criteria?`, `assignee?`, `reviewer?`, `due_at?`, `follow_up_of?`, `idempotency_key` | task |
| `update_task` | `workspace_id`, `task_id`, `title?`, `instructions?`, `acceptance_criteria?`, `due_at?`, `version`, `idempotency_key` | task |
| `set_reviewer` | `workspace_id`, `task_id`, `reviewer`, `version`, `idempotency_key` | task |
| `set_requester` | `workspace_id`, `task_id`, `requester`, `version`, `idempotency_key` | task |
| `list_tasks` | `workspace_id`, `status?`, `mine?`, `cursor?`, `order?` (`oldest`, the default, or `newest`) | page of tasks |
| `get_task` | `workspace_id`, `task_id` | task, submissions, artifacts, last 20 messages, history |
| `assign_task` | `workspace_id`, `task_id`, `assignee`, `version`, `idempotency_key` | task |
| `accept_task` / `decline_task` / `release_task` | `workspace_id`, `task_id`, `version`, `reason?`, `idempotency_key` | task |
| `send_message` | `workspace_id`, `task_id`, `body`, `idempotency_key` | message |
| `list_messages` | `workspace_id`, `task_id`, `after?` | page of messages |
| `submit_task` | `workspace_id`, `task_id`, `artifacts[]`, `note?`, `commit_sha?`, `version`, `idempotency_key` | task |
| `request_changes` / `verify_task` | `workspace_id`, `task_id`, `submission_no`, `commit_sha?`, `reason?`, `idempotency_key` | task |
| `cancel_task` | `workspace_id`, `task_id`, `reason`, `version`, `idempotency_key` | task |
| `read_inbox` | `after?`, `limit?`, `ack?` | `events`, `acked_seq`, `unread`, `dropped` |
| `ack_inbox` | `up_to` | `acked_seq`, `unread` |
| `set_wake` / `delete_wake` | `url`, `headers?`, `debounce?` | wake |

Private invitations, authorization-role changes and revocation remain person-controlled dashboard actions in the kernel. `follow_up_of` and `commit_sha` are proposed. `commit_sha` is required on `submit_task` and `verify_task` when a task has a linked repository.

### Proposed extension capabilities

These are added milestone by milestone and use the same code path and permission checks. Names are proposed.

| Milestone | Agent capabilities |
| --- | --- |
| Planning | `get_plan`, `set_task_plan` |
| M1 | `get_workroom_brief`, `list_role_openings`, `claim_role`, `release_role`, `list_activity` |
| M2 | `list_assets`, `get_asset_link`, `create_upload`, `list_artifacts`, `submit_task` referencing uploaded files |
| M4 | `discover_workrooms` |
| M5 | `get_repo_access`, `get_task_release_status`, `merge_task` |
| M6 | `deploy_release`, only for an agent with explicit delegation |

Person-only dashboard actions stay outside this list: creating workrooms, appointing admins, changing access and visibility, connecting services, confirming ownership and disconnecting agents.

## Inbox and wake

Each agent has one inbox across all its workspaces, and the cursor is kept on our side, because a session-based agent can't keep one itself.

- An event lands in an agent's inbox when it needs that agent: a task offered to it, a submission it must review,
  changes requested on its task, a message on a task it is party to, a task of its canceled or reassigned, or the agent
  being added to or removed from a workspace.
- Reading does not advance the cursor; `ack_inbox` (or `read_inbox { ack: true }`) does. A session that dies mid-way
  leaves its events for the next one.
- Delivery to the inbox is at least once; events carry stable IDs so agents can dedupe.
- **Wake:** an agent can register one HTTPS URL. When its inbox gets something, Podster sends a signed `POST` there,
  at most once per debounce window (default 15 min). A wake URL might trigger a CI job, or a scheduled routine. Wake is a nudge, never a guarantee: the inbox is the source of truth, and an agent with no wake URL
  simply finds its work at its next session.

### People's attention queue

People need the same durable signal as agents: a person named as reviewer otherwise has no way to learn of a submission. Each person has an inbox with the same event and cursor rules, shown as **Needs attention** in the dashboard. Email notifications are optional, delivered only for types offered in Settings, and are never the source of truth.

### Shared activity and the personal inbox

Shared workroom activity is a permission-filtered history of what happened in that room. The personal agent inbox is the actionable queue across that agent's workrooms. Do not create competing task state in a separate room-wide inbox.

A lead offers a task → the assignee receives an inbox item; the assignee accepts → the requester sees it; a submission → the reviewer receives a review request; requested changes → the assignee receives the next action. Role invitations can also require attention. Reading a shared activity feed must not acknowledge another agent's inbox.

Admins of an agent's owning organization may inspect its inbox ([decision 31](#decisions-needed)). Nobody else may, apart from the agent itself. Activity visibility and inbox delivery must use the same authoritative workroom permissions. An agent's identity can span workrooms, while task context, files and repository access remain scoped to the specific room. Separate execution environments are recommended for agents working on separate projects; Podster does not host or guarantee that runtime isolation.

## Agent communication: MCP and A2A

Keep hosted MCP and Agent Auth for connecting existing agents. The connection UI uses **MCP client** and **Connect your own agent**, with **Agent Auth** as the subtitle. Connecting establishes identity, not execution or automatic workroom access.

A2A interoperability is a **core product requirement** alongside MCP, not a deferred optional adapter. Its adapter must map to the same authoritative tasks, events, permissions and inboxes. The lead agent coordinates; the protocol carries requests and responses; Podster records the shared state. A2A does not determine the plan or keep an agent running.

Core A2A must support authorized agent-to-agent communication through the same policy and durable state. It does not promise that offline agents are continuously reachable. Protocol version, discovery, authentication, task-state mapping, message delivery and interoperability tests remain design work and launch gates. Keep MCP-only agents able to participate. Do not claim A2A conformance or treat a protocol message as authority to bypass permissions.

## Interface

[DESIGN.md](DESIGN.md) specifies navigation, vocabulary, states, screens, patterns and accessibility, and reconciles the mockups with this spec. Headline choices: **shadcn/ui** with **Sidebar** navigation, the profile anchored at the bottom left, and a consistent **right-side Sheet** for task, agent, connection and access details.

The dashboard is where people create goals and roles, provide assets, configure access, review work and manage their own agents. These are real connected identities, not unfilled work-role openings. Settings covers profile, organization and notification preferences; workroom visibility, roles, repository and deployment settings belong inside each workroom. Text, identities, counts and URLs in images are illustrative, not live data or finalized field contracts.

The Rust API is private, service-only and never called directly from browser code. Three public surfaces are planned under `podster.dev`: landing page, application UI and agent gateway. No public Rust API hostname is planned. Deployed apps and uploaded previews must use a separate domain; see [ARCHITECTURE.md](ARCHITECTURE.md#content-and-deployment-origins).

## Coordination kernel limits (baseline)

| Limit | Value |
| --- | --- |
| Workspaces per organization | 20, counting archived ones. Rooms can't be deleted yet |
| Members per workspace | 50 |
| Open tasks per workspace | 1,000 (terminal tasks kept until the workspace is deleted) |
| Message body | 16 KB of Markdown |
| Artifacts per submission | 10, HTTPS links only |
| Fields | Title 500 bytes; instructions 64 KB; acceptance criteria 16 KB; note 16 KB; reason 4 KB |
| Workroom brief | Goal 2 KB; context 32 KB; both optional |
| Role openings | 50 per workspace; title 200 bytes; responsibilities 4 KB; 1 to 50 openings each |
| Inbox | 10,000 events per agent; unread kept 30 days, acked 7 days; `read_inbox` returns at most 50 |
| Wake | One URL per agent; at most once per 1 min–24 h (default 15 min); off after 3 failures in a row |
| Invitations | Expire after 7 days |
| Uploads, from M2 (not built) | 100 MB per file; 5 GB per workspace ([decision 50](#decisions-needed)) |

## Proposed: Podster Runner

[RUNNER.md](RUNNER.md) proposes an optional owner-operated local executor and CLI adapters, including a local run policy, threat model and recovery. Its direction is set by [decisions 26 to 29](#decisions-needed), while its detailed design remains proposed and nothing is implemented. It doesn't replace independent agents, the existing task state machine or [access-control requirements](ACCESS-CONTROL.md).

The proposed primary flow is Runner launching local Claude Code to perform eligible work and, when separately authorized, open a PR. Runner reports permitted results, the verified PR link and test outcomes to Podster for an independent reviewer. Repository-scoped, short-lived GitHub App credentials and their secure delivery remain an [open design](RUNNER.md#proposed-github-access-and-reviewer-handoff), separate from the one-time pairing code. Nothing here authorizes installation, credential creation, merge or deployment.

It tests the thesis: agents still own execution and Podster never hosts them, but Podster would be publishing software that prompts tools on people's machines. That is why it is gated, optional and separate from the coordination service.

## Scope boundaries

### Target product, not in the coordination kernel

These ship in the [milestones](#product-direction-and-delivery-scope) above.

| Feature | Requirement before it ships |
| --- | --- |
| Uploads | Storage, scanning, retention and access design; the [upload policy](UPLOAD-POLICY.md) passes on a deployment. |
| Public participation | Rules and abuse controls confirmed. |
| A2A | Publish a supported protocol contract, and pass interoperability and authorization tests before claiming support. |
| Managed GitHub repositories | Contracts, GitHub App and credential model. |
| Workroom-level deployment | Hosting model, separate content domain, budget and approval policy. |

### Out of scope

| Out of scope | Why |
| --- | --- |
| Hosting, running or prompting participant agents | Agents own execution. We are the meeting place. Podster-operated starter bots and owner-operated [Runner](RUNNER.md) software are separate questions in [Decisions needed](#decisions-needed). |
| Workspace channels, DMs, real-time chat | Task threads cover the handoff. Channels add noise before they add value. |
| Public REST API, SDKs | Capabilities cover agents; REST stays internal. |
| Team templates | Role definitions and openings are core; prebuilt bundles remain an optional shortcut. |
| Automated matchmaking, reputation and general marketplace systems | The revised [contributor selection and optional paid arrangements](CONTRIBUTORS-AND-LIMITS.md) are future concepts only. They do not establish a shipped marketplace, trust score or payment system; broader matchmaking/reputation remains excluded. |
| Automatic workflow orchestration, SLAs and escalation | Board/Gantt and same-workroom dependency planning are now in scope under [Task planning](TASK-PLANNING.md). Planning does not launch agents, change ownership or add lifecycle gates; automatic orchestration, SLAs and escalation remain excluded. |
| Bringing an existing repository; Jira sync | Later extensions after managed repositories. |
| Current preview billing/payment processing | Preview remains free. Future optional paid contributor arrangements are documented in [Contributors and limits](CONTRIBUTORS-AND-LIMITS.md), gated on financial authority, trustworthy metering/control, commercial terms and security design; no payment functionality exists by virtue of these concepts. |

## Coordination kernel success criteria

The kernel milestone is validated when this works on a real deployment, end to end. This does not establish completion of the expanded workroom product:

1. Org A creates a workspace and adds its agent A; Org B accepts an invitation and brings agent B, each connected
   through a different method (one hosted MCP, one Agent Auth).
2. A creates a task and offers it to B; B sees it in its inbox in its next session, without a public URL.
3. B accepts; A sees the acceptance. B posts a message and submits an artifact link.
4. A requests changes once; B resubmits; A verifies; the task is `completed`.
5. Both read the same final state and history after reconnecting.
6. An agent outside the workspace, and B as a guest, cannot see tasks they are not party to.
7. Org A revokes Org B: B's next read and next action both fail, and B gets no more inbox events from the workspace beyond one ID-only removal notice.
8. Retrying any mutation with the same idempotency key creates nothing new.

And these hold:

- An agent goes from connected to its first accepted task in under 5 tool calls.
- No mutation is ever recorded without its event, or an event without its mutation (tested under concurrency).
- A message never reaches an agent that was not allowed to see it at the moment it was posted.

## Expanded workroom acceptance criteria

Before the expanded experience is called complete:

1. A person creates a workroom with goal, context, input assets, outputs and roles with opening counts, without launching agents implicitly. M1 covers goal, context and roles; input assets and expected outputs arrive in M2 ([decision 47](#decisions-needed)).
2. A public room accepts a valid agent's claim without a manual invitation; concurrent claims cannot overfill a role. A private room rejects uninvited participants and remains absent from unauthorized discovery.
3. Claiming a role grants only its defined scope, not administrator, reviewer, merge or deploy rights. A task still requires explicit acceptance.
4. A lead coordinates work and review through the same task history regardless of supported connection protocol; duplicate deliveries do not create competing tasks.
5. Shared room activity and agent inbox show consistent events with correct visibility. One room cannot expose another room's context or credentials.
6. Review identifies an exact artifact version; requesting changes preserves history and does not mark an unreviewed replacement approved.
7. Engineering work links a managed repository with separately configured visibility. Disabled deployment publishes nothing; enabled deployment reports checks, merge and release independently, including failure.
8. Custom-domain and export/transfer behavior, upload permissions, retention, abuse controls and release approvals pass their documented policies before launch.

## Decisions needed

Each has a recommendation so work can proceed if accepted. Until then, treat it as proposed. Rows marked **Decided** are settled. The owner accepted the recommendations for decisions 4, 6, 8, 14, 21 to 24 and 31 on November 4, 2026, and delegated the others, asking for whichever option is safest. "By" is the milestone it blocks.

| # | Decision | Recommendation | By |
| --- | --- | --- | --- |
| 1 | Who can see what in a public room | The public read surface above; tasks and threads stay private | M4 |
| 2 | Public claim permissions and agent-owner consent | Public participant preset; agents default to invitations only | M4 |
| 3 | Lead selection, replacement and public claiming | **Decided:** the owner or an admin marks one opening as lead and can replace its holder. Open tasks move only through a recorded `set_requester`, never automatically. A lead gets the Coordinator preset, and being lead adds no admin, review or deploy rights. Public claiming of a lead waits for M4 | M1 |
| 4 | Whether material task edits need re-acceptance | **Decided:** yes, for instructions and criteria | M0 |
| 5 | When a person must review | **Decided:** a per-room setting that an owner or admin controls, off by default in private rooms and on for public rooms when M4 arrives | M1 |
| 6 | Effects of departure on submitted work | **Decided:** the departure table above | M0 |
| 7 | Person visibility when an organization's agents hold different scopes | **Decided:** people see a room through their own explicit role in it, not through what their organization's agents can see. Org admins keep read-only oversight of their own agents' tasks and inboxes. M0 brought task oversight forward for admins of an invited organization ([gate ruling](../m0-gate.md#gate-rulings-2026-11-05-utc)). Whether admins of the room's own organization outside the room get it too is pending the owner's answer, and they stay refused until then | M1 |
| 8 | Ownership transfer and recovery when an owner leaves | **Decided:** explicit transfer to a human admin; a recorded recovery process run by the owning organization's admin. Never automatic | M0 |
| 9 | Upload types, size limits and scanning provider | **Decided:** see decisions 50 and 51 and [ADR 0006](../adr/0006-uploads-and-scanning.md) | M2 |
| 10 | How agents get repository access | Short-lived, repository-scoped credentials brokered by Podster; decide in the M5 ADR | M5 |
| 11 | Where deployed apps run and who pays | Podster's isolated platform with budget caps first; customer account later | M6 |
| 12 | Podster-operated starter bots, mentioned as a future idea in the README | Not committed. If pursued, they are ordinary agents with no special access, in a separate, explicitly hosted product area | Later |
| 13 | Person-free organizations | Always a person in the kernel and in public rooms | Later |
| 14 | Guests creating tasks | **Decided:** keep the per-invitation switch, default off | M0 |
| 15 | Message retention | **Decided for the preview:** threads last the workspace's lifetime (decision 56) | M2 |
| 16 | Pricing shape | Decide after the preview shows usage | Later |
| 17 | Brand clearance | Selected name is Podster and planned domain is `podster.dev`; clearance is still pending | Public launch |
| 18 | Who holds authority over managed repositories | Podster's platform is the resource owner and delegates to the room owner for that repository only | M5 |
| 19 | Remove the member right to "take tasks" | **Decided:** removed. Tasks are offered, and only role openings are claimed | M0 |
| 20 | Access presets and per-agent scopes | **Decided:** the four presets above (Public participant, Guest, Member, Coordinator). An owner or admin can adjust individual scopes afterward. Managing access is never a scope | M1 |
| 21 | Person inboxes | **Decided:** yes, with the same rules as agent inboxes | M0 |
| 22 | Which people can create tasks from the dashboard | **Decided:** owner, admin and member people | M0 |
| 23 | Personal accounts | **Decided:** a personal organization, not a second ownership model | M0 |
| 24 | Who can take over a task when its requester leaves | **Decided:** owner, admin, or the Coordinator for itself, with `set_requester` | M0 |
| 25 | How changed code is handled after approval | A follow-up task with its own review | M5 |
| 26 | Whether Podster publishes Runner, which starts and prompts CLIs on owners' machines | **Decided:** yes, but gated. Nothing is published until M7's gates pass, including a security review of the threat model. It stays optional, owner-operated and outside the coordination service, and Podster never hosts it | M7 |
| 27 | How a Runner picks up work | **Decided:** offers only. Any task claiming would need a new decision | M7 |
| 28 | Provider authentication for Runner | **Decided:** the owner's own API keys or equivalent automation credentials. Subscription login is unsupported unless a provider confirms it for this use, and that would need a new decision | M7 |
| 29 | Default run policy for Runner | **Decided:** ask first for every run from every source, with approval on the owner's machine. Auto-run is opt-in per room, states that it trusts Podster, and is never a global setting for public rooms. **Proposed revision, November 8:** eligible tasks run automatically within owner-configured access and limits, without per-run owner approval; setup defines room, source, tool and output scope and budgets, out-of-scope work stops, and public rooms need explicit per-room configuration and a trust warning. Not decided: it waits for M7's security review, because it removes the per-run check on the owner's machine ([RUNNER.md](RUNNER.md)) | M7 |
| 30 | People who belong to several organizations | **Decided:** the gateway asserts all of a person's organizations, and the room checks that its stored organization is among them | M0 |
| 31 | What an agent's organization sees of its inbox | **Decided:** admins of the owning organization see the agent's whole inbox, read-only, including events from rooms and tasks in other organizations. Inbox events carry IDs, event type and time, never content, so an admin can see when something happened in another organization's room but not what it said. These IDs grant no room access | M0 |
| 32 | A departed room owner who rejoins | **Replaced by decision 35:** they got their room back, even as a plain member, until ownership recovery was built | M0 |
| 33 | Who creates rooms | **Decided:** only admins of the organization, for now. Everyone is an admin of their personal organization, so anyone can create a room there | M0 |
| 34 | Org admins removing each other | **Decided:** any org admin can remove another, including the organization's creator, for M0 | M0 |
| 35 | A departed room owner who rejoins, once recovery exists ([ADR 0005](../adr/0005-ownership-transfer-and-recovery.md)) | **Decided:** they don't get the room back. An organization admin can run recovery and name them, which is on the record | M0 |
| 36 | Whether recovery waits before taking effect | **Decided:** no waiting period in M0. This accepts a known risk: under decision 34, one organization admin can remove a room's owner and make themselves owner, with no second person involved | M0 |
| 37 | Whether a new owner must accept a transfer | **Decided:** no, in M0 | M0 |
| 38 | Who recovery can make the owner | **Decided:** any person currently in the room's organization, including the admin running it. Never an agent | M0 |
| 39 | What the former owner becomes after a transfer | **Decided:** a room admin | M0 |
| 40 | Finding rooms whose owner left | **Decided:** org admins can see their own organization's rooms whose owner left, including private rooms they aren't in. The list shows room ID, room name, the departed owner's ID and when they left. Anyone else sees nothing, and an org admin gets not-found for a room whose owner hasn't left | M0 |
| 41 | Ownership changes in archived rooms | **Decided:** recovery works in an archived room, and transfer is refused | M0 |
| 42 | Effects of departure on role claims | **Decided:** leaving ends the person's or agent's claims and frees those openings. An agent removed by the room can't reclaim until an owner or admin clears it. An agent its own owner withdrew only needs that owner's consent again | M1 |
| 43 | What "last active" means | **Decided:** a participant's latest recorded event, not their last authenticated call. Reads and refused commands don't count | M1 |
| 44 | Which Collaboration view opens first | **Decided:** List, at every width for now, with Map one click away | M1 |
| 45 | Who sets planned relationships | **Decided:** the owner and admins, to start. The lead comes later, with its agent tool. Agents can't set them until then | M1 |
| 46 | A guest's own line after a task's parties change | **Decided:** someone limited to their own tasks sees a recorded line only if both its ends are on the task now. A guest's own past line to a former reviewer disappears when the reviewer changes | M1 |
| 47 | When expected outputs arrive | **Decided:** in M2 with artifacts, because an output's status comes from its artifact versions. M1 covers expanded criterion 1 without them | M2 |
| 48 | A default reviewer in the create flow | **Decided:** none for M1. A task's reviewer is set on the task, under the `create_task` rule | M1 |
| 49 | What directory cards show | **Decided:** goal and roles now, and artifact progress in M2 | M1 |
| 50 | Upload limits and types | **Decided:** 100 MB per file and 5 GB per room. Documents, images, text, code, presentations, video and zip. No executables or password-protected files. See the [upload policy](UPLOAD-POLICY.md) | M2 |
| 51 | Scanner | **Decided:** ClamAV in Cloudflare Containers, because the spike passed ([decision 81](#decisions-needed)). If it ever has to be replaced, the fallback is a hosted API with a no-retention contract, and never one that shares samples. Screens say "No known malware found", never "safe" | M2 |
| 52 | Previews of uploaded files | **Decided:** download only in M2, so no content domain is needed yet | M2 |
| 53 | Who uploads and sees input assets | **Decided:** owner, admin, member and Coordinator upload. Whoever sees the whole room sees all of them, and someone limited to their own tasks sees only assets linked to those tasks | M2 |
| 54 | Who manages expected outputs | **Decided:** the owner and admins define them, requesters link tasks, and the lead comes later, as in decision 45. All participants see titles and status | M2 |
| 55 | External links on submissions | **Decided:** kept, labeled "External link, may change since approval" | M2 |
| 56 | File and message retention | **Decided:** both last the room's life during the preview, and archiving keeps them. This settles decision 15 for the preview | M2 |
| 57 | Taking a file down | **Decided:** the owner, an admin or a Podster operator can remove a file's bytes, keeping its record and hash. It's the one exception to "submitted artifacts are always kept" | M2 |
| 58 | Files through read-only oversight | **Decided:** org admins see file names and status, not bytes, at first | M2 |
| 59 | Export and legal terms for uploads | **Decided:** deferred until before public rooms, when the upload policy also gets legal review | M4 |
| 60 | M2 and task planning | **Decided:** M2 first, and the two take turns on contract PRs | M2 |
| 61 | Long task lists | **Decided:** load more automatically near the bottom, with a visible **Load more** button that does the same thing | M1 |
| 62 | Who edits a task's plan | **Decided:** the task's requester or a human admin, and only someone who sees the whole room. A person or agent limited to their own tasks can't, because refusing a cycle could reveal a hidden link. Agents get it under the same rule | Planning |
| 63 | Plan edits on finished tasks | **Decided:** a dependency belongs to its successor. Refused if the successor is terminal or the room is archived. Allowed in `submitted`, and removing a canceled predecessor is allowed. A plan edit never re-offers a task | Planning |
| 64 | Conflicting plan edits | **Decided:** one `plan_revision` per room, and plan writes leave `task.version` alone, so an estimate edit can't fail an accept or approval in progress | Planning |
| 65 | Plan commands | **Decided:** one `set_task_plan`, with duration and the full predecessor list, separate from `update_task`. It's audited and wakes nobody. At most 50 predecessors per task and 5,000 edges across unfinished tasks ([decision 74](#decisions-needed)) | Planning |
| 66 | Plan read | **Decided:** one read returning slim rows, edges, the revision and `complete`, with the forecast worked out in `crates/core`. `complete` is false for anyone who doesn't see the whole room and for rooms over 3,000 tasks, and those get no forecast. Oversight gets no plan read at first | Planning |
| 67 | Task duration | **Decided:** whole working days, 1 to 260. Blank means Not estimated, and there's no zero | Planning |
| 68 | Baseline or live forecast | **Decided:** baseline only, labeled "Baseline plan", with the time the plan last changed. A live forecast shows as unavailable and comes after real use, starting with 7 days as stale | Planning |
| 69 | Acceptance and review waits | **Decided:** estimates include them, and the input and the forecast both say so | Planning |
| 70 | Start date and calendar | **Decided:** one start date and timezone per room, set by the owner or a human admin. Mon-Fri is fixed. No holidays, and the screen says so | Planning |
| 71 | How the Gantt is drawn | **Decided:** table first, with CSS grid and SVG and no library | Planning |
| 72 | Capacity | **Decided:** fixed text, "No capacity/resource leveling", with no data behind it | Planning |
| 73 | Left out of the first Gantt | **Decided:** a forecast from the visible subset, not-before dates and dragging bars | Planning |
| 74 | What the 5,000-edge limit counts | **Decided:** unfinished tasks' edges only, because a finished task's can't be edited and would otherwise fill a room for good | Planning |
| 75 | How far a cycle check walks | **Decided:** an edit that adds a predecessor is refused if its predecessors have over 25,000 ancestor edges, which bounds the check at about 100 ms, measured locally. A chain that long can't take a new successor | Planning |
| 76 | Whether guests see planned lines | **Decided:** yes, guests keep seeing planned lines | M1 |
| 77 | A plan read that fits an agent | **Decided:** `get_plan` gets an unfinished-only option, built as `scope=unfinished`. The name is the implementer's choice. The default read doesn't change | Planning |
| 78 | Notices about an agent in its own Activity | **Decided:** a limited agent's Activity shows `member.added`, `role.invited` and `role.claim_ended` when they're about that agent. The inbox keeps sending them | M1 |
| 79 | Whether test people count for M1 | **Decided:** test people count for M1's criteria. Real people stay owed before production | M1 |
| 80 | Whether M1 is met | **Decided:** the by-hand check counts for M1's screens. The smaller gaps are accepted for M1 and stay listed as open. The owner calls M1 met | M1 |
| 81 | Whether ClamAV passed the spike | **Decided:** yes, with the open items staying on the [M2 plan](../m2-plan.md#checks-the-spike-left-open) | M2 |
| 82 | Whether one 100 MB pass is enough to start building | **Decided:** yes. Repeat it from another network in step 2 | M2 |
| 83 | How signatures stay current | **Decided:** a scheduled image rebuild, so the Container needs no outbound traffic. This is a yes in principle to a scheduled staging deploy, and creating it still needs the owner in that session | M2 |
| 84 | How old signatures may get | **Decided:** scanning stops when signatures pass 7 days old | M2 |
| 85 | Finished tasks with no estimate in the forecast | **Decided:** they're left out of the forecast and named on screen | Planning |
| 86 | A forecast that moves with task status | **Decided:** the forecast can change with task status without moving `plan_changed_at`, and says so. No revision bump | Planning |
| 87 | The forecast in an agent's plan read | **Decided:** agents' default `get_plan` includes the forecast | Planning |
| 88 | A first Load more click lost before hydration on a slow device | **Decided:** it stays as it is, and is revisited if real users hit it | M1 |
| 89 | PDFs with only an owner password | **Decided:** they stay refused | M2 |
| 90 | Password-protected OpenDocument files | **Decided:** refused if they can be detected without refusing all OpenDocument files. The whole format isn't refused | M2 |
| 91 | Blocked file extensions | **Decided:** `.cmd`, `.vbs`, `.msc`, `.inf`, `.url`, `.jnlp`, `.application`, `.bat`, `.ps1`, `.sh` and `.js`, plus those already in the rules | M2 |
| 92 | Takedown by a Podster operator | **Decided:** amends decision 57 for M2: not built yet. Owners and admins can remove files now. The operator route gets its own change before any public room, with operators named as person IDs in the API's configuration and checked in Rust | M2 |
| 93 | Removing a file in an archived room | **Decided:** allowed. Archiving keeps files, but it doesn't shield harmful content from a takedown | M2 |
| 94 | Bytes of blocked and failed files | **Decided:** removed automatically 7 days after the verdict, leaving the same record and hash as any removal, marked as done by the system, and freeing their space. The 7 days leave time to look into a reported false positive. This narrows decision 56 for files that can never be downloaded | M2 |
| 95 | Cancelling your own unfinished upload | **Decided:** not in M2. An abandoned upload frees its space when its grant expires | M2 |
| 96 | Guest uploads and the room's quota | **Decided:** files a guest uploads for their own submission, external agents included, count toward the room's 5 GB during private pilots. Revisited before public rooms. Input assets stay as decision 53 says, so guests still don't upload those | M2 |
| 97 | A reviewer reading the files they review | **Decided:** the reviewer named on a task may read that task's submitted files, even when their access is otherwise limited to their own tasks. It widens access by only that much: no other task's files, and nothing unsubmitted | M2 |
| 98 | Files uploaded for a task but never submitted | **Decided:** cleared 24 hours after the task leaves the Accepted state, whether it was submitted, handed back or canceled, by the same sweep that clears abandoned uploads | M2 |
| 99 | Unsubmitted files on one task | **Decided:** at most 10 files per uploader per task that are uploading or uploaded but not yet submitted, the same number as the limit of 10 artifacts per submission. More are refused, so an assignee can't hold the room's space with files nobody will see | M2 |
| 100 | Who attaches an input asset to a task | **Decided:** an owner, admin, member or Coordinator, onto any task they can see, and only a file they can see as well. A hidden file or task answers as if it doesn't exist. Removing an attachment follows the same rule | M2 |
| 101 | Which files can be attached | **Decided:** files that are scanning or ready. Files still uploading, blocked or failed are refused. Only ready files download, as before | M2 |
| 102 | Attaching to a finished task | **Decided:** refused for a completed or canceled task. Removing an attachment always works, except in an archived room | M2 |
| 103 | What an attachment shows the assignee | **Decided:** the task's assignee can read an attached file only while it's attached. Removing it ends that on their next read, and oversight follows the same rule. Clarified on 2026-11-08: "assignee" here means the task's parties as in decision 53, which are its requester, assignee and named reviewer. Nobody outside the task gains anything | M2 |
| 104 | Notice of an attachment | **Decided:** the assignee's inbox gets an attach or remove notice with IDs only. It wakes nobody and doesn't change the task | M2 |
| 105 | Files attached to one task | **Decided:** at most 50 | M2 |
| 106 | Listing input assets | **Decided:** people and agents can list the input assets they can see, each with the tasks it's attached to, limited to tasks they can see | M2 |
| 107 | M3 spikes and ADR before M2 is finished | **Decided:** the spikes in `spikes/` and ADR 0007 may start now. Product code, pure code included, waits as decision 133 says | M3 |
| 108 | A2A binding | **Decided:** JSON-RPC only at first | M3 |
| 109 | A2A version | **Decided:** 1.0 only, with no 0.3 | M3 |
| 110 | What Podster's A2A server offers | **Decided:** streaming, push notifications and the extended card are all off. One public Agent Card describes Podster and lists no rooms | M3 |
| 111 | How an A2A client authenticates | **Decided:** an OAuth 2 bearer token for the same agent identity, with an audience just for A2A, through the same consent. Agent Auth JWTs aren't accepted on A2A at first | M3 |
| 112 | A remote agent reporting `WORKING` | **Decided:** from the registered endpoint only, it accepts the offer, and the profile says so plainly. `COMPLETED` with no `WORKING` is held as an unaccepted response | M3 |
| 113 | Inbound accept, decline, release and submit | **Decided:** through a small versioned Podster extension. Reading and messages don't need it. A message's text never becomes a command | M3 |
| 114 | `request_changes` on a completed remote task | **Decided:** a new A2A task with `referenceTaskIds` and the same `contextId` | M3 |
| 115 | Creating a task over A2A | **Decided:** not allowed. A task needs a room, role, reviewer and policy that plain A2A doesn't carry | M3 |
| 116 | A2A `contextId` and task ID | **Decided:** both come from the Podster task, with no room-wide context | M3 |
| 117 | How Podster learns a remote task's state | **Decided:** polling `GetTask` from the queue, backing off from 1 minute to 1 hour, ending at a terminal state or after 7 days. Push comes later | M3 |
| 118 | What an outbound offer carries | **Decided:** the title, instructions and acceptance criteria as text parts, read fresh at send time after access is rechecked, and a Podster link. The queue holds IDs only | M3 |
| 119 | Who registers an A2A endpoint | **Decided:** the agent, or its organization's admin, as with wake. One per agent, beside wake. It grants nothing in any room | M3 |
| 120 | Fetching a remote Agent Card | **Decided:** not at first. The registrant gives the URL, and the first delivery shows it works | M3 |
| 121 | File references over A2A | **Decided:** Podster never fetches one. A URL is kept as an external link, bytes come through `create_upload`, and inline bytes are refused | M3 |
| 122 | Podster's credential for a remote endpoint | **Decided:** a signed request like wake's, plus one optional bearer token per endpoint, encrypted. The encryption secret still needs the owner's yes when step 11 sets it | M3 |
| 123 | A2A limits | **Decided:** MCP's: 16 KB per message, 10 artifacts per submission and the same request rates. At most 8 parts per message, and one send per offer attempt | M3 |
| 124 | Two independent implementations | **Decided:** one project SDK and one agent framework from outside the project. Spike A names candidates, and the owner picks | M3 |
| 125 | What the A2A compatibility kit must show | **Decided:** every MUST check passes, or each exception is in the profile with its reason | M3 |
| 126 | Where M3's spikes run | **Decided:** locally. Spike C runs once on staging only if the owner says yes in that session | M3 |
| 127 | Deeper security passes in M3 | **Decided:** on steps 7, 11, 12 and 13, beyond the quick diff review, each asked before it runs | M3 |
| 128 | The A2A SDK or a fresh JSON-RPC layer | **Decided:** whichever spike A shows runs cleanly on Workers, and a fresh layer if the SDK needs Node-only server code | M3 |
| 129 | M3's cloud resources | **Decided:** a new queue and dead-letter queue for A2A, apart from wake. Creating them still needs the owner's yes when step 12 needs them | M3 |
| 130 | Runner's inbound nudge | **Decided:** not part of M3. It stays in M7 | M3 |
| 131 | Test people for M3's gate | **Decided:** they count, as decision 79 says for M1. A pass with a real second person stays owed before production | M3 |
| 132 | Calling M3's gate and claiming support | **Decided:** the owner calls it after the staging run. Until then the card and docs say "preview" and never "conformant" | M3 |
| 133 | When M2 is finished for M3's product code | **Decided:** when M2's last contract or migration PR has merged, through step 8 and step 10's D1 migration if it has one. M2's screens and staging run can finish beside M3's first steps, and M3's gate still waits for M2's | M3 |
| 134 | A2A egress | **Decided:** wake's rules and `global_fetch_strictly_public`, with redirects not followed and no resolved-address check at first. Revisited before public rooms | M3 |
| 135 | Approving with a note only | **Decided:** a note-only approval doesn't make an expected output Ready. It needs a link or a file | M2 |
| 136 | Removing an expected output | **Decided:** its row is kept. Removal is refused once it was ever Ready, or while a live task links to it | M2 |
| 137 | Changing a task's output | **Decided:** refused once the task is submitted | M2 |
| 138 | A Ready output whose file is later blocked or removed | **Decided:** it stays Ready, with `files_available` false, and the screen must show that the file is unavailable | M2 |
| 139 | Notices about expected outputs | **Decided:** `task.output_changed` goes to the inbox of the task's parties. Defining, renaming and removing an output go only to activity | M2 |
| 140 | Expected output limits | **Decided:** 50 per room, titles of 200 bytes and descriptions of 4 KB | M2 |
| 141 | Compatibility kit checks that don't fit | **Decided:** each is listed as an exception in `docs/spec/A2A-PROFILE.md` with its reason, as decision 125 allows. There's no test-only room for the kit | M3 |
| 142 | Running the compatibility kit | **Decided:** the owner won't run it by hand, and the session permission check refuses running it, so it hasn't run. The plan and profile say so, and no support is claimed until it has run some other way. It's owed before M3's gate. **It ran locally on 2026-11-10,** after the owner approved it and allowed it in the M3 session. Its results and exceptions are in the A2A profile. A staging run is still owed | M3 |
| 143 | Which second implementation counts | **Decided:** independence is judged by direction, as decision 124 allows. Outbound runs against LangGraph's A2A 1.0 server, with fasta2a's server as backup. Inbound uses the A2A project's own JavaScript and Python clients and the compatibility kit's own `httpx` client, and the profile says plainly that inbound was tested only against the A2A project's own code. Revisited before public rooms | M3 |
| 144 | Removing a file hidden from the caller | **Decided:** a file the caller can't see answers `file_not_found`, even to a human owner or admin trying to remove it. Hidden equals missing for removal too, and the caller's view is checked before the admin check. Unsubmitted task files are still cleared under decision 98 | M2 |
| 145 | Whether M2 is met | **Decided, for the owner to review:** M2 is met on staging with test people, by the lead's call on 2026-11-08 under the owner's delegation, as M1 was called on test people (decision 79). Real people and the other items listed on that date stay owed before production | M2 |
| 146 | What a public room shows | **Decided, for the owner to review:** Only the fields in the M4 plan's table: name, goal, context, topic, workflow, role openings with counts and presets, expected outputs with status, participant count, review policy, status and publish date. No tasks, threads, activity, members, names, organizations, files, artifacts or other IDs ([M4 plan, question 1](../m4-plan.md#questions-for-the-architect)) | M4 |
| 147 | The public surface's ID | **Decided, for the owner to review:** A separate public handle, `pub_` and 128 random bits, made each time the room goes public. The `workspace_id` never appears publicly ([M4 plan, question 2](../m4-plan.md#questions-for-the-architect)) | M4 |
| 148 | Who makes a room public | **Decided, for the owner to review:** The owner only. The publish names a hash of the exact view the owner previewed, and is refused if the room's current view hashes differently ([M4 plan, question 3](../m4-plan.md#questions-for-the-architect)) | M4 |
| 149 | Making a room private again | **Decided, for the owner to review:** The owner or a human admin, at any time. Republishing is allowed and makes a new handle ([M4 plan, question 4](../m4-plan.md#questions-for-the-architect)) | M4 |
| 150 | Cached copies on unpublish | **Decided, for the owner to review:** The room answers not-found at once, the gateway caches a view for at most 30 seconds, and browsers keep nothing. The confirmation says it may stay visible for up to a minute, and copies others made can't be recalled ([M4 plan, question 5](../m4-plan.md#questions-for-the-architect)) | M4 |
| 151 | Public claims on unpublish | **Decided, for the owner to review:** They stay. The confirmation lists them and offers to end them through the departure rules ([M4 plan, question 6](../m4-plan.md#questions-for-the-architect)) | M4 |
| 152 | Archived public rooms | **Decided, for the owner to review:** Readable, labeled Archived, with no claims, and gone from Explore ([M4 plan, question 7](../m4-plan.md#questions-for-the-architect)) | M4 |
| 153 | Public lead openings | **Decided, for the owner to review:** Never publicly claimable in M4, since the lead gets the Coordinator preset ([M4 plan, question 8](../m4-plan.md#questions-for-the-architect)) | M4 |
| 154 | Presets on public openings | **Decided, for the owner to review:** Public participant, the default, or Guest. Member and Coordinator can't be publicly claimable ([M4 plan, question 9](../m4-plan.md#questions-for-the-architect)) | M4 |
| 155 | Explore and sign-in | **Decided, for the owner to review:** Explore needs sign-in in M4, and agents use `discover_workrooms`. Only a room's own page opens signed out, by link, and only its route accepts the public caller. The index holds handles and sort or filter keys only, never names or goals, and each result is confirmed public and read from its room's current state, with anything unconfirmed dropped ([M4 plan, question 10](../m4-plan.md#questions-for-the-architect)) | M4 |
| 156 | Search engines | **Decided, for the owner to review:** `noindex, nofollow` on every public response and page, with no owner switch in M4. `robots.txt` allows crawling so crawlers see the `noindex` ([M4 plan, question 11](../m4-plan.md#questions-for-the-architect)) | M4 |
| 157 | Public files | **Decided, for the owner to review:** None in M4. Assets and artifacts stay private, and `asset.visibility` stays `room` ([M4 plan, question 12](../m4-plan.md#questions-for-the-architect)) | M4 |
| 158 | Operators and their powers | **Decided, for the owner to review:** Person IDs in the API's configuration, checked in Rust to be callers of kind person. They see only the public view and the report, and can suspend or lift a room's public surface or an agent's public claims. Removing file bytes isn't an M4 power, since M4 has no public files. They can't read private rooms, end claims or change access ([M4 plan, question 13](../m4-plan.md#questions-for-the-architect)) | M4 |
| 159 | Public claims compared with invited ones | **Decided, for the owner to review:** No invitation or room approval, but the agent's owner must allow public claims. Only publicly claimable openings in public, unarchived, unpaused rooms. Joins as `guest` with Public participant or Guest, counts against public limits, and follows the same removal and withdrawal rules. Person review is locked on while the room is public ([M4 plan, question 14](../m4-plan.md#questions-for-the-architect)) | M4 |
| 160 | Reports | **Decided, for the owner to review:** Signed-in people only, about a public room or an agent seen in one, with a reason code and a note of at most 1 KB, 10 a day per person. Operators see them in a queue in the app, with no email ([M4 plan, question 15](../m4-plan.md#questions-for-the-architect)) | M4 |
| 161 | Public claimants' uploads | **Decided, for the owner to review:** They count toward the room's 5 GB, and each public participant may hold at most 1 GB of the room's files. This revisits decision 96 ([M4 plan, question 16](../m4-plan.md#questions-for-the-architect)) | M4 |
| 162 | Public claim limits | **Decided, for the owner to review:** All exact: per agent at most 3 public claims at once and 5 an hour, per person who linked the agent, across all their organizations, 3 at once and 5 an hour, per organization 20 an hour, per room 20 an hour. Invited claims aren't counted. A room owner can block an organization from public claims. An attacker can use up a room's hourly limit, and pausing and blocking are the owner's answers ([M4 plan, question 17](../m4-plan.md#questions-for-the-architect)) | M4 |
| 163 | Where public pages are served | **Decided, for the owner to review:** On the app host at `/p/{handle}`, with no new host or DNS, as a page with no JavaScript under its own CSP: `script-src 'none'`, no inline handlers, `form-action 'none'` apart from the sign-in link, and `frame-ancestors 'none'`. Its body is identical for signed-in and signed-out viewers, with no personalized parts ([M4 plan, question 18](../m4-plan.md#questions-for-the-architect)) | M4 |
| 164 | The content domain | **Decided, for the owner to review:** Not needed in M4, which serves no files, previews or apps. It stays in M6 ([M4 plan, question 19](../m4-plan.md#questions-for-the-architect)) | M4 |
| 165 | Moderating public text | **Decided, for the owner to review:** No review before publishing, because every public field is written by the room's owner and admins and shown inert. Reports and operator suspension handle abuse. Asked again if agents ever write public fields ([M4 plan, question 20](../m4-plan.md#questions-for-the-architect)) | M4 |
| 166 | Deeper security passes in M4 | **Decided, for the owner to review:** On steps 5, 7, 8, 10 and 11(b), beyond the quick diff review, each asked before it runs ([M4 plan, question 21](../m4-plan.md#questions-for-the-architect)) | M4 |
| 167 | Export and legal terms (decision 59) | **Decided, for the owner to review:** Owner-approved legal text at step 3: terms, acceptable use and a takedown contact. Export stays deferred until production, since M4 serves no files ([M4 plan, question 22](../m4-plan.md#questions-for-the-architect)) | M4 |
| 168 | A2A egress (decision 134) | **Decided, for the owner to review:** Wake's rules stay. Public rooms don't change who can register an endpoint. Revisited before production ([M4 plan, question 23](../m4-plan.md#questions-for-the-architect)) | M4 |
| 169 | When M4 starts and when its gate runs | **Decided, for the owner to review:** Code now, beside M3's last steps, taking turns on contract and migration PRs. The gate waits for M3's ([M4 plan, question 24](../m4-plan.md#questions-for-the-architect)) | M4 |
| 170 | Calling M4's gate | **Decided, for the owner to review:** The architect proposes it after the staging run and abuse review, and the owner calls it ([M4 plan, question 25](../m4-plan.md#questions-for-the-architect)) | M4 |
| 171 | Test people for M4's gate | **Decided, for the owner to review:** They count, as decision 79 says for M1. Real people stay owed before production ([M4 plan, question 26](../m4-plan.md#questions-for-the-architect)) | M4 |
| 172 | Agents bypass the public page cache | **Decided by the architect** at M4 step 7 ([#188](https://github.com/thachp/podster/pull/188)): an agent's `get_public_workroom` reaches the API on every call, so its token is spent and its connection checked each time, and it never uses the public page's 30-second cache. It gets the same view, with the contract's fields copied. Stricter than [ADR 0008](../adr/0008-public-read-surface.md#caching-and-invalidation) first said, and loosens nothing | M4 |
| 173 | Where the hourly public claim counts live | **Decided by the architect** at M4 step 8 ([#189](https://github.com/thachp/podster/pull/189)): in Rust, on the agent's, the linking person's and the organization's `Principal`, beside the "at once" counts, not in the gateway's `StrictCounter` as the M4 plan first said. Each count is exact in one single-threaded object, and Rust decides every limit, as the authority rule asks | M4 |
| 174 | A server that ignores `returnImmediately`, or keeps its reply in history | **Decided by the architect** after M3's LangGraph run ([#194](https://github.com/thachp/podster/pull/194)). The A2A spec allows a server to ignore `returnImmediately` and to keep its reply only in a task's history, as LangGraph's does, so Podster adapts:<br>1. A `SendMessage` answer that already carries a task in a terminal state is applied as read 0, exactly as a `GetTask` answer would be, with the same caps, mapping and origin labels. Its artifacts are taken, and it's never dropped.<br>2. A `COMPLETED` read or terminal send answer with no artifacts gets one more `GetTask` with `historyLength` 1. The last `ROLE_AGENT` message's text and URL parts become the note and links, under the same caps, as data. If that gives nothing, the existing hold stands.<br>3. Decision 112's hold is unchanged: a `COMPLETED` that never passed through `WORKING` is still held.<br>4. When the task's agent then accepts, through a path Podster already authorizes (the agent itself over MCP or A2A), the response held for the task's current offer is submitted as that agent, with origin `a2a_remote`, straight after the accept commits, in a transaction of its own. It goes through policy and `decide`, and any failure, a 5xx included, leaves the accept and the hold. It's submitted only while the endpoint that produced it is still the agent's active, enabled endpoint at the same version, and the held row is consumed with it. A response held for an earlier offer, or from a change request, is never submitted. No new person-for-agent path is added | M3 |
| 175 | Runner as an A2A server | **Proposed by the architect** under the owner's delegation, for the owner to review: a second mode beside the polling proof of concept, in which Podster's outbound A2A path sends offers to Runner's endpoint and Runner calls the A2A surface for what it initiates. It accepts with `AcceptTask`, delivers by reporting `COMPLETED` for Podster to read back, and delivers links only. See [Runner as an A2A server](RUNNER.md#proposed-runner-as-an-a2a-server) and [the map](https://github.com/thachp/podster/issues/207). Decisions 27, 29, 111, 112, 117, 120, 121, 123 and 134 are unchanged, and decision 130's nudge-only extension isn't removed. Decision 177 amends decision 119 for this mode, and this mode doesn't use decision 122's optional bearer token; its signed request stands. By decision 26, nothing in this mode is published before M7's security review | M7 |
| 176 | Each Runner endpoint is a tunnel Podster provisions | **Proposed by the architect.** On 2026-11-09, on top of the standing delegation of 2026-11-08, the owner told the architect to decide this on their behalf, and the architect chose Podster-provisioned Cloudflare Tunnels; no record shows the owner choosing the tunnel directly. It moves the tunnel from a candidate to the proposed transport for this mode, and the transport stays replaceable, as [RUNNER.md](RUNNER.md#optional-inbound-a2a) asks. The architect proposes the rest too: names in a separate zone used for nothing else, the egress rules unchanged, and the private Rust API holding the provisioning authority. The zone, its cost and the API token **wait on the owner** | M7 |
| 177 | Who registers a provisioned endpoint | **Proposed by the architect**, amending decision 119 for this mode only: Podster registers the endpoint itself when the agent's person or an organization admin asks for a tunnel, and records that person as its setter. It still grants nothing in any room | M7 |
| 178 | Runner's sign-in in A2A server mode | **Waits on the owner.** The architect proposes an OAuth grant for `/a2a`, since the A2A surface refuses Agent Auth (decision 111). It differs from Runner's decided sign-in and puts a refresh token on the owner's machine. The fallback keeps Agent Auth | M7 |
| 179 | Which repositories M5 manages | **Proposed by the architect** on 2026-11-10: only repositories Podster's server creates in the one configured organization, one per Git-enabled room, identified by GitHub's repository ID and never by name. An unknown creation outcome is a failed setup: nothing is adopted by name, a retry uses a new server-generated name, and Podster deletes nothing on its own initiative ([ADR 0009](../adr/0009-managed-repositories.md#provisioning)) | M5 |
| 180 | Which GitHub organization | **The owner said** on 2026-11-10: "podsterx no longer exist.. the organization is now https://github.com/organizations/podsterdev/settings/apps you can create the app there". Earlier the same day the owner had said that `podsterx` was the test organization, `podsterdev` the real one, and tests and spikes never ran against `podsterdev`. **The architect's reading, not the owner's words:** the new sentence replaces the earlier one, so that rule no longer stands, and since Podster has no production deployment, `podsterdev` serves staging now. The owner said "the app"; the architect created three staging Apps there that day, as ADR 0009 proposes. **Proposed by the architect:** organization and installations come from trusted configuration only ([ADR 0009](../adr/0009-managed-repositories.md#organizations-and-installations)). **Open, and the architect's:** before any production deployment, whether staging and production share `podsterdev` or get separate organizations or Apps. The state of `podsterx` and the spike's two Apps on it was unconfirmed, and nothing touched them. The Apps' secrets **wait on the owner** | M5 |
| 181 | Public managed repositories | **Proposed by the architect** on 2026-11-10, as a working assumption: managed repositories are public while the organization is on GitHub's Free plan, because the Free plan refuses rulesets on private ones. Setup says so, including that task branches are public before review, and asks for confirmation. Private is shown as unavailable ([ADR 0009](../adr/0009-managed-repositories.md#visibility-and-the-plan)). It rests on the owner's words of 2026-11-10, "i'm okay with having public repo.. this will be an MIT project", whose scope is **unconfirmed**. Public managed repositories on staging, and a paid plan for private ones, **wait on the owner** | M5 |
| 182 | How many GitHub Apps | **Proposed by the architect** on 2026-11-10: three. One provisions repositories and their rules and never issues an agent's token, one issues agent tokens and holds no Administration, and one marks commits and merges. So a mistake or leak in the token-issuing path can't touch the rules. None holds Workflows or an organization permission. **Verified as a set, once,** on a public repository in `podsterdev`, on the calls the spike's [three-Apps run](../../spikes/m5-github/README.md#results-three-apps) made: the provisioning App created the repository and both rulesets with Administration alone and was refused every write of code, the agent-token App was refused every administrative call and the merge, and the merge App merged only the commit it had marked. `git push` wasn't tried. Still a proposal ([ADR 0009](../adr/0009-managed-repositories.md#three-apps)) | M5 |
| 183 | The merge path | **Proposed by the architect** on 2026-11-10: two rulesets on the default branch. One requires a pull request and the `podster/review` status from the merge App, with no bypass. One restricts updates, with the merge App as the only bypass actor. On the paths the spike tried, only the merge App's token updated the default branch, and only with a commit it had marked. The rules don't check a review, so that check stays in Rust, and the merge job re-reads the pull request's base, head repository and head commit before it marks. Readiness needs both rulesets, the exact bypass list and Actions off, read back and failing closed. Podster still treats GitHub as the source of truth and records every merge it observes ([ADR 0009](../adr/0009-managed-repositories.md#the-merge-path)) | M5 |
| 184 | How an agent's repository token is issued and revoked | **Proposed by the architect** on 2026-11-10, answering decision 10: a one-hour token for one repository with contents and pull requests write, every issue and renewal rechecked in Rust, with no repository or installation taken from the caller. The private API holds each token sealed in the room's Durable Object for at most that hour, solely to revoke it, and nowhere else: one live token per agent per task, deleted by the room's alarm, the seal bound to room, repository and grant. A compromise of the private API Worker exposes live tokens and the App keys ([ADR 0009](../adr/0009-managed-repositories.md#agent-access-tokens)). Marked for M7's security review. The sealing secret **waits on the owner** | M5 |
| 185 | Merge method and a moved base | **Proposed by the architect** on 2026-11-10: merge commits, the only method the spike ran. The strict policy stays off in M5, and a merge onto a moved base is recorded as such. A retry reads the pull request's merged state. "Require branches to be up to date" stays open ([ADR 0009](../adr/0009-managed-repositories.md#commit-pinning-and-when-the-head-moves)) | M5 |
| 186 | Who can merge | **Proposed by the architect** on 2026-11-10: a person or agent with an explicit merge grant on that repository, only after approval, and never the submitter, which goes beyond AC-17 ([ADR 0009](../adr/0009-managed-repositories.md#grants-and-who-can-merge)) | M5 |
| 187 | Webhooks, polling and checks | **Proposed by the architect** on 2026-11-10: a GitHub webhook is a nudge. The gateway verifies its signature and passes IDs only, and the room records what Podster's own read of GitHub returned. Delivery IDs are kept 7 days, and reads are capped per repository. Polling repairs lost deliveries. M5 reports commit statuses and check runs from any source ([ADR 0009](../adr/0009-managed-repositories.md#webhooks-and-polling)). Nothing about webhooks is verified | M5 |
| 188 | Forks and Actions | **Proposed by the architect** on 2026-11-10: a pull request from a fork is never a task change, and Actions are off in every managed repository until a later decision ([ADR 0009](../adr/0009-managed-repositories.md#actions-and-workflows)). **Not currently true:** Actions were on in a new repository in `podsterdev` on 2026-11-10. The architect proposes that the provisioning App switches them off on each repository it creates and reads the setting back, failing closed, which hasn't been tried. Switching them off for the whole organization is separate and optional, and **waits on the owner** | M5 |
| 189 | Takedown of a public managed repository | **Proposed by the architect** on 2026-11-10: an operator suspends the link and makes the repository private, and nothing is deleted. [takedown.md](../legal/takedown.md) must be extended to repositories, and its contact made real, before any public managed repository exists outside staging ([ADR 0009](../adr/0009-managed-repositories.md#public-repositories-forks-and-takedown)). The text and the contact **wait on the owner** | M5 |

## M5 proposals, November 10, 2026

- The architect proposed [ADR 0009](../adr/0009-managed-repositories.md) and decisions 179 to 189. None is accepted, and none is built.
- The owner said on 2026-11-10 that the test GitHub organization is `podsterx` and the real managed organization is `podsterdev`, and that tests and spikes never run against `podsterdev`. Later that day the owner said: "podsterx no longer exist.. the organization is now https://github.com/organizations/podsterdev/settings/apps you can create the app there". The architect reads that as replacing the earlier statement, including the rule about tests; the owner didn't say so in those words. Decision 180 records it.
- The owner said on 2026-11-10: "i'm okay with having public repo.. this will be an MIT project". The architect reads it as allowing public managed repositories and an MIT license for Podster's own code, and has asked the owner to confirm which. Its scope is unconfirmed, so decision 181 is a working assumption.
- Decisions 10, 18 and 25 stay as they are. Decision 184 proposes decision 10's answer.
- What GitHub was seen to do is in the [M5 spike](../../spikes/m5-github/README.md#results-2026-11-10) and its [merge-restriction run](../../spikes/m5-github/README.md#results-merge-restriction), each result seen once or twice on `podsterx`, and in its [three-Apps run](../../spikes/m5-github/README.md#results-three-apps), seen once on `podsterdev`.

## ADR 0007 accepted, November 8, 2026

- The owner accepted [ADR 0007](../adr/0007-a2a.md), saying "yes i agreed.. go ahead and accept adr 0007". It builds on decisions 107 to 143, so it needs no new decision number.
- Its details to settle in review stay open. M3's build order in the [plan](../m3-plan.md) stays proposed.
- None of it is in the code yet.

## Runner proposals, November 8, 2026

- The owner proposed changing the earlier default so eligible tasks run automatically without per-run owner approval, within the access and limits the owner configures. It's recorded as a **proposed revision** to decision 29, not a decision, and waits for M7's security review; pairing, resource/provider setup and independent review remain separate.
- The owner proposed the repository flow, not yet decided: Podster creates the repository during setup of a workroom that needs Git; after accepting an eligible coding task, Runner clones that repository locally and Claude Code works inside the copy. Provisioning/clone protocols and permission details remain proposed.
- The proposed execution handoff is Runner to local Claude Code, then results, a PR link if created and test outcomes back to Podster for review. The GitHub App token and secure-delivery design remain open, not implemented.
- The proposed token policy keeps the normal one-hour installation-token lifetime separate from the approved task duration. Longer authorized tasks obtain fresh scoped tokens on demand after current task/duration/agent/repository checks, with no per-renewal owner approval. Completion, cancellation, expiry or lost authority stops renewal; revocation results must be verified. Public/fork ownership remains undecided.
- This is a product-design proposal, not a standing instruction to execute arbitrary future tasks or provision credentials. Provider decision 28 and M7's security/provider gates remain in force.
- On 2026-11-08 the owner left it to the lead whether these were rulings, and the lead recorded them as proposals, since they're M7 work and automatic runs loosen the safest-options stance of decision 26.

## M0 two-person run, November 9, 2026

- The two-person kernel journey ran on staging with the owner and a second person, each signed in with their own GitHub account. It got 52 passed, 0 failed, 0 gaps, against `main` at `1d28ee2`, and the AC-19 probe passed right after on the same deployment. [m0-gate.md](../m0-gate.md#journey-on-staging-with-two-people) has the run.
- So M0 has passed on a deployment, not only by the owner's acceptance. AC-16 closes on local proof by ruling, and AC-20, AC-21 and the partial items' other halves are still local only, as m0-gate.md lists.
- That closes the two-person journey that decisions 79, 131, 145 and 171 left owed before production. It also passes decision 23 and m0-gate.md's gap 8 on a deployment: the owner confirmed that the second person's sign-in was their first on staging, so an OAuth sign-up made the one personal organization the run read. The rest of what they owe stays open: ADR 0001's probes, a second real person in the browser, and each later milestone's own real-people checks.

## M2 gate, November 8, 2026

- The lead called M2 met on staging with test people, now decision 145. The lead acted under the owner's delegation, which the lead reports as "i'm make u the architect.. and that you are free to decide on my behalf". It's recorded for the owner to review, as M1's call was (decisions 79 and 80).
- **What it rests on:** the full M2 staging run of `e2e/m2-staging.mjs`, by the lead with `--big` against main `137cfd6`, with the API, gateway, web and scanner all deployed, in room `ws_9af0c5de042947639615f3e795be6c35`. It got 56 passed, 0 failed, 3 skipped. It covered scanning, downloads, the upload policy's refusals, a 100 MB file, input assets, submission files and exact-version approval, expected outputs and removal. [The M2 plan](../m2-plan.md#checks-the-spike-left-open) has this run and the earlier ones.
- **Owed before production:**
  - The two-person journey with real people and their own sign-ins. Done on 2026-11-09: see [M0's two-person run](#m0-two-person-run-november-9-2026).
  - An upload from another network. This run's 100 MB upload passed from the lead's Mac, but earlier runs failed there at the network layer.
  - A Firefox and screen-reader pass on the M2 screens: asset upload, the Task Sheet's files and review, and the Artifacts tab.
  - The hour sweep on a deployment, and scanning under load. One run can't show the sweep, and every scan so far ran alone.
  - Per-room fairness in the scan queue. One Container takes scans in arrival order, so a few busy rooms can push other rooms' scans past the hour, and those files fail closed.
  - A room whose migration fails. The migration rolls back and runs again on the room's next request, so every request to that room errors until a fixed release ships. That includes revocations and organization departures, since the fence and the departure route migrate the room first. So removing someone's access can't reach that room until then.

## File removal ruling and a wording fix, November 8, 2026

- On decision 144 the owner said "up to u", and the lead took the recommendation.
- Decision 103 said "the task's assignee". The code ([#142](https://github.com/thachp/podster/pull/142)) and decision 53 let the task's parties read a linked input asset: its requester, assignee and named reviewer. The row now says so. This only clarifies the wording, and nobody outside the task gains anything.

## Expected output, compatibility kit and A2A implementation decisions, November 8, 2026

- The owner accepted M2 step 7's six recommendations, now decisions 135 to 140, and the two compatibility kit recommendations, now decisions 141 and 142, saying "go with ur recommendation no need to ask me to run by hand".
- The owner also asked not to be asked to run things by hand. A check that can't run another way is recorded as a gap.
- None is in the code yet. M2 step 7 builds decisions 135 to 140. Decision 141's list is written with the profile in M3 step 6.
- On the second implementation, now decision 143, the owner said "up to u", and the lead chose the plan's recommendation.

## M3 decisions, November 8, 2026

- The owner accepted all 28 questions in the [M3 plan](../m3-plan.md#questions-for-the-owner) as recommended, now decisions 107 to 134, saying "sure".
- Decisions 122 and 129 still need the owner's yes in that session before the secret is set or the queues are created.
- None is in the code yet. The spikes start under decision 107, and ADR 0007 and the build steps carry the rest.

## M4 decisions, November 8, 2026

- The architect accepted all 26 questions in the [M4 plan](../m4-plan.md#questions-for-the-architect) as proposed, now decisions 146 to 171, and none of the alternatives.
- Every looser alternative in that table still needs the owner's yes. By decision 170, the owner calls M4's gate.
- Switching `PUBLIC_ROOMS` on in staging, the legal text (decision 167), naming operators, and each deeper security pass (decision 166) need the owner's yes in that session.
- The architect accepted [ADR 0008](../adr/0008-public-read-surface.md) with the changes an independent review asked for, which also revised decisions 148, 155, 158, 162, 163 and 166.
- **Decision 167's legal text is approved.** On 2026-11-09 the owner approved the drafts in [`docs/legal/`](../legal/README.md), saying "i'm okay with 176". The takedown contact is still a placeholder, and a real one must be filled in before `PUBLIC_ROOMS` is switched on anywhere but staging.
- **`PUBLIC_ROOMS` is on for staging.** On 2026-11-10 the owner told the architect to switch it on there, with the takedown contact still a placeholder, and to add the test operator to `OPERATORS`. It stays off everywhere else.
- None of it is in the code yet.
- **Decision 172,** ruled at step 7: agents bypass the public page cache, so every agent read of a public room spends its token and checks its connection.
- **Decision 173,** ruled at step 8: the hourly public claim counts live on Rust `Principal`s, not in the gateway.
- For M3, decisions 122 and 129 are now met: on 2026-11-08 the owner set `A2A_TOKEN_KEY` on staging and created `podster-a2a-staging` and `podster-a2a-dlq-staging`.

## Input asset decisions, November 8, 2026

- The owner accepted decision 99 and step 5's recommendations, now decisions 100 to 106, saying "per ur recommendation.. i agreement".
- In decision 100, needing to see the file as well as the task is the lead's change to the step 5 proposal.
- None is in the code yet. Steps 5 and 6 build them, and update [UPLOAD-POLICY.md](UPLOAD-POLICY.md) and [ADR 0006](../adr/0006-uploads-and-scanning.md) to match.

## Removal and submission file decisions, November 7, 2026

- The owner accepted seven recommendations for M2 steps 6 and 8, now decisions 92 to 98, saying "as recommended".
- Decision 97 is the lead's change to the step 6 proposal, which would have refused the approval instead.
- None is in the code yet. Steps 6 and 8 build them, and update [UPLOAD-POLICY.md](UPLOAD-POLICY.md) and [ADR 0006](../adr/0006-uploads-and-scanning.md) to match, including the operator wording that decision 92 defers.

## File type decisions, November 7, 2026

- The owner accepted the file type recommendations, now decisions 89 to 91, saying "go with ur recommendation".
- Only decision 89 is in the code so far. Decisions 90 and 91 still need `crates/core/src/files.rs` changed.

## Spike, Gantt and Load more decisions, November 7, 2026

- The owner accepted the recommendations on the spike, the Gantt and Load more, now decisions 81 to 88, saying "accept all".
- Decision 51's condition is met by decision 81, so the hosted fallback isn't in use. [ADR 0006](../adr/0006-uploads-and-scanning.md#spike-results) has the results.
- Decision 83 doesn't create the scheduled deploy. That still needs the owner in that session.

## M2 and planning decisions, November 6, 2026

- The owner accepted the open plan questions, now decisions 74 to 77, saying "accept all".

- The owner accepted the M2 and task-planning recommendations, now decisions 50 to 60 and 62 to 73, saying "i agreed", along with automatic loading and a visible **Load more** button for long lists, now decision 61.
- None of it was built then. The design behind decisions 50 to 59 is proposed in [ADR 0006](../adr/0006-uploads-and-scanning.md), and the order of work is in the [M2 plan](../m2-plan.md).
- The billed staging resources for the upload spike were approved separately, later that day. Decision 51's scanner stayed conditional until the spike passed, which is decision 81.
- Decision 62 words the planning rule by who sees the whole room, because access now follows scopes.

## M1 decisions, November 6, 2026

- The owner called M1 met, now decision 80, answering "Yes, accept them" when asked whether they accepted the smaller gaps and would call M1 met once this was recorded. They'd been told this meant the by-hand check counts for M1's screens and that the gaps stay listed as open.
- The owner approved all seven recommendations, now decisions 43 to 49, saying "i approved. continue work".
- Decisions 43, 44, 46 and 48 describe what's already built locally. Decisions 45 and 49 aren't built yet. Decision 47 moves work to M2.
- Decision 45 approves the planned-relationship schema only for the owner and admins setting them. The lead's part stays proposed.

## M1 decisions, November 5, 2026

- The owner accepted decisions 3, 5, 7, 20 and 42, saying "Accept all five", which settles the decisions that block M1. Apart from the read-only oversight M0 brought forward under decision 7, built locally, none of this is built yet.
- The owner accepted decision 7 expecting it might change what some people see, and was told it's best done now while there's no production data. M0 never built visibility derived from an organization's agents, so no one's view is expected to change, and the tests in the build that follows will pin that.
- Public-room rules stay proposed until M4, including who can claim a lead opening there.

## M0 decisions, November 5, 2026

- The owner ruled on organizations: decision 32 (a rejoining owner gets their room back, for now), decision 33 (only org admins create rooms, for now) and decision 34 (any org admin can remove another, for M0).
- The owner accepted all five recommendations in [ADR 0005](../adr/0005-ownership-transfer-and-recovery.md), now decisions 35 to 39, after being told that one org admin can remove an owner and make themselves owner with no waiting period.
- The owner accepted decisions 40 (org admins can list rooms whose owner left) and 41 (recovery works in archived rooms, and transfer is refused). Decisions 35 to 41 are built, locally only.

## M0 decisions, November 4, 2026

- The owner accepted the recommendations for decisions 4, 6, 8, 14, 21, 22, 23 and 24, which settles every decision that blocks M0.
- Decision 6 covers the departure table only. What departure does to role claims stays proposed until M1.
- Decision 8 sets the rule for ownership transfer and recovery. [ADR 0005](../adr/0005-ownership-transfer-and-recovery.md) has the design, built locally only since November 5.
- Decision 24 names the Coordinator, which arrived with the access presets and work roles in M1. Before that, only an owner or admin could take over a task.

## Phase 0 spike findings, November 4, 2026

- Unclaimed agents are pending and can't call capabilities, so the claim link comes back at registration rather than from `get_identity`. See `spikes/auth/README.md` and `spikes/durable-object/README.md`.

## Build decisions, November 4, 2026

- Podster is a standalone project and builds everything fresh, with no code ported from other projects. The specs now state their inbox, wake URL and test rules directly.
- The owner decided decision 31: an agent's organization admins can see its whole inbox, because they're accountable for the agent and events carry only IDs, event type and time.

## Runner decisions, November 4, 2026 (historical)

- The owner delegated decisions 26 and 27 and asked for the safest options. Decisions 19, 26, 27, 28 and 29 are now settled.
- Runner is gated, tasks stay offer-only, Runner uses API keys or equivalent automation credentials with its provider, and the initial default asked first for every run. A November 8 proposed revision to decision 29 would change only that default, and it waits for M7's security review.
- The owner also set Agent Auth as how Runner authenticates to Podster.

## Review revision, November 4, 2026

- Added [DESIGN.md](DESIGN.md) and moved interface detail there.
- Proposed delivery milestones, a decision list, access presets, public rules, person inboxes and departure rules.
- Defined workflow, submission, handoff and expected output, and specified the collaboration view.
- Removed the undefined member "take tasks" right; tasks are offered and only role openings are claimed.
- Added `update_task` and `set_reviewer`. Added version and idempotency inputs to mutations that lacked them, and bound reviews to a submission number.
- Separated target features from true non-goals in Scope boundaries.

## Access and interoperability decisions, November 4, 2026

- Confirmed creator ownership, owner-appointed human admins, no ordinary-member/agent permission elevation, agent-owner connection/withdrawal control and separately delegated GitHub/deploy authority.
- Added [proposed enforcement and denial-test acceptance criteria](ACCESS-CONTROL.md), explicitly not implemented or run.
- Updated domain direction to `podster.dev`; Rust API stays private and service-only.
- Selected shadcn/ui Sidebar and consistent right-side Sheet details.
- Elevated A2A to a core product requirement with protocol/security interoperability gates.

## Changes on November 4, 2026

- Expanded the product from a link-based handoff to goal-based workrooms with input assets, work-role openings and versioned outputs.
- Defined invitation-only private participation and open-role claiming for public rooms, separate from authorization privileges.
- Added the lead coordinator, shared activity/personal inbox distinction and one identity with scoped workroom context.
- Added managed-repository and optional workroom-level Cloudflare release concepts, separating review, merge and deployment.
- Added MCP/Agent Auth connection wording and A2A direction with explicit interoperability work still required.
- Linked the current concept mockups and preserved the coordination kernel as a technical baseline, not the full revised product.

## Changes from the earlier draft (historical)

For reviewers of the first draft (`docs/MVP-SPEC.md`, in git history). These describe the November 3 kernel revision; the November 4 direction above supersedes its narrower product-scope exclusions:

- **Lifecycle simplified.** `created`/`assigned` became `open`/`offered`; `in_progress` dropped (progress is messages);
  `verified` and `completed` merged into one `verify_task` step. Added `release_task` so an assignee can give work back
  honestly instead of going silent.
- **Messaging decided:** task threads only (was an open question).
- **API surface decided:** capabilities over Agent Auth and hosted MCP; REST internal; A2A later (was an open question).
- **Approval decided:** cross-organization invitations need a person on both sides; agents can't invite or accept
  outside organizations.
- **Offline agents:** added an inbox with server-side cursor and an optional wake URL, replacing "poll the
  workspace event feed and keep your own cursor".
- **No self-sign-off** rule added; untrusted-content marking (`external: true`) specified.



