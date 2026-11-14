// The built notice module on claude-engine-vitest: a toast only when no graphmind binary exists.
import { createKit } from "claude-engine-vitest";
import { expect } from "vitest";

const { test, mock } = createKit({ module: new URL("../plugin/hooks/notice.mjs", import.meta.url), plugin: "graphmind-helper" });

/**
 * Stubs the engine calls of the module.
 *
 * @param on - The test's `on`.
 * @param existing - Paths `fs.exists` reports as present.
 * @returns The toasts shown.
 */
function stubs(on: Parameters<typeof mock.clock>[0], existing: string[]) {
  const toasts: string[] = [];
  on("env.get", (_$, e) => ({ value: e.name === "HOME" ? "/home/u" : e.name === "PATH" ? "/p1:/p2" : undefined }));
  on("fs.exists", (_$, e) => ({ value: existing.includes(String(e.path)) }));
  on("ui.toast", (_$, e) => {
    toasts.push(String(e.text));
    return { value: undefined };
  });
  on("session.start", async () => ({}));
  return { toasts, clock: mock.clock(on) };
}

test("session start toasts when no graphmind binary exists", async ($, on) => {
  const { toasts, clock } = stubs(on, []);
  await $.session.start({ source: "startup" });
  await clock.settle();
  expect(toasts).toHaveLength(1);
  expect(toasts[0]).toMatch(/graphmind binary was not found/);
});

test("session start stays quiet when the binary is on PATH or in ~/.local/bin", async ($, on) => {
  const { toasts, clock } = stubs(on, ["/p2/graphmind"]);
  await $.session.start({ source: "startup" });
  await clock.settle();
  expect(toasts).toHaveLength(0);
});

test("session start stays quiet with the binary in ~/.local/bin", async ($, on) => {
  const { toasts, clock } = stubs(on, ["/home/u/.local/bin/graphmind"]);
  await $.session.start({ source: "startup" });
  await clock.settle();
  expect(toasts).toHaveLength(0);
});
