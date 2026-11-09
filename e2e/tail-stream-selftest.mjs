// Shows the tail reader handles wrangler's real `--format json` shape: each event a multi-line, 4-space-indented JSON value,
// back to back, arriving in chunks that split anywhere, with braces and quotes inside logged strings.
import { JsonStream } from "./tail-stream.mjs";

const event = (n, message) => ({
  outcome: "ok",
  scriptName: "podster-api-staging",
  exceptions: [],
  logs: [{ message: [message], level: "log", timestamp: 1794266716899 + n }],
  eventTimestamp: 1794266716899 + n,
  event: { request: { url: `https://api.internal/v1/workspaces/ws_${n}`, method: "GET", headers: {}, cf: {} }, response: { status: 200 } },
  id: n,
});
const messages = ['plain', 'a } brace and a { brace in a string', 'quote \\" and backslash \\\\ and ] bracket', '{"json":"inside","n":[1,2]}'];
const expected = messages.map((message, n) => event(n, message));
const output = `Successfully created tail, expires at 2026-11-10T00:00:00Z\n${expected.map((value) => JSON.stringify(value, null, 4)).join("\n")}\n`;

let failed = 0;
const check = (passed, title) => {
  if (!passed) failed += 1;
  console.log(`${passed ? "ok  " : "FAIL"} ${title}`);
};

for (const size of [1, 2, 7, 64, 4096, output.length]) {
  const stream = new JsonStream();
  for (let at = 0; at < output.length; at += size) stream.push(output.slice(at, at + size));
  check(JSON.stringify(stream.values) === JSON.stringify(expected), `every event parses, in chunks of ${size}`);
}
// The old way, one line at a time, parses none of them, which is why the stream is read whole.
const byLine = output.split("\n").flatMap((line) => {
  try {
    return [JSON.parse(line)];
  } catch {
    return [];
  }
});
check(!byLine.some((value) => value && typeof value === "object" && "event" in value), "reading line by line would have found no event");
// A noise line with an unbalanced brace before the events: they still all parse, from the next line that starts one.
{
  const stream = new JsonStream().push(`a { stray brace and [ bracket\n${output}`);
  check(JSON.stringify(stream.values) === JSON.stringify(expected) && stream.error === null, "events after a noise line with an unbalanced brace still parse");
}
// Text that never forms a value, past the cap, is dropped and reported, and the buffer doesn't grow without bound.
{
  const stream = new JsonStream();
  const noise = `[${" x".repeat(1024)}`;
  for (let n = 0; n < 700; n++) stream.push(noise);
  check(stream.error !== null, "over 1 MB that never forms a value is reported");
  stream.push(`\n${JSON.stringify(expected[0], null, 4)}\n`);
  check(stream.values.length === 1 && stream.values[0].id === 0, "and events after it still parse");
}
process.exit(failed ? 1 : 0);
