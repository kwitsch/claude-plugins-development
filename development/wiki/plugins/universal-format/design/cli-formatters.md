# CLI formatters on stdin

How Kotlin, Python, Go and Rust are formatted before the write, which output is trusted, and what each tool's stdin mode does and does not honor.

- `REGISTRY` (`registry.ts`) holds a chain per language; the first tool on PATH that has no hard style conflict wins: `ktlint` then `ktfmt`, `ruff` then `black`, `goimports` then `gofmt`, `rustfmt`. One pass, no package runner.
- Each tool gets the would-be content on stdin and its stdout is what gets written. `stdinArgs(file)` is the argv tail that switches the tool into that mode and names the real path, so `pyproject.toml`/`.ruff.toml`, `.editorconfig` and the Go module resolve as for the file on disk:
  - `ruff format --quiet [mapped flags] --stdin-filename <file> -`
  - `black --quiet [mapped flags] --stdin-filename <file> -`
  - `ktlint --format --log-level=none --stdin --stdin-path <file>`
  - `ktfmt --enable-editorconfig --quiet --stdin-name=<file> -`
  - `goimports -srcdir <file>` (`-srcdir` "may instead be the complete file name"), `gofmt`
  - `rustfmt [mapped flags] [--edition <year>]`
- stdout is trusted only when the exit code is in the tool's `okExit` (default `[0]`; ktlint `[0, 1]`: 1 means "reformatted, violations it cannot fix remain") and stdout is not empty. Neither alone is enough: black's exit 123 echoes the unformatted input, ktlint reports a syntax error with exit 0 and empty stdout. Anything else answers `{}`.
- Verified against the real tools (2026-10-19, former repository): ruff 0.17.1, black 26.10.1, gofmt go1.22.2, goimports x/tools 0.52.0, rustfmt 1.9.0, ktlint 1.8.0, ktfmt 0.64 and 0.65. The tests here run stubs only.
- Known edges of the tools:
  - ktfmt honors `.editorconfig` for stdin (through `--stdin-name`) only from 0.65 on; 0.64 formats with its default style;
  - ktlint, gofmt, goimports and rustfmt normalise CRLF to LF on stdin; ruff, black and ktfmt keep it;
  - rustfmt parses stdin as Rust 2015 unless told otherwise and then rejects `async fn`; `cargoEdition` passes the `edition` of the nearest `Cargo.toml` that states one, up to the base (a crate with `edition.workspace = true` has no literal, so the walk goes on to the workspace root), as `cargo fmt` does.
- rustfmt has no path flag for stdin and finds `rustfmt.toml` by walking up from its cwd, so it is spawned in the file's own directory (`spawnCwd: "fileDir"`); every other tool runs in the base.
- `.editorconfig` mapping (`editorconfig.ts`), only for a `mapped` tool and only when no tool-native config governs the file (ruff: `.ruff.toml`, `ruff.toml`, `[tool.ruff]` in `pyproject.toml`; black: `[tool.black]`; rustfmt: `rustfmt.toml`, `.rustfmt.toml`): `max_line_length`, `indent_style` and `indent_size` become flags. Both walks are bounded by the base: these tools only look inside the project tree.
  - ruff's `indent-width` is a top-level setting; `format.indent-width` is rejected (exit 2, no output; found against ruff 0.17.1).
  - black is fixed at four spaces: an `.editorconfig` asking for tabs skips black (the file stays as it is) instead of formatting against the project's own config.
  - The glob matcher supports `*`, `**`, `?` and `{a,b}` on the base name only; any other form never matches (no mapping rather than a wrong one).
- `runStdinFormatter` spawns asynchronously, never `spawnSync`: the server serves concurrent hook calls. It kills the tool after 30 s (`SPAWN_TIMEOUT_MS`; the hook's `timeout: 60` is the backstop) and resolves at once, because `close` waits for the pipes, which a surviving grandchild can hold open. Spawn errors, EPIPE on stdin (the tool gave up early) and crashes resolve `null`.

## PATH

- `onPath` caches per tool name for the life of the process whether a PATH directory holds the executable.
- At the first lookup `~/.local/bin` is appended to the server's PATH (and so to the PATH its children inherit). Reason: user-level installs live there, and the PATH of the Claude Code process need not hold that directory. Appended, so a tool on the inherited PATH wins and a stale user-level binary cannot shadow a system tool (tested both ways). Until 0.18.0 the launcher script did this (and appended `~/.bun/bin` for the bun runtime, which is gone).
