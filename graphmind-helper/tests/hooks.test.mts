// The built command hooks and MCP wrapper, run as processes with a fake `graphmind` on PATH and a temp HOME.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, test } from "vitest";
import { searchTerms } from "../plugin/bin/gm-prompt.mjs";
import { indexable } from "../plugin/bin/mcp.mjs";

const BIN = fileURLToPath(new URL("../plugin/bin/", import.meta.url));
let root = "";
let home = "";
let proj = "";
let fakeBin = "";

/** A fake graphmind: logs every call, `which` follows the REGISTERED file, memory and status answer fixed text. */
const FAKE = `#!/bin/sh
echo "$@" >> "$FAKE_LOG"
case "$1" in
  which) [ -f "$FAKE_REGISTERED" ] && echo slug && exit 0; exit 1 ;;
  init) touch "$FAKE_REGISTERED"; exit 0 ;;
  status) echo "Project: p"; echo "Graph: 1 symbols" ;;
  map) echo ">> Graph map"; echo "  top file" ;;
  memory)
    case "$2" in
      list) echo ">> mem"; echo "★ aaaaaaaa [decision] always use X" ;;
      search) echo "bbbbbbbb [pattern] about foo_bar" ;;
    esac ;;
  search) echo "  foo [Function] a.ts:1" ;;
esac
exit 0
`;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "gmh-"));
  home = join(root, "home");
  proj = join(root, "proj");
  fakeBin = join(root, "bin");
  for (const d of [home, proj, fakeBin, join(proj, ".git")]) mkdirSync(d, { recursive: true });
  writeFileSync(join(fakeBin, "graphmind"), FAKE);
  chmodSync(join(fakeBin, "graphmind"), 0o755);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

/**
 * Runs a built script.
 *
 * @param name - File in `plugin/bin`.
 * @param input - Hook payload.
 * @param opts - `registered` creates the project registration; `noBinary` leaves the fake off PATH.
 * @returns Process result and the fake's call log.
 */
function runScript(name: string, input: object, opts: { registered?: boolean; noBinary?: boolean } = {}) {
  const log = join(root, "calls.log");
  const reg = join(root, "registered");
  rmSync(reg, { force: true });
  if (opts.registered) writeFileSync(reg, "");
  const r = spawnSync(process.execPath, [join(BIN, name)], {
    cwd: proj,
    input: JSON.stringify(input),
    encoding: "utf8",
    env: { HOME: home, PATH: `${opts.noBinary ? "" : `${fakeBin}:`}/usr/bin:/bin`, FAKE_LOG: log, FAKE_REGISTERED: reg },
    timeout: 20_000,
  });
  return { r, calls: existsSync(log) ? readFileSync(log, "utf8") : "" };
}

test("session briefing in a registered project carries status, map and priority memory", () => {
  const { r } = runScript("gm-session.mjs", { session_id: "s1" }, { registered: true });
  const ctx = (JSON.parse(r.stdout) as { hookSpecificOutput: { additionalContext: string } }).hookSpecificOutput.additionalContext;
  assert.match(ctx, /Project indexed and ready/);
  assert.match(ctx, /Graph: 1 symbols/);
  assert.match(ctx, /always use X/);
  assert.equal(readFileSync(join(home, ".graphmind/hook-state/s1/priority-ids"), "utf8"), "aaaaaaaa\n");
});

test("hooks are silent without the binary and outside a registered project", () => {
  assert.equal(runScript("gm-session.mjs", { session_id: "s" }, { registered: true, noBinary: true }).r.stdout, "");
  assert.equal(runScript("gm-session.mjs", { session_id: "s" }).r.stdout, "");
  assert.equal(runScript("gm-prompt.mjs", { session_id: "s", prompt: "where is foo_bar defined" }).r.stdout, "");
});

test("hooks pass when setup already wired them into settings.json", () => {
  mkdirSync(join(home, ".claude"), { recursive: true });
  writeFileSync(join(home, ".claude/settings.json"), "{\"hooks\":{\"x\":\"/h/graphmind-session.sh\"}}");
  assert.equal(runScript("gm-session.mjs", { session_id: "s" }, { registered: true }).r.stdout, "");
});

test("prompt recall adds memory and code, a save reminder comes on the 10th prompt, short prompts are skipped", () => {
  const input = { session_id: "s2", prompt: "where is foo_bar defined in the code" };
  const first = runScript("gm-prompt.mjs", input, { registered: true });
  const ctx = (JSON.parse(first.r.stdout) as { hookSpecificOutput: { additionalContext: string } }).hookSpecificOutput.additionalContext;
  assert.match(ctx, /\[graphmind memory\] Relevant:/);
  assert.match(ctx, /about foo_bar/);
  assert.match(ctx, /\[graphmind code\] Relevant symbols:/);
  assert.equal(runScript("gm-prompt.mjs", { session_id: "s2", prompt: "short" }, { registered: true }).r.stdout, "");
  writeFileSync(join(home, ".graphmind/hook-state/s2/turns"), "9\n");
  const tenth = runScript("gm-prompt.mjs", { session_id: "s2", prompt: "something entirely different here" }, { registered: true });
  assert.match(tenth.r.stdout, /graphmind checkpoint — prompt 10/);
});

test("searchTerms puts identifiers first and drops stopwords", () => {
  assert.equal(searchTerms("where is parseConfig and foo_bar defined"), "parseconfig foo_bar defined");
});

test("search nudge fires once per session for grep, never for graphmind itself", () => {
  const grep = { session_id: "s3", tool_name: "Bash", tool_input: { command: "grep -rn foo src" } };
  assert.equal(runScript("gm-search.mjs", { ...grep, tool_input: { command: "graphmind search foo" } }, { registered: true }).r.stdout, "");
  assert.match(runScript("gm-search.mjs", grep, { registered: true }).r.stdout, /graphmind-indexed/);
  assert.equal(runScript("gm-search.mjs", grep, { registered: true }).r.stdout, "");
});

test("mcp wrapper in an unregistered git repo runs init --skip-build, a background build, then mcp", async () => {
  const { r, calls } = runScript("mcp.mjs", {});
  assert.equal(r.status, 0);
  const lines = calls.trim().split("\n");
  assert.ok(lines.includes("init --skip-build"));
  assert.equal(lines.at(-1), "mcp");
  await new Promise((done) => setTimeout(done, 300));
  assert.match(readFileSync(join(root, "calls.log"), "utf8"), /^build$/m);
});

test("mcp wrapper with the setup's server in ~/.claude.json still inits but does not serve", () => {
  writeFileSync(join(home, ".claude.json"), "{\"mcpServers\":{\"graphmind\":{\"command\":\"graphmind\"}}}");
  const { calls } = runScript("mcp.mjs", {});
  assert.match(calls, /init --skip-build/);
  assert.doesNotMatch(calls, /^mcp$/m);
});

test("mcp wrapper without the binary exits 1; home and non-git folders are not indexable", () => {
  assert.equal(runScript("mcp.mjs", {}, { noBinary: true }).r.status, 1);
  assert.equal(indexable(root), false);
  assert.equal(indexable(proj), true);
});
