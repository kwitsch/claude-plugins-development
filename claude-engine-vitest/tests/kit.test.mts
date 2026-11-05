// The kit's own rules: stubs before $, unanswered calls, skipped hooks and the engine report, origins, inline plugins.
import { expect, test as vitest } from "vitest";
import { createKit } from "../index.mts";

const { test } = createKit({ module: new URL("./mods/probe.mts", import.meta.url), plugin: "probe", options: { a: 1, b: 1 } });

test("the test's own $ is engine-origin, and register gets the kit options under the test's", { options: { b: 2 } }, async ($) => {
  expect(JSON.parse((await $.command.run({ command: "origin" })).text)).toEqual({ plugin: "engine", tier: "core" });
  expect(JSON.parse((await $.command.run({ command: "options" })).text)).toEqual({ a: 1, b: 2 });
});

test("a stub registered after the first call on $ throws", async ($, on) => {
  await $.command.run({ command: "origin" });
  expect(() => on("tool.call", () => ({ result: "late" }))).toThrow("on(\"tool.call\") after the test first called $");
});

test("a mods API call no stub answers rejects with no implementation", async ($, on) => {
  on("store.get", (_$, e, next) => next(e));
  expect((await $.command.run({ command: "store" })).text).toBe("rejected: no implementation for store.get");
});

test("a { deny } makes the call reject with its reason, a { value } resolve to it", async ($, on) => {
  let deny = true;
  on("store.get", () => (deny ? { deny: "kept away" } : { value: 7 }));
  expect((await $.command.run({ command: "store" })).text).toBe("rejected: kept away");
  deny = false;
  expect((await $.command.run({ command: "store" })).text).toBe("7");
});

test("a hook whose call rejects unhandled is skipped, so the event reaches the bottom", async ($) => {
  await expect($.command.run({ command: "unhandled" })).rejects.toThrow("no implementation for command.run");
});

test("a throwing hook is skipped and the chain goes on beneath it", async ($, on) => {
  on("tool.call", () => ({ result: "stub" }));
  expect(await $.tool.call({ tool: "Bash", command: "ls" })).toEqual({ result: "stub" });
});

vitest("a failing test lists the skipped hooks under the engine reported", async () => {
  let body;
  // Capture the wrapped body instead of registering a nested vitest test.
  const { test: capture } = createKit({ module: new URL("./mods/probe.mts", import.meta.url), plugin: "probe", runner: (_name, _opts, fn) => (body = fn) });
  capture("x", async ($, on) => {
    on("tool.call", () => ({ result: "stub" }));
    await $.tool.call({ tool: "Bash" });
    expect(1).toBe(2);
  });
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
  expect((await $.command.run({ command: "close" })).text).toBe("probe saw {\"value\":\"closed\"} from p");
});

test("the test's $ cannot fire a mods API call", async ($) => {
  expect(() => $.ui.close({ id: "p" })).toThrow(/mods API call/);
});
