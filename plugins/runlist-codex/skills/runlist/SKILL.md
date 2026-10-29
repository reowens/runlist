---
name: runlist
description: Save and resume session handoffs, and manage a repository's plans, docs, decisions, and saved prompts with the runlist CLI. Use for explicit consume requests for saved prompts, creating or consuming a handoff, starting or closing plan work, or checking the plan queue.
---

# Runlist workflow

For an explicit `consume <prompt>` request, run `runlist use <prompt>` before file discovery or other task commands. If the native request hook already supplied the consumed handoff, continue from that output without consuming it again. Report a consumption failure before starting the handoff's work.

For installing Runlist or turning on planning, use the **runlist-setup** skill.
Handoffs need no setup. This skill covers ongoing work.

The CLI is `runlist` (from the `runlist` package; `dotmd` remains an alias). The session hook prints a short live orientation. `CODEX_THREAD_ID` is the session identity used for plan claims; do not replace it with a process ID.

## Handoffs (every project)

- Save where the session stands: write the resume to a temp file (next concrete move, decisions, gotchas, paths; not a recap), then `runlist baton <slug> @/tmp/draft.md`, picking a short slug that names the work yourself. It saves `resume-<slug>`; report the name baton prints last. In a Git repository with no runlist config, this first baton also writes a handoffs-only `runlist.config.mjs` and a prompts folder.
- Resume: `runlist prompts` lists pending handoffs and `runlist use <name>` consumes one. With several pending, ask which; never consume the oldest by default.
- If `runlist plans` says planning is off, the project uses runlist for handoffs only: skip the planning bullets below, create no plans or docs, and suggest `runlist setup` only when the user asks for planning.

## Planning projects

These apply where `runlist plans` shows a dashboard (a `runlist.config.mjs` or `dotmd.config.mjs` with planning on).

- Orient with `runlist plans`. Use `runlist agent-context` for structured state; `runlist briefing` is the comprehensive view and can be large.
- Create from a draft with `runlist new plan <slug> @/tmp/draft.md` or `runlist new doc <slug> @/tmp/draft.md`. Draft headings become the body; opening frontmatter supplies fields such as `current_state` and `next_step`, while the command fixes `type`.
- Read a plan or long doc with `runlist show <file>` (card, outline and open boxes with line numbers, the active phase), then `runlist show <file> --section "<heading>"` one section at a time; never read a plan whole.
- Start plan work with `runlist use <plan-file>`. It claims the plan, marks it `in-session`, and prints the card.
- Change status with `runlist set <status> <file> [--note "why"]`; this runs validation, lifecycle hooks, ref repairs, and index updates. Never hand-edit a `status:` field.
- Close a shipped plan with `runlist archive <file>`; use `partial`, `active`, `awaiting`, or `blocked` when those match the actual state. Valid statuses are repository and type specific: `runlist statuses list --type plan`.
- For a handoff, write a concrete resume draft, then run `runlist baton [<plan-or-slug>] @<draft-file>`. An owned plan is released in the same operation. If a handoff for that work is pending, inspect it with `runlist prompts show <file>`; keep it if current or pass `--replace` with the new draft. Replacement archives the old text and refreshes exactly one pending prompt.
- **Subagent handoffs:** return completed results to the parent. For unfinished work or an explicit saved handoff, use `runlist baton --subagent <task-slug> @/tmp/draft.md` to save `subagent-<task-slug>`. Under a parent-owned plan, choose a distinct task slug that does not resolve to a plan; do not release the parent's claim. A child owning a dedicated plan can use `runlist baton --subagent <plan-file> @/tmp/draft.md`. Add `--parent resume-<session-name>` to link the child beneath its parent in `rl prompts`; the parent may be saved later. Parent-session batons keep the default `resume-*` naming. Matching prefixes are kept once; conflicting prefixes are refused. Existing prompts keep their names, and `--subagent --replace` refuses a parent-prefixed prompt.
- **Draft outlines:** `runlist baton --template` prints the resume outline. The Runlist desktop app's Templates editor (not Claude Desktop) saves resume/subagent outlines in `runlist.templates.json`; repository baton instructions still apply.
- **Child draft:** `runlist baton --subagent --template --parent resume-<name>` prints the saved child outline (built-in: Task, State, Next, Evidence and Boundaries). Fill the draft; its `parent_prompt` travels on save. A launcher can pass `RUNLIST_PARENT_PROMPT` into the child environment instead. Keep full records at durable repo-relative paths with commits and checked results; temporary scratch paths are supplementary. Completed work is a result for the parent to record, not another restart. Repair old links without replacing text: `runlist prompts link <child...> --parent resume-<name>`. Showing or consuming a parent surfaces its pending children without consuming them.
- Consume a saved prompt with `runlist use <prompt-file>` (or bare `runlist use` for the oldest). This archives and claims before printing the body. Only an agent session consumes; a plain terminal gets the body plus the `runlist prompts use <path>` line, and the prompt stays pending. A prompt that ends with that line is still pending: run the command first. For read-only triage, survey names with `runlist prompts`, then peek selected bodies with `runlist prompts show a b c`; use `show --all` only with `--limit N`. Never open pending prompts with a file reader or `cat`.
- Inspect `runlist config get promptTracking` before prompt Git operations: `untracked` recommends leaving pending prompts out of commits to reduce churn, `tracked` allows commits, `local` denies them (legacy default). Untracked is not ignored; `git add -A` can include prompts. `runlist config set promptTracking <value>` records an explicit choice without changing ignore files or Git state. Baton prints a commit hint for the plan/source files only.
- Record a decision with `runlist new decision <plan> --question "…" @<record-file>`; configured registers may also require `--answers`.
- If a lifecycle mutation reports an abandoned transaction, inspect `runlist doctor --transactions` before retrying. Use `--apply` only for cases the doctor identifies as recoverable.

The `PreToolUse` hook warns on direct pending-prompt reads and denies hand-edited status transitions or Git operations that would include a live prompt. A repo can opt into blocking direct reads of existing pending prompts with `guard: { promptReads: 'deny' }`. Archived prompts and `runlist prompts show` remain readable. Codex requires explicit trust of a plugin's hooks before they run.

**Document model:** a hub organizes related plans and supporting docs. Older docs and filenames call hubs *runlists*; this is the same document, not another level below a hub. A hub can be a coordination map or hold ordered plans in its `runlist:` array. A roadmap is an optional hub collecting other hubs and rolling up progress, with direct plan children also supported. Hubs currently use `type: plan` with hub metadata. Stage describes when a plan should ship, while status describes progress; neither adds a document level. Existing `runlist` commands, fields and output labels remain unchanged. See the repository README's “Hubs, Ordered Plans, And Roadmaps” section for examples.

**Optional filing policy:** with `export const filing = true` (or `{ categoryDepth: 3 }`), `check` warns on missing/multiple/uncategorized homes, while `coverage` lists direct/inherited homes and hub:line evidence. A home is a status-bearing table row whose first cell links the plan; mentions and order lists are references. A child without its own row can inherit a home through explicit `parent_plan:` ancestors. Categories come from headings or the containing hub's filing category. Scoping retains full evidence; incomplete scans suppress absence findings. Neither command assigns homes or repairs rows. Enable the policy or retire an older custom check only with repository authorization. Available in CLI 0.93.0.
