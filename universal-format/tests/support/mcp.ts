// End-to-end access to the built server: a throwaway sandbox (project dir, HOME, a PATH that holds only bash, node,
// cat and the stub formatters a test adds) and the spawned `plugin/mcp/server.mjs` speaking JSON-RPC. No real
// formatter and no network is ever reached.
import { type ChildProcessWithoutNullStreams, spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import type { HookOut } from "./plugin.ts";

/** The built plugin. */
export const PLUGIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../plugin");
/** The built server. */
export const SERVER = path.join(PLUGIN, "mcp/server.mjs");

/** A JSON-RPC answer of the server. */
export interface RpcReply {
  /** The request id. */
  id: number;
  /** The result; absent on an error answer. */
  result: Record<string, unknown> & { structuredContent: HookOut; tools: { name: string; _meta?: unknown }[] };
  /** The error; absent on a result answer. */
  error: { code: number; message: string; data?: unknown };
}

/** A spawned server. */
export interface Server {
  /** Sends a request and resolves with its answer. */
  rpc(method: string, params?: object): Promise<RpcReply>;
  /** Calls `format_pre` and resolves with the hook result. */
  call(args: object): Promise<HookOut>;
  /** `format_pre` for a Write; `cwd` defaults to the project dir. */
  write(file: string, content: string, cwd?: string): Promise<HookOut>;
  /** `format_pre` for an Edit in the project dir. */
  edit(file: string, old_string: string, new_string: string): Promise<HookOut>;
  /** Writes one raw JSON-RPC message; no answer is awaited. */
  raw(msg: object): void;
  /** The ids answered so far. */
  answered: Set<number>;
  /** Everything the server wrote to stderr so far. */
  stderr(): string;
  /** The server process. */
  child: ChildProcessWithoutNullStreams;
}

/** A throwaway environment for one test. */
export interface Sandbox {
  /** The root of everything below. */
  root: string;
  /** The only PATH directory. */
  bin: string;
  /** HOME. */
  home: string;
  /** The project directory, used as the session's cwd. */
  proj: string;
  /** Writes an executable bash stub into `dir` (default `bin`) with the given body lines. */
  stub(name: string, lines: string[], dir?: string): void;
  /** A stub that appends `<name> <argv>` to the record, drains stdin and prints `reformatted-by-<name>`. */
  recStub(name: string): void;
  /** What the recording stubs wrote, `""` when none ran. */
  recorded(): string;
  /** Spawns the server with the sandbox's PATH and HOME. */
  server(env?: Record<string, string>): Server;
}

const servers: ChildProcessWithoutNullStreams[] = [];
const roots: string[] = [];

/** Kills every server and removes every sandbox; a test file registers it with `afterEach`. */
export function cleanup(): void {
  while (servers.length) servers.pop()?.kill("SIGKILL");
  while (roots.length) rmSync(roots.pop() ?? "", { recursive: true, force: true });
}

/**
 * Creates a sandbox.
 *
 * @returns The sandbox.
 */
export function sandbox(): Sandbox {
  const root = mkdtempSync(path.join(tmpdir(), "uf-mcp-"));
  roots.push(root);
  const [bin, home, proj] = ["bin", "home", "proj"].map((d) => path.join(root, d));
  for (const d of [bin, home, proj]) mkdirSync(d);
  // a stray dprint or git state above os.tmpdir() must not reach the tests: every upward walk ends at a .git
  mkdirSync(path.join(root, ".git"));
  for (const t of ["bash", "node", "cat"]) symlinkSync(spawnSync("sh", ["-c", `command -v ${t}`], { encoding: "utf8" }).stdout.trim(), path.join(bin, t));
  const record = path.join(root, "record");
  const stub: Sandbox["stub"] = (name, lines, dir = bin) => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, name), ["#!/usr/bin/env bash", ...lines, ""].join("\n"));
    chmodSync(path.join(dir, name), 0o755);
  };
  return {
    root,
    bin,
    home,
    proj,
    stub,
    recStub: (name) => stub(name, [`printf '%s %s\\n' ${name} "$*" >> "$RECORD"`, "cat >/dev/null", `printf 'reformatted-by-${name}\\n'`]),
    recorded: () => (existsSync(record) ? readFileSync(record, "utf8") : ""),
    server(env = {}) {
      const child = spawn(path.join(bin, "node"), [SERVER], { env: { PATH: bin, HOME: home, RECORD: record, ...env }, stdio: ["pipe", "pipe", "pipe"] });
      servers.push(child);
      let stderr = "";
      child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
      const answered = new Set<number>();
      const waiting = new Map<number, (msg: RpcReply) => void>();
      createInterface({ input: child.stdout }).on("line", (line) => {
        const msg = JSON.parse(line) as RpcReply; // throws (fails the run) if stdout carries anything but JSON-RPC
        answered.add(msg.id);
        waiting.get(msg.id)?.(msg);
        waiting.delete(msg.id);
      });
      let nextId = 0;
      const raw: Server["raw"] = (msg) => void child.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...msg }) + "\n");
      const rpc: Server["rpc"] = (method, params) =>
        new Promise((resolve) => {
          const id = ++nextId;
          waiting.set(id, resolve);
          raw({ id, method, params });
        });
      const call: Server["call"] = async (args) => (await rpc("tools/call", { name: "format_pre", arguments: args })).result.structuredContent;
      return {
        rpc,
        call,
        raw,
        answered,
        stderr: () => stderr,
        child,
        write: (file, content, cwd = proj) => call({ cwd, tool_name: "Write", tool_input: { file_path: file, content, old_string: "", new_string: "", replace_all: "" } }),
        edit: (file, old_string, new_string) => call({ cwd: proj, tool_name: "Edit", tool_input: { file_path: file, content: "", old_string, new_string, replace_all: "false" } }),
      };
    },
  };
}
