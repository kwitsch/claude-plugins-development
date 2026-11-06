// The grader example of the docs: /grade asks a model and reports PASS or FAIL.
import type { On } from "../../index.mts";

export function register(on: On) {
  on("command.run", { command: "grade" }, async ($, e) => {
    // the shape the tests' model.complete stub answers
    const reply = (await $.model.complete({ model: "haiku", system: "Grade the sentence. Start your reply with PASS or FAIL.", prompt: e.args })) as { isAnswered: boolean; text: string };
    const passed = reply.isAnswered && reply.text.startsWith("PASS");
    return { text: passed ? "Passed" : "Try again" };
  });
}
