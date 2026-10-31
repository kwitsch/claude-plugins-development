// End-to-end tests: spawn the built plugin/mcp/server.mjs with an isolated PATH (bash + node + a stub
// `dprint`) and HOME; the stub speaks Content-Length JSON-RPC like `dprint lsp`.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const PLUGIN = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../plugin",
);
const SERVER = path.join(PLUGIN, "mcp/server.mjs");

// Stub `dprint lsp`: formatting and rangeFormatting answer one whole-document TextEdit with trailing
// spaces stripped and exactly one final newline. argv mode "range-error" fails rangeFormatting with a
// JSON-RPC error (exec-plugin case); "crash" exits at once.
const STUB_LSP = `
const MODE = process.argv[2] ?? "ok";
if (MODE === "crash") process.exit(1);
const docs = new Map();
let buf = Buffer.alloc(0);
const send = (msg) => {
  const body = Buffer.from(JSON.stringify(msg));
  process.stdout.write(Buffer.concat([Buffer.from("Content-Length: " + body.length + "\\r\\n\\r\\n"), body]));
};
const fmt = (t) => t.split("\\n").map((l) => l.replace(/[ \\t]+$/, "")).join("\\n").replace(/\\n*$/, "\\n");
process.stdin.on("data", (chunk) => {
  buf = Buffer.concat([buf, chunk]);
  for (;;) {
    const sep = buf.indexOf("\\r\\n\\r\\n");
    if (sep === -1) return;
    const len = Number(/Content-Length: (\\d+)/i.exec(buf.subarray(0, sep).toString())[1]);
    if (buf.length < sep + 4 + len) return;
    const msg = JSON.parse(buf.subarray(sep + 4, sep + 4 + len).toString());
    buf = buf.subarray(sep + 4 + len);
    const p = msg.params;
    if (msg.method === "initialize") {
      send({ jsonrpc: "2.0", id: msg.id, result: { capabilities: { documentFormattingProvider: true, documentRangeFormattingProvider: true } } });
    } else if (msg.method === "textDocument/didOpen") {
      docs.set(p.textDocument.uri, p.textDocument.text);
    } else if (msg.method === "textDocument/didClose") {
      docs.delete(p.textDocument.uri);
    } else if (msg.method === "textDocument/rangeFormatting" && MODE === "range-error") {
      send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "range formatting not supported" } });
    } else if (msg.method === "textDocument/formatting" || msg.method === "textDocument/rangeFormatting") {
      const text = docs.get(p.textDocument.uri);
      const end = { line: text.split("\\n").length, character: 0 };
      send({ jsonrpc: "2.0", id: msg.id, result: [{ range: { start: { line: 0, character: 0 }, end }, newText: fmt(text) }] });
    } else if (msg.id !== undefined) {
      send({ jsonrpc: "2.0", id: msg.id, result: null });
    }
  }
});
`;

let tmp, bin, home, repo;
const servers = [];

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), "dprint-mcp-test-"));
  bin = path.join(tmp, "bin");
  home = path.join(tmp, "home");
  repo = path.join(tmp, "repo");
  for (const d of [bin, home, repo]) mkdirSync(d);
  // a stray config above os.tmpdir() must not leak into the tests: the search stops at a .git
  mkdirSync(path.join(tmp, ".git"));
  for (const t of ["bash", "node"]) {
    const src = spawnSync("sh", ["-c", `command -v ${t}`], {
      encoding: "utf8",
    }).stdout.trim();
    if (src) symlinkSync(src, path.join(bin, t));
  }
  writeFileSync(path.join(tmp, "stub-lsp.mjs"), STUB_LSP);
  // format_pre only formats when the cwd holds a dprint config
  writeFileSync(path.join(repo, "dprint.json"), "{}");
});

afterEach(() => {
  while (servers.length) servers.pop().kill();
});

/**
 * (Re)write bin/dprint as a bash wrapper around the stub in the given mode. `listCmd` is the file-list
 * subcommand this dprint knows: it prints `$PWD/a.ts` and a path outside the cwd; any other `*file-paths`
 * subcommand fails like dprint does for an unknown subcommand (exit 10).
 */
