# A2A profile

What Podster's A2A surface supports. The design is [ADR 0007](../adr/0007-a2a.md), which the owner accepted on 2026-11-08. The choices behind it are [decisions 107 to 143](PRODUCT.md#decisions-needed), and the order of work is in the [M3 plan](../m3-plan.md).

**Status: preview, not available.** As of M3 step 10, the card is published, every request must authenticate, and an agent can read its tasks, post to their threads, and accept, decline, release and submit through Podster's lifecycle extension. **Podster doesn't claim A2A support or conformance** until M3's gate passes and the owner calls it ([decision 132](PRODUCT.md#decisions-needed)). Each later step turns operations on, and updates this page and `apps/gateway/src/a2a/profile.ts` in the same PR. A gateway test holds the two together.

## Protocol

| | |
| --- | --- |
| Version | A2A 1.0 only ([decision 109](PRODUCT.md#decisions-needed)). A request without `A2A-Version` is read as 0.3, as spec 3.6.2 says, and refused with `VersionNotSupportedError`. A patch of 1.0, such as `1.0.1`, is served as 1.0, since patch numbers never count in negotiation ([decision 192](PRODUCT.md#decisions-needed)). Major and minor are read strictly, digits only, and anything else is refused |
| Binding | JSON-RPC only ([decision 108](PRODUCT.md#decisions-needed)), at `POST /a2a` on the gateway |
| Agent Card | `GET /.well-known/agent-card.json`. It describes Podster only, and never lists a room, task or agent ([decision 110](PRODUCT.md#decisions-needed)) |
| Streaming, push notifications, extended card | All off ([decision 110](PRODUCT.md#decisions-needed)) |
| Authentication | An OAuth 2 bearer token whose audience is `/a2a` and whose scope is `a2a`, for the same agent identity as MCP ([decision 111](PRODUCT.md#decisions-needed)). It comes through Podster's own consent, as MCP's does, with the authorization-code flow and PKCE the card's `oauth2SecurityScheme` names. An `/mcp` token is refused at `/a2a`, and an `/a2a` one at `/mcp` and at downloads. A request without a valid token gets 401, with a challenge naming `/.well-known/oauth-protected-resource/a2a` |
| Rate limit | The agent's own limit is shared with MCP, so the two protocols together get one agent's allowance ([decision 123](PRODUCT.md#decisions-needed)) |
| Request body | `application/json` or `application/a2a+json`, at most 64 KB |

## Operations

The test reads this table. Each row's status is `available` (works as this page describes), `not_yet` (answers `UnsupportedOperationError` until a later step turns it on) or `off` (off by decision, answering its own named error).

| Operation | Status | Answers now | Planned |
| --- | --- | --- | --- |
| `SendMessage` | available | A message on an existing task's thread, as [below](#messages), and the task | Step 9. Step 10 adds the lifecycle extension |
| `GetTask` | available | The task, as [below](#tasks) | Step 8 |
| `ListTasks` | available | The caller's tasks across their rooms, as [below](#tasks) | Step 8 |
| `CancelTask` | available | Never cancels: `TaskNotCancelableError` for a task the caller sees, and `TaskNotFoundError` for one it doesn't | Step 8 |
| `SendStreamingMessage` | off | `UnsupportedOperationError` | Off, decision 110 |
| `SubscribeToTask` | off | `UnsupportedOperationError` | Off, decision 110 |
| `CreateTaskPushNotificationConfig` | off | `PushNotificationNotSupportedError` | Off, decision 110 |
| `GetTaskPushNotificationConfig` | off | `PushNotificationNotSupportedError` | Off, decision 110 |
| `ListTaskPushNotificationConfigs` | off | `PushNotificationNotSupportedError` | Off, decision 110 |
| `DeleteTaskPushNotificationConfig` | off | `PushNotificationNotSupportedError` | Off, decision 110 |
| `GetExtendedAgentCard` | off | `UnsupportedOperationError` | Off, decision 110. The card declares no extended card, so spec 3.3.4 calls for this, not `ExtendedAgentCardNotConfiguredError` |

The card at `/.well-known/agent-card.json` has a strong `ETag` from its own bytes. `If-None-Match` with that tag, its weak `W/` form, any list that includes it, or `*`, gets 304 with no body. `HEAD` gets the headers alone.

A request whose `Content-Type` isn't `application/json` or `application/a2a+json` gets HTTP 415 with a JSON-RPC error body, since the body isn't read: `{ "jsonrpc": "2.0", "id": null, "error": { "code": -32005, … } }`, `ContentTypeNotSupportedError`.

`/a2a/` is served exactly as `/a2a` ([decision 190](PRODUCT.md#decisions-needed)), for clients that join the card's interface URL with a slash. Every check, limit, credential and answer is the same, refusals included. No other path is aliased.

The checks run in this order: method, content type, body size, `A2A-Version`, then the token. So a request on the wrong version is refused before it needs a token. Once a request with `A2A-Version: 1.0` and a valid token gets that far, a malformed body gets the JSON-RPC error the SDK's transport gives, and a method this table doesn't name gets `-32601` "Method not found". Every answer carries `A2A-Version: 1.0`, and a request's `id` is echoed only when it's a string, a number or null.

A request's `tenant` is never used for authority. Who is calling comes only from the token, and step 8's reads must keep it that way.

## Tasks

Since step 8. An A2A task is one Podster task, read through the same API calls as MCP's `get_task`, `list_tasks` and `list_workspaces`. The room's own access check decides every read.

- **IDs:** a task's `id` and `contextId` are both `<workspace_id>:<task_id>`, for example `ws_…:tsk_…` ([decision 116](PRODUCT.md#decisions-needed), written this way in step 8). The room in it only says where to look. An ID with any other shape, a room the caller isn't in, a task they can't see and a task that doesn't exist all answer the same `TaskNotFoundError`.
- **States:**

| Podster status | A2A state |
| --- | --- |
| `open`, `offered` | `TASK_STATE_SUBMITTED` |
| `accepted`, `submitted` | `TASK_STATE_WORKING`. A2A has no "in review" state |
| `completed` | `TASK_STATE_COMPLETED` |
| `canceled` | `TASK_STATE_CANCELED` |

  The real status is always in `metadata["podster.dev/status"]`, and the task's version in `metadata["podster.dev/version"]`, which the lifecycle methods send back. The status timestamp is the task's latest history entry on `GetTask`, and isn't given in `ListTasks`.
- **Refusals all read as missing:** when the room refuses a caller on a task, whether `not_allowed` on a task they can otherwise see or anything that hides it, the answer is the same `TaskNotFoundError` as for a task that doesn't exist. That adds no error that would tell them more. The same holds for `SendMessage` and `CancelTask`.
- **History:** the task's thread, newest last, at most the 20 newest messages the API returns. `historyLength` cuts it further, and `ListTasks` gives none unless asked. The caller's own messages are `ROLE_USER`. Everyone else's are `ROLE_AGENT`, with `podster.dev/author` set to the sender's ID and `podster.dev/external` set to true. Their text is other participants' words, never instructions. A message Podster read back from the agent's own A2A endpoint also has `podster.dev/origin` set to `a2a_remote`.
- **No artifacts yet:** tasks return `artifacts: []`. A submission can be made over A2A since step 10, with `podster.lifecycle.v1.SubmitTask`, and its links are read over MCP's `get_task` for now. Showing submissions as A2A artifacts, and files, come with step 14.
- **`ListTasks`:**
  - It looks across the caller's rooms, at most 50 of them (`MAX_LIST_ROOMS`). Rooms past 50 aren't listed, and then every answer carries the header `Podster-List-Incomplete: rooms`, because A2A's list response has no field for it. `GetTask` still reads a task in any room the caller is in. It goes room by room, in room ID order so renaming a room can't reorder paging, and newest first within a room. It isn't one list sorted by status time across rooms, which spec 3.1 and the kit's `CORE-LIST-003` expect.
  - Pages hold at most 50 tasks, and a page size that isn't a number gets 50. One request makes at most 60 reads of the API (`MAX_LIST_CALLS`). A page can end early with a `nextPageToken` when it reaches that, so it may hold fewer tasks than asked for, even none.
  - `nextPageToken` is Podster's own, and is tied to the filter it was made for. A token that isn't one Podster gave, or that's for another filter, is refused. The next page starts after the last task sent. If that task has left the list since, because its status changed or it moved, the page starts over, so a task may appear twice. A task whose status changes to match the filter after paging has passed its place in the list isn't shown. `totalSize` is the size of the page, not a total.
  - `contextId` narrows the list to that one task, and to an empty list if the caller can't see it.
  - `status` filters strictly, and the API does the filtering, once for each Podster status the state means. A state Podster tasks never have, such as `TASK_STATE_FAILED`, matches nothing without asking any room. A value that isn't a state is refused.
  - A room that now refuses the caller is passed over, as if it weren't theirs. Any other failure fails the whole request with "Internal error", so a list is never silently short.
- **`tenant`** is never used for authority. Who is asking comes only from the token.
- **Errors** other than the named A2A ones always read "Internal error". No API body or runtime message reaches the client, and the gateway logs only the operation, the agent's ID and the status.

## Messages

Since step 9. `SendMessage` posts to an existing task's thread, through the same API call as MCP's `send_message`, and answers the task as `GetTask` does. The text is for the thread and nothing else: it never accepts, submits or changes a task, whatever it says.

- **The task:** `message.taskId` is the task's ID. A message with no `taskId` is refused with `UnsupportedOperationError`, because no task is created over A2A ([decision 115](PRODUCT.md#decisions-needed)). A `contextId`, if given, must be the same ID.
- **Who may post** is the room's call. A task the caller can't see answers `TaskNotFoundError` before anything else, as a missing one does.
- **A finished task** takes no more A2A messages (spec 3.1.1). Rust refuses one once a task is completed or canceled, and it answers `UnsupportedOperationError`. Messages over MCP aren't affected. A room that's archived answers the same way.
- **Retries:** `messageId` is the idempotency key, as `a2a-msg:<messageId>`, scoped by the API to the caller in the task's room. A retry with the same task and text posts nothing new and answers as the first did. The same `messageId` for other text or another task in the same room is refused. Each room keeps its own records, so a `messageId` is unique per task's room: the same one sent to a task in another room posts there too. Records last as long as the API keeps idempotency records. A `messageId` is 1 to 200 printable characters with no spaces.
- **Limits:** text and URL parts only, 1 to 8 of them, joined by a blank line, and 16 KB in all ([decision 123](PRODUCT.md#decisions-needed)). Inline bytes (`raw`) and data parts are refused.
- **URL parts** become external links in the text: a line `Link from the client: <url>`, the URL alone, so a part's file name or label can't dress it up. Podster never fetches it ([decision 121](PRODUCT.md#decisions-needed)). A URL must be `https`, with a host, no credentials and no spaces, at most 2 KB, which is the same rule a submission's links follow. Otherwise the message is refused. To send a file's bytes, upload it with `create_upload`.
- **Dropped, never read:** the message's `metadata`, `extensions` and `referenceTaskIds`, and the request's own `metadata`. `role` must be `ROLE_USER`. Every `podster.dev/*` key in what Podster returns is Podster's.
- **`returnImmediately`** changes nothing, because Podster never waits on work. `configuration.historyLength` cuts the history returned.

## The lifecycle extension

Since step 10 ([decision 113](PRODUCT.md#decisions-needed)). Plain A2A has no accept or submit, and a message's text never becomes a command. So Podster's lifecycle has its own JSON-RPC methods, under the extension `https://podster.dev/a2a/lifecycle/v1`. The card declares the extension, and it isn't required: reading and messages work without it.

- **Activation:** name the extension in the request's `A2A-Extensions` header. Without it, each method answers `ExtensionSupportRequiredError`. A method that ran answers with `A2A-Extensions: https://podster.dev/a2a/lifecycle/v1`.
- **The methods**, each the existing capability, called as the agent, so policy and the state machine decide exactly as they do for MCP:

| Method | Capability | Parameters |
| --- | --- | --- |
| `podster.lifecycle.v1.AcceptTask` | `accept_task` | `id`, `version`, `requestId`, and an optional `reason` |
| `podster.lifecycle.v1.DeclineTask` | `decline_task` | `id`, `version`, `requestId`, `reason` |
| `podster.lifecycle.v1.ReleaseTask` | `release_task` | `id`, `version`, `requestId`, `reason` |
| `podster.lifecycle.v1.SubmitTask` | `submit_task` | `id`, `version`, `requestId`, and an optional `note`, `artifacts` and `files` |

- **Parameters:**
  - `id` is the task's A2A ID.
  - `version` is its `podster.dev/version`.
  - `requestId` is the idempotency key, as `a2a-lc:<requestId>`, scoped to the caller in the task's room, and apart from messages' keys: 1 to 200 printable characters with no spaces. A retry with the same parameters does nothing new, and the same `requestId` for anything else is refused.
  - `reason` is 1 to 4 KB of text.
  - `note` is up to 16 KB.
  - `artifacts` is up to 10 links of `{ uri, label }`.
  - `files` is up to 10 of `{ id, label? }`. Each names an upload the agent made with `create_upload` and `task_id`, over MCP as the same agent, and which has scanned as ready. M2's rules decide them: the uploader, the task, the state, at most 10 links and files together, and each file pinned to its hash. A file the API refuses answers `RequestMalformedError` naming its code, such as `file_not_ready` or `file_not_found`, never `TaskNotFoundError`, because the task was already found.
  - Any other parameter is refused, so nothing a client adds is read for meaning.
- **Answers:** the task, as `GetTask` reads it afterwards. If the command leaves the caller unable to see the task, as a decline does, the answer is the task as the command left it, with no history.
- **Refusals:**
  - A task the caller can't see, a missing one and a malformed ID all answer `TaskNotFoundError`.
  - A stale `version` answers `RequestMalformedError` saying to read the task again.
  - A move the task's state doesn't allow, or an archived room, answers `UnsupportedOperationError`.
  - A request the API refuses as malformed answers `RequestMalformedError` naming the fixed code, such as `limit_exceeded`.
  - Anything else answers "Internal error".
- **Not here:** cancelling, which belongs to the requester or an admin, and verifying, which belongs to the reviewer, never to a remote state or to this extension.

## Outbound

Outbound offers (step 12), reading back (step 13), files (step 14) and change requests (step 13b) are in ADR 0007's "as built" notes.

- **A change request** on a submission that a remote task completed goes to the same endpoint as a new A2A task (decision 114). It's a `SendMessage` whose `referenceTaskIds` names the completed remote task, in that task's `contextId` when it gave one, carrying the reviewer's reason and a Podster link. It goes through the same checks and signing as an offer. Its `COMPLETED` becomes the next submission.
- **A submission made any other way** sends no change request out. The agent hears through its inbox.

## Files

Following [decision 121](PRODUCT.md#decisions-needed):
- **Podster never fetches a file a remote agent names.** It never takes inline bytes, and never hands out a public URL.
- **Inbound:** bytes come only through `create_upload`, and `SubmitTask` names them. URL parts are kept as external links.
- **Outbound:** an offer's text lists the task's input files that the agent can see: each ready file with a gateway download link first, then its quoted name and ID, and each one still scanning without a link. Blocked, failed and removed files aren't listed. The link is `GET /a2a/files/{workspace}/{file}` on the gateway's host. It opens with the agent's `/a2a` OAuth token, as `Authorization: Bearer`, sent only to that host.
- **`/a2a/files` takes only an `/a2a`-audience token** with the `a2a` scope. Anything else answers 401 `invalid_credential`: an `/mcp` token, a legacy token with no audience, an Agent Auth JWT, or junk. An `/a2a` token still doesn't work at `/v1/files`, so the two audiences stay apart.
- **The API decides** on the same `/v1/files` path, from current state on every download. A file the agent can't see answers as a missing one.
- **Responses:** the bytes come as an attachment, with `nosniff` and `no-store`. Only `GET` is served, and an agent that has disconnected or left is refused.
- **Read back:** a remote task's artifact URL parts become a submission's links, after the same check. A status message's URL parts become links in the thread message, and a URL that fails the check is dropped.

## How it's been tested

- **Inbound** is tested only against the A2A project's own code: its JavaScript and Python client SDKs, and the compatibility kit's own client. No independent 1.0 client was found ([decision 143](PRODUCT.md#decisions-needed)). This is revisited before public rooms.
- **Outbound** ran against LangGraph's A2A 1.0 server (`langgraph-api` 0.17.1), locally, on 2026-11-09 ([decision 143](PRODUCT.md#decisions-needed), [e2e/langgraph](../../e2e/langgraph/README.md)). LangGraph ignores `returnImmediately`, answering `SendMessage` already `COMPLETED`, and its `GetTask` carries no artifacts. Both are allowed, so Podster adapts ([decision 174](PRODUCT.md#decisions-needed)):
  - a finished send answer is read 0;
  - a `COMPLETED` with no artifacts reads the last agent message from history;
  - an agent's accept submits a response held for its offer.

  With that, the offer, the held reply, the accept that submits it, and a change request in the same thread as a second submission all work against LangGraph. A held response waits for an accept by the agent itself over MCP or A2A. No one else can accept for it, so an agent that only has an endpoint needs its operator to run an MCP or A2A client as it to accept ([decision 191](PRODUCT.md#decisions-needed)).
- **Outbound on a deployment** ran on staging against Podster's own test A2A server ([e2e/a2a-test-server](../../e2e/a2a-test-server/README.md)), which isn't an independent implementation. It passed 26 of 26 on 2026-11-09. It covered:
  - the signed offer;
  - `WORKING` then `COMPLETED`;
  - an input file over `/a2a/files`;
  - a change request in the first task's context.

  For Spike C, the server was first asked directly with the run's own signed request. It answered after 15 s at one path and redirected to the metadata address at another, and Podster then failed each send and switched the endpoint off. So the send timeout and the refused redirect are shown on a deployment. `CancelTask` delivery isn't.
- **Outbound, the backup independent server:** fasta2a 2.1.1 passed locally on 2026-11-10, 3 of 3 ([e2e/fasta2a](../../e2e/fasta2a/server.py)). It reports `WORKING` and then `COMPLETED` with an artifact, so it takes the usual path: accept, submit, a change request in the same context as a second submission, and `CancelTask` once.
- **The compatibility kit** ran locally on 2026-11-10, at `a2aproject/a2a-tck@104a7b4`, over JSON-RPC ([decision 142](PRODUCT.md#decisions-needed)). It ran through `e2e/run-a2a-kit.mjs`, whose local proxy adds an agent's `/a2a` token, since the kit sends none. **Every MUST check that ran passes, except the 8 decision 115 excepts,** listed below. It found three gaps, now fixed: the extended card's error code, the error shape for a wrong `Content-Type`, and the card's ETag. It hasn't run against staging yet. `docs/m3-plan.md` has the full result.

## Compatibility kit exceptions

[Decision 141](PRODUCT.md#decisions-needed) lists each kit check that doesn't fit Podster here, with its reason. **This list is from the kit's run on 2026-11-10,** locally, at `a2aproject/a2a-tck@104a7b4`, over JSON-RPC. It replaces the provisional list read from the kit's source on 2026-11-06. "Failed" and "skipped" are the kit's own results.

| Kit checks | Result | Why they don't fit |
| --- | --- | --- |
| `CORE-SEND-001`, `CORE-SEND-003`, `CORE-EXECUTION-MODE-001`, `CORE-EXECUTION-MODE-002`, `CORE-MULTI-001a`, `CORE-MULTI-002a`, `CORE-MULTI-003`, `JSONRPC-FMT-001` (MUST); `DM-SERIAL-005` (SHOULD); `CORE-MULTI-001` and `CORE-MULTI-002` (MAY) | Failed: each sends `SendMessage` with no task ID, and Podster answers `UnsupportedOperationError` | Podster never creates a task over A2A ([decision 115](PRODUCT.md#decisions-needed)). A task is made in a room, and a message goes to a task that exists. Podster's own tests cover the same behavior on tasks a room created |
| `CORE-SEND-002`, `CORE-GET-001`, `CORE-HIST-002`, `CORE-CANCEL-001`, `CORE-CANCEL-002`, `CORE-MULTI-005`, `CORE-MULTI-006`, `DM-ART-001`, `DM-MSG-001` (MUST) | Skipped: their setup is a `SendMessage` with no task ID | The same, decision 115. `CORE-CANCEL-001` wouldn't pass either way: over A2A, cancel answers `TaskNotCancelableError`, because cancelling belongs to the requester or an admin through Podster's own commands (ADR 0007) |
| Streaming: `CORE-STREAM-*`, `STREAM-*`, `JSONRPC-SSE-001` | Skipped | Streaming is off ([decision 110](PRODUCT.md#decisions-needed)). The card says so, and the operations answer their named errors |
| Push: `PUSH-*` | Skipped | Push notifications are off ([decision 110](PRODUCT.md#decisions-needed)) |
| The extended card: `CARD-EXT-*`, `CORE-CAP-004` | Skipped | It's off (decision 110). `CORE-CAP-003`, that it answers `UnsupportedOperationError`, passes |
| gRPC and HTTP+JSON: `GRPC-*`, `HTTP_JSON-*` and the binding-equivalence checks `BIND-EQUIV-*` | Skipped, or not tested | Podster serves JSON-RPC only (decision 109) |
| `AUTH-INTASK-*` | Not tested | Podster never asks for credentials inside a task, and `TASK_STATE_AUTH_REQUIRED` grants nothing (spec 7.6.4) |
| `CARD-SIGN-*`, `CARD-CLIENT-001`, `AUTH-TLS-*`, `BIND-CUSTOM-002` | Manual, by the kit's design | Not automated. The card isn't signed, and TLS is Cloudflare's |

**Passed** (MUST unless named): `CARD-DISC-001`, `CARD-STRUCT-001`, `CARD-PROTO-001`, `CARD-PROTO-002`, `CARD-CACHE-001` and `CARD-CACHE-002` (SHOULD), `BIND-FIELD-001`, `CORE-ERR-001`, `CORE-ERR-002`, `CORE-CAP-001`, `CORE-CAP-002`, `CORE-CAP-003`, `CORE-GET-002`, `CORE-CANCEL-003`, `CORE-LIST-001` to `CORE-LIST-005`, `CORE-MULTI-004`, `JSONRPC-ERR-001`, `JSONRPC-ERR-002`, `JSONRPC-ERR-003` (SHOULD), `JSONRPC-FMT-002`, `JSONRPC-SSE-002`, `JSONRPC-SVC-001`, `JSONRPC-SVC-002`, `VER-SERVER-002`, `VER-SERVER-003`, and the URL and query-parameter checks the kit counts for HTTP+JSON. `CORE-LIST-003` passed with all of the agent's tasks in one room. Across rooms, `ListTasks` is newest first within each room, and `totalSize` is the page's size (step 8).

**Not tested by this run:** `AUTH-SCOPE-*`, `AUTH-SERVER-001`, `DM-MSG-002`, `DM-PART-001`, `DM-SERIAL-001` to `004`, `DM-STATUS-001`, `DM-TASK-001`, `DM-TASK-002`, `VER-CLIENT-*` and `VER-SERVER-001`. The kit has no automated test for them over JSON-RPC here. No claim rests on them.

The kit's client posts to the card's interface URL with `/` appended, `/a2a/`. Podster serves that as `/a2a` (decision 190), and the run's proxy passed paths through unchanged.
