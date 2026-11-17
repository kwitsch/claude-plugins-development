// Kit tests for the built plugin/hooks/register.mjs of rc-enhancement: the interaction gate.
import { createKit } from "claude-engine-vitest";
import type { On } from "claude-engine-vitest";
import { expect } from "vitest";

const { test, mock } = createKit({ module: new URL("../plugin/hooks/register.mjs", import.meta.url), plugin: "rc-enhancement" });

// Stands for the engine's turn and prompt chains; records every prompt the plugin submitted.
function stubTurns(on: On): string[] {
  const prompts: string[] = [];
  on("turn.start", async (_$, e) => ({ turnId: e.turnId }));
  on("turn.complete", async () => ({ text: "" }));
  on("prompt.submit", async (_$, e) => {
    prompts.push(String(e.text));
    return { value: undefined };
  });
  return prompts;
}

const done = (turnId: string, answer: string, agentId?: string) => ({
  answer,
  durationMs: 1,
  isAborted: false,
  turnId,
  reason: "answer" as const,
  ...(agentId === undefined ? {} : { agentId }),
});

test("a main-loop answer ending in a bare question gets exactly one gate prompt that points at the session rule; the gate's own turn is never gated", async ($, on) => {
  const clock = mock.clock(on);
  const prompts = stubTurns(on);
  await $.turn.start({ text: "do it", turnId: "t1" });
  await $.turn.complete(done("t1", "Done.\n```\nwhy?\n```\nWant me to X or Y?"));
  await clock.settle();
  expect(prompts).toHaveLength(1);
  expect(prompts[0]).toContain("AskUserQuestion");
  expect(prompts[0]).toContain("CRITICAL RULE");
  await $.turn.start({ text: `The rc-enhancement plugin sent a message: ${prompts[0]}`, turnId: "t2" });
  await $.turn.complete(done("t2", "Still asking?"));
  await clock.settle();
  expect(prompts).toHaveLength(1);
});

test("the loop guard holds even when the gate turn's prompt text does not carry the reason", async ($, on) => {
  const clock = mock.clock(on);
  const prompts = stubTurns(on);
  await $.turn.start({ text: "do it", turnId: "t1" });
  await $.turn.complete(done("t1", "Shall I?"));
  await clock.settle();
  await $.turn.start({ text: "", turnId: "t2" }); // the gate's turn, framed beyond recognition
  await $.turn.complete(done("t2", "Still asking?"));
  await clock.settle();
  expect(prompts).toHaveLength(1);
  await $.turn.start({ text: "next request", turnId: "t3" }); // a new user turn is gated again
  await $.turn.complete(done("t3", "Which one?"));
  await clock.settle();
  expect(prompts).toHaveLength(2);
});

const quiet = [
  ["a plain answer", "All done. Summary above."],
  ["an empty answer", ""],
  ["a question inside a code fence", "Result:\n```\nwhat?\n```"],
  ["a question that is not the last line", "Is it?\nYes, it is."],
] as const;

for (const [name, answer] of quiet) {
  test(`no gate prompt for ${name}`, async ($, on) => {
    const clock = mock.clock(on);
    const prompts = stubTurns(on);
    await $.turn.start({ text: "do it", turnId: "t1" });
    await $.turn.complete(done("t1", answer));
    await clock.settle();
    expect(prompts).toEqual([]);
  });
}

test("no gate prompt for a subagent's question or a turn that did not end with an answer", async ($, on) => {
  const clock = mock.clock(on);
  const prompts = stubTurns(on);
  await $.turn.start({ text: "do it", turnId: "t1" });
  await $.turn.complete(done("a-t1", "Which file?", "a1"));
  await $.turn.complete({ ...done("t1", "Which file?"), reason: "aborted" as const });
  await $.turn.complete({ ...done("t1", "Which file?"), reason: "error" as const });
  await clock.settle();
  expect(prompts).toEqual([]);
});

test("a failed submit clears the pending exemption, so the next user turn is gated again", async ($, on) => {
  const clock = mock.clock(on);
  const prompts: string[] = [];
  on("turn.start", async (_$, e) => ({ turnId: e.turnId }));
  on("turn.complete", async () => ({ text: "" }));
  let fail = true;
  on("prompt.submit", async (_$, e) => {
    prompts.push(String(e.text));
    return fail ? { deny: "refused" } : { value: undefined };
  });
  await $.turn.start({ text: "do it", turnId: "t1" });
  await $.turn.complete(done("t1", "Shall I?"));
  await clock.settle();
  fail = false;
  await $.turn.start({ text: "next request", turnId: "t2" });
  await $.turn.complete(done("t2", "Which one?"));
  await clock.settle();
  expect(prompts).toHaveLength(2);
});
