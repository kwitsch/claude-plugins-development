/**
 * Minimal `dprint lsp` client.
 *
 * @remarks
 * One lazily spawned child per {@link DprintLsp} speaks Content-Length framed JSON-RPC over stdio. Calls to
 * {@link DprintLsp.format} run one at a time (promise-chain mutex) and the child is respawned after a crash.
 *
 * @packageDocumentation
 */
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { findDprint } from "../skills/init-dprint/find-dprint.mjs";

/** LSP range: zero-based line and UTF-16 character offsets, end exclusive. */
export type LspRange = {
  /** First position inside the range. */
  start: { line: number; character: number };
  /** First position after the range. */
  end: { line: number; character: number };
};

/** LSP `TextEdit`: replace `range` with `newText`. */
type TextEdit = {
  /** Range of the original document to replace. */
  range: LspRange;
  /** Replacement text. */
  newText: string;
};

/** Per-request timeout; a request that exceeds it kills the child, the next format respawns it. */
const REQUEST_TIMEOUT_MS = 30_000;
/** Required by the LSP formatting requests; dprint takes its real settings from the project config. */
const FORMAT_OPTIONS = { tabSize: 2, insertSpaces: true };

/** A JSON-RPC error response (as opposed to a timeout or a dead child). */
class RpcError extends Error {}

/** A JSON-RPC message from the child, as far as this client reads it; every field is checked before use. */
type RpcMessage = {
  /** Request/response id; absent or `null` on notifications. */
  id?: unknown;
  /** Set on server-to-client requests and notifications. */
  method?: unknown;
  /** Response payload. */
  result?: unknown;
  /** Error response payload. */
  error?: { message?: unknown } | null;
};

/** An in-flight request awaiting its response. */
type Pending = {
  /** Settles the request with the response `result`. */
  resolve: (v: unknown) => void;
  /** Settles the request with an error response, a timeout or the child's death. */
  reject: (e: Error) => void;
  /** Timeout of the request. */
  timer: NodeJS.Timeout;
};

/** Client for one `dprint lsp` child rooted at one working directory. */
export class DprintLsp {
  /** Working directory and `rootUri` of the child; decides which dprint config applies. */
  private readonly cwd: string;
  /** The running child, or `null` before the first format and after it died. */
  private child: ChildProcessWithoutNullStreams | null = null;
  /** Settles once `initialize` succeeded; `null` until the child is (re)started. */
  private ready: Promise<void> | null = null;
  /** Unconsumed stdout bytes (an incomplete frame). */
  private buf: Buffer = Buffer.alloc(0);
  /** Id of the next request. */
  private nextId = 1;
  /** In-flight requests by id. */
  private readonly pending = new Map<number, Pending>();
  /** Tail of the format queue; every format waits for the previous one. */
  private queue: Promise<unknown> = Promise.resolve();

  /**
   * Create a client; the child is spawned lazily on the first {@link DprintLsp.format}.
   *
   * @param opts - Client options; `cwd` is the working directory and LSP root of the child.
   */
  constructor(opts: { cwd: string }) {
    this.cwd = opts.cwd;
  }

  /**
   * Format a document, or a range of it, as dprint would format the file at `uri`.
   *
   * @param uri - `file://` URI of the document; dprint picks the plugin by its extension.
   * @param text - Document content (sent via `didOpen`, nothing is read from disk).
   * @param range - Range to format; whole document when omitted. A plugin without range support falls back
   * to formatting the whole document.
   * @returns The formatted text, or `null` when dprint returns no edits (already formatted).
   * Rejects on any failure: dprint missing, crash, timeout or error response.
   */
  format(uri: string, text: string, range?: LspRange): Promise<string | null> {
    const run = this.queue.then(() => this.formatNow(uri, text, range));
    this.queue = run.catch(() => {}); // a failed call must not block the next one
    return run;
  }

  /**
   * Kill the child, if any, and reject every in-flight request.
   */
  dispose(): void {
    const child = this.child;
    this.child = null;
    this.ready = null;
    child?.kill();
    this.failPending(new Error("dprint lsp disposed")); // the exit handler ignores a disposed child
  }

  /**
   * Reject and forget every in-flight request.
   *
   * @param err - Rejection reason.
   */
  private failPending(err: Error): void {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }

