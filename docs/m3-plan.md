# M3 plan

**Proposed.** Everything here is a draft for the owner, and no choice below is accepted. It covers [M3 A2A](spec/PRODUCT.md#product-direction-and-delivery-scope), and the design it starts from is the [proposed A2A adapter](spec/ARCHITECTURE.md#a2a-adapter). No A2A code exists.

## Does M3 wait for M2?

**Partly, and the gate has to wait.**

- **M3's gate shouldn't pass before M2's.** Remote work has to land as a submission a reviewer can approve, and exact-version files don't exist until [M2](m2-plan.md).
- **M3's contract and migration work shouldn't start until M2's has merged, through M2 step 8.** Under [decision 60](spec/PRODUCT.md#decisions-needed), M2 and planning take turns on contract PRs, so a third stream would slow M2 and change the same task and artifact shapes.
- **Design, spikes and pure code can start now.** See [what can start now](#what-can-start-now).

## What M3 includes

From [`PRODUCT.md`](spec/PRODUCT.md#agent-communication-mcp-and-a2a):

- **A published profile:** which protocol version, bindings, operations and state mappings Podster supports.
- **Inbound:** a remote client authenticates as a Podster agent identity and reaches the same commands as MCP.
- **Outbound:** an agent that registers an A2A endpoint gets offers delivered through the outbox under the wake egress policy.
- **Tests:** interoperability and authorization, positive and negative.

MCP-only agents stay fully supported, and offline agents aren't promised to be reachable.

## Protocol gates

These come from the specs. Nothing can say Podster supports A2A until all of them pass:

- The profile is published.
- Positive and negative interoperability tests pass with at least two independent implementations.
- Authorization tests pass on a deployment, including:
  - **AC-12:** forged, expired or wrong-audience assertions are refused, the same as on the other paths.
  - **AC-18:** A2A instructions to elevate access stay data.
  - **AC-24:** a remote completion records a submission only, or is held before acceptance, and grants nothing.
- Expanded criterion 4 holds across protocols: one task history, and duplicate deliveries don't compete.

## What the published spec says

Checked on 2026-11-07 against the source at tag `v1.0.1`.

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

## Build order

C changes contracts and M adds a migration. All of this is proposed, and those PRs merge one at a time.

| Step | Work | C | M | After |
| --- | --- | --- | --- | --- |
| 0 | ADR 0007: the profile, from the questions below | | | Can start now |
| 1 | Spike in `spikes/`: JSON-RPC on a Worker against two SDK clients and the kit, locally | | | Can start now |
| 2 | Pure state mapping in a new `crates/core` module, with tests | | | 0 |
| 3 | Agent Card, version handling and authentication to an agent identity, on the gateway | Yes | | 0, M2 step 8 |
| 4 | Inbound reads: `GetTask` and `ListTasks`, scoped as today's reads | Yes | | 3 |
| 5 | Inbound messages on a task thread, stored as untrusted content, with duplicates removed | Yes | If the ADR adds a table | 4 |
| 6 | Inbound lifecycle: accept, decline, release and submit | Yes | | 5 |
| 7 | Registering an endpoint: a capability, its policy and its credential | Yes | Yes | 3 |
| 8 | Outbound offers: outbox, queue, `SendMessage`, and the stored mapping | | Yes | 7 |
| 9 | Remote updates: submission, held response, failure, cancel | Yes | Yes | 8 |
| 10 | Files in both directions | Yes | | 6, 9, M2 step 6 |
| 11 | Screens: endpoint status, and held responses flagged to the requester | | | 7, 9 |
| 12 | Run on staging: the kit, two implementations, AC-12, AC-18 and AC-24. Then publish the profile | | | All, M2's gate |

The gateway only translates, and Rust decides every command, including what a remote state means. New gateway code goes in a new module, to stay out of `apps/gateway/src/index.ts`. Each capability updates contracts in its own PR.

## What depends on M2

| M3 needs | From M2 | Why |
| --- | --- | --- |
| A remote agent's files on a submission | Step 6 | Without it, remote work can only be text or links |
| Input files sent to a remote agent | Steps 4 and 5 | An outbound offer has to link what the task names |
| A stable task and artifact shape | Through step 8 | Otherwise M3's contract changes twice |
| Exact-version approval of remote work | Steps 6 and 7 | "Remote completion is only a submission" needs a submission that can hold the files |
| M3's gate | Step 11 | The files path has to run for real |

Text messages, reads and lifecycle don't depend on M2's code, only on its turn with the contracts.

## What can start now

None of this takes the contract turn, adds a migration or touches M2's files:

- **ADR 0007,** once the owner has answered the questions below.
- **The spike** in `spikes/`, local only. It shows whether the SDK clients and kit can drive a Worker, and whether the kit fits a server that doesn't run the work itself. Nothing merges from it into product code.
- **The pure state mapping** in a new `crates/core` module, with one line in `lib.rs`. It takes no contract, so it's like the pure upload rules in [#98](https://github.com/thachp/podster/pull/98).
- **A list of independent implementations** to test against.

These can't start now: gateway routes, capabilities, `openapi.yaml`, room schema, and any cloud resource or DNS change.

## Risks to test

- **Authority:** an Agent Card, message, artifact label or remote state never grants anything or moves `verify`.
- **Self-review:** a remote agent can't approve its own work through any mapping.
- **Probing:** a task someone can't see gets the same `TaskNotFoundError` as one that doesn't exist, and `ListTasks` can't be widened by a `contextId`.
- **Audience:** a token for MCP or for one service isn't accepted for another (AC-12).
- **Duplicates:** the same `messageId` or a retried outbox send makes no competing task or second submission.
- **Out of order:** a late remote update arrives after a decline, cancel, revocation or reassignment, and changes nothing.
- **Reaching out:** SSRF through a registered endpoint, a redirect or a file reference. A remote Agent Card is untrusted input.
- **Credentials:** an endpoint's credential never reaches logs, events or a read. Revoking an agent stops its deliveries.
- **Remote completion before acceptance:** it's held and flagged, not treated as acceptance.
- **Terminal tasks:** a change request after `COMPLETED` makes a linked new A2A task without losing the history.
- **Slow or dead agents:** Podster never waits on one, and an offer can move to someone else.
- **Hostile content:** size limits on messages and parts, inert rendering, and `external` marking.
- **Logs:** IDs only, with no message bodies, URIs or tokens.
- **Rooms:** an agent in two rooms can't move anything between them through a shared `contextId`.

## Questions for the owner

All are recommendations and none is decided.

| # | Question | Recommendation | Why |
| --- | --- | --- | --- |
| 1 | When does M3 start? | **Proposed:** design and spike now. Contracts after M2 step 8, and the gate after M2's | See [above](#does-m3-wait-for-m2). If speed matters more, taking turns with M2 from step 6 is the alternative, with more rework |
| 2 | Which binding? | **Proposed:** JSON-RPC only at first | One binding is allowed, it's the simplest to run on a Worker, and HTTP+JSON's error format disagrees within the spec. Whether interoperability partners need another is what the spike checks |
| 3 | Which version? | **Proposed:** 1.0 only, with no 0.3 | Two versions double the tests, and nothing depends on 0.3 |
| 4 | Streaming, push and the extended card on Podster's server? | **Proposed:** all off at first | Polling and wake cover it, and the spec gives named errors. A long stream on the gateway is its own design |
| 5 | How does an A2A client authenticate? | **Proposed:** OAuth 2 bearer tokens to the same agent identity, with an audience just for A2A | It reuses the identity work, and doesn't accept an MCP token elsewhere. How it fits Agent Auth is for the ADR |
| 6 | What counts as a remote agent accepting? | **Proposed:** the registered endpoint reporting `WORKING` on an offered task accepts it. `COMPLETED` with no `WORKING` is held | Accepting is the agent's own right, so its own report grants nothing extra, and generic A2A agents can take part without an extension. The spec's `WORKING` means processing, so it's a stretch, and the profile must say so plainly |
| 7 | How does an inbound client accept, decline or submit? | **Proposed:** a small versioned Podster extension, not required for reading or messages | Plain A2A messages have no named lifecycle actions, and a message's text must never become a command |
| 8 | How does `request_changes` reach a completed remote task? | **Proposed:** a new A2A task with `referenceTaskIds` and the same `contextId` | Terminal tasks take no messages, so the spec leaves little choice |
| 9 | Can a task be created over A2A? | **Proposed:** not in the first profile. `SendMessage` with no `taskId` is refused | A task needs a room, role, reviewer and policy, and plain A2A doesn't carry those. A lead still uses MCP or Agent Auth |
| 10 | What are `contextId` and the task ID inbound? | **Proposed:** both come from the Podster task, with no room-wide context | A room-wide context would invite reads across a room, and threads belong to tasks |
| 11 | What happens to file references? | **Proposed:** Podster never fetches one. A URL is stored as an [external link](spec/PRODUCT.md#decisions-needed), and bytes come through `create_upload` | It avoids SSRF and keeps every file under the scan and quota. Inline bytes are refused at first |
| 12 | What credential does Podster hold for a remote endpoint? | **Proposed:** a signed request like wake, plus one optional stored bearer token per endpoint, encrypted | Real agents will need a token, and it would be Podster's first stored outbound credential, so it needs the security pass in question 15 |
| 13 | What counts as two independent implementations? | **Proposed:** one project SDK, and one agent framework from outside the project | Two SDKs from one project could share misreadings. Which framework isn't chosen |
| 14 | What does the kit have to show? | **Proposed:** all MUST checks pass, or each exception is listed with its reason in the profile | Podster coordinates rather than runs work, so some checks may not fit. The spike finds out |
| 15 | Run a deeper security pass? | **Proposed:** yes, on steps 3, 7 and 9, beyond the quick diff review | They add a public protocol surface, outbound calls and a stored credential |
| 16 | Which cloud resources? | **Proposed:** use the existing wake queue if the spike allows, otherwise ask for a new queue | Nothing's created without the owner in that session |

## How far this was checked

- **Read directly:** `v1.0.1`'s `docs/specification.md`, for the rows above, and the task states in `specification/a2a.proto`.
- **Not read closely:** the rest of the spec, the kit beyond its README, and the SDKs themselves.
- **Not run:** nothing here has run. Whether a Worker can serve this, and whether the kit fits, is what step 1 is for.
- **Not checked:** whether the differences between v1.0.0 and v1.0.1 matter, beyond its release notes.
