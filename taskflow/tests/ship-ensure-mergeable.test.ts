// Process tests of the built plugin/bin/ship-ensure-mergeable.mjs: exit codes and the single `mergeState=` line.
// gh/glab are bash stubs (canned JSON, call log in $TMPDIR); real git on a bare origin for the conflict paths. Ported
// from the merge-script block of the old bats suite; the script runs with an env of PATH (symlinked tools plus the
// stubs), HOME, TMPDIR and the two poll overrides only.
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";

/** The plugin package directory (`taskflow/`). */
const PKG = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** The built script under test. */
const SCRIPT = join(PKG, "plugin", "bin", "ship-ensure-mergeable.mjs");

/** The script's source (scanned for forbidden git options). */
const SOURCE = join(PKG, "src", "bin", "ship-ensure-mergeable.ts");

/** Tools symlinked onto the isolated PATH (the stubs and git need them; jq and sleep are no longer used). */
const TOOLS = ["bash", "env", "grep", "sed", "git", "cat", "rm", "mkdir", "printf", "head", "cut", "tr"];

/** Throwaway directories, removed after each test. */
const made: string[] = [];

afterEach(() => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A per-test sandbox: `tmp` is also the script's TMPDIR, `bin` its whole PATH. */
type Sandbox = { tmp: string; bin: string; home: string };

/**
 * Finds a program on the test runner's PATH.
 *
 * @param tool - Program name.
 * @returns Its path, or undefined.
 */
function which(tool: string): string | undefined {
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    const p = join(dir, tool);
    if (dir && existsSync(p)) return p;
  }
  return undefined;
}

/**
 * Creates a sandbox with the tool symlinks.
 *
 * @returns The sandbox paths.
 */
function sandbox(): Sandbox {
  const tmp = mkdtempSync(join(tmpdir(), "tf-merge-"));
  made.push(tmp);
  const bin = join(tmp, "bin");
  const home = join(tmp, "home");
  mkdirSync(bin);
  mkdirSync(home);
  for (const t of TOOLS) {
    const src = which(t);
    if (src) symlinkSync(src, join(bin, t));
  }
  return { tmp, bin, home };
}

/**
 * Drops an executable bash stub onto the sandbox PATH.
 *
 * @param sb - The sandbox.
 * @param name - Command name.
 * @param body - Bash script body.
 */
function stub(sb: Sandbox, name: string, body: string): void {
  const f = join(sb.bin, name);
  writeFileSync(f, `#!/usr/bin/env bash\n${body}\n`);
  chmodSync(f, 0o755);
}

/**
 * Runs the built script with the isolated environment.
 *
 * @param sb - The sandbox.
 * @param args - Script arguments.
 * @param cwd - Working directory (the git checkout for the conflict paths).
 * @returns Exit status and output.
 */
function runMergeable(sb: Sandbox, args: string[], cwd = sb.tmp): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd,
    encoding: "utf8",
    env: { PATH: sb.bin, HOME: sb.home, TMPDIR: sb.tmp, SHIP_MERGE_POLL_INTERVAL: "0", SHIP_MERGE_POLL_RETRIES: "2" },
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

/**
 * Runs git for a fixture with the sandbox HOME and without inherited GIT_* variables.
 *
 * @param cwd - Working directory.
 * @param home - HOME for git's global config.
 * @param args - git arguments.
 * @returns git's stdout.
 */
