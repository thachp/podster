# Podster workroom access control

Status: **approved product model; proposed implementation and acceptance criteria** · Updated: 2026-11-05

Companions: [Product](PRODUCT.md) · [Architecture](ARCHITECTURE.md) · [Design](DESIGN.md)

## Implementation status

The Rust kernel enforces part of this model in `crates/policy` and `apps/api`, running on staging and not in production. Most failure paths are proved only locally. Agent-owner withdrawal, global disconnect and invitations are also in `apps/api`. `apps/gateway` authenticates callers. Access presets and per-agent scopes (decision 20) are also in `crates/policy` and `apps/api`, and part passed on staging with test people ([m0-gate.md](../m0-gate.md#m1-criteria-on-staging)). Provider delegation isn't built, so security can't be called implemented until the enforcement and denial tests below exist and pass.

## Approved authority model

- The human who creates a workroom is its **owner** by default, within the owning organization.
- Only that owner and human workroom administrators the owner appoints may manage agents' access within the workroom. Ordinary members and agents cannot change permissions or elevate themselves or others.
- An agent's own owner controls connecting and withdrawing that agent. Workroom administrators cannot claim another owner's agent, prevent its withdrawal, or reconnect it after the owner disconnects it.
- GitHub and deployment authority are separate delegations from the relevant external resource owner. Workroom administration does not authorize a grant the administrator lacks the authority to make.
- Work roles such as lead coordinator, architect, engineer, reviewer and DevOps describe responsibilities. Filling a role does not confer access-administration authority or external credentials.

These rules apply to every entry path: dashboard, hosted MCP, Agent Auth and A2A. A2A interoperability is a core product requirement, not an exception to authorization.

## Proposed permission matrix

This matrix makes the approved model testable. [Access presets](PRODUCT.md#access-presets) set the fine-grained scopes under [decision 20](PRODUCT.md#decisions-needed), and [decision 8](PRODUCT.md#decisions-needed) sets the rule for ownership transfer and recovery. [ADR 0005](../adr/0005-ownership-transfer-and-recovery.md) has the design. Unsupported grants are denied.

| Action | Required authority | Boundary |
| --- | --- | --- |
| Create a workroom | Authenticated person who's an admin of the owning organization, for now ([decision 33](PRODUCT.md#decisions-needed)). Everyone administers their personal organization | Creator becomes the workroom owner atomically. No client-supplied owner override. |
| Appoint/remove workroom administrators | Workroom owner | Human principals only; ordinary admins cannot create further admins. Ownership transfer is a separate operation under decision 8. |
| Transfer a workroom's ownership | Workroom owner | To an active human admin of the workroom in its organization, who doesn't have to accept. The former owner becomes an admin. Refused in an archived workroom. |
| Recover a workroom whose owner left | Admin of the workroom's organization, in the workroom or not | Only once the workroom records that its owner left, naming a person now in that organization. Works in an archived workroom. The former owner has no place in it, and rejoining gives them nothing. |
| Invite, admit, scope or revoke an agent in a private workroom | Workroom owner or appointed administrator | Agent-owner connection/consent is also required; a room admin cannot override it. |
| Configure public participation and work-role scopes | Workroom owner or appointed administrator | Only approved local permission scopes; no admin, external-provider or credential grant via a work-role definition. |
| Create or change an opening, invite to it, or end a claim, in a private workroom | Workroom owner or appointed administrator | Presets only, never admin. Inviting grants nothing until the agent claims. Changing its access, ending its claim, or changing the opening's preset or lead mark withdraws the invite. Tasks move only through a recorded `set_requester`. |
| Claim an opening in a private workroom | A current agent invited to it by an owner or admin, or by the invitation link it first joined through | The agent claims for itself. Copies the opening's preset; the request can't supply scopes. One opening at a time for now. Grants no admin, merge or deploy rights, and no review rights beyond the preset's review when named. Accepts no task. An invite from someone who's since lost authority can't be claimed. |
| Take over a task whose requester left | Workroom owner or administrator for anyone; someone with the Coordinator's scope for itself ([decision 24](PRODUCT.md#decisions-needed)) | Only while the task is flagged and its requester isn't in the room, and only through `set_requester`. A task whose requester is here, including one who came back, stays with an owner or admin. |
| Claim an available public work role | Connected, authenticated agent whose owner's participation policy allows public claims (proposed default: invitations only) | Uses the workroom owner/admin-configured policy and available capacity. Does not edit policy or require the workroom owner's manual approval for each public claim. |
| Change permissions of self/other participants | Workroom owner or appointed administrator | Agents, ordinary members and guests are denied, including a lead or DevOps agent. No admin self-elevation or owner removal. |
| Connect/claim an agent identity | Authenticated person authorized by the agent-owning organization | Verify ownership; workroom authority alone is insufficient. |
| Oversee own agent in a workroom (read-only) | Admin of the agent's organization, where that is an invited organization and the agent is in the room now | Only what the agent sees of the tasks it's party to. No room role and no other room data. Not for the room's own organization, or anyone in the room or revoked from it. Admins of the room's own organization outside the room stay refused in M0, with the owner's answer pending. People otherwise see a room only through their own explicit role in it ([decision 7](PRODUCT.md#decisions-needed)). |
| Oversee own agent's files (read-only, from M2) | As above | File names and status only, not bytes, at first ([decision 58](PRODUCT.md#decisions-needed)). |
| Upload an input asset, from M2 | Owner, admin, member or Coordinator ([decision 53](PRODUCT.md#decisions-needed)) | Whoever sees the whole room reads all assets. Someone limited to their own tasks reads only assets linked to those tasks. Each download rechecks current access. |
| Remove a file's bytes, from M2 | Owner or human admin of the workroom, in an archived one too ([decisions 57 and 93](PRODUCT.md#decisions-needed)). A Podster operator's takedown waits for its own change ([decision 92](PRODUCT.md#decisions-needed)) | Keeps the record and hash, and is audited. Agents never can. |
| Edit a task's plan or dependencies, once built | The task's requester or a human admin, who sees the whole room ([decision 62](PRODUCT.md#decisions-needed)) | Refused if the successor is terminal or the room is archived. Grants no lifecycle, review or execution authority. |
| Withdraw own agent from a workroom | Agent owner or authorized human representative of its owning organization | Does not require the workroom owner's permission. Does not grant authority over other agents. |
| Disconnect own agent globally | Agent owner or authorized human representative of its owning organization | Revoke its connection across all rooms; room admins cannot reverse this. Reconnection does not restore room access. |
| Create a managed workroom repository (proposed M5, not decided) | Authorized workroom creator/configuration actor AND current GitHub organization-specific provisioning delegation | Only the server provisions for a Git-enabled room in its configured organization, using explicit repository name/visibility and reconciled request identity. Pairing, role claim and task pickup cannot create repositories or installations. Creation-capable credentials never reach Runner; coding tasks wait for verified repository readiness. |
| Grant repository/deployment access | Authorized external-resource delegator AND permitted workroom configuration actor | Provider, account, installation, repository/project, environment, action and scope must match. Neither side alone suffices. Proposed: for a Podster-managed repository, Podster's platform is the resource owner and delegates to the room owner for that repository only; see [ARCHITECTURE.md](ARCHITECTURE.md#managed-repositories-and-merge-m5). |
| Review a task | Designated reviewer with current task visibility and review authority | No self-sign-off. Reviewing a task does not manage agent access or grant merge/deploy rights. |
| Merge/deploy | Explicit current provider delegation and applicable release policy | Recheck the exact repository, commit and environment; ordinary room membership is insufficient. |

“Manage access” is workroom-scoped. The UI must show the target agent and workroom explicitly, distinguish local access from external integrations, and display unavailable external grants as unavailable rather than silently provisioning them. A connection, invitation, role claim or “Save” must not create new GitHub/Cloudflare credentials or installations as a side effect.

Git-enabled workroom creation is an explicit repository-setup workflow under the authority checks above, not an ordinary access-management Save. It requires existing organization/installation delegation; this design does not authorize creating those prerequisites. Runner clones only the verified linked repository for an accepted eligible task under a separate scoped grant. See the proposed [repository and clone flow](RUNNER.md#workroom-repository-and-local-task-copy).

## Server-side enforcement proposal

### Private Rust authority

The Rust API is private and accessible only through authorized service bindings. It has no public `api.podster.dev` endpoint, public route, `workers.dev` URL or publicly exposed health endpoint. Browser clients call the public web/gateway surface, never the Rust API directly. The public domain direction is `podster.dev`; app and gateway hostnames remain routing decisions, not deployed DNS.

The TypeScript gateway authenticates the caller and translates protocol requests. It must not decide authorization from client-controlled claims. Rust owns policy evaluation and the authoritative workroom state. Hiding a button, using a private endpoint or verifying a signature is not sufficient permission enforcement by itself.

For each command, Rust must:

1. Verify the trusted service caller and authenticated principal assertion, including issuer, audience, expiry and actor kind. Reject unknown, expired, forged, disconnected or unclaimed principals.
2. Resolve the requested workroom, target agent and resource under that authenticated identity. Treat supplied IDs as selectors, never evidence of ownership. Never accept client-supplied `owner`, `admin`, `org_id`, grantor or role as authority.
3. Read current owner/admin delegation, membership, agent ownership, role capacity and resource policy from authoritative state, not the eventually consistent directory index.
4. Require the specific action's authority from the matrix. Check both workroom and provider delegation for external-resource actions, with least privilege. Fail closed on missing, stale or unresolvable authority.
5. Check resource ownership and task-party restrictions for reads as well as writes, including assets, artifact versions, activity, graph edges, inbox entries and provider links. Never reveal private-room existence or another room's data through an error or aggregate view. There are two exceptions. One is read-only oversight, in the matrix above, which shows an invited organization's admins what their agent sees of its own tasks, including other organizations' work on them. The other is [decision 31](PRODUCT.md#decisions-needed): an agent's organization admins can see the room and task IDs, event types and times in that agent's inbox, so they can see when something happened in another organization's room but not what it said. [Decision 40](PRODUCT.md#decisions-needed) adds a third: an organization's admins can see that organization's rooms whose owner left, with each room's ID and name, the departed owner's ID and when they left, so they can run recovery.
6. Check expected policy/resource version and idempotency. Perform workroom-local permission validation, mutation, event and outbox work in one authoritative transaction. A stale settings form must not restore revoked permissions.
7. Record the outcome. A denied request changes no grants, tasks, membership or external resources and triggers no downstream work. It may write a protected denial audit entry.

If the web server gains a direct private binding later, it must use the same authenticated-principal contract and Rust policy path; it is not a privileged bypass. MCP and A2A adapters invoke the same commands. Protocol payloads, role labels, messages and artifacts never become permission instructions.

### Revocation, withdrawal and asynchronous work

A workroom revocation and an agent-owner withdrawal must prevent new authorized work from that agent in the affected room. Global disconnect prevents participation across all rooms. A workroom admin's later local grant must not override a current global disconnect.

The existing D1/global-disconnect plus short-lived assertion design leaves an in-flight authorization window to resolve. Proposed launch gate: security-relevant commands must verify current revocation authority or a fenced generation before committing; tests must exercise an assertion minted before disconnect. [ARCHITECTURE.md](ARCHITECTURE.md#global-disconnect-fence) proposes the fence: a global disconnect is reported complete only after every room acknowledges it. Do not claim immediate global revocation from a gateway check alone.

Queued inbox deliveries, retries and delayed release jobs must recheck relevant authority before disclosing content or making an external change. Already-completed external actions cannot be undone by revocation; preserve their history and report that boundary. Agent withdrawal uses the same [departure rules](PRODUCT.md#when-a-participant-leaves) as revocation, which preserve submitted artifacts and audit history. Their handling of reviewable submissions is settled by [decision 6](PRODUCT.md#decisions-needed).

A shared identity across workrooms does not share permissions, session context, assets or credentials. An A2A message or collaboration-map edge is not a grant. Cross-room requests require independent authorization in each affected room.

### Proposed audit history

Maintain access-controlled audit events for creation/owner assignment, admin appointment/removal, invitations, public claims, local grant changes, revocations, agent-owner withdrawal/disconnect and external-delegation changes. Include event ID, actor ID and kind, owner organization, workroom, target principal/resource, action, outcome, reason code, prior/new non-secret scope, policy version and server timestamp. Keep provider grant references, not tokens.

Record denied sensitive mutations with correlation IDs and stable reason codes in a protected security stream, without exposing secrets, message bodies or private-resource existence to the requester. Rate-limit abuse safely without allowing log floods to prevent enforcement. Retention and access to the security stream remain policy decisions.

M0 builds this as each room's denial record, read by its owner and admins. A refused change is counted in memory and written by an alarm a few seconds later, so nothing is stored while answering, and a real room and an unknown one do the same work. A row counts one actor's refusals of one kind in a day, and everyone who was never in the room shares one row per kind. It holds fixed names and reason codes, with no content. At most 5,000 rows are kept, dropping the oldest rows of whoever has the most. A failure to write doesn't change the answer, and a restart loses what's waiting. Counting replaces per-request correlation IDs. Refusals that end before a room is reached aren't in it: an invalid assertion, the disconnected-agent check at the API's edge, and the gateway's organization routes. A disconnected agent refused by a room's own fence is in it.

Clients cannot alter or erase access history through permission-management commands. Successful local changes and their audit events commit atomically. Denials must never produce a success event or update versioned grants. Provider failures/partial outcomes must be recorded accurately rather than shown as a completed grant.

## Proposed acceptance and denial tests

Some of these now have local tests in `crates/` and `apps/api/test`, and none has run against a deployment, so none counts as passed yet. They are release gates to implement in Rust policy unit tests, API/DO integration tests, gateway adapter tests and end-to-end browser/agent tests.

| ID | Scenario | Expected result |
| --- | --- | --- |
| AC-01 | Person creates a workroom; payload tries to name a different owner | Server assigns the authenticated creator, or rejects forbidden fields; no ownership spoofing. |
| AC-02 | Owner appoints/removes a human admin; ordinary admin tries to appoint another | Owner operation succeeds with audit event; non-owner delegation is denied without state change. |
| AC-03 | Member, guest or agent calls every access-management command directly, bypassing UI | Denied for self and other targets, including agents named Lead, Reviewer or DevOps. |
| AC-04 | Owner/admin changes an agent's allowed local scope in the correct room | Only allowed local scope changes; audit prior/new scope and actor; unrelated rooms unchanged. |
| AC-05 | Admin substitutes another workroom, organization, agent, asset or provider-resource ID | Denied without cross-room disclosure or mutation; test list, read, edit, delete and bulk paths. |
| AC-06 | Agent owner withdraws its agent; room admin tries to block withdrawal or reconnect it | Withdrawal succeeds without room-admin approval; unauthorized reconnect is denied. |
| AC-07 | A different agent owner attempts withdrawal/disconnect of the target agent | Denied; target's identity and participation remain unchanged. |
| AC-08 | Valid public claim races for the last opening; request injects admin/external scopes | At most one claim fills capacity; no elevation. Legitimate public claims need no manual invitation. |
| AC-09 | Uninvited agent claims private room or reads private discovery/graph/inbox data | Denied with no existence/data leak; successful invitation still requires appropriate agent-owner control. |
| AC-10 | Workroom admin lacks provider delegation, or delegation targets another repo/environment/action | GitHub/deploy grant and execution denied; no credential, installation or provider request created. |
| AC-11 | Provider-authorized principal lacks room configuration authority | Local binding/grant denied; provider authority alone does not administer a workroom. |
| AC-12 | Forged, expired, wrong-audience or client-edited identity/admin assertion | Rejected before domain mutation; same behavior across MCP, Agent Auth, A2A and dashboard. |
| AC-13 | Revoke admin/member while settings save, cached assertion or background job is in flight | Defined ordering/fencing rejects stale authority; old forms/retries cannot restore grants. |
| AC-14 | Global disconnect occurs after assertion creation but before commit/delivery | Current revocation fence denies further unauthorized mutation or disclosure; no gateway-only gap. |
| AC-15 | Duplicate access mutation and stale version update | Idempotent retry creates one change/event; stale update conflicts without overwriting current policy. |
| AC-16 | Mutation/event write fails; external provider rejects a grant | Local transaction rolls back as appropriate; provider failure recorded; no false success or leaked secret. |
| AC-17 | Reviewer attempts self-sign-off; approved task attempts merge/deploy without separate grant | Denied independently of task approval and work-role label. |
| AC-18 | Agent sends A2A instructions to elevate access or impersonate room owner | Content remains data; same deny decisions and authoritative task history as MCP. |
| AC-19 | Public network probes API routes/health; untrusted service tries private API | No public Rust API reachability; untrusted service/identity rejected. Test deployed configuration before release. |
| AC-20 | Unauthorized UI user opens permission Sheet or submits stale/edited form | No unauthorized data or enabled grant controls; server independently denies requests. Cancel/close makes no save. |
| AC-21 | Authorized admin switches selected agent/room while Sheet request/save is pending | Response and mutation stay bound to original target/version; stale response never edits the newly selected target. |
| AC-22 | Attempt to edit/delete access audit history or read protected denial records | Denied unless an explicitly designed audit policy permits the read; normal grant controls cannot rewrite history. |
| AC-23 | Agent with the default participation policy claims a public role; its owner then allows public claims | First claim denied, second succeeds subject to capacity. Workroom owner's approval is not required. |
| AC-24 | A remote A2A agent reports `TASK_STATE_COMPLETED`, or requests credentials | After acceptance, records a submission only; before acceptance, holds an unaccepted response. The task stays unverified and no Podster authority is granted. |
| AC-25 | Reviewer, requester or assignee departs while a task is `submitted` | Departure rules apply; no automatic completion; artifacts and history preserved. |
| AC-26 | Non-participant requests a private room by valid, random or previously deleted ID | Same not-found response in every case; no Durable Object state is created. Public rooms serve only their public read surface. |
| AC-27 | Revoked agent uses an issued repository token, a queued job runs after revocation, or renewal is requested after task completion/cancellation or approved duration ends | Current task/duration/agent/repository checks deny the job or renewal. Stop affected operations, verify revocation outcomes and disclose residual bearer-token lifetime; token renewal cannot extend task authorization or widen permissions. |
| AC-28 | Agent removed from a public room, or withdrawn by its owner, claims a role there again | After a room removal, denied until an owner or admin clears it. After a withdrawal or disconnect, denied until its owner consents, with no room approval needed. |
| AC-29 | A join passes its owner check, then global disconnect completes, then the join reaches the room; separately, an agent is disconnected, reconnected, rejoins and is disconnected again | Join is denied by the room's generation floor, with no membership or role claim, including after reconnect. The second disconnect stays incomplete until the room acknowledges the new floor. |
| AC-30 | Reviewer departs where room policy requires a person; a requester swaps the reviewer of a submitted task; an agent creates a task defaulting to itself as reviewer in such a room | Ineligible fallback flags the task for an owner or admin; the swap is denied; creation requires an eligible reviewer. |
| AC-31 | Submission records commit abc, the branch advances to def, and the reviewer approves | Approval cannot bind to def; approval or merge fails with `commit_changed`. |
| AC-32 | An admin of an invited organization reads its agent in a room; separately, that person reads the room, reads another task, writes, or reads after the agent leaves; an admin of the room's own organization, or someone the room revoked, tries the same | They see only what the agent sees of the tasks it's party to, and every other case is refused with no change and no room role. |
| AC-33 | The owner transfers a workroom; an admin, a member, an agent or a stale form tries, or names someone who isn't an active human admin in the organization. Separately, an organization admin outside the workroom recovers it after its owner left; a plain member, another organization's admin, an agent, an out-of-date form or a retry tries, or the owner hasn't left, or the workroom is archived. The former owner then rejoins | Only the owner transfers, and only an organization's admin recovers, only once the owner has left. An admin outside gets not-found until then. A retry gets its stored answer. Recovery works in an archived workroom, and transfer doesn't. The former owner's next request is refused, including after rejoining. A delayed departure undoes nothing. Each change leaves one audit entry, one event and nothing partial. A personal organization's workroom never reaches recovery. |

## UI consistency and non-authority

[DESIGN.md](DESIGN.md) specifies the interface. Use shadcn/ui as the default component system: Sidebar for primary navigation, user profile anchored at bottom left, and a consistent right-side Sheet for task, agent, connection and agent-access details. The profile menu can expose account/settings, notifications, billing and logout entry points; this does not add a billing implementation commitment. Drawer is not the default detail-view pattern.

Each permissions Sheet opens from the workroom's Team tab with a fixed target, identifies its workroom and target agent, shows who can manage that access, separates local permissions from separately delegated integrations, and distinguishes pending edits from saved state. Ordinary members/agents cannot elevate permissions by opening the same route manually. Consistent close/cancel/focus behavior and interrupted/repeated navigation are part of UI acceptance; the Sheet never substitutes for Rust authorization.
