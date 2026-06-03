---
description: "dotmd docs briefing — list, scaffold, query, validate, archive reference docs/ADRs/RFCs"
allowed-tools: "Bash(dotmd:*), Read"
---

Run `Bash(dotmd context)` for an LLM-oriented briefing across all document types, then help the user.

Common doc commands: `dotmd query [filters]`, `dotmd list`, `dotmd new doc <name>`, `dotmd set <status> <file>`, `dotmd archive <file>`, `dotmd doctor --apply` (auto-fix refs/lint/dates/index). See the **dotmd** skill for the full workflow and guardrails (don't hand-edit `status:`, don't cat/commit prompts).
