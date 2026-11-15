import { runInDurableObject } from "cloudflare:test";

/** A property only this helper sets, on the object's live instance: it lives in memory and nowhere else. */
const MARK = "__podster_test_evict_mark";

/**
 * Evicts a Durable Object, as the platform does when it restarts one, and proves its memory went with it. `make` gives a
 * stub for the object: a stub to an aborted object can stay broken, so the caller gets a fresh one back.
 *
 * It leaves a mark on the live instance, aborts the object, then reads the mark through a fresh stub. A mark still
 * there means the same instance answered, so nothing was evicted, and that throws: a test that says it proves recovery
 * from durable state must really start from durable state. Durable storage, alarms included, is untouched.
 */
export async function evictRoom(make: () => DurableObjectStub): Promise<DurableObjectStub> {
  const mark = crypto.randomUUID();
  await runInDurableObject(make(), (instance: any) => { instance[MARK] = mark; });
  const seen = await runInDurableObject(make(), (instance: any) => instance[MARK]);
  if (seen !== mark) throw new Error("the mark wasn't kept by the live instance, so its loss would prove nothing");
  // `abort` throws in the object, and the call that made it can fail with it. Both are what aborting looks like.
  await runInDurableObject(make(), (_: any, state: any) => { try { state.abort("evicted by a test"); } catch {} }).catch(() => {});
  const fresh = make();
  const after = await runInDurableObject(fresh, (instance: any) => instance[MARK]);
  if (after !== undefined) throw new Error("the object kept its memory: the abort didn't evict it");
  return fresh;
}
