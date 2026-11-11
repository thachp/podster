# M3 plan

The owner accepted all 28 questions below on 2026-11-08, as [decisions 107 to 134](spec/PRODUCT.md#decisions-needed). The owner accepted [ADR 0007](adr/0007-a2a.md) on 2026-11-08, which covers the engineering details in the build order. The order of the steps is still **Proposed**, and so are ADR 0007's [details to settle in review](adr/0007-a2a.md#proposed-details-to-settle-in-review). It covers [M3 A2A](spec/PRODUCT.md#product-direction-and-delivery-scope) and starts from the [proposed A2A adapter](spec/ARCHITECTURE.md#a2a-adapter). No A2A code exists.

**Status, 2026-11-11 UTC: M3's gate is met.** The owner called it on 2026-11-11, accepting local runs for four items that didn't run on staging ([decision 193](spec/PRODUCT.md#decisions-needed)). [The gate call](#m3s-gate-checklist) is recorded under M3's gate checklist. Everything below is kept as it was written.

**Status, 2026-11-08 UTC:** on 2026-11-07 the owner said "we need to finish m2", meaning M2 before any M3 code. [Decision 133](spec/PRODUCT.md#decisions-needed) says what finished means for M3's product code, and [decision 107](spec/PRODUCT.md#decisions-needed) lets the spikes and ADR 0007 start now. The [spikes](#spikes) come first, then the [build order](#build-order).

**2026-11-08, step 8:** the lead ruled, as architect, that an A2A task's `id` and `contextId` are written `<workspace_id>:<task_id>`. A2A reads carry only a task ID, and Podster reads a task within its room. It keeps decision 116's intent, and ADR 0007 records it. `ListTasks` looks across the caller's rooms, at most 50.

## What M3 includes

From [`PRODUCT.md`](spec/PRODUCT.md#agent-communication-mcp-and-a2a):

- **A published profile:** which protocol version, binding, operations and state mappings Podster supports.
- **Inbound:** a remote A2A client authenticates as a Podster agent identity and reaches the same commands as MCP.
- **Outbound:** an agent that registers an A2A endpoint gets its offers delivered through the outbox, under the wake egress policy.
- **Tests:** interoperability and authorization, positive and negative.

MCP-only agents stay fully supported, and offline agents aren't promised to be reachable. Runner's [inbound nudge](spec/RUNNER.md#optional-inbound-a2a) stays in M7 (question 24).

## Protocol gates

From the specs. Nothing may say Podster supports A2A until all of these pass:

- The profile is published.
- Positive and negative interoperability tests pass with at least two independent implementations.
- Authorization tests pass on a deployment, including:
  - **AC-12:** forged, expired or wrong-audience assertions are refused, the same as on the other paths.
  - **AC-18:** A2A instructions to elevate access stay data.
  - **AC-24:** a remote completion records a submission only, or is held before acceptance, and grants nothing.
- Expanded criterion 4 holds across protocols: one task history, and duplicate deliveries don't create competing tasks.

## What M3 needs from M2

| M3 needs | From M2 | Status on `main`, 2026-11-08 | Used by M3 step |
| --- | --- | --- | --- |
| No more M2 contract or migration PRs in flight | Through step 8, and step 10's D1 migration if it has one | Steps 2 and 4 merged. Step 3 is [#125](https://github.com/thachp/podster/pull/125) and step 6's second part is [#131](https://github.com/thachp/podster/pull/131), both open. Steps 5, 7, 8 and 10 not started | 5, 6 and every later C or M PR |
| A stable task and submission shape | Steps 6 and 7 | Step 6's pure rules merged in [#128](https://github.com/thachp/podster/pull/128). The rest is open | 8, 10, 13 |
| Uploads an agent can start for its own submission | Step 6 (`create_upload` with `task_id`) | In #131 | 14 |
| Input files an offer can point to | Step 5 | Not started | 14 |
| Held responses shown beside submissions in the Task Sheet | Step 9b | Not started | 15 |
| A files path that has run for real | Step 11, M2's gate | Not started | 16 |

Text messages, reads and the lifecycle need M2 only to have finished its contract and migration changes. Files need M2's code. M2 step 10 may add a D1 migration if cards read the index. If it does, that migration is one of M2's and lands before M3's first C or M PR.

## Spikes

Each runs in `spikes/`, is thrown away afterwards, and ends with its results written into ADR 0007, as M2's spike did for [ADR 0006](adr/0006-uploads-and-scanning.md#spike-results). [Decision 107](spec/PRODUCT.md#decisions-needed) lets them run before M2 is finished.

| Spike | What it must prove | Pass bar | Where | Needs |
| --- | --- | --- | --- | --- |
| **A: inbound on a Worker** | A Worker can serve A2A 1.0 over JSON-RPC to real clients: Agent Card, `SendMessage` to an existing task, `GetTask`, `ListTasks`, and named errors for streaming, push and the extended card. Also whether the project's JavaScript SDK server code runs on Workers (question 22) | Two client implementations (question 18) complete card, send and get with no patches. A request with no version gets `VersionNotSupportedError`. Every kit MUST failure is either fixed or written down with why it doesn't fit a coordinator. CPU per request is measured and recorded | Local, `wrangler dev` | Questions 1, 2, 3, 18 and 22 |
| **B: a separate A2A audience** | The gateway's existing OAuth provider can issue tokens for a second resource, `/a2a`, with its own scope, tied to the same agent identity and consent as `/mcp` | An A2A token is refused at `/mcp` and `/v1/files`, and an MCP token at `/a2a`, before any API call. Disconnecting revokes both. At least one A2A client finishes the OAuth flow unpatched, or the ADR records which clients need a token issued by hand | Local | Questions 1 and 5 |
| **C: outbound send and read-back** | A queue consumer can send `SendMessage` with `return_immediately` to a remote A2A server, then read its state with `GetTask`, under `crates/egress`'s rules as they stand | An offer reaches two different server implementations and their state is read back. Everything [the wake policy](spec/ARCHITECTURE.md#wake) refuses is refused before sending: `http`, an IP address in any form, credentials in the URL, a non-default port and `podster.dev`. A redirect isn't followed. A resend with the same `messageId` is recorded as the server actually treats it. Logs hold IDs only | Local, with a test server. A staging run needs the owner in that session | Questions 1, 16 and 20 |

The wake policy checks the name, not what it resolves to, and relies on `global_fetch_strictly_public`. Spike C doesn't test resolved addresses. Whether A2A needs more, since it sends task text where wake sends only IDs, is question 28.

### Spike results, 2026-11-08 UTC

All three ran locally. Each folder's README has the details.

- **A** ([#138](https://github.com/thachp/podster/pull/138), `spikes/m3-a2a-inbound`):
  - **Passed:** 14 tests in workerd. The project's JavaScript and Python clients passed unpatched. The SDK's JSON-RPC transport runs on Workers, used with Podster's own request handler and not the SDK's `DefaultRequestHandler`.
  - **Not run:** the kit, because the permission check refused it ([decision 142](spec/PRODUCT.md#decisions-needed)). From its source, it creates its own tasks and sends no token.
- **B** ([#139](https://github.com/thachp/podster/pull/139), `spikes/m3-a2a-audience`):
  - **Passed:** 9 tests in workerd, and a standard OAuth client followed by the A2A client, 10 of 10. `/mcp` and `/a2a` tokens are refused at each other's resource, and disconnect revokes both.
  - **Needs:** the gateway's OAuth set-up has to change, as step 7 says.
- **C** ([#140](https://github.com/thachp/podster/pull/140), `spikes/m3-a2a-outbound`), the local half only:
  - **Passed:** 10 tests in workerd through a local queue, against the project's own SDK server.
  - **Found:** the SDK server makes a second task for a resent `messageId`.
  - **Not run then:** an independent server, since starting LangGraph's was refused by the permission check. Both LangGraph and the staging half ran on 2026-11-09, with the owner's yes. See M3's gate checklist.

## Build order

C changes `packages/contracts` and M adds a migration or room schema. The order is **Proposed**. What each step does follows the accepted ADR 0007. Product code, steps 5 onward, waits until M2 is finished as [decision 133](spec/PRODUCT.md#decisions-needed) defines it. C and M PRs merge one at a time, after M2's last one, and take turns with planning's as [decision 60](spec/PRODUCT.md#decisions-needed) does for M2.

| Step | Work | C | M | After | Runs beside |
| --- | --- | --- | --- | --- | --- |
| 0 | ADR 0007 draft: the profile, from the owner's rulings | | | Rulings. **Done** ([#145](https://github.com/thachp/podster/pull/145)) | 1, 2, 3 |
| 1 | Spike A | | | Questions 1, 2, 3, 18 and 22. **Done**, without the kit ([#138](https://github.com/thachp/podster/pull/138)) | 0, 2, 3 |
| 2 | Spike B | | | Questions 1 and 5. **Done** ([#139](https://github.com/thachp/podster/pull/139)) | 0, 1, 3 |
| 3 | Spike C | | | Questions 1, 16 and 20. **Done.** The local half is [#140](https://github.com/thachp/podster/pull/140), and the staging half ran on 2026-11-09 with the owner's yes, as recorded under M3's gate checklist | 0, 1, 2 |
| 4 | ADR 0007 with spike results, accepted by the owner | | | 0 to 3. **Done:** accepted on 2026-11-08 | |
| 5 | Pure mapping in `crates/core/src/a2a.rs`, with one line in `lib.rs`: a remote state plus the current Podster state gives one command, a hold or nothing. Tests include late and out-of-order updates | | | 4, M2 finished | 6 |
| 6 | Gateway module `apps/gateway/src/a2a/`: Agent Card, JSON-RPC envelope, version check, and every operation answering its named "not supported" error. The profile is `docs/spec/A2A-PROFILE.md`, and a gateway test checks the card lists only the operations it names. `check.mjs` covers only `openapi.yaml` and `capabilities.yaml`, so nothing here changes `packages/contracts` | | | 4, M2 finished. **Done** ([#155](https://github.com/thachp/podster/pull/155)) | 5 |
| 7 | Authentication, as its own PR with [decision 127](spec/PRODUCT.md#decisions-needed)'s deeper pass:<br>• Move the gateway from the combined `OAuthProvider` to one `OAuthAuthorizationServer` with two `OAuthResourceServer`s, `/mcp` and `/a2a`, still in one Worker. The combined provider has one resource, so it can't give `/a2a` its own audience.<br>• Set `defaultResource` and `legacyGrantResource` to `/mcp`, so clients that send no `resource`, and old grants, stay MCP.<br>• Change the consent code to grant `a2a` for an `/a2a` request. Today it refuses every scope but `mcp` and `offline_access`.<br>• Use `getOAuthApi(env)` where the gateway uses `env.OAUTH_PROVIDER`, and keep `forMcp` MCP-only.<br>• Tokens resolve to the same agent identity. Add AC-12's negatives. | Only if the API's identity call changes | | 6. **Done** ([#157](https://github.com/thachp/podster/pull/157)) | |
| 8 | Inbound reads: `GetTask` and `ListTasks` through `get_task` and `list_tasks`. A hidden task gets the same `TaskNotFoundError` as a missing one | | | 7. **Done** ([#165](https://github.com/thachp/podster/pull/165)) | 11 |
| 9 | Inbound messages: `SendMessage` with a `taskId` becomes `send_message`, with `messageId` as the idempotency key, size limits and `external` marking. No `taskId` is refused | Yes | Only if `messageId` can't use the idempotency record | 8. **Done** ([#167](https://github.com/thachp/podster/pull/167)) | 11 |
| 10 | Inbound lifecycle through the Podster extension: accept, decline, release, and submit with text and links | Yes | | 9 | 11 |
| 11 | Endpoint registration on the `Principal`: set, delete and status, checked against the egress policy, with the credential from question 16 | Yes | Yes | 7 | 8, 9, 10 |
| 12 | Outbound offers: outbox, queue, `SendMessage` with `return_immediately`, the stored mapping of one A2A task per offer attempt, retries with the same `messageId`, and switching off after repeated failures | | Yes | 5, 11 | **Done** ([#173](https://github.com/thachp/podster/pull/173)). Passed on staging for the failure half, 2026-11-09 at `0794706` |
| 13 | Remote updates, as question 11 decides: read back, mapped through step 5 into a submission, a held response, a release or nothing. `cancel_task` sent out | Yes | Yes | 12 | **Done** ([#177](https://github.com/thachp/podster/pull/177)) |
| 13b | `request_changes` on a completed remote task, sent out as a new A2A task with `referenceTaskIds` and the same `contextId` ([decision 114](spec/PRODUCT.md#decisions-needed)). Split from 13 on 2026-11-08, because it's a second send path | Yes | Yes | 13 | **Done** ([#183](https://github.com/thachp/podster/pull/183)), with `origin` on history entries |
| 14 | Files: inbound submissions with files from `create_upload`, offers that link input files as Podster links, and remote file references kept as external links | Yes | | 10, 13, M2 steps 5 and 6 | **Done** ([#180](https://github.com/thachp/podster/pull/180), and `/a2a/files` in [#181](https://github.com/thachp/podster/pull/181)). Passed on staging, 2026-11-09 at `0794706` |
| 15 | Screens: endpoint status on the agent's Sheet, and held responses flagged to the requester in the Task Sheet | | | 11, 13, M2 step 9b | **Done** ([#182](https://github.com/thachp/podster/pull/182)) |
| 16 | Staging run: AC-12, AC-18, AC-24, criterion 4 across protocols, and the implementations [decision 143](spec/PRODUCT.md#decisions-needed) names. The kit runs only if a way to run it has been found ([decision 142](spec/PRODUCT.md#decisions-needed)). Its non-fitting checks are listed in the profile ([decision 141](spec/PRODUCT.md#decisions-needed)). Then the owner rules, and the profile is published | | | All, M2's gate | |

**What runs in parallel:** the three spikes and the ADR draft. Steps 5 and 6. Step 11 is built beside 8 to 10, because it's in the `Principal` and they're in the `Workspace` path. Steps 9 to 11 change contracts and 11 adds a migration, so they're built side by side and still merge one at a time. Steps 14 and 15, which are in different folders.

**Steps that still need the owner's yes in that session:**

- **Spike C on staging,** by [decision 126](spec/PRODUCT.md#decisions-needed). The owner said yes on 2026-11-09, and it ran that day.
- **Step 11's encryption secret** for stored endpoint tokens, by [decision 122](spec/PRODUCT.md#decisions-needed). The owner sets it.
- **Step 12's queue and dead-letter queue,** by [decision 129](spec/PRODUCT.md#decisions-needed). The owner created `podster-a2a-staging` and `podster-a2a-dlq-staging` on 2026-11-08.

Step 8 waits only on step 7, because reads translate today's task view. Step 5's mapping is first used by step 12.

The gateway only translates. Rust decides every command, including what a remote state means. New gateway code goes in `apps/gateway/src/a2a/`, new Rust in new modules, and each touches `index.ts`, `lib.rs` and `workspace.rs` by a line or two. Each capability updates contracts in its own PR.

## Questions for the owner

The owner accepted every recommendation on 2026-11-08 ("sure"). Each row links to its decision, which is the record. The defaults are kept to show what was ruled out.

| # | Question | Accepted recommendation | Default it replaced | Decision |
| --- | --- | --- | --- | --- |
| 1 | Do the spikes and ADR count as the M3 code that the owner's 2026-11-07 statement holds until M2 is finished? | Spikes in `spikes/` and the ADR may start now, since they don't touch product code, contracts or staging. Product code, including step 5's pure code, waits as question 27 says | Nothing but docs until M2 is finished | [107](spec/PRODUCT.md#decisions-needed) |
| 2 | Which binding? | JSON-RPC only at first. One binding is allowed, it's the simplest on a Worker, and HTTP+JSON's error format disagrees within the spec | Same | [108](spec/PRODUCT.md#decisions-needed) |
| 3 | Which version? | 1.0 only, with no 0.3. Two versions double the tests | Same | [109](spec/PRODUCT.md#decisions-needed) |
| 4 | What does Podster's server offer beyond the basics? | Streaming, push notifications and the extended card all off. One public card that describes Podster and lists no rooms | Same | [110](spec/PRODUCT.md#decisions-needed) |
| 5 | How does an A2A client authenticate? | An OAuth 2 bearer token for the same agent identity, with an audience just for A2A, through the same consent. Agent Auth JWTs aren't accepted on A2A at first | Same | [111](spec/PRODUCT.md#decisions-needed) |
| 6 | Does a remote agent reporting `WORKING` accept an offer? | Yes, from the registered endpoint only, and the profile says so plainly. `COMPLETED` with no `WORKING` is held. Generic agents can then take part without an extension | No. Only the extension accepts, and anything before that is held | [112](spec/PRODUCT.md#decisions-needed) |
| 7 | How does an inbound client accept, decline, release or submit? | A small versioned Podster extension. Reading and messages don't need it. A message's text never becomes a command | No inbound lifecycle in the first profile, only reads and messages | [113](spec/PRODUCT.md#decisions-needed) |
| 8 | How does `request_changes` reach a completed remote task? | A new A2A task with `referenceTaskIds` and the same `contextId`, because a terminal task takes no messages | Same | [114](spec/PRODUCT.md#decisions-needed) |
| 9 | Can a task be created over A2A? | No. A task needs a room, role, reviewer and policy that plain A2A doesn't carry | Same | [115](spec/PRODUCT.md#decisions-needed) |
| 10 | What are `contextId` and the task ID? | Both come from the Podster task, with no room-wide context, so a shared `contextId` can't reach across a room | Same | [116](spec/PRODUCT.md#decisions-needed) |
| 11 | How does Podster learn a remote task's state? | Polling `GetTask` from the queue, backing off from 1 minute to 1 hour, ending at a terminal state or after 7 days. Push later, since servers needn't support it and it adds a public webhook | Same | [117](spec/PRODUCT.md#decisions-needed) |
| 12 | What does an outbound offer carry? | The title, instructions and acceptance criteria as text parts, read fresh at send time after access is rechecked, and a Podster link. The queue holds IDs only | IDs and a link only, which most generic agents can't act on | [118](spec/PRODUCT.md#decisions-needed) |
| 13 | Who registers an endpoint? | The agent, or its organization's admin, as with wake. One per agent, beside wake rather than replacing it. It grants nothing in any room | The agent only | [119](spec/PRODUCT.md#decisions-needed) |
| 14 | Does Podster fetch a remote Agent Card? | Not at first. The registrant gives the URL, and the first delivery shows it works. A fetched card would be untrusted input with SSRF risk | Same | [120](spec/PRODUCT.md#decisions-needed) |
| 15 | What happens to file references? | Podster never fetches one. A URL is kept as an [external link](spec/PRODUCT.md#decisions-needed), bytes come through `create_upload`, and inline bytes are refused | Same | [121](spec/PRODUCT.md#decisions-needed) |
| 16 | What credential does Podster hold for a remote endpoint? | A signed request like wake's, plus one optional bearer token per endpoint, encrypted. It's Podster's first stored outbound credential, so it gets question 21's pass and a new secret the owner sets. Setting the secret still needs the owner's yes at step 11 | Signed requests only, and no stored token | [122](spec/PRODUCT.md#decisions-needed) |
| 17 | Which limits apply? | MCP's: 16 KB per message, 10 artifacts per submission, the same request rates. At most 8 parts per message. One send per offer attempt | Same | [123](spec/PRODUCT.md#decisions-needed) |
| 18 | What counts as two independent implementations? | One project SDK, and one agent framework from outside the project, so they can't share a misreading. Spike A names candidates for the owner to pick | No support claimed until the owner names them | [124](spec/PRODUCT.md#decisions-needed) |
| 19 | What must the kit show? | Every MUST check passes, or each exception is in the profile with its reason | Same | [125](spec/PRODUCT.md#decisions-needed) |
| 20 | Where do the spikes run? | Locally. Spike C runs once on staging only if the owner says yes in that session | Local only, with the real egress checks left to step 12 on staging | [126](spec/PRODUCT.md#decisions-needed) |
| 21 | Which steps get a deeper security pass? | Steps 7, 11, 12 and 13, beyond the quick diff review. They add a public protocol surface, outbound calls and a stored credential | Same, since each is asked before it runs | [127](spec/PRODUCT.md#decisions-needed) |
| 22 | The project's JavaScript SDK in the gateway, or a small fresh JSON-RPC layer? | Whichever spike A shows runs cleanly on Workers. A fresh layer if the SDK needs Node-only server code | A fresh layer | [128](spec/PRODUCT.md#decisions-needed) |
| 23 | Which cloud resources? | A new queue and dead-letter queue for A2A, kept apart from wake, which is ID-only and debounced. Creating them still needs the owner's yes at step 12 | Nothing is created. Without a queue, step 12 can't start | [129](spec/PRODUCT.md#decisions-needed) |
| 24 | Is Runner's inbound nudge part of M3? | No, it stays in M7. M3 only gives it a profile to follow | Same | [130](spec/PRODUCT.md#decisions-needed) |
| 25 | Do test people count for M3's gate, as for M1 under [decision 79](spec/PRODUCT.md#decisions-needed)? | Yes. A pass with a real second person stays owed before production | Same | [131](spec/PRODUCT.md#decisions-needed) |
| 26 | Who calls the gate, and when may support be claimed? | The owner, after step 16's staging run. Until then the card and docs say "preview" and never "conformant" | Same | [132](spec/PRODUCT.md#decisions-needed) |
| 27 | When is M2 "finished" for M3's product code? | When M2's last contract or migration PR has merged, through step 8 and step 10's D1 migration if it has one. M2's screens and staging run can finish beside M3's first steps, and M3's gate still waits for M2's | When M2's gate, step 11, has passed | [133](spec/PRODUCT.md#decisions-needed) |
| 28 | Does A2A egress need more than wake's policy? | No new resolved-address check at first. Keep wake's rules and `global_fetch_strictly_public`, and don't follow redirects. Revisit before public rooms, when anyone could register an endpoint | Same | [134](spec/PRODUCT.md#decisions-needed) |

## Question C: the second implementation

[Decision 143](spec/PRODUCT.md#decisions-needed) settles it: independence is judged by direction. Outbound runs against LangGraph's A2A 1.0 server, with fasta2a's server as backup. Inbound uses the A2A project's own clients and the kit's `httpx` client, and the profile says so. It's revisited before public rooms.

**What the recommendation rested on,** read on 2026-11-08 UTC from package metadata and source, without running either:

- **fasta2a 2.1.1,** from PyPI, and `pydantic/fasta2a` at `5786276` on GitHub. It doesn't depend on `a2a-sdk`.
  - In `fasta2a/client.py`, `A2AClient` sends the 0.3 method names `message/send`, `message/stream` and `tasks/get`.
  - It sets only `Content-Type` on each request, and makes its own `httpx` client with no default headers unless the caller passes one.
  - `fasta2a/jsonrpc_v1.py` maps 1.0 method names to those, for the server side only.
- **langgraph-api 0.17.1,** installed from PyPI into a local virtual environment and read, not run:
  - `langgraph_api/api/a2a.py` sets `A2A_PROTOCOL_VERSION = "1.0"` and serves `/a2a/{assistant_id}`.
  - Nothing in the package imports `a2a`.
- **langgraph-sdk 0.4.14:**
  - Its PyPI description doesn't mention A2A.
  - A GitHub code search of `langchain-ai/langgraph` for "a2a" under `libs/sdk-py` matched only a docstring in `langgraph_sdk/runtime.py` and `uv.lock`. Under `libs/sdk-js` it matched nothing.
  - So I found no A2A client there. A search can miss one.
- **Built on `a2a-sdk`, from their PyPI metadata:** CrewAI 1.15.37 pins `a2a-sdk~=0.3.10`. Google ADK 2.14.0 and `agent-framework-a2a` 1.0.0b261106 depend on `a2a-sdk`.

## M3's gate checklist

What proves each gate item, and how far that proof has got. This is modeled on [M0's gate](m0-gate.md), and an item only moves when the run has actually happened.
- **Passed locally:** a test passes under Miniflare or `wrangler dev`. For a staging check, it passed in its local rehearsal (`run-a2a-staging.mjs`).
- **Passed on staging:** the staging check passed against `gateway-staging.podster.dev`, at the commit given.
- **Owed:** nothing yet proves it.

Last updated 2026-11-10 UTC: every M3 build step merged (1 to 15, 13b, and `/a2a/files`), #240 merged and deployed, and the kit run on staging. Decision 192 was deployed, and AC-18 and the screens ran on staging. **Three items are owed to the owner, and one question.** "Owed before M3's gate" lists them. That was the state on 2026-11-10; the owner answered on 2026-11-11, as the next entry says.

**The gate call, 2026-11-11: M3's gate is met.**
- **Decided by the owner,** on 2026-11-11, in reply to the architect's question under "Owed before M3's gate", which laid out the evidence and the open items. The owner's reply, in full: "M3 gate: local runs are enough for LangGraph, fasta2a, cancel-task delivery and the Python client. Gate met."
- **This is the gate call** that [decision 132](spec/PRODUCT.md#decisions-needed) gives to the owner. It's recorded as [decision 193](spec/PRODUCT.md#decisions-needed).
- **What it accepts:** that the local runs stand as the evidence for four gate items that did not run on staging. None of the four has run on staging since, and nothing here says one did:
  - **outbound to LangGraph:** ran locally only; accepted by the owner on 2026-11-11. The local run is `e2e/run-langgraph-check.mjs`, 4 of 4 with decision 174;
  - **fasta2a as the backup independent server:** ran locally only; accepted by the owner on 2026-11-11. The local run is `e2e/run-fasta2a-check.mjs`, 3 of 3;
  - **`CancelTask` delivery:** ran locally only; accepted by the owner on 2026-11-11. The local evidence is `a2a-readback.spec.ts` against a scripted endpoint, and the fasta2a run, where `CancelTask` went out once. On staging, the round trip shows only Podster's task staying canceled;
  - **the A2A project's Python client:** ran locally only; accepted by the owner on 2026-11-11. The only local run on record is Spike A's ([#138](https://github.com/thachp/podster/pull/138)), against the spike's code. The run against the built gateway was never made, locally or on staging, because the install was refused.
- **What it doesn't change:**
  - **The kit's result stands as recorded.** Of its 115 MUST checks, 29 passed, of which 26 test Podster. 8 failed, all from decision 115. By [the profile's tally](spec/A2A-PROFILE.md#decision-125s-tally), 44 are evidenced against Podster, 68 are listed exceptions, 3 pass but test only the kit's own constants, and 0 have neither.
  - **What's left on staging stays there:** each run's room and tasks, and its test person, signed out. The test sign-up is still on, and turning it off is the owner's `wrangler secret delete E2E_SIGNUP_SECRET --env staging`. The test Worker `podster-a2a-test-staging` is still deployed, and deleting it is the owner's.
  - **The card and docs still say "preview".** Whether the Agent Card and docs drop 'preview' now that the gate is met is a separate question for the owner; nothing was changed.
  - **What's owed before production** is still owed, as listed under "Owed before production that M3 touches".
- **Earlier, on 2026-11-10,** the owner had said "sure .. go ahead do whatever u need to do for to complete m3 as m4.. you got my approval". The architect didn't treat that as the gate call, and asked.

**The gate run, 2026-11-09.** The owner approved three items that day, answering "yes, yes, option a": LangGraph locally, Spike C on staging, and the test A2A server from [#184](https://github.com/thachp/podster/pull/184)'s option A. All three ran.
- **The outside round trip and Spike C on staging.** `e2e/a2a-roundtrip.mjs` passed 26 of 26, with 0 failed, after #194's review fixes. It ran against staging in room `ws_1659316eb6114fc99c949e0f42881009`, with staging on API version `f9813a81` and gateway `2aa10d4b`, and the test server on version `982b35b8`.
  - **The far end** was [the test A2A server](../e2e/a2a-test-server/README.md), `podster-a2a-test-staging`, at `https://podster-a2a-test-staging.podster-dev.workers.dev`. It checks the signature and bearer, as a real agent would.
  - **The lead accepted this design** for how a run's values reach it:
    - The server holds one secret, `RUN_KEY`, 64 hex characters, which the owner set once. Its local copy is `~/.config/podster/a2a-test-run.key`, on the machine that runs the check. The run refuses the file unless only its owner can read it, and the key is never printed or committed.
    - Each run seals the endpoint's signing secret, the agent's `/a2a` token and an expiry under `RUN_KEY` with AES-256-GCM. It sets the result as the endpoint's bearer token, which Podster stores sealed again. The run checks every agent's endpoint holds it, as `stored`.
    - The expiry is at most 1 hour, and the server refuses a bearer that claims longer.
    - The server opens the bearer and verifies `X-Podster-Signature` with the signing secret inside. Without `RUN_KEY` nobody can make a bearer it accepts, so nobody can choose the secret it checks against, and the signature check isn't weakened.
    - So no Worker secret is set per run.
  - **The run showed:**
    - an offer with an input file going out signed;
    - the server downloading the file over `/a2a/files` with the agent's `/a2a` token, HTTP 200 with the same SHA-256;
    - `WORKING` read back as an acceptance and `COMPLETED` as a submission, both as the agent with origin `a2a_remote`;
    - a change request going out as a new A2A task naming the completed one in `referenceTaskIds`, which the server's note shows arrived in the first task's context. It was read back as a second submission, which the lead verified;
    - a task canceled while the remote worked staying canceled. `CancelTask` reaching the server isn't shown, since it keeps nothing.
- **Spike C's timing** on the deployment:
  - offered to the send reaching the server: 6.5 s, and between 6.0 and 11.4 s across the runs;
  - offered to accepted: 73 s, which is the first read at 1 minute;
  - accepted to submitted: 126 s, the second read at 2 minutes;
  - change request to resubmission: 198 s.

  Real egress to `workers.dev` works under `global_fetch_strictly_public`.
- **Spike C's failures.** Before relying on Podster's failure, the run asks the server directly, with that run's own signed request and bearer:
  - `/a2a/slow` answered HTTP 200 after 15.2 s. Podster's sends to it then failed 3 times in a row, and the endpoint switched off in 165 s with its task untouched. That counts as the 10 s timeout.
  - `/a2a/redirect` answered 302 to `http://169.254.169.254/latest/meta-data/`. Podster's sends to it failed 3 times, and it switched off in 137 s with its task untouched. That counts as the redirect not being followed.

  No session cookie, OAuth token, signing secret, key or sealed bearer was in the run's output: 17 values were checked.
- **After decision 174 was deployed,** with main at `5cffc42` on staging (API `f6033fe9`, gateway `c1303ad1`), the full round trip passed 26 of 26 again, in room `ws_0853e930af784a2f98b2e5968b9cebb1`.
  - The send reached the server in 1.0 s after the offer. The offer was accepted at 63 s and submitted 121 s after that, and the change request was resubmitted after 198 s.
  - So decision 174 changed nothing on the usual path. The test server reports `WORKING` first, so this run doesn't take decision 174's read-0 or held-submit paths. LangGraph covers those locally.
- **Earlier runs** were made before the review fixes. A first full run failed 4 of 20: the owner renamed the account's `workers.dev` subdomain from `agentlater` to `podster-dev` while it was going, so every send after the first offer failed DNS. With the new name, a full run passed 20 of 20, and a round-trip-only run passed 14 of 14.
- **LangGraph** ([decision 143](spec/PRODUCT.md#decisions-needed)) ran locally: `langgraph-api` 0.17.1 with [one trivial graph](../e2e/langgraph/README.md), against Podster's real send, read-back, accept, change-request and cancel code in workerd (`apps/api/test/a2a-langgraph.spec.ts`, through `e2e/run-langgraph-check.mjs`).
  - **The first run failed decision 143.** LangGraph's results didn't reach Podster:
    - its `SendMessage` ignores `returnImmediately` and answers once the run ends, already `TASK_STATE_COMPLETED`, with the reply as an artifact, and Podster kept only that answer's task ID and context;
    - its `GetTask` has no artifacts, only a fixed status message, with the reply in `history` unless `historyLength` is 0, which Podster sent.

    The lead ruled that both behaviors are allowed by the A2A spec, so Podster adapts, as [decision 174](spec/PRODUCT.md#decisions-needed).
  - **After decision 174, 4 of 4 pass, and the whole flow runs with LangGraph:**
    - its finished send answer is applied as read 0, and held under decision 112 with the graph's reply, since it never passed `WORKING`;
    - the agent's accept submits that reply as the agent, with origin `a2a_remote`;
    - the lead's change request goes into the same LangGraph thread as a new task, and its answer comes back as submission 2, which the lead verifies;
    - a task already finished at read 0 is sent no `CancelTask`.
- **The owner's approval for these runs,** typed in the lead session on 2026-11-10: "sure .. go ahead do whatever u need to do for to complete m3 as m4.. you got my approval". Also said in the lead session that day: "you are the architect and i need you to make appropriate decision on my behalf". In the M3 session the owner then allowed the installs its permission check had refused, answering "I've allowed them". Both ran locally on 2026-11-10.
- **fasta2a** ([decision 143](spec/PRODUCT.md#decisions-needed)'s backup independent server) ran locally: `fasta2a` 2.1.1 with uvicorn 0.38.0, on Python 3.12, with [one trivial agent](../e2e/fasta2a/server.py), against Podster's real send, read-back, change-request and cancel code in workerd (`apps/api/test/a2a-fasta2a.spec.ts`, through `e2e/run-fasta2a-check.mjs`). **3 of 3 passed**, and fasta2a's own log had no warning or error:
  - fasta2a takes the offer as a `SUBMITTED` task, and its task and context are recorded;
  - a read during the run sees `WORKING`, which accepts. A later one sees `COMPLETED` with the agent's text artifact, which submits, both marked `a2a_remote`. This is the usual path, not decision 174's;
  - the lead's change request goes into the same context as a new task, and comes back as submission 2, which the lead verifies;
  - a task canceled while fasta2a works is sent `CancelTask` once, recorded as sent.

  Its pins and wheel hashes are in [e2e/fasta2a/requirements.lock](../e2e/fasta2a/requirements.lock). `fasta2a` 2.1.1's wheel is `sha256:98931d24…` or `cec2b74a…`. A first version of the agent sent text parts with a `kind` key, which fasta2a 2.1.1's 1.0 output doesn't expect; with plain `text` parts, as its own worker builds them, it answers clean camelCase.
- **The compatibility kit** ([decision 142](spec/PRODUCT.md#decisions-needed)) ran locally: `a2aproject/a2a-tck` at `104a7b4ae0d83f65c075e3793e322953a830eaba`, over JSON-RPC, through `e2e/run-a2a-kit.mjs`. The kit's client sends no credentials, so a local proxy adds the agent's `/a2a` token and points the card at itself. **Final run, after this PR's fixes,** counted in the kit's requirements, one result each:
  - **MUST, 115 requirements:** 29 pass, 8 fail, 45 skipped, 26 not tested, and 7 marked for manual checking.
    - **Of the 29 passes, 26 test Podster:** `BIND-FIELD-001`, `CARD-DISC-001`, `CARD-PROTO-001`, `CARD-PROTO-002`, `CARD-STRUCT-001`, `CORE-CANCEL-003`, `CORE-CAP-001`, `CORE-CAP-002`, `CORE-CAP-003`, `CORE-ERR-001`, `CORE-ERR-002`, `CORE-GET-002`, `CORE-LIST-001` to `CORE-LIST-005`, `CORE-MULTI-004`, `JSONRPC-ERR-001`, `JSONRPC-ERR-002`, `JSONRPC-FMT-002`, `JSONRPC-SSE-002`, `JSONRPC-SVC-001`, `JSONRPC-SVC-002`, `VER-SERVER-002` and `VER-SERVER-003`.
    - **The other 3 test only the kit.** `HTTP_JSON-QP-001`, `HTTP_JSON-URL-001` and `HTTP_JSON-URL-002` check the kit's own HTTP+JSON constants, which its source calls client-side validation, and never call Podster, which doesn't serve HTTP+JSON.
    - **All 8 failures are decision 115's exception:** Podster never creates a task from a `SendMessage` with no task ID. They are `CORE-SEND-001`, `CORE-SEND-003`, `CORE-EXECUTION-MODE-001`, `CORE-EXECUTION-MODE-002`, `CORE-MULTI-001a`, `CORE-MULTI-002a`, `CORE-MULTI-003` and `JSONRPC-FMT-001`, each on the profile's exception list.
    - **The skips** are transports Podster doesn't serve (gRPC, HTTP+JSON), push, streaming and the extended card, all off in the profile, and checks whose setup needs decision 115's task creation. **The 26 not tested** are auth, binding-equivalence and serialization checks the kit didn't exercise over JSON-RPC here. **The 7 manual** are TLS, card signing and custom bindings.
  - **SHOULD, 14 requirements:** 3 pass, `CARD-CACHE-001`, `CARD-CACHE-002` (the ETag this PR adds) and `JSONRPC-ERR-003`. 1 fails, `DM-SERIAL-005`, which is decision 115 again, since its request has no task ID. 6 skipped, 2 not tested and 2 manual.
  - **MAY, 4 requirements:** `CORE-MULTI-001` and `002` fail, again decision 115, and 2 are skipped.

  In pytest's own count of test functions, a different unit, the run was 45 passed, 8 failed, 207 skipped and 3 expected failures. The kit's summary reads "MUST 46%" because it counts what didn't run.

  **The report** is committed as [e2e/kit-report-2026-11-10.json](../e2e/kit-report-2026-11-10.json), SHA-256 `2d6560d80410b28ee73c2663683f6237ccc428c5277ec5327ef8908ae103016c`. It's the kit's `compatibility.json` from the last local run, at 11:58 UTC, after decision 190's alias, with the proxy only adding the token. It holds requirement IDs, results and the local proxy's URL, and no room, agent or token. The kit's dependencies are pinned with hashes in [e2e/kit-requirements.lock](../e2e/kit-requirements.lock), exported from its own `uv.lock` (SHA-256 `bdcbbf44…`). The run's venv had the same versions, installed by version: `markupsafe` and `anyio` failed on Python 3.15.0a7, so it ran on 3.13.3.
- **What the kit found, and this PR fixes:**
  - **`CORE-CAP-003`, a MUST:** `GetExtendedAgentCard` answered `ExtendedAgentCardNotConfiguredError`, -32007. The card declares no extended card, so spec 3.3.4 calls for `UnsupportedOperationError`, -32004. Fixed in the gateway's handler, and the profile's operations row says so.
  - **`JSONRPC-SSE-002`, a MUST:** a request with the wrong `Content-Type` got Podster's REST-style 415 body, whose error code is a string. It's still 415, now as a JSON-RPC `ContentTypeNotSupportedError`, -32005, with a null id.
  - **`CARD-CACHE-002`, a SHOULD:** the card had no ETag. It now has a strong one from its own bytes, and `If-None-Match` gets 304.
- **What the kit found, and the architect ruled:** the kit's client joins the card's interface URL with `/`, so it posts to `/a2a/`, which answered a REST-style 404 and failed 14 more checks. [Decision 190](spec/PRODUCT.md#decisions-needed) serves `/a2a/` exactly as `/a2a`, as an alias for that one path. The final run went through the proxy with no path mapping and gave the same results.
- **Accepted, from the review of #240:**
  - `/a2a/.` and `/a2a/%2e` also reach `/a2a`, because the URL parser normalizes them to `/a2a/` before the alias sees them. They get exactly `/a2a`'s checks, like the alias itself.
  - The repository's own vitest runs, which the LangGraph and fasta2a runners start, inherit the full environment, since they run only this repository's tests. Only the third-party programs get the allow-listed one.
- **How the kit ran, and what's not like its own setup:**
  - its `pyproject.toml` requires Python 3.15, and the newest 3.15 available here, 3.15.0a7, couldn't run it: `markupsafe`'s binary failed to load, and `anyio` then needed a `sentinel` builtin that alpha 7 lacks. So it ran on Python 3.13.3, with the exact versions its `uv.lock` pins and its code unchanged;
  - **it ran on staging on 2026-11-10, after #240 merged as `a1ee59e` and was deployed** (API `dca920a6`, gateway `417586cb`). Command: `PODSTER_E2E_SIGNUP_SECRET="$(cat ~/.podster/e2e-signup-secret.staging)" node e2e/run-a2a-kit.mjs --staging --kit <checkout>`. The secret went only to Podster's own script, and the kit's process had the allow-listed environment. **The result is the same as locally, requirement for requirement:**
    - **MUST, 115:** 29 pass, of which 26 test Podster and 3 are the kit's own HTTP+JSON constant checks. 8 fail, all decision 115: `CORE-SEND-001`, `CORE-SEND-003`, `CORE-EXECUTION-MODE-001`, `CORE-EXECUTION-MODE-002`, `CORE-MULTI-001a`, `CORE-MULTI-002a`, `CORE-MULTI-003` and `JSONRPC-FMT-001`. 45 skipped, 26 not tested and 7 manual, for the reasons above.
    - **SHOULD, 14:** 3 pass, including `CARD-CACHE-002`. 1 fails, `DM-SERIAL-005`, which is decision 115.
    - **MAY, 4:** `CORE-MULTI-001` and `002` fail, which is decision 115. 2 are skipped.
    - **In pytest's count:** 45 passed, 8 failed, 207 skipped and 3 expected failures.
  - **What ties this run to staging.** The report's `sut_url`, `http://127.0.0.1:23761`, is the runner's own local proxy, which forwards to `https://gateway-staging.podster.dev` with the agent's token. The run's room and agents were made on staging through its test sign-up. The probes the same minute saw the card staging serves, with `ETag: W/"d7b31fd6ef7f2358"`, from API `dca920a6` and gateway `417586cb`.
  - **Staging's test sign-up** was turned on by the owner, who set a fresh `E2E_SIGNUP_SECRET` on 2026-11-10, and **it is still on**. Turning it off is the owner's `wrangler secret delete E2E_SIGNUP_SECRET --env staging`.
  - **The staging report** is committed as [e2e/kit-report-staging-2026-11-10.json](../e2e/kit-report-staging-2026-11-10.json), SHA-256 `3bb1f0ba5c2fc23e8149982ed6ed667f9eb9cc35a3d63de083ed58b75a50214a`, from 12:41 UTC. It holds no room, agent or token.
  - **It took 1 test sign-up.** The `finally` disconnected both of the run's agents and signed the person out. Read-only queries of staging's gateway database afterwards found both agents revoked and no live session made since 12:40 UTC. Its room, `ws_cfa9926e5437477b8f3df50bcbf5b0bf`, stays with 3 tasks, since staging has no delete route.
  - **Signed-out probes of the deployment:**
    - `POST /a2a` and `POST /a2a/` with no credential gave the identical 401, with the same `WWW-Authenticate`, and `/a2a/x` gave 404.
    - The card came with `ETag: W/"d7b31fd6ef7f2358"`, weakened by Cloudflare's compression, and sending that back got 304 with no body.
    - A wrong `Content-Type` got 415 with a JSON-RPC -32005 body.

**The staging run.** The lead ran `e2e/a2a-staging.mjs` (at `097fb21`) against staging at main `0794706` on 2026-11-09. It passed 59, failed 0 and skipped 0, in room `ws_234f0ec64e074e00b8daa716e8f68b15`. The deployed versions were API `88c50951`, gateway `f19887bc` and web `4fdfed72`. The run includes the unreachable endpoint's switch-off and a real ready-file download over `/a2a/files` with the `/a2a` token. M2's staging check passed 51, failed 0 and skipped 4 on the same deploy.

### Protocol gates

| Gate item | How it's verified | Status |
| --- | --- | --- |
| The profile is published | [A2A-PROFILE.md](spec/A2A-PROFILE.md), with the operations, the lifecycle extension, files and the kit's exceptions | Published in the repository. The kit ran locally on 2026-11-10, and its exception list is now from that run |
| Inbound interoperability, implementation 1: the A2A project's JavaScript client | `e2e/a2a-staging.mjs`, through `@a2a-js/sdk` 1.3.0: discovery, OAuth to `/a2a`, `GetTask`, `ListTasks` with paging, `SendMessage` with a retry, the lifecycle extension, and the refusals | Passed locally. Passed on staging, 2026-11-09 at `0794706` |
| Inbound interoperability, implementation 2: the Python client and the kit's client ([decision 143](spec/PRODUCT.md#decisions-needed)) | The A2A compatibility kit ([decision 142](spec/PRODUCT.md#decisions-needed)), through `e2e/run-a2a-kit.mjs` | **Ran locally, 2026-11-10:** every MUST that ran passes, except the 8 that decision 115 excepts, each listed in the profile. Three gaps it found are fixed in #240. **Ran on staging, 2026-11-10, after #240's deploy, with the same result.** That is the kit's client. **The Python client: ran locally only; accepted by the owner on 2026-11-11.** Its only run is Spike A's, against the spike's code |
| Outbound interoperability, with an independent server | LangGraph's `langgraph-api` 0.17.1 ([decision 143](spec/PRODUCT.md#decisions-needed)), through `e2e/run-langgraph-check.mjs` | **Met locally, 2026-11-09, with decision 174:** offer, held reply, the agent's accept submitting it, a change request in the same thread as submission 2, and the lead's verify. LangGraph never reports `WORKING`, so each completion is held until the agent accepts. The remaining gap is below. **Backup, fasta2a 2.1.1: passed locally, 2026-11-10, 3 of 3,** on the usual path: `WORKING` accepts, `COMPLETED` submits, a change request comes back as submission 2, and `CancelTask` goes out once. **Outbound to LangGraph: ran locally only; accepted by the owner on 2026-11-11. fasta2a: ran locally only; accepted by the owner on 2026-11-11** |
| Outbound behavior without an outside server | `e2e/a2a-staging.mjs`, unreachable endpoint: an offer to an endpoint that doesn't resolve fails, is retried as the same message, and switches the endpoint off after 3 failures, with the task untouched and the admin's read off. `apps/api/test/a2a-outbound.spec.ts` and `a2a-readback.spec.ts` cover the rest against a scripted endpoint | Passed locally. Passed on staging, 2026-11-09 at `0794706` |
| AC-12: forged, expired or wrong-audience credentials are refused, as on other paths | `apps/gateway/test/oauth-split.spec.ts` (an `/mcp` token at `/a2a` and the reverse), `a2a-files.spec.ts` (only `/a2a` tokens at `/a2a/files`, and `/v1/files` still refuses them), and the assertion tests M0 already passed. `e2e/a2a-staging.mjs` checks an `/a2a` token is refused at `/mcp`, and the `/a2a/files` audience both ways | Passed locally. Passed on staging, 2026-11-09 at `0794706` |
| AC-18: A2A instructions to elevate access stay data | `a2a-messages.spec.ts` (a message's own fields and text never move the task), `a2a-readback.spec.ts` (remote text is posted as a message, a remote `AUTH_REQUIRED` grants nothing, and artifact text becomes a note, never a command) | Passed locally |
| AC-24: a remote completion records a submission only, or is held before acceptance, and grants nothing | `a2a-readback.spec.ts`: `WORKING` then `COMPLETED` gives accept then submit, never verify. `COMPLETED` at once is held, and the requester is told. A refused submission is held. Events are marked `a2a_remote` | Passed locally. Passed on staging, 2026-11-09, by the round trip: accept then submit as the agent, origin `a2a_remote`, never verify |
| Expanded criterion 4: one task history across protocols, and duplicates create no competing tasks | `a2a-messages.spec.ts` (a retried `messageId` posts once), `a2a-lifecycle.spec.ts` (a retried `requestId` acts once), `a2a-outbound.spec.ts` (a redelivered send sends nothing, and a recorded answer is never sent again), `a2a-readback.spec.ts` (a stale or redelivered read number does nothing). MCP and A2A act on the same task and history | Passed locally. Passed on staging, 2026-11-09 at `0794706`, for the inbound retries (`messageId` and `requestId`) |

### Behavior M3 adds, by step

| Item | How it's verified | Status |
| --- | --- | --- |
| Endpoint registration with a sealed token (step 11) | `a2a-endpoint.spec.ts`, and `e2e/a2a-staging.mjs` "Endpoint": set, read, rotate, the admin's read, delete and disconnect, with no token or secret in any output | Passed locally. Passed on staging, 2026-11-09 at `0794706` |
| Offers out, from the outbox through the queue, with the send-time rechecks (step 12) | `a2a-outbound.spec.ts`: IDs-only jobs, `returnImmediately`, the signature and token, the answer recorded first, retries as the same message, switching off after 3 failures, the setter's departure, and the dead-letter queue | Passed locally. Passed on staging, 2026-11-09 at `0794706`, for the failure half: an unreachable endpoint fails, retries and switches off. Passed on staging, 2026-11-09, for the success half, and for a timeout and a refused redirect, by the round trip |
| Reading back by `GetTask`, and cancel out (step 13) | `a2a-readback.spec.ts`: the backoff, the 7 days, the caps refused whole, the archive guard, origin on messages and events, and `CancelTask` once | Passed locally. Passed on staging, 2026-11-09, for reading back: `WORKING` and `COMPLETED`, with origin on events. **`CancelTask` delivery isn't shown on a deployment:** the test server keeps nothing, so the run only shows Podster's task staying canceled. `a2a-readback.spec.ts` covers delivery locally. **`CancelTask` delivery: ran locally only; accepted by the owner on 2026-11-11** |
| Change requests out (step 13b) | `a2a-readback.spec.ts`: `referenceTaskIds` and `contextId` from Podster's own stored rows, and superseded by new work | Passed locally. Passed on staging, 2026-11-09, by the round trip |
| Files (step 14, and `/a2a/files`) | `a2a-lifecycle.spec.ts` (`SubmitTask.files`), `a2a-messages.spec.ts` (URL parts as links), `a2a-outbound.spec.ts` (an offer's file links), `a2a-files.spec.ts` (the route's audience), and `e2e/a2a-staging.mjs` (a ready file downloads at `/a2a/files` with the `/a2a` token only) | Passed locally, without the download, which needs a scanner. Passed on staging, 2026-11-09 at `0794706`, with a real ready file |
| Screens (step 15) | `apps/web` tests: the Agent Sheet's endpoint section, and origin labels on the Task Sheet. `run-a11y.mjs` | Passed locally |

## Owed before M3's gate

**2026-11-11: the gate is met.** The owner called it, accepting local runs for the four items this section lists as owed on staging ([decision 193](spec/PRODUCT.md#decisions-needed), and [the gate call](#m3s-gate-checklist) above). This section is kept as it stood on 2026-11-10, with dated notes where the call answers it.

- **Who calls the gate.** On 2026-11-10, in the lead session, the owner said "sure .. go ahead do whatever u need to do for to complete m3 as m4.. you got my approval". [Decision 132](spec/PRODUCT.md#decisions-needed) stands: the owner calls M3's gate. The architect hasn't called it, and puts the open items below to the owner. **2026-11-11:** the owner called it met, saying "M3 gate: local runs are enough for LangGraph, fasta2a, cancel-task delivery and the Python client. Gate met."
- **The two MUST gaps from the kit's untested checks are closed** (`VER-SERVER-001` and `VER-CLIENT-002`). [Decision 192](spec/PRODUCT.md#decisions-needed) and [#247](https://github.com/thachp/podster/pull/247), merged as `4769455`, serve `A2A-Version: 1.0.1` as `1.0`. It was deployed to staging as gateway `427510d8`. Signed out, `1.0.1` got the same 401 and body as `1.0`, and `1.1` and `2.0` were refused as before. [#250](https://github.com/thachp/podster/pull/250) adds more refusal tests.
- **Merged for the gate:**
  - [#240](https://github.com/thachp/podster/pull/240): the kit, fasta2a and the kit's fixes;
  - [#246](https://github.com/thachp/podster/pull/246), as `7f1e59d`: tests for the kit's untested checks;
  - [#247](https://github.com/thachp/podster/pull/247), as `4769455`: decision 192.

  Also merged: [#248](https://github.com/thachp/podster/pull/248), as `37c3d9e`, the AC-18 and screens harness; and [#250](https://github.com/thachp/podster/pull/250), as `47db019`, more version-refusal tests.
- **Every gate item, where it ran and its evidence,** since decision 132 names the staging run:

  | Gate item | Locally | On staging |
  | --- | --- | --- |
  | The profile is published, with the kit's exceptions | `docs/spec/A2A-PROFILE.md` | Not applicable |
  | Inbound: the A2A project's JavaScript client | `run-a2a-staging.mjs`, 53 passed, 0 failed, 1 skipped | `a2a-staging.mjs`, 59 of 59 at `0794706` |
  | Inbound: the compatibility kit's client | The kit: 29 MUST pass, of which 26 test Podster and 3 only the kit's own constants. 8 decision-115 failures, and the rest listed exceptions. **Podster's own tests evidence the 16 MUST checks the kit didn't test** (see the profile) | **The kit's run only:** the same result for each requirement it tested, after #240's deploy. Report SHA-256 `3bb1f0ba…`. Of the 16 it didn't test, only the two version checks have staging evidence, from signed-out probes of gateway `427510d8`. The other 14 rest on local tests |
  | Inbound: the A2A project's Python client | Spike A only | **Owed to the owner:** the install was refused (below). **2026-11-11: ran locally only; accepted by the owner on 2026-11-11.** It didn't run on staging |
  | Outbound, independent: LangGraph, and fasta2a as backup | LangGraph 4 of 4 with decision 174, and fasta2a 3 of 3 | **Owed to the owner:** needs a server staging can reach (below). Staging's outbound ran against Podster's own test server. **2026-11-11, LangGraph: ran locally only; accepted by the owner on 2026-11-11. fasta2a: ran locally only; accepted by the owner on 2026-11-11.** Neither ran from staging |
  | Outbound behavior: offers, read-back, files, change requests, Spike C | The API specs | `a2a-roundtrip.mjs`, 26 of 26 after #194's review fixes, and 26 of 26 again after decision 174's deploy |
  | AC-12: refused credentials | Gateway specs | `a2a-staging.mjs` at `0794706`, and the signed-out probes of `/a2a` and `/a2a/` on 2026-11-10 |
  | AC-18: instructions stay data | `a2a-messages.spec.ts`, `a2a-readback.spec.ts` | `a2a-roundtrip.mjs --only ac18`, **16 of 16** on 2026-11-10, in room `ws_b8825bdd2eeb46a5afc8fcb69d891e03` |
  | AC-24: a remote completion only submits or holds | `a2a-readback.spec.ts` | The round trip: accept then submit as the agent, never verify |
  | Criterion 4: one history, no duplicates | The specs | The inbound retries in `a2a-staging.mjs` |
  | Step 11: endpoint registration | `a2a-endpoint.spec.ts` | `a2a-staging.mjs` |
  | Step 12: offers out | `a2a-outbound.spec.ts` | The round trip, and the unreachable endpoint's switch-off |
  | Step 13: read-back and cancel | `a2a-readback.spec.ts` | Read-back by the round trip. **`CancelTask` delivery is owed to the owner** (below). **2026-11-11: ran locally only; accepted by the owner on 2026-11-11.** Delivery isn't shown on staging |
  | Step 13b: change requests | `a2a-readback.spec.ts` | The round trip, in the first task's context |
  | Step 14: files | The specs | A ready file over `/a2a/files` in both runs |
  | Step 15: screens | `apps/web` tests, `run-a11y.mjs` | `a2a-roundtrip.mjs --only screens`, **15 of 15** on 2026-11-10, in room `ws_990b5bf2d5d748d0a22de9cd3a8fa633`, details below |
  | Decision 192: patch versions | `a2a.spec.ts` | Gateway `427510d8`: `1.0.1` is served like `1.0`, and `1.1` and `2.0` are refused as before |

  **Step 15's screens on staging** ran at `#248`'s `1f0c608`, with one test sign-up, in Chromium, as the test person.
  - **The Agent Sheet** showed the endpoint section with its host, the token as stored without showing it, and the Change, New signing secret and Remove buttons. No token, secret or bearer was in the page, and axe found nothing beyond `a11y-known.json`.
  - **The Task Sheet's Activity tab** marked the accept and the submission "through its A2A endpoint", 2 labels, and axe found nothing beyond the known list.
  - **The two earlier attempts** failed in the harness, not the app: first a network-idle wait, then a closed Activity tab. Both were fixed and proven locally first.
  - **Clean-up:** the endpoints were deleted, the agents disconnected and the person signed out, and no secret was in the output.

  **What each staging run leaves behind:** its room and the room's tasks, since staging has no delete route, and its test person, signed out. Its agents are disconnected and their endpoints deleted. `a2a-roundtrip.mjs` prints the room it leaves.
- **Owed to the owner, with options and costs.** **2026-11-11:** the owner accepted the local runs for the first three, so none of these options was taken, and no resource was created:
  - **Outbound to LangGraph or fasta2a from staging.** It needs a server staging can reach, a public `https` name, as egress policy requires. Both servers run only on this machine, and the existing test Worker is JavaScript while both are Python. Each way is a cloud resource or an outside service:
    - a tunnel to this machine, which is free, but is an outside service and exposes the machine while it runs;
    - a short-lived Cloudflare Container or small VM running LangGraph, a few cents for an hour's run and deleted after;
    - a new Python Worker running fasta2a, which is free, but its in-memory store doesn't fit stateless isolates, so it may be flaky.
  - **`CancelTask` delivery on staging.** The test Worker keeps nothing, so delivery can't be seen from outside. Either:
    - give the Worker a KV namespace, a new resource, free at this volume;
    - or have Podster show a cancel's delivery, as `cancel_state` on the task's read, which is product code and needs its own decision.
  - **The Python client on staging.** This session's permission check refused installing `a2a-sdk==1.3.0`, Spike A's pin, with hashes, as "Code from External". Allowing that install in this session costs nothing and takes one test sign-up to run. The refused command, in the session's scratchpad: `uv pip compile --python-version 3.12 --generate-hashes` of `a2a-sdk==1.3.0` and `httpx`, then `uv venv --python 3.12 .venv` and `uv pip install --require-hashes -r requirements.lock`.
  - **Recorded, not gating:** `AUTH-SERVER-001` (SHOULD) has no test, since it rests on the Workers runtime's `fetch`. Whether staging refuses TLS 1.1 can't be tested from this client, and Cloudflare sets it.
- **The question for the owner:** M3's gate has these items open:
  - outbound against LangGraph or fasta2a from staging;
  - `CancelTask` delivery on staging;
  - the Python SDK client on staging.

  What ran on staging:
  - **The kit.** Of its 115 MUST checks, 29 passed, of which 26 test Podster and 3 only the kit's own constants. 8 failed, all from decision 115: Podster doesn't create tasks over A2A. The rest are listed exceptions in the profile. The 16 MUST checks the kit didn't test are evidenced by Podster's own tests, locally, and the two version checks also by staging probes.
  - **The rest passed:** the round trip, AC-18, Spike C, the screens and decision 192.

  LangGraph and fasta2a passed locally. Either approve a short-lived server so outbound can run against LangGraph from staging, or rule that the local LangGraph and fasta2a runs plus staging's test-server run are enough. Also say whether `CancelTask` delivery must be shown on staging, and if so by which option, and whether to allow the Python client's install in the M3 session.

  **The owner's answer, 2026-11-11:** "M3 gate: local runs are enough for LangGraph, fasta2a, cancel-task delivery and the Python client. Gate met." **The architect's reading, not the owner's words:** the local runs are enough, so `CancelTask` delivery needn't be shown on staging, and the Python client's install isn't needed for the gate. That install was not run.
- **Owed to the owner: the test A2A server.** The architect ruled it stays deployed. It costs nothing to keep, since it's one Worker with no storage that refuses anything not sealed under `RUN_KEY`, and it lets the round trip run again with no new secrets. Deleting it, `wrangler delete podster-a2a-test-staging`, which also removes `RUN_KEY`, is a cloud change and the owner's call. **2026-11-11:** still deployed after the gate call.

**Ruled, 2026-11-10:**
- **Who accepts for an agent that only has an endpoint,** [decision 191](spec/PRODUCT.md#decisions-needed). Its operator runs an MCP or A2A client as the agent to accept, and the accept submits the held response under decision 174. M3 adds no new authority path. An organization admin accepting for the agent may come later, with its own design and a security review.

## Owed before production that M3 touches

- **Two real people and their own sign-ins.** Done: the [two-person kernel journey](m0-gate.md) passed on staging on 2026-11-09 at 1d28ee2, with two real people, 52 passed, 0 failed, 0 gaps. #178 records it. M3's agents from other organizations still need their cross-organization checks run the same way.
- **A forged `cf-connecting-ip`.** It's still open on the [M2 plan](m2-plan.md#checks-the-spike-left-open). A2A's rate limits are per client, as MCP's are, so they rest on it too.
- **Key rotation.** Agent keys can't be rotated yet. Rotating an endpoint's stored token (question 16) needs its own path before production.
- **Guest uploads.** [Decision 96](spec/PRODUCT.md#decisions-needed) counts external agents' submission files toward the room's quota during private pilots, and is revisited before public rooms. M3's remote agents are the main case.
- **Monitoring.** The [alerts](spec/ARCHITECTURE.md) cover the outbox and wake. A2A's queue depth, send failures and refusals need the same before production.

## What the published spec says

Read against the source at tag `v1.0.1`. On 2026-11-08 UTC, v1.0.1 was still the latest GitHub release.

**The version.** The latest GitHub release is v1.0.1, from 2026-05-28. The spec page and that tag's text still label the latest version 1.0.0. Version negotiation uses `Major.Minor`, so both are `1.0`.

| Spec rule | Section | What it means here |
| --- | --- | --- |
| Three standard bindings: JSON-RPC, gRPC and HTTP+JSON. A server declares what it supports, and all it declares must behave the same. I found no rule requiring any one of them | 5.1, 5.2, 8.3 | One binding is enough to start |
| HTTP+JSON's error format disagrees within the spec: `google.rpc.Status` in 11.6, and `application/problem+json` in the 6.4 example | 6.4, 11.6 | Another reason to start with JSON-RPC |
| A missing version is read as 0.3, and an unsupported one gets `VersionNotSupportedError` | 3.6.2 | A client that sends no header is refused if only 1.0 is supported |
| Streaming, push and the extended card are declared capabilities. If off, the operation returns a named error | 3.3.4 | All three can be off at first |
| A terminal task (`COMPLETED`, `FAILED`, `CANCELED`, `REJECTED`) takes no more messages | 3.1.1 | `request_changes` can't reuse a completed remote task |
| `SendMessage` blocks by default, unless `return_immediately` is set | 3.2.2 | Outbound sends must set it, because a queue consumer can't wait |
| Send may be idempotent through `messageId`, and isn't required to be | 3.3.1 | Podster can't rely on a remote agent to remove duplicates |
| Every request is authenticated and authorized, before anything that could reveal a resource exists. `ListTasks` is scoped to the caller | 7.4, 13.1 | Same refusals as today's reads |
| `TASK_STATE_AUTH_REQUIRED` authorizes nothing by itself | 7.6.4 | Matches the proposed table |
| Webhook URLs should be checked for SSRF, retries are expected, and duplicates may arrive | 13.2 | The spec only says SHOULD, so Podster's egress policy decides |
| File references must be validated against SSRF | 14.1 | Podster shouldn't fetch a remote agent's URL |

There's also a [compatibility kit](https://github.com/a2aproject/a2a-tck) covering all three bindings, where MUST failures are hard failures and SHOULD failures are expected ones. The project lists SDKs for Python, Go, Java, JavaScript, .NET and Rust.

## Risks to test

- **Authority:** an Agent Card, message, artifact label or remote state never grants anything or moves `verify`.
- **Self-review:** a remote agent can't approve its own work through any mapping.
- **Probing:** a task someone can't see gets the same `TaskNotFoundError` as one that doesn't exist, and `ListTasks` can't be widened by a `contextId`.
- **Audience:** a token for MCP or for one service isn't accepted for another (AC-12).
- **Duplicates:** the same `messageId` or a retried outbox send makes no competing task or second submission.
- **Out of order:** a late remote update arrives after a decline, cancel, revocation or reassignment, and changes nothing.
- **Reaching out:** SSRF through a registered endpoint, a redirect or a file reference.
- **Credentials:** an endpoint's credential never reaches logs, events or a read. Revoking an agent stops its deliveries.
- **Content leaving Podster:** an offer's text is read at send time, so access removed while it was queued stops the send, and the queue never holds content.
- **Remote completion before acceptance:** it's held and flagged, not treated as acceptance.
- **Terminal tasks:** a change request after `COMPLETED` makes a linked new A2A task without losing the history.
- **Slow or dead agents:** Podster never waits on one, polling ends, and an offer can move to someone else.
- **Hostile content:** size limits on messages and parts, inert rendering, and `external` marking.
- **Logs:** IDs only, with no message bodies, URIs or tokens.
- **Rooms:** an agent in two rooms can't move anything between them through a shared `contextId`.

## How far this was checked

- **Read directly:** `v1.0.1`'s `docs/specification.md` for the rows above, the task states in `specification/a2a.proto`, and the gateway's MCP and Agent Auth paths, which question 5 and spike B build on.
- **Not read closely:** the rest of the spec, the kit beyond its README, and the SDKs.
- **Run:** the three local spikes above, and, at M3's gate, LangGraph, fasta2a and the kit, as recorded under M3's gate checklist.
- **Not checked:** whether the differences between v1.0.0 and v1.0.1 matter, beyond the release notes.