function stubDprint(mode = "ok", listCmd = "file-paths") {
  const f = path.join(bin, "dprint");
  writeFileSync(
    f,
    [
      "#!/usr/bin/env bash",
      `if [ "$1" = "${listCmd}" ]; then printf '%s\\n' "$PWD/a.ts" /nonexistent-outside/b.ts; exit 0; fi`,
      `case "$1" in *file-paths) echo "error: unrecognized subcommand '$1'" >&2; exit 10;; esac`,
      `exec node "${path.join(tmp, "stub-lsp.mjs")}" ${mode}`,
      "",
    ].join("\n"),
  );
  chmodSync(f, 0o755);
}

/** Spawn the built server; `opts.cwd` sets its process cwd (default: the test's). */
function startServer(opts = {}) {
  const child = spawn(path.join(bin, "node"), [SERVER], {
    cwd: opts.cwd,
    env: { PATH: bin, HOME: home },
    stdio: ["pipe", "pipe", "pipe"],
  });
  servers.push(child);
  child.stderr.resume();
  const waiting = new Map();
  createInterface({ input: child.stdout }).on("line", (line) => {
    const msg = JSON.parse(line); // throws (fails the run) if stdout carries anything but JSON-RPC
    waiting.get(msg.id)?.(msg);
    waiting.delete(msg.id);
  });
  let nextId = 0;
  const rpc = (method, params) =>
    new Promise((resolve) => {
      const id = ++nextId;
      waiting.set(id, resolve);
      child.stdin.write(
        JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n",
      );
    });
  const tool = async (name, args) =>
    (await rpc("tools/call", { name, arguments: args })).result
      .structuredContent;
  const call = (args) => tool("format_pre", args);
  return { rpc, call, tool };
}

const lines = (n) => Array.from({ length: n }, (_, i) => `l${i}`);
const count = (hay, needle) => hay.split(needle).length - 1;

test("server.mjs is an executable node script", () => {
  assert.ok(readFileSync(SERVER, "utf8").startsWith("#!/usr/bin/env node"));
  assert.ok(statSync(SERVER).mode & 0o100);
});

test("initialize reports dprint-hooks with the manifest version; tools/list has exactly the hook tools", async () => {
  const s = startServer();
  const init = await s.rpc("initialize", {
    protocolVersion: "2025-11-25",
    capabilities: {},
    clientInfo: { name: "test", version: "0" },
  });
  const manifest = JSON.parse(
    readFileSync(path.join(PLUGIN, ".claude-plugin/plugin.json"), "utf8"),
  );
  assert.deepEqual(init.result.serverInfo, {
    name: "dprint-hooks",
    version: manifest.version,
  });
  const list = await s.rpc("tools/list", {});
  assert.deepEqual(
    list.result.tools.map((t) => t.name),
    [
      "format_pre",
      "cwd_changed",
      "worktree_entered",
      "worktree_exited",
      "file_written",
      "file_changed",
    ],
  );
});

test("excluded and out-of-root paths are never formatted", async () => {
  stubDprint();
  const s = startServer();
  for (const file of [
    path.join(repo, "node_modules/x.ts"),
    path.join(repo, "settings.local.json"),
    path.join(repo, ".claude/worktrees/w/x.ts"),
    path.join(tmp, "outside.ts"),
  ])
    assert.deepEqual(
      await s.call({
        cwd: repo,
        tool_name: "Write",
        tool_input: { file_path: file, content: "x   \n" },
      }),
      {},
      file,
    );
});

