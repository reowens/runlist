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
