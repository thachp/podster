import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setUrl } from "@/test/next-navigation";
import { roomPage } from "@/lib/public/render";
import { visibleText } from "@/lib/public/visible-text";
import { PreviewFields, VisibilityControls } from "./visibility-controls";
import { publishBlock, type RoomVisibility } from "./visibility-model";

const HASH = "a".repeat(64);
const base = (): RoomVisibility => ({
  visibility: "private",
  public_handle: null,
  published_at: null,
  published_on: null,
  topic: null,
  public_claims_paused: false,
  suspension: null,
  public_rooms_enabled: true,
  view_hash: HASH,
  preview: {
    archived: false,
    context: "Line one\nLine ‮two",
    goal: "Ship <script>alert(1)</script>",
    name: "Launch room",
    openings: [
      { capacity: 2, filled: 1, id: "rol_1", lead: false, preset: "public_participant", publicly_claimable: true, responsibilities: "Writes tests", title: "Tester" },
      { capacity: 1, filled: 0, id: null, lead: true, preset: "coordinator", publicly_claimable: false, responsibilities: "Runs it", title: "Lead" },
    ],
    outputs: [{ description: "The plan", ready: true, title: "Plan" }],
    participant_count: 3,
    person_review: true,
    topic: null,
    workflow: "general",
  },
});

const sent: { method: string; url: string; body: unknown }[] = [];
let reply: { status: number; body: unknown };

beforeEach(() => {
  setUrl("/w/ws_1/settings");
  sent.length = 0;
  reply = { status: 200, body: {} };
  vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
    sent.push({ method: init.method ?? "GET", url, body: JSON.parse(String(init.body)) });
    return new Response(JSON.stringify(reply.body), { status: reply.status });
  });
});
afterEach(() => vi.unstubAllGlobals());

const show = (state: RoomVisibility = base(), { isOwner = true, archived = false } = {}) => render(<VisibilityControls roomId="ws_1" state={state} isOwner={isOwner} archived={archived} />);

async function confirm(label: string) {
  await userEvent.click(screen.getByRole("button", { name: label }));
  const dialog = await screen.findByRole("alertdialog");
  await userEvent.click(within(dialog).getByRole("button", { name: label }));
}

