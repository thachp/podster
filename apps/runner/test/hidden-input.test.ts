// The pairing code is typed without being shown (L5 on #454).
import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { keystrokes, readHidden } from "../src/node/hidden-input.js";

/** A terminal stand-in: records raw mode and what was written. */
function terminal() {
  const input = Object.assign(new EventEmitter(), {
    isTTY: true,
    raw: [] as boolean[],
    setRawMode(on: boolean) {
      this.raw.push(on);
      return this;
    },
    resume() {},
    pause() {},
    setEncoding() {},
  });
  const written: string[] = [];
  return { input, output: { write: (text: string) => void written.push(text) }, written };
}

describe("reading the code without echo", () => {
  it("collects keys to Enter, with backspace, and stops on Ctrl-C or Ctrl-D", () => {
    expect(keystrokes("", "abc\r")).toEqual({ text: "abc", done: "enter" });
    expect(keystrokes("ab", "c\x7fd\n")).toEqual({ text: "abd", done: "enter" });
    expect(keystrokes("", "\x7f\x7fx")).toEqual({ text: "x", done: null });
    expect(keystrokes("abc", "\x03")).toEqual({ text: "", done: "cancel" });
    expect(keystrokes("abc", "\x04")).toEqual({ text: "", done: "cancel" });
    // A pasted code with a trailing newline in one chunk.
    expect(keystrokes("", `${"k".repeat(43)}\n`)).toEqual({ text: "k".repeat(43), done: "enter" });
  });

  it("puts the terminal in raw mode, writes only the prompt and a newline, never what was typed, and restores it", async () => {
    const { input, output, written } = terminal();
    const answer = readHidden("Code: ", input as never, output);
    input.emit("data", "secret-");
    input.emit("data", "code\r");
    expect(await answer).toBe("secret-code");
    expect(written.join("")).toBe("Code: \n");
    expect(input.raw).toEqual([true, false]);
    expect(input.listenerCount("data")).toBe(0);
  });

  it("rejects on Ctrl-C, with the terminal restored", async () => {
    const { input, output } = terminal();
    const answer = readHidden("Code: ", input as never, output);
    input.emit("data", "abc\x03");
    await expect(answer).rejects.toThrow(/canceled/);
    expect(input.raw).toEqual([true, false]);
  });
});
