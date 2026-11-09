import { describe, expect, it } from "vitest";
import { roomPage } from "./render";
import { visibleName, visibleText } from "./visible-text";

describe("visible text", () => {
  it("removes default-ignorable code points and the blank Braille pattern, as well as controls and formats", () => {
    for (const hidden of ["ㅤ", "⠀", "️", "︀", "͏", "ᅟ", "᠎", "‮", "​", "\u{E0041}", "\u{E0001}", "\u{E0100}"]) {
      expect(visibleText(`a${hidden}b`), hidden.codePointAt(0)!.toString(16)).toBe("ab");
    }
  });

  it("keeps line breaks, tabs and the joiners scripts need", () => {
    expect(visibleText("a\nb\tc‌d‍e")).toBe("a\nb\tc‌d‍e");
  });

  it("names an empty or all-invisible room Unnamed", () => {
    expect(visibleName("ㅤ⠀ ​")).toBe("Unnamed");
    expect(visibleName("")).toBe("Unnamed");
    expect(visibleName("Reefㅤ")).toBe("Reef");
  });
});

describe("the public page with hidden characters", () => {
  const view = (content: Record<string, unknown>) => ({ handle: `pub_${"1".repeat(32)}`, published_on: "2026-11-09", content: { name: "Reef", goal: null, context: null, topic: null, workflow: "general", openings: [], outputs: [], participant_count: 1, person_review: true, archived: false, ...content } }) as Parameters<typeof roomPage>[0];

  it("gives a link whose scheme hides a zero-width space no address", () => {
    const html = roomPage(view({ goal: "[x](java​script:alert(1))" }));
    const goal = html.slice(html.indexOf("<h2>Goal</h2>"), html.indexOf("</section>"));
    expect(html).not.toMatch(/href="[^"]*script/i);
    expect(goal).not.toMatch(/<a\s/);
    expect(goal).toContain("<p>x</p>");
  });

  it("titles an all-invisible name Unnamed", () => {
    const html = roomPage(view({ name: "ㅤ⠀" }));
    expect(html).toContain("<h1>Unnamed</h1>");
    expect(html).toContain("<title>Unnamed · Podster</title>");
  });
});
