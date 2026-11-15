// Cache countdown, auto-compact and Haiku compaction (ported from HeyCubit/effortless) of the built plugin/hooks/*.mjs.
// None of it needs jev-api: the kit tests list no tools.
import { createKit } from "claude-engine-vitest";
import { expect } from "vitest";

/** Options passed to the kit: effort routing, compaction and Haiku compaction on, auto-compact at 60%. */
const DEFAULTS = { routing: true, compaction: true, haikuCompact: true, autoCompactPercent: 60 };
/** Test kit bound to the built `plugin/hooks/register.mjs`. */
const { test, mock } = createKit({ module: new URL("../plugin/hooks/register.mjs", import.meta.url), plugin: "jevfort", options: DEFAULTS });

/** The cache lifetimes the countdown assumes (ms): 5 minutes and 1 hour. */
const CACHE_TTL = { "5m": 5 * 60_000, "1h": 60 * 60_000 } as const;
/** The output cap of a Haiku compaction summary (tokens). */
const COMPACT_MAX_TOKENS = 16_000;

/** Usage of one main-loop step that writes 900 tokens to the one-hour cache. */
const usage1h = { input_tokens: 5, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 900, cache_creation: { ephemeral_1h_input_tokens: 900 } };
/** What `$.session.start` gets. */
const START = { cwd: "/proj", surface: "terminal", isInteractive: true };
/** The band above the prompt as the terminal raises it (`ui.render`, component `AbovePrompt`). */
const BAND = { plugin: "jevfort", component: "AbovePrompt", props: { hasSurvey: false, isCollapsed: false, isWorking: false, maxRows: 10, bodyColumns: 80 }, surface: "terminal" };
/** What a hook beneath jevfort draws in the band. */
const BENEATH = { type: "Text", props: {}, children: ["beneath"] };
/** The band's countdown text (` cache 59m`), or `undefined` when it shows none. */
const label = async (ui: { find(q: { type: string; text: RegExp }): Promise<{ children: unknown[] } | undefined> }) => (await ui.find({ type: "Text", text: /cache/ }))?.children[0];

/** A 5-minute cache write: the usage names the 5-minute lifetime. */
const usage5m = { input_tokens: 5, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 900, cache_creation: { ephemeral_5m_input_tokens: 900 } };
/** A warm read of 900 tokens with no write: the cache was still there. */
const warmRead = { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 900, cache_creation_input_tokens: 0 };
/** Usage as Claude Code 2.1.322 reports it: four counts and the model, no `cache_creation` detail. */
const cold = { input_tokens: 5, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 90_000, model: "claude-opus-5-5" };

test("the band words: 1 minute left reads <1m, 2 read 1m, 59 read 58m, none is cold", async () => {
  const { cacheLabel } = await import("../plugin/hooks/lib.mjs");
  expect(cacheLabel(1)).toBe("cache <1m");
  expect(cacheLabel(2)).toBe("cache 1m");
  expect(cacheLabel(59)).toBe("cache 58m");
  expect(cacheLabel(0)).toBe("cache cold");
});

test("a 1-hour cache write starts a 59-minute countdown", async ($, on) => {
  on("ui.render", () => BENEATH);
  const { clock } = chatSetup(on, 10);
  await $.session.start(START);
  const ui = await $.ui.mount(BAND);
  await respond($);
  await clock.settle();
  expect(await label(ui)).toBe(" cache 59m");
  await ui.unmount();
});

test("a 5-minute cache write starts a countdown of about 5 minutes", async ($, on) => {
  on("ui.render", () => BENEATH);
  const { clock, state } = chatSetup(on, 10);
  state.usage = usage5m;
  await $.session.start(START);
  const ui = await $.ui.mount(BAND);
  await respond($);
  await clock.settle();
  expect(await label(ui)).toMatch(/^ cache [45]m$/);
  await ui.unmount();
});

test("a warm read after the 5-minute lifetime shows the 1-hour lifetime", async ($, on) => {
  on("ui.render", () => BENEATH);
  const { clock, state } = chatSetup(on, 10);
  state.usage = usage5m;
  await $.session.start(START);
  const ui = await $.ui.mount(BAND);
  await respond($);
  await clock.advance(CACHE_TTL["5m"] + 1_000);
  state.usage = warmRead;
  await respond($);
  await clock.settle();
  expect(await label(ui)).toBe(" cache 59m");
  await ui.unmount();
});

