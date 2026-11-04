#!/usr/bin/env node
// mcp/server.mjs — inline-headroom: host-wide SQLite storage MCP server (Node built-ins only).
// Invoked directly as the .mcp.json command (#!/usr/bin/env node, mode 100755, node-only, no wrapper).
//
// One file, two modes:
// - default: the per-session stdio MCP front-end. Newline-delimited JSON-RPC 2.0; stdout carries
//   JSON-RPC only, every diagnostic goes to stderr. It never imports node:sqlite.
// - `--service <dataDir>`: the detached singleton, spawned on demand by a front-end. It is the ONLY
//   process that opens storage.db, held under PRAGMA locking_mode=EXCLUSIVE from start to exit: that
//   OS-level lock is the host-wide election mutex (freed by the kernel on any process death). It serves
//   one JSON line per connection on the owner-only Unix socket <dataDir>/storage.sock, never writes
//   stdout, and its stderr is <dataDir>/service.log.
//
// PROTOCOL must be bumped on any op or schema change. MIGRATIONS is append-only and additive:
// never edit, reorder or remove an entry.
import { type ChildProcess, spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, realpathSync, unlinkSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import process from "node:process";
// Type-only, erased by tsc: the front-end never loads node:sqlite (runService imports it dynamically).
import type { DatabaseSync, SQLOutputValue } from "node:sqlite";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

/** Absolute path of this file: the `--service` spawn target and the main-module check. */
const SELF = fileURLToPath(import.meta.url);

/**
 * The plugin version, read from plugin.json (its only home).
 *
 * @returns The manifest `version`, or "0.0.0" when unreadable.
 */
function readVersion(): string {
  try {
    const manifest = JSON.parse(readFileSync(path.join(path.dirname(SELF), "..", ".claude-plugin", "plugin.json"), "utf8")) as { version?: string };
    return String(manifest.version ?? "0.0.0");
  } catch {
    return "0.0.0";
  }
}

/** Plugin version: lets a front-end retire an older long-lived service after a plugin update. */
export const VERSION = readVersion();
/** MCP server name; keep aligned with the .mcp.json key. */
const SERVER_NAME = "storage";
/** `serverInfo` reported on `initialize`. */
const SERVER_INFO = { name: SERVER_NAME, version: VERSION };
/** MCP protocol version answered when the client's `initialize` omits one. */
const DEFAULT_PROTOCOL = "2025-11-25";
/** Wire protocol between front-end and service. Bump on any op or schema change. */
export const PROTOCOL = 2;
/** Append-only schema migrations; entry i takes PRAGMA user_version from i to i+1. */
export const MIGRATIONS = [
  "CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT",
  `CREATE TABLE stats (
    day TEXT NOT NULL,
    writer TEXT NOT NULL,
    steps INTEGER NOT NULL,
    clamped INTEGER NOT NULL,
    cache_drops INTEGER NOT NULL,
    input_tokens INTEGER NOT NULL,
    cache_read_input_tokens INTEGER NOT NULL,
    cache_creation_input_tokens INTEGER NOT NULL,
    PRIMARY KEY (day, writer)
  ) STRICT`,
];
/** How long a front-end waits for a spawned service to answer. */
const START_TIMEOUT_MS = 3000;
/** Delay between connection attempts while a service starts or is replaced. */
const POLL_MS = 50;
/** Minimum gap between two spawns by one front-end. */
const SPAWN_RETRY_MS = 500;
/** Per-connection timeout, on both sides of the socket. */
const REQUEST_TIMEOUT_MS = 5000;
/** How long a failed service start blocks further spawns. */
const FAILURE_COOLDOWN_MS = 60000;
/** The service exits after this long without a request. */
const IDLE_MS = 600000;
/** Largest request line the service reads (2 MiB). */
const MAX_REQUEST_BYTES = 2097152;
/** Largest serialized kv value (1 MiB). */
const MAX_VALUE_BYTES = 1048576;
/** Longest kv key, in code points. */
const MAX_KEY_LENGTH = 512;
/** Longest socket path: the macOS sun_path limit (Linux allows 107). */
const MAX_SOCKET_PATH_BYTES = 103;
/** SQLite's primary result code for a locked database. */
const SQLITE_BUSY = 5;
/** How long a shutting-down service lets accepted connections finish. */
const DRAIN_MS = 1000;
/** Wait before a service that lost the election checks for a live winner. */
const ELECTION_PROBE_MS = 300;
/**
 * A lone UTF-16 surrogate. SQLite stores one as U+FFFD, so distinct keys would collapse to one row: reject them.
 * (String#isWellFormed is not in the tsconfig's ES2022 lib.)
 */
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
/**
 * The persisted /headroom counters in stats column order. hooks/policy.mjs COUNTER_KEYS repeats them
 * (this file stays import-free); tests/storage.test.mjs pins both orders.
 */
const STATS_KEYS = ["steps", "clamped", "cache_drops", "input_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"] as const;
/** One validated stats_put row: a day plus every counter. */
type StatsRow = { day: string } & Record<(typeof STATS_KEYS)[number], number>;
/** One stats_put transaction's bound; the mod sends at most the 30 days of its window. */
const MAX_STATS_ROWS = 31;
/** Shape of a YYYY-MM-DD day; `isDay` also checks the calendar. */
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
/** A stats writer id. */
const WRITER_RE = /^[A-Za-z0-9_-]{1,64}$/;
/** Built once from STATS_KEYS, so the column order and the binding order cannot drift. */
const STATS_PUT_SQL = `INSERT OR REPLACE INTO stats(day, writer, ${STATS_KEYS.join(", ")}) VALUES (${["day", "writer", ...STATS_KEYS].map(() => "?").join(", ")})`;
/** Sums every counter from a day on, one column per STATS_KEYS entry. */
const STATS_SUM_SQL = `SELECT ${STATS_KEYS.map((k) => `COALESCE(SUM(${k}), 0) AS ${k}`).join(", ")} FROM stats WHERE day >= ?`;

/** JSON schema of a kv key. */
const KEY_SCHEMA = { type: "string", minLength: 1, maxLength: MAX_KEY_LENGTH };
/** Input schema of the key-only kv tools. */
const KEY_INPUT = { type: "object", properties: { key: KEY_SCHEMA }, required: ["key"], additionalProperties: false };
/** JSON schema of a YYYY-MM-DD day. */
const DAY_SCHEMA = { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" };
/** JSON schema of a stats counter. */
const COUNT_SCHEMA = { type: "integer", minimum: 0 };
/** The `tools/list` answer while storage is enabled. */
const TOOLS = [
  { name: "kv_get", description: "inline-headroom persistent storage: read the JSON value stored under key", inputSchema: KEY_INPUT },
  {
    name: "kv_set",
    description: `inline-headroom persistent storage: store a JSON value under key (max ${MAX_VALUE_BYTES / 2 ** 20} MiB)`,
    inputSchema: {
      type: "object",
      properties: { key: KEY_SCHEMA, value: { description: `any JSON value, at most ${MAX_VALUE_BYTES / 2 ** 20} MiB serialized` } },
      required: ["key", "value"],
      additionalProperties: false,
    },
  },
  { name: "kv_delete", description: "inline-headroom persistent storage: delete key", inputSchema: KEY_INPUT },
  {
    name: "stats_put",
    description: "inline-headroom persistent storage: replace one writer's /headroom stats rows (one per local day) and delete every row before purgeBefore",
    inputSchema: {
      type: "object",
      properties: {
        writer: { type: "string", pattern: "^[A-Za-z0-9_-]{1,64}$" },
        purgeBefore: DAY_SCHEMA,
        rows: {
          type: "array",
          minItems: 1,
          maxItems: MAX_STATS_ROWS,
          items: {
            type: "object",
            properties: { day: DAY_SCHEMA, ...Object.fromEntries(STATS_KEYS.map((k) => [k, COUNT_SCHEMA])) },
            required: ["day", ...STATS_KEYS],
            additionalProperties: false,
          },
        },
      },
      required: ["writer", "rows", "purgeBefore"],
      additionalProperties: false,
    },
  },
  {
    name: "stats_sum",
    description: "inline-headroom persistent storage: sum the /headroom stats of every writer from day since (YYYY-MM-DD, inclusive) on",
    inputSchema: { type: "object", properties: { since: DAY_SCHEMA }, required: ["since"], additionalProperties: false },
  },
  {
    name: "storage_status",
    description: "inline-headroom persistent storage: service pid, protocol and schema version",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
];

// ------------------------------------------------------------------ pure exports

/**
 * userConfig storage_enabled, fail-closed: only the trimmed literal "true" enables, because an
 * enabled store creates files and a host-wide process.
 *
 * @param value - The interpolated userConfig value.
 * @returns Whether storage is enabled.
 */
export function isStorageEnabled(value: string | undefined): boolean {
  return String(value ?? "").trim() === "true";
}

/**
 * Storage paths under CLAUDE_PLUGIN_DATA. No fallback dir: data must survive plugin updates.
 *
 * @param dataDirValue - The CLAUDE_PLUGIN_DATA value.
 * @returns The data dir and its database, socket and log paths.
 */
export function resolveStorage(dataDirValue: string | undefined): { dataDir: string; db: string; sock: string; log: string } {
  const dataDir = typeof dataDirValue === "string" ? dataDirValue.trim() : "";
  if (dataDir === "" || dataDir.includes("${")) throw new Error("CLAUDE_PLUGIN_DATA is unset or unresolved; storage unavailable");
  const sock = path.join(dataDir, "storage.sock");
  // shortcut: the socket path is capped at 103 bytes (macOS sun_path), so a very long data dir fails
  // closed. Upgrade path: a per-uid 0700 dir under os.tmpdir() keyed by a hash of the data dir.
  const n = Buffer.byteLength(sock);
  if (n > MAX_SOCKET_PATH_BYTES) throw new Error(`socket path too long (${n} bytes > ${MAX_SOCKET_PATH_BYTES}): ${sock}`);
  return { dataDir, db: path.join(dataDir, "storage.db"), sock, log: path.join(dataDir, "service.log") };
}

/**
 * Numeric dotted-version comparison (x.y.z); missing or non-numeric parts count as 0.
 *
 * @param a - The first version.
 * @param b - The second version.
 * @returns Negative when a is older, 0 when equal, positive when a is newer.
 */
export function compareVersions(a: unknown, b: unknown): number {
  // String(undefined) and String(null) parse to the same single 0 part as "0".
  const part = (v: unknown) =>
    String(v)
      .split(".")
      .map((n) => Number.parseInt(n, 10) || 0);
  const [x, y] = [part(a), part(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/**
 * Whether a pid reported over the socket may be SIGTERMed: a sane pid that, where /proc exists,
 * is really a `server.mjs --service` process (no /proc, e.g. macOS: the owner-only socket is the trust anchor).
 *
 * @param pid - The pid from a service reply.
 * @returns Whether the pid may be signalled.
 */
export function isStorageService(pid: unknown): boolean {
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 1) return false;
  if (!existsSync("/proc/self/cmdline")) return true;
  try {
    const args = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0");
    return args.includes("--service") && args.some((a: string) => path.basename(a) === "server.mjs");
  } catch {
    return false;
  }
}

/**
 * Applies every missing MIGRATIONS entry, one transaction each. Never downgrades.
 *
 * @param db - The open storage database.
 * @returns The schema version after migration.
 */
export function migrate(db: DatabaseSync): number {
  const v = Number((db.prepare("PRAGMA user_version").get() as { user_version: SQLOutputValue }).user_version);
  if (v > MIGRATIONS.length) throw new Error(`database schema v${v} is newer than this plugin (v${MIGRATIONS.length}); update inline-headroom`);
  for (let i = v; i < MIGRATIONS.length; i++) {
    db.exec("BEGIN");
    try {
      db.exec(MIGRATIONS[i]);
      db.exec(`PRAGMA user_version = ${i + 1}`);
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  }
  return MIGRATIONS.length;
}

/**
 * True for a real calendar day written as YYYY-MM-DD (rejects 2026-02-30, 2026-13-45).
 *
 * @param s - The value to check.
 * @returns Whether `s` is such a day.
 */
function isDay(s: unknown): s is string {
  if (typeof s !== "string" || !DAY_RE.test(s)) return false;
  const t = Date.parse(`${s}T00:00:00Z`);
  return !Number.isNaN(t) && new Date(t).toISOString().startsWith(s);
}

/**
 * Runs one data op: the single trust boundary, validating every key, value, day, writer and counter.
 *
 * @param db - The open, migrated storage database.
 * @param op - The op name; a raw socket client may send a non-string.
 * @param args - The op's arguments, unvalidated.
 * @returns The op's result object.
 */
export function execOp(db: DatabaseSync, op: string, args: Record<string, unknown>): Record<string, unknown> {
  const key = args.key;
  // typeof: a raw socket client may send a non-string op, which must reach "unknown op", not a TypeError.
  if (typeof op === "string" && op.startsWith("kv_")) {
    if (typeof key !== "string" || key.length < 1 || LONE_SURROGATE.test(key) || [...key].length > MAX_KEY_LENGTH) {
      throw new Error(`key must be a non-empty string of at most ${MAX_KEY_LENGTH} characters`);
    }
  }
  // The kv_ cases below cast key: the check above has validated it for every kv_ op.
  switch (op) {
    case "kv_get": {
      const row = db.prepare("SELECT value FROM kv WHERE key = ?").get(key as string);
      return row === undefined ? { found: false } : { found: true, value: JSON.parse(row.value as string) as unknown };
    }
    case "kv_set": {
      let text = "";
      try {
        text = JSON.stringify(args.value) ?? "";
      } catch {
        /* cyclic or BigInt: not serializable */
      }
      if (text === "" || Buffer.byteLength(text) > MAX_VALUE_BYTES) throw new Error(`value must be JSON-serializable and at most ${MAX_VALUE_BYTES} bytes`);
      db.prepare("INSERT INTO kv(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key as string, text);
      return { ok: true };
    }
    case "kv_delete":
      return { deleted: Number(db.prepare("DELETE FROM kv WHERE key = ?").run(key as string).changes) > 0 };
    case "stats_put": {
      const { writer, purgeBefore, rows } = args;
      if (typeof writer !== "string" || !WRITER_RE.test(writer)) throw new Error("writer must be 1-64 of letters, digits, _ and -");
      if (!isDay(purgeBefore)) throw new Error("purgeBefore must be a YYYY-MM-DD day");
      if (!Array.isArray(rows) || rows.length < 1 || rows.length > MAX_STATS_ROWS) throw new Error(`rows must hold 1-${MAX_STATS_ROWS} rows`);
      const list: unknown[] = rows;
      // Load-bearing, not left to the table: STRICT coerces the string "7" into an INTEGER column and accepts 2**53.
      const isRow = (row: unknown): row is StatsRow => {
        if (row === null || typeof row !== "object" || Array.isArray(row)) return false;
        const r = row as Record<string, unknown>;
        return isDay(r.day) && STATS_KEYS.every((k) => Number.isSafeInteger(r[k]) && (r[k] as number) >= 0);
      };
      if (!list.every(isRow)) throw new Error(`each row needs a YYYY-MM-DD day and non-negative integer ${STATS_KEYS.join(", ")}`);
      db.exec("BEGIN");
      try {
        const put = db.prepare(STATS_PUT_SQL);
        for (const row of list) put.run(row.day, writer, ...STATS_KEYS.map((k) => row[k]));
        // shortcut: the purge trusts the caller's day and is global across writers, so a writer whose clock
        // runs ahead purges early. Upgrade path: clamp purgeBefore to the newest stored day if skew ever matters.
        const purged = Number(db.prepare("DELETE FROM stats WHERE day < ?").run(purgeBefore).changes);
        db.exec("COMMIT");
        return { ok: true, purged };
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    }
    case "stats_sum": {
      if (!isDay(args.since)) throw new Error("since must be a YYYY-MM-DD day");
      // BigInt reads: a SUM past 2**53 (each row only passes the safe-integer check) makes a plain read throw
      // ERR_OUT_OF_RANGE, which would leave the window unreadable until its rows age out.
      const sumStmt = db.prepare(STATS_SUM_SQL);
      sumStmt.setReadBigInts(true);
      // An aggregate without GROUP BY always yields one row.
      const row = sumStmt.get(args.since) as Record<string, SQLOutputValue>;
      // A plain object: .get() returns a null-prototype one.
      return Object.fromEntries(STATS_KEYS.map((k) => [k, Number(row[k])]));
    }
    default:
      throw new Error(`unknown op: ${op}`);
  }
}

/**
 * Message of a caught value.
 *
 * @param e - Anything thrown.
 * @returns `e.message` for an `Error`, else `String(e)`.
 */
function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Stack of a caught value, for debug output.
 *
 * @param e - Anything thrown.
 * @returns `e.stack` for an `Error` (its message when it has none), else `String(e)`.
 */
function errStack(e: unknown): string {
  return e instanceof Error ? (e.stack ?? e.message) : String(e);
}

/**
 * Error code of a caught value (a Node system error's `code`, node:sqlite's `errcode`).
 *
 * @param e - Anything thrown.
 * @param field - The property holding the code.
 * @returns The property's value, or undefined when `e` has none.
 */
function errField(e: unknown, field: "code" | "errcode"): unknown {
  return (e as Record<string, unknown> | null | undefined)?.[field];
}

// ------------------------------------------------------------------ front-end

/** A service reply line; every field but `protocol` is checked before use. */
type ServiceReply = { protocol: number; pid?: unknown; version?: unknown; error?: unknown; result?: unknown };

/** A parsed JSON-RPC message from the client; every field is checked before use. */
type RpcRequest = { id?: unknown; method?: unknown; params?: { protocolVersion?: unknown; name?: unknown; arguments?: unknown } | null };

/** Whether userConfig storage_enabled is on for this front-end. */
const ENABLED = isStorageEnabled(process.env.INLINE_HEADROOM_STORAGE_ENABLED);
/** The service this front-end spawned, until it exits. */
let child: ChildProcess | null = null;
/** Earliest time of this front-end's next spawn. */
let nextSpawnAt = 0;
/** Spawning is blocked until this time after a failed service start. */
let coolDownUntil = 0;
/** Why spawning is cooling down; thrown while it is. */
let coolDownReason = "";

/**
 * One request over a fresh connection: writes one JSON line, resolves with the first reply line.
 *
 * @param sockPath - The service socket.
 * @param msg - The request object.
 * @returns The parsed reply, which always carries a numeric `protocol`.
 */
function roundTrip(sockPath: string, msg: Record<string, unknown>): Promise<ServiceReply> {
  return new Promise((resolve, reject) => {
    let buf = "";
    const sock = net.connect(sockPath);
    sock.setEncoding("utf8");
    sock.setTimeout(REQUEST_TIMEOUT_MS, () => sock.destroy(new Error("storage request timed out")));
    sock.on("connect", () => sock.write(JSON.stringify(msg) + "\n"));
    sock.on("data", (chunk: string) => {
      buf += chunk;
      const nl = buf.indexOf("\n");
      if (nl === -1) return;
      sock.destroy();
      try {
        const reply = JSON.parse(buf.slice(0, nl)) as ServiceReply | null;
        if (typeof reply?.protocol !== "number") throw new Error("no protocol");
        resolve(reply);
      } catch {
        reject(new Error("malformed storage service reply"));
      }
    });
    sock.on("error", reject);
    sock.on("close", () => reject(Object.assign(new Error("storage service closed the connection without a reply"), { code: "ECLOSED" })));
  });
}

/**
 * Starts the detached service: not a child that dies with this session.
 *
 * @param storage - The data dir and the service log path.
 */
function spawnService(storage: { dataDir: string; log: string }): void {
  mkdirSync(storage.dataDir, { recursive: true, mode: 0o700 });
  // shortcut: service.log is never rotated; it only gets fatal service errors (one line per failed
  // start, and the mod's per-turn stats write or an open /headroom pane's refresh can trigger one per
  // session every FAILURE_COOLDOWN_MS on a host that cannot run the service). Upgrade path: rotate it if it ever grows noticeably.
  const fd = openSync(storage.log, "a", 0o600);
  try {
    // --disable-warning: node:sqlite's ExperimentalWarning (Node 22) would otherwise land in service.log on every start.
    // cwd: a long-lived daemon must not pin the caller's project dir (it would block an umount).
    child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", SELF, "--service", storage.dataDir], {
      detached: true,
      stdio: ["ignore", "ignore", fd],
      cwd: storage.dataDir,
    });
  } finally {
    closeSync(fd);
  }
  child.unref();
  const coolDown = (reason: string) => {
    coolDownUntil = Date.now() + FAILURE_COOLDOWN_MS;
    coolDownReason = reason;
  };
  child.on("exit", (code: number | null) => {
    child = null;
    // 0 = lost the election (normal); null = killed by a signal (the next call respawns)
    if (code) coolDown(`storage service exited with code ${code}; see ${storage.log}`);
  });
  child.on("error", (e: Error) => {
    child = null;
    coolDown(`cannot spawn storage service: ${e.message}`);
  });
}

/**
 * Sends one op to the host-wide service, spawning it when none listens. Retried: ENOENT/ECONNREFUSED/
 * ECONNRESET (nothing was sent) and a reply-less close (a service shutting down). Every op is idempotent
 * (stats_put replaces absolute rows and purges by date; kv_delete may report deleted:false when the first
 * attempt had already applied), so a retry is safe.
 * A failure cool-down only gates spawning: a live service is always tried first.
 *
 * @param op - The op name.
 * @param args - The op's arguments.
 * @returns The op's result.
 */
async function callService(op: string, args: Record<string, unknown>): Promise<unknown> {
  if (!ENABLED) throw new Error("storage is disabled (userConfig storage_enabled is not true)");
  // The transport is a path-based Unix socket; native-Windows listen() would need a \\.\pipe\ name instead.
  if (process.platform === "win32") throw new Error("storage is unsupported on native Windows (it needs a Unix domain socket); use WSL2");
  const storage = resolveStorage(process.env.CLAUDE_PLUGIN_DATA);
  const deadline = Date.now() + START_TIMEOUT_MS;
  const startTimeout = () => new Error(`storage service did not start within ${START_TIMEOUT_MS} ms; see ${storage.log}`);
  for (;;) {
    let res: ServiceReply;
    try {
      res = await roundTrip(storage.sock, { protocol: PROTOCOL, op, args });
    } catch (e) {
      const code = errField(e, "code");
      if (code !== "ENOENT" && code !== "ECONNREFUSED" && code !== "ECONNRESET" && code !== "ECLOSED") throw e;
      if (Date.now() < coolDownUntil) throw new Error(coolDownReason, { cause: e });
      if (Date.now() > deadline) throw startTimeout();
      if (!child && Date.now() >= nextSpawnAt) {
        spawnService(storage);
        nextSpawnAt = Date.now() + SPAWN_RETRY_MS;
      }
      await sleep(POLL_MS);
      continue;
    }
    if (res.protocol > PROTOCOL) {
      throw new Error(`a newer inline-headroom storage service is running (protocol ${res.protocol} > ${PROTOCOL}); restart this session to load the updated plugin`);
    }
    if (res.protocol < PROTOCOL) {
      // An older service answered "protocol mismatch" without executing the request: replace it.
      if (Date.now() > deadline) throw startTimeout();
      if (!retire(res.pid)) throw new Error(`storage service on the socket reported an unusable pid (${String(res.pid)}); not replacing it`);
      await sleep(POLL_MS);
      continue;
    }
    if ("error" in res) throw new Error(String(res.error));
    // Same protocol, older plugin version (a fix shipped without a PROTOCOL bump): the request already ran,
    // so retire the old service best-effort; the next call spawns the current one. Never the reverse, or two
    // sessions on different versions would kill each other's service.
    if (compareVersions(res.version, VERSION) < 0) retire(res.pid);
    return res.result;
  }
}

/**
 * SIGTERMs an older service (it drains in-flight requests first) when its pid checks out.
 *
 * @param pid - The pid from the service's reply.
 * @returns False when the pid is not a storage service and was left alone.
 */
function retire(pid: unknown): boolean {
  if (!isStorageService(pid)) return false;
  try {
    process.kill(pid as number, "SIGTERM");
  } catch {
    /* already gone */
  }
  return true;
}

/**
 * Serves MCP over stdio (newline-delimited JSON-RPC 2.0) until stdin closes.
 */
function startServer(): void {
  const send = (msg: unknown) => process.stdout.write(JSON.stringify(msg) + "\n");
  const ok = (id: unknown, result: unknown) => send({ jsonrpc: "2.0", id, result });
  const fail = (id: unknown, code: number, message: string) => send({ jsonrpc: "2.0", id, error: { code, message } });

  const handle = async (msg: RpcRequest | null): Promise<unknown> => {
    const { id, method, params }: RpcRequest = msg ?? {};
    switch (method) {
      case "initialize":
        return ok(id, { protocolVersion: params?.protocolVersion ?? DEFAULT_PROTOCOL, capabilities: { tools: {} }, serverInfo: SERVER_INFO });
      case "ping":
        return ok(id, {});
      case "tools/list":
        return ok(id, { tools: ENABLED ? TOOLS : [] });
      case "tools/call": {
        const name = params?.name;
        const tool = TOOLS.find((t) => t.name === name);
        if (!tool) return fail(id, -32602, `unknown tool: ${String(name)}`);
        // The service's execOp validates every argument; the MCP client is not trusted to.
        const args = (params?.arguments ?? {}) as Record<string, unknown>;
        if (process.env.MCP_HOOK_DEBUG) process.stderr.write(`[${SERVER_NAME}] tools/call ${tool.name} args=${JSON.stringify(args)}\n`);
        try {
          const result = await callService(tool.name, args);
          return ok(id, { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result });
        } catch (e) {
          return ok(id, { content: [{ type: "text", text: `inline-headroom storage: ${errMsg(e)}` }], isError: true });
        }
      }
      default:
        if (id === undefined) return; // notifications/*
        return fail(id, -32601, `method not found: ${String(method)}`);
    }
  };

  const onLine = (line: string) => {
    const trimmed = line.trim();
    if (trimmed === "") return;
    let msg: RpcRequest | null;
    try {
      msg = JSON.parse(trimmed) as RpcRequest | null;
    } catch {
      process.stderr.write(`[${SERVER_NAME}] non-JSON line ignored\n`);
      return;
    }
    handle(msg).catch((e: unknown) => {
      process.stderr.write(`[${SERVER_NAME}] handler crash: ${errStack(e)}\n`);
      if (msg?.id !== undefined) fail(msg.id, -32603, `internal error: ${errMsg(e)}`);
    });
  };

  // Frame on "\n" only: readline also splits on U+2028/U+2029 (Node >= 24), which JSON.stringify
  // leaves raw inside strings, so a request carrying one would be cut into unparseable fragments.
  let buf = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk: string) => {
    buf += chunk;
    for (let nl = buf.indexOf("\n"); nl !== -1; nl = buf.indexOf("\n")) {
      onLine(buf.slice(0, nl));
      buf = buf.slice(nl + 1);
    }
  });
  process.stdin.on("end", () => process.exit(0));
}

// ------------------------------------------------------------------ service

/**
 * The detached singleton: wins the storage.db exclusive lock or exits 0, migrates, then serves one
 * JSON line per connection on storage.sock until 10 idle minutes pass or SIGTERM/SIGINT arrives.
 *
 * @param dataDirValue - The data dir from the command line.
 */
async function runService(dataDirValue: string | undefined): Promise<void> {
  process.umask(0o077);
  const storage = resolveStorage(dataDirValue);
  mkdirSync(storage.dataDir, { recursive: true, mode: 0o700 });
  let sqlite: typeof import("node:sqlite");
  try {
    sqlite = await import("node:sqlite");
  } catch (e) {
    throw new Error(`node:sqlite unavailable in Node ${process.version}; Node >= 22.13 required`, { cause: e });
  }
  const db = new sqlite.DatabaseSync(storage.db);
  try {
    db.exec("PRAGMA locking_mode=EXCLUSIVE; PRAGMA journal_mode=WAL; BEGIN EXCLUSIVE; COMMIT");
  } catch (e) {
    if (errField(e, "errcode") !== SQLITE_BUSY) throw e;
    // Lost the election, or a foreign process (a sqlite3 shell) holds the DB. Stay silent when a live service
    // answers; otherwise leave one line in service.log so the front-end's "see service.log" points somewhere.
    await sleep(ELECTION_PROBE_MS);
    try {
      await roundTrip(storage.sock, { protocol: PROTOCOL, op: "storage_status", args: {} });
    } catch {
      process.stderr.write(`[storage] ${new Date().toISOString()} ${storage.db} is locked by another process and no storage service answers on ${storage.sock}\n`);
    }
    process.exit(0);
  }
  const schemaVersion = migrate(db);
  try {
    unlinkSync(storage.sock); // only the lock holder gets here, so any socket file is stale
  } catch (e) {
    if (errField(e, "code") !== "ENOENT") throw e;
  }

  let idle: NodeJS.Timeout | undefined;
  let closing = false;
  const open = new Set<net.Socket>();
  const finish = () => {
    try {
      unlinkSync(storage.sock);
    } catch {
      /* already gone */
    }
    db.close();
    process.exit(0);
  };
  // Stops accepting, then lets accepted connections finish for at most DRAIN_MS (a stuck client must not keep
  // the DB lock alive). The socket is unlinked before the lock is released, so it can only be this service's own.
  const shutdown = () => {
    if (closing) return;
    closing = true;
    clearTimeout(idle);
    server.close();
    if (open.size === 0) return finish();
    setTimeout(finish, DRAIN_MS);
  };

  const respond = (line: string): Record<string, unknown> => {
    let req: { protocol?: unknown; op?: unknown; args?: unknown } | null;
    try {
      req = JSON.parse(line) as typeof req;
    } catch {
      return { error: "malformed request" };
    }
    if (req?.protocol !== PROTOCOL) return { error: "protocol mismatch" }; // never executed
    if (req.op === "storage_status") return { result: { pid: process.pid, protocol: PROTOCOL, version: VERSION, schemaVersion, dataDir: storage.dataDir } };
    try {
      // Casts only: execOp is the trust boundary and rejects a non-string op or bad args itself.
      return { result: execOp(db, req.op as string, (req.args ?? {}) as Record<string, unknown>) };
    } catch (e) {
      return { error: errMsg(e) };
    }
  };

  const onConnection = (sock: net.Socket) => {
    let buf = "";
    let bytes = 0;
    let answered = false;
    const reply = (body: Record<string, unknown>) => sock.end(JSON.stringify({ protocol: PROTOCOL, pid: process.pid, version: VERSION, ...body }) + "\n");
    open.add(sock);
    sock.on("close", () => {
      open.delete(sock);
      if (closing && open.size === 0) finish();
    });
    sock.setEncoding("utf8");
    sock.setTimeout(REQUEST_TIMEOUT_MS, () => sock.destroy());
    sock.on("error", () => {});
    sock.on("data", (chunk: string) => {
      if (answered) return;
      buf += chunk;
      bytes += Buffer.byteLength(chunk);
      if (bytes > MAX_REQUEST_BYTES) {
        answered = true;
        reply({ error: "request too large" });
        return;
      }
      if (!chunk.includes("\n")) return;
      answered = true;
      if (!closing) {
        clearTimeout(idle);
        idle = setTimeout(shutdown, IDLE_MS);
      }
      reply(respond(buf.slice(0, buf.indexOf("\n"))));
    });
  };

  const server = net.createServer(onConnection);
  await new Promise<void>((resolve, reject) => server.once("error", reject).listen(storage.sock, resolve));
  idle = setTimeout(shutdown, IDLE_MS);
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

/**
 * Whether this file runs as the program rather than as an import (tests import its pure exports).
 *
 * @returns True when argv[1] resolves to this file.
 */
function isMainModule(): boolean {
  try {
    return realpathSync(process.argv[1]) === realpathSync(SELF);
  } catch {
    return false;
  }
}

if (isMainModule()) {
  if (process.argv[2] === "--service") {
    runService(process.argv[3]).catch((e: unknown) => {
      // One line per failed start (the mod's per-turn write can trigger one every cool-down); the stack only when debugging.
      process.stderr.write(`[storage] ${process.env.MCP_HOOK_DEBUG ? errStack(e) : errMsg(e)}\n`);
      process.exit(1);
    });
  } else {
    startServer();
  }
}
