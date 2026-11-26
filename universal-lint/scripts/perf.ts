#!/usr/bin/env node
// Usage: node universal-lint/scripts/perf.ts [runs=5]   (from any directory; run `pnpm --filter universal-lint build` first)
// Per-call cost of the built server plugin/mcp/server.mjs (one process per PATH variant) and of plugin/hooks/watch-paths.mjs
// (dev only, never shipped). The Write/Edit and FileChanged rows are tool calls of the server, timed from writing the
// tools/call line to its answer line; the SessionStart rows and the floor spawn their process directly. 16 cases, once
// with the real PATH and once with the /mnt/ dirs removed, print a Markdown table of median (min-max) ms over `runs`
// timed rounds after one warm-up round. Fixtures live in an os.tmpdir() directory removed at the end; nothing is written
// into the repo. Needs the real linters on PATH to reproduce real costs; the header lists which of them were found per PATH variant.
// Exit 0 = every run passed its check, 1 = a case failed, 2 = usage error, missing build or a setup/spawn error.
import { execFileSync, spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { availableParallelism, homedir, loadavg, release, tmpdir, totalmem } from "node:os";
import { dirname, join, resolve } from "node:path";

/** The universal-lint plugin directory (parent of scripts/). */
const ROOT = resolve(import.meta.dirname, "..");
/** The built MCP server under measurement (one process per PATH variant). */
const SERVER = join(ROOT, "plugin/mcp/server.mjs");
/** The built SessionStart/CwdChanged watch-paths hook under measurement. */
const WATCH = join(ROOT, "plugin/hooks/watch-paths.mjs");
/** universal-lint version from package.json (the only manifest source). */
const VERSION = String((JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as Record<string, unknown>).version);
/** Per-run kill timeout: above the 90 s tool-call budget, so a server-side kill shows as its own status. */
const RUN_TIMEOUT_MS = 120_000;
/** Linters the cases invoke (`.sh`, `.py`, `.yml`, `.md`, `.css`, `.ts`, `.mts`); the header says which were found on PATH. */
const TOOLS = ["shellcheck", "ruff", "yamllint", "markdownlint-cli2", "eslint", "oxlint", "stylelint"];
/** Printed to stderr on a bad argument. */
const USAGE = "usage: node universal-lint/scripts/perf.ts [runs=5]";
/** Session id the harness uses for its one main-conversation session per server. */
const SESSION = "perf";

/** A JSON object of a tool answer or a hook answer. */
type Answer = Record<string, unknown>;

/** One measured case (a table row). */
interface Case {
  /** Row name. */
  name: string;
  /** Spawn cwd, and the cwd of the payload. */
  cwd: string;
  /** Hook payload; null = the floor case (`node -e 0`, no hook). */
  payload: object | null;
  /** Expected exit status: 0 = no finding or skip, 2 = finding. */
  expect: number;
  /** The server tool the row calls, from the payload's event; null = a spawned process (watch-paths or the floor). */
  tool: "file_edited" | "file_changed" | null;
  /** Extra per-run assertion: `"watchPaths"` in stdout, or `"skipped"`: a FileChanged of `a.sh` right after its Write is skipped. */
  observable?: "watchPaths" | "skipped";
}

/** One timed run. */
interface Run {
  /** Wall time, ms. */
  ms: number;
  /** Exit status (0 or 2 for a server row); null when killed by a signal. */
  status: number | null;
  /** Captured stdout (spawned rows only). */
  stdout: string;
  /** Captured stderr, or the finding text of a server row. */
  stderr: string;
}

/** One running server with its session key: the JSON-RPC line client of tests/support/call-server.ts (scripts do not import tests). */
interface Server {
  /** The session key the server issued for `SESSION`. */
  key: string;
  /**
   * Call a tool; resolves with its structured content (`{}` for a JSON-RPC error).
   *
   * @param tool - Tool name.
   * @param args - Tool arguments.
   */
  call(tool: string, args: object): Promise<Answer>;
  /** Close stdin and wait for the process to exit (killed after `RUN_TIMEOUT_MS`). */
  close(): Promise<void>;
}

/**
 * Run git with a throwaway identity and the user's global signing and hook config neutralised (a `commit.gpgsign` or a
 * global `core.hooksPath` pre-commit hook would otherwise fail the fixture commit); output is discarded, a failure throws.
 *
 * @param cwd - Repository directory.
 * @param args - git arguments.
 */
function git(cwd: string, ...args: string[]): void {
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args], { cwd, stdio: "ignore" });
}

