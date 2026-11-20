// Unit tests of jev-api's tool registration data (src/hooks/tools.ts): the schema names what the validator enforces.
import { describe, expect, it } from "vitest";
import { parseInput } from "../src/hooks/input.ts";
import { MAX_LEVELS, MAX_OPTIONS, MIN_LEVELS, SPEC } from "../src/hooks/tools.ts";
import { OVERFLOWS, TOOL, TYPES } from "../src/hooks/types.ts";
import { DEFAULT_TIMEOUT_S, MAX_TIMEOUT_S } from "../src/hooks/util.ts";

type Schema = { enum?: string[]; description?: string; items?: { properties: Record<string, Schema>; required: string[] } };
const props = SPEC.inputSchema.properties as Record<string, Schema>;
const question = props["questions"]?.items;

describe("SPEC", () => {
  it("offers every question type and describes the criteria of each with the validator's limits", () => {
    expect(question?.properties["type"]?.enum).toEqual([...TYPES]);
    const criteria = question?.properties["criteria"]?.description ?? "";
    for (const type of TYPES) expect(criteria).toContain(`${type}:`);
    expect(criteria).toContain(`1 to ${MAX_OPTIONS} option names`);
    expect(criteria).toContain(`${MIN_LEVELS} to ${MAX_LEVELS} levels`);
  });

  it("registers the tool by its bare name with every overflow mode and the timeout bounds", () => {
    expect(SPEC.name).toBe(TOOL);
    expect(SPEC.inputSchema.required).toEqual(["state", "questions"]);
    expect(props["overflow"]?.enum).toEqual([...OVERFLOWS]);
    expect(props["timeout"]?.description).toContain(`at most ${MAX_TIMEOUT_S}`);
    expect(props["timeout"]?.description).toContain(`else ${DEFAULT_TIMEOUT_S}`);
  });

  it("a call holding only what the schema requires, one per question type, passes the validator", () => {
    expect(question?.required).toEqual(["type", "instructions"]);
    const criteria: Record<string, unknown> = { noul: undefined, choice: { a: "first" }, score: ["low", "high"] };
    for (const type of TYPES) {
      const r = parseInput({ tool: `mcp__jev-api__${TOOL}`, state: "text", questions: [{ type, instructions: "Q", criteria: criteria[type] }] });
      expect(typeof r, `${type}: ${JSON.stringify(r)}`).toBe("object");
    }
  });
});
