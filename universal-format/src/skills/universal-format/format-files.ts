#!/usr/bin/env node
/**
 * Driver of the `universal-format` skill: applies the plugin's on-write formatting to a list of files through the
 * hook handler itself, so there is no second formatting logic.
 *
 * @remarks
 * Usage: `format-files.mjs <listfile>`; the list file holds one path per line, resolved against the cwd. Each file is
 * read, passed to `formatPre` as a Write would be, and the returned content written back. Fails open per file and
 * always exits 0 on a real run (2 without a readable list file): the printed summary is the signal.
 *
 * @packageDocumentation
 */
import { readFileSync, writeFileSync } from "node:fs";
import { extname, resolve } from "node:path";
import process from "node:process";
import { formatPre } from "../../mcp/handlers.js";
import { EXT_MAP } from "../../mcp/registry.js";

const listFile = process.argv[2];
if (!listFile) {
  console.error("usage: format-files.mjs <listfile>");
  process.exit(2);
}

const cwd = process.cwd();
let list = "";
try {
  list = readFileSync(listFile, "utf8");
} catch (err) {
  console.error(`cannot read the list file ${listFile}: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(2);
}
const paths = list.split("\n").map((line) => line.trim()).filter((line) => line.length > 0);

/** Files per outcome. */
const count = { formatted: 0, unchanged: 0, skipped: 0 };
for (const p of paths) {
  const resolved = resolve(cwd, p);
  if (!Object.hasOwn(EXT_MAP, extname(resolved).toLowerCase())) {
    count.skipped++;
    console.log(`skipped (unsupported): ${p}`);
    continue;
  }
  try {
    const content = readFileSync(resolved, "utf8");
    const updated = (await formatPre({ cwd, tool_name: "Write", tool_input: { file_path: resolved, content } })).hookSpecificOutput?.updatedInput;
    if (updated !== undefined && "content" in updated && updated.content !== content) {
      writeFileSync(resolved, updated.content);
      count.formatted++;
      console.log(`formatted: ${p}`);
    } else {
      count.unchanged++;
      console.log(`unchanged: ${p}`);
    }
  } catch (err) {
    count.skipped++;
    console.log(`skipped (error: ${err instanceof Error ? err.message : String(err)}): ${p}`);
  }
}
console.log(`universal-format: ${count.formatted} formatted, ${count.unchanged} unchanged, ${count.skipped} skipped (${paths.length} total)`);
process.exit(0);