/**
 * The server tool a payload's row calls: `file_changed` for a FileChanged payload, `null` for a SessionStart payload
 * (watch-paths) and for the floor (no payload), `file_edited` for everything else (PostToolUse and the empty payload).
 *
 * @param payload - The row's payload, or null for the floor.
 * @returns The tool name, or null when the row spawns a process.
 */
function toolOf(payload: object | null): Case["tool"] {
  if (payload === null) return null;
  const ev = (payload as { hook_event_name?: unknown }).hook_event_name;
  if (ev === "SessionStart") return null;
  return ev === "FileChanged" ? "file_changed" : "file_edited";
}

/**
 * Write the fixture repo into `dir` (one commit of every tracked file) and build the case list.
 *
 * @param dir - Empty fixture directory.
 * @returns The 16 cases in run order (a `.css` row is dropped by `main` when a stylelint config is visible).
 */
function makeFixtures(dir: string): Case[] {
  const sh = "#!/bin/sh\necho ok\n";
  const fns = Array.from({ length: 28 }, (_, k) => `export function f${k + 1}(a: number): number { return a + ${k + 1}; }`);
  const files: Record<string, string> = {
    "a.json": "{}\n",
    "a.sh": sh,
    "t.sh": sh, // FileChanged target only: no Write/Edit case may record a digest for it
    "a.py": "x = 1\n",
    "a.yml": "a: 1\n",
    "a.md": "# T\n\nText.\n",
    "a.css": ".a{color:red;}\n",
    "a.ts": ["export const x: number = 1;", "export const y: string = \"2\";", ...fns, ""].join("\n"),
    "tsconfig.json": "{\"compilerOptions\":{\"strict\":true,\"noEmit\":true},\"include\":[\"a.ts\"]}\n",
    ".gitignore": "ign.sh\ndata/\n",
    "ign.sh": sh,
  };
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
  mkdirSync(join(dir, "data"));
  git(dir, "init", "-q");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "fixture");
  const repo = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: ROOT, encoding: "utf8" }).trim();
  /** PostToolUse payload for fixture file `f`. */
  const post = (tool: string, f: string, extra: Record<string, unknown> = {}): object => ({ hook_event_name: "PostToolUse", tool_name: tool, tool_input: { file_path: join(dir, f), content: tool === "Write" ? files[f] : undefined }, tool_response: { success: true, ...extra }, cwd: dir });
  /** FileChanged payload for fixture file `f`. */
  const changed = (event: string, f: string): object => ({ hook_event_name: "FileChanged", event, file_path: join(dir, f), cwd: dir });
  /** SessionStart payload for `cwd`. */
  const start = (cwd: string): object => ({ hook_event_name: "SessionStart", source: "startup", cwd });
  /** Edit hunk replacing line 1 of a.ts (EDIT_L1 shape from tests/tsc.test.ts). */
  const edit = { structuredPatch: [{ oldStart: 1, oldLines: 2, newStart: 1, newLines: 2, lines: ["-export const x = 1;", "+export const x: number = 1;", " export const y: string = \"2\";"] }] };
  const rows: Omit<Case, "tool">[] = [
    { name: "floor node -e 0", cwd: dir, payload: null, expect: 0 },
    { name: "empty payload", cwd: dir, payload: {}, expect: 0 },
    { name: "out-of-scope .json Write", cwd: dir, payload: post("Write", "a.json"), expect: 0 },
    { name: ".sh Write", cwd: dir, payload: post("Write", "a.sh"), expect: 0, observable: "skipped" },
    { name: ".py Write", cwd: dir, payload: post("Write", "a.py"), expect: 0 },
    { name: ".yml Write", cwd: dir, payload: post("Write", "a.yml"), expect: 0 },
    { name: ".md Write", cwd: dir, payload: post("Write", "a.md"), expect: 0 },
    { name: ".css Write (no stylelint config)", cwd: dir, payload: post("Write", "a.css"), expect: 0 },
    { name: ".ts Write (no eslint config)", cwd: dir, payload: post("Write", "a.ts"), expect: 0 },
    { name: ".ts Edit (no eslint config)", cwd: dir, payload: post("Edit", "a.ts", edit), expect: 0 },
    // A real repo file through the root .oxlintrc.json and node_modules/.bin/oxlint (F04's local-bin route).
    { name: ".mts Write (this repo)", cwd: repo, payload: { hook_event_name: "PostToolUse", tool_name: "Write", tool_input: { file_path: join(repo, "universal-lint/scripts/perf.ts") }, tool_response: { success: true }, cwd: repo }, expect: 0 },
    { name: "FileChanged tracked unchanged", cwd: dir, payload: changed("change", "t.sh"), expect: 0 },
    { name: "FileChanged ignored", cwd: dir, payload: changed("change", "ign.sh"), expect: 0 },
    { name: "FileChanged unlink", cwd: dir, payload: changed("unlink", "a.sh"), expect: 0 },
    { name: "SessionStart fixture", cwd: dir, payload: start(dir), expect: 0, observable: "watchPaths" },
    { name: "SessionStart this repo", cwd: repo, payload: start(repo), expect: 0, observable: "watchPaths" },
  ];
  return rows.map((c) => ({ tool: toolOf(c.payload), ...c }));
}