test("cwd_changed / worktree_entered re-root later format_pre calls for that session", async () => {
  stubDprint();
  const s = startServer();
  const other = path.join(tmp, "other");
  const third = path.join(tmp, "third");
  for (const d of [other, third]) {
    mkdirSync(d);
    writeFileSync(path.join(d, "dprint.json"), "{}");
  }
  const write = (dir) =>
    s.call({
      cwd: repo,
      session_id: "s1",
      tool_name: "Write",
      tool_input: { file_path: path.join(dir, "a.ts"), content: "x   \n" },
    });
  assert.deepEqual(await write(other), {}); // outside the hook cwd
  await s.rpc("tools/call", {
    name: "cwd_changed",
    arguments: { session_id: "s1", new_cwd: other },
  });
  assert.equal(
    (await write(other)).hookSpecificOutput.updatedInput.content,
    "x\n",
  );
  await s.rpc("tools/call", {
    name: "worktree_entered",
    arguments: { session_id: "s1", tool_response: { worktreePath: third } },
  });
  assert.equal(
    (await write(third)).hookSpecificOutput.updatedInput.content,
    "x\n",
  );
  await s.rpc("tools/call", {
    name: "worktree_exited",
    arguments: { session_id: "s1", tool_response: { restoredCwd: other } },
  });
  assert.deepEqual(await write(third), {}); // back outside the cwd
  assert.equal(
    (await write(other)).hookSpecificOutput.updatedInput.content,
    "x\n",
  );
  // an ExitWorktree response without restoredCwd drops the override: the payload cwd applies again
  await s.rpc("tools/call", {
    name: "worktree_exited",
    arguments: { session_id: "s1", tool_response: { restoredCwd: "" } },
  });
  assert.deepEqual(await write(other), {});
  assert.equal(
    (await write(repo)).hookSpecificOutput.updatedInput.content,
    "x\n",
  );
});

test("Write with trailing spaces -> updatedInput.content stripped + notice", async () => {
  stubDprint();
  const s = startServer();
  const file = path.join(repo, "a.ts");
  const out = await s.call({
    cwd: repo,
    tool_name: "Write",
    tool_input: { file_path: file, content: "const a = 1;   \nlet b = 2;\n" },
  });
  assert.equal(out.hookSpecificOutput.hookEventName, "PreToolUse");
  assert.deepEqual(out.hookSpecificOutput.updatedInput, {
    file_path: file,
    content: "const a = 1;\nlet b = 2;\n",
  });
  assert.match(
    out.hookSpecificOutput.additionalContext,
    /^dprint: reformatted /,
  );
  assert.equal(out.hookSpecificOutput.permissionDecision, undefined);
});

test("Edit on a CRLF file: old_string/new_string come back LF-only (Claude Code's Edit matches the LF view)", async () => {
  stubDprint();
  const s = startServer();
  const file = path.join(repo, "crlf.ts");
  writeFileSync(file, lines(10).join("\r\n") + "\r\n");
  const out = await s.call({
    cwd: repo,
    tool_name: "Edit",
    tool_input: { file_path: file, old_string: "l5", new_string: "l5 x   " },
  });
  assert.deepEqual(out.hookSpecificOutput.updatedInput, {
    file_path: file,
    old_string: "l5\n",
    new_string: "l5 x\n",
    replace_all: false,
  });
});

test("Edit: only the edited line region comes back, occurring once in the file", async () => {
  stubDprint();
  const s = startServer();
  const file = path.join(repo, "b.ts");
  const O = lines(10).join("\n") + "\n";
  writeFileSync(file, O);
  const out = await s.call({
    cwd: repo,
    tool_name: "Edit",
    tool_input: {
      file_path: file,
      old_string: "l5",
      new_string: "l5 x   ",
      replace_all: "false",
    },
  });
  assert.deepEqual(out.hookSpecificOutput.updatedInput, {
    file_path: file,
    old_string: "l5\n",
    new_string: "l5 x\n",
    replace_all: false,
  });
  assert.equal(count(O, "l5\n"), 1);
});

test("Edit: whole-file reformat by the stub -> far hunks dropped", async () => {
  stubDprint();
  const s = startServer();
  const file = path.join(repo, "c.ts");
  const L = lines(30);
  L[1] = "l1   ";
  const O = L.join("\n") + "\n";
  writeFileSync(file, O);
  const out = await s.call({
    cwd: repo,
    tool_name: "Edit",
    tool_input: { file_path: file, old_string: "l25", new_string: "l25 x  " },
  });
  const u = out.hookSpecificOutput.updatedInput;
  assert.deepEqual(u, {
    file_path: file,
    old_string: "l25\n",
    new_string: "l25 x\n",
    replace_all: false,
  });
  assert.ok(O.replace(u.old_string, () => u.new_string).includes("l1   \n"));
});

