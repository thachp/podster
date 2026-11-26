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
// 1. **It holds the body before sending headers,** up to `HOLD_BYTES` and for up to `HOLD_MS` (no time at all for an
//    event stream, which is meant to be read as it comes). A body that ends within both is sent whole, with its exact
//    `Content-Length`, so a visitor can always tell a short body. A body whose read fails within both is never sent:
//    the answer is this Worker's own `502 app_error`, as for an app that throws before its headers.
// 2. **A body that outgrows the hold is streamed,** what was held first, through a stream of this Worker's own that is
//    errored, never closed, when the app's body fails. An errored body is a truncated response, which the runtime sends
//    as an aborted one (HTMLRewriter's documented "the client will see a truncated response"), never a clean end. The
//    error carries a fixed message, never the app's.
//
// **Memory is bounded per request, whatever the app sends** (review of PR 613): a chunk is held only if it fits under
// `HOLD_BYTES` with what is already held, so at most 64 KiB is ever held; a chunk that doesn't fit stops the hold and
// is passed on as it is. Nothing is copied: a whole body is written chunk by chunk into a fixed-length stream, and the
// rest of an outgrown body is piped, with backpressure, so a slow visitor holds back the app, not this Worker's memory.
// After the hold no code of this Worker's runs per chunk: the rest is a native pipe on Workers.
//
// What this can't do: if the platform ended a stopped app's body cleanly instead of failing it, no Worker in front
// could tell that from a whole body. Staging's run of 2026-11-26 saw a CPU stop past the hold reach the visitor as a
// body that ended normally, most likely that way: a known platform limitation, unconfirmed until `/api/after-hold`
// passes on staging (docs/m6-plan.md, C09). A body the app itself fails is still errored here.

/** The most of a body held before the headers are sent: 64 KiB, checked before each chunk is held. */
export const HOLD_BYTES = 64 * 1024;
/** The longest a body is held before the headers are sent, so an answer that streams for long still starts. */
export const HOLD_MS = 1_000;

/** What a held body came to. */
export type Held =
  /** It ended within the hold: a stream of exactly `length` bytes, sent with that `Content-Length`. */
  | { kind: "whole"; body: ReadableStream<Uint8Array>; length: number }
  /** It outgrew the hold: a stream of what was held and then the rest, errored if the app's body fails. */
  | { kind: "streamed"; body: ReadableStream<Uint8Array> }
  /** Its read failed within the hold: nothing of it is sent. */
  | { kind: "failed" };

/** The fixed error a streamed body ends with when the app's fails. Nothing of the app's message is in it. */
export const STREAM_FAILED = "app_stream_failed";

const ignore = (promise: Promise<unknown>) => {
  promise.catch(() => {});
};

type Pair = { readable: ReadableStream<Uint8Array>; writable: WritableStream<Uint8Array> };
// Workers' native streams, where they exist: a pipe into them runs no JavaScript per chunk, and a fixed-length one
// sends exactly its length. Elsewhere, as under the tests, the standard identity stream.
const native = globalThis as unknown as { IdentityTransformStream?: new () => Pair; FixedLengthStream?: new (length: number) => Pair };
const identity = (): Pair => (native.IdentityTransformStream ? new native.IdentityTransformStream() : new TransformStream<Uint8Array, Uint8Array>());
const fixedLength = (length: number): Pair => (native.FixedLengthStream ? new native.FixedLengthStream(length) : new TransformStream<Uint8Array, Uint8Array>());

/**
 * Holds `body` until it ends, the next chunk wouldn't fit under `maxBytes`, or `wait` settles, whichever is first.
 * `lateFailure` is called once if the app's body fails after the headers were sent, so the Worker can log it.
 */
export async function holdBody(body: ReadableStream<Uint8Array>, wait: Promise<void>, lateFailure: () => void, maxBytes = HOLD_BYTES): Promise<Held> {
  const reader = body.getReader();
  const held: Uint8Array[] = [];
  let length = 0;
  const timeUp = wait.then(() => "time" as const);
  // The read already asked for when the hold stopped, if any, or a chunk read that didn't fit.
  let pending: Promise<ReadableStreamReadResult<Uint8Array>> | null = null;
  let carry: Uint8Array | null = null;
  for (;;) {
    const next = reader.read();
    ignore(next);
    let step: ReadableStreamReadResult<Uint8Array> | "time";
    try {
      step = await Promise.race([next, timeUp]);
    } catch {
      ignore(reader.cancel());
      return { kind: "failed" };
    }
    if (step === "time") {
      pending = next;
      break;
    }
    if (step.done) {
      const whole = fixedLength(length);
      const writer = whole.writable.getWriter();
      // Written as the visitor reads, so nothing waits on it here.
      ignore((async () => {
        for (const chunk of held) await writer.write(chunk);
        await writer.close();
      })());
      return { kind: "whole", body: whole.readable, length };
    }
    if (length + step.value.byteLength > maxBytes) {
      carry = step.value;
      break;
    }
    held.push(step.value);
    length += step.value.byteLength;
  }
  // Outgrown: what was held, then the rest. Written with backpressure, then piped.
  const out = identity();
  const writer = out.writable.getWriter();
  ignore((async () => {
    let fromApp = false;
    try {
      for (const chunk of held.splice(0)) await writer.write(chunk);
      if (carry !== null) await writer.write(carry);
      carry = null;
      if (pending !== null) {
        fromApp = true;
        const step = await pending;
        fromApp = false;
        if (step.done) {
          await writer.close();
          return;
        }
        await writer.write(step.value);
      }
      writer.releaseLock();
      reader.releaseLock();
      // The app's error is never passed on (`preventAbort`); this Worker's fixed one is, below. A pipe that fails because
      // the visitor went away cancels the app's body and leaves it closed; one whose app body failed leaves it errored.
      try {
        await body.pipeTo(out.writable, { preventAbort: true });
      } catch {
        fromApp = await body
          .getReader()
          .closed.then(() => false)
          .catch(() => true);
        throw new Error(STREAM_FAILED);
      }
    } catch {
      if (fromApp) {
        try {
          lateFailure();
        } catch {
          // Nothing: the body is errored with or without the line.
        }
        ignore(out.writable.abort(new Error(STREAM_FAILED)));
        // A writer still holding the lock aborts through it.
        ignore(writer.abort(new Error(STREAM_FAILED)));
      } else {
        // The visitor went away while what was held was being sent: the app's body is cancelled.
        ignore(reader.cancel());
      }
    }
  })());
  return { kind: "streamed", body: out.readable };
}
