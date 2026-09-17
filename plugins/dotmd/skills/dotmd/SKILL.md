---
name: dotmd
description: Manage this repo's plans, docs, and prompts with the runlist CLI (formerly dotmd). Use when the user asks what's on the plate, references a plan/doc/prompt (or a slug under docs/), queues work, or wants to start, transition, or close one. Covers the order of operations (briefing → use → set → archive) and the rules for handling saved prompts.
allowed-tools: "Bash(runlist:*), Bash(rl:*), Bash(dotmd:*), Read"
---

# runlist workflow

This repo's plans, reference docs, and saved prompts are managed by the **runlist** CLI (markdown + YAML frontmatter; installed from the `dotmd-cli` package, and `dotmd` still works as an alias). Always drive them through `runlist` — never hand-edit frontmatter, never read prompts with the file tools, never commit session-local prompts. The session-start hook prints the live verb sheet and a bounded plan-status vocabulary; if it truncates, use the printed `runlist statuses list --type plan` fallback. Run `runlist briefing` any time to refresh live state.

**Workflow contract** — the irreducible verbs at a glance; the sections below expand each one.

<!-- runlist:canonical-workflow:start -->
- **Orient:** `runlist briefing` — active / paused / ready work, with ages and next steps.
- **Start a plan:** `runlist use <plan-file>` — marks it `in-session` and prints the plan card.
- **Single status verb:** `runlist set <status> [<file>]` writes the status, validates it against the doc's type, runs lifecycle hooks, fixes refs, and syncs the index. **Never hand-edit a `status:` line.** Add `--note "why"` to record the reason in `## Version History` in the same call.
- **Close to match reality:** `archived` (shipped) · `partial` (tail deferred — link the successor) · `active` (more work later) · `awaiting` (needs a human decision) · `blocked` (external arrival you can't speed up). Parking a plan with a known next step? Leave a baton in the same breath — never narrate the next pickup into chat.
- **Hand off / save a resume prompt:** `runlist baton [<plan-or-slug>] @<draft-file>` — write the resume to a file first; saves the prompt and releases the in-session plan (a slug with no plan just saves `resume-<slug>`). Never paste a "here's how to resume" block into chat.
- **Saved prompts are session-local:** consume with `runlist use` (no arg = oldest pending), peek with `runlist prompts show` (`--all` surveys the whole queue in one call). Never read them with file tools, never commit `docs/prompts/*.md`.
<!-- runlist:canonical-workflow:end -->

## Order of operations

1. **Orient** — `runlist briefing` (or `runlist plans`) to see active / paused / ready work, ages, and next steps.
2. **Start work on a plan** — `runlist use <plan-file>` marks it `in-session` and prints the plan card. (`runlist set in-session <file>` sets the status without printing.)
3. **Do the work.**
4. **Close it** — pick the status that matches reality (see the decision tree below). Handing off mid-work instead? `runlist baton @/tmp/draft.md` is the whole closeout: it saves the resume prompt, flips the plan back to `active` (`--status` to override), and prints the exact `git commit` to run. Don't add status changes or triage on top of it.

## The single status verb: `runlist set <status> [<file>]`

One verb handles starting, transitioning, and closing — it writes the new status to frontmatter, validates it against the doc's type, runs lifecycle hooks, fixes refs, and keeps the index in sync. **Never edit a `status:` line by hand** — direct edits skip all of that.

Closure decision tree for a plan:
- Fully shipped → `runlist set archived <file>` (or `runlist archive <file>` — also moves it + fixes refs).
- Shipped, tail deferred → `runlist set partial <file>` (reference the successor plan in the body).

Add `--note "why"` to any `set`/`archive` to append the reason to `## Version History` in the same call — one tool call instead of status-change + body edit. Example: `runlist set partial x --note "tail tracked in y.md"`.
- Needs more work later → `runlist set active <file>`.
- Stuck on a human decision/input → `runlist set awaiting <file>`.
- Blocked on an external arrival you can't speed up → `runlist set blocked <file>`.

Valid statuses are type-aware and project-specific — the SessionStart primer lists a bounded plan set and points to `runlist statuses list --type plan` when truncated.

## Creating documents

`runlist new <type> <name> [body]` — types: `plan`, `doc`, `prompt` (default `doc`).
- `runlist new plan auth-revamp` → `docs/plans/auth-revamp.md`, created `planned` (`--status <s>` to override; `runlist use` starts it)
- `runlist new doc token-refresh-design` → `docs/token-refresh-design.md`
- Body input modes (all types): `@path` (preferred for multi-line), `-` (stdin), `--message "…"`, or inline (one-liners only).
- Plan body variants (plans only, mutually exclusive with each other and `--runlist`/`--coordination`): `--lite`/`--minimal` (Problem → Phases → Version History) and `--audit`/`--findings` (Problem → Findings (ranked) → Suggested order → Open Questions).

**Plan frontmatter field lengths — write them right the first time.** `current_state` is a 2-4 sentence summary (cap 1500 chars); `next_step` is a 1-2 sentence pointer (cap 800). Everything longer goes in the body. If a cap warning fires anyway, run `runlist doctor --frontmatter-fix` ONCE (it mechanically moves the overflow into the body) — do not hand-trim, re-run `runlist check` in a loop, or audit other docs' warnings you didn't touch.

## Saved prompts — the #1 confusion point

Saved prompts (`docs/prompts/*.md`) are **session-local handoff artifacts**, not source code:

- **Consume, don't read.** If the user references a prompt — "resume via docs/prompts/foo.md", "use this prompt", "load that one" — run `runlist use <file>` (no arg = oldest pending). It commits archive/claim before stdout, so body output is at-most-once and the prompt can't be double-consumed; an output failure is recoverable with `runlist prompts show <archived-path>`. **Do NOT `cat` it, Read it, or copy its body into chat.** If the prompt was made by `runlist baton`, consuming it also **claims its plan** (`→ Claimed …`, flips it `in-session`) — so your later `runlist baton` hands that plan off automatically; no need to `runlist use <plan>` first. Only triaging or cleaning up prompts? `runlist use --no-claim <file>` consumes without starting the plan.
- **Ownership is durable and session-local.** Claims live under gitignored `.runlist/` (legacy `.dotmd/` is still read); no-target `set`/`baton` never guesses from journal entries or global in-session counts. Pickup hooks are at-least-once with stable `operationId` values, and a live delivery lease blocks release/takeover.
- **Peek without consuming.** Triaging or surveying pending prompts (not acting on one)? `runlist prompts show <file>` prints the body read-only — no archive, safe to repeat. Never `runlist use` a prompt you only meant to look at, and never `use` a prompt you just saved (that destroys the handoff).
- **Survey the whole queue in ONE call.** `runlist prompts show --all` peeks every pending prompt (`--limit N` to cap, or pass several names: `runlist prompts show a b c`). Reaching for Read once per file is the single most common wrong-move in the guard log — the bulk verb exists so you never need to.
- **Don't commit them.** The prompts dir is often gitignored; committing a pending prompt is wrong and may fail. No `git add` / `git commit` of `docs/prompts/*.md`.
- **"Save a resume prompt" = `runlist baton`**, any time, plan or no plan — never paste a "here's how to resume" block into chat. With a plan in-session, `runlist baton @/tmp/draft.md` saves the prompt AND releases the plan; with no plan, `runlist baton <slug> @/tmp/draft.md` just saves `resume-<slug>` and touches nothing else (reference the relevant plans/docs in the draft body). The next session sees it at SessionStart. Baton refuses, saving nothing, when a handoff for that work is already pending: consume or archive the waiting prompt first, then re-run.

## Guardrails (the guard hook enforces these)

- ❌ `git add/commit docs/prompts/*.md` → ✅ they're session-local; the next session runs `runlist use`. (Merely *mentioning* a prompt path in a commit message or a sibling command is fine — the guard only blocks commits whose pathspec includes a prompt.)
- ❌ `cat`/Read a `docs/prompts/*.md` → ✅ `runlist use <file>` to consume, `runlist prompts show <file>` to peek, `runlist prompts show --all` to survey the queue. Reading them one file at a time is still the wrong move — there is a bulk verb.
- ❌ change a `status:` line by hand (Edit, Write, `sed -i`, `perl -pi`) → ✅ `runlist set <status> <file>`. This one is **blocked**, not just warned (config `guard: { deny: false }` for warn-only).

## Querying

- `runlist plans` / `runlist plans --status active` / `--status in-session`
- `runlist query --type doc --status active`, `runlist query --keyword <term>` (add `--body` to scan bodies)
- `runlist grep <term>` — "which doc discussed X?" Searches frontmatter + bodies, returns doc cards with line-numbered excerpts. Prefer it over raw grep across docs/.
- `runlist actionable`, `runlist stale`, `runlist health`, `runlist unblocks <file>`
- `runlist runlist <hub>` / `runlist runlist next <hub>` for ordered plan sequences. Scaffold one with `runlist new plan <hub> --runlist a,b,c` (hub + child stubs); `runlist new plan <hub> --coordination` for a prose-first coordination hub. Worked example — scaffold a sprint, then walk it:
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
- `runlist roadmap` / `runlist roadmaps` — the tier ABOVE runlists. A hub with `execution_mode: roadmap` (scaffold `runlist new plan <hub> --roadmap`) composes *runlists* via `related_plans:` and rolls their `done/total` up into a recursive grand total. `runlist roadmap <hub>` shows each child runlist's progress + next-pickup; `runlist roadmap next` opens the first startable plan across all of them. `runlist check` nudges a coordination hub whose children are themselves runlists toward `execution_mode: roadmap`.
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
