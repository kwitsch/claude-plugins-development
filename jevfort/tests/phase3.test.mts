// Phase 3 (prompt classifier, subagent types, compaction) of the built plugin/hooks/*.mjs: upstream jev-pilot
// tests/phase3.test.ts. The pure tests come first; the kit tests follow.
import { expect, test } from "vitest";
import { compactInstructions, compactItems } from "../plugin/hooks/compact.mjs";
import { hints } from "../plugin/hooks/prompt.mjs";

test("hints: a mid-confidence skill and a large task get hints; a confident skill is left to step 0", () => {
  expect(hints("task", 0.9, { name: "aws-diagrams", p: 0.7 }, 0.85)).toHaveLength(2);
  expect(hints("question", 0.9, { name: "aws-diagrams", p: 0.95 }, 0.85)).toHaveLength(0);
  expect(hints("task", 0.2, { name: "none", p: 0.9 }, 0.85)).toHaveLength(0);
});

test("Compaction instructions keep relevant results and mark stale ones", () => {
  const messages = [
    { role: "user", text: "fix the failing date test", toolUses: [] },
    {
      role: "assistant",
      text: "",
      toolUses: [
        { tool_use_id: "t1", tool: "Read", input: { file_path: "/proj/todo.js" }, text: "export function isOverdue…" },
        { tool_use_id: "t2", tool: "Bash", input: { command: "ls" }, text: "a b c" },
        { tool_use_id: "t3", tool: "Bash", input: { command: "npm test" }, text: "not ok 5 - isOverdue" },
      ],
    },
  ];
  const items = compactItems(messages);
  expect(items.map((i) => i.label)).toEqual(["Read /proj/todo.js", "Bash ls", "Bash npm test"]);
  const text = compactInstructions(items, [2.5, 0.2, 2.9]) ?? "";
  expect(text).toContain("Keep exact details (paths, errors, decisions, values) from: Read /proj/todo.js; Bash npm test.");
  expect(text).toContain("dropped: Bash ls.");
});