/**
 * A stylelint config the hook could find for a file in `dir`: a config file name in `dir`, `dir/.config` or an ancestor
 * (loose name pattern: a false hit only drops the `.css` row), a `package.json` with a `stylelint` key, or an existing
 * user config dir. The `.css` row measures the no-config skip, so a visible config would time stylelint instead.
 *
 * @param dir - Fixture directory.
 * @returns Path of the first config found, or null.
 */
function stylelintConfigVisible(dir: string): string | null {
  const home = homedir();
  const user = [process.env.XDG_CONFIG_HOME || join(home, ".config"), join(home, "Library", "Preferences")].map((d) => join(d, "stylelint")).find((p) => existsSync(p));
  if (user) return user;
  for (let d = dir;; d = dirname(d)) {
    for (const x of [d, join(d, ".config")]) {
      try {
        const hit = readdirSync(x).find((n) => /^\.?stylelint(rc|\.config)(\.\w+)?$/.test(n));
        if (hit) return join(x, hit);
      } catch { /* unreadable or absent: no config there */ }
    }
    try {
      if ((JSON.parse(readFileSync(join(d, "package.json"), "utf8")) as { stylelint?: unknown } | null)?.stylelint != null) return join(d, "package.json");
    } catch { /* no package.json or invalid: no key */ }
    if (dirname(d) === d) return null;
  }
}

/**
 * One-time fixture precheck and header label: the PATH `tsc` must type-check the fixture tsconfig.json, so a `.ts`
 * row never times a silently skipped tsc config-load failure. No `--incremental`: writes nothing, builds no cache.
 *
 * @param dir - Fixture directory.
 * @returns `tsc <version>`, or `tsc absent` when no tsc is on PATH.
 */
function tscLabel(dir: string): string {
  let version: string;
  try {
    version = execFileSync("tsc", ["--version"], { encoding: "utf8" }).trim();
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return "tsc absent";
    throw new Error("tsc --version failed", { cause: e });
  }
  try {
    execFileSync("tsc", ["--noEmit", "-p", join(dir, "tsconfig.json")], { cwd: dir, encoding: "utf8" });
  } catch (e) {
    throw new Error(`fixture tsconfig.json rejected by tsc: ${(e as { stdout?: string }).stdout ?? ""}`, { cause: e });
  }
  return `tsc ${version.replace(/^Version /, "")}`;
}

