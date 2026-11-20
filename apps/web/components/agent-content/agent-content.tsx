"use client";

import { Bot, ExternalLink, User } from "lucide-react";
import { toJsxRuntime, type Components } from "hast-util-to-jsx-runtime";
import { Component, memo, useEffect, useRef, useState, type ReactNode } from "react";
import { Fragment, jsx, jsxs } from "react/jsx-runtime";
import { Badge } from "@/components/ui/badge";
import { revealWhenIdle } from "./layout-reveal";
import { CANT_FORMAT_NOTE, NOTE_CLASS, PARSE_AT_ONCE_CHARS, PLAIN_TEXT_CLASS } from "./limits";
import { useParsedBody, type BodyState } from "./use-parsed-body";
import { authoritySoundingName, chosenNameLabel, destinationHost, plainName, safeLinkUrl, truncate } from "./text";

/** `viewer` means this is the person looking, whose "You" is ours and not a name anyone chose. */
export type AgentAuthor = { name: string; kind: "agent" | "person"; organization?: string; viewer?: boolean };

/** Every level is one fixed level below a screen's section headings, and no bigger than the text around it, so agent text can't pass for the page's own structure. */
const heading: Components["h1"] = ({ children }) => <h4 className="font-semibold">{children}</h4>;

/** Wide tables scroll here and not the page. Scrolling has to work by keyboard, so this takes focus, but only when it scrolls: a tab stop per table adds up. Its name is ours. */
function TableScroller({ children }: { children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [scrolls, setScrolls] = useState(true);
  useEffect(() => {
    const element = ref.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => setScrolls(element.scrollWidth > element.clientWidth));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return (
    <div ref={ref} role="group" aria-label="Table in this text. It may scroll sideways." tabIndex={scrolls ? 0 : undefined} className="max-w-full overflow-x-auto rounded-md outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50">
      {children}
    </div>
  );
}

/** These take only their children, so nothing Markdown can set reaches them, including a cell's alignment, which arrives as `style`. */
const COMPONENTS: Partial<Components> = {
  h1: heading,
  h2: heading,
  h3: heading,
  h4: heading,
  h5: heading,
  h6: heading,
  table({ children }) {
    return (
      <TableScroller>
        <table className="border-collapse text-sm">{children}</table>
      </TableScroller>
    );
  },
  th({ children }) {
    return (
      <th scope="col" className="min-w-20 border bg-muted px-2 py-1 text-left align-top font-medium">
        {children}
      </th>
    );
  },
  td({ children }) {
    return <td className="min-w-20 border px-2 py-1 align-top">{children}</td>;
  },
  // The author's mark and nothing more: it can't be changed, nobody has verified it, and only Podster's own controls show a task's state.
  input({ type, checked }) {
    if (type !== "checkbox") return null;
    return <input type="checkbox" checked={Boolean(checked)} disabled readOnly aria-label="Author's mark, not verified by Podster" className="mr-1.5 align-middle" />;
  },
  a({ href, children }) {
    const url = safeLinkUrl(href);
    if (!url) return <>{children}</>;
    return (
      <a href={url} target="_blank" rel="noopener noreferrer nofollow ugc" className="text-primary underline break-all">
        {children}
        <span className="text-muted-foreground"> ({destinationHost(url)})</span>
        <ExternalLink className="ml-1 inline size-3" aria-label="external link" />
      </a>
    );
  },
  // Never an <img>: fetching one would tell its host who's reading.
  img({ src, alt }) {
    const url = safeLinkUrl(typeof src === "string" ? src : undefined);
    return (
      <span className="text-muted-foreground">
        [Image not loaded{alt ? `: ${alt}` : ""}
        {url ? ` from ${destinationHost(url)}` : ""}]
      </span>
    );
  },
};

/**
 * Layout of long text starts skipped, and layout-reveal.ts ends that for whatever turns out to be cheap. Skipping contains paint, so the
 * classes beside this leave room for a focus ring and for list numbers, which hang to the left. The size only stands in until the first layout.
 */
function skippedLayout(text: string) {
  if (text.length <= PARSE_AT_ONCE_CHARS) return {};
  return { style: { contentVisibility: "auto", containIntrinsicSize: `auto ${Math.ceil(text.length / 50) * 20}px` } } as const;
}

function PlainText({ text }: { text: string }) {
  return (
    <>
      <p className={NOTE_CLASS}>{CANT_FORMAT_NOTE}</p>
      <p className={PLAIN_TEXT_CLASS}>{text}</p>
    </>
  );
}

/** One message that can't be rendered shows as its own text, and the rest of the page stays. */
class RenderBoundary extends Component<{ text: string; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? <PlainText text={this.props.text} /> : this.props.children;
  }
}

/** A tree only ever changes with its text, so re-rendering never builds this again. Allowed elements only: parse.ts removed the rest. */
const Formatted = memo(function Formatted({ tree }: { tree: Extract<BodyState, { kind: "ready" }>["tree"] }) {
  return toJsxRuntime(tree, { Fragment, jsx, jsxs, components: COMPONENTS, ignoreInvalidStyle: true, passKeys: true, passNode: false });
});

function Body({ text, state }: { text: string; state: BodyState }) {
  if (state.kind === "pending") return <p className={PLAIN_TEXT_CLASS}>{text}</p>;
  if (state.kind === "failed") return <PlainText text={text} />;
  return (
    <RenderBoundary key={text} text={text}>
      <Formatted tree={state.tree} />
    </RenderBoundary>
  );
}

/**
 * Text an agent wrote. It's attributed, can't load anything and can't become markup, and it never carries instructions
 * for Podster, or looks like Podster's own guidance.
 */
export function AgentContent({ author, external = false, body, maxLength }: { author: AgentAuthor; external?: boolean; body: string; maxLength?: number }) {
  const { text, truncated } = truncate(body, maxLength);
  const article = useRef<HTMLElement>(null);
  const state = useParsedBody(text, article);
  const content = useRef<HTMLDivElement>(null);
  const isLong = text.length > PARSE_AT_ONCE_CHARS;
  useEffect(() => {
    if (isLong && content.current && article.current) return revealWhenIdle(content.current, article.current);
  }, [isLong]);
  return (
    <article ref={article} className="min-w-0 rounded-lg border p-3">
      <AuthorLine author={author} external={external} />
      {/* From the fifth level, nesting stops indenting, or 100 levels push text 1,000 px out of a Sheet at phone width. Without kerning,
          a long run of `*` or `_` lays out in 1 ms instead of 350 ms: kerning pairs make the shaper redo the run for every line. A code
          block marked `text`, as Runner's notes carry an agent's words, wraps like prose instead of scrolling sideways. */}
      <div ref={content} {...skippedLayout(text)} className={`[font-kerning:none] break-words [&_blockquote]:border-l-2 [&_blockquote]:pl-3 [&_code]:font-mono [&_ol]:list-decimal [&_ol]:pl-5 [&_pre]:overflow-x-auto [&_code.language-text]:whitespace-pre-wrap [&_pre]:rounded-md [&_pre]:bg-muted [&_pre]:p-2 [&_.task-list-item]:list-none [&_ul]:list-disc [&_ul]:pl-5 [&_:is(ul,ol,blockquote)_:is(ul,ol,blockquote)_:is(ul,ol,blockquote)_:is(ul,ol,blockquote)_:is(ul,ol,blockquote)]:border-l-0 [&_:is(ul,ol,blockquote)_:is(ul,ol,blockquote)_:is(ul,ol,blockquote)_:is(ul,ol,blockquote)_:is(ul,ol,blockquote)]:pl-0 [&_:is(ul,ol,blockquote)_:is(ul,ol,blockquote)_:is(ul,ol,blockquote)_:is(ul,ol,blockquote)_blockquote]:shadow-[inset_2px_0_0_var(--border)] ${text.length > PARSE_AT_ONCE_CHARS ? "-mr-1 -mb-1 -ml-7 mt-1 space-y-2 pt-1 pr-1 pb-1 pl-7" : "mt-2 space-y-2"}`}>
        <Body text={text} state={state} />
      </div>
      {truncated ? <p className="mt-2 text-xs text-muted-foreground">Shortened for display.</p> : null}
    </article>
  );
}

export function AuthorLine({ author, external = false }: { author: AgentAuthor; external?: boolean }) {
  const name = plainName(author.name);
  const Icon = author.kind === "agent" ? Bot : User;
  return (
    <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
      <Icon className="size-3.5" aria-hidden />
      <span className="max-w-full truncate font-medium text-foreground" title={name}>
        {name}
      </span>
      <span>{author.kind === "agent" ? "Agent" : "Person"}</span>
      {author.organization ? (
        <span className="max-w-full truncate" title={plainName(author.organization)}>
          {plainName(author.organization)}
        </span>
      ) : null}
      {!author.viewer && authoritySoundingName(name) ? <Badge variant="outline">{chosenNameLabel(author.kind)}</Badge> : null}
      {external ? <Badge variant="outline">External</Badge> : null}
    </p>
  );
}
