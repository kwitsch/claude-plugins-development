// Pure helpers of the graphmind-helper module (built plugin/hooks/terms.mjs).
import assert from "node:assert/strict";
import { test } from "vitest";
import { binaryDirs, fit, isCodePrompt, isRecallable, resolveTools, searchTerms, shouldNudge } from "../plugin/hooks/terms.mjs";

test("searchTerms puts identifiers first and drops stopwords", () => {
  assert.equal(searchTerms("where is parseConfig and foo_bar defined"), "parseconfig foo_bar defined");
});

test("searchTerms keeps a dotted identifier with a camelCase first part (grep -oE leftmost-longest)", () => {
  assert.equal(searchTerms("how does userService.findById work"), "userservice.findbyid userservice findbyid work");
});

test("isRecallable skips short and system-made prompts", () => {
  assert.equal(isRecallable("short"), false);
  assert.equal(isRecallable("<task-notification> something long enough"), false);
  assert.equal(isRecallable("where is foo_bar defined"), true);
});

test("isCodePrompt matches exploration and implementation prompts", () => {
  assert.equal(isCodePrompt("how does the cache work"), true);
  assert.equal(isCodePrompt("thanks, that is fine with me"), false);
});

test("shouldNudge: searches yes, graphmind itself and exhaustive searches no", () => {
  assert.equal(shouldNudge({ tool: "Grep" }), true);
  assert.equal(shouldNudge({ tool: "Bash", command: "cd src && rg foo" }), true);
  assert.equal(shouldNudge({ tool: "Bash", command: "cd src\nrg foo" }), true);
  assert.equal(shouldNudge({ tool: "Bash", command: "graphmind search foo" }), false);
  assert.equal(shouldNudge({ tool: "Bash", command: "cat x | grep foo" }), false);
  assert.equal(shouldNudge({ tool: "Bash", command: "grep -rn foo src", description: "find all usages of foo" }), false);
  assert.equal(shouldNudge({ tool: "Bash", command: "grep -rc foo src" }), false);
  assert.equal(shouldNudge({ tool: "Agent", subagent_type: "Explore" }), true);
  assert.equal(shouldNudge({ tool: "Agent", prompt: "write the docs" }), false);
  assert.equal(shouldNudge({ tool: "Read" }), false);
});

test("fit keeps whole blocks, cuts the one that overflows, and reports the lines that fit", () => {
  const a = fit("", [{ title: "T1", lines: ["one", "two"] }, { title: "T2", lines: [] }, { title: "T3", lines: ["three"] }]);
  assert.equal(a.text, "T1\none\ntwo\n\nT3\nthree\n\n");
  assert.deepEqual([...a.whole], ["one", "two", "three"]);
  const big = fit("", [{ title: "T", lines: ["x".repeat(900)] }], 500);
  assert.match(big.text, /cut to fit the hook output limit/);
  assert.equal(big.whole.size, 0);
});

test("fit counts the lines of a cut block shown before the cut as whole, not the cut one", () => {
  const lines = Array.from({ length: 20 }, (_, i) => `★ aaaaaaa${i} [decision] ${"x".repeat(40)}`);
  const out = fit("", [{ title: "Priority", lines }], 500);
  assert.match(out.text, /cut to fit the hook output limit/);
  const shown = lines.filter((l) => out.text.includes(`${l}\n`));
  assert.ok(shown.length > 0 && shown.length < lines.length);
  assert.deepEqual([...out.whole], shown);
  assert.ok(!out.whole.has(lines[shown.length]));
});

test("fit puts a title-less block in as plain text", () => {
  assert.equal(fit("H\n", [{ title: "", lines: ["footer line"] }]).text, "H\nfooter line\n\n");
});

test("binaryDirs: absolute PATH entries first, then the places the setup scripts add", () => {
  assert.deepEqual(binaryDirs("/a/:rel:/b", "/home/u"), ["/a", "/b", "/home/u/.graphmind/bin", "/home/u/.local/bin", "/usr/local/bin"]);
  assert.deepEqual(binaryDirs(undefined, undefined), ["/usr/local/bin"]);
  assert.deepEqual(binaryDirs("//:/usr/bin", undefined), ["/", "/usr/bin", "/usr/local/bin"]);
});

test("resolveTools finds the plugin's own server and a setup server, and needs all four tools", () => {
  const own = ["status", "map", "memory_list", "search"].map((t) => ({ name: `mcp__plugin_graphmind-helper_graphmind__gm_${t}` }));
  const setup = ["status", "map", "memory_list", "search"].map((t) => ({ name: `mcp__graphmind__gm_${t}` }));
  assert.equal(resolveTools(own)?.status, "mcp__plugin_graphmind-helper_graphmind__gm_status");
  assert.equal(resolveTools(setup)?.search, "mcp__graphmind__gm_search");
  assert.equal(resolveTools([...setup, ...own])?.map, "mcp__plugin_graphmind-helper_graphmind__gm_map");
  assert.equal(resolveTools(own.slice(1)), undefined);
  assert.equal(resolveTools([{ name: "mcp__other__gm_status" }]), undefined);
});
