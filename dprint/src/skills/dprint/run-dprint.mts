#!/usr/bin/env node
/**
 * dprint skill helper: run `dprint check` or `dprint fmt` in the working directory, optionally narrowed to one
 * scope argument, once dprint and a project dprint config are found.
 *
 * @remarks
 * Usage `node run-dprint.mjs <check|fmt> [scope]`. Without dprint or a config in the working directory or an
 * ancestor it prints `status=notsetup reason=<missing|noconfig>`, a hint to run `/dprint init` and exits 3
 * without running dprint. Otherwise dprint runs with inherited stdio (no shell, the scope is passed after `--`)
 * and its exit code is passed through. Contract: `run-dprint.reference.md`.
 *
 * @packageDocumentation
 */

import { spawnSync } from "node:child_process";
import { findConfig, findDprint } from "./find-dprint.mjs";

/**
 * Validate the arguments, check that dprint is set up and run it.
 *
 * @param args - Command-line arguments after the script path: `check` or `fmt`, then an optional non-empty scope.
 * @returns The exit code: 2 usage error or spawn failure, 3 not set up, otherwise dprint's own exit code.
 */
function run(args: string[]): number {
  const sub = args[0];
  if (
    args.length < 1
    || args.length > 2
    || (sub !== "check" && sub !== "fmt")
    || (args.length === 2 && args[1] === "")
  ) {
    process.stderr.write("usage: node run-dprint.mjs <check|fmt> [scope]\n");
    return 2;
  }

  const dprint = findDprint();
  if (dprint === null || findConfig(process.cwd()) === null) {
    const missing = dprint === null;
    process.stdout.write(`status=notsetup reason=${missing ? "missing" : "noconfig"}\n`);
    process.stderr.write(
      `dprint is not set up here (${missing ? "no dprint found" : "no dprint config found in this directory or its ancestors"}): run /dprint init (/dprint:dprint init) first\n`,
    );
    return 3;
  }

  // no shell: the scope reaches dprint byte-for-byte; `--` keeps a scope starting with `-` from being an option
  const r = spawnSync(dprint, args.length === 2 ? [sub, "--", args[1]] : [sub], { stdio: "inherit" });
  if (r.error || r.status === null) {
    process.stderr.write(`run-dprint: '${dprint} ${sub}' failed: ${r.error?.message ?? String(r.signal)}\n`);
    return 2;
  }
  return r.status;
}

/** Exit code of this run; set instead of calling `process.exit()` so dprint's inherited output is not cut. */
process.exitCode = run(process.argv.slice(2));