test("rangeFormatting JSON-RPC error -> formatted via whole-file fallback", async () => {
  stubDprint("range-error");
  const s = startServer();
  const file = path.join(repo, "d.ts");
  writeFileSync(file, lines(10).join("\n") + "\n");
  const out = await s.call({
    cwd: repo,
    tool_name: "Edit",
    tool_input: { file_path: file, old_string: "l5", new_string: "l5 x   " },
  });
  assert.deepEqual(out.hookSpecificOutput.updatedInput, {
    file_path: file,
    old_string: "l5\n",
    new_string: "l5 x\n",
    replace_all: false,
  });
});

test("Edit whose trim would drop the deleted repeated line -> {} (never loses the edit)", async () => {
  stubDprint("range-error");
  const s = startServer();
  const file = path.join(repo, "g.ts");
  writeFileSync(file, "a=1  \nx\nx\nx\nb=2  \n");
  // the line diff aligns the deleted "x" next to "b=2", a hunk not touching the edit, so the trim drops it
  const out = await s.call({
    cwd: repo,
    tool_name: "Edit",
    tool_input: {
      file_path: file,
      old_string: "a=1  \nx\n",
      new_string: "a=1  \n",
    },
  });
  assert.deepEqual(out, {});
});

test("cwd without any dprint config -> Write returns {} and no dprint lsp is spawned", async () => {
  // a dprint that would format, but logs every spawn
  const log = path.join(tmp, "spawned.log");
  const f = path.join(bin, "dprint");
  writeFileSync(
    f,
    `#!/usr/bin/env bash\necho spawned >> "${log}"\nexec node "${path.join(tmp, "stub-lsp.mjs")}" ok\n`,
  );
  chmodSync(f, 0o755);
  const bare = path.join(tmp, "bare");
  mkdirSync(bare);
  const s = startServer();
  const out = await s.call({
    cwd: bare,
    tool_name: "Write",
    tool_input: { file_path: path.join(bare, "a.ts"), content: "x   \n" },
  });
  assert.deepEqual(out, {});
  assert.equal(existsSync(log), false);
  // same server, cwd with a config: the logging stub is spawned and formats
  const ok = await s.call({
    cwd: repo,
    tool_name: "Write",
    tool_input: { file_path: path.join(repo, "a.ts"), content: "x   \n" },
  });
  assert.equal(ok.hookSpecificOutput.updatedInput.content, "x\n");
  assert.equal(existsSync(log), true);
});

test("only .config/dprint.jsonc in the cwd -> the Write is formatted", async () => {
  stubDprint();
  const dir = path.join(tmp, "dotconfig");
  mkdirSync(path.join(dir, ".config"), { recursive: true });
  writeFileSync(path.join(dir, ".config/dprint.jsonc"), "{}");
  const s = startServer();
  const out = await s.call({
    cwd: dir,
    tool_name: "Write",
    tool_input: { file_path: path.join(dir, "a.ts"), content: "x   \n" },
  });
  assert.equal(out.hookSpecificOutput.updatedInput.content, "x\n");
});

test("a dprint config only in an ancestor of the cwd -> the Write is formatted", async () => {
  stubDprint();
  const sub = path.join(repo, "packages", "foo");
  mkdirSync(sub, { recursive: true });
  const s = startServer();
  const out = await s.call({
    cwd: sub,
    tool_name: "Write",
    tool_input: { file_path: path.join(sub, "a.ts"), content: "x   \n" },
  });
  assert.equal(out.hookSpecificOutput.updatedInput.content, "x\n");
});

