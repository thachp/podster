# Results: the OpenAI Agents SDK spike, run 2026-11-21

Run by the architect on the owner's machine on 2026-11-21, against [the spike plan](../../docs/spec/RUNNER-OPENAI.md#spike-plan), with the dedicated project key at `~/.podster/openai-runner.key` (read only by the spike's transport, by path), `gpt-6-luna` only, synthetic tasks only, and the owner's 2.00 USD approval. Each scenario ran as its own `node spike.mjs <scenario>` so its results and the ledger could be checked before the next. The summaries are in `results/`. They hold IDs, tool names, rules, counts and charges, with no task text, model text, command or key.

**Spend: 5,951 micro-USD (0.006 USD) of 2.00 USD**, on the spike's own overcounting reading. No stop condition was hit: no unexplained connection, no `output_tokens` above `max_output_tokens`, no overspend in the cap scenario, no refused key sent, and the total stayed far below 1.50 USD. Every run settled, and the lock was released each time.

| Scenario | Requests sent | Charged (micro-USD) | Outcome |
| --- | --- | --- | --- |
| `traffic` | 3 | 172 | `done` |
| `bound` | 1 | 821 (worst case) | no result: the request came back `incomplete` at the bound |
| `usage` | 3 | 1,186 | `done` |
| `read` | 3 | 175 | `done` |
| `edit` | 6 | 410 | `done`, one file changed, tests pass |
| `refuse` | 2 | 103 | `failed`, as it should be |
| `cancel` | 2 | 2,908 (2,861 is the cut request's worst case) | cancelled in flight |
| `cap` | 4 | 176 | stopped by the spend cap, 0 over |
| **Total** | **24** | **5,951** | |

## Step 1: no network

`npm ci --ignore-scripts && npm test` ran again in a fresh worktree before any spend: 60 tests, 60 pass, exit 0.

## Step 2: tracing and traffic

- During the whole `traffic` run, the only outbound connection from the spike's process was `api.openai.com:443`. Both the fetch hook (undici `beforeConnect`) and the raw socket hook (`net.client.socket`, TLS) saw it, and the unexplained list is empty.
- Tracing stayed locked down (`lockedDown: true`, `noopTrace: true`), and no connection went to a tracing endpoint.
- **Not seen:** DNS lookups, and the docker CLI's own connections to the local Docker socket. Those are child processes, and the hooks don't see them.

## Step 3: body and bound

- **Refused before sending:** all seven bodies, with `background`, `previous_response_id`, `conversation`, `service_tier` and `prompt_cache_retention` as `refused_key`, and the `web_search` and `code_interpreter` hosted tools as `tools`, were refused by the broker with 0 requests sent.
- **The bound held:** with `max_output_tokens: 256`, the one request returned `output_tokens: 256`, which is equal to the bound and not above it. Across all 24 requests, none went above its `max_output_tokens` (`output_over_bound` is 0 in every file).
- **What the model did with a tight bound:** all 256 output tokens were reasoning tokens (`reasoning_tokens: 256`). The response came back `incomplete` with `incomplete_reason: max_output_tokens` and no visible output. The SDK raised `ModelBehaviorError`, and the run produced no result. The broker charged the worst case (821) because the answer was incomplete, as designed. **For the adapter:** a low output bound combined with reasoning can use the whole bound on reasoning and return nothing. Bounds need headroom over the reasoning effort.
- **Unverified:** whether OpenAI *bills* by `max_output_tokens` or by tokens produced. Only the project's usage page shows that.

## Step 4: usage nesting

The usage object carries every field the broker reads: `input_tokens`, `output_tokens`, `total_tokens`, `input_tokens_details.cached_tokens`, `input_tokens_details.cache_write_tokens` and `output_tokens_details.reasoning_tokens`. No request had a missing field. **`cache_write_tokens` is present and non-zero**: OpenAI cached automatically on the `usage` task's longer prompt, with no `prompt_cache_retention` sent. No 12-hour write appeared.

From the field arithmetic, on all 23 requests that returned usage:

- `total_tokens` = `input_tokens` + `output_tokens`, every time.
- `cached_tokens` + `cache_write_tokens` ≤ `input_tokens`, every time. Example from `usage`, request 3: 3,947 input, of which 2,114 were cached and 1,830 were cache writes.
- `reasoning_tokens` ≤ `output_tokens`, every time. In `bound`, all 256 output tokens were reasoning.

So **cached and cache-write tokens are parts of `input_tokens`, and reasoning tokens are part of `output_tokens`**, not added on top. The broker's overcounting reading adds them on top, so it overcharges. That is the safe side, but it shortens runs. On the nested reading, the same requests come to about 4,642 micro-USD against the 5,951 charged. The 2,861 worst case for the cancelled request is the same on both readings. The overcharge is largest where caching happens: `usage` was charged 1,186 against about 578 on the nested reading.

**Owed by the owner:** compare `results/usage.json`, and the run timestamps in `results/spend.json`, with the OpenAI project's usage page. The architect can't see that page. The nesting above comes from the API's own numbers, and the billing side is unverified until that comparison is made.

## Reasoning with `store: false`

`gpt-6-luna` **accepted** `reasoning: { effort: "low" }` with `include: ["reasoning.encrypted_content"]` and `store: false`. Every request returned 200, multi-turn runs carried on past turns that reported reasoning tokens, and there was no `previous_response_id`, since it is refused. **Unverified:** that the encrypted reasoning items were actually sent back on later turns. The results don't record input item types, and request bodies growing faster on turns after reasoning only suggests it.

## Step 5: the three tasks

- **Read** (`read`, and `traffic` with the same task): `done` in 3 requests. On both runs the model's first move was a shell command that isn't on the room's list. The decision point refused it (`command_not_listed`). The model then used `read_file` and finished. **Unverified:** whether the answer was right, because the result's text isn't recorded.
- **Edit:** `done` in 6 requests and 4 executions. Again the first shell call was refused as not listed. Then it made 2 `read_file` calls, 1 `write_file` call and an allowed `node --test` run, and returned a result naming 1 file. Afterwards, the architect ran `node --test` again in a fresh `--network none` container on the task folder, and it passed (exit 0). Only `sum.js` differed from an untouched room.
- **Refuse:** the model asked to run the refused command once, the decision point refused it (`command_not_listed`, 0 executions), and the model returned `failed` on the next turn, with no retry loop.
- **Comparison with spike B (Claude):** behavior is broadly alike: it uses only the offered tools, follows the decision point's refusals and ends through `StructuredOutput`. Spend per task here is a fraction of a cent. A side-by-side with spike B's figures isn't drawn here. `gpt-6.1-terra` was not run (not allowed, question 5).

## Step 6: cancellation and cap stop

- **Cancel:** the run was aborted 50 ms after its second request went out. The broker counted 1 request cut in flight, charged it its worst case (2,861 micro-USD), and sent nothing after it (2 requests sent in all). **Unverified:** what OpenAI bills for a request that was cut. The owner's usage page shows it.
- **Cap:** with the run cap at 3,000 micro-USD, 4 `echo tick` turns ran (176 micro-USD real). Then the fifth request's worst case (about 2,900, with `max_output_tokens` at 4,096) no longer fit, and the broker refused it before sending (`spend_cap`). **Spend over the cap: 0.** The reservation is cautious: with a 4,096-token bound, a small cap stops a run at about 6% of its figure. Product caps should be sized with that in mind, or the bound lowered for loops.

## Found while running

- **The shell had an `OPENAI_API_KEY` name in its environment**, from outside the repo. The spike's environment check refused to start (`refused: environment names OPENAI_API_KEY`) before reading the key or spending anything. Every run then used `env -u OPENAI_API_KEY node spike.mjs …`. The value was never read. Runner's own start check should refuse the same way, as S-54 says.
- `lib/sandbox.mjs` and spike.mjs's real path ran for the first time here. The docker CLI got `e2e/child-env.mjs`'s environment with its own throwaway `DOCKER_CONFIG` holding `{}` and `DOCKER_HOST`, and no credential helper hung. The task image `node:22-bookworm-slim` was pulled first, through a separate temporary `DOCKER_CONFIG`, which was deleted afterwards along with the spike's `work/` folder.

## Not verified

- Billing: the dashboard against `results/usage.json`, billing by bound or by tokens produced, and what a cut request costs. All of these are the owner's to check on the project's usage page.
- Whether the OpenAI project budget is a hard stop (question 4). Nothing came near it.
- The correctness of the read task's answer. Encrypted reasoning items being sent back on later turns.
- DNS and child-process traffic, which the socket hooks don't see.
- `gpt-6-luna`'s coding ability beyond one two-line fix. `gpt-6.1-terra` was not run.
- Streaming against the real API: the driver runs non-streamed.
