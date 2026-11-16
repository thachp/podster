import { runInDurableObject } from "cloudflare:test";

/**
 * The room's test-only route for the test's own pass (`src/workspace/test_alarms.rs`). In a room whose alarms the test
 * runs (`manualAlarms`), this is the only way the job runs: the runtime's firing, and a direct `instance.alarm()` call,
 * do nothing there.
 */
const PASS = "https://workspace.internal/internal/test-alarm-pass";

/** Whether an object's alarms are the test's: a room given `test_alarms_manual`. Other objects never are. */
function manual(state: any): boolean {
  try {
    return state.storage.sql.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'test_alarms_manual'").toArray().length > 0;
  } catch {
    return false;
  }
}

/**
 * Runs the object's alarm job once, in its turn, from inside `runInDurableObject`. A room whose alarms are the test's
 * runs it through the test's route; any other object through its handler, as the runtime would. Use this, never a
 * bare `instance.alarm()`, which does nothing in a room whose alarms are the test's.
 */
export async function runAlarm(instance: any, state: any) {
  if (!manual(state)) return instance.alarm();
  const response: Response = await instance.fetch(new Request(PASS));
  if (!response.ok) throw new Error(`the test's pass failed: ${response.status}`);
  return response;
}

/**
 * One whole run of a room's alarm, or of a person's or an agent's own object's, which has ended when this returns, and which no other run of it overlapped.
 *
 * The test runtime runs alarms on its own as they come due, beside whatever a test does. The pool's
 * `runDurableObjectAlarm` doesn't fit with that in two ways. It calls the handler directly, so its run can overlap one
 * the runtime started, which the platform never allows: two provisioning jobs then work on one request, and the second
 * reads the first's attempt as a run that died. And it returns at once, having run nothing, when no alarm is set, which
 * is also what it sees while the runtime's own run is under way, so a check straight after it races that run.
 *
 * This always runs the job. In test builds the object gives a direct call its turn (see `alarm` in
 * `src/workspace.rs` and `src/principal.rs`), so it waits out a run under way and then runs alone. The alarm that was set is cleared first, as
 * `runDurableObjectAlarm` clears it, and the run sets the next one.
 */
export const alarmPass = (room: DurableObjectStub) =>
  runInDurableObject(room, async (instance: any, state: any) => {
    await state.storage.deleteAlarm();
    await runAlarm(instance, state);
  });

/**
 * Leaves a room with no alarm run under way and none to come, so nothing of it reaches a later test: a run under way is
 * waited out, one pass is run, and the alarm that pass set is cleared. A room nobody calls again sets no other.
 */
export const alarmQuiet = (room: DurableObjectStub) =>
  runInDurableObject(room, async (instance: any, state: any) => {
    await runAlarm(instance, state);
    await state.storage.deleteAlarm();
  });

/**
 * Puts a room's alarms under the test's control from now on, and hands it back quiet (review standard 1). The
 * runtime's own firing of the room's alarm does nothing from here, so only a pass the test runs (`alarmPass`,
 * `alarmQuiet`, `runAlarm`) runs the job, and a row the test writes after a command is never met by a run it didn't
 * start. Alarms are still set as before, but one due at once is taken by the runtime's firing, which runs nothing and
 * leaves none: read `nextAlarm` only for a due time ahead, as a pass's wait sets.
 *
 * The shared room helpers call this. A run the runtime started before the switch is waited out, and the alarm left is
 * cleared, as `alarmQuiet` does. A test that needs the runtime's own firing, delivery that nobody passes for, gives
 * its room back with `runtimeAlarms`.
 */
export const manualAlarms = (room: DurableObjectStub) =>
  runInDurableObject(room, async (instance: any, state: any) => {
    state.storage.sql.exec("CREATE TABLE IF NOT EXISTS test_alarms_manual (x INTEGER)");
    await runAlarm(instance, state);
    await state.storage.deleteAlarm();
  });

/** Gives a room's alarms back to the runtime, for a test that shows what the runtime's own firing does. */
export const runtimeAlarms = (room: DurableObjectStub) =>
  runInDurableObject(room, (_: any, state: any) => {
    state.storage.sql.exec("DROP TABLE IF EXISTS test_alarms_manual");
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
