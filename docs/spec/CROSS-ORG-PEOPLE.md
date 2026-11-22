# Inviting a person from another organization

Status: **Proposed** by the architect on 2026-11-22, not approved, and nothing here is built. On 2026-11-22 the owner said yes to the idea of a room's owner inviting a *person* from another organization into a workroom. That yes is the only settled part; this document is what the owner approves before a build starts. Companions: [Product](PRODUCT.md#invitations-private-workrooms) · [Access control](ACCESS-CONTROL.md) · [Architecture](ARCHITECTURE.md#invitations-across-organizations) · [Design](DESIGN.md#team-and-manage-access-sheet)

## Why

Issue 521 and PR 524 found that a workroom invitation brings in agents only. `acceptInvitation` writes a `member` row for each chosen agent and none for the person accepting. A person gets a role only through `addMember`, and only if the gateway's directory places them in the room's own organization; anyone else is refused `invitation_required`. So Long's agent joined the demo room and Long didn't, and `/w/<id>` correctly answered `workspace_not_found`. Today the only route is to join the room's organization first, and a room in a personal organization can't take another person at all.

## What already fits

Most of the model is already in the code, which is why this stays small:

- **A member row can name any organization.** `member(principal_id, kind, org_id, role, …)` in the `Workspace` DO stores the organization a participant holds their place through. `resolve_caller` already checks that the caller is in that organization now (`in_org`) and that their membership there began before the row was written (`org_since`). Nothing in it assumes the room's own organization; only `handle_add_member` does.
- **One gap: "never admin" isn't enforced today.** `handle_change_role` lets the owner make any current person row `admin` without checking that its `org_id` is the room's organization. It's harmless now, because only `handle_add_member` writes person rows and it requires that organization. It stops being harmless once an outside person has a row, so the build closes it first (step 3, AC-36).
- **Person and agent rows are independent.** PR 524's `person-and-agent.spec.ts` proves an agent's row gives its person nothing, and removing the agent leaves the person's role alone.
- **Oversight lists agents only.** `list_oversight_rooms` filters `membership_index` to `agt_` IDs, so an organization's admins never learn a room from a person's row.
- **Invitations already expire, end with their creator's authority, and are barred by an organization's revocation** (`INVITATION_TTL_MS`, `end_invitations_of`, `barred_by_revocation`).

## The design

### Who invites

The workroom's **owner or an appointed admin**, as a person: the same `ManageAccess` authority that invites an organization's agents today. Never a member, a guest or an agent, whatever role an agent has stored. A pending invitation ends when its creator stops being owner or admin, as agent invitations do.

### How it's addressed

To **one email address**. The inviter types it, chooses the role, and gets a link to send out-of-band, as with organization invitations. Podster doesn't email it in this proposal. Cloudflare Email Service already sends sign-in links ([ADR 0004](../adr/0004-email-sign-in.md)); mailing invitations from it is a later step with its own sender, and a cloud change that is the owner's. The link carries a token, `inv_<room>.<id>.<secret>`, stored only as a hash, as today.

The address binds the invitation. Only a signed-in person whose **verified** sign-in email matches it, compared case-insensitively, can accept. A forwarded link does nothing for anyone else. "Verified" means Better Auth's `user` row has `emailVerified = 1` at the time of the request. The gateway sends the email only then. Sign-up refusing unverified emails isn't enough, because unverified rows exist: test people, password sign-in where a deployment enables it, and rows from before that rule. Test people (`isTestEmail`) are sent with their email only in builds and deployments that already admit test people, the same switch that admits them now, so a test run can invite one; staging's two-person run uses real accounts. Creating an invitation answers the same whether or not the address has a Podster account, so it can't be used to probe for accounts.

### What the invitee needs

A Podster account (any sign-in) with that verified email. Everyone has a personal organization, so no team organization is needed. Someone without an account signs up through the link first.

### How it's accepted

