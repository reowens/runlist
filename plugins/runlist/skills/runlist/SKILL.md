---
name: runlist
description: Save and resume session handoffs, and manage this repo's plans, docs, and prompts with the runlist CLI. Use for explicit consume requests for saved prompts, saving or resuming a handoff, when the user asks what's on the plate, references a plan/doc/prompt (or a slug under docs/), queues work, or wants to start, transition, or close one. Covers the order of operations (briefing → use → set → archive) and the rules for handling saved prompts.
allowed-tools: "Bash(runlist:*), Bash(rl:*), Bash(dotmd:*), Read"
---

# runlist workflow

For an explicit `consume <prompt>` request, run `runlist use <prompt>` before file discovery or other task commands. If the native request hook already supplied the consumed handoff, continue from that output without consuming it again. Report a consumption failure before starting the handoff's work.

For installing Runlist or turning on planning, use the **runlist-setup** skill.
Handoffs need no setup. This skill covers ongoing work.

## Handoffs (every project)

Saving where a session stands and resuming it later is the part every runlist
user has, with or without plans.

- **Save ("baton", "save where we are", `/baton`):** write the resume to a temp file (the next concrete move, decisions, gotchas, paths; not a recap), then `runlist baton <slug> @/tmp/draft.md`. Pick the slug yourself, a few words naming the work; never ask the user for one. It saves `resume-<slug>`. In a Git repository with no runlist config, this first baton also writes a handoffs-only `runlist.config.mjs` and a prompts folder; relay its one-line note. Tell the user the prompt name baton prints last. Never paste a resume block into chat.
- **Resume ("pick up where we left off", `/pickup`):** `runlist prompts` lists the pending handoffs; `runlist use <name>` consumes one and prints it. With several pending, ask which; never consume the oldest by default.
- **Is planning on?** Run `runlist plans`. If it says planning is off, the project uses runlist for handoffs only: skip the planning sections below, create no plans or docs (`runlist new plan` refuses), and suggest `runlist setup` only when the user asks for planning.

## Saved prompts — the #1 confusion point

Use `/pickup [<name>]` to resume a saved handoff; `/prompts` manages the queue.

Saved prompts (`docs/prompts/*.md`, or `prompts/*.md` in a handoffs-only project without `docs/`) are handoff artifacts; the project chooses their Git policy. Bullets about plans, claims and ownership apply only where planning is on:

