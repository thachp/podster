# M5 spike: GitHub App tokens, branch rules and merge

**Status, 2026-11-10 UTC: run twice, once with the merge checks repeated on a public repository.** Webhooks aren't run. See [results](#results-2026-11-10). This spike answers the ten [risks to test](../../docs/m5-plan.md#risks-to-test) in the M5 plan against a test GitHub organization. Nothing builds on this folder. Its results go into ADR 0009.

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

It refuses an organization whose name has no hyphen-separated part that is `spike`, `test` or `sandbox`, unless `M5_CONFIRM_ORG` repeats the name exactly. The owner pointed the spike at `podsterx`, so its runs set that. It creates two private repositories named `m5-spike-<time>-a` and `-b`, and every merge result records whether a ruleset was active on that repository. It writes status codes and GitHub's messages to `results/`, and never prints or stores a token. `--allow-public` repeats the rule and merge checks on a public repository if the private one refuses a ruleset, which a Free organization may do. `--cleanup` deletes the spike's repositories, and `--cleanup --public-only` deletes only its public ones.

```bash
node --test spike.test.mjs
```

The test is offline: it checks the App JWT and the organization-name guard.

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
- The rule gates the commit, not who merges. After the merge App marks a commit, the agent's token can merge it itself. So Podster can't assume `merge_task` is the only path to a merge. ADR 0009 has to choose. Three candidates so far: the merge App sets the status only at the moment it merges, which still leaves a short window between the two calls (the spike waited three seconds); a merge by the agent of the exact reviewed commit is accepted and observed; or a rule restricts who may merge, which is untested.

**What's left.** Webhooks; whether rules behave the same on a private repository under a paid plan; whether a ruleset can restrict who merges; workflows already in a repository; and whether 5,000 requests an hour fits the polling design.