/**
 * Whether an executable-named file `tool` exists in a directory of `path`.
 *
 * @param tool - Command name.
 * @param path - A PATH value.
 */
function onPath(tool: string, path: string): boolean {
  return path.split(":").some((d) => d !== "" && existsSync(join(d, tool))); // shortcut: existence only, exec bit not checked
}

/**
 * Spawn one run of a process row (the SessionStart rows run watch-paths, the floor runs `node -e 0`) with `payloadFile`
 * as stdin (a file descriptor, so the timing excludes the parent's pipe writes) and time it.
 *
 * @param c - The case; `payload: null` spawns the bare `node -e 0`, resolved through `env.PATH` like a hook's shebang.
 * @param payloadFile - Payload JSON file.
 * @param env - Child environment.
 * @returns Wall time, exit status (null when killed after `RUN_TIMEOUT_MS`), stdout and stderr.
 */
function runOnce(c: Case, payloadFile: string, env: NodeJS.ProcessEnv): Promise<Run> {
  return new Promise((done, fail) => {
    const fd = openSync(payloadFile, "r");
    const t0 = process.hrtime.bigint();
    const child = c.payload === null
      ? spawn("node", ["-e", "0"], { cwd: c.cwd, env, stdio: [fd, "pipe", "pipe"] })
      : spawn(WATCH, [], { cwd: c.cwd, env, stdio: [fd, "pipe", "pipe"] });
    closeSync(fd); // the child holds its own copy once spawn() returns
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8").on("data", (s: string) => (stdout += s));
    child.stderr?.setEncoding("utf8").on("data", (s: string) => (stderr += s));
    const timer = setTimeout(() => child.kill("SIGKILL"), RUN_TIMEOUT_MS);
    child.on("error", (e) => {
      clearTimeout(timer);
      fail(e);
    });
    child.on("close", (status: number | null) => {
      const ms = Number(process.hrtime.bigint() - t0) / 1e6;
      clearTimeout(timer);
      done({ ms, status, stdout, stderr });
    });
  });
}

/**
 * Start one server with `env` in `cwd` and fetch the harness session's key (a keyless `next_report` with `wait_ms: 0`).
 *
 * @param env - Child environment (one PATH variant).
 * @param cwd - Server working directory.
 * @returns The running server; its `key` is the session key.
 */
async function startServer(env: NodeJS.ProcessEnv, cwd: string): Promise<Server> {
  const child = spawn(SERVER, [], { env, cwd, stdio: ["pipe", "pipe", "pipe"] });
  const closed = new Promise<void>((resolve) => child.on("close", () => resolve()));
  child.stderr.resume();
  const waiting = new Map<number, (answer: Answer) => void>();
  let id = 0;
  let buf = "";
  child.stdout.setEncoding("utf8").on("data", (d: string) => {
    buf += d;
    for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
      const m = JSON.parse(buf.slice(0, i)) as { id?: number; result?: { structuredContent?: Answer } };
      buf = buf.slice(i + 1);
      if (m.id !== undefined) {
        waiting.get(m.id)?.(m.result?.structuredContent ?? {});
        waiting.delete(m.id);
      }
    }
  });
  const call = (tool: string, args: object): Promise<Answer> => {
    const n = ++id;
    return new Promise((resolve) => {
      waiting.set(n, resolve);
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: n, method: "tools/call", params: { name: tool, arguments: args } }) + "\n");
    });
  };
  const key = String((await call("next_report", { session_id: SESSION, wait_ms: 0 }))["key"]);
  return {
    key,
    call,
    close: async () => {
      const timer = setTimeout(() => child.kill("SIGKILL"), RUN_TIMEOUT_MS);
      child.stdin.end();
      await closed;
      clearTimeout(timer);
    },
  };
}

