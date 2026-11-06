---
paths:
  - "**/*.mts"
  - "**/*.ts"
  - "tsconfig*.json"
  - ".oxlintrc.json"
  - "**/package.json"
---

# Rule: workspace lint, type check and vitest config

- `.oxlintrc.json`: oxlint, TypeScript-first, for every hand-written `.mts` (`plugin/` is ignored): the `correctness` category plus the former ESLint presets' extra rules. One run at the root (`pnpm exec oxlint`, part of `pnpm lint`) covers the whole workspace. `options.typeAware` + `options.typeCheck` run tsgolint (TypeScript 7) with the root `tsconfig.json`, a solution file referencing `tsconfig.src.json` (`*/src/`, `*/scripts/` (incl. `development/scripts/`), `development/vitest/claude-engine/`, `vitest.config.mts`: fully strict) and `tsconfig.tests.json` (`*/tests/`: no `noImplicitAny`, `allowJs`; `.oxlintrc.json` also turns off `no-unsafe-*` and `require-await` there), both extending `tsconfig.base.json` (type check only, `noEmit`; no per-plugin tsconfig; `@types/node` is a root devDependency), so `pnpm lint` is also the type check (no `tsc`, no `typecheck` script). Doc comments are not linted; `.claude/rules/tsdoc.md` covers them.
- `vitest.config.mts`: every package's `test` script is `vitest run --config "$(git rev-parse --show-toplevel)/vitest.config.mts"` (vitest does not search parent dirs for a config; the git root keeps the path the same at any depth).
