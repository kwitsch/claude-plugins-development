// Types of Claude Code's official mod test kit (exists only inside the `claude` binary, runs under `claude plugin test`).
// Its API is claude-engine-vitest's (exports verified with 2.1.329: describe, expect, mock, test, tier); declared as used.
declare module "claude-code/testing" {
  import type { createKit } from "claude-engine-vitest";
  type Kit = ReturnType<typeof createKit>;
  export const test: Kit["test"];
  export const mock: Kit["mock"];
  export const expect: typeof import("vitest").expect;
}
