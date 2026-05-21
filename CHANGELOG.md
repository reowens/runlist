# Changelog

All notable changes to `dotmd-cli` are documented here. Older releases predate this file — see git tags and the GitHub Releases page for their notes.

## 0.27.1 — 2026-05-20

### Fixed

- **`dotmd hud` missed pending prompts when `prompts/` was a root itself ([#6](https://github.com/reowens/dotmd/issues/6)).** `findPendingPrompts` joined every `config.docsRoots` entry with `'prompts'`, which produced nonexistent paths (e.g. `docs/prompts/prompts`) when a consumer's `dotmd.config.mjs` listed `docs/prompts` directly as a root. HUD now detects roots whose basename is already `prompts` and scans them in place, so `dotmd hud --json` surfaces `type: prompt, status: pending` files under either layout.

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
