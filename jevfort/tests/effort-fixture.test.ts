// Acceptance criteria A1 to A5 of the effort calibration, against 120 recorded Jev answers (60 prompts, German and
// English; labels 0 low .. 4 max; d1-3b, 2026-11-13), through the built plugin/hooks/register.mjs: each record's score
// and mechanical answer are Jev's answers to step 0's `effort` and `mechanical` questions, and the level and source step 0 logs are checked.
import type { On } from "claude-engine-vitest";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "vitest";
import { byId, DEFAULTS, effortOf, makeKit, mech, type Runner, scored, user } from "./support/kit.ts";

type Row = { id: number; lang: "en" | "de"; label: number; score: number; confidence: number; mechanical: number };
const ROWS = JSON.parse(readFileSync(new URL("./fixtures/effort-scores.json", import.meta.url), "utf8")) as Row[];
const EFFORTS = ["low", "medium", "high", "xhigh", "max"];

const { test: kitTest, setup } = makeKit(DEFAULTS);

/**
 * Feeds the fake Jev one record at a time: the record's score and, unless `shortcut` is off, its mechanical answer.
 *
 * @param on - The test's `on`.
 * @returns The state to set before each estimate, and the step-0 runner.
 */
function feed(on: On) {
  const state = { row: ROWS[0], shortcut: true };
  setup(on, {
    // The fake answers by question id: the prompt text does not matter.
    messages: [user("estimate this")],
    jev: byId({
      get effort() {
        return scored(state.row.score, state.row.confidence);
      },
      get mechanical() {
        return mech(state.shortcut ? state.row.mechanical : 0);
      },
    }),
  });
  return { state, run: effortOf(on) };
}

/**
 * The estimate of one record, as step 0 logs it (Opus, session effort high, options low..xhigh).
 *
 * @param $ - The test's `$`.
 * @param fed - The fake Jev's state and runner from `feed`.
 * @param r - The record.
 * @param shortcut - Whether the mechanical answer counts (false: the score alone decides).
 * @returns The effort's level index and the estimate's source.
 */
async function estimate($: Runner, fed: ReturnType<typeof feed>, r: Row, shortcut = true) {
  fed.state.row = r;
  fed.state.shortcut = shortcut;
  const { effort, source } = await fed.run($);
  return { level: EFFORTS.indexOf(effort ?? ""), source };
}

test("the fixture has 120 records: 60 prompts in both languages, 24 per label", () => {
  assert.equal(ROWS.length, 120);
  assert.equal(ROWS.filter((r) => r.lang === "de").length, 60);
  for (const l of [0, 1, 2, 3, 4]) assert.equal(ROWS.filter((r) => r.label === l).length, 24);
});

kitTest("A1: no record falls back, whatever its confidence", async ($, on) => {
  const fed = feed(on);
  let fallbacks = 0;
  for (const r of ROWS) if ((await estimate($, fed, r)).source === "fallback") fallbacks++;
  assert.equal(fallbacks, 0);
});

kitTest("A2: the calibrated level hits min(label, xhigh) in at least 100 of 120", async ($, on) => {
  const fed = feed(on);
  let hits = 0;
  for (const r of ROWS) if ((await estimate($, fed, r, false)).level === Math.min(r.label, 3)) hits++;
  assert.ok(hits >= 100, `hits ${hits}`);
});

kitTest("A3: no medium record counts as mechanical", async ($, on) => {
  const fed = feed(on);
  let mechanical = 0;
  for (const r of ROWS.filter((x) => x.label === 1)) if ((await estimate($, fed, r)).source === "mechanical") mechanical++;
  assert.equal(mechanical, 0);
});

kitTest("A4: at least 20 of 24 low records count as mechanical", async ($, on) => {
  const fed = feed(on);
  let mechanical = 0;
  for (const r of ROWS.filter((x) => x.label === 0)) if ((await estimate($, fed, r)).source === "mechanical") mechanical++;
  assert.ok(mechanical >= 20, `mechanical ${mechanical}`);
});

kitTest("A5: German and English of the same prompt get the same level in at least 50 of 60", async ($, on) => {
  const fed = feed(on);
  const levelOf = new Map<number, number>();
  for (const r of ROWS.filter((x) => x.lang === "en")) levelOf.set(r.id, (await estimate($, fed, r, false)).level);
  assert.equal(levelOf.size, 60);
  let same = 0;
  for (const r of ROWS.filter((x) => x.lang === "de")) if (levelOf.get(r.id) === (await estimate($, fed, r, false)).level) same++;
  assert.ok(same >= 50, `same ${same}`);
});
