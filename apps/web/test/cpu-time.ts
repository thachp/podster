/**
 * Runs `run`, which must be synchronous, and says how many milliseconds of CPU it took, with what it returned.
 *
 * For a test that shows some work can't freeze the page. A bound on the wall clock is a margin a loaded machine uses up: with
 * other processes taking the CPU, the same work takes many times longer by the clock, and the test fails though nothing
 * changed. CPU time counts only the time this code ran, so the bound holds whatever else the machine is doing. Vitest runs
 * each test file in a process of its own (the `forks` pool), so the process's CPU time is this test's; where Node can say
 * how much CPU this thread alone took, that is used.
 */
export function cpuTime<T>(run: () => T): { value: T; ms: number } {
  const usage = (previous?: NodeJS.CpuUsage) => (typeof process.threadCpuUsage === "function" ? process.threadCpuUsage(previous) : process.cpuUsage(previous));
  const started = usage();
  const value = run();
  const used = usage(started);
  return { value, ms: (used.user + used.system) / 1000 };
}
