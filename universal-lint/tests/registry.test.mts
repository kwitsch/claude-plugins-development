// Unit tests of the exports of the built plugin/hooks/lint-file.mjs (ported from test/universal-lint/registry.test.mjs).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import type { SpawnSyncReturns } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "vitest";
import { acquireSlot, buildArgv, classifyCheckstyleOutput, classifyExit, coalesceProjectCheck, configExists, editRanges, FILE_CHANGED_SLOTS, gateFinding, hashPath, hasProjectMarkdownlintConfig, hasProjectYamllintConfig, isExcludedPath, isToolAvailable, lintFileHandler, lintFilesHandler, looksLikeSolutionStyleTsconfig, oxlintConfigTypeChecks, recordWritten, REGISTRY, resolveCargoManifest, resolveCheckstyleConfig, resolveLintTarget, resolveOxlintConfig, resolveTsconfig, scopedTarget, stripTrailingCommas, truncate, tsBuildInfoPathFor, tscOutputHasSourceDiagnostic, WATCH_LIMIT } from "../plugin/hooks/lint-file.mjs";

// The handler tests below call lintFileHandler in this process: report findings at once, no settle window (F34).
process.env.UNIVERSAL_LINT_SETTLE_MS = "0";

const shellcheck = REGISTRY.shell.chain[0];
const checkstyle = REGISTRY.java.chain[0];
const ruff = REGISTRY.python.chain[0];
const golangciLint = REGISTRY.go.chain[0];
const goVet = REGISTRY.go.chain[1];

test("REGISTRY: chain of 1 for five languages, chain of 2 for go", () => {
  assert.equal(REGISTRY.shell.chain.length, 1);
  assert.equal(REGISTRY.java.chain.length, 1);
  assert.equal(REGISTRY.kotlin.chain.length, 1);
  assert.equal(REGISTRY.jsts.chain.length, 1);
  assert.equal(REGISTRY.python.chain.length, 1);
  assert.equal(REGISTRY.go.chain.length, 2);
  assert.equal(golangciLint.name, "golangci-lint");
  assert.equal(goVet.name, "go");
});

test("no chain entry ever carries a --fix/--format/--write-equivalent flag", () => {
  const banned = /^--?(fix|format|write|replace)$/i;
  for (const lang of Object.values(REGISTRY)) {
    for (const tool of lang.chain) {
      assert.ok(
        tool.args.every((a) => !banned.test(a)),
        `${tool.name} args ${JSON.stringify(tool.args)} contain a fix/format flag`,
      );
    }
  }
});

test("buildArgv: plain tool appends the resolved file last", () => {
  assert.deepEqual(buildArgv(shellcheck, "/proj/a.sh", "/proj"), ["/proj/a.sh"]);
});

test("buildArgv: ruff check keeps its subcommand before the file", () => {
  assert.deepEqual(buildArgv(ruff, "/proj/a.py", "/proj"), ["check", "/proj/a.py"]);
});

test("buildArgv: go entries target the directory, not the file", () => {
  assert.deepEqual(buildArgv(goVet, "/proj/pkg/a.go", "/proj"), ["vet", "/proj/pkg"]);
  assert.deepEqual(buildArgv(golangciLint, "/proj/pkg/a.go", "/proj"), ["run", "/proj/pkg"]);
});

test("buildArgv: checkstyle injects -c <resolved config> before the file", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "ul-cs-"));
  assert.deepEqual(buildArgv(checkstyle, path.join(dir, "A.java"), dir), ["-c", "/google_checks.xml", path.join(dir, "A.java")]);
});

test("resolveCheckstyleConfig: finds checkstyle.xml walking up to cwd", () => {
  const root = mkdtempSync(path.join(tmpdir(), "ul-cs-"));
  writeFileSync(path.join(root, "checkstyle.xml"), "<module name=\"Checker\"/>");
  const sub = path.join(root, "src", "main");
  mkdirSync(sub, { recursive: true });
  assert.equal(resolveCheckstyleConfig(sub, root), path.join(root, "checkstyle.xml"));
});

test("resolveCheckstyleConfig: finds config/checkstyle/checkstyle.xml", () => {
  const root = mkdtempSync(path.join(tmpdir(), "ul-cs-"));
  mkdirSync(path.join(root, "config", "checkstyle"), { recursive: true });
  writeFileSync(path.join(root, "config", "checkstyle", "checkstyle.xml"), "<module name=\"Checker\"/>");
  assert.equal(resolveCheckstyleConfig(root, root), path.join(root, "config", "checkstyle", "checkstyle.xml"));
});

test("resolveCheckstyleConfig: nothing found -> null", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "ul-cs-"));
  assert.equal(resolveCheckstyleConfig(dir, dir), null);
});

test("classifyExit: shellcheck/ktlint/eslint/oxlint/ruff/golangci-lint/yamllint/markdownlint-cli2/markdownlint share the 0-clean/1-issues/else-skip contract", () => {
  for (const name of ["shellcheck", "ktlint", "eslint", "oxlint", "ruff", "golangci-lint", "yamllint", "markdownlint-cli2", "markdownlint"]) {
    assert.equal(classifyExit(name, 0), "clean");
    assert.equal(classifyExit(name, 1), "issues");
    assert.equal(classifyExit(name, 2), "skip");
  }
});

test("classifyExit: go (go vet) is clean-vs-nonzero only, no skip bucket", () => {
  assert.equal(classifyExit("go", 0), "clean");
  assert.equal(classifyExit("go", 1), "issues");
  assert.equal(classifyExit("go", 2), "issues");
});

test("classifyExit: null status (signal-killed) always skips, any tool", () => {
  assert.equal(classifyExit("eslint", null), "skip");
  assert.equal(classifyExit("go", null), "skip");
});

test("classifyExit: unknown tool name skips", () => {
  assert.equal(classifyExit("mystery-tool", 0), "skip");
});

test("classifyCheckstyleOutput: boilerplate only -> clean", () => {
  const r = classifyCheckstyleOutput("Starting audit...\nAudit done.\n");
  assert.equal(r.status, "clean");
  assert.equal(r.text, "");
});

test("classifyCheckstyleOutput: boilerplate + violation lines -> issues (exit-code-independent)", () => {
  const r = classifyCheckstyleOutput("Starting audit...\n[WARN] /proj/A.java:3: Missing a Javadoc comment. [JavadocType]\nAudit done.\n");
  assert.equal(r.status, "issues");
  assert.match(r.text, /JavadocType/);
});

test("classifyCheckstyleOutput: no trailing 'Audit done.' -> skip (crash/misconfig)", () => {
  const r = classifyCheckstyleOutput("Exception in thread \"main\" java.lang.RuntimeException\n");
  assert.equal(r.status, "skip");
});

test("truncate: short text passes through unchanged (trimmed)", () => {
  assert.equal(truncate("  hello\n"), "hello");
});

test("truncate: collapses 3+ blank lines to 1", () => {
  assert.equal(truncate("a\n\n\n\nb"), "a\n\nb");
});

test("truncate: caps at MAX_CONTEXT_CHARS and marks truncation", () => {
  const long = "x".repeat(5000);
  const out = truncate(long);
  assert.ok(out.length < long.length);
  assert.ok(out.endsWith("… (truncated)"));
});

test("REGISTRY: npmSpec carried by eslint (jsts) and both markdown tools; not by yaml/shell/java/kotlin/python/go", () => {
  assert.equal(REGISTRY.jsts.chain[0].npmSpec, "eslint");
  assert.equal(REGISTRY.markdown.chain[0].npmSpec, "markdownlint-cli2");
  assert.equal(REGISTRY.markdown.chain[1].npmSpec, "markdownlint-cli");
  for (const lang of ["shell", "java", "kotlin", "python", "go", "yaml", "rust"]) {
    for (const tool of REGISTRY[lang].chain) {
      assert.equal(tool.npmSpec, undefined);
    }
  }
});

test("REGISTRY: chain of 1 for yaml (yamllint), chain of 2 for markdown (cli2 -> cli); no json entry", () => {
  assert.equal(REGISTRY.yaml.chain.length, 1);
  assert.equal(REGISTRY.yaml.chain[0].name, "yamllint");
  assert.equal(REGISTRY.markdown.chain.length, 2);
  assert.equal(REGISTRY.markdown.chain[0].name, "markdownlint-cli2");
  assert.equal(REGISTRY.markdown.chain[1].name, "markdownlint");
  assert.equal(REGISTRY.json, undefined);
});

test("isToolAvailable: true when the tool itself is on PATH", () => {
  assert.equal(isToolAvailable({ name: "shellcheck", args: [] }, true, false), true);
  assert.equal(isToolAvailable({ name: "eslint", args: [], npmSpec: "eslint" }, true, false), true);
});

