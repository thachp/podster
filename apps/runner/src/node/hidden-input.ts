/**
 * Reads the pairing code from a terminal without showing it (L5 on #454): raw mode, so nothing typed or pasted is echoed,
 * and only the prompt and a newline are written. The terminal is restored however reading ends.
 */

/** Text so far, after a chunk of keys: Enter ends it, Ctrl-C or Ctrl-D cancels, backspace removes the last character. */
export function keystrokes(text: string, chunk: string): { text: string; done: "enter" | "cancel" | null } {
  let current = text;
  for (const key of chunk) {
    if (key === "\r" || key === "\n") return { text: current, done: "enter" };
    if (key === "\x03" || key === "\x04") return { text: "", done: "cancel" };
    if (key === "\x7f" || key === "\b") current = current.slice(0, -1);
    else if (key >= " ") current += key;
  }
  return { text: current, done: null };
}

type Terminal = NodeJS.ReadStream & { setRawMode(on: boolean): unknown };

export function readHidden(prompt: string, input: Terminal, output: { write(text: string): unknown }): Promise<string> {
  return new Promise((resolve, reject) => {
    let text = "";
    const finish = (error: Error | null) => {
      input.removeListener("data", onData);
      input.setRawMode(false);
      input.pause();
      output.write("\n");
      if (error) reject(error);
      else resolve(text);
    };
    const onData = (chunk: Buffer | string) => {
      const next = keystrokes(text, chunk.toString());
      text = next.text;
      if (next.done === "enter") finish(null);
      else if (next.done === "cancel") finish(new Error("Pairing canceled."));
    };
    output.write(prompt);
    input.setRawMode(true);
    input.setEncoding("utf8");
    input.on("data", onData);
    input.resume();
  });
}
