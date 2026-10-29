---
description: "Pick up where you left off — load a saved handoff from an earlier session"
allowed-tools: "Bash(runlist:*), Bash(rl:*), Bash(dotmd:*)"
---

Resume saved work. The user's `/pickup` is the request to consume a handoff.

- If arguments were given (`$ARGUMENTS`), run `runlist use "$ARGUMENTS"`
  directly, including a named held prompt: naming it is the user's explicit
  request. Let the CLI resolve the name and report any eligibility error.
- Without arguments: run `runlist prompts list --status pending --all` for a
  compact survey of the full pending queue. Only pending prompts are candidates.
  With exactly one pending prompt, consume it with `runlist use <name>` using
  its explicit name.
- With several pending prompts: list their names from the
  compact survey. Ask which one to resume; never consume the oldest by default.
- With none pending: say there are no pending handoffs and point to
  `runlist plans` for in-flight plans.

Never Read prompt files with file tools. Peek only with
`runlist prompts show <name>`; consume only with `runlist use <name>`.
