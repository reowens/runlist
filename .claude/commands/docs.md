---
description: dotmd-managed docs briefing for this repo. Use when the user asks to list, scaffold, query, validate, archive, or rename non-plan docs (reference docs, ADRs, RFCs, design notes), or asks how the dotmd doc lifecycle works here.
---
<!-- dotmd-generated: 0.49.3 -->

All documentation in this repo is managed by **dotmd** (v0.49.3). Docs across 1 root: docs. Config at `dotmd.config.mjs`.

Document types: `plan`, `doc`, `prompt`.

Commands for working with docs:
- `dotmd context` — LLM-oriented briefing across all types
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
- `dotmd new prompt <name>` — save a resume-prompt (pipe stdin or @path for body)
- `dotmd use` — consume oldest pending prompt (prints body, auto-archives)
- `dotmd use <file>` — open any doc by type: prompt → consume, plan → start work, doc → read
- `dotmd set <status> [<file>]` — unified transition (archive / status bump; infers path from your active in-session plan)
- `dotmd status <file> <status>` — transition status (legacy; `set` is preferred)
- `dotmd archive <file>` — archive with auto ref-fixing
- `dotmd bulk archive <files>` — archive multiple at once
- `dotmd touch --git` — bulk-sync updated dates from git history
- `dotmd lint --fix` — auto-fix frontmatter issues
- `dotmd fix-refs` — repair broken references and body links
- `dotmd rename <old> <new>` — rename doc + update all references

**Saved prompts (`docs/prompts/*.md`):** if the user references a file under `docs/prompts/` — e.g. "resume via docs/prompts/foo.md", "use this prompt" — consume it with `dotmd use <file>` (prints the body and archives atomically). Do NOT `cat` it or read it with the file-reading tool. To pick the oldest pending prompt without naming a file, run `dotmd use` with no arg.
