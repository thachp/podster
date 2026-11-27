/**
 * The OpenAI Agents SDK's driver (RUNNER-OPENAI.md, "How the Agents SDK driver works"; built 2026-11-22 under the
 * architect's revised ruling on question 6). **Experimental and off by default:** policy.json must name
 * `adapter: "openai_agents"` and `experimental_openai: true`. Not verified for support. It implements `AgentDriver` and
 * decides nothing: the run policy, the task container, the key, the budget and the outcome are `SupervisedAdapter`'s.
 *
 * - **No process or container of its own.** The SDK's loop runs in Runner's process. Every tool is Runner's own function
 *   tool (`strict: true`), whose `execute` calls `session.check` first and only then `session.tool`, which runs it in
 *   the task's container. A refusal returns Runner's fixed refusal text and runs nothing. No built-in or hosted tool
 *   is imported or offered, and the SDK's approval hook isn't used: Runner's check is the only approval.
 * - **Every model request goes through the broker.** The SDK's OpenAI client holds the placeholder key, never the real
 *   one, has `maxRetries: 0`, and its `fetch` is `brokerFetch`: it takes only `POST` to exactly the profile's upstream
 *   URL with no query and a non-streamed body, and hands it to `session.model`. Anything else fails the run with
 *   `model_request_refused` before the broker sees it. The client's base URL is derived from the profile, so this file
 *   names no host or path. The Responses WebSocket transport is never used.
 * - **Tracing locked down three ways** (S-53): `setTracingDisabled(true)` and `setTraceProcessors([])` once, and
 *   `tracingDisabled: true` in every SDK `Runner`; sensitive-data logging off. Only `@openai/agents-core`,
 *   `@openai/agents-openai` and `openai` are imported; never the `@openai/agents` umbrella, whose import turns on
 *   OpenAI's trace exporter (a source test holds this). The SDK's model provider refuses every lookup, so nothing can
 *   build a client of its own from a model name.
 * - **Fixed settings:** `store: false`, `parallelToolCalls: false` (each call reaches the decision point in turn),
 *   `truncation: "disabled"`, the fixed reasoning effort with encrypted reasoning carried across turns, `maxTokens` from
 *   the run's caps (the broker rewrites it anyway) and `maxTurns` from the run's limits (the broker's turn cap is first).
 * - **The prompt:** the run's frame is the agent's instructions; the task's text is the user input, exactly, which the
 *   frame marks as another party's untrusted data. The SDK reads no file: nothing from the repository reaches the model
 *   but a tool's output.
 * - **The result:** a `StructuredOutput` function tool. Its call is checked like any other; an accepted one records the
 *   result and ends the loop, a refused one returns the refusal text and the loop goes on.
 * - **Cancel** aborts the run's `AbortSignal`, which the SDK's run takes; the task's container is killed by
 *   `SupervisedAdapter`.
 *
 * Logs carry codes only. The SDK's own errors carry text, so only that one happened is kept, as `sdk_error`.
 */
import { Agent, MaxTurnsExceededError, Runner, setSensitiveDataLoggingEnabled, setTraceProcessors, setTracingDisabled, tool, type FunctionToolResult, type ModelProvider, type Tool as SdkTool } from "@openai/agents-core";
import { OpenAIResponsesModel } from "@openai/agents-openai";
import OpenAI from "openai";
import { upstreamUrl } from "../core/broker.js";
import { OPENAI_MODEL, OPENAI_MODELS, OPENAI_PROFILE, OPENAI_REASONING_EFFORT, openaiBaseUrl, openaiVersionRefusal } from "../core/openai-profile.js";
import { RESULT_TOOL } from "../core/policy.js";
import { CHANGE_TYPES } from "../core/pull-text.js";
import { SUMMARY_FIELD_DESCRIPTION, type AgentDriver, type DriverOutcome, type DriverRun, type DriverSession } from "../core/run-interface.js";
import { silentLogger, type Logger } from "../core/runtime.js";
import { shellDescription } from "../core/toolchains.js";
import { MAX_SUMMARY_CHARS, refusalText } from "../core/tool-policy.js";

