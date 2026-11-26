// Fixture MCP server for mcp-core.test.ts: one tool with both per-tool options, one with none.
const core = (await import(process.env["MCP_CORE"] ?? new URL("../../src/mcp-core.ts", import.meta.url).href)) as typeof import("../../src/mcp-core.ts");

core.serveMcp({
  name: "fixture-visible",
  version: "1.0.0",
  tools: {
    open: { description: "model-visible with a schema", modelVisible: true, inputSchema: { type: "object", properties: { a: { type: "string" } }, required: ["a"] }, handler: () => ({}) },
    hidden: { description: "defaults", handler: () => ({}) },
  },
});
