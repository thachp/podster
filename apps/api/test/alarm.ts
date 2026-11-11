import { runInDurableObject } from "cloudflare:test";

/**
 * One whole run of a room's alarm, or of a person's or an agent's own object's, which has ended when this returns, and which no other run of it overlapped.
 *
 * The test runtime runs alarms on its own as they come due, beside whatever a test does. The pool's
 * `runDurableObjectAlarm` doesn't fit with that in two ways. It calls the handler directly, so its run can overlap one
 * the runtime started, which the platform never allows: two provisioning jobs then work on one request, and the second
 * reads the first's attempt as a run that died. And it returns at once, having run nothing, when no alarm is set, which
 * is also what it sees while the runtime's own run is under way, so a check straight after it races that run.
 *
 * This always runs the handler. In test builds the object gives a direct call its turn (see `alarm` in
 * `src/workspace.rs` and `src/principal.rs`), so it waits out a run under way and then runs alone. The alarm that was set is cleared first, as
 * `runDurableObjectAlarm` clears it, and the run sets the next one.
 */
export const alarmPass = (room: DurableObjectStub) =>
  runInDurableObject(room, async (instance: any, state: any) => {
    await state.storage.deleteAlarm();
    await instance.alarm();
  });

/**
 * Leaves a room with no alarm run under way and none to come, so nothing of it reaches a later test: a run under way is
 * waited out, and the alarm that run set is cleared. A room nobody calls again sets no other.
 */
export const alarmQuiet = (room: DurableObjectStub) =>
  runInDurableObject(room, async (instance: any, state: any) => {
    await instance.alarm();
    await state.storage.deleteAlarm();
  });

/** When the room's next alarm is set for, or null if none is. */
export const nextAlarm = (room: DurableObjectStub) =>
  runInDurableObject(room, (_: any, state: any) => state.storage.getAlarm()) as Promise<number | null>;

/**
 * Checks that a pass left no alarm sooner than `minMs` from now: either none, or one at least that far off. A pass that
 * did nothing must never leave its own due time in the past, which would bring the alarm straight back in a loop.
 */
export async function expectNoAlarmSooner(room: DurableObjectStub, minMs: number) {
  const at = await nextAlarm(room);
  if (at !== null && at < Date.now() + minMs) throw new Error(`the next alarm is due in ${at - Date.now()} ms, sooner than ${minMs} ms`);
}