test("isToolAvailable: true via npx only when npmSpec is set and npx is on PATH", () => {
  assert.equal(isToolAvailable({ name: "eslint", args: [], npmSpec: "eslint" }, false, true), true);
  assert.equal(isToolAvailable({ name: "eslint", args: [], npmSpec: "eslint" }, false, false), false);
  assert.equal(isToolAvailable({ name: "shellcheck", args: [] }, false, true), false);
});

test("REGISTRY: css chain of 1 (stylelint), carries npmSpec", () => {
  assert.equal(REGISTRY.css.chain.length, 1);
  assert.equal(REGISTRY.css.chain[0].name, "stylelint");
  assert.equal(REGISTRY.css.chain[0].npmSpec, "stylelint");
});

test("classifyExit: stylelint is 0-clean/2-issues/else-skip (NOT the shared 0/1/else contract)", () => {
  assert.equal(classifyExit("stylelint", 0), "clean");
  assert.equal(classifyExit("stylelint", 1), "skip");
  assert.equal(classifyExit("stylelint", 2), "issues");
  assert.equal(classifyExit("stylelint", 64), "skip");
  assert.equal(classifyExit("stylelint", 78), "skip");
});

test("classifyExit: tsc is 0-clean/1-or-2-issues/else-skip (empirically verified across both tsc v6.0.3 and TypeScript 7.0's native compiler)", () => {
  assert.equal(classifyExit("tsc", 0), "clean");
  assert.equal(classifyExit("tsc", 1), "issues");
  assert.equal(classifyExit("tsc", 2), "issues");
  assert.equal(classifyExit("tsc", 64), "skip");
});

test("tscOutputHasSourceDiagnostic: true for a real diagnostic anchored to a .ts/.tsx/.mts/.cts location", () => {
  assert.equal(tscOutputHasSourceDiagnostic("a.ts(1,1): error TS2322: bad"), true);
  assert.equal(tscOutputHasSourceDiagnostic("src/a.tsx:1:1 - error TS2322: bad"), true);
  assert.equal(tscOutputHasSourceDiagnostic("a.mts(1,1): error TS2322: bad"), true);
  assert.equal(tscOutputHasSourceDiagnostic("a.cts:1:1 - error TS2322: bad"), true);
});

test("tscOutputHasSourceDiagnostic: false for a pure project/config-loading failure (no source-file location)", () => {
  assert.equal(tscOutputHasSourceDiagnostic("error TS5083: Cannot read file '/proj/missing-base.json'."), false);
  assert.equal(tscOutputHasSourceDiagnostic("error TS5058: The specified path does not exist: '/proj/tsconfig.json'."), false);
  assert.equal(tscOutputHasSourceDiagnostic("tsconfig.json(1,44): error TS6046: invalid --target value"), false);
});

test("tscOutputHasSourceDiagnostic: true when a config failure and a real diagnostic are both present", () => {
  const combined = "error TS5083: Cannot read file '/proj/missing-base.json'.\na.ts(1,1): error TS2322: bad";
  assert.equal(tscOutputHasSourceDiagnostic(combined), true);
});

test("tscOutputHasSourceDiagnostic: matches through ANSI color codes (real tsc output is colorized even when piped)", () => {
  const colorized = "\x1b[96ma.ts\x1b[0m:\x1b[93m1\x1b[0m:\x1b[93m7\x1b[0m - \x1b[91merror\x1b[0m TS2322: bad";
  assert.equal(tscOutputHasSourceDiagnostic(colorized), true);
});

test("resolveTsconfig: finds tsconfig.json walking up to cwd", () => {
  const root = mkdtempSync(path.join(tmpdir(), "ul-ts-"));
  writeFileSync(path.join(root, "tsconfig.json"), "{\"compilerOptions\":{},\"include\":[\"*.ts\"]}");
  const sub = path.join(root, "src");
  mkdirSync(sub, { recursive: true });
  assert.equal(resolveTsconfig(sub, root), path.join(root, "tsconfig.json"));
});

test("resolveTsconfig: nothing found -> null", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "ul-ts-"));
  assert.equal(resolveTsconfig(dir, dir), null);
});

test("resolveTsconfig: solution-style tsconfig (references, no files/include) is skipped, keeps walking, -> null when nothing else found", () => {
  const root = mkdtempSync(path.join(tmpdir(), "ul-ts-"));
  writeFileSync(path.join(root, "tsconfig.json"), "{\"files\":[],\"references\":[{\"path\":\"./pkg\"}]}");
  const sub = path.join(root, "src");
  mkdirSync(sub, { recursive: true });
  assert.equal(resolveTsconfig(sub, root), null);
});

test("resolveTsconfig: solution-style nearer file is skipped in favor of a real one further up", () => {
  const root = mkdtempSync(path.join(tmpdir(), "ul-ts-"));
  writeFileSync(path.join(root, "tsconfig.json"), "{\"compilerOptions\":{},\"include\":[\"**/*.ts\"]}");
  const sub = path.join(root, "pkg");
  mkdirSync(sub, { recursive: true });
  writeFileSync(path.join(sub, "tsconfig.json"), "{\"files\":[],\"references\":[{\"path\":\"./other\"}]}");
  assert.equal(resolveTsconfig(sub, root), path.join(root, "tsconfig.json"));
});

test("resolveTsconfig: unreadable tsconfig.json (a directory of that name -> EISDIR) is treated as absent, walk continues upward", () => {
  const root = mkdtempSync(path.join(tmpdir(), "ul-ts-"));
  writeFileSync(path.join(root, "tsconfig.json"), "{\"compilerOptions\":{},\"include\":[\"*.ts\"]}");
  const sub = path.join(root, "pkg");
  // a directory named tsconfig.json: existsSync -> true, readFileSync -> EISDIR
  mkdirSync(path.join(sub, "tsconfig.json"), { recursive: true });
  assert.equal(resolveTsconfig(sub, root), path.join(root, "tsconfig.json"));
});

test("looksLikeSolutionStyleTsconfig: references with no files/include -> true", () => {
  assert.equal(looksLikeSolutionStyleTsconfig("{\n  \"files\": [],\n  \"references\": [{\"path\": \"./pkg\"}]\n}"), true);
});

test("looksLikeSolutionStyleTsconfig: references alongside include -> false", () => {
  assert.equal(looksLikeSolutionStyleTsconfig("{\n  \"include\": [\"src/**/*.ts\"],\n  \"references\": [{\"path\": \"./pkg\"}]\n}"), false);
});

test("looksLikeSolutionStyleTsconfig: no references at all -> false", () => {
  assert.equal(looksLikeSolutionStyleTsconfig("{\n  \"compilerOptions\": {}\n}"), false);
});

test("looksLikeSolutionStyleTsconfig: a // comment mentioning the literal '\"references\":' text doesn't misclassify a normal default-discovery config (no include/files at all)", () => {
  assert.equal(looksLikeSolutionStyleTsconfig("{\n  // mentions \"references\": here for docs, not a real key\n  \"compilerOptions\": {}\n}"), false);
});

test("looksLikeSolutionStyleTsconfig: a /* */ comment mentioning the literal '\"references\":' text doesn't misclassify a normal default-discovery config", () => {
  assert.equal(looksLikeSolutionStyleTsconfig("{\n  /* mentions \"references\": here for docs */\n  \"compilerOptions\": {}\n}"), false);
});

test("looksLikeSolutionStyleTsconfig: a genuine solution-style config with an unrelated comment is still detected", () => {
  assert.equal(looksLikeSolutionStyleTsconfig("{\n  // solution file, compiles nothing directly\n  \"files\": [],\n  \"references\": [{\"path\": \"./pkg\"}]\n}"), true);
});

test("looksLikeSolutionStyleTsconfig: a string value containing // is not misread as a comment start (files array entry survives stripping)", () => {
  assert.equal(
    looksLikeSolutionStyleTsconfig("{\n  \"files\": [\"http://example/a.ts\"],\n  \"references\": [{\"path\": \"./pkg\"}]\n}"),
    false, // files has a real non-empty entry -> not solution-style
  );
});

test("tsBuildInfoPathFor: stable for the same tsconfig path, differs for a different one", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "ul-ts-"));
  const a = path.join(dir, "tsconfig.json");
  writeFileSync(a, "{}");
  const p1 = tsBuildInfoPathFor(a);
  const p2 = tsBuildInfoPathFor(a);
  assert.equal(p1, p2);
  const otherDir = mkdtempSync(path.join(tmpdir(), "ul-ts-"));
  const b = path.join(otherDir, "tsconfig.json");
  writeFileSync(b, "{}");
  assert.notEqual(p1, tsBuildInfoPathFor(b));
});

