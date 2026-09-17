---
description: "Baton: save a resume prompt for whatever this session is doing, and release the plan if one is in-session. Use when the user says baton (\"baton this\", \"baton now\", \"baton those items\"), save a resume, hand off, wrap up, or pick it up next time, or when context is getting tight. Gives the exact command form, so no --help call is needed."
allowed-tools: "Bash(runlist:*), Bash(rl:*), Bash(dotmd:*), Bash(git commit:*), Write"
---

Save a resume prompt for the work in flight. Two steps, one command:

1. **Write the draft** to a temp file (`/tmp/baton.md`): 10–20 lines — the next concrete decision plus any gotchas, NOT a recap. Reference the relevant plan/doc paths inside the draft so the next session can orient.

2. **Run the verb** — pick the form that matches reality:

   ```bash
   runlist baton @/tmp/baton.md                # a plan is in-session: saves resume-<plan-slug>,
                                             # flips it in-session → active, prints the exact commit
   runlist baton <slug> @/tmp/baton.md         # no plan involved: saves resume-<slug>, touches NOTHING else
   ```

   The user saying "save a resume prompt for this" does NOT require a plan — slug mode exists precisely for that. Variations (plan mode only):
   - `runlist baton <plan-file> @/tmp/baton.md` — when baton can't tell which plan is yours.
   - `--status paused|awaiting|partial|blocked` — when the plan's reality changed; default `active` is right for plain "work continues".
   - `--note "why"` — records the reason in `## Version History` in the same call.

   If baton printed a `git commit` command, run it as-is. If it didn't, nothing repo-tracked changed — you're done. Tell the user the prompt name baton printed.

   Always pass the draft (`@<file>`). A bare `runlist baton` saves nothing: it prints these same forms and exits. If baton refuses because a handoff for the same work is already pending, it names that prompt; consume or archive it, then re-run.

**Scope guard — baton is the whole closeout. Do NOT:**
- run `runlist use` (that *consumes* prompts / *starts* plans — the wrong direction during a handoff; running it on your own freshly saved prompt destroys the handoff),
- change the status of any other plan, or triage the repo on the way out,
- commit the prompt or the generated index (only run the commit baton printed, verbatim),
- paste the resume text into chat for copy-paste; the next session's `runlist hud` surfaces the saved prompt automatically.