const REF = /^[A-Za-z0-9_-]{1,128}$/;

/** A JSON schema for a strict function tool: every property required, nothing else allowed. */
type Schema = { type: "object"; properties: Record<string, unknown>; required: string[]; additionalProperties: false };
const strictSchema = (properties: Record<string, unknown>): Schema => ({ type: "object", properties, required: Object.keys(properties), additionalProperties: false });
const STRING = { type: "string" };
/** Strict mode has no optional property: an optional one is nullable, and a null is dropped before Runner's check. */
const NULLABLE_STRING = { type: ["string", "null"] };

/** Each of Runner's tools, its strict input schema, and what it tells the model. Fixed. */
export const OPENAI_TOOL_SHAPES: Readonly<Record<"read" | "search" | "write" | "edit" | "shell", { description: string; parameters: Schema }>> = Object.freeze({
  read: { description: "Read a file in the task's folder. Its path is relative to the folder, such as src/a.ts.", parameters: strictSchema({ path: STRING }) },
  search: { description: "Search the task's folder, or a folder in it given by a relative path (null for the whole folder), for a regular expression.", parameters: strictSchema({ pattern: STRING, path: NULLABLE_STRING }) },
  write: { description: "Write a whole file in the task's folder. Its path is relative to the folder, such as notes.txt.", parameters: strictSchema({ path: STRING, content: STRING }) },
  edit: { description: "Replace one exact piece of text, which must appear once, in a file in the task's folder. Its path is relative to the folder.", parameters: strictSchema({ path: STRING, old: STRING, new: STRING }) },
  shell: { description: shellDescription([]), parameters: strictSchema({ command: STRING }) },
});

/**
 * The structured result's strict schema: Runner's `RESULT_SCHEMA` in the shape strict mode takes (every property
 * required, `change_type` nullable). Its bounds aren't repeated here, but the summary's limit is named in words (2026-11-27):
 * Runner checks the result itself either way.
 */
export const OPENAI_RESULT_PARAMETERS: Schema = strictSchema({
  status: { type: "string", enum: ["completed", "blocked"] },
  summary: { type: "string", description: SUMMARY_FIELD_DESCRIPTION },
  files: { type: "array", items: STRING },
  change_type: { type: ["string", "null"], enum: [...CHANGE_TYPES, null] },
});
export const RESULT_DESCRIPTION = `Give the task's structured result: call it once, when you are done or can't go on. Its summary is at most ${MAX_SUMMARY_CHARS} characters.`;

/** The tool's input with its nulls dropped, as Runner's policy reads it; anything not an object is passed as it is. */
function withoutNulls(input: unknown): unknown {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return input;
  return Object.fromEntries(Object.entries(input as Record<string, unknown>).filter(([, v]) => v !== null));
}

/** The SDK's tool input: an object, or a JSON string of one; anything that isn't is passed on for Runner's check to refuse. */
function parsedInput(input: unknown): unknown {
  if (typeof input !== "string") return input;
  try {
    return JSON.parse(input) as unknown;
  } catch {
    return input;
  }
}

/** Refuses every lookup, so the SDK never builds a default OpenAI client from a model name. */
const REFUSING_PROVIDER: ModelProvider = Object.freeze({
  getModel(): never {
    throw new Error("model_provider_refused");
  },
});

let lockedDown = false;
/** Tracing off, twice here and once per SDK `Runner`; sensitive-data logging off. Idempotent. */
export function lockDownOpenAiSdk(): void {
  setTracingDisabled(true);
  setTraceProcessors([]);
  setSensitiveDataLoggingEnabled(false);
  lockedDown = true;
}
export const sdkLockedDown = () => lockedDown;

/** The bytes of a request body the OpenAI client hands its fetch, or null for anything else. */
function bodyBytes(body: unknown): Uint8Array | null {
  if (typeof body === "string") return new TextEncoder().encode(body);
  if (body instanceof Uint8Array) return body;
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  return null;
}

