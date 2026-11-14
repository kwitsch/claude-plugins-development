// The /universal-lint:universal-lint skill (SKILL.md + lint-files.mjs); ported from test/universal-lint/skill.bats.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, readdirSync, readFileSync, realpathSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "vitest";
import { DRIVER, makeEnv } from "./support/lint-hook.mts";

const SKILL = path.dirname(DRIVER);
const skillMd = readFileSync(path.join(SKILL, "SKILL.md"), "utf8");
const frontmatter = /^---\n([\s\S]*?)\n---/.exec(skillMd)?.[1] ?? "";

/** Every file below the skill dir, as text. */
const skillFiles = readdirSync(SKILL, { recursive: true, withFileTypes: true })
  .filter((d) => d.isFile())
  .map((d) => path.join(d.parentPath, d.name));

/** Run the driver on `paths` from the env's project dir. */
function driver(e: ReturnType<typeof makeEnv>, paths: string[], out = "") {
  const list = path.join(path.dirname(e.cwd), "list");
  writeFileSync(list, paths.join("\n") + "\n");
  return spawnSync(process.execPath, [DRIVER, list], { cwd: e.cwd, env: e.childEnv({ out }), encoding: "utf8" });
}

test("SKILL.md exists and is non-empty", () => {
  assert.ok(statSync(path.join(SKILL, "SKILL.md")).size > 0);
});

test("SKILL.md frontmatter: user-only, arguments file_scope, scoped allowed-tools (no bare Bash)", () => {
  assert.match(frontmatter, /disable-model-invocation: true/);
  assert.match(frontmatter, /arguments: file_scope/);
  assert.ok(frontmatter.includes("\"Glob\""));
  assert.ok(frontmatter.includes("\"AskUserQuestion\""));
  assert.ok(frontmatter.includes("\"Bash(git:*)\""));
  assert.ok(!frontmatter.includes("\"Bash\""));
});

test("SKILL.md points at the reference doc and invokes the driver via the literal token", () => {
  assert.ok(skillMd.includes("lint-files.reference.md"));
  assert.ok(skillMd.includes("${CLAUDE_SKILL_DIR}/lint-files.mjs"));
});

test("SKILL.md makes repo-root-relative git/gh paths resolvable from a subdirectory cwd", () => {
  assert.ok(skillMd.includes("git diff --relative --name-only"));
  assert.ok(skillMd.includes("$(git rev-parse --show-toplevel)/"));
  assert.doesNotMatch(skillMd, /git diff --name-only/);
});

test("SKILL.md writes the list as a new file in a mktemp -d directory (Write refuses an unread existing file)", () => {
  assert.ok(skillMd.includes("`mktemp -d`"));
  assert.ok(skillMd.includes("<dir>/list.txt"));
  assert.doesNotMatch(skillMd, /unique path with `mktemp`/);
});

test("SKILL.md never writes the exclamation-mark-then-backtick injection sequence", () => {
  assert.ok(!skillMd.includes("!" + "`"));
});

test("driver and its reference are colocated at the skill root", () => {
  assert.ok(existsSync(path.join(SKILL, "lint-files.mjs")));
  assert.ok(existsSync(path.join(SKILL, "lint-files.reference.md")));
});

test("skill dir is self-contained (no cross-plugin references)", () => {
  for (const f of skillFiles) assert.doesNotMatch(readFileSync(f, "utf8"), /universal-format|coding-toolbox|taskflow/i, f);
});

test("driver never invokes a fix/format/write path (read-only)", () => {
  assert.doesNotMatch(readFileSync(DRIVER, "utf8"), /--fix|--format|--write/i);
});

test("lint-files.mjs reports an aggregated finding for a supported file", () => {
  const e = makeEnv();
  e.recStub("shellcheck", 1);
  const r = driver(e, [e.file("a.sh", "echo $1\n")], "a.sh:1:6: note: Double quote to prevent globbing. [SC2086]");
  assert.equal(r.status, 0);
  assert.match(r.stdout, /SC2086/);
  assert.match(r.stdout, /universal-lint:/);
});

test("lint-files.mjs prints no-findings for a clean file", () => {
  const e = makeEnv();
  e.recStub("shellcheck", 0);
  const r = driver(e, [e.file("a.sh", "echo hi\n")], "no problems");
  assert.equal(r.status, 0);
  assert.match(r.stdout, /no findings/);
});

test("lint-files.mjs skips an unsupported extension (.json): no findings, linter never invoked", () => {
  const e = makeEnv();
  e.recStub("shellcheck", 1);
  const r = driver(e, [e.file("a.json", "{\"a\":1}\n")], "x");
  assert.equal(r.status, 0);
  assert.match(r.stdout, /no findings/);
  assert.deepEqual(e.lines(), []);
});

