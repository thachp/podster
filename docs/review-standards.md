# Review standards

Findings that reviews kept making in the week of 2026-11-12, written once so an author can meet them before review and a reviewer can cite them by number. Each rule has its reason and the pull requests where it was learned. Nothing here is new policy: a rule with no pull request behind it isn't on this page.

This page adds to [CLAUDE.md](../CLAUDE.md), which holds the rules that must always hold and the scripts agents must use, merges through `scripts/merge-gate` among them. Where the two disagree, CLAUDE.md wins and this page is wrong.

## 1. Tests never depend on wall-clock time

- No sleep, and no wait on a timer to "let it happen". Wait for the thing itself: a write held at a stand-in, a line the process prints, an alarm run the test makes.
- No margin that real time can use up. A test that must show "it waits" sets the due time far ahead first; it never assumes a short wait hasn't run out yet.
- No count asserted (`attempts: 1`) while an alarm the test doesn't control may still run. Read what the last controlled pass left and count from there.
- An exact boundary is tested with the clock passed in, or in the pure rule in `crates/core`, to the millisecond.
- A fault or refusal is scripted before the command that sets the alarm, so whichever run comes first meets it. Every room a test makes is quieted with `alarmQuiet` in `afterEach` or `finally`, so no alarm of it reaches a later test.

**Why:** a runner under load is slower than any margin, and a failure that needs a slow runner to show can't be reproduced or trusted.

- Learned in #305 (2026-11-12): four tests put a stamp one second inside a 24-hour window; a test that took 1,772 ms on CI used the second up. The margin became an hour, which only made the race rarer.
- Learned in #306 (2026-11-12): the window's edge got one owner, `crates/core`, and a pure test pins it. That is where an exact edge belongs.
- Learned in #319 (2026-11-12): the alarm's 10-second bound reads the clock, and the PR says plainly that no test shows it.
- Learned in #322 (2026-11-13): no test assumes a 5-second wait hasn't run out; faults are scripted before the command that sets the alarm; a hand-written row met a room's own alarm and flaked on `main`.
- Learned in #323 (2026-11-13): a self-test sent itself a signal and raced the event loop, failing `main`'s CI. The stand-in now holds the request until the signal has been handled, and the test has no timer at all.
- Learned in #325 (2026-11-13): a test no longer assumes `attempts: 1`; "a pass woke something" is shown by holding the write only that thing makes.
- Learned in #331 (2026-11-13): in test builds an object reads its clock from a table, so a day's and an hour's edge are each tested to the millisecond.
- Learned in #336 (2026-11-13): every room a test makes is quieted in an `afterEach`; two `attempts: 2` assertions stopped resting on a wait; the reads' 5-second bound and the upload's one-hour expiry are each shown to the millisecond with the clock passed in.
- Learned in #341 (2026-11-13): an accessibility run read a 50-message thread in one in-page script under a single 90-second bound, and stalled on CI without saying how far it got. It is now a bounded step per message, named, with no timer. A page starved of CPU still fails its 800 ms responsiveness budget, but as a measurement.
- Learned in #342 (2026-11-13): a gateway test got its 429 only when other tests had put 20 requests into a shared counter's current wall-clock minute, and its `"0"` limit was an invalid setting that silently fell back to the default. It failed `main`. The test now makes its own refusal, with a caller of its own.

## 2. A check that can't fail is not a check

- An assertion must fail on the old code. Put the bug back, or take the new line out, and see the test fail; say in the PR that you did.
- "Both answers are alike" must also require the expected answer. Two refusals from the edge are alike too.
- A run that showed nothing exits non-zero and names what it didn't show.
- A harness that asserts "nothing was seen" needs a control showing it could have seen it.

**Why:** a green result is read as evidence. A check that passes whatever the code does hides the gap it was written to close.

- Learned in #315 (2026-11-12): a staging run with one check passed and ten skipped exited 0; it now exits 1 and lists what wasn't shown. A pair of answers that matched but were both 429, 401 or 502 passed; only the API's own expected answer passes now.
- Learned in #318 (2026-11-12): the PR shows its guard still fails on the old page, by putting the old prop back.
- Learned in #332 (2026-11-13): the browser run recorded JSON and exited 0 if one browser launched. It now fails unless every browser held each sandbox property, asserts the opposite in a control, and a self-test takes each assertion away in turn.
- Learned in #334 (2026-11-13): on bash 3.2, a script killed by `set -u` with an EXIT trap exited 0. Every exit the script means now sets a flag first, and the trap treats any other exit as an error that is never 0. A hung self-test case is killed at a bound and fails by name; no case passes because of time.
- Learned in #336 (2026-11-13): an added call survived its own mutation, which is how the author found the call was redundant and removed it, keeping the test.

