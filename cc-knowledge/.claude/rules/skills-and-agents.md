---
paths:
  - "plugin/skills/cc-review/**"
  - "plugin/skills/cc-author/**"
  - "plugin/skills/memory-audit/**"
  - "plugin/skills/cc-compress/**"
  - "plugin/agents/**"
  - "src/skills/cc-compress/**"
---

# Orchestrator skills, agents and cc-compress

- `cc-review`, `cc-author` and `memory-audit` run inline (no `context: fork`: they need `Agent` and `Edit`/`Write`), gate every application through `AskUserQuestion`, and detect at run time with Bash, never with load-time injection (the exclamation-mark-plus-backtick sequence). `memory-audit` reuses `cc-reviewer` with `component_type: memory` and reads `analysis-workflow.reference.md`.
- The three agents are read-only (no `Write`, `Edit` or `Bash`), answer only from `cc-reference` and name no `context-mode` tool. `cc-reviewer` and `cc-author-planner` return structured JSON, never prose.
- Shell-variant skills use no rtk-optimizable command; the fetch-variant components fall back to `WebFetch` (a problem domain rtk has no role in).
- `cc-compress`: the script enforces exact preservation of code blocks, inline code, URLs, heading count and frontmatter (retry once, then fail without writing), backs the original up outside the source directory before the in-place write (exclusive create), and refuses sensitive file names before any content reaches `claude`. Behaviour of `compress.ts` stays identical to the upstream adaptation; every change needs a test in `tests/compress.test.ts` with a stubbed `claude`.
