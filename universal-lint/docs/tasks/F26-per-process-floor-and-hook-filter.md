---
id: F26
title: Per-process floor (about 40 ms) for events the hook cannot act on
status: done
priority: low
area: universal-lint/src/hooks/lint-file.mts (`createHash` wrapper), universal-lint/tests/manifest.test.mts, universal-lint/docs/tasks/F26-per-process-floor-and-hook-filter.md, universal-lint/docs/TASKS.md, universal-lint/.claude/rules/hook-design.md
---

# F26 Per-process floor for events the hook cannot act on

## Status

Done in 0.15.23. Merges bench-js-ts floor finding (confirmed, low), static node-startup finding (confirmed, low) and real-sessions FileChanged-spawn finding (confirmed, low).

- Step 1 (extension check before realpath in `scopedTarget`) already shipped with F12.
- Lazy `node:crypto` shipped: the non-exported `createHash` wrapper loads it through the synchronous `process.getBuiltinModule("node:crypto")` on first hash; the callers (`runNpx`, `hashPath`, `fileDigest`) are unchanged. Re-measured (31 spawns per variant through `process.execPath`, medians in ms):

| Payload                    | static (before) | lazy `node:crypto` |
| -------------------------- | --------------- | ------------------ |
| out-of-scope `.json` Write | 46.0            | 39.5               |
| FileChanged `unlink`       | 44.8            | 37.8               |

Raw import cost with fs/path already loaded: `node:crypto` 5.3-5.5 ms, `node:child_process` 1.2-1.6 ms.

- Node floor: unchanged at 18.14 (`os.availableParallelism`). `process.getBuiltinModule` exists from Node 22.3 / 20.16; older Node falls back to `createRequire(import.meta.url)("node:crypto")` (the `node:module` import measured 0 ms). The review found every lint path hashes (`recordWritten`/`fileDigest`, `probeFilePath`/`hashPath`, `runNpx`), so an unguarded `getBuiltinModule` would have meant silent fail open, i.e. zero linting on old Node. Events that never hash skip both.
- Lazy `node:child_process` not shipped: about 2 ms more, inside noise, seven call sites.
- No hooks.json filter (user decision); hooks.json is unchanged. Prototype (Claude Code 2.1.321; three throwaway copies of the built `plugin/`, each hooks.json command wrapped by a spy script that logs event and file path, then pipes stdin to the unchanged `lint-file.mjs`; fresh scratch git repo per run; `claude -p --plugin-dir <copy> --debug-file <log> --allowedTools "Write Edit Bash Read" --model haiku`; steps: Write c.json, Write d.sh, Write sub/e.sh, Write F.SH, Edit a.sh, Edit b.json, sleep, external append to a.sh, `rm d.sh`):
  - Caveat: the runs were NOT isolated. Debug logs show `Loaded 23 installed plugins`, `Processing 17 enabled plugins` and `Plugin "universal-lint" from --plugin-dir overrides installed version`. The spawn counts still stand because the spy logs only the prototype plugin's spawns and only a.sh was watched.
  - Baseline: 1 SessionStart, 4 PostToolUse (c.json, d.sh, a.sh, b.json: 2 of 4 out of scope), 2 FileChanged (a.sh echo of the Edit, a.sh external append). `rm d.sh` fired nothing (d.sh is not in the watch list).
  - PostToolUse `if` (handler-level, permission-rule syntax): `Edit(*.sh)` fired only for Edit a.sh and does not cover Write. `Write(*.sh)`, `Write(**/*.sh)` and absolute `Write(//tmp/**/*.sh)` fired for d.sh, sub/e.sh and F.SH (any depth, case-insensitive). `Write(*.{sh,json})` (braces) and `Edit(*.sh)|Edit(*.json)` (alternation) never matched. A skip logs `Skipping hook due to if condition "<rule>" not matching` and spawns no process. `if` takes exactly one permission rule per handler by documentation (Claude Code 2.1.85+), so a filter keeping every lintable file needs one handler per tool x extension: 2 x 23 = 46 handlers kept in step with `EXT_MAP`/`TYPE_CHECK_EXTS` by a drift test. `if` relative-path semantics already changed once (2.1.214); how a relative `*.ext` rule resolves after CwdChanged to a directory outside the project root is unverified.
  - FileChanged `matcher`: `"a.sh"` fired on both a.sh events (same as baseline); `"zzz.sh"` no FileChanged spawn at all; `"*.sh"` never fired (not a glob); `".*\\.sh$"` fired on both. The matcher does two jobs: it is split on `|` into literal filenames registered as watched files, and it regex-filters the changed file's basename case-sensitively. An extension regex would register bogus watch entries and drop `F.SH`-style lints unless written with `[sS][hH]`-style classes for all 23 extensions. It can only skip basenames that are not lintable (files watched by another plugin, e.g. dprint's .json); the hook's own Write/Edit echo (digest skip) and `unlink` carry a lintable basename and keep their spawn.
  - What a filter would buy: about 8% of Write/Edit spawns (.json 3.5-4.3%, .bats 2.3%, .txt 0.8%, .toml 0.4%), each about 40 ms background CPU (asyncRewake: no wall-clock, no tokens). Not worth the drift risk (F22, F23, F25 precedent).
