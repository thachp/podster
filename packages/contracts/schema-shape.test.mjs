// The schema-shape guard and the validator, checked on inputs of their own, so "no problems" in check.mjs means something.
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { schemaShapeProblems, validate } from "./schema-shape.mjs";

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
