---
description: dotmd-managed plan briefing for this repo. Use when the user asks what's on the plate, references a plan slug, queues work, or wants to start / close / archive a plan. Valid plan statuses: in-session, active, planned, blocked, partial, paused, awaiting, queued-after, archived. Valid doc statuses: draft, active, review, reference, deprecated, archived. Valid prompt statuses: pending, held, shelved, claimed, archived.
---
<!-- dotmd-generated: 0.50.1 -->

Run `dotmd context` to get the current plans briefing, then use it to orient yourself.

Plans are managed by **dotmd** (v0.50.1). Config at `dotmd.config.mjs`. Always use `dotmd` directly.

Plan-specific commands:
- `dotmd context` — briefing with active/paused/ready plans, age tags, next steps
- `dotmd set <status> [<file>]` — single status verb. Use this to start, transition, or close any plan:
    - `dotmd set in-session <file>` — start work on a plan (marks in-session + prints body)
    - `dotmd set <status> [<file>]` — transition to any other status; closes out the in-session marker automatically
    - `dotmd set archived <file>` — close out (same as `dotmd archive`)
- `dotmd archive <file>` — explicit archive with ref-fixing (equivalent to `set archived`)
- `dotmd bulk archive <files>` — archive multiple at once
- `dotmd new plan <name>` — scaffold with full phase structure
- `dotmd new prompt <name>` — save a resume-prompt to docs/prompts/ (pipe stdin or @path for body)
- `dotmd use` — consume oldest pending prompt (prints body, auto-archives)
- `dotmd use <file>` — open any doc by type: prompt → consume, plan → start work, doc → read
- `dotmd unblocks <file>` — what depends on / is blocked by a plan
- `dotmd actionable` — ready plans with next steps (what to promote)
- `dotmd query --keyword <term>` — find plans by keyword
- `dotmd runlist <hub>` — show ordered children of a runlist hub (→ marks next pickup)
- `dotmd runlist next <hub>` — pick up the next non-archived child of a runlist hub

If the user asks about a specific plan, read its file directly (path is in the briefing or findable via `dotmd query --keyword <term>`).

If the user asks to change a plan's status, use `dotmd set <status> <file>`.
If the user asks to archive a plan, use `dotmd set archived <file>` (or `dotmd archive <file>`).
If the user references a runlist by name — e.g. "what's next on <X> runlist", "<X> runlist status", "pick up the next in <X>" — use `dotmd runlist next <X>` (or `dotmd runlist <X>` first to inspect the ordering). Do NOT fall back to `dotmd context` for runlist-scoped questions.

**Saved prompts (`docs/prompts/*.md`):** if the user references a file under `docs/prompts/` — e.g. "resume via docs/prompts/foo.md", "use this prompt", "load that one" — consume it with `dotmd use <file>` (atomically prints the body and archives the prompt so it cannot be double-consumed). Do NOT `cat` it, read it with the file-reading tool, or copy its body into chat. To pick the oldest pending prompt without naming a file, run `dotmd use` with no arg.
