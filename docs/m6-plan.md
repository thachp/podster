# M6 plan

**Status, 2026-11-10 UTC: Proposed. Nothing here is approved or built.** The architect drafted this plan from the specs while the owner was away. No ADR, spike, contract, migration, code or cloud resource exists for M6. Its [questions](#questions-for-the-architect) carry the architect's proposed answers, which aren't recorded as decisions in `PRODUCT.md`. Items marked **owner's yes** create an account or a cloud resource, cost money, set a secret, are legal text, or loosen a security stance, so the architect can't settle them alone. Nothing about Cloudflare's or GitHub's behaviour in this plan is verified; [How far this was checked](#how-far-this-was-checked) says what was read.

It covers [M6 Release](spec/PRODUCT.md#product-direction-and-delivery-scope), which the milestone table gives one line: "Workroom-level deployment, separate content domain, custom domains". Its gate in that table is "Expanded criteria 7 and 8" of the [expanded workroom acceptance criteria](spec/PRODUCT.md#expanded-workroom-acceptance-criteria). It starts from the [release and deployment design](spec/ARCHITECTURE.md#release-and-deployment-m6), which is four bullets and two record shapes, and from [decision 11](spec/PRODUCT.md#decisions-needed), which is a recommendation and not decided.

M6 is the first time Podster serves code and markup that agents wrote, to anyone on the internet, from infrastructure Podster pays for. So the plan settles where that content is served, what it can reach and who can stop it before any feature code.

## What the specs say, and where they are thin

Everything in this section is quoted or linked. The rest of the plan is the architect's proposal built on it.

- **Milestone row:** "Workroom-level deployment, separate content domain, custom domains", gate "Expanded criteria 7 and 8" ([PRODUCT.md](spec/PRODUCT.md#product-direction-and-delivery-scope)). "M5 and M6 can ship later for engineering rooms."
- **Core job 8:** "an engineering workroom can use a Podster-managed repository and an optional Cloudflare deployment workflow, configured once at workroom level."
- **[Review, merge and optional Cloudflare deployment](spec/PRODUCT.md#review-merge-and-optional-cloudflare-deployment):** deployment is a workroom-level option with a default URL and optional custom-domain mapping. A human owner or admin configures it once, and a DevOps role can propose settings. "Deploy releases the merged version only when the workroom's configured release policy allows it. Record commit, environment and result separately from task completion." Failures are reported accurately, for example "Merged, deployment failed". The same section says: "Release environments, approval policy, retry/rollback behavior, branch protection, credential handling, custom-domain validation and budget controls are unresolved implementation requirements."
- **Scope boundary:** workroom-level deployment needs "Hosting model, separate content domain, budget and approval policy" before it ships ([PRODUCT.md](spec/PRODUCT.md#target-product-not-in-the-coordination-kernel)).
- **Capability:** `deploy_release`, "only for an agent with explicit delegation" ([proposed extension capabilities](spec/PRODUCT.md#proposed-extension-capabilities)). The name is proposed.
- **Decision 11**, a recommendation: "Podster's isolated platform with budget caps first; customer account later".
- **Decision 164**, "Decided, for the owner to review": the content domain "stays in M6". Decision 52, decided: M2 is download only, "so no content domain is needed yet".
- **[Content and deployment origins](spec/ARCHITECTURE.md#content-and-deployment-origins):** deployed apps and previews "must never share a site with the application". They use a separate registrable domain, which "must be on the Public Suffix List", with a distinct subdomain per room. "`*.podster.dev` must not host this content." Uploaded HTML and SVG never share a room's app origin.
- **[Release and deployment (M6)](spec/ARCHITECTURE.md#release-and-deployment-m6):** the `release_config` and `release` shapes; Workers for Platforms "fits the proposed Podster-hosted default", each room's app a user Worker in an untrusted dispatch namespace "with no bindings to Podster's own data"; a merge may start a release only if `release_config` allows it and "the release job's authority recheck passes"; each attempt is its own record tied to an exact commit; "Task completion never implies deployment". Custom domains need proven ownership, and "An M6 spike must validate the Cloudflare custom-hostname flow; it is not yet verified for this design." Open for the ADR: "where builds run, secrets for deployed apps, rollback, budgets and quotas, abuse takedown, and account limits."
- **[ACCESS-CONTROL.md](spec/ACCESS-CONTROL.md#proposed-permission-matrix):** deployment authority is a separate delegation from the external resource owner. The rows "Grant repository/deployment access" and "Merge/deploy" apply, with AC-05, AC-10, AC-11, AC-13, AC-16 and AC-17. "Queued inbox deliveries, retries and delayed release jobs must recheck relevant authority before disclosing content or making an external change."
- **[DESIGN.md](spec/DESIGN.md#release-stages):** the deployment labels (Off, Waiting for merge, Waiting for approval, Deploying, Live, Deployment failed), the Release panel, the merge-consequence confirmation, release approvals in Needs attention, Release in room settings, and UI-02.
- **[ADR 0009](adr/0009-managed-repositories.md#actions-and-workflows):** proposes GitHub Actions off in every managed repository, and says "M6 will need its own decision before anything runs." M5's `get_task_release_status` "reports that no release exists; M6 adds releases" ([M5 plan, step 8](m5-plan.md#build-order)).
- **`RUNNER.md`, `CONTRIBUTORS-AND-LIMITS.md` and `TASK-PLANNING.md`** add no M6 scope. Each says only that its subject grants no deploy right (R-14, R-34; pricing and model labels; planning edges), and that progress counts reviewer-approved tasks, not deployed ones.

**Where the specs are thin.** They don't say what a release is made of, where a build runs, what an environment is, what the approval policy's values are, who may see a deployed app, what the budget caps are, or what the "documented policies" in criterion 8 are for custom domains, export or transfer and release approvals. No such policy document exists. This plan proposes each and marks it.

## Where earlier milestones stand

M6 is planned while three earlier gates are open. None blocks M6's planning or its spikes.

- **M3's gate** isn't called. It waits on the owner's approval of fasta2a and the compatibility kit. **2026-11-11:** the owner called it met, accepting local runs for outbound to LangGraph, fasta2a, `CancelTask` delivery and the Python client ([decision 193](spec/PRODUCT.md#decisions-needed)).
- **M4's gate** isn't called. `PUBLIC_ROOMS` is on for staging. The staging run of 2026-11-10 ended 102 passed, 3 failed, 0 skipped, 6 owed ([M4 plan](m4-plan.md#abuse-review-draft-step-14)). The fixes merged as [#236](https://github.com/thachp/podster/pull/236); the lead session reports them deployed, which this plan didn't check. A rerun is owed.
- **M5** has built no agent-facing behaviour. [ADR 0009](adr/0009-managed-repositories.md) is on `main` as a proposal, the spike ran, and three staging GitHub Apps exist in `podsterdev`. Step 2 merged on 2026-11-10 as [#238](https://github.com/thachp/podster/pull/238): the room's state and one read of it for people, with no agent capability and no call to GitHub. `get_repo_access`, `merge_task` and `get_task_release_status` join the contract in M5's steps 6, 7 and 8.
- **A correction to the M5 plan as it stands on `main`:** its "Where M3 and M4 stand" still says M4's staging run hasn't happened and that the test operator isn't in `OPERATORS`. The M4 plan records the run, and the lead session reports the operator set. This PR doesn't edit the M5 plan.

Contract and migration PRs merge one at a time, so M6's step 2 waits until every M5 contract or migration PR has merged: M5's step 2 at the least, and any later M5 PR that changes a contract or adds a migration.

## What M6 includes

**Proposed**, as the architect's reading of the lines above.

- **Release as a room setting:** an owner or admin of an Engineering room with a ready managed repository switches deployment on, once, under a deployment delegation. Off is the default, and off publishes nothing.
- **A release record per attempt:** each names the exact commit, the environment, who asked, the state and the result, kept apart from the task's state and from the merge's.
- **A release of merged code only:** a release is made from a commit that Podster's own merge put on the default branch. Nothing unreviewed is deployed.
- **Hosting on Podster's platform:** the room's app runs in an untrusted Workers for Platforms dispatch namespace, with no binding to Podster's data, as the architecture proposes.
- **Static files only, as a working assumption:** a release is files a browser loads, with no agent-written code on the server. This narrows core job 8's "working web application", so it is the **owner's** to confirm (question 5).
- **A private room's app isn't served to anyone who can't already see the room,** as the working assumption until the owner answers question 11. How to serve it to the room's own people without a Podster session on the content domain isn't designed, so until it is, a private room's app isn't served at all.
- **The content domain:** a separate registrable domain, on the Public Suffix List, with one host per room. Nothing agent-written is served from `podster.dev`.
- **Custom domains:** a room's owner maps a hostname they have proven they control. One hostname belongs to one room.
- **Approval:** a release policy says whether a merge starts a release by itself or a person approves each one.
- **`deploy_release`** for an agent that holds an explicit deployment grant, and the same command for a person.
- **Status:** `get_task_release_status` gains the release, beside checks and merge, each with its own time, including failure.
- **Limits and a stop:** budget caps per room, an owner's off switch that unpublishes, and an operator's suspension.
- **Screens:** Release in room settings and setup, the deployment stage on a task's Release panel, and release approvals in Needs attention.
- **Written policies** for custom domains, release approvals, and export or transfer, since criterion 8 says they must pass "their documented policies" and none is written.

Not in M6: a way for a DevOps role to propose release settings through Podster. The spec says "a DevOps role can propose its settings", and no command, state or screen for a proposal is designed. In M6 such an agent can only say what it suggests in a task thread, which is data, and the owner or an admin configures release. A proposal command is left for a later design, because it would let agent-written text become configuration by one click.

Also not in M6: a customer's own Cloudflare account, a build service, secrets or bindings for deployed apps, previews of unmerged code (the owner's to confirm, question 7, since `PRODUCT.md` names a "preview/live URL"), previews of uploaded files, a provider other than Cloudflare, Runner (M7), and anything in production. M6 ends on staging, like M1 to M5.

## The gate

From the specs. Nothing may say release works until all of these pass on staging:

- **Expanded criterion 7, the deployment half:** "Disabled deployment publishes nothing; enabled deployment reports checks, merge and release independently, including failure." The repository half is M5's gate, and M6's gate needs M5's to have passed.
- **Expanded criterion 8, all of it,** as the milestone table gives it to M6: "Custom-domain and export/transfer behavior, upload permissions, retention, abuse controls and release approvals pass their documented policies before launch." M6 builds the custom-domain, export or transfer and release-approval parts, and abuse controls for deployed content. Upload permissions and retention were shown at M2's gate and public-room abuse controls are M4's gate, which isn't called. **Proposed, and the owner's to confirm (question 24):** M6's gate reruns the M2 and M4 staging scripts at the gate's commit, so those three parts are shown again and not taken on trust.
- **Expanded criterion 3, for deployment:** claiming a role grants no deploy right.
- **Access tests** that name deployment, on a deployment: AC-05 for provider-resource and environment IDs, AC-10, AC-11, AC-13, AC-16 for a provider's refusal, and AC-17.
- **The origin boundary, shown on staging:** content on a room's host can't read or set a cookie for the application, since it is on another registrable domain, and the application never serves agent-written markup. **Ruled by the architect:** the gate doesn't wait for browsers to ship the Public Suffix List entry. M6 must be safe without it: Podster sets no cookie and accepts no credential on any app hostname, and nothing security-relevant relies on the entry. Until browsers ship it, one room's app can set a cookie that another room's app reads. That is recorded as a known gap, and the entry is defence in depth.
- **UI-02:** "Merged · Deployment failed", never live.
- **M6's own tests,** [below](#acceptance-tests).
- **A security review** of the built system against the [threat model](#threat-model), with the result written into this plan.

The architect proposes the gate call, for the owner to review.

## What M6 needs from earlier milestones

| M6 needs | From | Status on `main`, 2026-11-10 |
| --- | --- | --- |
| The revocation fence, the outbox and its jobs, idempotency | M0 | Built |
| Owner and admin authority, Manage access | M1 | Built |
| `crates/egress` for every outbound call | M0 | Built |
| Operators, reports and suspension, extended to a room's app | M4 | Built; gate not called |
| `repo_link` and `provider_grant` as room state | M5 step 2 | Merged, #238 |
| Grant checks in `crates/core` and `crates/policy` | M5 step 3 | Not built |
| A ready repository link | M5 step 4 | Not built |
| A merge that Podster made and confirmed, with its commit | M5 step 7 | Not built |
| `get_task_release_status` | M5 step 8 | Not built |
| The task's change and merge panel | M5 step 9(b) | Not built |
| Nothing from M3 | | A protocol gives no deploy authority (AC-18, AC-24) |

## Build order

**Proposed.** Each step is one PR unless it says otherwise. Steps 2 onward wait for step 1's ADR and spikes.

| Step | What | Needs from M5 | Notes |
| --- | --- | --- | --- |
| 1 | **ADR 0010, the release policies and the spikes.** The ADR settles everything the architecture leaves "open for the ADR": where builds run, secrets, rollback, budgets, takedown and account limits, plus what this plan's questions leave open. Three short policies are written beside it: custom domains, release approvals, and export or transfer. The spikes answer the [risks](#risks-to-test) and stay in `spikes/`. | None | The spikes need a domain, a Cloudflare add-on and a token, each the owner's yes. The ADR and the policies can be drafted without them. |
| 2 | **M6's contracts, migrations and the new Durable Object class, in one PR, apart from the two agent-facing pieces named at the end:** `release_config`, `release` and the room's hostname request as room state; the new hostname-claim Durable Object class and its migration; and in `openapi.yaml` the person routes for configuring release, approving a release and mapping a hostname, and step 9's routes: an operator's suspend and lift of a room's app, and a report that names an app. The room's Durable Object owns the configuration and the records, because they are authority. The hostname claim is a separate object; [question 10](#questions-for-the-architect) says how the two commit. D1 gets at most a projection for lists, which never authorizes. | Every M5 contract or migration PR merged, step 2 at the least | One contract and migration PR at a time. Alone and first. **Two exceptions, from the architect's ruling at M5's step 2:** no agent sees a merge or deploy tool before its path and checks exist, and `e2e/journey.mjs` asserts it (AC-17). So `deploy_release` joins `capabilities.yaml` with step 6, and the release fields join `get_task_release_status` with step 7, which can't come before M5's step 8 creates that capability. Each is a contract change that merges alone. |
| 3 | **Decisions in `crates/core` and `crates/policy`:** who may configure release, the deployment grant check, the release state machine, the approval policy, which commit is releasable, the caps, and the hostname rules. Pure, with no I/O. | Step 3, for the grant check it extends | AC-10, AC-11 and AC-17's deploy half are decided here. |
| 4 | **The content Worker and domain:** a new public Worker, proposed as `apps/content`, on the content domain only. It maps a hostname to a room's app in the dispatch namespace and adds fixed response headers. It has no binding to the gateway, the API, D1 or R2. | None | **Security-sensitive.** A new public surface that serves agent-written content. Needs the domain. |
| 5 | **The release job:** an outbox job that rechecks authority, reads the release's files from the repository at the exact merged commit, checks them against the caps, uploads them, confirms what is being served, and records success or failure. An unknown outcome is recorded as uncertain and reconciled by reading the platform, never assumed. | Steps 4 and 7 | **Security-sensitive.** It holds the credential that publishes. |
| 6 | **Triggers and approvals:** `deploy_release`, a release started by a merge when the policy allows, approval by a person, rollback as a new release of an earlier released commit, and switching deployment off, which unpublishes. | Step 7 | **Security-sensitive.** This is where "task completion never implies deployment" holds or doesn't. Adds `deploy_release` to the contract, alone in its turn. |
| 7 | **Status:** `get_task_release_status` reports the release beside checks and merge, each with its observation time. | Step 8 | Small. Adds the release fields to the contract, alone in its turn. |
| 8 | **Custom domains:** proof of control, the hostname claim, routing and removal. | None | **Security-sensitive.** A wrong claim serves one party's content on another's name. |
| 9 | **Limits, suspension and takedown:** the caps enforced, an operator's suspension of a room's app, and a report that names a deployed app. | None; M4's operators | Extends decision 158's operator powers (decided, for the owner to review), which is a question below. Its routes are in step 2. |
| 10 | **Screens**, in two PRs: (a) Release in room settings and setup, with its *Not configured*, *Needs approval* and *Ready* states and the custom domain; (b) the deployment stage on the task's Release panel, the merge-consequence confirmation, and release approvals in Needs attention. | (b) needs step 9(b) | Unavailable grants show as unavailable. A preview or live link shows only when real for this commit. |
| 11 | **Staging run and security review,** then the gate call. | M5's gate | A script against staging with test people. |

**Side by side.** After step 2: steps 3, 4 and 10(a). After steps 2 and 4: steps 8 and 9. Steps 5, 6 and 7 follow in that order.

**What doesn't wait for unfinished M5 behaviour:** step 1; and, once step 2 has merged, step 4, exercised with a test app a script uploads; step 8; step 9's suspension; and step 10(a). Step 2 waits only for M5's contract and migration PRs to merge. Steps 3, 5, 6, 7 and 10(b) each wait for the M5 step named.

**Deeper review.** Steps 4, 5, 6 and 8 are security-sensitive and each should get a review deeper than the quick diff review. No decision covers that for M6, so each deeper review is asked before it runs.

## What needs the owner's yes

- **A content domain.** A new registrable domain, bought and added to the Cloudflare account, used for nothing else. Money, a cloud resource and DNS. Its name is the owner's choice; `podsters.io` in the mockups isn't a decision.
- **A Public Suffix List entry for it.** A public request to a third party under Podster's name, slow to undo, with that list's own rules. The owner's, because it is outward-facing.
- **Workers for Platforms.** A dispatch namespace needs a Cloudflare add-on that is believed to be billed monthly. Unverified, and nothing has been bought.
- **Custom hostnames (Cloudflare for SaaS)** on the content zone. May be billed per hostname. Unverified.
- **Whether hosted apps live in the Cloudflare account that holds `podster.dev`, or in a second account.** A second account is an account creation; one account puts the publishing credential beside Podster's own Workers. See question 3.
- **A new public Worker, `apps/content`,** routed on the content domain. A new cloud resource and a new public surface.
- **A Workers KV namespace** for the content Worker's hostname map.
- **A new Durable Object class** on the private API Worker, for hostname claims. It deploys with step 2's migration.
- **A fourth GitHub App, read-only,** for the release job (question 6). The owner creates and installs it and sets its key.
- **Who may open a private room's app** (question 11). Serving it to anyone with the address loosens private-room visibility, so the architect can't decide it. Until the owner answers, it isn't served to anyone who can't already see the room.
- **Static files only** (question 5). It narrows core job 8's "working web application", and with question 7 it drops the preview URL that `PRODUCT.md` names. The narrowing is the owner's to confirm, as much as its alternative.
- **Which reading of criterion 8 the gate uses** (question 24).
- **Secrets:** the Cloudflare API token that uploads to the namespace and manages custom hostnames. The owner creates it, with the scope the architect names, and sets it with `wrangler secret put`. The read-only App's private key is set the same way.
- **Who pays, and the caps.** Decision 11's "who pays" is the owner's. On staging Podster pays. The caps in question 12 are proposals.
- **Agent-written content served publicly on staging.** A new exception of the same kind as `PUBLIC_ROOMS`. `takedown.md`'s staging exception covers public rooms only.
- **Legal text:** terms, acceptable use and takedown extended to deployed content and custom domains. May need a lawyer.
- **Export and transfer.** ADR 0009 left repository transfer and deletion to the owner, with the managed organization's ownership and legal terms. M6's policy can't settle them alone.
- **A real domain for the custom-domain test,** or a zone the test script may edit. See M6-14.
- **Any looser alternative** in the questions below, notably server code in a deployed app, previews of unmerged code, and GitHub Actions as the build.
- **Each deeper security pass.** None is agreed for M6 yet; each is asked before it runs.
- **The gate call's review,** and anything in production.

## Cloud resources

**The proposal needs new billed resources, more than any earlier milestone.** This plan creates none.

- **A domain,** registered and on Cloudflare, with a wildcard DNS record and a wildcard certificate for the per-room hosts. Billed yearly.
- **A Workers for Platforms dispatch namespace** for staging. Believed billed. One namespace for staging; whether production gets its own is for before production.
- **A new Worker,** `apps/content`, routed on the content domain only. Believed not billed by itself on Workers Paid. **Owner's yes.**
- **Custom hostnames** on the content zone, for step 8. Possibly billed.
- **A hostname-to-app map** for the content Worker. **Proposed:** a Workers KV namespace the private API writes and the content Worker only reads. It routes; it never authorizes. A new resource, small. **Owner's yes.**
- **Durable Object state** for `release_config`, `release` and the room's hostname through the room's own forward-only migrations, and a new Durable Object class for hostname claims (question 10), which is the **owner's yes**. At most a projection table in the API's existing D1 database.
- **Secrets:** the Cloudflare API token, on the private API Worker only. The content Worker and the gateway hold none.
- **GitHub:** a fourth App in `podsterdev`, with Contents read and Metadata read only, for the release job (question 6). **Owner's yes.** No existing App's permissions change.
- **Possibly a second Cloudflare account** (question 3).

## Acceptance tests

**Proposed.** Each runs from a script against staging, with test people and staging's organization, `podsterdev`. The owner won't run checks by hand, so a check that can't run that way is recorded as a gap. "The host" means the room's default host on the content domain.

| Test | What it shows |
| --- | --- |
| M6-01 | With deployment off, approving and merging a task creates no release record and the room has no host. That nothing is in the namespace is evidenced by a not-found answer from the content domain; a script can't list the namespace without a credential. `get_task_release_status` reports deployment as off (criterion 7). |
| M6-02 | An owner without the deployment delegation can't switch deployment on (AC-10). On staging the evidence is the refusal, an unchanged `release_config`, no release record and the room's denial record. **A gap on staging:** that no request reached Cloudflare can't be observed from a script. It is shown locally, in a test whose provider stub counts calls. |
| M6-03 | Someone who holds a deployment grant but isn't the room's owner or admin can't change `release_config` (AC-11). An agent can't, whatever its role is called (AC-03). |
| M6-04 | With deployment on and the policy allowing it, a merge by a person who holds both grants creates one release for the merged commit. It reaches live, and the host serves a marker file whose content is that commit. |
| M6-05 | A completed, merged task with no deployment grant behind it deploys nothing. `deploy_release` from a person or agent without the grant is denied. An agent with the grant succeeds (AC-17, criterion 3). |
| M6-06 | Where the policy needs a person, a release waits, shows as waiting for approval, and starts only after a person with the grant approves it. An agent can't approve. |
| M6-07 | A commit with no release directory, or one over a cap, ends as a failed deployment with a reason code. The task stays completed, the merge stays merged, and the host keeps serving the earlier release (UI-02). |
| M6-08 | Checks, merge and release are reported separately, each with its time, across these combinations: failed check and no merge; merged and deployment failed; merged and live. |
| M6-09 | `deploy_release` naming a commit that isn't on the default branch through Podster's merge, a task branch's head, another room's repository, or another environment is refused (AC-05, AC-10). |
| M6-10 | A release is queued, then the requester's grant is removed, or the requester is revoked, or deployment is switched off. The job refuses and uploads nothing (AC-13). |
| M6-11 | A repeated request with the same idempotency key creates one release. A job retried after a lost answer leaves one deployment. An unknown outcome is recorded as uncertain and settled by reading what is served. |
| M6-12 | A page on room A's host can't read or set a cookie for the application or for room B's host, in a scripted browser. No response from the content domain sets any cookie, a request carrying a Podster cookie or an `Authorization` header gets nothing more than one without, and no content host is under `podster.dev`. **A known gap, which the gate doesn't wait for:** room A's app can set a cookie room B's app reads until browsers ship the Public Suffix List entry. The script records which it saw. |
| M6-13 | A deployed app answers only `GET` and `HEAD`, with the fixed headers, and runs no agent-written code on the server. Stated for question 5's proposal; it changes if server code is allowed. |
| M6-14 | A custom hostname routes only after its proof of control passes. Without proof it doesn't route. Removing the mapping stops it. **A gap unless** the script has a domain whose DNS it may edit. |
| M6-15 | A custom hostname that is `podster.dev`, the content domain, a subdomain of either, an IP address, or already claimed by another room is refused. Two rooms racing for one hostname leave one claim. |
| M6-16 | Switching deployment off unpublishes: the host answers not-found within a stated time, and the release records are kept. |
| M6-17 | Rolling back creates a new release of an earlier released commit, under the same grant and approval, and the host serves that commit. |
| M6-18 | The caps hold: an oversized release, too many files, and too many releases in a day are each refused with a reason code. |
| M6-19 | An operator suspends a room's app: the host stops serving, the owner can't switch it back on, and lifting the suspension restores it. A report can name a deployed app. Needs a test operator in staging's `OPERATORS`; the lead session reports one has been set there since 2026-11-10, for M4's run, which this plan didn't check. Without one this is a gap. |
| M6-20 | Archiving a room stops its app from serving. |
| M6-21 | A client-supplied account, namespace, app name or host label is ignored or refused. |
| M6-22 | Logs from every Worker during the run hold IDs and reason codes only: no token, no file content, no hostname. **A gap on staging unless** the session running the script already has Cloudflare access to read the Workers' logs; a script alone can't. Locally, the test run's captured logs are checked. |
| M6-23 | A private room's app answers not-found to a request from outside the room, as the working assumption for question 11. Its host can't be derived from its ID or name, and nothing about its release appears on any public page or in Explore. |
| M6-24 | Export and transfer behave as their written policy says. As proposed: a release names its repository ID and commit, so what was released can be fetched from the repository, and no transfer route exists. |
| M6-25 | The task Sheet shows Live only when a release record for that commit is live, and shows "Merged · Deployment failed" for M6-07, in a scripted browser. |

## Threat model

**Draft, to be walked against the built system at step 11.** "Unverified" means nothing has tested it. "From M5's spike" means the M5 spike saw the GitHub half once; the M6 half is still unverified.

| Threat | Proposed mitigation | Verified? |
| --- | --- | --- |
| A deployed app reads or sets the application's cookies, or another room's | A separate registrable domain, one host per room, nothing under `podster.dev`, and no cookie set and no credential accepted by Podster on any app hostname. That protects the application without the Public Suffix List entry. Between rooms, the entry is defence in depth: until browsers ship it, one room's app can set a cookie another's reads, a known gap. A sandboxing Content Security Policy on every response is a candidate for ADR 0010 | Unverified. Browsers' uptake of a new list entry is outside Podster's control |
| A deployed app reaches Podster's data | The app has no bindings. The content Worker has none to the gateway, the API, D1 or R2 | Unverified. The architecture cites Cloudflare's isolation page; nothing was tried |
| Agent-written server code calls out, mines or attacks from Podster's account | Static files only in M6 (question 5), so no agent-written code runs on Cloudflare | Unverified, and gone if server code is allowed |
| Unreviewed code is deployed | Only a commit that Podster's merge job put on the default branch and confirmed there is releasable, checked in Rust and rechecked by the job, which reads the files at that exact commit | From M5's spike for the merge path. Unverified for the release |
| An approved or merged task deploys with no deployment authority | Deployment needs its own grant and the room's policy, checked in Rust at the command and again in the job. Approval and merge grant nothing (AC-17) | Unverified |
| A stale job deploys after revocation or after deployment is switched off | The job rechecks current authority and the current `release_config` version before its external call (AC-13) | Unverified |
| The publishing credential leaks, or is used on the wrong target | Held by the private API Worker only, scoped as narrowly as Cloudflare allows, with the account, namespace and app name from trusted configuration and server-generated names. A second account if the scope can't exclude Podster's own Workers | Unverified. The token's narrowest scope isn't known |
| A client steers a release to another account, namespace or app | None of those is accepted from a client (M6-21) | Unverified |
| Someone maps a hostname they don't control, or takes over one whose DNS was left pointing at Podster | Proof of control before routing, one claim per hostname owned by a single object, the proof rechecked on a schedule, and routing removed when it fails or the mapping is removed | Unverified. The custom-hostname flow is the spike the architecture asks for |
| A custom hostname is Podster's own name or another room's host | Refused in `crates/core` (M6-15) | Unverified |
| Podster hosts phishing, malware or illegal content written by an agent | Deployment is off by default and switched on by a person; releases are of reviewed, merged commits; a person approves each release in a public room; operators can suspend an app; reports can name one; the terms cover it | Unverified. The legal text isn't written |
| A deployed app imitates Podster's sign-in | A different registrable domain, a server-generated host label that never contains a room's or Podster's name, and operator suspension | Unverified |
| A deployed app runs up Podster's bill | Caps on a release's size and file count, releases per day and one app per room; static files only; platform limits if the spike finds them | Unverified. No platform limit has been tried |
| A private room's existence or work leaks through its host | Working assumption until the owner answers question 11: a private room's app isn't served to anyone who can't already see the room. Also a random host label and nothing about a release on public pages. An address still leaks by itself: through the `Referer` header on links out of the app, answered with `Referrer-Policy: no-referrer` on every response; through certificate-transparency logs, which publish a custom hostname when its certificate is issued, and a per-room certificate would do the same for a default host, so the default hosts use one wildcard certificate; and through browser history and sync, which Podster can't prevent. So an unguessable address is never the control | Unverified |
| A lost answer from Cloudflare leaves the record and the served content disagreeing | An uncertain state, settled by reading back what is served and comparing it with the release's commit | Unverified |
| A deployed app keeps running in a visitor's browser after it is unpublished or suspended, from a service worker or a cache | The content Worker refuses requests for a service-worker script, so none is registered from a room's host; responses carry short cache lifetimes; and the not-found answer after an unpublish or a suspension carries `Clear-Site-Data`. A visitor who never returns keeps what they have | Unverified |
| A forged or replayed event starts a release | A release starts only from a command or from Podster's own recorded merge, never from a webhook observation alone | Unverified |
| Repository content is treated as instructions | The job copies files and reads no configuration from them beyond a fixed directory name. Agent content is data | Unverified |
| A failed release is shown as live | Each attempt is its own record; live is set only after the job confirms what is served (UI-02) | Unverified |
| A workflow in the repository deploys by itself | Actions stay off, as ADR 0009 proposes, and no App holds Workflows. Actions being off is proposed and not currently true | From M5's spike: Actions were on in a new repository |

## Questions for the architect

**Proposed answers by the architect. None is recorded as a decision.** "Owner's yes" marks an answer or an alternative that costs money, creates an account or resource, is legal text or loosens the stance. "Owner only" marks a question the architect can't answer at all.

| # | Question | Proposed | Alternative |
| --- | --- | --- | --- |
| 1 | Where do deployed apps run? | Podster's platform: a Workers for Platforms dispatch namespace, as the architecture and decision 11 recommend. **Owner's yes** for the add-on. | A customer's own Cloudflare account. Later, with its own delegation design. |
| 2 | Who pays? | **Owner only.** On staging, Podster. Preview stays free, so no charge is passed on. | |
| 3 | Same Cloudflare account as Podster's own Workers, or a second one? | Decided by the spike: the same account only if the publishing token can be scoped so it can't touch Podster's Workers. Otherwise a second account. **Owner's yes** either way. | Accepting an account-wide token beside Podster's Workers. Loosens the stance; not proposed. |
| 4 | Where do builds run? | Nowhere in M6. A release is a fixed directory already committed at the merged commit, copied as it is. Podster runs no agent-written build, and Actions stay off. | GitHub Actions in the managed repository, which reverses ADR 0009's proposal and needs its own decision. A Podster build service, which runs untrusted code on Podster's account. Both the owner's yes. |
| 5 | Static files, or server code too? | **Owner only**, both ways. The working assumption is static files only. The architecture describes each app as a user Worker; under the assumption that Worker is Podster's fixed file server, or a static-assets upload, whichever the spike shows works. It narrows core job 8's "working web application" to what runs in a browser, and that narrowing needs the owner as much as the alternative does. | An agent-written Worker with no bindings and blocked outbound requests, after a spike of the isolation. Podster would then be running code an agent wrote, which touches "Podster never hosts or runs agents": the code isn't an agent, but the line needs the owner to draw it. |
| 6 | Which credential reads the files from GitHub? | A fourth App with Contents read and Metadata read only, used by the release job alone, its token cut down to the one repository and never returned. ADR 0009 keeps provisioning, agent tokens and merge apart, and a release shouldn't borrow any of them. **Owner's yes**, to create it. | The merge App's token cut down to reading. Not proposed: it puts the merge key in the release path. An unauthenticated read of a public repository, which fails for private ones. |
| 7 | What is an environment? | One per room in M6, named `production`, as DESIGN.md's copy uses. `environments_json` holds that one entry. This leaves out the preview URL that `PRODUCT.md` names, which is the **owner's** to confirm with question 5. | A preview environment for unmerged commits. **Owner's yes**: it serves unreviewed agent code. |
| 8 | What are the approval policy's values? | `person`: a person with the deployment grant approves each release, the default, and the only value in a public room. `on_merge`: a merge starts the release, only if the person who asked for the merge also holds the deployment grant; otherwise the release waits for approval. **Stated plainly:** under `on_merge`, an agent that holds both the merge grant and the deployment grant publishes with no person involved at that moment. A person chose `on_merge` and gave both grants, and a reviewer other than the submitter approved the work, but in a private room that reviewer may be an agent too. So the question is also whether `on_merge` is offered at all where the room doesn't require a person as reviewer. Proposed: it isn't; `on_merge` needs the room's person-review setting on. | `on_merge` wherever the owner chooses it, or as the default. **Owner's yes.** |
| 9 | Who holds deployment authority? | Podster's platform is the resource owner and delegates to the room's owner for that room's app only, as decision 18 proposes for repositories. Others need a `provider_grant` with a `deploy` action, given by the owner. Whether a room may switch deployment on at all is trusted configuration on staging. | Any admin can deploy. Loosens AC-10; not proposed. |
| 10 | Who owns a hostname's uniqueness across rooms, and how does a claim commit? | A separate object: one small Durable Object per normalized hostname, in the private API, holding at most one claim, since a D1 row must never authorize. It spans two objects, with no distributed transaction. (1) The room's command checks policy and commits `hostname.requested`, its event, an outbox job and the idempotency record in one transaction. (2) The job asks the hostname object, which in its own transaction records the claim for that room and request, or refuses if another room holds it. Asking again with the same room and request gets the same answer. (3) The job reports back, and the room commits `hostname.claimed` or `hostname.refused`. Routing starts only after the room has recorded the claim and the proof of control has passed. Removal runs the same way in reverse: the room commits the removal and stops routing first, then the job frees the claim. A job that dies between steps leaves a hostname held and not routed, never held twice, and its retry finishes it. | A unique index in D1 as a reservation. Simpler, and at odds with "read models never authorize". |
| 11 | Who may open a deployed app? | **Owner only.** The architect can't decide it, because serving a private room's app to anyone with the address loosens private-room visibility. Working assumption until the owner answers, as the safest option: a public room's app is public, and a private room's app isn't served to anyone who can't already see the room. Gating by sign-in would need a Podster session on the content domain, which the separate domain exists to prevent, so the way to serve it to the room's own people is undesigned; a signed, expiring link issued by the application is the candidate for ADR 0010. Until that is designed and reviewed, a private room's app isn't served at all. | Anyone with the address, whatever the room's visibility, said plainly and confirmed at setup. **Owner's yes.** |
| 12 | What are the caps? | Per room: one app, 25 MB and 1,000 files per release, 20 releases a day, one custom hostname. Placeholders until the spike shows the platform's own limits. | Higher caps, or none. **Owner's yes**, as money. |
| 13 | Rollback | A new release of a commit that was live before, under the same grant and approval. Nothing is rewritten. | Automatic rollback on failure. Not needed: a failed release leaves the earlier one serving. |
| 14 | What happens to an app when deployment is switched off, the room is archived, or the room's owner leaves? | Off and archived both unpublish and keep the records. An owner's departure leaves the app serving until recovery, like the repository. | Keep serving an archived room's app. |
| 15 | Can operators suspend a deployed app? | Yes: a new operator power beside decision 158's (decided, for the owner to review), to stop a room's app from serving and to lift that. They still read nothing private. Reports can name an app. | Owner removal only. Not proposed: Podster hosts the content. |
| 16 | Secrets and bindings for deployed apps | None in M6. | Per-room secrets. Later; a design of its own. |
| 17 | Proof of control for a custom hostname | A DNS record the owner publishes, checked by Rust's job before routing and on a schedule after. The exact records depend on Cloudflare's custom-hostname flow, which the spike validates. | An HTTP file check. Decided with the spike. |
| 18 | Export and transfer | Export: a release names its repository and commit, and a public repository can be cloned. Transfer of a repository or an app to its owner's account isn't offered. Uploads' export stays deferred to before production, as decision 167 says (decided, for the owner to review). **Owner's yes**: ADR 0009 left transfer and deletion to the owner. | Building transfer in M6. Waits on the managed organization's legal terms. |
| 19 | Does staging need the real content domain? | Yes. The origin boundary can't be shown on a `podster.dev` host. | A `workers.dev` host for the first spike only, never for the gate. |
| 20 | Does M6 serve previews of uploaded HTML, SVG or video? | No. Decision 52's download-only stands. The content domain makes a later preview possible, on a per-object origin, as its own change. | Bring previews into M6. Not proposed. |
| 21 | Can a public claimant hold a deployment grant? | No. The Public participant and Guest presets never carry one, and a grant needs the owner's explicit act for a named principal. | Allowed by explicit grant. **Owner's yes.** |
| 22 | When does M6's code start, and when does its gate run? | Step 1 now. Steps 4, 8, 9 and 10(a) once step 2 has merged and the owner has said yes to the domain and the add-on. The rest behind the M5 steps named. The gate waits for M5's. | Wait for M5's gate before any M6 code. |
| 23 | Calling M6's gate | The architect proposes it after the staging run and the security review, for the owner to review. Test people count, as decision 79 says; real people stay owed before production. | |
| 24 | Which reading of criterion 8 does M6's gate use? | **Owner only.** The milestone table gives M6 the whole criterion. Proposed: the whole of it, with upload permissions, retention and public-room abuse controls shown again by rerunning the M2 and M4 staging scripts at the gate's commit. | Only the custom-domain, export or transfer and release-approval parts, resting on M2's and M4's own gates for the others. |

## Risks to test

The spikes at step 1 answer these before any feature code. None has run.

1. Does a user Worker in a dispatch namespace, in untrusted mode, have no access to the account's other Workers, KV, D1, R2 or caches? What does it share?
2. Can a namespace hold a static-files-only app, and how is one uploaded? What are the size and file limits?
3. What is the narrowest API token that can upload to one namespace and manage custom hostnames on one zone? Can it touch the account's other Workers?
4. Can an upload be read back, so the job can confirm which commit is being served?
5. How long after an upload or a delete does the host serve the new state?
6. What does the Public Suffix List ask of a new entry, how long does acceptance take, and how long until browsers ship it? The gate doesn't wait for it, so: what can one room's app do to another's without the entry, and does a sandboxing Content Security Policy close that without breaking ordinary static apps?
7. Does the custom-hostname flow prove control before any traffic routes? What does it issue certificates on, what does a hostname cost, and what happens when the customer's DNS is removed or pointed elsewhere?
8. Can one room's custom hostname be made to route to another room's app by a request's `Host` header or SNI?
9. Which per-app limits does the platform offer: requests, CPU, size? Do they apply to static files?
10. Does a read-only App's token, cut down to one repository, read a private and a public managed repository, and can the job fetch a directory at an exact commit without following anything the repository controls, such as submodules or symlinks?
11. What does GitHub return for a large directory or a large file, and do its rate limits fit a release?
12. Can a wildcard host and custom hostnames both route to one Worker on the content zone, with nothing on `podster.dev`?
13. Does refusing service-worker scripts at the content Worker stop registration in current browsers, and does `Clear-Site-Data` on a not-found answer clear what an app cached?
14. From ADR 0009, still open: whether a workflow already in a repository can run with Actions switched off per repository.

## How far this was checked

- **Read:** `CLAUDE.md`; `PRODUCT.md` in full to the first decisions, and its later decisions by search for deployment, release, domain and M6; `ARCHITECTURE.md`'s content origins, M5 and M6 sections; `ACCESS-CONTROL.md` in full; `DESIGN.md`, `RUNNER.md`, `CONTRIBUTORS-AND-LIMITS.md` and `TASK-PLANNING.md` by search for deployment and release; the M5 plan in full; the M4 plan's opening, cloud resources and run record; ADR 0009's Apps, Actions, deletion and legal sections. All on `main` at `f1096ce`.
- **Checked against GitHub:** #236 and #238 are merged.
- **Not checked:** that #236's fixes are deployed, and the state of staging. Both are as the lead session reported.
- **Nothing about Cloudflare or GitHub is verified.** Workers for Platforms' isolation, its pricing, static files in a namespace, API token scopes, custom hostnames, the Public Suffix List's process and browsers' behaviour are all written from the specs' links or the architect's memory. Where this plan says "believed" or "may", it means that.
- **Not found in the specs:** any policy document for custom domains, release approvals, or export and transfer; any definition of an environment, the approval policy's values, the release states, or the budget caps.
- **Not read:** the code. This plan doesn't claim what `apps/api`, `apps/gateway` or `apps/web` hold today beyond what the plans and specs say.
- **Run:** nothing. No code, contract, migration, spike or cloud resource was created or changed.
