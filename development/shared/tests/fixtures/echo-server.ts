// Fixture MCP server for mcp-core.test.ts: three tools on top of serveMcp. `MCP_CORE` names the module to load (a mutated copy in the mutation check).
const core = (await import(process.env["MCP_CORE"] ?? new URL("../../src/mcp-core.ts", import.meta.url).href)) as typeof import("../../src/mcp-core.ts");

core.serveMcp({
  name: "fixture-hooks",
  version: "9.8.7",
  tools: {
    echo: { description: "returns its arguments", handler: (args: Record<string, unknown>) => ({ echo: args }) },
    boom: {
      description: "throws",
      handler: () => {
        throw new Error("kaput");
      },
    },
    // a result JSON.stringify cannot serialize: the loop itself throws after the handler returned
    bigint: { description: "returns a BigInt", handler: () => ({ n: 1n }) },
    // answers at once but keeps listening on its signal: a cancel for the finished call must not reach it
    watch: {
      description: "answers at once, logs a later abort",
      handler: (_args: never, signal: AbortSignal) => {
        signal.addEventListener("abort", () => process.stderr.write("fixture: watch saw late abort\n"), { once: true });
        return { done: true };
      },
    },
    slow: {
      description: "waits for its abort signal",
      handler: (_args: never, signal: AbortSignal) =>
        new Promise<Record<string, unknown>>((resolve) => {
          signal.addEventListener("abort", () => {
            process.stderr.write("fixture: slow saw abort\n");
            resolve({ late: true });
          }, { once: true });
        }),
    },
  },
  onClose: () => process.stderr.write("fixture: closed\n"),
});
