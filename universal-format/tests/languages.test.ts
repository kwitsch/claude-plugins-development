// Every language through the spawned server (`format_pre` over JSON-RPC), one sandbox and one server per case, as
// Claude Code calls it. The prettier languages need no stub: the bundled prettier is in-process. The CLI languages
// (Kotlin, Python, Go, Rust) run stub formatters on the sandbox's PATH.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, test } from "vitest";
import { cleanup, type Sandbox, sandbox } from "./support/mcp.ts";
import type { HookOut } from "./support/plugin.ts";

afterEach(cleanup);

/** One Write through `format_pre`. */
interface Case {
  /** Test name. */
  name: string;
  /** The written file, relative to the project dir. */
  file: string;
  /** The content of the Write. */
  content: string;
  /** Files that exist in the project before the call, by relative path. */
  project?: Record<string, string>;
  /** Stub executables on PATH: a name alone is a recording stub, a tuple is `[name, ...body lines]`. */
  stubs?: (string | [string, ...string[]])[];
  /** The expected `updatedInput.content`, a predicate on it, or null for a `{}` answer. */
  expect: string | null | ((content: string) => boolean);
  /** The expected record of the stubs (`$P` stands for the project dir); not checked when absent. */
  record?: string;
  /** What the notice must match. */
  notice?: RegExp[];
}

const CSS = ".a {\n  color: red;\n}\n";
const HTML_IN = "<div>   <p>hi</p>   </div>";
const HTML = "<div><p>hi</p></div>\n";
const VUE_IN = "<template><p>hi</p></template>\n\n<script setup>\nlet x=1\n</script>";
const VUE = "<template><p>hi</p></template>\n\n<script setup>\nlet x = 1;\n</script>\n";
// 40 numbers are far wider than 80 columns: prettier's default wraps them, an unbounded printWidth does not
const LONG_JSON = JSON.stringify([...Array(40).keys()]);
// the spaces after `a:` make the formatted text differ from the input even when nothing wraps
const LONG_YAML = `a:   [${[...Array(30).keys()].join(", ")}]\n`;
const oneLine = (c: string): boolean => c.split("\n").length === 2;
const wrapped = (c: string): boolean => c.split("\n").length > 2;
const EC_WIDTH = (n: number): string => `root = true\n[*]\nmax_line_length = ${n}\n`;

