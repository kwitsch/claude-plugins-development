// cc-compress: the built compress.mjs run on an isolated PATH (node, bash, cat, git, a stub `claude`) and the shape of
// its SKILL.md. Ported from the bats cases "compress.mjs ..." and "cc-compress ...".
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { accessSync, constants, existsSync, mkdirSync, readdirSync, readFileSync, statSync, symlinkSync } from "node:fs";
import { basename, join } from "node:path";
import { expect, test } from "vitest";
import { makeStub, PLUGIN, put, readPlugin, run, tmpDir } from "./support/plugin.js";

const SCRIPT = join(PLUGIN, "skills/cc-compress/compress.mjs");
const SKILL_MD = "skills/cc-compress/SKILL.md";
const PRESERVED = "# Title\n\nThis is a long enough sentence to compress.\n";

/** A throwaway world: isolated bin dir (node, bash, cat, git), home and a work dir. */
function world() {
  const root = tmpDir();
  const bin = join(root, "bin");
  mkdirSync(bin);
  for (const t of ["node", "bash", "cat", "git"]) {
    const found = execFileSync("sh", ["-c", `command -v ${t}`], { encoding: "utf8" }).trim();
    symlinkSync(found, join(bin, t));
  }
  const home = join(root, "home");
  mkdirSync(home);
  const extra: Record<string, string> = {};
  return {
    root,
    bin,
    extra,
    compress: (...args: string[]) => run(SCRIPT, args, { env: { PATH: bin, HOME: home, ...extra } }),
  };
}

/** Joined stdout and stderr, as bats `$output` held both. */
const out = (r: { stdout: string; stderr: string }): string => r.stdout + r.stderr;

/** Every file named `name` below `dir`. */
function findFiles(dir: string, name: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile() && e.name === name)
    .map((e) => join(e.parentPath, e.name));
}

/** Mirrors backupPathFor: parent dir name plus 8 hex chars of the sha256 of the dir path. */
const backupHashDir = (dir: string): string => `${basename(dir)}-${createHash("sha256").update(dir).digest("hex").slice(0, 8)}`;

/** A `claude` stub echoing the text after the last "TEXT:\n" marker plus a trailing comment marker. */
function passthroughStub(bin: string): void {
  makeStub(bin, "claude", [
    "if [[ \"$*\" != *\"--print\"* || \"$*\" != *\"--model\"* || \"$*\" != *\"sonnet\"* ]]; then echo \"bad args: $*\" >&2; exit 9; fi",
    "prompt=\"$(cat)\"",
    "marker=$'TEXT:\\n'",
    "body=\"${prompt#*\"$marker\"}\"",
    "printf '%s\\n\\n<!-- compressed -->' \"$body\"",
  ]);
}

/** A `claude` stub answering `first` on its first call and `second` after, counting calls in a file. */
function retryStub(w: ReturnType<typeof world>, first: string, second: string): string {
  const counter = join(w.root, "counter");
  put(join(w.root, "o1.md"), first);
  put(join(w.root, "o2.md"), second);
  w.extra.RETRY_COUNTER = counter;
  w.extra.RETRY_OUTPUT_1 = join(w.root, "o1.md");
  w.extra.RETRY_OUTPUT_2 = join(w.root, "o2.md");
  makeStub(w.bin, "claude", [
    "if [[ \"$*\" != *\"--print\"* || \"$*\" != *\"--model\"* || \"$*\" != *\"sonnet\"* ]]; then echo \"bad args: $*\" >&2; exit 9; fi",
    "cat > /dev/null",
    "n=0; [ -f \"$RETRY_COUNTER\" ] && n=$(cat \"$RETRY_COUNTER\")",
    "n=$((n+1)); echo \"$n\" > \"$RETRY_COUNTER\"",
    "if [ \"$n\" -eq 1 ]; then cat \"$RETRY_OUTPUT_1\"; else cat \"$RETRY_OUTPUT_2\"; fi",
  ]);
  return counter;
}

const BASH_DOC = "# Title\n\n```bash\necho hi\n```\n\nA sentence long enough to compress here.\n";

test("compress.mjs exists, has a shebang, is executable and passes node --check", () => {
  expect(readFileSync(SCRIPT, "utf8").startsWith("#!/usr/bin/env node")).toBe(true);
  accessSync(SCRIPT, constants.X_OK);
  expect(statSync(SCRIPT).mode & 0o111).not.toBe(0);
  expect(run(process.execPath, ["--check", SCRIPT]).status).toBe(0);
});

test("compress.mjs: no args prints usage and exits 1", () => {
  const r = world().compress();
  expect(r.status).toBe(1);
  expect(out(r)).toMatch(/usage/i);
});

test("compress.mjs: one arg prints usage and exits 1", () => {
  const w = world();
  expect(w.compress(join(w.root, "x.md")).status).toBe(1);
});

