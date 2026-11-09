import type { ElementContent, RootContent } from "hast";
import { parseBody } from "@/components/agent-content/parse";
import { destinationHost, safeLinkUrl } from "@/components/agent-content/text";
import { visibleText } from "./visible-text";

// The public room page (M4 step 11(b), ADR 0008, decision 163) as plain HTML with no script, built on the server. Every
// value comes from the room's public view, written by its owner and admins, and is escaped here. Markdown goes through the
// app's inert parser, and only its allowed elements are written, each with no attributes but a link's checked address.

/**
 * A fixed formatting budget (ADR 0008: the browser's rendering limits hold on the server too). Parsing Markdown costs time that
 * grows faster than the text, and with the number of emphasis delimiters, and here it's billed CPU in an isolate every
 * page shares. So a field is formatted only if it's at most 2 KB with at most 256 `*` and `_`, and only while the page's
 * formatted fields add up to at most 8 KB, in page order. Anything else shows as escaped plain text with its line breaks
 * kept. It counts bytes and characters, never time, so the same view always renders the same page.
 */
export const FIELD_FORMAT_BYTES = 2 * 1024;
export const PAGE_FORMAT_BYTES = 8 * 1024;
export const FIELD_DELIMITERS = 256;

/** What's left of one page's formatting budget. */
export type FormatBudget = { left: number };
export const pageBudget = (): FormatBudget => ({ left: PAGE_FORMAT_BYTES });

const utf8Bytes = (text: string) => new TextEncoder().encode(text).length;
const delimiters = (text: string) => text.match(/[*_]/g)?.length ?? 0;
const plainText = (source: string) => `<p class="plain">${escapeHtml(source)}</p>`;

const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (c) => ESCAPES[c]);

/** Elements written as themselves, with no attributes. Anything else the parser allows is handled below or shows its text. */
const PLAIN = new Set(["p", "em", "strong", "del", "code", "pre", "ul", "ol", "li", "blockquote", "br", "hr", "table", "thead", "tbody", "tr", "th", "td"]);
const VOID = new Set(["br", "hr"]);
// A heading in someone's text sits under the page's own, so it never outranks them.
const HEADING: Record<string, string> = { h1: "h3", h2: "h3", h3: "h4", h4: "h5", h5: "h6", h6: "h6" };

function text(nodes: (RootContent | ElementContent)[]): string {
  return nodes.map((n) => (n.type === "text" ? n.value : n.type === "element" ? text(n.children) : "")).join("");
}

function write(nodes: (RootContent | ElementContent)[]): string {
  let out = "";
  for (const node of nodes) {
    if (node.type === "text") out += escapeHtml(node.value);
    if (node.type !== "element") continue;
    const tag = node.tagName;
    if (PLAIN.has(tag)) out += VOID.has(tag) ? `<${tag}>` : `<${tag}>${write(node.children)}</${tag}>`;
    else if (HEADING[tag]) out += `<${HEADING[tag]}>${write(node.children)}</${HEADING[tag]}>`;
    else if (tag === "a") {
      const url = safeLinkUrl(typeof node.properties?.href === "string" ? node.properties.href : undefined);
      // The host is shown, so a lookalike says where it goes. No new tab: the page has no script to need one.
      out += url
        ? `<a href="${escapeHtml(url)}" rel="noopener noreferrer nofollow ugc">${write(node.children)}</a> <span class="host">(${escapeHtml(destinationHost(url))})</span>`
        : write(node.children);
    } else if (tag === "img") {
      // Never loaded: fetching it would tell its host who's reading.
      const alt = typeof node.properties?.alt === "string" ? node.properties.alt : "";
      const url = safeLinkUrl(typeof node.properties?.src === "string" ? node.properties.src : undefined);
      out += `<span class="muted">[Image not loaded${alt ? `: ${escapeHtml(alt)}` : ""}${url ? ` from ${escapeHtml(destinationHost(url))}` : ""}]</span>`;
    } else if (tag === "input") {
      // The author's mark, not a control.
      if (node.properties?.type === "checkbox") out += node.properties.checked ? "[x] " : "[ ] ";
    } else out += write(node.children);
  }
  return out;
}

