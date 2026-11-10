# M5 plan

**Status, 2026-11-09 UTC: Proposed. Nothing here is approved or built.** The architect drafted this plan from the specs. Its [questions](#questions-for-the-architect) carry the architect's proposed answers, which aren't recorded as decisions in `PRODUCT.md` yet. Items marked **owner's yes** create an account or a cloud resource, cost money, set a secret, or are legal text, so the architect can't settle them alone. No ADR exists for M5 yet; step 1 writes it.

It covers [M5 Managed repositories](spec/PRODUCT.md#product-direction-and-delivery-scope): a GitHub App, a repository linked to a room, review bound to a commit, and merge. Its gate is [expanded criterion 7](spec/PRODUCT.md#expanded-workroom-acceptance-criteria) for repositories. It starts from the [managed repositories design](spec/ARCHITECTURE.md#managed-repositories-and-merge-m5), which is itself proposed, and from decisions 10, 18 and 25, which are proposals too. Decision 10 leaves agent access to the M5 ADR.

M5 is the first time Podster holds authority over something outside itself and hands part of it to agents. So the plan proves on GitHub what a token can and can't do before any feature code.

## Where M3 and M4 stand

M5 starts while two earlier gates are still open. Neither blocks M5's planning or its spike, and `PRODUCT.md` already says M5 can ship later for engineering rooms.

- **M3's gate** isn't called. It still waits on the owner's approval of fasta2a and the compatibility kit.
- **M4's gate** isn't called. Step 14's code is merged and on staging at `17563d1`, and `EXPLORE_CURSOR_KEY` is set. The staging run hasn't happened. On 2026-11-10 the owner had `PUBLIC_ROOMS` switched on for staging; the test operator isn't in `OPERATORS` yet, and the takedown contact is a placeholder.

Contract and migration PRs still merge one at a time, so M5's step 2 waits for any M3 or M4 PR that changes them.

## What M5 includes

- **A repository per Git-enabled room:** when an authorized person sets up a room that needs Git, Podster's server creates a repository in a dedicated Podster-managed GitHub organization and links it to that room. Rooms that don't need Git get none.
- **Repository visibility of its own:** private unless the person setting up the room chooses otherwise. It doesn't follow the room's visibility.
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
- **The token boundary, proven on GitHub:** a token from `get_repo_access` can't merge to the default branch, can't reach another repository, and can't administer the repository. This is the spike's question, and the gate needs it shown again on staging.
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
| 1 | **ADR 0009 and the spike.** The ADR settles everything the architecture leaves "open for the ADR". The spike runs against a test organization and answers the [risks](#risks-to-test). | Needs the owner first: see [what needs the owner's yes](#what-needs-the-owners-yes). The spike's code stays in `spikes/` and nothing builds on it. |
| 2 | **Contracts and migration:** `repo_link`, `provider_grant`, `task_change` and a provisioning request, with `get_repo_access`, `get_task_release_status` and `merge_task` in `capabilities.yaml` and their routes in `openapi.yaml`. The room's Durable Object owns all four as state, because grants are authority. D1 gets at most a projection for lists, which never authorizes. | One contract and migration PR at a time. |
| 3 | **Decisions in `crates/core` and `crates/policy`:** grant checks, `commit_sha` required on `submit_task` and `verify_task` for a linked task, `commit_changed`, and merge as its own state. Pure, with no I/O. | AC-31 is decided here, and AC-17's rule that approval alone never merges. |
| 4 | **Provisioning:** room setup records a request; a job creates the repository, sets its protections and records the verified repository ID. Pending, ready, failed and uncertain states, with reconciliation before any retry. | A failed setup blocks coding tasks in that room, not other work. |
| 5 | **Webhooks:** the gateway verifies GitHub's signature and passes a normalized observation to the room's Durable Object, which records it with its observation time. A job polls when state looks stale. | A new public route on the gateway. It authenticates the sender and decides nothing. |
| 6 | **`get_repo_access`:** the private Rust API mints a token for one repository after rechecking the task and its run, the fixed deadline and budget, the agent's assignment and connection, room access, the exact repository and installation, the grant and the provider permissions. Renewal runs the same checks. | Tokens never reach events, logs or the gateway's storage. AC-27. |
| 7 | **`merge_task`:** the job rechecks authority, merges with the reviewed commit's `sha`, and records success or failure. A changed commit leads to a follow-up task, as decision 25 proposes. | Depends on the spike's answer about the merge boundary. |
| 8 | **`get_task_release_status`:** checks and merge state, each with its own observation time. | Reports that no release exists; M6 adds releases. |
| 9 | **Screens**, in two PRs: (a) the Git option in room setup and the repository's state; (b) grants in Manage access and a task's change and merge state. | Unavailable grants show as unavailable, never silently provisioned. |
| 10 | **Staging run and security review,** then the gate call. | A script against staging with test people and a test organization. |

Steps 3, 5 and 9(a) can run side by side after step 2. Steps 4 to 7 are security-sensitive: a provisioning credential, a new public route, token issuing and merge. Each gets the deeper review the owner has already agreed for security-sensitive steps; anything deeper than that is asked first.

## What needs the owner's yes

- **A GitHub organization for managed repositories,** and a second one for tests. Creating an account is the owner's. Its ownership and legal terms are open, and may need a lawyer.
- **The GitHub Apps:** one that provisions and issues agent tokens, and a separate merge App if the spike confirms the split. The owner creates and installs them, or approves the architect doing it in a named session.
- **Secrets:** each App's private key and the webhook secret. The owner sets them with `wrangler secret put`; the architect gives the exact command.
- **Money:** a GitHub plan, if private repositories need one for branch rules. See [cloud resources](#cloud-resources).
- **Any looser alternative** in the questions below.
- **Each deeper security pass** beyond the ones already agreed for security-sensitive steps.
- **The gate call's review,** and anything in production.

## Cloud resources

**The proposal needs resources outside Cloudflare, which no earlier milestone did.**

- **GitHub:** two organizations and up to two Apps, as above. **Possibly billed.** GitHub's free plan for organizations is believed to offer branch protection and rulesets on public repositories only, so private managed repositories with protected branches would need a paid plan, charged per seat. This isn't verified; the spike checks it on the test organization before anything is bought.
- **Cloudflare:** no new billed resource is proposed. Step 2 adds Durable Object state through the room's own forward-only migrations, and at most a projection table in the API's existing D1 database. Step 5 adds a route to the existing gateway Worker. Provisioning and merge jobs use the existing outbox; a dedicated queue is only proposed if the spike shows the outbox can't carry them, and that would need the owner's yes.
- **Secrets:** each App's private key on the private API Worker only, and the webhook secret on the gateway. The owner sets them.

## Acceptance tests

**Proposed.** Each runs from a script against staging, with test people and the test organization. The owner won't run checks by hand, so a check that can't run that way is recorded as a gap.

| Test | What it shows |
| --- | --- |
| M5-01 | Setting up a Git-enabled room creates one repository in the configured organization, with the chosen name and visibility, and the room records GitHub's repository ID. A room without Git creates none. |
| M5-02 | A repository's visibility is what was chosen at setup, whatever the room's visibility is. |
| M5-03 | A timeout during creation leaves the request uncertain. Reconciliation finds the repository by its recorded identity, never by a matching name, and no second repository is made. |
| M5-04 | A client-supplied organization or installation is ignored or refused. |
| M5-05 | `get_repo_access` without a grant is denied and no token is requested from GitHub. |
| M5-06 | A token from `get_repo_access` can push a task branch and open a pull request, and can't merge to the default branch, reach another repository, change settings, add or change a workflow, or set the required status. |
| M5-07 | After the agent is revoked, the task ends or the deadline passes, renewal is denied. What the already-issued token can still do, and for how long, is measured and written down. |
| M5-08 | A submission records its commit. After the branch advances, approval fails with `commit_changed`. |
| M5-09 | `merge_task` merges the reviewed commit. With a changed head it records `merge.failed` with `commit_changed`, and the task stays completed. |
| M5-10 | An approved task without a separate merge grant can't be merged, and a reviewer can't merge their own work. |
| M5-11 | A webhook with a bad signature is refused. A lost webhook is repaired by polling. |
| M5-12 | Checks and merge are reported separately, each with its time, including a failed check and a failed merge. |
| M5-13 | Logs from every Worker during the run hold IDs and reason codes only: no token, no repository content. |
| M5-14 | Setting up a Git-enabled room without the organization's provisioning delegation is denied, and no request reaches GitHub (AC-10). |
| M5-15 | A failed setup blocks coding tasks in that room and nothing else. It never falls back to another organization and never deletes a repository. |
| M5-16 | A replayed webhook delivery, or one naming a repository other than the room's linked one, changes nothing. |

## Threat model

**Draft, to be walked against the built system at step 10.**

| Threat | Proposed mitigation |
| --- | --- |
| An agent merges unreviewed code with its push token | A required status on the default branch that only the merge App can set, for the exact reviewed commit. Unverified until the spike. |
| A token is used after its authority ends | One-hour tokens (GitHub's lifetime, unverified), every issuance rechecked, revocation attempted on the events that end authority, and the residual lifetime disclosed. |
| A token reaches a log, an event or another agent | Minted and returned by the private Rust API only; never stored; the log check in M5-13. |
| A client steers provisioning to another organization | Organization and installation come from trusted configuration only. |
| A repository with a matching name is adopted | Ownership is the recorded GitHub repository ID, never a name. |
| A forged or replayed webhook changes state | Signature check at the gateway, and each delivery ID accepted once. Rust checks the observed repository ID against the room's link. Observations are records, and GitHub stays the source of truth for merge and checks. |
| An agent pushes a workflow that runs with the repository's own token and merges or sets the required status | The agent's token can't write workflows, and Actions are off or restricted in the managed organization until the spike shows a safe setting. Unverified. |
| A public repository publishes agent content under Podster's organization | Private by default and an explicit choice at setup. Takedown for public repositories, and pull requests from forks, are open for the ADR; until it settles them, public repositories stay unavailable. |
| A room admin grants access they don't hold | Policy checks the granter's delegation for that repository and action (AC-10, AC-11). |
| A stale job acts after revocation | Each job rechecks current authority before its external call (AC-13, AC-27). |
| Repository content is treated as instructions | Agent content is data. Podster stores commit IDs, check names and states, not content. |
| The managed organization is compromised or its App key leaks | Least permissions per App, the split between provisioning and merge, and a rotation procedure. Owed in the ADR. |

## Questions for the architect

**Proposed answers by the architect. None is recorded as a decision yet.** "Owner's yes" marks an alternative that costs money, loosens the stance or creates an account.

| # | Question | Proposed | Alternative |
| --- | --- | --- | --- |
| 1 | Which repositories does M5 manage? | Only ones the server creates in the dedicated organization. | Linking an existing repository under its real owner's delegation. Later, with its own design. |
| 2 | One App or two? | Two: one provisions and issues agent tokens, one merges. Confirmed or dropped by the spike. | One App with branch rules alone. Owner's yes, because a push token may then merge. |
| 3 | Default repository visibility | Private, chosen explicitly at setup. | Following the room's visibility. Not proposed. |
| 4 | Who can merge? | A person or agent with an explicit merge grant on that repository, and only after approval. Never the submitter, which is a new rule beyond AC-17. | Any approver. Owner's yes. |
| 5 | Token lifetime and renewal | One hour, renewed on demand with a full recheck and no fresh approval, as the architecture proposes. | Shorter tokens through a broker. Decided with M7. |
| 6 | Merge method | Squash, so the merged commit maps to one reviewed submission. | Merge commits. |
| 7 | How commits attribute an agent | The App authors the merge; the agent's ID goes in a trailer. Settled in the ADR. | A machine account per agent. Not proposed. |
| 8 | A changed commit after approval | A follow-up task with its own review, as decision 25 proposes. | Re-review on the same task. Not proposed: the architecture makes a completed task terminal. |
| 9 | Where provider jobs run | The existing outbox, with a recheck before each external call. | A dedicated queue. Owner's yes, as a new resource. |
| 10 | Deletion, export and transfer of a repository | Not built in M5. A removed room leaves its repository in place, archived, until the ADR's policy is approved. | Deleting with the room. Owner's yes; it destroys work. |
| 11 | Private repositories on a free plan | Decide after the spike shows whether branch rules work there. | Buying a plan now. Owner's yes. |
| 12 | Calling M5's gate | The architect proposes it after the staging run and the security review, for the owner to review. | |

## Risks to test

The spike at step 1 answers these on the test organization, before any feature code:

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

## How far this was checked

- Written from `PRODUCT.md`, `ARCHITECTURE.md`, `ACCESS-CONTROL.md` and `RUNNER.md` as they stand on `main` at `17563d1`.
- **Nothing about GitHub's behavior here is verified.** Every claim about tokens, merges, branch rules and plans is from the specs or from memory, and the spike exists to check it.
- No code, contract, migration or cloud resource was created or changed.
- The Runner sections of the specs that lean on M5 are proposals and weren't reconciled with this plan. [#227](https://github.com/thachp/podster/pull/227), open now, proposes Runner as an A2A server and may change what M7 needs from M5.
