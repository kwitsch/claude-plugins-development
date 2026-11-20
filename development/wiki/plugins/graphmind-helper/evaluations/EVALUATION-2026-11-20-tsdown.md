# graphmind-helper 0.2.3: tsdown build, live check

Whether the tsdown-built plugin (mod as `plugin/hooks/register.js`, wrapper as `plugin/bin/mcp.mjs`) loads and works in a real Claude Code session, and what the build produces.

## Method

- Build: `pnpm --filter graphmind-helper build` (tsdown 0.23.7 / rolldown 1.3.3), twice, `git status` compared; sizes with `wc -c`.
- Tests: `pnpm -r test`, `claude plugin validate graphmind-helper/plugin`.
- Live run 1 (live 2.1.329, 2026-11-20): `graphmind-helper/plugin/` copied to a directory outside the repository (no `package.json` above it, as in an installed plugin); `claude -p --plugin-dir <copy> --setting-sources project --debug-file <log> --allowedTools Read` in a throwaway git repo with one commit; one prompt.
- Live run 2: the same, plus `--mcp-config` with a file that wires the `graphmind` MCP server (`graphmind mcp`), `--allowedTools Grep,Read`; the prompt asks for one Grep call and for the graphmind context the model received. A first attempt passed the file as `--settings`: the log shows no `graphmind` server from it (only the plugin's own server), so the run was repeated with `--mcp-config`.
- One machine, one run each.

## Results

- Output: `plugin/hooks/register.js` 11201 B (compressed, not mangled; 0.2.2: `register.mjs` 8549 B + `lib.mjs` 4506 B + `shared/graphmind-paths.mjs` 210 B), `plugin/bin/mcp.mjs` 2201 B (minified, shebang, mode 0755; 0.2.2: `mcp.mjs` 1097 B + `common.mjs` 1288 B + the shared module). No `plugin/hooks/lib.mjs`, no `plugin/shared/`.
- The second build left `git status --porcelain -- graphmind-helper/plugin` empty: yes (`pnpm -r build` over the committed output, whole tree clean).
- Imports left in the output: `register.js` none, `mcp.mjs` only `node:child_process`, `node:fs`, `node:os`, `node:path` (grep 2026-11-20).
- Tests: graphmind-helper 86 passed (86 before), `plugin-build` 16 passed; `claude plugin validate graphmind-helper/plugin`: `✔ Validation passed` (one plugin-directory warning, `ICON_MISSING`, which does not change the verdict).

## Bug hunt

- None run for this change: the sources are unchanged apart from comments and one re-export in `src/bin/mcp.ts`; the behaviour tests are the 86 existing ones against the new output.

## Live validation

- `.js` hooks module: loaded. `hooks module graphmind-helper@inline loaded (worker, environment 2, tier user)`, then `plugin.register: graphmind-helper (user, graphmind-helper@inline), judged by cc-plugin-sec-default: admitted`; no load error or static-check rejection. Each hook settled (`session.start settled in 22.9ms`, `prompt.submit settled in 65.4ms`, `session.end settled in 158.8ms`; run 2 also `tool.call settled in 37.7ms`).
- Events registered: `events: session.start,session.end,session.compact,prompt.submit,tool.call` (the five expected).
- MCP wrapper `bin/mcp.mjs`: run 1 `MCP server "plugin:graphmind-helper:graphmind": Successfully connected (transport: stdio) in 1073ms`, server `graphmind` 0.3.7, closed cleanly at the end. In the `--settings` attempt of run 2 (after run 1 had registered the repo) it stepped aside as designed: `Connection failed ... (CONNECTION_CLOSED)`. In the `--mcp-config` run the log has no line for the plugin's server at all and gives no reason.
- Run 2, graphmind server wired: connected through `--mcp-config` (`MCP server "graphmind": Successfully connected (transport: stdio) in 170ms`); not through `--settings` (no `MCP server "graphmind"` line).
- Run 2, briefing on the first prompt: NONE. The log gives no module line beyond `prompt.submit settled in 64.0ms`. The likely reason is the setup-hooks dedupe: the user's `~/.claude/settings.json` names `graphmind-prompt.sh`, `graphmind-search.sh` and `graphmind-session.sh`, so the module adds nothing (`--setting-sources project` does not stop the module from reading that file). Not confirmed further, because the engine logs only failed `$` calls.
- Run 2, recall: not seen (same reason; the model got no graphmind text).
- Run 2, nudge after the Grep call: NONE (`tool.call settled in 37.7ms`, nothing added; same reason).
- The binary probe at `session.start` walks `PATH`: every missing candidate logs `$.fs.stat (graphmind-helper): <dir>/graphmind failed: ENOENT` plus `[ERROR] hooks chain failed: errorKind=HooksError` (about 60 pairs per run). The probe fails open as designed; the lines are noise in the debug log only.
- Side effects of the runs and what was cleaned up: run 1's wrapper ran `graphmind init`, which registered the throwaway repo with graphmind (slug `repo`) and added a project-scoped `graphmind` server for it to `~/.claude.json`. The cleanup `claude mcp remove graphmind` in the throwaway repo was refused by the session's auto-mode classifier, so both stay behind: the `.claude.json` project entry and the graphmind registration (`graphmind unregister repo` removes it). The scratch directory with the repo and the debug logs was deleted.
- Not exercised: a `graphmind setup` server (`mcp__graphmind__*`) as the only server, an unregistered project without the wrapper, the 10th-prompt checkpoint, `/clear` and `/resume`, compaction, an interactive session, other platforms. The module's own output (briefing, recall, nudge) could not be observed: the setup-hooks dedupe applies on this machine, and a run without it needs a temp `HOME` or `CLAUDE_CONFIG_DIR` with the user's credentials.
