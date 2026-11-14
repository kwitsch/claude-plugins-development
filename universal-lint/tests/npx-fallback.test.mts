// eslint npx fallback (present/absent), ported from test/universal-lint/npx-fallback.bats; the project-local node_modules/.bin route (F04) and the npx-cache route (F09).
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "vitest";
import { makeEnv } from "./support/lint-hook.mts";
import type { LintEnv } from "./support/lint-hook.mts";

/** Stub line recording the npm_config notice-off vars the spawn received as `env:<update_notifier>,<fund>,<audit>`. */
const ENV_REC = "printf 'env:%s,%s,%s\\n' \"$npm_config_update_notifier\" \"$npm_config_fund\" \"$npm_config_audit\" >> \"$RECORD\"";

/**
 * Drop a recording stub at `<cwd>/<dir>/node_modules/.bin/<name>`: it appends `local:<dir>/<name> <argv>`,
 * `path:<first PATH entry>`, `pwd:<cwd>` and `env:<npm_config_update_notifier>,<npm_config_fund>,<npm_config_audit>` to
 * `$RECORD`, prints `$OUT` and exits with `exit`.
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
      "printf 'pwd:%s\\n' \"$PWD\" >> \"$RECORD\"",
      ENV_REC,
      "printf '%s\\n' \"$OUT\"",
      `exit ${exit}`,
      "",
    ].join("\n"),
  );
  if (executable) chmodSync(p, 0o755);
  return p;
}

/** npm 11.19.1's `_npx` dir name for markdownlint-cli2 (sha512 hex[0:16], verified against ~/.npm/_npx); hard-coded so a wrong hash in the hook fails. */
const KEY = "3c2a9ea6c4b6e0a2";

/** `localStub` dir of the cached bin in the per-test HOME's npm cache (`e.file` resolves against cwd = `<base>/proj`, HOME = `<base>/home`). */
const CACHED = `../home/.npm/_npx/${KEY}`;

/**
 * Create the hook's npx refresh stamp for markdownlint-cli2 in the env's CLAUDE_PLUGIN_DATA, `ageMs` old.
 *
 * @param e - Test environment.
 * @param ageMs - Age of the stamp's mtime in milliseconds.
 * @returns The stamp's absolute path.
 */
function stamp(e: LintEnv, ageMs = 0): string {
  mkdirSync(e.data, { recursive: true });
  const p = path.join(e.data, `npx-refreshed-${KEY}`);
  writeFileSync(p, "");
  const t = new Date(Date.now() - ageMs);
  utimesSync(p, t, t);
  return p;
}

/**
 * The markdownlint-cli2 argv the hook passes for a `.md` file without a project markdownlint config.
 *
 * @param e - Test environment.
 * @param f - Absolute path of the linted file.
 * @returns The space-joined argv.
 */
function mdArgv(e: LintEnv, f: string): string {
  return `--no-globs --config ${path.join(e.data, "markdownlint-no-line-length.json")} :${f}`;
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
  assert.ok(e.lines().includes(`pwd:${e.cwd}`));
  assert.ok(!e.lines().some((l) => l.startsWith("npx")));
});

