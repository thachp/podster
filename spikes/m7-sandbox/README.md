# Spike B (M7): the Claude Agent SDK under Runner's control

Throwaway M7 spike, run 2026-11-18. It answers [M7 plan](../../docs/m7-plan.md) step 3 for the Claude Agent SDK: (a) whether every tool call reaches Runner's own decision point before it runs, (b) how far spend passes a cap before Runner's hard stop, (c) isolation in a Linux container with the provider key outside it, and (d) whether a run ends in a result Runner can parse and bound, plus the turn and run-time caps of decision 29's condition 3. The answers are in the plan's [spike B results](../../docs/m7-plan.md#spike-b-results-2026-11-18). Nothing in `apps/` changed, and nothing builds on this code.

**Local only.** One Mac (arm64, Node 25.8.1, Docker Desktop 28.5.1 with its Linux VM), `@anthropic-ai/claude-agent-sdk` 0.3.327 pinned exactly, which bundles Claude Code 2.1.327. Model `claude-haiku-5-5` throughout, on a dedicated key with a 5 USD provider-side limit set by the owner.

## How to run

```bash
npm ci
npm pack @anthropic-ai/claude-agent-sdk-linux-arm64@0.3.327   # in an empty folder; extract package/claude
docker pull node:22-bookworm-slim
M7B_SCRATCH=<an empty folder> M7B_LINUX_CLAUDE=<path to package/claude> node spike.mjs a-outside-refuse a-outside-open ...
node --test selftest.mjs
```

`spike.mjs` lists the scenarios. The key is read from `M7B_KEY_FILE` (default `~/.podster/anthropic-spike-b.key`) by `lib/broker.mjs`, which sends it to the provider, and by `spike.mjs`'s `containsKey`, only to check that it appears nowhere in the probes' output or the containers' `docker inspect`. Neither prints, logs or stores it.

**Which code made each result file.** Some result files came from earlier code in this branch, and reruns overwrote earlier files of the same name; `results/spend.json` lists every run in order, reruns included. `d-oversize.json`'s `pass` was recomputed without a rerun after the review (a run that hung until Runner's time cap with no result doesn't pass), and `a-outside-refuse.json` was rerun once after the broker's upstream URL was rebuilt from fixed parts. Docker runs with a throwaway `DOCKER_CONFIG` holding `{}` and the allow-listed environment from `e2e/child-env.mjs`.

| File | What it is |
| --- | --- |
| `lib/broker.mjs` | The provider broker, the only part that sends the key. Loopback only; accepts `POST /v1/messages` (with `beta=true` the only query allowed; the upstream URL is built from fixed parts) for allow-listed models; counts spend and requests from the provider's usage; Runner's hard stop (refuse later requests, cut those in flight); optional `max_tokens` clamp and worst-case reservation |
| `lib/runner.mjs` | The stand-in Runner's adapter. A `PreToolUse` hook is the decision point for every tool call; caps on spend, turns and run time; the stop kills the task container. Two placements: `outside` (Claude Code on the host in an empty folder, no built-in tools, Runner's MCP tools `docker exec` into a container with no network) and `inside` (Claude Code's Linux binary in the container through `spawnClaudeCodeProcess`, reaching the broker only through a relay) |
| `lib/policy.mjs`, `lib/result.mjs` | Runner's run policy for one call, and its bound on the final result. Pure |
| `lib/docker.mjs` | Containers: user 1000, all capabilities dropped, `no-new-privileges`, read-only root, own task folder at `/work`, no home, key or Docker socket mounted |
| `probe/probe.mjs` | The isolation probe, run as a task command |
| `results/*.json` | One file per scenario: IDs, tool names, rule names, counts, times and costs. No task text, model text, command or key. Host paths are written as `<scratch>` and `<home>` |
| `results/spend.json` | The running spend, as the broker counted it and as the SDK reported it |
| `selftest.mjs` | Pure checks of the policy, the SDK permission default, the broker's upstream URL, the price table and the result bound |

## Scenarios

| Scenario | What it shows | Result |
| --- | --- | --- |
| `a-outside-refuse`, `a-inside-refuse` | Three calls asked for: one allowed, one refused by Runner only (the SDK's `dontAsk` list allows the tool), one refused by both. SDK permission mode `dontAsk` with Runner's allow list | Pass: 3 tool uses, 3 decisions, each before its call; only the allowed file exists |
| `a-outside-open`, `a-inside-open` | The same with the SDK open: `bypassPermissions` | Pass: Runner's refusals held alone |
| `a-*-open-control` | The same, open, with Runner allowing all three | All three files exist, so the refusals above are what stopped them |
| `c-probe` | The probe run directly in an `inside` container and an `outside` one, with a second task's container running | Pass: no key, no home, no other task; `inside` reaches only the relay, `outside` no network |
| `c-probe-model` | The probe run by the model through Claude Code's Bash tool, as a child of Claude Code in the container | Pass: no key; it sees Claude Code's environment (placeholder, not the key) and its state folder |
| `c-repo`, `c-repo-control` | Planted `.claude/settings.json` hooks and `defaultMode`, `settings.local.json`, `.mcp.json`, `CLAUDE.md`, an agent and a skill | Pass: none loaded with `settingSources: []` and `strictMcpConfig`; the control loaded all of them |
| `c-expand`, `c-expand-verbatim` | `@/tmp/<canary file>` in the prompt, `outside` | Without `verbatimPrompts` the host file reached the provider with no tool call; with it, not |
| `b-sdk-usd`, `b-runner-usd`, `b-runner-usd-reserve` | A 60-call loop against a 0.003 USD cap: the SDK's `maxBudgetUsd`, Runner's broker stop, and the broker with a `max_tokens` clamp and reservation | +2.97%, +0.19%, and −53% (stopped early, never past the cap) |
| `t-sdk-turns`, `t-runner-turns` | A turn cap of 5 | 5 requests and 5 tool runs each; no tool ran after either stop |
| `r-runner-time` | A 15 s cap on a loop of `sleep 3` commands, `inside` | Stop +2 ms, Claude Code exited +106 ms, container killed +188 ms. A killed `docker exec` client left its process running |
| `d-structured` | `outputFormat` with a JSON schema | Pass, once Runner's policy names the SDK's `StructuredOutput` tool |
| `d-oversize`, `d-oversize-capped` | The model asked to put 3000 characters in a 200-character field | Uncapped: fail, no result; 118 s of generation inside one tool call, nothing seen until Runner's time cap cut it. With a 2048-token output cap: the SDK's schema check refused the oversize tries and the run ended with a valid result |
