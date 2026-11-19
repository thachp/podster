// The schema-shape guard and the validator, checked on inputs of their own, so "no problems" in check.mjs means something.
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { schemaShapeProblems, unknownKeywordProblems, validate } from "./schema-shape.mjs";

let failed = 0;
const check = (ok, what) => { console.log(`${ok ? "ok  " : "FAIL"} ${what}`); if (!ok) failed++; };

// The shape #443 shipped: the author schema under `items:` sits at its parent's indentation.
const broken = parse(`
components:
  schemas:
    Shape:
      type: object
      properties:
        authors:
          type: array
          items:
        type: object
        additionalProperties: false
        required: [id]
        properties:
          id: { type: string }
`);
const found = schemaShapeProblems(broken);
check(broken.components.schemas.Shape.properties.authors.items === null, "the broken shape parses as YAML does: `items` is null");
check(found.includes("#/components/schemas/Shape/properties/authors/items: is null, not a schema"), "a null `items` is found, by path");
for (const name of ["type", "additionalProperties", "required", "properties"]) {
  check(found.some((p) => p.startsWith(`#/components/schemas/Shape/properties/${name}:`)), `a property named \`${name}\` is found`);
}
check(schemaShapeProblems({ s: { properties: { items: { type: "array" } } } }).length === 1, "a property named `items` is found");
check(schemaShapeProblems({ s: { allOf: [{ properties: { a: { type: "array", items: null } } }] } }).length === 1, "a null `items` deep in allOf is found");
check(schemaShapeProblems({ s: { properties: { a: null } } }).length === 1, "a null property schema is found");

// #468's shape: a property written inside its neighbour's schema map, where YAML takes it as a key of that schema.
const slipped = parse(`
paths:
  /x:
    put:
      requestBody: { content: { application/json: { schema: { type: object, properties: { rotate_secret: { type: boolean, description: "d", delivery: { type: string } } } } } } }
components:
  schemas:
    Ok: { type: object, additionalProperties: false, properties: { a: { type: [string, "null"], maxLength: 3, x-note: 1 }, b: { allOf: [{ $ref: "#/c" }] } } }
    Bad: { type: array, items: { type: string, delivery: 1 } }
`);
const slippedFound = unknownKeywordProblems(slipped);
check(slippedFound.includes("#/paths//x/put/requestBody/content/application/json/schema/properties/rotate_secret/delivery: not a schema keyword, so a field sits in the wrong map"), "a key inside a boolean schema is found, by path");
check(slippedFound.some((p) => p.startsWith("#/components/schemas/Bad/items/delivery:")), "a key inside an items schema is found");
check(!slippedFound.some((p) => p.includes("/Ok/")), "keywords, x- extensions and allOf entries pass");
check(slippedFound.length === 2, "nothing else is found");
check(unknownKeywordProblems({ type: "object", properties: { a: { tpye: "string" } } }, true).length === 1, "a misspelt keyword in a root schema file is found");
check(unknownKeywordProblems({ paths: { "/y": { get: { summary: "s", tags: ["q"] } } } }).length === 0, "an operation's own keys aren't schema keys");

const fixed = parse(`
components:
  schemas:
    Shape:
      type: object
      properties:
        authors:
          type: array
          items:
            type: object
            additionalProperties: false
            required: [id]
            properties:
              id: { type: string }
`);
check(schemaShapeProblems(fixed).length === 0, "the same schema, indented right, passes");

// The validator, on the contract's own TaskProvenance and an answer shaped as apps/api's provenance::of_task makes one.
const api = parse(readFileSync(new URL("openapi.yaml", import.meta.url), "utf8"));
const schema = { $ref: "#/components/schemas/TaskProvenance" };
const author = { id: "agt_a", org: "org_a", external: false, active: true, written_at: 1 };
const unknown = { id: null, org: null, external: true, active: false, written_at: null };
const answer = {
  room_visibility: "private",
  requester: { id: "agt_a", org: null, external: true, active: false },
  inputs: [
    { input: "title", external: false, authors: [author] },
    { input: "change_request", external: true, authors: [author, unknown], event_id: null },
  ],
};
const clone = () => structuredClone(answer);
check(validate(schema, answer, api).length === 0, "an answer of of_task's shape holds to TaskProvenance");
const extra = clone(); extra.inputs[0].authors[0].name = "x";
check(validate(schema, extra, api).some((p) => p.includes("inputs[0].authors[0]") && p.includes("name")), "an author with a field the schema lacks fails");
const lacking = clone(); delete lacking.inputs[0].authors[0].written_at;
check(validate(schema, lacking, api).some((p) => p.includes("lacks written_at")), "an author without `written_at` fails");
const wrong = clone(); wrong.inputs[0].authors[0].active = "yes";
check(validate(schema, wrong, api).some((p) => p.includes("authors[0].active")), "a wrong type fails");
const none = clone(); none.inputs[0].authors = [];
check(validate(schema, none, api).some((p) => p.includes("fewer than 1")), "an input with no author fails");
const named = clone(); named.inputs[0].input = "notes";
check(validate(schema, named, api).some((p) => p.includes("isn't one of")), "an input core doesn't name fails");
check(validate({ type: "string", minLength: 1 }, "x").some((p) => p.includes("doesn't know minLength")), "a keyword the validator doesn't know is refused, not skipped");
check(validate({ type: ["integer", "null"] }, 1.5).length === 1, "a fraction isn't an integer");

if (failed) { console.error(`${failed} schema-shape self-tests failed`); process.exit(1); }
console.log("schema-shape self-tests passed");
