# ADR 0009: Managed repositories and merge

**Status:** **Proposed** by the architect on 2026-11-10 UTC. Not approved, and nothing here is built. It answers what the [M5 plan](../m5-plan.md) and the [architecture](../spec/ARCHITECTURE.md#managed-repositories-and-merge-m5) leave open for this ADR, using the [M5 spike](../../spikes/m5-github/README.md#results-2026-11-10)'s results. It also uses the spike's [merge-restriction run](https://github.com/thachp/podster/pull/234), whose results are in [#234](https://github.com/thachp/podster/pull/234) and not on `main` yet. Its choices are recorded as proposals in [decisions 179 to 189](../spec/PRODUCT.md#m5-proposals-november-10-2026). Items under [what needs the owner's yes](#what-needs-the-owners-yes) aren't the architect's to settle.

## How to read this

Every claim carries one of these labels, in a section's heading line or beside the claim:

- **Verified:** the spike saw GitHub do it on `podsterx`, on the date and the number of times its README says, the merge-restriction run included. Nothing else about GitHub counts as verified.
- **GitHub's documentation:** read on docs.github.com on 2026-11-10 and linked. Not run.
- **Spec:** already in `PRODUCT.md`, `ARCHITECTURE.md`, `ACCESS-CONTROL.md` or `RUNNER.md`. Most of those passages are proposals themselves.
- **Proposed:** the architect's proposal in this ADR.
- **Owner's yes:** needs the owner, because it costs money, creates an account or a secret, is legal text, or loosens the security stance.
- **Unverified:** not checked by anyone. Collected under [not verified](#not-verified).

## What the owner has said

- **Owner, 2026-11-10:** the test GitHub organization is `podsterx`. The real managed organization is `podsterdev`. Tests and spikes never run against `podsterdev`.
- **Owner, 2026-11-10, verbatim:** "i'm okay with having public repo.. this will be an MIT project".
  - **The architect's reading, unconfirmed:** managed repositories may be public, and Podster's own code will carry an MIT license. The architect has asked the owner which of these was meant. Until the owner answers, this ADR treats public managed repositories as a working assumption and nothing more. It doesn't read the sentence as licensing what rooms put in their repositories.

## Context

M5 is the first time Podster holds authority over something outside itself and hands part of it to agents. The rules it has to keep are the standing ones:

- **Rust decides authority.** The gateway authenticates and translates.
- **The Rust API stays private.**
- **Commands and queries are separate, with no event sourcing.** A command runs `crates/policy`, then `crates/core`, then commits state, event, outbox and idempotency record in one transaction.
- **Read models never authorize.**
- **Agent content is data.** Repository content, branch names, commit messages and pull request text never become instructions or permissions.
- **Logs carry IDs only.** Tokens never reach events, logs, the outbox, D1 or the gateway's storage.

The specs proposed a design before anything was tried on GitHub. The spike then changed three of its assumptions, and its last run answered the third:

1. **Verified:** on the Free plan, GitHub refuses a ruleset on a private repository (`403`, "Upgrade to GitHub Pro or make this repository public"). Without a ruleset, a token with contents write committed straight to the default branch and merged freely. So on the Free plan, a private managed repository has no merge boundary at all.
2. **Verified, on the two paths tried, once each:** with a ruleset on a public repository, a required status pinned to the merge App kept unmarked commits off the default branch. A status from the other App didn't count.
3. **Verified, once:** the rule gates the commit, not who merges. After the merge App marked a commit, the agent's own token merged it (`200`). So `merge_task` isn't the only path to a merge under that rule.
4. **Verified, once each, in the [merge-restriction run](https://github.com/thachp/podster/pull/234):** with a second rule that restricts updates to the default branch and names the merge App as its only bypass actor, the agent's token was refused on the three paths tried, even with the status on the head, and the merge App merged.

## Decision

### Which repositories are managed

**Proposed.** Only repositories that Podster's server creates in the one configured organization, for a Git-enabled room, one per room. Not in M5: linking a repository that already exists, repositories under anyone else's account, any provider other than GitHub.

A repository's identity is GitHub's repository ID, recorded when Podster creates it. A name never identifies one.

### Organizations and installations

- **Proposed:** the organization and each App's installation come from the private API Worker's configuration: the organization's ID and login, each App's ID and its installation ID. Nothing a client, task or webhook sends selects them (M5-04). The API compares the owner ID in GitHub's answers with the configured one before recording anything.
- **Proposed:** staging is configured with `podsterx`. A staging run uses test people and is a test, and the owner's rule is that tests never run against `podsterdev`. So `podsterdev` gets Apps and secrets only when the owner approves a deployment for real use, and none exists today.
- **Proposed:** `podsterx` is kept for staging and tests. The spike's README says to delete the test organization when this ADR is accepted. That line is out of date under this proposal, and it's noted here instead of edited, because this change is documentation only and doesn't touch `spikes/`.
- **Owner's yes:** the spike's two Apps are throwaway. They hold permissions the real ones shouldn't (the provisioning App can set commit statuses). Staging gets its own Apps later, with the permissions below, which the owner creates or approves.

### Two Apps

**Proposed: two, as the plan's question 2 proposed. The spike supports keeping the split.** The required status is pinned to one App's identity, and a status from the other App was refused (**verified**, `405`). If one App both issued agent tokens and set the status, the pin would say nothing.

| App | Used for | Repository permissions | Who holds its tokens |
| --- | --- | --- | --- |
| Provisioning | Creating repositories, creating their two rulesets, changing visibility, reading state, minting agent tokens | Administration write, Contents write, Pull requests write, Metadata read. Read access for checks and statuses is to settle with polling | The private API. An agent gets only a token cut down to one repository and fewer permissions |
| Merge | Setting `podster/review` on a reviewed commit, and merging | Contents write, Pull requests write, Commit statuses write, Metadata read. No Administration | The private API's merge job only. Never returned to any caller |

- **Verified:** these permissions were enough for the calls the spike made. Whether each is the least that works isn't checked.
- **Verified, once:** the merge App needed no extra permission to be a bypass actor. Being named in the ruleset was enough.
- **Proposed:** the provisioning App doesn't hold Commit statuses write or Workflows. Neither App holds an organization or account permission.
- Each App's private key is a secret on the private API Worker only. The gateway holds neither.
- **What the split doesn't protect.** The provisioning App holds Administration write, so its key can presumably remove a rule; that's inferred from the permission and wasn't run. A leaked provisioning key is control of every managed repository's settings and content. The split protects against an agent's token and against a mistake in the token-issuing path, not against that key leaking. See [key rotation and compromise](#key-rotation-and-compromise).

### Visibility and the plan

The specs propose private by default, chosen at setup and independent of the room's visibility. The spike makes that unbuildable on the Free plan with a merge boundary.

- **Proposed, as the working assumption:** managed repositories are public, so branch rules work on the Free plan. It rests on the architect's unconfirmed reading of the owner's words above.
- **Proposed:** while the organization is on the Free plan, the Git option in room setup creates a public repository and says so before the person confirms: the code, the repository's name, its branches and its pull requests are readable by anyone, whatever the room's visibility is. A private repository is shown as unavailable, never silently made public and never made private without rules.
- **Proposed:** the room's visibility still decides nothing about the repository, as the specs say. A private room with a public repository is allowed only through that explicit confirmation.
- **Owner's yes:** private managed repositories wait for a paid GitHub plan. That costs money. Whether rulesets then behave on a private repository as they did on a public one is **unverified**.
- **Proposed:** the M5 plan says public repositories stay unavailable until this ADR settles takedown and forks. The proposals for both are [below](#public-repositories-forks-and-takedown), and they are proposals. Public repositories stay unavailable outside tests until the owner confirms the public scope and the takedown items.

### Where state lives

**Spec, from the M5 plan's step 2; kept.** The room's Durable Object owns `repo_link`, `provider_grant`, `task_change` and the provisioning request as state, because grants are authority. It also keeps the webhook delivery IDs it has accepted.

- Every change is a command: policy, then core, then one transaction with state, event, outbox and idempotency record.
- D1 holds at most a projection: rows for lists, and a lookup from GitHub's repository ID to the room, used to route a webhook. It never authorizes. The room checks the repository ID against its own `repo_link` before recording anything.
- Calls to GitHub run from outbox jobs, through `crates/egress`. A job rechecks current authority in the room before its external call, and commits the result as its own command.
- Events and logs carry IDs, commit SHAs, pull request numbers, Podster reason codes and GitHub's status codes. They don't carry tokens, repository content, branch names, commit messages or GitHub's message text.

### Provisioning

**Proposed**, filling in the architecture's provisioning lifecycle.

- **Request.** Room setup with the Git option records one provisioning request in the room, with an idempotency key, the chosen name and visibility, and a random marker. Rust checks room-configuration authority and the organization's provisioning delegation first (M5-14). One room has at most one request and one repository.
- **Name.** Lowercase letters, digits and hyphens, starting with a letter or digit, at most 64 characters, validated in `crates/core`. No dots, so names GitHub treats specially in an organization, such as `.github`, can't be asked for. A name that's taken fails the request with `name_taken`. Podster never adopts the repository that holds it. `full_name` in `repo_link` is for display.
- **States:** `pending`, `ready`, `failed`, `uncertain`.
- **Ready** means all of these were read back from GitHub: the repository exists under the configured organization's ID, its ID is recorded, the default branch has an initial commit, the rule on the default branch is active and requires `podster/review` from the merge App's ID, and both installations cover it. **Verified:** a new repository was under the installation at once on both runs, and the gap wasn't measured.
- **Uncertain** is a creation call that timed out or lost its answer. No retry runs until reconciliation has looked. With no repository ID in hand, reconciliation reads the repository of that name in the configured organization and accepts it only if the owner ID matches and it carries the request's marker. A matching name without the marker is `name_taken`. Where the marker is stored on the repository is to settle while building, and is **unverified**.
- **Failed** carries a reason code. A repository that exists but isn't ready stays, with its ID recorded, and a retry finishes setup on that same ID. Nothing is deleted, and nothing falls back to another organization (M5-15).
- **What a failure blocks:** `get_repo_access` and `merge_task` in that room answer `repo_not_ready`. Other room work goes on.
- **Drift.** **Proposed:** polling also reads the rule back. If it's missing or changed, the link becomes `degraded`, token issuing and merge stop for that repository, and the room's owner and the operators see it. Podster doesn't put the rule back by itself.

### Grants and who can merge

**Spec and the plan's question 4; kept.**

- Creating a linked repository delegates to the room's owner for that repository only. An agent or reviewer needs an explicit `provider_grant` for that repository and action, from someone who holds the delegation (AC-10, AC-11).
- Proposed grant actions: `push`, which covers task branches and pull requests, and `merge`.
- `merge_task` needs an approved submission, a current `merge` grant, and a caller who isn't the submitter (AC-17 and question 4).
- An A2A agent or a public participant gets no repository authority from its protocol or its claim (AC-24).

### Agent access tokens

This answers [decision 10](../spec/PRODUCT.md#decisions-needed), as a proposal.

- **Scope.** One repository, with Contents write, Pull requests write and Metadata read. **Verified:** such a token got `404` on another repository, `403` on repository settings, on creating a ruleset and on setting a commit status, and `403` pushing a workflow file. Asking for a permission the App lacks returned `422`.
- **Issue.** `get_repo_access` reaches the private Rust API, which checks the task and its run, the fixed deadline and budget, the agent's assignment and connection, room access, the `push` grant, and that the repository is the room's ready link, as the architecture lists. Only then does it ask GitHub. A denied request sends nothing to GitHub (M5-05). The API checks the repository and permissions in GitHub's answer before returning the token.
- **Lifetime.** **Verified:** one hour. Podster can't shorten it, so a token can outlive the task's deadline, and the response says when the token expires and when the task's authority ends, as two fields.
- **Renewal.** A new `get_repo_access` call with every check run again, and no fresh approval, as RUNNER.md proposes. It never widens scope and never extends the task.
- **Revocation.** **Verified, once:** `DELETE /installation/token` returned `204`, that token got `401` on the next request, and another token from the same installation kept working.
  - GitHub's call revokes the token it's made with. So Podster can revoke only a token it still holds. RUNNER.md and AC-27 ask for revocation at the authorization boundary, and the plan said tokens are never stored. Both can't hold as written.
  - **Proposed:** the private Rust API seals each issued agent token and keeps it in the room's Durable Object for at most its one-hour life, solely so it can be revoked. It's deleted on revocation or expiry. It's never in an event, the outbox, D1, a log or the gateway. The seal follows the pattern of `A2A_TOKEN_KEY`: a 64-hex key that the owner sets as a secret on the private API Worker only.
  - Revocation is attempted when the task is submitted, completed, released or cancelled, when the deadline passes, and when the agent's grant, room access or connection ends. The outcome is recorded without the token (AC-27).
  - **Rejected alternative:** no revocation. Podster would hold nothing and deny renewal, and a removed agent could keep pushing to task branches for up to an hour after its access ended.
  - **Owner's yes:** the new secret. Holding a bearer token at all is new for Podster, so this is marked for M7's security review as well as M5's.
- **What an agent's token can still do.** It can write any branch other than the default one, including another task's branch in the same repository. Commit pinning is what keeps that out of a review. Whether it can create tags or releases is **unverified**.

### Commit pinning, and when the head moves

**Spec; kept, with the spike's results added.**

- `submit_task` on a linked task records `commit_sha` on the submission, and it never changes. `verify_task` names the commit and fails with `commit_changed` if it differs from the submission's or from the latest observed head.
- **Before approval,** a moved head means the agent submits again, as a new numbered submission with its own commit.
- **After approval,** the merge names the reviewed commit as `sha`. **Verified:** GitHub answered `409` "Head branch was modified" after a new push, with and without a ruleset. The job records `merge.failed` with `commit_changed`, the task stays completed, and the requester or lead opens a follow-up task (decision 25).
- **The mark is per commit.** **Verified:** with the rule active, a new head had no status, and even the merge App got `405` until it marked that head. Podster marks only the commit of an approved submission, so a commit pushed after review can't reach the default branch on the paths tried.
- **A moved base still merges in M5.** **Verified:** with the strict policy off, a merge went through after the base had moved. **Proposed:** the strict policy stays off in M5, and Podster records the base it observed at each merge and that it had moved. The result is a tree nobody reviewed as a whole, though every commit in it was reviewed or already merged. "Require branches to be up to date" is an open item: whether it does what the architecture asks, and how often it would force a follow-up task, is **unverified**.
- **Retries can't trust the merge call.** **Verified:** a second merge call on an already merged pull request returned `200` again. A retried job reads the pull request's state first, and takes "merged" from that read.

### The merge path

**Proposed: only the merge App can update the default branch, and it can update it only with a reviewed commit.** Two rulesets on the default branch, both created by the provisioning App at setup, as the [merge-restriction run](https://github.com/thachp/podster/pull/234)'s variant (c):

| Ruleset | Rules | Bypass | What it does |
| --- | --- | --- | --- |
| Review | `pull_request`, and `required_status_checks` for `podster/review` pinned to the merge App | Nobody | Binds everyone, the merge App included, to a pull request whose head the merge App has marked |
| Update | `update` | The merge App only (`Integration`, `always`) | Refuses every other update to the default branch |

**Verified, once each, on a public repository on the Free plan:**

- The agent's token, with the status already on the head, was refused merging the pull request (`405`), committing straight to the default branch through the contents API (`409`), and moving the branch's ref to the pull request's head (`422`).
- The merge App merged that same pull request (`200`).
- The merge App itself was refused merging a pull request whose head had no status (`405`), and committing straight to the default branch (`409`). So a bug in Podster's merge job can't put an unmarked commit on the default branch on these paths.
- Bypass is per ruleset, not per rule. With one ruleset holding all three rules, the merge App bypassed the status and pull request rules too. That's why there are two.

**What this gives.**

- `merge_task` is the only path to the default branch on the paths tried. That's where Rust checks the review, the merge grant, the submitter rule and the agent's current standing, so Rust decides every merge.
- The M5 gate's token boundary and M5-06, "an agent's token can't merge to the default branch", hold on the paths tried.
- The merge job sets `podster/review` on the approved submission's commit and then merges with that commit as `sha`. When the status is set no longer matters to the boundary, since marking a commit lets nobody else merge it.

**Rejected alternatives.**

1. **Mark at the moment of merge,** with the status rule alone. It leaves a window between the two calls in which the agent's token can merge the marked commit. The spike waited three seconds there. It narrows the gap and can't close it.
2. **Accept and observe an agent merging the exact reviewed commit.** A merge would then skip the merge grant, the submitter rule and the recheck of the agent's standing. A submitter could merge their own approved work, which the plan's question 4 forbids, and authority would rest on GitHub's rule alone.

**Not tried,** so not claimed: `git push` over HTTPS with either token; the squash and rebase merge methods; the `creation` rule; bypass modes other than `always`; organization-level rulesets; a private repository on a paid plan; and whether organization owners, or anyone else with admin rights, are held by the rules. Anything holding Administration write can change a ruleset, which the provisioning App's key does.

**Still proposed, because of what wasn't tried:**

- **GitHub is the source of truth for what merged.** Podster records what it reads from GitHub, and doesn't assume `merge_task` was the only path.
- Every merge Podster observes on a linked pull request is recorded on `task_change`, with the merged commit, GitHub's ID for the account that merged, and the observation time.
- A merge with no matching `merge.requested`, or of a commit that isn't an approved submission's, is recorded as its own event with a reason code and shown to the room's owner and the operators. Podster doesn't revert it.

### Merge method and attribution

- **Proposed, changing the plan's question 6:** merge commits in M5, not squash. The `merge` method is the only one the spike ran, and it keeps the reviewed commit itself in the default branch's history, so "what merged" can be checked against the submission. Squash and rebase are **unverified**, and wait until they've been tried.
- A retried merge job reads the pull request's merged state before and after its call, because a second merge call returned `200`.
- **Attribution is left open.** The plan's question 7 proposed that the App authors the merge and the agent's ID goes in a commit trailer. In a public repository that publishes a Podster ID, and the public surface shows none (ADR 0008). **Proposed for now:** Podster's own records carry attribution, from the submission to its agent, and the merge commit carries no Podster ID. Commits on a task branch carry whatever author the agent set, which is agent content.

### Webhooks and polling

**Nothing about webhooks is verified.** The spike's Apps had them off.

- **Spec:** the gateway gets a public route for GitHub's deliveries. It verifies the signature and decides nothing.
- **GitHub's documentation:** the signature is an HMAC-SHA256 of the body in `X-Hub-Signature-256`, to be compared in constant time ([validating webhook deliveries](https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries)). The webhook secret is on the gateway only.
- **Proposed:** the gateway passes on only the delivery ID, the event type, the repository and installation IDs, the pull request number and the commit SHAs. No titles, bodies, branch names or user text.
- **Proposed, stricter than the architecture:** a delivery is a nudge. The room checks the repository ID against its link and that the delivery ID is new, then queues a read of GitHub with Podster's own token. What's recorded is what that read returned, with its observation time. A forged or replayed delivery can cost a read and can't change state (M5-11, M5-16).
- **Polling** repairs a lost delivery. **Proposed:** only tasks with a change that's submitted or approved and not yet merged are polled, backing off from 1 minute to 1 hour as decision 117 does for A2A, and ending when the change merges, closes or its task ends.
- **Verified:** 5,000 requests an hour for an installation. One installation serves every room, so that budget is shared. Whether it fits isn't worked out, and it has to be before step 5.
- **Checks with Actions off.** **Proposed:** M5 reports commit statuses and check runs from any source, each with its observation time. Nothing in a managed repository produces one while Actions are off, so M5-12 is exercised on staging with a test status posted by a test App or token. Reading check runs and statuses with the provisioning App's token is **unverified**.

### Actions and workflows

- **Verified, once:** an agent's token without the Workflows permission got `403` pushing a workflow file.
- **Proposed:** Actions stay disabled for the managed organization until a later decision. It's an organization setting, which neither App can change, so the owner sets it, and provisioning reads it back where it can. No App gets the Workflows permission.
- **Unverified:** whether a workflow already in a repository can be abused, and whether disabling Actions also stops workflows on pull requests from forks. M6 will need its own decision before anything runs.

### Public repositories, forks and takedown

**All proposed.** The specs leave the fork design open, and this doesn't choose one.

- **A pull request from a fork is never a task change.** Podster links a pull request to a task only when the task's assigned agent names it in `submit_task`, Podster's own read shows its head is in the managed repository itself (the head repository's ID equals the link's), and its base is the default branch. The merge App never marks a commit for any other pull request.
- That stands in for "pushed with a Podster-issued token", which Podster can't see directly. It holds only while nobody but the two Apps and the organization's owner can write to the repository. So the organization has no other members, teams or outside collaborators, and adding one is the owner's decision.
- Pull requests from forks, issues and comments from strangers are ignored. They're never shown in a room and never read as instructions. Whether Podster closes them or turns those features off is open.
- **Takedown** follows [takedown.md](../legal/takedown.md). An operator action, decided in Rust like M4's suspension, sets the link to `suspended`, which stops token issuing and merge, and then makes the repository private. Archiving stops writes and leaves the content public, so it's the action for a room that's been removed, not for a takedown. Nothing is deleted.
  - **Unverified:** changing visibility or archiving through the provisioning App, what happens to an existing ruleset when a repository on the Free plan turns private, and what happens to forks made before. Copies others already made aren't recalled, as takedown.md says of everything.
  - **Proposed, and owner's yes for the text:** takedown.md covers public rooms today and says nothing of repositories. It must be extended to repositories, and its placeholder contact replaced by a real address, before any public managed repository exists outside staging. Both are legal text or a cloud change, so both are the owner's.

### Key rotation and compromise

- **GitHub's documentation:** an App can have up to 25 private keys, and more than one is how a key is rotated without downtime ([managing private keys](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/managing-private-keys-for-github-apps)). The page doesn't say how soon a deleted key stops working. **Unverified.**
- **Rotation, proposed:** the owner generates a second key for the App, sets it with `wrangler secret put` on the private API Worker, and it deploys. The architect checks that a token can be minted with it. The owner then deletes the old key on GitHub. The webhook secret rotates the same way, with the gateway accepting the old and new secrets for a stated overlap.
- **A leaked merge key** can mark and merge any commit in any managed repository. It can't change settings.
- **A leaked provisioning key** can change settings, remove rules and write content in every managed repository.
- **Response, proposed:** the owner deletes the key and sets a new one. Token issuing and merge stop for every room while that happens. Tokens minted with the leaked key can live up to an hour, and Podster can't revoke tokens it doesn't hold. Suspending the installation may cut that short, and is **unverified**. Afterwards a job reads every managed repository's rule and default-branch head and compares them with what Podster last recorded. Each difference is recorded as an observation and shown to the room's owner and the operators.
- Rotation and response get a written runbook before M5's gate.

### Deletion, export and transfer

- **Proposed, as the plan's question 10:** none is built in M5. Nothing in Podster deletes a repository. A removed or archived room leaves its repository in place, archived.
- A public repository can already be cloned by anyone, which is export in practice.
- **Owner's yes:** transfer to a room owner's own account, and any deletion policy, depend on the organization's legal terms below.

### Ownership and legal terms

**Left open. Owner's yes, and possibly a lawyer's.** Who owns `podsterdev`, who owns what agents push to its repositories, what license a managed repository carries if any, and what the terms say about all of it aren't decided here. The owner's sentence about MIT isn't read as answering any of them.

## Every open item, and where it stands

| Item | From | Outcome |
| --- | --- | --- |
| Which repositories are managed | Plan question 1 | Proposed: server-created only |
| Organization and installation selection | Architecture | Proposed: trusted configuration; `podsterx` for staging and tests, `podsterdev` for real use |
| One App or two; separate App permissions | Architecture, plan question 2 | Proposed: two, with the table above. Least permissions unverified |
| Installation access to a new repository | Architecture | Verified on both runs |
| Provisioning request and state contract | Architecture | Proposed |
| Naming and visibility | Architecture, plan questions 3 and 11 | Name proposed. Public as a working assumption; private needs the owner's yes for a paid plan |
| Initialized base and protection readiness | Architecture | Proposed, with drift detection |
| Unknown-outcome recovery; provisioning failure | Architecture | Proposed. Where the marker lives is unverified |
| How agents get repository access (scope, issue, renew, revoke) | Decision 10 | Proposed, with the token held sealed for revocation. The secret is the owner's |
| Commit pinning and a moved head | Architecture | Kept. Strict policy off in M5; "require up to date" left open |
| The merge path | Spike | Proposed: two rulesets, so only the merge App updates the default branch |
| Merge method | Plan question 6 | Proposed: merge commits, changing the plan |
| How commits attribute agents | Architecture, plan question 7 | Left open, with an interim proposal |
| Webhooks and polling | Architecture, plan step 5 | Proposed. All unverified |
| Checks with Actions off | Criterion 7, M5-12 | Proposed: statuses and check runs from any source |
| Where state lives | Plan step 2 | Kept |
| Key rotation and compromise | Plan's threat model | Proposed. Runbook owed |
| Actions and workflows | Plan's threat model | Proposed: disabled |
| Public repositories, takedown, pull requests from forks | Plan's threat model, architecture | Proposed. Needs the owner's yes before use |
| Ownership and legal terms of the organization | Architecture | Left open, for the owner |
| Deletion | Architecture, plan question 10 | Proposed: none in M5 |
| Export or transfer | Architecture | Left open, for the owner |

## Where the specs and the spike disagree

The M5 plan is updated with this ADR where it says so below. The specs aren't, until the ADR is accepted.

- **Private by default** (PRODUCT, ARCHITECTURE, plan question 3) can't have a merge boundary on the Free plan. The plan now proposes public.
- **"A required status that only the merge App can set"** (ARCHITECTURE) was written as if it limited merging to Podster. It limits which commit merges. The update rule is what limits who merges.
- **The gate's token boundary and M5-06** were false under the status rule alone, and hold under the two rulesets on the paths tried. The plan now says so.
- **"Tokens are never stored"** (plan) and **"revoke issued credentials"** (RUNNER.md, AC-27) conflict, because revoking a token needs the token. The plan now says a token is held sealed for revocation only.
- **"Retried jobs check whether the merge already happened"** (ARCHITECTURE) can't use the merge call, which answers `200` twice.
- **"Branch rules must recheck status at merge time"** for a moved base (ARCHITECTURE): with the strict policy off, nothing did, and M5 leaves it off.
- **Squash** (plan question 6) wasn't tried. The plan now proposes merge commits.
- **The plan kept public repositories unavailable** until this ADR settled takedown and forks, and the working assumption makes them the only kind. The plan now says they exist on staging only until the owner's items are done.
- **takedown.md** covers rooms, not repositories.
- **The spike's README** says to delete the test organization once this ADR is accepted. The proposal here keeps it for staging and tests. The README isn't edited in this change.

## Consequences

- **Code in a Git-enabled room is public** while the organization is on the Free plan, including for a private room. Setup has to say so plainly.
- **Every merge goes through `merge_task`** on the paths tried, and Podster still records any merge it didn't make.
- **Podster holds a bearer token** for up to an hour, sealed, which it never did before.
- **One installation's rate limit is shared** by every room.
- **No checks run** in a managed repository while Actions are off, so M5's check reporting is shown with a test status.
- **A leaked provisioning key is the worst case,** and the two-App split doesn't soften it.
- **`podsterdev` stays empty** through M5. Everything M5 proves is proved on `podsterx`.

## What needs the owner's yes

- **Confirming the scope of "i'm okay with having public repo.. this will be an MIT project":** whether managed repositories may be public, and what the MIT license covers.
- **A paid GitHub plan** for private managed repositories. It costs money.
- **The real organization's Apps and their secrets:** creating and installing both Apps on `podsterdev`, each private key and the webhook secret.
- **Staging's own Apps on `podsterx`,** with the permissions above, and their secrets. The owner creates them or approves the architect doing it.
- **The token-sealing secret:** a 64-hex key on the private API Worker only, as `A2A_TOKEN_KEY` is.
- **Legal terms and ownership of `podsterdev`,** and of what's pushed to its repositories. Possibly a lawyer.
- **The takedown contact,** which is still a placeholder, and extending takedown.md to repositories, before any public managed repository exists outside staging.
- **Disabling Actions** in each organization, and keeping each organization free of other members.
- **Keeping `podsterx`** after this ADR instead of deleting it.

## Not verified

- **Webhooks:** which arrive, how late, redelivery, and the signature check against real deliveries.
- **Rulesets on a private repository under a paid plan.**
- **`git push` over HTTPS** against the rules, with either token. The spike tried the contents API, a ref update through the API and the merge call.
- **Squash and rebase merges.**
- **The `creation` rule, bypass modes other than `always`, and organization-level rulesets.**
- **Whether organization owners,** or anyone else with admin rights, are held by the rules.
- **Suspending or uninstalling an installation,** and how long a token survives either.
- **Polling load** against 5,000 requests an hour.
- **How long an expired token keeps working,** and how soon a deleted App key does.
- **The strict policy,** "require branches to be up to date", for a moved base.
- **Workflows already in a repository,** and workflows from forks with Actions disabled.
- **Changing visibility and archiving** through the App, and what either does to rules and forks.
- **Tags and releases** with an agent's token.
- **The least permissions** each App needs, and read access for checks and statuses.
- **Everything the spike saw was seen once or twice,** on one Free organization, on one day. The two-ruleset result was seen once.

## Cloud resources this needs

- **GitHub:** `podsterx` exists. `podsterdev` is named by the owner, and this ADR doesn't record whether it has been created. Two Apps in each organization that's used. A paid plan only if the owner wants private repositories.
- **Cloudflare:** nothing new and billed. Durable Object state through the room's forward-only migrations, at most a projection table in the existing D1 database, one route on the existing gateway, and the existing outbox.
- **Secrets:** two App keys and the token-sealing key on the private API Worker, and the webhook secret on the gateway. The owner sets each.
