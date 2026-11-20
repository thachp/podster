/**
 * The exact secret values Runner holds right now (review of #489): a run's broker token and a task's GitHub token. The
 * local diagnostics file redacts each by exact match before it writes, beside the pattern redaction, which a bare 64-hex
 * token wouldn't match. Values live in memory only, from when they're made or received until they're dropped.
 */
const held = new Map<string, number>();
const MIN_LENGTH = 16;

/** Holds `value` until the returned release is called. Short values are ignored: they'd redact ordinary words. */
export function holdSecret(value: string): () => void {
  if (typeof value !== "string" || value.length < MIN_LENGTH) return () => undefined;
  held.set(value, (held.get(value) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const n = (held.get(value) ?? 1) - 1;
    if (n <= 0) held.delete(value);
    else held.set(value, n);
  };
}

/** The text with every held secret value replaced by `[redacted]`, and how many were. */
export function redactKnown(text: string): { text: string; count: number } {
  let out = text;
  let count = 0;
  // Longest first, so a value that contains another is taken whole.
  for (const value of [...held.keys()].sort((a, b) => b.length - a.length)) {
    const parts = out.split(value);
    count += parts.length - 1;
    out = parts.join("[redacted]");
  }
  return { text: out, count };
}

/** How many values are held, for tests. */
export const heldSecretCount = () => held.size;
