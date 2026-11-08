# Spike C: outbound send and read-back, local half

M3's third spike, from the [M3 plan](../../docs/m3-plan.md#spikes). It's a throwaway experiment, local only ([decision 126](../../docs/spec/PRODUCT.md#decisions-needed)), and not product code. Nothing ran on staging, and no queue was created ([decision 129](../../docs/spec/PRODUCT.md#decisions-needed)).

```bash
npm install
npm test        # 10 tests in workerd, with a local queue
```

## What it is

- **`src/index.ts`** is Podster's side. An offer is a queue message carrying IDs only ([decision 118](../../docs/spec/PRODUCT.md#decisions-needed)). The consumer then:
  - reads the task fresh and checks it's still offered and still has an endpoint;
  - checks the endpoint against the egress rules;
  - sends `SendMessage` with `returnImmediately`, a timeout and `redirect: "manual"`;
  - records the remote task;
  - queues `GetTask` reads until a terminal state, or until the read limit, which stands in for the 7 days in [decision 117](../../docs/spec/PRODUCT.md#decisions-needed).
  Each remote state goes through a sketch of step 5's mapping, which records what Podster would do and never verifies. State is in KV, standing in for the room.
- **`src/egress.ts`** has `crates/egress`'s wake rules, written again in TypeScript for the spike only. In M3 the check stays in Rust ([decision 134](../../docs/spec/PRODUCT.md#decisions-needed)).
- **`test/remote.ts`** has the remote agents, in Node, on the A2A project's JavaScript SDK server. The test pool routes the Worker's real outbound `fetch` to them, each host behaving differently: steady, answering at once, rejecting, redirecting, or too slow.

## Results, 2026-11-08 UTC

| Check | Result |
| --- | --- |
| Tests in workerd (`npm test`), through a real local queue | **10 passed** in about 6 s |
| Steady agent | `SUBMITTED`, `WORKING`, then `COMPLETED`, which maps to accept and then a submission. Never a verify |
| Agent that completes at once, with no `WORKING` | Held as an unaccepted response, as [decision 112](../../docs/spec/PRODUCT.md#decisions-needed) says |
| Agent that rejects | Maps to a decline |
| `http`, an IP address, a `podster.dev` name | Refused before sending. The remote counted no request |
| The egress rules on their own | Matches `crates/egress`'s cases, including `2130706433` and `0x7f.1` arriving as IPv4 |
| Redirect to `169.254.169.254` | Not followed, and recorded as a failed delivery |
| Agent slower than the 500 ms timeout | Given up on. The message goes back to the queue, which is set to retry once. The test checks the timeout, not the count of retries |
| Task accepted by MCP before its turn in the queue | Nothing sent |
| Logs | IDs only: no task text, and no endpoint |
| The task's text reaches the agent | Yes, read at send time |
| The same `messageId` sent twice | **The SDK server made two tasks.** It doesn't remove duplicates, which spec 3.3.1 allows |

## Findings

1. **A remote agent may not remove duplicates, so Podster keys each send on its own attempt record.** A redelivered queue message for a send that already went out sends nothing. But a send that times out after the remote received it, and is then retried, can leave two remote tasks. Podster only knows the second. ADR 0007 should say Podster records only the remote task it got an answer for, and ignores updates for any other.
2. **`returnImmediately` worked with this server:** the response came back at `SUBMITTED` while the agent kept working. Without it, the SDK server would hold the consumer until the task ended.
3. **Reading back fits the queue.** Each read is one queued job with its own delay. A redelivered read is skipped by its number, and the last read ends the reads. Decision 117's 1-minute to 1-hour backoff is a list of delays.
4. **What's read is mapped, never trusted.** `COMPLETED` only becomes a submission after `WORKING`. `FAILED` before acceptance is a decline, and after it a release. `AUTH_REQUIRED` is only a thread message. Unknown states are ignored.
5. **The text of an offer is the one thing that leaves Podster with content in it.** It's read after the access check at send time, so a task that moved on while queued sends nothing. Nothing in the queue or the logs holds it.
6. **A 500 ms timeout is a spike value.** Wake uses 10 s. The real value should come from step 12 on staging, with the owner's yes.

## The gap: no independent server ran

**[Decision 124](../../docs/spec/PRODUCT.md#decisions-needed) wants an implementation from outside the A2A project, and this only ran against the project's own server.** LangGraph's `langgraph-api` 0.17.1 is the planned one, with fasta2a as backup. Its package installed into a local virtual environment, but starting its dev server was refused by this session's permission check as code from outside, and I didn't work around it. I didn't try fasta2a, because running its server is the same kind of action.

From the installed package's source, read but not run: `langgraph_api/api/a2a.py` serves A2A 1.0 at `/a2a/{assistant_id}`, with an Agent Card at `/a2a/{assistant_id}/.well-known/agent-card.json`. Its card says `protocolVersion: "1.0"`, it answers both 1.0 and 0.3 method names, and it doesn't import `a2a-sdk`. So it's still the best candidate. Running it needs the permission check to allow it, or another way, before step 12's interoperability run.

## Not proven

- **Nothing ran on a deployment.** The real edge, `global_fetch_strictly_public`, queue timing and CPU are unmeasured.
- **No independent server ran,** as above.
- **The signed request and stored bearer token** from [decision 122](../../docs/spec/PRODUCT.md#decisions-needed) aren't sent. That's step 11's.
- **The room is KV,** with no Rust, outbox or idempotency records. The mapping is a sketch of step 5, not the real one.
- **Cancel going out isn't tried.** A remote that refuses to cancel a finished task is step 13's.
