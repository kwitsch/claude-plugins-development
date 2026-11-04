#!/usr/bin/env node
/** Plugin version: lets a front-end retire an older long-lived service after a plugin update. */
export declare const VERSION: string;
/** Front-end <-> service wire protocol. Bump on any op or schema change. */
export declare const PROTOCOL = 2;
/** Append-only schema migrations; entry i takes PRAGMA user_version from i to i+1. */
export declare const MIGRATIONS: string[];
/**
 * userConfig storage_enabled, fail-closed: only the trimmed literal "true" enables, because an
 * enabled store creates files and a host-wide process.
 */
export declare function isStorageEnabled(value: string | undefined): boolean;
/**
 * Storage paths under CLAUDE_PLUGIN_DATA. No fallback dir: data must survive plugin updates.
 */
export declare function resolveStorage(dataDirValue: string | undefined): {
    dataDir: string;
    db: string;
    sock: string;
    log: string;
};
/**
 * Numeric dotted-version comparison (x.y.z); missing or non-numeric parts count as 0.
 * @returns negative when a < b, 0 when equal, positive when a > b
 */
export declare function compareVersions(a: unknown, b: unknown): number;
/**
 * Whether a pid reported over the socket may be SIGTERMed: a sane pid that, where /proc exists,
 * is really a `server.mjs --service` process (no /proc, e.g. macOS: the owner-only socket is the trust anchor).
 */
export declare function isStorageService(pid: unknown): boolean;
/**
 * Applies every missing MIGRATIONS entry, one transaction each. Never downgrades.
 * @param db - a node:sqlite DatabaseSync
 * @returns the schema version after migration
 */
export declare function migrate(db: any): number;
/**
 * Runs one data op: the single trust boundary, validating every key, value, day, writer and counter.
 * @param db - a node:sqlite DatabaseSync
 */
export declare function execOp(db: any, op: string, args: Record<string, unknown>): Record<string, unknown>;
