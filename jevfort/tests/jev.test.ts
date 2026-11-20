// The jev-api tool jevfort needs (`mcp__jev-api__request`), through src/hooks/register.ts: a listing that
// has it lets step 0 ask Jev for the effort, a listing that lacks it leaves the session effort without asking.
import { expect } from "vitest";
import { JEV_REQUEST } from "../src/hooks/jev.ts";
import { byId, claudeBeneath, DEFAULTS, drain, ids, makeKit, mech, type Runner, scored, SINGLE_TOOLS, step, user } from "./support/kit.ts";

const { test, setup } = makeKit(DEFAULTS);
const jev = (name: string) => ({ name, description: name, mcp: true });

/**
 * Runs one step 0 of "add a retry" (Jev scores it 1.6: medium) with this tool listing.
 *
 * @param $ - The test's `$`.
 * @param on - The test's `on`.
 * @param tools - The full tool names the listing holds.
 * @returns The questions Jev got, how many request calls jevfort made (the fake denies a call at an unlisted tool and records no question) and the effort the step reached Claude with.
 */
async function stepWith($: Runner, on: Parameters<typeof setup>[0], tools: readonly string[]) {
  const { sent, calls } = setup(on, { messages: [user("add a retry")], jev: byId({ effort: scored(1.6), mechanical: mech(0.1) }), tools: tools.map(jev) });
  const seen: { effort?: string }[] = [];
  claudeBeneath(on, seen);
  await drain($.turn.step(step));
  return { sent, calls, effort: seen[0]?.effort };
}

test("the needed tool is jev-api's request: a listing with it lets step 0 ask Jev", async ($, on) => {
  const { sent, effort } = await stepWith($, on, [JEV_REQUEST]);
  expect(ids(sent)).toEqual(["effort", "mechanical"]);
  expect(effort).toBe("medium");
});

test("nothing is missing when request is listed among other tools", async ($, on) => {
  expect((await stepWith($, on, ["Bash", JEV_REQUEST])).effort).toBe("medium");
});

for (
  const [name, tools] of [
    ["the removed single-question tools alone are not enough: Jev is missing", SINGLE_TOOLS.map((t) => t.name)],
    ["jev-api 0.6's batch alone is not enough: Jev is missing", ["mcp__jev-api__batch"]],
    ["an empty listing misses request", []],
    ["a similar name misses request", ["mcp__other__request", "request", "mcp__jev-api__requests"]],
  ] as const
) {
  test(name, async ($, on) => {
    const { calls, effort } = await stepWith($, on, tools);
    expect(calls()).toBe(0);
    expect(effort).toBe("high");
  });
}

// A hook that consults jevMissing: the scratchpad allow is only given while jev-api's request is listed.
const SCRATCH = "/tmp/claude-1000/-proj/sid-1/scratchpad/x.md";
async function writeDecision($: Runner, on: Parameters<typeof setup>[0], tools: string[]) {
  setup(on, { messages: [], jev: () => undefined, tools: tools.map(jev) });
  on("tool.check", () => ({ decision: "ask" }));
  return ((await $.tool.check({ tool: "Write", input: { file_path: SCRATCH }, tool_use_id: "toolu_jm" })) as { decision: string }).decision;
}

test("jevMissing: with request listed the scratchpad write is allowed", async ($, on) => {
  expect(await writeDecision($, on, [JEV_REQUEST])).toBe("allow");
});

for (const tools of [[], SINGLE_TOOLS.map((t) => t.name), ["mcp__jev-api__batch"], ["mcp__other__request", "request", "mcp__jev-api__requests"]]) {
  test(`jevMissing: the scratchpad write stays ask with [${tools.join(", ")}]`, async ($, on) => {
    expect(await writeDecision($, on, tools)).toBe("ask");
  });
}
