// The first-mod example of the docs: counts tool calls, /tally reports them.
let count = 0;
export function register(on) {
  on("tool.call", async ($, e, next) => {
    count++;
    return next(e);
  });
  on("command.run", { command: "tally" }, async () => ({ text: `Claude has made ${count} tool calls since this mod loaded` }));
}
