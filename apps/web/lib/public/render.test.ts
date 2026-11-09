import { describe, expect, it } from "vitest";
import { FIELD_DELIMITERS, FIELD_FORMAT_BYTES, inertMarkdown, notFoundPage, PAGE_FORMAT_BYTES, pageBudget, roomPage, type PublicView } from "./render";

const view = (content: Partial<PublicView["content"]> = {}): PublicView => ({
  handle: `pub_${"1".repeat(32)}`,
  published_on: "2026-11-09",
  content: { name: "Reef survey", goal: "Count the fish", context: null, topic: "research", workflow: "general", openings: [], outputs: [], participant_count: 3, person_review: true, archived: false, ...content },
});

describe("the public room page", () => {
  it("has no script, inline style, event handler or frame, whatever the owner wrote (M4-12)", () => {
    const hostile = [
      "<script>alert(1)</script>",
      '<img src=x onerror="alert(1)">',
      "[x](javascript:alert(1))",
      "[d](data:text/html,<script>alert(1)</script>)",
      "![remote](https://tracker.example/pixel.png)",
      "<iframe src='https://evil.example'></iframe>",
      '<a href="https://evil.example" onclick="x()">hi</a>',
      '<div style="position:fixed">x</div>',
    ].join("\n\n");
    const html = roomPage(view({ name: '<b onmouseover="x()">Name</b>', goal: hostile, context: hostile, openings: [{ id: "role_1", title: "<script>t</script>", responsibilities: hostile, capacity: 2, filled: 0, preset: "public_participant", lead: false, publicly_claimable: true }], outputs: [{ title: "<i>o</i>", description: hostile, ready: false }] }));
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/<iframe/i);
    expect(html).not.toMatch(/<img/i);
    // Escaped text may say anything: what matters is that no real tag carries a handler or a style.
    expect(html).not.toMatch(/<[^>]*\son\w+\s*=/i);
    expect(html).not.toMatch(/<[^>]*\sstyle\s*=/i);
    expect(html).not.toMatch(/href="(javascript|data):/i);
    expect(html).toContain("&lt;b onmouseover=&quot;x()&quot;&gt;Name&lt;/b&gt;");
    expect(html).toContain("[Image not loaded: remote from tracker.example]");
  });

  it("shows a link's host beside it, and only for http and https", () => {
    expect(inertMarkdown("[docs](https://xn--pple-43d.com/a)")).toContain('<a href="https://xn--pple-43d.com/a" rel="noopener noreferrer nofollow ugc">docs</a> <span class="host">(xn--pple-43d.com)</span>');
    expect(inertMarkdown("[no](ftp://example.com)")).toBe("<p>no</p>");
  });

  it("shows the room's public facts, openings an agent can claim, and expected outputs", () => {
    const html = roomPage(view({
      openings: [
        { id: "role_open", title: "Surveyor", responsibilities: "Count", capacity: 2, filled: 1, preset: "public_participant", lead: false, publicly_claimable: true },
        { id: null, title: "Lead", responsibilities: "Plan", capacity: 1, filled: 1, preset: "coordinator", lead: true, publicly_claimable: false },
      ],
      outputs: [{ title: "Fish counts", description: null, ready: true }],
    }));
    expect(html).toContain("<h1>Reef survey</h1>");
    expect(html).toContain("Topic: research · 3 participants · A person reviews submitted work · Public since 2026-11-09");
    expect(html).toContain(`href="/workrooms/explore?claim=pub_${"1".repeat(32)}&amp;opening=role_open">Claim with an agent</a>`);
    expect(html.match(/Claim with an agent/g)).toHaveLength(1);
    expect(html).toContain("Fish counts <span class=\"tag\">Ready</span>");
    expect(html).toContain('<meta name="robots" content="noindex, nofollow">');
  });

  it("says when a room is archived, and offers no claim", () => {
    const html = roomPage(view({ archived: true, openings: [{ id: null, title: "S", responsibilities: "", capacity: 1, filled: 0, preset: "guest", lead: false, publicly_claimable: false }] }));
    expect(html).toContain("This workroom is archived.");
    expect(html).not.toContain("Claim with an agent");
  });

  it("shows very deep nesting as plain text", () => {
    expect(inertMarkdown(`${"> ".repeat(500)}deep`)).toMatch(/^<p class="plain">&gt; &gt;/);
  });

  it("formats a field only within its 2 KB, and shows one past it as escaped plain text with its lines kept", () => {
    const fits = `**b**\n${"b\n".repeat((FIELD_FORMAT_BYTES - 6) / 2)}`;
    expect(new TextEncoder().encode(fits).length).toBe(FIELD_FORMAT_BYTES);
    expect(inertMarkdown(fits)).toContain("<strong>b</strong>");
    const over = `${"b\n".repeat(FIELD_FORMAT_BYTES / 2)}<i>x</i>\n**c**`;
    const html = inertMarkdown(over);
    expect(html).toMatch(/^<p class="plain">b\nb\n/);
    expect(html).toContain("&lt;i&gt;x&lt;/i&gt;\n**c**</p>");
    expect(html).not.toContain("<strong>");
    // Bytes, not characters: 683 three-byte characters are past 2 KB.
    expect(inertMarkdown(`**${"界".repeat(683)}**`)).toMatch(/^<p class="plain">/);
  });

  it("formats a field only with at most 256 emphasis delimiters", () => {
    const at = `${"*a* ".repeat(FIELD_DELIMITERS / 2)}`;
    expect(inertMarkdown(at)).toContain("<em>a</em>");
    expect(inertMarkdown(`${at}_`)).toMatch(/^<p class="plain">\*a\* /);
  });

  it("stops formatting once the page has formatted 8 KB, in page order, whatever the field", () => {
    const field = "word ".repeat(400); // 2,000 bytes, no delimiters
    const budget = pageBudget();
    const out = [1, 2, 3, 4, 5].map(() => inertMarkdown(`*a* ${field}`, budget));
    expect(out.slice(0, 4).every((html) => html.includes("<em>a</em>"))).toBe(true);
    expect(out[4]).toMatch(/^<p class="plain">/);
    expect(budget.left).toBe(PAGE_FORMAT_BYTES - 4 * 2_004);
    // A field small enough for what's left still fits.
    expect(inertMarkdown("*z*", budget)).toContain("<em>z</em>");
  });

  // The worst rooms the limits allow, for each delimiter pattern the review found costly. The counts are the guard; the
  // time is only a loose bound, so a slow CI runner can't make it flake.
  describe.each(["*a", "*a_", "a*_", "*_ "])("the worst room made of %j", (unit) => {
    const fill = (bytes: number) => unit.repeat(Math.ceil(bytes / unit.length)).slice(0, bytes);
    /** As costly as a field can be and still be formatted: 256 delimiters of the pattern, padded to 2 KB. */
    const capped = () => {
      let text = "";
      while ((text + unit).match(/[*_]/g)!.length <= FIELD_DELIMITERS) text += unit;
      return text.padEnd(FIELD_FORMAT_BYTES, "a");
    };
    const room = (field: (bytes: number) => string) =>
      view({
        goal: field(2 * 1024),
        context: field(32 * 1024),
        openings: Array.from({ length: 50 }, (_, i) => ({ id: `role_${i}`, title: `Role ${i}`, responsibilities: field(4 * 1024), capacity: 50, filled: 0, preset: "public_participant", lead: false, publicly_claimable: true })),
        outputs: Array.from({ length: 50 }, (_, i) => ({ title: `Output ${i}`, description: field(4 * 1024), ready: false })),
      });
    const plainCount = (html: string) => html.match(/<p class="plain">/g)?.length ?? 0;

    it("formats nothing when every field is full of delimiters", () => {
      const started = performance.now();
      const html = roomPage(room(fill));
      expect(performance.now() - started).toBeLessThan(1_000);
      expect(plainCount(html)).toBe(102);
      expect(html).not.toMatch(/<(em|strong)>/);
      expect(roomPage(room(fill))).toBe(html);
    });

    it("formats only the first 8 KB of fields at the delimiter cap", () => {
      const started = performance.now();
      const html = roomPage(room(capped));
      expect(performance.now() - started).toBeLessThan(1_000);
      // The goal, the context and two openings fill the 8 KB; the other 98 fields are plain text.
      expect(plainCount(html)).toBe(98);
      expect(roomPage(room(capped))).toBe(html);
    });
  });

  it("has one not-found page", () => {
    expect(notFoundPage()).toContain("There's no public workroom at this address.");
  });
});
