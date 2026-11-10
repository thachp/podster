# M5 spike: GitHub App tokens, branch rules and merge

**Status, 2026-11-10 UTC: run twice, once with the merge checks repeated on a public repository, plus one run of the merge-restriction mode.** Webhooks aren't run. See [results](#results-2026-11-10) and [results, merge restriction](#results-merge-restriction). This spike answers the ten [risks to test](../../docs/m5-plan.md#risks-to-test) in the M5 plan against a test GitHub organization. Nothing builds on this folder. Its results go into ADR 0009.

The permissions below worked for the calls the first run made. Whether each is the least that works isn't checked.

## Owner setup

Only the owner does these, because they create accounts and hold keys. About ten minutes. Nothing here costs money: stay on the Free plan and skip every upgrade offer.

### 1. Create the test organization

1. Open <https://github.com/organizations/plan> and choose **Free**.
2. Name it something that can't be mistaken for the real one, such as `podster-spike`. It belongs to your personal account.
3. Skip inviting members.

Leave every organization setting at its default. The spike records what the defaults allow.

### 2. Create the provisioning App

In the organization: **Settings → Developer settings → GitHub Apps → New GitHub App**.

| Field | Value |
| --- | --- |
| Name | `podster-spike-provision` (names are global; add a suffix if it's taken) |
| Homepage URL | `https://podster.dev` |
| Webhook → Active | **Unticked** |
| Where can this App be installed? | **Only on this account** |

Repository permissions:

| Permission | Access |
| --- | --- |
| Administration | Read and write |
| Contents | Read and write |
| Pull requests | Read and write |
| Commit statuses | Read and write |
| Actions | Read-only |
| Metadata | Read-only (GitHub sets this) |

Leave everything else at **No access**, including **Workflows** and all organization and account permissions.

Commit statuses write is here for the spike only: it lets the script check that a status from the wrong App doesn't satisfy a rule pinned to the merge App. The real provisioning App wouldn't hold it.

After **Create GitHub App**:

1. Note the **App ID** on the App's page.
2. **Generate a private key.** A `.pem` file downloads.
3. **Install App** → the test organization → **All repositories**.

### 3. Create the merge App

The same steps, with the name `podster-spike-merge` and these repository permissions:

| Permission | Access |
| --- | --- |
| Contents | Read and write |
| Pull requests | Read and write |
| Commit statuses | Read and write |
| Metadata | Read-only |

No Administration. Note its App ID, generate its key, and install it on **All repositories** too.

### 4. Put the keys where the script reads them

The keys stay on your machine, outside the repository. Don't paste them into chat.

```bash
mkdir -p ~/.podster/m5-spike && chmod 700 ~/.podster/m5-spike
```

Move the two downloads there under these names (adjust the source file names):

```bash
mv ~/Downloads/podster-spike-provision.*.private-key.pem ~/.podster/m5-spike/provision.pem
```

```bash
mv ~/Downloads/podster-spike-merge.*.private-key.pem ~/.podster/m5-spike/merge.pem
```

```bash
chmod 600 ~/.podster/m5-spike/*.pem
```

### 5. Tell the architect

Three things, none of them secret: the organization's name and the two App IDs.

## What isn't covered yet

- **Webhooks (risk 8).** The Apps have webhooks off, because there is no public endpoint to receive them. That part runs later and needs a webhook URL and secret.
- **The real organization.** Its name, ownership and legal terms are still open in the M5 plan.

## Cleaning up

Delete the test organization when ADR 0009 is accepted. That removes its repositories, both Apps and their keys.

## Running it

The architect runs this once the owner's setup is done. It needs Node 22 or later and no packages.

```bash
M5_ORG=<org> M5_PROVISION_APP_ID=<id> M5_MERGE_APP_ID=<id> node spike.mjs
```

It refuses an organization whose name has no hyphen-separated part that is `spike`, `test` or `sandbox`, unless `M5_CONFIRM_ORG` repeats the name exactly. The owner pointed the spike at `podsterx`, so its runs set that. It creates two private repositories named `m5-spike-<time>-a` and `-b`, and every merge result records whether a ruleset was active on that repository. It writes status codes and GitHub's messages to `results/`, and never prints or stores a token. `--allow-public` repeats the rule and merge checks on a public repository if the private one refuses a ruleset, which a Free organization may do. `--merge-restriction` runs only the check of whether a ruleset can restrict who merges: it creates one public repository named `m5-spike-<time>-restrict` and skips everything else. It refuses to be combined with the other flags, and its scoped agent token is revoked when it ends. `--cleanup` deletes the spike's repositories, and `--cleanup --public-only` deletes only its public ones.

```bash
node --test spike.test.mjs
```

The test is offline: it checks the App JWT, the organization-name guard and the ruleset bodies the merge-restriction mode sends.

## Results, 2026-11-10

Two runs against `podsterx` (Free plan), with the provisioning App (ID 5693929) and the merge App (ID 5693945), both created by the architect in the owner's browser on the owner's say. The second run used `--allow-public`, with the owner's yes, and its public repository was deleted afterwards (`204` from the cleanup; the results files don't record it). The private-repository results were the same in both runs. The public-repository results were seen once.

