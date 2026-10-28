---
description: "Baton: save a resume prompt for whatever this session is doing, and release the plan if one is in-session. Use when the user says baton (\"baton this\", \"baton now\", \"baton those items\"), save a resume, hand off, wrap up, or pick it up next time, or when context is getting tight. Gives the exact command form, so no --help call is needed."
allowed-tools: "Bash(runlist:*), Bash(rl:*), Bash(dotmd:*), Bash(git commit:*), Write, Edit"
---

Save a resume prompt for the work in flight, then bring the plans up to date. If the repo defines baton (`templates.prompt.baton` in its runlist config, printed by the hook when the user asks for a baton), that definition wins wherever it differs from the steps below.

Start with `runlist baton --template` if useful. Resume and subagent outlines can be customized in desktop **Templates** (`runlist.templates.json`); repository baton instructions still apply.

1. **Write the draft** to a temp file (`/tmp/baton.md`): 10–20 lines — the next concrete decision plus any gotchas, NOT a recap. Reference the relevant plan/doc paths inside the draft so the next session can orient.

2. **Run the verb** — pick the form that matches reality:

   ```bash
   runlist baton @/tmp/baton.md                # a plan is in-session: saves resume-<plan-slug>,
                                             # flips it in-session → active, prints the exact commit
   runlist baton <slug> @/tmp/baton.md         # no plan involved: saves resume-<slug>, touches NOTHING else
   ```

   Delegated agents use `runlist baton --subagent <task-slug> @/tmp/baton.md`,
   which saves `subagent-<task-slug>`. Under a parent-owned plan, choose a distinct
   task slug that does not resolve to a plan; do not release the parent's claim.
   A child owning a dedicated plan can pass `<plan-file>` with `--subagent`.
   Add `--parent resume-<session-name>` to link the child beneath its parent's
   prompt in `rl prompts`; the parent may be saved later.
   Start its draft with `runlist baton --subagent --template --parent resume-<session-name>`.
   Fill Task, State, Next, Evidence and Boundaries. The draft carries its parent;
   a launcher may instead pass `RUNLIST_PARENT_PROMPT` into the child environment.
   State completed work as a result for the parent to record, with commits and
   verified checks. Keep full records at durable repo-relative paths; scratch
   files are supplementary. Link an old child without replacing its text with
   `runlist prompts link <child> --parent resume-<session-name>`.
   Parent-session batons default to `resume-*`. Existing prompts keep their names.
   Matching prefixes are kept once and conflicting prefixes are refused;
   `--subagent --replace` refuses a parent-prefixed pending prompt.

   The user saying "save a resume prompt for this" does NOT require a plan — slug mode exists precisely for that. Variations (plan mode only):
   - `runlist baton <plan-file> @/tmp/baton.md` — when baton can't tell which plan is yours.
   - `--status paused|awaiting|partial|blocked` — when the plan's reality changed; default `active` is right for plain "work continues".
   - `--note "why"` — records the reason in `## Version History` in the same call.

   Always pass the draft (`@<file>`). A bare `runlist baton` saves nothing: it prints these same forms and exits. If a handoff may already be pending, inspect it with `runlist prompts show <resume-slug>` first. Keep it if current; if stale, pass `--replace` with the new draft. Baton archives the prior text and refreshes exactly one pending handoff with the plan release. Never consume a prompt merely to replace it. If baton refuses, it names the pending prompt to inspect.

3. **Bring the plans up to date, after the prompt is saved.** The owning plan first: its body, then `current_state` and `next_step`. Then every other plan this session touched. When baton released an in-session plan that has a `next_step`, it prints `Handoff not done yet`: the handoff is not done until you update the plan and run `runlist baton --done` (or `runlist baton --done <plan-file>`), which refuses while `next_step` still reads as it did when the prompt was saved. The prompt is saved first, so a stop between the two steps loses nothing.

4. **Commit and report.** If baton printed a commit command, run it once the plans are updated, with the other plans you updated named too. Tell the user the prompt name baton printed; it is the last line of the output. Do not pipe baton through `tail`, `head` or `grep`.

**Do NOT:**
- run `runlist use` (that *consumes* prompts / *starts* plans — the wrong direction during a handoff; running it on your own freshly saved prompt destroys the handoff),
- add the generated index to the baton commit; follow `runlist config get promptTracking` for prompt Git operations (the printed hint covers the plan only),
- paste the resume text into chat for copy-paste; the next session's `runlist hud` surfaces the saved prompt automatically.
