// Shared harness for the universal-lint tests (not a test file: vitest only runs *.test.ts).
// Hermetic: PATH holds only bash, node, git plus the linter stubs a test adds; HOME and CLAUDE_PLUGIN_DATA are per-test.
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll } from "vitest";
import { startServer } from "./call-server.ts";

/** The built plugin under test. */
export const PLUGIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../plugin");
/** The built watch-list command hook (SessionStart, CwdChanged). */
export const WATCH = path.join(PLUGIN, "hooks/watch-paths.mjs");
/** The built function-hooks module. */
export const MOD = path.join(PLUGIN, "hooks/register.js");
/** The built skill driver. */
export const DRIVER = path.join(PLUGIN, "skills/universal-lint/lint-files.mjs");
/** The built MCP server. */
export const SERVER = path.join(PLUGIN, "mcp/server.mjs");
/** The one-shot driver and server client (plain node script). */
export const CALL = path.join(path.dirname(fileURLToPath(import.meta.url)), "call-server.ts");

/** Every server `LintEnv.server` started in this test file; closed when it ends. */
const servers: ReturnType<typeof startServer>[] = [];
afterAll(async () => {
  await Promise.all(servers.map((s) => s.close()));
});

/** One scratch root for the whole test file, removed when it finishes. */
const ROOT = mkdtempSync(path.join(tmpdir(), "universal-lint-test-"));
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));
/** Counter giving every `makeEnv` its own directory. */
let counter = 0;

/** Result of one run: the watch-list command hook (SessionStart, CwdChanged) or one server driven through `CALL`. */
export interface HookRun {
  /** 2 when a report text came back, else the process's exit status (0; null when killed by a signal). */
  status: number | null;
  /** The server's stderr plus the driver's (the watch-list hook's own stderr for SessionStart/CwdChanged). */
  stderr: string;
  /** Raw stdout of the watch-list hook (its watch-paths JSON); "" for a server run. */
  stdout: string;
  /** `{ rewake: <report> }` when a report text came back, `{}` otherwise (no finding). */
  result: { rewake?: string };
  /** The report text (`file_edited` context, `stop` reason), or "" when there is none. */
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
  /** The recorded lines. */
  lines(): string[];
  /** Env of a child process. */
  childEnv(opts?: RunOptions): Record<string, string>;
  /** Send one Write/Edit payload for `filePath` to a fresh server (`file_edited`, through `CALL`). */
  run(filePath: string, opts?: RunOptions): HookRun;
  /** Run one hook payload: SessionStart/CwdChanged through the watch-list hook, any other event through a fresh server (`CALL`). */
  runEvent(payload: Record<string, unknown>, opts?: RunOptions): HookRun;
  /** One server process with this env (multi-call tests); closed when the test file ends. */
  server(opts?: RunOptions & { cwd?: string }): ReturnType<typeof startServer>;
}

/**
 * The PostToolUse payload the hook reads from stdin.
 *
 * @param filePath - Written file.
 * @param cwd - Payload cwd.
 * @param opts - Run options; `toolName` and `toolResponse` shape the payload.
 * @returns The JSON text; a Write carries the file's current text as `tool_input.content`, as Claude Code's does.
 */
export const payload = (filePath: string, cwd: string, opts: RunOptions = {}): string => {
  const tool = opts.toolName ?? "Write";
  let content: string | undefined;
  try {
    if (tool === "Write") content = readFileSync(path.resolve(cwd, filePath), "utf8");
  } catch {
    // no such file: the payload carries no content
  }
  return JSON.stringify({ hook_event_name: "PostToolUse", tool_name: tool, tool_input: { file_path: filePath, content }, tool_response: { success: true, ...opts.toolResponse }, cwd });
};

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
    lines: () => readFileSync(record, "utf8").split("\n").filter(Boolean),
    // UNIVERSAL_LINT_SETTLE_MS=0: findings are reported at once; a test of the settle window overrides it through opts.env.
    childEnv: (opts = {}) => ({ PATH: bin, HOME: home, RECORD: record, OUT: opts.out ?? "", CLAUDE_PLUGIN_DATA: data, GIT_CONFIG_NOSYSTEM: "1", UNIVERSAL_LINT_SETTLE_MS: "0", ...opts.env }),
    run: (filePath, opts) => env.runEvent(JSON.parse(payload(filePath, cwd, opts)) as Record<string, unknown>, opts),
    runEvent(p, opts) {
      const ev = p["hook_event_name"];
      if (ev === "SessionStart" || ev === "CwdChanged") {
        const r = spawnSync(process.execPath, [WATCH], { input: JSON.stringify(p), env: env.childEnv(opts), encoding: "utf8" });
        return { status: r.status, stderr: r.stderr, stdout: r.stdout, result: {}, ctx: "" };
      }
      const r = spawnSync(process.execPath, [CALL, SERVER], { input: JSON.stringify(p), env: env.childEnv(opts), encoding: "utf8" });
      const out = JSON.parse(r.stdout || "{\"text\":\"\",\"stderr\":\"\"}") as { text: string; stderr: string };
      const ctx = out.text.trim();
      return { status: ctx ? 2 : r.status, stderr: out.stderr + r.stderr, stdout: "", result: ctx ? { rewake: ctx } : {}, ctx };
    },
    server: (opts = {}) => {
      const s = startServer(SERVER, env.childEnv(opts), opts.cwd ?? cwd);
      servers.push(s);
      return s;
    },
  };
  return env;
}
