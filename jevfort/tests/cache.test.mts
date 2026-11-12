// Cache countdown, auto-compact and Haiku compaction (ported from HeyCubit/effortless) of the built plugin/hooks/*.mjs.
// None of it needs jev-api: the kit tests list no tools.
import { createKit } from "claude-engine-vitest";
import { expect, test as pureTest } from "vitest";
import { CACHE_TTL, cacheColor, cacheLabel, cacheTtlOf, minutesLeft, nextTtl, shouldAutoCompact } from "../plugin/hooks/cache.mjs";
import { compactTranscript, haikuTranscript } from "../plugin/hooks/compact.mjs";

const DEFAULTS = { routing: "effort", compaction: true, haikuCompact: true, autoCompactPercent: 60 };
const { test, mock } = createKit({ module: new URL("../plugin/hooks/register.mjs", import.meta.url), plugin: "jevfort", options: DEFAULTS });

const usage1h = { input_tokens: 5, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 900, cache_creation: { ephemeral_1h_input_tokens: 900 } };

pureTest("cache lifetime: from the write, or 1h once a warm read after 5 minutes shows it", () => {
  expect(cacheTtlOf(usage1h)).toBe("1h");
  expect(cacheTtlOf({ cache_creation: { ephemeral_5m_input_tokens: 10 } })).toBe("5m");
  expect(cacheTtlOf(null)).toBeUndefined();
  const warm = { input_tokens: 10, cache_read_input_tokens: 900, cache_creation_input_tokens: 0 };
  expect(nextTtl(warm, "5m", CACHE_TTL["5m"] + 1)).toBe("1h");
  expect(nextTtl(warm, "5m", 1000)).toBe("5m");
  // A short 5-minute tail over a warm 1-hour read never lowers the lifetime.
  expect(nextTtl({ ...warm, cache_creation: { ephemeral_5m_input_tokens: 5 } }, "1h", 1000)).toBe("1h");
});

pureTest("countdown: minutes, label and colour", () => {
  expect(minutesLeft(0, 5)).toBeNull();
  expect(minutesLeft(1000, 2000)).toBe(0);
  expect(minutesLeft(61_000, 0)).toBe(2);
  expect(cacheLabel(0)).toBe("cache cold");
  expect(cacheLabel(1)).toBe("cache <1m");
  expect(cacheLabel(59)).toBe("cache 58m");
  expect(cacheColor(59)).toBeUndefined();
  expect(cacheColor(21)).toBe("yellow");
  expect(cacheColor(6)).toBe("red");
  expect(cacheColor(0)).toBe("cyan");
});

pureTest("auto-compact needs a cold cache, enough fill, a threshold above 0 and no earlier run this period", () => {
  expect(shouldAutoCompact(0, 60, 60, false)).toBe(true);
  expect(shouldAutoCompact(0, 59, 60, false)).toBe(false);
  expect(shouldAutoCompact(3, 90, 60, false)).toBe(false);
  expect(shouldAutoCompact(null, 90, 60, false)).toBe(false);
  expect(shouldAutoCompact(0, 90, 0, false)).toBe(false);
  expect(shouldAutoCompact(0, 90, 60, true)).toBe(false);
});

pureTest("the Haiku transcript keeps the tail whole and cuts old tool results", () => {
  const long = "x".repeat(5000);
  const messages = [
    { role: "user" as const, text: "go", toolUses: [] },
    { role: "assistant" as const, text: "", toolUses: [{ tool_use_id: "a", tool: "Bash", input: { command: "ls" }, text: long }] },
    ...Array.from({ length: 6 }, () => ({ role: "user" as const, text: "more", toolUses: [] })),
  ];
  const t = compactTranscript(messages);
  expect(t).toContain("[Bash");
  expect(t).toContain("3000 more characters");
  expect(haikuTranscript(messages)).toBeDefined();
});

