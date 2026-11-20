// Runs under `claude plugin test` via development/scripts/plugin-test.ts (`pnpm --filter dprint test:plugin`), on a temp
// copy of the built plugin/. Imports the engine's own kit, not vitest (development/wiki/decisions/test-layers.md).
// Together the tests fire all 4 registrations of the built register.js: session.start, classic.CwdChanged and
// tool.call for EnterWorktree and for ExitWorktree. No imports besides the kit and no node:fs: the fake world is in memory.
import { expect, mock, test } from "claude-code/testing";

/** The test's `on`, taken from the kit's own types. */
type On = Parameters<typeof mock.clock>[0];

/** Directories of the fake world; each is a repository root (`.git`) with a dprint config. */
const DIRS = ["/proj", "/other", "/wt", "/back"];
/** The one dprint on the fake PATH; it exists but cannot start. */
const DPRINT = "/p1/dprint";

/**
 * The toast the module shows for a directory whose dprint cannot start.
 *
 * @param dir - The directory.
 * @returns The toast text.
 */
const toast = (dir: string): string => `dprint: ${dir} (or a parent up to the git root) has a dprint config but ${DPRINT} could not start or took over 10 s to answer --version; run /dprint:dprint init`;

/**
 * Stubs every engine call of the module. One call per test, before the first `$` call.
 *
 * @param on - The test's `on`.
 * @returns The toasts shown and the fake clock.
 */
function world(on: On) {
  const toasts: string[] = [];
  const present = new Set(["/home/u", DPRINT, ...DIRS.flatMap((d) => [`${d}/.git`, `${d}/dprint.json`])]);
  const clock = mock.clock(on);
  on("fs.exists", (_$, e) => ({ value: present.has(String(e.path)) }));
  on("session.cwd", () => ({ value: "/proj" }));
  on("env.get", (_$, e) => ({ value: e.name === "HOME" ? "/home/u" : e.name === "PATH" ? "/p1" : undefined }));
  // a deny rejects the mod's $.process.run: stands for "the program cannot start"
  on("process.run", () => ({ deny: "spawn ENOENT" }));
  on("ui.toast", (_$, e) => {
    toasts.push(String(e.text));
    return { value: undefined };
  });
  on("session.start", async () => ({ cwd: "/proj" }));
  on("classic.CwdChanged", async () => ({}));
  on("tool.call", (_$, e) => ({ result: e.tool === "ExitWorktree" ? { worktreePath: "/wt", restoredCwd: "/back" } : e.tool === "EnterWorktree" ? { worktreePath: "/wt" } : "tool output" }));
  return { toasts, clock };
}

test("the built mod loads and toasts for the session's directory (session.start)", async ($, on) => {
  const { toasts, clock } = world(on);
  await $.session.start({ source: "startup", cwd: "/proj" });
  await clock.settle();
  expect(toasts).toEqual([toast("/proj")]);
});

test("a changed working directory is checked (classic.CwdChanged)", async ($, on) => {
  const { toasts, clock } = world(on);
  await $.classic.CwdChanged({ new_cwd: "/other" });
  await clock.settle();
  expect(toasts).toEqual([toast("/other")]);
});

test("EnterWorktree checks the worktree its result names (tool.call { tool: EnterWorktree })", async ($, on) => {
  const { toasts, clock } = world(on);
  await $.tool.call({ tool: "EnterWorktree" });
  await clock.settle();
  expect(toasts).toEqual([toast("/wt")]);
});

test("ExitWorktree checks the directory it restored, not the worktree it left (tool.call { tool: ExitWorktree })", async ($, on) => {
  const { toasts, clock } = world(on);
  await $.tool.call({ tool: "ExitWorktree" });
  await clock.settle();
  expect(toasts).toEqual([toast("/back")]);
});

test("another tool call passes through the built mod without a check", async ($, on) => {
  const { toasts, clock } = world(on);
  expect(JSON.stringify(await $.tool.call({ tool: "Bash", command: "ls" }))).toContain("tool output");
  await clock.settle();
  expect(toasts).toEqual([]);
});