The invitee opens the link, signs in, sees the room's name, the inviter's name, the role and the expiry, and picks **which of their organizations they join as**, their personal one by default. It must be an organization they belong to now, and **not the room's own organization**: that is refused, because people of the room's organization are added directly as today. That organization is stored as the row's `org_id`. It's a label and an anchor, not a grant: the organization gets no authority in the room, and its admins don't see the room. Accepting adds the person only, never their agents, and is idempotent the way agent acceptance is (`accepted_request`, `accepted_response`).

An invitation is one person, one use, 7 days, withdrawable until accepted.

### Role

A kernel role, as people have today; presets stay for agents.

- **Guest** by default: their own tasks and their threads; creating tasks only with the invitation's switch on ([decision 14](PRODUCT.md#decisions-needed)).
- **Member** only as an explicit choice on the invitation, matching "Granting `member` to an outside organization is an explicit choice".
- **Never admin or owner.** `admin` stays limited to the room's organization. Transfer and recovery already require it; `handle_change_role` will too (see [What already fits](#what-already-fits)).

A guest or member person may be named reviewer under the existing rules, and their review counts as a person's review ([decision 5](PRODUCT.md#decisions-needed)). Decision 195's self-review rule is unchanged: it compares controlling persons, so their approval of their own agent's work still can't be merged.

### What they can never do

Already denied by role, and kept denied by tests:

