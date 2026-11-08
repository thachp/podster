# A2A profile

What Podster's A2A surface supports. The design is [ADR 0007](../adr/0007-a2a.md), which the owner accepted on 2026-11-08. The choices behind it are [decisions 107 to 143](PRODUCT.md#decisions-needed), and the order of work is in the [M3 plan](../m3-plan.md).

**Status: preview, not available.** As of M3 step 6, the card is published and every operation answers a named error. **Podster doesn't claim A2A support or conformance** until M3's gate passes and the owner calls it ([decision 132](PRODUCT.md#decisions-needed)). Each later step turns operations on, and updates this page and `apps/gateway/src/a2a/profile.ts` in the same PR. A gateway test holds the two together.

## Protocol

| | |
| --- | --- |
| Version | A2A 1.0 only ([decision 109](PRODUCT.md#decisions-needed)). A request without `A2A-Version` is read as 0.3, as spec 3.6.2 says, and refused with `VersionNotSupportedError` |
| Binding | JSON-RPC only ([decision 108](PRODUCT.md#decisions-needed)), at `POST /a2a` on the gateway |
| Agent Card | `GET /.well-known/agent-card.json`. It describes Podster only, and never lists a room, task or agent ([decision 110](PRODUCT.md#decisions-needed)) |
| Streaming, push notifications, extended card | All off ([decision 110](PRODUCT.md#decisions-needed)) |
| Authentication | Not yet. Step 7 adds an OAuth 2 bearer token whose audience is `/a2a` and whose scope is `a2a`, for the same agent identity as MCP ([decision 111](PRODUCT.md#decisions-needed)). Until then the card declares no security scheme, because every operation refuses |
| Request body | `application/json` or `application/a2a+json`, at most 64 KB |

## Operations

The test reads this table. Each row's status is `not_yet` (answers `UnsupportedOperationError` until a later step turns it on) or `off` (off by decision, answering its own named error).

| Operation | Status | Answers now | Planned |
| --- | --- | --- | --- |
| `SendMessage` | not_yet | `UnsupportedOperationError` | Step 9: a message on an existing task's thread. Step 10 adds the lifecycle extension |
| `GetTask` | not_yet | `UnsupportedOperationError` | Step 8: `get_task` |
| `ListTasks` | not_yet | `UnsupportedOperationError` | Step 8: `list_tasks`, scoped to the caller |
| `CancelTask` | not_yet | `UnsupportedOperationError` | Step 8: `TaskNotCancelableError` for any task the caller sees, and `TaskNotFoundError` for one it doesn't |
| `SendStreamingMessage` | off | `UnsupportedOperationError` | Off, decision 110 |
| `SubscribeToTask` | off | `UnsupportedOperationError` | Off, decision 110 |
| `CreateTaskPushNotificationConfig` | off | `PushNotificationNotSupportedError` | Off, decision 110 |
| `GetTaskPushNotificationConfig` | off | `PushNotificationNotSupportedError` | Off, decision 110 |
| `ListTaskPushNotificationConfigs` | off | `PushNotificationNotSupportedError` | Off, decision 110 |
| `DeleteTaskPushNotificationConfig` | off | `PushNotificationNotSupportedError` | Off, decision 110 |
| `GetExtendedAgentCard` | off | `ExtendedAgentCardNotConfiguredError` | Off, decision 110 |

A malformed request gets the JSON-RPC error the SDK's transport gives, and an unknown method gets "method not found".

## What's planned, from ADR 0007

None of this is built yet:

- **Tasks:** an A2A task is a Podster task, with `id` and `contextId` both the Podster task ID ([decision 116](PRODUCT.md#decisions-needed)).
- **States:** `submitted` shows as `TASK_STATE_WORKING`, and the real status is always in `metadata["podster.dev/status"]`.
- **Messages:** the caller's own are `ROLE_USER`, and everyone else's are `ROLE_AGENT`, marked `podster.dev/external`.
- **Limits:** text parts only, at most 8, and 16 KB in all ([decision 123](PRODUCT.md#decisions-needed)).
- **No new tasks:** a message without a `taskId` is refused, because no task is created over A2A ([decision 115](PRODUCT.md#decisions-needed)).
- **Lifecycle:** accepting, declining, releasing and submitting go through the extension `https://podster.dev/a2a/lifecycle/v1` ([decision 113](PRODUCT.md#decisions-needed)).
- **Outbound:** offers go to a registered endpoint under ADR 0007's rules for outbound offers.

## How it's been tested

- **Inbound** is tested only against the A2A project's own code: its JavaScript and Python client SDKs, and the compatibility kit's own client. No independent 1.0 client was found ([decision 143](PRODUCT.md#decisions-needed)). This is revisited before public rooms.
- **Outbound** is to be tested against LangGraph's A2A 1.0 server, with fasta2a's as backup. **That hasn't run.**
- **The compatibility kit hasn't run.** The session permission check refuses running its code, and the owner won't run it by hand ([decision 142](PRODUCT.md#decisions-needed)). Nothing here claims what a kit run would show.

## Compatibility kit exceptions

[Decision 141](PRODUCT.md#decisions-needed) lists each kit check that doesn't fit Podster here, with its reason. **The list below is provisional.** It comes from reading the kit's source at `a2aproject/a2a-tck@104a7b4`, from 2026-11-06, not from running it. It covers only its JSON-RPC, core, data model, push, streaming, card and versioning MUST checks. It becomes final once the kit has run, which [decision 142](PRODUCT.md#decisions-needed) owes before M3's gate.

| Kit checks | Why they don't fit |
| --- | --- |
| Checks whose setup creates a task with `SendMessage` and no `taskId`, using the kit's `tck-*` message prefixes: `CORE-SEND-001`, `CORE-SEND-002`, `CORE-SEND-003`, `CORE-GET-001`, `CORE-HIST-002`, `CORE-CANCEL-002`, `CORE-MULTI-001a`, `CORE-MULTI-002a`, `CORE-MULTI-003`, `CORE-MULTI-005`, `CORE-MULTI-006`, `CORE-EXECUTION-MODE-001`, `CORE-EXECUTION-MODE-002`, `JSONRPC-FMT-001`, `JSONRPC-FMT-002`, `JSONRPC-SVC-001`, `JSONRPC-SVC-002`, and the `DM-*` data-model checks | Podster never creates a task over A2A ([decision 115](PRODUCT.md#decisions-needed)), and doesn't run work the way the kit's scenarios expect, because agents own execution. The behavior these checks look at is covered by Podster's own tests on tasks a room created |
| `CORE-CANCEL-001`: cancel returns the canceled task | Over A2A, cancel always answers `TaskNotCancelableError`, because cancelling belongs to the requester or an admin through Podster's own commands (ADR 0007) |
| Streaming checks: `CORE-STREAM-*`, `STREAM-*` and `JSONRPC-SSE-001` | Streaming is off ([decision 110](PRODUCT.md#decisions-needed)). The card says so, and the operations answer their named errors |
| Push notification checks: `PUSH-*` | Push notifications are off ([decision 110](PRODUCT.md#decisions-needed)) |
| Any check, while the kit sends no credentials | From step 7 every request must authenticate, as spec 7.4 requires, and the kit's clients have no option to send a token. Running the kit needs a way to pass one, and Podster won't add an unauthenticated mode to its real service |
| The `AUTH-INTASK-*` checks | Podster never asks for credentials inside a task, and `TASK_STATE_AUTH_REQUIRED` grants nothing (spec 7.6.4) |

Checks expected to apply as Podster is, from the same reading: the card checks (`CARD-*`, except signing, which is manual), JSON-RPC error shapes (`JSONRPC-ERR-*`, `JSONRPC-SSE-002`), the capability errors (`CORE-CAP-*`), input validation (`CORE-ERR-*`), versioning (`VER-SERVER-*`), and `BIND-FIELD-001`.
