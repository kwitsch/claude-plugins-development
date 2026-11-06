// The first-mod example of the docs: counts tool calls, /tally reports them.
import type { On } from "../../index.mts";

let count = 0;
export function register(on: On) {
  on("tool.call", (_$, e, next) => {
    count++;
    return next(e);
  });
  on("command.run", { command: "tally" }, () => ({ text: `Claude has made ${count} tool calls since this mod loaded` }));
}
