#!/usr/bin/env node
/**
 * Compresses a markdown file into caveman-style prose via a one-shot `claude --print` call, validates the result,
 * retries with one targeted fix, and backs up the original outside the source directory.
 *
 * @remarks
 * The caller (the cc-compress `SKILL.md`) passes the backup root, usually the invoking session's temp/scratchpad
 * dir. Validation and retry happen entirely on in-memory strings; the source file is written at most once, only
 * after a valid result exists, so a crash mid-retry can never leave it half-compressed.
 *
 * @packageDocumentation
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import type { Stats } from "node:fs";
import { basename, dirname, extname, resolve, sep } from "node:path";

/** 1 initial compress attempt + 1 targeted-fix retry. */
const MAX_RETRIES = 2;

/** Largest file compressed (500 KB). */
const MAX_FILE_SIZE = 500_000;

/** Timeout of one `claude --print` call. */
const CLAUDE_TIMEOUT_MS = 120_000;

// ---------- Frontmatter / fence helpers ----------
// JS has no \A/\Z: `^`/`$` without the `m` flag already anchor to the whole
// string, which is the equivalent. `re.DOTALL` maps to the `s` flag.

/** YAML frontmatter at the start of a file. */
const FRONTMATTER_REGEX = /^(---\r?\n.*?\r?\n---\r?\n)(.*)$/s;