- Reopen trigger: adopt a filter only if Claude Code adds alternation/brace globs to `if` (one handler per tool) or a documented glob/extension matcher for FileChanged, or if out-of-scope spawns stop being background-only.

## Problem

Write/Edit of .json/.toml/.bats/.txt and FileChanged events the hook cannot act on (its own Write/Edit echoes, `unlink`, files watched only by another plugin such as dprint's .json) each start a full Node process, load the module and run scope checks before exiting 0. Background (asyncRewake), so CPU only.

## Evidence

`node -e 0` 20-26 ms; node + the hook's builtin imports 33 ms; hook no-op 38-47 ms (.json 39-42, .txt 38, node_modules path 43, outside cwd 39); preload at 27 ms, stdin read at 39 ms, end at 43 ms; `NODE_COMPILE_CACHE` no gain (one run: 55 -> 45 ms early exit). Sessions: .json 3.5-4.3%, .bats 2.3%, .txt 0.8%, .toml 0.4% of Write/Edit (about 8%). Live: each Edit of a watched file fired FileChanged about 0.6-1.5 s later (43-54 ms, digest skip; 4 extra spawns for 6 edits); unlink events 82-85 ms; dprint-only plugin.json 170 ms.

## Code locations

The non-exported `createHash` wrapper (lazy `node:crypto` via `process.getBuiltinModule`, `createRequire` fallback on older Node) and its three callers `runNpx` (npx cache key), `hashPath` and `fileDigest`; `main`; `isMainModule`; `postToolScope`/`scopedTarget` (extension check before realpath, F12); `fileChangedHandler` (`unlink` check); hooks.json (matcher `Write|Edit`, no FileChanged matcher; unchanged).

## Approach

1. Extension-first reorder in `scopedTarget`: shipped with F12.
2. Lazy `node:crypto` through `process.getBuiltinModule`: shipped (about 7 ms off every spawn that never hashes). Lazy `node:child_process`: not shipped (about 2 ms).
3. Claude Code filtering (PostToolUse `if`, FileChanged matcher): investigated with a `--plugin-dir` copy and spawn counts from a debug log; not adopted (see Status).

## Verification

Bench (31 spawns, medians): `.json` Write no-op 46.0 -> 39.5 ms, `unlink` 44.8 -> 37.8 ms. manifest.test.mts asserts the built hook has no static `node:crypto` import. manifest.test.mts pins `PostToolUse[0]` and must be updated with any hooks.json change. `node universal-lint/scripts/perf.mts 5` exits 0.

## Constraints

A filter must never drop `EXT_MAP`/`TYPE_CHECK_EXTS` files; the digest skip stays. A FileChanged matcher changes the documented "no matcher on the three non-tool events" rule (hook-design.md). It is an explicit trade-off: confirm with the user and update hook-design.md and manifest.test.mts. No `userConfig`. Version bump.

## Related

F12 (reorder), F32 (echo race), F01 (floor baseline).
