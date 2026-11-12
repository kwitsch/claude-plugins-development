// The jev-api tool name jevfort needs, and whether a tool listing lacks it (built plugin/hooks/jev.mjs).
import assert from "node:assert/strict";
import { test } from "vitest";
import { JEV_BATCH, JEV_TOOL_PREFIX, JEV_TOOLS, missingJevTools } from "../plugin/hooks/jev.mjs";

test("the needed tool is jev-api's batch", () => {
  assert.equal(JEV_TOOL_PREFIX, "mcp__jev-api__");
  assert.equal(JEV_BATCH, "mcp__jev-api__batch");
  assert.deepEqual(JEV_TOOLS, [JEV_BATCH]);
});

test("nothing is missing when batch is listed", () => {
  assert.deepEqual(missingJevTools([JEV_BATCH]), []);
  assert.deepEqual(missingJevTools(["Bash", JEV_BATCH, "mcp__jevfort__estimate_effort"]), []);
});

test("jev-api 0.1's single-question tools alone are not enough", () => {
  assert.deepEqual(missingJevTools(["mcp__jev-api__noul", "mcp__jev-api__choice", "mcp__jev-api__score"]), [JEV_BATCH]);
});

test("an empty listing or a similar name misses batch", () => {
  assert.deepEqual(missingJevTools([]), [JEV_BATCH]);
  assert.deepEqual(missingJevTools(["mcp__other__batch", "batch", "mcp__jev-api__batches"]), [JEV_BATCH]);
});
