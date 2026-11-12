/// <reference types="vite/client" />
import { isValidElement, type ReactElement } from "react";

/**
 * A guard for the line between a server page and the client components it renders. React sends a client component's
 * props over the wire, and refuses what it can't serialize: a function that isn't a server action, a class instance, an
 * unregistered symbol. A test that calls a server page and renders the result in jsdom never serializes anything, so it
 * misses this, and the page answers 500 for real. This walks the element tree a server page returns and names every such
 * prop.
 *
 * Which components are client components is read from the source: a module under `app/` or `components/` whose first
 * statement is "use client". Server components it meets are expanded when they are plain functions, so a client
 * component rendered inside one is checked too; one that is async, or throws when called outside React, is walked only
 * through the props it was given.
 */
const sources = import.meta.glob<string>(["/app/**/*.tsx", "/components/**/*.tsx", "!/**/*.test.tsx"], { query: "?raw", import: "default", eager: true });
const loaders = import.meta.glob<Record<string, unknown>>(["/app/**/*.tsx", "/components/**/*.tsx", "!/**/*.test.tsx"]);

/**
 * Whether a module's first statement is the "use client" directive. One pass from the start, with no regular expression:
 * whitespace and comments are skipped by `indexOf`, so the time is linear in the file's length whatever it holds.
 */
export function isClientSource(text: string): boolean {
  let at = 0;
  while (at < text.length) {
    const char = text[at]!;
    if (char === " " || char === "\t" || char === "\n" || char === "\r" || char === "\uFEFF") {
      at += 1;
    } else if (text.startsWith("//", at)) {
      const end = text.indexOf("\n", at + 2);
      if (end === -1) return false;
      at = end + 1;
    } else if (text.startsWith("/*", at)) {
      const end = text.indexOf("*/", at + 2);
      if (end === -1) return false;
      at = end + 2;
    } else {
      return text.startsWith('"use client"', at) || text.startsWith("'use client'", at);
    }
  }
  return false;
}

/** Every exported component of every client module, by reference, with a name for messages. */
export async function clientComponents(): Promise<Map<unknown, string>> {
  const found = new Map<unknown, string>();
  for (const [path, text] of Object.entries(sources)) {
    if (!isClientSource(text)) continue;
    const loaded = await loaders[path]!();
    for (const [name, value] of Object.entries(loaded)) {
      if (typeof value === "function" || (typeof value === "object" && value !== null && "$$typeof" in value)) found.set(value, `${name} (${path.slice(1)})`);
    }
  }
  return found;
}

const SERVER_REFERENCE = Symbol.for("react.server.reference");
const SERIALIZABLE_CLASSES = [Date, Map, Set, ArrayBuffer, DataView, Promise, URLSearchParams] as const;

function checkValue(value: unknown, where: string, clients: Map<unknown, string>, problems: string[], seen: Set<unknown>) {
  if (typeof value === "function") {
    if ((value as { $$typeof?: symbol }).$$typeof !== SERVER_REFERENCE) problems.push(`${where} is a function`);
    return;
  }
  if (typeof value === "symbol") {
    if (Symbol.keyFor(value) === undefined) problems.push(`${where} is a symbol that isn't registered`);
    return;
  }
  if (typeof value !== "object" || value === null) return;
  if (isValidElement(value)) return visit(value, clients, problems, seen);
  if (seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) return value.forEach((item, index) => checkValue(item, `${where}[${index}]`, clients, problems, seen));
  if (value instanceof Map) return [...value].forEach(([key, item], index) => (checkValue(key, `${where} key ${index}`, clients, problems, seen), checkValue(item, `${where} value ${index}`, clients, problems, seen)));
  if (value instanceof Set) return [...value].forEach((item, index) => checkValue(item, `${where} item ${index}`, clients, problems, seen));
  if (ArrayBuffer.isView(value) || SERIALIZABLE_CLASSES.some((kind) => value instanceof kind)) return;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    problems.push(`${where} is an instance of ${(value as { constructor?: { name?: string } }).constructor?.name ?? "a class"}`);
    return;
  }
  for (const [key, item] of Object.entries(value)) checkValue(item, `${where}.${key}`, clients, problems, seen);
}

/** Walks a node's props for nested elements, without judging the props themselves: they stay on the server. */
function walkServerProps(props: Record<string, unknown>, clients: Map<unknown, string>, problems: string[], seen: Set<unknown>) {
  const nodes = (value: unknown): void => {
    if (Array.isArray(value)) return value.forEach(nodes);
    if (isValidElement(value)) visit(value, clients, problems, seen);
  };
  for (const value of Object.values(props)) nodes(value);
}

function visit(node: unknown, clients: Map<unknown, string>, problems: string[], seen: Set<unknown>): void {
  if (Array.isArray(node)) return node.forEach((child) => visit(child, clients, problems, seen));
  if (!isValidElement(node) || seen.has(node)) return;
  // A server component's children are reached twice, through its props and by expanding it; each is checked once.
  seen.add(node);
  const element = node as ReactElement<Record<string, unknown>>;
  const props = element.props ?? {};
  const client = clients.get(element.type);
  if (client) {
    for (const [prop, value] of Object.entries(props)) checkValue(value, `<${client.split(" ")[0]}> prop ${prop}`, clients, problems, seen);
    return;
  }
  walkServerProps(props, clients, problems, seen);
  // A plain server component: expand it, so the client components it renders are checked too.
  if (typeof element.type === "function") {
    try {
      const out = (element.type as (props: unknown) => unknown)(props);
      if (out && typeof (out as Promise<unknown>).then === "function") (out as Promise<unknown>).catch(() => null);
      else visit(out, clients, problems, seen);
    } catch {
      // Not callable outside React (a hook, a class). Its props were walked above.
    }
  }
}

/** Every prop that couldn't cross from the server to a client component, anywhere in what a server page returned. */
export function boundaryProblems(tree: unknown, clients: Map<unknown, string>): string[] {
  const problems: string[] = [];
  visit(tree, clients, problems, new Set());
  return problems;
}