const CASES: Case[] = [
  // the prettier languages: in-process, a formatter or package runner on PATH is never run
  { name: "css: formatted by the bundled prettier", file: "a.css", content: ".a{color:red}\n", expect: CSS },
  { name: "scss: formatted by the bundled prettier", file: "a.scss", content: ".a{color:red}\n", expect: CSS },
  { name: "scss: prettier and npx stubs on PATH are never run", file: "a.scss", content: ".a{color:red}\n", stubs: ["prettier", "npx"], expect: CSS, record: "" },
  { name: "less: formatted by the bundled prettier", file: "a.less", content: "@c:  red;\n.a{color:@c}\n", expect: "@c: red;\n.a {\n  color: @c;\n}\n" },
  { name: "graphql: a .graphql file", file: "a.graphql", content: "query   Q {  a }", expect: "query Q {\n  a\n}\n" },
  { name: "graphql: a .gql file", file: "a.gql", content: "query   Q {  a }", expect: "query Q {\n  a\n}\n" },
  { name: "html: an .html file", file: "a.html", content: HTML_IN, expect: HTML },
  { name: "html: an .htm file", file: "a.htm", content: HTML_IN, expect: HTML },
  { name: "html: prettier and npx stubs on PATH are never run", file: "a.html", content: HTML_IN, stubs: ["prettier", "npx"], expect: HTML, record: "" },
  { name: "java: formatted by the bundled plugin (its wasm files load)", file: "A.java", content: "class A {  }", expect: "class A {}\n" },
  { name: "java: google-java-format and clang-format stubs on PATH are never run", file: "A.java", content: "class A {  }", stubs: ["google-java-format", "clang-format"], expect: "class A {}\n", record: "" },
  { name: "json: formatted by the bundled prettier", file: "a.json", content: "{\"a\":1}", expect: "{ \"a\": 1 }\n" },
  { name: "json: no project prettier config -> the long array is not wrapped", file: "a.json", content: LONG_JSON, expect: oneLine },
  { name: "json: a top-level prettier key in package.json -> prettier's default wraps the long array", file: "a.json", content: LONG_JSON, project: { "package.json": "{\"prettier\": {}}" }, expect: wrapped },
  { name: "json: an .editorconfig path-glob section sets max_line_length -> prettier's width stays, the array wraps", file: "a.json", content: LONG_JSON, project: { ".editorconfig": "root = true\n[**/*.json]\nmax_line_length = 40\n" }, expect: wrapped },
  { name: "jsts: a .ts file, no prettier and no npx anywhere on PATH", file: "a.ts", content: "let x=1", expect: "let x = 1;\n" },
  { name: "jsts: prettier and npx stubs on PATH are never run", file: "a.js", content: "let x=1", stubs: ["prettier", "npx"], expect: "let x = 1;\n", record: "" },
  { name: "markdown: formatted by the bundled prettier", file: "a.md", content: "#  hi\n", expect: "# hi\n" },
  { name: "php: formatted by the bundled plugin", file: "a.php", content: "<?php  echo \"hi\";", expect: "<?php echo \"hi\";\n" },
  { name: "php: a php-cs-fixer stub on PATH is never run", file: "a.php", content: "<?php  echo \"hi\";", stubs: ["php-cs-fixer"], expect: "<?php echo \"hi\";\n", record: "" },
  { name: "shell: a .sh file", file: "a.sh", content: "echo  hi", expect: "echo hi\n" },
  { name: "shell: a .bash file", file: "a.bash", content: "echo  hi", expect: "echo hi\n" },
  { name: "shell: a shfmt stub on PATH is never run", file: "a.sh", content: "echo  hi", stubs: ["shfmt"], expect: "echo hi\n", record: "" },
  { name: "vue: a single-file component", file: "a.vue", content: VUE_IN, expect: VUE },
  { name: "vue: prettier and npx stubs on PATH are never run", file: "a.vue", content: VUE_IN, stubs: ["prettier", "npx"], expect: VUE, record: "" },
  { name: "yaml: a .yaml file", file: "a.yaml", content: "a:   1\n", expect: "a: 1\n" },
  { name: "yaml: a .yml file", file: "a.yml", content: "a:   1\n", expect: "a: 1\n" },
  { name: "yaml: no project prettier config -> the long flow sequence is not wrapped", file: "a.yaml", content: LONG_YAML, expect: oneLine },
  { name: "yaml: a project .prettierrc -> prettier's default wraps the long flow sequence", file: "a.yaml", content: LONG_YAML, project: { ".prettierrc": "{}\n" }, expect: wrapped },
  { name: "yaml: .editorconfig max_line_length -> prettier honors it and wraps", file: "a.yaml", content: LONG_YAML, project: { ".editorconfig": EC_WIDTH(40) }, expect: wrapped },

  // the CLI languages: the content goes to the tool on stdin, its stdout comes back
  {
    name: "go: gofmt gets the content on stdin, its stdout becomes updatedInput, the notice names tool and file",
    file: "a.go",
    content: "package main",
    stubs: ["gofmt"],
    expect: "reformatted-by-gofmt\n",
    record: "gofmt \n",
    notice: [/gofmt reformatted a\.go/, /exempt from .surgical\/minimal-diff. change-scope rules/],
  },
  { name: "go: no formatter on PATH -> {}", file: "a.go", content: "package main", expect: null },
  { name: "a non-target extension (.txt) -> {}, no formatter run", file: "a.txt", content: "hi", stubs: ["gofmt"], expect: null, record: "" },
  { name: "node_modules path -> {}, no formatter run", file: "node_modules/x/a.go", content: "package main", stubs: ["gofmt"], expect: null, record: "" },
  { name: "node_modules path of a prettier language -> {}", file: "node_modules/x/a.json", content: "{\"a\":1}", expect: null },
  { name: ".claude/worktrees path -> {}, no formatter run", file: ".claude/worktrees/foo/a.go", content: "package main", stubs: ["gofmt"], expect: null, record: "" },
  { name: ".claude/agent-memory path -> {}", file: ".claude/agent-memory/a.md", content: "#  hi", expect: null },
  { name: "a *.local.* file -> {}, no formatter run", file: "settings.local.go", content: "package main", stubs: ["gofmt"], expect: null, record: "" },
  { name: ".claude/rules path (neither worktrees nor agent-memory) -> still formatted", file: ".claude/rules/a.go", content: "package main", stubs: ["gofmt"], expect: "reformatted-by-gofmt\n", record: "gofmt \n" },
  { name: "the formatter exits non-zero -> {} although it printed something", file: "a.go", content: "package main", stubs: [["gofmt", "cat >/dev/null", "printf 'partial\\n'", "exit 2"]], expect: null },
  { name: "the formatter exits 0 with empty stdout -> {} (an empty result is never written)", file: "a.go", content: "package main", stubs: [["gofmt", "cat >/dev/null", "exit 0"]], expect: null },
  { name: "the formatter's output equals the input -> {} (the content diff decides)", file: "a.go", content: "package main", stubs: [["gofmt", "cat"]], expect: null },
  { name: ".prettierignore opts a prettier language out", file: "a.json", content: "{\"a\":1}", project: { ".prettierignore": "a.json\na.go\n" }, expect: null },
  { name: ".prettierignore never opts a CLI language out", file: "a.go", content: "package main", project: { ".prettierignore": "a.json\na.go\n" }, stubs: ["gofmt"], expect: "reformatted-by-gofmt\n" },
  {
    name: "kotlin: ktlint exits 1 (violations it cannot fix remain) with the formatted file on stdout -> applied",
    file: "a.kt",
    content: "fun main(){}",
    stubs: [["ktlint", "printf '%s %s\\n' ktlint \"$*\" >> \"$RECORD\"", "cat >/dev/null", "printf 'reformatted\\n'", "exit 1"]],
    expect: "reformatted\n",
    record: "ktlint --format --log-level=none --stdin --stdin-path $P/a.kt\n",
    notice: [/ktlint reformatted a\.kt/],
  },
  { name: "kotlin: ktlint exits 0 with empty stdout (its syntax-error shape) -> {}", file: "a.kt", content: "fun main(", stubs: [["ktlint", "cat >/dev/null", "exit 0"]], expect: null },
  { name: "kotlin: ktfmt (ktlint absent) gets --stdin-name=<file> and reads stdin via -", file: "a.kts", content: "fun main(){}", stubs: ["ktfmt"], expect: "reformatted-by-ktfmt\n", record: "ktfmt --enable-editorconfig --quiet --stdin-name=$P/a.kts -\n" },
  {
    name: "python: pyproject [tool.ruff] beats .editorconfig -> ruff runs bare (no --line-length)",
    file: "a.py",
    content: "x=1",
    project: { "pyproject.toml": "[tool.ruff]\nline-length = 79\n", ".editorconfig": EC_WIDTH(88) },
    stubs: ["ruff"],
    expect: "reformatted-by-ruff\n",
    record: "ruff format --quiet --stdin-filename $P/a.py -\n",
  },
  { name: "python: .editorconfig only -> ruff gets --line-length, then the stdin tail", file: "a.py", content: "x=1", project: { ".editorconfig": EC_WIDTH(88) }, stubs: ["ruff"], expect: "reformatted-by-ruff\n", record: "ruff format --quiet --line-length 88 --stdin-filename $P/a.py -\n" },
  {
    name: "python: black (ruff absent) exits 123 echoing the input -> {} (only exit 0 is trusted)",
    file: "a.py",
    content: "def f(:",
    stubs: [["black", "printf '%s %s\\n' black \"$*\" >> \"$RECORD\"", "cat", "exit 123"]],
    expect: null,
    record: "black --quiet --stdin-filename $P/a.py -\n",
  },
  {
    name: "rust: no config -> rustfmt runs bare on stdin, in the file's directory",
    file: "src/a.rs",
    content: "fn main(){}",
    stubs: [["rustfmt", "printf '%s %s %s\\n' rustfmt \"$*\" \"$PWD\" >> \"$RECORD\"", "cat >/dev/null", "printf 'reformatted\\n'"]],
    expect: "reformatted\n",
    record: "rustfmt  $P/src\n",
  },
  { name: "rust: rustfmt.toml present -> no --config is passed", file: "a.rs", content: "fn main(){}", project: { "rustfmt.toml": "max_width = 100\n", ".editorconfig": EC_WIDTH(120) }, stubs: ["rustfmt"], expect: "reformatted-by-rustfmt\n", record: "rustfmt \n" },
  { name: "rust: rustfmt absent -> {}", file: "a.rs", content: "fn main(){}", expect: null, record: "" },
  { name: "rust: rustfmt exits 1 -> {} although it printed output", file: "a.rs", content: "fn main(){}", stubs: [["rustfmt", "cat >/dev/null", "printf 'garbage\\n'", "exit 1"]], expect: null },
  { name: "rust: .editorconfig max_line_length -> rustfmt gets --config max_width", file: "a.rs", content: "fn main(){}", project: { ".editorconfig": EC_WIDTH(120) }, stubs: ["rustfmt"], expect: "reformatted-by-rustfmt\n", record: "rustfmt --config max_width=120\n" },
  { name: "rust: the crate's Cargo.toml edition is passed as --edition", file: "src/a.rs", content: "async fn main(){}", project: { "Cargo.toml": "[package]\nname = \"x\"\nedition = \"2021\"\n" }, stubs: ["rustfmt"], expect: "reformatted-by-rustfmt\n", record: "rustfmt --edition 2021\n" },
];

