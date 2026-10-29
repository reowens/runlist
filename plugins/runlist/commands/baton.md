---
description: "Save where you are so the next session can pick it up (a “baton”). /runlist:pickup is the other half."
when_to_use: "Use when the user says baton (“baton this”, “baton now”, “baton those items”), save where we are, save a resume, hand off, wrap up, or pick it up next time, or when context is getting tight."
allowed-tools: "Bash(runlist:*), Bash(rl:*), Bash(dotmd:*), Bash(git commit:*), Write, Edit"
---

Save a resume prompt for the work in flight (and, in a project that uses plans, bring the plans up to date). The user's `/runlist:baton` (or "baton", "save where we are", "hand off", "pick it up next time") is the request. The next session loads it with `/runlist:pickup`. If the repo defines baton (`templates.prompt.baton` in its runlist config, printed by the hook when the user asks for a baton), that definition wins wherever it differs from the steps below.

Start with `runlist baton --template` if useful. Resume and subagent outlines can be customized in the Runlist desktop app's Templates editor (`runlist.templates.json`; not a Claude Desktop feature); repository baton instructions still apply.

1. **Write the draft** to a fresh temporary file of your own (for example, a path from `mktemp`): 10–20 lines — the next concrete decision plus any gotchas, NOT a recap. Reference the relevant file paths inside the draft so the next session can orient.

2. **Run the verb.** If this session owns an in-session plan, use the plan form further down (no slug) so the plan is handed off with the prompt. Otherwise — the usual case, and the only one when the project has no runlist config yet or `runlist plans` says planning is off:

   ```bash
   runlist baton <slug> @<draft-file>         # saves resume-<slug>, touches NOTHING else
   ```

   Pick the slug yourself: a few words naming the work (`checkout-totals`); never ask the user to name it. In a Git repository with no runlist config, this first baton also writes a handoffs-only `runlist.config.mjs` and keeps prompts in `docs/prompts/`, first moving any an older runlist saved in a root `prompts/`; relay what baton prints about that. The user saying "save a resume prompt for this" does NOT require a plan — slug mode exists precisely for that.

   **Only in a project that uses plans**, when this session owns an in-session plan:

   ```bash
   runlist baton @<draft-file>                # saves resume-<plan-slug>, flips the plan
                                             # in-session → active, prints the exact commit
   ```

   Variations (plan mode only):
   - `runlist baton <plan-file> @<draft-file>` — when baton can't tell which plan is yours.
   - `--status paused|awaiting|partial|blocked` — when the plan's reality changed; default `active` is right for plain "work continues".
   - `--note "why"` — records the reason in `## Version History` in the same call.

   Always pass the draft (`@<file>`). A bare `runlist baton` saves nothing: it prints these same forms and exits. If a handoff may already be pending, inspect it with `runlist prompts show <resume-slug>` first. Keep it if current; if stale, pass `--replace` with the new draft. Baton archives the prior text and refreshes exactly one pending handoff with the plan release. Never consume a prompt merely to replace it. If baton refuses, it names the pending prompt to inspect.

3. **Finish the handoff only if baton asks** (plan handoffs only). Read baton's output. If it says `Handoff not done yet` (it released an in-session plan that has a `next_step`), update that plan's body, then run:

   ```bash
   runlist baton --done --next-step "<next move>" [--current-state "<where it stands>"]
   ```

   Add `<plan-file>` after `--done` when running from another session. The command writes the fields (creating a missing key) and refuses a `next_step` that still reads as it did when the prompt was saved. Each value is one line; `--dry-run` previews the write. If baton did not say that (slug mode, or no `next_step`), skip `--done`: it has nothing to confirm and exits with an error. The prompt is saved first, so a stop between the steps loses nothing.

   Any other plan this session touched is a separate, ordinary update: edit its body and change its status with `runlist set <status> <plan-file>` (`--note "why"` records the reason). `--done` applies only to the plan baton just released.

4. **Commit and report.** If baton printed a commit command, run it once the plans are updated, with the other plans you updated named too. Tell the user the prompt name baton printed; it is the last line of the output. Do not pipe baton through `tail`, `head` or `grep`.

**Do NOT:**
- run `runlist use` (that *consumes* prompts / *starts* plans — the wrong direction during a handoff; running it on your own freshly saved prompt destroys the handoff),
- add the generated index to the baton commit; follow `runlist config get promptTracking` for prompt Git operations (the printed hint covers the plan only),
- paste the resume text into chat for copy-paste; the next session's `runlist hud` surfaces the saved prompt automatically.

## Subagents (only when you are a delegated agent)

Delegated agents use `runlist baton --subagent <task-slug> @<draft-file>`,
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
