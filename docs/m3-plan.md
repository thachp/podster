# M3 plan

**Proposed.** This is a draft for the owner, and no choice in it is accepted. It covers [M3 A2A](spec/PRODUCT.md#product-direction-and-delivery-scope) and starts from the [proposed A2A adapter](spec/ARCHITECTURE.md#a2a-adapter). No A2A code exists.

**Status, 2026-11-08 UTC:** on 2026-11-07 the owner said "we need to finish m2", meaning M2 before any M3 code. That's the owner's statement of that date, not yet a numbered decision. So M3 is planning only, and what "finished" means for M3's first code is question 27. When M2 is done, M3 starts with the [rulings](#questions-for-the-owner) and the [spikes](#spikes), then the [build order](#build-order).

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

Each runs in `spikes/`, is thrown away afterwards, and ends with its results written into ADR 0007, as M2's spike did for [ADR 0006](adr/0006-uploads-and-scanning.md#spike-results). Question 1 asks whether they can run before M2 is done.

| Spike | What it must prove | Pass bar | Where | Needs |
| --- | --- | --- | --- | --- |
| **A: inbound on a Worker** | A Worker can serve A2A 1.0 over JSON-RPC to real clients: Agent Card, `SendMessage` to an existing task, `GetTask`, `ListTasks`, and named errors for streaming, push and the extended card. Also whether the project's JavaScript SDK server code runs on Workers (question 22) | Two client implementations (question 18) complete card, send and get with no patches. A request with no version gets `VersionNotSupportedError`. Every kit MUST failure is either fixed or written down with why it doesn't fit a coordinator. CPU per request is measured and recorded | Local, `wrangler dev` | Questions 1, 2, 3, 18 and 22 |
| **B: a separate A2A audience** | The gateway's existing OAuth provider can issue tokens for a second resource, `/a2a`, with its own scope, tied to the same agent identity and consent as `/mcp` | An A2A token is refused at `/mcp` and `/v1/files`, and an MCP token at `/a2a`, before any API call. Disconnecting revokes both. At least one A2A client finishes the OAuth flow unpatched, or the ADR records which clients need a token issued by hand | Local | Questions 1 and 5 |
| **C: outbound send and read-back** | A queue consumer can send `SendMessage` with `return_immediately` to a remote A2A server, then read its state with `GetTask`, under `crates/egress`'s rules as they stand | An offer reaches two different server implementations and their state is read back. Everything [the wake policy](spec/ARCHITECTURE.md#wake) refuses is refused before sending: `http`, an IP address in any form, credentials in the URL, a non-default port and `podster.dev`. A redirect isn't followed. A resend with the same `messageId` is recorded as the server actually treats it. Logs hold IDs only | Local, with a test server. A staging run needs the owner in that session | Questions 1, 16 and 20 |

The wake policy checks the name, not what it resolves to, and relies on `global_fetch_strictly_public`. Spike C doesn't test resolved addresses. Whether A2A needs more, since it sends task text where wake sends only IDs, is question 28.

## Build order

C changes `packages/contracts` and M adds a migration or room schema. All of it is proposed. Product code, steps 5 onward, waits until M2 is finished as question 27 defines it. C and M PRs merge one at a time, after M2's last one, and take turns with planning's as [decision 60](spec/PRODUCT.md#decisions-needed) does for M2.

| Step | Work | C | M | After | Runs beside |
| --- | --- | --- | --- | --- | --- |
| 0 | ADR 0007 draft: the profile, from the owner's rulings | | | Rulings | 1, 2, 3 |
| 1 | Spike A | | | Questions 1, 2, 3, 18 and 22 | 0, 2, 3 |
| 2 | Spike B | | | Questions 1 and 5 | 0, 1, 3 |
| 3 | Spike C | | | Questions 1, 16 and 20 | 0, 1, 2 |
| 4 | ADR 0007 with spike results, accepted by the owner | | | 0 to 3 | |
| 5 | Pure mapping in `crates/core/src/a2a.rs`, with one line in `lib.rs`: a remote state plus the current Podster state gives one command, a hold or nothing. Tests include late and out-of-order updates | | | 4, M2 finished | 6 |
| 6 | Gateway module `apps/gateway/src/a2a/`: Agent Card, JSON-RPC envelope, version check, and every operation answering its named "not supported" error. The profile is `docs/spec/A2A-PROFILE.md`, and a gateway test checks the card lists only the operations it names. `check.mjs` covers only `openapi.yaml` and `capabilities.yaml`, so nothing here changes `packages/contracts` | | | 4, M2 finished | 5 |
| 7 | Authentication: the `/a2a` audience and scope, resolving to the same agent identity. AC-12's negatives | Only if the API's identity call changes | | 6 | |
| 8 | Inbound reads: `GetTask` and `ListTasks` through `get_task` and `list_tasks`. A hidden task gets the same `TaskNotFoundError` as a missing one | | | 7 | 11 |
| 9 | Inbound messages: `SendMessage` with a `taskId` becomes `send_message`, with `messageId` as the idempotency key, size limits and `external` marking. No `taskId` is refused | Yes | Only if `messageId` can't use the idempotency record | 8 | 11 |
| 10 | Inbound lifecycle through the Podster extension: accept, decline, release, and submit with text and links | Yes | | 9 | 11 |
| 11 | Endpoint registration on the `Principal`: set, delete and status, checked against the egress policy, with the credential from question 16 | Yes | Yes | 7 | 8, 9, 10 |
| 12 | Outbound offers: outbox, queue, `SendMessage` with `return_immediately`, the stored mapping of one A2A task per offer attempt, retries with the same `messageId`, and switching off after repeated failures | | Yes | 5, 11 | |
| 13 | Remote updates, as question 11 decides: read back, mapped through step 5 into a submission, a held response, a release or nothing. `cancel_task` sent out | Yes | Yes | 12 | |
| 14 | Files: inbound submissions with files from `create_upload`, offers that link input files as Podster links, and remote file references kept as external links | Yes | | 10, 13, M2 steps 5 and 6 | 15 |
| 15 | Screens: endpoint status on the agent's Sheet, and held responses flagged to the requester in the Task Sheet | | | 11, 13, M2 step 9b | 14 |
| 16 | Staging run: the kit, two implementations, AC-12, AC-18, AC-24 and criterion 4 across protocols. Then the owner rules, and the profile is published | | | All, M2's gate | |

**What runs in parallel:** the three spikes and the ADR draft. Steps 5 and 6. Step 11 is built beside 8 to 10, because it's in the `Principal` and they're in the `Workspace` path. Steps 9 to 11 change contracts and 11 adds a migration, so they're built side by side and still merge one at a time. Steps 14 and 15, which are in different folders.

**Steps that unruled defaults block:**

- **Questions 6 and 7:** with both defaults, no A2A path can accept a task. Step 10 builds nothing, and AC-24's after-acceptance case can't run over A2A, so step 16 can't pass the gate.
- **Question 18:** with its default, step 16 can run but support can't be claimed.
- **Question 23:** with its default there's no queue, so steps 12 to 16 are blocked.

Steps 5 to 9 and 11 don't depend on any of these.

Step 8 waits only on step 7, because reads translate today's task view. Step 5's mapping is first used by step 12.

The gateway only translates. Rust decides every command, including what a remote state means. New gateway code goes in `apps/gateway/src/a2a/`, new Rust in new modules, and each touches `index.ts`, `lib.rs` and `workspace.rs` by a line or two. Each capability updates contracts in its own PR.

## Questions for the owner

Each has a recommendation and the narrowest default, which is what the plan does if the question isn't ruled. None is decided.

| # | Question | Recommendation | Default if unruled |
| --- | --- | --- | --- |
| 1 | Do the spikes and ADR count as the M3 code that the owner's 2026-11-07 statement holds until M2 is finished? | Spikes in `spikes/` and the ADR may start now, since they don't touch product code, contracts or staging. Product code, including step 5's pure code, waits as question 27 says | Nothing but docs until M2 is finished |
| 2 | Which binding? | JSON-RPC only at first. One binding is allowed, it's the simplest on a Worker, and HTTP+JSON's error format disagrees within the spec | Same |
| 3 | Which version? | 1.0 only, with no 0.3. Two versions double the tests | Same |
| 4 | What does Podster's server offer beyond the basics? | Streaming, push notifications and the extended card all off. One public card that describes Podster and lists no rooms | Same |
| 5 | How does an A2A client authenticate? | An OAuth 2 bearer token for the same agent identity, with an audience just for A2A, through the same consent. Agent Auth JWTs aren't accepted on A2A at first | Same |
| 6 | Does a remote agent reporting `WORKING` accept an offer? | Yes, from the registered endpoint only, and the profile says so plainly. `COMPLETED` with no `WORKING` is held. Generic agents can then take part without an extension | No. Only the extension accepts, and anything before that is held |
| 7 | How does an inbound client accept, decline, release or submit? | A small versioned Podster extension. Reading and messages don't need it. A message's text never becomes a command | No inbound lifecycle in the first profile, only reads and messages |
| 8 | How does `request_changes` reach a completed remote task? | A new A2A task with `referenceTaskIds` and the same `contextId`, because a terminal task takes no messages | Same |
| 9 | Can a task be created over A2A? | No. A task needs a room, role, reviewer and policy that plain A2A doesn't carry | Same |
| 10 | What are `contextId` and the task ID? | Both come from the Podster task, with no room-wide context, so a shared `contextId` can't reach across a room | Same |
| 11 | How does Podster learn a remote task's state? | Polling `GetTask` from the queue, backing off from 1 minute to 1 hour, ending at a terminal state or after 7 days. Push later, since servers needn't support it and it adds a public webhook | Same |
| 12 | What does an outbound offer carry? | The title, instructions and acceptance criteria as text parts, read fresh at send time after access is rechecked, and a Podster link. The queue holds IDs only | IDs and a link only, which most generic agents can't act on |
| 13 | Who registers an endpoint? | The agent, or its organization's admin, as with wake. One per agent, beside wake rather than replacing it. It grants nothing in any room | The agent only |
| 14 | Does Podster fetch a remote Agent Card? | Not at first. The registrant gives the URL, and the first delivery shows it works. A fetched card would be untrusted input with SSRF risk | Same |
| 15 | What happens to file references? | Podster never fetches one. A URL is kept as an [external link](spec/PRODUCT.md#decisions-needed), bytes come through `create_upload`, and inline bytes are refused | Same |
| 16 | What credential does Podster hold for a remote endpoint? | A signed request like wake's, plus one optional bearer token per endpoint, encrypted. It's Podster's first stored outbound credential, so it gets question 21's pass and a new secret the owner sets | Signed requests only, and no stored token |
| 17 | Which limits apply? | MCP's: 16 KB per message, 10 artifacts per submission, the same request rates. At most 8 parts per message. One send per offer attempt | Same |
| 18 | What counts as two independent implementations? | One project SDK, and one agent framework from outside the project, so they can't share a misreading. Spike A names candidates for the owner to pick | No support claimed until the owner names them |
| 19 | What must the kit show? | Every MUST check passes, or each exception is in the profile with its reason | Same |
| 20 | Where do the spikes run? | Locally. Spike C runs once on staging only if the owner says yes in that session | Local only, with the real egress checks left to step 12 on staging |
| 21 | Which steps get a deeper security pass? | Steps 7, 11, 12 and 13, beyond the quick diff review. They add a public protocol surface, outbound calls and a stored credential | Same, since each is asked before it runs |
| 22 | The project's JavaScript SDK in the gateway, or a small fresh JSON-RPC layer? | Whichever spike A shows runs cleanly on Workers. A fresh layer if the SDK needs Node-only server code | A fresh layer |
| 23 | Which cloud resources? | A new queue and dead-letter queue for A2A, kept apart from wake, which is ID-only and debounced | Nothing is created. Without a queue, step 12 can't start |
| 24 | Is Runner's inbound nudge part of M3? | No, it stays in M7. M3 only gives it a profile to follow | Same |
| 25 | Do test people count for M3's gate, as for M1 under [decision 79](spec/PRODUCT.md#decisions-needed)? | Yes. A pass with a real second person stays owed before production | Same |
| 26 | Who calls the gate, and when may support be claimed? | The owner, after step 16's staging run. Until then the card and docs say "preview" and never "conformant" | Same |
| 27 | When is M2 "finished" for M3's product code? | When M2's last contract or migration PR has merged, through step 8 and step 10's D1 migration if it has one. M2's screens and staging run can finish beside M3's first steps, and M3's gate still waits for M2's | When M2's gate, step 11, has passed |
| 28 | Does A2A egress need more than wake's policy? | No new resolved-address check at first. Keep wake's rules and `global_fetch_strictly_public`, and don't follow redirects. Revisit before public rooms, when anyone could register an endpoint | Same |

## Owed before production that M3 touches

- **Two real people and their own sign-ins.** The [two-person kernel journey](m0-gate.md) still hasn't run on a deployment. M3 adds agents from other organizations, so its cross-organization checks need the same.
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
- **Not run:** nothing. Whether a Worker can serve this, and whether the kit fits, is what the spikes are for.
- **Not checked:** whether the differences between v1.0.0 and v1.0.1 matter, beyond the release notes.