/**
 * Puts a case's stubs on the sandbox's PATH.
 *
 * @param s - The sandbox.
 * @param stubs - The case's stubs.
 */
function addStubs(s: Sandbox, stubs: Case["stubs"] = []): void {
  for (const stub of stubs) {
    if (typeof stub === "string") s.recStub(stub);
    else s.stub(stub[0], stub.slice(1));
  }
}

/**
 * Checks what every formatted answer must hold: the event name, and never a permission decision.
 *
 * @param out - The hook result.
 */
function assertShape(out: HookOut): void {
  assert.equal(out.hookSpecificOutput.hookEventName, "PreToolUse");
  assert.equal("permissionDecision" in out.hookSpecificOutput, false, "format_pre must never set permissionDecision");
}

for (const c of CASES) {
  test(c.name, async () => {
    const s = sandbox();
    for (const [rel, text] of Object.entries(c.project ?? {})) writeFileSync(path.join(s.proj, rel), text);
    addStubs(s, c.stubs);
    const file = path.join(s.proj, c.file);
    mkdirSync(path.dirname(file), { recursive: true });
    const out = await s.server().write(file, c.content);
    if (c.expect === null) assert.deepEqual(out, {});
    else {
      assertShape(out);
      const { content, file_path } = out.hookSpecificOutput.updatedInput;
      assert.equal(file_path, file);
      if (typeof c.expect === "string") assert.equal(content, c.expect);
      else assert.ok(c.expect(content), `unexpected content: ${JSON.stringify(content)}`);
      for (const re of c.notice ?? []) assert.match(out.hookSpecificOutput.additionalContext, re);
    }
    if (c.record !== undefined) assert.equal(s.recorded(), c.record.replaceAll("$P", s.proj));
    assert.equal(existsSync(file), false, "the hook never writes the file itself");
  });
}

