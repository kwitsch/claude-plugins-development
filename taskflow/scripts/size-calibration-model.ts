/**
 * Accuracy of the plain model call the `size-task` tool falls back to (dev only, never shipped): the tool's own
 * `MODEL_SYSTEM`, `modelPrompt` and `readModelSize`, with the model called through `claude -p`.
 *
 * `node taskflow/scripts/size-calibration-model.ts <out.jsonl> <model,model> [dev|test|all]`
 *
 * Rows have the shape of `size-calibration-run.ts` (confidence is fixed at 1: a plain answer carries none), so
 * `size-calibration-report.ts` reads them.
 */

import { appendFileSync, writeFileSync } from "node:fs";
import { buildState, MODEL_SYSTEM, modelPrompt, readModelSize } from "../src/hooks/size.ts";
import type { Item } from "./size-calibration-corpus.ts";
import { askClaude, pickItems, pool } from "./size-calibration-lib.ts";

const [out, models = "claude-opus-5-5", split = "all"] = process.argv.slice(2);
if (!out) throw new Error("usage: size-calibration-model.ts <out.jsonl> <models> [dev|test|all]");

async function one(model: string, item: Item): Promise<void> {
  const row: Record<string, unknown> = { variant: model, id: item.id, label: item.label, rep: 0 };
  try {
    const reply = await askClaude(model, MODEL_SYSTEM, modelPrompt(buildState(item.text, item.subs)));
    const size = readModelSize(reply);
    if (!size) throw new Error(`no size in: ${reply.slice(0, 60)}`);
    row["size"] = size;
    row["confidence"] = 1;
  } catch (err) {
    row["error"] = err instanceof Error ? err.message.slice(0, 200) : "failed";
  }
  appendFileSync(out, JSON.stringify(row) + "\n");
}

writeFileSync(out, "");
await pool(models.split(",").flatMap((model) => pickItems(split).map((item) => () => one(model, item))));
console.log(`wrote ${out}`);
