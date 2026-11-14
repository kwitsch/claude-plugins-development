---
name: bughunt
description: Run a structured bug hunt on a plugin in this repository - parallel read-only reviewer agents that must prove each finding with a repro, fixes with tests that fail without them, live checks, and an honest final claim. Use when the user asks for a bug hunt, a deep review, "find all bugs", or a final verification of a plugin before merge.
argument-hint: "<plugin-name> [areas...]"
---

# bughunt

Worked out on the dprint plugin (16 rounds, about 40 confirmed defects). The method matters more than the number of rounds.

## Start: worktree

Before anything else check whether the session already is in a linked git worktree (`git rev-parse --git-dir` ends in `/worktrees/<name>` or `git rev-parse --git-common-dir` differs from `--git-dir`). If not, call `EnterWorktree` (load it via ToolSearch if deferred) with a name like `bughunt-<plugin>` and switch to a `fix/<plugin>-bughunt` branch; never nest. A pure review request stays read-only, but the reviewers' scratch files and the checkout still belong in the worktree, not in the user's checkout.

## Round

1. **Split the plugin into areas** (protocol/server, core logic, scripts/skills, hooks wiring + docs). One read-only reviewer per area, run in parallel (`Agent`, `subagent_type: general-purpose`, `model: opus`, effort medium); fixes and the closing pass, when delegated to agents, run on `model: sonnet`, effort medium.
2. **Brief each reviewer**: worktree path, plugin name, what was already fixed (so it does not re-report), the area, "READ-ONLY on the repo", scratch dir under the session scratchpad, **report only CONFIRMED defects with a repro and its output, severity and a minimal fix; say 'none found' with the list of what you checked**; "high bar: no style, speculation or documented limitations". Ask for real tools where possible (real dprint/git/node, the built `plugin/` output, the test stub of the plugin) instead of reading alone.
3. **Triage each finding yourself** (read the code, rerun the repro). Fix the root cause once in the shared code. **Add a test that fails without the fix** (revert the line to check); a regression test that passes on the old code proves nothing. Rebuild, `pnpm lint`, `pnpm --filter <plugin> test`.
4. **Commit and push after each batch** only when the task authorizes repository changes (a request for a PR or for fixes); a pure review or verification request stays read-only and reports findings. Bump the version once per PR.
5. **Next round with a new lens** on the _newest_ diff plus one fresh angle (interactions between fixes, TOCTOU, caches keyed too coarsely, slow file systems, unusual file names/encodings, resource leaks, fail-open paths, docs contradicting code, tests that cannot fail). The newest fix is the most likely place for the next defect: three rounds in a row found a regression introduced by the previous fix. After a performance worklist, give every cache, buffer and merged request it added one round on its invalidation points (`.claude/rules/hook-caches-and-tests.md`).

## Also do

- **Tests audit**: revert each change one at a time in a scratch copy and see whether any test fails; add what is missing. Check temp dirs, env restore (`PATH`/`HOME`/other env in `finally`), leaked processes, timing thresholds (`>= 290` for a 300 ms timer), flakiness over 5 runs and `--sequence.shuffle`. A negative test whose cases all run in a world where an earlier gate already returns nothing cannot fail: give each case a world where only its own gate blocks. A selection rule (which of several candidates wins) needs a test with several candidates. Every flag on a regex (`m`, `i`) and every TTL or reset branch gets a test that fails without it. Isolate user-level config of external tools (`HOME`, `XDG_CONFIG_HOME`, tool env such as `YAMLLINT_CONFIG_FILE`): a test that passes in CI fails on a machine with `~/.config/<tool>`.
- **Randomized test** for the central invariant, seeded (mulberry32) so it is deterministic; run a bigger independent fuzz against the real tool once.
- **Docs audit**: every number, default, limit, env var and event name in README, rules and docs must match the source. A claim about what an external tool does ("never edits X", "writes only Y") is checked by running it under a temp `HOME` and `CLAUDE_CONFIG_DIR` and listing what it wrote; after any fix that changes a path or env var, grep the README for the old one.
- **Live checks** with the `live-verify` skill for the flows the tests cannot cover.
- **Final gate**: the repository's `/code-review high` on the whole branch, then CI green on the head commit (`gh pr checks`).

## Close: learnings

At the end of the hunt, before the final report, check what the hunt taught that holds beyond this plugin:

1. List the confirmed defect classes and the Claude Code / tool behaviours you verified (compare with `.claude/rules/hook-file-safety.md`, `.claude/rules/claude-code-hook-facts.md`, `.claude/rules/plugin-docs-tasks.md` and the other rules and skills).
2. For each, decide: new general fact or defect class, correction of an existing rule or skill, or plugin-specific (stays in the plugin's `docs/` and rules). Only what other plugins of this repository can use, written generally (no plugin names in the rule text except as the source), goes into `.claude/rules/*.md` (with `paths:`) or `.claude/skills/`.
3. Apply the additions and corrections in the same PR, say in one line which rules or skills changed (or that nothing new qualified).

## What to claim

Never claim "no bugs". A clean round only means that round found nothing; earlier clean rounds were repeatedly followed by new defects. Report: what was checked, what was fixed, which limits stay unexercised and why (for example a downloaded installer that auto mode will not run, a mount that was not available).

## Session mechanics learned

- A worktree-isolated session refuses compound commands (`cd x && git ...`, long pipelines, heredocs with git): put multi-step edits into a small node/python script under the scratchpad and run it with one plain command; run git/pnpm from the worktree root.
- Edit big literal blocks with a node script that throws when the anchor text is missing (`replace` silently doing nothing is the failure mode).
- Reviewer agents that run `claude` with `--dangerously-skip-permissions` are denied by auto mode; run nested `claude -p` yourself with `--allowedTools` narrowed instead.
- Do not run a downloaded script that auto mode refuses, and do not work around the refusal; read downloaded scripts first (the dprint installer runs `pkill -9 dprint`).
