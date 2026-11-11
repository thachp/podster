// The test suite's fake GitHub (apps/api/test/fake-github.ts), served over HTTP on this machine, for the local
// rehearsal's stack with managed repositories on (run-local.mjs). The API there is built with its `rehearsal` feature,
// which sends GitHub's calls to this address and nowhere else. Nothing here is GitHub, and no real key is involved:
// the fake makes its own key pairs when it starts, and writes them to the file named, for that one stack's configuration.
//
//   node --experimental-strip-types fake-github-server.mjs <port> <file for its keys and IDs>
//
// A path under /__fake/ is the fake's control surface, which the check script uses to script a pull request and to read
// back what the Apps did. Every other path is answered as api.github.com would be.
import { writeFileSync } from "node:fs";
import { createServer } from "node:http";

const [port, out] = process.argv.slice(2);
if (!/^\d+$/.test(port ?? "") || !out) {
  console.error("Give a port and a file to write the fake's keys to.");
  process.exit(2);
}
const fake = await import("../apps/api/test/fake-github.ts");

const server = createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const control = req.url.startsWith("/__fake/");
  const url = control ? `https://github-fake.example.com/${req.url.slice("/__fake/".length)}` : `https://api.github.com${req.url}`;
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) if (typeof value === "string" && name !== "host" && name !== "content-length") headers.set(name, value);
  const body = ["GET", "HEAD"].includes(req.method) || chunks.length === 0 ? undefined : Buffer.concat(chunks);
  try {
    const answer = (await fake.fakeGithub(new Request(url, { method: req.method, headers, body }))) ?? new Response(null, { status: 404 });
    res.writeHead(answer.status, { "content-type": answer.headers.get("content-type") ?? "application/json" });
    res.end(Buffer.from(await answer.arrayBuffer()));
  } catch (error) {
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ message: String(error) }));
  }
});
server.listen(Number(port), "127.0.0.1", () => {
  writeFileSync(out, JSON.stringify({ ids: fake.FAKE_GITHUB, provisionKey: fake.FAKE_APP_KEY_PEM, agentKey: fake.FAKE_AGENT_KEY_PEM, mergeKey: fake.FAKE_MERGE_KEY_PEM }), { mode: 0o600 });
});
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => process.exit(0));
