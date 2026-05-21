# Changelog

All notable changes to `dotmd-cli` are documented here. Older releases predate this file — see git tags and the GitHub Releases page for their notes.

## 0.28.0 — 2026-05-21

### Changed

- **Unknown statuses are now validation errors, not warnings.** `dotmd check` previously emitted a warning when a doc's `status:` wasn't in the configured vocabulary, which let typos and stale values drift through `--errors-only` filters and CI gates. They now surface as errors, fail `check`, and are picked up by `dotmd doctor` and `--errors-only`. Use `dotmd statuses add <name>` (or edit your config) if the status is legitimate; use `dotmd migrate status <old> <new>` to bulk-rename a typo.

### Fixed

- **Inline YAML flow arrays now parse.** Frontmatter values like `surfaces: []` or `tags: [a, b, c]` (the YAML flow-style shorthand) were previously read as the string `"[]"` / `"[a, b, c]"`, breaking taxonomy lookups and reference-field checks. They now parse to actual arrays, matching the block-form behaviour (`tags:\n  - a\n  - b`). No migration needed; affected docs start validating correctly on next run.

## 0.27.1 — 2026-05-20

### Fixed

- **`dotmd hud` missed pending prompts when `prompts/` was a root itself ([#6](https://github.com/reowens/dotmd/issues/6)).** `findPendingPrompts` joined every `config.docsRoots` entry with `'prompts'`, which produced nonexistent paths (e.g. `docs/prompts/prompts`) when a consumer's `dotmd.config.mjs` listed `docs/prompts` directly as a root. HUD now detects roots whose basename is already `prompts` and scans them in place, so `dotmd hud --json` surfaces `type: prompt, status: pending` files under either layout.

## 0.27.0 — 2026-05-13

### Added

- **`dotmd prompts <subcommand>` namespace.** `list` (default), `next` (claim + print the oldest pending prompt), `use <file>` (claim a specific prompt), `archive <file>`, `new <name> [body]`. Pairs with the prompt type added in 0.23.
- **HUD prompt awareness.** `dotmd hud` now reports pending prompts alongside held leases and queued handoffs, so saved prompts surface at session start without a separate query.

## 0.26.0 — 2026-05-13

### Added

- **YAML multiline scalar parser** (`|`, `>`, with chomping indicators) — frontmatter bodies can now hold multi-line values without inline-escaping.
- **`doc` template lint rules + auto Version History.** Doc-template heading drift is now caught by lint, and `dotmd new doc` seeds the Version History section automatically.

## 0.25.0 — 2026-05-13

### Changed

- **Enriched `doc` template.** New docs scaffold with a build-up shape (Overview → Version History → Related Documentation) plus richer frontmatter (modules, surfaces, domain, audience, related_plans, related_docs).
- **Dropped the unused `research` default type.** `research` never carried its weight as a distinct vocabulary — analyses, audits, and investigations fit better under `doc`. Existing docs with `type: research` keep working (rendered, exported, queryable), but the type isn't in the default config anymore. Add it back via `types.research` if you want it.

## 0.24.1 — 2026-05-13

### Added

- **Positional substring filter for `dotmd plans`.** `dotmd plans auth payments` filters to plans whose title or path contains both words — same matcher as `bulk archive` file args.

## 0.24.0 — 2026-05-13

### Added

- **Tighter `dotmd plans` / `dotmd prompts` defaults** — both now hide archived by default; pass `--include-archived` to see them.
- **Prompts migrator.** Bulk-promote inline session reminders to `type: prompt` docs.

## 0.23.0 — 2026-05-13

### Breaking changes

- **`dotmd new` is now type-first.** Signature changed from `dotmd new <name> --template <t>` to `dotmd new <type> <name> [body]`. The legacy `--template` flag was removed; the legacy templates `adr`, `rfc`, `audit`, and `design` were dropped (they all expanded to `type: doc` with cosmetic shape differences and saw little real use). `<type>` is optional and defaults to `doc`, so `dotmd new my-doc` still works.
  - **Migration:** `dotmd new my-plan --template plan` → `dotmd new plan my-plan`. `dotmd new my-decision --template adr` → `dotmd new doc my-decision` (then write the ADR shape yourself, or add a custom `adr` template in config).
- **`prompt` type added to defaults.** Statuses `pending`, `claimed`, `archived`. `dotmd new prompt <name>` requires a body (inline, `--message`, `-` for stdin, or `@path`).
- **`--list-templates` renamed to `--list-types`** (the old name still works as an alias).

## 0.22.1 — 2026-05-13

### Fixed

- `dotmd doctor --migrate-template` now catches `## Out of Scope` (capital S) in addition to lowercase `## Out of scope` when retrofitting legacy plans.

## 0.22.0 — 2026-05-13

### Added

- **`dotmd doctor --migrate-template`** — retrofits old plans into the 0.19 build-up shape, mapping legacy headings to the new section structure.

## 0.21.0 — 2026-05-13

### Added

- **Plan-shape lint rules.** `dotmd lint` now enforces template discipline on `type: plan` docs — Problem / Phases / Closeout headings, phase-status markers, Version History block. Pairs with the `--migrate-template` doctor mode added in 0.22.

## 0.20.0 — 2026-05-13

### Changed

- **Pickup card.** `dotmd pickup` now prints a pointer card (frontmatter + first ~150 lines + section index) instead of the full plan body. ~150× token reduction on large plans; pass `--full` to restore the previous behaviour.

## 0.19.0 — 2026-05-13

### Added

- **Build-up plan template.** New plans scaffold with Problem → Phases (with status markers) → Closeout shape and a Version History block. Designed to make plan-state visible from the headings alone.
- **ISO timestamps everywhere.** `created` and `updated` frontmatter fields now carry full ISO-8601 timestamps (date + time + offset), not just dates. Existing date-only values still parse — `touch`, `archive`, and friends migrate them on next write.

## 0.18.0 — 2026-05-13

### Added

- **`dotmd handoff <plan> [body]`.** Writes a resume-prompt sidecar at `.dotmd/handoffs/<plan-path>`, releases the lease, and flips the plan back to its prior status. Next `dotmd pickup` of that plan prints the handoff instead of the body and atomically consumes the sidecar (single-claim).
- **`dotmd hud`.** Three-line session-start triage — held leases, queued handoffs, stuck leases. Silent when clean. Designed as a zero-pollution replacement for `dotmd briefing` in the Claude Code `SessionStart` hook.
- **`dotmd release`** added as the recommended name for `dotmd unpickup` (both still work).

## 0.17.1 — 2026-05-09

### Fixed

- **README `SessionEnd` hook recipe was using the wrong shape.** The 0.17.0 docs showed the unwrapped form (`{ "SessionEnd": [{ "type": "command", … }] }`), which Claude Code silently ignores. The correct schema requires the wrapped form: `{ "hooks": { "SessionEnd": [{ "hooks": [{ "type": "command", … }] }] } }` — confirmed against the official `claude-code-settings.json` schema. README updated; users who copied the old recipe should update theirs. Also note: `Bash(dotmd:*)` must be present in `permissions.allow` or the hook command is blocked.

## 0.17.0 — 2026-05-09

### Added

- **Session leases.** `dotmd pickup` now writes a per-session lease at `<repoRoot>/.dotmd/in-session.json` recording who holds each `in-session` plan (session id, pid, host, prior status, timestamp). Session id is sourced from `$CLAUDE_CODE_SESSION_ID` (set by Claude Code) with fallbacks to `$CLAUDE_SESSION_ID`, `$TERM_SESSION_ID`, and a `shell:<user>@<host>` last resort. The lease enables silent re-attach across `/clear` and auto-compaction (same-session pickup of a plan you already hold no longer errors), distinguishes live conflicts from stale leases, and gives the next agent a clear takeover path. Lease writes are atomic (sibling temp + rename) and serialised by an advisory lockfile with a 5s stale-lock timeout.
- **`dotmd unpickup [<file>]`.** Releases in-session leases and flips frontmatter back to the recorded prior status. With no args, releases every lease owned by the current session — the form intended for a Claude Code `SessionEnd` hook. Flags: `--to <status>` (override target), `--all` (release every lease), `--stale` (release leases with dead pid or >24h old), `--force` (override cross-session refusal), `--json`, `--dry-run`. Manual-edit fallback: if the plan's status is `in-session` but no lease exists, `--to <status>` flips it anyway with a warning. Calls a new `hooks.onUnpickup` config callback on each release.
- **`dotmd pickup --takeover`.** Force-claim a plan held by another session (typical use: the prior holder crashed or the lease is >24h old). Records `takenOverFrom: { session, pid, pickedUpAt }` on the new lease for an audit trail.
- **`dotmd briefing` surfaces stuck leases.** When `findStaleLeases` returns non-empty, the briefing prints `Stuck in-session: N (>1d or dead pid, run \`dotmd unpickup --stale\`)`.
- **`dotmd init` ensures `.dotmd/` is gitignored.** Creates `.gitignore` if missing, appends `.dotmd/` if absent, and is idempotent on re-run.
- **README "Session leases & unpickup" section** documenting the lease semantics, the session-id resolution order, the `SessionEnd` hook recipe for `~/.claude/settings.json`, and the takeover workflow.

### Changed

- `dotmd pickup` no longer hard-rejects a plan whose status is already `in-session`. It defers the decision to the lease layer: same session → silent re-attach (prints body, no frontmatter rewrite); different session, live pid → refuses with `Held by <host>/<session> …`; different session, dead pid or >24h → suggests `--takeover`.
- `dotmd finish` / `dotmd archive` / `dotmd rename` auto-release (or migrate) the corresponding lease so the common closeout paths don't leave orphan state.

### Tests

- 552 → 598 (+46): 29 unit tests in `test/lease.test.mjs` covering env-precedence resolution, atomic writes, lock recovery, all `acquireLease` outcomes, stale detection, and key migration; 17 integration tests in `test/lifecycle.test.mjs` covering pickup re-attach / cross-session refusal / takeover, every `unpickup` mode, auto-release on archive/rename, and the `init` gitignore behaviour.

## 0.16.1 — 2026-05-09

### Changed

- **Default `paused` plan-status is now loud, not quiet.** Previously configured as `quiet: true` (skipStale + skipWarnings); now configured with `staleDays: 3` and no quiet sugar. The original definition treated `paused` as "intentionally set aside" — interchangeable with `queued-after` — but real usage shows `paused` means "started, stopped mid-work, needs near-term review." That deserves stale pressure, not silence. Projects with custom `types.plan.statuses` overrides are unaffected.
  - Lifecycle-flag effect: `paused` is no longer in `skipStaleFor` / `skipWarningsFor` defaults; it is now in `staleDays` with a 3-day threshold. Still NOT terminal — it stays in active-work scope.
  - README and CLAUDE.md tables updated; rich-form example in `dotmd.config.example.mjs` reflects the new default.
  - If you relied on the old quiet behavior, add an explicit `paused: { quiet: true }` override to your project's `types.plan.statuses` (or run `dotmd statuses set paused --type plan --quiet`).

## 0.16.0 — 2026-05-09

### Breaking changes

- **Default plan vocabulary overhaul.** The built-in `types.plan.statuses` now reads `in-session, active, planned, blocked, partial, paused, awaiting, queued-after, archived` (was `in-session, active, planned, blocked, done, archived`). Every stop-status maps to a distinct unstuck-action — `blocked = monitor`, `partial = spawn successors`, `paused = re-evaluate`, `awaiting = ask`, `queued-after = check predecessor`. See README §"What each plan status means" for the full table.
  - **`done` was removed from the defaults.** It saw effectively zero real-world use (plans went `in-session`/`active` → `archived` directly). To finish a plan, run `dotmd archive <plan-file>`. To keep the previous behavior, add `done` back via `types.plan.statuses` in your config.
  - **`research` was renamed to `scoping`** in the global typeless-fallback `statuses.order` / `staleDays` / `presets.stale` / `context.counted` / health pipeline / `dotmd init` auto-detected order. The name `research` now means only `type: research` everywhere — no more axis collision in queries and briefings.
- Projects with custom `types` overrides (e.g. anything that defines its own `types.plan.statuses` in `dotmd.config.mjs`) are unaffected — defaults only apply when the project doesn't override.

### Migration

- If your docs use `status: done`, either run `dotmd archive <file>` for each one or `dotmd migrate status done archived` to bulk-rewrite, then drop `done` from your config.
- If your docs use `status: research` (typeless), run `dotmd migrate status research scoping`.
- See the new `dotmd statuses` CLI (in this release) for managing per-project status taxonomy without hand-editing config.

### Added

- `quiet` flag on rich-form status definitions — sugar for `skipStale: true, skipWarnings: true`. Use it for visible-but-quiet statuses (`partial`, `paused`, `queued-after`) where you want no nagging but still want them in active-work scope. An explicit `skipStale: false` or `skipWarnings: false` overrides the sugar.
- `dotmd status --help` now lists every default plan status with its unstuck-action.
- `dotmd migrate <field> <old> <new> [files...]` now accepts optional file args. With no files passed it preserves the whole-bucket rename behavior; with files passed it only rewrites the listed docs. This is the affordance for splitting one overloaded status into several distinct ones (e.g. some `backlog` plans → `paused`, others → `partial`). File args match the same way as `bulk archive`: exact path first, then substring fallback against full path or basename. Unmatched file args fail loudly so a typo can't silently skip work.
- `dotmd doctor --statuses` — read-only diagnostic that flags overloaded status buckets. For each status with at least 10 docs, it scores `current_state` + `next_step` text against cue keywords (`partial` / `paused` / `awaiting` / `queued-after` / `blocked`); when two or more cue groups each claim ≥15% of the bucket, it prints a split suggestion (e.g. "47 plans → 22 partial / 15 paused / 6 queued-after / 4 kept"). Never writes; always ends with "Heuristic — verify before migrating." `--json` produces a machine-readable shape for tooling.
- `dotmd statuses` — manage per-project status taxonomy from the CLI instead of hand-editing the 7-flag rich-form object in `dotmd.config.mjs`. Subcommands: `list` (table view, also `--json`), `add <name> --type <t> [--like <existing>] [flags...]` (clones from `--like` then overlays user flags), `set <name> --type <t> <flags...>` (edit individual flags), `remove <name> --type <t>` (refuses if any docs use the status, lists offenders, suggests `dotmd migrate`), and `migrate <type>` (one-shot conversion of array-form `statuses: [...]` to rich-form `statuses: {...}`, pulling in peer `staleDays` / `context` / `taxonomy.moduleRequiredFor`). All write commands print a flag diff and prompt for confirmation (skip with `--yes`, preview with `--dry-run`). Writes are atomic: edits land in a sibling temp file, are validated by re-import + a clean `resolveConfig()` pass, then renamed into place — a syntax error or new warning leaves the original untouched.
- **Lifecycle-override safety check.** Configs that define both rich-form `types` and an explicit `export const lifecycle = {...}` silently ignore per-status flags at runtime (the explicit lifecycle export wins over the derived one). `dotmd statuses` write commands detect this and refuse to write unless `--ignore-lifecycle-override` is passed, with a message recommending you delete the explicit `lifecycle` block.
- The rich-form example block in `dotmd.config.example.mjs` no longer shows an explicit `lifecycle` export — new projects starting from the example won't inherit the override trap. The array-form example block keeps its `lifecycle` export (still required there).

### Fixed

- Stats and coverage scope filters no longer conflate `skipWarnings` with `terminal`. A status configured `skipWarnings: true, terminal: false` (e.g. a quiet-but-visible `partial`) now correctly appears in active-work scope. Previously the scope filter was `!terminal && !skipWarnings`, which silently excluded any quiet status from briefings; it is now `!terminal` only. If a project relied on `skipWarnings: true` as a stats-exclusion lever, add `terminal: true` to preserve the old behavior.
