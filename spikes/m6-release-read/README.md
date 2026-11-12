# M6 spikes E and F: reading a release from GitHub, and Actions switched off

**Status, 2026-11-12 UTC: run, against one acceptance-run leftover, `podsterdev/e2e-m5-202611120015-ae33-7c9b19`, a public repository.** The answers and what they change in ADR 0010 are in [the M6 plan](../../docs/m6-plan.md#spike-e-results). This file says how the spike works and exactly what it wrote. Nothing builds on it.

**The authority for it:** the owner told the architect on 2026-11-12 to decide on their behalf, and the architect ruled that these read spikes go ahead with the existing staging Apps. No App was created, no App's permissions changed, no secret set, no cloud resource made, nothing deployed, and no repository's settings changed.

## What it does

`spike.mjs` has four modes. Each needs `M6_REPO`, which must be an `e2e-m5-*` repository, and reads the staging Apps' IDs from `apps/api/wrangler.jsonc` and their keys from `~/.podster/m5-staging/`.

| Mode | What it does | Writes to GitHub |
| --- | --- | --- |
| `fixture` | Builds a commit locally with git's plumbing and pushes it to the branch `spike/m6-release-read`. Then tries nine trees git forbids, each to its own branch, and six paths through the git data API | Yes: see below |
| `read` | Spike E. Reads the fixture back with the agent App's token cut down to Contents `read` on that one repository | No. Two writes are tried with the read token, to see them refused |
| `actions` | Spike F. Reads the Actions setting with the provisioning App's token cut down to Administration `read`, tries three ways to add a workflow file with the agent App's token, and looks for runs | One blob on no branch: see below |
| `limits` | Mints seven tokens and reads which request count each reports | No |

```bash
M6_REPO=e2e-m5-202611120015-ae33-7c9b19 M6_OTHER_REPO=e2e-m5-202611120015-ae33 node spike.mjs read
```

```bash
node --test spike.test.mjs
```

The test file is offline and calls nothing.

**Tokens.** Every token is minted for the run with its permissions and repositories named in the request, which the script refuses to send without both. A token is held in memory, passed to `git` through an environment variable that an askpass script reads, and never printed or written. Output is scrubbed of every key-signed JWT and token the run held. The results hold status codes, counts, sizes and GitHub's own messages.

## The results files

- `fixture.json`: the commit, the trees and files in it, and what each push answered. **It is the second run's record:** the first, at 09:03:12 UTC, made the branch; the second pushed the same commit again, which changed nothing, and added the git data API attempts.
- `results/read.json`: spike E, the third and last run, at 09:13 UTC. The first two differ only in timings and counts.
- `results/actions.json`: spike F, run once, at 09:06 UTC.
- `results/limits.json`: the request counts, the third run, at 09:15 UTC.

## The fixture

One commit with no parent, `ccf4bc6f1a0753c563d7b2283ff1f25da9720ea9`, holding one directory, `m6-spike-e/`:

| Directory | What is in it |
| --- | --- |
| `app/` | 34 entries: an ordinary file, an executable one, two symlinks (one pointing out of the repository), a submodule entry naming the default branch's head, an empty directory, a path 1,265 bytes long, a name of 255 bytes and one of 300, and names with a space, a tab, a newline, a backslash, a leading dot, three dots, non-ASCII letters, the same letter composed and decomposed, two that differ only by case, one that isn't UTF-8, `_headers`, and `.well-known/podster-release.json` |
| `rel300/` | 300 different small files |
| `big/` | 101 directories of 1,200 files each, 121,200 files. Every directory is the same tree and every file the same blob, so it is three objects |
| `steps/` | Five directories holding 10, 20, 30, 40 and 60 of those 1,200-file directories |
| `flat/` | One directory of 40,000 files |
| `files/` | Files of 0 bytes, 1 KiB, 1 MiB, 5 MiB, 5 MiB and a byte, 25 MiB and 99 MiB. The bytes repeat, so the push was small |

## What was written to GitHub

All of it to `podsterdev/e2e-m5-202611120015-ae33-7c9b19`, with the agent App's token cut down to Contents `write` on that repository. Nothing was written to `main`, to the other test repository or to any setting.

1. **The branch `spike/m6-release-read`,** at the commit above. It is still there, so the reads can be repeated.
2. **A tree on no branch,** `baf0e26c83bbef9db36ee148454f868f8d094423`, holding `ok/fine.txt`, with its subtree and one-line blob: the one git data API path that was accepted.
3. **A blob on no branch,** `9fe951acd4190ad4a9469a2e24bfd2393504416c`: the text of a workflow, made by the git data API before the tree that would have given it a workflow's path was refused. It has no path and isn't a workflow file.

**Refused, and so not written:** the nine `spike/m6-refused-*` branches; the workflow file by the Contents API, by the git data API's tree and by `git push` to `spike/m6-actions-off-git`; five malformed paths through the git data API; a blob and a branch tried with the read token; a blob tried on the other test repository. The repository's branches afterwards were `e2e/second-1`, `main` and `spike/m6-release-read`.

**A side effect that wasn't checked:** GitHub sends a push event for a new branch to whatever is subscribed to the repository, which may include staging's webhook. What staging did with it wasn't looked at.

**To remove it:** delete the branch, or the test repository. Nothing in Podster refers to either.
