# ADR 0009: Managed repositories and merge

**Status:** **Proposed** by the architect on 2026-11-10 UTC. Not approved, and nothing here is built. It answers what the [M5 plan](../m5-plan.md) and the [architecture](../spec/ARCHITECTURE.md#managed-repositories-and-merge-m5) leave open for this ADR, using the [M5 spike](../../spikes/m5-github/README.md#results-2026-11-10)'s results. It also uses the spike's [merge-restriction run](../../spikes/m5-github/README.md#results-merge-restriction) and its [three-Apps run](../../spikes/m5-github/README.md#results-three-apps). Its choices are recorded as proposals in [decisions 179 to 189](../spec/PRODUCT.md#m5-proposals-november-10-2026). Items under [what needs the owner's yes](#what-needs-the-owners-yes) aren't the architect's to settle.

## How to read this

Every claim carries one of these labels, in a section's heading line or beside the claim:

- **Verified:** the spike saw GitHub do it, on the date and the number of times its README says. The first runs and the merge-restriction run were on `podsterx`, with two Apps. The three-Apps run was on `podsterdev`, and a claim that rests on it says so. Nothing else about GitHub counts as verified.
- **GitHub's documentation:** read on docs.github.com on 2026-11-10 and linked. Not run.
- **Spec:** already in `PRODUCT.md`, `ARCHITECTURE.md`, `ACCESS-CONTROL.md` or `RUNNER.md`. Most of those passages are proposals themselves.
- **Proposed:** the architect's proposal in this ADR.
- **Owner's yes:** needs the owner, because it costs money, creates an account or a secret, is legal text, or loosens the security stance.
- **Unverified:** not checked by anyone. Collected under [not verified](#not-verified).

## What the owner has said

- **Owner, 2026-11-10, verbatim:** "podsterx no longer exist.. the organization is now https://github.com/organizations/podsterdev/settings/apps you can create the app there".
  - **Earlier the same day the owner had said** that the test GitHub organization was `podsterx`, the real managed organization was `podsterdev`, and tests and spikes never ran against `podsterdev`.
  - **The architect's reading, not the owner's words:** the new sentence replaces the earlier one, so the rule that tests never run against `podsterdev` no longer stands. `podsterdev` is the one organization. Podster has no production deployment, so `podsterdev` serves staging now, and the spike's three-Apps run was on it.
  - **The owner said "the app". The architect created three,** each installed on all repositories, as this ADR proposes.
- **Owner, 2026-11-10, verbatim:** "i'm okay with having public repo.. this will be an MIT project".
  - **The architect's reading, unconfirmed:** managed repositories may be public, and Podster's own code will carry an MIT license. The architect has asked the owner which of these was meant. Until the owner answers, this ADR treats public managed repositories as a working assumption and nothing more. It doesn't read the sentence as licensing what rooms put in their repositories. *Superseded on 2026-11-11 by the owner's reply below.*
- **Owner, 2026-11-11, verbatim:** "who are the operators? an admin of a workroom should be able to connect to repo .. it doesn't have to be only an operators somewehre".
  - **Asked two questions, the owner chose:** for an operator's approval of an organization before it can have managed repositories, "No gate, with limits"; for who in a workroom may ask for the repository and give push and merge grants, "Owner and admins". It's [decision 194](../spec/PRODUCT.md#decisions-needed), and it replaces the architect's ruling of 2026-11-10 that only an operator gives an organization the delegation.
  - **The architect's, within that choice, proposed:** the cap of 5 accepted requests in 24 hours for an organization, the same cap for one person asking (one person can make any number of organizations), and ending an admin's grants when they stop being one.
- **Owner, 2026-11-11, verbatim:** "okay with public repo, MIT project".
  - **The architect's reading, told to the owner:** it confirms both. Managed repositories may be public, and Podster's own code is MIT-licensed; the `LICENSE` file at the repository's root was added on that reading. It still isn't read as licensing what rooms put in their repositories. The words don't cover switching `MANAGED_REPOSITORIES` on, setting the Apps' keys, or the takedown process for public repositories. Each still needs the owner.

## Context

M5 is the first time Podster holds authority over something outside itself and hands part of it to agents. The rules it has to keep are the standing ones:

- **Rust decides authority.** The gateway authenticates and translates.
- **The Rust API stays private.**
- **Commands and queries are separate, with no event sourcing.** A command runs `crates/policy`, then `crates/core`, then commits state, event, outbox and idempotency record in one transaction.
- **Read models never authorize.**
- **Agent content is data.** Repository content, branch names, commit messages and pull request text never become instructions or permissions.
- **Logs carry IDs only.** Tokens never reach events, logs, the outbox, D1 or the gateway's storage.

The specs proposed a design before anything was tried on GitHub. The spike then changed three of its assumptions, and its last run answered the third:

1. **Verified:** on the Free plan, GitHub refuses a ruleset on a private repository (`403`, "Upgrade to GitHub Pro or make this repository public"). Without a ruleset, a token with contents write committed straight to the default branch and merged freely. Classic branch protection wasn't tried, so this ADR claims only that rulesets, the mechanism it relies on, aren't available there.
2. **Verified, on the two paths tried, once each:** with a ruleset on a public repository, a required status pinned to the merge App kept unmarked commits off the default branch. A status from the other App didn't count.
3. **Verified, once:** the rule gates the commit, not who merges. After the merge App marked a commit, the agent's own token merged it (`200`). So `merge_task` isn't the only path to a merge under that rule.
4. **Verified, once each, in the [merge-restriction run](../../spikes/m5-github/README.md#results-merge-restriction):** with a second rule that restricts updates to the default branch and names the merge App as its only bypass actor, the agent's token was refused on the three paths tried, even with the status on the head, and the merge App merged.

## Decision

### Which repositories are managed

**Proposed.** Only repositories that Podster's server creates in the one configured organization, for a Git-enabled room, one per room. Not in M5: linking a repository that already exists, repositories under anyone else's account, any provider other than GitHub.

A repository's identity is GitHub's repository ID, recorded when Podster creates it. A name never identifies one.

### Organizations and installations

- **Proposed:** the organization and each App's installation come from the private API Worker's configuration: the organization's ID and login, each App's ID and its installation ID. Nothing a client, task or webhook sends selects them (M5-04). The API compares the owner ID in GitHub's answers with the configured one before recording anything.
- **Owner, 2026-11-10:** the organization is `podsterdev`, by [the owner's sentence above](#what-the-owner-has-said).
- **Observed by the architect through GitHub's API, 2026-11-10:** `podsterdev` was created that day, is on the Free plan, and was empty.
- **Proposed, on the architect's reading:** staging is configured with `podsterdev`. Podster has no production deployment, so nothing else uses it.
- **Done on 2026-11-10:** the owner said "you can create the app there", and the architect created three Apps in `podsterdev`, in the owner's browser, as this ADR proposes: `podster-staging-provision` (App ID 5695065), `podster-staging-agent` (5695079) and `podster-staging-merge` (5695088). Each is private, has webhooks off, is installed on all repositories and holds the permissions in the table below. Their keys are on the owner's machine. None is a secret on any Worker yet; setting those is the owner's.
- **Open, and the architect's to settle before any production deployment:** whether staging and production share `podsterdev`, or get separate organizations, or separate Apps in one organization. Sharing would put test repositories beside real ones, under the same App keys and the same rate limits. Nothing is decided, and nothing needs deciding while only staging exists.
- **`podsterx`:** the owner said it no longer exists. Its state wasn't confirmed: GitHub's API still showed it, and the spike's two Apps, when the architect checked just after. Nothing has touched it since. The earlier proposal here, to keep `podsterx` for staging and tests and delete the spike's two Apps and their keys from it, is moot if the organization is gone. Those two Apps held permissions the real ones shouldn't, and they aren't used again.

### Three Apps

**Proposed: three. Verified as a set, once, on `podsterdev`, on the calls the [three-Apps run](../../spikes/m5-github/README.md#results-three-apps) made.** The earlier runs used one App both to provision and to issue agent tokens. The plan's question 2 proposed two.

| App | Used for | Repository permissions | Who holds its tokens |
| --- | --- | --- | --- |
| Provisioning | Creating repositories and their two rulesets, changing visibility, reading rules back. Never issues an agent's token | Administration write, Metadata read. **Verified, once:** that was enough to create a repository with its first commit (`auto_init`) and both rulesets | The private API's provisioning and takedown jobs only |
| Agent token | Minting each agent's token | Contents write, Pull requests write, Metadata read. No Administration | The private API. An agent gets a token cut down to one repository |
| Merge | Setting `podster/review` on a commit, and merging | Contents write, Pull requests write, Commit statuses write, Metadata read. No Administration | The private API's merge job only. Never returned to any caller |

**Why three.**

- **The merge App is separate** because the required status and the update bypass both rest on its identity. **Verified:** a status from another App was refused (`405`), and the merge App needed no extra permission to be a bypass actor.
- **The agent-token App is separate from provisioning** so that a mistake in the token-issuing path, or a leak of that App's key, can't touch the rules. A token can't hold a permission its App lacks (**verified:** asking for one returned `422`), and this App has no Administration to give.
- **Verified, with the spike's single provisioning App:** its token created rulesets naming a bypass actor (`201`), and deleted rulesets and repositories (`204`; the repository deletes were seen on the console and aren't in a results file). An agent's cut-down token from that same App got `403` on settings and rulesets. So the boundary held in the spike by scoping alone, and three Apps make it hold by the App's own permissions.

**Verified, once each, on a public repository in `podsterdev`, in the [three-Apps run](../../spikes/m5-github/README.md#results-three-apps):**

- **Installations.** A repository the provisioning App created was under the other two installations at once: each minted a token scoped to it on the first try.
- **The agent-token App has no administrative reach.** Its token, both cut down to the one repository and as the full installation token, got `403` editing repository settings, creating, editing and deleting a ruleset, creating a repository in the organization, deleting the repository and setting a commit status. Asking that App for a token with Administration returned `422`. The cut-down token got `404` reading and writing another, private repository.
- **The agent-token App can do its work and can't merge.** The cut-down token created a branch, committed and opened a pull request (`201` each). It was refused the merge before the merge App's status (`405`). After the status, it and the full token were each refused the merge (`405`), a commit to the default branch (`409`) and a ref update (`422`).
- **The merge App** was refused an unmarked commit (`405`), merged the marked one (`200`), and got `403` on each administrative call above except setting a status, which is its job (`201`).
- **The provisioning App can't write code.** It got `403` on a commit to the default branch and to a task branch, creating a branch, opening a pull request, moving the default branch's ref, merging and setting a status.

**Still unverified:** whether any App would work with less than it holds, and which App's token does the polling reads. `git push` wasn't tried with any of the three.

- No App holds Commit statuses write except the merge App. None holds Workflows, or an organization or account permission.
- Each App's private key is a secret on the private API Worker only. The gateway holds none.
- **What the split doesn't protect.** A leaked provisioning key can remove the rules, add a bypass actor, delete repositories and, by its permission, change visibility. See [key rotation and compromise](#key-rotation-and-compromise).

### Visibility and the plan

The specs propose private by default, chosen at setup and independent of the room's visibility. The spike found no way to build it on the Free plan with the rules this ADR relies on.

- **Proposed, as the working assumption:** managed repositories are public, so branch rules work on the Free plan. It rests on the architect's reading of the owner's words above, unconfirmed on 2026-11-10 and confirmed by the owner on 2026-11-11.
- **Proposed:** while the organization is on the Free plan, the Git option in room setup creates a public repository and says so before the person confirms: the code, the repository's name, its branches and its pull requests are readable by anyone, whatever the room's visibility is. A task branch is public as soon as it's pushed, before any review. A private repository is shown as unavailable, never silently made public and never made private without rules.
- **Proposed:** the room's visibility still decides nothing about the repository, as the specs say. A private room with a public repository is allowed only through that explicit confirmation.
- **Owner's yes:** private managed repositories wait for a paid GitHub plan. That costs money. Whether rulesets then behave on a private repository as they did on a public one is **unverified**.
- **Proposed:** the M5 plan says public repositories stay unavailable until this ADR settles takedown and forks. The proposals for both are [below](#public-repositories-forks-and-takedown), and they are proposals. Public repositories stay unavailable outside staging until the owner confirms the public scope and the takedown items.
- **Owner's yes:** public managed repositories on staging need their own yes. takedown.md's staging exception of 2026-11-10 covers `PUBLIC_ROOMS`, not repositories.

### Where state lives

**Spec, from the M5 plan's step 2; kept.** The room's Durable Object owns `repo_link`, `provider_grant`, `task_change` and the provisioning request as state, because grants are authority. It also keeps the webhook delivery IDs it has accepted, and each sealed agent token for at most an hour.

- Every change is a command: policy, then core, then one transaction with state, event, outbox and idempotency record.
- D1 holds at most a projection: rows for lists, and a lookup from GitHub's repository ID to the room, used to route a webhook. It never authorizes. The room checks the repository ID against its own `repo_link` before recording anything.
- Calls to GitHub run from outbox jobs, through `crates/egress`. A job rechecks current authority in the room before its external call, and commits the result as its own command.
- Events and logs carry IDs, commit SHAs, pull request numbers, Podster reason codes and GitHub's status codes. They don't carry tokens, repository content, branch names, commit messages or GitHub's message text.

### Provisioning

**Proposed**, filling in the architecture's provisioning lifecycle.

- **Request.** Room setup with the Git option records one provisioning request in the room, with an idempotency key and the chosen name and visibility. Rust checks room-configuration authority and the organization's provisioning delegation first (M5-14). **Since 2026-11-11 ([decision 194](../spec/PRODUCT.md#decisions-needed)):** room-configuration authority is a person who is the room's owner or a room admin; every organization holds the delegation unless a Podster operator took it back; and a request is counted, in the same call that reads the delegation, against a cap of 5 accepted requests in any 24 hours for the organization and for the person asking. A room is counted once: a replay, a retry of its setup and a request the room doesn't record cost nothing. An operator's take-back refuses new requests and retries, and stops a job that hasn't linked the repository yet; a repository already linked keeps its grants, tokens and merges. One room has at most one request and one linked repository. While managed repositories are switched off, every room's repository route answers as a route that doesn't exist, but the organization's provisioning-delegation routes keep answering, so an operator can take the delegation back before the feature is switched on: a ruled exception (the architect, 2026-11-11; for the owner to review).
- **Name.** Lowercase letters, digits and hyphens, starting with a letter or digit, at most 64 characters, validated in `crates/core`. No dots, so names GitHub treats specially in an organization, such as `.github`, can't be asked for. A name that's taken fails the request with `name_taken`. `full_name` in `repo_link` is for display.
- **Never by name.** Podster links a repository only by the ID in GitHub's answer to its own creation call. It never adopts a repository because its name matches, as the architecture and M5-03 say.
- **States of the request:** `pending`, `ready`, `failed`, `uncertain`. **States of the link after that:** `ready`, `degraded`, `suspended`. Only `ready` lets a token be issued or a merge run.
- **Ready** means all of these were read back from GitHub, and any that's missing, different or unreadable fails closed:
  - the repository exists under the configured organization's ID, and its ID is recorded;
  - the default branch has an initial commit;
  - both rulesets are present on the default branch with enforcement `active`: the review ruleset with no bypass actor, and the update ruleset whose bypass list is exactly the merge App;
  - Actions are disabled on the repository, which is **proposed and not currently true**: see [Actions and workflows](#actions-and-workflows);
  - all three installations cover the repository. **Verified, once, for three:** each of the other two Apps minted a token for a new repository on the first try. The gap wasn't measured.
- **Uncertain** is a creation call that timed out or lost its answer, so Podster has no repository ID. **Proposed:** it's treated as a failed setup. Coding tasks stay blocked, and a retry uses a new name that the server generates, never the same one. A repository the lost call did create stays where it is, unlinked, and is listed for the operators. Podster never deletes one on its own initiative.
  - **Left open, unverified, and a spike item:** adopting such an orphan by a marker Podster wrote into it at creation. Until that's tried and approved, nothing is adopted.
- **Failed** carries a reason code. A repository whose ID Podster holds but that isn't ready stays, and a retry finishes setup on that same ID. Nothing is deleted, and nothing falls back to another organization (M5-15).
- **What a failure blocks:** `get_repo_access` and `merge_task` in that room answer `repo_not_ready`. Other room work goes on.
- **Drift.** **Proposed:** the same read-back runs on a schedule and again before each merge. If anything differs, the link becomes `degraded`, token issuing and merge stop for that repository, and the room's owner and the operators see it. Podster doesn't put the rules back by itself.
- **Verified, once, on a public repository in `podsterdev`:** the provisioning App's token read both rulesets back with `GET`, each `active` on the default branch, with the status pinned to the merge App, an empty bypass list on the review ruleset and the merge App alone on the update ruleset. The read gave the same answer after every refused attempt in that run. The agent's and the merge App's tokens could read the rules too, but their answers carried no bypass list. So the read-back uses the provisioning App's token.
- **Verified, once:** the provisioning App's token read the repository's Actions setting (`200`), and Actions were **on**. It got `403` reading the organization's Actions setting, since no App here holds an organization permission.
- **Proposed, not tried, and a spike item:** the provisioning App switches Actions off on each repository it creates, with its repository Administration permission, and reads that repository's setting back before the link is ready, failing closed. Reading the organization's setting isn't needed for that. **GitHub's documentation, untested:** an App would need the organization's Administration read permission to read the organization's setting.
- **Unverified:** the same reads on a private repository.

### Grants and who can merge

**Spec and the plan's question 4; kept.**

- Creating a linked repository delegates to those who run the room, for that repository only: a person who is its owner or a room admin ([decision 194](../spec/PRODUCT.md#decisions-needed), 2026-11-11; before it, the room's owner alone). An agent or reviewer needs an explicit `provider_grant` for that repository and action, from one of them, and it counts only while its giver still is one (AC-10, AC-11). An admin's grants end in the change that demotes or removes them, and making them an admin again restores nothing.
- **What follows from "Owner and admins" and "No gate, with limits", stated plainly:**
  - **In a room whose owner has left, its admins can still ask for the repository and give grants.** Before 2026-11-11 nobody could until ownership was recovered.
  - **An admin who grants a principal an action the owner already granted them replaces the owner's row with their own.** That grant then ends if that admin is demoted or removed, though the owner gave it first.
  - **An operator's take-back stops new requests and retries of setup, and a setup job that hasn't linked its repository yet (`not_delegated`), and nothing else.** Nothing is counted for a refused request. Repositories already linked, their tokens, grants and merges keep working. **Ruled by the architect, 2026-11-11; for the owner to review:** the owner's words were only that an operator "can take the ability away from an organization".
  - **There is no cap across sign-ups.** The cap is 5 accepted requests for one person in a rolling 24 hours, so N sign-ups get 5N. Nothing holds people acting together, or one person with many accounts. Owed to M7's security review.
  - **A deployment can name who may ask (`REPOSITORY_REQUESTERS`).** Added by the architect on 2026-11-11 after M5's security review; the owner's "No gate, with limits" stands as the product rule, and this is a deployment's setting beside it. The review found that the limits assumed staging had test people only: staging's sign-in is open to anyone, and with no operator's approval any stranger who signed in could create 5 public repositories a day under `podsterdev`.
    - **What it is.** A Worker variable on the API. Unset, the rules above apply to everyone. Set, it's a list separated by commas of person IDs and, optionally, the entry `test-people`, and only those it names may ask for a room's repository or retry its setup. Empty or malformed, it lets nobody, the well-formed entries with the rest: a slip closes requests and never opens them. An operator isn't implied; list them.
    - **A test person** is one made by the gateway's secret-protected test sign-up, whose user IDs start `e2e_`, so their person ID starts `per_e2e_`. No other sign-up produces that prefix. The API reads it from the verified caller's ID in the gateway's assertion, never from anything a client sends.
    - **Where it's decided.** `core::provisioning::RepositoryRequesters` reads the list and `policy::repositories::authorize_repository_request` decides, both pure. The room's rule answers first, so a member, an agent or a stranger gets the refusal they always got, and only a person who is the room's owner or an admin learns that requests are closed: `repository_requests_closed` (403), which says nothing of who is listed. It's checked before any place in a count is reserved, again in the command's transaction, and again by the job for whoever asked, before anything goes to GitHub: a request recorded under a wider setting ends `failed` with that reason under a narrower one.
    - **What it doesn't touch.** Grants, tokens, merges and reads in a room that already has its repository. The room's repository read carries `may_request`, so a screen says the option is unavailable; that shows and never authorizes.
    - **A retry by someone listed doesn't rescue a request first made by someone who isn't.** The job holds the request to whoever first asked, as it does for their standing in the room.
    - **Staging** sets it to `test-people`. The owner's own person ID is to be added as a second entry: it's recorded only in the `OPERATORS` secret, so it wasn't guessed, and until then only test people can ask on staging. **Production's value is the owner's to decide before production.**
  - **How a request is counted.** A request is counted like this, and never un-counted (ruled by the architect on 2026-11-11, after three reviews each found a way to record a request that no count held):
    - **One place per room, in each object.** The organization's object and the asker's own each keep one row per room, stamped with when it was last asked for. Asking is "insert if absent, otherwise stamp again with now", in one transaction with the delegation read in the organization's object, by that object's own clock. It's held if the room already has a place there, or if fewer than 5 other rooms were stamped in the last 24 hours.
    - **There is no release.** A request that fails after it was counted leaves its room counted until 24 hours pass with nobody asking for that room again; every held ask stamps the place with now. The organization is asked first, then the person; if the person's object refuses or can't answer, the organization's place for that room stays.
    - **The room's transaction records only if this very call was told "held" by both objects,** for the caller it resolves inside the transaction and the organization the room is in then. Otherwise it refuses with `delegation_unavailable`, retryable.
    - **So a count is only ever too high.** The cases: a call refused in its transaction (the caller demoted meanwhile, a second call for a room that just got its request, a failed write); the person's cap or an unreachable person's object after the organization counted; and, for two people asking for one room at once, the person who didn't record. Each ages out 24 hours after the last ask for that room, and only if nobody asks for it again: every held ask stamps the place with now, so asking again keeps it.
    - **Accepted consequence: one person can fill an organization's five places with nothing recorded.** The organization is reserved before the person. So a person already at their own cap, who is owner or admin of more rooms in an organization, can ask for five of those rooms: each ask takes the organization's place, the person's own object refuses, and nothing is recorded. Asking again within each 24 hours keeps the places, and meanwhile no other room of that organization can ask. It needs authority in each of those rooms, so it isn't a way for someone without authority to block others. Accepted by the review of 2026-11-11; owed to M7's security review.
    - **Only someone with authority can use a place up.** A reserve is reached only by a person who is the room's owner or an admin at the look before it, so nobody burns another organization's places without already running a room in it.
    - **What the cap bounds, honestly:** rooms asked for, not calls to GitHub. A counted request can run setup up to 5 times, and each run whose outcome is unknown may leave a repository under a new name. So the worst case is 25 repositories on GitHub for an organization in a day, if every outcome is unknown; the ordinary case is 5. Owed to M7's security review.
- Proposed grant actions: `push`, which covers task branches and pull requests, and `merge`.
- `merge_task` needs an approved submission, a current `merge` grant, and a caller who isn't the submitter (AC-17 and question 4).
- An A2A agent or a public participant gets no repository authority from its protocol or its claim (AC-24).
- **No selector comes from the caller.** `get_repo_access` and `merge_task` accept no organization, installation, repository or pull request ID from a client. The caller names a task, and for a merge the submission and its commit. The repository comes from the room's `repo_link`, the pull request from the task's `task_change`, and the organization and installations from configuration.

### Agent access tokens

This answers [decision 10](../spec/PRODUCT.md#decisions-needed), as a proposal.

- **Scope.** One repository, with Contents write, Pull requests write and Metadata read. **Verified:** such a token got `404` on another repository, `403` on repository settings, on creating a ruleset and on setting a commit status, and `403` pushing a workflow file. Asking for a permission the App lacks returned `422`.
- **Issue.** The token comes from the agent-token App. `get_repo_access` reaches the private Rust API, which checks the task and its run, the fixed deadline and budget, the agent's assignment and connection, room access, the `push` grant, and that the repository is the room's ready link, as the architecture lists. Only then does it ask GitHub. A denied request sends nothing to GitHub (M5-05). The API checks the repository and permissions in GitHub's answer before returning the token.
- **Lifetime.** **Verified:** one hour. Podster can't shorten it, so a token can outlive the task's deadline, and the response says when the token expires and when the task's authority ends, as two fields.
- **Renewal.** A new `get_repo_access` call with every check run again, and no fresh approval, as RUNNER.md proposes. It never widens scope and never extends the task.
- **Revocation.** **Verified, once:** `DELETE /installation/token` returned `204`, that token got `401` on the next request, and another token from the same installation kept working.
  - GitHub's call revokes the token it's made with. So Podster can revoke only a token it still holds. RUNNER.md and AC-27 ask for revocation at the authorization boundary, and the plan said tokens are never stored. Both can't hold as written.
  - **Proposed:** the private Rust API seals each issued agent token and keeps it in the room's Durable Object for at most its one-hour life, solely so it can be revoked. It's deleted on revocation or expiry. It's never in an event, the outbox, D1, a log or the gateway. The seal follows the pattern of `A2A_TOKEN_KEY`: a 64-hex key that the owner sets as a secret on the private API Worker only.
  - Revocation is attempted when the task is submitted, completed, released or cancelled, when the deadline passes, and when the agent's grant, room access or connection ends. The outcome is recorded without the token (AC-27).
  - **Rejected alternative:** no revocation. Podster would hold nothing and deny renewal, and a removed agent could keep pushing to task branches for up to an hour after its access ended.
  - **One live token per agent per task.** A repeated `get_repo_access` returns the held token until it's near expiry, after the same checks, and concurrent requests are coalesced. That caps what a room holds and what an agent can make Podster mint.
  - **Deletion at expiry** is the room's alarm, set for the earliest expiry it holds. It doesn't wait for the next request.
  - **The seal is bound** to the room, the repository ID and the grant as associated data, so a sealed token copied to another row or room doesn't open.
  - **The sealing key rotates.** A sealed token doesn't name its key. While rotating, the old key is kept as a second secret, `REPO_TOKEN_KEY_PREVIOUS`, tried only to open a token when the current key can't; new tokens are always sealed with the current key. The previous secret is removed at least 65 minutes later, when nothing it sealed is still alive. A token neither key opens is recorded as unrevocable and dropped, unless the previous secret is set but malformed, when it waits (ruling M2 of M5 step 6's review, in `docs/m5-plan.md`).
  - **What this doesn't protect.** A compromise of the private API Worker exposes every live token it can unseal. Worse, it exposes the three App keys held on that same Worker, which can mint tokens at will. The seal protects the stored copy, not the Worker.
  - **Owner's yes:** the new secret. Holding a bearer token at all is new for Podster, so this is marked for M7's security review as well as M5's.
- **What an agent's token can still do.** It can write any branch other than the default one, including another task's branch in the same repository, and what it pushes is public at once. Commit pinning is what keeps another agent's push out of a review. Whether it can create tags or releases is **unverified**.

### Commit pinning, and when the head moves

**Spec; kept, with the spike's results added.**

- `submit_task` on a linked task records `commit_sha` on the submission, and it never changes. `verify_task` names the commit and fails with `commit_changed` if it differs from the submission's or from the latest observed head.
- **Before approval,** a moved head means the agent submits again, as a new numbered submission with its own commit.
- **After approval,** the merge names the reviewed commit as `sha`. **Verified:** GitHub answered `409` "Head branch was modified" after a new push, with and without a ruleset. The job records `merge.failed` with `commit_changed`, the task stays completed, and the requester or lead opens a follow-up task (decision 25).
- **The mark is per commit.** **Verified:** with the rule active, a new head had no status, and even the merge App got `405` until it marked that head. Podster's merge job marks only the commit of an approved submission, so a commit pushed after review got no mark and couldn't reach the default branch on the paths tried.
- **A moved base still merges in M5.** **Verified:** with the strict policy off, a merge went through after the base had moved. **Proposed:** the strict policy stays off in M5, and Podster records the base it observed at each merge and that it had moved. The result is a tree nobody reviewed as a whole, though every commit in it was reviewed or already merged. "Require branches to be up to date" is an open item: whether it does what the architecture asks, and how often it would force a follow-up task, is **unverified**.
- **Retries can't trust the merge call.** **Verified:** a second merge call on an already merged pull request returned `200` again. A retried job reads the pull request's state first, and takes "merged" from that read.

### The merge path

**Proposed: on the paths tried, only the merge App's token can update the default branch, and only with a commit the merge App marked.** GitHub's rules know nothing of a review. Whether a commit was reviewed, and by whom, is decided in Podster's Rust before the merge App marks anything. Two rulesets on the default branch, both created by the provisioning App at setup, as the [merge-restriction run](../../spikes/m5-github/README.md#results-merge-restriction)'s variant (c):

| Ruleset | Rules | Bypass | What it does |
| --- | --- | --- | --- |
| Review | `pull_request`, and `required_status_checks` for `podster/review` pinned to the merge App | No bypass actor | Held the agent's token and the merge App's token to a pull request whose head the merge App marked |
| Update | `update` | The merge App only (`Integration`, `always`) | Refused the agent's token on every update tried |

**Verified, once each, on a public repository on the Free plan, with the `merge` method only:**

- The agent's token, with the status already on the head, was refused merging the pull request (`405`), committing straight to the default branch through the contents API (`409`), and moving the branch's ref to the pull request's head (`422`).
- The merge App merged that same pull request (`200`).
- The merge App itself was refused merging a pull request whose head had no status (`405`), and committing straight to the default branch (`409`). So a bug in Podster's merge job can't put an unmarked commit on the default branch on these paths.
- Only those two tokens were tried. Organization owners, anyone else with admin rights, and `git push` weren't.
- **Limits of that run.** Its three variants ran in turn on one repository, so they aren't independent: each variant's rulesets were deleted before the next (`204`), and the run didn't list the rulesets to confirm none was left. It also had no control: the case without the update rule, where the agent's token merged a marked commit, is from an earlier run on another repository, also seen once.
- Bypass is per ruleset, not per rule. With one ruleset holding all three rules, the merge App bypassed the status and pull request rules too. That's why there are two.

**What this gives, and what it doesn't.**

- `merge_task` is the only path to the default branch on the paths tried. That's where Rust checks the review, the merge grant, the submitter rule and the agent's current standing.
- **The rules don't stop the merge App from marking a commit and then merging it.** Nothing on GitHub checks that a marked commit was reviewed. So the review-authority check stays in Podster's Rust, and the merge App's key and the code that uses it are what the boundary rests on.
- The M5 gate's token boundary and M5-06, "an agent's token can't merge to the default branch", hold on the paths tried.

**The merge job, proposed.** After Rust has rechecked authority:

1. It reads the pull request from GitHub: its base ref, its head repository's ID and its head SHA.
2. It refuses, with a reason code and no mark, unless the base is the linked repository's default branch, the head repository is the linked repository, and the head SHA is the approved submission's commit. An agent's token can edit a pull request, so none of the three is taken from an earlier read.
3. It sets `podster/review` on that commit and merges with that commit as `sha`, straight away.
4. It reads the pull request's merged state, and confirms the default branch contains the reviewed commit, before it records `merge.succeeded`.

The marked commit lets the agent's token merge nothing, on the paths tried, so when the status is set doesn't open a window.

**Rejected alternatives.**

1. **Mark at the moment of merge,** with the status rule alone. It leaves a window between the two calls in which the agent's token can merge the marked commit. The spike waited three seconds there. It narrows the gap and can't close it.
2. **Accept and observe an agent merging the exact reviewed commit.** A merge would then skip the merge grant, the submitter rule and the recheck of the agent's standing. A submitter could merge their own approved work, which the plan's question 4 forbids, and authority would rest on GitHub's rule alone.

**Not tried,** so not claimed: `git push` over HTTPS with either token; the squash and rebase merge methods; the `creation` rule; bypass modes other than `always`; organization-level rulesets; a private repository on a paid plan; and whether organization owners, or anyone else with admin rights, are held by the rules. Anything holding Administration write can change or delete a ruleset, as the spike's provisioning token did (`204`).

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
- **Delivery IDs are kept for 7 days,** proposed, then pruned by the room's alarm. A replay inside that time is refused. One after it costs a read and changes nothing, since state comes from the read. How long GitHub may redeliver is **unverified**, and the number is settled against it.
- **A cap on reads per repository,** proposed: at most 60 an hour for one repository, from deliveries and polling together, so one busy or attacked repository can't spend the shared budget. Reads over the cap are dropped and the next poll catches up. A merge job's own reads aren't capped.
- **Polling** repairs a lost delivery. **Proposed:** only tasks with a change that's submitted or approved and not yet merged are polled, backing off from 1 minute to 1 hour as decision 117 does for A2A, and ending when the change merges, closes or its task ends.
- **Verified:** 5,000 requests an hour for an installation. One installation serves every room, so that budget is shared. Whether it fits isn't worked out, and it has to be before step 5.
- **Checks with Actions off.** **Proposed:** M5 reports commit statuses and check runs from any source, each with its observation time. Nothing in a managed repository would produce one with Actions off, which is proposed and not currently true, so M5-12 is exercised on staging with a test status posted by a test App or token. Reading check runs and statuses with an App's token is **unverified**.

### Actions and workflows

- **Verified, once:** an agent's token without the Workflows permission got `403` pushing a workflow file.
- **Verified, once:** Actions were on in a new repository in `podsterdev` on 2026-11-10. So "Actions are off" isn't currently true anywhere.
- **Proposed, not currently true, and not tried:** Actions are off in every managed repository until a later decision. The provisioning App switches them off on each repository it creates, a repository setting, with its Administration permission. It reads the setting back, and a repository isn't ready unless it's off. A spike item. No App gets the Workflows permission.
- **Separate and optional:** switching Actions off for the whole organization. Only the owner can make that setting. That no App here can change it is untested; none holds an organization permission.
- **Unverified:** whether a workflow already in a repository can be abused, and whether disabling Actions also stops workflows on pull requests from forks. M6 will need its own decision before anything runs.

### Public repositories, forks and takedown

**All proposed.** The specs leave the fork design open, and this doesn't choose one.

- **A pull request from a fork is never a task change.** Podster links a pull request to a task only when the task's assigned agent names it in `submit_task`, Podster's own read shows its head is in the managed repository itself (the head repository's ID equals the link's), and its base is the default branch. The merge App never marks a commit for any other pull request.
- That stands in for "pushed with a Podster-issued token", which Podster can't see directly. It holds only while nobody but the three Apps and the organization's owner can write to the repository. So the organization has no other members, teams or outside collaborators, and adding one is the owner's decision.
- Pull requests from forks, issues and comments from strangers are ignored. They're never shown in a room and never read as instructions. Whether Podster closes them or turns those features off is open.
- **Takedown** follows [takedown.md](../legal/takedown.md). An operator action, decided in Rust like M4's suspension, sets the link to `suspended`, which stops token issuing and merge, and then makes the repository private. Archiving stops writes and leaves the content public, so it's the action for a room that's been removed, not for a takedown. Nothing is deleted.
  - **Unverified:** changing visibility or archiving through the provisioning App, what happens to an existing ruleset when a repository on the Free plan turns private, and what happens to forks made before. Copies others already made aren't recalled, as takedown.md says of everything.
  - **Proposed, and owner's yes for the text:** takedown.md covers public rooms today and says nothing of repositories. It must be extended to repositories, and its placeholder contact replaced by a real address, before any public managed repository exists outside staging. Both are legal text or a cloud change, so both are the owner's.

### Key rotation and compromise

- **GitHub's documentation:** an App can have up to 25 private keys, and more than one is how a key is rotated without downtime ([managing private keys](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/managing-private-keys-for-github-apps)). The page doesn't say how soon a deleted key stops working. **Unverified.**
- **Rotation, proposed:** the owner generates a second key for the App, sets it with `wrangler secret put` on the private API Worker, and it deploys. The architect checks that a token can be minted with it. The owner then deletes the old key on GitHub. The webhook secret rotates the same way, with the gateway accepting the old and new secrets for a stated overlap.
- **A leaked merge key** can mark and merge any commit in any managed repository. It can't change settings.
- **A leaked agent-token key** can push to any branch but the default one in any managed repository, and open or edit pull requests. It can't change rules, mark a commit or merge, on the paths tried.
- **A leaked provisioning key** can remove the rules, add a bypass actor and delete repositories in every managed repository (**verified** that the spike's provisioning token did each: `204`, `201`, `204`), and by its permission change visibility. With the rules gone it can do anything.
- **Response, proposed:** the owner deletes the key and sets a new one. Token issuing and merge stop for every room while that happens. Tokens minted with the leaked key can live up to an hour, and Podster can't revoke tokens it doesn't hold. Suspending the installation may cut that short, and is **unverified**. Afterwards a job reads every managed repository and compares it with what Podster last recorded: that it still exists, its visibility, both rulesets and their bypass lists, and the default branch's head. Each difference is recorded as an observation and shown to the room's owner and the operators.
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
| Organization and installation selection | Architecture | Proposed: trusted configuration. The owner named `podsterdev`, which serves staging. Whether production shares it is open, for the architect, before any production deployment |
| One App or two; separate App permissions | Architecture, plan question 2 | Proposed: three, with the table above. Verified as a set, once, on `podsterdev`; whether less would do is unverified |
| Installation access to a new repository | Architecture | Verified, once, for three Apps, and on both earlier runs for two |
| Provisioning request and state contract | Architecture | Proposed |
| Naming and visibility | Architecture, plan questions 3 and 11 | Name proposed. Public as a working assumption; private needs the owner's yes for a paid plan |
| Initialized base and protection readiness | Architecture | Proposed: both rulesets, the bypass list and Actions read back, failing closed, on a schedule and before each merge. The ruleset read-back is verified, once, with the provisioning App's token. Switching Actions off per repository and reading that back is proposed and not tried |
| Unknown-outcome recovery; provisioning failure | Architecture | Proposed: an unknown outcome is a failed setup, never adopted by name. Adopting an orphan by a marker is left open |
| How agents get repository access (scope, issue, renew, revoke) | Decision 10 | Proposed, with the token held sealed for revocation. The secret is the owner's |
| Commit pinning and a moved head | Architecture | Kept. Strict policy off in M5; "require up to date" left open |
| The merge path | Spike | Proposed: two rulesets, and a merge job that re-reads the pull request before it marks |
| Merge method | Plan question 6 | Proposed: merge commits, changing the plan |
| How commits attribute agents | Architecture, plan question 7 | Left open, with an interim proposal |
| Webhooks and polling | Architecture, plan step 5 | Proposed. All unverified |
| Checks with Actions off | Criterion 7, M5-12 | Proposed: statuses and check runs from any source |
| Where state lives | Plan step 2 | Kept |
| Key rotation and compromise | Plan's threat model | Proposed. Runbook owed |
| Actions and workflows | Plan's threat model | Proposed: disabled on each repository by the provisioning App. Not currently true, and not tried |
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
- **"Reconciliation finds the repository by its recorded identity ... and no second repository is made"** (M5-03) can't both hold when the creation call's answer is lost, because then no identity was recorded. This ADR keeps "never by name" and gives up "no second repository": a retry uses a new name. The plan's M5-03 now says so.
- **The spike's README** said to delete the test organization once this ADR is accepted. The owner has since said `podsterx` no longer exists, and the README now says its state was unconfirmed.

## Consequences

- **Code in a Git-enabled room is public** while the organization is on the Free plan, including for a private room, and including unreviewed task branches from the moment they're pushed. Setup has to say so plainly.
- **Every merge goes through `merge_task`** on the paths tried, and Podster still records any merge it didn't make.
- **Podster holds a bearer token** for up to an hour, sealed, which it never did before.
- **Each installation's rate limit is shared** by every room.
- **No checks would run** in a managed repository with Actions off, so M5's check reporting is shown with a test status. Actions being off is proposed and not currently true.
- **A leaked provisioning key is the worst case,** and no split softens it. Three Apps keep that key out of the token-issuing path.
- **The private API Worker holds every key.** Its compromise is the compromise of all three Apps.
- **An unknown creation outcome can leave an orphan repository** that only the owner removes.
- **Proposed: `podsterdev` holds staging's repositories** through M5. Everything M5 proves from here would be proved there, and test repositories would sit beside real ones if production later shares it.

## What needs the owner's yes

- **Confirming the scope of "i'm okay with having public repo.. this will be an MIT project".** **Confirmed by the owner on 2026-11-11:** "okay with public repo, MIT project". The architect reads it as confirming both that managed repositories may be public and that Podster's own code is MIT-licensed.
- **Public managed repositories on staging.** That they may be public is confirmed by the owner's words of 2026-11-11 above. Still owed: the words don't switch `MANAGED_REPOSITORIES` on or set the Apps' keys, and takedown.md's staging exception of 2026-11-10 covers `PUBLIC_ROOMS`, not repositories, so the takedown process for public repositories still needs the owner.
- **A paid GitHub plan** for private managed repositories. It costs money.
- **The three Apps' secrets.** The Apps exist in `podsterdev` since 2026-11-10, created by the architect after the owner said "you can create the app there". Setting each private key on the private API Worker, and the webhook secret, is the owner's.
- **Any change to an App's permissions.** None is proposed.
- **The token-sealing secret:** a 64-hex key on the private API Worker only, as `A2A_TOKEN_KEY` is.
- **Legal terms and ownership of `podsterdev`,** and of what's pushed to its repositories. Possibly a lawyer.
- **The takedown contact,** which is still a placeholder, and extending takedown.md to repositories, before any public managed repository exists outside staging.
- **Disabling Actions for the whole of `podsterdev`,** which is optional beside the per-repository proposal, and keeping the organization free of other members.

Not the owner's, and listed so it isn't lost: **the architect** must settle, before any production deployment, whether staging and production share `podsterdev` or get separate organizations or Apps.

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
- **Whether any App would work with less than it holds,** and read access for checks and statuses.
- **Three Apps together, beyond the one run:** it was seen once, on one public repository, with the `merge` method and no `git push`. The agent-token App's full installation token wasn't tried on the agent's ordinary work or on a second repository.
- **Switching Actions off on a repository with the provisioning App's token, and reading that back.** A spike item. The repository's setting was read once, with Actions on, and the organization's setting couldn't be read. Reading rulesets and bypass lists back on a private repository.
- **Adopting an orphan repository by a marker** after a lost creation answer. A spike item.
- **Classic branch protection** on a private repository on the Free plan.
- **How long GitHub may redeliver a webhook.**
- **The state of `podsterx`,** which the owner said no longer exists and GitHub's API still showed just after.
- **Everything the spike saw was seen once or twice,** on two Free organizations, on one day. The two-ruleset result was seen once, after two other variants on the same repository, with no check that their rulesets were gone and no control in the same run.

## Cloud resources this needs

- **GitHub:** `podsterdev` exists, on the Free plan, with the three staging Apps and no repository left from the spike. Whether production needs its own organization or Apps is open. A paid plan only if the owner wants private repositories.
- **Cloudflare:** nothing new and billed. Durable Object state through the room's forward-only migrations, at most a projection table in the existing D1 database, one route on the existing gateway, and the existing outbox.
- **Secrets:** three App keys and the token-sealing key on the private API Worker, and the webhook secret on the gateway. The owner sets each.
