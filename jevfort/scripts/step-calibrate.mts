// Calibration run for the step-effort question: scores every labelled delta of tests/fixtures/step-deltas.json
// RUNS times against the real Jev endpoint (the env of jev-api: TYPESAFE_API_KEY, TYPESAFE_BASE_URL, JEV_URL,
// TYPESAFE_DEFAULT_MODEL), writes the scores to tests/fixtures/step-effort-scores.json and prints, per label, the
// spread and the cut points that separate neighbouring labels best. Dev tool: never shipped.
//
//   node scripts/step-calibrate.mts [--runs 5] [--out tests/fixtures/step-effort-scores.json]
import { readFileSync, writeFileSync } from "node:fs";
import { sendRequest } from "../../jev-api/src/shared/http.ts";
import { EFFORT_CUTS, effortLevel, stepEffortQuestion } from "../src/hooks/policy.ts";

type Delta = { id: number; label: number; request: string; delta: unknown[] };
type Row = { id: number; label: number; scores: number[] };

const argv = process.argv.slice(2);
const flag = (name: string, fallback: string): string => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined) ?? fallback;
const RUNS = Number(flag("--runs", "5"));
const OUT = new URL(flag("--out", "../tests/fixtures/step-effort-scores.json"), import.meta.url);
const SESSION_EFFORT = "medium";
const CONCURRENCY = 4;

const trim = (name: string): string | undefined => process.env[name]?.trim() || undefined;
const env = { key: trim("TYPESAFE_API_KEY"), base: trim("TYPESAFE_BASE_URL"), jevUrl: trim("JEV_URL"), model: trim("TYPESAFE_DEFAULT_MODEL") };
const deltas = JSON.parse(readFileSync(new URL("../tests/fixtures/step-deltas.json", import.meta.url), "utf8")) as Delta[];

/**
 * One score of the step-effort question for one delta.
 *
 * @param d - The labelled delta.
 * @returns The score.
 */
async function scoreOnce(d: Delta): Promise<number> {
  const state = JSON.stringify({ request: d.request, effort: SESSION_EFFORT, delta: d.delta });
  const out = await sendRequest(env, state, { q0: stepEffortQuestion }, async (url, init) => {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(30_000) });
    return { status: res.status, text: await res.text() };
  });
  if (out.kind !== "ok") throw new Error(`delta ${d.id}: ${out.kind === "http" ? `HTTP ${out.status} ${out.reason ?? ""}` : out.message}`);
  const answer = (JSON.parse(out.text) as { answers?: Record<string, { score?: number }> }).answers?.["q0"];
  if (typeof answer?.score !== "number") throw new Error(`delta ${d.id}: no score in the answer`);
  return answer.score;
}

const jobs = deltas.flatMap((d) => Array.from({ length: RUNS }, () => d));
const rows = new Map<number, Row>(deltas.map((d) => [d.id, { id: d.id, label: d.label, scores: [] }]));
let next = 0;
await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
  while (next < jobs.length) {
    const d = jobs[next++];
    rows.get(d.id)?.scores.push(await scoreOnce(d));
  }
}));
const result = [...rows.values()];
writeFileSync(OUT, JSON.stringify({ runs: RUNS, question: stepEffortQuestion.instructions, rows: result }, null, 1) + "\n");

const mean = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;
const sd = (xs: number[]): number => Math.sqrt(mean(xs.map((x) => (x - mean(xs)) ** 2)));
const byLabel = (l: number): number[] => result.filter((r) => r.label === l).flatMap((r) => r.scores);
const labels = [...new Set(deltas.map((d) => d.label))].sort((a, b) => a - b);
console.log("label  n   mean  sd    min   max");
for (const l of labels) {
  const xs = byLabel(l);
  console.log(`${l}      ${xs.length}  ${mean(xs).toFixed(2)}  ${sd(xs).toFixed(2)}  ${Math.min(...xs).toFixed(2)}  ${Math.max(...xs).toFixed(2)}`);
}
console.log("\nrepeat spread per delta (max sd): " + Math.max(...result.map((r) => sd(r.scores))).toFixed(2));

/** The cut between two neighbouring labels with the most scores on the right side (a threshold search in 0.05 steps). */
const cutBetween = (lo: number, hi: number): { cut: number; accuracy: number } => {
  const a = byLabel(lo);
  const b = byLabel(hi);
  let best = { cut: 0, accuracy: 0 };
  for (let c = 0; c <= 4; c += 0.05) {
    const accuracy = (a.filter((x) => x < c).length + b.filter((x) => x >= c).length) / (a.length + b.length);
    if (accuracy > best.accuracy + 1e-9) best = { cut: Math.round(c * 100) / 100, accuracy };
  }
  return best;
};
console.log("\nbest cut between neighbouring labels:");
const best: number[] = [];
for (let i = 0; i + 1 < labels.length; i++) {
  const c = cutBetween(labels[i], labels[i + 1]);
  best.push(c.cut);
  console.log(`  ${labels[i]}|${labels[i + 1]}: ${c.cut} (accuracy ${(c.accuracy * 100).toFixed(0)}%)`);
}
const levelAccuracy = (cuts: readonly number[]): number => {
  const level = (s: number): number => cuts.filter((c) => s >= c).length;
  const all = result.flatMap((r) => r.scores.map((s) => (level(s) === r.label ? 1 : 0)));
  return all.reduce((a: number, b) => a + b, 0) / all.length;
};
console.log(`\nlevel accuracy with the step-0 cuts ${JSON.stringify(EFFORT_CUTS)}: ${(levelAccuracy(EFFORT_CUTS) * 100).toFixed(0)}%`);
console.log(`level accuracy with the cuts found above ${JSON.stringify(best)}: ${(levelAccuracy(best) * 100).toFixed(0)}%`);
console.log(`(effortLevel(1.05) = ${effortLevel(1.05).toFixed(2)})`);
