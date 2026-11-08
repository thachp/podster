import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { FileStateBadge } from "./file-state-badge";

describe("FileStateBadge", () => {
  it.each([
    ["uploading", "Uploading"],
    ["scanning", "Scanning"],
    ["ready", "Ready"],
    ["blocked", "Blocked"],
    ["failed", "Scan failed"],
    ["removed", "Removed"],
    [null, "Unavailable"],
    ["toString", "Unavailable"],
  ])("labels %s as %s, with an icon that isn't read out", (state, label) => {
    const { container } = render(<FileStateBadge state={state} />);
    expect(screen.getByText(label)).toBeInTheDocument();
    expect(container.querySelector("svg")).toHaveAttribute("aria-hidden");
  });
});
