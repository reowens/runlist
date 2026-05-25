<!-- dotmd-generated: 0.32.1 -->

Run `dotmd context` to get the current plans briefing, then use it to orient yourself.

Plans are managed by **dotmd** (v0.32.1). Config at `dotmd.config.mjs`. Always use `dotmd` directly.

Plan-specific commands:
- `dotmd context` — briefing with active/paused/ready plans, age tags, next steps
- `dotmd pickup <file>` — pick up a plan (set in-session + print body)
- `dotmd release` — release current session's leases (alias: unpickup)
- `dotmd health` — plan velocity, aging, checklist progress, pipeline view
- `dotmd unblocks <file>` — what depends on / is blocked by a plan
- `dotmd actionable` — ready plans with next steps (what to promote)
- `dotmd new plan <name>` — scaffold with full phase structure
- `dotmd prompts new <name> "<body>"` — save a resume-prompt to docs/prompts/
- `dotmd prompts next` — consume oldest pending prompt (prints body, auto-archives)
- `dotmd prompts use <file>` — consume a specific prompt (prints body, auto-archives)
- `dotmd archive <file>` — archive with auto ref-fixing (both directions)
- `dotmd bulk archive <files>` — archive multiple at once
- `dotmd status <file> <status>` — transition status
- `dotmd query --keyword <term>` — find plans by keyword

If the user asks about a specific plan, read its file directly (path is in the briefing or findable via `dotmd query --keyword <term>`).

If the user asks to change a plan's status, use `dotmd status <file> <status>`.
If the user asks to archive a plan, use `dotmd archive <file>`.

**Saved prompts (`docs/prompts/*.md`):** if the user references a file under `docs/prompts/` — e.g. "resume via docs/prompts/foo.md", "use this prompt", "load that one" — consume it with `dotmd prompts use <file>` (atomically prints the body and archives the prompt so it cannot be double-consumed). Do NOT `cat` it, read it with the file-reading tool, or copy its body into chat. To pick the oldest pending prompt without naming a file, use `dotmd prompts next`.
