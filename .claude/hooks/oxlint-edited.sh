#!/usr/bin/env bash
# PostToolUse hook (Write|Edit, asyncRewake): runs oxlint with the repo's root .oxlintrc.json on the edited
# .ts/.mts file in the background. Findings: exit 2, which wakes Claude with them (stderr). Otherwise exit 0.
f=$(jq -r '.tool_input.file_path // empty')
case "$f" in *.ts | *.mts) ;; *) exit 0 ;; esac
[ -f "$f" ] || exit 0
cd "$CLAUDE_PROJECT_DIR" || exit 0
out=$(pnpm exec oxlint --deny-warnings "$f" 2>&1) && exit 0
# a file the config ignores (plugin/**, .claude/**) is no finding
case "$out" in *"No files found to lint"*) exit 0 ;; esac
printf 'oxlint findings in %s:\n%s\n' "$f" "$out" >&2
exit 2