test("the config search stops at the git repo root and at a worktree root", async () => {
  stubDprint();
  const s = startServer();
  const write = (cwd) =>
    s.call({
      cwd,
      tool_name: "Write",
      tool_input: { file_path: path.join(cwd, "a.ts"), content: "x   \n" },
    });
  // config above the repo root is ignored; a config at the repo root counts
  const outer = path.join(tmp, "outer");
  const repoRoot = path.join(outer, "repo");
  const sub = path.join(repoRoot, "pkg", "foo");
  mkdirSync(sub, { recursive: true });
  mkdirSync(path.join(repoRoot, ".git"));
  writeFileSync(path.join(outer, "dprint.json"), "{}");
  assert.deepEqual(await write(sub), {});
  writeFileSync(path.join(repoRoot, "dprint.json"), "{}");
  assert.equal((await write(sub)).hookSpecificOutput.updatedInput.content, "x\n");
  // a worktree (".git" is a file) is its own root: the main checkout's config does not reach into it
  const wt = path.join(repoRoot, "wt");
  mkdirSync(path.join(wt, "src"), { recursive: true });
  writeFileSync(path.join(wt, ".git"), "gitdir: elsewhere\n");
  assert.deepEqual(await write(path.join(wt, "src")), {});
  writeFileSync(path.join(wt, "dprint.json"), "{}");
  assert.equal(
    (await write(path.join(wt, "src"))).hookSpecificOutput.updatedInput.content,
    "x\n",
  );
});

test("the config gate follows cwd_changed: config-less dir -> {}, back in the config dir -> formatted", async () => {
  stubDprint();
  const bare = path.join(tmp, "bare");
  mkdirSync(bare);
  const s = startServer();
  const write = (dir) =>
    s.call({
      cwd: repo,
      session_id: "s1",
      tool_name: "Write",
      tool_input: { file_path: path.join(dir, "a.ts"), content: "x   \n" },
    });
  const cd = (dir) =>
    s.rpc("tools/call", {
      name: "cwd_changed",
      arguments: { session_id: "s1", new_cwd: dir },
    });
  await cd(bare);
  assert.deepEqual(await write(bare), {});
  await cd(repo);
  assert.equal(
    (await write(repo)).hookSpecificOutput.updatedInput.content,
    "x\n",
  );
});

test("no dprint on PATH or in ~/.dprint/bin -> {}", async () => {
  const s = startServer();
  const out = await s.call({
    cwd: repo,
    tool_name: "Write",
    tool_input: { file_path: path.join(repo, "e.ts"), content: "x   \n" },
  });
  assert.deepEqual(out, {});
});

test("crashing dprint -> {}, then a working dprint is respawned -> formatted", async () => {
  stubDprint("crash");
  const s = startServer();
  const args = {
    cwd: repo,
    tool_name: "Write",
    tool_input: { file_path: path.join(repo, "f.ts"), content: "x   \n" },
  };
  assert.deepEqual(await s.call(args), {});
  stubDprint();
  const out = await s.call(args);
  assert.equal(out.hookSpecificOutput.updatedInput.content, "x\n");
});

test(".mcp.json key matches every hooks.json server id and each hook tool is listed", async () => {
  const mcp = JSON.parse(readFileSync(path.join(PLUGIN, ".mcp.json"), "utf8"));
  const hooks = JSON.parse(
    readFileSync(path.join(PLUGIN, "hooks/hooks.json"), "utf8"),
  );
  const keys = Object.keys(mcp.mcpServers);
  assert.deepEqual(keys, ["dprint-hooks"]);
  const s = startServer();
  await s.rpc("initialize", {
    protocolVersion: "2025-11-25",
    capabilities: {},
  });
  const tools = (await s.rpc("tools/list", {})).result.tools.map((t) => t.name);
  const entries = Object.values(hooks.hooks)
    .flat()
    .flatMap((m) => m.hooks);
  assert.ok(entries.length > 0);
  for (const e of entries) {
    if (e.type === "command") {
      assert.match(e.command, /mcp\/watch-paths\.mjs/);
      continue;
    }
    assert.equal(e.type, "mcp_tool");
    assert.equal(e.server, `plugin:dprint:${keys[0]}`);
    assert.ok(tools.includes(e.tool), e.tool);
  }
  assert.ok(existsSync(path.join(PLUGIN, "mcp/watch-paths.mjs")));
  assert.equal(hooks.hooks.SessionStart[0].hooks[0].type, "command");
  assert.equal(hooks.hooks.CwdChanged[0].hooks[1].type, "command");
});

