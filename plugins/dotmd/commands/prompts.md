---
description: "dotmd saved-prompt queue — see pending prompts, consume one, or queue a new resume prompt"
allowed-tools: "Bash(dotmd:*), Read"
---

Run `Bash(dotmd prompts list)` to show the saved-prompt queue (pending / held / archived), then help the user.

Saved prompts (`docs/prompts/*.md`) are **session-local handoff artifacts**, not source code. Handle them only through dotmd:

- **Consume** (read + archive atomically): `dotmd use <file>` — or `dotmd use` with no arg for the oldest pending. This is how you "load", "resume", or "open" a prompt. **Never `cat` it, Read it with the file tool, or copy its body into chat**, and **never `git add`/`commit` it** (the dir is often gitignored). The PreToolUse guard blocks these.
- **Queue a new one** (e.g. a resume prompt for the next session): `dotmd new prompt <slug> @/tmp/draft.md` (or `-` for stdin, `--message "…"` for one-liners). The next session sees it at SessionStart.
- **Admin**: `dotmd prompts hold <file>` / `unhold <file>` (the "saved but not next" bucket), `dotmd prompts archive <file>`.

If the user references a specific `docs/prompts/*.md` file — "resume via …", "use this prompt", "load that one" — consume it with `dotmd use <file>`. See the **dotmd** skill for the full workflow.
