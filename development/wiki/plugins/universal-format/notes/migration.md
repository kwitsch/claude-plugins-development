# Migration into this repository (0.19.0)

What changed when universal-format moved from kwitsch/claude-plugins (`plugins/universal-format`, `src/universal-format-mcp`, `test/universal-format`) into this repository, how the tests were carried over, and the live check.

## Base

- The unreleased 0.19.0 work of the branch `perf/universal-format-single-hook-event` (commit `0cc87a4`: one PreToolUse hook, CLI formatters on stdin, lazy plugins), plus the dprint gate of `main` there (PR 282, 0.18.0), re-applied onto the one-hook handler. 0.19.0 is the first release from this repository; the tag did not exist in either repository (checked 2026-11-17).
- User decisions of 2026-11-17: the vendored-bundle exception with `pluginBuild.assets`, rolldown instead of bun, node only without the launcher ([vendor-build.md](../design/vendor-build.md)).

## What changed in behaviour

- The server is dual-era, hides its tool from the model, answers `initialize` with its own protocol version and honors `notifications/cancelled` (kills a running CLI formatter).
- `.mcp.json` starts `node` directly; `~/.local/bin` is appended to PATH inside the server at the first formatter lookup; `~/.bun/bin` is no longer appended.
- No compile cache, no signal handlers, no runtime name in the startup line.
- Fixed in the code-review round of the migration PR, each reproduced against the build before the fix and covered by a test:
  - a landed `.prettierignore` write re-reads the ignore state of the file's own directory, not of the writer's base (a session rooted above wrote `pkg/.prettierignore`, a session rooted in `pkg` kept formatting the ignored file);
  - a CLI formatter is spawned in the nearest existing directory (a Write into a directory it creates made the spawn fail, so the file landed unformatted; seen with rustfmt, which runs in the file's directory);
  - the JSON/YAML printWidth guard no longer overrides a width prettier itself resolved (an `.editorconfig` section such as `[**/*.json]`, which the own resolver does not match);
  - the cwd is normalised with `path.resolve` (with a trailing separator the config walks bounded by the base ran to the filesystem root);
  - the dprint gate counts an enabled `dprint@<marketplace>` although another marketplace's copy is disabled in the same settings file;
  - the skill driver exits 2 for an unreadable list file instead of crashing with exit 1;
  - the README no longer claims `end_of_line` is mapped for ruff and black;
  - the notice of the no-op Edit says what the Edit tool answers ([hook-design.md](../design/hook-design.md), "Edit").
- Everything else is the handler logic of the base, ported with its types made explicit.

## Tests: 221 before, 210 after

- Before: 107 bats cases and 101 `node:test` cases on the base branch (100 `test()` call sites, one inside a loop over two signals), plus the 13 cases of `dprint-gate.test.mjs` on `main`.
- After: 210 vitest cases in 12 files, all against the built `plugin/`: `languages` 66, `prettier` 35, `registry` 23, `manifest` 17, `dprint-gate` 16, `editorconfig` 12, `handlers` 9, `mcp-server` 9, `skill` 8, `bundled-plugins` 7, `build` 5, `cli-stdin` 3. 205 came with the port, 5 with the fixes of the code-review round.
- Carried over one to one: the `node:test` files `prettier`, `registry`, `editorconfig`, `handlers`, `cli-stdin`, `bundled-plugins` (88 cases), and the 13 gate cases (the two that used `format_post` now go through `format_pre`).
- The 59 cases of the 16 language bats files and `core.bats` are 60 cases in `languages.test.ts` (55 table rows, 5 own tests; the two-step `.prettierignore` case became two rows). Every formatted row now also checks the event name, the absent `permissionDecision`, the returned `file_path` and that the hook wrote nothing.
- New (13): PATH append for `~/.local/bin` (2), `replace_all` as a string (1), the description rule (1), both protocol eras, error answers, notifications and cancellation (7), the config-name comparison with dprint and `CLAUDE_CONFIG_DIR` (2).
- Dropped without a replacement (16):
  - `scaffold.bats`: registration in `marketplace.json`, the root README row, the `test.yml` matrix entry (all three live in the marketplace repository or are replaced by the `claudePlugin` marker); the three launcher cases (executable, PATH form and exit 64, `NODE_COMPILE_CACHE`); "src holds the sources and the build driver" (the build and the layout check enforce the layout); the fingerprint banner; the two doc-pin cases on `CLAUDE.md` files (the documents were split into rules and these pages, `wiki-check.ts` checks their links);
  - `build-artifact.test.mjs`: banner, `src=` hash, `body=` hash (CI rebuilds and compares instead), no-`Bun.` token (no bun target);
  - `runtime-detect.test.mjs`: exit 0 on SIGINT and on SIGTERM (the handlers went with the compile cache).
- Merged into another case (the rest of the difference): the three README-heading cases, the three "no managed copy, no npx" cases, "hooks.json is valid JSON" and "declares an input" (covered by the exact-shape cases), the version pin (now "equals `package.json`", the number is CI's), `skipLibCheck` with `.gitattributes`, the git-mode case (now file modes on disk, with the executable check), the unsupported-extension case (a table row), the exact-pin half of the banner case, the three wasm cases (one case in `build.test.ts`), and in `skill.bats` "exists", "colocated" and "self-contained".
- Changed on purpose: the description cases. The `description` is now one short sentence by the repository rule, so it no longer lists languages; the README table and the `hooks.json` description still must.

## Live check (2026-11-17, Claude Code 2.1.326, headless, `--setting-sources project`, Sonnet)

- Method: the `live-verify` recipe with `--plugin-dir universal-format/plugin` and a throwaway probe plugin (a command hook and an `mcp_tool` hook with the same `input` template, both logging what they receive), throwaway repositories in the session scratchpad.
- Run 1, a plain repository: a Write of `const a={b:1}` to `a.ts` landed as `const a = { b: 1 };`, a Write of `{"x":1,"y":[1,2]}` to `main.json` as `{ "x": 1, "y": [1, 2] }`, an Edit of `a.ts` (`b: 1` to `b:   2,c:3`) as `const a = { b: 2, c: 3 };`. After `EnterWorktree` a Write of `let  z=1` to `wt.ts` inside the worktree landed as `let z = 1;`; both probes logged the worktree path as `cwd` for that call, and no `CwdChanged` event was logged.
- Run 2, the dprint gate: see [dprint-gate.md](../design/dprint-gate.md), last bullet.
- The debug log showed the server connected in the 2026-07-28 era, `format_pre` kept from the model, and the hook's `updatedInput` and `additionalContext` applied on each call.
- Run 3 and 4, the Edit edge cases: the no-op Edit and an LF file under `endOfLine: "crlf"`, see [hook-design.md](../design/hook-design.md), "Edit".
- Not exercised live: the CLI languages with real tools (stubs only in the tests; the real tools were last run on 2026-10-19 in the former repository), the skill, an interactive session, subagents, Windows.
