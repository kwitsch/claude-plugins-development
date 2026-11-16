# npm, npx and Node runtime behaviour

How `npx` finds and refreshes a package, and Node runtime traps that hit hook scripts.

How universal-lint uses these: [npx-and-local-bin.md](../plugins/universal-lint/design/npx-and-local-bin.md). How dprint probes for a runner: [notice-hook.md](../../../dprint/.claude/rules/notice-hook.md).

## npx (npm 11.19.1, probed 2026-11-07)

- Lookup order of `npx --yes <name>` (positional, no `--package`): a bin of the cwd's own `package.json`, then `node_modules/.bin` from the npm local prefix up to `/`, then the global `<prefix>/bin`, then the cache `_npx/<sha512(spec) hex[0:16]>`. It runs a bin from a parent directory's `node_modules/.bin` even when the cwd has its own `package.json`.
- A name-only spec is checked against the registry's `latest` on every call and the cache is upgraded. Offline, or right after a release, a cached package then counts as missing: add `--prefer-offline` when only the cache should count.
- `npx --no <pkg> --version` prints npm's own version (npx swallows `--version` once `--no` is given): write `npx --no -- <pkg> --version`.
- npx holds a lock `<cache dir>/concurrency.lock` while it loads or installs the tree, which bumps the cache directory's mtime on every run. The lock exists only from libnpmexec 10.2.0 (npm 11.x); Node 22's npm 10.9 has none, and there the directory mtime moves only on installs.

## Node (24.x)

- Any import of `node:process`, or touching `process.stdin`, opens fd 0 as a non-blocking pipe. A later `readFileSync(0)` throws `EAGAIN` for a late writer or a payload above the pipe buffer (about 128-192 KB), even through a plain shell pipe. Read hook stdin with `await json(process.stdin)` from `node:stream/consumers` (probed on 24.22.2).
- `setTimeout` and `node:timers/promises` fire a delay above 2^31-1 ms after 1 ms with a `TimeoutOverflowWarning`; `AbortSignal.timeout` does not (checked 2026-11-12).
- `JSON.parse(text, reviver)` gives the reviver a third argument whose `source` is the literal's original text (Node 24, Bun 1.3). Use it when a number must be handled digit for digit: `String(v)` rounds a long number and normalises `123456.0`.

## This machine class (WSL2)

- Claude Code's `PATH` under WSL carries the Windows directories (44 entries on `/mnt/c` in the measured setup): every lookup of a tool that is not installed costs about 90 ms there. A stat on `/mnt/c` costs 0.7-2.5 ms against about 5 µs on ext4 (measured 2026-11-07).
