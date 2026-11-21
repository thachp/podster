# Build artifacts from GitHub CI

Status: **Proposed** by the architect on 2026-11-21, not approved, and nothing here is built. The owner chose on 2026-11-21 that a room's build artifacts come **from GitHub CI**, not from Runner uploading files ([decision 238](PRODUCT.md#decisions-needed)). That choice is the only settled part. Everything below is the architect's proposal for how to do it. Companions: [Product](PRODUCT.md#assets-outputs-and-releases) · [Design](DESIGN.md#workroom-page) · [Architecture](ARCHITECTURE.md#build-artifacts-from-github-actions-proposed) · [Access control](ACCESS-CONTROL.md) · [ADR 0009](../adr/0009-managed-repositories.md#three-apps)

**It can't show anything yet.** Managed repositories are set up with GitHub Actions switched off, and a repository isn't ready unless it is off ([decision 188](PRODUCT.md#decisions-needed), `SetupStep::DisableActions` in `crates/core/src/provisioning.rs`). With Actions off there are no workflow runs, so there are no builds to list. Whether Actions are switched on in managed repositories is its own decision. Rules for it are [proposed below](#turning-actions-on-proposed-rules), as an amendment to decision 188 that stands only once the owner approves it.

## What it is

The workroom's **Artifacts** tab gets two views:

- **Deliverables:** today's reviewed, versioned outputs, unchanged ([DESIGN.md](DESIGN.md#workroom-page), [decision 52](PRODUCT.md#decisions-needed)).
- **Builds:** new. What GitHub Actions built on the room's linked repository, shown the way GitHub shows a workflow run's artifacts.

Only a room with a linked, ready managed repository shows **Builds**. Other rooms show the Artifacts tab as it is today, with no second view.

Builds is a window onto GitHub. **Podster stores no artifact bytes, runs no scan on them and hosts no copy.** A download comes from GitHub. Retention is GitHub's: the repository's artifact retention setting, 90 days by default. Podster shows GitHub's `expires_at` and never extends it.

Builds never counts as review. A build artifact isn't a submission, can't be approved, and doesn't change a task's state or the **Approved** badge on a deliverable.

## The Builds view

Workflow runs on the room's linked repository, newest first, one group per run, 20 runs a page with **Load more** as elsewhere ([decision 61](PRODUCT.md#decisions-needed)). Each run shows:

| Field | From GitHub | Shown as |
| --- | --- | --- |
| Workflow | `name` | Inert text |
| Run | `run_number`, and `run_attempt` when above 1 | "#42", "#42, attempt 2" |
| State | `status`, then `conclusion` once completed | **Queued**, **In progress**, **Succeeded**, **Failed**, **Canceled**, **Skipped**, **Timed out**, **Action required**. An icon and the word, never color alone ([DESIGN.md](DESIGN.md)) |
| Commit | `head_sha` | The first 7 characters, the full sha on hover and copy |
| Branch or pull request | `head_branch`, `pull_requests[].number` | Inert text, and "PR #12" when GitHub names one |
| Task | `head_branch` when it is exactly `podster/<task_id>`, Runner's task branch | The task's title, opening the Task Sheet, only when that task is in this room and the viewer can see it. Otherwise the branch as text, with nothing about the task |
| Started and duration | `run_started_at`, `updated_at` | "Started 10:42 · 3 min 10 s", or "Running for 2 min" |
| Link | Built by Podster | **View on GitHub**, `https://github.com/<owner>/<repo>/actions/runs/<run_id>` from the room's own repository link and GitHub's numeric run ID, never GitHub's `html_url` |

Under each run, its artifacts:

| Field | From GitHub | Shown as |
| --- | --- | --- |
| Name | `name` | Inert text |
| Size | `size_in_bytes` | "12.4 MB". GitHub's artifact is a zip of what the workflow uploaded |
| Digest | `digest`, when GitHub gives one | "sha256:3f9a…", full value on copy. "Not given" when GitHub's answer has none, which older artifacts don't |
| Expires | `expires_at`, `expired` | "Expires 20 Feb". An expired artifact shows **Expired** and no download |
| Download | | **Download**, only for a viewer allowed to, and only while not expired |

A task branch named in a run claims a task; it isn't evidence that the task's agent ran it, or that the build used the reviewed commit. The view says "Branch `podster/…`" beside the task and never marks a build as the task's verified output.

**States of the view.** Each says what is true and never assumes success ([DESIGN.md](DESIGN.md)):

- **Not configured:** the deployment can't read Actions yet, because the App's permission or its switch isn't set ([below](#which-app-reads)).
- **GitHub Actions is off for this repository:** today's state of every managed repository.
- **No workflow runs yet.**
- **Last updated 3 min ago · GitHub didn't answer:** the last list Podster read, with its time, while GitHub is unreachable or rate-limited.
- **Couldn't reach GitHub:** nothing read yet.

**In the Task Sheet (Proposed).** The engineering details already show the linked pull request, branch, commit and required checks ([PRODUCT.md](PRODUCT.md#review-merge-and-optional-cloudflare-deployment)). They may also show the latest workflow runs on the task's branch, `podster/<task_id>`, with their artifacts, under the same rules as the Builds view. Whether to is an [open question](#open-questions).

## Agent content is data

Workflow names, run titles, branch names and artifact names come from files and branches that agents write. They are shown as inert text: no Markdown, no autolinking, no HTML, control characters removed, each capped in length (proposed: 200 characters, then an ellipsis). None of them becomes an instruction to an agent, a permission, a link or part of a URL. The only links are the fixed GitHub run URL and Podster's own download route, both built from numeric IDs and the room's own repository link.

## Who sees Builds and who can download

Decided in Rust from the room's current state on every read and every download. A cached list never decides. **Proposed, the stricter of the two readings, and an [open question](#open-questions):**

| Viewer | Builds list | Download |
| --- | --- | --- |
| Workroom owner and admins (people) | All runs | Yes |
| Someone with artifact scope `all` (Member, Coordinator) | All runs | Yes |
| A Member or Coordinator who is a task's assignee or named reviewer, without artifact scope `all` | Runs on that task's branch, `podster/<task_id>`, only | Yes, for those runs |
| Anyone else in the room, Guests and Public participants included, even on their own task's branch | Nothing: the Builds view isn't shown | No |
| An organization admin overseeing their own agent | Nothing | No |
| A public room's visitors, signed in or not | Nothing. Builds isn't part of the [public read surface](PRODUCT.md#public-and-private-participation) | No |

This is stricter than who can download a submitted file today (an artifact scope of `all`, its submitter and the task's named reviewer): a Guest or Public participant sees no runs, even on their own task's branch, until [open question 3](#open-questions) is answered. Anyone who sees a run sees all of its artifacts' names, sizes and digests.

**A public repository is still public on GitHub.** While managed repositories are public on GitHub's Free plan ([decision 181](PRODUCT.md#decisions-needed)), GitHub itself shows the repository's runs, and lets people signed in to GitHub download their artifacts. Podster's rule above limits Podster's view only. It doesn't make the builds private, and room setup must not imply it does.

## How it's read

Server side only, in the private Rust API. The browser never calls GitHub's API or the private Rust API, and the gateway only authenticates and passes the request on; it decides nothing ([CLAUDE.md](../../CLAUDE.md), [ARCHITECTURE.md](ARCHITECTURE.md#build-artifacts-from-github-actions-proposed)).

1. The `Workspace` DO checks the viewer against the table above, from current state.
2. If its cached list for the room is younger than **60 seconds**, it answers from that, filtered for the viewer.
3. Otherwise it reserves two reads from the deployment's GitHub budget, mints a token (below) for the one repository, reads, revokes the token, stores the list with its time and answers. Two reads cover a page: `GET /repositories/{id}/actions/runs?per_page=20`, and `GET /repositories/{id}/actions/artifacts?per_page=100`, whose artifacts each name their `workflow_run.id`. A run on the page whose artifacts weren't in that answer gets its own `GET /repositories/{id}/actions/runs/{run_id}/artifacts` when its group is opened.

The repository is always the room's own link, addressed by GitHub's numeric ID. Nothing a client sends names a repository, an owner or an installation.

**The cache** is a read model in the DO: per room, the last list, when it was read, and GitHub's `ETag`, so a refresh can ask `If-None-Match` and a `304` costs no rate limit (GitHub's documentation). It holds no token and no download URL. One refresh runs at a time per room; viewers who arrive during it get the previous list or wait for the new one. It's never used to authorize, and it's dropped when the room's repository link changes or is removed.

**Rate limits.** The installation's limit is shared across every room the App is installed for, and with its merge work. Each read is reserved from the deployment's budget before it's made, as the release read does (`apps/api/src/github/release_read.rs`), and Podster's existing handling reads GitHub's limit headers (`podster_core::rate_limit`). On a primary or secondary limit Podster stops asking until GitHub's reset or `retry-after`, and shows the last list with its time. Merging takes priority: proposed, Builds may use at most a fixed share of the budget (a figure for the build PR), and a refresh that doesn't fit serves the cached list.

## Download

**Proposed: a redirect, not a stream.** Podster never holds the bytes.

1. The viewer opens Podster's download route for an artifact ID in the room.
2. The DO checks the viewer may download, from current state, as for the list.
3. The API mints a token for the one repository, reads `GET /repositories/{id}/actions/artifacts/{artifact_id}`, and refuses unless that artifact is in this repository, isn't expired, and its run is one the viewer may see.
4. It calls `GET /repositories/{id}/actions/artifacts/{artifact_id}/zip` without following redirects. GitHub answers `302` with a `Location` that GitHub's documentation says expires after one minute.
5. It revokes the token and answers `302` to that `Location`, with `Cache-Control: no-store` and `Referrer-Policy: no-referrer`. It checks only that the `Location` is an absolute `https` URL; it doesn't keep a list of GitHub's storage hosts, which GitHub doesn't promise.

Neither hop follows the redirect: the API's call to GitHub asks not to, and the gateway's call to the API over the service binding must pass the `302` back to the browser unfollowed. **Unverified:** that a service binding's `fetch` with `redirect: "manual"` hands the `302` back as is; the build's tests check it. A test must also check that the gateway's error path, when the API's answer is a redirect it doesn't expect, never logs the `Location`.

**Why a redirect.** Artifacts can be several gigabytes, and streaming them through a Worker would hold a request, spend its CPU and egress, and add nothing: Podster runs no scan on them, so proxying checks nothing a redirect doesn't. The URL GitHub signs reaches one artifact, carries no credential for anything else, lives about a minute, and is asked for only after Podster's check on that click. What it gives up: someone who has the URL can use it for that minute, and a download already started isn't cut off. Both are already true of a file once downloaded, and Deliverables downloads accept the second ([UPLOAD-POLICY.md](UPLOAD-POLICY.md#downloads)). The bytes are served from GitHub's storage host, never from a Podster origin, so they can't run on Podster's site.

**Never cached, never logged.** The signed URL isn't stored, cached, put in an event, an error or a log line, and the gateway passes the redirect on without logging it. Logs carry the room, artifact and run IDs and an outcome code only. Each click asks GitHub afresh.

Unlike an upload, which streams through Podster with no presigned URL because a presigned URL can't enforce a size or be revoked ([ARCHITECTURE.md](ARCHITECTURE.md#assets-and-versioned-artifacts-m2)), a download of bytes Podster doesn't hold has neither problem.

## Which App reads

**Proposed:** the **merge App**, `podster-staging-merge` on staging, gets the repository permission **Actions: read**. Its tokens are held only by the server and never returned to any caller, and it has no Administration. The provisioning App isn't used, because it holds Administration, and the agent-token App never gets Actions read, because agents' tokens must not gain it.

The App's token for Builds is cut down to **Actions read and Metadata read** on the one repository, like the merge App's marking and observing tokens (`TokenPermissions::MARKER` and `OBSERVER` in `crates/core/src/repo_access.rs`), checked against GitHub's answer, and revoked when the read ends. It can't write, merge, set a status or read the repository's contents. Actions read also reaches run logs, which Builds doesn't read.

**Owner granted 2026-11-21; installation checked the same day.** Adding Actions read to the App is a change in the GitHub organization, which is the owner's, not an agent's. On 2026-11-21 the owner granted it, and the architect checked the same day, through the organization's installations list, that the `podster-staging-merge` installation on `podsterdev` shows Actions read, Contents write, Metadata read, Pull requests write and Commit statuses write. **Not done:** a live read of runs or artifacts with the App's token. Its key isn't on the architect's machine; the API Worker would hold it. So the App's actual reach with Actions read is unverified. As with the checks reader (`GITHUB_AGENT_APP_READS_CHECKS` in `apps/api/src/workspace/changes.rs`), the build adds a switch the owner sets once the build is in place, with the permission already granted. Until then the view says **Not configured** and nothing is asked of GitHub.

## Turning Actions on: proposed rules

**Proposed** by the architect on 2026-11-21, drafted at the owner's request ("Yes, draft them"). These are a **proposed amendment to [decision 188](PRODUCT.md#decisions-needed)**, which has Actions off in every managed repository. Decision 188 stands unchanged until the owner approves them, and nothing here is built or set on any repository. Each claim about GitHub is labelled as in [ADR 0009](../adr/0009-managed-repositories.md#how-to-read-this): **Verified** only where the M5 spike saw it; **GitHub's documentation** where it was read and not run; **Unverified** otherwise.

1. **Agents can't add or change workflows.** GitHub refuses a change that creates or edits a file under `.github/workflows/` from a GitHub App token without the Workflows permission. **Verified, once,** through the contents API: the agent-token App's token got `403` ([spike](../../spikes/m5-github/README.md), item 10). Seen once on 2026-11-21 (spike PR #511): GitHub refused an agent-App `git push` that added or changed a workflow. The agent-token App holds Contents write, Pull requests write and Metadata read and no Workflows, and **no App whose tokens reach an agent ever gets Workflows**. Only a person, the room's owner or an admin acting in GitHub, adds or changes workflows on the default branch. Defence in depth, **done 2026-11-21** (the Runner change `fix: keep workflow files out of Runner's commits and quiet wrangler's metrics`): Runner refuses to publish any change under `.github/workflows/` (`work_tree_workflow`, [RUNNER.md](RUNNER.md#runner-clones-for-an-accepted-task)).
2. **A read-only `GITHUB_TOKEN`, and no pull request approvals.** The repository's default workflow permissions are read, and Actions may not create or approve pull requests (`default_workflow_permissions: read`, `can_approve_pull_request_reviews: false`). Provisioning already sets these today (`SetupStep::RestrictWorkflowPermissions`). **A caveat, GitHub's documentation:** this is a default, not a ceiling. A workflow file's own `permissions:` key can ask for write on a run that isn't from a fork. So the real limit is rule 1, that only people write workflows, and this rule on what they write. A task branch is in the same repository, not a fork, so a workflow that asked for write would run agent-written code (`npm test`, a build script) with that write token.
   **The rule for every workflow in a managed repository,** which a person writes: it declares a top-level `permissions:` with no write scope (`contents: read`, or `{}`), and its only triggers are `push`, `pull_request` from the same repository, and `workflow_dispatch` started by a person. Forbidden: `pull_request_target`, `workflow_run`, `repository_dispatch`, `issue_comment`, and release or tag triggers. Agents' tokens (Contents write, Pull requests write) can fire events like these, and the workflow would run with whatever it declares. How this rule is enforced, rather than left to convention, is an [open question](#open-questions). Podster ships no workflows of its own.
3. **No secrets.** Managed repositories hold no Actions secrets or variables, Podster never sets any, and no environments are created. A workflow therefore has nothing to leak but its own `GITHUB_TOKEN`.
4. **Allowed actions.** Only GitHub-owned actions plus an explicit allow-list, each pinned by full commit sha; no other Marketplace actions. **GitHub's documentation, not run:** the repository's Actions permissions take `allowed_actions: selected`, with `github_owned_allowed` and `patterns_allowed` set through the selected-actions endpoint, and a newer setting that requires actions to be pinned to a full-length sha. The allow-list is the owner's to approve.
5. **Forks.** While managed repositories are public ([decision 181](PRODUCT.md#decisions-needed)), workflows on pull requests from forks need approval for **all outside contributors**, GitHub's strictest fork approval setting (**GitHub's documentation, not run**). `pull_request_target` is forbidden by rule 2. Decision 188's rule that a fork's pull request is never a task change is unchanged.
6. **Checks don't gate merges.** The merge App's required `podster/review` status stays the only gate, because the review ruleset names the merge App as that status's only source. **Verified, once:** with another App's status the merge was refused (`405`). That ruleset, not the read-only token, is what keeps a workflow from gating or passing a merge. A workflow's results are shown, as checks and in Builds, and are informational.
7. **Runners and cost.** GitHub-hosted standard runners only, which GitHub documents as free for public repositories. No self-hosted runners, and no larger runners. A private managed repository's minutes would be billed, so **Actions stays off in any private managed repository** until the owner rules on spend.
8. **Artifact retention.** Provisioning sets each repository's artifact and log retention, proposed **30 days**, instead of GitHub's 90-day default. **GitHub's documentation, not run:** a repository-level retention setting exists in the REST API. The figure is the owner's.
9. **Provisioning.** `SetupStep::DisableActions` becomes a configure step that, with a deployment switch on, enables Actions and sets the repository settings in rules 2, 4, 5 and 8; readiness reads each back and fails closed, as it does for Actions off today (`verify_ready` in `crates/core/src/provisioning.rs`). The switch defaults off, and with it off behaviour is exactly today's: Actions off, and a repository isn't ready unless it is. A private repository is always set up with Actions off (rule 7).
10. **A spike before any code,** on `podsterdev`, to verify: (a) the agent-token App's token is refused pushing a workflow file, by the contents API and by `git push`; (b) a run's default `GITHUB_TOKEN` is read-only, and what a workflow's `permissions:` key can raise it to; (c) fork pull request approval applies to an outside contributor's pull request; (d) the provisioning App sets and reads back the settings in rules 2, 4, 5 and 8 with its existing Administration write; if it needs another permission, that's named and is the owner's; (e) whether the agent-token App's token can send `repository_dispatch`, which GitHub's documentation says needs Contents write, so it likely can (**unverified**).

**What needs the owner's yes:** turning Actions on at all, which loosens decision 188; the allow-list of actions; the retention figure; and any App permission the spike finds missing. Granting the merge App Actions read is already done (owner granted 2026-11-21; installation checked the same day).

## Out of scope

- Runner uploading build files.
- Previews of artifacts, or opening one in the browser.
- Copying artifacts into Podster's storage, scanning them or keeping them past GitHub's expiry.
- CI other than GitHub Actions, and repositories other than the room's managed one.
- Logs, re-running, canceling or approving a workflow from Podster.
- Turning GitHub Actions on in managed repositories, which this needs and doesn't decide. Its rules are [proposed above](#turning-actions-on-proposed-rules) as an amendment to decision 188.

## What the owner does

- Decide whether GitHub Actions runs in managed repositories, under the [proposed rules](#turning-actions-on-proposed-rules), with the allow-list, the retention figure and any App permission the spike finds missing ([decision 188](PRODUCT.md#decisions-needed) has it off).
- Done: the merge App's **Actions: read**. Owner granted 2026-11-21; installation checked the same day.
- Set the build's switch on staging once the permission is in place.

## Open questions

1. **Actions in managed repositories.** The [proposed rules](#turning-actions-on-proposed-rules) await the owner's yes and a spike. Without both, Builds stays empty.
2. **Which runs count.** All branches; or only task branches (`podster/<task_id>`) and the default branch, hiding runs on other branches.
3. **Who sees Builds.** The stricter table above, or the wider reading that a run's artifacts are like input assets and anyone who sees the whole room's tasks sees them all. And whether a Guest or Public participant should see runs on their own task's branch, which the table above refuses for now.
4. **The Task Sheet.** Whether Builds also appear in the Task Sheet's engineering details, for the task's branch.
5. **Agents.** Whether agents get the same list and download through a capability, and through A2A. A later contracts PR adds the route and capability; this proposal assumes the same rule as people.
6. **Webhooks.** Whether a signed `workflow_run` webhook nudges the cache, as pull request webhooks nudge a task's change, instead of reading only on view.
7. **Budget share.** The share of the installation's rate limit Builds may use, and the 60-second bound.
8. **Digest.** Whether an artifact with no GitHub digest should be marked more strongly, and whether Podster should ever show a digest it computed itself, which would mean reading the bytes.
9. **Enforcing the workflow rule.** How rule 2's rule on workflows is enforced: checked by provisioning's ready state, which would read every workflow file on the default branch; or Podster refusing to list builds from a workflow that breaks it; or both. Not left to convention.