/** Whether a body asks to stream. The driver never streams, so such a request is refused. */
function asksToStream(body: Uint8Array): boolean {
  try {
    const parsed = JSON.parse(new TextDecoder().decode(body)) as unknown;
    return typeof parsed === "object" && parsed !== null && (parsed as { stream?: unknown }).stream === true;
  } catch {
    return false;
  }
}

/**
 * The OpenAI client's `fetch`: never the network. Only `POST` to exactly the profile's upstream URL, with no query and a
 * non-streamed body, goes on, to `session.model`; anything else calls `refused` and throws `model_request_refused`.
 * The headers the client sends, its placeholder key among them, are dropped: the broker forwards none.
 */
export function brokerFetch(session: Pick<DriverSession, "model">, refused: (code: string) => void): typeof globalThis.fetch {
  const expected = upstreamUrl(OPENAI_PROFILE);
  return async (input, init) => {
    const refuse = (code: string): never => {
      refused(code);
      throw new Error("model_request_refused");
    };
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : refuse("model_request_refused");
    if (url !== expected) refuse("model_request_refused");
    if ((init?.method ?? "GET").toUpperCase() !== "POST") refuse("model_request_refused");
    const body = bodyBytes(init?.body);
    if (body === null || asksToStream(body)) return refuse("model_request_refused");
    const parsed = new URL(url);
    const answer = await session.model({ method: "POST", path: parsed.pathname, query: parsed.search.replace(/^\?/, ""), body });
    if (!answer.ok) return refuse(answer.refused === "upstream_failed" ? "upstream_failed" : "model_request_refused");
    return new Response(answer.body as Uint8Array<ArrayBuffer>, { status: answer.status, headers: { "content-type": "application/json" } });
  };
}

export type OpenAIDriverDeps = {
  /** The installed packages' versions, by name: each must be exactly the pin (S-58). */
  installed: Readonly<Record<string, unknown>>;
  log?: Logger;
};

type Live = { abort: AbortController; done: Promise<unknown> };

export class OpenAIDriver implements AgentDriver {
  readonly adapter = "openai_agents" as const;
  readonly profile = OPENAI_PROFILE;
  readonly models = OPENAI_MODELS;
  private readonly deps: OpenAIDriverDeps;
  private readonly live = new Map<string, Live>();

  constructor(deps: OpenAIDriverDeps) {
    const refused = openaiVersionRefusal(deps.installed);
    if (refused) throw new Error(`Runner won't run these OpenAI packages: ${refused.slice("version:".length)} isn't the pinned version.`);
    this.deps = deps;
    lockDownOpenAiSdk();
  }

  private log(outcome: string, code?: string) {
    (this.deps.log ?? silentLogger)("adapter.openai", outcome, code ? { code } : {});
  }

