#!/usr/bin/env node
// refresh.ts — deterministic plumbing for the update-cc-references skill. Run directly by Node 24 (erasable syntax only).
// Subcommands:
//   plan [<target>] [<scratch>]   resolve target files from sources.json, curl every mapped doc
//                                 (<url>.md, HTML check, one altUrls retry), write plan.json + workflow.js
//   gate <scratch> <name>         revert unsourced-version hunks, label line-changing hunks for the validator
//   finish <scratch> <name> [--keep h1,h2]  authoritative, fail-closed: revert every line-changing hunk not
//                                 kept, then stamp the verified date or restore the file from HEAD
//   release <scratch>             guarded patch bump of cc-knowledge/package.json, then `pnpm --filter cc-knowledge build`
// Writes: <scratch>/{plan.json,workflow.js,docs/,diffs/}, the target reference files and
// cc-knowledge/package.json (plus the plugin.json the build regenerates).
// Fail-closed: an unverified line change never survives finish.
// stdout carries exactly one JSON object; diagnostics go to stderr.
// Exit codes: 0 ok, 1 usage/invalid input, 2 fetch failure, 3 git failure.

import { spawnSync } from "node:child_process";
import type { SpawnSyncOptions } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The refresh targets (`all` is every other one). */
const TARGETS = ["skills", "agents", "hooks", "commands", "mcp", "plugins", "memory", "settings", "all"];
/** The `verified YYYY-MM-DD` stamp in a reference file header. */
const DATE_RE = /(verified:?\s+)(\d{4}-\d{2}-\d{2})/i;
/** An x.y.z version token. */
const VERSION_RE = /\bv?\d+\.\d+\.\d+\b/g;
/** First line of an HTML page served instead of markdown. */
const HTML_RE = /^\s*<(!doctype|html)/i;
/** The manifest source of the plugin: the only place its version lives. */
const PACKAGE_JSON = "cc-knowledge/package.json";

/** `sources.json`. */
type Sources = {
  refsDir: string;
  targets: Record<string, string[]>;
  files: Record<string, { docs: string[]; note?: string }>;
  altUrls: Record<string, string>;
};
/** One target of `plan.json`. */
type Target = { name: string; file: string; docs: { url: string; path: string }[]; note?: string };
/** `plan.json`. */
type Plan = { date: string; scratch: string; repoRoot: string; script: string; targets: Target[] };
/** One `git diff -U0` hunk. */
type Hunk = { head: string; body: string[]; removed: string[]; added: string[]; versions?: string[]; id?: string };

let SOURCES: Sources;

/** A failure that ends the run with an exit code and a JSON payload. */
class Exit extends Error {
  code: number;
  payload: Record<string, unknown>;
  constructor(code: number, payload: Record<string, unknown>) {
    super(String(payload.error));
    this.code = code;
    this.payload = payload;
  }
}

/** Ends the run with an error payload. */
function fail(code: number, error: string, extra: Record<string, unknown> = {}): never {
  throw new Exit(code, { ok: false, error, ...extra });
}

/** Runs a program and collects its output; a failure to start reads as exit 1. */
function run(cmd: string, args: string[], opts: SpawnSyncOptions = {}): { status: number; stdout: string; stderr: string } {
  const r = spawnSync(cmd, args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024, ...opts });
  return { status: typeof r.status === "number" ? r.status : 1, stdout: String(r.stdout || ""), stderr: String(r.stderr || "") };
}

/** Runs git and returns stdout; a failure exits 3. */
function git(args: string[], cwd: string): string {
  const r = run("git", args, { cwd });
  if (r.status !== 0) {
    process.stderr.write(r.stderr);
    fail(3, `git ${args[0]} failed (exit ${r.status})`);
  }
  return r.stdout;
}

/** The top level of the repository the cwd is in. */
function repoRoot(): string {
  const r = run("git", ["rev-parse", "--show-toplevel"]);
  if (r.status !== 0) fail(1, "not inside a git repository");
  return r.stdout.trim();
}

/** Today as YYYY-MM-DD (UTC). */
function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Where a fetched doc is kept in the scratch directory. */
function docPath(scratch: string, url: string): string {
  const u = new URL(url);
  return join(scratch, "docs", `${u.host}${u.pathname.replace(/\//g, "_")}.md`);
}

