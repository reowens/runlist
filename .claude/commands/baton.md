---
description: Save a resume prompt for the held plan and release the lease — the minimum handoff. Use when the user says hand off / save a resume / wrap up, or when context is getting tight.
---
<!-- dotmd-generated: 0.39.9 -->

Wrap this session. Minimum required (two commands):

1. **Save the resume prompt.** `dotmd new prompt resume-<plan-slug>` with a 10-20 line body via heredoc: the next concrete decision plus any gotchas. NOT a recap of the plan body. The saved prompt IS the handoff — never print it into chat for copy-paste.

2. **Release the lease.** `dotmd release` — or `dotmd archive <file>` if the work is fully shipped (archive auto-releases).

Optional, only when genuinely needed:
- Status really changed (paused / awaiting / partial / blocked): `dotmd status <file> <status>` BEFORE `dotmd release`.
- Plan dashboard text is misleading the user: edit `next_step:` in the plan frontmatter. Cosmetic — the next session reads the resume prompt, not the plan frontmatter.

If you don't already know which plan you hold: `dotmd hud --json` and read `.owned`. Do NOT use `dotmd plans --status in-session` — that lists every session's holdings, not just yours.

The next session's `dotmd hud` (SessionStart hook) surfaces the pending prompt automatically.