test("local bin: the nearest node_modules/.bin from the file's dir wins over the cwd one", () => {
  const e = makeEnv();
  e.file(".oxlintrc.json", "{}");
  localStub(e, ".", "oxlint", 0);
  localStub(e, "pkg", "oxlint", 0);
  e.run(e.file("pkg/a.js", "let x = 1;\n"));
  assert.deepEqual(e.lines().filter((l) => l.startsWith("local:")).map((l) => l.split(" ")[0]), ["local:pkg/oxlint"]);
  assert.ok(e.lines().includes(`pwd:${path.join(e.cwd, "pkg")}`));
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

test("local bin: one that cannot spawn (no exec bit) does not block the npx cache route: the cached bin runs, npx never invoked", () => {
  const e = makeEnv();
  e.recStub("npx", 0);
  stamp(e);
  localStub(e, CACHED, "markdownlint-cli2", 1);
  localStub(e, ".", "markdownlint-cli2", 0, false);
  const f = e.file("a.md", "# T\n");
  const r = e.run(f, { out: "cache-marker" });
  assert.match(r.ctx, /cache-marker/);
  assert.ok(e.lines().includes(`local:${CACHED}/markdownlint-cli2 ${mdArgv(e, f)}`));
  assert.ok(!e.lines().some((l) => l.startsWith("npx")));
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

test("npx cache: a cached markdownlint-cli2 bin runs directly (bin dir first on PATH, cwd as npx), npx never invoked; once it is gone npx runs", () => {
  const e = makeEnv();
  e.recStub("npx", 0);
  stamp(e);
  const bin = localStub(e, CACHED, "markdownlint-cli2", 1);
  const f = e.file("a.md", "# T\n");
  const r = e.run(f, { out: "cache-marker" });
  assert.match(r.ctx, /cache-marker/);
  assert.ok(e.lines().includes(`local:${CACHED}/markdownlint-cli2 ${mdArgv(e, f)}`));
  assert.ok(e.lines().includes(`path:${path.join(e.home, ".npm", "_npx", KEY, "node_modules", ".bin")}`));
  assert.ok(e.lines().includes(`pwd:${e.cwd}`));
  assert.ok(!e.lines().some((l) => l.startsWith("npx")));
  rmSync(bin);
  e.run(f);
  assert.ok(e.lines().some((l) => l.includes(`npx --yes markdownlint-cli2 ${mdArgv(e, f)}`)));
});

test("npx cache: cold npm_config_cache -> first run via npx, second run direct", () => {
  const e = makeEnv();
  const base = path.dirname(e.cwd); // makeEnv base dir: holds bin/, home/, data/, proj/ (= cwd)
  const env = { npm_config_cache: path.join(base, "cache") };
  e.recStub("npx", 0);
  const f = e.file("a.md", "# T\n");
  e.run(f, { env });
  /** The recorded `npx --yes markdownlint-cli2` invocations so far. */
  const npx = (): string[] => e.lines().filter((l) => l.startsWith("npx --yes markdownlint-cli2 "));
  assert.equal(npx().length, 1);
  assert.ok(existsSync(path.join(e.data, `npx-refreshed-${KEY}`)));
  assert.equal(existsSync(path.join(base, "cache")), false); // the hook never creates the npm cache root
  localStub(e, `../cache/_npx/${KEY}`, "markdownlint-cli2", 0); // what npx's install leaves
  e.run(f, { env });
  assert.ok(e.lines().includes(`local:../cache/_npx/${KEY}/markdownlint-cli2 ${mdArgv(e, f)}`));
  assert.equal(npx().length, 1);
});

test("npx cache: a refresh stamp older than NPX_REFRESH_MS sends one run through npx, the renewed stamp makes the next run direct", () => {
  const e = makeEnv();
  e.recStub("npx", 0);
  stamp(e, 25 * 60 * 60 * 1000);
  localStub(e, CACHED, "markdownlint-cli2", 0);
  const f = e.file("a.md", "# T\n");
  e.run(f);
  /** The recorded `npx --yes markdownlint-cli2` invocations so far. */
  const npx = (): string[] => e.lines().filter((l) => l.startsWith("npx --yes markdownlint-cli2 "));
  assert.equal(npx().length, 1);
  assert.ok(!e.lines().some((l) => l.startsWith("local:")));
  e.run(f);
  assert.ok(e.lines().includes(`local:${CACHED}/markdownlint-cli2 ${mdArgv(e, f)}`));
  assert.equal(npx().length, 1);
});

test("npx cache: a refresh stamp dated in the future counts as stale -> one run through npx", () => {
  const e = makeEnv();
  e.recStub("npx", 0);
  stamp(e, -60 * 60 * 1000);
  localStub(e, CACHED, "markdownlint-cli2", 0);
  e.run(e.file("a.md", "# T\n"));
  assert.ok(e.lines().some((l) => l.startsWith("npx --yes markdownlint-cli2 ")));
  assert.ok(!e.lines().some((l) => l.startsWith("local:")));
});

test("npx cache: a cached bin that cannot spawn (no exec bit) falls back to npx", () => {
  const e = makeEnv();
  e.recStub("npx", 0);
  stamp(e);
  localStub(e, CACHED, "markdownlint-cli2", 0, false);
  e.run(e.file("a.md", "# T\n"));
  assert.ok(e.lines().some((l) => l.startsWith("npx --yes markdownlint-cli2 ")));
  assert.ok(!e.lines().some((l) => l.startsWith("local:")));
});

test("npx cache: an npx install in progress (concurrency.lock) -> npx, the cached bin never runs", () => {
  const e = makeEnv();
  e.recStub("npx", 0);
  stamp(e);
  localStub(e, CACHED, "markdownlint-cli2", 0);
  mkdirSync(path.join(e.home, ".npm", "_npx", KEY, "concurrency.lock"));
  e.run(e.file("a.md", "# T\n"));
  assert.ok(e.lines().some((l) => l.startsWith("npx --yes markdownlint-cli2 ")));
  assert.ok(!e.lines().some((l) => l.startsWith("local:")));
});

test("npx cache: a node_modules/.bin/<name> above cwd (npx's own lookup runs it first) -> npx, the cached bin never runs", () => {
  const e = makeEnv();
  e.recStub("npx", 0);
  stamp(e);
  localStub(e, CACHED, "markdownlint-cli2", 0);
  localStub(e, "..", "markdownlint-cli2", 0); // the makeEnv base dir above cwd
  e.run(e.file("a.md", "# T\n"));
  assert.ok(e.lines().some((l) => l.startsWith("npx --yes markdownlint-cli2 ")));
  assert.ok(!e.lines().some((l) => l.startsWith("local:")));
});

test("npx env: the bare npx spawn gets the notice-off npm_config vars, so no npm notice reaches the finding", () => {
  const e = makeEnv();
  e.stub(
    "npx",
    "printf \"%s %s\\n\" \"npx\" \"$*\" >> \"$RECORD\"",
    ENV_REC,
    "if [ \"$npm_config_update_notifier\" != \"false\" ]; then printf \"npm notice New major version of npm available\\n\" >&2; fi",
    "printf '%s\\n' \"$OUT\"",
    "exit 1",
  );
  const f = e.file("a.md", "# T\n");
  const r = e.run(f, { out: "a.md:1 MD041 npx-finding-marker" });
  assert.match(r.ctx, /npx-finding-marker/);
  assert.doesNotMatch(r.ctx, /npm notice/);
  assert.ok(e.lines().includes("env:false,false,false"));
  assert.ok(e.lines().some((l) => l.startsWith("npx --yes ")));
});

test("npx env: the cached-bin direct route gets no npm_config vars (env belongs to the npx spawn only)", () => {
  const e = makeEnv();
  e.recStub("npx", 0);
  stamp(e);
  localStub(e, CACHED, "markdownlint-cli2", 0);
  e.run(e.file("a.md", "# T\n"));
  assert.ok(e.lines().some((l) => l.startsWith("local:")));
  assert.ok(e.lines().includes("env:,,"));
  assert.ok(!e.lines().some((l) => l.startsWith("npx")));
});

test("local bin: its relative paths resolve against the package root it ran in (Finding.base), so a same-named cwd file stays apart", () => {
  const e = makeEnv();
  e.file(".oxlintrc.json", "{}");
  e.file("a.js", "x\n");
  localStub(e, "pkg", "oxlint", 1);
  const f = e.file("pkg/a.js", "a\nb\nc\n");
  const patch = [{ oldStart: 1, oldLines: 3, newStart: 1, newLines: 3, lines: ["-z", "+a", " b", " c"] }];
  // pkg/a.js:3 lies outside the edited line 1 -> dropped; resolved against cwd it would be cwd/a.js (foreign, kept).
  assert.equal(e.run(f, { toolName: "Edit", toolResponse: { structuredPatch: patch }, out: "a.js:3:1 far-marker" }).status, 0);
});
