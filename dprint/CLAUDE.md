# dprint

Skill-only plugin: one model-invocable skill `init-dprint` (`plugin/skills/init-dprint/SKILL.md`) and its
zero-dep detection script `plugin/skills/init-dprint/check-dprint.mjs` (contract: `check-dprint.reference.md`).

`check-dprint.mjs` and `plugin/.claude-plugin/plugin.json` are **build output** (`pnpm build`) of
`src/skills/init-dprint/check-dprint.mts` and `plugin.json`. Do not edit them here.

`MIN_VERSION` is defined only in the `.mts` source. Changing it: edit there, update the
"Minimum dprint version" line in `README.md`, rebuild. Tests read the value from the built script.