## 3. Fail closed on what can't be read, and tell "couldn't read" from "read and false"

- A fact that couldn't be read is undecided: answer so, write nothing, and let it be asked again.
- A fact that was read and doesn't hold fails. Only that fails anything.
- A response body of an unexpected shape is a refusal, never "nothing found" and never the end of a list.
- Two missing values are not a match. `None == None` must not compare an unreadable value equal to "wants nothing".
- For a safety stop, unreadable means stopped: nothing new is written or served.

**Why:** treating an unread fact as false ends things that should have gone on, and treating it as true or absent lets through what should have been refused. Both have happened here.

- Learned in #325 (2026-11-13): "couldn't read the entry" and "wants no entry" compared equal, so a foreign entry on a taken-down host would have stayed for ever, untold. A list page with no `result_info` is now a failed list, not the last page.
- Learned in #334 (2026-11-13): a deploy script's reads failed open on an unexpected body. Every read must now be exactly one JSON document of the exact expected shape, naming the thing asked for; anything else refuses, and an error is never a "no".
- Learned in #335 (2026-11-13): an unreadable stop, person or delegation answers `503 standing_unknown` and changes nothing; only a fact that was read and fails ends a release.

## 4. A takedown never fails or waits because of other bookkeeping

Taking an app down commits in its own transaction and runs before anything slower. Tidying that follows it runs separately; if that fails, it is logged by its code and skipped.

**Why:** a takedown is the answer to abuse. It can't be held up by work that is merely owed.

- Learned in #319 (2026-11-12): the alarm does takedown work "before anything slower", and the rest of the pass is bounded so a takedown still goes first.
- Learned in #336 (2026-11-13): ending expired uploads shared a path with unpublishing. It now has a transaction of its own, after the suspension has committed; two tests make it fail and show the suspension still commits and the alarm still removes the entry.

## 5. Names are not IDs

Hostnames and script names are kept only in operator-only stores: the Moderation object's tables and the operators' queue and findings. They never reach a log, an event or an answer to anyone who isn't an operator. Logs carry IDs and codes.

**Why:** a name says what someone published or reported. CLAUDE.md's "logs carry IDs only" doesn't protect anything if a name is treated as one.

- Learned in #322 (2026-11-13): a mismatch is logged as the room's and the request's IDs with a code, `hostname_generation_mismatch`, not the hostname.
- Learned in #325 (2026-11-13): a script's name is recorded in the operators' findings; a bad key, script or room is logged by its code.
- Learned in #331 (2026-11-13): a reported host is a name, not an ID, kept only in the Moderation object's table and the operators' queue. A test fails if any `console` call contains it.

## 6. No Cloudflare IDs and no secrets in this repository

This repository is public. No account, zone or namespace ID and no secret goes into a file, a commit message or a commit that will be pushed. Name the resource instead ("the account that holds `podster.dev`"), take the account from `CLOUDFLARE_ACCOUNT_ID`, and look an ID up by name at run time.

**Why:** history is public too. An ID in an earlier commit of a branch is published even if the last commit removes it, so the only fix is a new branch.

- Learned in #302 (2026-11-12): it replaces #301, closed because its commits carried resource IDs. Same work, rebuilt as one new commit.
- Learned in #304 (2026-11-12): it replaces #303, closed for the same reason. The zone's ID is now looked up by name.

## 7. Deploy tooling: never rely on a tool's default

