/**
 * Owner text as it's shown, on the public room page and in the owner's preview of it alike, so what the owner confirms is
 * what anyone reads (M4 step 11). Removes control and invisible format characters, which could make text read as something
 * else: bidirectional overrides such as U+202E, zero-width characters such as U+200B, and tag characters. It keeps line
 * breaks and tabs, which Markdown needs, and the joiners U+200C and U+200D, which scripts such as Persian need.
 * Applied before escaping and before Markdown.
 */
export const visibleText = (text: string) => text.replace(/(?![\n\t‌‍])[\p{Cc}\p{Cf}]/gu, "");
