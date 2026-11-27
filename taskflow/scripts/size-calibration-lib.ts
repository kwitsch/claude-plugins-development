/**
 * What the size calibration scripts share (dev only, never shipped): the item split, a worker pool and the `claude -p`
 * call.
 */

import { execFile } from "node:child_process";
import { TEST } from "./size-calibration-corpus-test.ts";
import { CORPUS } from "./size-calibration-corpus.ts";
import type { Item } from "./size-calibration-corpus.ts";

/**
 * The tasks of a split: `dev` is the tuning set (corpus.ts), `test` the held-out set (corpus-test.ts).
 *
 * @param split - `dev`, `test` or anything else for both.
 * @returns The tasks.
 */
export function pickItems(split: string): Item[] {
  return split === "dev" ? CORPUS : split === "test" ? TEST : [...CORPUS, ...TEST];
}

/**
 * Runs jobs with a fixed number of workers.
 *
 * @param jobs - The jobs; the array is consumed.
 * @param workers - How many run at once.
 */
export async function pool(jobs: (() => Promise<void>)[], workers = 4): Promise<void> {
  const work = async (): Promise<void> => {
    for (let job = jobs.shift(); job; job = jobs.shift()) await job();
  };
  await Promise.all(Array.from({ length: workers }, work));
}

/**
 * One plain model call through `claude -p` (no tools, no settings, no session).
 *
 * @param model - The model id.
 * @param system - The system prompt.
 * @param prompt - The prompt, sent on stdin.
 * @returns The model's reply text.
 */
export function askClaude(model: string, system: string, prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile("claude", ["-p", "--model", model, "--tools", "", "--no-session-persistence", "--disable-slash-commands", "--setting-sources", "", "--system-prompt", system], { timeout: 120_000, maxBuffer: 1 << 24 }, (err: Error | null, stdout: string) => (err ? reject(new Error(err.message)) : resolve(stdout)));
    child.stdin?.end(prompt);
  });
}
