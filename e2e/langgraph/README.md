# LangGraph's A2A server, for decision 143

[Decision 143](../../docs/spec/PRODUCT.md#decisions-needed) runs outbound against an independent A2A 1.0 server, LangGraph's `langgraph-api` 0.17.1. The owner approved starting it locally on 2026-11-09.

- `graph.py` is one trivial graph. It answers each message with a fixed line naming its turn and the message's length.
- `langgraph.json` serves that graph as `podster_test`.
- `../run-langgraph-check.mjs` starts `langgraph dev` on 127.0.0.1 and runs `apps/api/test/a2a-langgraph.spec.ts` against it. That's Podster's real send, read-back and cancel code in workerd. The test runtime forwards the made-up endpoint host `langgraph.example.com` to the local server, and Podster's egress rules are unchanged.

```bash
uv venv --python 3.12 .venv && VIRTUAL_ENV=$PWD/.venv uv pip install "langgraph-api==0.17.1" "langgraph-cli[inmem]"
```

```bash
node e2e/run-langgraph-check.mjs --langgraph <that venv>/bin/langgraph
```

## What it found, 2026-11-09

Run with `langgraph-api` 0.17.1, `langgraph` 1.2.20 and `langgraph-cli` 0.4.42. All four checks passed. The agent card reports protocol 1.0.

1. **It takes Podster's offer as a task.** Its task ID is `<thread>:<run>`, and its `contextId` is the thread. Both pass Podster's checks and are recorded. It ignores `X-Podster-Signature` and the bearer token, which A2A allows.
2. **It ignores `returnImmediately`.** `SendMessage` answers only once the run ends, already `COMPLETED`, with the graph's reply as an artifact. Podster keeps only the task's ID and context from a send's answer. So the first read sees `COMPLETED` with no `WORKING` before it, and [decision 112](../../docs/spec/PRODUCT.md#decisions-needed) holds it as an unaccepted response. A graph that runs longer than Podster's 10 s send timeout would fail to send at all.
3. **Its `GetTask` never carries artifacts,** whatever `historyLength` is, only the fixed status message "Task completed successfully". The graph's reply is in `history`, as a `ROLE_AGENT` message, unless `historyLength` is 0, and Podster sends 0. So nothing the graph wrote reaches Podster. Even after the agent accepts by hand, the `COMPLETED` read gives a submission with no note and no link. The room refuses that and holds it instead.
4. **So no submission comes in over A2A, and no change request goes out.** Step 13b sends one only for a submission that came in over A2A. Sent by hand, with Podster's change-request shape (`referenceTaskIds` and its `contextId`), LangGraph continues the same thread as a new task: turn 2, same context, a new run ID.
5. **`CancelTask` on a finished run answers -32002, `TaskNotCancelable`.** Podster records the cancel as refused and doesn't retry it.

So **decision 143's outbound item isn't met**. The protocol fits, but LangGraph's run-to-completion `SendMessage` and its artifact-free `GetTask` leave a LangGraph agent's results held, not submitted. The four checks pass because they assert that gap. Whether Podster should take a terminal state and artifacts from a send's answer, or read `history` on a `COMPLETED` with no artifacts, is the lead's ruling, not a fix made here.
