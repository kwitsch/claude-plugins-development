// The jev-api tool names jevfort needs, and which of them a tool listing lacks (built plugin/hooks/jev.mjs).
import assert from "node:assert/strict";
import { test } from "vitest";
import { JEV_TOOL_PREFIX, JEV_TOOLS, missingJevTools } from "../plugin/hooks/jev.mjs";

const ALL = ["mcp__jev-api__noul", "mcp__jev-api__choice", "mcp__jev-api__score"];

test("the needed tools are jev-api's noul, choice and score", () => {
  assert.equal(JEV_TOOL_PREFIX, "mcp__jev-api__");
  assert.deepEqual(JEV_TOOLS, ALL);
});

test("nothing is missing when all three tools are listed", () => {
  assert.deepEqual(missingJevTools(ALL), []);
  assert.deepEqual(missingJevTools([...ALL].reverse()), []);
});

test("a tool that is not listed is reported by its full name", () => {
  assert.deepEqual(missingJevTools(["mcp__jev-api__noul", "mcp__jev-api__choice"]), ["mcp__jev-api__score"]);
});

test("an empty listing misses all three", () => {
  assert.deepEqual(missingJevTools([]), ALL);
});

test("unrelated tools are ignored, also ones with a similar name", () => {
  assert.deepEqual(missingJevTools([...ALL, "Bash", "mcp__jevfort__estimate_effort"]), []);
  assert.deepEqual(missingJevTools(["mcp__other__noul", "noul", "mcp__jev-api__scores"]), ALL);
});
