---
paths:
  - "*/plugin/skills/**"
  - "*/src/skills/**"
  - ".claude/skills/**"
---

# Rule: verified behaviour of the tools a skill tells Claude to use (universal-lint bug hunt, 2.1.323)

- Glob returns at most 100 files without saying so: list folders with `git ls-files` or `find`.
- Write refuses to overwrite an existing file that was not Read in the session, so `mktemp` then Write fails: let Write create a new path.
- A named skill argument gets only the first word of the command text; `$ARGUMENTS` gets all of it.
- In `claude -p`, `AskUserQuestion` is disabled, so interactive skill flows stop at their first question without changing anything.
