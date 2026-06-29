---
name: dotmd
description: Manage this repo's plans, docs, and prompts with the dotmd CLI. Use when the user asks what's on the plate, references a plan/doc/prompt (or a slug under docs/), queues work, or wants to start, transition, or close one. Covers the order of operations (briefing → use → set → archive) and the rules for handling saved prompts.
allowed-tools: "Bash(dotmd:*), Read"
---

# dotmd workflow

This repo's plans, reference docs, and saved prompts are managed by the **dotmd** CLI (markdown + YAML frontmatter). Always drive them through `dotmd` — never hand-edit frontmatter, never read prompts with the file tools, never commit session-local prompts. The session-start hook prints the live verb sheet and this repo's valid status vocabulary; run `dotmd briefing` any time to refresh it.

## Order of operations

1. **Orient** — `dotmd briefing` (or `dotmd plans`) to see active / paused / ready work, ages, and next steps.
2. **Start work on a plan** — `dotmd use <plan-file>` marks it `in-session` and prints the plan card. (`dotmd set in-session <file>` sets the status without printing.)
3. **Do the work.**
4. **Close it** — pick the status that matches reality (see the decision tree below). Handing off mid-work instead? `dotmd baton @/tmp/draft.md` is the whole closeout: it saves the resume prompt, flips the plan back to `active` (`--status` to override), and prints the exact `git commit` to run. Don't add status changes or triage on top of it.

## The single status verb: `dotmd set <status> [<file>]`

One verb handles starting, transitioning, and closing — it writes the new status to frontmatter, validates it against the doc's type, runs lifecycle hooks, fixes refs, and keeps the index in sync. **Never edit a `status:` line by hand** — direct edits skip all of that.

Closure decision tree for a plan:
- Fully shipped → `dotmd set archived <file>` (or `dotmd archive <file>` — also moves it + fixes refs).
- Shipped, tail deferred → `dotmd set partial <file>` (reference the successor plan in the body).

Add `--note "why"` to any `set`/`archive` to append the reason to `## Version History` in the same call — one tool call instead of status-change + body edit. Example: `dotmd set partial x --note "tail tracked in y.md"`.
- Needs more work later → `dotmd set active <file>`.
- Stuck on a human decision/input → `dotmd set awaiting <file>`.
- Blocked on an external arrival you can't speed up → `dotmd set blocked <file>`.

Valid statuses are type-aware and project-specific — the SessionStart primer lists this repo's set, or run `dotmd statuses list`.

## Creating documents

`dotmd new <type> <name> [body]` — types: `plan`, `doc`, `prompt` (default `doc`).
- `dotmd new plan auth-revamp` → `docs/plans/auth-revamp.md`
- `dotmd new doc token-refresh-design` → `docs/token-refresh-design.md`
- Body input modes (all types): `@path` (preferred for multi-line), `-` (stdin), `--message "…"`, or inline (one-liners only).
- Plan body variants (plans only, mutually exclusive with each other and `--runlist`/`--coordination`): `--lite`/`--minimal` (Problem → Phases → Version History) and `--audit`/`--findings` (Problem → Findings (ranked) → Suggested order → Open Questions).

**Plan frontmatter field lengths — write them right the first time.** `current_state` is a 2-4 sentence summary (cap 1500 chars); `next_step` is a 1-2 sentence pointer (cap 800). Everything longer goes in the body. If a cap warning fires anyway, run `dotmd doctor --frontmatter-fix` ONCE (it mechanically moves the overflow into the body) — do not hand-trim, re-run `dotmd check` in a loop, or audit other docs' warnings you didn't touch.

## Saved prompts — the #1 confusion point

Saved prompts (`docs/prompts/*.md`) are **session-local handoff artifacts**, not source code:

- **Consume, don't read.** If the user references a prompt — "resume via docs/prompts/foo.md", "use this prompt", "load that one" — run `dotmd use <file>` (no arg = oldest pending). It prints the body and archives the prompt atomically so it can't be double-consumed. **Do NOT `cat` it, Read it, or copy its body into chat.**
- **Peek without consuming.** Triaging or surveying pending prompts (not acting on one)? `dotmd prompts show <file>` prints the body read-only — no archive, safe to repeat. Never `dotmd use` a prompt you only meant to look at, and never `use` a prompt you just saved (that destroys the handoff).
- **Don't commit them.** The prompts dir is often gitignored; committing a pending prompt is wrong and may fail. No `git add` / `git commit` of `docs/prompts/*.md`.
- **"Save a resume prompt" = `dotmd baton`**, any time, plan or no plan — never paste a "here's how to resume" block into chat. With a plan in-session, `dotmd baton @/tmp/draft.md` saves the prompt AND releases the plan; with no plan, `dotmd baton <slug> @/tmp/draft.md` just saves `resume-<slug>` and touches nothing else (reference the relevant plans/docs in the draft body). The next session sees it at SessionStart.

## Guardrails (the guard hook enforces these)

- ❌ `git add/commit docs/prompts/*.md` → ✅ they're session-local; the next session runs `dotmd use`. (Merely *mentioning* a prompt path in a commit message or a sibling command is fine — the guard only blocks commits whose pathspec includes a prompt.)
- ❌ `cat`/Read a `docs/prompts/*.md` → ✅ `dotmd use <file>` to consume, `dotmd prompts show <file>` to peek.
- ❌ change a `status:` line by hand (Edit, Write, `sed -i`, `perl -pi`) → ✅ `dotmd set <status> <file>`. This one is **blocked**, not just warned (config `guard: { deny: false }` for warn-only).

## Querying

- `dotmd plans` / `dotmd plans --status active` / `--status in-session`
- `dotmd query --type doc --status active`, `dotmd query --keyword <term>` (add `--body` to scan bodies)
- `dotmd grep <term>` — "which doc discussed X?" Searches frontmatter + bodies, returns doc cards with line-numbered excerpts. Prefer it over raw grep across docs/.
- `dotmd actionable`, `dotmd stale`, `dotmd health`, `dotmd unblocks <file>`
- `dotmd runlist <hub>` / `dotmd runlist next <hub>` for ordered plan sequences. Scaffold one with `dotmd new plan <hub> --runlist a,b,c` (hub + child stubs); `dotmd new plan <hub> --coordination` for a prose-first coordination hub. Worked example — scaffold a sprint, then walk it:
  ```bash
  dotmd new plan auth-revamp --runlist extract,rewrite,cleanup
  #   → hub auth-revamp.md (runlist: [...] + an ## Order of operations list)
  #   + auth-revamp-01-extract.md … -03-cleanup.md (status planned, parent_plan back-ref)
  dotmd runlist auth-revamp        # the sequence + statuses; → marks the next pickup
  dotmd runlist next auth-revamp   # pick up the → child (planned → in-session) + print its card
  ```
- At scale (>50 plans): `dotmd modules --sort cleanup` → `dotmd module <name>`

## Audit (operator)

- `dotmd misuse` / `dotmd misuse --by-rule` — what wrong-moves the guard intercepted across repos.
- `dotmd journal` — per-repo CLI invocation log (opt-in).
