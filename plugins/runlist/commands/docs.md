---
description: "Browse and manage your reference docs: list, create, search, check, archive"
when_to_use: "Use when the user asks about reference docs, ADRs, RFCs or design docs: finding, creating, checking or archiving one."
allowed-tools: "Bash(runlist:*), Bash(rl:*), Bash(dotmd:*), Read"
---

Run `Bash(runlist context)` for an LLM-oriented briefing across all document types, then help the user.

Common doc commands: `runlist query [filters]`, `runlist list`, `runlist new doc <name>`, `runlist set <status> <file>`, `runlist archive <file>`, `runlist doctor --apply` (auto-fix refs/lint/dates/index). See the **runlist** skill for the full workflow and guardrails (don't hand-edit `status:`, inspect prompts through runlist, follow the project's `promptTracking` policy).
