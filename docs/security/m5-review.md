# M5 security review, 2026-11-11

The security review [M5's gate](../m5-plan.md#the-gate) asks for. Three reviewers each read one part of managed repositories. This page puts their findings in one table, with what the architect ruled for each on 2026-11-11.

**Nothing here is fixed.** "Assigned" means the architect ruled that it's fixed before M5's gate and gave the work out. The one exception is O-1's interim: [#279](https://github.com/thachp/podster/pull/279), merged at `b66644b`, takes `MANAGED_REPOSITORIES` out of staging's configuration. No fix for any finding was on `main` when this was written. M5's gate hasn't been proposed or called.

**Later on 2026-11-11 UTC that changed.** The paragraph above, the dispositions in the tables and the lists below are kept as they were written that morning. [Each finding's status](#status-of-each-finding-2026-11-11-utc) says what is fixed and on staging, what the owner decided, what is still owed and what is open. The architect has [proposed M5's gate](../m5-plan.md#the-architects-proposal-for-m5s-gate-2026-11-11-for-the-owner-to-review). The owner hasn't called it.

## Scope

- **What was read:** `main` at `c8053c385ef50c9c4e88b041fadc40c15f3dca49`, on 2026-11-11 UTC. `main` at `8e6ab69`, where this page's citations were checked, differs from it in three files under `docs/` only.
- **Three parts, one reviewer each:**
  - **Authority (A-):** who may ask for a repository, give a grant, get a push token and cause a merge, and what the merge job re-checks.
  - **Credentials (C-):** the three GitHub Apps' keys, installation tokens, the HTTP client, provisioning and webhooks.
  - **Operations (O-):** abuse and limits, content under Podster's name, data exposure, the web app, and what an operator can see and do.

## Method, and its limits

- **Read-only.** Each reviewer worked in a detached copy of the repository. Nothing was sent to staging or to GitHub.
- **Most findings come from reading the code.** The table says which: **test** (a pure test was run), **reading** (code read, not run), **suspicion** (it depends on GitHub's behaviour or a secret nobody in the review could see).
- **Tests that were run,** all pure Rust: `podster-egress` (26 passed), `podster-assertion` (12 passed), `podster-core`'s provisioning tests (11 passed), and a few throwaway tests of the pure crates, deleted afterwards.
- **Not run by the reviewers:** the API's suite, the gateway's suite and the e2e scripts.
- **GitHub's behaviour is assumed, not exercised.** Every statement about what a ruleset stops, what a token can reach and how rate limits are counted is from the code's intent, the spike or GitHub's documentation.
- **The reviewers are models.** Their reports are evidence. This page summarises them and adds no findings of its own, except where checking a citation against the code showed a difference, which is [listed](#where-the-reviews-and-the-code-differ).
- **Citations** are the reviewers', as `file:line` at `c8053c3`. About forty were spot-checked against `8e6ab69` for this page and held, except the web copy's, which are corrected in the table. The rest weren't checked one by one.

## Verdict on the main property

**No way was found, through Podster's own code, to put a commit other than the approved submission's on a managed repository's default branch, or to merge or get a push token without a grant that counts.** Every authority finding either fails closed, is a difference in what someone can learn, or is a gap between the specs and the design.

**It rests on GitHub's rulesets behaving as the design assumes, and the review didn't exercise that.** The [first acceptance run on staging](../m5-plan.md#step-10-the-first-run-on-staging-2026-11-11), the same day and at the same commit, did exercise the basic cases against real GitHub: 32 passed, 0 failed, 0 skipped. Among them, GitHub refused an agent's token a push to the default branch, a merge and the review status, and the merged default branch's tip was one merge commit whose second parent was the reviewed commit. That was one run. It didn't read bypass lists, and it ran none of the [proposed staging checks](#proposed-staging-checks-not-yet-run) below in full.

**The verdict is about authority only.** The operations review found two high findings that aren't about that property: who can reach staging (O-1), and that Podster can't stop a repository (O-2).

## Status of each finding, 2026-11-11 UTC

**As of 17:47Z on 2026-11-11,** when staging was deployed at `e6592b88b4da401cc22f9bedb67a8b227e018183`.

**What "fixed and deployed" means here, and what it doesn't.** The pull request named is merged, its merge commit is an ancestor of `origin/main` (checked with `git merge-base --is-ancestor` for #281, #282 and #283), it's part of `e6592b8`, and the deploy's log says that commit was deployed with every probe passing. The fix's code was looked for on `main` by name, not reviewed again. **It doesn't mean the fix was seen working on staging.** Only three were: A-1, C-8's settings, and O-1's list as far as admitting test people ([the day's runs](../m5-plan.md#step-10-the-day-on-staging-and-the-later-runs-2026-11-11)). Every other fix is shown by its pull request's tests against a fake GitHub, and each pull request says what it left unverified.

**Fixed and deployed to staging:**

| ID | What was done | Pull request | Seen on staging |
| --- | --- | --- | --- |
| O-1 | The API's `REPOSITORY_REQUESTERS`; staging's value is `operators,test-people`. Deployed at 16:50Z at `c6f90bc`, which closed the window that had been open since 13:17Z. The interim switch-off (#279) was merged and never deployed | [#281](https://github.com/thachp/podster/pull/281) | In part: the second and third acceptance runs' test people were admitted. No unlisted person has been seen refused |
| A-1 | The owner's decision 195: a merge is refused `self_review` unless the approving review came from someone the submitter's person doesn't control | [#283](https://github.com/thachp/podster/pull/283) | Yes: M5-10e in the third run |
| A-3 | The merge job runs the request's own decision on every pass, policy included | #283 | No |
| A-4 | An organization's admin with no place in the room can take a grant back | #283 | No |
| A-5 | The delegation routes for anyone but an operator, the operator's recheck and `repo-access` answer as missing while the switch is off | #283 | No: staging's switch is on |
| A-6 | M5's events follow the switch and the visibility of the read each mirrors | #283 | No |
| A-9 | Rated "None" in the table. #283 moved the two checks written outside `crates/policy` into it, with behaviour unchanged. The inputs still come from the gateway's assertion | #283 | No |
| O-5, C-9, and the misreading in C-1 | GitHub's rate-limit signals are read; a limit is never a credential failure and never spends a setup run | [#282](https://github.com/thachp/podster/pull/282) | No. GitHub's real headers and message are unconfirmed |
| C-2 | Degrading a link marks every held token for revocation, in the same alarm pass | #282 | No |
| C-4 | Provisioning's tokens are asked for by permission and used only if GitHub's answer matches | #282 | Only that provisioning still works with them: the third run made its repository |
| C-5 | A GitHub answer is read up to a bound | #282 | No |
| C-6 | Only `204` counts as revoked; a `401` keeps the row | #282 | No |
| C-7 | Each App's role is compared with both others, by App, installation and parsed key | #282 | No |
| C-8 | Settings are sent at creation and read back with the default workflow permissions | #282 | In part: the third run's repository came up `ready`, and GitHub's listing shows it with issues, wiki, projects and discussions off. Auto-merge isn't in that listing |
| O-8 | A `ready` link is read back 24 hours after it was last found right | #282 | No: a day hasn't passed |
| O-11 | The web copy no longer promises an operator's reset, an operator's check or a suspension, and the confirmation says the repository is public and in Podster's organization | #282 | No: nobody has looked at the screens in a browser |
| O-13 | Ended grants are pruned 30 days after they ended | #282 | No |

#282 also built two things this page's [last section](#where-the-reviews-and-the-code-differ) found missing: a repository deleted on GitHub reads back as `repository_gone` after two sightings, and an operator's recheck now degrades a `ready` link. Both are checked against the fake only.

**Written, not followed:** O-3 and the gate's part of O-2, the [credentials runbook](../runbooks/m5-credentials.md) and the [takedown procedure](../runbooks/m5-takedown.md), merged with this page in [#280](https://github.com/thachp/podster/pull/280).

**Owner decisions:**

| ID | Status |
| --- | --- |
| A-1 | **Made:** [decision 195](../spec/PRODUCT.md#decisions-needed), 2026-11-11. Built and deployed, as above |
| A-2 | **Not asked again.** Decision 195 records "controlling person" as staying per credential. #283 added a test that pins today's reading, so a ruling that changes it must change the test |
| O-2, what Podster promises about a takedown | **Outstanding** |
| O-1, production's value for the allow-list | **Outstanding.** Owed before production |

**Still owed before production,** unchanged by today's fixes, as [listed below](#owed-before-production-not-before-the-gate) and in [the plan](../m5-plan.md#owed-before-production):

- **O-2:** Podster can't stop a repository. #282's deleted-repository detection and recheck are what Podster does after a by-hand takedown; they don't stop one.
- **C-1:** Podster's reads share the agent-token installation's rate limit. Only the misreading is fixed. The separate read-only App isn't made.
- **C-3, O-7:** what an agent's token can do off the default branch. #282 switches issues, wiki and projects off on new repositories; branches, tags, releases and other tasks' pull requests are as the finding says.
- **O-4** (no inventory), **O-6** (no deployment-wide budget), **O-9** (the kill switch), **O-10** (look-alike names), **O-12** (no log retention or alerting), **O-16** (no global or lifetime cap).

**No action ruled, and none taken:** A-7, A-8, C-10, C-11, O-14 and O-15. For O-14, five public repositories are now in `podsterdev` for the owner to archive or delete.

**Open, not done.** [#285](https://github.com/thachp/podster/pull/285), the follow-up to the reviews of #282, #283 and #284, is an open pull request and isn't on `main`. Nothing in it counts as fixed here:

- **A test double weakened.** #282's merge left the fake GitHub unable to show a presence token that was never revoked. #285 restores that and adds the test.
- **Contract enum gaps.** `self_review` and `controller_departed` are missing from the contract's `Error.code`. #285 adds those two, and lists 13 older codes the enum also misses without adding them.
- **CI's font check is one-way.** #285 makes it check both directions.
- **An accessibility timing that measured nothing** in the fallback run of [#284](https://github.com/thachp/podster/pull/284)'s browser install. #285 makes those two paths fail when too little stays laid out.

**The [proposed staging checks](#proposed-staging-checks-not-yet-run) still haven't been run,** and neither have the eight #282 proposed in its description.

## Findings

Severity is the reviewer's. Where two reviewers reported the same thing, it's one row with both IDs, and both severities if they differed. Paths are from the repository's root.

**Dispositions:** **Assigned** is being fixed before M5's gate. **Owner** waits on [a decision of the owner's](#owner-decisions-outstanding). **Production** is [owed before production](#owed-before-production-not-before-the-gate), not before the gate. **None** means the architect's rulings of 2026-11-11 name no action for it.

### Authority

| ID | Severity | Finding | Where | Checked | Disposition |
| --- | --- | --- | --- | --- | --- |
| A-1 | Medium (design) | Review independence is by principal ID only. The submitter's own controlling person, or their second agent, can be the reviewer who approves. Only the merge compares people | `crates/core/src/lib.rs:835`, `crates/policy/src/lib.rs:646-648`, `apps/api/src/workspace/changes.rs:249-252` | test | Owner. **Decided 2026-11-11, assigned:** a commit is merged only after a review independent of the submitter's person; the task's own review is unchanged ([decision 195](../spec/PRODUCT.md#decisions-needed)). Built on `fix/m5-review-authority`, not merged |
| A-2 | Low | "Controlling person" is whoever linked the credential a request came with: per credential, and frozen at submission and at the merge request. It isn't a property of the agent | `apps/api/src/workspace/changes.rs:160-166`, `:487-489`, `apps/gateway/src/index.ts:271-281`, `apps/api/src/workspace/merges.rs:326` | reading | Owner |
| A-3 | Low | The merge job re-runs core on each pass and never policy, and asks less about the requester than token issuing does. A requester whose access was narrowed after asking, an agent whose linker has left, and a person who left their organization after asking still get their merge. The window is one request's passes | `apps/api/src/workspace/merges.rs:428-499`, against `apps/api/src/workspace/repo_tokens.rs:773-780` | reading | Assigned: the job re-runs policy each pass |
| A-4 | Low (fails closed) | An organization's admin with no place in the room can't take a grant back, though AC-11 and the policy say they can. The caller is resolved as a room member before the route is reached | `apps/api/src/workspace.rs:4116`, `:4835-4861`, `crates/policy/src/repositories.rs:115-143` | reading | Assigned: the admin may take a grant back, as AC-11 says |
| A-5 | Low | With `MANAGED_REPOSITORIES` off, three paths don't answer as a missing route: `GET` and `PUT` of an organization's provisioning delegation, the operator's recheck, and `repo-access` with no idempotency key | `apps/api/src/lib.rs:431-441`, `apps/api/src/principal.rs:927-963`, `apps/api/src/moderation.rs:671-688`, `apps/api/src/workspace.rs:4209-4216` | reading | Assigned: all three answer as missing |
| A-6 | Low | Events show more than the reads do, and stay visible with the switch off. `repository.*` events with their reason codes reach anyone who sees the whole room, agents included, while the repository read is for people only. `repo_access.issued` tells anyone who can read the task that the assignee holds a push grant, with its ID | `apps/api/src/workspace.rs:2683-2688`, `:2398-2401`, `crates/policy/src/lib.rs:788-793`, `apps/api/src/workspace/repo_tokens.rs:705` | reading | Assigned: M5's events follow the switch and the reads' visibility |
| A-7 | Info | `self_merge` is answered before the grant is looked at, so a caller with no grant learns whether a submitter's controlling person is on record | `crates/policy/src/repositories.rs:237-240`, `apps/api/src/workspace/merges.rs:165-173` | test | None |
| A-8 | Info | A merge call recorded by an earlier request stays on record for the next one. If someone with a bypass on GitHub merged the reviewed commit between two requests, Podster records it as its own success. The commit is the reviewed one either way | `apps/api/src/workspace/merges.rs:322-335`, `:546`, `:1586-1609` | reading | None |
| A-9 | Info | Some inputs to authority come from the gateway's signed assertion and not from the owning Durable Object's state (a person's organizations, `admin_orgs`, an agent's linker), and two checks are written outside `crates/policy`. No client field is read. It's the pattern earlier milestones use | `apps/api/src/workspace/repositories.rs:632-640`, `apps/api/src/principal.rs:938` | reading | None |

### Credentials, GitHub and webhooks

| ID | Severity | Finding | Where | Checked | Disposition |
| --- | --- | --- | --- | --- | --- |
| C-1 | Medium | An agent's token draws on the same installation rate limit as Podster's own reads, since both come from the agent-token App. One agent making about 5,000 cheap calls starves every room's reads until the hour turns, and can repeat it each hour. Submissions and approvals of linked tasks then answer `502 provider_unavailable` everywhere. The exhausted limit is also misread as a credential failure, which is O-5's | `apps/api/src/github.rs:853-907`, `:928-963`, `apps/api/src/workspace/changes.rs:335-351` | reading. The shared bucket is GitHub's documented behaviour, not tried | Production: needs a separate read-only App. The misreading is assigned, with O-5 |
| C-2 | Low | Degrading a link doesn't mark held agent tokens for revocation. They're revoked at the room's next alarm, which may be as late as the token's own expiry. With the update ruleset gone, a token minted minutes earlier can push to the default branch until then | `apps/api/src/workspace/merges.rs:912-938`, `apps/api/src/store.rs:830-849`, `apps/api/src/workspace.rs:4970-4975` | reading | Assigned: degrading revokes held tokens |
| C-3, O-7 | Low (C), Medium (O) | Nothing bounds what an agent's token does off the default branch: create, force-push and delete any other branch, another task's included; tags; by GitHub's permission model, releases with assets; edit, close and comment on any pull request. All of it is public at once, under Podster's organization, and every agent acts as the one App bot. New repositories keep issues, wiki and forking at GitHub's defaults and carry nothing that says they're a user's | `crates/core/src/repo_access.rs:53-60`, `apps/api/src/github.rs:460-495` | reading. Releases and wiki are suspicion | Production |
| C-4 | Low | Provisioning's tokens aren't narrowed by permission, and aren't checked against what GitHub says it minted. The creation token reaches the whole installation with every permission the App has | `apps/api/src/github.rs:414-430` | reading | Assigned: narrowed and checked |
| C-5 | Low | A GitHub answer is read whole before its size is checked. The 10-second timeout is the only bound | `apps/api/src/github.rs:289-295` | reading | Assigned: a size bound |
| C-6 | Low | Any `401` on revocation counts as revoked and drops the row. A `401` for another reason leaves a live token unrecorded for its hour | `apps/api/src/github.rs:784-789`, `apps/api/src/workspace/repo_tokens.rs:925-931` | reading | Assigned |
| C-7 | Info | The check that the three Apps are different is asymmetric and compares keys as text. Provisioning compares its key with the agent-token App's only, and the agent-token App with provisioning's only | `apps/api/src/github.rs:136-141`, `:663-671`, `:1051-1063` | reading | Assigned: compared symmetrically |
| C-8 | Info | Read-back covers rulesets and Actions only. `allow_auto_merge`, forking, default workflow permissions, collaborators and the organization's base permission are assumed | `apps/api/src/github.rs:521-588`, `crates/core/src/provisioning.rs:297-341` | reading | Assigned: settings set at creation and read back |
| C-10 | Info | A signed delivery puts an unwatched change back on watch and clears its not-found count | `apps/api/src/workspace/repositories.rs:150-162` | reading | None |
| C-11 | Info | One webhook secret serves three Apps, and a delivery carries no time, so a captured one is good until the secret changes | `docs/staging.md` (the secrets table), `apps/gateway/src/github-webhook.ts:116-124` | reading | None. The [credentials runbook](../runbooks/m5-credentials.md#github_webhook_secret-1) records the gap |

C-9 is in the next table, with O-5.

### Abuse, exposure, web and operations

| ID | Severity | Finding | Where | Checked | Disposition |
| --- | --- | --- | --- | --- | --- |
| O-1 | High | Staging sign-in is open to anyone, so "test people only" isn't enforced. Any GitHub account or email address can sign in and get 5 public repositories a day under `podsterdev`. No operator approves first ([decision 194](../spec/PRODUCT.md#decisions-needed)), and there's no allow-list | `apps/web/wrangler.jsonc:36`, `apps/gateway/wrangler.jsonc:36`, `apps/gateway/src/email-sign-in.ts:15-18`, `crates/core/src/provisioning.rs:878` | reading | Assigned: a deployment allow-list of who may ask for a repository. Interim: staging switched off again (#279, merged). **2026-11-11, later:** the allow-list is built in [#281](https://github.com/thachp/podster/pull/281), the API's `REPOSITORY_REQUESTERS`, with staging's switch back on beside it for `operators,test-people`. That pull request is open as this is written |
| O-2 | High | Podster can't stop a repository or a room's access to it. `suspended` is read in many places and written nowhere. An operator can't reach a private room. Suspending a room stops merges and not tokens. A takedown is by hand on GitHub | `apps/api/src/workspace/merges.rs:912-929`, `apps/api/src/store.rs:830-849`, `apps/api/src/moderation.rs:114-116`, `apps/api/src/lib.rs:462-478` | reading | Production. For the gate, [the by-hand procedure](../runbooks/m5-takedown.md), written with this page |
| O-3 | Medium | The rotation and compromise runbook ADR 0009 promises "before M5's gate" didn't exist | `docs/adr/0009-managed-repositories.md:288` | reading | [Written with this page](../runbooks/m5-credentials.md). Nobody has followed it yet |
| O-4 | Medium | No inventory of managed repositories. Linked ones are a row each in D1 that no route lists. Ones created and never linked are recorded only inside their room | `apps/api/migrations/0007_repo_room_index.sql`, `apps/api/src/workspace/repositories.rs:240-291`, `apps/api/src/workspace/provisioning.rs:899-905` | reading | Production |
| O-5, C-9 | Medium (O), Info (C) | GitHub's rate limiting isn't recognised. No `retry-after` or `x-ratelimit-*` header is read. A `403` from the limit reads as a credential failure, so each room tells its admins the provider refused Podster and backs off for up to an hour. A rate-limited creation call spends one of a room's 5 setup runs for good | `apps/api/src/github.rs:262-305`, `crates/core/src/task_change.rs:232-236`, `apps/api/src/workspace/provisioning.rs:748-756` | reading; test for the two classifications | Assigned: limits recognised, and never spend a setup run |
| O-6 | Medium | No deployment-wide budget for GitHub calls. Each room has its own hourly caps and nothing sums them. The reviewer's estimate is 400 to 550 calls an hour for one room driven at its caps, so about 10 such rooms reach one installation's 5,000 | `apps/api/src/workspace/repo_tokens.rs:47-51`, `apps/api/src/workspace/changes.rs:36-42`, `crates/core/src/provider_deliveries.rs:17`, `crates/core/src/repo_merge.rs:562-566` | reading. The per-room counts are an estimate | Production |
| O-8 | Medium | Protections are read back only when a merge runs or an operator rechecks a degraded link. ADR 0009 and the plan's threat model say "on a schedule and before each merge" | `apps/api/src/workspace/merges.rs:982`, `:1043`, `:1377` | reading | Assigned: read back on a schedule |
| O-9 | Low | The kill switch needs two Workers deployed, and push tokens already out live up to 60 minutes after it | `apps/api/src/workspace/repo_tokens.rs:874-880`, `:958-968` | reading | Production |
| O-10 | Low | Look-alike and third-party names pass: `podsters`, `my-podster`, `podsterdev-official`, `github`, any brand. Twelve reserved words and one prefix, no word list, one shared namespace | `crates/core/src/provisioning.rs:29-52`, `crates/core/src/repositories.rs:244-252` | test for `podsters` and `my-podster`; reading for the rest | Production |
| O-11 | Low | The web copy promises operator actions that don't exist: "A Podster operator can reset it", "A Podster operator can check", and a "Suspended" state. The confirmation doesn't say the repository is under Podster's GitHub organization. Some merge refusals still say only the owner grants | `apps/web/app/(shell)/w/[id]/settings/repository-section.tsx:137`, `repository-model.ts:92`, `:100`, `:124` (corrected from the review's lines) | reading | Assigned: copy that promises only what exists, and a plain public-repository confirmation |
| O-12 | Low | No log retention and no alerting on the API or the gateway. An unrevoked organization-wide token is one error line, seen only by someone tailing at the time | `apps/api/wrangler.jsonc`, `apps/gateway/wrangler.jsonc` (neither sets `observability`), `apps/api/src/workspace/provisioning.rs:704-711` | reading | Production |
| O-13 | Low | `provider_grant` rows, with their audit and event rows, grow without limit through cycles of granting and taking back | `apps/api/src/store.rs:221-223` | reading | Assigned: grant rows pruned |
| O-14 | Info | Each staging run leaves a public repository that only the script's output names | `docs/staging.md` (M5's staging run) | reading of the documents; the script wasn't read | None |
| O-15 | Info | A person at their own cap can hold an organization's 5 places with nothing recorded. Already accepted in [the plan](../m5-plan.md#self-serve-repositories-what-was-built) | `apps/api/src/workspace/provisioning.rs:522-542` | reading | None: accepted before this review |
| O-16 | Not rated | No global or lifetime cap. One person gets 5 more repositories every 24 hours, 150 in 30 days, and N sign-ups get 5N a day. The review reports this in its text with no ID; the number is this page's | `crates/core/src/provisioning.rs:878`, `apps/api/src/principal.rs:1481-1560` | reading | Production |

## Assigned before the gate

As the architect ruled on 2026-11-11. None is on `main` yet, apart from O-1's interim switch-off.

- **O-1:** a deployment allow-list of who may ask for a repository. Until it's built, the ruling is that staging has managed repositories switched off again. [#279](https://github.com/thachp/podster/pull/279) is merged and takes the switch out of both Workers' staging variables; [staging.md](../staging.md#managed-repositories-on-staging) says it takes effect when both are next deployed. This page doesn't say what is deployed. The allow-list itself isn't on `main`.
- **A-3:** the merge job re-runs policy on each pass.
- **A-4:** an organization's admin may take a grant back, as AC-11 says.
- **A-5:** the three switch-off paths answer as missing.
- **A-6:** M5's events follow the switch and the reads' visibility.
- **O-5, C-9, and the misreading in C-1:** rate limits are recognised, and never spend a setup run.
- **C-2:** degrading a link revokes held tokens.
- **C-6:** a `401` on revocation is no longer taken as revoked whatever its cause.
- **C-5:** a bound on a response's size before it's read whole.
- **C-4:** provisioning's tokens are narrowed and checked.
- **C-7:** the three Apps are compared symmetrically.
- **C-8:** repository settings are set at creation and read back.
- **O-8:** protections are read back on a schedule.
- **O-11:** web copy that promises only what exists, and a plain public-repository confirmation.
- **O-13:** grant rows are pruned.
- **O-3 and the gate's part of O-2:** the [credentials runbook](../runbooks/m5-credentials.md) and the [takedown procedure](../runbooks/m5-takedown.md), written with this page. Neither has been followed against staging or GitHub.

## Owner decisions outstanding

Each is stated as the review found it. None is decided here.

### Whether a review by a principal the submitter's person controls should count (A-1)

**Decided by the owner on 2026-11-11 and assigned** ([decision 195](../spec/PRODUCT.md#decisions-needed)). The recommendation: a commit can be merged into a managed repository only if the review that approved it came from someone not controlled by the submitter's person; ordinary task review stays as it is. The owner's reply: "i agreed with your recommendation". Being built on `fix/m5-review-authority` as `self_review` (403). It compares Podster accounts: one human with two accounts isn't detectable. A-2 stays as it is.

Today review compares principal IDs: the reviewer mustn't be the assignee. Only the merge compares controlling people, and only the submitter's against the merger's. The reviewer's sequence, with one person A who is a room admin and any second person B who holds a merge grant:

1. A creates a task in a room with a ready repository, assigns it to A's agent X, and names A as reviewer. Where the room doesn't require a person to review, A's second agent R will do.
2. X pushes, opens a pull request and submits commit C. The submitter's person on record is A.
3. A, or R, approves C. C is now the reviewed commit.
4. B, or B's agent, asks for the merge. `self_merge` doesn't apply, since B isn't A.

Two people are still needed, but the second needn't have reviewed anything. The reviewer's reading of the specs: "No self-sign-off" and AC-17 are met as written, and decisions 186 and 194 speak only of who merges, so the code meets the letter. Whether review should also compare controlling people is what's asked.

### Whether "controlling person" should be per credential, as now (A-2)

The code takes an agent's controlling person from the linker of the credential the request came with. It's stored at submission and at the merge request, and never resolved again. What follows, as the reviewer lists it:

- An agent with credentials linked by A and by B is "controlled" by whichever credential made the request. If X's submission came through the credential B linked, A may merge it, though A also holds a live credential for X. That needs B's credential, so it isn't a way round for one person alone.
- A change of linker after submission, or after the merge request, changes nothing for that submission or request.
- A request with no linker has no controlling person, and is then refused as possibly anyone's. A change with no submitter's person on record can never be merged. Both fail closed.

Decision 194 says "an agent the same person controls". The code's reading is narrower than "any person who holds a credential for that agent".

### What Podster promises about taking down a repository (O-2)

[takedown.md](../legal/takedown.md) says nothing of repositories and its contact is a placeholder. ADR 0009 proposes that an operator suspends the link and then makes the repository private; none of that is built. Today a takedown is the [by-hand procedure](../runbooks/m5-takedown.md), which only the owner can carry out. What Podster tells a reporter and a room's owner it will do, and how soon, is the owner's to say, and may need a lawyer.

### Production's value for the allow-list (O-1)

The fix assigned for O-1 is a deployment allow-list of who may ask for a repository. What production's list holds (nobody, named pilots, or everyone) is the owner's.

## Owed before production, not before the gate

With the reviewers' numbers. None of these stops the gate by the architect's ruling.

- **Podster can't stop a repository (O-2).** `suspended` is never written: the only status changes are to `degraded` and back to `ready`. An operator can't reach a private room, since room suspension goes by public handle, and it stops merges and not tokens. An operator's take-back of an organization's delegation stops new requests and unfinished setups only. A takedown is by hand.
- **Podster's own reads share the agent-token installation's rate limit (C-1).** About 5,000 cheap calls with one agent's token starve every room's reads for the rest of the hour, and the token can be renewed each hour. It needs a separate read-only App, so agents' tokens and Podster's reads don't share a bucket.
- **No deployment-wide GitHub budget (O-6).** Per room and hour: 60 token mints, 60 refresh reads, 60 reads for submissions and approvals (20 a caller), 20 merge requests of up to 5 attempts and 12 unknown-outcome reads each. The reviewer estimates 400 to 550 calls an hour for one room at its caps, so about 10 such rooms reach 5,000: two accounts on day one, or one account on day two.
- **An agent's token can create, force-push and delete any non-default branch, and create tags and releases (C-3, O-7).** A grant taken back and given again forces a new mint: up to 60 a room an hour, 300 an hour for one person's 5 rooms.
- **No repository inventory (O-4).** The only complete list is GitHub's own listing of the organization, and nothing compares it with Podster's records.
- **Look-alike names (O-10).**
- **The kill switch needs two deploys, and tokens live up to an hour after (O-9).**
- **No log retention or alerting (O-12).**
- **No global or lifetime cap across sign-ups (O-16).** 5 a person a day, 150 in 30 days, 5N for N sign-ups. Email sign-in allows about 100 new people a day across everyone; GitHub sign-in has no daily limit. The reviewer's worst case on staging as it stood: 20 GitHub accounts and a script make 100 public repositories a day, and the day's 100 email links about 500 more. The worst case for one person is 25 repositories from 5 requests, only if GitHub loses the creation answer on every run, which the person can't cause.

The operations review also lists what the documents promise and the code doesn't do. Beyond the findings above:

- A removed or archived room leaves its repository "in place, archived" (ADR 0009). Nothing archives it.
- After a compromise, a job reads every managed repository and compares it with Podster's records (ADR 0009). There's no job, and no inventory to drive one.
- takedown.md extended to repositories, with a real contact, "before any public managed repository exists outside staging" (ADR 0009). Not done.
- An operator's reset for a stuck setup, already in the plan's [owed before production](../m5-plan.md#owed-before-production). The reviewer adds: sooner, if O-5 is left as it is.

## Proposed staging checks, not yet run

From the credentials review. All seven need real GitHub. **None has been run.** The first staging run covered parts of check 1 only: a push to the default branch, a commit, a ref update and a merge through the API, the review status, and a settings change, each refused once.

1. With an agent's token from `get_repo_access`, on a staging repository: `git push` to the default branch, fast-forward and forced; `PUT /pulls/{n}/merge` before the mark, and again after the merge App has set `podster/review`; `POST /statuses/{sha}`; `PUT /contents/.github/workflows/x.yml` on a task branch; `PUT /actions/permissions`; `POST /rulesets`; `PATCH /repos` to change the default branch; GraphQL `enablePullRequestAutoMerge`; `GET` a second managed repository that was made private. Each must be refused.
2. With the same token: create and delete a tag, create a release with an asset, force-push and delete another task's branch, close another task's pull request. Record which succeed (C-3).
3. `GET /rate_limit` with an agent's token, then cause one Podster read, then `GET /rate_limit` again: does `remaining` fall by Podster's three calls (C-1)? Note the status and headers GitHub gives at the limit.
4. As an organization admin, disable a ruleset on a staging repository while an agent holds a token, ask for a merge, and time how long the token still answers after the link shows `degraded` (C-2).
5. The mint answer's `repositories`, `permissions` and `expires_at` for each of the six permission sets; a second `DELETE /installation/token` answering `401`; how long a revoked token still works for `git` and for REST.
6. For a new repository: `allow_auto_merge`, `allow_forking`, the default workflow permissions, collaborators and the organization's base permission (C-8).
7. How many deliveries one push produces with three Apps installed, and whether a redelivery keeps the body and the delivery ID (C-11).

## What nobody covered

Each review's own list, merged.

**Against GitHub and deployments:**

- Whether the rulesets hold against organization owners, other Apps, users with write access, and organization-level rules or classic branch protection, which the readiness read doesn't look at.
- GitHub's real rate-limit accounting, and what `contents: write` reaches in practice.
- Any behaviour on staging. Whether staging's GitHub sign-in secrets are set, and whether anything in front of staging, such as Cloudflare Access, limits who reaches it: neither is visible in the repository.
- Timing: whether hidden and missing answers take the same time.

**Suites:** the API's, the gateway's, the web app's and the e2e scripts weren't run by any reviewer.

**Code read in part or not at all:**

- The merge decision (`crates/core/src/repo_merge.rs`) and grant policy were read in depth by the authority review only. `merges.rs` and `repositories.rs` beyond the parts cited weren't read by the operations review.
- The authority review didn't go deep on token sealing, revocation and the token alarm, the provisioning job after a request is recorded, the daily caps' counting, or the webhook's signature check. The credentials review covered sealing, revocation and the webhook; the operations review covered the caps.
- The gateway's handling of the `get_repo_access` answer between the API and the agent (MCP and Agent Auth transports, response headers, any logging) wasn't traced end to end.
- How a client path is kept from reaching a room's `/internal/...` routes was taken from earlier milestones.
- Events, inbox, activity and exports, field by field. The public page's reads and field filters. The MCP tool listing and descriptions, beyond a skim.
- The grants screens, the access sheet, the team screen and the public page, line by line. The dashboard's rendering of `full_name` and `default_branch` was read by the operations review and not by the credentials review.
- `e2e/m5-staging.mjs`.

**Documents:**

- `docs/spec/ACCESS-CONTROL.md` and `DESIGN.md` weren't read by the operations review, which compared the code with ADR 0009 and the plan only.
- `packages/contracts` beyond the entries cited.
- The plan's threat model and risks weren't walked line by line by the authority review. The gate asks for a review "against the threat model"; no reviewer reports having walked every row.

## Where the reviews and the code differ

Found while checking this page against the code at `8e6ab69`.

- **Severity.** The two reviews that reported what a token can do off the default branch rated it low (C-3) and medium (O-7). The two that reported missing rate-limit handling rated it info (C-9) and medium (O-5). The credentials review says "nothing critical or high was found"; that's about its own part, and the operations review found two high.
- **A deleted repository isn't degraded.** The operations review says that after a by-hand takedown the link stays `ready` "until a merge attempt reads it back and degrades it". By the code, that holds for a repository made private or archived, which read back as a definite difference if the rest of the read-back still answers; nobody has tried that for a private repository on the Free plan. A deleted one can't be read back at all, which the merge job treats as a read that couldn't be made: it waits, and the link stays `ready` (`Readiness::CouldNotRead` in `apps/api/src/workspace/merges.rs`, from `read_back` in `apps/api/src/github.rs:521-526`). The [takedown procedure](../runbooks/m5-takedown.md#podsters-state-afterwards) says what follows.
- **An operator's recheck never degrades a link.** It reads GitHub only for a link that's already `degraded` (`operator_recheck` in `apps/api/src/workspace/merges.rs`). So only a merge attempt degrades one.
- **The web copy's lines** are at `repository-section.tsx:137` and `repository-model.ts:92`, `:100` and `:124`, not the lines the review gives. The text is as quoted.
- **Document line numbers** in the reviews are from `c8053c3`. `docs/m5-plan.md` and `docs/staging.md` have changed since, so this page cites their sections.
