// The built MCP wrapper, run as a process with a fake `graphmind` on PATH and a temp HOME.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, test } from "vitest";
import { indexable } from "../plugin/bin/mcp.mjs";

const MCP = fileURLToPath(new URL("../plugin/bin/mcp.mjs", import.meta.url));
let root = "";
let home = "";
let proj = "";
let fakeBin = "";

/** A fake graphmind: logs every call, `which` follows the REGISTERED file, `init` creates it. */
const FAKE = `#!/bin/sh
echo "$@" >> "$FAKE_LOG"
case "$1" in
  which) [ -f "$FAKE_REGISTERED" ] && echo slug && exit 0; exit 1 ;;
  init) touch "$FAKE_REGISTERED"; exit 0 ;;
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
 * Runs the wrapper in the project directory.
 *
 * @param noBinary - Leave the fake off PATH.
 * @returns Process result and the fake's call log.
 */
function runWrapper(noBinary = false) {
  const log = join(root, "calls.log");
  const r = spawnSync(process.execPath, [MCP], {
    cwd: proj,
    encoding: "utf8",
    env: { HOME: home, PATH: `${noBinary ? "" : `${fakeBin}:`}/usr/bin:/bin`, FAKE_LOG: log, FAKE_REGISTERED: join(root, "registered") },
    timeout: 20_000,
  });
  return { r, calls: existsSync(log) ? readFileSync(log, "utf8") : "" };
}

test("in an unregistered git repo the wrapper runs init --skip-build, a background build, then mcp", async () => {
  const { r, calls } = runWrapper();
  assert.equal(r.status, 0);
  const lines = calls.trim().split("\n");
  assert.ok(lines.includes("init --skip-build"));
  assert.equal(lines.at(-1), "mcp");
  await new Promise((done) => setTimeout(done, 300));
  assert.match(readFileSync(join(root, "calls.log"), "utf8"), /^build$/m);
});

test("with the setup's server in ~/.claude.json the wrapper still inits but does not serve", () => {
  writeFileSync(join(home, ".claude.json"), "{\"mcpServers\":{\"graphmind\":{\"command\":\"graphmind\"}}}");
  const { calls } = runWrapper();
  assert.match(calls, /init --skip-build/);
  assert.doesNotMatch(calls, /^mcp$/m);
});

test("without the binary the wrapper exits 1; home and non-git folders are not indexable", () => {
  assert.equal(runWrapper(true).r.status, 1);
  assert.equal(indexable(root), false);
  assert.equal(indexable(proj), true);
});
