// lsp.mts — minimal `dprint lsp` client: one lazily spawned child speaking Content-Length framed
// JSON-RPC over stdio, one format() at a time (promise-chain mutex), respawned after a crash.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export type LspRange = {
  start: { line: number; character: number };
  end: { line: number; character: number };
};
export type TextEdit = { range: LspRange; newText: string };

const REQUEST_TIMEOUT_MS = 30_000;
const FORMAT_OPTIONS = { tabSize: 2, insertSpaces: true };

/** A JSON-RPC error response (as opposed to a timeout or a dead child). */
class RpcError extends Error {}

type Pending = {
  resolve: (v: any) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
};

export class DprintLsp {
  private readonly cwd: string;
  private child: ChildProcessWithoutNullStreams | null = null;
  private ready: Promise<void> | null = null;
  private buf: Buffer = Buffer.alloc(0);
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private queue: Promise<unknown> = Promise.resolve();

  constructor(opts: { cwd: string }) {
    this.cwd = opts.cwd;
  }

  /** Formatted text, or null when dprint returns no edits (already formatted). Rejects on any failure. */
  format(uri: string, text: string, range?: LspRange): Promise<string | null> {
    const run = this.queue.then(() => this.formatNow(uri, text, range));
    this.queue = run.catch(() => {}); // a failed call must not block the next one
    return run;
  }

  dispose(): void {
    const child = this.child;
    this.child = null;
    this.ready = null;
    child?.kill();
  }

  private async formatNow(
    uri: string,
    text: string,
    range?: LspRange,
  ): Promise<string | null> {
    await this.start();
    this.notify("textDocument/didOpen", {
      textDocument: { uri, languageId: "", version: 1, text },
    });
    try {
      let edits: TextEdit[] | null;
      try {
        edits = range
          ? await this.request("textDocument/rangeFormatting", {
              textDocument: { uri },
              range,
              options: FORMAT_OPTIONS,
            })
          : await this.request("textDocument/formatting", {
              textDocument: { uri },
              options: FORMAT_OPTIONS,
            });
      } catch (e) {
        if (!range || !(e instanceof RpcError)) throw e;
        // plugin without range support: one retry on the whole document
        edits = await this.request("textDocument/formatting", {
          textDocument: { uri },
          options: FORMAT_OPTIONS,
        });
      }
      return edits && edits.length > 0 ? applyTextEdits(text, edits) : null;
    } finally {
      this.notify("textDocument/didClose", { textDocument: { uri } });
    }
  }

  private start(): Promise<void> {
    if (this.ready) return this.ready;
    // same lookup order as the skill's findDprint(): PATH first, then ~/.dprint/bin
    const child = spawn("dprint", ["lsp"], {
      cwd: this.cwd,
      stdio: "pipe",
      env: {
        ...process.env,
        PATH: `${process.env.PATH ?? ""}:${join(homedir(), ".dprint", "bin")}`,
      },
    });
    this.child = child;
    this.buf = Buffer.alloc(0);
    child.stdin.on("error", () => {}); // EPIPE after a crash; the crash itself surfaces via exit/error
    child.stderr.on("data", (d: Buffer) => process.stderr.write(d));
    child.stdout.on("data", (d: Buffer) => this.onData(d));
    const dead = (err: Error) => {
      if (this.child !== child) return;
      this.child = null;
      this.ready = null;
      for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.reject(err);
      }
      this.pending.clear();
    };
    child.on("error", (e) => dead(e));
    child.on("exit", (code, signal) =>
      dead(new Error(`dprint lsp exited (${code ?? signal})`)),
    );
    const ready = this.request("initialize", {
      processId: process.pid,
      rootUri: pathToFileURL(this.cwd).href,
      capabilities: {},
    }).then(
      () => this.notify("initialized", {}),
      (e) => {
        if (this.child === child) this.dispose();
        throw e;
      },
    );
    this.ready = ready;
    return ready;
  }

  private onData(chunk: Buffer): void {
    this.buf = Buffer.concat([this.buf, chunk]);
    for (;;) {
      const sep = this.buf.indexOf("\r\n\r\n");
      if (sep === -1) return;
      const len = /content-length:\s*(\d+)/i.exec(
        this.buf.subarray(0, sep).toString("ascii"),
      )?.[1];
      if (len === undefined) return this.broken();
      const end = sep + 4 + Number(len);
      if (this.buf.length < end) return;
      const body = this.buf.subarray(sep + 4, end).toString("utf8");
      this.buf = this.buf.subarray(end);
      let msg: any;
      try {
        msg = JSON.parse(body);
      } catch {
        return this.broken();
      }
      this.onMessage(msg);
    }
  }

  /** Unparseable frame: the stream is out of sync; kill the child so pending requests reject now. */
  private broken(): void {
    this.buf = Buffer.alloc(0);
    this.child?.kill();
  }

  private onMessage(msg: any): void {
    if (msg?.id === undefined || msg.id === null) return; // server notification
    if (msg.method !== undefined) {
      this.send({ jsonrpc: "2.0", id: msg.id, result: null }); // server->client request
      return;
    }
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.error)
      p.reject(new RpcError(String(msg.error.message ?? "JSON-RPC error")));
    else p.resolve(msg.result);
  }

  private request(method: string, params: unknown): Promise<any> {
    if (!this.child)
      return Promise.reject(new Error("dprint lsp is not running"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`dprint lsp: ${method} timed out`));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  private notify(method: string, params: unknown): void {
    this.send({ jsonrpc: "2.0", method, params });
  }

  private send(msg: unknown): void {
    const body = Buffer.from(JSON.stringify(msg), "utf8");
    this.child?.stdin.write(
      Buffer.concat([
        Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "ascii"),
        body,
      ]),
    );
  }
}

// shortcut: positions assume "\n" or "\r\n" line breaks and UTF-16 offsets (LSP default); upgrade if dprint ever negotiates positionEncoding
export function applyTextEdits(text: string, edits: TextEdit[]): string {
  const starts = [0];
  for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1))
    starts.push(i + 1);
  const offset = (p: { line: number; character: number }) => {
    if (p.line >= starts.length) return text.length;
    const lineEnd =
      p.line + 1 < starts.length ? starts[p.line + 1] - 1 : text.length;
    return Math.min(starts[p.line] + p.character, lineEnd); // LSP: past the line end means the line end
  };
  const spans = edits
    .map((e) => ({
      s: offset(e.range.start),
      e: offset(e.range.end),
      t: e.newText,
    }))
    .sort((x, y) => y.s - x.s);
  let out = text;
  for (const { s, e, t } of spans) out = out.slice(0, s) + t + out.slice(e);
  return out;
}
