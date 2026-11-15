# Mining session transcripts for hook behaviour

How to measure from the local transcripts what a hook really did across many sessions: how often it reported, to whom, how long after which edit.

Record shapes this relies on: [claude-code-command-hooks.md](../facts/claude-code-command-hooks.md). First use: universal-lint task F40 (`universal-lint/docs/tasks/F40-mid-edit-findings.md`), 133 wake-ups over nine days.

## Where the data is

- `~/.claude/projects/<slug of the cwd>/<session id>.jsonl` is a session's main transcript; `<session id>/subagents/**/*.jsonl` are its subagents (workflow agents sit in nested folders, so walk recursively).
- One JSON object per line. Useful `type`s: `assistant` (content blocks, among them `tool_use` with `name`, `input`, `id`), `user`, `attachment`, `queue-operation`. `api-request-blob` lines repeat earlier content: skip them or every hit counts several times.

## Recipe

1. Select sessions by file mtime, and keep only lines that contain the hook's text before parsing (a full parse of every line is slow).
2. Count events from `queue-operation` records with `operation: "enqueue"`: one per report, with the timestamp of the hook's exit. Do not count `hook_blocking_error` (headless only) or the delivery records (each report would count twice).
3. Find the delivery of each report: a `user` record with the same string (a turn of its own) or an `attachment` `queued_command` with the same `prompt` (absorbed into the running turn). Match on equal content and a timestamp at or after the enqueue.
4. Collect every `tool_use` of `Write` and `Edit` from the main transcript and from all subagent transcripts of the session, each tagged with its origin. The triggering edit of a report is the last edit of the reported file before the enqueue; bound the search (the hook timeout plus a margin), or an old edit of the same file in the main transcript is taken for the trigger.
5. Derive per report: who triggered it (main or subagent), the gap from trigger to report, edits of the same file between report and delivery, the time until the next edit of the same file, the rule ids in the text.
6. Read the first assistant text after the delivery for a sample of reports: it shows whether the report was acted on.

## Traps

- A hook can report under more than one prefix (universal-lint's FileChanged findings start with `universal-lint (changed outside Write/Edit):`). A pattern built for one prefix silently misses the others; count them separately first.
- Do not keep whole transcripts in memory while joining: a few hundred subagent files exhaust a 2 GB heap. Keep the extracted edits and re-read a file only when its text is needed.
- An assistant message's timestamp is when the block was written, not when the tool ran; gaps under a second are noise.
- The running session's own transcript matches every search term the analysis itself used: exclude it or expect false hits.
- Transcripts hold the user's prompts and file contents. Keep mining scripts and their output in the session scratchpad, and write only aggregated numbers into the repository.
