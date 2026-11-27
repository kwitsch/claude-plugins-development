// Shared test kit of the size-task mod: the kit bound to src/hooks/register.ts (unit layer; the built register.js is covered by claude-tests/).
import { createKit } from "claude-engine-vitest";
import { SIZES } from "../../src/hooks/size.ts";

/** The kit: `test` runs a test against a fake engine, `mock` stubs the engine calls most tests share. */
export const { test, mock } = createKit({ module: new URL("../../src/hooks/register.ts", import.meta.url), plugin: "taskflow" });

/** The test's `$` (the kit does not export its type). */
export type Runner = Parameters<Parameters<typeof test>[2]>[0];

/** The full name of the tool. */
export const SIZE_TASK = "mcp__taskflow__size-task";

/** The full name of jev-api's tool. */
export const JEV_REQUEST = "mcp__jev-api__request";

/**
 * jev-api's result text for one choice answer.
 *
 * @param choice - The option chosen.
 * @param probability - Its probability; the other three share the rest.
 * @returns The JSON array jev-api answers with.
 */
export function jevAnswer(choice: string, probability: number): string {
  const rest = (1 - probability) / 3;
  const probabilities = Object.fromEntries(SIZES.map((s) => [s, s === choice ? probability : rest]));
  return JSON.stringify([{ type: "choice", choice, confidence: probability / 2, probabilities }]);
}