test("compress.mjs: non-.md target is skipped with exit 0, no backup written", () => {
  const w = world();
  const src = join(w.root, "notes.txt");
  put(src, "hello\n");
  const backups = join(w.root, "backups_skip");
  expect(w.compress(src, backups).status).toBe(0);
  expect(existsSync(backups)).toBe(false);
});

test("compress.mjs: sensitive filename is refused without spawning claude", () => {
  // No `claude` stub on PATH: a bypassed check would say "claude CLI not found", not "sensitive".
  const w = world();
  const src = join(w.root, "secrets.md");
  const body = "some content that is long enough to pass the empty check\n";
  put(src, body);
  const r = w.compress(src, join(w.root, "backups_sensitive"));
  expect(r.status).toBe(1);
  expect(out(r)).toMatch(/sensitive/i);
  expect(readFileSync(src, "utf8")).toBe(body);
});

test("compress.mjs: claude missing from PATH leaves source untouched with a clear error", () => {
  const w = world();
  const src = join(w.root, "plain.md");
  const body = "# Title\n\nSome prose sentence long enough to compress.\n";
  put(src, body);
  expect(w.compress(src, join(w.root, "backups_noclaude"), "--confirmed").status).toBe(1);
  expect(readFileSync(src, "utf8")).toBe(body);
});

test("compress.mjs: successful compression writes compressed file + backup", () => {
  const w = world();
  passthroughStub(w.bin);
  const src = join(w.root, "proj/notes.md");
  put(src, PRESERVED);
  const backups = join(w.root, "backups_ok");
  expect(w.compress(src, backups, "--confirmed").status).toBe(0);
  const text = readFileSync(src, "utf8");
  expect(text).toContain("<!-- compressed -->");
  expect(text).toContain("# Title");
  const found = findFiles(backups, "notes.original.md");
  expect(found).toHaveLength(1);
  expect(readFileSync(found[0], "utf8")).toContain("This is a long enough sentence to compress.");
});

test("compress.mjs: existing backup aborts to prevent data loss", () => {
  const w = world();
  passthroughStub(w.bin);
  const dir = join(w.root, "proj2");
  const src = join(dir, "notes.md");
  put(src, PRESERVED);
  const backups = join(w.root, "backups_exists");
  put(join(backups, backupHashDir(dir), "notes.original.md"), "pre-existing backup\n");
  const r = w.compress(src, backups, "--confirmed");
  expect(r.status).toBe(1);
  expect(out(r)).toMatch(/already exists/i);
  expect(readFileSync(src, "utf8")).toContain("# Title");
});

test("compress.mjs: YAML frontmatter round-trips verbatim", () => {
  const w = world();
  passthroughStub(w.bin);
  const src = join(w.root, "proj3/notes.md");
  put(src, "---\nname: test\ntype: memory\n---\n# Title\n\nThis is a long enough sentence to compress.\n");
  expect(w.compress(src, join(w.root, "backups_fm"), "--confirmed").status).toBe(0);
  expect(readFileSync(src, "utf8").split("\n").slice(0, 4).join("\n")).toBe("---\nname: test\ntype: memory\n---");
});

test("compress.mjs: nested fenced code block survives validation", () => {
  const w = world();
  passthroughStub(w.bin);
  const src = join(w.root, "proj4/notes.md");
  put(src, "# Title\n\n````text\nsome outer content\n```inner marker```\nmore outer\n````\n\nA sentence long enough to compress here.\n");
  expect(w.compress(src, join(w.root, "backups_nest"), "--confirmed").status).toBe(0);
  const text = readFileSync(src, "utf8");
  expect(text).toContain("````text");
  expect(text).toContain("inner marker");
});

test("compress.mjs: multiple URLs preserved", () => {
  const w = world();
  passthroughStub(w.bin);
  const src = join(w.root, "proj5/notes.md");
  put(src, "# Title\n\nSee https://example.com/a and https://example.com/b for a long enough sentence.\n");
  expect(w.compress(src, join(w.root, "backups_urls"), "--confirmed").status).toBe(0);
  const text = readFileSync(src, "utf8");
  expect(text).toContain("https://example.com/a");
  expect(text).toContain("https://example.com/b");
});

test("compress.mjs: preserves a trailing newline the original had", () => {
  const w = world();
  passthroughStub(w.bin);
  const src = join(w.root, "proj9/notes.md");
  put(src, PRESERVED);
  expect(w.compress(src, join(w.root, "backups_nl"), "--confirmed").status).toBe(0);
  expect(readFileSync(src, "utf8").endsWith("\n")).toBe(true);
});