test("tsBuildInfoPathFor: respects CLAUDE_PLUGIN_DATA when set", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "ul-ts-"));
  const tsconfig = path.join(dir, "tsconfig.json");
  writeFileSync(tsconfig, "{}");
  const dataDir = mkdtempSync(path.join(tmpdir(), "ul-data-"));
  const prev = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = dataDir;
  try {
    const p = tsBuildInfoPathFor(tsconfig);
    assert.ok(p.startsWith(dataDir));
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
    else process.env.CLAUDE_PLUGIN_DATA = prev;
  }
});

test("tsBuildInfoPathFor: falls back to the OS temp dir (not cwd/'.') when CLAUDE_PLUGIN_DATA is unset -- never lands inside the project tree", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "ul-ts-"));
  const tsconfig = path.join(dir, "tsconfig.json");
  writeFileSync(tsconfig, "{}");
  const prev = process.env.CLAUDE_PLUGIN_DATA;
  delete process.env.CLAUDE_PLUGIN_DATA;
  try {
    const p = tsBuildInfoPathFor(tsconfig);
    assert.ok(!p.startsWith(dir), `expected outside ${dir}, got ${p}`);
    assert.ok(p.startsWith(tmpdir()));
  } finally {
    if (prev !== undefined) process.env.CLAUDE_PLUGIN_DATA = prev;
  }
});

/**
 * Run `fn` with CLAUDE_PLUGIN_DATA set to a fresh temp dir, restoring the previous value afterwards.
 *
 * @param fn - Test body; receives the data dir. May be async (awaited before the restore).
 */
async function withDataDir(fn: (dataDir: string) => void | Promise<void>): Promise<void> {
  const dataDir = mkdtempSync(path.join(tmpdir(), "ul-data-"));
  const prev = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = dataDir;
  try {
    await fn(dataDir);
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
    else process.env.CLAUDE_PLUGIN_DATA = prev;
  }
}

/**
 * Path of slot `i` under `dataDir`, as acquireSlot builds it.
 *
 * @param dataDir - Plugin data dir.
 * @param i - Slot index.
 * @returns The slot file path.
 */
const slotPath = (dataDir: string, i: number) => path.join(path.resolve(dataDir), "fc-slots", String(i));

test("acquireSlot: takes free slots holding this pid; a live pid with an mtime under 90 s in the future and an empty slot count as held; gives up after one round when all are held (F10)", async () => {
  await withDataDir((dataDir) => {
    for (let i = 0; i < FILE_CHANGED_SLOTS; i++) {
      assert.equal(acquireSlot(0), slotPath(dataDir, i));
      assert.equal(readFileSync(slotPath(dataDir, i), "utf8"), String(process.pid));
    }
    assert.equal(acquireSlot(0), null);
    const future = new Date(Date.now() + 60000);
    utimesSync(slotPath(dataDir, 1), future, future);
    assert.equal(acquireSlot(0), null);
    writeFileSync(slotPath(dataDir, 0), "");
    assert.equal(acquireSlot(0), null);
  });
});

test.each([
  ["a dead pid", (slot: string) => writeFileSync(slot, String(spawnSync(process.execPath, ["-e", "0"]).pid))],
  ["an mtime 91 s old", (slot: string) => {
    const d = new Date(Date.now() - 91000);
    utimesSync(slot, d, d);
  }],
  ["an mtime 91 s in the future", (slot: string) => {
    const d = new Date(Date.now() + 91000);
    utimesSync(slot, d, d);
  }],
])("acquireSlot: reclaims a slot whose pid is dead or whose mtime is at least 90 s old or at least 90 s in the future (F10): %s", async (_label, makeStale) => {
  await withDataDir((dataDir) => {
    for (let i = 0; i < FILE_CHANGED_SLOTS; i++) assert.notEqual(acquireSlot(0), null);
    makeStale(slotPath(dataDir, 0));
    assert.equal(acquireSlot(0), slotPath(dataDir, 0));
    assert.equal(readFileSync(slotPath(dataDir, 0), "utf8"), String(process.pid));
  });
});

/**
 * Path of `fc-locks/<key><ext>` under `dataDir`, as coalesceProjectCheck builds it.
 *
 * @param dataDir - Plugin data dir.
 * @param key - Project key passed to coalesceProjectCheck.
 * @param ext - `.lock` (the claim) or `.last` (the last completed run's start stamp).
 * @returns The file path.
 */
const lockPath = (dataDir: string, key: string, ext: ".lock" | ".last") => path.join(path.resolve(dataDir), "fc-locks", `${key}${ext}`);

/**
 * Block this thread for `ms` milliseconds (no `sleep` binary needed).
 *
 * @param ms - Milliseconds to wait.
 */
const waitMs = (ms: number): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

/**
 * A counting stand-in for coalesceProjectCheck's async `run`.
 *
 * @param result - Fields merged over a clean spawn result (status 0, no error, no signal).
 * @param inside - Called during each run (assertions while the lock is held).
 * @returns The `run` function and its call counter.
 */
function stubRun(result: Partial<SpawnSyncReturns<string>> = {}, inside: () => void = () => {}): { run: () => Promise<SpawnSyncReturns<string>>; calls: { n: number } } {
  const calls = { n: 0 };
  const run = async (): Promise<SpawnSyncReturns<string>> => {
    calls.n++;
    inside();
    return { status: 0, stdout: "", stderr: "", error: undefined, signal: null, ...result } as SpawnSyncReturns<string>;
  };
  return { run, calls };
}

test("coalesceProjectCheck: a .last stamp newer than the file's ctime and not in the future skips the run (F13, async F18)", async () => {
  await withDataDir(async (dataDir) => {
    const file = path.join(dataDir, "a.ts");
    writeFileSync(file, "export const a = 1;\n");
    mkdirSync(path.join(dataDir, "fc-locks"), { recursive: true });
    waitMs(20); // file timestamps use the coarse kernel clock, up to one tick behind Date.now()
    writeFileSync(lockPath(dataDir, "k6", ".last"), String(Date.now()));
    const { run, calls } = stubRun();
    assert.equal(await coalesceProjectCheck("k6", file, 45000, run), null);
    assert.equal(calls.n, 0);
  });
});

test("coalesceProjectCheck: without a stamp it runs once, stamps the run's start and releases the lock (F13, async F18)", async () => {
  await withDataDir(async (dataDir) => {
    const file = path.join(dataDir, "a.ts");
    writeFileSync(file, "export const a = 1;\n");
    const { run, calls } = stubRun();
    const before = Date.now();
    const r = await coalesceProjectCheck("k7", file, 45000, run);
    assert.equal(r?.status, 0);
    assert.equal(calls.n, 1);
    const t = Number(readFileSync(lockPath(dataDir, "k7", ".last"), "utf8"));
    assert.ok(t >= before && t <= Date.now(), `stamp ${t} not within [${before}, now]`);
    assert.equal(existsSync(lockPath(dataDir, "k7", ".lock")), false);
  });
});

test("coalesceProjectCheck: an errored run is returned, writes no stamp and releases the lock (F13, async F18)", async () => {
  await withDataDir(async (dataDir) => {
    const file = path.join(dataDir, "a.ts");
    writeFileSync(file, "export const a = 1;\n");
    const { run, calls } = stubRun({ error: new Error("x") });
    const r = await coalesceProjectCheck("k8", file, 45000, run);
    assert.equal(r?.error?.message, "x");
    assert.equal(calls.n, 1);
    assert.equal(existsSync(lockPath(dataDir, "k8", ".last")), false);
    assert.equal(existsSync(lockPath(dataDir, "k8", ".lock")), false);
  });
});

test("coalesceProjectCheck: a lock held by a dead pid is reclaimed and holds this pid during the run (F13, async F18)", async () => {
  await withDataDir(async (dataDir) => {
    const file = path.join(dataDir, "a.ts");
    writeFileSync(file, "export const a = 1;\n");
    mkdirSync(path.join(dataDir, "fc-locks"), { recursive: true });
    const lock = lockPath(dataDir, "k9", ".lock");
    writeFileSync(lock, String(spawnSync(process.execPath, ["-e", "0"]).pid));
    const { run, calls } = stubRun({}, () => assert.equal(readFileSync(lock, "utf8"), String(process.pid)));
    assert.equal((await coalesceProjectCheck("k9", file, 45000, run))?.status, 0);
    assert.equal(calls.n, 1);
    assert.equal(existsSync(lock), false);
  });
});

