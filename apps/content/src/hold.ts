// An app's answer body, held before its headers are sent (C09, 2026-11-26). Staging's run of 2026-11-25 saw an app
// that passed its CPU limit after its headers were sent reach the visitor as status `200` with the 6 bytes sent before
// the stop and a body that ended normally: a truncated `200` no visitor could tell from a whole one.
//
// Cloudflare documents that a user Worker that passes a custom limit "will immediately throw an exception"
// ([custom limits](https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/configuration/custom-limits/)),
// that the dispatching Worker's `fetch()` waits for the headers only, and that "a recorded HTTP `200` does not mean the
// whole body arrived" ([service bindings, HTTP](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/http/)).
// So a limit passed while the body streams can surface only on the body, as a failed read, and only once its headers
// are already the app's `200`. This Worker can't change what was already sent, so it does two things:
//
// 1. **It holds the body before sending headers,** up to `HOLD_BYTES` and for up to `HOLD_MS`. A body that ends within
//    both is sent whole, with its exact `Content-Length`, so a visitor can always tell a short body. A body whose read
//    fails within both is never sent: the answer is this Worker's own `502 app_error`, as for an app that throws before
//    its headers.
// 2. **A body that outgrows the hold is streamed,** what was held first, through a stream of this Worker's own that is
//    errored, never closed, when the app's body fails. An errored body is a truncated response, which the runtime sends
//    as an aborted one (HTMLRewriter's documented "the client will see a truncated response"), never a clean end. The
//    error carries a fixed message, never the app's.
//
// What this can't do: if the platform ever ended a stopped app's body cleanly instead of failing it, no Worker in front
// could tell that from a whole body. Staging's C09 shows which it is.

/** The most of a body held before the headers are sent: 1 MiB, far under a Worker's 128 MB of memory. */
export const HOLD_BYTES = 1024 * 1024;
/** The longest a body is held before the headers are sent, so an answer that streams for long still starts. */
export const HOLD_MS = 1_000;

/** What a held body came to. */
export type Held =
  /** It ended within the hold: its bytes. */
  | { kind: "whole"; bytes: Uint8Array<ArrayBuffer> }
  /** It outgrew the hold: a stream of what was held and then the rest, errored if the app's body fails. */
  | { kind: "streamed"; body: ReadableStream<Uint8Array> }
  /** Its read failed within the hold: nothing of it is sent. */
  | { kind: "failed" };

/** The fixed error a streamed body ends with when the app's fails. Nothing of the app's message is in it. */
export const STREAM_FAILED = "app_stream_failed";

const ignore = (promise: Promise<unknown>) => {
  promise.catch(() => {});
};

/**
 * Holds `body` until it ends, its bytes pass `maxBytes`, or `wait` settles, whichever is first. `lateFailure` is called
 * once if the app's body fails after the headers were sent, so the Worker can log it.
 */
export async function holdBody(body: ReadableStream<Uint8Array>, wait: Promise<void>, lateFailure: () => void, maxBytes = HOLD_BYTES): Promise<Held> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let held = 0;
  const timeUp = wait.then(() => "time" as const);
  let next = reader.read();
  ignore(next);
  for (;;) {
    let step: ReadableStreamReadResult<Uint8Array> | "time";
    try {
      step = await Promise.race([next, timeUp]);
    } catch {
      ignore(reader.cancel());
      return { kind: "failed" };
    }
    if (step === "time") break;
    if (step.done) {
      const bytes = new Uint8Array(held);
      let at = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, at);
        at += chunk.byteLength;
      }
      return { kind: "whole", bytes };
    }
    chunks.push(step.value);
    held += step.value.byteLength;
    next = reader.read();
    ignore(next);
    if (held > maxBytes) break;
  }
  // Outgrown: what was held, then the rest as it comes. The read already asked for is the first of the rest.
  const streamed = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      chunks.length = 0;
    },
    async pull(controller) {
      let step: ReadableStreamReadResult<Uint8Array>;
      try {
        step = await next;
      } catch {
        try {
          lateFailure();
        } catch {
          // Nothing: the body is errored with or without the line.
        }
        controller.error(new Error(STREAM_FAILED));
        return;
      }
      if (step.done) {
        controller.close();
        return;
      }
      controller.enqueue(step.value);
      next = reader.read();
      ignore(next);
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
  return { kind: "streamed", body: streamed };
}
