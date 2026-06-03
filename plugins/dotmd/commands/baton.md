---
description: "Save a resume prompt for the active plan and close it out — the minimum handoff. Use when the user says hand off / save a resume / wrap up, or when context is getting tight."
allowed-tools: "Bash(dotmd:*), Bash(git commit:*), Read"
---

Wrap this session. Three steps:

1. **Save the resume prompt.** `dotmd new prompt resume-<plan-slug> @/tmp/draft.md` (or `-` for stdin). 10–20 line body: the next concrete decision plus any gotchas — NOT a recap of the plan body. The saved prompt IS the handoff — never print it into chat for copy-paste. (`docs/prompts/` is usually gitignored — the prompt is local session state, do not commit it.)

2. **Close out via `dotmd set <status>`.** Pick the status that matches reality:
    - `dotmd set active <file>` — work continues; return the plan to the active queue
    - `dotmd set archived <file>` — fully shipped (also: `dotmd archive <file>`)
    - `dotmd set paused <file>` / `awaiting <file>` / `partial <file>` / `blocked <file>` — when the status really changed
  `set` clears the in-session marker automatically when transitioning to any other status.

3. **Commit the tracked changes.** `dotmd set`/`archive` edits the plan's frontmatter and (for archive) moves the file — those are git-tracked and must be committed: `git commit -m "..." -- <plan-path>` (archive: `-- <old-path> <new-path>` so git shows a rename). **Never add the generated plans index or `docs/prompts/**` to the pathspec — both are gitignored and will fail the commit.** The index regenerates itself.

If you don't already know which plan is in-session: `dotmd hud --json` and read `.owned`. Do NOT use `dotmd plans --status in-session` — that lists every session's in-session plans, not just yours.

The next session's `dotmd hud` (SessionStart hook) surfaces the pending prompt automatically. See the **dotmd** skill for the full workflow.