test("coalesceProjectCheck: past the lock-wait deadline a live holder's lock is left alone and the check runs unlocked (F13, async F18)", async () => {
  await withDataDir(async (dataDir) => {
    const file = path.join(dataDir, "a.ts");
    writeFileSync(file, "export const a = 1;\n");
    mkdirSync(path.join(dataDir, "fc-locks"), { recursive: true });
    const lock = lockPath(dataDir, "k10", ".lock");
    writeFileSync(lock, String(process.pid)); // the vitest worker is alive: slotStale keeps the lock held
    const { run, calls } = stubRun();
    // reserveMs 1e9: FILE_CHANGED_BUDGET_MS - reserveMs is already past, so one claim attempt, then run unlocked.
    assert.equal((await coalesceProjectCheck("k10", file, 1e9, run))?.status, 0);
    assert.equal(calls.n, 1);
    assert.equal(readFileSync(lock, "utf8"), String(process.pid));
    assert.equal(existsSync(lockPath(dataDir, "k10", ".last")), false);
  });
});

test("REGISTRY: yaml/markdown chain entries carry their line-length guard flags", () => {
  assert.equal(REGISTRY.yaml.chain[0].guardYamlLineLength, true);
  assert.equal(REGISTRY.markdown.chain[0].guardMarkdownLineLength, true);
  assert.equal(REGISTRY.markdown.chain[1].guardMarkdownLineLength, true);
});

test("hasProjectYamllintConfig: finds .yamllint directly in cwd", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "ul-yl-"));
  writeFileSync(path.join(dir, ".yamllint"), "extends: default\n");
  assert.equal(hasProjectYamllintConfig(dir), true);
});

test("hasProjectYamllintConfig: finds .yamllint.yaml / .yamllint.yml variants", () => {
  const dirA = mkdtempSync(path.join(tmpdir(), "ul-yl-"));
  writeFileSync(path.join(dirA, ".yamllint.yaml"), "extends: default\n");
  assert.equal(hasProjectYamllintConfig(dirA), true);
  const dirB = mkdtempSync(path.join(tmpdir(), "ul-yl-"));
  writeFileSync(path.join(dirB, ".yamllint.yml"), "extends: default\n");
  assert.equal(hasProjectYamllintConfig(dirB), true);
});

test("hasProjectYamllintConfig: nothing found -> false", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "ul-yl-"));
  assert.equal(hasProjectYamllintConfig(dir), false);
});

test("hasProjectYamllintConfig: a config in the user's home directory is found (yamllint checks there too before stopping)", () => {
  const fakeHome = mkdtempSync(path.join(tmpdir(), "ul-yl-home-"));
  writeFileSync(path.join(fakeHome, ".yamllint"), "extends: default\n");
  const sub = path.join(fakeHome, "proj");
  mkdirSync(sub, { recursive: true });
  const prevHome = process.env.HOME;
  process.env.HOME = fakeHome;
  try {
    assert.equal(hasProjectYamllintConfig(sub), true);
  } finally {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
  }
});

test("hasProjectMarkdownlintConfig: finds a markdownlint-cli2 config", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "ul-md-"));
  writeFileSync(path.join(dir, ".markdownlint-cli2.jsonc"), "{}");
  assert.equal(hasProjectMarkdownlintConfig(dir), true);
});

test("hasProjectMarkdownlintConfig: finds a legacy .markdownlint.json walking up from a nested file dir", () => {
  const root = mkdtempSync(path.join(tmpdir(), "ul-md-"));
  writeFileSync(path.join(root, ".markdownlint.json"), "{}");
  const sub = path.join(root, "docs");
  mkdirSync(sub, { recursive: true });
  assert.equal(hasProjectMarkdownlintConfig(sub), true);
});

test("hasProjectMarkdownlintConfig: nothing found -> false", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "ul-md-"));
  assert.equal(hasProjectMarkdownlintConfig(dir), false);
});

test("buildArgv: yamllint gets -d line-length-disable override when no project .yamllint exists", () => {
  const yamllint = REGISTRY.yaml.chain[0];
  const dir = mkdtempSync(path.join(tmpdir(), "ul-yl-"));
  // Isolate from the developer's own ~/.yamllint, ~/.config/yamllint/config and YAMLLINT_CONFIG_FILE.
  const keys = ["HOME", "XDG_CONFIG_HOME", "YAMLLINT_CONFIG_FILE"] as const;
  const prev = keys.map((k) => process.env[k]);
  process.env.HOME = mkdtempSync(path.join(tmpdir(), "ul-yl-home-"));
  delete process.env.XDG_CONFIG_HOME;
  delete process.env.YAMLLINT_CONFIG_FILE;
  try {
    assert.deepEqual(buildArgv(yamllint, path.join(dir, "a.yaml"), dir), ["-d", "{extends: default, rules: {line-length: disable}}", path.join(dir, "a.yaml")]);
  } finally {
    keys.forEach((k, i) => {
      if (prev[i] === undefined) delete process.env[k];
      else process.env[k] = prev[i];
    });
  }
});

test("buildArgv: yamllint runs bare when a project .yamllint exists", () => {
  const yamllint = REGISTRY.yaml.chain[0];
  const dir = mkdtempSync(path.join(tmpdir(), "ul-yl-"));
  writeFileSync(path.join(dir, ".yamllint"), "extends: default\n");
  assert.deepEqual(buildArgv(yamllint, path.join(dir, "a.yaml"), dir), [path.join(dir, "a.yaml")]);
});

test("buildArgv: markdownlint-cli2 gets --config <MD013-off file in CLAUDE_PLUGIN_DATA> when no project config exists", () => {
  const markdownlintCli2 = REGISTRY.markdown.chain[0];
  const dir = mkdtempSync(path.join(tmpdir(), "ul-md-"));
  const dataDir = mkdtempSync(path.join(tmpdir(), "ul-data-"));
  const prev = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = dataDir;
  try {
    const argv = buildArgv(markdownlintCli2, path.join(dir, "a.md"), dir);
    const cfg = path.join(dataDir, "markdownlint-no-line-length.json");
    assert.deepEqual(argv, ["--no-globs", "--config", cfg, path.join(dir, "a.md")]);
    assert.deepEqual(JSON.parse(readFileSync(cfg, "utf8")), { MD013: false });
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
    else process.env.CLAUDE_PLUGIN_DATA = prev;
  }
});

test("buildArgv: markdownlint-cli2 runs with only --no-globs when a project config exists", () => {
  const markdownlintCli2 = REGISTRY.markdown.chain[0];
  const dir = mkdtempSync(path.join(tmpdir(), "ul-md-"));
  writeFileSync(path.join(dir, ".markdownlint.json"), "{}");
  assert.deepEqual(buildArgv(markdownlintCli2, path.join(dir, "a.md"), dir), ["--no-globs", path.join(dir, "a.md")]);
});

test("buildArgv: classic markdownlint runs bare with a .markdownlintrc (rc config) above the file; cli2 keeps its guard", () => {
  const root = mkdtempSync(path.join(tmpdir(), "ul-md-"));
  writeFileSync(path.join(root, ".markdownlintrc"), "{\"MD013\": {\"line_length\": 20}}");
  const sub = path.join(root, "docs");
  mkdirSync(sub, { recursive: true });
  const file = path.join(sub, "a.md");
  const dataDir = mkdtempSync(path.join(tmpdir(), "ul-data-"));
  const prev = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = dataDir;
  try {
    assert.deepEqual(buildArgv(REGISTRY.markdown.chain[1], file, root), [file]);
    assert.deepEqual(buildArgv(REGISTRY.markdown.chain[0], file, root), ["--no-globs", "--config", path.join(dataDir, "markdownlint-no-line-length.json"), file]);
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
    else process.env.CLAUDE_PLUGIN_DATA = prev;
  }
});