/** An outer code fence wrapped around the whole model answer. */
const OUTER_FENCE_REGEX = /^\s*(`{3,}|~{3,})[^\n]*\n(.*)\n\1\s*$/s;

/**
 * Splits YAML frontmatter from the body.
 *
 * @param text - The file text.
 * @returns The frontmatter (with its closing line) and the body; the frontmatter is empty when there is none.
 */
function splitFrontmatter(text: string): { frontmatter: string; body: string } {
  const m = text.match(FRONTMATTER_REGEX);
  if (m) return { frontmatter: m[1], body: m[2] };
  return { frontmatter: "", body: text };
}

/**
 * Removes an outer code fence the model put around its whole answer.
 *
 * @param text - The model answer.
 * @returns The text inside the fence, or the text unchanged.
 */
function stripLlmWrapper(text: string): string {
  const m = text.match(OUTER_FENCE_REGEX);
  return m ? m[2] : text;
}

// ---------- Sensitive-path denylist ----------
// Best-effort filename/path check, refused before any content reaches the
// `claude` subprocess. It does not scan file content — a secret pasted into
// an ordinary-looking notes.md would not be caught.

/** Basenames that look like credentials or keys. */
const SENSITIVE_BASENAME_REGEX = /^(\.env(\..+)?|\.netrc|id_(rsa|dsa|ecdsa|ed25519)(\.pub)?|authorized_keys|known_hosts|.*\.(pem|key|p12|pfx|crt|cer|jks|keystore|asc|gpg))$/i;

/** Directory names that hold private material. */
const SENSITIVE_PATH_COMPONENTS = new Set([".ssh", ".aws", ".gnupg", ".kube", ".docker"]);

/**
 * Substring tokens are checked against the separator-stripped basename, which already subsumes whole-basename
 * patterns like "credentials"/"secrets" — keep those families here only, not duplicated in the regex above.
 */
const SENSITIVE_NAME_TOKENS = ["secret", "credential", "password", "passwd", "apikey", "accesskey", "token", "privatekey"];

/**
 * Whether the file name or path looks sensitive.
 *
 * @param filepath - Absolute path of the file.
 * @returns `true` when compression must be refused.
 */
function isSensitivePath(filepath: string): boolean {
  const name = basename(filepath);
  if (SENSITIVE_BASENAME_REGEX.test(name)) return true;
  const parts = filepath.split(sep).map((p) => p.toLowerCase());
  if (parts.some((p) => SENSITIVE_PATH_COMPONENTS.has(p))) return true;
  const lowered = name.toLowerCase().replace(/[_\-\s.]/g, "");
  return SENSITIVE_NAME_TOKENS.some((tok) => lowered.includes(tok));
}

// ---------- Detection (markdown-only) ----------

/**
 * Whether the file is a markdown file that is not a backup.
 *
 * @param filepath - Path of the file.
 * @returns `true` for a `.md` file other than `*.original.md`.
 */
function shouldCompress(filepath: string): boolean {
  if (basename(filepath).toLowerCase().endsWith(".original.md")) return false;
  return extname(filepath).toLowerCase() === ".md";
}

// ---------- Git recoverability ----------
// git-tracked + clean means `git checkout -- <file>` is a second rollback
// path alongside the session-temp backup; untracked or dirty means the
// session-temp backup is the ONLY rollback path, which the caller should
// confirm with the user before proceeding (see the --confirmed flag).

/**
 * Whether `git checkout -- <file>` restores the file: tracked and without uncommitted changes.
 *
 * @param filepath - Absolute path of the file.
 * @returns `true` when git is a second rollback path.
 */
function isGitRecoverable(filepath: string): boolean {
  const dir = dirname(filepath);
  try {
    execFileSync("git", ["-C", dir, "ls-files", "--error-unmatch", "--", filepath], { stdio: "ignore" });
  } catch {
    return false; // untracked, or not inside a git repo at all
  }
  let status: string;
  try {
    status = execFileSync("git", ["-C", dir, "status", "--porcelain", "--", filepath], { encoding: "utf8" });
  } catch {
    return false;
  }
  return status.trim() === "";
}

// ---------- Backup path ----------
// Mirrors the parent directory name PLUS a short hash of its full resolved
// path under the backup root. A bare parent-dir-name mirror collides for two
// different directories that share a basename (e.g. two repos both named
// "app"); the hash suffix makes the mirrored segment unique to the actual
// source directory instead of merely "usually" distinct.

/**
 * Where the backup of a file goes.
 *
 * @param filepath - Absolute path of the file.
 * @param backupRoot - Backup root directory.
 * @returns `<backupRoot>/<parent>-<hash>/<stem>.original.md`.
 */
function backupPathFor(filepath: string, backupRoot: string): string {
  const dir = dirname(filepath);
  const parentName = basename(dir);
  const hash = createHash("sha256").update(dir).digest("hex").slice(0, 8);
  const stem = basename(filepath, extname(filepath));
  return resolve(backupRoot, `${parentName}-${hash}`, `${stem}.original.md`);
}

// ---------- claude CLI call ----------

/**
 * Sends a prompt to `claude --print` on stdin.
 *
 * @param prompt - The prompt.
 * @returns The answer without an outer code fence.
 * @throws Error when the CLI is missing, fails or times out.
 */
function callClaude(prompt: string): string {
  const result = execFileSync("claude", ["--print", "--model", "sonnet"], {
    input: prompt,
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
    timeout: CLAUDE_TIMEOUT_MS,
  });
  return stripLlmWrapper(result.trim());
}

/**
 * The compression prompt.
 *
 * @param original - The markdown body.
 * @returns The prompt text.
 */
function buildCompressPrompt(original: string): string {
  return `Compress this markdown into caveman format.

STRICT RULES:
- Do NOT modify anything inside \`\`\` code blocks
- Do NOT modify anything inside inline backticks
- Preserve ALL URLs exactly
- Preserve ALL headings exactly
- Preserve file paths and commands
- Return ONLY the compressed markdown body — do NOT wrap the entire output in a \`\`\`markdown fence or any other fence. Inner code blocks from the original stay as-is; do not add a new outer fence around the whole file.

Only compress natural language.

TEXT:
${original}
`;
}

/**
 * The targeted-fix prompt.
 *
 * @param original - The original file text.
 * @param compressed - The compressed text that failed validation.
 * @param errors - The validation errors to fix.
 * @returns The prompt text.
 */
