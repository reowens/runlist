---
description: "runlist plan briefing — what's on the plate, what to pick up, how to start/close a plan"
allowed-tools: "Bash(runlist:*), Bash(rl:*), Bash(dotmd:*), Read"
---

Run `Bash(runlist plans)` to load the compact plan dashboard, then orient the user. For a structured view across the repo, use `runlist agent-context`; `runlist briefing` is comprehensive and may be large.

For plan actions use the runlist verbs: `runlist use <file>` to start (marks in-session + prints the card), `runlist set <status> <file>` to transition, `runlist archive <file>` to close out. See the **dotmd** skill for the full workflow and guardrails. If the user references a `docs/prompts/*.md` file, consume it with `runlist use <file>` — do not cat or Read it.
