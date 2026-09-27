---
name: runlist
description: Manage a repository's plans, docs, decisions, and saved prompts with the runlist CLI. Use when starting or closing plan work, checking the plan queue, or creating or consuming a handoff.
---

# Runlist workflow

Use this skill in repositories with `runlist.config.mjs` or `dotmd.config.mjs`. The CLI is `runlist` (from `dotmd-cli`; `dotmd` remains an alias). The session hook prints a short live orientation. `CODEX_THREAD_ID` is the session identity used for plan claims; do not replace it with a process ID.

- Orient with `runlist plans`. Use `runlist agent-context` for structured state; `runlist briefing` is the comprehensive view and can be large.
- Start plan work with `runlist use <plan-file>`. It claims the plan, marks it `in-session`, and prints the card.
- Change status with `runlist set <status> <file> [--note "why"]`; this runs validation, lifecycle hooks, ref repairs, and index updates. Never hand-edit a `status:` field.
- Close a shipped plan with `runlist archive <file>`; use `partial`, `active`, `awaiting`, or `blocked` when those match the actual state. Valid statuses are repository and type specific: `runlist statuses list --type plan`.
- For a handoff, write a concrete resume draft, then run `runlist baton [<plan-or-slug>] @<draft-file>`. An owned plan is released in the same operation. If a handoff for that work is pending, inspect it with `runlist prompts show <file>`; keep it if current or pass `--replace` with the new draft. Replacement archives the old text and refreshes exactly one pending prompt.
- Consume a saved prompt with `runlist use <prompt-file>` (or bare `runlist use` for the oldest). This archives and claims before printing the body. For read-only triage, use `runlist prompts show <file>` or `runlist prompts show --all`; never open pending prompts with a file reader or `cat`.
- Pending prompts are session-local. Commit the tracked plan or source files named by baton, not `docs/prompts/*.md`.
- Create a document with `runlist new <type> <name> @<draft-file>`. A draft starting with frontmatter can supply scaffold fields; `type` is fixed by the command.
- Record a decision with `runlist new decision <plan> --question "…" @<record-file>`; configured registers may also require `--answers`.
- If a lifecycle mutation reports an abandoned transaction, inspect `runlist doctor --transactions` before retrying. Use `--apply` only for cases the doctor identifies as recoverable.

The `PreToolUse` hook warns on direct pending-prompt reads and denies hand-edited status transitions or Git operations that would include a live prompt. A repo can opt into blocking direct reads of existing pending prompts with `guard: { promptReads: 'deny' }`. Archived prompts and `runlist prompts show` remain readable. Codex requires explicit trust of a plugin's hooks before they run.
