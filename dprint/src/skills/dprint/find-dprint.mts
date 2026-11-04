/**
 * Shared dprint lookup used by `check-dprint.mts`, `run-dprint.mts` and the MCP server's lsp client
 * (`mcp/lsp.mts`) and watch list (`mcp/watch-list.mts`). The project config lookup is `find-config.mts`.
 *
 * @packageDocumentation
 */

import { execFileSync } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/** npx arguments that run the dprint npm package, downloading it into the npm cache when it is not there. */
const NPX_DPRINT = ["--yes", "dprint"];

/** Timeout of the `npx --yes dprint --version` probe; a cold download measured about 2 s. */
const NPX_PROBE_TIMEOUT_MS = 10_000;

/**
 * Probe outcome per npx path: `true` when `npx --yes dprint --version` printed a dprint version.
 *
 * @remarks
 * shortcut: a failed probe is not retried in this process (a session started offline stays without npx dprint
 * until it restarts); upgrade to a time-limited entry if that bites.
 */
const npxWorks = new Map<string, boolean>();

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
 * Check once per npx path whether `npx --yes dprint --version` runs the dprint npm package.
 *
 * @remarks
 * The outcome is cached in {@link npxWorks}. A failure writes one stderr line naming the reason.
 *
 * @param npx - Absolute path of the npx executable.
 * @returns `true` when the probe exited 0 and printed `dprint <digit>...`, `false` otherwise.
 */
function probeNpx(npx: string): boolean {
  const cached = npxWorks.get(npx);
  if (cached !== undefined) return cached;
  let ok: boolean;
  let why: string;
  try {
    const out = execFileSync(npx, [...NPX_DPRINT, "--version"], {
      encoding: "utf8",
      timeout: NPX_PROBE_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    ok = /^dprint \d/.test(out);
    why = `unexpected output ${JSON.stringify(out)}`;
  } catch (e) {
    ok = false;
    // the message spans lines (command, then npm's stderr); the diagnostic stays one line
    why = (e instanceof Error ? e.message : String(e)).replace(/\s+/g, " ").trim();
  }
  if (!ok) {
    process.stderr.write(
      `find-dprint: no dprint on PATH or in ~/.dprint/bin, and '${npx} --yes dprint --version' failed (${why}); treating dprint as not installed\n`,
    );
  }
  npxWorks.set(npx, ok);
  return ok;
}

/**
 * Find how to run dprint: the first executable `dprint` on `PATH`, else `~/.dprint/bin/dprint` (the install
 * script's default location), else the dprint npm package through the first `npx` on `PATH`, if a probe shows it
 * runs.
 *
 * @remarks
 * `PATH` and `~/.dprint/bin` are checked on every call, so a dprint installed later wins over npx; only the npx
 * probe outcome is cached.
 *
 * @returns The argv prefix to spawn without a shell (`[dprint]` or `[npx, "--yes", "dprint"]`, absolute first
 * element), or `null` when none works.
 */
export function findDprint(): string[] | null {
  const bin = onPath("dprint");
  if (bin) return [bin];
  const fallback = join(homedir(), ".dprint", "bin", "dprint");
  if (isExecutableFile(fallback)) return [fallback];
  const npx = onPath("npx");
  return npx && probeNpx(npx) ? [npx, ...NPX_DPRINT] : null;
}
