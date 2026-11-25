import { describe, expect, it } from "vitest";
import { limitsFromSettings, MAX_CPU_MS } from "../src/limits";

// The dispatch's limits for a host with code, from their two settings. No figure is the code's: anything but two
// decimal strings, the CPU time at least one, is no limits, and every request that would run an app's code is refused.
describe("the dispatch's limits", () => {
  it("are read from two decimal strings, the CPU time at least one millisecond and the subrequests none or more", () => {
    expect(limitsFromSettings("50", "5")).toEqual({ cpuMs: 50, subRequests: 5 });
    expect(limitsFromSettings("1", "0")).toEqual({ cpuMs: 1, subRequests: 0 });
    // The CPU time up to the platform's maximum, five minutes, and no further.
    expect(MAX_CPU_MS).toBe(300_000);
    expect(limitsFromSettings("300000", "999999999")).toEqual({ cpuMs: 300_000, subRequests: 999_999_999 });
    expect(limitsFromSettings("300001", "5")).toBeNull();
    expect(limitsFromSettings("999999999", "5")).toBeNull();
  });

  it("are none when either setting is missing, isn't a string, or isn't written exactly so", () => {
    for (const [cpu, sub] of [
      [undefined, "5"],
      ["50", undefined],
      [50, "5"],
      ["50", 5],
      [null, null],
      ["0", "5"],
      ["", "5"],
      ["50", ""],
      ["050", "5"],
      ["50", "05"],
      ["-1", "5"],
      ["+50", "5"],
      [" 50", "5"],
      ["50 ", "5"],
      ["5e1", "5"],
      ["50.0", "5"],
      ["0x32", "5"],
      ["1000000000", "5"],
      ["50", "1000000000"],
    ] as [unknown, unknown][]) {
      expect(limitsFromSettings(cpu, sub), `${JSON.stringify(cpu)} ${JSON.stringify(sub)}`).toBeNull();
    }
  });
});
