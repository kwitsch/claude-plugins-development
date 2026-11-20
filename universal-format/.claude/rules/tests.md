---
paths:
  - "tests/**"
---

# Tests

- Unit tests import `src/mcp/*.ts`; the root vitest alias resolves `./vendor/index.js` to the built `plugin/mcp/vendor/index.mjs`, so run `pnpm --filter universal-format build` once after a vendor change. Process tests spawn `plugin/mcp/server.mjs` and the skill driver.
- `tests/support/mcp.ts`: the hermetic harness for the spawned server and the skill driver. A sandbox per test: a project dir, a HOME, a PATH that holds only `bash`, `node` and `cat` (symlinked) plus the stubs a test adds (`recStub(name)` records `<name> <argv>`, drains stdin, prints `reformatted-by-<name>`), and a `.git` above them that ends every upward walk. No real formatter, no network.
- `tests/support/plugin.ts`: in-process access to `formatPre` of `src/mcp/handlers.ts` for the unit tests; importing it points HOME at a temp dir (the handler reads user settings and appends `~/.local/bin` to PATH). A unit test file that touches PATH or the handler imports it.
- The PATH answer per tool is cached for the life of a process: a test that needs another PATH for the same tool starts a new server; in-process, only one file probes a given tool with stubs (`cli-stdin.test.ts`: `goimports`/`gofmt`; `registry.test.ts`: `ruff`/`gofmt`/`rustfmt`).
- `languages.test.ts`: one table row per Write case over the spawned server; a like case is a new row, not a new test body. Assert the printWidth policy on the produced content.
- `mcp-server.test.ts`: both protocol eras, cancellation. `dprint-gate.test.ts`: the gate, through the spawned server because HOME anchors the user settings. `manifest.test.ts`: wiring pins (`hooks.json` input, `.mcp.json`, README). `build.test.ts`: what the vendor step must have produced.
- Config-cache tests probe `semi` on a `.mjs` file, never a JSON/YAML `printWidth` (the printWidth guard re-reads the disk on every call and would make the test pass for the wrong reason).
- The tests assume no `.git` entry, no prettier config and no dprint config above `os.tmpdir()`.
