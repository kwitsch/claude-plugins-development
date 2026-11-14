// The kit's own rules: stubs before $, unanswered calls, skipped hooks and the engine report, origins, inline plugins.
import { expect, test as vitest } from "vitest";
import { createKit } from "../index.mts";

const { test } = createKit({ module: new URL("./mods/probe.mts", import.meta.url), plugin: "probe", options: { a: 1, b: 1 } });
/** The `text` of a command.run result. */
const text = async (p: Promise<unknown>) => ((await p) as { text: string }).text;

test("the test's own $ is engine-origin, and register gets the kit options under the test's", { options: { b: 2 } }, async ($) => {
  expect(JSON.parse(await text($.command.run({ command: "origin" })))).toEqual({ plugin: "engine", tier: "core" });
  expect(JSON.parse(await text($.command.run({ command: "options" })))).toEqual({ a: 1, b: 2 });
});

test("a stub registered after the first call on $ throws", async ($, on) => {
  await $.command.run({ command: "origin" });
  expect(() => on("tool.call", () => ({ result: "late" }))).toThrow("on(\"tool.call\") after the test first called $");
});

test("a mods API call no stub answers rejects with no implementation", async ($, on) => {
  on("store.get", (_$, e, next) => next(e));
  expect(await text($.command.run({ command: "store" }))).toBe("rejected: no implementation for store.get");
});

test("a { deny } makes the call reject with its reason, a { value } resolve to it", async ($, on) => {
  let deny = true;
  on("store.get", () => (deny ? { deny: "kept away" } : { value: 7 }));
  expect(await text($.command.run({ command: "store" }))).toBe("rejected: kept away");
  deny = false;
  expect(await text($.command.run({ command: "store" }))).toBe("7");
});

test("a throwing stub's .catch handler answers in its place", async ($, on) => {
  on("store.get", () => {
    throw new Error("stub broke");
  }).catch(() => ({ value: 9 }));
  expect(await text($.command.run({ command: "store" }))).toBe("9");
});

test("a hook whose call rejects unhandled is skipped, so the event reaches the bottom", async ($) => {
  await expect($.command.run({ command: "unhandled" })).rejects.toThrow("no implementation for command.run");
});

test("a throwing hook is skipped and the chain goes on beneath it", async ($, on) => {
  on("tool.call", () => ({ result: "stub" }));
  expect(await $.tool.call({ tool: "Bash", command: "ls" })).toEqual({ result: "stub" });
});

vitest("a failing test lists the skipped hooks under the engine reported", async () => {
  let body: (() => Promise<void>) | undefined;
  // Capture the wrapped body instead of registering a nested vitest test.
  const { test: capture } = createKit({ module: new URL("./mods/probe.mts", import.meta.url), plugin: "probe", runner: (_name, _opts, fn) => (body = fn) });
  capture("x", async ($, on) => {
    on("tool.call", () => ({ result: "stub" }));
    await $.tool.call({ tool: "Bash" });
    expect(1).toBe(2);
  });
  if (!body) throw new Error("runner not called");
  await expect(body()).rejects.toThrow(/the engine reported:\n {2}in probe's tool\.call hook: probe broke/);
});

test("a mods API call fires through the hooks of the plugins above the caller, then the stubs", {
  plugins: [{
    name: "closer",
    register(on) {
      on("command.run", { command: "close" }, async ($) => ({ text: await $.ui.close({ id: "p" }) }));
    },
  }],
}, async ($, on) => {
  on("ui.close", () => ({ value: "closed" }));
  expect(await text($.command.run({ command: "close" }))).toBe("probe saw {\"value\":\"closed\"} from p");
});

/** The next.signal each hook of the abandonment test saw. */
const seen: { above?: AbortSignal; below?: AbortSignal } = {};
test("a hook that settles before its next abandons the rest of the chain: next.signal aborts beneath it only", {
  plugins: [{
    name: "above",
    tier: "prepend",
    register(on) {
      on("prompt.submit", (_$, e, next) => (seen.above = next.signal, void Promise.resolve(next(e)).catch(() => {}), {}));
    },
  }],
}, async ($, on) => {
  let release = () => {};
  on("prompt.submit", (_$, _e, next) => (seen.below = next.signal, new Promise((r) => (release = () => r({})))));
  expect(await $.prompt.submit({ text: "x" })).toEqual({});
  expect(seen.above?.aborted).toBe(false);
  expect(seen.below?.aborted).toBe(true);
  release();
});


test("the test's $ cannot fire a mods API call", ($) => {
  expect(() => $.ui.close({ id: "p" })).toThrow(/mods API call/);
});