  async begin(session: DriverSession): Promise<DriverRun> {
    const ref = session.run_ref;
    if (!REF.test(ref)) throw new Error("run_ref_invalid");
    lockDownOpenAiSdk();
    const abort = new AbortController();
    if (session.signal.aborted) abort.abort();
    session.signal.addEventListener("abort", () => abort.abort(), { once: true });
    let failure: string | null = null;
    const fail = (code: string) => {
      if (failure === null) {
        failure = code;
        this.log("failed", code);
      }
      abort.abort();
    };

    const client = new OpenAI({ apiKey: session.provider.api_key, baseURL: openaiBaseUrl(OPENAI_PROFILE), organization: null, project: null, webhookSecret: null, maxRetries: 0, fetch: brokerFetch(session, fail) });
    const model = new OpenAIResponsesModel(client, OPENAI_MODEL);

    const callIdOf = (details: unknown): string => {
      const id = (details as { toolCall?: { callId?: unknown } } | undefined)?.toolCall?.callId;
      return typeof id === "string" ? id : "";
    };
    const runnerTool = (name: keyof typeof OPENAI_TOOL_SHAPES): SdkTool =>
      tool({
        name,
        description: name === "shell" ? shellDescription(session.toolchains) : OPENAI_TOOL_SHAPES[name].description,
        parameters: OPENAI_TOOL_SHAPES[name].parameters,
        strict: true,
        errorFunction: null,
        execute: async (raw: unknown, _context: unknown, details: unknown) => {
          const call = { call_id: callIdOf(details), tool: name, input: withoutNulls(parsedInput(raw)) };
          const decision = session.check(call);
          if (!decision.allow) return refusalText(decision.reason, decision.rule);
          const output = await session.tool(call);
          return output.text === "" ? (output.ok ? "Done." : "Failed.") : output.text;
        },
      }) as unknown as SdkTool;

    let result: unknown = null;
    const resultTool = tool({
      name: RESULT_TOOL,
      description: RESULT_DESCRIPTION,
      parameters: OPENAI_RESULT_PARAMETERS,
      strict: true,
      errorFunction: null,
      execute: async (raw: unknown, _context: unknown, details: unknown) => {
        const input = withoutNulls(parsedInput(raw));
        const call = { call_id: callIdOf(details), tool: RESULT_TOOL, input };
        const decision = session.check(call);
        if (!decision.allow) return refusalText(decision.reason, decision.rule, input);
        const output = await session.tool(call);
        if (!output.ok) return refusalText("run_stopped");
        result = input;
        return "Recorded.";
      },
    }) as unknown as SdkTool;

    const allowed = session.allowed_tools.filter((t): t is keyof typeof OPENAI_TOOL_SHAPES => Object.hasOwn(OPENAI_TOOL_SHAPES, t));
    const tools: SdkTool[] = [...allowed.map(runnerTool), ...(session.allowed_tools.includes(RESULT_TOOL) ? [resultTool] : [])];

    const agent = new Agent({
      name: "runner-task",
      instructions: session.frame,
      model,
      tools,
      // The loop ends only on a result Runner accepted; a refused one goes back to the model.
      toolUseBehavior: (_context: unknown, results: FunctionToolResult[]) =>
        result !== null && results.some((r) => r.tool.name === RESULT_TOOL) ? { isFinalOutput: true, isInterrupted: undefined, finalOutput: "result" } : { isFinalOutput: false, isInterrupted: undefined },
      modelSettings: {
        store: false,
        maxTokens: session.limits.max_tokens,
        parallelToolCalls: false,
        truncation: "disabled",
        reasoning: { effort: OPENAI_REASONING_EFFORT },
        providerData: { include: ["reasoning.encrypted_content"] },
      },
    });
    const runner = new Runner({ tracingDisabled: true, traceIncludeSensitiveData: false, modelProvider: REFUSING_PROVIDER });

    const done = (async (): Promise<DriverOutcome> => {
      try {
        if (!abort.signal.aborted) await runner.run(agent, session.prompt.text, { maxTurns: session.limits.turns, signal: abort.signal });
      } catch (error) {
        // The SDK's own error carries text: never kept, only its kind.
        if (failure === null) fail(error instanceof MaxTurnsExceededError ? "max_turns" : abort.signal.aborted ? "aborted" : "sdk_error");
      }
      if (failure !== null) throw new Error(failure);
      return { result };
    })();
    done.catch(() => undefined);
    const live: Live = { abort, done };
    this.live.set(ref, live);
    void done.finally(() => {
      if (this.live.get(ref) === live) this.live.delete(ref);
    }).catch(() => undefined);
    return { done, cancel: () => this.stop(ref) };
  }

  /** Aborts the run's signal and waits, bounded, for the SDK's loop to end. */
  private async stop(ref: string): Promise<void> {
    const live = this.live.get(ref);
    if (!live) return;
    live.abort.abort();
    await Promise.race([live.done.catch(() => undefined), new Promise((resolve) => setTimeout(resolve, 5_000))]);
  }

  /** Nothing of the run is left: its loop, the only thing of its own, has ended. */
  async confirmGone(run_ref: string): Promise<boolean> {
    if (!REF.test(run_ref)) return false;
    return !this.live.has(run_ref);
  }

  /** After a restart: the loop died with the previous process, so there is nothing of this driver's to reap. */
  async reap(run_ref: string): Promise<void> {
    await this.stop(run_ref);
  }
}