function git(cwd: string, home: string, ...args: string[]): string {
  const env: Record<string, string> = { HOME: home, GIT_CONFIG_NOSYSTEM: "1" };
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith("GIT_") && k !== "HOME" && v !== undefined) env[k] = v;
  return execFileSync("git", args, { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
}

/**
 * Builds a bare origin and a clone on `feature`, with `main` advanced past it.
 *
 * @param sb - The sandbox.
 * @param kind - `conflict`: a conflicting hunk `-X ours` resolves; `modifydelete`: main deletes f.txt that feature edits (leaves an unmerged path).
 * @returns The clone's path.
 */
function gitFixture(sb: Sandbox, kind: "conflict" | "modifydelete"): string {
  const origin = join(sb.tmp, "origin.git");
  const work = join(sb.tmp, "work");
  git(sb.tmp, sb.home, "init", "-q", "--bare", origin);
  git(sb.tmp, sb.home, "clone", "-q", origin, work);
  const g = (...args: string[]): string => git(work, sb.home, ...args);
  g("config", "user.email", "t@t");
  g("config", "user.name", "t");
  writeFileSync(join(work, "f.txt"), "base\n");
  g("add", "f.txt");
  g("commit", "-qm", "init");
  g("branch", "-M", "main");
  g("push", "-q", "origin", "main");
  g("checkout", "-q", "-b", "feature");
  writeFileSync(join(work, "f.txt"), "feature-change\n");
  g("commit", "-qam", "feature");
  g("push", "-q", "origin", "feature");
  g("checkout", "-q", "main");
  if (kind === "modifydelete") {
    g("rm", "-q", "f.txt");
    g("commit", "-qm", "base deletes f");
  } else {
    writeFileSync(join(work, "f.txt"), "base-change\n");
    g("commit", "-qam", "base advances");
  }
  g("push", "-q", "origin", "main");
  g("checkout", "-q", "feature");
  return work;
}

/** Stub prologue: counts calls in $TMPDIR/<name>-n and exposes the count as $n. */
const counter = (name: string): string => `n_file="$TMPDIR/${name}-n"; n=$(cat "$n_file" 2>/dev/null || echo 0); n=$((n+1)); echo "$n" > "$n_file"`;

describe("ship-ensure-mergeable.mjs", () => {
  test("rejects a wrong argument count with exit 64", () => {
    const sb = sandbox();
    const r = runMergeable(sb, ["github", "feature", "main"]);
    expect(r.status).toBe(64);
    expect(r.stderr).toContain("usage: ship-ensure-mergeable.mjs <github|gitlab> <branch> <base> <pr-id>");
  });

  test("clean GitHub state → mergeState=clean, no mutation", () => {
    const sb = sandbox();
    stub(
      sb,
      "gh",
      String.raw`echo "ARGS: $*" >> "$TMPDIR/gh-calls"
if [ "$1" = "pr" ] && [ "$2" = "view" ]; then
  echo "{\"mergeable\":\"MERGEABLE\",\"mergeStateStatus\":\"CLEAN\"}"; exit 0
fi
exit 0`,
    );
    const r = runMergeable(sb, ["github", "feature", "main", "42"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("mergeState=clean\n");
    expect(readFileSync(join(sb.tmp, "gh-calls"), "utf8")).not.toContain("update-branch");
  });

  test("BEHIND GitHub → gh pr update-branch → mergeState=rebased", () => {
    const sb = sandbox();
    stub(
      sb,
      "gh",
      counter("gh") + "\n" + String.raw`echo "ARGS: $*" >> "$TMPDIR/gh-calls"
if [ "$1" = "pr" ] && [ "$2" = "view" ]; then
  if [ "$n" -le 1 ]; then echo "{\"mergeable\":\"UNKNOWN\",\"mergeStateStatus\":\"BEHIND\"}";
  else echo "{\"mergeable\":\"MERGEABLE\",\"mergeStateStatus\":\"CLEAN\"}"; fi
  exit 0
fi
if [ "$1" = "pr" ] && [ "$2" = "update-branch" ]; then exit 0; fi
exit 0`,
    );
    const r = runMergeable(sb, ["github", "feature", "main", "42"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("mergeState=rebased\n");
    expect(readFileSync(join(sb.tmp, "gh-calls"), "utf8")).toContain("pr update-branch 42");
  });

  test("need_rebase GitLab → rebase API → mergeState=rebased", () => {
    const sb = sandbox();
    stub(
      sb,
      "glab",
      counter("glab") + "\n" + String.raw`echo "ARGS: $*" >> "$TMPDIR/glab-calls"
if [ "$1" = "api" ] && [ "$2" = "-X" ] && [ "$3" = "PUT" ]; then exit 0; fi
if [ "$n" -le 1 ]; then echo "{\"detailed_merge_status\":\"need_rebase\",\"merge_status\":\"cannot_be_merged\",\"rebase_in_progress\":false,\"merge_error\":null}";
else echo "{\"detailed_merge_status\":\"mergeable\",\"merge_status\":\"can_be_merged\",\"rebase_in_progress\":false,\"merge_error\":null}"; fi
exit 0`,
    );
    const r = runMergeable(sb, ["gitlab", "feature", "main", "7"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("mergeState=rebased\n");
    expect(readFileSync(join(sb.tmp, "glab-calls"), "utf8")).toContain("merge_requests/7/rebase");
  });

  test("-X ours-resolvable conflict → merge + non-force push → mergeState=resolved", () => {
    const sb = sandbox();
    const work = gitFixture(sb, "conflict");
    stub(
      sb,
      "gh",
      counter("gh") + "\n" + String.raw`if [ "$1" = "pr" ] && [ "$2" = "view" ]; then
  if [ "$n" -le 1 ]; then echo "{\"mergeable\":\"CONFLICTING\",\"mergeStateStatus\":\"DIRTY\"}";
  else echo "{\"mergeable\":\"MERGEABLE\",\"mergeStateStatus\":\"CLEAN\"}"; fi
  exit 0
fi
exit 0`,
    );
    const r = runMergeable(sb, ["github", "feature", "main", "42"], work);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("mergeState=resolved\n");
    // -X ours kept the feature side of the conflicting hunk
    expect(readFileSync(join(work, "f.txt"), "utf8")).toContain("feature-change");
  });

  test("conflict NOT -X ours-resolvable → abort, no push, exit 1", () => {
    const sb = sandbox();
    const work = gitFixture(sb, "modifydelete");
    const originBefore = git(work, sb.home, "rev-parse", "origin/feature");
    stub(
      sb,
      "gh",
      String.raw`if [ "$1" = "pr" ] && [ "$2" = "view" ]; then
  echo "{\"mergeable\":\"CONFLICTING\",\"mergeStateStatus\":\"DIRTY\"}"; exit 0
fi
exit 0`,
    );
    const r = runMergeable(sb, ["github", "feature", "main", "42"], work);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("ship-ensure-mergeable: merge -X ours left unmerged paths");
    // merge was aborted → no unmerged paths remain
    expect(git(work, sb.home, "ls-files", "--unmerged")).toBe("");
    // origin/feature was NOT pushed to (remote unchanged)
    expect(git(work, sb.home, "rev-parse", "origin/feature")).toBe(originBefore);
  });

  test("remediation error (update-branch fails) → exit 1", () => {
    const sb = sandbox();
    stub(
      sb,
      "gh",
      String.raw`if [ "$1" = "pr" ] && [ "$2" = "view" ]; then
  echo "{\"mergeable\":\"UNKNOWN\",\"mergeStateStatus\":\"BEHIND\"}"; exit 0
fi
if [ "$1" = "pr" ] && [ "$2" = "update-branch" ]; then echo "boom" >&2; exit 1; fi
exit 0`,
    );
    const r = runMergeable(sb, ["github", "feature", "main", "42"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("ship-ensure-mergeable: gh pr update-branch 42 failed");
  });

  test("transient read error → mergeState=unknown, exit 0", () => {
    const sb = sandbox();
    stub(sb, "gh", `echo "api down" >&2; exit 1`);
    const r = runMergeable(sb, ["github", "feature", "main", "42"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("mergeState=unknown\n");
  });

  // Bug-compatible with the bash original: jq printed nothing for unparsable input, so every field is empty → clean.
  test("unparsable JSON from gh pr view → mergeState=clean", () => {
    const sb = sandbox();
    stub(sb, "gh", `echo "not json"; exit 0`);
    const r = runMergeable(sb, ["github", "feature", "main", "42"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("mergeState=clean\n");
  });

  test("GitLab rebase reporting merge_error → exit 1 with the message", () => {
    const sb = sandbox();
    stub(
      sb,
      "glab",
      counter("glab") + "\n" + String.raw`if [ "$1" = "api" ] && [ "$2" = "-X" ] && [ "$3" = "PUT" ]; then exit 0; fi
if [ "$n" -le 1 ]; then echo "{\"detailed_merge_status\":\"need_rebase\",\"merge_status\":\"cannot_be_merged\",\"rebase_in_progress\":false,\"merge_error\":null}";
else echo "{\"detailed_merge_status\":\"need_rebase\",\"rebase_in_progress\":false,\"merge_error\":\"conflict in f.txt\"}"; fi
exit 0`,
    );
    const r = runMergeable(sb, ["gitlab", "feature", "main", "7"]);
    expect(r.status).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("ship-ensure-mergeable: GitLab rebase reported merge_error: conflict in f.txt");
  });

  test("never issues a force push or a checkout --ours/--theirs force-pick", () => {
    expect(readFileSync(SOURCE, "utf8")).not.toMatch(/--force|--force-with-lease|checkout\s+--ours|checkout\s+--theirs/);
  });
});
