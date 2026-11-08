import { describe, expect, it } from "vitest";
import { CAPABILITIES, jsonSchema, toApiCall } from "../src/capabilities";

// Expected outputs as agent capabilities (M2 step 7). Defining, renaming and removing outputs are for people only.

describe("expected outputs, as capabilities", () => {
  const capability = (name: string) => CAPABILITIES.find((c) => c.name === name)!;

  it("offers no capability to define, rename or remove an output", () => {
    for (const c of CAPABILITIES) expect(c.path.includes("/outputs") && c.method !== "GET", c.name).toBe(false);
  });

  it("list_outputs reads the room's outputs and nothing else", () => {
    expect(toApiCall(capability("list_outputs"), { workspace_id: "w", extra: "x" })).toEqual({ method: "GET", path: "/v1/workspaces/w/outputs" });
  });

  it("set_task_output requires output_id, which may be null to clear it", () => {
    const schema = jsonSchema(capability("set_task_output")) as any;
    expect(schema.required).toEqual(expect.arrayContaining(["workspace_id", "task_id", "output_id", "idempotency_key"]));
    const allowed = JSON.stringify(schema.properties.output_id);
    expect(allowed).toContain('"string"');
    expect(allowed).toContain('"null"');
    const set = toApiCall(capability("set_task_output"), { workspace_id: "w", task_id: "t", output_id: "out_1", version: 3, idempotency_key: "k" });
    expect(set).toMatchObject({ method: "PUT", path: "/v1/workspaces/w/tasks/t/expected-output", idempotencyKey: "k" });
    expect(JSON.parse(set.body!)).toEqual({ output_id: "out_1" });
    const cleared = toApiCall(capability("set_task_output"), { workspace_id: "w", task_id: "t", output_id: null, idempotency_key: "k" });
    expect(JSON.parse(cleared.body!)).toEqual({ output_id: null });
  });

  it("create_task passes expected_output_id on", () => {
    const call = toApiCall(capability("create_task"), { workspace_id: "w", title: "T", instructions: "I", expected_output_id: "out_1", idempotency_key: "k" });
    expect(JSON.parse(call.body!)).toEqual({ title: "T", instructions: "I", expected_output_id: "out_1" });
  });
});
