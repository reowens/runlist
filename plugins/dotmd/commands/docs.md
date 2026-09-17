---
description: "runlist docs briefing — list, scaffold, query, validate, archive reference docs/ADRs/RFCs"
allowed-tools: "Bash(runlist:*), Bash(rl:*), Bash(dotmd:*), Read"
---

Run `Bash(runlist context)` for an LLM-oriented briefing across all document types, then help the user.

Common doc commands: `runlist query [filters]`, `runlist list`, `runlist new doc <name>`, `runlist set <status> <file>`, `runlist archive <file>`, `runlist doctor --apply` (auto-fix refs/lint/dates/index). See the **dotmd** skill for the full workflow and guardrails (don't hand-edit `status:`, don't cat/commit prompts).
