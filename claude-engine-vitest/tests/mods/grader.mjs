// The grader example of the docs: /grade asks a model and reports PASS or FAIL.
export function register(on) {
  on("command.run", { command: "grade" }, async ($, e) => {
    const reply = await $.model.complete({ model: "haiku", system: "Grade the sentence. Start your reply with PASS or FAIL.", prompt: e.args });
    const passed = reply.isAnswered && reply.text.startsWith("PASS");
    return { text: passed ? "Passed" : "Try again" };
  });
}
