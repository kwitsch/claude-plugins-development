// Dev-only (never shipped): runs `claude plugin test` on a temporary copy of the built plugin.
// `claude plugin test` does not follow symlinks, so the tests in claude-tests/ are copied next to the plugin files.
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const tmp = mkdtempSync(join(tmpdir(), "gh-plugin-test-"));
try {
  cpSync(join(root, "plugin"), tmp, { recursive: true });
  mkdirSync(join(tmp, "test"));
  cpSync(join(root, "claude-tests"), join(tmp, "test"), { recursive: true });
  const r = spawnSync("claude", ["plugin", "test", tmp], { stdio: ["ignore", "inherit", "inherit"] });
  process.exitCode = r.status ?? 1;
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