test("format_pre formats only files whose real path is inside the cwd and outside the scratchpad", async () => {
  stubDprint();
  const s = startServer();
  const other = path.join(tmp, "other");
  mkdirSync(other);
  const write = (file, extra = {}) =>
    s.call({
      cwd: repo,
      ...extra,
      tool_name: "Write",
      tool_input: { file_path: file, content: "x   \n" },
    });
  // positive control: a plain file in the cwd is formatted
  assert.equal(
    (await write(path.join(repo, "a.ts"))).hookSpecificOutput.updatedInput
      .content,
    "x\n",
  );
  // a file in another directory
  assert.deepEqual(await write(path.join(other, "a.ts")), {});
  // a symlink inside the cwd to a file elsewhere: Write and Edit
  writeFileSync(path.join(other, "t.ts"), "l0\nl1\n");
  symlinkSync(path.join(other, "t.ts"), path.join(repo, "link.ts"));
  assert.deepEqual(await write(path.join(repo, "link.ts")), {});
  assert.deepEqual(
    await s.call({
      cwd: repo,
      tool_name: "Edit",
      tool_input: {
        file_path: path.join(repo, "link.ts"),
        old_string: "l1",
        new_string: "l1 x   ",
      },
    }),
    {},
  );
  // a dangling symlink inside the cwd
  symlinkSync(path.join(other, "missing.ts"), path.join(repo, "dl.ts"));
  assert.deepEqual(await write(path.join(repo, "dl.ts")), {});
  // the session scratchpad inside the cwd is skipped, the rest of the cwd is not
  const scratch = path.join(repo, "scratch");
  mkdirSync(scratch);
  assert.deepEqual(
    await write(path.join(scratch, "a.ts"), { scratchpad_dir: scratch }),
    {},
  );
  assert.equal(
    (await write(path.join(repo, "b.ts"), { scratchpad_dir: scratch }))
      .hookSpecificOutput.updatedInput.content,
    "x\n",
  );
});

test("format_pre without a cwd skips instead of using the server's own cwd", async () => {
  stubDprint();
  const s = startServer({ cwd: repo });
  const args = {
    tool_name: "Write",
    tool_input: { file_path: path.join(repo, "a.ts"), content: "x   \n" },
  };
  assert.deepEqual(await s.call(args), {});
  assert.equal(
    (await s.call({ ...args, cwd: repo })).hookSpecificOutput.updatedInput
      .content,
    "x\n",
  );
});

test("file_changed formats an in-cwd file on disk (CRLF files keep CRLF); unlink, outside and lone-CR files are left alone", async () => {
  stubDprint();
  const s = startServer();
  const changedEv = (file, event = "change") =>
    s.tool("file_changed", { cwd: repo, file_path: file, event });
  // git is not on the stub PATH: the git guard fails open and the file is formatted
  const a = path.join(repo, "a.ts");
  writeFileSync(a, "x  \n");
  assert.deepEqual(await changedEv(a), {});
  assert.equal(readFileSync(a, "utf8"), "x\n");
  const added = path.join(repo, "added.ts");
  writeFileSync(added, "z  \n");
  assert.deepEqual(await changedEv(added, "add"), {});
  assert.equal(readFileSync(added, "utf8"), "z\n");
  const u = path.join(repo, "u.ts");
  writeFileSync(u, "x  \n");
  assert.deepEqual(await changedEv(u, "unlink"), {});
  assert.equal(readFileSync(u, "utf8"), "x  \n");
  const outside = path.join(tmp, "outside.ts");
  writeFileSync(outside, "x  \n");
  assert.deepEqual(await changedEv(outside), {});
  assert.equal(readFileSync(outside, "utf8"), "x  \n");
  const crlf = path.join(repo, "crlf.ts");
  writeFileSync(crlf, "x  \r\ny  \r\n");
  assert.deepEqual(await changedEv(crlf), {});
  assert.equal(readFileSync(crlf, "utf8"), "x\r\ny\r\n");
  const cr = path.join(repo, "cr.ts");
  writeFileSync(cr, "x  \ry  \r");
  assert.deepEqual(await changedEv(cr), {});
  assert.equal(readFileSync(cr, "utf8"), "x  \ry  \r");
});

