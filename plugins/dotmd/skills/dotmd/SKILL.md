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
4. **Close it** — pick the status that matches reality (see the decision tree below).

## The single status verb: `dotmd set <status> [<file>]`

One verb handles starting, transitioning, and closing — it writes the new status to frontmatter, validates it against the doc's type, runs lifecycle hooks, fixes refs, and keeps the index in sync. **Never edit a `status:` line by hand** — direct edits skip all of that.

Closure decision tree for a plan:
- Fully shipped → `dotmd set archived <file>` (or `dotmd archive <file>` — also moves it + fixes refs).
- Shipped, tail deferred → `dotmd set partial <file>` (reference the successor plan in the body).
- Needs more work later → `dotmd set active <file>`.
- Stuck on a human decision/input → `dotmd set awaiting <file>`.
- Blocked on an external arrival you can't speed up → `dotmd set blocked <file>`.

Valid statuses are type-aware and project-specific — the SessionStart primer lists this repo's set, or run `dotmd statuses list`.

## Creating documents

`dotmd new <type> <name> [body]` — types: `plan`, `doc`, `prompt` (default `doc`).
- `dotmd new plan auth-revamp` → `docs/plans/auth-revamp.md`
- `dotmd new doc token-refresh-design` → `docs/token-refresh-design.md`
- Body input modes (all types): `@path` (preferred for multi-line), `-` (stdin), `--message "…"`, or inline (one-liners only).

## Saved prompts — the #1 confusion point

Saved prompts (`docs/prompts/*.md`) are **session-local handoff artifacts**, not source code:

- **Consume, don't read.** If the user references a prompt — "resume via docs/prompts/foo.md", "use this prompt", "load that one" — run `dotmd use <file>` (no arg = oldest pending). It prints the body and archives the prompt atomically so it can't be double-consumed. **Do NOT `cat` it, Read it, or copy its body into chat.**
- **Don't commit them.** The prompts dir is often gitignored; committing a pending prompt is wrong and may fail. No `git add` / `git commit` of `docs/prompts/*.md`.
- **Queue one** instead of pasting a "here's how to resume" block into chat: `dotmd new prompt <slug> @/tmp/draft.md` (or `-` for stdin). The next session sees it at SessionStart.

## Guardrails (the guard hook enforces these)

- ❌ `git add/commit docs/prompts/*.md` → ✅ they're session-local; the next session runs `dotmd use`.
- ❌ `cat`/Read a `docs/prompts/*.md` → ✅ `dotmd use <file>`.
- ❌ hand-edit a `status:` field → ✅ `dotmd set <status> <file>`.

## Querying

- `dotmd plans` / `dotmd plans --status active` / `--status in-session`
- `dotmd query --type doc --status active`, `dotmd query --keyword <term>`
- `dotmd actionable`, `dotmd stale`, `dotmd health`, `dotmd unblocks <file>`
- `dotmd runlist <hub>` / `dotmd runlist next <hub>` for ordered plan sequences
- At scale (>50 plans): `dotmd modules --sort cleanup` → `dotmd module <name>`

## Audit (operator)

- `dotmd misuse` / `dotmd misuse --by-rule` — what wrong-moves the guard intercepted across repos.
- `dotmd journal` — per-repo CLI invocation log (opt-in).
