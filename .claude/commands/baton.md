<!-- dotmd-generated: 0.36.2 -->

You are wrapping this session. Hand the baton cleanly to the next one.

1. **Update the in-flight plan.** Find it via `dotmd plans --status in-session`. Edit its `current_state:` / `next_step:` frontmatter so they reflect where things actually stand. If status should change (shipped → archive, stuck on a human decision → awaiting, etc.), transition with `dotmd status <file> <status>` — or `dotmd archive <file>` if work is done.

2. **Save ONE lean handoff prompt.** Run `dotmd new prompt resume-<plan-slug>` with a body of ~10-20 lines: point at the plan file, name the next concrete decision, flag any gotchas. Do NOT recap the plan body (the plan is for that). Do NOT print the handoff into chat for the user to copy-paste — the saved prompt is the handoff.

3. **Release the lease.** `dotmd release` (skip if `dotmd archive` already closed out — archive auto-releases).

The next session's `dotmd hud` (SessionStart hook) surfaces the pending prompt automatically.