test("compress.mjs: retries with a targeted fix and succeeds on retry 2", () => {
  const w = world();
  const counter = retryStub(
    w,
    "# Title\n\nBroken compression, code block dropped.",
    "# Title\n\n```bash\necho hi\n```\n\nFixed compression.",
  );
  const src = join(w.root, "proj6/notes.md");
  put(src, BASH_DOC);
  expect(w.compress(src, join(w.root, "backups_retry_ok"), "--confirmed").status).toBe(0);
  expect(readFileSync(src, "utf8")).toContain("Fixed compression");
  expect(readFileSync(counter, "utf8").trim()).toBe("2");
});

test("compress.mjs: retries when a URL is dropped, succeeds after the fix", () => {
  const w = world();
  const counter = retryStub(
    w,
    "# Title\n\nSee docs for a sentence long enough to compress.",
    "# Title\n\nSee https://example.com/docs for a fixed sentence.",
  );
  const src = join(w.root, "proj8/notes.md");
  put(src, "# Title\n\nSee https://example.com/docs for a sentence long enough to compress here.\n");
  expect(w.compress(src, join(w.root, "backups_retry_url"), "--confirmed").status).toBe(0);
  expect(readFileSync(src, "utf8")).toContain("https://example.com/docs");
  expect(readFileSync(counter, "utf8").trim()).toBe("2");
});

test("compress.mjs: exhausts retries, leaves source untouched, writes no backup", () => {
  const w = world();
  retryStub(w, "# Title\n\nBroken compression, code block dropped.", "# Title\n\nStill broken, code block still dropped.");
  const src = join(w.root, "proj7/notes.md");
  put(src, BASH_DOC);
  const backups = join(w.root, "backups_retry_fail");
  expect(w.compress(src, backups, "--confirmed").status).toBe(2);
  expect(readFileSync(src, "utf8")).toBe(BASH_DOC);
  expect(findFiles(backups, "notes.original.md")).toEqual([]);
});

test("compress.mjs: exit 3 when target is untracked, nothing touched", () => {
  const w = world();
  const dir = join(w.root, "proj10");
  mkdirSync(dir);
  execFileSync("git", ["init", "-q"], { cwd: dir });
  const src = join(dir, "notes.md");
  const body = "# Title\n\nSome prose sentence long enough to compress.\n";
  put(src, body);
  const backups = join(w.root, "backups_untracked");
  const r = w.compress(src, backups);
  expect(r.status).toBe(3);
  expect(out(r)).toMatch(/not git-recoverable/i);
  expect(readFileSync(src, "utf8")).toBe(body);
  expect(findFiles(backups, "notes.original.md")).toEqual([]);
});

test("compress.mjs: --confirmed bypasses the git-recoverability gate", () => {
  const w = world();
  passthroughStub(w.bin);
  const dir = join(w.root, "proj11");
  mkdirSync(dir);
  execFileSync("git", ["init", "-q"], { cwd: dir });
  put(join(dir, "notes.md"), PRESERVED);
  expect(w.compress(join(dir, "notes.md"), join(w.root, "backups_bypass"), "--confirmed").status).toBe(0);
});

test("compress.mjs: git-tracked-and-clean target skips the recoverability gate", () => {
  const w = world();
  passthroughStub(w.bin);
  const dir = join(w.root, "proj12");
  const src = join(dir, "notes.md");
  put(src, PRESERVED);
  const git = (...a: string[]) => execFileSync("git", a, { cwd: dir });
  git("init", "-q");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "test");
  git("add", "notes.md");
  git("commit", "-q", "-m", "init");
  expect(w.compress(src, join(w.root, "backups_tracked")).status).toBe(0);
});

// --- SKILL.md shape ---

test("cc-compress SKILL.md exists", () => {
  expect(existsSync(join(PLUGIN, SKILL_MD))).toBe(true);
});

test("cc-compress SKILL.md has name, description, argument-hint frontmatter", () => {
  const t = readPlugin(SKILL_MD);
  expect(t).toMatch(/^name:\s*cc-compress/m);
  expect(t).toMatch(/^description:/m);
  expect(t).toMatch(/^argument-hint:/m);
});

test("cc-compress is model-invocable (no disable-model-invocation)", () => {
  expect(readPlugin(SKILL_MD)).not.toMatch(/^disable-model-invocation:\s*true/m);
});

test("cc-compress has no load-time !-injection trigger", () => {
  expect(readPlugin(SKILL_MD)).not.toContain("!`");
});

test("cc-compress references its bundled script via CLAUDE_SKILL_DIR", () => {
  expect(readPlugin(SKILL_MD)).toContain("${CLAUDE_SKILL_DIR}/compress.mjs");
});

test("cc-compress gates non-recoverable targets through AskUserQuestion", () => {
  const t = readPlugin(SKILL_MD);
  expect(t).toContain("AskUserQuestion");
  expect(t).toMatch(/git/i);
});

test("cc-compress documents the session-temp backup resolution", () => {
  expect(readPlugin(SKILL_MD)).toMatch(/scratchpad|mktemp/i);
});
