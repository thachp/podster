// The contract's schemas keep their shape, checked by check.mjs and self-tested by schema-shape.test.mjs. YAML takes a
// mis-indented block without complaint: a schema's own keywords slip one level down and become properties named `type` or
// `required`, and an `items:` left empty parses as null, so a schema that looks right says nothing (TaskProvenance, #443).
//
// `validate` checks a value against the subset of JSON Schema the contract uses, so a test can hold a real answer to its
// schema. It has no dependencies, so the API's Workers tests can run it too.

/** Schema keywords that, met as a name under `properties`, mean a block slipped a level: no field here is named one. */
export const KEYWORD_NAMES = ["type", "properties", "items", "required", "additionalProperties"];

/** Every place in `doc` where a schema keyword is a property's name, or `items` is null, each named by its path. */
export function schemaShapeProblems(doc) {
  const problems = [];
  const walk = (node, at) => {
    if (Array.isArray(node)) { node.forEach((child, i) => walk(child, `${at}/${i}`)); return; }
    if (!node || typeof node !== "object") return;
    if ("items" in node && (node.items === null || typeof node.items !== "object")) problems.push(`${at}/items: is ${JSON.stringify(node.items)}, not a schema`);
    if (node.properties && typeof node.properties === "object" && !Array.isArray(node.properties)) {
      for (const name of Object.keys(node.properties)) {
        if (KEYWORD_NAMES.includes(name)) problems.push(`${at}/properties/${name}: a schema keyword as a property's name, so a block is mis-indented`);
        if (node.properties[name] === null) problems.push(`${at}/properties/${name}: is null, not a schema`);
      }
    }
    for (const [key, child] of Object.entries(node)) walk(child, `${at}/${key}`);
  };
  walk(doc, "#");
  return problems;
}

const typeOf = (value) => {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (Number.isInteger(value)) return "integer";
  return typeof value;
};

/**
 * Each way `value` breaks `schema`, by path; empty when it holds. `root` is the document `$ref`s resolve in. It knows
 * `$ref`, `type`, `enum`, `required`, `properties`, `additionalProperties`, `items`, `minItems`, `maxItems` and `pattern`,
 * and refuses a schema that uses any other validating keyword, so it never passes something it didn't look at.
 */
export function validate(schema, value, root = {}, at = "$") {
  const known = new Set(["$ref", "type", "enum", "required", "properties", "additionalProperties", "items", "minItems", "maxItems", "pattern", "description", "format", "example"]);
  while (schema?.$ref) schema = schema.$ref.replace(/^#\//, "").split("/").reduce((node, part) => node?.[part], root);
  if (!schema || typeof schema !== "object") return [`${at}: no schema`];
  const unknown = Object.keys(schema).filter((key) => !known.has(key));
  if (unknown.length) return [`${at}: the validator doesn't know ${unknown.join(", ")}`];
  const problems = [];
  if (schema.type !== undefined) {
    const types = [schema.type].flat();
    const actual = typeOf(value);
    if (!types.includes(actual) && !(actual === "integer" && types.includes("number"))) return [`${at}: is ${actual}, not ${types.join(" or ")}`];
  }
  if (schema.enum && !schema.enum.includes(value)) problems.push(`${at}: ${JSON.stringify(value)} isn't one of ${schema.enum.join(", ")}`);
  if (typeof value === "string" && schema.pattern && !new RegExp(schema.pattern, "u").test(value)) problems.push(`${at}: doesn't match ${schema.pattern}`);
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) problems.push(`${at}: fewer than ${schema.minItems} items`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) problems.push(`${at}: more than ${schema.maxItems} items`);
    if (schema.items) value.forEach((item, i) => problems.push(...validate(schema.items, item, root, `${at}[${i}]`)));
  } else if (value && typeof value === "object") {
    for (const name of schema.required ?? []) if (!(name in value)) problems.push(`${at}: lacks ${name}`);
    for (const [name, child] of Object.entries(value)) {
      const property = schema.properties?.[name];
      if (property) problems.push(...validate(property, child, root, `${at}.${name}`));
      else if (schema.additionalProperties === false) problems.push(`${at}: has ${name}, which the schema doesn't allow`);
      else if (typeof schema.additionalProperties === "object") problems.push(...validate(schema.additionalProperties, child, root, `${at}.${name}`));
    }
  }
  return problems;
}
