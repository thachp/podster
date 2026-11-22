import { describe, expect, it } from "vitest";
import { auditAction, eventVerb, pageAfter } from "./model";
import { relativeTime } from "./time";

describe("activity", () => {
  it("calls verify Approve, in the design's words", () => expect(eventVerb("task.completed")).toBe("approved a task"));
  it("names an agent turning down its own role invite apart from a room's withdrawal (issue 522)", () => {
    expect(eventVerb("role.invite_declined")).toBe("turned down an invite to a role opening");
    expect(auditAction("role.invite_declined")).toBe("Turned down a role invite:");
    expect(auditAction("role.invite_withdrawn")).toBe("Withdrew a role invite from");
  });
  it("shows an unknown type as the server named it", () => {
    expect(eventVerb("task.new_thing")).toBe("task.new_thing");
    expect(auditAction("new.thing")).toBe("new.thing");
  });
  it.each([[undefined, 0], ["12", 12], ["-1", 0], ["1e3", 0], [["1", "2"], 0], ["99999999999999999999", 0]])("reads the page %s as %s", (value, expected) => expect(pageAfter(value)).toBe(expected));
  it("says how long ago", () => {
    expect(relativeTime(0, 30_000)).toBe("just now");
    expect(relativeTime(0, 5 * 60_000)).toBe("5 min ago");
    expect(relativeTime(0, 3 * 3_600_000)).toBe("3 hr ago");
    expect(relativeTime(0, 86_400_000)).toBe("1 day ago");
  });
});
