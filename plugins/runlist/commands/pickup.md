---
description: "Pick up where you left off — load a saved handoff from an earlier session"
allowed-tools: "Bash(runlist:*), Bash(rl:*), Bash(dotmd:*)"
---

Resume saved work. The user's `/pickup` is the request to consume a handoff.

- With `$ARGUMENTS`: survey `runlist prompts --status pending --all --json`
  to check eligibility, then consume that prompt with `runlist use <name>`.
  Held prompts are not candidates: if the named prompt is held, explain that it must be
  unheld explicitly before pickup.
- Without arguments: run `runlist prompts --status pending --all --json` to
  survey the full pending queue. Exclude held prompts. With exactly one pending prompt, consume it with
  `runlist use <name>` using its explicit name.
- With several pending prompts: list their names, ages, titles, and linked plans
  when available cheaply from the queue metadata.
  Ask which one to resume; never consume the oldest by default.
- With none pending: say there are no pending handoffs and point to
  `runlist plans` for in-flight plans.

Never Read prompt files with file tools. Peek only with
`runlist prompts show <name>`; consume only with `runlist use <name>`.
