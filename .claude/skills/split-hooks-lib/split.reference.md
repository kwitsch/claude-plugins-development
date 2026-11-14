# split script

One-off node script (write it to the session scratchpad, never into the repository, and run it as a plain `node <scratchpad>/split.mjs` from the worktree root). It reads `<plugin>/src/hooks/register.mts`, cuts it into chunks (a TSDoc comment plus its top-level `function`, `const` or `type` declaration), and writes one `.mts` per target file with generated imports. Fill `PLUGIN`, `MAP` (target file to the symbols it takes, every top-level symbol exactly once; `register` stays in `register.mts`) and `DOC` (one sentence per helper file, becomes its file comment).

Limits: one declaration per top-level name; no `export default`; imports of the original file are not carried over (a file with `node:` imports needs them added by hand to the helper that uses them); a symbol name that also appears inside a string literal may produce an unused import, which `pnpm lint` flags.

```js
import { readFileSync, writeFileSync } from "node:fs";

const PLUGIN = "<plugin>";
const MAP = {
  "types.mts": ["..."],
  "util.mts": ["..."],
  "register.mts": ["register"],
};
const DOC = { "types.mts": "...", "util.mts": "..." };

const dir = `${PLUGIN}/src/hooks/`;
const lines = readFileSync(dir + "register.mts", "utf8").split("\n");
const declRe = /^(export )?(async )?(function|const|type) ([A-Za-z0-9_]+)/;

const decls = [];
lines.forEach((l, i) => { const m = declRe.exec(l); if (m) decls.push({ name: m[4], kind: m[3], line: i }); });
for (const d of decls) {
  let s = d.line;
  if (lines[s - 1]?.trim().endsWith("*/")) { s -= 1; while (!lines[s].trim().startsWith("/**")) s -= 1; }
  d.start = s;
}
decls.forEach((d, i) => { d.end = (decls[i + 1]?.start ?? lines.length) - 1; while (lines[d.end].trim() === "") d.end -= 1; });
const header = lines.slice(0, decls[0].start).join("\n");

const byName = new Map(decls.map((d) => [d.name, d]));
const fileOf = new Map();
for (const [f, names] of Object.entries(MAP)) for (const n of names) { if (!byName.has(n)) throw new Error(`unknown ${n}`); fileOf.set(n, f); }
for (const d of decls) if (!fileOf.has(d.name)) throw new Error(`unassigned ${d.name}`);

const strip = (t) => t.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
for (const [f, names] of Object.entries(MAP)) {
  const own = new Set(names);
  const chunks = names.map((n) => byName.get(n)).sort((a, b) => a.start - b.start).map((d) => {
    let t = lines.slice(d.start, d.end + 1).join("\n");
    if (f !== "register.mts") t = t.replace(/^(async function |function |const |type )/m, "export $1");
    return t;
  });
  const body = chunks.join("\n\n");
  const code = strip(body);
  const imports = new Map();
  for (const [n, from] of fileOf) {
    if (own.has(n) || from === f || !new RegExp(`\\b${n}\\b`).test(code)) continue;
    const kind = byName.get(n).kind === "type" ? "type" : "value";
    if (!imports.has(from)) imports.set(from, { type: [], value: [] });
    imports.get(from)[kind].push(n);
  }
  const importLines = [];
  for (const [from, { type, value }] of [...imports].sort(([a], [b]) => a.localeCompare(b))) {
    const mod = `./${from.replace(".mts", ".mjs")}`;
    if (value.length) importLines.push(`import { ${value.sort().join(", ")} } from "${mod}";`);
    if (type.length) importLines.push(`import type { ${type.sort().join(", ")} } from "${mod}";`);
  }
  const top = f === "register.mts" ? header : `/**\n * ${DOC[f]}\n *\n * @packageDocumentation\n */`;
  writeFileSync(dir + f, `${top}\n\n${importLines.join("\n")}${importLines.length ? "\n\n" : ""}${body}\n`);
  console.log(f, names.length, "symbols,", importLines.length, "import lines");
}
```

After it ran: `pnpm lint` (the root one), remove flagged unused imports, check that no helper declares a name another helper declares (the bundler fails on it too).