| Risk | Question | What GitHub did |
| --- | --- | --- |
| 1 | Can the App create a repository in the organization? | Yes. `201` for a private repository, with repository Administration write and no organization permission. |
| 2 | Is a new repository under the installation at once? | Yes on both runs. A token scoped to it was minted on the first try, straight after the second repository was created; the gap wasn't measured. It expires after one hour. |
| 3 | Can a token be limited to one repository and fewer permissions? | Yes. The token held contents and pull requests write plus metadata read. It got `404` on the other repository, `403` on repository settings and on creating a ruleset. Asking for a permission the App lacks returned `422`. |
| 4 | Can the agent's token merge to the default branch? | **Only a commit the merge App has marked, on the two paths tried, once.** Those were a commit through the contents API and a merge with the `merge` method; `git push`, ref updates, squash, rebase and bypass weren't tried. With the ruleset active on a public repository, a direct commit got `409` and a merge got `405`, both "Required status check `podster/review` is expected". A status from the provisioning App didn't count: `405` "was not set by the expected GitHub app". Once the merge App set the status on that commit, **the agent's own token merged the pull request** (`200`). With no ruleset, on a private repository, the token committed straight to the default branch and merged freely. |
| 5 | Do rulesets apply to private repositories on the Free plan? | **No.** `403`: "Upgrade to GitHub Pro or make this repository public to enable this feature." |
| 6 | Does merge refuse a head that differs from the given `sha`? | Yes, with and without a ruleset. `409` "Head branch was modified" after a new push. With the ruleset active, the new head had no status and even the merge App got `405`; after it set the status on the new head, the merge returned `200`. The base had moved by then and the merge still went through, with the strict policy off. |
| 7 | What can be revoked? | A single token can be. `DELETE /installation/token` returned `204`, the token got `401` on the next request, and another token from the same installation kept working. Suspending or uninstalling the installation wasn't tested. |
| 8 | Webhooks | Not run. |
| 9 | Rate limits | 5,000 requests an hour for the installation, REST and GraphQL each. Whether that fits the polling design isn't worked out. |
| 10 | Can the agent push a workflow? | No. `403` without the Workflows permission. Whether a workflow that is already in the repository can be abused wasn't tested. |

Also seen: the agent's token got `403` setting a commit status, and a second merge call on an already merged pull request returned `200` again, so merge calls after the first on the same pull request say nothing.

**What this means for the design.**

