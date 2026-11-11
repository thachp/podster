# Stopping or removing a managed repository, by hand

What can be done today when a managed repository has to stop or come down. **Podster can't do it.** Everything that takes content away happens on GitHub, by hand, and Podster isn't told.

**Written on 2026-11-11 from the code at `8e6ab69`, the [M5 security review](../security/m5-review.md) (finding O-2) and GitHub's documentation. Nobody has followed it yet.** No step has been tried against staging or GitHub.

This is a procedure, not a policy. What Podster promises a reporter or a room's owner, how soon, and what a notice must contain are in [takedown.md](../legal/takedown.md), which says nothing of repositories yet and whose contact is a placeholder. Those are [the owner's to decide](../security/m5-review.md#what-podster-promises-about-taking-down-a-repository-o-2).

## What Podster can't do

By the code:

- **Set a repository's link `suspended`.** The status is read in many places and written nowhere. The only changes are to `degraded`, by a merge attempt, the daily read-back or an operator's recheck that finds the repository different or gone, and back to `ready`, by an operator's recheck that finds it exactly right.
- **Make a repository private, archive it or delete it.** No call for any of them exists in `apps/api/src/github.rs`.
- **Reach a private room as an operator.** An operator suspends a room by its public handle. A room with no public handle can't be suspended, and suspending one stops merges and not push tokens.
- **Revoke the tokens of one repository.** A room revokes the tokens it holds when their authority ends in that room. No operator route asks a room to do it.
- **List managed repositories,** or go from a repository's name to its room without the database.

ADR 0009 [proposes](../adr/0009-managed-repositories.md#public-repositories-forks-and-takedown) an operator action that suspends the link and then makes the repository private. It isn't built, and is owed before production.

## Who decides

**The owner.** Only an owner of the GitHub organization `podsterdev` can carry out the GitHub steps, and ADR 0009's design assumes that organization has no other members. An operator or the architect can find the room and prepare the steps, and can't act on GitHub.

## 1. Identify the repository and its room

1. **The repository's ID.** GitHub shows it for a public repository. Use the ID from here on, never the name.

   ```bash
   gh api repos/podsterdev/<name> --jq .id
   ```

2. **The room,** for a repository that was linked. There's no route for this. The one record outside the room is a row in D1's `repo_room_index`, in `podster-api-staging`: the provider, the repository's ID and the room's ID. It's a read model the room writes from its alarm after the link exists, so a row can be missing for a link that's seconds old. Reading the database is a `wrangler` command against staging, so it's the owner's to run or to ask for.

   ```bash
   cd apps/api && npx wrangler d1 execute podster-api-staging --env staging --remote --command "SELECT workspace_id FROM repo_room_index WHERE provider = 'github' AND provider_repo_id = <id>"
   ```

3. **No row.** The repository was created and never linked, or a staging run left it, or it isn't Podster's. A created-and-never-linked repository's ID is in its own room's request record and nowhere else, so **the room can't be found from the repository**. No token can be minted for a repository with no link, so nothing in Podster needs stopping; go to the GitHub steps.
4. **The room's people.** No operator read shows a private room's owner or members. This procedure doesn't cover how to reach them.

## 2. Act on GitHub

**Owner**, in `podsterdev`. Pick by what's wanted. What each does to Podster is in [the next section](#podsters-state-afterwards).

| Wanted | Action | What it does on GitHub |
| --- | --- | --- |
| Content no longer public, kept | **Make it private, then archive it** | Private hides it. Archived makes code, branches, tags, pull requests and releases read-only, by GitHub's documentation |
| Writes stopped, content stays public | **Archive it** | Read-only, still public. ADR 0009's action for a room that's been removed, not for a takedown |
| Content gone | **Delete it** | Removed. ADR 0009's proposal is that nothing is deleted, so this is the owner's call each time |

Why private and archived together: private alone doesn't stop writes. An agent's token is expected to still reach a private repository, since the App's installation covers every repository in the organization whatever its visibility; that's from GitHub's documentation and untried. On the Free plan a private repository's rulesets may stop being enforced, so the default branch may lose its protection. That's **unverified**; ADR 0009 lists it. Do private first: whether an archived repository's visibility can still be changed wasn't checked.

**What doesn't exist on GitHub either:**

- **Revoking an App's tokens for one repository.** GitHub's revoke call "revokes the installation token you're using to authenticate" and nothing else, and its page lists no call that ends all of an installation's tokens or one repository's (read 2026-11-11). A token an agent already holds lasts until its hour ends, unless the room that holds its sealed copy revokes it.
- **Narrowing the installation.** An organization's owner can change an App's installation from all repositories to selected ones. That would break new repositories, which rely on the three Apps reaching them at once, and whether it ends live tokens is unverified. Not recommended.

**Stopping every repository at once** is suspending the agent-token App's installation, or switching `MANAGED_REPOSITORIES` off. Both are in the [credentials runbook](m5-credentials.md#what-the-switch-does-and-doesnt-stop). Neither is in proportion to one repository.

**Not recalled:** clones and forks others already made, and copies in search engines and archives. What happens to forks of a public repository that turns private or is deleted wasn't checked.

## Podster's state afterwards

Podster isn't told about any of this. By reading the code; none of it was tried.

**The link still reads `ready`** until Podster reads the repository back. The room's settings show the repository as before until then. What notices it, by reading the code and the tests against the fake GitHub; none of it was tried against GitHub:

| After | What reads it back | `get_repo_access` |
| --- | --- | --- |
| Private, or private and archived | The room's daily read-back, an operator's recheck, or a merge attempt. Each finds it differs (`visibility_differs` or `archived`), sets the link `degraded`, and tells the room's owner and admins. That needs the read-back to answer for a private repository, which is unverified on the Free plan | Until degraded: still mints a token. GitHub refuses writes to an archived repository. Once degraded: refused `repo_not_ready` |
| Archived only | The same, with `archived` | The same |
| Deleted, or taken out of the installation | Two read-backs at least a minute apart, within an hour, each answered "not found" by ID to a token GitHub had just minted, with nothing finding it in between, set the link `degraded` with `repository_gone`. One answer alone changes nothing | Until degraded: each call tries to mint, GitHub refuses, and the agent gets `502 provider_unavailable`. Once degraded: refused `repo_not_ready` |

**Held tokens are revoked with the degrade.** Degrading marks every token agents hold on the repository in the same change, and the room's alarm revokes them; for the daily read, in that same pass.

### Making Podster stop now

**An operator rechecks the room's repository** with `POST /v1/moderation/repositories/{room}/recheck`. It reads a `ready` link back, as the daily read does, and degrades it on any definite difference.

- **Private or archived:** the first recheck answers `{ "status": "degraded", "reason": "visibility_differs" }` (or `archived`). From then on the room offers no tokens and makes no merges, and the tokens already out are revoked at its next alarm pass.
- **Deleted:** the first recheck answers `502 provider_unavailable` and changes nothing, since one "not found" isn't enough. Wait at least a minute, and no more than an hour, and recheck again. The second answers `{ "status": "degraded", "reason": "repository_gone" }`, and from then on it's as above. A recheck that answers 502 for another reason (GitHub down, a rate limit) clears the first sighting: start again.
- **Without a recheck,** the daily read-back finds it within a day, and confirms a deleted one a minute later.

A recheck needs the room's ID. Nothing lists rooms by repository for an operator yet ([owed before production](../m5-plan.md#owed-before-production)).

**Restoring:** if the repository is put back exactly as Podster set it, a recheck of the `degraded` link reads it back and makes it `ready` again.

### Other ways to stop it

- **The room's owner or an admin takes back the push and merge grants.** Each token the grant backed is marked in the same change and revoked by the room's alarm. On staging, once, GitHub refused such a token 0.2 seconds after the grant was taken back. They can give grants again, so this holds only with their cooperation.
- **The room is archived** by its own people. Its tokens are marked for revocation, and no grant counts in an archived room.
- **An operator takes the organization's provisioning delegation back,** with `PUT /v1/orgs/{org}/provisioning-delegation` and `{ "granted": false }`. That stops the organization asking for another repository, and stops a setup that hasn't linked yet. It does nothing to a linked repository, its tokens, grants or merges, and a person can make another organization. It needs the organization's ID, which nothing tells an operator.
- **For a room with a public handle, an operator suspends the room.** That stops merges. It doesn't stop push tokens.
- **Switching `MANAGED_REPOSITORIES` off** stops everything, for every room.

Whatever Podster's link says, the GitHub step is what holds: an archived or deleted repository takes no writes.

## What to record

- The repository's GitHub ID and name, and the room's ID if one was found.
- What was asked for and when it arrived, and what the owner decided.
- Each GitHub action and its time, in UTC.
- What Podster showed afterwards: the link's status, and whether a merge attempt or a grant take-back followed.
- What wasn't done or couldn't be checked.

Where takedown records are kept isn't decided. This repository is not the place for a reporter's name or contact details.

## What this rests on

- **Read in the code:** every statement about Podster above.
- **Read in GitHub's documentation on 2026-11-11:** the revoke call ends only the calling token; archiving makes a repository's code, branches, tags, pull requests and releases read-only; an organization's owner can suspend or uninstall an App's installation and change which repositories it reaches.
- **Not verified, and to confirm on staging:** that an agent's token still reaches a repository made private, and can write to it; that archiving leaves visibility as it was; whether an archived repository's visibility can be changed; what a private repository on the Free plan does to rulesets and to Podster's read-back; what GitHub answers a token mint for an archived or deleted repository; forks; whether a deleted repository can be restored; and the whole procedure end to end.