test("buildArgv: classic markdownlint keeps the guard for configs it never reads (below the spawn cwd, missing $markdownlint_config)", () => {
  const root = mkdtempSync(path.join(tmpdir(), "ul-md-"));
  const sub = path.join(root, "sub");
  mkdirSync(sub, { recursive: true });
  writeFileSync(path.join(sub, ".markdownlintrc"), "{\"MD009\": false}");
  writeFileSync(path.join(sub, ".markdownlint.json"), "{\"MD009\": false}");
  const file = path.join(sub, "a.md");
  const dataDir = mkdtempSync(path.join(tmpdir(), "ul-data-"));
  const guarded = [path.join(dataDir, "markdownlint-no-line-length.json"), file];
  const prev = { data: process.env.CLAUDE_PLUGIN_DATA, home: process.env.HOME, env: process.env.markdownlint_config };
  process.env.CLAUDE_PLUGIN_DATA = dataDir;
  process.env.HOME = mkdtempSync(path.join(tmpdir(), "ul-home-"));
  process.env.markdownlint_config = path.join(root, "missing.json");
  try {
    const classic = REGISTRY.markdown.chain[1];
    assert.deepEqual(buildArgv(classic, file, root), ["--config", ...guarded]);
    // spawned in sub (a local package root there): markdownlint reads sub's configs
    assert.deepEqual(buildArgv(classic, file, root, null, sub), [file]);
    writeFileSync(path.join(root, ".markdownlint.yaml"), "MD009: false\n");
    assert.deepEqual(buildArgv(classic, file, root), [file]);
  } finally {
    for (const [k, v] of [["CLAUDE_PLUGIN_DATA", prev.data], ["HOME", prev.home], ["markdownlint_config", prev.env]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

test("REGISTRY: php chain is phpstan -> psalm, neither carries npmSpec", () => {
  assert.equal(REGISTRY.php.chain.length, 2);
  assert.equal(REGISTRY.php.chain[0].name, "phpstan");
  assert.equal(REGISTRY.php.chain[0].npmSpec, undefined);
  assert.equal(REGISTRY.php.chain[1].name, "psalm");
  assert.equal(REGISTRY.php.chain[1].npmSpec, undefined);
});

test("classifyExit: phpstan is 0-clean/else-issues (accepted ambiguity, same as go)", () => {
  assert.equal(classifyExit("phpstan", 0), "clean");
  assert.equal(classifyExit("phpstan", 1), "issues");
  assert.equal(classifyExit("phpstan", 2), "issues");
});

test("classifyExit: psalm is 0-clean/2-issues/else-skip (NOT the shared 0/1/else contract)", () => {
  assert.equal(classifyExit("psalm", 0), "clean");
  assert.equal(classifyExit("psalm", 1), "skip");
  assert.equal(classifyExit("psalm", 2), "issues");
  assert.equal(classifyExit("psalm", 3), "skip");
});

test("isExcludedPath: node_modules/vendor/.git segments -> excluded", () => {
  assert.equal(isExcludedPath(path.join("node_modules", "x", "a.sh")), true);
  assert.equal(isExcludedPath(path.join("vendor", "a.php")), true);
  assert.equal(isExcludedPath(path.join(".git", "hooks", "a.sh")), true);
});

test("isExcludedPath: .claude/worktrees and .claude/agent-memory -> excluded", () => {
  assert.equal(isExcludedPath(path.join(".claude", "worktrees", "foo", "a.sh")), true);
  assert.equal(isExcludedPath(path.join(".claude", "agent-memory", "a.md")), true);
});

test("isExcludedPath: other .claude/ subtrees (e.g. rules/agents/skills) stay covered", () => {
  assert.equal(isExcludedPath(path.join(".claude", "rules", "a.md")), false);
  assert.equal(isExcludedPath(path.join(".claude", "settings.json")), false);
});

test("isExcludedPath: a later .claude segment matching worktrees/agent-memory is still excluded, even after an earlier non-matching .claude segment", () => {
  assert.equal(isExcludedPath(path.join(".claude", "rules", ".claude", "worktrees", "foo", "a.sh")), true);
  assert.equal(isExcludedPath(path.join(".claude", "skills", ".claude", "agent-memory", "a.md")), true);
});

test("isExcludedPath: *.local.* files excluded regardless of location", () => {
  assert.equal(isExcludedPath(path.join(".claude", "settings.local.json")), true);
  assert.equal(isExcludedPath("docker-compose.local.yml"), true);
  assert.equal(isExcludedPath("a.sh"), false);
});

/** The PostToolUse payload resolveLintTarget reads. */
function mockResolveArgs(cwd: string, filePath: string, success = true) {
  return {
    session_id: "test-session",
    transcript_path: "/dev/null",
    cwd,
    permission_mode: "default",
    hook_event_name: "PostToolUse",
    tool_name: "Write",
    tool_input: { file_path: filePath },
    tool_response: { success },
  };
}

test("resolveLintTarget: returns the resolved absolute path for an in-cwd eligible file", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "ul-rlt-"));
  writeFileSync(path.join(dir, "a.sh"), "echo hi\n");
  assert.equal(resolveLintTarget(mockResolveArgs(dir, "a.sh")), path.join(dir, "a.sh"));
});

test("resolveLintTarget: null when tool_response.success === false", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "ul-rlt-"));
  writeFileSync(path.join(dir, "a.sh"), "echo hi\n");
  assert.equal(resolveLintTarget(mockResolveArgs(dir, "a.sh", false)), null);
});

test("resolveLintTarget: null for a path resolving outside cwd", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "ul-rlt-"));
  assert.equal(resolveLintTarget(mockResolveArgs(dir, "../escape.sh")), null);
});

test("resolveLintTarget: null for an excluded path (node_modules)", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "ul-rlt-"));
  const nm = path.join(dir, "node_modules");
  mkdirSync(nm, { recursive: true });
  writeFileSync(path.join(nm, "a.sh"), "echo hi\n");
  assert.equal(resolveLintTarget(mockResolveArgs(dir, "node_modules/a.sh")), null);
});

test("resolveLintTarget: null for an unsupported extension", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "ul-rlt-"));
  writeFileSync(path.join(dir, "a.txt"), "hi\n");
  assert.equal(resolveLintTarget(mockResolveArgs(dir, "a.txt")), null);
});

test("resolveLintTarget: null when the file does not exist", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "ul-rlt-"));
  assert.equal(resolveLintTarget(mockResolveArgs(dir, "gone.sh")), null);
});

test("REGISTRY: rust chain is cargo-clippy -> cargo, both manifestPath, neither carries npmSpec", () => {
  assert.equal(REGISTRY.rust.chain.length, 2);
  assert.equal(REGISTRY.rust.chain[0].name, "cargo-clippy");
  assert.deepEqual(REGISTRY.rust.chain[0].args, ["--", "-D", "warnings"]);
  assert.equal(REGISTRY.rust.chain[0].manifestPath, true);
  assert.equal(REGISTRY.rust.chain[0].npmSpec, undefined);
  assert.equal(REGISTRY.rust.chain[1].name, "cargo");
  assert.deepEqual(REGISTRY.rust.chain[1].args, ["check"]);
  assert.equal(REGISTRY.rust.chain[1].manifestPath, true);
  assert.equal(REGISTRY.rust.chain[1].npmSpec, undefined);
});

test("REGISTRY: rust chain's clippy entry is probed as cargo-clippy but spawned as cargo clippy", () => {
  const clippy = REGISTRY.rust.chain[0];
  assert.deepEqual(clippy.spawnAs, { name: "cargo", args: ["clippy"] });
  // cargo check (chain[1]) has no spawnAs -- it's already spawned under its
  // own probed name, no decoupling needed.
  assert.equal(REGISTRY.rust.chain[1].spawnAs, undefined);
});

test("resolveCargoManifest: finds Cargo.toml walking up from a nested dir", () => {
  const root = mkdtempSync(path.join(tmpdir(), "ul-cargo-"));
  writeFileSync(path.join(root, "Cargo.toml"), "[package]\nname = \"x\"\n");
  const sub = path.join(root, "src", "inner");
  mkdirSync(sub, { recursive: true });
  assert.equal(resolveCargoManifest(sub, root), path.join(root, "Cargo.toml"));
});

test("resolveCargoManifest: finds Cargo.toml at cwd", () => {
  const root = mkdtempSync(path.join(tmpdir(), "ul-cargo-"));
  writeFileSync(path.join(root, "Cargo.toml"), "[package]\nname = \"x\"\n");
  assert.equal(resolveCargoManifest(root, root), path.join(root, "Cargo.toml"));
});

test("resolveCargoManifest: nothing found -> null", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "ul-cargo-"));
  assert.equal(resolveCargoManifest(dir, dir), null);
});

test("buildArgv: cargo-clippy inserts --manifest-path before the -- separator, no trailing positional", () => {
  const clippy = REGISTRY.rust.chain[0];
  const root = mkdtempSync(path.join(tmpdir(), "ul-cargo-"));
  writeFileSync(path.join(root, "Cargo.toml"), "[package]\nname = \"x\"\n");
  const sub = path.join(root, "src");
  mkdirSync(sub, { recursive: true });
  assert.deepEqual(buildArgv(clippy, path.join(sub, "main.rs"), root), ["--manifest-path", path.join(root, "Cargo.toml"), "--", "-D", "warnings"]);
});

test("buildArgv: cargo check appends --manifest-path, no trailing positional", () => {
  const cargo = REGISTRY.rust.chain[1];
  const root = mkdtempSync(path.join(tmpdir(), "ul-cargo-"));
  writeFileSync(path.join(root, "Cargo.toml"), "[package]\nname = \"x\"\n");
  assert.deepEqual(buildArgv(cargo, path.join(root, "main.rs"), root), ["check", "--manifest-path", path.join(root, "Cargo.toml")]);
});

test("buildArgv: manifestPath tool with no Cargo.toml leaves args unchanged and adds no positional", () => {
  const cargo = REGISTRY.rust.chain[1];
  const dir = mkdtempSync(path.join(tmpdir(), "ul-cargo-"));
  assert.deepEqual(buildArgv(cargo, path.join(dir, "main.rs"), dir), ["check"]);
  const clippy = REGISTRY.rust.chain[0];
  assert.deepEqual(buildArgv(clippy, path.join(dir, "main.rs"), dir), ["--", "-D", "warnings"]);
});

