/**
 * Size calibration against the Haiku fallback of jev-api (dev only, never shipped): the same corpus and variants as
 * `size-calibration-run.ts`, answered by `claude -p` with the fallback's own system prompt, with the same answer
 * rebuilding as jev-api's `checkAnswer` (choice probabilities normalised to sum 1).
 *
 * `node taskflow/scripts/size-calibration-haiku.ts <out.jsonl> <variants,comma> [dev|test|all]`
 *
 * The system prompt and model are read from `jev-api/src/hooks/haiku.ts` by pattern, because that module imports its
 * siblings as `./util.js` and Node's type stripping cannot load it; a changed template literal there fails the run
 * loudly instead of measuring a stale copy.
 */

import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import type { Item } from "./size-calibration-corpus.ts";
import { askClaude, pickItems, pool } from "./size-calibration-lib.ts";
import { VARIANTS } from "./size-calibration-variants.ts";

const [out, names = "c8", split = "all"] = process.argv.slice(2);
if (!out) throw new Error("usage: size-calibration-haiku.ts <out.jsonl> <variants> [dev|test|all]");

const source = readFileSync(new URL("../../jev-api/src/hooks/haiku.ts", import.meta.url), "utf8");
const system = /HAIKU_SYSTEM = `([^`]*)`/.exec(source)?.[1];
const model = /HAIKU_MODEL = "([^"]*)"/.exec(source)?.[1];
if (!system || !model) throw new Error("HAIKU_SYSTEM or HAIKU_MODEL not found in haiku.ts");

/**
 * jev-api's `checkAnswer` for a choice: the answer must name an option and give every option a probability; the
 * probabilities are normalised to sum 1.
 *
 * @param options - The option names.
 * @param a - The answer Haiku gave.
 * @returns The rebuilt answer, or undefined when it does not fit.
 */
function rebuild(options: string[], a: Record<string, unknown>): Record<string, unknown> | undefined {
  const probs = a["probabilities"] as Record<string, number> | undefined;
  const conf = a["confidence"];
  // jev-api's checkAnswer wants a confidence in 0..1 too
  if (typeof conf !== "number" || !(conf >= 0 && conf <= 1)) return undefined;
  if (a["type"] !== "choice" || typeof a["choice"] !== "string" || !options.includes(a["choice"]) || !probs) return undefined;
  const raw = options.map((o) => probs[o]);
  if (raw.some((p) => typeof p !== "number" || !(p >= 0 && p <= 1))) return undefined;
  const sum = raw.reduce((t, p) => t + p, 0);
  if (!(sum > 0)) return undefined;
  return { type: "choice", choice: a["choice"], confidence: conf, probabilities: Object.fromEntries(options.map((o, i) => [o, Math.round((raw[i] / sum) * 10000) / 10000])) };
}

async function one(variant: string, item: Item): Promise<void> {
  const v = VARIANTS[variant];
  if (!v) throw new Error(`unknown variant ${variant}`);
  const { state, questions, decide } = v(item);
  // rebuild() knows the choice answer only; a score variant (v0) would turn every valid answer into an error row
  if ((questions["q0"] as { type: string }).type !== "choice") throw new Error(`${variant}: this script handles choice variants only`);
  const row: Record<string, unknown> = { variant, id: item.id, label: item.label, rep: 0 };
  try {
    const reply = await askClaude(model as string, system as string, `Text:\n${state}\n\nQuestions (JSON):\n${JSON.stringify(questions)}`);
    const body = JSON.parse(reply.trim().replace(/^```(?:json)?\s*/i, "").replace(/```$/, "")) as { answers: Record<string, Record<string, unknown>> };
    const q0 = questions["q0"] as { criteria: Record<string, string> };
    const answer = rebuild(Object.keys(q0.criteria), body.answers["q0"]);
    if (!answer) throw new Error("no valid answer");
    const d = decide([answer]);
    row["size"] = d.size;
    row["confidence"] = d.confidence;
    row["answers"] = [answer];
  } catch (err) {
    row["error"] = err instanceof Error ? err.message.slice(0, 200) : "failed";
  }
  appendFileSync(out, JSON.stringify(row) + "\n");
}

writeFileSync(out, "");
await pool(names.split(",").flatMap((variant) => pickItems(split).map((item) => () => one(variant, item))));
console.log(`wrote ${out}`);
