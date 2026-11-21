// The socket recorder (S-53) sees net, tls and fetch connections through Node's diagnostics channels, by host and
// port, and the check flags anything outside the allowed endpoints. Loopback only.
import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import tls from "node:tls";
import http from "node:http";
import { startSocketRecorder, unexplained } from "../lib/sockets.mjs";

async function server(t) {
  const srv = http.createServer((_q, r) => r.end("ok"));
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  t.after(() => {
    srv.closeAllConnections();
    srv.close();
  });
  return srv.address().port;
}
const settle = () => new Promise((r) => setTimeout(r, 20));

test("a raw net connection is recorded with its port", async (t) => {
  const port = await server(t);
  const rec = startSocketRecorder();
  await new Promise((r) => {
    const s = net.connect(port, "127.0.0.1", () => s.end());
    s.on("close", r);
  });
  rec.stop();
  await settle();
  assert.equal(rec.sockets.length, 1);
  assert.equal(rec.sockets[0].port, port);
  assert.equal(rec.sockets[0].tls, false);
  assert.deepEqual(unexplained(rec, [{ host: "api.openai.com", port: 443 }]), [`socket 127.0.0.1:${port}`]);
});

test("a tls connection attempt is recorded as tls, even when its handshake fails", async (t) => {
  const port = await server(t);
  const rec = startSocketRecorder();
  await new Promise((r) => {
    const s = tls.connect({ port, host: "127.0.0.1", servername: "x.test" });
    s.on("error", () => {});
    s.on("close", r);
  });
  rec.stop();
  await settle();
  assert.equal(rec.sockets.length, 1);
  assert.equal(rec.sockets[0].tls, true);
  assert.equal(rec.sockets[0].port, port);
  assert.equal(unexplained(rec, []).length, 1);
});

test("fetch is recorded by the host it asked for, and passes only when that host and port are allowed", async (t) => {
  const port = await server(t);
  const rec = startSocketRecorder();
  await (await fetch(`http://127.0.0.1:${port}/`)).text();
  rec.stop();
  await settle();
  assert.deepEqual(rec.fetchConnects.map((c) => `${c.host}:${c.port}`), [`127.0.0.1:${port}`]);
  assert.equal(rec.sockets.length, 1);
  assert.deepEqual(unexplained(rec, [{ host: "127.0.0.1", port }]), []);
  assert.deepEqual(unexplained(rec, [{ host: "api.openai.com", port: 443 }]), [`fetch 127.0.0.1:${port}`]);
});

test("nothing is recorded after stop, and an empty recording explains itself", async (t) => {
  const port = await server(t);
  const rec = startSocketRecorder();
  rec.stop();
  await (await fetch(`http://127.0.0.1:${port}/`)).text();
  assert.equal(rec.sockets.length + rec.fetchConnects.length, 0);
  assert.deepEqual(unexplained(rec, []), []);
});
