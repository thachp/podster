# Spike (M7): the OpenAI Agents SDK under Runner's control

**Prepared 2026-11-21, not yet run against OpenAI.** A throwaway spike for [Runner's OpenAI adapter](../../docs/spec/RUNNER-OPENAI.md), following its [spike plan](../../docs/spec/RUNNER-OPENAI.md#spike-plan). It answers whether the Agents SDK's loop can run in Runner's own process with every model request going through Runner's broker, every tool call going through Runner's decision point, and nothing else leaving the machine. Nothing in `apps/` changed, and nothing builds on this code.

Step 1 of the plan (no network at all) is the test suite and is done. Steps 2 to 6 are `spike.mjs`'s scenarios. They need the owner's key and are not run yet.

**Pins.** `@openai/agents-core` 0.22.0, `@openai/agents-openai` 0.22.0 and `openai` 7.62.0, exactly, with npm's `sha512` integrity in `package-lock.json`, installed with `npm install --ignore-scripts`. The `@openai/agents` umbrella and `@openai/agents-realtime` are not installed. Model `gpt-6-luna` only. Node 22 or later (`openai` needs it).

## Caps

The owner approved **2.00 USD in total** on 2026-11-21. `spike.mjs` enforces:

| Cap | Figure | Where |
| --- | --- | --- |
| Per run | 0.20 USD (`spend_micro_usd: 200_000`) | The broker's reservation: a request whose worst case would pass the cap is refused before it is sent |
| Per day | 2.00 USD (`2_000_000` micro-USD) | `results/spend.json` (`lib/ledger.mjs`); a run's cap is lowered to what is left |
| In total | 2.00 USD | `results/spend.json`; no run starts with less than 0.02 USD left |
| Model | `gpt-6-luna` only | The profile's price table; any other model is refused by the broker |
| Turns, output | 20 requests a run; 60,000 output tokens a run; 4,096 per request | The broker; the SDK's `maxTurns` is a second lock |

The OpenAI project's own budget is the owner's to set (RUNNER-OPENAI.md question 4). The `cap` scenario sets its run cap to 0.003 USD on purpose.

**The ledger can't be outrun.** Only one spike process runs at a time: it takes `results/spend.lock` with `O_EXCL` and a second process is refused. Each run's whole cap is written into `results/spend.json` as spent before the run starts, and replaced with the real figure (spent plus anything still reserved that never settled) only when it ends. A run that is killed or crashes stays charged its whole cap, and leaves the lock behind. To clear a stale lock: make sure no `node spike.mjs` is running, check `results/spend.json` (the crashed run shows `"settled": false` and is charged its cap), then delete `results/spend.lock`.

## How to run

The owner creates a dedicated OpenAI project and a project key for it (Runner and its builders never create accounts or keys), and saves the key at `~/.podster/openai-runner.key`: one line, a regular file owned by you, mode `600`. The spike refuses a key that isn't an `sk-proj-` key, a file that is a link or readable by others, and a process environment holding any `OPENAI_*` name other than the three disabling ones, a proxy, `NODE_OPTIONS` or extra TLS trust.

```bash
cd spikes/m7-openai
npm ci --ignore-scripts
npm test                                   # step 1: free, no network
docker pull node:22-bookworm-slim          # the task image; runs use --pull never, so pull it first
node spike.mjs --help                      # lists the scenarios and caps
node spike.mjs traffic                     # step 2
node spike.mjs bound                       # step 3
node spike.mjs usage                       # step 4, then compare results/usage.json with the project's usage page
node spike.mjs read edit refuse            # step 5
node spike.mjs cancel cap                  # step 6
```

`M7O_KEY_FILE` names another key file. `M7O_SCRATCH` names a scratch folder, which must be inside the spike's `work/` folder (the default, ignored by git); anything else is refused. Each run prints one line of counts and writes `results/<scenario>.json`; `results/spend.json` keeps the running spend. Commit those with the write-up; git ignores everything else under `results/`, the lock and temporary files included.

Run `gpt-6.1-terra` only if the owner allows it; that is a reviewed profile change, not a flag.

## What each part is

| File | What it is |
| --- | --- |
| `lib/profile.mjs` | The profile, fixed in code: host `api.openai.com`, path `/v1/responses`, `content-type` only, the `gpt-6-luna` price table (short and above-272K tiers), the pins and the caps. The only file that names the host and path |
| `lib/dialect.mjs` | The Responses dialect: the request-body allowlist (keys refused by name, hosted tool types refused by type, input items and roles), `max_output_tokens` rewritten to min(cap, tokens left, asked) and `store` forced `false` after a parse and re-serialize; the worst case; the overcounting usage reading; the `response.completed` stream reader |
| `lib/broker.mjs` | The run's broker, in process: admission, caps (spend, turns, output tokens), the worst-case reservation, settling each request from usage or its worst case, cancel |
| `lib/transport.mjs` | The only holder of the key: adds `authorization: Bearer` last to the one URL, `redirect: "error"`, refuses a forward with any auth or `OpenAI-*` header; the key file, key provider and environment checks |
| `lib/driver.mjs` | The stand-in `openai_agents` driver: `OpenAIResponsesModel` over an `OpenAI` client whose `fetch` is `brokerFetch` and whose key is a placeholder; one strict function tool per allowed tool, each asking the decision point before it runs; `StructuredOutput` stops the loop; tracing off three ways; a model provider that refuses every lookup |
| `lib/policy.mjs` | The stand-in run policy, tool schemas, the result schema and Runner's own bound on the result. Pure |
| `lib/sockets.mjs` | The socket check: `net.client.socket` and undici's `beforeConnect` diagnostics channels, recorded by host and port only |
| `lib/sandbox.mjs` | The task container for the real scenarios: user 1000, all capabilities dropped, `no-new-privileges`, read-only root, `--network none`, `--pull never`, the task folder at `/work`. The docker CLI gets `e2e/child-env.mjs`'s environment |
| `lib/ledger.mjs` | The spend ledger: the `O_EXCL` lock, each run's cap charged before it starts and settled after, and the `M7O_SCRATCH` check |
| `spike.mjs` | Steps 2 to 6, the synthetic tasks and room |
| `test/` | Step 1 and the checks below, against `test/fake-upstream.mjs`, an in-process fake Responses upstream |

## Scenarios (not yet run)

| Scenario | Plan step | What it records |
| --- | --- | --- |
| `traffic` | 2 | Every outbound connection from Runner's process during the read task, by host and port; anything but `api.openai.com:443` is listed as unexplained |
| `bound` | 3 | Seven bodies with refused keys or hosted tools sent straight to the broker, each refused with nothing sent; then a task asking for far more output than a 256-token bound, recording `output_tokens` against `max_output_tokens` per request |
| `usage` | 4 | Each request's usage fields (input, cached, cache write, output, reasoning, total), to set against the project's usage page and settle the nesting |
| `read`, `edit`, `refuse` | 5 | Spike B's three tasks: a read-only answer, a small fix with `node --test` in a Node room, a `curl` call Runner refuses |
| `cancel` | 6 | The edit task cancelled while its second request is in flight: the cut, the worst case charged, nothing after |
| `cap` | 6 | A loop of `echo tick` calls against a 0.003 USD cap: how far spend passed the cap, which should be zero |

Result files hold IDs, tool names, rule names, counts, bounds, usage counts and charges: no task text, model text, command or key.

## What the tests show (step 1, run 2026-11-21)

`npm test`: 60 tests, 60 pass, against the real SDK packages with an in-process fake upstream and no network.

- **The loop and decision point.** The SDK's loop calls Runner's function tools; each asks `decide` first; a refused call isn't run and the model gets the fixed refusal text; a tool not allowed isn't offered; `StructuredOutput` ends the loop with the result.
- **Model traffic.** Every request reaches the fake upstream only through the broker and transport, with the test key added by the transport alone; `store` is `false`, `max_output_tokens` is the bound, `parallel_tool_calls` is `false`, `truncation` is `disabled`, and only function tools are sent. `brokerFetch` refuses any other URL, method or path, including `/v1/traces/ingest`, `/v1/conversations` and `wss://`.
- **Body allowlist (S-55).** Every refused key by name, every hosted tool type by type, `system` and `developer` roles, image, file and audio input, `item_reference`, other `include` values, `truncation: "auto"`; refused before anything is sent; a duplicate key can't pass, since the body forwarded is the one checked.
- **Output bound and usage (S-56).** The bound is rewritten on every request; output above it is flagged; missing usage fields, a non-2xx answer, an incomplete answer, a cut stream and 12-hour cache writes count the worst case; the overcounting reading and the long-context tier are priced as the design says.
- **Caps.** Turn, output-token and spend caps stop the run; the reservation refuses the request whose worst case would pass the cap, so spend stays under it; cancel cuts the request in flight.
- **Tracing (S-53).** A trace processor registered before the driver starts receives nothing; the global provider hands out only no-op traces (with a control showing the same processor does receive a trace when tracing is on). During a whole run the socket recorder sees no socket at all. The recorder itself is tested against real loopback `net`, `tls` and `fetch` connections.
- **Key and environment (S-54).** Wrong-provider and malformed keys, link, shared and multi-line key files, and `OPENAI_*`, proxy and TLS environment names are refused; errors never carry the key.
- **Ledger.** A child process killed mid-run leaves its cap charged and its lock in place, and the next process is refused until the lock is cleared; a second process is refused while the first holds the lock; `M7O_SCRATCH` outside `work/`, or a link out of it, is refused.
- **Supply chain (S-58).** Exact pins in `package.json`, installed and in the lockfile; every package with `sha512` integrity from the npm registry; no install script; no realtime or umbrella package; no spike source imports the umbrella, the trace exporter, any hosted or built-in tool or the WebSocket transport.

## Found while building

- **The SDK always sends `include`**, as an empty array when nothing is asked for, so the broker accepts `[]` as well as `["reasoning.encrypted_content"]`.
- **`@openai/agents-core` 0.22.0 is bigger than RUNNER-OPENAI.md describes.** It depends on `tar` 7.5.22, and has an optional dependency on `@modelcontextprotocol/client` 2.4.0, which npm installs with `cross-spawn`, `jose`, `eventsource` and others (25 packages in all). It exports a `./sandbox` subpath with a Docker sandbox that uses `tar`. The spike never imports `./sandbox`, and a source test refuses it; a product pin would want `--omit=optional` checked, and the larger tree reviewed under S-58.
- **`openai` 7.62.0 has optional peer dependencies** (`ws`, `undici`, AWS and Google auth). None is installed, and none is needed.

## Not verified

Everything that needs OpenAI: the real traffic, whether `gpt-6-luna` accepts `reasoning` and `include: ["reasoning.encrypted_content"]` with `store: false`, the usage nesting, whether usage carries `cache_write_tokens` at all (if it doesn't, every request is charged its worst case and runs stop early, which is the safe side), billing against `max_output_tokens`, `gpt-6-luna`'s coding ability, and whether the project budget is a hard stop. The socket check doesn't see DNS lookups or child processes (the docker CLI). `lib/sandbox.mjs` and `spike.mjs`'s real path have not run; no Docker command was run while building. Streaming is tested at the broker; the driver runs non-streamed.
