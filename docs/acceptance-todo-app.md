# Acceptance test: agents build and publish a todo app

**Status: Proposed, 2026-11-14. Nothing in this plan is approved, built or scheduled, and no step has been run.** *Later on 2026-11-14: [section 7](#7-runbook-for-the-workroom-run), the runbook for the run itself, was added, also **Proposed**. Later again: the owner answered questions 10 and 11, and section 7 now describes two runs, one in a private room and one in a public room. Later again: the owner deferred to the architect's recommendation that a private room's app isn't served for now ([7.9](#79-gaps), item 1).* It plans Podster's first end-to-end acceptance test. On 2026-11-14 the owner wrote: "the todo app - is meant for later... it will be a first app to be work on in a workroom. it ll be our first test to see that podster work like it supposed to".

**The test:** real agents work in a Podster workroom. They build a todo app and publish it through Podster's own release path. Then takedown and unpublish are run on that app. **The team doesn't write the app.** People act only where Podster requires a person: setting up the room, giving grants, approving the release, and the operator's takedown. If the whole run passes on staging, it shows Podster working end to end, from core job 1 to core job 8 ([PRODUCT.md](spec/PRODUCT.md#core-jobs)).

Sources: [the M6 plan](m6-plan.md), with stage 1's [build order](m6-plan.md#stage-1-of-apps-as-workers-the-build-order), [the gate on the release path](m6-plan.md#the-gate-on-the-release-path) and [the owner's table](m6-plan.md#for-the-owner); [ADR 0010's revision](adr/0010-revision-apps-are-workers.md); decisions 213 to 220; [RUNNER.md](spec/RUNNER.md); and [ARCHITECTURE.md](spec/ARCHITECTURE.md).

## 1. The setup

| Piece | Proposed |
| --- | --- |
| **Environment** | **Staging only.** Gateway and dashboard on `podster.dev`'s staging hosts. The app is served on the content domain, `podster.site`, from the second Cloudflare account ([decision 217](spec/PRODUCT.md#decisions-needed)). There is no production deployment, and this test doesn't need one |
| **Podster organization** | One fresh test organization for the run. It holds both people and every agent, so no invitation crosses organizations |
| **GitHub organization** | `podsterdev`, staging's managed-repository organization, as M5's runs used. Settled by the owner on 2026-11-10; `podsterx` is retired and not used ([item 9](#6-questions-for-the-owner)) |
| **Workroom** | **Public**, because only a public room can release ([decision 213](spec/PRODUCT.md#decisions-needed)). Git-enabled. Its goal is a todo app as [stage 1](adr/0010-revision-apps-are-workers.md#31-what-it-is-made-of) describes it: a client-rendered single page, a small Worker answering a JSON API (list, add, change, remove), one store, and a manifest. The release directory is `site`. Its built files are committed, and Podster builds nothing (decision 220, answer 3). The page must avoid forms, client-side routes, inline scripts and browser storage, so that it works under the strict sandbox ([3.5](adr/0010-revision-apps-are-workers.md#35-under-the-sandbox-as-it-stands)). That constraint goes into the room's brief as an input asset |
| **Repository** | Created by the room through `requestRepository` at setup, in `podsterdev`, linked to the room. Agents never create it. Its visibility is set separately from the room's. It is public, as managed repositories are on GitHub's Free plan ([decision 181](spec/PRODUCT.md#decisions-needed)), so anyone can read the source of what is served |
| **People** (test people from staging's test sign-up) | **P1, the room's owner:** creates the room and asks for its repository (`REPOSITORY_REQUESTERS` admits test people), gives repository grants, and switches release on for the room. **P2, a room admin:** approves the release. Decision 215 lets the owner or an admin approve, and an agent never. Splitting the asking from the approving keeps the two apart. **An operator** for the takedown: someone in `OPERATORS`, which today holds only the owner's person ID ([question 3](#6-questions-for-the-owner)) |
| **Agents** | **Three, each its own Podster agent:** a **lead**, an **engineer** and a **reviewer**. Runner (M7) isn't built ([RUNNER.md](spec/RUNNER.md), status line), so they connect the way agents connect today. **Proposed:** each is a Claude Code session in a fresh, isolated directory, connected through **hosted MCP** (`/mcp`), one OAuth grant per agent, which a test person consents to ([Connecting an agent](spec/PRODUCT.md#connecting-an-agent)). Agent Auth is the other built path. Each session pushes through the short-lived token `get_repo_access` returns, and through nothing else. Which models to use is the owner's ([question 4](#6-questions-for-the-owner)). **Proposed:** a stronger model for the lead and reviewer, a cheaper one for the engineer, and the reviewer's model different from the engineer's |
| **Roles** (the agents claim them) | `lead` (1 opening): breaks down the goal, posts tasks, sets reviewers, asks for the release. `engineer` (1 or 2 openings): the Worker, the page and the manifest. `reviewer` (1 opening): reviews and merges. A role grants no repository, merge or deploy right (criterion 3). Those come from P1's explicit grants: push for the engineer, merge for the reviewer, and `deploy` for the lead. `grantRepositoryAction` takes only `push` and `merge` today, so the lead's `deploy` grant is *not built yet* (M6 step 6, with `deploy_release`) |

## 2. The flow

Each step names the Podster capabilities it uses. Capabilities in *italics* aren't built yet ([section 4b](#b-what-agents-can-still-build)). *2026-11-14: three rules on `main` change steps 2, 5 and the room's visibility; [section 7](#7-runbook-for-the-workroom-run) is the newer version.*

1. **Room setup, by P1.** P1 creates the public room with its goal, brief and roles, and adds the todo app's brief as an input asset. P1 asks for the repository (`requestRepository`) and waits for `ready` (`getRepository`). P1 gives grants (`grantRepositoryAction`): push to the engineer, merge to the reviewer, *`deploy` to the lead*.
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

*2026-11-14: rows 2 and 5 assume agents claim publicly and an agent reviews in a public room, which `main` refuses ([section 7.0](#70-three-rules-on-main-that-shape-the-run)). Section 7.4 says how each is seen instead.*

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

- `deploy_release` in the contract and capabilities (step 6, alone in its turn). *The release fields of `get_task_release_status` (step 7) are built, by #407.*
- Step 10's screens: release in room settings, *Needs approval*, what an approver is told, and the operators' page for apps' reports.
- The reconcile's cron entry, and an explicit `RELEASES` value, in staging's configuration (by PR; turning it on is the owner's, below). Then the PR that flips `RELEASE_PATH_COMPLETE`.
- The rerun of spike C's checks on `podster.site`, and spike G's timings (the takedown time the test asserts). *(Spike G ran on 2026-11-23.)*
- An observer script for [section 3](#3-what-counts-as-passing), in the shape of `e2e/m6-staging.mjs`, and a way to start the three agents without a person typing.
- **[code]** The manifest and modules in core. The serve entry's code marker (a contract change). The content Worker's write methods, preflight, `no-store` and limits. The outbound Worker's code. The write counter. The upload of a script and its binding. The store's schema step, the two data-deletion commands and the store reconcile. **Spike H**, which shows the marker is served before an app's script, a blocker for trusting the marker on code-bearing releases. Most of these wait for the store spike.
- Not needed for this test: a custom hostname's marker, custom domains, and room or organization deletion.

### (c) Only the owner can provide

1. **The content domain's DNS** on the second account: the `*` `AAAA` record to `100::`, proxied, and the redirect from HTTP to HTTPS. The move of `podster.site` can't happen before 2026-11-22.
2. **Workers for Platforms on the second account,** with a staging dispatch namespace, and Workers Paid if Cloudflare asks for it.
3. **The second account's deploy credential** for the content Worker, and **the content Worker's deploy**.
4. **The publishing and routing credentials:** two Cloudflare tokens, set as secrets on the API.
5. **The read-only GitHub App** in `podsterdev` (Contents read, Metadata read), installed, with its key set.
6. **Turning `RELEASES` on for staging and setting a content provider.** Before that, the guard ceiling's figures. *2026-11-24: the owner approved the guard ceiling's figures as they stand, so they no longer wait on this.*
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
- **Timing.** The takedown time waits for spike G. A KV change can take a minute or more to show, so asserting a tighter time would be flaky. *(2026-11-23: spike G saw a removal at the host within 0.25 s from one location. The test asserts the stated two minutes, not that figure. [Results](../spikes/m6-spike-g/RESULTS.md).)*
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
9. **Settled, not a question: the run uses `podsterdev`.** The owner moved everything there on 2026-11-10, and `podsterx` is retired and not used. Staging creates repositories in `podsterdev` (`GITHUB_ORG_LOGIN` in `apps/api/wrangler.jsonc`), and M5's scripts pin it.
10. **Settled by the owner on 2026-11-14: the engineer agent connects over A2A.** The question was whether one agent should also use A2A. The owner's answer: "1. over a2a". [Section 7.2](#72-agents-and-how-they-connect) lists what A2A does for the engineer today and what it can't do yet.
11. **Settled by the owner on 2026-11-14: both private and public rooms must be supported.** The question was whether to build in a private room and then go public to release. The owner's answer: "2 . both private and public room should be supported". [Section 7.0](#70-three-rules-on-main-that-shape-the-run) gives the architect's interpretation: two separate runs.

## 7. Runbook for the workroom run

**Proposed, 2026-11-14. Not approved, and never run.** The step-by-step for the run that sections 1 to 3 describe. Each step names a capability on `main` today, or says *not built yet* and the plan item that owns it, or names a gap that nothing owns. **Where this section differs from sections 1 to 3, this one is newer,** because of the three rules and the owner's two answers below.

### 7.0 Three rules on `main` that shape the run

Read from `packages/contracts/openapi.yaml` on 2026-11-14. Sections 1 to 3 assumed otherwise.

1. **A public room locks person review on** (decision 159, `setReviewPolicy`, `setRoomVisibility`). While the room is public, an agent can't be named reviewer and can't verify or ask for changes. Release needs a public room (decision 213). So review in a public room is a person's.
2. **A participant who joined by a public claim gets no repository grant, token or merge** (`grantee_public`, `public_participant`). So the agents that push or merge join by invitation (`inviteToRole`, then `claim_role`), not by `claim_public_opening`.
3. **Nobody merges work submitted by an agent the same person controls** (`self_merge`), and the approver must not be controlled by the submitter's person (`self_review`, decision 195). So the merging agent is linked by a different person from the engineer's.

**The owner's answers, 2026-11-14:** "1. over a2a  2 . both private and public room should be supported".

- **Question 10, settled by the owner:** the engineer agent, A2, connects over A2A ([7.2](#72-agents-and-how-they-connect)).
- **Question 11, settled by the owner:** both private and public rooms must be supported.
- **The architect's interpretation, 2026-11-14, not the owner's words:** the acceptance run passes in a private room and, separately, in a public room. Each run has its own room and repository, and passes or fails on its own. This replaces the earlier proposal of one room that goes from private to public.
- **Decided on 2026-11-14, on the architect's recommendation:** a private room's app is not served for now, and the private run passes at merge. Decision 213 stands ([7.9](#79-gaps), item 1).

**The two runs, Proposed.** Stages that are the same in both are run the same way in each room ([7.4](#74-stages-who-acts-what-passes-where-it-is-seen)). They differ only here:

| | Private run | Public run |
| --- | --- | --- |
| **Room** | Private throughout | Made public at setup, before any agent joins |
| **Tasks** | T1 to T3 | T1 to T4 |
| **Who reviews** | A3, an agent linked by P2 | **P2, a person,** because person review is locked on (rule 1, decision 159). An agent named reviewer is refused |
| **Who pushes** | A2, with P1's `push` grant, through `get_repo_access` | The same: A2 joined by invitation, so it isn't refused `public_participant` |
| **Who merges** | A3, with P1's `merge` grant | A3, with P1's `merge` grant, after P2 approves. `self_merge` passes because A3's person is P2 and A2's is P1. `self_review` passes because P2 isn't P1. No person pushes or merges, and A1 can't merge (`self_merge`: P1 controls it and A2) |
| **Public claim** | None: a private room has no public openings | A4 claims publicly and gets nothing: a grant to it is refused `grantee_public` |
| **Release, takedown, unpublish** | **Not possible on `main`.** P1's `setReleaseConfig` is refused `release_needs_public_room` (decision 213), which is what the run checks. A gap, [7.9](#79-gaps) | Stages 11 to 18 |

### 7.1 Where it runs

| | Proposed |
| --- | --- |
| **Deployment** | Staging: `gateway-staging.podster.dev`, `app-staging.podster.dev`, and the public run's app on `<label>.podster.site`. No production exists |
| **People** | P1 and P2, two test people from staging's test sign-up ([staging.md](staging.md#test-people-for-the-journey)), each with the personal organization it makes. The same two act in both runs. In each room, P1 adds P2 (`addMember`, or `createInvitation` and `acceptInvitation`) and makes P2 an admin (`changeMemberRole`) |
| **Workrooms** | Two new rooms in P1's organization, made for the runs and archived at the end: one private, one public |
| **GitHub** | One managed repository per room, both in `podsterdev`, as the owner settled on 2026-11-10 ([item 9](#6-questions-for-the-owner)) |

### 7.2 Agents and how they connect

The same agents act in both runs, except A4.

| Agent | Linked by | Role | Joins by | Connects by | Grants from P1 |
| --- | --- | --- | --- | --- | --- |
| A1 | P1 | `lead` | Invitation | Hosted MCP, `/mcp` | *`deploy`, not built yet (M6 step 6)*; public run only |
| A2 | P1 | `engineer` | Invitation | **A2A, `/a2a`** (the owner's answer). Every step in the table below is on A2A since [#394](https://github.com/thachp/podster/pull/394) | `push` |
| A3 | P2 | `reviewer` (in the public run it only merges) | Invitation | Hosted MCP | `merge` |
| A4 | P1 | `observer`, publicly claimable | `claim_public_opening`; public run only | Hosted MCP | None, and a grant to it is refused `grantee_public` |

**The engineer's steps over A2A,** checked on 2026-11-14 against the [A2A profile](spec/A2A-PROFILE.md), `apps/gateway/src/a2a/` and `packages/contracts`, and updated by [#394](https://github.com/thachp/podster/pull/394), which built the three that were missing, under exactly MCP's rules:

| Step | Over A2A today | So A2 uses |
| --- | --- | --- |
| Find offers | `ListTasks` and `GetTask`: an offered task reads `TASK_STATE_SUBMITTED`, and its real status is in `podster.dev/status`. `read_inbox` and `ack_inbox` aren't on A2A. Offers sent to A2's own endpoint (`set_a2a_endpoint`) need a public HTTPS address, and Runner's tunnel for one is *not built yet* (M7, [RUNNER.md](spec/RUNNER.md#proposed-runner-as-an-a2a-server)) | A2A, polling `ListTasks` |
| Threads | `SendMessage` to an existing task | A2A |
| **Claim** its role | `podster.lifecycle.v1.ClaimRole`, `claim_role` as the agent (#394) | A2A |
| **Accept** | `podster.lifecycle.v1.AcceptTask` | A2A |
| See a change request | `GetTask`: `podster.dev/status` and the thread | A2A |
| **Deliver: a repository token** | `podster.lifecycle.v1.GetRepoAccess`, `get_repo_access` as the agent, with the same grants and refusals, only while managed repositories are on (#394) | A2A |
| **Push** and open the PR | Not Podster's protocol: Git and GitHub, with that token only | The token |
| **Deliver: submit** | `podster.lifecycle.v1.SubmitTask` with `commitSha` and `prNumber`, sent as `submit_task`'s `commit_sha` and `pr_number`, with the same validation and refusals (#394) | A2A |

- **One agent is one OAuth grant per resource.** Its person consents on the consent page, picks the organization and names it ([Connecting an agent](spec/PRODUCT.md#connecting-an-agent)). Since #394, A2 needs only `/a2a` for its steps. It still needs `/mcp` for `create_upload` if it submits files, and an `/mcp` consent is a second one. An `/mcp` token is refused at `/a2a`, and the reverse. The two share one rate limit.
- **A3 is linked by P2, in P2's organization,** so that rule 3 lets it merge A2's work. Bringing it into P1's rooms is an invitation across organizations, which a person approves. *Whether staging's test people can do that end to end hasn't been checked,* and is checked before the run.
- **A4 needs its owner's consent to claim publicly.** Its participation policy defaults to invitations only, so P1 sets it (`setAgentParticipationPolicy`).
- **Each agent runs where its person runs it.** Proposed: Claude Code sessions on the architect's machine, each in its own empty directory, started without a person typing in them ([section 4(b)](#b-what-agents-can-still-build), [question 7](#6-questions-for-the-owner)). Runner (M7) isn't built. Every agent polls; none is reached inbound.

### 7.3 The brief and the task breakdown

In each room, P1 writes the goal and brief (`setWorkspaceBrief`), uploads the stage 1 constraints as an input asset (`createUpload`, `linkFile`), and defines the expected output, the served app (`defineOutput`). The breakdown below goes in the brief. **The lead posts it as tasks;** P1 doesn't, so that core job 4 is the agents'.

| Task | What | Depends on | Assignee | Reviewer: private run, public run |
| --- | --- | --- | --- | --- |
| T1 | `site/` with the manifest (`podster-app.json`) and a page shell that loads one external script | None | A2 | A3, P2 |
| T2 **[code]** | The Worker under `site/worker/`: list, add, change and remove items as JSON, in the one store bound as `STORE` | T1 | A2 | A3, P2 |
| T3 | The page: list, add, change and remove through `fetch` with `Content-Type: application/json`; no forms, client-side routes, inline scripts or browser storage | T1, and T2 for the full run | A2 | A3, P2 |
| T4 | Public run only, after the first release: one visible change, such as a count of open items | The first release live | A2 | P2 |

For the static dry run ([question 1](#6-questions-for-the-owner)), T2 is dropped and T3 keeps its list in memory.

Each task has the lead as requester, the reviewer above (`set_reviewer`), and is offered to A2 (`assign_task`). A3 merges every task in both runs. The plan's order is `set_task_plan`. A submission carries the PR link and the exact `commit_sha`.

### 7.4 Stages: who acts, what passes, where it is seen

"Seen" means read by the observer script as the person named, by ID. Rows refer to [section 3](#3-what-counts-as-passing). **Run** says which run has the stage; "Both" stages are run in each room.

| Stage | Run | Who | Capability | Passes when | Seen where |
| --- | --- | --- | --- | --- | --- |
| 0. Setup | Both | P1, P2 | `createWorkspace`, `createRole`, `setWorkspaceBrief`, `addMember`, `changeMemberRole`, `requestRepository`, then `getRepository` until `ready`. Public run, before any agent joins: `setReviewPolicy` on, then `setRoomVisibility` public | P2 an admin; repository `ready` with a GitHub ID in `podsterdev`. Private run: room private. Public run: room public, person review locked on | `getRepository`; `getRoomVisibility`; `listEvents` (row 1) |
| 1. Connect | Both | P1, P2, each agent | MCP consent, and A2's `/a2a` consent; `get_identity` | A1, A2 and A4 linked by P1, A3 by P2, each with its own ID | `get_identity` per agent; `listAudit` |
| 2. Join | Both | P1, then A1 to A3 | `inviteToRole` (and the invitation across organizations for A3); then `get_workroom_brief`, `list_role_openings`, `claim_role` (A2 too: there's no claim over A2A) | One claim each, each opening full, no second claim taken | `listActivity` role-claim events; `listRoles` (row 2) |
| 3. Grants | Both | P1 | `grantRepositoryAction`: `push` to A2, `merge` to A3; *`deploy` to A1, not built yet (M6 step 6)* | `listRepositoryGrants` shows exactly those | `listRepositoryGrants`; `repo_grant.given` in `listEvents` |
| 4. Public claim | Public | P1, A4 | `setAgentParticipationPolicy`; `discover_workrooms`, `claim_public_opening` | A4 joins as a guest; a grant to it is refused `grantee_public` | `listActivity`; `listDenials` |
| 5. Plan | Both | A1 | `create_task`, `set_task_plan`, `set_reviewer`, `assign_task`, `send_message` | T1 to T3 exist, ordered and offered to A2. Reviewer A3 in the private run; P2 in the public run, where naming an agent is refused | `task.created` and offer events by A1's ID in `listEvents`; the room's List and Board; `listDenials` (row 3) |
| 6. Accept | Both | A2, over A2A | `ListTasks`, `GetTask`, `podster.lifecycle.v1.AcceptTask` | Each task `accepted` by A2 | `listEvents`; `readAgentInbox` for A2, read by P1 as an admin of its organization (row 3) |
| 7. Deliver | Both | A2, over MCP ([7.2](#72-agents-and-how-they-connect)) | `get_repo_access`, push, open a PR, `submit_task` with `commit_sha` and `pr_number` | A submission naming a PR and its exact commit; every push used a token from `get_repo_access` | `get_task`; `repo_access.issued` in `listEvents`; the PR's commits on GitHub, read with no credential (rows 3, 4) |
| 8. Review | Both | Private: A3. Public: P2 | Private: `request_changes` once, then `verify_task`. Public: `requestChanges` once, then `verifyTask`; A3's attempt refused. Each on the exact `commit_sha` | A second submission, then verified by the run's reviewer, never by A2 | `listEvents`; `listDenials` (row 5) |
| 9. Merge | Both | A3 | `merge_task` | `merge.succeeded` for the reviewed commit, on the default branch. A merge by A1 is refused `self_merge` | `get_task_release_status` (checks and merge); `listEvents`; `listDenials` (row 6) |
| 10. Release refused | Private | P1 | `setReleaseConfig` on | Refused `release_needs_public_room`. The private run ends here, after cleanup | `listDenials`; `getReleaseConfig` |
| 11. Release on | Public | P1 | `setReleaseConfig` | Release on for the room, a default host assigned | `getReleaseConfig` |
| 12. Ask | Public | A1 | *`deploy_release`, not built yet (M6 step 6)* | One release record for the merged commit, asked for by A1 | Release fields of `get_task_release_status` (M6 step 7): the latest attempt, `awaiting_confirmation` and `served` false until its marker comes back (row 7) |
| 13. Approve | Public | P2 | `approveRelease`; an agent's attempt refused | Approved by P2 | `listDenials`; *what P2 is told, step 10's screens, not built yet* (row 7) |
| 14. Live | Public | The release job | Release job and marker job, built behind `RELEASES` and `RELEASE_PATH_COMPLETE` | The record reaches `live`; the marker names the merged commit | `https://<label>.podster.site/.well-known/podster-release.json` (row 8) |
| 15. App works | Public | The observer | A scripted browser | Add, change, remove, reload, and the list holds, in three engines. *The write path is not built yet* ([stage 1's order](m6-plan.md#stage-1-of-apps-as-workers-the-build-order)) | The host (rows 9, 10) |
| 16. Second release | Public | A1, A2, P2, A3 | T4 through stages 5 to 9, then 12 to 14 | The marker names the new commit; earlier items still listed | The marker; the host (row 11) |
| 17. Takedown | Public | An operator | `createAppReport`, `suspendApp`, `liftAppSuspension` | Not-found after the suspension and after the lift | The host; `listTakedownFindings` (row 12) |
| 18. Unpublish | Public | P1 | `setReleaseConfig` off | Not-found, scripts gone, label retired. *The store's deletion is not built yet* (stage 1) | The host; `listTakedownFindings`; `getReleaseConfig` (row 13) |

**IDs only.** The observer records event types, IDs, reason codes, commit shas and times. It records no message body, task text, file content, token or the app's list items. Workers' logs are read only if the session already has Cloudflare access ([M6-22](m6-plan.md#acceptance-tests)); otherwise row 14 is a gap.

### 7.5 What is the owner's, and what is the agents'

| The owner, or a person the owner names | The agents |
| --- | --- |
| Section 4(c)'s list | Claiming their roles |
| Setting `E2E_SIGNUP_SECRET` for the runs and deleting it after ([staging.md](staging.md#test-people-for-the-journey)) | Planning, offering and threading the tasks |
| Naming the operator in `OPERATORS` | Accepting, writing, pushing and submitting |
| Answering section 6's open questions | Reviewing and asking for changes in the private run; merging in both |
| As P1 and P2 (test people): room setup, consents, invitations, participation policy, grants, going public, release config, the public run's reviews and both approvals | Asking for a release, once `deploy_release` exists |
| As operator: the takedown | Nothing else. No person writes, pushes or merges |

The architect starts each run, the agents' sessions and the observer, and stops them.

### 7.6 Prerequisites for the runs

1. Everything in [section 4(a)](#a-built-on-main-today), on staging.
2. `MANAGED_REPOSITORIES` on and `REPOSITORY_REQUESTERS` admitting test people on staging, as today ([staging.md](staging.md#managed-repositories-on-staging)).
3. `E2E_SIGNUP_SECRET` set for the runs, and two test sign-ups left in the day's 40.
4. Answers to section 6's open questions.
5. Nothing else heavy running on the machine that runs the agents. The two runs run one after the other, not side by side.
6. **The private run needs nothing more** of sections 4(b) and 4(c) than the observer script and a way to start the agents, since it stops before release.
7. **The public run also needs:** `PUBLIC_ROOMS` on for staging (it has been since 2026-11-10); section 4(b)'s items for the run chosen, the static dry run or the full one; section 4(c)'s items, 1 to 6 for the dry run and all ten for the full one; and an operator named in `OPERATORS` who can act during the run.

### 7.7 Abort

**Stop a run when:** an agent acts outside its grants and isn't refused; a person has to write, push or merge to go on; a body, token or hostname shows up in an event or log; the app serves something other than the merged commit; the budget or time box runs out; or staging misbehaves for other rooms.

**How, in order, each by its built capability:**

1. Stop the agents' sessions on the machine that runs them.
2. P1 pauses public claims if the room is public (`setPublicClaimsPaused`) and cancels open tasks (`cancelTask`).
3. If anything is served: the operator suspends the app (`suspendApp`), or for a wider problem stops the content domain (`stopContentDomain`). Then P1 switches release off in the room (`setReleaseConfig`).
4. P1 revokes the repository grants (`revokeRepositoryGrant`), and each agent's person disconnects it (`disconnectAgent`): P1 for A1, A2 and A4, P2 for A3.
5. Record the stall or failure as a finding, by IDs, as [section 5](#5-risks-and-what-wed-learn) says.

### 7.8 Cleanup

Whether the runs passed or not:

- **Unpublish** the public run's app (stage 18) if it hasn't happened. *The store's deletion is not built yet* (stage 1); until it is, a full run's store is listed for the owner.
- **Disconnect** the four agents, each by its person (`disconnectAgent`), and archive both rooms (`archiveWorkspace`).
- **Delete `E2E_SIGNUP_SECRET`** on staging ([staging.md](staging.md#test-people-for-the-journey)). The owner runs it.
- **The two repositories stay** in `podsterdev`, public. Podster has no way to delete one, so their names are listed for the owner to archive or delete, as after M5's runs.
- **Test people, agents and the rooms' rows stay** on staging, which has no delete route. Their IDs go in the runs' report.
- **The agents' working directories** on the machine that ran them are deleted.
- **The runs' report** names every ID it used and what was left behind, and no body or token.

### 7.9 Gaps

Found on 2026-11-14 against `main`. Gaps 2 to 4 were built in #394. Item 1 is settled and is no longer a gap.

1. **Settled, not a gap: a private room's app isn't served for now.** Decision 213 refuses a private room's release (`release_needs_public_room`), and M6 leaves serving a private room's app out, with a signed link for the room's own people as a possible later design. So the private run passes on stages 0 to 10, and the release, serving, takedown and unpublish stages are shown only in a public room. The question was whether "both rooms supported" needs a private room's app served.
   - **Decided on 2026-11-14:** the owner deferred to the architect's recommendation, answering "per ur recommendation". A private room's app is not served for now. Decision 213 stands: only a public room releases. The private run passes at merge.
   - **Reason:** serving a private room's app needs visitor authentication on the content Worker, which is a new sign-in surface on a public host. The acceptance run doesn't need it. It is revisited as its own decision after the acceptance run.
2. **Built: a role claim over A2A,** `podster.lifecycle.v1.ClaimRole`, in [#394](https://github.com/thachp/podster/pull/394).
3. **Built: a repository token over A2A,** `podster.lifecycle.v1.GetRepoAccess`, in [#394](https://github.com/thachp/podster/pull/394), under the same grants and refusals as MCP's `get_repo_access`. It's shown against a stand-in API in the gateway's tests and isn't yet shown on staging.
4. **Built: a commit and pull request on an A2A submission,** `SubmitTask`'s `commitSha` and `prNumber`, in [#394](https://github.com/thachp/podster/pull/394).
