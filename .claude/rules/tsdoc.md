---
paths:
  - "**/*.mts"
  - "**/*.ts"
---

# Rule: TSDoc in TypeScript sources

Doc comments are not linted. Keep them up to date by hand whenever you edit a `.mts`/`.ts` file:

- Every function, method, class, type, interface, type member and module-level constant you add gets a TSDoc comment, exported or not.
- When you change a symbol's behavior, parameters, return value or type, update its comment in the same edit. Delete comments of removed symbols.
- TSDoc syntax: description first, one blank line, then tags. `@param name - text` (hyphen; no dotted `@param opts.x`, document options on their type), `@returns`, `@remarks`, `@typeParam` (not `@template`). No types in tags; TypeScript carries them.
- Comments only exist in sources: the build strips them from `plugin/**/*.mjs`.
