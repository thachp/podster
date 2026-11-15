# Acceptance test: agents build and publish a todo app

**Status: Proposed, 2026-11-14. Nothing in this plan is approved, built or scheduled, and no step has been run.** It plans Podster's first end-to-end acceptance test. On 2026-11-14 the owner wrote: "the todo app - is meant for later... it will be a first app to be work on in a workroom. it ll be our first test to see that podster work like it supposed to".

**The test:** real agents work in a Podster workroom. They build a todo app and publish it through Podster's own release path. Then takedown and unpublish are run on that app. **The team doesn't write the app.** People act only where Podster requires a person: setting up the room, giving grants, approving the release, and the operator's takedown. If the whole run passes on staging, it shows Podster working end to end, from core job 1 to core job 8 ([PRODUCT.md](spec/PRODUCT.md#core-jobs)).

Sources: [the M6 plan](m6-plan.md), with stage 1's [build order](m6-plan.md#stage-1-of-apps-as-workers-the-build-order), [the gate on the release path](m6-plan.md#the-gate-on-the-release-path) and [the owner's table](m6-plan.md#for-the-owner); [ADR 0010's revision](adr/0010-revision-apps-are-workers.md); decisions 213 to 220; [RUNNER.md](spec/RUNNER.md); and [ARCHITECTURE.md](spec/ARCHITECTURE.md).

## 1. The setup

| Piece | Proposed |
| --- | --- |
| **Environment** | **Staging only.** Gateway and dashboard on `podster.dev`'s staging hosts. The app is served on the content domain, `podster.site`, from the second Cloudflare account ([decision 217](spec/PRODUCT.md#decisions-needed)). There is no production deployment, and this test doesn't need one |
| **Podster organization** | One fresh test organization for the run. It holds both people and every agent, so no invitation crosses organizations |
| **GitHub organization** | `podsterdev`, staging's managed-repository organization, as M5's runs used |
| **Workroom** | **Public**, because only a public room can release ([decision 213](spec/PRODUCT.md#decisions-needed)). Git-enabled. Its goal is a todo app as [stage 1](adr/0010-revision-apps-are-workers.md#31-what-it-is-made-of) describes it: a client-rendered single page, a small Worker answering a JSON API (list, add, change, remove), one store, and a manifest. The release directory is `site`. Its built files are committed, and Podster builds nothing (decision 220, answer 3). The page must avoid forms, client-side routes, inline scripts and browser storage, so that it works under the strict sandbox ([3.5](adr/0010-revision-apps-are-workers.md#35-under-the-sandbox-as-it-stands)). That constraint goes into the room's brief as an input asset |
| **Repository** | Created by the room through `requestRepository` at setup, in `podsterdev`, linked to the room. Agents never create it. Its visibility is set separately from the room's. It is public, as managed repositories are on GitHub's Free plan ([decision 181](spec/PRODUCT.md#decisions-needed)), so anyone can read the source of what is served |
| **People** (test people from staging's test sign-up) | **P1, the room's owner:** creates the room and asks for its repository (`REPOSITORY_REQUESTERS` admits test people), gives repository grants, and switches release on for the room. **P2, a room admin:** approves the release. Decision 215 lets the owner or an admin approve, and an agent never. Splitting the asking from the approving keeps the two apart. **An operator** for the takedown: someone in `OPERATORS`, which today holds only the owner's person ID ([question 3](#6-questions-for-the-owner)) |
| **Agents** | **Three, each its own Podster agent:** a **lead**, an **engineer** and a **reviewer**. Runner (M7) isn't built ([RUNNER.md](spec/RUNNER.md), status line), so they connect the way agents connect today. **Proposed:** each is a Claude Code session in a fresh, isolated directory, connected through **hosted MCP** (`/mcp`), one OAuth grant per agent, which a test person consents to ([Connecting an agent](spec/PRODUCT.md#connecting-an-agent)). Agent Auth is the other built path. Each session pushes through the short-lived token `get_repo_access` returns, and through nothing else. Which models to use is the owner's ([question 4](#6-questions-for-the-owner)). **Proposed:** a stronger model for the lead and reviewer, a cheaper one for the engineer, and the reviewer's model different from the engineer's |
| **Roles** (the agents claim them) | `lead` (1 opening): breaks down the goal, posts tasks, sets reviewers, asks for the release. `engineer` (1 or 2 openings): the Worker, the page and the manifest. `reviewer` (1 opening): reviews and merges. A role grants no repository, merge or deploy right (criterion 3). Those come from P1's explicit grants: push for the engineer, merge for the reviewer, and `deploy` for the lead |

## 2. The flow

Each step names the Podster capabilities it uses. Capabilities in *italics* aren't built yet ([section 4b](#b-what-agents-can-still-build)).

1. **Room setup, by P1.** P1 creates the public room with its goal, brief and roles, and adds the todo app's brief as an input asset. P1 asks for the repository (`requestRepository`) and waits for `ready` (`getRepository`). P1 gives grants (`grantRepositoryAction`): push to the engineer, merge to the reviewer, `deploy` to the lead.
2. **Agents join.** Each agent connects, reads `get_workroom_brief` and `list_role_openings`, then claims its role (`claim_public_opening`, or `claim_role` by invitation).
3. **Planning.** The lead posts tasks (`create_task`), orders them (`set_task_plan`), sets a reviewer for each (`set_reviewer`) and offers each to the engineer (`assign_task`). It discusses them in threads (`send_message`).
4. **Work.** The engineer finds offers through `read_inbox`/`ack_inbox`, reads each (`get_task`) and accepts it (`accept_task`). It gets a token (`get_repo_access`), pushes a task branch, opens a PR, and submits with the exact commit (`submit_task`).
5. **Review.** The reviewer asks for changes at least once (`request_changes`), so a second submission is reviewed. Then it approves the exact commit (`verify_task`) and merges it (`merge_task`, through the merge App). `get_task_release_status` shows checks and merge separately.
6. **Release switched on, by P1.** `setReleaseConfig` turns release on for the room, and the room gets its default host, `<label>.podster.site`.
7. **Release asked for, by the lead agent.** The lead asks for a release of the merged commit (*`deploy_release`*, which policy already decides, AC-17). The release waits as *Needs approval*. P2 is told what it holds: code that runs on a server and a store anyone can write to (*step 10's screen*). P2 approves (`approveRelease`).
8. **Release job.** The job rechecks authority. It reads the tree through the read-only App within the read share, and uploads the static files, *the Worker's script and its one store binding*. It adds the marker, `/.well-known/podster-release.json`. The marker job then records the release `live`.
9. **Served.** The app answers on its host under the sandbox. A scripted browser adds, changes and removes items, and the list survives a reload. `get_task_release_status` reports checks, merge and release, each with its time.
10. **A second release.** A follow-up task changes something visible, then goes through review, merge, ask and approve again. The host switches to the new commit, and the list's data stays.
11. **Takedown.** A report names the app by its address (`createAppReport`). The operator suspends it (`suspendApp`), and the host answers not-found. Lifting the suspension (`liftAppSuspension`) restores nothing. Serving again takes a new ask and a new approval. Optionally, `stopContentDomain` and `resumeContentDomain` are run once.
12. **Unpublish.** P1 switches release off for the room (`setReleaseConfig`). The host answers not-found, the provider confirms the room's scripts are gone, and the label is retired. *The command that deletes an app's data* removes its store, and the provider confirms it. The release records are kept.

## 3. What counts as passing

**The run passes only if every row below is seen on staging, by a script that reads Podster as the people in the run** (the owner won't run checks by hand). One more rule: **nobody does a step outside Podster.** No person writes, pushes or merges code, edits the repository, or calls Cloudflare or GitHub. People act only through Podster's own pages and routes, and only in the steps that need a person: room setup, grants, release config, approval and the operator's takedown.

| # | Step | Seen as |
| --- | --- | --- |
| 1 | Room and repository | The room is public. Its repository link is `ready`, with a GitHub repository ID in `podsterdev`, and nobody but the room's request created it |
| 2 | Roles claimed | A role-claim event for each of the three agents. No role gives more than it defines (criterion 3) |
| 3 | Tasks | `task.created`, offer, `accepted` and submission events, each by an agent's ID. The plan is visible on the room's List/Board |
| 4 | Commits by agents only | Every commit in the PRs was pushed with a token from `get_repo_access`, which its issuance record shows. No other credential pushed |
| 5 | Review | One `request_changes`, then a `verify_task` on the exact `commit_sha`. The reviewer is an agent other than the author |
| 6 | Merge | `merge.succeeded` for the reviewed sha. The merge commit is on the default branch |
| 7 | Release, asked and approved | A `release` record for that commit, asked for by the lead agent and approved by P2. An agent's attempt to approve is refused |
| 8 | Live | The record reaches `live`. `https://<label>.podster.site/.well-known/podster-release.json` names the merged commit |
| 9 | The app works | In Chromium, Firefox and WebKit, add, change and remove an item, reload, and the list holds. A plain-text `POST` is refused by the content Worker. Nothing of the app sets a cookie |
| 10 | Status kept apart | `get_task_release_status` shows checks, merge and release with separate times. The task Sheet shows Live only for the live commit |
| 11 | Second release | The marker names the new commit. Items added before it are still listed |
| 12 | Takedown | After `suspendApp`, the host answers not-found within the stated time, and the room can't release while it holds. After the lift, still not-found until a new approved release |
| 13 | Unpublish | After release is off in the room: not-found, a provider-confirmed deletion of every script, the label retired, the store deleted by the provider's answer, and the release records still readable |
| 14 | Logs and events | Events and the Workers' logs hold IDs and reason codes only: no message body, token, file content or hostname (M6-22) |

## 4. Prerequisites

Items marked **[code]** are needed only if the app has code and a store. A static build doesn't need them.

### (a) Built on main today

- The coordination kernel, public rooms and claims (M1 to M4). Managed repositories, `get_repo_access`, review bound to a commit, `merge_task` and `get_task_release_status` (M5, on staging).
- M6, behind `RELEASES` and with `RELEASE_PATH_COMPLETE` false: the contract and room state (step 2); core and policy, including the `deploy_release` decision (step 3); takedown, the stop and both reconciles (step 4(a)); the content Worker's handler for static hosts, configured to deploy nowhere (step 4(b)); the room's recheck, start and commit, and the release job (tree read, static upload, driver, read share, marker job, settling `uncertain`); the unpublish triggers that have a source, the outage guard, the held unpublish and the operators' release switch (step 6 and decision 218); caps and app reports (step 9).

### (b) What agents can still build

From [the gate's list](m6-plan.md#the-gate-on-the-release-path) and [stage 1's order](m6-plan.md#stage-1-of-apps-as-workers-the-build-order):

- `deploy_release` in the contract and capabilities (step 6, alone in its turn). The release fields of `get_task_release_status` (step 7).
- Step 10's screens: release in room settings, *Needs approval*, what an approver is told, and the operators' page for apps' reports.
- The reconcile's cron entry, and an explicit `RELEASES` value, in staging's configuration (by PR; turning it on is the owner's, below). Then the PR that flips `RELEASE_PATH_COMPLETE`.
- The rerun of spike C's checks on `podster.site`, and spike G's timings (the takedown time the test asserts).
- An observer script for [section 3](#3-what-counts-as-passing), in the shape of `e2e/m6-staging.mjs`, and a way to start the three agents without a person typing.
- **[code]** The manifest and modules in core. The serve entry's code marker (a contract change). The content Worker's write methods, preflight, `no-store` and limits. The outbound Worker's code. The write counter. The upload of a script and its binding. The store's schema step, the two data-deletion commands and the store reconcile. **Spike H**, which shows the marker is served before an app's script, a blocker for trusting the marker on code-bearing releases. Most of these wait for the store spike.
- Not needed for this test: a custom hostname's marker, custom domains, and room or organization deletion.

### (c) Only the owner can provide

1. **The content domain's DNS** on the second account: the `*` `AAAA` record to `100::`, proxied, and the redirect from HTTP to HTTPS. The move of `podster.site` can't happen before 2026-11-22.
2. **Workers for Platforms on the second account,** with a staging dispatch namespace, and Workers Paid if Cloudflare asks for it.
3. **The second account's deploy credential** for the content Worker, and **the content Worker's deploy**.
4. **The publishing and routing credentials:** two Cloudflare tokens, set as secrets on the API.
5. **The read-only GitHub App** in `podsterdev` (Contents read, Metadata read), installed, with its key set.
6. **Turning `RELEASES` on for staging and setting a content provider.** Before that, the guard ceiling's figures.
7. **[code]** The **store spike's four short-lived tokens** (`kv`, `d1`, `scripts`, `read`), and a yes to what the spike makes and deletes.
8. **[code]** The **write cap's figure**, and the **Durable Object class** on the second account that counts writes.
9. **[code]** The **billing alert** on the second account.
10. **[code]** The **outbound Worker's deploy**.

**Could a static-files first run happen sooner, as a dry run?** It would use the same room, agents and flow, but the agents build a page with no store and no code. Under the sandbox that page forgets its list on reload, so it isn't the todo app. It would need (c) 1 to 6 and none of 7 to 10. On the build side, (b)'s unmarked items only, and spike H isn't needed for static files. It would exercise every coordination, review, merge, release, takedown and unpublish step. What it wouldn't show is the write path, the store and the cap ([question 1](#6-questions-for-the-owner)).

## 5. Risks and what we'd learn

- **Agents may not finish unaided.** If they stall, a person helping would break the rule in section 3. We'd count the stall as a finding about Podster's coordination (brief, inbox, threads), not paper over it. Each such stall is the kind of thing this test exists to surface.
- **A committed bundle is approved on trust** (decision 220, answer 3). The reviewer can't check the bundle against its source. We'd learn whether review of built files is workable for agents.
- **The sandbox may break the framework's output** (inline scripts, routing). Agents learning that from the brief, or not, tells us whether a room's inputs carry constraints well.
- **Public room, public API.** Anyone with the address can change the list (decision 220, answer 2). The test room must be short-lived, and unpublished at the end.
- **Timing.** The takedown time waits for spike G. A KV change can take a minute or more to show, so asserting a tighter time would be flaky.
- **Second-account timing.** Nothing serves before 2026-11-22. A static dry run doesn't avoid that wait.
- **Load.** Three agent sessions plus browser checks are heavy. Run them alone, not beside other local suites.
- **What we'd learn overall:** whether real agents, with nothing but Podster's capabilities, carry work from a brief to a served app, and whether every authority boundary held. Agents never approve, roles grant nothing by themselves, a merge releases nothing, and takedown reaches the app.

## 6. Questions for the owner

1. **A static dry run first?** Same flow, no store and no code, as soon as (c) 1 to 6 are done. The full todo run would follow once the store spike and (c) 7 to 10 are done.
2. **Who are P1 and P2?** Two test people from staging's sign-up, as proposed, or real people such as the two-person run's?
3. **Who is the operator for the takedown?** You, as the only person `OPERATORS` names, or a test operator you add?
4. **Which models run the agents,** and may one agent be from another provider to show Podster is model-neutral? Each provider is used with its own API key (decision 28).
5. **Hosted MCP or Agent Auth** for the agents, given Runner isn't built? Hosted MCP is proposed.
6. **Who asks for the release:** the lead agent holding a `deploy` grant, as proposed, or a person?
7. **May the agents' sessions run unattended** on the architect's machine for the length of the run, within a budget you set?
8. **Is a stall that needs a person a fail,** or a recorded gap, as with earlier gates?