/** true = clean markdown landed at `out`; false = curl failure, empty file or HTML fallback page. */
function fetchDoc(url: string, out: string): boolean {
  const r = run("curl", ["-sSL", "--fail", "--connect-timeout", "10", "--max-time", "60", "-o", out, `${url}.md`]);
  if (r.status !== 0) {
    process.stderr.write(`curl ${url}.md failed (exit ${r.status}) ${r.stderr}\n`);
    return false;
  }
  const text = readFileSync(out, "utf8");
  if (text.length === 0) return false;
  if (HTML_RE.test(text.split("\n", 1)[0] ?? "")) {
    process.stderr.write(`curl ${url}.md returned HTML, not markdown\n`);
    return false;
  }
  return true;
}

/** The target name of a reference file: its basename without `.reference.md`. */
const nameOf = (file: string): string => file.replace(/\.reference\.md$/, "");

/** `plan`: fetch the docs and write plan.json and workflow.js. */
function cmdPlan(args: string[]): Record<string, unknown> {
  const target = args[0] || "all";
  if (!TARGETS.includes(target)) fail(1, `unknown target: ${target} (expected one of ${TARGETS.join(" ")})`);
  const root = repoRoot();
  let scratch: string;
  if (args[1]) scratch = resolve(args[1]);
  else if (process.env.CLAUDE_JOB_DIR) scratch = join(process.env.CLAUDE_JOB_DIR, "tmp", "docs");
  else scratch = mkdtempSync(join(tmpdir(), "update-cc-references-"));
  mkdirSync(join(scratch, "docs"), { recursive: true });
  // A reused scratch dir must not leak gate/finish snapshots from an earlier run.
  rmSync(join(scratch, "diffs"), { recursive: true, force: true });
  mkdirSync(join(scratch, "diffs"), { recursive: true });

  const files = [...new Set(target === "all" ? Object.values(SOURCES.targets).flat() : SOURCES.targets[target])];
  for (const f of files) if (!SOURCES.files[f]) fail(1, `sources.json has no files entry for ${f}`);
  const urls = [...new Set(files.flatMap((f) => SOURCES.files[f].docs))];
  const failed: string[] = [];
  for (const url of urls) {
    const out = docPath(scratch, url);
    if (fetchDoc(url, out)) continue;
    const alt = SOURCES.altUrls[url];
    if (alt && fetchDoc(alt, out)) continue;
    failed.push(url);
  }
  if (failed.length) fail(2, "doc fetch failed", { failed });

  const plan: Plan = {
    date: today(),
    scratch,
    repoRoot: root,
    script: fileURLToPath(import.meta.url),
    targets: files.map((f) => ({
      name: nameOf(f),
      file: join(root, SOURCES.refsDir, f),
      docs: SOURCES.files[f].docs.map((url) => ({ url, path: docPath(scratch, url) })),
      note: SOURCES.files[f].note,
    })),
  };
  writeFileSync(join(scratch, "plan.json"), JSON.stringify(plan, null, 2) + "\n");
  const template = readFileSync(new URL("./workflow.template.js", import.meta.url), "utf8");
  const workflowScript = join(scratch, "workflow.js");
  writeFileSync(workflowScript, template.replace("__PLAN__", () => JSON.stringify(plan)));
  return { ok: true, scratch, date: plan.date, targets: plan.targets.map((t) => t.name), workflowScript };
}

/** Reads plan.json of a scratch directory. */
function loadPlan(scratch: string | undefined): Plan {
  if (!scratch) fail(1, "missing <scratch> argument");
  const p = join(resolve(scratch), "plan.json");
  if (!existsSync(p)) fail(1, `missing ${p} (run plan first)`);
  return JSON.parse(readFileSync(p, "utf8")) as Plan;
}

/** The plan target with a name. */
function findTarget(plan: Plan, name: string | undefined): Target {
  const t = plan.targets.find((x) => x.name === name);
  if (!t) fail(1, `unknown name: ${name}`);
  return t;
}

