// A refused request body's SHAPE, for step 9(b)'s opt-in real run only (the architect's request after #460's sixth real
// run): so a refusal can be ruled on by its structure without any of its words. It keeps key names that are plain
// identifiers, array lengths and each value's type (`string`, `number`, `bool`, `null`, `object`), and no string value
// at all except the fixed enums: a message's `role`, a block's `type`, `source.type`, `media_type` and
// `cache_control.type`, and those only when they are plain identifiers. It never describes the inside of a tool's input,
// a schema or metadata, whose keys a model or another party could choose: each reads only as `object`. Never used by
// Runner itself, and never in a default test run's output.

const KEY = /^[a-z_][a-z0-9_]{0,39}$/;
const ENUM = /^[a-z][a-z0-9_]{0,39}$/;
const MEDIA = /^[a-z]+\/[a-z0-9.+-]{1,40}$/;
/** Keys whose contents are never described. */
const OPAQUE = new Set(["input", "input_schema", "schema", "metadata", "properties"]);
/** Array items described, at most; the length is always given. */
const MAX_ITEMS = 40;

type Shape = string | number | null | Shape[] | { [key: string]: Shape };

function typeOf(v: unknown): string {
  if (v === null) return "null";
  if (typeof v === "boolean") return "bool";
  if (typeof v === "number") return "number";
  if (typeof v === "string") return "string";
  if (Array.isArray(v)) return "array";
  return typeof v === "object" ? "object" : "other";
}

/** Which keys' string values are fixed enums, by where they sit. */
function enumValue(key: string, parent: string | null, value: string): string | null {
  if (key === "role" && parent === "message") return ENUM.test(value) ? value : null;
  if (key === "type" && (parent === "block" || parent === "source" || parent === "cache_control")) return ENUM.test(value) ? value : null;
  if (key === "media_type" && parent === "source") return MEDIA.test(value) ? value : null;
  return null;
}

function shapeOf(v: unknown, kind: string | null): Shape {
  if (Array.isArray(v)) {
    const itemKind = kind === "messages" ? "message" : kind === "content" || kind === "system" ? "block" : null;
    return { length: v.length, items: v.slice(0, MAX_ITEMS).map((x) => shapeOf(x, itemKind)) } as unknown as Shape;
  }
  if (typeof v !== "object" || v === null) return typeOf(v);
  const out: { [key: string]: Shape } = {};
  for (const [rawKey, value] of Object.entries(v as Record<string, unknown>)) {
    const key = KEY.test(rawKey) ? rawKey : "other";
    if (OPAQUE.has(rawKey)) {
      out[key] = typeOf(value);
      continue;
    }
    if (typeof value === "string") {
      out[key] = enumValue(rawKey, kind, value) ?? "string";
      continue;
    }
    const childKind = rawKey === "messages" ? "messages" : rawKey === "content" ? "content" : rawKey === "system" ? "system" : rawKey === "source" ? "source" : rawKey === "cache_control" ? "cache_control" : null;
    out[key] = shapeOf(value, childKind);
  }
  return out;
}

/** The body's shape: structure, lengths, types and fixed enums only. */
export function bodyShape(body: unknown): Shape {
  return shapeOf(body, "body");
}
