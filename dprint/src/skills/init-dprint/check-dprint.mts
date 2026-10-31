#!/usr/bin/env node
/**
 * init-dprint skill helper: locate dprint, read `dprint --version` and compare it numerically against
 * {@link MIN_VERSION}.
 *
 * @remarks
 * Prints exactly one line
 * `status=<ok|missing|outdated|error> version=<X.Y.Z|-> min=<MIN> path=<abs|->` and exits with the code
 * documented in `check-dprint.reference.md`. Read-only: never installs anything.
 *
 * @packageDocumentation
 */

import { execFileSync } from "node:child_process";
import { findDprint } from "./find-dprint.mjs";

/** Lowest supported dprint version; the only definition (README and tests read it from here). */
const MIN_VERSION = "0.50.0";

/** Outcome of {@link check}: the exit code plus the fields of the status line. */
interface CheckResult {
  /** Process exit code (0 ok, 2 error, 10 missing, 11 outdated). */
  code: number;
  /** `ok`, `missing`, `outdated` or `error`. */
  status: string;
  /** Detected `X.Y.Z`, or `-` when unknown. */
  version: string;
  /** Absolute path of the dprint binary, or `-` when none was found. */
  path: string;
}

/**
 * Compare a `X.Y.Z` version numerically against {@link MIN_VERSION}.
 *
 * @param version - Release version without prerelease suffix.
 * @returns Negative if `version` is lower, 0 if equal, positive if higher.
 */
function compareToMin(version: string): number {
  const a = version.split(".").map(Number);
  const b = MIN_VERSION.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

/**
 * Locate dprint and classify its version.
 *
 * @param args - Command-line arguments after the script path; any argument is a usage error.
 * @returns The status line fields and the exit code.
 */
function check(args: string[]): CheckResult {
  if (args.length > 0) {
    process.stderr.write("usage: node check-dprint.mjs (takes no arguments)\n");
    return { code: 2, status: "error", version: "-", path: "-" };
  }
  const path = findDprint();
  if (path === null) {
    return { code: 10, status: "missing", version: "-", path: "-" };
  }

  let out: string;
  try {
    out = String(
      execFileSync(path, ["--version"], {
        encoding: "utf8",
        timeout: 10000,
        stdio: ["ignore", "pipe", "pipe"],
      }),
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    process.stderr.write(`check-dprint: '${path} --version' failed: ${msg}\n`);
    return { code: 2, status: "error", version: "-", path };
  }

  const m = /^dprint (\d+)\.(\d+)\.(\d+)(-\S+)?/.exec(out.trim());
  if (!m) {
    process.stderr.write(
      `check-dprint: unparseable '${path} --version' output: ${JSON.stringify(out.trim())}\n`,
    );
    return { code: 2, status: "error", version: "-", path };
  }
  const version = `${m[1]}.${m[2]}.${m[3]}`;
  // a prerelease of MIN_VERSION sorts below it
  const cmp = compareToMin(version) || (m[4] ? -1 : 0);
  return cmp >= 0
    ? { code: 0, status: "ok", version, path }
    : { code: 11, status: "outdated", version, path };
}

/** Result of this run, printed as the single status line. */
const r = check(process.argv.slice(2));
process.stdout.write(
  `status=${r.status} version=${r.version} min=${MIN_VERSION} path=${r.path}\n`,
);
process.exit(r.code);
