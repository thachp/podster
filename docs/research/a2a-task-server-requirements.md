# What A2A 1.0 requires of a task server

Research for [issue #215](https://github.com/thachp/podster/issues/215), a child of the map [#207](https://github.com/thachp/podster/issues/207). Read on 2026-11-09. This is a research note, not a spec: nothing here is a decision.

**The question:** what is the least a Runner must implement to be an A2A 1.0 task server that Podster's outbound path can drive?

## Short answer

- **To be driven by Podster,** a Runner needs three JSON-RPC methods at one HTTPS URL: `SendMessage`, `GetTask` and `CancelTask`. Podster calls nothing else and never fetches an Agent Card.
- **To also be a conformant A2A 1.0 server,** it must add `ListTasks`, answer the seven streaming, push and extended-card methods with their named errors, publish an Agent Card with eight required fields, check `A2A-Version`, and authenticate every request.
- **The spec leaves optional several things Podster's path depends on.** The Runner spec has to pin them, because a server can be fully conformant and still not work with Podster. They are listed under [What Podster relies on that the spec leaves optional](#what-podster-relies-on-that-the-spec-leaves-optional).
- **Three points in ADR 0007 don't match the spec text** or are fragile against a conformant server. They are under [Mismatches with ADR 0007](#mismatches-with-adr-0007).

## Sources and how to read the citations

| Short name | What it is |
| --- | --- |
| Spec | The A2A specification at tag `v1.0.0`, published at <https://a2a-protocol.org/v1.0.0/specification/>. Read from its source, [`docs/specification.md@v1.0.0`](https://github.com/a2aproject/A2A/blob/v1.0.0/docs/specification.md). Section links below point at the published page |
| Proto | [`specification/a2a.proto@v1.0.0`](https://github.com/a2aproject/A2A/blob/v1.0.0/specification/a2a.proto). Spec 1.4 calls it "the single authoritative normative definition" of every data object, so required fields are taken from it |
| Latest | <https://a2a-protocol.org/latest/specification/>, which follows the `main` branch, not a release. It differs from `v1.0.0`: see [Version drift](#version-drift) |
| Life of a Task | [`docs/topics/life-of-a-task.md@v1.0.0`](https://github.com/a2aproject/A2A/blob/v1.0.0/docs/topics/life-of-a-task.md), a project guide. It isn't normative |
| ADR | [`docs/adr/0007-a2a.md`](../adr/0007-a2a.md) |
| Code | [`apps/api/src/a2a_out.rs`](../../apps/api/src/a2a_out.rs) and `crates/core/src/a2a.rs` at `3623ce3`, read to confirm what the ADR says is sent |

"Unverified" marks anything not confirmed from a primary source. Nothing was installed or run.

## 1. Operations a JSON-RPC server must support

**The spec names eleven operations** and says they are "the fundamental capabilities that all A2A implementations must support" ([Spec 3.1](https://a2a-protocol.org/v1.0.0/specification/#31-core-operations)). The JSON-RPC method names are in [Spec 5.3](https://a2a-protocol.org/v1.0.0/specification/#53-method-mapping-reference). Seven of them hang on a capability flag, and a server that leaves the flag off must still answer them, with an error ([Spec 3.3.4](https://a2a-protocol.org/v1.0.0/specification/#334-capability-validation)).

| Method | Minimal conformant server | Podster calls it |
| --- | --- | --- |
| `SendMessage` | Implement | Yes: offers and change requests |
| `GetTask` | Implement | Yes: polling, and one history read |
| `CancelTask` | Implement. It may refuse with `TaskNotCancelableError` | Yes, once per canceled task |
| `ListTasks` | Implement. No capability flag turns it off | Never |
| `SendStreamingMessage`, `SubscribeToTask` | MUST answer `UnsupportedOperationError` (`-32004`) when `capabilities.streaming` is false or absent | Never |
| The four push-config methods | MUST answer `PushNotificationNotSupportedError` (`-32003`) when `capabilities.pushNotifications` is false or absent | Never |
| `GetExtendedAgentCard` | MUST answer `UnsupportedOperationError` when `capabilities.extendedAgentCard` is false or absent | Never |

**Binding rules** ([Spec 9](https://a2a-protocol.org/v1.0.0/specification/#9-json-rpc-protocol-binding)):

- JSON-RPC 2.0 over HTTP(S), `Content-Type: application/json`, PascalCase method names (9.1).
- `A2A-Version` and `A2A-Extensions` travel as HTTP headers (9.2).
- `SendMessage` answers `result.task` or `result.message` (9.4.1). `GetTask` and `CancelTask` answer a `Task` as `result`.
- A2A errors use codes `-32001` to `-32009` ([Spec 5.4](https://a2a-protocol.org/v1.0.0/specification/#54-error-code-mappings)), and MUST carry a `google.rpc.ErrorInfo` in `error.data` (9.5). Podster reads only `error.code`.
- JSON fields are camelCase and enums are their proto names, such as `TASK_STATE_WORKING` and `ROLE_USER` ([Spec 5.5](https://a2a-protocol.org/v1.0.0/specification/#55-json-field-naming-convention)).
- **The HTTP status of a JSON-RPC error isn't stated** anywhere in section 9. See [mismatch 3](#mismatches-with-adr-0007).

**Versioning** ([Spec 3.6.2](https://a2a-protocol.org/v1.0.0/specification/#362-server-responsibilities)): a server MUST process a request under the `A2A-Version` it names, MUST answer `VersionNotSupportedError` (`-32009`) for one it doesn't support, and MUST read an empty value as 0.3.

**Authentication** ([Spec 7.4](https://a2a-protocol.org/v1.0.0/specification/#74-server-authentication-responsibilities)): a server MUST authenticate every incoming request "based on the provided credentials and its declared authentication requirements". Production MUST use HTTPS ([Spec 7.1](https://a2a-protocol.org/v1.0.0/specification/#71-protocol-security)).

**Compared with Podster.** Podster sends `content-type: application/json` and `a2a-version: 1.0` on every request (Code, `rpc`), and only the three methods above. That matches. A Runner that implements only those three works with Podster but isn't a conformant server.

## 2. Agent Card fields

**A server MUST make an Agent Card available** ([Spec 8.1](https://a2a-protocol.org/v1.0.0/specification/#81-purpose)). The well-known path `/.well-known/agent-card.json` is one of three listed discovery mechanisms, beside registries and direct configuration ([Spec 8.2](https://a2a-protocol.org/v1.0.0/specification/#82-discovery-mechanisms)). The spec doesn't say a server MUST serve it at that path. It says only that whatever is at that path MUST be an `AgentCard` ([Spec 14.3](https://a2a-protocol.org/v1.0.0/specification/#143-well-known-uri-registration)).

**Required fields**, from the `REQUIRED` annotations in Proto's `AgentCard`, `AgentInterface` and `AgentSkill`. A required array "MUST contain at least one element" ([Spec 5.7](https://a2a-protocol.org/v1.0.0/specification/#57-field-presence-and-optionality)).

| Field | Notes |
| --- | --- |
| `name`, `description`, `version` | `version` is the agent's own, not the protocol's |
| `supportedInterfaces` | At least one. Each needs `url`, `protocolBinding` (`JSONRPC` here) and `protocolVersion` (`1.0`). `tenant` is optional |
| `capabilities` | Required as an object. Every flag inside is optional: `streaming`, `pushNotifications`, `extendedAgentCard`, `extensions`. Absent means off (Spec 3.3.4) |
| `defaultInputModes`, `defaultOutputModes` | Media types, at least one each |
| `skills` | At least one. Each needs `id`, `name`, `description` and `tags`, and `tags` needs at least one entry |

**Optional:** `provider`, `documentationUrl`, `iconUrl`, `securitySchemes`, `securityRequirements`, `signatures`. The card MUST declare every protocol the agent supports ([Spec 5.2](https://a2a-protocol.org/v1.0.0/specification/#52-protocol-selection-and-negotiation), [8.3](https://a2a-protocol.org/v1.0.0/specification/#83-protocol-declaration-requirements)).

**A naming inconsistency in the spec.** The sample card in Spec 8.5 writes `"security"`, but Proto's field is `security_requirements`, so the JSON name is `securityRequirements`. Proto is normative.

**Compared with Podster.** Podster never fetches a remote card (ADR, decision 120), so nothing in a Runner's card affects whether Podster can drive it. Two consequences:

- **Publishing a card is a conformance question only.** It's the open "Agent Card" item on the map.
- **Podster's credential has no obvious card declaration.** Spec 7.4 ties authentication to "declared authentication requirements". Podster's optional bearer token fits `httpAuthSecurityScheme`. The `X-Podster-Signature` HMAC over `{t}.{body}` isn't one of the five scheme types in Proto (`apiKey`, `httpAuth`, `oauth2`, `openIdConnect`, `mtls`). Whether an `apiKeySecurityScheme` naming that header is an acceptable way to declare it is a judgement, and **unverified**.

## 3. What a server may answer to `SendMessage` with `returnImmediately`

**Two answers are allowed:** a `Task`, or a direct `Message` "for simple interactions that don't require task tracking" ([Spec 3.1.1](https://a2a-protocol.org/v1.0.0/specification/#311-send-message)). The agent chooses.

**With `returnImmediately: true`** ([Spec 3.2.2](https://a2a-protocol.org/v1.0.0/specification/#322-sendmessageconfiguration)):

- The operation "MUST return immediately after creating the task, even if processing is still in progress".
- The returned task "will have an in-progress state (e.g., `working`, `input_required`)". That sentence isn't a MUST, and it names no required state.
- The caller is then responsible for polling `GetTask`, subscribing or push.
- The field "has no effect" when the answer is a direct `Message`.

**Without it,** the default is blocking: the server MUST wait for a terminal or interrupted state.

**Errors `SendMessage` may answer** (Spec 3.1.1): `ContentTypeNotSupportedError` for a part's media type, `UnsupportedOperationError` for a message to a task in a terminal state, and `TaskNotFoundError`.

**Compared with Podster.**

- **A `Task` answer** is recorded: Podster keeps `result.task.id`, and `contextId` if there is one. If the task is already terminal, it's applied as read 0 (ADR, decision 174).
- **A `Message` answer** counts as answered, with no remote task. Nothing is polled afterwards, so the offer just stays in Podster. A Runner must answer with a `Task` to be read back.
- **Podster marks its one part `mediaType: text/markdown`** (Code, `request_body`). A server may refuse that with `ContentTypeNotSupportedError`. The project's JavaScript SDK does exactly this when `validateInputModes` is on and the card's `defaultInputModes` doesn't list the type ([`default_request_handler.ts@v1.3.0`, `_validateInputModes`](https://github.com/a2aproject/a2a-js/blob/v1.3.0/src/server/request_handler/default_request_handler.ts)). A Runner must accept `text/markdown`.
- **Podster's send has a timeout** (the ADR says up to 10 s). A server that blocks past it is a failed send, and the same `messageId` is sent again.

## 4. Duplicate `messageId`, `referenceTaskIds` and `contextId`

### Duplicate `messageId`

- **Deduplication is optional.** "Send Message operations MAY be idempotent. Agents may utilize the messageId to detect duplicate messages" ([Spec 3.3.1](https://a2a-protocol.org/v1.0.0/specification/#331-idempotency)). That's the whole rule. The spec doesn't say what a server that does deduplicate should answer.
- **`messageId` is required** on every message and is "created by the message creator" (Proto, `Message`).
- **The JavaScript SDK doesn't deduplicate.** At `v1.3.0` its default handler makes a new task ID for every message without a `taskId` and never looks `messageId` up. That agrees with spike C in the ADR.

**Compared with Podster.** Podster uses the offer attempt's ID as `messageId` and resends the same one on retry, so a retry after a timed-out send is the case that matters. The ADR already accepts that a server may make a second task and that Podster can't see or cancel it. For a Runner the spec allows the fix: keep `messageId` to task, and answer a repeat with the first task.

### `contextId`

From [Spec 3.4.1](https://a2a-protocol.org/v1.0.0/specification/#341-context-identifier-semantics) and [3.4.3](https://a2a-protocol.org/v1.0.0/specification/#343-multi-turn-conversation-patterns):

- An agent MAY generate a `contextId` for a message that has none, and if it does, it MUST put it in the response.
- An agent MAY accept a client-provided one. If it can't, it MUST reject the request, and MUST NOT substitute its own.
- A client SHOULD NOT send one it made up, and SHOULD treat a server's as opaque.
- A client MAY send `contextId` without `taskId` "to start a new task within an existing conversation context".
- An agent MUST infer it from the task when only `taskId` is given, and MUST reject a `contextId` that doesn't match the task's.
- **Whether a `Task` always has a `contextId` is unclear.** Proto's `Task.context_id` isn't `REQUIRED`, and generating one is a MAY. Proto's comment on `Message` says a server message's `context_id` "must be provided".

**Compared with Podster.** An offer carries no `contextId`, so the server chooses. A change request sends back the `contextId` the first task's answer gave, and omits it if none came. That follows every rule above. Podster checks a `contextId` like a task ID before keeping it, and drops one that fails.

### `referenceTaskIds`

- It's "a list of task IDs that this message references for additional context" (Proto, `Message`).
- Clients SHOULD use it to reference related tasks, and agents SHOULD use the referenced tasks "to understand the context and intent of follow-up requests" (Spec 3.4.3). Both are SHOULD. Nothing says what a server does with an ID it doesn't know.
- **A finished task can't take the follow-up itself.** A message to a task in a terminal state gets `UnsupportedOperationError` (Spec 3.1.1). Life of a Task says a terminal task "cannot restart" and a refinement "must initiate a new task within the same `contextId`", with `referenceTaskIds` as the hint.
- **The JavaScript SDK** loads each referenced task and hands it to the executor, and only logs a warning for one it can't find.

**Compared with Podster.** Decision 114 is the pattern the spec and Life of a Task describe: a new `SendMessage` with no `taskId`, the completed task in `referenceTaskIds`, and the same `contextId`. A server is free to ignore the reference, so how a Runner ties the change request to its earlier work is the Runner spec's to state. That's the map's open "Change requests" item.

## 5. Task states

**Nine values** in Proto's `TaskState`. The spec groups them but defines no transition table, and doesn't say when a server must move from `SUBMITTED` to `WORKING`.

| State | Proto's definition | Kind |
| --- | --- | --- |
| `TASK_STATE_UNSPECIFIED` | "unknown or indeterminate" | None |
| `TASK_STATE_SUBMITTED` | "successfully submitted and acknowledged" | In progress |
| `TASK_STATE_WORKING` | "actively being processed by the agent" | In progress |
| `TASK_STATE_INPUT_REQUIRED` | "requires additional user input to proceed" | Interrupted |
| `TASK_STATE_AUTH_REQUIRED` | "authentication is required to proceed" | Interrupted |
| `TASK_STATE_COMPLETED` | "finished successfully" | Terminal |
| `TASK_STATE_FAILED` | "finished with an error" | Terminal |
| `TASK_STATE_CANCELED` | "canceled before completion" | Terminal |
| `TASK_STATE_REJECTED` | "the agent has decided to not perform the task. This may be done during initial task creation or later" | Terminal |

**Rules that attach to states:**

- **Terminal:** no more messages (`UnsupportedOperationError`, Spec 3.1.1), no cancel (`TaskNotCancelableError`, [Spec 3.1.5](https://a2a-protocol.org/v1.0.0/specification/#315-cancel-task)).
- **Interrupted:** a blocking send returns here (Spec 3.2.2). After `INPUT_REQUIRED` the client continues by sending a message with the same `taskId` and `contextId` (Spec 3.4.3).
- **`AUTH_REQUIRED`:** the agent MUST use a task, MUST include a status message explaining what's needed unless that was agreed out of band, and SHOULD accept messages to the task while it waits ([Spec 7.6.1](https://a2a-protocol.org/v1.0.0/specification/#761-in-task-authorization-agent-responsibilities)).
- **Cancel:** the server "will attempt to cancel the task, but success is not guaranteed". It's idempotent, and a repeat MAY answer `TaskNotFoundError` once the task is "canceled and purged" (Spec 3.1.5, 3.3.1).
- **Results belong in artifacts.** "Messages SHOULD NOT be used to deliver task outputs. Results SHOULD BE returned using Artifacts". History isn't guaranteed to hold every message, and "clients MUST NOT rely on this behavior unless negotiated out-of-band" ([Spec 3.7](https://a2a-protocol.org/v1.0.0/specification/#37-messages-and-artifacts)).
- **`historyLength`:** 0 means the `history` field SHOULD be omitted, and a positive value is an upper bound a server may undercut ([Spec 3.2.4](https://a2a-protocol.org/v1.0.0/specification/#324-history-length-semantics); Proto, `GetTaskRequest`).
- **A task may expire.** `TaskNotFoundError` covers a task that is "invalid, expired, or already completed and purged" ([Spec 3.3.2](https://a2a-protocol.org/v1.0.0/specification/#332-error-handling)). No retention period is set.

**Compared with Podster's mapping table** (ADR, "Mapping"):

| Remote state | What Podster does | What the spec says about it |
| --- | --- | --- |
| `SUBMITTED` | Nothing | Consistent. It's the only state that means "received, not started" |
| `WORKING` | Accepts the offer for the agent (decision 112) | The spec gives `WORKING` no such weight. It's the ordinary first state of any task a server starts running, and the example the spec gives for a `returnImmediately` answer |
| `INPUT_REQUIRED` | A thread message from the status message | The spec expects the client to answer on the same task. Podster's outbound path sends no message with a `taskId`, so it never answers |
| `AUTH_REQUIRED` | A thread message that grants nothing | Consistent, though the section the ADR cites isn't in `v1.0.0`: see [Version drift](#version-drift) |
| `COMPLETED` | A submission after acceptance, held before | Podster reads artifacts first, as Spec 3.7 recommends, then falls back to history |
| `REJECTED`, `FAILED` | Decline before acceptance, release after | Consistent with Proto's wording for `REJECTED` |
| `CANCELED` | Recorded only | Consistent |
| `UNSPECIFIED`, unknown | Ignored | Consistent |

## 6. Maintained server SDKs

All are under [github.com/a2aproject](https://github.com/a2aproject), none is archived, and all were pushed to within a week of 2026-11-09. Versions are each repository's latest GitHub release on that date. Registry pages (npm, PyPI, Maven Central, NuGet, crates.io) weren't checked, so **published package versions are unverified**.

| Language | Repository and package | Latest release | Spec 1.0 server, by its own README | JSON-RPC server |
| --- | --- | --- | --- | --- |
| Python | [`a2a-python`](https://github.com/a2aproject/a2a-python), `a2a-sdk` | `v1.3.0`, 2026-10-27 | Yes. Its table lists 1.0 client and server for all three bindings, with a 0.3 compatibility mode | Yes |
| JavaScript and TypeScript | [`a2a-js`](https://github.com/a2aproject/a2a-js), `@a2a-js/sdk` | `v1.3.0`, 2026-09-29 | Yes: "implements the A2A Protocol Specification v1.0.0" | Yes. Podster's gateway pins this version |
| Java | [`a2a-java`](https://github.com/a2aproject/a2a-java), `org.a2aproject.sdk` | `v1.5.1.Final`, 2026-11-09. A `v0.3.4.Final` line is also kept up | The README doesn't name a spec version. That the 1.x line is spec 1.0 is inferred from the parallel 0.3 line, and **unverified** | Yes, `a2a-java-sdk-reference-jsonrpc` |
| Go | [`a2a-go`](https://github.com/a2aproject/a2a-go), `github.com/a2aproject/a2a-go/v2` | `v2.8.0`, 2026-11-06 | Yes: "v1.0 Protocol Specification". The SDK's version number isn't the spec's | Yes, `a2asrv.NewJSONRPCHandler` |
| .NET | [`a2a-dotnet`](https://github.com/a2aproject/a2a-dotnet), `A2A` and `A2A.AspNetCore` | `v1.0.0-preview4`, 2026-11-02. **Every release is a pre-release** | Yes: "implements the A2A v1.0 specification" | Yes |
| Rust | [`a2a-rs`](https://github.com/a2aproject/a2a-rs), crates `a2a-lf` and `a2a-server-lf` | No SDK release on GitHub. The releases there are for its CLI. `a2a-server-lf` is `0.5.3` in `Cargo.toml` on `main` | Yes: "a Rust workspace for the A2A v1 protocol" | Yes, on `axum` |

**Related, not SDKs:** [`a2a-tck`](https://github.com/a2aproject/a2a-tck), the compatibility kit the profile already discusses, and [`a2a-inspector`](https://github.com/a2aproject/a2a-inspector).

**What wasn't checked:** how each SDK's default server behaves on the points in section 4 and 5, other than the JavaScript one. In particular, whether the others deduplicate `messageId`, and when their default handlers move a task to `WORKING`. Podster's own rule that nothing is ported from other projects (CLAUDE.md) doesn't stop a Runner from depending on an SDK, as the gateway does.

## What Podster relies on that the spec leaves optional

Each of these is something a conformant A2A 1.0 server may do differently and still be conformant. A Runner spec has to say them outright.

1. **Answer `SendMessage` with a `Task`, never a bare `Message`.** The spec lets the agent choose. A `Message` answer leaves Podster with nothing to poll.
2. **Hold a new task at `SUBMITTED` until the Runner decides to take it, and report `WORKING` only as acceptance.** The spec attaches no meaning to the move, and a typical SDK server reports `WORKING` as soon as its executor starts. A Runner built that way would accept every offer it receives. `REJECTED` is the spec's own state for "won't do it" and maps to a decline.
3. **Deduplicate on `messageId`.** It's a MAY. Without it, a retried offer makes an orphan task.
4. **Put results in artifacts.** It's a SHOULD. Podster falls back to the last agent message in history, which the spec says a client must not rely on.
5. **Accept `text/markdown` text parts.** A server may refuse a media type it doesn't list.
6. **Generate task IDs and `contextId`s of at most 256 bytes of printable ASCII with no whitespace.** The spec puts no format on either ("e.g. UUID"). Podster treats a task ID outside that as a failed send, and silently drops a `contextId` outside it.
7. **Return a `contextId` on the task.** Generating one is a MAY. Without it, a change request goes out with a reference but no context.
8. **Use `referenceTaskIds` to tie a change request to the earlier work.** It's a SHOULD.
9. **Keep each task readable for as long as Podster polls it,** which is up to 7 days, at intervals up to an hour. The spec lets a server purge tasks and sets no retention.
10. **Keep answers within Podster's caps:** 64 KB in all, 10 artifacts, 8 parts in each artifact or message, 16 KB of text. The spec has no size limits, and Podster refuses a whole answer past any of them.
11. **Accept Podster's credential.** A signed request and an optional bearer token aren't something a stock SDK server checks. The spec only says to authenticate against whatever the server declares.
12. **Answer within the send timeout.** "Immediately" has no number in the spec.

## Mismatches with ADR 0007

1. **"A server may ignore `returnImmediately`" isn't what the spec says.** The ADR and decision 174 say the spec allows it. Spec 3.2.2 says a non-blocking send "MUST return immediately after creating the task, even if processing is still in progress". The spec allows two narrower things: a direct `Message` answer, where the field has no effect, and a task that happens to be finished already. A server that waits for the work, as LangGraph's does, isn't following that MUST. Podster tolerating it does no harm, and is good practice against real servers. The wording is what's off, and a Runner shouldn't copy the behavior, because Podster's send would time out on real work.
2. **A not-found answer can switch an endpoint off.** `CancelTask` treats only `-32002` and a task result as final (Code, `process_cancel`). Any other error, `TaskNotFoundError` (`-32001`) included, is a failure that counts toward the three that switch the endpoint off, and is retried. The spec expressly allows `TaskNotFoundError` for a repeated cancel of a purged task (Spec 3.3.1), and for any expired task (Spec 3.3.2). The same holds for `GetTask`, where any JSON-RPC error is a failed read. So a Runner that restarts and loses its tasks, then correctly answers "not found", is penalized as if it were down. Either the Runner must keep tasks durably, or Podster should treat `-32001` as an answer. That's the map's open "Recovery" item.
3. **Podster treats every non-2xx response as a failure, and the spec doesn't fix the HTTP status of a JSON-RPC error.** Section 9 says nothing about it. The JavaScript SDK's Express handler answers 200 for protocol errors and 500 for server faults ([`json_rpc_handler.ts@v1.3.0`](https://github.com/a2aproject/a2a-js/blob/v1.3.0/src/server/express/json_rpc_handler.ts)). A Runner must answer `TaskNotCancelableError` with HTTP 200, or Podster won't see the code and will retry the cancel.
4. **`INPUT_REQUIRED` is a dead end outbound.** The spec's model is that the client replies on the same task. Podster posts the question to the thread and has no path that sends a `SendMessage` with that `taskId`. The remote task stays interrupted until the 7-day limit. The ADR doesn't claim otherwise, so this is a gap, not a contradiction. It's the map's open "Progress" item.
5. **The ADR cites "spec 7.6.4", which isn't in `v1.0.0`.** See below.

**No mismatch found** in the wire shapes: the method names, `result.task` and `result.message`, `ROLE_USER`, the `TASK_STATE_*` names, `-32002`, `historyLength` 0 and 1, the `A2A-Version` header, and the section numbers the ADR cites for 3.1.1, 3.3.1, 3.6.2 and 7.4.

## Version drift

- **`/latest/` isn't a release.** It's built from `main`, which is ahead of both `v1.0.0` (2026-03-12) and `v1.0.1` (2026-05-28). A `v1.1.0-rc` tag exists. The ADR links `/latest/`.
- **Section 7.6.4, "In-Task Authorization Scope",** is on `main` and `/latest/` only. It isn't in `v1.0.0` or `v1.0.1`, where 7.6 ends at 7.6.3. It's the text that says `AUTH_REQUIRED` "MUST NOT" be treated as authorization by itself. Podster's behavior matches it. The citation just can't be followed in the version Podster says it supports.
- **`v1.0.1` changed text that matters to a server.** Compared with `v1.0.0`, by diff of the two tagged sources:
  - `AgentInterface.tenant`: when a card sets it, clients MUST send that value in every request's `tenant`. Podster reads no card and sends no `tenant`, so a Runner must not depend on one.
  - JSON-RPC `error.data`: each entry MUST have an `@type`. Including `ErrorInfo` went from MUST to SHOULD for JSON-RPC.
  - Several HTTP and gRPC status mappings changed. JSON-RPC codes didn't.
  - State names are written `TASK_STATE_*` throughout. `v1.0.0`'s prose still uses names like `working` in places, but Proto and Spec 5.5 are clear that the wire value is the full name.
- **The `v1.0.0` source file's own title says "Release Candidate v1.0".** The published `/v1.0.0/` page doesn't. Whether `/v1.0.0/` is built from the `v1.0.0` or the `v1.0.1` tag is **unverified**: the page was too long to read to the sections that differ.

## Unverified

- Published package versions on each language's registry, as opposed to GitHub releases.
- That `a2a-java` 1.x implements spec 1.0. Its README doesn't say.
- How the Python, Java, Go, .NET and Rust SDK servers handle a repeated `messageId`, `referenceTaskIds`, or the move to `WORKING`.
- Which tag the published `/v1.0.0/` page is built from.
- Whether an `apiKeySecurityScheme` is an acceptable declaration of Podster's signature header.
- That no part of the spec states an HTTP status for JSON-RPC errors. Section 9 and a search of the whole file found none, which isn't proof.
- What the compatibility kit requires of `ListTasks` or of any point above. Its source wasn't read for this note.
