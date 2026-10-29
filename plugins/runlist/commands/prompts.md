---
description: "See saved handoffs and prompts waiting for a later session, load one, or queue a new one"
when_to_use: "Use when the user asks what handoffs or saved prompts are waiting, wants to look at one without loading it, or wants to queue a reminder for a later session."
allowed-tools: "Bash(runlist:*), Bash(rl:*), Bash(dotmd:*), Read"
---

Run `Bash(runlist prompts list)` to show the saved-prompt queue (pending / held / archived), then help the user.

Saved prompts (`docs/prompts/*.md` unless the project configured another folder; `runlist config get promptDirectory` says which) are handoff artifacts with a project-selected Git policy. Handle them only through runlist:

- **Consume** (read + archive atomically): `runlist use <file>` — or `runlist use` with no arg for the oldest pending. This is how you "load", "resume", or "open" a prompt. It consumes only inside an agent session; a plain terminal gets the body and the command to run, and the prompt stays pending. **Never `cat` it, Read it with the file tool, or copy its body into chat**. Inspect `runlist config get promptTracking` for Git policy: `untracked` warns, `tracked` allows, `local` denies pending-prompt Git operations. Untracked is not ignored; broad staging can include prompts.
- **Peek / triage** (no archive): `runlist prompts` surveys names; `runlist prompts show a b c` peeks selected bodies in one call. Use `runlist prompts show --all --limit N` for a capped batch. Use these when the user wants to know what's queued without acting on it — never Read the pending files.
- **Queue a new one** (e.g. a resume prompt for the next session): `runlist new prompt <slug> @<draft-file>` (or `-` for stdin, `--message "…"` for one-liners). The next session sees it at SessionStart.
- **Admin**: `runlist prompts hold <file>` / `unhold <file>` (the "saved but not next" bucket), `runlist prompts archive <file>`.

If the user references a specific `docs/prompts/*.md` file — "resume via …", "use this prompt", "load that one" — consume it with `runlist use <file>`. See the **runlist** skill for the full workflow.
