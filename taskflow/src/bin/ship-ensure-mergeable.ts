#!/usr/bin/env node
// ship-ensure-mergeable.mjs <platform> <branch> <base> <pr-id>: make the PR/MR mergeable before the Ship phase enters
// the ci-monitor loop, so CI actually starts. Reads the platform merge-state; a branch BEHIND its base is
// updated/rebased through the platform's own API; merge CONFLICTS are auto-resolved locally with `git merge -X ours`
// (the PR/head branch wins every conflicting hunk) and pushed without force. Any conflict shape `-X ours` cannot
// cleanly resolve (add/add, rename/modify, modify/delete, binary), and any API/CLI/push failure, exits 1 (blocked).
//
// It never force-pushes (neither force nor force-with-lease), never merges the PR/MR itself, never enables
// auto-merge, and never retargets or touches the base. All git commands run in the caller's cwd (the worktree with
// the work branch checked out).
//
// Args: platform (github | gitlab), branch (work / PR source branch), base (base branch, never modified),
// pr-id (GitHub PR number / GitLab MR iid).
// stdout (success): one line `mergeState=<clean|rebased|resolved|unknown>`; all four mean: proceed into the
// ci-monitor loop. stderr (failure): a human-readable reason.
// Exit codes: 0 success, 1 remediation failed (shipper reports "blocked"), 64 usage error.
// Env overrides (mainly for tests): SHIP_MERGE_POLL_INTERVAL seconds between polls (default 5, fractions allowed),
// SHIP_MERGE_POLL_RETRIES poll attempts (default 3). Ported 1:1 from the bash script of taskflow 2.2.0,
// including jq's `//` semantics: unparsable JSON yields empty fields.
import { spawnSync } from "node:child_process";

/** A terminal merge-state classification of one poll attempt. */
type MergeClass = "clean" | "behind" | "conflict";

/** The command-line arguments after the script path. */
const ARGV = process.argv.slice(2);

/** Platform, work branch, base branch and PR/MR id (empty when missing). */
const [PLATFORM = "", BRANCH = "", BASE = "", PR_ID = ""] = ARGV;

/** Poll attempts as written in the environment (the exhaustion message prints it verbatim). */
const RETRIES_TEXT = process.env.SHIP_MERGE_POLL_RETRIES || "3";

/** Poll attempts; a non-number means no attempt, as bash arithmetic on a word evaluates to 0. */
const RETRIES = Number(RETRIES_TEXT);

/** Seconds between polls. */
const SLEEP_SECONDS = Number(process.env.SHIP_MERGE_POLL_INTERVAL || "5");

/** Marks a field jq could not read (unparsable or non-object input): jq printed nothing, so the value is empty. */
const UNREADABLE = Symbol("unreadable");

// shortcut: process.exit after a pipe write is safe on Linux (pipe writes are synchronous there); on macOS a slow reader could lose the line
/**
 * Writes `ship-ensure-mergeable: <msg>` to stderr and exits 1.
 *
 * @param msg - The failure reason.
 * @returns Never.
 */
function fail(msg: string): never {
  process.stderr.write(`ship-ensure-mergeable: ${msg}\n`);
  process.exit(1);
}

/** Sleeps SLEEP_SECONDS synchronously; zero, negative or non-numeric values do not sleep. */
function sleep(): void {
  if (Number.isFinite(SLEEP_SECONDS) && SLEEP_SECONDS > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, SLEEP_SECONDS * 1000);
}

/**
 * Runs a command without a shell in the caller's cwd; stderr is discarded.
 *
 * @param cmd - Program, looked up on PATH.
 * @param args - Arguments.
 * @param capture - Capture stdout (otherwise it is discarded).
 * @returns `ok` when the program ran and exited 0 (a spawn error counts as failure, like bash's 127), and the captured
 * stdout with trailing newlines removed, as `$(...)` does.
 */
