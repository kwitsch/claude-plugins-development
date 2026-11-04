/**
 * Shared dprint lookup used by `check-dprint.mts`, `run-dprint.mts` and the MCP server's lsp client
 * (`mcp/lsp.mts`) and watch list (`mcp/watch-list.mts`). The project config lookup is `find-config.mts`.
 *
 * @packageDocumentation
 */

import { execFile } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

/** npx arguments that run the dprint npm package, downloading it into the npm cache when it is not there. */
const NPX_DPRINT = ["--yes", "dprint"];

/** Timeout of the `npx --yes dprint --version` probe; a cold download measured about 2 s. */
const NPX_PROBE_TIMEOUT_MS = 10_000;

/** How long a failed npx probe stays cached; a later call after this re-probes (a download that timed out, a network that came back). */
const NPX_RETRY_MS = 30_000;

/**
 * Probe per npx path: the in-flight or settled result of `npx --yes dprint --version`, and when it failed (a
 * success is kept for the life of the process).
 */
const probes = new Map<string, { ok: Promise<boolean>; failedAt?: number }>();

/**
 * Check whether a path is a regular file this user may execute.
 *
 * @param p - Path to test.
 * @returns `true` for an executable regular file, `false` otherwise (including when it does not exist).
 */
function isExecutableFile(p: string): boolean {
  try {
    accessSync(p, constants.X_OK);
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/**
 * Find the first executable regular file named `name` in the `PATH` entries.
 *
 * @param name - File name to look for.
 * @returns Absolute path of the first match, or `null` when no `PATH` entry has one.
 */
function onPath(name: string): string | null {
  for (const dir of (process.env.PATH ?? "").split(":")) {
    if (!dir) continue;
    const p = resolve(dir, name);
    if (isExecutableFile(p)) return p;
  }
  return null;
}

/**
 * Run `npx --yes dprint --version` without blocking the event loop.
 *
 * @param npx - Absolute path of the npx executable.
 * @returns `true` when it exited 0 and printed `dprint <digit>...`; otherwise `false` after one stderr line naming the reason.
 */
async function runProbe(npx: string): Promise<boolean> {
  let why: string;
  try {
    const { stdout } = await promisify(execFile)(npx, [...NPX_DPRINT, "--version"], {
      encoding: "utf8",
      timeout: NPX_PROBE_TIMEOUT_MS,
    });
    const out = stdout.trim();
    if (/^dprint \d/.test(out)) return true;
    why = `unexpected output ${JSON.stringify(out)}`;
  } catch (e) {
    // the message spans lines (command, then npm's stderr); the diagnostic stays one line
    why = (e instanceof Error ? e.message : String(e)).replace(/\s+/g, " ").trim();
  }
  process.stderr.write(
    `find-dprint: no dprint on PATH or in ~/.dprint/bin, and '${npx} --yes dprint --version' failed (${why}); treating dprint as not installed\n`,
  );
  return false;
}

/**
 * Check whether `npx --yes dprint --version` runs the dprint npm package.
 *
 * @remarks
 * Concurrent callers share one probe. A success is cached; a failure for {@link NPX_RETRY_MS}.
 *
 * @param npx - Absolute path of the npx executable.
 * @returns `true` when the probe printed a dprint version, `false` otherwise.
 */
function probeNpx(npx: string): Promise<boolean> {
  const hit = probes.get(npx);
  if (hit && (hit.failedAt === undefined || Date.now() - hit.failedAt < NPX_RETRY_MS)) return hit.ok;
  const entry: { ok: Promise<boolean>; failedAt?: number } = { ok: runProbe(npx) };
  void entry.ok.then((ok) => {
    if (!ok) entry.failedAt = Date.now();
  });
  probes.set(npx, entry);
  return entry.ok;
}

/**
 * Build the spawn arguments for a dprint subcommand.
 *
 * @param cmd - A command returned by {@link findDprint}.
 * @param args - dprint arguments (subcommand and options).
 * @returns The file to spawn and its argv (the command's own prefix, then `args`).
 */
export function dprintArgv(cmd: string[], args: string[]): [string, string[]] {
  const [file, ...pre] = cmd;
  return [file, [...pre, ...args]];
}

/**
 * Find how to run dprint: the first executable `dprint` on `PATH`, else `~/.dprint/bin/dprint` (the install
 * script's default location), else the dprint npm package through the first `npx` on `PATH`, if a probe shows it
 * runs.
 *
 * @remarks
 * `PATH` and `~/.dprint/bin` are checked on every call, so a dprint installed later wins over npx. The probe is
 * asynchronous (the MCP server keeps answering other hooks during a cold download) and cached, see {@link probeNpx}.
 *
 * @returns The argv prefix to spawn without a shell (`[dprint]` or `[npx, "--yes", "dprint"]`, absolute first
 * element; build the spawn arguments with {@link dprintArgv}), or `null` when none works.
 */
export async function findDprint(): Promise<string[] | null> {
  const bin = onPath("dprint");
  if (bin) return [bin];
  const fallback = join(homedir(), ".dprint", "bin", "dprint");
  if (isExecutableFile(fallback)) return [fallback];
  const npx = onPath("npx");
  return npx && (await probeNpx(npx)) ? [npx, ...NPX_DPRINT] : null;
}
