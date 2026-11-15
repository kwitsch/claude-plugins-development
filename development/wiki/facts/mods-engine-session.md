# Mods engine: transcript rows, prompts, slash commands, compaction and usage

What `$.session.messages` returns, how prompts and slash commands a plugin raises are queued, what a `session.compact` hook replaces, and which usage figures a mod can see.

Basics (meta rows omitted, state resets, `$.command.run` resolving after the compaction, `prompt.submit` `turnId`) are in [claude-code-hook-facts.md](../../../.claude/rules/claude-code-hook-facts.md).

## `$.session.messages` rows

- Every tool result sits twice in the rows: in the assistant row's `toolUses[i].text` and in the following user row's `toolResults[i].text` (user rows have `toolUses: []`). Read results from one side only; a reader that walks both double-counts (binary 2.1.322).
- Row shapes seen (live 2.1.325):
  - a compaction summary is a user row starting `This session is being continued from a previous conversation that ran out of context.`; after a mid-turn auto-compact the list holds only the summary onward, after a manual `/compact` earlier rows stay
  - an Esc interrupt is the user row `[Request interrupted by user]`
  - a `!` command starts its own model turn with rows `<bash-input>..` and `<bash-stdout>..<bash-stderr>..`
  - an image-only SDK prompt is a user row with text `""`
  - a local command is a `<command-name>/x</command-name>` plus `<command-message>` row (`/cost` shows as `/usage`); a slash-command skill's turn shows only its `<command-message>/<command-name>/<command-args>` row, the expanded skill text is absent
  - long pasted text arrives as `<pasted_content id=..>` text
  - absent from the list: `@file` attachments, hook `additionalContext`, user messages queued mid-turn
- A prompt a plugin submits with `$.prompt.submit` is stored and returned wrapped: `The <plugin> plugin sent a message:\n<text>\n\nThis is how Claude Code surfaces a prompt a plugin submits between turns ...` (live 2.1.325).
- A user prompt may itself begin with a transcript tag (`<system-reminder>`, `<bash-stdout>`) followed by own text: classify a row as transcript-only by matching the whole row, never a prefix (kit probe, 2026-11-14).

## `prompt.submit` origins

- `origin.kind` is `composer` for a typed prompt, `sdk` for a `claude -p` or SDK prompt, `plugin` (with `name`) for a `$.prompt.submit`, which reaches the calling plugin's other hooks, and `task-notification` for a background-task notice, whose `isMeta` is undefined (typings, live 2.1.325).
- Slash commands never go through `prompt.submit` (binary 2.1.322).

## `$.command.run`

- It does not run in place. It enqueues `/<cmd> <args>` as a prompt-mode queue entry with priority `later` and origin `plugin`; the queue drains only when the turn guard is idle, and a user prompt reserves the guard at the start of its processing. A timer-issued `/compact` that lands between prompt submit and the first `turn.step` therefore runs after the user's turn (binary 2.1.322).
- It is not refused from a `$.clock.every` callback after the hook frame ended (binary 2.1.322, not run live).
- It rejects at once when the command is not enabled (`DISABLE_COMPACT`) or the session was stopped and nobody has sent input since; later when the entry is removed from the queue, interrupted, or the command threw (binary 2.1.322).
- `/compact` answers `Not enough messages` and `Compaction failed` as `{ text, level: "error" }`: the promise resolves although nothing was compacted (binary 2.1.322).

## `session.compact`

- A hook that answers `{ messages }` without calling `next()` makes core never run. Skipped then: classic `PreCompact` hooks (a blocking one is ignored and its stdout never becomes instructions), the post-compact attachments (recently read files, plan file, invoked skills) and every lower `session.compact` hook including the builtin one that re-attaches agent instructions. Still run: `PostCompact` (with an empty `compact_summary`) and `SessionStart(compact)` hooks (binary 2.1.322).
- A `precompute` dispatch happens only when a server flag is on and the context is at about 80% of the window or more (binary 2.1.322).

## Usage and cache

- `turn.step` usage is `{ input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens, model }` only. The API's `cache_creation` breakdown is dropped, so a mod cannot see whether the prompt cache has a 5-minute or a 1-hour lifetime. The real lifetime is 5 minutes with an API key, Bedrock, Vertex or Foundry, and 1 hour on a subscription within its limits; the setting `promptCacheTtl` and the environment variables `CLAUDE_CODE_PROMPT_CACHE_TTL` and `FORCE_PROMPT_CACHING_5M` override it (binary 2.1.322).
- `$.session.usage()` without `breakdown` is a synchronous in-memory read. With `{ breakdown: "summary" }`, `context.breakdown.isAutoCompactEnabled` follows Claude Code's own rule: not `DISABLE_COMPACT`, not `DISABLE_AUTO_COMPACT`, and the auto-compact setting on (binary 2.1.322).
- `$.agent.list()` gives each agent's `status` (`running`, `completed`, `failed`, `killed`, ...). Background shell tasks are not visible to `$`; only a classic `Stop` hook's `background_tasks` lists them (typings).