function buildFixPrompt(original: string, compressed: string, errors: string[]): string {
  const errorsStr = errors.map((e) => `- ${e}`).join("\n");
  return `You are fixing a caveman-compressed markdown file. Specific validation errors were found.

CRITICAL RULES:
- DO NOT recompress or rephrase the file
- ONLY fix the listed errors — leave everything else exactly as-is
- The ORIGINAL is provided as reference only (to restore missing content)
- Preserve caveman style in all untouched sections

ERRORS TO FIX:
${errorsStr}

HOW TO FIX:
- Missing URL: find it in ORIGINAL, restore it exactly where it belongs in COMPRESSED
- Code block mismatch: find the exact code block in ORIGINAL, restore it in COMPRESSED
- Heading mismatch: restore the exact heading text from ORIGINAL into COMPRESSED
- Do not touch any section not mentioned in the errors

ORIGINAL (reference only):
${original}

COMPRESSED (fix this):
${compressed}

Return ONLY the fixed compressed file. No explanation.
`;
}

// ---------- Validation ----------

// Trailing-punctuation lookbehind: a URL immediately followed by sentence
// punctuation (a period, comma, closing quote/bracket, ...) must not capture
// that punctuation as part of the URL — otherwise a harmless change in
// surrounding sentence structure looks like a URL mismatch.

