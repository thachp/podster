# Stopping or removing a managed repository, by hand

What can be done today when a managed repository has to stop or come down. **Podster can't do it.** Everything that takes content away happens on GitHub, by hand, and Podster isn't told.

**Written on 2026-11-11 from the code at `8e6ab69`, the [M5 security review](../security/m5-review.md) (finding O-2) and GitHub's documentation. Nobody has followed it yet.** No step has been tried against staging or GitHub.

This is a procedure, not a policy. What Podster promises a reporter or a room's owner, how soon, and what a notice must contain are in [takedown.md](../legal/takedown.md), which says nothing of repositories yet and whose contact is a placeholder. Those are [the owner's to decide](../security/m5-review.md#what-podster-promises-about-taking-down-a-repository-o-2).

## What Podster can't do

By the code:

- **Set a repository's link `suspended`.** The status is read in many places and written nowhere. The only changes are to `degraded`, by a merge attempt that finds the rules different, and back to `ready`, by an operator's recheck.
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

**The link still reads `ready`,** and the room's settings show the repository as before.

| After | A merge attempt in the room | `get_repo_access` |
| --- | --- | --- |
| Private, or private and archived | Reads the repository back, finds it differs (`visibility_differs` or `archived`), sets the link `degraded`, ends the merge, and tells the room's owner and admins. That needs the read-back to answer for a private repository, which is unverified on the Free plan | Until degraded: still mints a token. GitHub refuses writes to an archived repository. Once degraded: refused `repo_not_ready` |
| Archived only | The same, with `archived` | The same |
| Deleted | The read-back can't be made, so the job waits, counted against its attempts, and never degrades the link. **The link stays `ready`** indefinitely | Each call tries to mint, GitHub refuses, and the agent gets `502 provider_unavailable`. Nothing is minted |

So the room keeps offering push tokens until a merge attempt degrades the link, and for a deleted repository it keeps trying for good.

Two fixes are assigned and not on `main`: one that lets Podster notice a deleted repository, and one that lets an operator's recheck degrade a healthy link. Until they land, this procedure stands as written.

**Held tokens after a degrade** aren't revoked at once ([C-2](../security/m5-review.md#credentials-github-and-webhooks)). The room marks them at its next alarm, which may be as late as the token's expiry, up to an hour.

**An operator's recheck doesn't help here.** It reads GitHub only for a link that's already `degraded`, and can only turn it back to `ready`. It never degrades a `ready` link. Don't recheck a taken-down repository's room unless the repository has been restored exactly.

### Forcing it today

**An operator can't.** No operator route degrades or suspends a link, or revokes a room's tokens. What exists:

- **The room's owner or an admin takes back the push and merge grants.** Each token the grant backed is marked in the same change and revoked by the room's alarm. On staging, once, GitHub refused such a token 0.2 seconds after the grant was taken back. They can give grants again, so this holds only with their cooperation.
- **The room is archived** by its own people. Its tokens are marked for revocation, and no grant counts in an archived room.
- **Someone holding a merge grant asks to merge an approved task** in that room. The job's read-back then degrades the link, if the repository is private or archived. It needs an approved task with a pull request, so it can't be done to order.
- **An operator takes the organization's provisioning delegation back,** with `PUT /v1/orgs/{org}/provisioning-delegation` and `{ "granted": false }`. That stops the organization asking for another repository, and stops a setup that hasn't linked yet. It does nothing to a linked repository, its tokens, grants or merges, and a person can make another organization. It needs the organization's ID, which nothing tells an operator.
- **For a room with a public handle, an operator suspends the room.** That stops merges. It doesn't stop push tokens.
- **Switching `MANAGED_REPOSITORIES` off** stops everything, for every room.

Without one of these, the GitHub step is what holds: an archived or deleted repository takes no writes, whatever Podster's link says.

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