- Without a ruleset, a token with contents write is a merge token. The boundary depends on rules, and on the Free plan rules need a public repository. Private managed repositories need a paid plan.
- A status pinned to the merge App stopped unreviewed code on the paths tried: only the commit that App marked reached the default branch, and a new push needed a new status.
- The rule gates the commit, not who merges. After the merge App marks a commit, the agent's token can merge it itself. So Podster can't assume `merge_task` is the only path to a merge. ADR 0009 has to choose. Three candidates so far: the merge App sets the status only at the moment it merges, which still leaves a short window between the two calls (the spike waited three seconds); a merge by the agent of the exact reviewed commit is accepted and observed; or a rule restricts who may merge, which the [merge-restriction run](#results-merge-restriction) tested afterwards.

**What's left.** Webhooks; whether rules behave the same on a private repository under a paid plan; `git push` over HTTPS and the squash and rebase merge methods against the update restriction; workflows already in a repository; and whether 5,000 requests an hour fits the polling design.

## Results, merge restriction

One run of `--merge-restriction` on 2026-11-10 against `podsterx` (Free plan), on one public repository that was deleted afterwards. The delete's `204` and the organization then listing 0 public repositories were seen on the console and aren't in a results file; `--cleanup` records its deletes from now on. **Every row was observed once.** The agent's token was scoped to that repository with contents and pull requests write, issued by the provisioning App. Three variants ran in turn on the same repository, so they aren't independent: each variant's rulesets were deleted before the next and every delete returned `204`, but the run made no `GET /rulesets` check that none was left, in particular between (b) and (c). The script now lists the rulesets before and after each variant and skips a variant that doesn't start clean; that check hasn't run against GitHub. All rulesets targeted `~DEFAULT_BRANCH` with enforcement `active`. The `update` rule was sent with `update_allows_fetch_and_merge: false`, and the bypass actor was `{ "actor_id": 5693945, "actor_type": "Integration", "bypass_mode": "always" }`, the merge App.

- **(a)** one ruleset: `pull_request` + `required_status_checks` (pinned to the merge App) + `update`, merge App bypasses.
- **(b)** one ruleset: `pull_request` + `update`, no status rule, merge App bypasses.
- **(c)** two rulesets: `pull_request` + `required_status_checks` with no bypass actor; and `update` alone, merge App bypasses.

GitHub's messages all began "Repository rule violations found"; the table gives the lines after it.

| Attempt | (a) | (b) | (c) |
| --- | --- | --- | --- |
| Create the ruleset(s) with the provisioning App's token | `201`, bypass actor echoed back | `201`, bypass actor echoed back | `201` and `201` |
| Agent commits straight to the default branch (contents API) | `409` "Changes must be made through a pull request." "Required status check "podster/review" is expected." "Cannot update this protected ref." | `409` "Changes must be made through a pull request." "Cannot update this protected ref." | `409`, the same three lines as (a) |
| Agent moves the default branch ref to the pull request's head (`PATCH git/refs`, fast-forward), status present where required | `422` "Cannot update this protected ref." | `422` "Cannot update this protected ref." | `422` "Cannot update this protected ref." |
| **Agent merges the pull request, status present where required** | **`405` "Cannot update this protected ref."** | **`405` "Cannot update this protected ref."** | **`405` "Cannot update this protected ref."** |
| **Merge App merges the same pull request** | **`200` "Pull Request successfully merged"** | **`200` "Pull Request successfully merged"** | **`200` "Pull Request successfully merged"** |
| Merge App merges a second pull request with no status on its head | `200` "Pull Request successfully merged" | not run (no status rule) | `405` "Required status check "podster/review" is expected." |
| Merge App commits straight to the default branch (contents API) | `201` | `201` | `409` "Changes must be made through a pull request." "Required status check "podster/review" is expected." |

Each merge attempt read the pull request before and after: it was unmerged before every attempt in the table, still unmerged after each refusal, and merged after each `200`.

**No control in this run.** No variant here had the `pull_request` and status rules without the `update` rule. The comparison is risk 4 in the [table above](#results-2026-11-10): on a public repository with `pull_request` + the pinned status only, the agent's token merged with `200` once the merge App had set the status. That was a different repository and an earlier run, also seen once.

**The three things asked.**

- **Does the restriction work?** On the paths tried, once each, yes. With an `update` rule and the merge App as the bypass actor, the agent's token was refused at the merge even with the merge App's status on the head, and the merge App's token merged the same pull request.
- **Does the App need an extra permission to bypass?** None was added. The merge App held contents, pull requests and commit statuses write plus metadata read, and no Administration. Being named in `bypass_actors` was enough. Creating the ruleset used the provisioning App's Administration write; whether a lesser permission can create one wasn't tried.
- **Does `bypass_actors` work on the Free plan?** Yes on a public repository: every create returned `201` with enforcement `active`. Private repositories on Free refuse any ruleset (risk 5), so this wasn't tried there.

**What it means for the three ADR candidates.**

- The third candidate, a rule that restricts who merges, held where it was tried. With the `update` rule and the merge App as bypass actor, the agent's token was refused the merge of a commit the merge App had marked. Each refusal was seen once, with the `merge` method only; the same token was also refused a contents-API commit and a ref update. Against the earlier run, where that merge returned `200`, this is the difference the `update` rule made, with the limits in the paragraph on the control above.
- Bypass is per ruleset, not per rule. In (a) the merge App bypassed the status and pull request rules too: it merged a head with no status and committed straight to the default branch. With the rules split as in (c), the merge App was refused both.
- (c) binds the merge App only to "the status exists on the head", and the merge App sets that status itself. So (c) doesn't stop the merge App from marking a commit and then merging it. Whether a merge is allowed is still decided in Podster's Rust; GitHub's rule doesn't replace that check.
- (b) shows the agent was refused without any status rule.

**Not tried.** `git push` over HTTPS with either token; the `squash` and `rebase` merge methods; the `creation` rule, which doesn't bear on an existing default branch; bypass modes `pull_request` and `exempt`; a private repository on a paid plan; organization-level rulesets; an agent token that also holds other permissions; and whether anyone else with bypass or admin rights (organization owners weren't named as bypass actors here) is held by the rule. Rulesets were created by the provisioning App, so an agent token can't change them (`403`, risk 3), but anything holding Administration write can.

**Sources checked before coding** (REST API version `2022-11-28`):

- [REST API endpoints for rules: create a repository ruleset](https://docs.github.com/en/rest/repos/rules?apiVersion=2022-11-28#create-a-repository-ruleset) for the `bypass_actors` shape (`actor_id`, `actor_type`, `bypass_mode`). The run used `Integration` and `always` only. The page was read through a fetch tool that summarizes it, which listed the other `actor_type` values as `OrganizationAdmin`, `RepositoryRole`, `Team`, `DeployKey` and `User`, and the other `bypass_mode` values as `pull_request` and `exempt`; `User` and `exempt` in particular weren't checked against the page itself or tried. Also used for the rule types, including `update` with its required `update_allows_fetch_and_merge` and `creation` with no parameters.
- [Available rules for rulesets](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets) for what "Restrict updates" and "Restrict creations" mean: only those with bypass permission may push to or create matching refs.
- [Creating rulesets for a repository](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/creating-rulesets-for-a-repository) and [About rulesets](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/about-rulesets) for GitHub Apps as bypass actors. Neither page states an extra permission the App must hold; the run above is the evidence that none was needed.