- **Consume, don't read.** If the user references a prompt — "resume via docs/prompts/foo.md", "use this prompt", "load that one" — run `runlist use <file>` (no arg = oldest pending). It commits archive/claim before stdout, so body output is at-most-once and the prompt can't be double-consumed; an output failure is recoverable with `runlist prompts show <archived-path>`. **Do NOT `cat` it, Read it, or copy its body into chat.** If the prompt was made by `runlist baton`, consuming it also **claims its plan** (`→ Claimed …`, flips it `in-session`) — so your later `runlist baton` hands that plan off automatically; no need to `runlist use <plan>` first. Only triaging or cleaning up prompts? `runlist use --no-claim <file>` consumes without starting the plan. If your prompt ends with "runlist consumes a prompt only inside an agent session" and a `runlist prompts use <path>` command, you were started from a terminal and the prompt is still pending: run that command first, which archives it and claims its plan for you.
- **Ownership is durable and session-local (planning projects).** Claims live under local `.runlist/` (legacy `.dotmd/` is still read); no-target `set`/`baton` never guesses from journal entries or global in-session counts. Pickup hooks are at-least-once with stable `operationId` values, and a live delivery lease blocks release/takeover.
- **A plan claimed by a session that is gone** (planning projects) blocks `set`, `archive` and `baton` on it. `runlist doctor --claims` lists every claim with whether its session is live; `runlist doctor --claims --apply` releases the ones whose session is provably gone and sets the plan back to `active`. A claim runlist cannot judge (no recorded process, another machine) is released only with `--older-than <24h|3d>`, which is the person's call. SessionStart names dead claims when there are any.
- **Peek without consuming.** Triaging or surveying pending prompts (not acting on one)? `runlist prompts show <file>` prints the body read-only — no archive, safe to repeat. Never `runlist use` a prompt you only meant to look at, and never `use` a prompt you just saved (that destroys the handoff).
- **Survey names, then select bodies.** `runlist prompts` lists the pending queue; `runlist prompts show a b c` peeks selected prompts in one call. Use `runlist prompts show --all --limit N` for a capped batch. Never read pending prompts with file tools.
- **Follow the project's prompt Git policy.** `runlist config get promptTracking` shows the effective value and source. New projects default to `untracked`: leaving prompts out of commits reduces commit churn, but `git add -A` still includes unignored files. `tracked` permits prompt commits; `local` denies pending-prompt Git operations and preserves legacy behavior for existing configs without a choice. Change only by explicit user choice with `runlist config set promptTracking <value>`. This never changes ignore files or Git state.
- **"Save a resume prompt" = `runlist baton`**, any time, plan or no plan — never paste a "here's how to resume" block into chat. With a plan in-session, `runlist baton @/tmp/draft.md` saves the prompt AND releases the plan; with no plan, `runlist baton <slug> @/tmp/draft.md` just saves `resume-<slug>` and touches nothing else (reference the relevant plans/docs in the draft body). The next session sees it at SessionStart. Baton refuses, saving nothing, when a handoff for that work is already pending: inspect that prompt and keep it if current, or use `--replace` with the new draft.
- **Subagent handoffs:** return completed results to the parent. For unfinished work or an explicit saved handoff, use `runlist baton --subagent <task-slug> @/tmp/draft.md` to save `subagent-<task-slug>`. Under a parent-owned plan, choose a distinct task slug that does not resolve to a plan; do not release the parent's claim. A child owning a dedicated plan can use `runlist baton --subagent <plan-file> @/tmp/draft.md`. Add `--parent resume-<session-name>` to link the child beneath its parent in `rl prompts`; the parent may be saved later. Parent-session batons keep the default `resume-*` naming. Matching prefixes are kept once; conflicting prefixes are refused. Existing prompts keep their names, and `--subagent --replace` refuses a parent-prefixed prompt.
- **Draft outlines:** `runlist baton --template` prints the resume outline. The Runlist desktop app's Templates editor (not Claude Desktop) saves resume/subagent outlines in `runlist.templates.json`; repository baton instructions still apply.
- **Child draft:** `runlist baton --subagent --template --parent resume-<name>` prints the saved child outline (built-in: Task, State, Next, Evidence and Boundaries). Fill the draft; its `parent_prompt` travels on save. A launcher can pass `RUNLIST_PARENT_PROMPT` into the child environment instead. Keep full records at durable repo-relative paths with commits and checked results; temporary scratch paths are supplementary. Completed work is a result for the parent to record, not another restart. Repair old links without replacing text: `runlist prompts link <child...> --parent resume-<name>`. Showing or consuming a parent surfaces its pending children without consuming them.
- **Before a second handoff for the same work**, run `runlist prompts show <resume-slug>` to inspect the pending prompt. If it already carries the current next step, keep it and do not call baton again. If it is stale, write the new draft and call `runlist baton [<plan-or-slug>] @/tmp/draft.md --replace`. This preserves the old text under `docs/prompts/archived/` and refreshes exactly one pending prompt with the plan release. Do not consume a prompt merely to replace it.

## Planning projects

Everything below applies when the project uses plans (`runlist plans` shows a dashboard rather than "planning is off").

This repo's plans, reference docs, and saved prompts are managed by the **runlist** CLI (markdown + YAML frontmatter; installed from the `runlist` package, and `dotmd` still works as an alias). Always drive them through `runlist` — never hand-edit frontmatter, never read prompts with the file tools, follow the project's `promptTracking` policy for prompt commits. The session-start hook reports relevant live state; the recipes below supply command syntax. Read repository-specific plan statuses with `runlist statuses list --type plan`. Use `runlist plans` for a compact plan dashboard, `runlist agent-context` for structured agent orientation, and `runlist briefing` only when the comprehensive view is needed; its output grows with the corpus.

**Workflow contract** — the irreducible verbs at a glance; the sections below expand each one.

