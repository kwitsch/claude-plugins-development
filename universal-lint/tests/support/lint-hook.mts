// Shared harness for the universal-lint tests (not a test file: vitest only runs *.test.mts).
// Hermetic: PATH holds only bash, node, git plus the linter stubs a test adds; HOME and CLAUDE_PLUGIN_DATA are per-test.
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll } from "vitest";

/** The built plugin under test. */
export const PLUGIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../plugin");
/** The built hook script. */
export const HOOK = path.join(PLUGIN, "hooks/lint-file.mjs");
/** The built skill driver. */
export const DRIVER = path.join(PLUGIN, "skills/universal-lint/lint-files.mjs");

/** One scratch root for the whole test file, removed when it finishes. */
const ROOT = mkdtempSync(path.join(tmpdir(), "universal-lint-test-"));
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));
/** Counter giving every `makeEnv` its own directory. */
let counter = 0;

/** Result of one hook run. */
export interface HookRun {
  /** Exit status (null when killed by a signal). */
  status: number | null;
  /** Raw stderr. */
  stderr: string;
  /** Raw stdout (the watch-paths JSON of SessionStart/CwdChanged). */
  stdout: string;
  /** `{ rewake: <findings> }` on exit 2 (asyncRewake wakes Claude), `{}` otherwise (no finding). */
  result: { rewake?: string };
  /** The findings text (stderr on exit 2), or "" when there is none. */
  ctx: string;
}

/** Options of one run. */
export interface RunOptions {
  /** Value of the stubs' `$OUT` (their stdout). */
  out?: string;
  /** Extra environment variables. */
  env?: Record<string, string>;
  /** Payload `tool_name`; default "Write" (whole file counts as edited). */
  toolName?: string;
  /** Extra payload `tool_response` fields (e.g. an Edit's `structuredPatch`), merged over `{ success: true }`. */
  toolResponse?: Record<string, unknown>;
}

/** A fresh isolated environment. */
export interface LintEnv {
  /** Stub directory, the whole PATH. */
  bin: string;
  /** Isolated HOME. */
  home: string;
  /** CLAUDE_PLUGIN_DATA. */
  data: string;
  /** Project directory (the hook payload's cwd). */
  cwd: string;
  /** File the recording stubs append `<name> <argv>` to. */
  record: string;
  /** Write a project file (parent directories are created); returns its absolute path. */
  file(rel: string, content?: string): string;
  /** Drop an executable bash stub into `bin`. */
  stub(name: string, ...lines: string[]): void;
  /** Recording stub: appends `<name> <argv>` to `$RECORD`, prints `$OUT`, exits with `exitCode`. */
  recStub(name: string, exitCode: number): void;
  /** rtk stub answering both `rtk rewrite ... __RTK_PROBE__` (prints `rtk <verb> __RTK_PROBE__`, exit 3) and `rtk <verb> ...` (records, prints `$OUT`). */
  rtkStub(verb: string, exitCode: number): void;
  /** The recorded lines. */
  lines(): string[];
  /** Env of a child process. */
  childEnv(opts?: RunOptions): Record<string, string>;
  /** Pipe one PostToolUse payload for `filePath` into a fresh hook process. */
  run(filePath: string, opts?: RunOptions): HookRun;
  /** Pipe an arbitrary hook payload (FileChanged, SessionStart, CwdChanged, ...) into a fresh hook process. */
  runEvent(payload: Record<string, unknown>, opts?: RunOptions): HookRun;
}

/**
 * The PostToolUse payload the hook reads from stdin.
 *
 * @param filePath - Written file.
 * @param cwd - Payload cwd.
 * @param opts - Run options; `toolName` and `toolResponse` shape the payload.
 * @returns The JSON text.
 */
export const payload = (filePath: string, cwd: string, opts: RunOptions = {}): string => JSON.stringify({ hook_event_name: "PostToolUse", tool_name: opts.toolName ?? "Write", tool_input: { file_path: filePath }, tool_response: { success: true, ...opts.toolResponse }, cwd });

/**
 * Build a HookRun from the exit status and raw stderr.
 *
 * @param status - Exit status.
 * @param stderr - Raw stderr.
 * @param stdout - Raw stdout.
 * @returns The run.
 */
function toRun(status: number | null, stderr: string, stdout: string): HookRun {
  const ctx = status === 2 ? stderr.trim() : "";
  return { status, stderr, stdout, result: ctx ? { rewake: ctx } : {}, ctx };
}

/**
 * Create a fresh isolated environment.
 *
 * @returns The environment; no linter stubs yet.
 */
export function makeEnv(): LintEnv {
  const base = path.join(ROOT, String(counter++));
  const bin = path.join(base, "bin");
  const home = path.join(base, "home");
  const data = path.join(base, "data");
  const cwd = path.join(base, "proj");
  for (const d of [bin, home, cwd]) mkdirSync(d, { recursive: true });
  for (const t of ["bash", "node", "git"]) {
    const src = spawnSync("sh", ["-c", `command -v ${t}`], { encoding: "utf8" }).stdout.trim();
    if (src) symlinkSync(src, path.join(bin, t));
  }
  const record = path.join(base, "record");
  writeFileSync(record, "");
  const env: LintEnv = {
    bin,
    home,
    data,
    cwd,
    record,
    file(rel, content = "") {
      const p = path.join(cwd, rel);
      mkdirSync(path.dirname(p), { recursive: true });
      writeFileSync(p, content);
      return p;
    },
    stub(name, ...lines) {
      const p = path.join(bin, name);
      writeFileSync(p, ["#!/usr/bin/env bash", ...lines, ""].join("\n"));
      chmodSync(p, 0o755);
    },
    recStub(name, exitCode) {
      env.stub(name, `printf "%s %s\\n" "${name}" "$*" >> "$RECORD"`, "printf '%s\\n' \"$OUT\"", `exit ${exitCode}`);
    },
    rtkStub(verb, exitCode) {
      env.stub(
        "rtk",
        `if [ "$1" = "rewrite" ]; then printf "rtk ${verb} __RTK_PROBE__\\n"; exit 3; fi`,
        "printf \"%s %s\\n\" \"rtk\" \"$*\" >> \"$RECORD\"",
        "printf '%s\\n' \"$OUT\"",
        `exit ${exitCode}`,
      );
    },
    lines: () => readFileSync(record, "utf8").split("\n").filter(Boolean),
    childEnv: (opts = {}) => ({ PATH: bin, HOME: home, RECORD: record, OUT: opts.out ?? "", CLAUDE_PLUGIN_DATA: data, GIT_CONFIG_NOSYSTEM: "1", ...opts.env }),
    run(filePath, opts) {
      const r = spawnSync(process.execPath, [HOOK], { input: payload(filePath, cwd, opts), env: env.childEnv(opts), encoding: "utf8" });
      return toRun(r.status, r.stderr, r.stdout);
    },
    runEvent(p, opts) {
      const r = spawnSync(process.execPath, [HOOK], { input: JSON.stringify(p), env: env.childEnv(opts), encoding: "utf8" });
      return toRun(r.status, r.stderr, r.stdout);
    },
  };
  return env;
}
