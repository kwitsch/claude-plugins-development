/**
 * Size calibration run (dev only, never shipped): sends each corpus task to System One as the `build-task` size step
 * does and reports accept rate and accuracy per prompt variant.
 *
 * `node taskflow/scripts/size-calibration-run.ts <out.jsonl> <variants,comma> [repeats=1] [split=all|dev|test]
 *
 * Jev answers a fixed request the same way every time (measured), so `repeats` above 1 only costs time.
 *
 * Reads JEV_URL, TYPESAFE_API_KEY, TYPESAFE_BASE_URL, TYPESAFE_DEFAULT_MODEL from the environment; none of them is
 * ever printed or written.
 */

import { appendFileSync, writeFileSync } from "node:fs";
import { sendRequest } from "../../jev-api/src/shared/http.ts";
import { pickItems, pool } from "./size-calibration-lib.ts";
import type { Item } from "./size-calibration-corpus.ts";
import { VARIANTS } from "./size-calibration-variants.ts";

const [out, names = "v0", reps = "1", split = "all"] = process.argv.slice(2);
if (!out) throw new Error("usage: run.ts <out.jsonl> <variants> [repeats] [all|dev|test]");

const env = (k: string): string | undefined => process.env[k]?.trim() || undefined;
const httpEnv = { key: env("TYPESAFE_API_KEY"), base: env("TYPESAFE_BASE_URL"), jevUrl: env("JEV_URL"), model: env("TYPESAFE_DEFAULT_MODEL") };

const doFetch = async (url: string, init: { method: string; headers: Record<string, string>; body: string }): Promise<{ status: number; text: string }> => {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(60_000) });
  return { status: res.status, text: await res.text() };
};

async function one(variant: string, item: Item, rep: number): Promise<void> {
  const v = VARIANTS[variant];
  if (!v) throw new Error(`unknown variant ${variant}`);
  const { state, questions, decide } = v(item);
  const r = await sendRequest(httpEnv, state, questions, doFetch);
  const row: Record<string, unknown> = { variant, id: item.id, label: item.label, rep };
  if (r.kind !== "ok") row["error"] = r.kind === "http" ? `HTTP ${r.status} ${r.reason ?? ""}` : r.message;
  else {
    try {
      const body = JSON.parse(r.text) as unknown;
      const list = Array.isArray(body) ? body : Object.values((body as { answers: Record<string, unknown> }).answers);
      const d = decide(list as Record<string, unknown>[]);
      row["size"] = d.size;
      row["confidence"] = d.confidence;
      row["answers"] = list;
    } catch {
      row["raw"] = Array.from(r.text).slice(0, 300).join("");
    }
  }
  appendFileSync(out, JSON.stringify(row) + "\n");
}

writeFileSync(out, "");
await pool(names.split(",").flatMap((variant) => pickItems(split).flatMap((item) => Array.from({ length: Number(reps) }, (_, rep) => () => one(variant, item, rep)))));
console.log(`wrote ${out}`);