test("lint-files.mjs exits 2 with no listfile argument", () => {
  const e = makeEnv();
  const r = spawnSync(process.execPath, [DRIVER], { env: e.childEnv(), encoding: "utf8" });
  assert.equal(r.status, 2);
});

test("lint-files.mjs runs one linter call for three files", () => {
  const e = makeEnv();
  e.recStub("shellcheck", 1);
  const a = e.file("a.sh", "echo $1\n");
  const b = e.file("b.sh", "echo $1\n");
  const c = e.file("c.sh", "echo $1\n");
  const json = e.file("d.json", "{\"a\":1}\n");
  const outsider = path.join(path.dirname(e.cwd), "outside.sh");
  writeFileSync(outsider, "echo $1\n");
  const r = driver(e, [a, b, json, c, outsider], "a.sh:1:6: note: Double quote to prevent globbing. [SC2086]");
  assert.equal(r.status, 0);
  const calls = e.lines();
  assert.equal(calls.length, 1);
  assert.ok(calls[0].startsWith("shellcheck "), calls[0]);
  for (const f of [a, b, c]) assert.ok(calls[0].includes(f), calls[0]);
  assert.ok(!calls[0].includes(json), calls[0]);
  assert.ok(!calls[0].includes(outsider), calls[0]);
  assert.ok(r.stdout.includes("shellcheck found issues in a.sh, b.sh, c.sh:"), r.stdout);
  assert.equal(r.stdout.split("found issues in").length - 1, 1, r.stdout);
  assert.match(r.stdout, /universal-lint: 1 block\(s\) with findings\./);
});

test("lint-files.mjs runs tsc once per tsconfig", () => {
  const e = makeEnv();
  const TSCONFIG = "{\"compilerOptions\":{\"noEmit\":true},\"include\":[\"*.ts\"]}";
  e.file("p1/tsconfig.json", TSCONFIG);
  e.file("p2/tsconfig.json", TSCONFIG);
  const a = e.file("p1/a.ts", "const x: number = 1;\n");
  const b = e.file("p1/b.ts", "const y: number = 1;\n");
  const c = e.file("p2/c.ts", "const z: number = 1;\n");
  // p1's project has one diagnostic (exit 2 = issues), p2's is clean.
  e.stub("tsc", "printf \"%s %s\\n\" tsc \"$*\" >> \"$RECORD\"", "case \"$*\" in *p1/tsconfig.json*) echo 'p1/a.ts(1,1): error TS2322: x'; exit 2;; esac", "exit 0");
  const r = driver(e, [a, b, c]);
  assert.equal(r.status, 0);
  const calls = e.lines().filter((l) => l.startsWith("tsc "));
  assert.equal(calls.length, 2, calls.join("\n"));
  assert.equal(calls.filter((l) => /-p \S*\/p1\/tsconfig\.json$/.test(l)).length, 1, calls.join("\n"));
  assert.equal(calls.filter((l) => /-p \S*\/p2\/tsconfig\.json$/.test(l)).length, 1, calls.join("\n"));
  assert.equal(r.stdout.split("tsc found issues in p1:").length - 1, 1, r.stdout);
  assert.equal(r.stdout.split("p1/a.ts(1,1): error TS2322: x").length - 1, 1, r.stdout);
  assert.ok(!r.stdout.includes("found issues in p2"), r.stdout);
  assert.match(r.stdout, /universal-lint: 1 block\(s\) with findings\./);
});

test("lint-files.mjs reruns files singly when the batch run is a skip", () => {
  const e = makeEnv();
  e.recStub("shellcheck", 2);
  const files = [e.file("a.sh", "echo hi\n"), e.file("b.sh", "echo hi\n"), e.file("c.sh", "echo hi\n")];
  const r = driver(e, files, "bad invocation");
  assert.equal(r.status, 0);
  const calls = e.lines();
  assert.equal(calls.length, 4, calls.join("\n"));
  for (const f of files) assert.ok(calls[0].includes(f), calls[0]);
  files.forEach((f, i) => {
    const line = calls[i + 1];
    assert.ok(line.includes(f), line);
    assert.equal(files.filter((g) => line.includes(g)).length, 1, line);
  });
  assert.match(r.stdout, /no findings/);
});

