---
paths:
  - "*/src/**"
  - "*/tests/**"
---

# Rule: porting shell scripts and CLI glue to Node

Learned in the graphmind-helper bug hunt (a port of three setup hook scripts to a function-hooks module and an MCP wrapper). Every point was a real, reproduced defect.

## Regex semantics differ from grep

- `grep` matches per line: a JS pattern with `^` or `$` that ports a grep pattern needs the `m` flag, or it only sees the first line of a multi-line command or prompt. Pin the flag with a test whose match sits on a later line.
- `grep -oE` is POSIX leftmost-longest; JS alternation is leftmost-first. Order alternatives longest-first (a dotted `a.bC` before a camelCase `aB`) and test the overlapping inputs.
- grep runs a DFA; a JS `a.*b` or `\w+(\.\w+)*` backtracks from every start position, quadratic on a long line. A synchronous regex inside `prompt.submit` or a tool hook freezes the whole session. Bound the input (drop runs over a sane length) or pin the prefix with an atomic-group emulation `^(?=(?<x>.*?a))\k<x>.*b`, and add a timing test on a 100 KB input.

## Lookups the shell did for you

- `command -v` skips directories and non-executable files; a hand-written PATH walk must too (`accessSync(p, X_OK)` and `statSync(p).isFile()`). Skip relative PATH entries, and do not strip a PATH entry of `/` to `""` (that makes the binary path relative to the cwd).
- `$(git rev-parse ...)` drops all trailing newlines; splitting multi-value git output on `\n` breaks on a path that holds a newline. Ask git for one value per call and cut only its final newline.
- `process.cwd()` mangles a folder name that is not valid UTF-8, and spawning with that string as `cwd` fails with ENOENT. Omit the `cwd` option so the child inherits the real directory.
- Compare real paths on both sides (`realpathSync` of the cwd and of `HOME`): a symlinked `HOME` never equals a real cwd, so a "not in `$HOME`" guard silently stops working.

## Claude Code's own files

- `CLAUDE_CONFIG_DIR`, when set, replaces `~/.claude` for `settings.json` and moves `.claude.json` to `$CLAUDE_CONFIG_DIR/.claude.json`. Read both through one resolver; a hard-coded `~/.claude*` path reads the wrong file.
- `.claude.json`'s `projects` entry for a session is looked up under one key, the canonical git root: a linked worktree's main checkout root, the common git dir itself for a bare or `--separate-git-dir` repo, outside git the real cwd. Ancestors' entries are not loaded. A server listed in that entry's `disabledMcpServers` does not start, so it cannot stand in for another.
- A check of "is server X configured" must run before any step of yours that adds X (an external `init` that calls `claude mcp add`), or it sees its own write.

## Output budgets and dedupe

- Each hook output has its own character budget; merging two outputs the original sent separately (briefing and recall) under one budget silently drops the second.
- Cut text by code point, not UTF-16 unit: a cut inside a surrogate pair leaves a lone surrogate that breaks the JSON sent to the API.
- "Already shown" bookkeeping must follow what actually went out: a line counts as shown when it ends inside the cut (even if only its newline was cut), never when the whole block was cut. A notice without an entry id ("No ... found.") must not enter a block that is re-offered until its id is marked shown.
- Entry ids are parsed at their fixed position (line start after markers), not anywhere in the line: a summary or a date can hold the same pattern.
