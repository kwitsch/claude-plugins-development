# linux-token-efficiency: concepts and functions (reference for inline-headroom)

`linux-token-efficiency` is deprecated; inline-headroom replaces it. This file records what the old plugin did, how, and why, so its ideas can be ported into inline-headroom later without reading the old source. It is a reference, not a plan: nothing here is implemented in inline-headroom unless inline-headroom's own `CLAUDE.md` or rules say so.

- Last release: `linux-token-efficiency` 0.8.1 in kwitsch/claude-plugins (tag `linux-token-efficiency-0.8.1`). Source: `plugins/linux-token-efficiency/`, tests: `test/linux-token-efficiency/` at that tag. Recover a file with `git show linux-token-efficiency-0.8.1:<path>`.
- Old layout (hand-written `.mjs`, the claude-plugins conventions, not this repo's): `hooks/register.ts` + pure `hooks/rtk-rewrite.mjs` (mods module), `hooks/rtk-install.mjs` (command hook), `mcp/server.mjs` + `mcp/cbm-context.mjs` + `mcp/binary-fetch.mjs` (proxy MCP server), `bin/rtk`, `bin/context-mode-launch.sh`, `hooks/SessionStart.md`, `hooks/subagent-nudge.json`, `output-styles/terse.md`, `cbm-tools.json`.

## Overview: five token-saving mechanisms

| #   | Mechanism                                              | Where it acted                                                          | Toggle                        |
| --- | ------------------------------------------------------ | ----------------------------------------------------------------------- | ----------------------------- |
| 1   | rtk rewrite of Bash commands                           | mods `tool.call` hook on `Bash`                                         | `auto_rewrite`                |
| 2   | rtk provisioning into `~/.local/bin/rtk`               | async `SessionStart` command hook                                       | `rtk_enabled`                 |
| 3   | context-mode MCP server + deny-steering                | `.mcp.json` server, `tool.call` hooks on `Bash`/`WebFetch`, static docs | `steer_enabled` (steers only) |
| 4   | codebase-memory-mcp (cbm) proxy server + context hooks | `.mcp.json` server, 1 command hook + 3 `mcp_tool` hooks                 | `cbm_enabled`                 |
| 5   | forced terse output style                              | `output-styles/terse.md`                                                | none                          |

The division of labour was deliberate and is the main design idea worth keeping:

- Side-effecting and single commands (`git`, `gh`, builds, file ops) stay in Bash, compressed by rtk.
- Read-only, output-heavy gathering (fetches, chains and pipelines of text tools) goes to the context-mode sandbox, where output is indexed and only search results enter context.
- Symbol and file lookups (`Grep`, `Glob`, `Read`) stay native, enriched by cbm graph context.
- The three never conflict mechanically (an MCP tool call never matches a `Bash` matcher), but they compete for the model's attention: three sets of "prefer X over Y" guidance in one session.

Platform: everything except the output style was Linux x86_64 only (musl/amd64 binaries). The mods module probed `$.fs.exists("/proc/version")` once per module load as its "is Linux" check (no `process.platform` in a mods module).

## 1. rtk Bash rewrite

[rtk](https://github.com/rtk-ai/rtk) is a CLI proxy that runs a command and compresses its output (`git status` becomes `rtk git status`). It ships its own Claude Code hook protocol: `rtk hook claude` reads a PreToolUse JSON on stdin and prints a `hookSpecificOutput.updatedInput.command` rewrite, or nothing.

### Hook shape

- One mods `tool.call` hook with matcher `{ tool: "Bash" }`, registered while `steer_enabled` or `auto_rewrite` is on. One hook, not two, so a deny (steer, section 3) and a rewrite never race; steer runs first.
- Skips: non-string or empty `command`, `command.length > 1 MiB`, non-Linux host.
- Rewrite call: `$.process.run([<HOME>/.local/bin/rtk, "hook", "claude"], { cwd, stdin, timeoutMs: 5000 })`. `stdin` = `{ hook_event_name: "PreToolUse", tool_name: "Bash", cwd, tool_input }`, where `tool_input` is the event minus the engine fields `tool`, `tool_use_id`, `consent`, `agentId`, `requestMeta`. `cwd` comes from `$.session.cwd()` read inside the hook, so a subagent gets its own directory.
- Result: only `hookSpecificOutput.updatedInput.command` (a string different from the original) is used, via `next({ ...e, command: rewritten })`, keeping every other argument. A permission decision from rtk is never forwarded. Non-zero exit, timeout, truncated stdout, unparseable or empty output: no rewrite.
- Fail-open: every helper turns failure into "no rewrite"; the hook calls `next` once, outside any `try`.

### Preflight (no rewrite when any holds)

- `HOME` unset, blank or containing a literal `${` (an uninterpolated placeholder). No `os.homedir()` fallback exists in a mods module.
- `~/.local/bin/rtk` does not stat (links followed) as a regular file.
- "Never double-wire": walk `PATH` (`$.env.get("PATH")`) and then the plugin's own `bin/` (Claude Code appends each enabled plugin's `bin/` to the Bash `PATH`). The first `<dir>/rtk` that is a regular file must resolve to the managed binary or the plugin's `bin/rtk` bridge; anything else is a user's global `rtk init -g` install that already owns the rewrite. Nothing found: no rewrite.
- The mods fs API has no execute bit, so a non-executable `rtk` earlier on `PATH` ends the walk where bash would skip it (accepted shortcut, fail-open either way).

### Linked-worktree guard

- Claude Code's worktree-isolation guard refuses `rtk git …` in a worktree-isolated session: it cannot verify cwd/root through the opaque wrapper, but it can for plain `git …`.
- So a rewrite with a `git` token (`command.split(/\s+/).includes("git")`) is withheld when cwd is inside a linked worktree. Detection: one `git rev-parse --git-dir --git-common-dir` (2 s timeout), both paths made absolute against cwd and resolved with `$.fs.stat(…, { resolve: true })`; linked means they differ. Any failure counts as "not linked".

### Composition

- Mods chains rewrites: a `tool.call` hook above hands its result in as `e.command`; this hook rewrites that, and hooks below see this hook's output. Cross-plugin order is the engine's.
- rtk's `hook claude` answers nothing for an already-rewritten `rtk …` command (verified on rtk 0.48.0), so a second rtk rewriter is a no-op.

### `bin/rtk` PATH bridge

A committed shell wrapper: `exec "$HOME/.local/bin/rtk" "$@"`, exit 127 with a stderr note when the binary is missing. Reason: Claude Code always puts an enabled plugin's `bin/` on the Bash `PATH`; `~/.local/bin` is not guaranteed to be there, so a hand-typed bare `rtk` would not resolve without it.

## 2. Binary provisioning (rtk and cbm)

One download discipline, shared by both binaries (`mcp/binary-fetch.mjs`: `fetchExpectedSha`, `downloadToFile`, `findBinaries`, `hashFile`):

- Always the latest release, through the `releases/latest/download/<asset>` redirect alias; no committed version pin and no updater skill.
- Fetch the release's own `checksums.txt` and require exactly one entry for the asset, or fail closed. Verify the tarball's sha256 against it before extraction. Require exactly one binary of the expected name inside the archive. The extracted binary is trusted, not re-hashed.
- Place by atomic `rename` from a temp dir on the same filesystem.
- Trust caveat, documented as accepted: a same-origin `checksums.txt` detects corruption and truncation, not a malicious release.
- One bounded attempt, silent degradation (one stderr line, exit 0); never inside a synchronous per-call hook.

rtk specifics (`hooks/rtk-install.mjs`):

- Async `SessionStart` command hook (`async: true`, no `asyncRewake`, `timeout: 20`), asset `rtk-x86_64-unknown-linux-musl.tar.gz`, download timeout 12 s (well under the hook timeout, so the `finally` cleanup of the `.rtk-install.*` scratch dir runs before a hard kill).
- Presence-only and never clobbering: acts only when `~/.local/bin/rtk` is absent. A regular file or a still-resolving symlink (stow/asdf/mise) is left alone; a dangling symlink is cleared first.
- Writes outside `${CLAUDE_PLUGIN_DATA}`; reversible with `rm ~/.local/bin/rtk`.

cbm specifics (`mcp/server.mjs`):

- Asset `codebase-memory-mcp-linux-amd64-portable.tar.gz`, the extracted binary is about 280 MiB (above GitHub's 100 MiB file limit: never committed). Download timeout 5 min, at most once per server process.
- Content-addressed cache: `${CBM_BUNDLE_CACHE}/<first 16 hex of asset sha256>/codebase-memory-mcp`, `CBM_BUNDLE_CACHE` defaulting to `${CLAUDE_PLUGIN_DATA}/cbm`. No pruning of old releases.
- `resolveBundleCache` fallback chain: `CBM_BUNDLE_CACHE` → `${CLAUDE_PLUGIN_DATA}/cbm` → `${XDG_CACHE_HOME}/claude-cbm` → `${HOME}/.cache/claude-cbm` → `${TMPDIR:-/tmp}/claude-cbm-<uid>`. Every candidate containing a literal `${` is rejected (`usablePath`): an untracked directory literally named `${CLAUDE_PLUGIN_DATA}` once appeared in a repo root.
- `CBM_CACHE_DIR` (cbm's own graph database root, default `~/.cache/codebase-memory-mcp`) is never set, so server, hooks and manual CLI use share one database. cbm rejects a different canonical root while any cbm process is active, and every active process must run the same binary build: restart sessions after an update.

Toggle policy: `rtk_enabled` and `cbm_enabled` create state over the network yet were deliberately fail-open (only the literal `false` disables), justified by the structural mitigations above. inline-headroom's convention is the opposite (state-creating toggles are fail-closed, e.g. `storage_enabled`); a port must pick one consciously.

## 3. context-mode integration and deny-steering

[context-mode](https://github.com/mksglu/context-mode) (npm, Elastic License 2.0, pinned `context-mode@1.0.169`) is an MCP server whose `ctx_*` tools run commands and code in a sandbox and index the output into a SQLite FTS5 store; only search results or printed stdout enter context. Tools: `ctx_execute`, `ctx_execute_file`, `ctx_batch_execute`, `ctx_index`, `ctx_search`, `ctx_fetch_and_index`, `ctx_stats`, `ctx_doctor`, `ctx_upgrade`, `ctx_purge`, `ctx_insight`.

### Registration

- `.mcp.json` server `context-mode` → `bin/context-mode-launch.sh`: `bunx context-mode@<pin>` if `bunx` resolves, else `npx --yes …`, else exit 1. It probes the package runners, not `node` (node alone does not run `npx`). `PATH` is hardened by appending (never prepending) `~/.local/bin` and `~/.bun/bin`; all diagnostics go to stderr (stdout is the stdio channel).
- Tool names are plugin-namespaced: `mcp__plugin_<plugin>_context-mode__<tool>`. A bare `mcp__context-mode__*` name or matcher never matches a plugin-bundled server.
- No integrity check: a registry fetch cannot be sha256-verified; the pin buys reproducibility only. The pin was bumped by hand.
- No toggle for the server, by explicit user decision (a `context_mode_enabled` toggle was built and removed).

### Static guidance

- `SessionStart` command hook `cat hooks/SessionStart.md`: upstream's `configs/claude-code/CLAUDE.md`, byte-for-byte (about 5 KB, injected on startup, resume, clear and compact). Kept verbatim so re-syncing is a copy and a diff; excluded from formatters and review bots. Its "BLOCKED" sections describe upstream's own routing engine (`hooks/core/routing.mjs`, about 44 KB), which was never ported; the steering hooks below made only the `WebFetch` and bare-`curl` parts real. `wget` and inline HTTP in sandboxed code stayed unintercepted.
- `SubagentStart` command hook `cat hooks/subagent-nudge.json`: subagents get their own system prompt and do not inherit the `SessionStart` document, so a short nudge told them (a) not to narrate between tool calls and (b) to prefer the `ctx_*` tools. The file must be the JSON envelope `{"hookSpecificOutput":{"hookEventName":"SubagentStart","additionalContext":"…"}}`: plain stdout is delivered as context only for `UserPromptSubmit`, `UserPromptExpansion`, `SessionStart` and `PostModelSwitch`; on `SubagentStart` it only reaches the debug log.
- Static per-call tips (upstream's `<context_guidance><tip>` hooks on Bash, Grep, Read) were rejected: they restate the session document at a per-call token cost.

### Deny-steering (`steer_enabled`)

Advice became enforcement: a deny whose reason carries a complete, copy-ready replacement call with the full namespaced tool name, plus "do not retry via Bash/WebFetch" so the model cannot loop on the denial.

| Denied call                                                         | Replacement in the deny reason                                      |
| ------------------------------------------------------------------- | ------------------------------------------------------------------- |
| every `WebFetch`                                                    | `ctx_fetch_and_index({url, source: <hostname>})`, then `ctx_search` |
| Bash: one bare `curl` GET of an `http(s)` URL                       | same as `WebFetch`                                                  |
| Bash: ≥ 3 chained segments (`&&`, `\|\|`, `;`), all heads read-only | `ctx_batch_execute(commands: [{label, command}…], queries)`         |
| Bash: a ≥ 3-stage pipeline, all heads read-only (≤ 2 segments)      | `ctx_execute({language: "shell", code})`                            |

Classifier (`splitTopLevel`, `commandHead`, `classifyBashCommand`), conservative by construction: anything it does not understand stays in Bash.

- Lexer honours single and double quotes and backslash escapes, and returns "stay" on command substitution (`$(`, backticks), redirects and heredocs (`>`, `<`, including `2>&1`), subshells and brace groups (`{…}` other than `${` and brace-expansion commas), background `&`, comments, newlines and unbalanced quotes.
- `commandHead` skips leading `VAR=value` assignments and a leading `command`.
- Read-only heads: `grep egrep fgrep rg find cat head tail awk sort uniq wc cut tr jq ls stat du df diff comm column nl file basename dirname realpath`. Any other head (`git`, `gh`, `sed`, `xargs`, `echo`, unknown binaries) means stay.
- `curl` stays when any token is an upload, method or output flag (`--data`, `--form`, `--upload-file`, `--output`, `--remote-name`, `--request`, `--json`, …, or a short-flag cluster containing one of `o d O F T X D`). `wget` always stays: its default is a file download, a side effect the steer cannot reproduce.
- `run_in_background: true` calls are never steered: `ctx_*` tools cannot background.
- WebFetch has no classifier: every URL steers.
- The hooks do not check MCP connectivity; `steer_enabled: false` is the escape hatch when context-mode is down. A deny pointing at an unavailable tool strands the model.

Known trade-off: `ctx_execute` and `ctx_batch_execute` run shell and code that no `Bash` hook observes (neither rtk nor another plugin's deny gates). Steering widens that bypass on purpose, limited to read-only gathers.

Not steered, on purpose: `Grep`, `Glob`, `Read` (cbm's domain, section 4).

## 4. codebase-memory-mcp proxy and graph-context hooks

[codebase-memory-mcp](https://github.com/DeusData/codebase-memory-mcp) is a code-graph MCP server (15 tools: `index_repository`, `search_graph`, `index_status`, `list_projects`, `check_index_coverage`, …).

### Proxy server (`mcp/server.mjs`)

- A zero-dep Node stdio MCP server registered directly as the `.mcp.json` `command` (no launcher). It downloads cbm (section 2), spawns it once as a long-lived MCP child (up to 3 restarts) and forwards `tools/call` verbatim with remapped JSON-RPC ids; `isError`, `content` and `structuredContent` pass through untouched.
- `tools/list` is served from a committed snapshot (`cbm-tools.json`) so the handshake never waits on the download. Forwarding is name-agnostic: a stale snapshot costs advertisement, never a working call.
- The model's own graph calls and the hooks share one warm child: one place that talks to cbm and peels its envelope; an `mcp_tool` hook costs a round-trip, not a process plus a 280 MiB exec.
- `cbm_enabled: false` (read from `CLAUDE_PLUGIN_OPTION_CBM_ENABLED`, injected via `.mcp.json` `env`): the server exits 0 immediately, never touches the network.

### The four context hooks

All inject `additionalContext` only; they never block, deny or rewrite. Each returns either `{}` or `{hookSpecificOutput: {hookEventName, additionalContext}}`, with `hookEventName` hardcoded per tool.

| Event                     | Hook type                                                  | Tool                    | Injects                                                                                     |
| ------------------------- | ---------------------------------------------------------- | ----------------------- | ------------------------------------------------------------------------------------------- |
| `SessionStart`            | command (`server.mjs --session-start-hook`, `async: true`) | `hook_session_context`  | graph project covering the repo, its index state, "prefer the graph tools over text search" |
| `SubagentStart`           | `mcp_tool`                                                 | `hook_subagent_context` | the same, shorter, plus "pass qualified symbols and paths through when delegating"          |
| `PreToolUse` `Grep\|Glob` | `mcp_tool`                                                 | `hook_symbol_context`   | up to 10 matching qualified symbols with `file:line` (`search_graph`, `format: "json"`)     |
| `PostToolUse` `Read`      | `mcp_tool`                                                 | `hook_coverage_context` | a warning only when `check_index_coverage` reports a real gap for that file                 |

- Output capped at 1500 characters, search pattern at 200. Each child call has a 4 s budget; hook `timeout: 20` covers two calls plus a cold handshake.
- Silence rules: no matching graph project (indexing is never suggested or started), empty or unrecognized payloads, timeouts, download in flight. Coverage: `coverage_lookup === "error"` or `status === "coverage_unavailable"` is checked first and means silence; otherwise only `status`/`freshness`/`recommended_action` matching `/not[_ -]?indexed|skipped|exclud|partial|unsupported|stale|source_newer|reindex/i` or `indexed/covered === false` warn. No signal is not evidence of a gap; warning there would fire on every `Read`.
- cbm results are `{content: [{type: "text", text: "<json>"}], isError}`; skipping the peel (`unwrapToolResult`) leaves every hook silent. `search_graph`'s JSON is `{cols, groups: [{qn_prefix, file, rows}]}`, read by `cols` index lookup. Re-probe these shapes on each upstream release.
- Per-cwd project cache: `cwd → project` mapping as one JSON file per sha256(cwd) under `<bundle cache>/project-cache`, TTL 10 min, atomic temp-file rename, every failure swallowed. A warm repo pays one cbm call per hook instead of two (`list_projects` skipped).
- A relative `file_path` is resolved against the hook's `cwd`, never the long-lived server's `process.cwd()`.

## 5. Terse output style

`output-styles/terse.md` with frontmatter `force-for-plugin: true` (applied whenever the plugin is enabled, overriding the user's `outputStyle`) and `keep-coding-instructions: true` (only response form changes). Body: multi-level bullets by default, prose only where bullets cannot carry it or the user asked for prose, no preamble/postamble/restating/narration, feedback once, one fact per bullet. It governs the main conversation only, takes effect on a new session or `/clear`, and was the plugin's one OS-independent component. No toggle: static frontmatter cannot be driven by `userConfig`.

## Harness facts learned (still valid input for inline-headroom)

- `mcp_tool` hooks are rejected on `SessionStart` (`mcp_tool hooks are not available for the 'SessionStart' hook event (no MCP client context)`); use a command hook there.
- An `mcp_tool` hook's `server` is the namespaced `plugin:<plugin>:<server-key>`; the bare `.mcp.json` key is "not connected" on every fire.
- An `mcp_tool` hook without an explicit `input` block receives `{}`, not the hook JSON. `${…}` substitution is string-only.
- Command hooks read `userConfig` via `CLAUDE_PLUGIN_OPTION_<KEY>` env vars; `${user_config.*}` in a command hook's `command` hard-errors when the plugin was never configured and is rejected outright from Claude Code 2.1.207. A mods module reads options from `register(on, options)`; an options change reloads the module.
- `SubagentStart` command-hook stdout is not delivered as context unless it is the `hookSpecificOutput` JSON envelope.
- Claude Code appends each enabled plugin's `bin/` to the Bash `PATH`; that does not apply to MCP-server spawning.
- `async: true` on a read-only `SessionStart` command hook moves its context to the next turn instead of blocking startup; `asyncRewake` is pointless without an exit-2 path.
- A mods `tool.call` deny is `return { deny: "<reason>" }`; a rewrite is `next({ ...e, command })`. The engine skips a throwing hook (`claude plugin validate` reports "gating hook without .catch").

## Porting notes for inline-headroom

inline-headroom already compresses tool results after the fact (`session.append`, door `tool-result`) and owns one `tool.call` hook. The old plugin worked before the call (rewrite, deny-steer) and around it (context injection). If any part is ported:

- Bash rewrite and steer fit inline-headroom's existing `tool.call` hook: a second matcher-less registration of an event fails validation (see `docs/claude-code-verification.md`). The old plugin ran two `tool.call` hooks with distinct matchers (`{ tool: "Bash" }`, `{ tool: "WebFetch" }`); a matcher hook beside inline-headroom's matcher-less one is unverified. Keep steer before rewrite, and keep the pure classifier and deny builders in `src/hooks/policy.mts` with every `$` use in `register.mts`.
- Decide how a pre-call rtk rewrite and inline-headroom's post-call compressors interact before enabling both: rtk-compressed output may defeat or duplicate the log, search and diff compressors.
- Steering depends on an external MCP server inline-headroom does not ship; the deny must name the namespaced tool of whichever plugin registers it, and needs an off switch for when that server is down.
- Binary downloads into `~/.local/bin` or a plugin cache are state-creating; inline-headroom's toggle convention makes such toggles fail-closed.
- The context-mode `SessionStart` document and the cbm hooks add per-session and per-call tokens; measure against inline-headroom's `/headroom` counters before reintroducing any.
- Prior history: context-mode was integrated and removed twice in kwitsch/claude-plugins (the `cave-context` plugin, and an optional accelerator in `coding-toolbox`/`cc-knowledge` that measured no gain over rtk for git/gh/glab commands). The 0.4.0+ shape (external server + verbatim rules + deny-steering) was a deliberate revisit.