test("go: gofmt runs when only gofmt is on PATH; goimports wins when both are and gets the file via -srcdir", async () => {
  const s = sandbox();
  const file = path.join(s.proj, "a.go");
  s.recStub("gofmt");
  assert.equal((await s.server().write(file, "package main")).hookSpecificOutput.updatedInput.content, "reformatted-by-gofmt\n");
  assert.equal(s.recorded(), "gofmt \n", "no flags at all: gofmt reads stdin when given no file");
  s.recStub("goimports");
  // a fresh server: the PATH lookup of a tool is cached for the life of the process
  assert.equal((await s.server().write(file, "package main")).hookSpecificOutput.updatedInput.content, "reformatted-by-goimports\n");
  assert.equal(s.recorded(), `gofmt \ngoimports -srcdir ${file}\n`);
});

test("a formatter found only in ~/.local/bin is used: the directory is appended to PATH", async () => {
  const s = sandbox();
  s.stub("gofmt", ["cat >/dev/null", "printf 'from-local-bin\\n'"], path.join(s.home, ".local", "bin"));
  assert.equal((await s.server().write(path.join(s.proj, "a.go"), "package main")).hookSpecificOutput.updatedInput.content, "from-local-bin\n");
});

test("a tool on the inherited PATH wins over one in ~/.local/bin", async () => {
  const s = sandbox();
  s.stub("gofmt", ["cat >/dev/null", "printf 'from-local-bin\\n'"], path.join(s.home, ".local", "bin"));
  s.recStub("gofmt");
  assert.equal((await s.server().write(path.join(s.proj, "a.go"), "package main")).hookSpecificOutput.updatedInput.content, "reformatted-by-gofmt\n");
});

