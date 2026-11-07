---
id: F26
title: Per-process floor (about 40 ms) for events the hook cannot act on
status: open
priority: low
area: universal-lint/plugin/hooks/hooks.json (PostToolUse and FileChanged entries), universal-lint/src/hooks/lint-file.mts (module top level, main, isMainModule, postToolScope, scopedTarget, fileChangedHandler)
---

# F26 Per-process floor for events the hook cannot act on

## Status

Open. Merges bench-js-ts floor finding (confirmed, low), static node-startup finding (confirmed, low) and real-sessions FileChanged-spawn finding (confirmed, low). Mostly measurement; the only real fix depends on Claude Code hook filtering, which is unverified.

## Problem

Write/Edit of .json/.toml/.bats/.txt and FileChanged events the hook cannot act on (its own Write/Edit echoes, `unlink`, files watched only by another plugin such as dprint's .json) each start a full Node process, load the module and run scope checks before exiting 0. Background (asyncRewake), so CPU only.

## Evidence

`node -e 0` 20-26 ms; node + the hook's builtin imports 33 ms; hook no-op 38-47 ms (.json 39-42, .txt 38, node_modules path 43, outside cwd 39); preload at 27 ms, stdin read at 39 ms, end at 43 ms; `NODE_COMPILE_CACHE` no gain (one run: 55 → 45 ms early exit). Sessions: .json 3.5-4.3%, .bats 2.3%, .txt 0.8%, .toml 0.4% of Write/Edit (about 8%). Live: each Edit of a watched file fired FileChanged about 0.6-1.5 s later (43-54 ms, digest skip; 4 extra spawns for 6 edits); unlink events 82-85 ms; dprint-only plugin.json 170 ms.

## Code locations

Top-level imports (`node:child_process`, `node:crypto`, `node:fs`, `node:os`, `node:url`); `main`; `isMainModule`; `postToolScope`/`scopedTarget` (realish before the extension check, see F12); `fileChangedHandler` (`unlink` check); hooks.json (matcher `Write|Edit`, no FileChanged matcher).

## Approach

1. Cheap: the extension-first reorder in `scopedTarget` (shared with F12). Optional: dynamic-import `node:child_process`/`node:crypto` only on the lint path (a few ms).
2. Investigate (do not assume) Claude Code filtering: a PostToolUse `if` rule (permission-rule syntax, e.g. one entry per extension glob) or a FileChanged matcher on basenames. Test with a `--plugin-dir` copy and count spawns in a debug log before adopting.

## Verification

Bench on a .json Write: unchanged about 44 ms with only the reorder; fewer hook spawns in a debug-file session if a filter exists. manifest.test.mts pins `PostToolUse[0]` and must be updated with any hooks.json change.

## Constraints

A filter must never drop `EXT_MAP`/`TYPE_CHECK_EXTS` files; the digest skip stays. A FileChanged matcher changes the documented "no matcher on the three non-tool events" rule (hook-design.md). It is an explicit trade-off: confirm with the user and update hook-design.md and manifest.test.mts. No `userConfig`. Version bump.

## Related

F12 (reorder), F32 (echo race), F01 (floor baseline).