- Manage access, appoint admins, invite anyone, configure public participation or openings, rename or archive the room, read the audit or denial log.
- See any other room, of the host organization or anyone else, or the host organization's agents beyond what their role shows in this room. No oversight of the host's agents.
- Act for any agent. A person's role never lets them act as, withdraw, scope or disconnect an agent they don't own.
- **GitHub and repositories: none.** No repository grant (`grant_required`), no `get_repo_access`, no merge, including a self-reviewed merge, which needs a grant. No Builds runs, until [BUILDS.md's open question 3](BUILDS.md#open-questions) is answered.
- **Releases and deploys: none.** They can't ask for, approve or stop a release, or delete an app's data.

### Grants stay separate

A person's row and their agents' rows are separate rows with separate grants:

- Inviting a person adds no agent. Inviting an organization's agents adds no person (unchanged).
- Removing, revoking or narrowing one never changes the other.
- An agent's membership gives its owner nothing, and a person's gives their agents nothing. Their agents join only through an agent invitation their organization's admin accepts.

### Leaving and removal

Each path writes `member.revoked` with a reason and runs the [departure rules](PRODUCT.md#when-a-participant-leaves) on their open tasks:

| Who ends it | How | Reason | Coming back |
| --- | --- | --- | --- |
| The room's owner or admin | The existing remove on the Team tab | `room_removed` | A new person invitation from the owner or an admin. That invitation is itself the room's decision, so no separate clear-removal is needed. Accepting it may not change the revoked row's `kind` or `org_id` unless the invitation was made by the owner; one made by an admin, accepted as a different organization than the row holds, is refused `not_allowed`. That keeps correcting a revoked participant's identity the owner's alone, as `handle_add_member` reserves it today (`AppointAdmin`) |
| The person | New: **Leave workroom** | `person_left` | A new invitation |
| Their organization | Removing them from the organization they joined as | `org_departure`, through the existing organization-departure path (`org_departure` in the `Workspace` DO); `resolve_caller` refuses them at once regardless | A new invitation. Rejoining the organization restores nothing, as today |
| The room revokes their organization | The existing revoke-organization route | As today | A new invitation made after the revocation |

A person who is also their organization's admin keeps today's oversight rule unchanged: anyone with a row, current or revoked, sees the room only through their own place in it, never through oversight. So oversight of their organization's agents in that room **never comes back** after they leave, whether by their own choice, `org_departure`, the room's removal or a revoked organization. Letting a voluntary leave restore it would let someone leave just before a removal to keep a view the room meant to end. Accepting a person invitation therefore costs an organization admin their oversight in that room, and the accept page says so.

### Residual risk: the email itself

The binding is only as good as the account's email. A GitHub-sourced email is GitHub's at sign-in time: if the person later loses that address, or an employer reassigns it, the Podster account still carries it as verified, and whoever now holds the address can't accept, while the old holder still can. Podster doesn't recheck an email with its provider. The inviter should send the link to someone they know, and the 7-day expiry and one use bound the exposure. This isn't closed by the design.

### Expiry and limits

- Unaccepted invitations expire after 7 days, as all invitations do, and their address is erased when they end (accepted, withdrawn, expired or ended with their creator's authority).
- At most **20 pending person invitations** per room, and **20 created per room per day**. A person counts toward the room's existing 50 members (`MAX_MEMBERS`).
- One pending invitation per address per room; making another replaces it.

### Audit, events and notifications

ID-only, as everywhere. No email address appears in an event, an audit entry, a log line or the inbox.

- Audit: `invitation.created` (with `invitee_kind: person`, role, switch; never the address), `invitation.withdrawn`, `invitation.accept`, `member.added` (kind `person`, `org_id`), `member.revoked` (reason as above), `member.role_changed`.
- The invitee's inbox gets an event when they're added, so the room shows in **Needs attention** and the room list. The inviter gets one when it's accepted.
- The address is stored on the pending invitation row only, so the owner and admins can see who was invited. It's never returned to anyone else.

### Private and public rooms

Both. In a private room this is the second invitation path. In a public room it's the only way a person joins, since only agents claim public openings ([decision 159](PRODUCT.md#decisions-needed)); the invited person sees the room as a participant with their role, not through the public read surface.

### Authority

Rust decides, from current `Workspace` DO state, in one transaction: policy, then the change, the audit entry, the event, the outbox and the idempotency record. The gateway only authenticates. On the accept and preview routes only, it adds the signed-in person's **verified email** to the assertion as a fact from its own rows, the way `target_member` is added for member routes; the DO compares it with the invitation and decides. Nothing from the request body names the invitee, their email or their role. The invitee's chosen organization is checked against the assertion's `orgs`.

## What changes in the specs

On approval, in the same PR as the build's first step:

- **Decision 7** gains one sentence: a person from another organization may hold their own explicit role in a room through a person invitation they accepted. The rule itself, that people see a room only through their own role, is unchanged.
- **PRODUCT.md:** the [Invitations](PRODUCT.md#invitations-private-workrooms) list gets a **Person from another organization** bullet; the [Authorization roles](PRODUCT.md#authorization-roles-kernel-baseline) bullet on outside members covers people; [decision 239](PRODUCT.md#decisions-needed) records the open questions' answers.
- **ACCESS-CONTROL.md:** two matrix rows (**Invite a person from another organization**, **Leave a workroom**), and new tests AC-34 to AC-37 below.
- **ARCHITECTURE.md:** [Invitations across organizations](ARCHITECTURE.md#invitations-across-organizations) gets a person flow; the `Workspace` DO's `invitation` table gets its new columns.
- **DESIGN.md:** the [Team](DESIGN.md#team-and-manage-access-sheet) section gets **Invite a person** and an **External** label on outside people; the accept page gets the organization picker; the room gets **Leave workroom**. PR 524's copy, "an invitation brings in agents only", changes to name the two kinds.

### Proposed tests

| ID | Scenario | Expected result |
| --- | --- | --- |
| AC-34 | A member, guest, agent or outside person creates a person invitation; an owner or admin does | Only owner and admin succeed; others `not_allowed` with no row written |
| AC-35 | Someone whose verified email differs, or whose email is unverified, previews or accepts; a forwarded link; a second accept; an expired, withdrawn or creator-demoted invitation; acceptance as the room's own organization; an admin's re-invitation accepted as a different organization than a revoked row holds | Only the addressed, verified person, once. Preview refuses a mismatch before revealing the room's name or inviter. Mismatch, expiry, withdrawal and reuse are the same `invitation_not_found`; the room's own organization is `invalid_argument`; the identity change is `not_allowed` |
| AC-36 | An outside person tries every access, repository, release, audit and room-management command, and opens another room of the host organization; the owner changes an outside person's role to `admin` | All refused; the other room is `workspace_not_found`; the role change is refused and the row stays as it was |
| AC-37 | The person leaves; the room removes them; their organization removes them; the room revokes their organization; separately their agent is removed | Each ends only the person's row and runs the departure rules; the agent's and person's rows never change each other |

## What a build needs

Named, not written:

- **Contracts** (`packages/contracts/openapi.yaml`): `POST /v1/workspaces/{ws}/invitations` takes `invitee: { kind: "person", email }`; `GET` lists person invitations with their address for owner and admins; `POST /v1/invitations/preview` and `/accept` answer and take a person invitation (`org_id`, no `agents`); new `POST /v1/workspaces/{ws}/leave`. `capabilities.yaml`: no change, because agents can't call any of it.
- **Assertion** (`crates/assertion`, `apps/gateway/src/assertion.ts`): an optional verified email, sent only on the two invitation routes.
- **Workspace DO migration** (appended to `store.rs`'s `MIGRATIONS`): `invitation.invitee_kind` (default `organization`) and `invitation.invitee_email` (nullable, erased when it ends). `member` is unchanged.
- **D1 migrations:** none. `membership_index` already lists a person's rooms by `principal_id`.
- **`handle_change_role`:** refuse `admin` for a person row whose `org_id` isn't the room's organization. Small, and it lands first, before any outside person can hold a row.
- **`crates/policy`:** a `LeaveRoom` action any current participant may take, and an explicit person-invitation rule that refuses `admin`. `crates/core`: no change.

## Build plan

1. Merge this proposal with the owner's answers; record a decision row and amend decision 7.
2. Contract PR: openapi changes and the assertion field. Merges alone, in turn.
3. API: first the `handle_change_role` organization check with its AC-36 case; then the DO migration, person invitation create, list, preview, accept and leave, with AC-34 to AC-37 in `apps/api/test`.
4. Gateway: the verified-email fact on the two routes, sent only when `emailVerified = 1`, with gateway tests for an unverified row and a test person.
5. Web: Invite a person, External label, accept page organization picker, Leave workroom; PR 524's copy updated.
6. Deploy to staging and run it with the owner and Long: invite Long by email into the demo room, accept as a guest, see the room listed and open, then leave.

## The architect's rulings, for the owner to review

Settled by the architect on 2026-11-22 on review of this proposal. They stand unless the owner overrules them:

- **The room's own organization can't be chosen** at acceptance. People of that organization are added directly, as today.
- **A re-invitation can't change a revoked row's identity** (`kind`, `org_id`) unless the owner made it, as `handle_add_member` reserves that to the owner today.
- **Oversight never comes back** to an organization admin who held a person row in the room, however they left, so leaving before a removal gains nothing.

## Open questions for the owner

| # | Question | Recommendation |
| --- | --- | --- |
| 1 | Who may invite a person: the owner only, or the owner and appointed admins? | **Owner and admins**, the same authority that already invites a whole organization's agents as members. Owner only would be stricter than today's agent path for no clear gain |
| 2 | How is the invitation addressed: email-bound, an open one-use link, or an existing account? | **Email-bound link**, accepted only by a verified matching sign-in. An open link can be forwarded; addressing by account needs a directory lookup that would reveal who has one |
| 3 | What roles can an outside person get? | **Guest by default, Member by explicit choice, never admin**, matching how outside organizations are invited |
| 4 | Which organization does the person join as? | **Their choice among their current organizations other than the room's, personal by default.** It's a label and an anchor for departure, with no authority |
| 5 | Should outside people see Builds runs on their own task's branch? | **No**, until BUILDS.md's open question 3 is answered for guests generally |
