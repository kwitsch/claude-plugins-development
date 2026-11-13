// Acceptance criteria A1 to A5 of the effort calibration, against 120 recorded Jev answers (60 prompts, German and
// English; labels 0 low .. 4 max; d1-3b, 2026-11-13). Pure tests of estimateEffort and effortLevel, no Jev call.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "vitest";
import { EFFORT_ORDER, estimateEffort } from "../plugin/hooks/policy.mjs";

type Row = { id: number; lang: "en" | "de"; label: number; score: number; confidence: number; mechanical: number };
const ROWS = JSON.parse(readFileSync(new URL("./fixtures/effort-scores.json", import.meta.url), "utf8")) as Row[];
const B = { model: "opus", defaultEffort: "high", minEffort: "low", maxEffort: "xhigh" } as const;
const answer = (r: Row) => ({ type: "score" as const, score: r.score, probabilities: {}, confidence: r.confidence });
const count = (rows: Row[], f: (r: Row) => boolean) => rows.filter(f).length;
/** The level the shipped rule gives (no mechanical shortcut, no model bias), as a number; capped at xhigh by the default bounds. */
const NO_SHORTCUT = undefined;
const level = (r: Row) => EFFORT_ORDER.indexOf(estimateEffort(answer(r), NO_SHORTCUT, B).effort);

test("the fixture has 120 records: 60 prompts in both languages, 24 per label", () => {
  assert.equal(ROWS.length, 120);
  assert.equal(count(ROWS, (r) => r.lang === "de"), 60);
  for (const l of [0, 1, 2, 3, 4]) assert.equal(count(ROWS, (r) => r.label === l), 24);
});

test("A1: no record falls back, whatever its confidence", () => {
  assert.equal(count(ROWS, (r) => estimateEffort(answer(r), r.mechanical, B).source === "fallback"), 0);
});

test("A2: the calibrated level hits min(label, xhigh) in at least 100 of 120", () => {
  assert.ok(count(ROWS, (r) => level(r) === Math.min(r.label, 3)) >= 100);
});

test("A3: no medium record counts as mechanical", () => {
  assert.equal(count(ROWS, (r) => r.label === 1 && estimateEffort(answer(r), r.mechanical, B).source === "mechanical"), 0);
});

test("A4: at least 20 of 24 low records count as mechanical", () => {
  assert.ok(count(ROWS, (r) => r.label === 0 && estimateEffort(answer(r), r.mechanical, B).source === "mechanical") >= 20);
});

test("A5: German and English of the same prompt get the same level in at least 50 of 60", () => {
  const en = new Map(ROWS.filter((r) => r.lang === "en").map((r) => [r.id, level(r)]));
  assert.equal(en.size, 60);
  assert.ok(count(ROWS.filter((r) => r.lang === "de"), (r) => en.get(r.id) === level(r)) >= 50);
});
