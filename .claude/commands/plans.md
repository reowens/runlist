<!-- dotmd-generated: 0.11.0 -->

Run `dotmd context` to get the current plans briefing, then use it to orient yourself.

Plans are managed by **dotmd** (v0.11.0). Config at `dotmd.config.mjs`. Always use `dotmd` directly.

Plan-specific commands:
- `dotmd context` — briefing with active/paused/ready plans, age tags, next steps
- `dotmd health` — plan velocity, aging, checklist progress, pipeline view
- `dotmd unblocks <file>` — what depends on / is blocked by a plan
- `dotmd next` — ready plans with next steps (what to promote)
- `dotmd new <name> --template plan` — scaffold with full phase structure
- `dotmd archive <file>` — archive with auto ref-fixing (both directions)
- `dotmd bulk archive <files>` — archive multiple at once
- `dotmd status <file> <status>` — transition status
- `dotmd query --keyword <term>` — find plans by keyword

If the user asks about a specific plan, read its file directly (path is in the briefing or findable via `dotmd query --keyword <term>`).

If the user asks to change a plan's status, use `dotmd status <file> <status>`.
If the user asks to archive a plan, use `dotmd archive <file>`.
