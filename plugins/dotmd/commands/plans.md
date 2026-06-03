---
description: "dotmd plan briefing — what's on the plate, what to pick up, how to start/close a plan"
allowed-tools: "Bash(dotmd:*), Read"
---

Run `Bash(dotmd briefing)` to load the current plan briefing (active / paused / ready plans, ages, next steps), then orient the user.

For plan actions use the dotmd verbs: `dotmd use <file>` to start (marks in-session + prints the card), `dotmd set <status> <file>` to transition, `dotmd archive <file>` to close out. See the **dotmd** skill for the full workflow and guardrails. If the user references a `docs/prompts/*.md` file, consume it with `dotmd use <file>` — do not cat or Read it.
