// The docs' kit examples (https://code.claude.com/docs/en/plugins/mods/test.md), ported by changing imports only.
import { expect } from "vitest";
import { createKit } from "../index.mjs";

const mod = (name) => new URL(`./mods/${name}.mjs`, import.meta.url);

{
  const { test } = createKit({ module: mod("tally"), plugin: "first-mod" });
  test("/tally reports the tool calls the mod has seen", async ($, on) => {
    on("tool.call", () => ({ result: "ok" }));
    await $.tool.call({ tool: "Bash", command: "ls" });
    await $.tool.call({ tool: "Read", file_path: "README.md" });
    const answer = await $.command.run({ command: "tally", args: "" });
    expect(answer.text).toBe("Claude has made 2 tool calls since this mod loaded");
  });
  test("each test loads a fresh module", async ($) => {
    expect((await $.command.run({ command: "tally", args: "" })).text).toBe("Claude has made 0 tool calls since this mod loaded");
  });
}

{
  const { test } = createKit({ module: mod("grader"), plugin: "grader" });
  const usage = { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  test("a passing grade is reported", async ($, on) => {
    on("model.complete", () => ({ value: { isAnswered: true, text: "PASS\nNice sentence.", usage } }));
    const answer = await $.command.run({ command: "grade", args: "The cat sat on the mat." });
    expect(answer.text).toBe("Passed");
  });
  test("a failing grade is reported", async ($, on) => {
    on("model.complete", () => ({ value: { isAnswered: true, text: "FAIL", usage } }));
    expect((await $.command.run({ command: "grade", args: "cat mat" })).text).toBe("Try again");
  });
}

{
  const { test, mock } = createKit({ module: mod("countdown"), plugin: "countdown" });
  test("the countdown ends with a toast", async ($, on) => {
    const clock = mock.clock(on);
    const toasts = [];
    on("ui.toast", ($, e) => {
      toasts.push(e.text);
      return { value: undefined };
    });
    await $.command.run({ command: "countdown", args: "3" });
    await clock.advance(2000);
    expect(toasts).toEqual([]);
    await clock.advance(1000);
    expect(toasts).toEqual(["Time is up"]);
    await clock.advance(5000);
    expect(toasts).toEqual(["Time is up"]); // the cancelled timer fires no more
  });
  test("a timer fires exactly on its period boundary, and set moves the clock to a time", async ($, on) => {
    const clock = mock.clock(on, { now: 5000 });
    const toasts = [];
    on("ui.toast", ($, e) => (toasts.push(clock.now()), { value: undefined }));
    await $.command.run({ command: "countdown", args: "1" });
    await clock.advance(999);
    expect(toasts).toEqual([]);
    await clock.set(6000);
    expect(toasts).toEqual([6000]);
  });
}

{
  const { test } = createKit({ module: mod("tabs"), plugin: "hello-tabs" });
  const PANE = {
    plugin: "hello-tabs",
    component: "Pane",
    requestId: "hello-tabs",
    viewport: { columns: 100, rows: 30 },
    props: { title: "Hello tabs", isFocused: true, bodyColumns: 60, placement: "inline", scroll: { offset: 0, bodyRows: 10 }, view: {} },
  };
  test("the second tab counts presses and saves the count", async ($, on) => {
    const saved = new Map();
    on("store.get", ($, e) => ({ value: saved.get(e.key) }));
    on("store.set", ($, e) => {
      saved.set(e.key, e.value);
      return { value: undefined };
    });
    for (const surface of ["terminal", "desktop"]) {
      const ui = await $.ui.mount({ ...PANE, surface });
      await ui.press({ key: "tab-two" });
      await ui.press({ key: "more" });
      expect(await ui.find({ type: "Text", text: /^Count: \d+$/ })).toBeDefined();
      await ui.unmount();
    }
    expect(saved.get("count")).toBe(2);
  });
  test("find matches a string as a substring, findAll lists every match, and pressing a missing key rejects", async ($, on) => {
    on("store.get", () => ({ value: 17 }));
    const ui = await $.ui.mount({ ...PANE, surface: "terminal" });
    await ui.press({ key: "tab-two" });
    expect(await ui.find({ type: "Text", text: "7" })).toMatchObject({ type: "Text", children: ["Count: 17"] });
    expect(await ui.findAll({ type: "Button" })).toHaveLength(3);
    expect(await ui.find({ key: "more" })).toMatchObject({ type: "Button", props: { label: "More" } });
    await expect(ui.press({ key: "nope" })).rejects.toThrow(/no Button with key "nope"/);
  });
}