test("classifyExit: cargo-clippy and cargo are 0-clean/nonzero-issues/null-skip", () => {
  for (const name of ["cargo-clippy", "cargo"]) {
    assert.equal(classifyExit(name, 0), "clean");
    assert.equal(classifyExit(name, 101), "issues");
    assert.equal(classifyExit(name, 1), "issues");
    assert.equal(classifyExit(name, null), "skip");
  }
});

test("resolveLintTarget: a .rs file resolves like any other eligible extension", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "ul-rlt-"));
  writeFileSync(path.join(dir, "main.rs"), "fn main() {}\n");
  assert.equal(resolveLintTarget(mockResolveArgs(dir, "main.rs")), path.join(dir, "main.rs"));
});

test("lintFileHandler and lintFilesHandler are exported (main/tests and the skill driver)", () => {
  assert.equal(typeof lintFileHandler, "function");
  assert.equal(typeof lintFilesHandler, "function");
});

test("REGISTRY.oxlint: one-entry alternate jsts chain with exact name, npmSpec and args", () => {
  assert.equal(REGISTRY.oxlint.chain.length, 1);
  const oxlint = REGISTRY.oxlint.chain[0];
  assert.equal(oxlint.name, "oxlint");
  assert.equal(oxlint.npmSpec, "oxlint");
  assert.deepEqual(oxlint.args, ["--no-error-on-unmatched-pattern"]);
});

/**
 * Fresh project root with an empty `sub/` dir; writes each root-relative file.
 *
 * @param files - Root-relative path -> content.
 * @returns The root and its `sub/` dir.
 */
function oxlRoot(files: Record<string, string>): { root: string; sub: string } {
  const root = mkdtempSync(path.join(tmpdir(), "ul-oxl-"));
  const sub = path.join(root, "sub");
  mkdirSync(sub, { recursive: true });
  for (const [rel, content] of Object.entries(files)) writeFileSync(path.join(root, rel), content);
  return { root, sub };
}

test("resolveOxlintConfig: no config anywhere -> null", () => {
  const { root, sub } = oxlRoot({});
  assert.equal(resolveOxlintConfig(sub, root), null);
});

test("resolveOxlintConfig: each oxlint config name at root is found from sub/", () => {
  for (const name of [".oxlintrc.json", ".oxlintrc.jsonc", "oxlint.config.ts"]) {
    const { root, sub } = oxlRoot({ [name]: "{}" });
    assert.equal(resolveOxlintConfig(sub, root), path.join(root, name), name);
  }
});

test("resolveOxlintConfig: eslint config at root -> null", () => {
  for (const name of ["eslint.config.mjs", ".eslintrc.json"]) {
    const { root, sub } = oxlRoot({ [name]: "{}" });
    assert.equal(resolveOxlintConfig(sub, root), null, name);
  }
});

test("resolveOxlintConfig: eslint and oxlint config in the same dir -> oxlint path (oxlint wins the tie)", () => {
  const { root, sub } = oxlRoot({ "eslint.config.mjs": "export default [];", ".oxlintrc.json": "{}" });
  assert.equal(resolveOxlintConfig(sub, root), path.join(root, ".oxlintrc.json"));
});

test("resolveOxlintConfig: nearest config wins (oxlint in sub/, eslint at root -> sub path)", () => {
  const { root, sub } = oxlRoot({ "eslint.config.js": "export default [];", "sub/.oxlintrc.json": "{}" });
  assert.equal(resolveOxlintConfig(sub, root), path.join(sub, ".oxlintrc.json"));
});

test("resolveOxlintConfig: nearest config wins (eslint in sub/, oxlint at root -> null)", () => {
  const { root, sub } = oxlRoot({ ".oxlintrc.json": "{}", "sub/eslint.config.js": "export default [];" });
  assert.equal(resolveOxlintConfig(sub, root), null);
});

test("resolveOxlintConfig: oxlint config only above cwd -> null (walk bounded at cwd)", () => {
  const { sub } = oxlRoot({ ".oxlintrc.json": "{}" });
  assert.equal(resolveOxlintConfig(sub, sub), null);
});

/**
 * Write one oxlint config into a fresh temp dir.
 *
 * @param name - Config file name.
 * @param content - File content.
 * @returns Absolute path of the written config.
 */
function oxlCfg(name: string, content: string): string {
  const p = path.join(mkdtempSync(path.join(tmpdir(), "ul-oxl-")), name);
  writeFileSync(p, content);
  return p;
}

test("oxlintConfigTypeChecks: options.typeCheck true -> true", () => {
  assert.equal(oxlintConfigTypeChecks(oxlCfg(".oxlintrc.json", "{\"options\":{\"typeAware\":true,\"typeCheck\":true}}")), true);
});

test("oxlintConfigTypeChecks: .jsonc with // and /* */ comments and trailing commas -> true", () => {
  const text = "// project oxlint config\n{\n  \"options\": {\n    \"typeAware\": true, /* tsgolint */\n    \"typeCheck\": true,\n  },\n}\n";
  assert.equal(oxlintConfigTypeChecks(oxlCfg(".oxlintrc.jsonc", text)), true);
});

test("oxlintConfigTypeChecks: typeCheck false / missing / no options / string \"true\" -> false", () => {
  for (const text of ["{\"options\":{\"typeCheck\":false}}", "{\"options\":{\"typeAware\":true}}", "{}", "{\"options\":{\"typeCheck\":\"true\"}}"]) {
    assert.equal(oxlintConfigTypeChecks(oxlCfg(".oxlintrc.json", text)), false, text);
  }
});

test("oxlintConfigTypeChecks: string values containing ',}' / ',]' survive trailing-comma removal -> true", () => {
  const text = "{\"ignorePatterns\": [\"a,}\", \"b,]\",],\n \"options\": {\"typeCheck\": true,},}";
  assert.equal(oxlintConfigTypeChecks(oxlCfg(".oxlintrc.jsonc", text)), true);
});

test("stripTrailingCommas: removes only structural trailing commas", () => {
  assert.equal(stripTrailingCommas("{\"a\": [1, 2 ,\n ], \"b\": \"x,}\\\",]\",}"), "{\"a\": [1, 2 \n ], \"b\": \"x,}\\\",]\"}");
});

test("oxlintConfigTypeChecks: malformed JSON -> false", () => {
  assert.equal(oxlintConfigTypeChecks(oxlCfg(".oxlintrc.json", "{\"options\":")), false);
});

test("oxlintConfigTypeChecks: oxlint.config.ts is never read -> false even with typeCheck: true", () => {
  assert.equal(oxlintConfigTypeChecks(oxlCfg("oxlint.config.ts", "export default { options: { typeCheck: true } };\n")), false);
});

test("oxlintConfigTypeChecks: a directory named .oxlintrc.json (EISDIR) -> false", () => {
  const p = path.join(mkdtempSync(path.join(tmpdir(), "ul-oxl-")), ".oxlintrc.json");
  mkdirSync(p);
  assert.equal(oxlintConfigTypeChecks(p), false);
});

/**
 * An Edit payload with the given structuredPatch hunks.
 *
 * @param hunks - The `structuredPatch` value.
 * @returns The payload.
 */
const editArgs = (hunks: unknown) => ({ cwd: "/p", tool_name: "Edit", tool_input: { file_path: "a.sh" }, tool_response: { success: true, structuredPatch: hunks } });

test("editRanges: replaced and added lines give the `+` run (0-based, inclusive)", () => {
  assert.deepEqual(editRanges(editArgs([{ newStart: 3, lines: [" a", "-b", "+B", "+C", " d"] }])), [[3, 4]]);
});

test("editRanges: a pure deletion gives the two lines around the deletion point", () => {
  assert.deepEqual(editRanges(editArgs([{ newStart: 3, lines: [" a", "-b", " c"] }])), [[2, 3]]);
  assert.deepEqual(editRanges(editArgs([{ newStart: 1, lines: ["-a", " b"] }])), [[0, 0]]);
});

test("editRanges: several hunks and runs each give a range; `\\ No newline` is not a line", () => {
  const hunks = [{ newStart: 1, lines: ["+x", " a", "-b", "+y", "\\ No newline at end of file"] }, { newStart: 20, lines: [" c", "+z"] }];
  assert.deepEqual(editRanges(editArgs(hunks)), [[0, 0], [2, 2], [20, 20]]);
});

test("editRanges: Write, a missing or a malformed patch gives null (whole file)", () => {
  assert.equal(editRanges({ ...editArgs([]), tool_name: "Write" }), null);
  assert.equal(editRanges({ cwd: "/p", tool_name: "Edit", tool_input: { file_path: "a.sh" } }), null);
  assert.equal(editRanges(editArgs([{ lines: [] }])), null);
});