/**
 * Run one case: a server row calls its tool (timed from the request line to the answer line, the findings of a
 * FileChanged row drained after the timing); a process row spawns its process.
 *
 * @param c - The case.
 * @param payloadFile - Payload JSON file (process rows only).
 * @param env - Child environment (process rows only).
 * @param s - The server of this PATH variant.
 * @returns The run; a server row's status is 2 when its answer carries a finding (`context`), else 0.
 */
async function runCase(c: Case, payloadFile: string, env: NodeJS.ProcessEnv, s: Server): Promise<Run> {
  if (c.tool === null) return runOnce(c, payloadFile, env);
  const args = c.payload !== null && Object.keys(c.payload).length > 0 ? { ...c.payload, session_id: SESSION, key: s.key } : {};
  const t0 = process.hrtime.bigint();
  const answer = await s.call(c.tool, args);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  if (c.tool === "file_changed") await s.call("prompt_submitted", { cwd: c.cwd, session_id: SESSION }); // drain outside the timing
  const context = typeof answer["context"] === "string" ? answer["context"] : "";
  return { ms, status: context === "" ? 0 : 2, stdout: "", stderr: context };
}

/**
 * The `skipped` observable, checked outside the timing: a FileChanged of `a.sh` right after its Write leaves no
 * report (the keyed `next_report` answers `timeout`). Drains whatever a report left.
 *
 * @param s - The server of this PATH variant.
 * @param dir - Fixture directory.
 * @returns Whether the FileChanged was skipped.
 */
async function skipped(s: Server, dir: string): Promise<boolean> {
  await s.call("file_changed", { hook_event_name: "FileChanged", event: "change", file_path: join(dir, "a.sh"), cwd: dir, session_id: SESSION });
  const state = (await s.call("next_report", { session_id: SESSION, key: s.key, wait_ms: 0 }))["state"];
  await s.call("prompt_submitted", { cwd: dir, session_id: SESSION });
  return state === "timeout";
}

/**
 * Median, min and max, rounded to integer ms.
 *
 * @param xs - Samples (at least one).
 * @returns The rounded statistics; the median of an even count is the mean of the middle two.
 */
function stats(xs: number[]): { med: number; min: number; max: number } {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  const med = s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
  return { med: Math.round(med), min: Math.round(s[0]), max: Math.round(s[s.length - 1]) };
}