/** Markdown from the room's owner, written inert. Past the budget, or if it won't parse, it's plain text. */
export function inertMarkdown(raw: string, budget: FormatBudget = pageBudget()): string {
  // What the owner previewed: the same characters are removed there.
  const source = visibleText(raw);
  const bytes = utf8Bytes(source);
  if (bytes > FIELD_FORMAT_BYTES || bytes > budget.left || delimiters(source) > FIELD_DELIMITERS) return plainText(source);
  budget.left -= bytes;
  const parsed = parseBody(source);
  if (!parsed) return plainText(source);
  return write(parsed.tree.children);
}

/** A line of text with no formatting, such as a title. */
export const plain = (value: unknown) => escapeHtml(typeof value === "string" ? visibleText(value) : "");

export type PublicOpening = { id: string | null; title: string; responsibilities: string; capacity: number; filled: number; preset: string; lead: boolean; publicly_claimable: boolean };
export type PublicOutput = { title: string; description: string | null; ready: boolean };
export type PublicView = {
  handle: string;
  published_on: string;
  content: { name: string; goal: string | null; context: string | null; topic: string | null; workflow: string; openings: PublicOpening[]; outputs: PublicOutput[]; participant_count: number; person_review: boolean; archived: boolean };
};

const PRESETS: Record<string, string> = { public_participant: "Public participant", guest: "Guest", member: "Member", coordinator: "Coordinator" };
const count = (n: unknown) => (typeof n === "number" && Number.isFinite(n) ? String(Math.max(0, Math.trunc(n))) : "0");
const topicLabel = (topic: string) => topic.replace(/_/g, " ");

function shell(title: string, body: string) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<meta name="referrer" content="same-origin">
<title>${title}</title>
<link rel="stylesheet" href="${PUBLIC_STYLESHEET}">
</head>
<body>
<header class="bar"><a href="/" class="brand">Podster</a></header>
<main>
${body}
</main>
</body>
</html>
`;
}

/** The stylesheet the page loads, from this host, since its CSP allows no inline style. */
export const PUBLIC_STYLESHEET = "/p-assets/style";

function opening(o: PublicOpening, handle: string, budget: FormatBudget) {
  const open = o.publicly_claimable && o.id && o.filled < o.capacity;
  const claim = open
    ? `<p><a class="action" href="/workrooms/explore?${new URLSearchParams({ claim: handle, opening: String(o.id) }).toString().replace(/&/g, "&amp;")}">Claim with an agent</a></p>`
    : "";
  return `<li class="card">
<h3>${plain(o.title)}${o.lead ? ` <span class="tag">Lead</span>` : ""}</h3>
<p class="muted">${count(o.filled)} of ${count(o.capacity)} filled · ${plain(PRESETS[o.preset] ?? o.preset)}${o.publicly_claimable ? " · Open to agents" : ""}</p>
<div class="text">${inertMarkdown(typeof o.responsibilities === "string" ? o.responsibilities : "", budget)}</div>
${claim}</li>`;
}

function output(o: PublicOutput, budget: FormatBudget) {
  return `<li class="card">
<h3>${plain(o.title)} <span class="tag">${o.ready ? "Ready" : "Not ready"}</span></h3>
${o.description ? `<div class="text">${inertMarkdown(o.description, budget)}</div>` : ""}
</li>`;
}

/** The whole page for a public room's view. */
export function roomPage(view: PublicView): string {
  const c = view.content;
  // One budget for the page, spent in the order the page reads.
  const budget = pageBudget();
  const facts = [
    c.archived ? "Archived" : null,
    c.topic ? `Topic: ${topicLabel(c.topic)}` : null,
    `${count(c.participant_count)} participant${c.participant_count === 1 ? "" : "s"}`,
    c.person_review ? "A person reviews submitted work" : null,
    `Public since ${view.published_on}`,
  ].filter(Boolean) as string[];
  const openings = Array.isArray(c.openings) ? c.openings : [];
  const outputs = Array.isArray(c.outputs) ? c.outputs : [];
  const body = `<article>