/** Scratch base directory for the gateFinding tests; holds a real `other.ts` (a different existing file). */
const GATE_DIR = mkdtempSync(path.join(tmpdir(), "ul-gate-"));
writeFileSync(path.join(GATE_DIR, "other.ts"), "");

/**
 * A finding as runChainLint/runTypeCheck build it.
 *
 * @param text - The tool's raw findings text.
 * @param base - Directory the tool's relative paths resolve against.
 * @returns The finding.
 */
const gf = (text: string, base: string = GATE_DIR) => ({ tool: "t", target: ".", text, base });

test("gateFinding: eslint stylish keeps only rows on edited lines; all rows missing drops header and summary (null)", () => {
  const resolved = path.join(GATE_DIR, "a.js");
  const text = `${resolved}\n  1:7  error  bad-one  r1\n  3:1  error  bad-three  r3\n\n✖ 2 problems\n`;
  const g = gateFinding(gf(text), [[0, 0]], resolved);
  assert.ok(g);
  assert.match(g.text, /bad-one/);
  assert.doesNotMatch(g.text, /bad-three/);
  assert.ok(g.text.includes(resolved));
  assert.match(g.text, /✖ 2 problems/);
  assert.equal(gateFinding(gf(text), [[5, 5]], resolved), null);
});

test("gateFinding: an oxlint block is dropped whole on a miss and kept on a hit", () => {
  const resolved = path.join(GATE_DIR, "a.ts");
  const text = "  x eslint(no-unused-vars): oxlint-marker\n   ,-[a.ts:3:7]\n 2 |\n 3 | const x = 1;\n   :       ^\n   `----\n\nFound 0 warnings and 1 error.\n";
  assert.equal(gateFinding(gf(text), [[0, 0]], resolved), null);
  const g = gateFinding(gf(text), [[2, 2]], resolved);
  assert.ok(g);
  assert.match(g.text, /oxlint-marker/);
});

test("gateFinding: tsc one-paragraph output keeps the hit diagnostic with its continuation, drops the miss", () => {
  const resolved = path.join(GATE_DIR, "a.ts");
  const text = "a.ts(1,7): error TS2322: diag-one\n  continuation-one\na.ts(9,1): error TS2322: diag-nine\n";
  const g = gateFinding(gf(text), [[0, 0]], resolved);
  assert.ok(g);
  assert.match(g.text, /diag-one/);
  assert.match(g.text, /continuation-one/);
  assert.doesNotMatch(g.text, /diag-nine/);
});

test("gateFinding: a tsc diagnostic in a different existing file is foreign and kept", () => {
  const resolved = path.join(GATE_DIR, "a.ts");
  const g = gateFinding(gf("other.ts(1,1): error TS2322: foreign-marker\n"), [[5, 5]], resolved);
  assert.ok(g);
  assert.match(g.text, /foreign-marker/);
});

test("gateFinding: checkstyle absolute path hits and misses", () => {
  const resolved = path.join(GATE_DIR, "A.java");
  const text = `Starting audit...\n[WARN] ${resolved}:3: checkstyle-marker [Rule]\nAudit done.\n`;
  const g = gateFinding(gf(text), [[2, 2]], resolved);
  assert.ok(g);
  assert.match(g.text, /checkstyle-marker/);
  assert.equal(gateFinding(gf(text), [[0, 0]], resolved), null);
});

test("gateFinding: shellcheck tty `In <file> line N:` block", () => {
  const resolved = path.join(GATE_DIR, "a.sh");
  const text = `\nIn ${resolved} line 3:\necho $1\n     ^-- SC2086 (info): shellcheck-marker\n\nFor more information:\n  https://www.shellcheck.net/wiki/SC2086 -- Double quote\n`;
  const g = gateFinding(gf(text), [[2, 2]], resolved);
  assert.ok(g);
  assert.match(g.text, /shellcheck-marker/);
  assert.equal(gateFinding(gf(text), [[0, 0]], resolved), null);
});

test("gateFinding: cargo `--> src/a.rs:L` against the crate directory hits", () => {
  const crate = path.join(GATE_DIR, "crate");
  mkdirSync(path.join(crate, "src"), { recursive: true });
  const resolved = path.join(crate, "src", "a.rs");
  const text = "warning: unused variable: `x` cargo-marker\n --> src/a.rs:12:5\n   |\n12 |     let x = 1;\n";
  const g = gateFinding(gf(text, crate), [[11, 11]], resolved);
  assert.ok(g);
  assert.match(g.text, /cargo-marker/);
  assert.equal(gateFinding(gf(text, crate), [[0, 0]], resolved), null);
});

test("gateFinding: a workspace-root-relative cargo path is matched by suffix (own file, so a miss drops it)", () => {
  const crate = path.join(GATE_DIR, "wscrate");
  mkdirSync(path.join(crate, "src"), { recursive: true });
  const resolved = path.join(crate, "src", "a.rs");
  const text = "warning: ws-marker\n --> wscrate/src/a.rs:3:1\n";
  const g = gateFinding(gf(text, crate), [[2, 2]], resolved);
  assert.ok(g);
  assert.match(g.text, /ws-marker/);
  assert.equal(gateFinding(gf(text, crate), [[0, 0]], resolved), null);
});

test("gateFinding: a path broken by a space in a directory name is not matched, so it is kept (fail open)", () => {
  const resolved = path.join(GATE_DIR, "my dir", "a.sh");
  const g = gateFinding(gf(`${resolved}:3:1: note: spaced-marker [SC2086]\n`), [[0, 0]], resolved);
  assert.ok(g);
  assert.match(g.text, /spaced-marker/);
});

test("gateFinding: an own-file parse error outside the range is kept (location line or preamble)", () => {
  const resolved = path.join(GATE_DIR, "a.ts");
  assert.ok(gateFinding(gf("a.ts(9,1): error TS1005: ';' expected.\n"), [[0, 0]], resolved));
  const rs = path.join(GATE_DIR, "src", "b.rs");
  assert.ok(gateFinding(gf("error: this file contains an unclosed delimiter\n --> src/b.rs:40:3\n"), [[0, 0]], rs));
  assert.equal(gateFinding(gf("a.ts(9,1): error TS2322: type-marker\n"), [[0, 0]], resolved), null);
});

test("gateFinding: eslint eqeqeq and rustc E0308 `expected` wording outside the range are not parse errors (dropped)", () => {
  const js = path.join(GATE_DIR, "a.js");
  assert.equal(gateFinding(gf(`${js}\n  3:7  error  Expected '===' and instead saw '=='  eqeqeq\n\n✖ 1 problem\n`), [[1, 1]], js), null);
  const rs = path.join(GATE_DIR, "src", "c.rs");
  const e0308 = "error[E0308]: mismatched types\n --> src/c.rs:4:20\n  |\n4 |     let x: u8 = {};\n  |            --   ^^ expected `u8`, found `()`\n";
  assert.equal(gateFinding(gf(e0308), [[2, 2]], rs), null);
  assert.ok(gateFinding(gf("error: expected `;`, found `println`\n --> src/c.rs:4:20\n"), [[2, 2]], rs));
});

test("gateFinding: text without any location is returned unchanged", () => {
  const f = gf("something went wrong\n");
  assert.equal(gateFinding(f, [[0, 0]], path.join(GATE_DIR, "a.ts")), f);
});

test("gateFinding: ranges null keeps every own-file diagnostic", () => {
  const resolved = path.join(GATE_DIR, "a.ts");
  const g = gateFinding(gf("a.ts(1,7): error TS1: diag-one\na.ts(9,1): error TS2: diag-nine\n"), null, resolved);
  assert.ok(g);
  assert.match(g.text, /diag-one/);
  assert.match(g.text, /diag-nine/);
});

test("gateFinding: only own-file misses and no foreign location gives null", () => {
  const resolved = path.join(GATE_DIR, "a.sh");
  assert.equal(gateFinding(gf("a.sh:2:1: note: x [SC1]\na.sh:4:1: note: y [SC2]\n"), [[0, 0]], resolved), null);
});