test("Edit of a CLI-language file: the merged file goes through the formatter, only the changed run of lines is swapped", async () => {
  const s = sandbox();
  const file = path.join(s.proj, "a.go");
  const before = "package main\n\nfunc a() {}\n\nfunc b() {}\n";
  writeFileSync(file, before);
  // a "formatter" that fixes exactly the edited line
  s.stub("gofmt", ["while IFS= read -r l; do printf '%s\\n' \"${l//x:=1/x := 1}\"; done"]);
  const out = await s.server().edit(file, "func a() {}", "func a() { x:=1 }");
  assertShape(out);
  assert.deepEqual(out.hookSpecificOutput.updatedInput, { file_path: file, old_string: "func a() {}\n", new_string: "func a() { x := 1 }\n", replace_all: false });
  assert.match(out.hookSpecificOutput.additionalContext, /gofmt reformatted a\.go/);
  assert.equal(readFileSync(file, "utf8"), before, "the hook never touches the file itself");
});

test("Edit with replace_all as the string \"true\" (the hooks.json template substitutes text) replaces every occurrence", async () => {
  const s = sandbox();
  const file = path.join(s.proj, "a.json");
  writeFileSync(file, "{ \"a\": 1, \"b\": 1 }\n");
  const args = (replace_all: unknown) => ({ cwd: s.proj, tool_name: "Edit", tool_input: { file_path: file, old_string: "1", new_string: "2  ", replace_all } });
  const server = s.server();
  for (const all of ["true", true]) {
    assert.deepEqual((await server.call(args(all))).hookSpecificOutput.updatedInput, { file_path: file, old_string: "{ \"a\": 1, \"b\": 1 }\n", new_string: "{ \"a\": 2, \"b\": 2 }\n", replace_all: false });
  }
  // without replace_all the old_string is not unique: the original Edit proceeds and reports it
  for (const all of ["false", false, ""]) assert.deepEqual(await server.call(args(all)), {});
});

test("a path outside the cwd is formatted against its own project (CLI language), named absolutely in the notice", async () => {
  const s = sandbox();
  const outside = path.join(s.root, "outside");
  mkdirSync(outside);
  s.recStub("gofmt");
  const out = await s.server().write(path.join(outside, "a.go"), "package main");
  assert.equal(out.hookSpecificOutput.updatedInput.content, "reformatted-by-gofmt\n");
  assert.ok(out.hookSpecificOutput.additionalContext.includes(`gofmt reformatted ${path.join(outside, "a.go")}`));
  assert.equal(s.recorded(), "gofmt \n");
});

test("a path outside the cwd is formatted against its own project (prettier language)", async () => {
  const s = sandbox();
  const outside = path.join(s.root, "outside");
  mkdirSync(outside);
  assert.equal((await s.server().write(path.join(outside, "a.json"), "{\"a\":1}")).hookSpecificOutput.updatedInput.content, "{ \"a\": 1 }\n");
});

test("an absent cwd with an absolute path is still formatted", async () => {
  const s = sandbox();
  assert.equal((await s.server().write(path.join(s.proj, "a.json"), "{\"a\":1}", "")).hookSpecificOutput.updatedInput.content, "{ \"a\": 1 }\n");
});
