---
description: Save a resume prompt for the active plan and close it out — the minimum handoff. Use when the user says hand off / save a resume / wrap up, or when context is getting tight.
---
<!-- dotmd-generated: 0.49.5 -->

Wrap this session. Two commands:

1. **Save the resume prompt.** `dotmd new prompt resume-<plan-slug>` — pipe stdin or pass `@path`. 10-20 line body: the next concrete decision plus any gotchas. NOT a recap of the plan body. The saved prompt IS the handoff — never print it into chat for copy-paste.

2. **Close out via `dotmd set <status>`.** Pick the status that matches reality:
    - `dotmd set active <file>` — work continues, return the plan to the active queue
    - `dotmd set archived <file>` — fully shipped (also: `dotmd archive <file>`)
    - `dotmd set paused <file>` / `awaiting <file>` / `partial <file>` / `blocked <file>` — when the status really changed
  `set` clears the in-session marker automatically when transitioning to any other status.

If you don't already know which plan you have in-session: `dotmd hud --json` and read `.owned`. Do NOT use `dotmd plans --status in-session` — that lists every session's in-session plans, not just yours.

The next session's `dotmd hud` (SessionStart hook) surfaces the pending prompt automatically.