test("gateFinding: repeated lines of one path classify identically (suffix-fallback own path and real foreign x/b.ts, interleaved)", () => {
  // resolved = dir/sub/x/b.ts. `b.ts` resolves to the absent dir/b.ts and is a suffix of resolved: own (cached false).
  // `x/b.ts` resolves to the real dir/x/b.ts: foreign (cached true). Ranges cover only some own lines.
  const dir = mkdtempSync(path.join(tmpdir(), "ul-f21-"));
  mkdirSync(path.join(dir, "x"));
  writeFileSync(path.join(dir, "x", "b.ts"), "");
  const resolved = path.join(dir, "sub", "x", "b.ts");
  const lines: string[] = [];
  for (let i = 1; i <= 20; i++) {
    lines.push(`b.ts(${i},1): error TS2322: own-${i};`);
    lines.push(`x/b.ts(${i},1): error TS2322: foreign-${i};`);
  }
  const text = `${lines.join("\n")}\n`;
  const g = gateFinding(gf(text, dir), [[0, 4]], resolved);
  assert.ok(g);
  const out = g.text.split("\n");
  for (let i = 1; i <= 20; i++) {
    assert.equal(out.some((l) => l.includes(`own-${i};`)), i <= 5, `own-${i}`);
    assert.ok(out.some((l) => l.includes(`foreign-${i};`)), `foreign-${i}`);
  }
  assert.deepEqual(gateFinding(gf(text, dir), [[0, 4]], resolved), g);
});

test("scopedTarget: lexical and real path of an in-cwd eligible file", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "ul-st-"));
  writeFileSync(path.join(dir, "a.sh"), "echo hi\n");
  assert.deepEqual(scopedTarget(dir, "a.sh"), { fp: path.join(dir, "a.sh"), real: path.join(realpathSync(dir), "a.sh") });
});

test("scopedTarget: null for a symlink inside cwd pointing outside it", () => {
  const root = mkdtempSync(path.join(tmpdir(), "ul-st-"));
  const dir = path.join(root, "proj");
  mkdirSync(dir);
  writeFileSync(path.join(root, "o.sh"), "echo hi\n");
  symlinkSync(path.join(root, "o.sh"), path.join(dir, "link.sh"));
  assert.equal(scopedTarget(dir, "link.sh"), null);
});

test("scopedTarget: null for a dangling symlink", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "ul-st-"));
  symlinkSync(path.join(dir, "missing.sh"), path.join(dir, "dl.sh"));
  assert.equal(scopedTarget(dir, "dl.sh"), null);
});

test("scopedTarget: null for a file inside the scratchpad dir, kept without one", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "ul-st-"));
  mkdirSync(path.join(dir, "s"));
  writeFileSync(path.join(dir, "s", "e.sh"), "echo hi\n");
  assert.equal(scopedTarget(dir, "s/e.sh", path.join(dir, "s")), null);
  assert.equal(scopedTarget(dir, "s/e.sh")?.fp, path.join(dir, "s", "e.sh"));
});

test("scopedTarget: null for cwd itself, an excluded path and an unsupported extension", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "ul-st-"));
  mkdirSync(path.join(dir, "node_modules"));
  writeFileSync(path.join(dir, "node_modules", "a.sh"), "echo hi\n");
  writeFileSync(path.join(dir, "x.txt"), "hi\n");
  assert.equal(scopedTarget(dir, "."), null);
  assert.equal(scopedTarget(dir, "node_modules/a.sh"), null);
  assert.equal(scopedTarget(dir, "x.txt"), null);
});

test("scopedTarget: roots.dirs gives the same result as the plain call", () => {
  const root = mkdtempSync(path.join(tmpdir(), "ul-st-"));
  const dir = path.join(root, "proj");
  mkdirSync(path.join(dir, "s"), { recursive: true });
  writeFileSync(path.join(dir, "a.sh"), "echo a\n");
  writeFileSync(path.join(root, "o.sh"), "echo o\n");
  symlinkSync(path.join(root, "o.sh"), path.join(dir, "link.sh"));
  symlinkSync(path.join(dir, "missing.sh"), path.join(dir, "dl.sh"));
  writeFileSync(path.join(dir, "s", "e.sh"), "echo e\n");
  mkdirSync(path.join(root, "out"));
  writeFileSync(path.join(root, "out", "a.sh"), "echo d\n");
  symlinkSync(path.join(root, "out"), path.join(dir, "d"));
  const dirs = new Map<string, string>();
  const cases: [string, string | undefined][] = [["a.sh", undefined], ["link.sh", undefined], ["dl.sh", undefined], ["s/e.sh", path.join(dir, "s")], ["nope.sh", undefined], ["d/a.sh", undefined]];
  for (const [f, s] of cases) {
    assert.deepEqual(scopedTarget(dir, f, s, { cwd: realpathSync(dir), scratchpad: s && realpathSync(s), dirs }), scopedTarget(dir, f, s));
  }
  assert.ok(dirs.size >= 1);
});

test("resolveLintTarget: null for a file inside the payload scratchpad_dir", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "ul-rlt-"));
  mkdirSync(path.join(dir, "s"));
  writeFileSync(path.join(dir, "s", "e.sh"), "echo hi\n");
  assert.equal(resolveLintTarget({ ...mockResolveArgs(dir, "s/e.sh"), scratchpad_dir: path.join(dir, "s") }), null);
  assert.equal(resolveLintTarget(mockResolveArgs(dir, "s/e.sh")), path.join(dir, "s", "e.sh"));
});

test("recordWritten: stores the SHA-256 base64 of the file bytes at CLAUDE_PLUGIN_DATA/written/<hashPath(real)>", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "ul-rw-"));
  const data = path.join(dir, "data");
  const fp = path.join(dir, "a.sh");
  writeFileSync(fp, "echo hi\n");
  const real = realpathSync(fp);
  const prev = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = data;
  try {
    recordWritten(fp, real);
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
    else process.env.CLAUDE_PLUGIN_DATA = prev;
  }
  assert.equal(readFileSync(path.join(data, "written", hashPath(real)), "utf8"), createHash("sha256").update("echo hi\n").digest("base64"));
});

test("WATCH_LIMIT is 5000", () => {
  assert.equal(WATCH_LIMIT, 5000);
});

/**
 * A fresh directory under the OS temp dir, so configExists's per-process memo has no entry for it yet.
 *
 * @returns The new directory.
 */
const freshCeDir = (): string => mkdtempSync(path.join(tmpdir(), "ul-ce-"));

test("configExists: default (no /mnt/ gate) is plain existsSync", () => {
  const d = freshCeDir();
  writeFileSync(path.join(d, "eslint.config.js"), "");
  assert.equal(configExists(d, "eslint.config.js"), true);
  assert.equal(configExists(d, "eslint.config.mjs"), false);
});

test("configExists: forced prefilter matches case-insensitively but confirms with existsSync", () => {
  const upper = freshCeDir();
  writeFileSync(path.join(upper, "ESLINT.CONFIG.JS"), "");
  assert.equal(configExists(upper, "eslint.config.js", true), false); // listed (upper-cased), existsSync says no on ext4
  const lower = freshCeDir();
  writeFileSync(path.join(lower, "eslint.config.js"), "");
  assert.equal(configExists(lower, "eslint.config.js", true), true);
});

test("configExists: forced prefilter checks the first segment of a nested name", () => {
  const d = freshCeDir();
  mkdirSync(path.join(d, ".config"));
  writeFileSync(path.join(d, ".config", "stylelintrc.json"), "{}");
  assert.equal(configExists(d, ".config/stylelintrc.json", true), true);
  assert.equal(configExists(d, ".config/stylelintrc.yaml", true), false);
});

test("configExists: forced prefilter rejects a dangling symlink", () => {
  const d = freshCeDir();
  symlinkSync(path.join(d, "missing-target.json"), path.join(d, ".oxlintrc.json"));
  assert.equal(configExists(d, ".oxlintrc.json", true), false);
});

test("configExists: the listing is memoized per process (accepted staleness)", () => {
  const d = freshCeDir();
  assert.equal(configExists(d, "Cargo.toml", true), false); // lists d once
  writeFileSync(path.join(d, "Cargo.toml"), "");
  assert.equal(configExists(d, "Cargo.toml", true), false); // memoized listing does not see the new file
  assert.equal(configExists(d, "Cargo.toml", false), true); // existsSync does
});

test.skipIf(process.getuid?.() === 0)("configExists: unreadable (x-only) directory falls back to existsSync", () => {
  const d = freshCeDir();
  writeFileSync(path.join(d, "tsconfig.json"), "{}");
  chmodSync(d, 0o111);
  try {
    assert.equal(configExists(d, "tsconfig.json", true), true);
  } finally {
    chmodSync(d, 0o755);
  }
});

test("gateFinding: a long whitespace-free line (minified) stays linear and keeps the located hit", () => {
  const resolved = path.join(GATE_DIR, "a.js");
  const text = `a.js:1:5: error: no-eval\n${"ab.c".repeat(256 * 1024)}`; // 1 MiB single token, the dotty worst case
  assert.ok(gateFinding(gf(text), null, resolved)?.text.startsWith("a.js:1:5")); // Write path
  assert.ok(gateFinding(gf(text), [[0, 0]], resolved)?.text.startsWith("a.js:1:5")); // Edit path, hit
  assert.equal(gateFinding(gf(text), [[7, 7]], resolved), null); // Edit path, miss gated
});
