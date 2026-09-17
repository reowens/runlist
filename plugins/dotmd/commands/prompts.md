---
description: "runlist saved-prompt queue — see pending prompts, consume one, or queue a new resume prompt"
allowed-tools: "Bash(runlist:*), Bash(rl:*), Bash(dotmd:*), Read"
---

Run `Bash(runlist prompts list)` to show the saved-prompt queue (pending / held / archived), then help the user.

Saved prompts (`docs/prompts/*.md`) are **session-local handoff artifacts**, not source code. Handle them only through runlist:

- **Consume** (read + archive atomically): `runlist use <file>` — or `runlist use` with no arg for the oldest pending. This is how you "load", "resume", or "open" a prompt. **Never `cat` it, Read it with the file tool, or copy its body into chat**, and **never `git add`/`commit` it** (the dir is often gitignored). The PreToolUse guard blocks these.
- **Peek / triage** (no archive): `runlist prompts show <file>` for one, `runlist prompts show --all` (`--limit N`) to survey the whole pending queue in a single call. Use this whenever the user wants to know what's queued without acting on it — never Read the files one by one.
- **Queue a new one** (e.g. a resume prompt for the next session): `runlist new prompt <slug> @/tmp/draft.md` (or `-` for stdin, `--message "…"` for one-liners). The next session sees it at SessionStart.
- **Admin**: `runlist prompts hold <file>` / `unhold <file>` (the "saved but not next" bucket), `runlist prompts archive <file>`.

If the user references a specific `docs/prompts/*.md` file — "resume via …", "use this prompt", "load that one" — consume it with `runlist use <file>`. See the **dotmd** skill for the full workflow.