describe("visibility in Settings", () => {
  it("previews exactly the API's fields, as text, and says what's never public", () => {
    show();
    expect(screen.getByRole("heading", { name: "What would be public" })).toBeInTheDocument();
    // Text, never markup, and without the bidirectional override.
    expect(screen.getByText("Ship <script>alert(1)</script>")).toBeInTheDocument();
    expect(document.querySelector("script")).toBeNull();
    expect(screen.getByText(/Line one\s+Line two/)).toBeInTheDocument();
    expect(screen.getByText("1 of 2 filled · Public participant")).toBeInTheDocument();
    expect(screen.getByText("0 of 1 filled · Coordinator · Lead coordinator")).toBeInTheDocument();
    expect(screen.getAllByText("Claimable from the public page")).toHaveLength(1);
    expect(screen.getByText("3, as a number only")).toBeInTheDocument();
    expect(screen.getByText(/Never public: who's in the workroom/)).toBeInTheDocument();
  });

  it("publishes naming the hash of the preview shown, with no policy version", async () => {
    reply = { status: 200, body: { ...base(), visibility: "public" } };
    show();
    await confirm("Make public");
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toEqual({ method: "PUT", url: "/api/v1/workspaces/ws_1/visibility", body: { visibility: "public", view_hash: HASH } });
    expect(await screen.findByText(/public now, under a new link/)).toBeInTheDocument();
  });

  it("says a changed preview published nothing", async () => {
    reply = { status: 409, body: { error: { code: "version_conflict" } } };
    show();
    await confirm("Make public");
    expect(await screen.findByText(/changed since you looked, so it isn't public/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Review latest" })).toBeInTheDocument();
  });

  it("explains a refusal for person review", async () => {
    reply = { status: 409, body: { error: { code: "person_review_required" } } };
    show();
    await confirm("Make public");
    expect(await screen.findByRole("alert")).toHaveTextContent(/need a person to review/);
  });

  it("offers going public only where it could work, and says why not", () => {
    const state = base();
    expect(publishBlock(state, { isOwner: true, archived: false })).toBeNull();
    expect(publishBlock(state, { isOwner: false, archived: false })).toMatch(/Only the owner/);
    expect(publishBlock({ ...state, public_rooms_enabled: false }, { isOwner: true, archived: false })).toMatch(/hasn't opened public workrooms/);
    expect(publishBlock(state, { isOwner: true, archived: true })).toMatch(/Bring this workroom back/);
    expect(publishBlock({ ...state, preview: { ...state.preview, person_review: false } }, { isOwner: true, archived: false })).toMatch(/Require a person to review/);
    expect(publishBlock({ ...state, suspension: { reason: "spam", at: 0 } }, { isOwner: true, archived: false })).toMatch(/suspended/);
    show(state, { isOwner: false });
    const button = screen.getByRole("button", { name: "Make public" });
    expect(button).toBeDisabled();
    expect(button).toHaveAccessibleDescription(/Only the owner/);
  });

  it("shows a public room's link, and makes it private with the owner's choice about claims", async () => {
    show({ ...base(), visibility: "public", public_handle: "pub_0123456789abcdef0123456789abcdef", published_on: "2026-11-09" }, { isOwner: false });
    expect(screen.getByText(/Public since 2026-11-09/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open the public page" })).toHaveAttribute("href", "/p/pub_0123456789abcdef0123456789abcdef");
    expect(screen.getByRole("heading", { name: "What's public now" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("checkbox", { name: /Also end public claims/ }));
    await confirm("Make private");
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toEqual({ method: "PUT", url: "/api/v1/workspaces/ws_1/visibility", body: { visibility: "private", end_public_claims: true } });
    expect(await screen.findByText(/public claims have ended/)).toBeInTheDocument();
  });

  it("says when Podster suspended it, with the reason in words", () => {
    show({ ...base(), suspension: { reason: "impersonation", at: Date.UTC(2026, 10, 8) } });
    expect(screen.getByRole("note")).toHaveTextContent("Suspended by Podster on 2026-11-08, for impersonation.");
    expect(screen.getByRole("button", { name: "Make public" })).toBeDisabled();
  });

  it("shows the same visible text as the public page, with the same invisible characters removed", () => {
    const hidden = (text: string) => `${text}\u202E\u200B\u{E0041}\u{E0001}`;
    const seeds = { name: hidden("Reef survey"), goal: `Count${"\u200B"} the ${"\u202E"}fish`, context: `Line one\nLine ${"\u202E"}two${"\u{E0067}"}`, title: hidden("Diver"), responsibilities: `Dive${"\u200B"} daily`, outputTitle: hidden("Fish count"), description: `Per ${"\u202E"}reef` };
    const preview = {
      ...base().preview,
      name: seeds.name,
      goal: seeds.goal,
      context: seeds.context,
      openings: [{ capacity: 2, filled: 0, id: "rol_1", lead: false, preset: "guest", publicly_claimable: true, responsibilities: seeds.responsibilities, title: seeds.title }],
      outputs: [{ description: seeds.description, ready: false, title: seeds.outputTitle }],
    };
    const { container } = render(<PreviewFields preview={preview} />);
    const page = new DOMParser().parseFromString(roomPage({ handle: `pub_${"1".repeat(32)}`, published_on: "2026-11-09", content: preview }), "text/html");
    const shown = container.textContent ?? "";
    const served = page.body.textContent ?? "";
    for (const seed of Object.values(seeds)) {
      const visible = visibleText(seed);
      expect(visible).not.toBe(seed);
      expect(shown, seed).toContain(visible);
      expect(served, seed).toContain(visible);
    }
    const invisible = /[\u202E\u200B\u{E0000}-\u{E007F}]/u;
    expect(shown).not.toMatch(invisible);
    expect(served).not.toMatch(invisible);
  });

  it("bases the claimable badge on the opening's setting, as the public page does", () => {
    const state = base();
    state.preview.openings = [{ ...state.preview.openings[0], id: null, publicly_claimable: true }];
    show(state);
    expect(screen.getByText("Claimable from the public page")).toBeInTheDocument();
  });

  it("won't publish while the topic has unsaved changes", async () => {
    show();
    await userEvent.selectOptions(screen.getByLabelText("Topic"), "research");
    const button = screen.getByRole("button", { name: "Make public" });
    expect(button).toBeDisabled();
    expect(button).toHaveAccessibleDescription("Save the topic first.");
  });

  it("says a public room isn't being served while public pages are off", () => {
    show({ ...base(), visibility: "public", public_handle: "pub_0123456789abcdef0123456789abcdef", published_on: "2026-11-09", public_rooms_enabled: false });
    expect(screen.getByText(/Public since 2026-11-09, but Podster isn't serving public pages right now/)).toBeInTheDocument();
    expect(screen.queryByText(/Anyone with the link can read/)).toBeNull();
  });

  it("saves a topic, or clears it", async () => {
    show({ ...base(), topic: "film" });
    const save = screen.getByRole("button", { name: "Save topic" });
    expect(save).toBeDisabled();
    await userEvent.selectOptions(screen.getByLabelText("Topic"), "research");
    await userEvent.click(save);
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toEqual({ method: "PUT", url: "/api/v1/workspaces/ws_1/topic", body: { topic: "research" } });
    await userEvent.selectOptions(screen.getByLabelText("Topic"), "");
    await userEvent.click(save);
    await waitFor(() => expect(sent).toHaveLength(2));
    expect(sent[1]?.body).toEqual({ topic: null });
  });
});
