// The jev-api tool jevfort needs (`mcp__jev-api__batch`), through the built plugin/hooks/register.mjs: a listing that
// has it lets `estimate_effort` ask Jev, a listing that lacks it answers the default effort without asking.
import { expect } from "vitest";
import { byId, DEFAULTS, makeKit, mech, type Runner, scored } from "./support/kit.ts";

const { test, setup } = makeKit(DEFAULTS);
const BATCH = "mcp__jev-api__batch";
const jev = (name: string) => ({ name, description: name, mcp: true });

/**
 * Calls the estimate tool once.
 *
 * @param $ - The test's `$`.
 * @returns The effort and its source.
 */
async function estimate($: Runner) {
  const res = (await $.tool.call({ tool: "mcp__jevfort__estimate_effort", model: "opus", defaultEffort: "high", minEffort: "low", maxEffort: "xhigh", prompt: "add a retry" })) as { result?: string };
  return JSON.parse(res.result ?? "null") as { effort: string; source: string };
}

test("the needed tool is jev-api's batch: a listing with it lets the estimate ask Jev", async ($, on) => {
  const { sent } = setup(on, { messages: [], jev: byId({ effort: scored(1.6), mechanical: mech(0.1) }), tools: [jev(BATCH)] });
  expect(await estimate($)).toEqual({ effort: "medium", source: "jev" });
  expect(sent.map((q) => q.id)).toEqual(["effort", "mechanical"]);
});

test("nothing is missing when batch is listed among other tools", async ($, on) => {
  setup(on, { messages: [], jev: byId({ effort: scored(1.6), mechanical: mech(0.1) }), tools: [jev("Bash"), jev(BATCH), jev("mcp__jevfort__estimate_effort")] });
  expect(await estimate($)).toEqual({ effort: "medium", source: "jev" });
});

test("jev-api 0.1's single-question tools alone are not enough: the estimate falls back", async ($, on) => {
  const { sent } = setup(on, { messages: [], jev: byId({ effort: scored(1.6), mechanical: mech(0.1) }), tools: ["noul", "choice", "score"].map((t) => jev(`mcp__jev-api__${t}`)) });
  expect(await estimate($)).toEqual({ effort: "high", source: "fallback" });
  expect(sent).toHaveLength(0);
});

test("an empty listing misses batch", async ($, on) => {
  const { sent } = setup(on, { messages: [], jev: byId({ effort: scored(1.6), mechanical: mech(0.1) }), tools: [] });
  expect(await estimate($)).toEqual({ effort: "high", source: "fallback" });
  expect(sent).toHaveLength(0);
});

test("a similar name misses batch", async ($, on) => {
  const { sent } = setup(on, { messages: [], jev: byId({ effort: scored(1.6), mechanical: mech(0.1) }), tools: ["mcp__other__batch", "batch", "mcp__jev-api__batches"].map(jev) });
  expect(await estimate($)).toEqual({ effort: "high", source: "fallback" });
  expect(sent).toHaveLength(0);
});
