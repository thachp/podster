// Shows a stop at any point of a publish leaves no room public: during its read, during its PUT, after a PUT that threw but
// landed, and with a PUT landing during clean-up's first sweep. A fake server applies each request when its delay ends.
import { RoomPublisher } from "./room-publisher.mjs";

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/** A fake server, and an owner whose requests take the delays given per kind. `public` is what the server holds. */
function world({ get = 10, publicPut = 10, privatePut = 5, publicPutThrows = false } = {}) {
  const server = { public: new Set(), puts: 0 };
  const owner = {
    async dash(method, path, body) {
      const id = path.split("/")[3];
      if (method === "GET") {
        await sleep(get);
        return { ok: true, status: 200, body: { view_hash: "h" } };
      }
      if (body.visibility === "public") {
        server.puts += 1;
        // The server applies it when it lands; the client may already have given up.
        const landing = sleep(publicPut).then(() => server.public.add(id));
        if (publicPutThrows) {
          await sleep(1);
          throw new Error("timed out");
        }
        await landing;
        return { ok: true, status: 200, body: { public_handle: `pub_${id}` } };
      }
      await sleep(privatePut);
      server.public.delete(id);
      return { ok: true, status: 200, body: {} };
    },
  };
  return { server, owner };
}

let failed = 0;
const check = (passed, title, detail = "") => {
  if (!passed) failed += 1;
  console.log(`${passed ? "ok  " : "FAIL"} ${title}${detail ? `: ${detail}` : ""}`);
};
const settle = (promise) => promise.then(() => "done", (error) => `refused: ${error.message}`);

{
  // A stop during the read: no PUT is sent at all.
  const { server, owner } = world({ get: 30 });
  const publisher = new RoomPublisher({ putTimeoutMs: 20, stopWaitMs: 100 });
  const publishing = settle(publisher.publish(owner, "ws_a"));
  await sleep(5);
  await publisher.stop();
  check(server.puts === 0 && server.public.size === 0, "a stop during the read sends no PUT", await publishing);
}
{
  // A stop during the PUT: clean-up waits for it, then makes the room private.
  const { server, owner } = world({ publicPut: 40 });
  const publisher = new RoomPublisher({ putTimeoutMs: 60, stopWaitMs: 100 });
  const publishing = settle(publisher.publish(owner, "ws_b"));
  await sleep(20);
  const result = await publisher.stop();
  check(server.public.size === 0 && result.madePrivate === 1 && result.left === 0, "a stop during the PUT waits for it, then makes the room private", await publishing);
}
{
  // A PUT that throws but lands on the server: the room was listed before it was sent, so it's swept.
  const { server, owner } = world({ publicPut: 15, publicPutThrows: true });
  const publisher = new RoomPublisher({ putTimeoutMs: 20, stopWaitMs: 100 });
  check((await settle(publisher.publish(owner, "ws_c"))).startsWith("refused"), "the PUT threw");
  await sleep(30);
  check(server.public.has("ws_c"), "and landed anyway");
  await publisher.stop();
  check(server.public.size === 0, "clean-up makes it private");
}
{
  // A PUT landing during the first sweep, after the wait gave up on it: the second sweep makes it private.
  const { server, owner } = world({ publicPut: 130, privatePut: 30, publicPutThrows: false });
  const publisher = new RoomPublisher({ putTimeoutMs: 40, stopWaitMs: 50 });
  // Another room already public, whose first sweep takes 30 ms, and a slow publish in flight.
  await publisher.publish(world({ publicPut: 1 }).owner, "ws_other").catch(() => null);
  publisher.published.set("ws_other", owner);
  server.public.add("ws_other");
  const slow = settle(publisher.publish(owner, "ws_d"));
  await sleep(20);
  await publisher.stop();
  await slow;
  await sleep(150);
  check(!server.public.has("ws_d") && server.public.size === 0, "a PUT landing during the first sweep is undone by the second", `public: ${[...server.public].join(", ") || "none"}`);
}
{
  // Once stopping, a new publish is refused before any request.
  const { server, owner } = world();
  const publisher = new RoomPublisher({ putTimeoutMs: 20, stopWaitMs: 100 });
  await publisher.stop();
  check((await settle(publisher.publish(owner, "ws_e"))).startsWith("refused") && server.puts === 0, "a publish after the stop is refused before any request");
}
{
  let threw = false;
  try {
    new RoomPublisher({ putTimeoutMs: 60_000, stopWaitMs: 60_000 });
  } catch {
    threw = true;
  }
  check(threw, "the PUT's timeout must be shorter than clean-up's wait");
}
process.exit(failed ? 1 : 0);