<!-- runlist:canonical-workflow:start -->
- **Orient:** `runlist plans` — compact plan dashboard; use `runlist agent-context` when an agent needs structured state across the repo.
- **Read a plan or long doc:** `runlist show <file>` prints its card, outline and open boxes with line numbers, and names the active phase; then `runlist show <file> --section "<heading>"`, one section at a time. Never read a plan whole.
- **Create from a draft:** `runlist new plan <slug> @/tmp/draft.md` or `runlist new doc <slug> @/tmp/draft.md`. Draft headings become the body; opening frontmatter supplies scaffold fields while the command fixes `type`.
- **Start a plan:** `runlist use <plan-file>` — marks it `in-session` and prints the plan card.
- **Single status verb:** `runlist set <status> [<file>]` writes the status, validates it against the doc's type, runs lifecycle hooks, fixes refs, and syncs the index. **Never hand-edit a `status:` line.** Add `--note "why"` to record the reason in `## Version History` in the same call.
- **Close to match reality:** `archived` (shipped) · `partial` (tail deferred — link the successor) · `active` (more work later) · `awaiting` (needs a human decision) · `blocked` (external arrival you can't speed up). Parking a plan with a known next step? Leave a baton in the same breath — never narrate the next pickup into chat.
- **Hand off / save a resume prompt:** `runlist baton [<plan-or-slug>] @<draft-file>` — write the resume to a file first; saves the prompt and releases the in-session plan (a slug with no plan just saves `resume-<slug>`). Never paste a "here's how to resume" block into chat.
- **Child handoff:** for unfinished work, `runlist baton --subagent <task-slug> @/tmp/draft.md --parent resume-<parent>`. Under a parent-owned plan, use a distinct task slug that does not resolve to a plan; preserve the parent's claim. Return completed results to the parent.
- **Record a decision:** `runlist new decision <plan> --question "…" @<record-file>`; if the repo configures a decisions register, also pass `--answers "Yes: … No: …"`. `runlist decisions --check` reports incomplete records.
- **Saved prompts:** consume with `runlist use` (no arg = oldest pending), survey names with `runlist prompts`, and peek selected bodies with `runlist prompts show a b c`. Use `show --all` only with `--limit N`. Never read them with file tools. Inspect `runlist config get promptTracking`: `untracked` recommends leaving pending prompts out of commits, `tracked` allows commits, `local` denies them. Untracked is not ignored; `git add -A` can include them.
- **Cross-reference before touching a plan:** `runlist xref <plan-file>` shows what names it, its decisions and any linked record that disagrees, and the code it cites (renamed, removed, or changed since its last commit); `runlist xref --check --flag` puts moved-code and disagreeing-decision findings on the flags list.
- **Flag what the person should know:** `runlist flag add <file[:line]> "<what is wrong>"` puts a problem you found but are not fixing on the flags list (`--severity problem|warn|info`); `runlist flags` lists what is open. A flag says what is wrong and where, never what to do about it.
<!-- runlist:canonical-workflow:end -->

## Order of operations

1. **Orient** — `runlist plans` for the compact dashboard, or `runlist agent-context` for structured state. Use `runlist briefing` only for the comprehensive view.
2. **Start work on a plan** — `runlist use <plan-file>` marks it `in-session` and prints the plan card. (`runlist set in-session <file>` sets the status without printing.)
3. **Do the work.**
4. **Close it** — pick the status that matches reality (see the decision tree below). Handing off mid-work instead? `runlist baton @/tmp/draft.md` saves the resume prompt first, flips the plan back to `active` (`--status` to override), and prints the exact `git commit` to run. Then bring the plans up to date. Only when baton's output says `Handoff not done yet` (it released an in-session plan that has a `next_step`): update that plan's body, then `runlist baton --done --next-step "<next move>"` (add `--current-state "…"` if that changed) writes the frontmatter and confirms it; it refuses a `next_step` that has not changed, and with nothing pending (slug mode) it exits 1, so skip it. Other plans you touched are ordinary edits: update the body and change status with `runlist set`. A repo's own `templates.prompt.baton` definition wins where it differs.

## The single status verb: `runlist set <status> [<file>]`

One verb handles starting, transitioning, and closing — it writes the new status to frontmatter, validates it against the doc's type, runs lifecycle hooks, fixes refs, and keeps the index in sync. **Never edit a `status:` line by hand** — direct edits skip all of that.

Closure decision tree for a plan:
- Fully shipped → `runlist set archived <file>` (or `runlist archive <file>` — also moves it + fixes refs).
- Shipped, tail deferred → `runlist set partial <file>` (reference the successor plan in the body).

Add `--note "why"` to any `set`/`archive` to append the reason to `## Version History` in the same call — one tool call instead of status-change + body edit. Example: `runlist set partial x --note "tail tracked in y.md"`.
- Needs more work later → `runlist set active <file>`.
- Stuck on a human decision/input → `runlist set awaiting <file>`.
- Blocked on an external arrival you can't speed up → `runlist set blocked <file>`.

Valid statuses are type-aware and project-specific: `runlist statuses list --type plan`.

## Creating documents

`runlist new <type> <name> [body]` — types: `plan`, `doc`, `prompt` (default `doc`).
- `runlist new plan auth-revamp` → `docs/plans/auth-revamp.md`, created `planned` (`--status <s>` to override; `runlist use` starts it)
- `runlist new doc token-refresh-design` → `docs/token-refresh-design.md`
- Body input modes (all types): `@path` (preferred for multi-line), `-` (stdin), `--message "…"`, or inline (one-liners only).
- Draft a full document with `## ` sections before calling `new`, then pass it as `@path`: those sections become the body instead of being appended to the template outline. A draft opening with `---` frontmatter can supply `current_state`, `next_step`, `surfaces`, and other scaffold fields in the same call; `type` stays fixed by the command.
- Plan body variants (plans only, mutually exclusive with each other and `--runlist`/`--coordination`): `--lite`/`--minimal` (Problem → Phases → Version History) and `--audit`/`--findings` (Problem → Findings (ranked) → Suggested order → Open Questions).

**Plan frontmatter field lengths — write them right the first time.** `current_state` is a 2-4 sentence summary (cap 1500 chars); `next_step` is a 1-2 sentence pointer (cap 800). Everything longer goes in the body. If a cap warning fires anyway, run `runlist doctor --frontmatter-fix` ONCE (it mechanically moves the overflow into the body) — do not hand-trim, re-run `runlist check` in a loop, or audit other docs' warnings you didn't touch.

## Decisions

`runlist new decision <plan> --question "What must be decided?" @/tmp/decision.md` adds one decision to the owning plan. Write the record file first: situation, current behavior, and the consequence of each answer. Repos with `decisions.register` require `--answers "Yes: … No: …"` too; include it on the first call. Read pending decisions with `runlist decisions [<plan>]`, and validate the record with `runlist decisions --check`.

## Guardrails (the guard hook enforces these)

- Git operations including pending prompts follow `promptTracking`: `untracked` warns, `tracked` allows, `local` denies. The guard inspects paths Git would actually include, including broad staging and pathless commits. Merely mentioning a prompt in a commit message is fine.
- ❌ `cat`/Read a `docs/prompts/*.md` → ✅ `runlist use <file>` to consume, `runlist prompts` to survey names, `runlist prompts show a b c` to peek selected bodies. Use `show --all` only with `--limit N`.
- Direct reads warn by default. Repositories can set `guard: { promptReads: 'deny' }` to block reads of existing pending prompts; archived prompts and `runlist prompts show` remain readable.
- ❌ change a `status:` line by hand (Edit, Write, `sed -i`, `perl -pi`) → ✅ `runlist set <status> <file>`. This one is **blocked**, not just warned (config `guard: { deny: false }` for warn-only).

## Querying

- `runlist plans` / `runlist plans --status active` / `--status in-session`
- `runlist query --type doc --status active`, `runlist query --keyword <term>` (add `--body` to scan bodies)
- `runlist grep <term>` — "which doc discussed X?" Searches frontmatter + bodies, returns doc cards with line-numbered excerpts. Prefer it over raw grep across docs/.
- `runlist actionable`, `runlist stale`, `runlist health`, `runlist unblocks <file>`
- **Document model:** a hub organizes plans and supporting docs. Older docs and filenames call hubs *runlists*; this is the same document, not another level below a hub. Coordination, ordered and roadmap hubs are optional shapes. A stage describes when a plan should ship, while status describes progress; neither creates a document level. Existing `runlist` commands, fields and output labels remain unchanged.
- `runlist runlist <hub>` / `runlist runlist next <hub>` for the plans ordered on a hub. Scaffold one with `runlist new hub <hub> --runlist a,b,c` (hub + child stubs); `runlist new hub <hub>` defaults to a prose-first coordination hub. The existing `new plan --runlist` / `--coordination` forms are equivalent. Worked example — scaffold an ordered hub, then walk it:
  ```bash
  runlist new plan auth-revamp --runlist extract,rewrite,cleanup
  #   → hub auth-revamp.md (runlist: [...] + an ## Order of operations list)
  #   + auth-revamp-01-extract.md … -03-cleanup.md (status planned, parent_plan back-ref)
  runlist runlist auth-revamp        # the sequence + statuses; → marks the next pickup
                                   #   (first pickup-able child; archived + parked children skipped)
  runlist runlist next auth-revamp   # pick up the → child (planned → in-session) + print its card
  ```
  Mutate the runlist through the CLI — never hand-edit the `runlist:` YAML. These keep the array, each child's `parent_plan:` back-ref, and any body `## Order of operations` list in sync (all take `--dry-run`/`--json`):
  ```bash
  runlist runlist add auth-revamp deploy          # append: bare slug → scaffolds a planned stub;
                                                #   an existing plan's path/slug → wires it in
  runlist runlist remove auth-revamp cleanup      # drop a child (match by slug or path); --clear-parent
                                                #   also blanks the removed child's back-ref
  runlist runlist reorder auth-revamp deploy --before rewrite   # move one child
  runlist runlist reorder auth-revamp cleanup extract rewrite deploy   # or set a full new order
  ```
- `runlist sync-status` — a hub that rows its children in a table prints each child's status by hand, and `runlist check` now catches it when that word disagrees with the plan's real status (warning when runlist inferred the word from the cell, error when it sits in a `<!--s-->…<!--/s-->` marker). `runlist sync-status` rewrites the drifted rows (`[<hub>...]`, `--dry-run`, `--json`); `--adopt` also wraps managed words in markers. **Never hand-edit a status word in a hub table** — fix the row with this, or change the plan's status with `runlist set`.
- `runlist check` also catches **membership drift** between a hub and its children: a plan claiming `parent_plan: <hub>` that the hub references nowhere warns on the hub, and a plan ranked in a hub's body order (`## Ranked queue` / `## Order of operations`) with no `parent_plan:` warns on the child. `runlist fix-membership [<hub>...] [--dry-run] [--json]` repairs only the mechanical child-side case when exactly one hub already states the relationship; it never writes hub prose, overwrites another parent, or guesses between hubs. `check --fix` and `doctor --apply` include it; bare `doctor` previews it. Orphan hub-side claims and wrong-parent conflicts remain manual.
- Optional **filing** policy (`export const filing = true`, with `{ categoryDepth: 3 }` also supported): `check` warns on missing/multiple/uncategorized homes; `coverage` lists homes and hub:line evidence. A home is a status-bearing table row whose first cell links the plan. Mentions/order lists remain references; a child without its own row can inherit an explicit `parent_plan:` ancestor's home. Categories come from headings or the containing hub's filing category. Scoping retains full evidence; incomplete scans suppress absence findings. Do not assign homes, rewrite rows, enable the policy or retire a custom coverage check without repository authorization. Available in CLI 0.93.0.
- `runlist roadmap` / `runlist roadmaps` — optional hubs that collect other hubs via `related_plans:` and roll progress up recursively; direct plan children are also supported. Set `execution_mode: roadmap` (scaffold `runlist new hub <hub> --roadmap`, or the equivalent `new plan` form). `runlist roadmap <hub>` shows child progress + next-pickup; `runlist roadmap next` opens the first startable plan across them. `runlist check` nudges a coordination hub whose children are themselves hubs toward `execution_mode: roadmap`. A hub does not require a roadmap parent.
- At scale (>50 plans): `runlist modules --sort cleanup` → `runlist module <name>`

## When mutations refuse repo-wide

If `set` / `archive` / `use` / `baton` / `rename` all start failing — especially with a message naming a **transaction manifest** or a file the command never touched — an abandoned mutation transaction is wedging the repo. Recovery sweeps every manifest on each mutation, so one stuck transaction blocks all of them.

```bash
runlist doctor --transactions           # report: status, owner liveness, each file's generation
runlist doctor --transactions --apply   # clear the ones whose files already agree on one generation
```

`--apply` touches no document content; anything ambiguous is reported for manual review rather than guessed at. Don't hand-delete manifests under `.runlist/transactions/` or hand-restore files — that's what this verb is for.

## Audit (operator)

- `runlist misuse` / `runlist misuse --by-rule` — what wrong-moves the guard intercepted across repos.
- `runlist journal` — per-repo CLI invocation log (opt-in).