test("a 5-minute write over a warm 1-hour read keeps the 1-hour lifetime", async ($, on) => {
  on("ui.render", () => BENEATH);
  const { clock, state } = chatSetup(on, 10);
  await $.session.start(START);
  const ui = await $.ui.mount(BAND);
  await respond($);
  await clock.advance(6 * 60_000);
  state.usage = { ...warmRead, cache_creation: { ephemeral_5m_input_tokens: 5 } };
  await respond($);
  await clock.settle();
  expect(await label(ui)).toBe(" cache 59m");
  await ui.unmount();
});

/** A main-loop response with `read` tokens from the cache and `input` uncached, no write detail. */
const readShare = (read: number, input: number) => ({ input_tokens: input, output_tokens: 5, cache_read_input_tokens: read, cache_creation_input_tokens: 0 });

for (const [gap, expected] of [[4, /^ cache [45]m$/], [6, /^ cache 59m$/]] as const) {
  test(`a warm read ${gap} minutes after a 5-minute write keeps a countdown of ${expected.source.includes("59") ? "1 hour" : "5 minutes"}`, async ($, on) => {
    on("ui.render", () => BENEATH);
    const { clock, state } = chatSetup(on, 10);
    state.usage = usage5m;
    await $.session.start(START);
    const ui = await $.ui.mount(BAND);
    await respond($);
    await clock.advance(gap * 60_000);
    state.usage = warmRead;
    await respond($);
    await clock.settle();
    expect(await label(ui)).toMatch(expected);
    await ui.unmount();
  });
}

for (const [read, input, expected] of [[50, 50, /^ cache [45]m$/], [51, 49, /^ cache 59m$/]] as const) {
  test(`a warm read of ${read} of ${read + input} prompt tokens after a 5-minute write ${expected.source.includes("59") ? "is mostly cached" : "is not mostly cached"}`, async ($, on) => {
    on("ui.render", () => BENEATH);
    const { clock, state } = chatSetup(on, 10);
    state.usage = usage5m;
    await $.session.start(START);
    const ui = await $.ui.mount(BAND);
    await respond($);
    await clock.advance(6 * 60_000);
    state.usage = readShare(read, input);
    await respond($);
    await clock.settle();
    expect(await label(ui)).toMatch(expected);
    await ui.unmount();
  });
}

test("the countdown turns yellow at 21 minutes left, red at 6, and cyan once cold", async ($, on) => {
  on("ui.render", () => BENEATH);
  const { clock } = chatSetup(on, 10);
  await $.session.start(START);
  const ui = await $.ui.mount(BAND);
  await respond($);
  await clock.settle();
  const colour = async () => (await ui.find({ type: "Text", text: /cache/ }))?.props.color;
  expect(await colour()).toBeUndefined();
  await clock.advance(39 * 60_000);
  expect(await colour()).toBe("yellow");
  await clock.advance(15 * 60_000);
  expect(await colour()).toBe("red");
  await clock.advance(6 * 60_000);
  expect(await label(ui)).toBe(" cache cold");
  expect(await colour()).toBe("cyan");
  await ui.unmount();
});

test("usage that names no lifetime keeps the assumed 1-hour countdown", async ($, on) => {
  on("ui.render", () => BENEATH);
  const { clock, state } = chatSetup(on, 10);
  state.usage = cold;
  await $.session.start(START);
  const ui = await $.ui.mount(BAND);
  await respond($);
  await clock.advance(20 * 60_000);
  await clock.settle();
  const minutes = Number(/(\d+)m$/.exec(String(await label(ui)))?.[1]);
  expect(minutes).toBeGreaterThanOrEqual(38);
  await ui.unmount();
});

/** An assistant row with one finished tool call. */
const call = (id: string, text: string) => ({ role: "assistant" as const, text: "", toolUses: [{ tool_use_id: id, tool: "Bash", input: { command: "ls" }, text }] });
/** The user row that carries that call's result, as the engine lists it. */
const result = (id: string, text: string) => ({ role: "user" as const, text: "", toolUses: [], toolResults: [{ tool_use_id: id, text, isError: false }] });
/** A row with nothing to print but its text. */
const filler = (role: "user" | "assistant") => ({ role, text: "more", toolUses: [] });