<p class="eyebrow">Public workroom</p>
<h1>${plain(c.name)}</h1>
<p class="muted">${facts.map(escapeHtml).join(" · ")}</p>
${c.archived ? `<p class="notice">This workroom is archived. It takes no new claims.</p>` : ""}
${c.goal ? `<section><h2>Goal</h2><div class="text">${inertMarkdown(c.goal, budget)}</div></section>` : ""}
${c.context ? `<section><h2>Context</h2><div class="text">${inertMarkdown(c.context, budget)}</div></section>` : ""}
<section><h2>Openings</h2>${openings.length ? `<ul class="list">${openings.map((o) => opening(o, view.handle, budget)).join("\n")}</ul>` : `<p class="muted">No openings.</p>`}</section>
${outputs.length ? `<section><h2>Expected outputs</h2><ul class="list">${outputs.map((o) => output(o, budget)).join("\n")}</ul></section>` : ""}
<p class="muted small">Agents claim openings through Podster with their owner's permission. Everything here was written by the workroom's owner.</p>
</article>`;
  return shell(`${plain(c.name)} · Podster`, body);
}

/** One not-found page for every handle that doesn't answer, whatever the reason. */
export function notFoundPage(): string {
  return shell("Not found · Podster", `<article><h1>Not found</h1><p class="muted">There's no public workroom at this address.</p></article>`);
}

export function limitedPage(): string {
  return shell("Too many requests · Podster", `<article><h1>Too many requests</h1><p class="muted">Wait a minute, then try again.</p></article>`);
}

export const STYLESHEET = `:root{color-scheme:light dark;--fg:#1a1a1a;--muted:#5f5f5f;--bg:#fff;--line:#e3e3e3;--accent:#2f5bd3}
@media (prefers-color-scheme:dark){:root{--fg:#ececec;--muted:#a3a3a3;--bg:#141414;--line:#2c2c2c;--accent:#8aa8ff}}
*{box-sizing:border-box}body{margin:0;font:16px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif;color:var(--fg);background:var(--bg)}
.bar{border-bottom:1px solid var(--line);padding:12px 16px}.brand{font-weight:600;color:var(--fg);text-decoration:none}
main{max-width:760px;margin:0 auto;padding:24px 16px 48px}h1{font-size:1.75rem;line-height:1.25;margin:4px 0 8px;overflow-wrap:anywhere}
h2{font-size:1.15rem;margin:28px 0 8px}h3{font-size:1rem;margin:0 0 4px;overflow-wrap:anywhere}h4,h5,h6{font-size:1rem;margin:12px 0 4px}
.eyebrow{text-transform:uppercase;letter-spacing:.06em;font-size:.75rem;color:var(--muted);margin:0}.muted{color:var(--muted)}.small{font-size:.85rem;margin-top:32px}
.notice{border:1px solid var(--line);border-radius:8px;padding:8px 12px}.list{list-style:none;padding:0;margin:0;display:grid;gap:12px}
.card{border:1px solid var(--line);border-radius:10px;padding:12px 14px}.tag{font-size:.75rem;border:1px solid var(--line);border-radius:999px;padding:1px 8px;font-weight:500;color:var(--muted)}
.text{overflow-wrap:anywhere}.text p{margin:6px 0}.plain{white-space:pre-wrap}a{color:var(--accent)}.host{color:var(--muted);font-size:.85em}
.action{display:inline-block;border:1px solid var(--accent);border-radius:8px;padding:4px 12px;text-decoration:none}
pre{overflow-x:auto;padding:8px;border:1px solid var(--line);border-radius:6px}table{border-collapse:collapse;display:block;overflow-x:auto}th,td{border:1px solid var(--line);padding:4px 8px}
blockquote{margin:6px 0;padding-left:12px;border-left:3px solid var(--line);color:var(--muted)}
`;
