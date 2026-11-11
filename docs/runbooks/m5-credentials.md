# M5 credentials: rotation and compromise

The runbook [ADR 0009](../adr/0009-managed-repositories.md#key-rotation-and-compromise) promised before M5's gate. It covers the five secrets managed repositories use, on staging, which is the only deployment.

**Written on 2026-11-11 from the code at `8e6ab69`, the [M5 security review](../security/m5-review.md) and GitHub's documentation. Nobody has followed it yet.** No step here has been tried against staging or GitHub. Where a step rests on something unverified, it says so.

It uses only what exists today. Where a step needs something that doesn't exist, the gap is written down with what to do by hand instead. The gaps are [listed together](#gaps) at the end.

## Who does what

- **The owner** sets and deletes every Worker secret, generates and deletes App keys on GitHub, changes an App's webhook secret, and suspends or uninstalls an App's installation. Nobody else does. Steps marked **Owner** are these.
- **The architect, or an agent the owner asks,** prepares the exact commands, changes configuration through a pull request, deploys with `scripts/deploy-staging`, and checks afterwards.
- Never paste a key, a token or a secret into a pull request, an issue, a log or a chat.

## The credentials

| Secret | Worker | What it is |
| --- | --- | --- |
| `GITHUB_PROVISION_APP_KEY` | API | Private key of `podster-staging-provision`, as the PEM GitHub gives |
| `GITHUB_AGENT_APP_KEY` | API | Private key of `podster-staging-agent` |
| `GITHUB_MERGE_APP_KEY` | API | Private key of `podster-staging-merge` |
| `REPO_TOKEN_KEY` | API | 64 hex characters. Seals each agent's repository token in its room, only so it can be revoked |
| `REPO_TOKEN_KEY_PREVIOUS` | API | Optional. The key before a rotation. It opens sealed tokens and never seals |
| `GITHUB_WEBHOOK_SECRET` | Gateway | At least 32 characters. The same value is the webhook secret of all three Apps |

The Apps' IDs and installation IDs are variables in `apps/api/wrangler.jsonc`, not secrets. [staging.md](../staging.md#managed-repositories-on-staging) has the full list. Nothing in this repository says whether a secret is set.

The API reads each key from its secret at every use, so a changed secret is used by the next call. It refuses a role whose App ID, installation ID or key is another role's, with the log line `repo_token.app_not_distinct` or `merge.app_not_distinct`; provisioning says only that it isn't configured. That comparison isn't complete today ([C-7](../security/m5-review.md#credentials-github-and-webhooks)), so check by eye that three different keys are set.

## What a holder could do, at most

From ADR 0009, the review and the code. "Verified" is the spike's or the staging run's, each seen once.

### The provisioning App's key

- Sign as the App and mint a token for the whole installation, with every permission the App has: Administration write and Metadata read.
- With it: remove a repository's rulesets, add a bypass actor, and delete repositories, in every managed repository. **Verified** for the spike's provisioning token (`204`, `201`, `204`). By its permission, also change visibility and create repositories in `podsterdev`.
- ADR 0009's words: "With the rules gone it can do anything." The App's own permissions carry no Contents write, so that means through what Administration can change, such as who may bypass or collaborate.
- This is the worst of the three.

### The agent-token App's key

- Mint a token for any managed repository, or for the whole installation: Contents write, Pull requests write, Metadata read.
- With it: create, force-push and delete any branch but the default one; create and delete tags; by GitHub's permission model, create releases with assets (untried); open, edit, close and comment on pull requests ([C-3](../security/m5-review.md#credentials-github-and-webhooks)).
- Not: push to or merge into the default branch, set `podster/review`, or change rules or settings. **Verified** once for an agent's own token on staging; the spike saw the full installation token refused every administrative call.
- Use up the installation's rate limit, 5,000 requests an hour at least, which stops Podster's own reads in every room ([C-1](../security/m5-review.md#credentials-github-and-webhooks)).

### The merge App's key

- Mint a token with Contents write, Pull requests write and Commit statuses write.
- With it: set `podster/review` on any commit and merge any pull request into the default branch of any managed repository. The update ruleset names this App as its one bypass actor.
- Not: change rules or settings. It has no Administration.

### `REPO_TOKEN_KEY` and `REPO_TOKEN_KEY_PREVIOUS`

- **Alone, nothing.** The sealed tokens are in each room's Durable Object storage, which isn't reachable from outside the API Worker.
- **With a copy of a room's storage:** open the tokens that room holds. Each is one agent's token for one repository, with the agent-token permissions above, and lives at most an hour from its minting. A sealed token opens only for the room, repository, grant, agent and task it was sealed for.
- So a leak of this key matters only together with a compromise of the API Worker or its storage, and that also exposes the three App keys. Treat it as [everything at once](#the-api-worker-or-several-secrets-at-once).
- **Losing** the key, with no leak, means held tokens can't be revoked. They live out their hour.

### `GITHUB_WEBHOOK_SECRET`

- Sign deliveries the gateway accepts. A delivery is a nudge: it carries IDs and one commit ID, and Podster records only what its own read of GitHub shows.
- At most: cause reads of a repository's pull requests, up to 60 an hour for a room, each about three GitHub calls on the shared installation, and so slow down what Podster notices; put a change the refresh job gave up on back on watch ([C-10](../security/m5-review.md#credentials-github-and-webhooks)); and learn by timing which repository IDs are managed.
- Not: change a task, a grant, a merge or a link.
- A captured genuine delivery can be replayed until the secret changes, since a delivery carries no time ([C-11](../security/m5-review.md#credentials-github-and-webhooks)). The room takes one body once.

## Routine rotation

### An App's private key

GitHub's documentation says an App can have up to 25 private keys at once, and that keys don't expire and are revoked by hand (read 2026-11-11). So a new key is added before the old one goes, with no gap. Do one App at a time.

1. **Owner:** in `podsterdev`'s settings, open the App and generate a new private key. GitHub downloads the PEM once.
2. **Owner:** set it as that role's secret on the API Worker. `wrangler secret put` puts it on the deployed Worker; no `scripts/deploy-staging` run is needed.

   ```bash
   cd apps/api && npx wrangler secret put GITHUB_AGENT_APP_KEY --env staging
   ```

   The other two are `GITHUB_PROVISION_APP_KEY` and `GITHUB_MERGE_APP_KEY`. Paste the PEM as GitHub gave it: one block, PKCS#1 or PKCS#8. A value that doesn't parse reads as "not configured", and that role stops until it's fixed.
3. **Check that the new key works before deleting the old one.** There's no health check that mints a token ([gap](#gaps)). What shows it, for someone tailing the API Worker's log:
   - **Agent-token key:** an agent's `get_repo_access` logs `repo_token.issued`, or any submission of a linked task reads its pull request without `task_change.read_failed`. A bad key logs `repo_token.mint_failed`.
   - **Merge key:** a merge logs `merge.succeeded`. A bad key leaves `merge.waiting`.
   - **Provisioning key:** a new repository request becomes `ready`, or a merge passes its readiness read, which uses this App.
   - `e2e/m5-staging.mjs` exercises all three in one run. It costs two test sign-ups and leaves one public repository in `podsterdev` for the owner to remove.
4. **Owner:** delete the old key in the App's settings on GitHub. GitHub's page doesn't say how soon a deleted key stops working. **Unverified.**
5. **Owner:** delete the downloaded PEM file.

Rotating a key doesn't end tokens already minted with the old one. Each lives out its hour unless Podster revokes it.

### `REPO_TOKEN_KEY`

A token lives at most an hour, so the old key is needed for an hour after the change. The code tries the current key first and then the previous one to open a sealed token, and seals with the current key only.

1. **Owner:** set `REPO_TOKEN_KEY_PREVIOUS` to the current key.
2. **Owner:** set `REPO_TOKEN_KEY` to the new key, 64 hex characters such as `openssl rand -hex 32` prints.
3. Wait at least 65 minutes.
4. **Owner:** delete `REPO_TOKEN_KEY_PREVIOUS`.

```bash
cd apps/api && npx wrangler secret put REPO_TOKEN_KEY_PREVIOUS --env staging
```

```bash
cd apps/api && npx wrangler secret put REPO_TOKEN_KEY --env staging
```

```bash
cd apps/api && npx wrangler secret delete REPO_TOKEN_KEY_PREVIOUS --env staging
```

What can go wrong, by the code:

- **`REPO_TOKEN_KEY_PREVIOUS` is set but isn't 64 hex characters:** nothing is dropped. Rows it might have sealed wait, the log says `repo_token.key_invalid` with `"key": "previous"`, and they're revoked once it's fixed.
- **A sealed token opens with neither key,** while a current key is set and the previous one is unset or well-formed: the row is recorded as `repo_token.unrevocable`, by its ID only, and dropped. That token can't be revoked and lives out its hour. The agent gets a new one at its next call.
- **`REPO_TOKEN_KEY` is unset or malformed:** `get_repo_access` answers `503 repo_access_unavailable` and mints nothing.

### `GITHUB_WEBHOOK_SECRET`

**Gap: the gateway reads one secret.** ADR 0009 proposes that it accepts the old and the new for an overlap. That isn't built. So there's a window in which deliveries signed with the other value are refused `401 invalid_signature`. A refused delivery's nudge is lost, and the room's own polling notices the change later.

1. **Owner:** generate a new value of at least 32 characters. A shorter one makes the route answer `404` to everything.
2. **Owner:** set it on the gateway.

   ```bash
   cd apps/gateway && npx wrangler secret put GITHUB_WEBHOOK_SECRET --env staging
   ```

3. **Owner:** straight after, set the same value as the webhook secret of each of the three Apps in `podsterdev`'s settings. Until all three are changed, their deliveries are refused.
4. Run the signed-out probe, which wants `401 invalid_signature` for an unsigned delivery:

   ```bash
   scripts/staging-probes --webhook-secret-set
   ```

5. Check a real delivery: each App's settings list recent deliveries with the gateway's answer. A `202` after the change shows the new secret matches. GitHub can send a failed delivery again from that page.

Keep the window short, and expect some `invalid_signature` answers during it. Nothing else is lost: a delivery never carries state.

## Compromise

Contain first, then rotate, then check. Write down the time each step is done, in UTC.

### What the switch does and doesn't stop

`MANAGED_REPOSITORIES` off stops **Podster's** use of GitHub. It doesn't stop someone who holds an App key, who talks to GitHub directly. For a leaked App key, containment is on GitHub.

- **Switching off** means changing `MANAGED_REPOSITORIES` to anything but `true` in both `apps/api/wrangler.jsonc` and `apps/gateway/wrangler.jsonc`, merging that, and deploying both Workers with `scripts/deploy-staging`, which waits for CI on `main`. So it takes as long as a pull request, its checks and a deploy. There's no faster switch in Podster ([O-9](../security/m5-review.md#abuse-exposure-web-and-operations)).
- **Once off:** the managed-repository routes answer as missing, and provisioning, merging and the refresh job stop. A merge in flight stays as it was. Each room marks the tokens it holds for revocation at its next alarm, which for a held token may be as late as its expiry, so **tokens live up to 60 minutes after**.
- **Keep `REPO_TOKEN_KEY` and the agent-token App's ID, installation ID and key set for at least 65 minutes after switching off,** or the rooms can't revoke what they hold.
- **Suspending an App's installation on GitHub** is the faster stop. **Owner:** `podsterdev`'s settings, GitHub Apps, Configure, Suspend. GitHub's documentation says a suspended App is blocked from the account's resources. Whether that ends tokens already minted, and how soon, is **unverified**; ADR 0009 says the same. Podster's own use of that App stops too.

### A leaked App key

1. **Contain. Owner:** delete the leaked key in the App's settings on GitHub. If the App has only that key, GitHub wants a new one generated first. How soon a deleted key stops signing is **unverified**.
2. **Contain. Owner:** if tokens minted with it may be in use, suspend that App's installation. Without that, such tokens live up to an hour from their minting, and Podster can't revoke tokens it doesn't hold. With it, that role stops for every room: no new repositories (provisioning), no agent tokens and none of Podster's reads (agent-token), no merges (merge).
3. **For the provisioning key, also:** assume rules may have been removed. Until the checks below are done, a merge in an affected repository isn't safe. Podster reads the rules back before each merge and stops if they differ, but it doesn't read the settings in [C-8](../security/m5-review.md#credentials-github-and-webhooks). Consider switching managed repositories off until the check is done.
4. **Rotate:** set the new key as the role's secret, as in [routine rotation](#an-apps-private-key), and lift the suspension. **Owner.**
5. **Check afterwards,** [below](#checking-afterwards).

### The repository token key

A leak of `REPO_TOKEN_KEY` alone opens nothing. If the room's storage may have leaked too, go to [everything at once](#the-api-worker-or-several-secrets-at-once). Otherwise rotate it as in [routine rotation](#repo_token_key), keeping the leaked key as `REPO_TOKEN_KEY_PREVIOUS` for the 65 minutes, since it's still needed to revoke what was sealed with it.

### The webhook secret

Rotate it, as in [routine rotation](#github_webhook_secret-1). That is the containment: a forged delivery is refused from the moment the gateway has the new value. What a holder could have done is bounded as [above](#github_webhook_secret), and none of it changes state, so there's nothing to undo. Look in the gateway's log for `github.webhook` lines with delivery IDs GitHub's own delivery list doesn't show.

### The API Worker, or several secrets at once

The private API Worker holds every key, and its rooms hold the sealed tokens.

1. **Contain. Owner:** suspend all three installations on GitHub.
2. Switch managed repositories off, as [above](#what-the-switch-does-and-doesnt-stop).
3. **Owner:** delete every App key on GitHub and generate new ones. Set them, a new `REPO_TOKEN_KEY` with the old one as `REPO_TOKEN_KEY_PREVIOUS`, and a new `GITHUB_WEBHOOK_SECRET`.
4. The Worker's other secrets (`ASSERTION_KEYS`, `SCANNER_SECRET`, `A2A_TOKEN_KEY`, `OPERATORS`) are outside this runbook and need the same thought.
5. Check afterwards, then lift the suspensions and switch back on.

## Checking afterwards

ADR 0009 proposes a job that reads every managed repository and compares it with what Podster recorded. **It isn't built, and there's no inventory to drive it** ([O-4](../security/m5-review.md#abuse-exposure-web-and-operations)). By hand:

1. **List the repositories.** GitHub's own listing of `podsterdev` is the only complete list. It includes repositories that were created and never linked, and what staging runs left behind.
2. **For each repository,** as an organization owner on GitHub, since bypass lists show to administrators only:
   - it still exists, and is public and not archived;
   - it has exactly two rulesets, `podster-review` and `podster-update`, both active, on the default branch;
   - `podster-review` has no bypass actor, and its required status `podster/review` is pinned to the merge App;
   - `podster-update` has exactly one bypass actor, the merge App, always;
   - Actions are off;
   - no collaborator, team or deploy key was added, auto-merge is off, and the default branch is the one Podster recorded. Podster doesn't read these back today ([C-8](../security/m5-review.md#credentials-github-and-webhooks)).
3. **The default branch's history.** Podster records each merge's commit with its task. Every commit on a default branch after the first should be a merge commit by the merge App whose second parent is a reviewed commit. Podster has no route that lists these across rooms, so comparing means each room's own task records.
4. **Branches, tags and releases** nobody in the room recognises. GitHub attributes every agent's push to the one App bot, so GitHub can't say which agent made one.
5. **GitHub's audit log** for `podsterdev`, for the period. What it records of an App's actions wasn't checked for this runbook.
6. **In Podster:** a repository whose rules differ is found only when a merge is attempted in its room, which sets the link `degraded`. An operator's recheck reads only a link that's already degraded. Neither can be run across all rooms.

### What to look for in logs

**Gap: nothing is kept.** Neither the API nor the gateway sets `observability`, so log lines are seen only by someone running `wrangler tail` at the time ([O-12](../security/m5-review.md#abuse-exposure-web-and-operations)). After an incident there's no log to read. During one, tail both Workers and look for:

| Line | What it means |
| --- | --- |
| `repo_token.issued`, with `ws`, `task`, `agent` | A token was minted for that agent |
| `repo_token.mint_failed`, with a `status` | GitHub refused a mint, or didn't answer |
| `repo_token.mismatch` | GitHub's token wasn't for the one repository with the agent's permissions. It was revoked and refused |
| `repo_token.revocations`, with counts | A room's alarm revoked tokens. `failed` and `unrevocable` should be zero |
| `repo_token.unrevoked`, `repo_token.unrevocable`, `repo_token.mint_unknown` | A token that may be live and can't be revoked. It lives out its hour |
| `repo_token.key_invalid` | A sealing key is set and malformed |
| `repo_token.opened` with `"key": "previous"` | A token sealed before a rotation was opened |
| `repo_token.app_not_distinct`, `merge.app_not_distinct` | Two roles share an App, an installation or a key |
| `provision.token_not_revoked`, with `room`, `request`, `count` | A provisioning token wasn't revoked. It may be the one for the whole installation |
| `merge.token_unrevoked`, `task_change.token_unrevoked` | A narrowed token of Podster's own wasn't revoked |
| `merge.succeeded`, `merge.failed`, `merge.waiting`, `merge.outcome_unknown` | The merge job's steps, with room and task |
| `task_change.read_failed` | A read of a pull request failed. Many at once, with `403`, may be the rate limit, not a credential ([O-5](../security/m5-review.md#abuse-exposure-web-and-operations)) |
| `github.webhook`, with `delivery` and `outcome` | A delivery whose signature was good |

Log lines carry IDs, fixed codes, counts and statuses only. A room's ID, a task's ID and an agent's ID are what to carry from a line into the room's own records.

### What to record

The time the leak was learned of and how; which secret; each containment and rotation step with its time; which repositories were checked and what differed; which tokens were logged as unrevoked; and what wasn't checked. Put it in a pull request under `docs/`, with IDs only.

## Gaps

| Gap | Instead, today |
| --- | --- |
| The gateway accepts one webhook secret, so rotating it loses deliveries for a short window | Change the gateway and the three Apps back to back; polling notices what was missed |
| One webhook secret serves three Apps | A leak means changing all three |
| No health check mints a token with each App | Watch the log lines above, or run `e2e/m5-staging.mjs` |
| No inventory of managed repositories, and no job that compares them with Podster's records | GitHub's listing of `podsterdev`, checked by hand |
| Podster can't revoke a token it doesn't hold, and can't revoke all of an App's tokens. GitHub's revoke call ends only the token that makes it | Suspend the installation (effect on live tokens unverified), or wait out the hour |
| Switching managed repositories off takes a pull request and a deploy of two Workers, and held tokens live up to an hour after | Suspend the installation on GitHub first |
| No log retention and no alerting | `wrangler tail` during the incident |
| How soon a deleted App key stops working, and whether suspension ends live tokens, are unverified | Assume up to an hour for tokens, and check with a call |
| Read-back doesn't cover auto-merge, forking, collaborators or the organization's base permission | Check by eye, as above |
| The three-Apps check doesn't compare every pair | Check by eye that three different keys are set |
| This runbook hasn't been followed | The first rotation on staging is its test |
