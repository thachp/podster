# M3 plan

The owner accepted all 28 questions below on 2026-11-08, as [decisions 107 to 134](spec/PRODUCT.md#decisions-needed). The owner accepted [ADR 0007](adr/0007-a2a.md) on 2026-11-08, which covers the engineering details in the build order. The order of the steps is still **Proposed**, and so are ADR 0007's [details to settle in review](adr/0007-a2a.md#proposed-details-to-settle-in-review). It covers [M3 A2A](spec/PRODUCT.md#product-direction-and-delivery-scope) and starts from the [proposed A2A adapter](spec/ARCHITECTURE.md#a2a-adapter). No A2A code exists.

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
  - **Not run:** an independent server. Starting LangGraph's was refused by the permission check. The staging half waits for the owner's yes.

## Build order

C changes `packages/contracts` and M adds a migration or room schema. The order is **Proposed**. What each step does follows the accepted ADR 0007. Product code, steps 5 onward, waits until M2 is finished as [decision 133](spec/PRODUCT.md#decisions-needed) defines it. C and M PRs merge one at a time, after M2's last one, and take turns with planning's as [decision 60](spec/PRODUCT.md#decisions-needed) does for M2.

| Step | Work | C | M | After | Runs beside |
| --- | --- | --- | --- | --- | --- |
| 0 | ADR 0007 draft: the profile, from the owner's rulings | | | Rulings. **Done** ([#145](https://github.com/thachp/podster/pull/145)) | 1, 2, 3 |
| 1 | Spike A | | | Questions 1, 2, 3, 18 and 22. **Done**, without the kit ([#138](https://github.com/thachp/podster/pull/138)) | 0, 2, 3 |
| 2 | Spike B | | | Questions 1 and 5. **Done** ([#139](https://github.com/thachp/podster/pull/139)) | 0, 1, 3 |
| 3 | Spike C | | | Questions 1, 16 and 20. **Local half done** ([#140](https://github.com/thachp/podster/pull/140)). The staging half waits for the owner's yes | 0, 1, 2 |
| 4 | ADR 0007 with spike results, accepted by the owner | | | 0 to 3. **Done:** accepted on 2026-11-08 | |
| 5 | Pure mapping in `crates/core/src/a2a.rs`, with one line in `lib.rs`: a remote state plus the current Podster state gives one command, a hold or nothing. Tests include late and out-of-order updates | | | 4, M2 finished | 6 |
| 6 | Gateway module `apps/gateway/src/a2a/`: Agent Card, JSON-RPC envelope, version check, and every operation answering its named "not supported" error. The profile is `docs/spec/A2A-PROFILE.md`, and a gateway test checks the card lists only the operations it names. `check.mjs` covers only `openapi.yaml` and `capabilities.yaml`, so nothing here changes `packages/contracts` | | | 4, M2 finished. **Done** ([#155](https://github.com/thachp/podster/pull/155)) | 5 |
| 7 | Authentication, as its own PR with [decision 127](spec/PRODUCT.md#decisions-needed)'s deeper pass:<br>• Move the gateway from the combined `OAuthProvider` to one `OAuthAuthorizationServer` with two `OAuthResourceServer`s, `/mcp` and `/a2a`, still in one Worker. The combined provider has one resource, so it can't give `/a2a` its own audience.<br>• Set `defaultResource` and `legacyGrantResource` to `/mcp`, so clients that send no `resource`, and old grants, stay MCP.<br>• Change the consent code to grant `a2a` for an `/a2a` request. Today it refuses every scope but `mcp` and `offline_access`.<br>• Use `getOAuthApi(env)` where the gateway uses `env.OAUTH_PROVIDER`, and keep `forMcp` MCP-only.<br>• Tokens resolve to the same agent identity. Add AC-12's negatives. | Only if the API's identity call changes | | 6. **Done** ([#157](https://github.com/thachp/podster/pull/157)) | |
| 8 | Inbound reads: `GetTask` and `ListTasks` through `get_task` and `list_tasks`. A hidden task gets the same `TaskNotFoundError` as a missing one | | | 7. **Done** ([#165](https://github.com/thachp/podster/pull/165)) | 11 |
| 9 | Inbound messages: `SendMessage` with a `taskId` becomes `send_message`, with `messageId` as the idempotency key, size limits and `external` marking. No `taskId` is refused | Yes | Only if `messageId` can't use the idempotency record | 8. **Done** ([#167](https://github.com/thachp/podster/pull/167)) | 11 |
| 10 | Inbound lifecycle through the Podster extension: accept, decline, release, and submit with text and links | Yes | | 9 | 11 |
| 11 | Endpoint registration on the `Principal`: set, delete and status, checked against the egress policy, with the credential from question 16 | Yes | Yes | 7 | 8, 9, 10 |
| 12 | Outbound offers: outbox, queue, `SendMessage` with `return_immediately`, the stored mapping of one A2A task per offer attempt, retries with the same `messageId`, and switching off after repeated failures | | Yes | 5, 11 | Built on `claude/m3-step12-outbound`. The queues exist. Not yet run on staging, and the LangGraph run is still owed |
| 13 | Remote updates, as question 11 decides: read back, mapped through step 5 into a submission, a held response, a release or nothing. `cancel_task` sent out | Yes | Yes | 12 | Built on `claude/m3-step13-readback`, waiting for #173. Not run on staging |
| 13b | `request_changes` on a completed remote task, sent out as a new A2A task with `referenceTaskIds` and the same `contextId` ([decision 114](spec/PRODUCT.md#decisions-needed)). Split from 13 on 2026-11-08, because it's a second send path | Yes | Yes | 13 | |
| 14 | Files: inbound submissions with files from `create_upload`, offers that link input files as Podster links, and remote file references kept as external links | Yes | | 10, 13, M2 steps 5 and 6 | Built on `claude/m3-step14-files`, with no contract or migration change |
| 15 | Screens: endpoint status on the agent's Sheet, and held responses flagged to the requester in the Task Sheet | | | 11, 13, M2 step 9b | 14 |
| 16 | Staging run: AC-12, AC-18, AC-24, criterion 4 across protocols, and the implementations [decision 143](spec/PRODUCT.md#decisions-needed) names. The kit runs only if a way to run it has been found ([decision 142](spec/PRODUCT.md#decisions-needed)). Its non-fitting checks are listed in the profile ([decision 141](spec/PRODUCT.md#decisions-needed)). Then the owner rules, and the profile is published | | | All, M2's gate | |

**What runs in parallel:** the three spikes and the ADR draft. Steps 5 and 6. Step 11 is built beside 8 to 10, because it's in the `Principal` and they're in the `Workspace` path. Steps 9 to 11 change contracts and 11 adds a migration, so they're built side by side and still merge one at a time. Steps 14 and 15, which are in different folders.

**Steps that still need the owner's yes in that session:**

- **Spike C on staging,** by [decision 126](spec/PRODUCT.md#decisions-needed). Until then it runs locally only.
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
- **On staging:** the staging check passed against `gateway-staging.podster.dev`. The lead records each run here, with the commit.
- **Owed:** nothing yet proves it.

Last updated 2026-11-09 UTC, with every M3 build step merged or merging: 1 to 15, 13b, and `/a2a/files`.

### Protocol gates

| Gate item | How it's verified | Status |
| --- | --- | --- |
| The profile is published | [A2A-PROFILE.md](spec/A2A-PROFILE.md), with the operations, the lifecycle extension, files and the kit's exceptions | Published in the repository. The kit's exception list waits on the kit run |
| Inbound interoperability, implementation 1: the A2A project's JavaScript client | `e2e/a2a-staging.mjs`, through `@a2a-js/sdk` 1.3.0: discovery, OAuth to `/a2a`, `GetTask`, `ListTasks` with paging, `SendMessage` with a retry, the lifecycle extension, and the refusals | Passed locally. On staging: for the lead to record |
| Inbound interoperability, implementation 2: the Python client and the kit's client ([decision 143](spec/PRODUCT.md#decisions-needed)) | The A2A compatibility kit ([decision 142](spec/PRODUCT.md#decisions-needed)) | **Owed.** It hasn't run, because the session permission check refuses running the kit's code |
| Outbound interoperability, with an independent server | LangGraph's `langgraph-api`, with fasta2a as backup ([decision 143](spec/PRODUCT.md#decisions-needed)), receiving an offer and reporting `WORKING` and `COMPLETED` | **Owed.** Starting it was refused by the permission check. See the round trip below |
| Outbound behavior without an outside server | `e2e/a2a-staging.mjs`, unreachable endpoint: an offer to an endpoint that doesn't resolve fails, is retried as the same message, and switches the endpoint off after 3 failures, with the task untouched and the admin's read off. `apps/api/test/a2a-outbound.spec.ts` and `a2a-readback.spec.ts` cover the rest against a scripted endpoint | Passed locally. On staging: for the lead to record |
| AC-12: forged, expired or wrong-audience credentials are refused, as on other paths | `apps/gateway/test/oauth-split.spec.ts` (an `/mcp` token at `/a2a` and the reverse), `a2a-files.spec.ts` (only `/a2a` tokens at `/a2a/files`, and `/v1/files` still refuses them), and the assertion tests M0 already passed. `e2e/a2a-staging.mjs` checks an `/a2a` token is refused at `/mcp`, and the `/a2a/files` audience both ways | Passed locally. On staging: for the lead to record |
| AC-18: A2A instructions to elevate access stay data | `a2a-messages.spec.ts` (a message's own fields and text never move the task), `a2a-readback.spec.ts` (remote text is posted as a message, a remote `AUTH_REQUIRED` grants nothing, and artifact text becomes a note, never a command) | Passed locally |
| AC-24: a remote completion records a submission only, or is held before acceptance, and grants nothing | `a2a-readback.spec.ts`: `WORKING` then `COMPLETED` gives accept then submit, never verify. `COMPLETED` at once is held, and the requester is told. A refused submission is held. Events are marked `a2a_remote` | Passed locally. **On a deployment: owed**, with the round trip |
| Expanded criterion 4: one task history across protocols, and duplicates create no competing tasks | `a2a-messages.spec.ts` (a retried `messageId` posts once), `a2a-lifecycle.spec.ts` (a retried `requestId` acts once), `a2a-outbound.spec.ts` (a redelivered send sends nothing, and a recorded answer is never sent again), `a2a-readback.spec.ts` (a stale or redelivered read number does nothing). MCP and A2A act on the same task and history | Passed locally. On staging: inbound retries in `a2a-staging.mjs`, for the lead to record |

### Behavior M3 adds, by step

| Item | How it's verified | Status |
| --- | --- | --- |
| Endpoint registration with a sealed token (step 11) | `a2a-endpoint.spec.ts`, and `e2e/a2a-staging.mjs` "Endpoint": set, read, rotate, the admin's read, delete and disconnect, with no token or secret in any output | Passed locally. On staging: for the lead to record |
| Offers out, from the outbox through the queue, with the send-time rechecks (step 12) | `a2a-outbound.spec.ts`: IDs-only jobs, `returnImmediately`, the signature and token, the answer recorded first, retries as the same message, switching off after 3 failures, the setter's departure, and the dead-letter queue | Passed locally |
| Reading back by `GetTask`, and cancel out (step 13) | `a2a-readback.spec.ts`: the backoff, the 7 days, the caps refused whole, the archive guard, origin on messages and events, and `CancelTask` once | Passed locally |
| Change requests out (step 13b) | `a2a-readback.spec.ts`: `referenceTaskIds` and `contextId` from Podster's own stored rows, and superseded by new work | Passed locally |
| Files (step 14, and `/a2a/files`) | `a2a-lifecycle.spec.ts` (`SubmitTask.files`), `a2a-messages.spec.ts` (URL parts as links), `a2a-outbound.spec.ts` (an offer's file links), `a2a-files.spec.ts` (the route's audience), and `e2e/a2a-staging.mjs` (a ready file downloads at `/a2a/files` with the `/a2a` token only) | Passed locally, but the download needs a scanner, so the local rehearsal skips it. On staging: for the lead to record |
| Screens (step 15) | `apps/web` tests: the Agent Sheet's endpoint section, and origin labels on the Task Sheet. `run-a11y.mjs` | Passed locally |

## Owed before M3's gate

- **A real round trip to an outside A2A server.** An offer goes out, then the server's `WORKING` and `COMPLETED` are read back as an acceptance and a submission. Its download of an input file goes over `/a2a/files`, and a change request is sent and read back. That needs an A2A server staging can reach. It's a new cloud resource, so the owner must approve it. A proposal is in the PR that added this checklist.
- **The outbound run against LangGraph's server** ([decision 143](spec/PRODUCT.md#decisions-needed)), or fasta2a's. It hasn't run, because starting it was refused by the session permission check. It may be the same run as the round trip, if the test server is LangGraph's.
- **The compatibility kit** ([decision 142](spec/PRODUCT.md#decisions-needed)). It hasn't run, for the same reason. It must run some other way before any support claim.
- **The staging results above.** The lead runs `e2e/a2a-staging.mjs` against staging and records each "for the lead to record" row with its commit.
- **Spike C on staging** ([decision 126](spec/PRODUCT.md#decisions-needed)): real egress, timeouts and queue timing. The unreachable-endpoint check covers the failure half. The success half needs the round trip.

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
- **Run:** only the three local spikes above. The kit and any independent implementation haven't run.
- **Not checked:** whether the differences between v1.0.0 and v1.0.1 matter, beyond the release notes.