/** Parse the arguments, run every case `1 + runs` times per PATH variant, print header and table, set the exit code. */
async function main(): Promise<void> {
  const arg = process.argv[2] ?? "5";
  if (process.argv.length > 3 || !/^\d+$/.test(arg) || Number(arg) < 1) {
    console.error(USAGE);
    process.exit(2);
  }
  if (!existsSync(SERVER) || !existsSync(WATCH)) {
    console.error("build first: pnpm --filter universal-lint build");
    process.exit(2);
  }
  const runs = Number(arg);
  const realPath = process.env.PATH ?? "";
  const dirs = realPath.split(":");
  const mnt = dirs.filter((d) => d.startsWith("/mnt/")).length;
  // without /mnt/ entries both variants are the same PATH: run only the real one
  const paths = mnt > 0 ? [realPath, dirs.filter((d) => !d.startsWith("/mnt/")).join(":")] : [realPath];
  const dir = mkdtempSync(join(tmpdir(), "ul-perf-"));
  const servers: Server[] = [];
  try {
    const seen = stylelintConfigVisible(dir);
    if (seen) console.error(`skipping the .css row: a stylelint config is visible from the fixture dir (${seen}), so it would not measure the no-config skip`);
    const cases = makeFixtures(dir).filter((c) => !(seen && c.name.startsWith(".css Write")));
    const tsc = tscLabel(dir);
    const data = join(dir, "data");
    cases.forEach((c, i) => writeFileSync(join(data, `p${i}.json`), JSON.stringify(c.payload ?? {})));
    // UNIVERSAL_LINT_SETTLE_MS=0: the harness measures lint cost, not the quiet-time hold of findings (F34, F40)
    const base: NodeJS.ProcessEnv = { ...process.env, CLAUDE_PLUGIN_DATA: data, UNIVERSAL_LINT_SETTLE_MS: "0" };
    delete base.NODE_OPTIONS;
    const envs = paths.map((PATH) => ({ ...base, PATH }));
    for (const env of envs) servers.push(await startServer(env, dir));
    const times = cases.map(() => envs.map((): number[] => []));
    const fails = cases.map(() => new Map<string, number>());
    const firstErr = cases.map((): string | null => null);
    const load0 = loadavg()[0].toFixed(2);
    for (let round = 0; round <= runs; round++) {
      for (const [v, env] of envs.entries()) {
        for (const [i, c] of cases.entries()) {
          const r = await runCase(c, join(data, `p${i}.json`), env, servers[v]);
          process.stderr.write(".");
          if (round > 0) times[i][v].push(r.ms);
          const labels: string[] = [];
          if (r.status === null) labels.push("killed");
          else if (r.status !== c.expect) labels.push(`expected ${c.expect}, got ${r.status}`);
          if (c.observable === "watchPaths" && !r.stdout.includes("\"watchPaths\"")) labels.push("no watchPaths");
          if (c.observable === "skipped" && !(await skipped(servers[v], dir))) labels.push("a.sh FileChanged after Write not skipped");
          for (const l of labels) fails[i].set(l, (fails[i].get(l) ?? 0) + 1);
          if (labels.length > 0 && firstErr[i] === null) firstErr[i] = r.stderr;
        }
      }
    }
    process.stderr.write("\n");
    const load1 = loadavg()[0].toFixed(2);
    const total = (runs + 1) * envs.length;
    const pathField = mnt > 0 ? `PATH ${dirs.length} dirs (${mnt} on /mnt)` : `PATH ${dirs.length} dirs (0 on /mnt, no-/mnt variant skipped)`;
    const names = mnt > 0 ? ["real PATH", "no /mnt"] : ["PATH"];
    const toolField = paths.map((p, v) => `${names[v]} ${TOOLS.filter((t) => onPath(t, p)).join("+") || "none"}`).join("; ");
    /** One table cell: `med (min-max)`, or `-` for a variant that did not run. */
    const cell = (xs: number[] | undefined): string => {
      if (!xs) return "-";
      const s = stats(xs);
      return `${s.med} (${s.min}-${s.max})`;
    };
    const out = [
      `universal-lint ${VERSION} perf, ${new Date().toISOString()}, ${release()}, ${availableParallelism()} cores, ${(totalmem() / 2 ** 30).toFixed(1)} GB RAM, node ${process.version}, ${tsc}, linters found (of ${TOOLS.join("/")}): ${toolField}, local oxlint ${existsSync(join(ROOT, "..", "node_modules", ".bin", "oxlint")) ? "yes" : "no"}, ${pathField}, load ${load0} -> ${load1}, runs ${runs} (+1 warm-up)`,
      "",
      "| Case | real PATH med (min-max) ms | no /mnt med (min-max) ms | status |",
      "| --- | ---: | ---: | --- |",
    ];
    for (const [i, c] of cases.entries()) {
      const status = fails[i].size === 0 ? "ok" : [...fails[i]].map(([l, k]) => `${l} (${k}/${total})`).join("; ");
      out.push(`| ${c.name} | ${cell(times[i][0])} | ${cell(times[i][1])} | ${status} |`);
    }
    for (const [i, c] of cases.entries()) if (firstErr[i] !== null) out.push("", `${c.name} stderr:`, firstErr[i] ?? "");
    console.log(out.join("\n"));
    process.exitCode = fails.some((f) => f.size > 0) ? 1 : 0;
  } finally {
    await Promise.all(servers.map((s) => s.close()));
    rmSync(dir, { recursive: true, force: true });
  }
}

await main().catch((e: unknown) => {
  console.error(e); // 1 means "a case failed"; a setup or spawn error exits 2 (the fixture directory is already removed by main's finally)
  process.exitCode = 2;
});