- Read what the pinned version does; don't assume it refuses. With no configuration file, `wrangler deploy` configures the project and deploys it.
- Pin the tool's exact version, and re-read the behaviour you depend on when the pin moves.
- A script that handles a token restarts itself in a clean process (`env -i` with an allow-list, a named shell, no profile) before anything else. It refuses to run under shell tracing, keeps the token out of every shell variable, and starts each tool with `env -i` and an allow-list, never the caller's environment.
- Setting a secret has one form: `cd apps/<app> && npx wrangler secret put NAME --env staging`. Never combine `--name` with `--env`. See [the staging guide](staging.md#setting-a-secret-one-form-only).

**Why:** a default is a decision someone else made and can change. Each of these was found as a deploy, a leak or a stray resource that nobody asked for.

- Learned in #302 (2026-11-12): the spike's wrangler inherited `process.env`; it now gets the allow-list from `e2e/child-env.mjs`.
- Learned in #328 (2026-11-13): the plan's guard assumed a bare `wrangler deploy` refuses without a configuration file. Since wrangler 4.68 it doesn't. The guard became a default-named `wrangler.jsonc` that can deploy nothing.
- Learned in #329 (2026-11-13): wrangler is pinned exactly in `apps/content`, and the static check reads the installed copy's source for which `account_id` wins, because the documentation doesn't say.
- Learned in #333 (2026-11-13): `--name` with `--env` made the stray Worker `podster-api-staging-staging`: wrangler appends the environment's name, and `secret put` creates an empty Worker when none exists.
- Learned in #334 (2026-11-13): review found the token echoed under `bash -x`, curl and wrangler run with the caller's environment, an exported shell function able to shadow `curl`, and `.env` files loaded from the working directory. Refusing exported functions was tried and its claim withdrawn; the script now restarts as `/bin/bash` under `/usr/bin/env -i`, refuses a second restart, and says its scope is accidents in the owner's shell, not an attacker.

## 8. An accepted ADR outranks a later ruling made in passing

When a ruling given in conversation disagrees with an accepted ADR, the author says so, decides nothing, and gets it resolved in writing: the ADR stands, or it is amended with a dated note.

**Why:** an ADR was argued and accepted; a ruling in passing may simply not have had it in view. Building on the newer one silently leaves two answers on record.

- Learned in #335 (2026-11-13): a ruling said an operator taking the delegation back doesn't unpublish what is live; ADR 0010 says it does. The author stopped and asked. Decision 218 kept the ADR, and `PRODUCT.md` and the ADR record it.

## 9. A change after review gets its delta reviewed

A push after a review is reviewed again for what changed, and the PR body says what changed since the reviewed commit, by its sha.

**Why:** a review covers one commit. What lands after it is unreviewed, however small.

- Learned in #315 (2026-11-12) and #318 (2026-11-12): each body has "Changes since the review at" a named commit.
- Learned in #319 (2026-11-12), #322 (2026-11-13) and #334 (2026-11-13): each records what was closed "after the delta review".

## 10. Staging: run the script after the deploy, and say what it did not show

- A merged M6 step is deployed with `scripts/deploy-staging` and followed by a run of `e2e/m6-staging.mjs`, recorded in [the M6 plan](m6-plan.md#staging-script).
- A deploy that changes a room's tables is wrapped in the script's two phases, `--before-deploy` and `--after-deploy`, so the change is shown on a room that existed before it.
- Every record of a run says what the run did not show, and what it was told and couldn't check.

**Why:** tests have missed things only a real run shows, and a run's pass is only as wide as what it reached. A room made after a deploy says nothing about rooms made before it.

- Learned in #316 (2026-11-12): the first run's record lists what was left unshown and is owed before the switch goes on.
- Learned in #320 (2026-11-12): schema steps had only ever been shown on rooms made after the deploy, so M6-S04 became two phases around one.
- Learned in #324 (2026-11-13): runs are recorded after #319 and after #322. Review found the deploy M6-S04 crossed changed the room's code, not its tables, so the record now says a table change on an older room is still unshown, and the next such deploy must be wrapped.

## 11. An outcome never depends on the order notices arrive

A rule applied to notices gives the same result whatever order they arrive in, and whichever are missed or heard twice. The state carries what a late hearer needs, and a test tries every order.

**Why:** delivery order isn't promised. A rule that is right only for the order its author pictured is wrong for some room.

- Learned in #344 (2026-11-13): as specified, a room that heard a give-back before the take it had missed stayed up. The switch now carries `last_take`, and a test of over 1,000 cases hears every subset of the notices in every order, with the expected outcome computed from the operator's acts alone.

## Enforced by a tool

- **Rule 1:** `e2e/test-timing-check.mjs` (#346, #348 and #349, all 2026-11-13) runs in CI's `e2e` job after its own self-test. It reads every file under `apps/api/test` and `apps/gateway/test` and fails on a sleep, on a wall-clock margin in an assertion, and on an API spec that makes a room and has no `alarmQuiet` in `afterEach`, `afterAll` or `finally`.
- **What it already found is owed.** `e2e/test-timing-allow.json` lists every existing finding with a reason: as of #349, 117 entries covering 324 findings, of which 97 entries, covering 101 findings, are owed fixes. Most of the rest are calls to helpers that only poll for the state itself. A new finding, or an edit to a listed line, fails until it is fixed or listed.

## Not yet enforced by a tool

Everything else above is kept by authors and reviewers reading. These could be kept by a lint or a static check instead. They are owed work, with no date.

- **Rule 1:** what the timing check's header lists as known gaps, among them a shared counter or rate-limit window (#342's kind), a margin in an `if` or `throw`, and a busy loop on `Date.now()`. The room rule is per file, so it doesn't show that every room reaches the quieting call.
- **Rule 5:** a `console` call given a hostname or a script name. #331 has a test for its own host only.
- **Rule 6:** a 32-character hexadecimal Cloudflare ID in any file or in a branch's commits.
- **Rule 7:** `--name` and `--env` together on a `wrangler secret put` line, in scripts and in documentation.
- **Rule 7:** that the account's Worker names are exactly the expected set. #333 records this as owed; it needs a credential that can list Workers.
