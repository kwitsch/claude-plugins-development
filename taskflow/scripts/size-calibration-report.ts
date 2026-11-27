/**
 * Summarises run.ts output: per variant accept rate, accuracy of the accepted, accuracy overall, undersizing and a
 * confidence/accuracy table.
 *
 * `[THRESHOLD=0.6] node taskflow/scripts/size-calibration-report.ts <out.jsonl> [more.jsonl ...]` (accept threshold: the shipped one by default; failed requests count against the rates)
 */

import { readFileSync } from "node:fs";
import { MIN_PROBABILITY, SIZES } from "../src/hooks/size.ts";

type Row = { variant: string; id: string; label: string; rep: number; size?: string; confidence?: number; error?: string };
const idx = (s: string): number => (SIZES as readonly string[]).indexOf(s);
const THRESHOLD = Number(process.env["THRESHOLD"] ?? MIN_PROBABILITY);
const rows: Row[] = process.argv.slice(2).flatMap((f) => readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Row));
const pct = (n: number, d: number): string => (d ? `${((100 * n) / d).toFixed(0)}%` : "-");

for (const variant of [...new Set(rows.map((r) => r.variant))]) {
  const all = rows.filter((r) => r.variant === variant);
  const ok = all.filter((r) => typeof r.size === "string" && typeof r.confidence === "number");
  const size = (r: Row): number => idx(r.size as string);
  const acc = ok.filter((r) => r.confidence! >= THRESHOLD);
  const exact = (rs: Row[]): number => rs.filter((r) => size(r) === idx(r.label)).length;
  const near = (rs: Row[]): number => rs.filter((r) => Math.abs(size(r) - idx(r.label)) <= 1).length;
  const under = (rs: Row[]): number => rs.filter((r) => size(r) < idx(r.label)).length;
  const meanConf = ok.reduce((t, r) => t + r.confidence!, 0) / (ok.length || 1);
  console.log(`${variant}: n=${all.length} errors=${all.length - ok.length} accept=${pct(acc.length, all.length)} meanConf=${meanConf.toFixed(2)}`);
  console.log(`  accepted: exact ${pct(exact(acc), acc.length)} within1 ${pct(near(acc), acc.length)} under ${under(acc)}/${acc.length}`);
  console.log(`  all:      exact ${pct(exact(ok), all.length)} within1 ${pct(near(ok), all.length)} under ${under(ok)}/${all.length}`);
  for (const l of SIZES) {
    const g = all.filter((r) => r.label === l);
    const a = g.filter((r) => typeof r.confidence === "number" && r.confidence >= THRESHOLD);
    console.log(`  ${l.padEnd(2)} accept ${pct(a.length, g.length).padStart(4)} exact ${pct(exact(g), g.length).padStart(4)}`);
  }
  console.log("  rows=label, cols=answer S M L XL (all / accepted)");
  for (const l of SIZES) {
    const cell = (rs: Row[], a: string): number => rs.filter((r) => r.label === l && r.size === a).length;
    console.log(`  ${l.padEnd(2)} ${SIZES.map((a) => `${cell(ok, a)}/${cell(acc, a)}`.padStart(6)).join("")}`);
  }
  for (const [lo, hi] of [[0, 0.4], [0.4, 0.5], [0.5, 0.6], [0.6, 0.8], [0.8, 1.01]] as const) {
    const g = ok.filter((r) => r.confidence! >= lo && r.confidence! < hi);
    console.log(`  conf ${lo}-${Math.min(hi, 1)}: n=${g.length} exact ${pct(exact(g), g.length)}`);
  }
}
