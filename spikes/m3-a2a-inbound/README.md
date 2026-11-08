# Spike A: inbound A2A on a Worker

M3's first spike, from the [M3 plan](../../docs/m3-plan.md#spikes). It's a throwaway experiment, local only ([decision 126](../../docs/spec/PRODUCT.md#decisions-needed)), and not product code. It asks whether a Worker can serve A2A 1.0 over JSON-RPC to real clients, and whether the project's JavaScript SDK server code runs on Workers ([decision 128](../../docs/spec/PRODUCT.md#decisions-needed)).

```bash
npm install
npm test           # 14 tests in workerd
npm run dev        # then, in another shell:
node clients/js-client.mjs
python clients/py_client.py   # needs a2a-sdk 1.3.0 and httpx
```

## What it is

- `src/index.ts`: the Worker. It serves the Agent Card, and on `POST /a2a` it authenticates, checks the body and the `A2A-Version` header, then hands the request to the SDK's `JsonRpcTransportHandler`.
- `src/handler.ts`: an `A2ARequestHandler` written for Podster. It's not the SDK's `DefaultRequestHandler`, which runs an executor and its own task store.
- `src/room.ts`: an in-memory stand-in for one room, so reads, visibility and messages behave like Podster from outside. Rust decides none of it here, so it shows the protocol layer only.
- Bearer tokens come from a fixed list in `wrangler.jsonc` and stand in for spike B's OAuth audience.

## Results, 2026-11-08 UTC

All against `@a2a-js/sdk` 1.3.0 and `a2a-sdk` 1.3.0 for Python, which both speak protocol version 1.0.

| Check | Result |
| --- | --- |
| Tests in workerd (`npm test`) | **14 passed** |
| The project's JavaScript client, in Node, unpatched | **8 passed**: card, `GetTask`, `SendMessage` to a task, scoped `ListTasks`, a hidden task refused, no `taskId` refused, streaming off, and the outsider |
| The project's Python client, unpatched | **6 passed**: card, `GetTask`, `SendMessage`, scoped `ListTasks`, a hidden task refused, no `taskId` refused, and the outsider |
| A request with no version | Refused with `VersionNotSupportedError`, as 0.3 (spec 3.6.2). Both SDK clients send `A2A-Version: 1.0` by themselves |
| The compatibility kit | **Not run.** See [below](#the-compatibility-kit) |
| Time per request, locally | p50 about 2.5 to 2.8 ms and p95 about 5.5 to 7.5 ms over 200 calls each to `GetTask`, `ListTasks` and `SendMessage` against `wrangler dev`. That's wall time on one Mac with an in-memory room, not CPU on a deployment |
| Worker size | 128 KiB, 21 KiB gzipped, with the SDK's server code |

**The two client libraries come from one project,** so they count as one implementation under [decision 124](../../docs/spec/PRODUCT.md#decisions-needed). They're in different languages and share no code, but they may share a reading of the spec.

## Findings

1. **The SDK's server code runs on Workers.** `JsonRpcTransportHandler`, `validateVersion` and the error classes run in workerd with `nodejs_compat`, which the gateway already sets. They need `Buffer`, and nothing Node-only beyond that. The Express adapter isn't needed, because the Worker does the HTTP part in about 60 lines. Under decision 128 that means the gateway can use the SDK rather than a fresh JSON-RPC layer.
2. **Use the SDK's transport, not its request handler.** `DefaultRequestHandler` runs an executor and keeps its own task store, so it would make Podster run work and hold a second copy of tasks. Implementing `A2ARequestHandler` directly lets each operation become one Podster command or read.
3. **Inbound A2A turns the roles around.** A2A assumes the client hands work to the server. Inbound, the client is the room's assignee and Podster only records. So Podster's A2A task state is the Podster task's state, the caller's own messages are `ROLE_USER`, and everyone else's are `ROLE_AGENT` with `podster.dev/external` set. ADR 0007 needs to say this plainly.
4. **A2A has no "submitted for review" state.** `submitted` shows as `TASK_STATE_WORKING`, and the real status is always in `metadata["podster.dev/status"]`. `open` and `offered` both show as `SUBMITTED`. The mapping is in `src/handler.ts`, and step 5 has to own it in Rust.
5. **The JavaScript client sends `"status": "UNRECOGNIZED"` when a caller leaves `status` out** of `ListTasks`. Read as a filter, that silently matched nothing, so the server now refuses an unknown state instead of answering with an empty list.
6. **Clients fall back by themselves.** With `streaming: false` on the card, both clients' streaming calls turned into one `SendMessage`, so nothing reached `SendStreamingMessage`. A raw caller still gets `UnsupportedOperationError`.
7. **Cancel has no clean answer.** `CancelTask` from a participant can't cancel anything, because cancelling belongs to the requester or an admin. The spike answers `UnsupportedOperationError`, and `TaskNotFoundError` for a hidden task. The spec also has `TaskNotCancelableError`, so the ADR should pick one.
8. **A retried `messageId` posts once,** and a reused one with different text is refused. The key is the sender plus `messageId`, as an idempotency key would be.

## The compatibility kit

**It didn't run.** Installing and running the kit's own code from its clone was refused by this session's permission check. I didn't work around that. The owner can allow it, or run it by hand:

```bash
./run_tck.py --sut-host http://localhost:8787 --transport jsonrpc
```

Reading its source at `a2aproject/a2a-tck@104a7b4` from 2026-11-06 instead, without running it, shows it won't fit Podster as it is:

- **It creates its own tasks.** Most core checks start with `SendMessage` and no `taskId`, using message IDs such as `tck-complete-task` that tell the server what to do. Podster refuses that under [decision 115](../../docs/spec/PRODUCT.md#decisions-needed), so those checks skip or fail.
- **It sends no credentials.** Its clients have no option for a token, so on a server that authenticates every request, as spec 7.4 requires, every call gets 401. Running it needs a local-only switch that treats an unauthenticated caller as one agent. That would never ship.
- **A rough count of its MUST checks,** skipping gRPC and HTTP+JSON, from a script that matches requirement IDs to tests: about 19 could pass as Podster is, covering the card, error shapes, capability errors and version handling. About 45 need a task the kit creates, or push or streaming. About 41 the script couldn't link to a test, which may only be a limit of the script.

So [decision 125](../../docs/spec/PRODUCT.md#decisions-needed)'s bar, every MUST passing or each exception listed with its reason, can't be met with the kit unchanged. The choices are listing about 45 exceptions, or a test-only room where the kit's prefixes create and finish tasks. That second choice would change Podster's behavior under test, so it's a question for the owner.

## Candidates for the second implementation

Decision 124 needs one agent framework from outside the A2A project. From package metadata only, on 2026-11-08 UTC:

| Framework | What its package says | Fit |
| --- | --- | --- |
| Pydantic AI's `fasta2a` 2.1.1 | No dependency on `a2a-sdk`, so it's its own implementation | **Check first.** Whether it has a client, and speaks 1.0, is unchecked |
| LangGraph's `langgraph-api` 0.17.1 | No dependency on `a2a-sdk` | **Check.** It may be server-only |
| CrewAI 1.15.37 | `a2a-sdk~=0.3.10` | Speaks 0.3, which decision 109 refuses |
| Google ADK 2.14.0 | Built on `a2a-sdk` | Not independent of the project |
| Microsoft Agent Framework (`agent-framework-a2a` 1.0.0b) | Built on `a2a-sdk` 1.x | Not independent of the project |

## Not proven

- **Nothing ran on a deployment,** so real CPU, latency and the edge are unmeasured.
- **The kit didn't run.**
- **No outside framework ran.** The two clients are from one project.
- **The room is a stand-in.** Rust policy, the `Workspace` DO, the outbox and idempotency records weren't involved, so a message here changes no real state.
- **Auth is a fixed list of tokens.** Spike B tests the real audience.
- **Only text parts.** File references and inline bytes are refused, as [decision 121](../../docs/spec/PRODUCT.md#decisions-needed) says, and turning a URL into an external link isn't built.
