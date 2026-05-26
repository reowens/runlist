---
description: dotmd-managed docs briefing for this repo. Use when the user asks to list, scaffold, query, validate, archive, or rename non-plan docs (reference docs, ADRs, RFCs, design notes), or asks how the dotmd doc lifecycle works here.
---
<!-- dotmd-generated: 0.39.2 -->

All documentation in this repo is managed by **dotmd** (v0.39.2). Docs across 1 root: docs. Config at `dotmd.config.mjs`.

Document types: `plan`, `doc`, `prompt`.

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
- `dotmd new plan <name>` — scaffold new plan
- `dotmd new doc <name>` — scaffold reference doc
- `dotmd prompts new <name> "<body>"` — save a resume-prompt
- `dotmd prompts next` — consume oldest pending prompt (prints body, auto-archives)
- `dotmd prompts use <file>` — consume a specific prompt (prints body, auto-archives)
- `dotmd status <file> <status>` — transition status
- `dotmd archive <file>` — archive with auto ref-fixing
- `dotmd bulk archive <files>` — archive multiple at once
- `dotmd touch --git` — bulk-sync updated dates from git history
- `dotmd lint --fix` — auto-fix frontmatter issues
- `dotmd fix-refs` — repair broken references and body links
- `dotmd rename <old> <new>` — rename doc + update all references

**Saved prompts (`docs/prompts/*.md`):** if the user references a file under `docs/prompts/` — e.g. "resume via docs/prompts/foo.md", "use this prompt" — consume it with `dotmd prompts use <file>` (prints the body and archives atomically). Do NOT `cat` it or read it with the file-reading tool. To pick the oldest pending prompt without naming a file, use `dotmd prompts next`.
