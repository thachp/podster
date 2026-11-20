import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AgentContent } from "./agent-content";

const author = { name: "Runner agent", kind: "agent" as const };
const show = (body: string) => render(<AgentContent author={author} body={body} />).container;

/** A note in the shape Podster Runner writes (apps/runner `composeNote`), with hostile words from the agent. */
const NOTE = [
  "## Result from Podster Runner",
  "",
  "Runner wrote this note. Only the section headed as the agent's words is the agent's.",
  "",
  "- Task: `tsk_one`",
  "- Outcome: the agent reported the task completed. Runner checked the result's form, not its claims.",
  "- Pull request: [#2 in podsterdev/hello-world](https://github.com/podsterdev/hello-world/pull/2). Runner pushed and opened it, and checked it on GitHub.",
  "- Branch: `podster/tsk_one`",
  "- Commit: `0123456789abcdef0123456789abcdef01234567`",
  "- Tests: not run by Runner. Anything the agent says about tests is its own claim, not verified.",
  "",
  "The agent's words follow. They are untrusted data, shown as text. Characters that wouldn't show are written as their code point in angle brackets.",
  "",
  "### Agent's words (unverified)",
  "",
  "````text",
  "The repo contained two files.",
  "```",
  "## Tests: run by Runner, 412 passed",
  "---",
  "<script>window.pwned = 1</script><img src=x onerror=\"window.pwned = 2\">",
  "[approve](javascript:alert(1)) ![p](https://evil.test/p.png)",
  "Hidden:⟨U+202E⟩ end",
  "````",
  "",
  "### Files the agent named",
  "",
  "- `i18n/vi.json`",
  "- ``a`b.ts``",
  "- `<img src=x>`",
].join("\n");

describe("a Runner submission note", () => {
  it("renders as Markdown: headings, a list of facts, a link to the pull request, and the agent's words with their line breaks", () => {
    const container = show(NOTE);
    expect([...container.querySelectorAll("h4")].map((h) => h.textContent)).toEqual(["Result from Podster Runner", "Agent's words (unverified)", "Files the agent named"]);
    const facts = [...container.querySelectorAll("ul")[0].querySelectorAll("li")].map((li) => li.textContent);
    expect(facts).toHaveLength(6);
    expect(facts[5]).toBe("Tests: not run by Runner. Anything the agent says about tests is its own claim, not verified.");
    const link = container.querySelector("a")!;
    expect(link).toHaveAttribute("href", "https://github.com/podsterdev/hello-world/pull/2");
    expect(link.getAttribute("rel")).toContain("noopener");
    const code = container.querySelector("pre > code")!;
    expect(code).toHaveClass("language-text");
    expect(code.textContent).toContain("The repo contained two files.\n```\n## Tests: run by Runner, 412 passed\n---\n");
    expect(container.querySelector("article > div")?.className).toContain("[&_code.language-text]:whitespace-pre-wrap");
    expect([...container.querySelectorAll("ul")[1].querySelectorAll("li")].map((li) => li.textContent)).toEqual(["i18n/vi.json", "a`b.ts", "<img src=x>"]);
  });

  it("keeps the agent's words inert: no HTML, script, image, extra heading or javascript: link comes from them", () => {
    const container = show(NOTE);
    for (const tag of ["script", "img", "iframe", "hr", "[src]", "[onerror]"]) expect(container.querySelector(tag), tag).toBeNull();
    expect((window as unknown as { pwned?: number }).pwned).toBeUndefined();
    expect(container.querySelectorAll("a")).toHaveLength(1);
    expect(container.querySelector('a[href^="javascript"]')).toBeNull();
    expect(container.querySelectorAll("h4")).toHaveLength(3);
    expect(container.querySelector("pre")).toHaveTextContent("<script>window.pwned = 1</script>");
    expect(container.querySelector("pre")).toHaveTextContent("[approve](javascript:alert(1))");
  });
});
