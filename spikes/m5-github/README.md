# M5 spike: GitHub App tokens, branch rules and merge

**Status, 2026-11-10 UTC: not run.** This spike answers the ten [risks to test](../../docs/m5-plan.md#risks-to-test) in the M5 plan against a test GitHub organization. Nothing builds on this folder. Its results go into ADR 0009.

Every permission below is from memory of GitHub's documentation and is unverified. Finding the least set that works is part of the spike, so expect this list to change.

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

It refuses an organization whose name doesn't contain `spike`, `test` or `sandbox`. It creates two private repositories named `m5-spike-<time>-a` and `-b`, and every merge result records whether a ruleset was active on that repository. It writes status codes and GitHub's messages to `results/`, and never prints or stores a token. `--allow-public` repeats the rule and merge checks on a public repository if the private one refuses a ruleset, which a Free organization may do. `--cleanup` deletes the spike's repositories.

```bash
node --test spike.test.mjs
```

The test is offline: it checks the App JWT and the organization-name guard. The script itself hasn't run against GitHub.