function run(cmd: string, args: string[], capture = false): { ok: boolean; out: string } {
  const r = spawnSync(cmd, args, { stdio: ["inherit", capture ? "pipe" : "ignore", "ignore"], encoding: "utf8" });
  const out = capture && typeof r.stdout === "string" ? r.stdout.replace(/\n+$/, "") : "";
  return { ok: r.error === undefined && r.status === 0, out };
}

/**
 * Parses CLI output as JSON.
 *
 * @param out - The captured stdout.
 * @returns The parsed value, or UNREADABLE when it does not parse.
 */
function parse(out: string): unknown {
  try {
    return JSON.parse(out) as unknown;
  } catch {
    return UNREADABLE;
  }
}

/**
 * Reads `.<key>` the way jq does.
 *
 * @param doc - A value returned by {@link parse}.
 * @param key - Field name.
 * @returns The field value; `null` on a `null` document; UNREADABLE when jq would fail (unparsable, array or scalar).
 */
function get(doc: unknown, key: string): unknown {
  if (doc === null) return null;
  if (doc === UNREADABLE || typeof doc !== "object" || Array.isArray(doc)) return UNREADABLE;
  return (doc as Record<string, unknown>)[key];
}

/**
 * Mirrors `jq -r '<value> // "<d>"'`.
 *
 * @param v - A value returned by {@link get}.
 * @param d - The alternative for `null`, a missing field or `false`.
 * @returns The raw string as jq would print it; empty when jq would fail.
 */
function jqAlt(v: unknown, d: string): string {
  if (v === UNREADABLE) return "";
  if (v === null || v === undefined || v === false) return d;
  return typeof v === "string" ? v : JSON.stringify(v);
}

/**
 * Calls an attempt up to RETRIES times until it reports a terminal outcome. Sleeps between attempts; with `presleep`
 * it sleeps before every attempt instead, the first included (the caller just triggered an async action).
 *
 * @param attempt - Returns true on a terminal outcome, false to try again; it may call {@link fail}.
 * @param presleep - Sleep before each attempt.
 * @returns False when every attempt was used up.
 */
function retryPoll(attempt: () => boolean, presleep = false): boolean {
  for (let i = 1; i <= RETRIES; i++) {
    if (presleep) sleep();
    if (attempt()) return true;
    if (!presleep && i < RETRIES) sleep();
  }
  return false;
}

/**
 * One GitHub merge-state read.
 *
 * @returns The classification, or null to poll again (read error, empty output, UNKNOWN state).
 */
function classifyGithubAttempt(): MergeClass | null {
  const r = run("gh", ["pr", "view", PR_ID, "--json", "mergeable,mergeStateStatus"], true);
  if (!r.ok || r.out === "") return null;
  const doc = parse(r.out);
  const mss = jqAlt(get(doc, "mergeStateStatus"), "UNKNOWN");
  const mergeable = jqAlt(get(doc, "mergeable"), "UNKNOWN");
  if (mss === "DIRTY" || mergeable === "CONFLICTING") return "conflict";
  if (mss === "BEHIND") return "behind";
  if (mss === "UNKNOWN" || mergeable === "UNKNOWN") return null;
  return "clean";
}

/**
 * One GitLab merge-state read.
 *
 * @returns The classification, or null to poll again (read error, empty output, unchecked/checking state).
 */
function classifyGitlabAttempt(): MergeClass | null {
  const r = run("glab", ["api", `projects/:id/merge_requests/${PR_ID}`], true);
  if (!r.ok || r.out === "") return null;
  const doc = parse(r.out);
  const dms = jqAlt(get(doc, "detailed_merge_status"), "");
  const ms = jqAlt(get(doc, "merge_status"), "");
  if (dms === "conflict" || (dms === "" && ms === "cannot_be_merged")) return "conflict";
  if (dms === "need_rebase") return "behind";
  if (dms === "unchecked" || dms === "checking" || (dms === "" && ms === "unchecked")) return null;
  return "clean";
}

