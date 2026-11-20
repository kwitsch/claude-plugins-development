---
paths:
  - "vitest.config.mts"
  - "tsconfig*.json"
  - ".oxlintrc.json"
  - "**/package.json"
  - ".claude/settings.json"
---

# Rule: workspace lint, type check and vitest config

- `.oxlintrc.json`: oxlint, TypeScript-first, for every hand-written `.ts` (`plugin/` is ignored): the `correctness` category plus the former ESLint presets' extra rules. One run at the root (`pnpm exec oxlint`, part of `pnpm lint`) covers the whole workspace. `options.typeAware` + `options.typeCheck` run tsgolint (TypeScript 7) with the root `tsconfig.json`, a solution file referencing `tsconfig.src.json` (`*/src/`, `*/scripts/` (incl. `development/scripts/`), `development/vitest/claude-engine/`, `vitest.config.mts`: fully strict) and `tsconfig.tests.json` (`*/tests/`: no `noImplicitAny`, `allowJs`; `.oxlintrc.json` also turns off `no-unsafe-*` and `require-await` there), both extending `tsconfig.base.json` (its `paths` maps `@shared/*` to `development/shared/src/*` and `@scripts/*` to `development/scripts/*`, the latter for tests, with the real extension: `@scripts/plugin-manifest.ts`; `vitest.config.mts` carries the matching alias; `tsconfig.src.json` also covers `development/shared/src/`, `development/tsdown/*.ts` and every `*/tsdown.config.ts`, `tsconfig.tests.json` `development/scripts/tests/` and `development/tsdown/tests/`; type check only, `noEmit`; no per-plugin tsconfig; `@types/node` is a root devDependency), so `pnpm lint` is also the type check (no `tsc`, no `typecheck` script).
- `vitest.config.mts` aliases `@shared` (like `@scripts`) and excludes `**/claude-tests/**`; `tsconfig.tests.json` also covers `*/claude-tests/` with the ambient `development/vitest/claude-engine/claude-code-testing.d.ts` (types of `claude-code/testing`); `.oxlintrc.json` relaxes `*/claude-tests/**` like `*/tests/**`.
- `vitest.config.mts`: every package's `test` script is `vitest run --config "$(git rev-parse --show-toplevel)/vitest.config.mts"` (vitest does not search parent dirs for a config; the git root keeps the path the same at any depth).
- `vitest.config.mts` also maps `./vendor/index.js` to the built `plugin/mcp/vendor/index.mjs` (a source's import of its vendored bundle; the types stay in `src/<dir>/index.d.ts`).
- Tooling (`oxlint`, `oxlint-tsgolint`, `tsdown` (pinned exactly, `0.23.7`: the standard build, `tsdown-build.md`), `vitest`, `@types/node`) is a root devDependency only.
