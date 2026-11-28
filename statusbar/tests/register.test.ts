// Kit tests of src/hooks/register.ts (claude-engine-vitest). The StatusLine site is mounted with the command's output
// "cmd"; a test-side ui.render stub beneath the mod records the props.text it receives.
import { createKit } from "claude-engine-vitest";
import { expect } from "vitest";

/** Test kit bound to the source `src/hooks/register.ts`. */
const { test, mock } = createKit({ module: new URL("../src/hooks/register.ts", import.meta.url), plugin: "statusbar" });

/** The test's `on`. */
type On = Parameters<typeof mock.clock>[0];

/** Red. */
const R = "\x1b[0;31m";
/** Green. */
const G = "\x1b[0;32m";
/** Yellow. */
const Y = "\x1b[0;33m";
/** Reset. */
const X = "\x1b[0m";
/** The StatusLine site as the terminal raises it, carrying the command's output. */
const SITE = { plugin: "statusbar", component: "StatusLine", props: { text: "cmd" }, surface: "terminal" };
/** The session start input. */
const START = { source: "startup" };
/**
 * The line for /proj on main with context 42 %.
 *
 * @param five - The 5h figure.
 * @param color - Its ANSI colour.
 * @returns The expected ANSI line.
 */
const line = (five: number, color: string) => `\u{1F4C2} proj | ⎇ main | ${G}\u{1F5C3}️ 42%${X} | ${color}\u{1F554} ${five}%${X}`;

/** What the fake usage answers; mutated by a test between triggers. */
type State = {
  /** The `context` object of `$.session.usage()`. */
  context: { tokens?: number; window?: number; percent?: number };
  /** The `five_hour` percentUsed, or undefined for no entry. */
  five?: number;
  /** `$.session.usage()` is refused. */
  fail?: boolean;
  /** `$.session.usage()` waits for this first. */
  hold?: Promise<void>;
};

/**
 * Stubs every engine call of the mod: cwd `/proj` (a git repo on main), usage from `state`, a fake clock, the
 * StatusLine site's recorder and the counted redraws and usage reads. One call per test, before the first `$` call.
 *
 * @param on - The test's `on`.
 * @param state - The fake usage.
 * @returns The clock, the recorded texts and the counters.
 */
function world(on: On, state: State) {
  const seen: unknown[] = [];
  const counts = { invalidate: 0, usage: 0 };
  const clock = mock.clock(on);
  on("session.cwd", () => ({ value: "/proj" }));
  on("fs.exists", (_$, e) => ({ value: e.path === "/proj/.git/HEAD" || e.path === "/proj/.git" }));
  on("fs.read", (_$, e) => (e.path === "/proj/.git/HEAD" ? { value: "ref: refs/heads/main\n" } : { deny: "ENOENT" }));
  on("session.usage", async () => {
    counts.usage++;
    await state.hold;
    if (state.fail) return { deny: "refused" };
    return { value: { context: state.context, rateLimits: state.five === undefined ? [] : [{ kind: "five_hour", percentUsed: state.five }] } };
  });
  on("ui.invalidate", (_$, e, next) => {
    counts.invalidate++;
    return next(e);
  });
  on("ui.render", (_$, e) => {
    const text = (e.props as { text?: unknown }).text;
    seen.push(text);
    return { type: "Text", props: {}, children: [String(text)] };
  });
  on("session.start", () => ({ cwd: "/proj" }));
  on("turn.complete", () => ({ text: "" }));
  on("session.measure", () => ({}));
  return { clock, seen, counts };
}

test("after session.start the StatusLine site shows the mod's line in place of the command's output", async ($, on) => {
  const w = world(on, { context: { percent: 42 }, five: 85 });
  await $.session.start(START);
  await $.ui.mount(SITE);
  await w.clock.settle();
  expect(w.seen.at(-1)).toBe(line(85, Y));
});

test("before the first usage answer the site passes the command's output through", async ($, on) => {
  let release = (): void => undefined;
  const hold = new Promise<void>((r) => (release = r));
  const w = world(on, { context: { percent: 42 }, five: 85, hold });
  const started = $.session.start(START);
  await w.clock.settle();
  await $.ui.mount(SITE);
  expect(w.seen).toEqual(["cmd"]);
  release();
  await started;
  await w.clock.settle();
  expect(w.seen.at(-1)).toBe(line(85, Y));
});

test("the 10 s timer redraws a changed 5h figure without any turn.complete", async ($, on) => {
  const state: State = { context: { percent: 42 }, five: 85 };
  const w = world(on, state);
  await $.session.start(START);
  await $.ui.mount(SITE);
  await w.clock.settle();
  state.five = 95;
  await w.clock.advance(9_999);
  expect(w.seen.at(-1)).toBe(line(85, Y));
  await w.clock.advance(1);
  expect(w.seen.at(-1)).toBe(line(95, R));
});

test("turn.complete redraws after a usage change", async ($, on) => {
  const state: State = { context: { percent: 42 }, five: 85 };
  const w = world(on, state);
  await $.session.start(START);
  await $.ui.mount(SITE);
  state.five = 79;
  expect(await $.turn.complete({ turnId: "t1" })).toEqual({ text: "" });
  await w.clock.settle();
  expect(w.seen.at(-1)).toBe(line(79, G));
});

test("session.measure redraws after a usage change", async ($, on) => {
  const state: State = { context: { percent: 42 }, five: 85 };
  const w = world(on, state);
  await $.session.start(START);
  await $.ui.mount(SITE);
  state.five = 90;
  await $.session.measure({});
  await w.clock.settle();
  expect(w.seen.at(-1)).toBe(line(90, R));
});

test("unchanged usage invalidates nothing more, though every trigger reads it", async ($, on) => {
  const w = world(on, { context: { percent: 42 }, five: 85 });
  await $.session.start(START);
  await $.ui.mount(SITE);
  await w.clock.settle();
  const before = { ...w.counts };
  await $.turn.complete({ turnId: "t1" });
  await w.clock.advance(10_000);
  expect(w.counts.usage - before.usage).toBe(2);
  expect(w.counts.invalidate - before.invalidate).toBe(0);
});

test("a refused usage read does not throw and keeps the previous line", async ($, on) => {
  const state: State = { context: { percent: 42 }, five: 85 };
  const w = world(on, state);
  await $.session.start(START);
  await $.ui.mount(SITE);
  state.five = 95;
  state.fail = true;
  expect(await $.turn.complete({ turnId: "t1" })).toEqual({ text: "" });
  await w.clock.advance(10_000);
  expect(w.seen.at(-1)).toBe(line(85, Y));
});

test("a second session.start cancels the first timer: one tick per period", async ($, on) => {
  const w = world(on, { context: { percent: 42 }, five: 85 });
  await $.session.start(START);
  await $.session.start(START);
  await w.clock.settle();
  const before = w.counts.usage;
  await w.clock.advance(10_000);
  expect(w.counts.usage - before).toBe(1);
});

test("context falls back to tokens / window when percent is missing", async ($, on) => {
  const w = world(on, { context: { tokens: 50_000, window: 200_000 }, five: 85 });
  await $.session.start(START);
  await $.ui.mount(SITE);
  await w.clock.settle();
  expect(w.seen.at(-1)).toBe(`\u{1F4C2} proj | ⎇ main | ${G}\u{1F5C3}️ 25%${X} | ${Y}\u{1F554} 85%${X}`);
});
