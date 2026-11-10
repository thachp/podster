# fasta2a, decision 143's backup independent server

The owner approved starting it locally on 2026-11-10. `server.py` is one trivial agent on pydantic's `fasta2a` 2.1.1:
1. It reports `WORKING`.
2. It waits `RUN_SECONDS`.
3. It reports `COMPLETED` with one text artifact, naming its turn in the context and how long the message it got was. It never echoes the text.

`../run-fasta2a-check.mjs` starts it on 127.0.0.1 and runs `apps/api/test/a2a-fasta2a.spec.ts` against it. That's Podster's real send, read-back, change-request and cancel code in workerd. Only the test runtime forwards the made-up host `fasta2a.example.com` to the local server, and Podster's egress rules are unchanged.

```bash
uv venv --python 3.12 .venv && VIRTUAL_ENV=$PWD/.venv uv pip install --require-hashes -r requirements.lock
```

```bash
node e2e/run-fasta2a-check.mjs --python <that venv>/bin/python
```

`requirements.lock` pins `fasta2a` 2.1.1 and `uvicorn` 0.38.0, and everything they need, with their wheel hashes.

## Result, 2026-11-10

3 of 3 passed, and fasta2a's own log had no warning or error.
- **The offer** is taken as a `SUBMITTED` task, and its task and context are recorded.
- **The flow:**
  1. A read during the run sees `WORKING`, which accepts.
  2. A later read sees `COMPLETED` with the artifact, which submits as the agent, with origin `a2a_remote`.
  3. A change request goes into the same context as a new task, which fasta2a counts as turn 2.
  4. It comes back as submission 2, which the lead verifies.
- **Cancel:** a task canceled while fasta2a works is sent `CancelTask` once.

A text part must be `{ "text": … }`, as fasta2a's own worker builds it. With a 0.3-style `kind` key, its 1.0 output falls back to snake_case keys with serializer warnings.
