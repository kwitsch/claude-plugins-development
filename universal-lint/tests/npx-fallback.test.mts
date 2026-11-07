// eslint npx fallback (present/absent), ported from test/universal-lint/npx-fallback.bats; the project-local node_modules/.bin route (F04).
import assert from "node:assert/strict";
import { chmodSync, symlinkSync } from "node:fs";
import path from "node:path";
import { test } from "vitest";
import { makeEnv } from "./support/lint-hook.mts";
import type { LintEnv } from "./support/lint-hook.mts";

/**
 * Drop a recording stub at `<cwd>/<dir>/node_modules/.bin/<name>`: it appends `local:<dir>/<name> <argv>` and
 * `path:<first PATH entry>` to `$RECORD`, prints `$OUT` and exits with `exit`.
 *
 * @param e - Test environment.
 * @param dir - Directory holding `node_modules`, relative to the env's cwd (`..` = the makeEnv base dir above cwd).
 * @param name - Bin name.
 * @param exit - Exit status of the stub.
 * @param executable - Set the exec bit; false makes spawning it fail with EACCES.
 * @returns The stub's absolute path.
 */
function localStub(e: LintEnv, dir: string, name: string, exit: number, executable = true): string {
  const p = e.file(
    path.join(dir, "node_modules", ".bin", name),
    [
      "#!/usr/bin/env bash",
      `printf "%s %s\\n" "local:${dir}/${name}" "$*" >> "$RECORD"`,
      "printf 'path:%s\\n' \"${PATH%%:*}\" >> \"$RECORD\"",
      "printf '%s\\n' \"$OUT\"",
      `exit ${exit}`,
      "",
    ].join("\n"),
  );
  if (executable) chmodSync(p, 0o755);
  return p;
}

test("eslint absent but npx present -> npx --yes eslint fallback runs, issues surfaced", () => {
  const e = makeEnv();
  e.file("eslint.config.mjs", "export default [];\n");
  e.recStub("npx", 1);
  const f = e.file("a.js", "let x = 1\n");
  const r = e.run(f, { out: "a.js: 1:1  error  x is assigned a value but never used  no-unused-vars" });
  assert.match(r.ctx, /no-unused-vars/);
  assert.ok(e.lines().some((l) => l.includes(`npx --yes eslint ${f}`)));
});

test("eslint present on PATH -> npx never invoked even if present", () => {
  const e = makeEnv();
  e.file("eslint.config.mjs", "export default [];\n");
  e.recStub("eslint", 0);
  e.recStub("npx", 0); // present but must not be used
  assert.deepEqual(e.run(e.file("a.js", "let x = 1\n"), { out: "clean" }).result, {});
  assert.ok(e.lines().some((l) => l.startsWith("eslint ")));
  assert.ok(!e.lines().some((l) => l.includes("npx")));
});

test("local bin: oxlint absent from PATH, <cwd>/node_modules/.bin/oxlint runs with its dir first on PATH, npx never invoked", () => {
  const e = makeEnv();
  const cfg = e.file(".oxlintrc.json", "{}");
  e.recStub("npx", 1);
  localStub(e, ".", "oxlint", 1);
  const f = e.file("a.js", "let x = 1;\n");
  const r = e.run(f, { out: "oxlint-local-marker" });
  assert.match(r.ctx, /oxlint-local-marker/);
  assert.ok(e.lines().includes(`local:./oxlint --no-error-on-unmatched-pattern -c ${cfg} ${f}`));
  assert.ok(e.lines().includes(`path:${path.join(e.cwd, "node_modules", ".bin")}`));
  assert.ok(!e.lines().some((l) => l.startsWith("npx")));
});

test("local bin: the nearest node_modules/.bin from the file's dir wins over the cwd one", () => {
  const e = makeEnv();
  e.file(".oxlintrc.json", "{}");
  localStub(e, ".", "oxlint", 0);
  localStub(e, "pkg", "oxlint", 0);
  e.run(e.file("pkg/a.js", "let x = 1;\n"));
  assert.deepEqual(e.lines().filter((l) => l.startsWith("local:")).map((l) => l.split(" ")[0]), ["local:pkg/oxlint"]);
});

test("local bin: keyed by bin name, not package: a local markdownlint (markdownlint-cli) beats npx markdownlint-cli2", () => {
  const e = makeEnv();
  e.recStub("npx", 0);
  localStub(e, ".", "markdownlint", 0);
  e.run(e.file("a.md", "# T\n"));
  assert.ok(e.lines().some((l) => l.startsWith("local:./markdownlint ")));
  assert.ok(!e.lines().some((l) => l.startsWith("npx")));
});

test("local bin: one that cannot spawn (no exec bit) falls back to npx --yes", () => {
  const e = makeEnv();
  e.file(".oxlintrc.json", "{}");
  localStub(e, ".", "oxlint", 1, false);
  e.recStub("npx", 1);
  e.run(e.file("a.js", "let x = 1;\n"));
  assert.ok(e.lines().some((l) => l.includes("npx --yes oxlint")));
  assert.ok(!e.lines().some((l) => l.startsWith("local:")));
});

test("local bin: never above cwd (file reached through a symlinked dir outside cwd) -> npx, the above-cwd bin never runs", () => {
  const e = makeEnv();
  const base = path.dirname(e.cwd); // makeEnv base dir: holds bin/, home/, proj/ (= cwd)
  // Config next to the file: the lexical walk from <base>/link never reaches cwd.
  e.file("sub/.oxlintrc.json", "{}");
  e.file("sub/a.js", "let x = 1;\n");
  symlinkSync(path.join(e.cwd, "sub"), path.join(base, "link"));
  localStub(e, "..", "oxlint", 1);
  e.recStub("npx", 1);
  // Lexically outside cwd, real path inside it, so scopedTarget accepts it.
  e.run(path.join(base, "link", "a.js"));
  assert.ok(e.lines().some((l) => l.includes("npx --yes oxlint")));
  assert.ok(!e.lines().some((l) => l.startsWith("local:")));
});

test("local bin: a chain tool on PATH still wins over a local bin", () => {
  const e = makeEnv();
  e.file(".oxlintrc.json", "{}");
  e.recStub("oxlint", 0);
  localStub(e, ".", "oxlint", 1);
  e.run(e.file("a.js", "let x = 1;\n"));
  assert.ok(e.lines().some((l) => l.startsWith("oxlint ")));
  assert.ok(!e.lines().some((l) => l.startsWith("local:")));
});