  /**
   * Body of {@link DprintLsp.format}, run under the queue.
   *
   * @param uri - `file://` URI of the document.
   * @param text - Document content.
   * @param range - Range to format, or `undefined` for the whole document.
   * @returns The formatted text, or `null` when there are no edits.
   */
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
      const whole = () =>
        this.request<TextEdit[] | null>("textDocument/formatting", {
          textDocument: { uri },
          options: FORMAT_OPTIONS,
        });
      const edits = range
        ? await this.request<TextEdit[] | null>(
          "textDocument/rangeFormatting",
          { textDocument: { uri }, range, options: FORMAT_OPTIONS },
        ).catch((e: unknown) => {
          if (!(e instanceof RpcError)) throw e;
          return whole(); // plugin without range support: one retry on the whole document
        })
        : await whole();
      return edits && edits.length > 0 ? applyTextEdits(text, edits) : null;
    } finally {
      this.notify("textDocument/didClose", { textDocument: { uri } });
    }
  }

  /**
   * Spawn and initialize the child unless it is already running.
   *
   * @returns Settles once the child answered `initialize`; rejects when dprint is missing or fails to start.
   */
  private start(): Promise<void> {
    if (this.ready) return this.ready;
    const bin = findDprint();
    if (!bin) return Promise.reject(new Error("dprint not found"));
    const child = spawn(bin, ["lsp"], { cwd: this.cwd, stdio: "pipe" });
    this.child = child;
    this.buf = Buffer.alloc(0);
    child.stdin.on("error", () => {}); // EPIPE after a crash; the crash itself surfaces via exit/error
    child.stderr.on("data", (d: Buffer) => process.stderr.write(d));
    child.stdout.on("data", (d: Buffer) => this.onData(d));
    const dead = (err: Error) => {
      if (this.child !== child) return;
      this.child = null;
      this.ready = null;
      this.failPending(err);
    };
    child.on("error", (e) => dead(e));
    child.on("exit", (code, signal) => dead(new Error(`dprint lsp exited (${code ?? signal})`)));
    const ready = this.request("initialize", {
      processId: process.pid,
      rootUri: pathToFileURL(this.cwd).href,
      capabilities: {},
    }).then(
      () => this.notify("initialized", {}),
      (e: unknown) => {
        if (this.child === child) this.dispose();
        throw e;
      },
    );
    this.ready = ready;
    return ready;
  }

  /**
   * Split stdout into Content-Length frames and dispatch each complete message.
   *
   * @param chunk - Bytes just read from the child's stdout.
   */
  private onData(chunk: Buffer): void {
    this.buf = Buffer.concat([this.buf, chunk]);
    for (;;) {
      const sep = this.buf.indexOf("\r\n\r\n");
      if (sep === -1) return;
      const len = /content-length:\s*(\d+)/i.exec(
        this.buf.subarray(0, sep).toString("ascii"),
      )?.[1];
      if (len === undefined) {
        this.broken();
        return;
      }
      const end = sep + 4 + Number(len);
      if (this.buf.length < end) return;
      const body = this.buf.subarray(sep + 4, end).toString("utf8");
      this.buf = this.buf.subarray(end);
      let msg: unknown;
      try {
        msg = JSON.parse(body);
      } catch {
        this.broken();
        return;
      }
      if (typeof msg === "object" && msg !== null) this.onMessage(msg);
    }
  }

  /**
   * Handle an unparseable frame: the stream is out of sync, so kill the child and let pending requests
   * reject now instead of timing out.
   */
  private broken(): void {
    this.buf = Buffer.alloc(0);
    this.dispose();
  }

  /**
   * Route one JSON-RPC message from the child.
   *
   * @param msg - Parsed message: a response settles its pending request, a server-to-client request is
   * answered with `null`, a notification is ignored.
   */
  private onMessage(msg: RpcMessage): void {
    if (msg.id === undefined || msg.id === null) return; // server notification
    if (msg.method !== undefined) {
      this.send({ jsonrpc: "2.0", id: msg.id, result: null }); // server->client request
      return;
    }
    if (typeof msg.id !== "number") return; // not one of ours: this client only sends numeric ids
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.error) {
      p.reject(
        new RpcError(
          typeof msg.error.message === "string"
            ? msg.error.message
            : "JSON-RPC error",
        ),
      );
    } else p.resolve(msg.result);
  }

  /**
   * Send a request and wait for its response.
   *
   * @typeParam T - Type of the response `result` (the LSP spec's result type for `method`; not checked).
   * @param method - JSON-RPC method.
   * @param params - Method parameters.
   * @returns The response `result`; rejects with {@link RpcError} on an error response, or with a plain
   * `Error` when the child is not running, dies or times out (a timeout also kills the child).
   */
  private request<T = unknown>(method: string, params: unknown): Promise<T> {
    if (!this.child) {
      return Promise.reject(new Error("dprint lsp is not running"));
    }
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`dprint lsp: ${method} timed out`));
        this.dispose(); // detach now, not on the async exit: the next queued format() must respawn
      }, REQUEST_TIMEOUT_MS);
      // the result is trusted to match T: dprint answers per the LSP spec for `method`
      this.pending.set(id, { resolve: (v) => resolve(v as T), reject, timer });
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  /**
   * Send a notification (no response expected).
   *
   * @param method - JSON-RPC method.
   * @param params - Method parameters.
   */
  private notify(method: string, params: unknown): void {
    this.send({ jsonrpc: "2.0", method, params });
  }

  /**
   * Write one Content-Length framed message to the child's stdin; a no-op when no child runs.
   *
   * @param msg - JSON-RPC message.
   */
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

/**
 * Apply LSP text edits to a document.
 *
 * @remarks
 * Positions past a line's end clamp to the line end (before a CRLF's `\r`); lines past the end clamp to the
 * document end. Edits starting at the same position are applied in array order.
 *
 * shortcut: positions assume `\n` or `\r\n` line breaks and UTF-16 offsets (LSP default); upgrade if dprint
 * ever negotiates `positionEncoding`.
 *
 * @param text - Original document.
 * @param edits - Non-overlapping edits against `text`, in any order.
 * @returns The edited document.
 */
export function applyTextEdits(text: string, edits: TextEdit[]): string {
  const starts = [0];
  for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) {
    starts.push(i + 1);
  }
  const offset = (p: { line: number; character: number }) => {
    if (p.line >= starts.length) return text.length;
    let lineEnd = p.line + 1 < starts.length ? starts[p.line + 1] - 1 : text.length;
    if (p.line + 1 < starts.length && text[lineEnd - 1] === "\r") lineEnd--; // CRLF: the line ends before the "\r"
    return Math.min(starts[p.line] + p.character, lineEnd); // LSP: past the line end means the line end
  };
  const spans = edits
    .map((e, i) => ({
      s: offset(e.range.start),
      e: offset(e.range.end),
      t: e.newText,
      i,
    }))
    .sort((x, y) => x.s - y.s || x.i - y.i); // same start: array order, so inserts land as listed
  const parts: string[] = [];
  let pos = 0;
  for (const { s, e, t } of spans) {
    parts.push(text.slice(pos, s), t);
    pos = e;
  }
  parts.push(text.slice(pos));
  return parts.join("");
}
