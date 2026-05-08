# Changelog

All notable changes to `dotmd-cli` are documented here. Older releases predate this file — see git tags and the GitHub Releases page for their notes.

## Unreleased

### Breaking changes

- **Default plan vocabulary overhaul.** The built-in `types.plan.statuses` now reads `in-session, active, planned, blocked, partial, paused, awaiting, queued-after, archived` (was `in-session, active, planned, blocked, done, archived`). Every stop-status maps to a distinct unstuck-action — `blocked = monitor`, `partial = spawn successors`, `paused = re-evaluate`, `awaiting = ask`, `queued-after = check predecessor`. See README §"What each plan status means" for the full table.
  - **`done` was removed from the defaults.** It saw effectively zero real-world use (plans went `in-session`/`active` → `archived` directly). To finish a plan, run `dotmd archive <plan-file>`. To keep the previous behavior, add `done` back via `types.plan.statuses` in your config.
  - **`research` was renamed to `scoping`** in the global typeless-fallback `statuses.order` / `staleDays` / `presets.stale` / `context.counted` / health pipeline / `dotmd init` auto-detected order. The name `research` now means only `type: research` everywhere — no more axis collision in queries and briefings.
- Projects with custom `types` overrides (e.g. anything that defines its own `types.plan.statuses` in `dotmd.config.mjs`) are unaffected — defaults only apply when the project doesn't override.

### Migration

- If your docs use `status: done`, either run `dotmd archive <file>` for each one or `dotmd migrate status done archived` to bulk-rewrite, then drop `done` from your config.
- If your docs use `status: research` (typeless), run `dotmd migrate status research scoping`.
- See the upcoming `dotmd statuses` CLI (Phase 3 of the vocabulary plan) for managing per-project status taxonomy without hand-editing config.

### Added

- `quiet` flag on rich-form status definitions — sugar for `skipStale: true, skipWarnings: true`. Use it for visible-but-quiet statuses (`partial`, `paused`, `queued-after`) where you want no nagging but still want them in active-work scope. An explicit `skipStale: false` or `skipWarnings: false` overrides the sugar.
- `dotmd status --help` now lists every default plan status with its unstuck-action.
- `dotmd migrate <field> <old> <new> [files...]` now accepts optional file args. With no files passed it preserves the whole-bucket rename behavior; with files passed it only rewrites the listed docs. This is the affordance for splitting one overloaded status into several distinct ones (e.g. some `backlog` plans → `paused`, others → `partial`). File args match the same way as `bulk archive`: exact path first, then substring fallback against full path or basename. Unmatched file args fail loudly so a typo can't silently skip work.

### Fixed

- Stats and coverage scope filters no longer conflate `skipWarnings` with `terminal`. A status configured `skipWarnings: true, terminal: false` (e.g. a quiet-but-visible `partial`) now correctly appears in active-work scope. Previously the scope filter was `!terminal && !skipWarnings`, which silently excluded any quiet status from briefings; it is now `!terminal` only. If a project relied on `skipWarnings: true` as a stats-exclusion lever, add `terminal: true` to preserve the old behavior.