test("the Haiku transcript prints each result once, keeps the tail whole and cuts old tool results", async ($, on) => {
  const asked = haikuSetup(on, "S".repeat(300));
  const messages = [
    { role: "user", text: "go", toolUses: [] },
    call("old", `OLDMARK${"x".repeat(4993)}`),
    result("old", `OLDMARK${"x".repeat(4993)}`),
    filler("assistant"),
    // The last six rows start here.
    call("new", `NEWMARK${"§".repeat(5000)}`),
    result("new", `NEWMARK${"§".repeat(5000)}`),
    filler("assistant"),
    filler("user"),
    filler("assistant"),
    // A call whose result no user row carries yet is printed from the call.
    call("pending", "PENDMARK"),
  ];
  await $.session.compact({ trigger: "manual", messages, instructions: "" });
  expect(asked).toHaveLength(1);
  const prompt = asked[0];
  expect(prompt.split("OLDMARK")).toHaveLength(2);
  expect(prompt).toContain("3000 more chars");
  expect(prompt.split("NEWMARK")).toHaveLength(2);
  expect(prompt.match(/§/g)).toHaveLength(5000);
  expect(prompt.split("PENDMARK")).toHaveLength(2);
});

test("the Haiku transcript clips tool inputs at 400 characters, except in the last 6 messages", async ($, on) => {
  const asked = haikuSetup(on, "S".repeat(300));
  const big = (id: string, c: string) => ({ role: "assistant" as const, text: "", toolUses: [{ tool_use_id: id, tool: "Bash", input: { command: c.repeat(1000) }, text: "" }] });
  const messages = [
    { role: "user", text: "go", toolUses: [] },
    filler("assistant"),
    filler("user"),
    big("a", "§"),
    big("b", "¶"),
    filler("user"),
    filler("assistant"),
    filler("user"),
    filler("assistant"),
    filler("user"),
  ];
  await $.session.compact({ trigger: "manual", messages, instructions: "" });
  expect(asked[0].match(/§/g)?.length).toBeLessThan(500);
  expect(asked[0].match(/¶/g)).toHaveLength(1000);
});

test("a transcript too long even in the short form gets no Haiku summary", async ($, on) => {
  on("session.compact", () => ({ skip: "test" }));
  const asked = haikuSetup(on, "S".repeat(300));
  const huge = { role: "user" as const, text: "z".repeat(1_300_000), toolUses: [] };
  await $.session.compact({ trigger: "manual", messages: [huge, huge], instructions: "" });
  expect(asked).toHaveLength(0);
});

/** A session with a long enough transcript, no jev-api tools and a Haiku that answers `text`. */
function haikuSetup(on: Parameters<typeof mock.clock>[0], text: string | undefined, outputTokens = 1) {
  mock.store(on, {});
  mock.clock(on);
  on("session.cwd", () => ({ value: "/proj" }));
  on("ui.status", () => ({ value: undefined }));
  on("tool.list", () => ({ value: [] }));
  const asked: string[] = [];
  on("model.complete", (_$, e) => {
    asked.push(`${String(e.model)}|${String(e.prompt)}`);
    return { value: text === undefined ? { isAnswered: false, reason: "down" } : { isAnswered: true, text, usage: { input_tokens: 1, output_tokens: outputTokens } } };
  });
  return asked;
}

/** Two-message transcript used as compaction input. */
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

test("a summary that used all of Haiku's tokens was cut off: Claude Code compacts instead", async ($, on) => {
  haikuSetup(on, "S".repeat(300), COMPACT_MAX_TOKENS);
  let beneath = 0;
  on("session.compact", () => {
    beneath++;
    return { skip: "test" };
  });
  const r = (await $.session.compact({ trigger: "manual", messages: MESSAGES })) as { messages?: unknown };
  expect(beneath).toBe(1);
  expect(r.messages).toBeUndefined();
});

test("a Haiku summary of 200 characters or fewer falls through to Claude Code", async ($, on) => {
  haikuSetup(on, "S".repeat(150));
  let beneath = 0;
  on("session.compact", () => {
    beneath++;
    return { skip: "test" };
  });
  const r = (await $.session.compact({ trigger: "manual", messages: MESSAGES })) as { messages?: unknown };
  expect(beneath).toBe(1);
  expect(r.messages).toBeUndefined();
});

