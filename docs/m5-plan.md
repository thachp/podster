# M5 plan

**Status, 2026-11-10 UTC: Proposed. Nothing here is approved or built.** Step 1 is drafted: [ADR 0009](adr/0009-managed-repositories.md) is written as a proposal, not accepted, and [the spike has run](../spikes/m5-github/README.md#results-2026-11-10) twice against the test organization, without webhooks. The spike's merge-restriction run is in [its own results](../spikes/m5-github/README.md#results-merge-restriction). The ADR's choices are proposals, recorded as [decisions 179 to 189](spec/PRODUCT.md#m5-proposals-november-10-2026). The gate, M5-03, M5-06, M5-12, the threat model, steps 4, 6 and 7 and questions 2, 3, 6, 7 and 11 below are reworded to match the ADR, and the ADR lists [where the spike disagreed with this plan](adr/0009-managed-repositories.md#where-the-specs-and-the-spike-disagree). The architect drafted this plan from the specs. Its [questions](#questions-for-the-architect) carry the architect's proposed answers, which aren't recorded as decisions in `PRODUCT.md` yet. Items marked **owner's yes** create an account or a cloud resource, cost money, set a secret, or are legal text, so the architect can't settle them alone.

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
| 2 | **Contracts and migration:** `repo_link`, `provider_grant`, `task_change` and a provisioning request, with `get_repo_access`, `get_task_release_status` and `merge_task` in `capabilities.yaml` and their routes in `openapi.yaml`. The room's Durable Object owns all four as state, because grants are authority. D1 gets at most a projection for lists, which never authorizes. | One contract and migration PR at a time. |
| 3 | **Decisions in `crates/core` and `crates/policy`:** grant checks, `commit_sha` required on `submit_task` and `verify_task` for a linked task, `commit_changed`, and merge as its own state. Pure, with no I/O. | AC-31 is decided here, and AC-17's rule that approval alone never merges. |
| 4 | **Provisioning:** room setup records a request; a job creates the repository, sets its protections and records the verified repository ID. Pending, ready, failed and uncertain states for the request, and ready, degraded and suspended for the link. An unknown outcome is a failed setup: nothing is adopted by name, and a retry uses a new server-generated name. | A failed setup blocks coding tasks in that room, not other work. |
| 5 | **Webhooks:** the gateway verifies GitHub's signature and passes a normalized observation to the room's Durable Object, which records it with its observation time. A job polls when state looks stale. | A new public route on the gateway. It authenticates the sender and decides nothing. |
| 6 | **`get_repo_access`:** the private Rust API mints a token for one repository after rechecking the task and its run, the fixed deadline and budget, the agent's assignment and connection, room access, the exact repository and installation, the grant and the provider permissions. Renewal runs the same checks. | Tokens never reach events, logs, D1 or the gateway's storage. The room's Durable Object holds each one sealed for at most its hour, for revocation only, as ADR 0009 proposes. AC-27. |
| 7 | **`merge_task`:** the job rechecks authority, re-reads the pull request's base, head repository and head commit and refuses on any difference from the reviewed values, marks the reviewed commit, merges with its `sha` as a merge commit, confirms the default branch contains it, and records success or failure. A changed commit leads to a follow-up task, as decision 25 proposes. | Under ADR 0009's two rulesets, only the merge App can update the default branch. A retry reads the pull request's merged state, since a second merge call answers `200`. |
| 8 | **`get_task_release_status`:** checks and merge state, each with its own observation time. | Reports that no release exists; M6 adds releases. |
| 9 | **Screens**, in two PRs: (a) the Git option in room setup and the repository's state; (b) grants in Manage access and a task's change and merge state. | Unavailable grants show as unavailable, never silently provisioned. |
| 10 | **Staging run and security review,** then the gate call. | A script against staging with test people, in `podsterdev`. |

Steps 3, 5 and 9(a) can run side by side after step 2. Steps 4 to 7 are security-sensitive: a provisioning credential, a new public route, token issuing and merge. Each gets the deeper review the owner has already agreed for security-sensitive steps; anything deeper than that is asked first.

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
| M5-10 | An approved task without a separate merge grant can't be merged, and a reviewer can't merge their own work. |
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
- No code, contract, migration or cloud resource was created or changed.
- The Runner sections of the specs that lean on M5 are proposals and weren't reconciled with this plan. [#227](https://github.com/thachp/podster/pull/227), open now, proposes Runner as an A2A server and may change what M7 needs from M5.