/** A URL, without trailing sentence punctuation. */
const URL_REGEX = /https?:\/\/[^\s)]+(?<![.,;:!?)"'\]])/g;

/** A code fence line (opening or closing). */
const FENCE_OPEN_REGEX = /^(\s{0,3})(`{3,}|~{3,})(.*)$/;

/** An ATX heading. */
const HEADING_REGEX = /^(#{1,6})\s+(.*)/gm;

/** A list bullet. */
const BULLET_REGEX = /^\s*[-*+]\s+/gm;

/** A file path. */
const PATH_REGEX = /(?:\.\/|\.\.\/|\/|[A-Za-z]:\\)[\w\-/\\.]+|[\w\-.]+[/\\][\w\-/\\.]+/g;

/** A heading as `[hashes, text]`. */
type Heading = [string, string];

/** The outcome of comparing the original and the compressed text. */
type Validation = {
  /** `true` when `errors` is empty. */
  isValid: boolean;
  /** Blocking problems. */
  errors: string[];
  /** Non-blocking problems. */
  warnings: string[];
};

/**
 * The headings of a text.
 *
 * @param text - Markdown text.
 * @returns Each heading's hashes and trimmed text.
 */
function extractHeadings(text: string): Heading[] {
  return [...text.matchAll(HEADING_REGEX)].map((m): Heading => [m[1], m[2].trim()]);
}

/**
 * Line-based, variable-length-fence, nesting-aware extractor: a closing fence must use the same char, be >= the
 * opening length, and have nothing but whitespace after it on that line (CommonMark) — a shorter/inner fence line
 * with trailing content does not close the block.
 *
 * @param text - Markdown text.
 * @returns Each closed fenced block, fences included.
 */
function extractCodeBlocks(text: string): string[] {
  const blocks: string[] = [];
  const lines = text.split("\n");
  let i = 0;
  while (i < lines.length) {
    const open = (lines[i]).match(FENCE_OPEN_REGEX);
    if (!open) {
      i++;
      continue;
    }
    const fenceChar = open[2][0];
    const fenceLen = open[2].length;
    const blockLines = [lines[i]];
    i++;
    let closed = false;
    while (i < lines.length) {
      const close = (lines[i]).match(FENCE_OPEN_REGEX);
      if (close && close[2][0] === fenceChar && close[2].length >= fenceLen && close[3].trim() === "") {
        blockLines.push(lines[i]);
        closed = true;
        i++;
        break;
      }
      blockLines.push(lines[i]);
      i++;
    }
    if (closed) blocks.push(blockLines.join("\n"));
  }
  return blocks;
}

/**
 * The URLs of a text.
 *
 * @param text - Markdown text.
 * @returns The distinct URLs.
 */
function extractUrls(text: string): Set<string> {
  return new Set(text.match(URL_REGEX) ?? []);
}

/**
 * The file paths of a text.
 *
 * @param text - Markdown text.
 * @returns The distinct paths.
 */
function extractPaths(text: string): Set<string> {
  return new Set(text.match(PATH_REGEX) ?? []);
}

/**
 * The number of list bullets of a text.
 *
 * @param text - Markdown text.
 * @returns The count.
 */
function countBullets(text: string): number {
  return [...text.matchAll(BULLET_REGEX)].length;
}

/**
 * Strips fenced blocks using the already-nesting-aware `codeBlocks` list (from {@link extractCodeBlocks}) rather than
 * re-matching fences with a simpler regex — a naive `` ^```[\s\S]*?^``` `` stops at the first inner fence line inside
 * a 4+-backtick outer fence, leaking its content into inline-code scanning.
 *
 * @param text - Markdown text.
 * @param codeBlocks - The fenced blocks of the text.
 * @returns The inline code spans outside fenced blocks.
 */
function extractInlineCodes(text: string, codeBlocks: string[]): string[] {
  let stripped = text;
  for (const block of codeBlocks) stripped = stripped.split(block).join("");
  return [...stripped.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
}

/**
 * Whether two heading lists are equal in order, hashes and text.
 *
 * @param a - First list.
 * @param b - Second list.
 * @returns `true` when equal.
 */
function headingsEqual(a: Heading[], b: Heading[]): boolean {
  return a.length === b.length && a.every((h, i) => h[0] === b[i][0] && h[1] === b[i][1]);
}

/**
 * Whether two string lists are equal in order.
 *
 * @param a - First list.
 * @param b - Second list.
 * @returns `true` when equal.
 */
function arraysEqual(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/**
 * Compares the compressed text with the original: code blocks, URLs, inline code and heading count are blocking,
 * heading text, paths and bullet count are warnings.
 *
 * @param origText - The original text.
 * @param compText - The compressed text.
 * @returns The errors and warnings.
 */
function validate(origText: string, compText: string): Validation {
  const errors: string[] = [];
  const warnings: string[] = [];

  const h1 = extractHeadings(origText);
  const h2 = extractHeadings(compText);
  if (h1.length !== h2.length) errors.push(`Heading count mismatch: ${h1.length} vs ${h2.length}`);
  if (!headingsEqual(h1, h2)) warnings.push("Heading text/order changed");

  const c1 = extractCodeBlocks(origText);
  const c2 = extractCodeBlocks(compText);
  if (!arraysEqual(c1, c2)) errors.push("Code blocks not preserved exactly");

  const u1 = extractUrls(origText);
  const u2 = extractUrls(compText);
  if (u1.size !== u2.size || [...u1].some((u) => !u2.has(u))) {
    const lost = [...u1].filter((u) => !u2.has(u));
    const added = [...u2].filter((u) => !u1.has(u));
    errors.push(`URL mismatch: lost=${JSON.stringify(lost)}, added=${JSON.stringify(added)}`);
  }

  const p1 = extractPaths(origText);
  const p2 = extractPaths(compText);
  if (p1.size !== p2.size || [...p1].some((p) => !p2.has(p))) {
    const lost = [...p1].filter((p) => !p2.has(p));
    const added = [...p2].filter((p) => !p1.has(p));
    warnings.push(`Path mismatch: lost=${JSON.stringify(lost)}, added=${JSON.stringify(added)}`);
  }

  const b1 = countBullets(origText);
  const b2 = countBullets(compText);
  if (b1 > 0 && Math.abs(b1 - b2) / b1 > 0.15) {
    warnings.push(`Bullet count changed too much: ${b1} -> ${b2}`);
  }

  const ic1 = extractInlineCodes(origText, c1);
  const ic2 = extractInlineCodes(compText, c2);
  const count1 = new Map<string, number>();
  for (const c of ic1) count1.set(c, (count1.get(c) ?? 0) + 1);
  const count2 = new Map<string, number>();
  for (const c of ic2) count2.set(c, (count2.get(c) ?? 0) + 1);
  const sameCounts = count1.size === count2.size && [...count1.entries()].every(([code, n]) => count2.get(code) === n);
  if (!sameCounts) {
    const lost: string[] = [];
    for (const [code, count] of count1.entries()) {
      const other = count2.get(code);
      if (other === undefined) lost.push(code);
      else if (other < count) lost.push(`${code} (lost ${count - other} of ${count} occurrences)`);
    }
    const added = [...count2.keys()].filter((c) => !count1.has(c));
    if (lost.length) errors.push(`Inline code lost: ${JSON.stringify(lost)}`);
    if (added.length) warnings.push(`Inline code added: ${JSON.stringify(added)}`);
  }

  return { isValid: errors.length === 0, errors, warnings };
}

/** The part of a thrown `execFileSync` or `fs` error the script reads. */
type ProcessError = { code?: string; stderr?: string; message: string };

// ---------- Core ----------

/**
 * Compresses one file in place, after backing it up.
 *
 * @param filepath - Path of the markdown file.
 * @param backupRoot - Backup root directory.
 * @param confirmed - `true` to proceed although git is no second rollback path.
 * @returns The process exit code: 0 done or skipped, 1 refused or failed before a write, 2 validation or fix failed, 3 needs `--confirmed`.
 */
function compressFile(filepath: string, backupRoot: string, confirmed: boolean): number {
  filepath = resolve(filepath);

  let stat: Stats;
  try {
    stat = statSync(filepath);
  } catch {
    console.log(`File not found: ${filepath}`);
    return 1;
  }
  if (!stat.isFile()) {
    console.log(`File not found: ${filepath}`);
    return 1;
  }
  if (stat.size > MAX_FILE_SIZE) {
    console.log(`File too large to compress safely (max 500KB): ${filepath}`);
    return 1;
  }
  if (isSensitivePath(filepath)) {
    console.log(
      `Refusing to compress ${filepath}: filename looks sensitive `
        + "(credentials, keys, secrets, or known private paths). "
        + "Compression sends file contents to the Anthropic API. "
        + "Rename the file if this is a false positive.",
    );
    return 1;
  }
  if (!shouldCompress(filepath)) {
    console.log("Skipping: not a markdown file");
    return 0;
  }
  if (!confirmed && !isGitRecoverable(filepath)) {
    console.log(`Not git-recoverable: ${filepath} is untracked or has uncommitted changes.`);
    console.log("The session-temp backup would be the only rollback path if compression proceeds.");
    console.log("Re-run with --confirmed to proceed anyway.");
    return 3;
  }

  console.log(`Processing: ${filepath}`);
  const originalText = readFileSync(filepath, "utf8");
  if (!originalText.trim()) {
    console.log("Refusing to compress: file is empty or whitespace-only.");
    return 1;
  }

  const backupPath = backupPathFor(filepath, backupRoot);
  if (existsSync(backupPath)) {
    console.log(`Backup file already exists: ${backupPath}`);
    console.log("The original backup may contain important content.");
    console.log("Aborting to prevent data loss. Remove or rename the backup file to proceed.");
    return 1;
  }

  const { frontmatter, body } = splitFrontmatter(originalText);
  if (frontmatter) {
    console.log(`Detected YAML frontmatter (${frontmatter.length} chars) — preserving verbatim`);
  }
  if (!body.trim()) {
    console.log("Refusing to compress: body is empty after frontmatter removal.");
    return 1;
  }

  console.log("Compressing with claude --print...");
  let compressedBody: string;
  try {
    compressedBody = callClaude(buildCompressPrompt(body));
  } catch (err) {
    const e = err as ProcessError;
    if (e.code === "ENOENT") {
      console.log("claude CLI not found on PATH. Original file is untouched.");
    } else {
      console.log(`claude --print failed: ${e.stderr || e.message}`);
    }
    return 1;
  }

  if (!compressedBody || !compressedBody.trim()) {
    console.log("Compression aborted: claude returned an empty response.");
    console.log("Original file is untouched (no backup created).");
    return 1;
  }
  if (compressedBody.trim() === body.trim()) {
    console.log("Compression aborted: output is identical to input.");
    console.log("Original file is untouched (no backup created).");
    return 1;
  }

  // Validate + retry entirely in memory. The source file is never written
  // until a valid result exists — a crash/kill mid-loop leaves nothing to
  // restore, because nothing was ever touched.
  let compressed = frontmatter + compressedBody;
  let attempt = 1;
  let result = validate(originalText, compressed);
  console.log(`Validation attempt ${attempt}`);

  while (!result.isValid && attempt < MAX_RETRIES) {
    console.log("Validation failed:");
    for (const e of result.errors) console.log(`   - ${e}`);
    console.log("Fixing with claude --print...");
    let fixed: string;
    try {
      fixed = callClaude(buildFixPrompt(originalText, compressed, result.errors));
    } catch (err) {
      const e = err as ProcessError;
      console.log(`claude --print failed during fix: ${e.stderr || e.message}`);
      console.log("Original file is untouched (no backup created).");
      return 2;
    }
    // Re-pin the ORIGINAL frontmatter: the fix prompt sends the full file
    // (frontmatter included) and asks the model to leave everything else
    // as-is, but a second LLM pass over YAML frontmatter is not a guarantee
    // — re-split the fix response and keep only its body.
    compressed = frontmatter + splitFrontmatter(fixed).body;
    attempt++;
    console.log(`Validation attempt ${attempt}`);
    result = validate(originalText, compressed);
  }

  if (!result.isValid) {
    console.log("Validation failed:");
    for (const e of result.errors) console.log(`   - ${e}`);
    console.log("Failed after retries — original untouched (no backup created)");
    return 2;
  }

  console.log("Validation passed");
  if (result.warnings.length) {
    console.log("Warnings (non-blocking):");
    for (const w of result.warnings) console.log(`   - ${w}`);
  }

  const finalContent = originalText.endsWith("\n") && !compressed.endsWith("\n") ? compressed + "\n" : compressed;

  mkdirSync(dirname(backupPath), { recursive: true });
  // Exclusive create (O_EXCL via 'wx'), not a plain write: closes the gap
  // between the early existsSync check (before the claude round trip) and
  // this write — two concurrent runs on the same file would otherwise both
  // pass that check and the second write would silently clobber the first
  // run's backup.
  try {
    writeFileSync(backupPath, originalText, { flag: "wx" });
  } catch (err) {
    const e = err as ProcessError;
    if (e.code === "EEXIST") {
      console.log(`Backup file already exists: ${backupPath}`);
      console.log("Another compression of this file may be running concurrently.");
      console.log("Aborting to prevent data loss.");
      return 1;
    }
    throw err;
  }
  const backupReadback = readFileSync(backupPath, "utf8");
  if (backupReadback !== originalText) {
    console.log(`Backup write verification failed: ${backupPath}`);
    console.log("In-memory original differs from on-disk backup. Aborting before touching the input file.");
    try {
      unlinkSync(backupPath);
    } catch {
      /* best-effort cleanup */
    }
    return 1;
  }
  writeFileSync(filepath, finalContent);
  console.log(`Compressed: ${filepath}`);
  console.log(`Original:   ${backupPath}`);
  return 0;
}

// ---------- CLI ----------

/** Parses the arguments and runs {@link compressFile}; the exit code is its result. */
function main(): void {
  const args = process.argv.slice(2);
  const confirmed = args.includes("--confirmed");
  const [filepath, backupRoot] = args.filter((a) => a !== "--confirmed");
  if (!filepath || !backupRoot) {
    console.log("Usage: compress.mjs <filepath> <backup-root-dir> [--confirmed]");
    process.exit(1);
  }
  try {
    process.exit(compressFile(filepath, backupRoot, confirmed));
  } catch (err) {
    console.log(`Error: ${(err as Error).message}`);
    process.exit(1);
  }
}

main();