test("a subagent's compaction is left to Claude Code", async ($, on) => {
  const asked = haikuSetup(on, "S".repeat(300));
  let beneath = 0;
  on("session.compact", () => {
    beneath++;
    return { skip: "test" };
  });
  await $.session.compact({ trigger: "auto", agentId: "a1", messages: MESSAGES });
  expect(asked).toHaveLength(0);
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

/**
 * A main loop that answers with 1-hour cache writes, a context `percent` full and a `/compact` that `run` answers.
 *
 * @param on - The test's `on`.
 * @param percent - What `$.session.usage()` reports as the context fill.
 * @param run - Answers a `/compact` run: `{ value }` resolves it, `{ deny }` refuses it, a pending promise queues it.
 * @returns The clock, the state (`/compact` run count; `hold` true keeps each `$.session.usage()` pending in `held` until called).
 */
function chatSetup(on: Parameters<typeof mock.clock>[0], percent: number, run: () => unknown = () => ({ value: undefined })) {
  mock.store(on, {});
  const clock = mock.clock(on);
  const state = { compacts: 0, hold: false, held: [] as Array<() => void>, usage: usage1h as Record<string, unknown> };
  on("session.cwd", () => ({ value: "/proj" }));
  on("ui.status", () => ({ value: undefined }));
  on("tool.list", () => ({ value: [] }));
  on("session.start", async () => ({}));
  on("session.end", async () => ({}));
  on("turn.complete", async () => ({}));
  on("turn.step", async function*(_$, e) {
    yield { kind: "stop", stopReason: "end_turn", usage: state.usage };
    return { turnId: e.turnId, index: e.index, answer: "ok", toolUses: [], stopReason: "end_turn", usage: state.usage };
  });
  on("session.usage", () => {
    const answer = { value: { context: { tokens: 1, window: 100, percent } } };
    return state.hold ? new Promise((resolve) => state.held.push(() => resolve(answer))) : answer;
  });
  on("command.run", (_$, e, next) => {
    if (e.command !== "compact") return next(e);
    state.compacts++;
    return run();
  });
  return { clock, state };
}

for (const [percent, option, runs] of [[70, 60, 1], [50, 60, 0], [90, 0, 0], [Number.NaN, 60, 0], [Number.POSITIVE_INFINITY, 60, 0]] as const) {
  test(`auto-compact at ${percent}% with autoCompactPercent ${option} runs /compact ${runs}x once the cache is cold`, { options: { autoCompactPercent: option } }, async ($, on) => {
    const { clock, state } = chatSetup(on, percent);
    await $.session.start(START);
    await respond($);
    // Warm for an hour: nothing yet.
    await clock.advance(CACHE_TTL["1h"] - 60_000);
    expect(state.compacts).toBe(0);
    // Cold: one run, never a second one for the same cold period.
    await clock.advance(120_000);
    await clock.advance(60_000);
    expect(state.compacts).toBe(runs);
  });
}

test("a response after an auto-compact opens a new cold period that compacts again", async ($, on) => {
  const { clock, state } = chatSetup(on, 70);
  await $.session.start(START);
  await respond($);
  await clock.advance(CACHE_TTL["1h"] + 60_000);
  expect(state.compacts).toBe(1);
  await respond($);
  await clock.advance(30 * 60_000);
  expect(state.compacts).toBe(1);
  await clock.advance(CACHE_TTL["1h"]);
  expect(state.compacts).toBe(2);
});

test("a repeated session.start (reload) replaces the cache tick instead of adding a second one", async ($, on) => {
  let reads = 0;
  // Registered before chatSetup, so it runs above its answer: counts every fill read.
  on("session.usage", (_$, e, next) => {
    reads++;
    return next(e);
  });
  // 50% stays below autoCompactPercent 60: every cold tick reads the fill, none compacts.
  const { clock } = chatSetup(on, 50);
  await $.session.start(START);
  await $.session.start(START);
  await respond($);
  await clock.advance(CACHE_TTL["1h"] + 1_000);
  const before = reads;
  await clock.advance(15_000);
  expect(reads - before).toBe(1);
});

test("a response that lands while the cold tick reads the clock keeps the warm chat from being compacted", async ($, on) => {
  let armed = false;
  // Registered before mock.clock, so it runs above it: one-shot, the tick's own clock read runs a whole turn.
  on("clock.now", async (_$, e, next) => {
    if (armed) {
      armed = false;
      await respond($);
    }
    return next(e);
  });
  const { clock, state } = chatSetup(on, 70);
  await $.session.start(START);
  await respond($);
  await clock.advance(CACHE_TTL["1h"] - 5_000);
  armed = true;
  await clock.advance(10_000);
  expect(armed).toBe(false);
  expect(state.compacts).toBe(0);
});

// The tick's clock read yields: a response or a /clear landing then has drawn the fresh countdown, the tick must not redraw the old one.
for (
  const [what, before, after, warmFor, during] of [
    ["a response on a cold cache", " cache cold", " cache 59m", CACHE_TTL["1h"] + 60_000, respond],
    ["a /clear on a warm cache", " cache 49m", undefined, 10 * 60_000, async ($) => {
      await $.session.end({ reason: "clear", sessionId: "s1", resume: { id: "s1" } });
    }],
  ] as const
) {
  test(`${what} during the tick's clock read keeps the fresh countdown on the band`, async ($, on) => {
    let armed = false;
    // Registered before mock.clock, so it runs above it: one-shot, on the tick's own clock read.
    on("clock.now", async (_$, e, next) => {
      if (armed) {
        armed = false;
        await during($);
      }
      return next(e);
    });
    const { clock } = chatSetup(on, 10);
    on("ui.render", () => BENEATH);
    await $.session.start(START);
    const ui = await $.ui.mount(BAND);
    await respond($);
    await clock.advance(warmFor);
    expect(await label(ui)).toBe(before);
    armed = true;
    await clock.advance(15_000);
    expect(armed).toBe(false);
    expect(await label(ui)).toBe(after);
    await ui.unmount();
  });
}

// The cold tick's fill read yields: whatever happens while it is pending must be judged again after it.
for (
  const [what, reads, runs, during] of [
    ["two more cold ticks overlap it", 3, 1, async (_$, clock) => {
      await clock.advance(15_000);
      await clock.advance(15_000);
    }],
    ["a main-loop turn starts", 1, 0, async ($) => {
      await $.turn.step({ turnId: "t2", index: 0, model: "claude-haiku-5-5", effort: "high", messageCount: 1 }).next();
    }],
    ["the session is reset (/clear)", 1, 0, async ($) => {
      await $.session.end({ reason: "clear", sessionId: "s1", resume: { id: "s1" } });
    }],
  ] as const
) {
  test(`auto-compact runs /compact ${runs}x when ${what} during the cold tick's fill read`, async ($, on) => {
    const { clock, state } = chatSetup(on, 70);
    await $.session.start(START);
    // turn.complete reads the fill too: hold only the reads after it.
    await respond($);
    state.hold = true;
    await clock.advance(CACHE_TTL["1h"] + 1_000);
    await during($, clock);
    expect(state.held.length).toBe(reads);
    for (const release of state.held.splice(0)) release();
    await clock.settle();
    expect(state.compacts).toBe(runs);
  });
}

test("a background subagent's step does not hold off auto-compact", async ($, on) => {
  const { clock, state } = chatSetup(on, 70);
  await $.session.start(START);
  await respond($);
  // A background agent: no main-loop turn.complete ever follows its step.
  await $.turn.step({ turnId: "s1", index: 0, model: "claude-opus-5-5", effort: "high", messageCount: 1, agentId: "a1" }).next();
  await clock.advance(CACHE_TTL["1h"] + 60_000);
  await clock.advance(60_000);
  expect(state.compacts).toBe(1);
});

test("a subagent's response leaves the main loop's cache countdown alone", async ($, on) => {
  const { clock } = chatSetup(on, 10);
  on("ui.render", () => BENEATH);
  await $.session.start(START);
  const ui = await $.ui.mount(BAND);
  await respond($);
  await clock.advance(30 * 60_000);
  expect(await label(ui)).toBe(" cache 29m");
  const stream = $.turn.step({ turnId: "s1", index: 0, model: "claude-opus-5-5", effort: "high", messageCount: 1, agentId: "a1" });
  while (!(await stream.next()).done);
  await clock.advance(15_000);
  expect(await label(ui)).toBe(" cache 29m");
  await ui.unmount();
});

test("a subagent's turn end leaves a running main-loop turn running: no auto-compact mid-turn", async ($, on) => {
  const { clock, state } = chatSetup(on, 70);
  await $.session.start(START);
  await respond($);
  await clock.advance(CACHE_TTL["1h"] - 60_000);
  // A main-loop turn starts its step and is still running.
  await $.turn.step({ turnId: "t2", index: 0, model: "claude-opus-5-5", effort: "high", messageCount: 1 }).next();
  await $.turn.complete({ turnId: "a-t1", agentId: "a1", reason: "answer", answer: "ok", durationMs: 1 });
  await clock.advance(5 * 60_000);
  expect(state.compacts).toBe(0);
});

test("a /compact still queued behind the session is not issued again by the next ticks", async ($, on) => {
  // The engine keeps a plugin's `command.run` pending until the command ran: only the flag stops a repeat.
  const { clock, state } = chatSetup(on, 70, () => new Promise(() => {}));
  await $.session.start(START);
  await respond($);
  await clock.advance(CACHE_TTL["1h"] + 60_000);
  await clock.advance(10 * 60_000);
  expect(state.compacts).toBe(1);
});

test("a refused /compact is not tried again in the same cold period", async ($, on) => {
  const { clock, state } = chatSetup(on, 70, () => ({ deny: "no command named /compact" }));
  await $.session.start(START);
  await respond($);
  await clock.advance(CACHE_TTL["1h"] + 60_000);
  await clock.advance(10 * 60_000);
  expect(state.compacts).toBe(1);
});

test("a precompute or a vetoed compaction leaves the countdown, a compaction that stands clears it", async ($, on) => {
  const { clock } = chatSetup(on, 70);
  let vetoed = true;
  on("session.compact", () => (vetoed ? { skip: "veto" } : { messages: [] }));
  on("model.complete", () => ({ value: { isAnswered: false, reason: "down" } }));
  on("ui.render", () => BENEATH);
  await $.session.start(START);
  const ui = await $.ui.mount(BAND);
  await respond($);
  await clock.advance(30_000);
  expect(await label(ui)).toMatch(/^ cache \d+m$/);
  // Nothing is installed: the cache is as warm as before.
  await $.session.compact({ trigger: "precompute", messages: MESSAGES });
  await clock.advance(30_000);
  expect(await label(ui)).toMatch(/^ cache \d+m$/);
  await $.session.compact({ trigger: "manual", messages: MESSAGES });
  await clock.advance(30_000);
  expect(await label(ui)).toMatch(/^ cache \d+m$/);
  // A compaction that stands rewrites the cache: the countdown waits for the next response.
  vetoed = false;
  await $.session.compact({ trigger: "manual", messages: MESSAGES });
  await clock.advance(30_000);
  expect(await label(ui)).toBeUndefined();
  await ui.unmount();
});

test("a Haiku-written compaction clears the countdown, and the old cold period does not compact the new chat", async ($, on) => {
  const { clock, state } = chatSetup(on, 70);
  on("model.complete", () => ({ value: { isAnswered: true, text: "S".repeat(300), usage: { input_tokens: 1, output_tokens: 1 } } }));
  on("ui.render", () => BENEATH);
  await $.session.start(START);
  const ui = await $.ui.mount(BAND);
  await respond($);
  await clock.advance(30_000);
  expect(await label(ui)).toMatch(/^ cache \d+m$/);
  const r = (await $.session.compact({ trigger: "manual", messages: MESSAGES })) as { messages?: unknown[] };
  expect(r.messages).toHaveLength(1);
  await clock.advance(30_000);
  expect(await label(ui)).toBeUndefined();
  await clock.advance(CACHE_TTL["1h"]);
  expect(state.compacts).toBe(0);
  await ui.unmount();
});

// A context-fill /compact still queued (its command.run pending) is done once a compaction stands: the next turn end may queue again.
for (const [path, options, answer] of [["Haiku", {}, "S".repeat(300)], ["Claude Code", { haikuCompact: false }, undefined]] as const) {
  test(`a compaction that stands (${path}) lets the next forced turn end queue /compact again`, { options }, async ($, on) => {
    // 96% is above forceCompactPercent 95: every turn end compacts, Jev or not.
    const { state } = chatSetup(on, 96, () => new Promise(() => {}));
    on("session.compact", () => ({ messages: [] }));
    on("model.complete", () => ({ value: answer === undefined ? { isAnswered: false, reason: "down" } : { isAnswered: true, text: answer, usage: { input_tokens: 1, output_tokens: 1 } } }));
    await $.session.start(START);
    await respond($);
    expect(state.compacts).toBe(1);
    // Still queued: the next turn end does not queue a second one.
    await respond($);
    expect(state.compacts).toBe(1);
    await $.session.compact({ trigger: "manual", messages: MESSAGES });
    await respond($);
    expect(state.compacts).toBe(2);
  });
}

test("a precompute that Claude Code's own compaction answers leaves the countdown", { options: { haikuCompact: false } }, async ($, on) => {
  const { clock } = chatSetup(on, 70);
  on("session.compact", () => ({ messages: [] }));
  on("model.complete", () => ({ value: { isAnswered: false, reason: "down" } }));
  on("ui.render", () => BENEATH);
  await $.session.start(START);
  const ui = await $.ui.mount(BAND);
  await respond($);
  await clock.advance(30_000);
  expect(await label(ui)).toMatch(/^ cache \d+m$/);
  await $.session.compact({ trigger: "precompute", messages: MESSAGES });
  await clock.advance(30_000);
  expect(await label(ui)).toMatch(/^ cache \d+m$/);
  await ui.unmount();
});

test("the countdown sits above another plugin's band while the effort row is hidden", { options: { routing: false } }, async ($, on) => {
  const { clock } = chatSetup(on, 10);
  on("ui.render", () => BENEATH);
  await $.session.start(START);
  const ui = await $.ui.mount(BAND);
  expect(await ui.find({ type: "Text", text: "beneath" })).toBeDefined();
  expect(await label(ui)).toBeUndefined();
  await respond($);
  await clock.settle();
  expect(await label(ui)).toBe(" cache 59m");
  expect(await ui.find({ type: "Text", text: "beneath" })).toBeDefined();
  await ui.unmount();
});

test("a /clear (session.end, no session.start follows) starts the countdown over", async ($, on) => {
  const { clock, state } = chatSetup(on, 70);
  on("ui.render", () => BENEATH);
  await $.session.start(START);
  const ui = await $.ui.mount(BAND);
  await respond($);
  await clock.settle();
  expect(await label(ui)).toBe(" cache 59m");
  await $.session.end({ reason: "clear", sessionId: "s1", resume: { id: "s1" } });
  await clock.settle();
  expect(await label(ui)).toBeUndefined();
  // The old chat's cold period does not compact the new one.
  await clock.advance(CACHE_TTL["1h"] + 120_000);
  expect(state.compacts).toBe(0);
  await ui.unmount();
});

test("a session.start (reload) after a response starts the countdown over", async ($, on) => {
  const { clock, state } = chatSetup(on, 70);
  on("ui.render", () => BENEATH);
  await $.session.start(START);
  const ui = await $.ui.mount(BAND);
  await respond($);
  await clock.settle();
  expect(await label(ui)).toBe(" cache 59m");
  await $.session.start(START);
  await clock.settle();
  expect(await label(ui)).toBeUndefined();
  await clock.advance(CACHE_TTL["1h"] + 120_000);
  expect(state.compacts).toBe(0);
  await ui.unmount();
});

test("a failing clock read never fails the model step", async ($, on) => {
  on("tool.list", () => ({ value: [] }));
  on("clock.now", () => ({ deny: "gone" }));
  on("turn.step", async function*(_$, e) {
    yield { kind: "stop", stopReason: "end_turn", usage: usage1h };
    return { turnId: e.turnId, index: e.index, answer: "ok", toolUses: [], stopReason: "end_turn", usage: usage1h };
  });
  const stream = $.turn.step({ turnId: "t1", index: 0, model: "claude-opus-5-5", effort: "high", messageCount: 1 });
  let r = await stream.next();
  while (!r.done) r = await stream.next();
  expect(r.value).toMatchObject({ answer: "ok" });
});