/**
 * Polls the platform's merge state.
 *
 * @returns The classification, or `unknown` when every attempt was indeterminate.
 */
function classify(): MergeClass | "unknown" {
  const attempt = PLATFORM === "github" ? classifyGithubAttempt : classifyGitlabAttempt;
  const found: { value?: MergeClass } = {};
  const done = retryPoll(() => {
    const c = attempt();
    if (c !== null) found.value = c;
    return c !== null;
  });
  return done && found.value !== undefined ? found.value : "unknown";
}

/**
 * One poll of a running GitLab rebase.
 *
 * @returns True when the rebase finished; false to poll again. Fails on a reported `merge_error`.
 */
function gitlabRebaseAttempt(): boolean {
  const r = run("glab", ["api", `projects/:id/merge_requests/${PR_ID}`], true);
  if (!r.ok) return false;
  const doc = parse(r.out);
  const merr = jqAlt(get(doc, "merge_error"), "null");
  if (merr !== "" && merr !== "null") fail(`GitLab rebase reported merge_error: ${merr}`);
  return jqAlt(get(doc, "rebase_in_progress"), "false") === "false";
}

/** Updates a branch that is behind its base through the platform API (never a force push). */
function remediateBehind(): void {
  if (PLATFORM === "github") {
    if (!run("gh", ["pr", "update-branch", PR_ID]).ok) fail(`gh pr update-branch ${PR_ID} failed`);
    return;
  }
  if (!run("glab", ["api", "-X", "PUT", `projects/:id/merge_requests/${PR_ID}/rebase`]).ok) fail(`glab rebase API failed for MR ${PR_ID}`);
  if (!retryPoll(gitlabRebaseAttempt, true)) fail(`GitLab rebase still in progress for MR ${PR_ID} after ${RETRIES_TEXT} poll attempts`);
}

/** Resolves conflicts locally with `git merge -X ours`, pushes without force and re-checks the merge state. */
function remediateConflict(): void {
  if (!run("git", ["fetch", "origin", BASE]).ok) fail(`git fetch origin ${BASE} failed`);
  if (!run("git", ["merge", "--no-edit", "-X", "ours", `origin/${BASE}`]).ok) {
    if (run("git", ["ls-files", "--unmerged"], true).out !== "") {
      run("git", ["merge", "--abort"]);
      fail("merge -X ours left unmerged paths (add/add, rename/modify, modify/delete, or binary conflict); aborted without force-picking a side");
    }
    run("git", ["merge", "--abort"]);
    fail(`git merge -X ours origin/${BASE} failed`);
  }
  if (!run("git", ["push", "origin", BRANCH]).ok) fail(`git push origin ${BRANCH} rejected (remote moved); not force-pushing`);
  if (classify() === "conflict") fail("merge-state still conflicting after -X ours resolution and push");
}

/**
 * Classifies, remediates and names the outcome.
 *
 * @returns The mergeState value to print.
 */
function main(): "clean" | "unknown" | "rebased" | "resolved" {
  const cls = classify();
  if (cls === "behind") {
    remediateBehind();
    if (classify() === "conflict") {
      remediateConflict();
      return "resolved";
    }
    return "rebased";
  }
  if (cls === "conflict") {
    remediateConflict();
    return "resolved";
  }
  return cls;
}

if (ARGV.length !== 4 || !PLATFORM || !BRANCH || !BASE || !PR_ID) {
  process.stderr.write("usage: ship-ensure-mergeable.mjs <github|gitlab> <branch> <base> <pr-id>\n");
  process.exit(64);
}
if (PLATFORM !== "github" && PLATFORM !== "gitlab") {
  process.stderr.write(`unknown platform: ${PLATFORM} (expected github or gitlab)\n`);
  process.exit(64);
}
process.stdout.write(`mergeState=${main()}\n`);
