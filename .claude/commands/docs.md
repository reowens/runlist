<!-- dotmd-generated: 0.11.0 -->

All documentation in this repo is managed by **dotmd** (v0.11.0). Docs across 1 root: .. Config at `dotmd.config.mjs`.

Document types: `plan`, `doc`, `research`.

Commands for working with docs:
- `dotmd context` — LLM-oriented briefing across all types
- `dotmd check` — validate frontmatter, refs, body links (target: 0 errors)
- `dotmd doctor` — auto-fix everything in one pass (refs, lint, dates, index)
- `dotmd query [filters]` — search by status, keyword, module, surface, type, staleness
- `dotmd health` — plan pipeline, velocity, aging
- `dotmd stats` — doc health dashboard (completeness, checklists, audit coverage)
- `dotmd graph [--dot]` — visualize document relationships
- `dotmd deps [file]` — dependency tree
- `dotmd unblocks <file>` — impact analysis for a doc
- `dotmd diff [file]` — git changes since last updated date
- `dotmd list` — all docs grouped by status
- `dotmd focus <status>` — detailed view for one status group

Lifecycle:
- `dotmd new <name> --template plan` — scaffold new plan
- `dotmd status <file> <status>` — transition status
- `dotmd archive <file>` — archive with auto ref-fixing
- `dotmd bulk archive <files>` — archive multiple at once
- `dotmd touch --git` — bulk-sync updated dates from git history
- `dotmd lint --fix` — auto-fix frontmatter issues
- `dotmd fix-refs` — repair broken references and body links
- `dotmd rename <old> <new>` — rename doc + update all references