/** A session with a long enough transcript, no jev-api tools and a Haiku that answers `text`. */
function haikuSetup(on: Parameters<typeof mock.clock>[0], text: string | undefined) {
  mock.store(on, {});
  mock.clock(on);
  on("session.cwd", () => ({ value: "/proj" }));
  on("ui.status", () => ({ value: undefined }));
  on("tool.list", () => ({ value: [] }));
  const asked: string[] = [];
  on("model.complete", (_$, e) => {
    asked.push(`${String(e.model)}|${String(e.prompt)}`);
    return { value: text === undefined ? { isAnswered: false, reason: "down" } : { isAnswered: true, text, usage: { input_tokens: 1, output_tokens: 1 } } };
  });
  return asked;
}

const MESSAGES = [{ role: "user", text: "fix the date bug", toolUses: [] }, { role: "assistant", text: "on it", toolUses: [] }];

test("session.compact is written by Haiku, with the user's note, without jev-api", async ($, on) => {
  const asked = haikuSetup(on, "S".repeat(300));
  const r = (await $.session.compact({ trigger: "manual", messages: MESSAGES, instructions: "keep the paths" })) as { messages: { text: string }[] };
  expect(asked).toHaveLength(1);
  expect(asked[0]).toContain("claude-haiku-5-5|");
  expect(asked[0]).toContain("keep the paths");
  expect(r.messages[0].text).toContain("S".repeat(300));
});

test("session.compact falls through to Claude Code when Haiku fails", async ($, on) => {
  haikuSetup(on, undefined);
  let beneath = 0;
  on("session.compact", () => {
    beneath++;
    return { skip: "test" };
  });
  await $.session.compact({ trigger: "auto", messages: MESSAGES });
  expect(beneath).toBe(1);
});

test("a precompute is skipped while Haiku compacts", async ($, on) => {
  const asked = haikuSetup(on, "S".repeat(300));
  const r = (await $.session.compact({ trigger: "precompute", messages: MESSAGES })) as { skip?: string };
  expect(r.skip).toBeDefined();
  expect(asked).toHaveLength(0);
});

test("haikuCompact off leaves the summary to Claude Code", { options: { haikuCompact: false } }, async ($, on) => {
  const asked = haikuSetup(on, "S".repeat(300));
  on("session.compact", () => ({ skip: "test" }));
  await $.session.compact({ trigger: "manual", messages: MESSAGES });
  expect(asked).toHaveLength(0);
});

/** Runs one main-loop response with usage, so the cache countdown starts. */
async function respond($: Parameters<Parameters<typeof test>[2]>[0]) {
  const stream = $.turn.step({ turnId: "t1", index: 0, model: "claude-opus-5-5", effort: "high", messageCount: 1 });
  while (!(await stream.next()).done);
  await $.turn.complete({ turnId: "t1", reason: "answer", answer: "ok", durationMs: 1 });
}

for (const [percent, option, runs] of [[70, 60, 1], [50, 60, 0], [90, 0, 0]] as const) {
  test(`auto-compact at ${percent}% with autoCompactPercent ${option} runs /compact ${runs}x once the cache is cold`, { options: { autoCompactPercent: option } }, async ($, on) => {
    mock.store(on, {});
    const clock = mock.clock(on);
    on("session.cwd", () => ({ value: "/proj" }));
    on("ui.status", () => ({ value: undefined }));
    on("tool.list", () => ({ value: [] }));
    on("command.register", () => ({ value: undefined }));
    on("session.start", async () => ({}));
    on("turn.complete", async () => ({}));
    on("turn.step", async function*(_$, e) {
      yield { kind: "stop", stopReason: "end_turn", usage: usage1h };
      return { turnId: e.turnId, index: e.index, answer: "ok", toolUses: [], stopReason: "end_turn", usage: usage1h };
    });
    on("session.usage", () => ({ value: { context: { tokens: 1, window: 100, percent } } }));
    let compacts = 0;
    on("command.run", (_$, e, next) => {
      if (e.command !== "compact") return next(e);
      compacts++;
      return { value: undefined };
    });
    await $.session.start({ cwd: "/proj", surface: "terminal", isInteractive: true });
    await respond($);
    // Warm for an hour: nothing yet.
    await clock.advance(CACHE_TTL["1h"] - 60_000);
    expect(compacts).toBe(0);
    // Cold: one run, never a second one for the same cold period.
    await clock.advance(120_000);
    await clock.advance(60_000);
    expect(compacts).toBe(runs);
  });
}
