import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { setUrl } from "@/test/next-navigation";
import { RepositoryGrants } from "../team/repository-grants";
import { TaskChangePanel, type PullRequestChange } from "../tasks/task-change";
import { RepositorySection } from "./repository-section";
import type { RepoLink, RepoRequest, RoomRepository } from "./repository-model";

// e2e/run-a11y.mjs runs every stack with managed repositories off, so it never reaches these sections. This runs axe over
// each of their states here instead. jsdom can't compute colours, so contrast is checked from the theme's own tokens below.
const check = async (container: Element) => {
  const results = await axe.run(container, { rules: { "color-contrast": { enabled: false } } });
  expect(results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
};

const request = (over: Partial<RepoRequest> = {}): RepoRequest => ({ id: "rr_1", state: "pending", name: "engineering", visibility: "public", reason: null, requested_by: "per_owner", requested_at: 1, updated_at: 1, attempts_left: 4, ...over });
const link = (over: Partial<RepoLink> = {}): RepoLink => ({ id: "rl_1", provider: "github", provider_repo_id: 42, full_name: "podsterdev/engineering", visibility: "public", default_branch: "main", status: "ready", status_reason: null, created_at: 1, verified_at: 1, updated_at: 1, ...over });

const STATES: [string, RoomRepository][] = [
  ["none", { request: null, repository: null, delegated: true }],
  ["none, without the delegation", { request: null, repository: null, delegated: false }],
  ["pending", { request: request(), repository: null }],
  ["ready", { request: request({ state: "ready" }), repository: link() }],
  ["degraded", { request: request({ state: "ready" }), repository: link({ status: "degraded", status_reason: "ruleset_differs" }) }],
  ["suspended", { request: request({ state: "ready" }), repository: link({ status: "suspended" }) }],
  ["failed", { request: request({ state: "failed", reason: "name_taken" }), repository: null }],
  ["uncertain", { request: request({ state: "uncertain", reason: "creation_outcome_unknown" }), repository: null }],
];

beforeEach(() => setUrl("/w/ws_1/settings"));

describe("axe over the repository screens", () => {
  it("does report a violation here, so a clean run means something", async () => {
    const { container } = render(
      <div>
        <input type="text" />
        <button type="button" />
      </div>,
    );
    const results = await axe.run(container, { rules: { "color-contrast": { enabled: false } } });
    expect(results.violations.map((v) => v.id)).toEqual(expect.arrayContaining(["label", "button-name"]));
  });

  for (const [name, state] of STATES) {
    for (const isOwner of [true, false]) {
      it(`the Settings section, ${name}, as ${isOwner ? "the owner" : "an admin"}`, async () => {
        const { container } = render(<RepositorySection roomId="ws_1" state={state} isOwner={isOwner} archived={false} />);
        await check(container);
      });
    }
  }

  it("the confirmation before a repository is created", async () => {
    render(<RepositorySection roomId="ws_1" state={STATES[0]![1]} isOwner archived={false} />);
    await userEvent.type(screen.getByLabelText("Repository name"), "engineering");
    await userEvent.click(screen.getByRole("button", { name: "Create a repository" }));
    await check(await screen.findByRole("alertdialog"));
  });

  it("the name field showing its problem", async () => {
    const { container } = render(<RepositorySection roomId="ws_1" state={STATES[0]![1]} isOwner archived={false} />);
    await userEvent.type(screen.getByLabelText("Repository name"), "Bad_Name");
    await userEvent.tab();
    await check(container);
  });

  it("the grants on Team, with the owner's form", async () => {
    const grants = [{ id: "pg_1", principal_id: "agt_1", action: "push" as const, delegated_by: "per_owner", created_at: 1, expires_at: null, revoked_at: null, state: "live" as const }];
    const { container } = render(<RepositoryGrants roomId="ws_1" grants={grants} linked isOwner isOrgAdmin={false} viewerId="per_owner" policyVersion={3} archived={false} members={[{ principal_id: "agt_1", kind: "agent", org_id: "org_a", role: "member" }]} names={{}} />);
    await check(container);
  });

  it("the task's Release panel, with every warning showing", async () => {
    const change: PullRequestChange = { provider_repo_id: 1, pr_number: 7, submission_no: 1, pr_state: "open", pr_draft: true, pr_observed_at: 1, commit_changed_at: 1, watched: false, observed_head_sha: "a".repeat(40), head_observed_at: 1, head_in_repository: false, base_is_default: false, observed_base_sha: null, reviewed_commit_sha: "b".repeat(40), reviewed_base_sha: null, commit_changed: true, merge_state: "not_requested", merge_reason: null, merge_sha: null, merge_observed_at: null };
    const { container } = render(<TaskChangePanel change={change} />);
    await check(container);
  });
});

/** WCAG 2.x relative luminance and contrast ratio. */
const luminance = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
};
const ratio = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
};

describe("the colours these screens use, in both themes", () => {
  const css = readFileSync(join(process.cwd(), "app/globals.css"), "utf8");
  const theme = (selector: string) => {
    const block = css.slice(css.indexOf(`${selector} {`), css.indexOf("}", css.indexOf(`${selector} {`)));
    return (name: string) => {
      const found = new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})`).exec(block);
      if (!found) throw new Error(`${selector} has no --${name}`);
      return found[1]!;
    };
  };

  for (const [label, selector] of [["light", ":root"], ["dark", ".dark"]] as const) {
    it(`meets AA for normal text in ${label}`, () => {
      const token = theme(selector);
      // Amber text on the Sheet's background (task-change.tsx's branch and base warnings) and on its own surface (the notes).
      for (const [text, background] of [["status-amber", "background"], ["status-amber", "status-amber-surface"], ["status-danger", "background"], ["status-danger", "status-danger-surface"], ["status-green", "status-green-surface"], ["status-blue", "status-blue-surface"], ["status-neutral", "status-neutral-surface"], ["muted-foreground", "background"]] as const) {
        expect(ratio(token(text), token(background)), `${text} on ${background}`).toBeGreaterThanOrEqual(4.5);
      }
    });
  }
});
