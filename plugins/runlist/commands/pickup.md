---
description: "Pick up where you left off — load a saved handoff from an earlier session"
when_to_use: "Use when the user says pick up where we left off, where were we, resume my handoff, load my last handoff, or continue from the last session."
allowed-tools: "Bash(runlist:*), Bash(rl:*), Bash(dotmd:*)"
---

Resume saved work. The user's `/runlist:pickup` is the request to consume a handoff.

- With a name supplied in the command arguments, run `runlist use <name>`
  directly: naming it is the user's explicit request. Let the CLI resolve the
  name and report any eligibility error.
- Without arguments: run `runlist prompts list --status pending --all` for a
  compact survey of the full pending queue. Only pending prompts are candidates.
  With exactly one pending prompt, consume it with `runlist use <name>` using
  its explicit name.
- With several pending prompts: list their names from the
  compact survey. Ask which one to resume; never consume the oldest by default.
- With none pending: say there are no pending handoffs. In a project that
  uses plans, point to `runlist plans` for in-flight plans; if it says planning
  is off, there is nothing more to resume.

Never Read prompt files with file tools. Peek only with
`runlist prompts show <name>`; consume only with `runlist use <name>`.
