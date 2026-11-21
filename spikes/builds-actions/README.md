# Builds spike: GitHub Actions rules on podsterdev

**Status, 2026-11-21 UTC: run once on `podsterdev`, then cleaned up.** The owner said on 2026-11-21: "go ahead and run the podsterdev test". This checks the proposed rules in [BUILDS.md](../../docs/spec/BUILDS.md), section "Turning Actions on: proposed rules" (on PR #509's branch until it merges), rule 10's items (a) to (d), plus two checks the architect added: (e) `repository_dispatch` and (f) tags and releases from an agent's token. It also checks Builds' read path with the merge App's token. Nothing builds on this folder.

Each result was **seen once**, on one public repository, `builds-spike-20261121142858`, which the provisioning App created and `--cleanup` deleted. No organization setting, App setting or other repository was changed. Raw results: [`results/20261121142858.json`](results/20261121142858.json) and [`results/20261121143132-cleanup.json`](results/20261121143132-cleanup.json). They hold status codes, GitHub's messages and run fields only: no token, key or signed URL.

## How it runs

```bash
cd spikes/builds-actions
node --test spike.test.mjs
BUILDS_ORG=podsterdev BUILDS_CONFIRM_ORG=podsterdev BUILDS_SCRATCH=<scratch dir> node spike.mjs
BUILDS_ORG=podsterdev BUILDS_CONFIRM_ORG=podsterdev node spike.mjs --cleanup
```

It refuses to run unless both variables are exactly `podsterdev`. It uses the three staging Apps in ADR 0009 (provision 5695065, agent 5695079, merge 5695088), with keys read by path from `~/.podster/m5-staging/` (`BUILDS_KEY_DIR` overrides). The person's steps (adding workflows on the default branch, as an owner would) go through the `gh` CLI's existing login, with bodies on stdin.

Tokens minted, each scoped to the one repository except the one that creates it:

| Token | Permissions asked | Granted |
| --- | --- | --- |
| provision, unscoped | (installation's) | administration write, metadata read |
| provision, repo | administration write | administration write, metadata read |
| agent, repo | contents write, pull_requests write | contents write, metadata read, pull_requests write |
| merge, repo | actions read, metadata read | actions read, metadata read |

Every minted token was revoked at the end: five `DELETE /installation/token`, five `204`.

`git push` runs in an isolated environment: no system or global git config, the credential helper emptied, and the token passed as an `http.extraheader` through `GIT_CONFIG_*` variables, never in argv or a URL. The clone lives in a temporary folder that is deleted afterwards.

## Results

All 2026-11-21, seen once.

| Check | What was tried | Status | What was seen |
| --- | --- | --- | --- |
| (a) | Agent token: create `.github/workflows/x.yml` on `podster/tsk_spike…` via contents API | `403` | "Resource not accessible by integration" |
| (a) | Agent token: modify existing `.github/workflows/default-perms.yml` via contents API | `403` | "Resource not accessible by integration" |
| (a) | Agent token: `git push` adding `.github/workflows/y.yml` | rejected, exit 1 | "refusing to allow a GitHub App to create or update workflow `.github/workflows/y.yml` without `workflows` permission" |
| (a) | Agent token: `git push` modifying `default-perms.yml` | rejected, exit 1 | Same message, naming `default-perms.yml` |
| (a) | Agent token: `git push` of a normal file (control) | accepted, exit 0 | Pushed; triggered the push workflows |
| (d) | Provision token: `PUT …/actions/permissions` `{enabled: true, allowed_actions: selected, sha_pinning_required: true}` | `204`, read back `200` | Before: `allowed_actions: all`, `sha_pinning_required: false`. After: `selected`, `true` |
| (d) | `PUT …/actions/permissions/selected-actions` GitHub-owned plus `actions/checkout@<sha>`, `actions/upload-artifact@<sha>` | `204`, read back `200` | Read back exactly as sent; `verified_allowed: false` |
| (d) | `PUT …/actions/permissions/workflow` `{default_workflow_permissions: read, can_approve_pull_request_reviews: false}` | `204`, read back `200` | Already `read` / `false` before the call (new repository's default here); unchanged after |
| (d), (c) | `PUT …/actions/permissions/fork-pr-contributor-approval` `{approval_policy: all_external_contributors}` | `204`, read back `200` | Before: `first_time_contributors`. After: `all_external_contributors` |
| (d) | `PUT …/actions/permissions/artifact-and-log-retention` `{days: 30}` | `204`, read back `200` | Before: `90` (`maximum_allowed_days: 90`). After: `30` |
| (d) | `GET …/actions/permissions/access` (read only) | `422` | "Access policy only applies to internal and private repositories." Expected for a public repository |
| (b) | Person adds five workflows on `main` through `gh` | `201` each | |
| (b) | Run of `default-perms` (no `permissions:` key) on push to `podster/**` | success | `GITHUB_TOKEN` permissions in the job log: Contents read, Metadata read, Packages read. Commit status write `403`; create ref `403`. Artifact uploaded |
| (b) | Run of `raised-perms` (`permissions: contents: write`) | success | Token: Contents write, Metadata read. Create ref `201`; commit status `403` (not asked for). Artifact uploaded |
| (e) | Agent token: `POST /repos/…/dispatches` `{event_type: spike}` | `204` | The person-written `on: repository_dispatch` workflow ran on `main` (event `repository_dispatch`), success |
| (f) | Agent token: create tag `refs/tags/spike-tag1` via git refs | `201` | The `on: push: tags: [spike-*]` workflow ran (event `push`, head_branch `spike-tag1`) |
| (f) | Agent token: create release `spike-rel1` | `201` | The `on: release: [published, created]` workflow ran twice (event `release`), and the release's new tag also ran the tag workflow (head_branch `spike-rel1`) |
| read | Merge token (actions + metadata read): list runs | `200` | 9 runs, each with `head_branch`, `head_sha`, `status: completed`, `conclusion: success`. Creating the task branch by the API also triggered the push workflows, so each push workflow ran twice |
| read | List run artifacts | `200` | Each artifact has `digest` in the form `sha256:<64 hex>`, `expires_at`, and `workflow_run.head_branch` / `head_sha` |
| read | Artifact zip, redirect not followed | `302` | `Location` host `productionresults<n>.blob.core.windows.net` (n varied: 6, 14, 18, 31), with an `se` expiry parameter. The expiry's length wasn't recorded |
| read | Job logs, redirect not followed | `302` | Same kind of host, with `se` |
| read | List runs with `If-None-Match` | `304` | `X-RateLimit-Remaining` 4953 on the plain `200`, still 4953 on the `304`; the next plain `200` made it 4952, and the `304` after it left it at 4952. A `304` didn't count |
| billing | `GET …/actions/runs/{id}/timing` for all 9 runs | `200` | `billable.UBUNTU.total_ms: 0` for every run; runners `ubuntu-latest`, group "GitHub Actions" |
| cleanup | Provision token: `DELETE /repos/podsterdev/builds-spike-20261121142858` | `204` | `gh api orgs/podsterdev/repos` afterwards listed only `e2e-m5-202611120015-ae33`, `e2e-m5-202611120015-ae33-7c9b19` and `hello-world` |

## What this says about BUILDS.md's proposed rules

- **Rule 1 held, now by both routes.** The agent App's token was refused adding or changing a workflow through the contents API (`403`) and through `git push` over HTTPS (rejected, naming the missing `workflows` permission), while a normal push with the same token worked.
- **Rule 2 held, and its caveat is real.** A workflow with no `permissions:` key got a read-only token (Contents, Metadata and Packages read) and couldn't create a ref or a commit status. A workflow asking for `contents: write` got it and created a branch (`201`). So the read default is not a ceiling, as the rule says.
- **Rule 4's settings set and read back,** with `sha_pinning_required: true` accepted. **Not tested:** that a run using an unpinned or unlisted action is actually refused. Both probe workflows used allowed, pinned actions.
- **Rule 5's setting set and read back** (`all_external_contributors`). **Unverified:** the behaviour on a real fork pull request, check (c). No second account was used.
- **Rule 6's "a read-only token can't set a commit status" held** (`403`), and a token raised to `contents: write` couldn't set one either.
- **Rule 7: nothing billed.** Every run on the public repository was standard `ubuntu-latest` with `billable` 0 ms.
- **Rule 8 held:** retention went from 90 to 30 days and read back.
- **Rule 9 needs no new permission.** The provisioning App's Administration write was enough for every setting in rules 2, 4, 5 and 8.
- **New, from (e) and (f): an agent's token can fire events other than `push`.** With only Contents write it sent `repository_dispatch` (`204`), created a tag (`201`) and created a release (`201`), and each ran a person-written workflow. Those workflows' files come from the default branch or the tagged commit, which agents can't change under `.github/workflows/`, but a tag can point at any commit the agent pushed, and `repository_dispatch` carries a `client_payload` the agent chooses. A person's workflow on these triggers would run agent-chosen code or data, just as a push workflow does on a task branch. Rule 1 doesn't stop the triggering; rule 2's advice (state `permissions: contents: read`) matters for these triggers too.
- **Builds' read path works with Actions read only,** and its assumptions held: artifacts carry a `sha256:` digest, the zip comes as a `302` to a signed `blob.core.windows.net` URL with an expiry, and a conditional list's `304` didn't spend rate limit.

## Surprises

- The default read token also carried **Packages: read**, not only Contents and Metadata.
- **Creating a branch through the API is a push** and ran the push workflows, so a task branch's first push runs them once before any code change.
- One release ran the release workflow **twice** (`created` and `published`) and also the tag workflow for the tag it created.
- On this new repository, `default_workflow_permissions` was already `read` and `can_approve_pull_request_reviews` already `false` before the spike set them; the organization's defaults may be doing that. Fork approval and retention were GitHub's defaults (`first_time_contributors`, 90 days).

## Not covered

- (c) a real fork pull request from an outside account.
- Whether `sha_pinning_required` and the allow-list refuse a run that breaks them.
- How long the zip's signed URL lasts (BUILDS.md cites one minute from GitHub's documentation).
- A private repository; Actions stays off there under rule 7.