/** sha256 of a file. */
function sha256(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

/** x.y.z tokens of the given lines, leading "v" stripped. */
function versions(lines: string[]): string[] {
  return lines.flatMap((l) => l.match(VERSION_RE) || []).map((v) => v.replace(/^v/, ""));
}

/** `git diff -U0 HEAD -- <file>` split into header lines and hunks. */
function diffFile(plan: Plan, t: Target): { header: string[]; hunks: Hunk[] } {
  const out = git(["diff", "--no-color", "--no-ext-diff", "--src-prefix=a/", "--dst-prefix=b/", "-U0", "HEAD", "--", t.file], plan.repoRoot);
  const lines = out.split("\n");
  if (lines.at(-1) === "") lines.pop();
  const header: string[] = [];
  const hunks: Hunk[] = [];
  for (const line of lines) {
    if (line.startsWith("@@")) hunks.push({ head: line, body: [], removed: [], added: [] });
    else if (hunks.length) hunks.at(-1)?.body.push(line);
    else header.push(line);
  }
  for (const h of hunks) {
    h.removed = h.body.filter((l) => l.startsWith("-")).map((l) => l.slice(1));
    h.added = h.body.filter((l) => l.startsWith("+")).map((l) => l.slice(1));
  }
  return { header, hunks };
}

/** Whether a hunk only changes the verified date. */
function isDateHunk(h: Hunk): boolean {
  const mask = (l: string): string => l.replace(DATE_RE, "$1<date>");
  return h.removed.length === 1 && h.added.length === 1 && DATE_RE.test(h.removed[0]) && mask(h.removed[0]) === mask(h.added[0]);
}

/** Boundary-anchored: "2.1.18" must not match inside "2.1.180" or "12.1.18". */
function hasVersion(text: string, v: string): boolean {
  return new RegExp(`(?<![\\d.])v?${v.replace(/\./g, "\\.")}(?![\\d]|\\.\\d)`).test(text);
}

/** Fetched docs are static after `plan`; read each target's docs once per process (diffs stay fresh). */
const docsCache = new Map<string, string>();
/** The fetched docs of a target as one text. */
function readDocs(t: Target): string {
  if (!docsCache.has(t.file)) {
    docsCache.set(t.file, t.docs.map((d) => (existsSync(d.path) ? readFileSync(d.path, "utf8") : "")).join("\n"));
  }
  return docsCache.get(t.file) as string;
}

/**
 * Date hunks dropped; unsourced = adds an x.y.z found neither in its own removed lines nor in the docs;
 * changing = other hunks removing >= 1 line (ids h1..hN in diff order); additive = the rest (count).
 */
function analyze(plan: Plan, t: Target): { header: string[]; unsourced: Hunk[]; changing: Hunk[]; additive: number } {
  const docsText = readDocs(t);
  const { header, hunks } = diffFile(plan, t);
  const unsourced: Hunk[] = [];
  const changing: Hunk[] = [];
  let additive = 0;
  for (const h of hunks) {
    if (isDateHunk(h)) continue;
    const carried = new Set(versions(h.removed));
    const bad = [...new Set(versions(h.added))].filter((v) => !carried.has(v) && !hasVersion(docsText, v));
    if (bad.length) unsourced.push({ ...h, versions: bad });
    else if (h.removed.length) changing.push({ ...h, id: `h${changing.length + 1}` });
    else additive++;
  }
  return { header, unsourced, changing, additive };
}

/** The first new-file line of a hunk. */
function newStart(h: Hunk): number {
  return Number(/\+(\d+)/.exec(h.head)?.[1] ?? 0);
}

/** Reverts hunks in the target file, all or nothing. */
function revertHunks(plan: Plan, t: Target, header: string[], hunks: Hunk[]): void {
  if (!hunks.length) return;
  const before = readFileSync(t.file);
  const patch = join(plan.scratch, "diffs", `${t.name}.revert.patch`);
  // One hunk per apply, bottom-up: -U0 hunks carry no context to re-anchor on, so reverting from the end
  // keeps every earlier hunk's line numbers valid. The snapshot keeps the whole revert all-or-nothing.
  const ordered = [...hunks].sort((a, b) => newStart(b) - newStart(a));
  for (const h of ordered) {
    writeFileSync(patch, [...header, h.head, ...h.body].join("\n") + "\n");
    const r = run("git", ["apply", "-R", "--unidiff-zero", patch], { cwd: plan.repoRoot });
    if (r.status !== 0) {
      writeFileSync(t.file, before);
      process.stderr.write(r.stderr);
      fail(3, `git apply -R failed for ${t.name}`, { name: t.name });
    }
  }
}

/** Stamps the date into the `verified` line of the file header; false when there is none. */
function stampDate(file: string, date: string): boolean {
  const lines = readFileSync(file, "utf8").split("\n");
  for (let i = 0; i < Math.min(15, lines.length); i++) {
    if (!DATE_RE.test(lines[i])) continue;
    const next = lines[i].replace(DATE_RE, `$1${date}`);
    if (next !== lines[i]) {
      lines[i] = next;
      writeFileSync(file, lines.join("\n"));
    }
    return true;
  }
  return false;
}

/** The auto-revert report of unsourced hunks. */
const autoReport = (hunks: Hunk[]): { versions?: string[]; header: string }[] => hunks.map((h) => ({ versions: h.versions, header: h.head }));

/** `gate`: revert unsourced hunks and label the line-changing ones. */
function cmdGate(args: string[]): Record<string, unknown> {
  const plan = loadPlan(args[0]);
  const t = findTarget(plan, args[1]);
  let a = analyze(plan, t);
  const autoReverted = autoReport(a.unsourced);
  if (a.unsourced.length) {
    revertHunks(plan, t, a.header, a.unsourced);
    a = analyze(plan, t);
  }
  let diffPath: string | null = null;
  if (a.changing.length) {
    diffPath = join(plan.scratch, "diffs", `${t.name}.diff`);
    writeFileSync(diffPath, [...a.header, ...a.changing.flatMap((h) => [`${h.head} ${h.id}`, ...h.body])].join("\n") + "\n");
  }
  const state = { sha256: sha256(t.file), ids: a.changing.map((h) => h.id) };
  writeFileSync(join(plan.scratch, "diffs", `${t.name}.state.json`), JSON.stringify(state) + "\n");
  return { name: t.name, additive: a.additive, changing: state.ids, diffPath, autoReverted };
}

/** `finish`: keep the confirmed hunks, revert the rest, stamp the date or restore the file. */
function cmdFinish(args: string[]): Record<string, unknown> {
  const plan = loadPlan(args[0]);
  const t = findTarget(plan, args[1]);
  const k = args.indexOf("--keep");
  const requested = k >= 0 && args[k + 1] ? args[k + 1].split(",").map((s) => s.trim()).filter((s) => /^h\d+$/.test(s)) : [];
  const statePath = join(plan.scratch, "diffs", `${t.name}.state.json`);
  // Idempotent: a repeat run on the file finish itself left behind returns the recorded result
  // instead of treating its own output as a stale edit and reverting the kept hunks.
  const donePath = join(plan.scratch, "diffs", `${t.name}.finished.json`);
  if (existsSync(donePath)) {
    const done = JSON.parse(readFileSync(donePath, "utf8")) as { sha256: string; result: Record<string, unknown> };
    if (done.sha256 === sha256(t.file)) return done.result;
  }
  const state = existsSync(statePath) ? (JSON.parse(readFileSync(statePath, "utf8")) as { sha256: string; ids: string[] }) : null;
  // Fail-closed: without a matching gate snapshot no line change can be kept.
  const stale = !state || state.sha256 !== sha256(t.file);
  const keep = new Set(stale ? [] : requested.filter((id) => state.ids.includes(id)));
  const a = analyze(plan, t);
  const drop = a.changing.filter((h) => !keep.has(h.id as string));
  revertHunks(plan, t, a.header, [...a.unsourced, ...drop]);
  const rest = diffFile(plan, t).hunks.filter((h) => !isDateHunk(h));
  let status: string;
  let stamped: boolean | null = null;
  if (!rest.length) {
    git(["checkout", "HEAD", "--", t.file], plan.repoRoot);
    status = "unchanged";
  } else {
    stamped = stampDate(t.file, plan.date);
    status = "updated";
  }
  const result = {
    name: t.name,
    status,
    kept: a.changing.filter((h) => keep.has(h.id as string)).map((h) => h.id),
    reverted: drop.map((h) => h.id),
    autoReverted: autoReport(a.unsourced),
    stale,
    stamped,
  };
  writeFileSync(donePath, JSON.stringify({ sha256: sha256(t.file), result }) + "\n");
  return result;
}

/** `release`: patch-bump cc-knowledge/package.json once per unreleased branch and rebuild the plugin. */
function cmdRelease(args: string[]): Record<string, unknown> {
  const plan = loadPlan(args[0]);
  const root = plan.repoRoot;
  const porcelain = git(["status", "--porcelain", "--", ...plan.targets.map((t) => t.file)], root);
  const files = porcelain.split("\n").filter(Boolean).map((l) => l.slice(3));
  if (!files.length) return { changed: false };

  const pkgPath = join(root, PACKAGE_JSON);
  const raw = readFileSync(pkgPath, "utf8");
  const obj = JSON.parse(raw) as { version?: unknown };
  const current = obj.version;
  if (typeof current !== "string" || !/^\d+\.\d+\.\d+$/.test(current)) fail(1, `malformed version in ${PACKAGE_JSON}: ${String(current)}`);
  const shown = run("git", ["show", `origin/main:${PACKAGE_JSON}`], { cwd: root });
  let base: unknown = null;
  if (shown.status === 0) {
    try {
      base = (JSON.parse(shown.stdout) as { version?: unknown }).version ?? null;
    } catch {
      base = null;
    }
  }
  if (base === null) fail(3, `cannot read ${PACKAGE_JSON} from origin/main (fetch it first)`);
  if (typeof base !== "string" || !/^\d+\.\d+\.\d+$/.test(base)) fail(1, `malformed version in origin/main ${PACKAGE_JSON}: ${String(base)}`);
  // Bump once per unreleased branch: a version already ahead of origin/main stays; one equal to or
  // behind it (origin/main moved on) becomes origin/main's patch + 1.
  const triple = (v: string): number[] => v.split(".").map(Number);
  const baseTriple = triple(base);
  const ahead = triple(current).reduce((r, n, i) => r || Math.sign(n - baseTriple[i]), 0) > 0;
  const bumped = !ahead;
  if (bumped) {
    const [a, b, c] = baseTriple;
    obj.version = `${a}.${b}.${c + 1}`;
  }
  const next = JSON.stringify(obj, null, 2) + "\n";
  if (next !== raw) writeFileSync(pkgPath, next);
  // plugin.json is generated from package.json: never edit it by hand
  const build = run("pnpm", ["--filter", "cc-knowledge", "build"], { cwd: root });
  if (build.status !== 0) {
    process.stderr.write(build.stdout + build.stderr);
    fail(1, "pnpm --filter cc-knowledge build failed");
  }
  return { changed: true, files, previousVersion: current, version: obj.version, bumped, date: plan.date, built: true };
}

/** The subcommands. */
const COMMANDS: Record<string, (args: string[]) => Record<string, unknown>> = { plan: cmdPlan, gate: cmdGate, finish: cmdFinish, release: cmdRelease };

/** Dispatches the subcommand. */
function main(): Record<string, unknown> {
  SOURCES = JSON.parse(readFileSync(new URL("./sources.json", import.meta.url), "utf8")) as Sources;
  const [cmd, ...args] = process.argv.slice(2);
  const fn = cmd !== undefined && Object.hasOwn(COMMANDS, cmd) ? COMMANDS[cmd] : null;
  if (!fn) return fail(1, `usage: node refresh.ts <${Object.keys(COMMANDS).join("|")}> ...`);
  return fn(args);
}

try {
  process.stdout.write(JSON.stringify(main()) + "\n");
} catch (e) {
  if (e instanceof Exit) {
    process.stdout.write(JSON.stringify(e.payload) + "\n");
    process.exitCode = e.code;
  } else {
    const err = e as Error | undefined;
    process.stderr.write(`${err?.stack ?? String(e)}\n`);
    process.stdout.write(JSON.stringify({ ok: false, error: String(err?.message ?? e) }) + "\n");
    process.exitCode = 1;
  }
}
