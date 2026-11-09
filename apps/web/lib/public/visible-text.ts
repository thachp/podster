/**
 * Owner text as it's shown, on the public room page and in the owner's preview of it alike, so what the owner confirms is
 * what anyone reads (M4 step 11). Removes what could make text read as something else or look empty while it isn't:
 * control and format characters, such as the bidirectional override U+202E, zero-width U+200B and tag characters; every
 * Unicode Default_Ignorable code point, such as the Hangul filler U+3164, variation selectors and the combining grapheme
 * joiner U+034F; and the blank Braille pattern U+2800, which isn't ignorable but shows as nothing. It keeps line breaks and
 * tabs, which Markdown needs, and the joiners U+200C and U+200D, which scripts such as Persian need.
 * Applied before escaping and before Markdown.
 */
export const visibleText = (text: string) => text.replace(/(?![\n\t‌‍])[\p{Cc}\p{Cf}\p{Default_Ignorable_Code_Point}⠀]/gu, "");

/** A room's name as shown: "Unnamed" when nothing visible is left, so a page never has an empty title. */
export function visibleName(name: unknown) {
  const visible = typeof name === "string" ? visibleText(name) : "";
  return visible.trim() ? visible : "Unnamed";
}
