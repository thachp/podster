# Runner's OpenAI adapter

**Status, 2026-11-23: question 7 answered (standard retention is acceptable); still opt-in until the billing check.** **Status, 2026-11-22: built, off by default, not verified for support** (the revised ruling under [question 6](#questions-for-the-owner)). **Status, 2026-11-21: Proposed. Design only.** Nothing here is approved, built or run. No OpenAI account, key, project, package install or spend exists for it, and this document creates none. It answers the owner's request of 2026-11-21 ("i'm also interested in supporting other agent sdk.. from open ai") within the owner's ruling of 2026-11-17: Claude Agent SDK first, behind Runner's provider-neutral adapter, with OpenAI's and xAI's agent SDKs later ([RUNNER.md, local CLI adapters](RUNNER.md#local-cli-adapters-and-two-sign-ins)). The owner picks the path ([questions](#questions-for-the-owner)) before any code.

Every external fact below carries its source and the date it was read. Package facts come from npm's registry (`npm view`) and from reading the published packages' files after `npm pack --ignore-scripts` into a scratch folder, on 2026-11-21; no package script was run and nothing was installed into the repository. **Nothing was run against OpenAI.** Every behavior claimed for an OpenAI SDK, CLI or API is unverified until [the spike](#spike-plan) runs it.

## Recommendation

1. **Use the OpenAI Agents SDK for TypeScript, not the Codex SDK,** as a new driver `openai_agents` behind the existing `AgentDriver` interface.
2. **Import only `@openai/agents-core` and `@openai/agents-openai`, never the `@openai/agents` umbrella,** whose import turns on OpenAI's trace exporter. Tracing is also switched off twice more, and the spike must show no socket opens from the SDK.
3. **The SDK's loop runs in Runner's own process, with no binary and no container of its own.** Its OpenAI client gets a `fetch` that never touches the network: it hands each request to the run's broker, and only the provider transport adds the real key. Every tool is Runner's own function tool, decided by `session.check` and run by `session.tool` in the task container, as today.
4. **The broker gains a second dialect, OpenAI's Responses API,** with its own body allowlist, a rewritten `max_output_tokens`, a forced `store: false`, usage read from `response.completed`, and a price table for one model.
5. **Codex is set aside, not rejected forever:** its value is its own shell, patch tool and sandbox, which Runner would have to turn off; its SDK has no per-call decision point; and it ships a large native binary on a near-daily release cadence.

## Which SDK

Two OpenAI agent SDKs fit the words "agent SDK" (both read 2026-11-21):

- **The Agents SDK** (`@openai/agents` 0.22.0, published 2026-11-12, made of `@openai/agents-core`, `@openai/agents-openai` and `@openai/agents-realtime`, each 0.22.0, depending on `openai` ^7.45.1, whose latest is 7.62.0 and needs Node 22 or later). A pure TypeScript library: an agent loop, function tools, handoffs, guardrails, structured output and tracing. It reads no configuration file and no repository file. Sources: [npm @openai/agents](https://www.npmjs.com/package/@openai/agents), [Agents SDK docs](https://openai.github.io/openai-agents-js/).
- **The Codex SDK** (`@openai/codex-sdk` 0.171.0, published 2026-11-21, depending on `@openai/codex` 0.171.0). The closest analogue to the Claude Agent SDK: it spawns the Codex CLI binary, `codex exec --experimental-json`, writes the prompt to its standard input and reads a stream of events. The CLI runs its own shell, file-change and web-search tools. Sources: [npm @openai/codex-sdk](https://www.npmjs.com/package/@openai/codex-sdk), [npm @openai/codex](https://www.npmjs.com/package/@openai/codex), and the package's `dist/index.js`.

Judged on Runner's requirements:

| Requirement | Agents SDK (in Runner's process) | Codex SDK + CLI (in its own container) |
| --- | --- | --- |
| A decision point for each tool call, Runner's run policy deciding | Yes. Tools are Runner's own function tools; each `invoke` calls `session.check` then `session.tool`, so a call nothing checked can't run. The SDK has no built-in tool unless one is imported (`shellTool`, `applyPatchTool`, `computerTool` exist in agents-core and stay unused). | No callback in the SDK. Its events (`item.started`, `item.completed`, `turn.completed`) only report. The CLI runs its tools itself. Getting a decision point means turning off `features.shell_tool`, `features.view_image`, `features.apps` and `web_search`, exposing Runner's tools as an MCP server through the relay, and still proving no other built-in tool (the file-change tool) remains: a larger and more fragile surface than Claude Code's `tools: []`. Codex's `PreToolUse` hook is a command the CLI runs, not a callback. |
| Runs with Runner's task container, tools and egress model | Yes, unchanged. The SDK never executes anything; the task container, egress proxy and toolchains stay as they are. | Only as a second container like Claude Code's. Codex's own sandbox on Linux is bubblewrap, which needs unprivileged user namespaces ([sandboxing](https://learn.chatgpt.com/codex/sandboxing), read 2026-11-21); Runner's hardened container (no capabilities, `no-new-privileges`) very likely denies them (unverified), so Codex would run `danger-full-access` inside it. |
| Every model request through Runner's broker | Yes, by construction: the OpenAI client's `fetch` is Runner's function, which calls `session.model`. No listener, relay or port. | Yes, as for Claude Code: `--config openai_base_url=…` (the SDK's `baseUrl`) pointed at the relay; the listener's per-run token as the key. Project-local config can't set `openai_base_url` ([config reference](https://learn.chatgpt.com/docs/config-file/config-reference), read 2026-11-21). |
| No telemetry or tracing leaves the machine | Needs care: the umbrella package's import calls `setDefaultOpenAITracingExporter()` (read in `@openai/agents` 0.22.0 `dist/index.mjs`), which batches traces to `https://api.openai.com/v1/traces/ingest` (`@openai/agents-openai` `dist/openaiTracingExporter.mjs`). Tracing is on by default in Node ([tracing guide](https://openai.github.io/openai-agents-js/guides/tracing/), read 2026-11-21). See [tracing](#tracing-and-other-traffic). | Codex's container has no route out, so nothing leaves whatever the CLI tries; Statsig analytics (`analytics.enabled`), OTel exporters, update checks and `feedback.enabled` would also be set off by `--config`. |
| Pinned versions with integrity | Three small npm packages and `openai`, pinned exactly in Runner's lockfile with npm's `sha512` integrity. Release cadence about two to four weeks (0.19.0 2026-10-05, 0.20.0 2026-10-08, 0.21.0 2026-10-20, 0.22.0 2026-11-12). | The Linux binaries are `@openai/codex@0.171.0-linux-x64` and `-linux-arm64`, about 444 MB and 442 MB unpacked each, with `sha512` integrity, fetched into the image as `claude-image` does today. Releases are near daily (an alpha of 0.173.0 published 2026-11-21), so a pin goes stale fast and each new one needs the image review again. |
| Reads no host configuration | Reads none. It reads `OPENAI_API_KEY` and `OPENAI_AGENTS_*` from the environment only as defaults, which Runner replaces explicitly. | Reads `$CODEX_HOME` (default `~/.codex`) config and `auth.json`, and, by default, the SDK passes the whole `process.env` to the CLI unless `env` is given. In a container with an empty tmpfs `CODEX_HOME` and an explicit `env`, there is nothing to read. |
| Repository `AGENTS.md` treated as data | Nothing reads it. A task's own tools may print it, and then it is tool output, inside the untrusted frame like any file. | The CLI loads `AGENTS.override.md`, `AGENTS.md` and fallbacks from the repository root to the working folder into its instructions, up to `project_doc_max_bytes` (32 KiB by default) ([AGENTS.md guide](https://developers.openai.com/codex/guides/agents-md), read 2026-11-21). No documented switch turns this off; `project_doc_max_bytes = 0` might, unverified. Mitigated in the two-container placement, since Codex's own working folder is an empty tmpfs, as Claude Code's is. |
| A structured result tool like `StructuredOutput` | Yes: a function tool named `StructuredOutput` with `RESULT_SCHEMA` as its parameters, and `toolUseBehavior: { stopAtToolNames: ["StructuredOutput"] }`, so the loop ends on it. Runner checks the result itself either way. | `--output-schema` (the SDK writes the schema to a temporary file) constrains the final message; Runner would parse the last agent message. |

**Both?** Not now. Each adapter is its own security review, spike and pin to keep current. If the owner later wants Codex's own coding behavior (its prompts and tool design), it becomes a second OpenAI adapter, `openai_codex`, with its own spike covering the open items in the table's right column.

## How the Agents SDK driver works

A new `apps/runner/src/node/openai-driver.ts` implements `AgentDriver` (`run-interface.ts`), with `adapter: "openai_agents"`, `profile: OPENAI_PROFILE` and `models: [OPENAI_MODEL]`. For each run:

1. **No container of its own.** `begin(session)` builds an `Agent` and a `Runner` (the SDK's) in Runner's process. `cancel()` aborts the run's `AbortSignal`, which the SDK's `run` accepts, and the task container is killed by `SupervisedAdapter` as today. `confirmGone` and `reap` have nothing of their own to reap; the task container's are already Runner's.
2. **The model.** `new OpenAIResponsesModel(client, OPENAI_MODEL)` from `@openai/agents-openai`, with `client = new OpenAI({ apiKey: PLACEHOLDER_KEY, baseURL, fetch: brokerFetch, maxRetries: 0 })`. The driver names no host or path of its own: `baseURL` is derived from `OPENAI_PROFILE` (`https://` plus its `host` plus its `path` without the last segment), and the one request URL `brokerFetch` accepts is `upstreamUrl(OPENAI_PROFILE)`. `brokerFetch` accepts only `POST` to exactly that URL with no query, and hands the body to `session.model({ method, path, query, body })`; anything else throws `model_request_refused` and fails the run. It returns the broker's answer as a `Response`. So the real key never enters the SDK, and a request the SDK makes outside `fetch` carries no key. The SDK's Responses WebSocket transport (`responsesWebSocketConnection`) isn't used, and the spike checks it never opens.
3. **Model settings,** fixed in code: `store: false`, `maxTokens` from the run's caps (the broker rewrites it anyway), `parallelToolCalls: false` (each call goes through the decision point in turn; revisit after the spike), reasoning effort fixed, and `providerData: { include: ["reasoning.encrypted_content"] }` so reasoning carries across turns without server-side state (needed with `store: false`; unverified for the chosen model).
4. **Tools.** One function tool per name in `session.allowed_tools`, each with Runner's fixed description (`shellDescription` for the shell) and JSON schema, `strict: true`. Its `execute` calls `session.check(call)`; a refusal returns the fixed `refusalText` to the model, and an allowed call returns `session.tool(call)`'s bounded output. `needsApproval` isn't used: Runner's check is the only approval. Plus `StructuredOutput`, which records the result and stops the loop.
5. **Limits.** `maxTurns: session.limits.turns`, as a second lock: the broker's turn count is the first.
6. **Prompt.** The run's frame is the agent's `instructions`; the task text goes in as the user input, marked untrusted by the frame exactly as for Claude.
7. **Outcome.** `DriverOutcome.result` is the `StructuredOutput` call's arguments, or null. The SDK's own usage figures are never read for spend.

### Tracing and other traffic

The driver must keep everything on the machine except the broker's one upstream:

- **Never import `@openai/agents`.** A source test in the style of the existing scoped source test (`test/machine.test.ts`) fails on any import of it, of `@openai/agents-realtime`, of `OpenAITracingExporter` or `setDefaultOpenAITracingExporter`, and of `shellTool`, `applyPatchTool` or `computerTool`.
- **Tracing off three ways:** `setTracingDisabled(true)` and `setTraceProcessors([])` once at start, and `tracingDisabled: true` in every `Runner`'s config. The agents-core default processor without the umbrella is a console exporter (`dist/tracing/processor.mjs`), which with the processors emptied gets nothing. Runner doesn't rely on `OPENAI_AGENTS_DISABLE_TRACING`, which the environment could unset; Runner's start refuses if it finds `OPENAI_BASE_URL`, `OPENAI_API_KEY` or any `OPENAI_AGENTS_*` other than the disabling ones in its own environment, so nothing can point the SDK elsewhere.
- **Sensitive logging off:** agents-core suppresses model and tool data in its logs unless told otherwise (`OPENAI_AGENTS_DONT_LOG_MODEL_DATA` and `OPENAI_AGENTS_DONT_LOG_TOOL_DATA` default to on in `dist/config.mjs`); Runner also calls `setSensitiveDataLoggingEnabled(false)`, which overrides the environment, and its logger receives none of the SDK's debug output.
- **The spike proves it:** during a real run, Node's `net` and `tls` connection hooks (diagnostics channels) see no connection from Runner's process other than the transport's to `api.openai.com:443` and the Podster gateway.

If the spike finds traffic it can't account for, the fallback is the two-container placement Claude Code already has: the SDK's loop in its own container with no route out, talking to the broker through the relay. That costs a Node image and the relay, and is a ruling for then.

## The broker profile

Runner's broker (`apps/runner/src/core/broker.ts`) is pure and provider-neutral in its accounting, but its body checks, output bound, usage reader and stream end are Anthropic's. The proposal makes those a **dialect** the profile names, so `ProviderProfile` gains `dialect: "anthropic_messages" | "openai_responses"` and the broker picks the matching functions. The Anthropic dialect's code doesn't change.

**Upstream.** `OPENAI_PROFILE` in a new `apps/runner/src/core/openai-profile.ts`, fixed in code, never read from configuration: `provider: "openai"`, `host: "api.openai.com"`, `path: "/v1/responses"`, `headers: { "content-type": "application/json" }`. That file is the only one that may name the path: the scoped source test in `apps/runner/test/machine.test.ts` (the "never reaches the Rust API" case, which now allows `"/v1/messages"` only in the Claude profile file) gets one more scoped literal, `"/v1/responses"`, allowed only in `core/openai-profile.ts`. The driver derives its base URL and the request URL it accepts from the profile, so it names neither. The transport adds `authorization: Bearer <key>` last, refuses a forward that carries any authorization of its own (as for `x-api-key` today), and keeps `redirect: "error"`, no environment proxy and no environment TLS trust. A fixed header may not carry `OpenAI-Beta`, `OpenAI-Organization` or `OpenAI-Project` (a project-scoped key needs none of them; refused like `anthropic-beta`).

**Request keys allowed** (top level; names from the `openai` 7.62.0 package's `ResponseCreateParamsBase`, read 2026-11-21). Anything else is refused by name, as today:

| Key | Rule |
| --- | --- |
| `model` | Must be in the profile's price table. |
| `input` | An array of items: messages with role `user` or `assistant` only, whose content is `input_text` or `output_text` only (a `system` or `developer` role is refused, so the only instructions are `instructions`, fixed by Runner); `function_call` and `function_call_output` (text output only); `reasoning` items (with `encrypted_content`). No image, file or audio input, no `item_reference`. |
| `instructions` | A string: Runner's frame, set by the driver from Runner's code. |
| `tools` | Only `type: "function"`, with `name`, `description`, `parameters`, `strict`. Every hosted tool is refused by type: `web_search*`, `file_search`, `code_interpreter`, `computer*`, `mcp`, `shell`, `local_shell`, `apply_patch`, `image_generation`, `programmatic_tool_calling`, `tool_search`, `custom`, `namespace`. |
| `tool_choice` | `auto`, `required`, `none`, or one named function. |
| `parallel_tool_calls` | Boolean. |
| `max_output_tokens` | Rewritten on every request (below). |
| `store` | Rewritten to `false` on every request. |
| `stream` | Boolean. |
| `include` | Only `["reasoning.encrypted_content"]`. |
| `reasoning` | `{ effort, summary }` with reviewed values only; `summary` limited to `none` or `auto` after review. |
| `text` | `{ format }` of `text` or `json_schema` only, and `verbosity`. |
| `temperature`, `top_p` | Numbers. |
| `truncation` | `disabled` only, so a request never silently drops input. |

Refused by name: `background` and `background_options` (work that outlives the run), `conversation`, `previous_response_id` and `prompt` (server-side state and stored prompts), `context_management` (server-side compaction spends beyond the body), `prompt_cache_options` and `prompt_cache_retention` (longer cache writes cost more and outlive the run), `prompt_cache_key`, `service_tier` (Fast mode is dearer; Standard only), `max_tool_calls` (hosted tools only), `metadata`, `safety_identifier`, `user`, `moderation`, `access_programs`, `image`, `top_logprobs`, `stream_options`. This mirrors the Anthropic dialect's rule: anything that could act or spend outside Runner's tools and its worst case is refused.

**The output bound.** `max_output_tokens` is "an upper bound for the number of tokens that can be generated for a response, including visible output tokens and reasoning tokens" (`openai` 7.62.0, `ResponseCreateParamsBase.max_output_tokens`, read 2026-11-21). So it bounds exactly what the broker reserves as output, and is rewritten exactly as `max_tokens` is now: `min(caps.max_tokens, output tokens left, the value asked)`, after a parse and rewrite so a duplicate key can't slip past. Whether the API ever bills output above `max_output_tokens` is unverified; the spike checks `output_tokens` never exceeds it.

**Worst case.** Unchanged in form: body bytes plus `INPUT_MARGIN_TOKENS` at the dearest input rate of the tier the bound falls in, plus all of `max_output_tokens` at the output rate. OpenAI's long-context tier starts above 272K input tokens ([pricing](https://developers.openai.com/api/docs/pricing), read 2026-11-21), so `above_input_tokens: 272_000`.

**Usage read back,** by the transport's OpenAI dialect in `node/provider-transport.ts`, as `streamUsage` reads Anthropic's stream there today; the broker only prices the usage it is handed. The non-streamed answer's `usage`, or for a stream, the `usage` of the `response.completed` event, and only once it arrives; a cut stream, an `error` or `response.failed` event, `response.incomplete`, or an answer that isn't 2xx counts the request's whole worst case, as `message_stop` does now. The fields (`openai` 7.62.0, `ResponseUsage`, read 2026-11-21): `input_tokens`, `input_tokens_details.cached_tokens`, `input_tokens_details.cache_write_tokens` (with `cache_write_tokens_details.ttl_30m_tokens` and `ttl_12h_tokens`), `output_tokens`, `output_tokens_details.reasoning_tokens`, `total_tokens`.

**Pricing them.** Whether OpenAI's cached and cache-write counts are parts of `input_tokens`, and reasoning tokens part of `output_tokens`, is **unverified**. Until the spike settles it, the reading must overcount, never undercount: price all of `input_tokens` at the input rate, plus `cached_tokens` at the cache-read rate and `cache_write_tokens` at the 30-minute write rate on top, as if the three were disjoint; and price `output_tokens + reasoning_tokens` at the output rate. If the fields are nested, this counts cached and cache-write tokens twice and reasoning tokens twice, which is the safe side. The reading is narrowed only after the spike shows the nesting, by a reviewed change. A usage object missing any of these fields counts the worst case.

**The long-context tier's input measure** for this dialect is `input_tokens` plus `cached_tokens` plus `cache_write_tokens`, compared with `above_input_tokens: 272_000`. That is what `costOf` in `broker.ts` already sums for Anthropic's fields; mapped onto OpenAI's fields it overcounts if they are nested, so a request can be priced at the long-context tier when OpenAI would bill the short one, which is the safe side too.

**Price table** (micro-USD per million tokens, Standard tier, from [OpenAI's pricing page](https://developers.openai.com/api/docs/pricing), read 2026-11-21; the page shows no as-of date):

| Model | Input | Cached input | Cache write (30m) | Output | Above 272K input: input / cached / write / output |
| --- | --- | --- | --- | --- | --- |
| `gpt-6-luna` (proposed) | 100,000 | 10,000 | 125,000 | 500,000 | 200,000 / 20,000 / 250,000 / 750,000 |
| `gpt-6.1-terra` (alternative, needs the owner) | 1,000,000 | 50,000 | 1,250,000 | 5,000,000 | 2,000,000 / 100,000 / 2,500,000 / 7,500,000 |

`gpt-6-luna` is proposed because it is the cheapest current model on the page, priced like the Claude path's Haiku 5.5, so the same caps mean roughly the same work. Whether it is capable enough for coding tasks is unknown until the spike. A larger model joins only by a new profile entry after review, as for Claude. 12-hour cache writes are never priced, because `prompt_cache_retention` and `prompt_cache_options` are refused; if usage ever reports `ttl_12h_tokens` above zero, the request counts its worst case and the run stops (`usage_unexpected`).

## policy.json and the key file

**The adapter.** `ADAPTERS` in `policy.ts` becomes `["claude_agent_sdk", "openai_agents"]`. The adapter stays a run fact, so a run decision is bound to it, and the run frame names it.

**Per Runner first, per room later.** Today `adapter` is one top-level field: one Runner, one provider. Proposed: keep it so for the first OpenAI release, since each Runner already has one key file and one engine. A room-level override (`rooms[].adapter`, defaulting to the top level) is a small change later, but it means two key files, two engines and two day budgets per Runner, which is a separate ruling ([question 3](#questions-for-the-owner)).

**The key file.** Unchanged in shape: `run --provider-key-file <path>`, the same checks (a regular file, not a link, owned by the owner, readable by no one else, one key), read once into the transport. The key format check widens to OpenAI's project keys (`sk-proj-…`, longer than Anthropic's), with the transport's key pattern made per profile. Runner refuses to start if the key's prefix doesn't match the adapter's provider, so an Anthropic key is never sent to OpenAI or the reverse. Proposed location for the owner's: `~/.podster/openai-runner.key`, as for spike B's key. The key is an **OpenAI project API key** in a project made for Runner only, with the project's monthly budget set ([question 4](#questions-for-the-owner): whether OpenAI's project budget is a hard stop is unverified; Runner's broker is the hard stop either way).

## Reused and new

**Reused unchanged:** `SupervisedAdapter`, the run policy and its decisions, caps and budget reservations, the task container, egress proxy, toolchains, `tool-policy.ts`'s tool names, checks and refusal text, `RESULT_SCHEMA` and Runner's result check, the run frame, progress events, the run store, recovery, the key store's file checks, the transport's environment refusals.

**Changed:** `broker.ts` gains the dialect seam (body check, output-bound key, forced keys, and the mapping of OpenAI's usage fields onto its pricing); `provider-transport.ts` gains, per dialect, the auth header and the usage reader (`response.completed` for OpenAI, `message_stop` for Anthropic); `policy.ts` gains the adapter name; `cli.ts` builds the engine the policy's adapter names.

**New:** `openai-profile.ts` (profile, prices, the pinned package versions, a version check like `versionRefusal`), `openai-driver.ts`, `openai-engine.ts` (no image to pin, only the version check, key file and transport), their tests, and the source test above.

**Claude-specific, and not carried over:** the Claude Code container, relay, listener and per-run token; the pinned SDK and Claude Code pair and the `claude-image` Dockerfile; `settingSources: []`, `strictMcpConfig`, `persistSession`, `verbatimPrompts`, `tools: []`, the `dontAsk` permission mode; the `PreToolUse` hook and the `hook_bypassed` check; `PLUGIN_ALLOWLIST` and `SDK_ENV_NAMES`; the init wait; bare mode; the in-process MCP server that carries Runner's tools to Claude Code. The Agents SDK needs none of them, because nothing outside Runner's process acts.

## Security review items

Proposed as S-53 to S-58 for M7's security review (or the review that admits this adapter), each to be shown, not assumed:

- **S-53, tracing and stray traffic.** No import of the umbrella or the trace exporter; tracing off three ways; no connection from Runner's process to anything but the broker's upstream and Podster during a real run; the WebSocket transport never used.
- **S-54, the key.** Only the transport holds it; the SDK's client holds the placeholder; the key never appears in a log, error, progress event or diagnostics file; a key of the wrong provider is refused at start; `OPENAI_API_KEY` in Runner's environment is refused.
- **S-55, the body allowlist.** Each refused key and tool type has a test by name; a hosted tool, `background`, `previous_response_id`, `conversation`, a non-Standard `service_tier` and a longer cache retention can't pass; `store` is always `false` upstream.
- **S-56, the output bound and usage.** `max_output_tokens` is rewritten on every request; billed `output_tokens` never exceed it; the usage nesting is confirmed or the conservative reading kept; a missing or partial usage counts the worst case.
- **S-57, prompt injection from repository files.** The SDK reads no `AGENTS.md`, `.codex/` or any file; anything from the repository reaches the model only as a tool's output inside the untrusted frame, and Runner's checks, not the model, decide every tool call. The same holds for task text and other agents' messages.
- **S-58, supply chain.** Exact versions of `@openai/agents-core`, `@openai/agents-openai` and `openai` with lockfile integrity; Runner refuses to start on any other installed version; no install-time scripts (no `preinstall`, `install` or `postinstall` in the packages' `package.json`, read 2026-11-21; recheck on each pin); `@openai/agents-realtime` absent from the lockfile.

**Data retention, for the owner's record:** with `store: false` OpenAI doesn't keep the response for later retrieval through the API, but OpenAI's data controls page lists retention for abuse monitoring separately ([your data](https://developers.openai.com/api/docs/guides/your-data), linked from the `store` field's documentation; not read in full). Zero Data Retention is an organization agreement with OpenAI, not a request flag.

## Spike plan

A spike, `spikes/m7-openai` (or a test branch of Runner), run locally by the architect on the owner's machine, with a **dedicated OpenAI project and key used for nothing else**, and Runner's caps set low. Nothing in it is merged as product code.

1. **No network at all first:** the driver against a stub broker answering recorded-shape Responses bodies, to check the loop, tools, `StructuredOutput` and cancellation. Free.
2. **Tracing and traffic:** connection hooks on, one real run; record every outbound connection by host and port only.
3. **Body and bound:** a run whose model is asked for more than the bound; confirm `output_tokens` ≤ `max_output_tokens` on every request, and that each refused key is in fact refused before sending.
4. **Usage nesting:** compare each request's usage fields with the dashboard's figures for the project, to settle whether cached, cache-write and reasoning tokens are parts of the totals.
5. **The same three tasks spike B ran** for Claude (read-only answer, a small edit with tests in a Node room, a refused tool call), to compare behavior and spend with `gpt-6-luna`; then once with `gpt-6.1-terra` only if the owner allows it.
6. **Cancellation and cap stop:** a run stopped mid-request and one stopped by the spend cap; record how far spend passed the cap, which should be zero by the broker's reservation.

**Proposed spend cap for the spike: 2.00 USD in total,** set as the dedicated project's budget and enforced by Runner's caps: 0.20 USD per run (`spend_micro_usd: 200_000`) and 2.00 USD per day (`day_caps.spend_micro_usd: 2_000_000`). At `gpt-6-luna`'s prices, 0.20 USD is about 400K output tokens or 2M input tokens per run, far more than spike B's runs used (the whole of step 9(b)'s real runs was capped at 0.326 USD). No spend happens until the owner approves this figure and creates the key.

## Questions for the owner

1. **The SDK:** the Agents SDK as recommended, or Codex (its own coding agent, but a larger and less controllable surface, as above), or both later?
   *Answered 2026-11-21 by the architect, on the owner's behalf:* the Agents SDK, as recommended. Codex is set aside, and is revisited only if the Agents SDK path fails the spike.
2. **The spike's spend:** approve 2.00 USD on a dedicated OpenAI project key, created by you (Runner and its builders never create accounts or keys), at `~/.podster/openai-runner.key`?
   *Still the owner's (2026-11-21).* The 2.00 USD spike and creating the key at `~/.podster/openai-runner.key` wait on the owner.
3. **Per Runner or per room:** keep one provider per Runner for now, or let one Runner run Claude in one room and OpenAI in another (two keys, two budgets)?
   *Answered 2026-11-21 by the architect, on the owner's behalf:* one provider per Runner for now, through policy.json's top-level `adapter`; a per-room adapter comes later.
4. **The OpenAI project's budget:** do you want the project budget set to match Runner's day cap as a second lock? Whether OpenAI enforces a project budget as a hard stop is unverified here.
   *Still the owner's (2026-11-21).* The OpenAI project's budget is the owner's to set.
5. **The model:** `gpt-6-luna` only at first (cheapest, unknown coding ability), or also `gpt-6.1-terra` (ten times the price) for the spike's comparison?
   *Answered 2026-11-21 by the architect, on the owner's behalf:* `gpt-6-luna` only, for the spike.
6. **Order:** start this after M7's gates close for the Claude adapter, or alongside? Under decision 26 nothing ships before M7's gates either way, and an OpenAI adapter adds its own items (S-53 to S-58) to the security review.
   *Answered 2026-11-21 by the architect, on the owner's behalf:* the design and the spike may run now; the adapter's code lands after M7's Claude gates (step 18), so S-53 to S-58 join a later security review, not M7's.
   *Revised 2026-11-22 by the architect (the owner said "up to ur rec"):* the adapter is built and merged now, not after M7's Claude gates, **off by default**. What was built on 2026-11-22:
   - The `openai_agents` driver (`apps/runner/src/node/openai-driver.ts`) behind the existing driver interface, importing only `@openai/agents-core` 0.22.0, `@openai/agents-openai` 0.22.0 and `openai` 7.62.0, pinned exactly with lockfile integrity, bundled, with no install scripts and `@openai/agents-realtime` absent. Runner refuses to start on any other installed version.
   - The opt-in: policy.json takes `adapter: "openai_agents"` only with `experimental_openai: true` beside it; otherwise the file is refused and `run` won't start. With it, `run` prints a warning that room content goes to OpenAI under OpenAI's standard retention, for test content only. Claude stays the default, and the Claude path is unchanged but for one start check: its transport now refuses a key shaped as an OpenAI project key (`sk-proj-`), so an OpenAI key is never sent to Anthropic.
   - The broker's Responses dialect, as [the broker profile](#the-broker-profile) above sets out, with usage read **nested** as the spike found (cached and cache-write tokens inside `input_tokens`, reasoning inside `output_tokens`), not the overcounting reading. A missing or partial usage, a usage whose parts exceed their whole, and an incomplete, failed or cut answer count the worst case; a 12-hour cache write stops the run (`usage_unexpected`). Prices were rechecked against OpenAI's pricing page on 2026-11-22 and match the table above.
   - **The reasoning headroom rule** (the spike's `bound` lesson): an OpenAI request's `max_output_tokens` is never below 4,096. A policy for this adapter with `caps.max_tokens` below 4,096 is refused at load, a request asking less is refused by name (`max_output_tokens:below_floor`), and when fewer than 4,096 of the run's output tokens are left the run stops on `output_tokens_exhausted` instead of sending a request that could only reason. 4,096 is the bound every completed spike run used, at the driver's fixed `low` effort.
   - Runner refuses to start with `OPENAI_API_KEY`, any other `OPENAI_` name but the three that only switch things off, or `ANTHROPIC_API_KEY` in its environment, and with a key file holding another provider's key.
   - Tests for S-53 to S-58, by name, in `apps/runner/test/openai-adapter.test.ts`, all offline against a fake upstream: no OpenAI call and no spend.
   Still open, and **not decided by this ruling**: question 7 (data retention for real room content) and the billing check of the spike's figures against OpenAI's usage page, both the owner's. S-53 to S-58 still owe a security review on the real path. Nothing claims OpenAI is supported.
7. **Data retention:** is `store: false` with OpenAI's standard abuse-monitoring retention acceptable for room content, or does an OpenAI room need Zero Data Retention on your OpenAI organization first?
   *Still the owner's (2026-11-21):* sending room content to OpenAI under standard retention is a data stance for the owner; the architect recommends `store: false` with standard retention for test content only.
   *Answered 2026-11-23 by the owner ("a"):* `store: false` with OpenAI's standard abuse-monitoring retention is acceptable for room content. Zero Data Retention isn't required first. The adapter stays opt-in (`experimental_openai: true`) with its test-content warning until the billing check passes: the owner compares the spike's 2026-11-21 usage (`spikes/m7-openai/results/`) with the OpenAI project's usage page, which also settles whether cached tokens are parts of `input_tokens`. After that, one small real run, then the warning and the "experimental" status are revisited.

## Unverified

Everything about runtime behavior: the SDK's actual traffic, the usage nesting, billing against `max_output_tokens`, `reasoning.encrypted_content` with `store: false` for `gpt-6-luna`, `gpt-6-luna`'s coding ability, OpenAI project budget enforcement, and, for Codex, bubblewrap inside Runner's container and whether `project_doc_max_bytes = 0` stops `AGENTS.md` loading. Prices change; recheck them on the day a profile is pinned.