test("lint-files.mjs reruns files singly when the batch run is killed", () => {
  const e = makeEnv();
  e.stub("shellcheck", "printf \"%s %s\\n\" shellcheck \"$*\" >> \"$RECORD\"", "if [ $# -gt 1 ]; then kill -KILL $$; fi", "printf '%s\\n' \"$OUT\"", "exit 1");
  const files = [e.file("a.sh", "echo hi\n"), e.file("b.sh", "echo hi\n"), e.file("c.sh", "echo hi\n")];
  const r = driver(e, files, "a.sh:1:6: note: x [SC2086]");
  assert.equal(r.status, 0);
  const calls = e.lines();
  assert.equal(calls.length, 4, calls.join("\n"));
  for (const f of files) assert.ok(calls[0].includes(f), calls[0]);
  files.forEach((f, i) => {
    const line = calls[i + 1];
    assert.ok(line.includes(f), line);
    assert.equal(files.filter((g) => line.includes(g)).length, 1, line);
  });
  assert.match(r.stdout, /universal-lint: 3 block\(s\) with findings\./);
  assert.ok(r.stdout.includes("shellcheck found issues in a.sh:"), r.stdout);
});

test("lint-files.mjs caps a batched block per file, not per run", () => {
  const e = makeEnv();
  e.recStub("shellcheck", 1);
  const files = [e.file("a.sh", "echo hi\n"), e.file("b.sh", "echo hi\n"), e.file("c.sh", "echo hi\n")];
  const out = Array.from({ length: 200 }, (_, i) => `a.sh:${i + 1}:1: note: x [SC2086]`).join("\n");
  const r = driver(e, files, out);
  assert.equal(r.status, 0);
  assert.ok(r.stdout.includes("a.sh:200:1:"), r.stdout);
  assert.ok(!r.stdout.includes("(truncated)"), r.stdout);
  const single = driver(e, [files[0]], out);
  assert.ok(single.stdout.includes("… (truncated)"), single.stdout);
});

test("lint-files.mjs splits a tool's files into one run per argv prefix (markdownlint config vs none)", () => {
  const e = makeEnv();
  e.file("d1/.markdownlint.json", "{}\n");
  const withConfig = e.file("d1/x.md", "# x\n");
  const without = e.file("a.md", "# a\n");
  e.recStub("markdownlint-cli2", 0);
  const r = driver(e, [withConfig, without]);
  assert.equal(r.status, 0);
  const calls = e.lines().filter((l) => l.startsWith("markdownlint-cli2 "));
  assert.equal(calls.length, 2, calls.join("\n"));
  assert.equal(calls.filter((l) => l.includes(withConfig) && !l.includes(without) && !l.includes("--config")).length, 1, calls.join("\n"));
  assert.equal(calls.filter((l) => l.includes(without) && !l.includes(withConfig) && l.includes("--config")).length, 1, calls.join("\n"));
  assert.match(r.stdout, /no findings/);
});

test("lint-files.mjs finds a project-local linter through a symlinked cwd ($PWD keeps the link)", () => {
  const e = makeEnv();
  const link = path.join(path.dirname(e.cwd), "link");
  symlinkSync(e.cwd, link);
  e.file(".oxlintrc.json", "{}\n");
  e.file("a.ts", "export const x = 1;\n");
  const bin = e.file("node_modules/.bin/oxlint", "#!/usr/bin/env bash\nprintf 'oxlint %s\\n' \"$*\" >> \"$RECORD\"\necho 'a.ts:1:1 warning: x'\nexit 1\n");
  chmodSync(bin, 0o755);
  const list = path.join(path.dirname(e.cwd), "list");
  writeFileSync(list, path.join(link, "a.ts") + "\n");
  const r = spawnSync(process.execPath, [DRIVER, list], { cwd: link, env: { ...e.childEnv(), PWD: link }, encoding: "utf8" });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /oxlint found issues/, r.stdout);
  assert.equal(e.lines().filter((l) => l.startsWith("oxlint ")).length, 1);
});

test("lint-files.mjs finds a project-local linter for a real-path entry through a symlinked cwd (git toplevel prefix)", () => {
  const e = makeEnv();
  const link = path.join(path.dirname(e.cwd), "link");
  symlinkSync(e.cwd, link);
  e.file("eslint.config.js", "export default [];\n");
  const real = e.file("a.js", "var x = 1;\n");
  const bin = e.file("node_modules/.bin/eslint", "#!/usr/bin/env bash\nprintf 'eslint %s\\n' \"$*\" >> \"$RECORD\"\necho 'a.js:1:5 error no-var'\nexit 1\n");
  chmodSync(bin, 0o755);
  const list = path.join(path.dirname(e.cwd), "list");
  writeFileSync(list, realpathSync(real) + "\n");
  const r = spawnSync(process.execPath, [DRIVER, list], { cwd: link, env: { ...e.childEnv(), PWD: link }, encoding: "utf8" });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /eslint found issues/, r.stdout);
  assert.equal(e.lines().filter((l) => l.startsWith("eslint ")).length, 1);
});
