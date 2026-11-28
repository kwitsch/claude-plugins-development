// Runs under `claude plugin test` via development/scripts/plugin-test.ts (`pnpm --filter statusbar test:plugin`), on a temp
// copy of the built plugin/. Imports the engine's own kit, not vitest (development/wiki/decisions/test-layers.md).
// Together the tests fire every event the built register.js registers: session.start, turn.complete, session.measure
// and ui.render ({ component: "StatusLine" }).
import { expect, mock, test } from "claude-code/testing";

/** The test's `on`, taken from the kit's own types. */
type On = Parameters<typeof mock.clock>[0];

/** Green. */
const G = "\x1b[0;32m";
/** Yellow. */
const Y = "\x1b[0;33m";
/** Red. */
const R = "\x1b[0;31m";
/** Reset. */
const X = "\x1b[0m";
/** The session's working directory. */
const CWD = "/proj";
/** The `session.start` input. */
const START = { source: "startup", cwd: CWD, surface: "terminal", isInteractive: true };
/** The StatusLine site as the terminal raises it. */
const SITE = { plugin: "statusbar", component: "StatusLine", props: { text: "cmd" }, surface: "terminal" };
/**
 * The line for /proj on main with context 42 %.
 *
 * @param five - The 5h figure.
 * @param color - Its ANSI colour.
 * @returns The expected ANSI line.
 */
const line = (five: number, color: string) => `\u{1F4C2} proj | ⎇ main | ${G}\u{1F5C3}️ 42%${X} | ${color}\u{1F554} ${five}%${X}`;

/**
 * Stubs every engine call of the mod (as tests/register.test.ts `world`). One call per test, before the first `$` call.
 *
 * @param on - The test's `on`.
 * @param state - The 5h figure the usage answers; mutated by a test between triggers.
 * @returns The clock and the texts the StatusLine site received.
 */
function world(on: On, state: { five: number }) {
  const seen: unknown[] = [];
  const clock = mock.clock(on);
  on("session.cwd", () => ({ value: CWD }));
  on("fs.exists", (_$, e) => ({ value: e.path === "/proj/.git/HEAD" || e.path === "/proj/.git" }));
  on("fs.read", (_$, e) => (e.path === "/proj/.git/HEAD" ? { value: "ref: refs/heads/main\n" } : { deny: "ENOENT" }));
  on("session.usage", () => ({ value: { context: { percent: 42 }, rateLimits: [{ kind: "five_hour", percentUsed: state.five }] } }));
  on("ui.render", (_$, e) => {
    const text = (e.props as { text?: unknown }).text;
    seen.push(text);
    // the kit refuses a text child with an escape sequence, so the drawn tree carries a plain label
    return { type: "Text", props: {}, children: ["site"] };
  });
  // The official kit refuses a session.start answer without `cwd`.
  on("session.start", async () => ({ cwd: CWD }));
  on("turn.complete", () => ({ text: "" }));
  on("session.measure", (_$, e) => ({ changed: e.changed }));
  return { clock, seen };
}

test("before session.start the site shows the command's output unchanged (ui.render)", async ($, on) => {
  const w = world(on, { five: 85 });
  await $.ui.mount(SITE);
  expect(w.seen).toEqual(["cmd"]);
});

test("session.start draws the mod's line in place of the command's output (session.start)", async ($, on) => {
  const w = world(on, { five: 85 });
  await $.session.start(START);
  await $.ui.mount(SITE);
  await w.clock.settle();
  expect(w.seen.at(-1)).toBe(line(85, Y));
});

test("turn.complete redraws a changed 5h figure (turn.complete)", async ($, on) => {
  const state = { five: 85 };
  const w = world(on, state);
  await $.session.start(START);
  await $.ui.mount(SITE);
  state.five = 95;
  await $.turn.complete({ turnId: "t1", reason: "answer", answer: "Done.", durationMs: 1, isAborted: false });
  await w.clock.settle();
  expect(w.seen.at(-1)).toBe(line(95, R));
});

test("session.measure redraws a changed 5h figure (session.measure)", async ($, on) => {
  const state = { five: 85 };
  const w = world(on, state);
  await $.session.start(START);
  await $.ui.mount(SITE);
  state.five = 70;
  await $.session.measure({ changed: ["rateLimits"] });
  await w.clock.settle();
  expect(w.seen.at(-1)).toBe(line(70, G));
});

test("the 10 s timer redraws without a turn (session.start timer)", async ($, on) => {
  const state = { five: 85 };
  const w = world(on, state);
  await $.session.start(START);
  await $.ui.mount(SITE);
  state.five = 90;
  await w.clock.advance(10_000);
  expect(w.seen.at(-1)).toBe(line(90, R));
});