test("file_written records the Edit/Write result: file_changed leaves it alone, also on repeated events", async () => {
  stubDprint();
  const s = startServer();
  const b = path.join(repo, "b.ts");
  writeFileSync(b, "x  \n");
  assert.deepEqual(
    await s.tool("file_written", { cwd: repo, tool_input: { file_path: b } }),
    {},
  );
  for (let i = 0; i < 2; i++) {
    assert.deepEqual(
      await s.tool("file_changed", { cwd: repo, file_path: b, event: "change" }),
      {},
    );
  }
  assert.equal(readFileSync(b, "utf8"), "x  \n");
  // positive control: a later change by another tool is formatted
  writeFileSync(b, "y  \n");
  await s.tool("file_changed", { cwd: repo, file_path: b, event: "change" });
  assert.equal(readFileSync(b, "utf8"), "y\n");
});

test("file_changed leaves a file alone that is unchanged against the git index", async (t) => {
  const git = spawnSync("which", ["git"], { encoding: "utf8" }).stdout?.trim();
  if (!git) return t.skip("git not on PATH");
  symlinkSync(git, path.join(bin, "git"));
  stubDprint();
  const g = (...args) => {
    const r = spawnSync(
      git,
      [
        "-c",
        "user.name=t",
        "-c",
        "user.email=t@t",
        "-c",
        "commit.gpgsign=false",
        ...args,
      ],
      { cwd: repo, encoding: "utf8" },
    );
    assert.equal(r.status, 0, r.stderr);
  };
  const c = path.join(repo, "c.ts");
  writeFileSync(c, "x  \n");
  g("init", "-q");
  g("add", "c.ts");
  g("commit", "-qm", "c");
  const s = startServer();
  const ev = { cwd: repo, file_path: c, event: "change" };
  assert.deepEqual(await s.tool("file_changed", ev), {});
  assert.equal(readFileSync(c, "utf8"), "x  \n");
  writeFileSync(c, "y  \n");
  assert.deepEqual(await s.tool("file_changed", ev), {});
  assert.equal(readFileSync(c, "utf8"), "y\n");
  // a gitignored file prints nothing in plain `git status --porcelain`, but is formatted like Write/Edit would
  writeFileSync(path.join(repo, ".gitignore"), "ignored.ts\n");
  const ig = path.join(repo, "ignored.ts");
  writeFileSync(ig, "z  \n");
  assert.deepEqual(await s.tool("file_changed", { ...ev, file_path: ig }), {});
  assert.equal(readFileSync(ig, "utf8"), "z\n");
});

const WATCH = path.join(PLUGIN, "mcp/watch-paths.mjs");
/** Run watch-paths.mjs like Claude Code's command hook: event JSON on stdin, stub PATH. */
const watch = (input) =>
  spawnSync(process.execPath, [WATCH], {
    env: { PATH: bin, HOME: home },
    input: JSON.stringify(input),
    encoding: "utf8",
  });

test("watch-paths.mjs prints the in-cwd dprint file paths as watchPaths on SessionStart and CwdChanged", () => {
  stubDprint();
  const start = watch({ hook_event_name: "SessionStart", cwd: repo });
  assert.equal(start.status, 0, start.stderr);
  assert.deepEqual(JSON.parse(start.stdout), {
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      watchPaths: [path.join(repo, "a.ts")],
    },
  });
  const cd = watch({
    hook_event_name: "CwdChanged",
    cwd: path.join(tmp, "other"),
    new_cwd: repo,
  });
  assert.equal(cd.status, 0, cd.stderr);
  assert.deepEqual(JSON.parse(cd.stdout), {
    hookSpecificOutput: {
      hookEventName: "CwdChanged",
      watchPaths: [path.join(repo, "a.ts")],
    },
  });
});

test("watch-paths.mjs prints nothing for a cwd without a dprint config", () => {
  stubDprint();
  const bare = path.join(tmp, "bare");
  mkdirSync(bare);
  const r = watch({ hook_event_name: "SessionStart", cwd: bare });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, "");
});

test("watch-paths.mjs falls back to output-file-paths on dprint 0.50-0.54", () => {
  stubDprint("ok", "output-file-paths");
  const r = watch({ hook_event_name: "SessionStart", cwd: repo });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), {
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      watchPaths: [path.join(repo, "a.ts")],
    },
  });
});
