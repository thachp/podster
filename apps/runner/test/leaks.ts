/**
 * What a test bans from logs and records. A task's word is matched as a whole token, never as a substring: Runner's logs
 * and records hold random IDs, keys, thumbprints and nonces in base64url, so `curl` or `leak` turns up inside one by
 * chance (CI run 44543735040: `xyPKcurljY8ryB…`). A secret, such as the provider key, is matched as an exact substring
 * anywhere, since no part of it may appear.
 */

/** Every string in a value, keys included, each as it is, so JSON's escapes never join a word to its neighbour. */
function strings(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const v of value) strings(v, out);
  else if (value !== null && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      out.push(k);
      strings(v, out);
    }
  }
  return out;
}

/** base64url's alphabet: read as word characters, so a word never matches inside a random value. */
const WORD = /[A-Za-z0-9_-]/;

/**
 * Whether `text` holds `word` as a whole token: where the word begins or ends with a word character, the character
 * beside it there must not be one. A word that begins or ends with punctuation (`.ssh`, `SYSTEM:`) has no boundary
 * there.
 */
export function hasToken(text: string, word: string): boolean {
  if (word === "") return false;
  for (let at = text.indexOf(word); at !== -1; at = text.indexOf(word, at + 1)) {
    const before = at === 0 ? "" : text[at - 1];
    const after = text[at + word.length] ?? "";
    const startOk = !WORD.test(word[0]) || !WORD.test(before);
    const endOk = !WORD.test(word[word.length - 1]) || !WORD.test(after);
    if (startOk && endOk) return true;
  }
  return false;
}

/** The banned words found in `value` as whole tokens, and the secrets found in it as substrings. */
export function leaksIn(value: unknown, ban: { words: readonly string[]; secrets: readonly string[] }): string[] {
  const texts = strings(value);
  return [...ban.words.filter((w) => texts.some((t) => hasToken(t, w))), ...ban.secrets.filter((s) => texts.some((t) => t.includes(s)))];
}
