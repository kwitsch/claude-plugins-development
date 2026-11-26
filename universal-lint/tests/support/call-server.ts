// JSON-RPC client of the built server (startServer) and, run as a script, the one-shot driver of the harness:
// `node call-server.ts <server.mjs>` with one hook payload on stdin prints `{ text, stderr }`.
import { spawn } from "node:child_process";
import { statSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** A tool call's `structuredContent` (the handler's answer object). */
export type Answer = Record<string, unknown>;
/** One JSON-RPC message from the server. */
export type Rpc = { id?: number; result?: Record<string, unknown>; error?: { code: number; message: string; data?: unknown } };

/**
 * Spawns the built server and returns a client for it.
 *
 * @param server - Path of the built `server.mjs`.
 * @param env - The server's whole environment.
 * @param cwd - The server's working directory.
 * @returns `rpc` (raw request, carries its `id`), `call` (tools/call, resolves the `structuredContent`), `key` (the session key, fetched once per session), `notify`, `stderr`, `pid` and `close` (ends stdin, resolves the exit code).
 */
export function startServer(server: string, env: Record<string, string>, cwd: string) {
  const child = spawn(process.execPath, [server], { env, cwd, stdio: ["pipe", "pipe", "pipe"] });
  let id = 0;
  let buf = "";
  let err = "";
  const waiting = new Map<number, (m: Rpc) => void>();
  const keys = new Map<string, string>();
  child.stdout.on("data", (d: Buffer) => {
    buf += d.toString();
    for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
      const m = JSON.parse(buf.slice(0, i)) as Rpc;
      buf = buf.slice(i + 1);
      if (m.id !== undefined) {
        waiting.get(m.id)?.(m);
        waiting.delete(m.id);
      }
    }
  });
  child.stderr.on("data", (d: Buffer) => (err += d.toString()));
  const closed = new Promise<number | null>((resolve) => child.on("close", resolve));
  const rpc = (method: string, params: object = {}): Promise<Rpc> & { id: number } => {
    const n = ++id;
    const p = new Promise<Rpc>((resolve) => waiting.set(n, resolve));
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: n, method, params }) + "\n");
    return Object.assign(p, { id: n });
  };
  const call = (tool: string, args: object = {}): Promise<Answer> & { id: number } => {
    const r = rpc("tools/call", { name: tool, arguments: args });
    return Object.assign(r.then((m) => (m.result?.["structuredContent"] ?? {}) as Answer), { id: r.id });
  };
  return {
    rpc,
    call,
    /** The session's key: the first call asks for it with a keyless `next_report` (`wait_ms: 0`). */
    async key(session_id: string): Promise<string> {
      let k = keys.get(session_id);
      if (k === undefined) {
        k = String((await call("next_report", { session_id, wait_ms: 0 }))["key"]);
        keys.set(session_id, k);
      }
      return k;
    },
    notify: (method: string, params: object): void => void child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n"),
    stderr: (): string => err,
    pid: child.pid,
    close: (): Promise<number | null> => (child.stdin.end(), closed),
  };
}

/** One-shot driver: one server, the tool calls of the payload's event, `{ text, stderr }` on stdout. */
async function main(): Promise<void> {
  let input = "";
  for await (const chunk of process.stdin) input += String(chunk);
  const p = { session_id: "harness", ...(JSON.parse(input) as Record<string, unknown>) };
  const cwd = typeof p["cwd"] === "string" && statSync(p["cwd"], { throwIfNoEntry: false })?.isDirectory() ? p["cwd"] : process.cwd();
  const s = startServer(process.argv[2] ?? "", process.env as Record<string, string>, cwd);
  const session_id = String(p.session_id);
  const key = await s.key(session_id);
  const ev = p["hook_event_name"] ?? "PostToolUse";
  let text: unknown;
  if (ev === "Stop" || ev === "SubagentStop") text = (await s.call("stop", p))["reason"];
  else if (ev === "FileChanged") {
    await s.call("file_changed", p);
    // `timeout`: file_changed reported nothing, so no stop (a stop would also sweep the record written before the git gate)
    if ((await s.call("next_report", { session_id, key, wait_ms: 0 }))["state"] === "ready") text = (await s.call("stop", { hook_event_name: "Stop", cwd: p["cwd"], session_id }))["reason"];
  } else {
    if (typeof p["scratchpad_dir"] === "string") await s.call("prompt_submitted", { cwd: p["cwd"], session_id, scratchpad_dir: p["scratchpad_dir"] });
    text = (await s.call("file_edited", { ...p, key }))["context"];
  }
  await s.close();
  process.stdout.write(JSON.stringify({ text: typeof text === "string" ? text : "", stderr: s.stderr() }));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
