---
description: "runlist saved-prompt queue — see pending prompts, consume one, or queue a new resume prompt"
allowed-tools: "Bash(runlist:*), Bash(rl:*), Bash(dotmd:*), Read"
---

Run `Bash(runlist prompts list)` to show the saved-prompt queue (pending / held / archived), then help the user.

Saved prompts (`docs/prompts/*.md`) are **session-local handoff artifacts**, not source code. Handle them only through runlist:

- **Consume** (read + archive atomically): `runlist use <file>` — or `runlist use` with no arg for the oldest pending. This is how you "load", "resume", or "open" a prompt. It consumes only inside an agent session; a plain terminal gets the body and the command to run, and the prompt stays pending. **Never `cat` it, Read it with the file tool, or copy its body into chat**, and **never `git add`/`commit` it** (the dir is often gitignored). The PreToolUse guard blocks these.
- **Peek / triage** (no archive): `runlist prompts` surveys names; `runlist prompts show a b c` peeks selected bodies in one call. Use `runlist prompts show --all --limit N` for a capped batch. Use these when the user wants to know what's queued without acting on it — never Read the pending files.
- **Queue a new one** (e.g. a resume prompt for the next session): `runlist new prompt <slug> @/tmp/draft.md` (or `-` for stdin, `--message "…"` for one-liners). The next session sees it at SessionStart.
- **Admin**: `runlist prompts hold <file>` / `unhold <file>` (the "saved but not next" bucket), `runlist prompts archive <file>`.

If the user references a specific `docs/prompts/*.md` file — "resume via …", "use this prompt", "load that one" — consume it with `runlist use <file>`. See the **runlist** skill for the full workflow.
