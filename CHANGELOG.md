# Changelog

All notable changes to `dotmd-cli` are documented here. Older releases predate this file — see git tags and the GitHub Releases page for their notes.

## 0.31.4 — 2026-05-24

Six fixes from the gmax-repo audit — a different shape than the dotmd self-audit because gmax is a brownfield repo with pre-existing markdown that `dotmd init` had to ingest. Findings ordered by severity, not commit order.

### Fixed

- **`dotmd list` surfaces untagged docs.** Every status section filtered by `d.status === ...`, so docs without a `status:` in frontmatter (or no frontmatter at all) were silently dropped. On a freshly-init'd repo with N pre-existing markdown files, `dotmd list` printed just "Index" — looked like the tool didn't see them. Both `_renderCompactList` and `_renderVerboseList` now append an "Untagged (N) — missing \`status:\` in frontmatter" section listing the paths so users can find and tag them. (gmax audit #1.)

- **`dotmd hud` surfaces validation errors.** Documented as "silent when clean" but stayed silent even when there were N validation errors. A SessionStart hook firing hud therefore left the agent with no signal that `check` was failing. `buildHud` now runs `buildIndex(config)` and includes an `errors` count in its return shape; `runHud` renders a red `✗ N validation errors  (run: dotmd check)` line when > 0. Both text and `--json` output include the new field. (gmax audit #5.)

- **Terminal-status snapshots no longer claim stale "in progress" body text.** Body-scraped `currentState` was clobbering archive docs with claims like `Archived: FIXED (uncommitted)` or `Archived: In progress` — diagnostic snapshots from when the doc was live, now misleading on docs explicitly tagged terminal. For statuses in `lifecycle.terminalStatuses` (archived/reference/deprecated by default), the body-scrape AND the "No current_state set" fallback are both dropped at the index layer when frontmatter has no explicit `current_state:`. Explicit frontmatter still wins. Render layer aligned: terminal docs without currentState render as bare-status (`Reference`, not `Reference: No current_state set` or `Reference: <stale body claim>`). Verbose-list and `dotmd query` got null guards so they don't print `: null` for terminal docs. (gmax audit #3, #4, D.)

- **`dotmd new doc <name> "body"` accepts body and lands it in Overview.** Pre-fix the doc template rejected body input with advice to set `acceptsBody: true` on a custom template — but init scaffolds no custom doc template, so the fix advice was a dead-end. `doc` now declares `acceptsBody: true` and consumes `ctx.bodyInput` in its body fn, placing inline / `--message` / `@path` / stdin body under the `## Overview` heading. Plan stays rejecting (highly structured, no obvious slot). (gmax audit #7.)

- **`dotmd init` warns when `docs/` is gitignored.** Pre-fix, init silently scaffolded `docs/` into repos where `docs/` was already in `.gitignore`, so every doc dotmd managed was untracked. The user only found out via `git ls-files docs/`. Init now runs `git check-ignore -q docs/` after the .gitignore write-or-skip block and emits a yellow notice with the concrete remediation hint (`!docs/`) when the dir is ignored. Only runs inside git repos. (gmax audit #2.)

## 0.31.3 — 2026-05-23

Closes the self-dogfood audit started in 0.31.1. Four remaining findings shipped; all eleven audit findings are now resolved.

### Fixed

- **Fresh `dotmd init` scaffolds `.claude/commands/*` on first run.** The dispatcher resolved config BEFORE `runInit` ran, so on a brand-new repo (no `dotmd.config.mjs` yet) it passed `null` to `runInit`. `runInit`'s slash-command block was gated on `if (config)` and silently skipped — `.claude/commands/*` only appeared on a second `dotmd init`, after the starter config already existed. `runInit` is now async and re-resolves the config from disk after the file-write phase, so STARTER_CONFIG (just written this run) or any pre-existing config is picked up uniformly. The dispatcher's `config.configFound ? config : null` ternary is gone. Dry-run path also now correctly previews the `.claude/commands/*` lines that were silently missing before. (Audit finding #11.)

- **`pickup`'s `Related:` resolver finds same-dir sibling refs.** `readRelatedSummary` in `src/pickup-card.mjs` used `resolveDocPath`, which only tries repo-root and docsRoots-relative paths — never doc-relative. So a bare-basename ref like `sibling.md` written in `docs/plans/foo.md`'s `related_plans:` always rendered `(missing)`, even though `graph` and `validate` resolved the same ref fine via `resolveRefPath` (doc-relative first, then repo-relative). Two resolvers, two semantics, one silently wrong from inside a doc. Now matches graph/validate semantics: `resolveRefPath(refStr, docDir, repoRoot) ?? resolveDocPath(refStr, config)` so doc-relative wins, with docsRoots-relative kept as a final fallback for legacy refs. (Audit finding #9.)

- **`dotmd doctor` numbered steps are contiguous `1–6`.** Pre-fix, step 5's heading (Claude Code commands) was conditional on having `updated`/`created` results to print, so output went `1, 2, 3, 4, 6` whenever there was nothing to refresh — and looked like a numbering bug. Step 4 (Regenerate index) had the same shape of bug, conditional on `config.indexPath` (would silently produce `1, 2, 3, 5, 6` on configs without an index). Both headings now always print, with a status body line (`No index path configured (skip).` / `Nothing to refresh.`) so the body still says something useful when there's nothing to do. (Audit finding #10.)

- **`dotmd briefing` Errors count now hints at `dotmd check`.** `Errors: 1` with no detail forced the user to know to run `dotmd check` separately to see what or where. The line now renders `Errors: 1 (run \`dotmd check\` to see)` (dimmed) when the count is non-zero. The zero-error case stays terse — no point hinting at empty output. (Audit finding #8.)

## 0.31.2 — 2026-05-23

This release is the back half of the self-dogfood audit started in 0.31.1. Six discrete fixes; all surfaced by running every dotmd command against the dotmd repo and tracking down the first thing that went wrong.

### Fixed

- **Out-of-box `referenceFields` defaults.** Fresh `dotmd init` scaffolded a config with no `referenceFields`, so `graph`, `deps`, `unblocks`, and `pickup`'s `Related:` resolver were dead on arrival on every new repo even though the built-in `plan` and `doc` templates were already writing `related_plans:`, `related_docs:`, and `parent_plan:`. `DEFAULTS.referenceFields` in `src/config.mjs` now ships with `bidirectional: ['related_plans', 'related_docs']` and `unidirectional: ['parent_plan']`, so every config that omits `referenceFields` inherits the matching defaults (including all v0.31.1-and-earlier configs once they upgrade). `STARTER_CONFIG` writes the same block explicitly so users see the wiring in their own config file. (Audit finding #2.)

- **Freshly-created prompts pass `dotmd check` cleanly.** `dotmd new prompt` (and `dotmd prompts new`) produced a file that immediately failed `check` with one error and two warnings: missing `updated:`, missing `title`, missing `summary`. The canonical "save a prompt for the next session" flow consistently put new files into an error state. Two changes: the prompt template now writes `updated: ${d}` alongside `created:` (matching plan and doc templates), and the validator exempts `type: prompt` from the title and summary warnings because prompts are intentionally body-only one-shot artifacts — the slug names them, the body IS the payload. (Audit finding #3.)

- **`dotmd new` regenerates the index after writing.** A `dotmd new` of any type wrote the file and stopped, leaving `docs/docs.md`'s generated block stale and causing the next `dotmd check` to error on a failure the user couldn't have caused. `runNew` now regenerates the index block after the write (mirroring what `archive` and `status` already did on archive crossings). Wrapped in try/catch so an index failure can't undo a successful create. (Audit finding #4, primary.)

- **Every status, lifecycle, and rename mutation regenerates the index.** The drift surface was broader than `new`. Pre-fix, only archive-crossing transitions regen'd the index. A pure `active → planned` left the per-status sections out of date; `pickup` / `release` / `finish` didn't regen at all (so `## In-session` was always wrong); `rename` left the index links pointing at the old basename. Introduces a `regenIndex(config)` helper in `src/lifecycle.mjs`, called from every doc-set or status mutation. `new` and `rename` import the same helper. (Audit finding #4, broader.)

- **Generated `.claude/commands/plans.md` references real commands only.** The slash-command template had listed `dotmd next` since its initial introduction in March 2026. The command never existed in the dispatcher — agents reading the slash command doc hit `Unknown command: next. Did you mean dotmd new?`. Replaced with `dotmd actionable` (the existing preset filtering to `status: active,ready` AND `has-next-step` — exactly the original "ready plans, what to promote" intent). To prevent the next phantom-command bug, extracted `KNOWN_COMMANDS` from `bin/dotmd.mjs` into `src/commands.mjs` and added a regression test that parses every backtick `dotmd <verb>` from both generated templates and asserts each verb resolves. (Audit finding #6.)

- **`dotmd init` respects `--dry-run` and reports every slash-command outcome.** Two bugs hiding each other. `runInit` took no `dryRun` param and ignored the global `--dry-run` flag entirely — `dotmd init -n` actually wrote the config, docs/, gitignore line, and `.claude/commands/*`. `scaffoldClaudeCommands` had the same gap. Both now accept `{ dryRun }`, every write is gated, every output line is prefixed `[dry-run]` when previewing. Separately, the init report loop only handled the `created` and `current` slash-command outcomes — `updated` (regen from older banner) was silently dropped even though the regen really happened, and `skipped` (user-managed file, no banner) was also unreported. Now all four outcomes print with unified verbs (`create` / `update` / `exists` / `skip`). (Audit finding #7.)

## 0.31.1 — 2026-05-23

### Fixed

- **`dotmd archive` (and `prompts use`, `prompts archive`, `rename`, `status` → archived/unarchived) no longer fails on uncommitted files.** All of these went through `gitMv`, which shelled out to `git mv` unconditionally. On a file that had never been `git add`-ed — the common case of scaffolding a doc and archiving it in the same session — `git mv` errors with `fatal: not under version control`, and the user has no recourse since the file is genuinely a doc, just not yet staged. `dotmd prompts use` was especially affected because the canonical "queue a prompt for the next session" workflow creates a prompt that is consumed before any commit happens.

  `gitMv` now checks `git ls-files --error-unmatch` first. Tracked sources still use `git mv` (preserving rename history). Untracked sources — and sources in directories that aren't git repos at all — fall back to `fs.renameSync`. Behavior is otherwise identical; return shape is unchanged. Tests in `test/git.test.mjs` cover the tracked path, the untracked path, and the no-repo path.

- **`dotmd stats`, `dotmd coverage`, `dotmd check`'s module-required validator, and `dotmd export` (markdown + html) now read the canonical `surfaces:` / `modules:` plural arrays.** The default plan template writes the plural list form, and `src/index.mjs` merges any singular `surface:` / `module:` value into the plural array so plural is the source of truth. But four readers still consulted only the singular field, so a plan with `surfaces: [cli]` and `modules: [init, doctor]` showed up as "missing surface" / "missing module" in coverage and stats, and was rejected by the module-required validator for active/ready/planned/blocked docs. `dotmd list --json` made the gap visible — `"surface": null` and `"surfaces": ["cli"]` side by side, with downstream readers consulting the null.

  After the fix, plural-only and singular-only and mixed forms all count identically. `dotmd graph --json` now emits both `module`/`surface` and `modules`/`surfaces` for forward compat. Regression tests cover plural-only docs in `test/stats.test.mjs` and `test/render.test.mjs`.

## 0.31.0 — 2026-05-23

### Removed (BREAKING)

- **`dotmd handoff` command removed.** It overlapped with `dotmd prompts` — both surfaces answered "leave a note for a future session" but with different storage (gitignored sidecar vs. tracked prompt file), different consumption semantics (atomic unlink vs. status transition), and parallel CLIs. Real-world usage stayed on prompts; handoff sat unused. Running `dotmd handoff` now errors with a pointer to `dotmd prompts new`.

- **`.dotmd/handoffs/` sidecar mechanism removed.** Pickup no longer reads or unlinks sidecars; the directory is now ignored. The `listQueuedHandoffs`, `hasHandoff`, `consumeHandoff`, `appendHandoff`, and `handoffPath` helpers (and `src/handoff.mjs` itself) are gone.

- **`/handoff` slash command no longer scaffolded.** `dotmd init` and `dotmd doctor` only install `plans.md` and `docs.md` under `.claude/commands/`. Existing `.claude/commands/handoff.md` files are left untouched (user-managed or stale-marker).

- **`dotmd hud` dropped the "N handoffs queued" line.** Output now has at most three lines (held leases / pending prompts / stale leases) instead of four. `--json` output no longer contains `queued`.

- **`dotmd pickup --json` dropped `handoffConsumed`.** Picking up a plan never reads a sidecar anymore, so the flag has no meaning.

### Migration

If you have queued sidecars under `.dotmd/handoffs/`, they will be silently ignored by 0.31.0. To convert one to a prompt before upgrading (or by hand after):

```bash
# Replace <name> and <body-path> with the sidecar's plan slug and file.
dotmd prompts new <name> @<.dotmd/handoffs/path/to/sidecar.md>
rm <.dotmd/handoffs/path/to/sidecar.md>
```

Or just delete `.dotmd/handoffs/` if the queued state is no longer needed.

## 0.30.0 — 2026-05-23

### Added

- **`dotmd init` now scaffolds and detects `docs/plans/` and `docs/prompts/`.** Previously `init` only created `docs/` and `docs/docs.md` — the canonical subdirs for the built-in `plan` and `prompt` templates were left for the user to discover via the first failing `dotmd new plan`. Now `init` creates them up-front, and the scan reports per-subdir counts split into dotmd-tracked (frontmatter-bearing) vs. plain-markdown files so files without frontmatter aren't invisible.

- **`dotmd init` warns about root-level `plans/` and `prompts/` siblings.** When `./plans/` or `./prompts/` exist at the repo root with `.md` content, `init` skips scaffolding the matching `docs/<sub>/` (avoiding a parallel-tree footgun) and prints a `notice` block with two concrete remediations: a `mv` command to move the files under `docs/`, or the `export const root = ['plans', 'prompts']` snippet for a flat layout. Empty root-level siblings are ignored.

## 0.29.2 — 2026-05-21

### Fixed

- **`dotmd new` no longer silently discards body input on non-body templates ([#9](https://github.com/reowens/dotmd/issues/9)).** The CLI accepted `-` (stdin), `@path`, `--message`, and inline body args for any template, but only the built-in `prompt` template's `body(t, ctx)` actually consumed `ctx.bodyInput`. `plan`, `doc`, and any user template that didn't reference `ctx.bodyInput` silently threw the input away. `dotmd new plan my-plan - <<EOF ... EOF` produced a plan with the canned template and no trace of the heredoc.

  Now: when body input is passed to a template that doesn't declare `acceptsBody: true` (or the existing `requiresBody: true`), `dotmd new` errors immediately, naming the input source (stdin / `--message` / `@path` / inline) and listing the built-in templates that accept body. The fast-fail surface makes the silent-discard footgun structurally impossible.

  Custom user templates that consume `ctx.bodyInput` should set `acceptsBody: true` to opt in. Built-in `prompt` now declares both `acceptsBody` and `requiresBody` for symmetry.

## 0.29.1 — 2026-05-21

### Added

- **`dotmd check` flags archive drift ([#8](https://github.com/reowens/dotmd/issues/8)).** A doc with an archive-flagged `status:` (default: `archived`) whose path is a direct child of a configured root — or a direct child of `<root>/plans/` or `<root>/prompts/` under a single-root config — now errors. Without this check, the file was invisible to default `dotmd plans` / `dotmd prompts` views (both filters exclude archive paths), so the user saw N files on disk but only M < N in the index with no signal about the gap.

  Error message names both the wrong location and the expected one, plus the exact `dotmd archive <path>` command to relocate. Nested non-archive subdirs (e.g. `docs/plans/audit/catalog-audit.md`) are exempt — that's an intentional clustering pattern the check shouldn't punish.

  The "live type-conventional dirs" set is built from each configured root plus the built-in template dirs (`plans`, `prompts`) joined to each root. Custom `templates.<type>.dir` values from your config extend the set, so user-added types are covered too.

### Migration

- Run `dotmd check` after upgrading. For each new drift error, run the `dotmd archive <path>` command in the error message — it relocates the file under `<root>/<archiveDir>/` atomically. If the destination already exists (a true duplicate), pick the version you want to keep and resolve by hand.

## 0.29.0 — 2026-05-21

### Changed (potentially breaking)

- **Type-scoped status validation is now strict.** When a doc declares a known `type:` (e.g., `prompt`, `plan`, `doc`), its `status:` must come from that type's `types.<type>.statuses` vocabulary. Previously the validator fell through to the global union of all types' statuses, which meant `type: prompt, status: active` silently passed because `active` was valid for plans. The whole point of type-scoped vocabularies was nullified by the lenient fallthrough.

  After upgrade, `dotmd check` will newly-error on type-status mismatches. Common causes:

  1. **Missing `archived` in `types.<doc|research>.statuses`.** If you use custom `types` config and `dotmd archive` on docs or research, `status: archived` may not be in the type's vocab. Fix: add `'archived': { context: 'counted', archive: true, terminal: true, quiet: true }` to each affected type.
  2. **Mis-typed documents.** A reference doc with `type: plan` and `status: current` was previously accepted (because `current` is valid for `type: doc`). Fix the `type` to match the document's actual nature.
  3. **Invented statuses.** Statuses that aren't in any vocabulary (e.g., `ready-to-archive`) previously slipped through if they coincidentally appeared in another type. Fix: migrate to a valid status with `dotmd migrate status <bad> <good> <file>`.

  Untyped docs (no `type:` field) and docs with an unknown type still use the global validStatuses, unchanged. Only docs whose type IS configured get strict scoping.

  Error message now names the type: `Unknown status 'active'; valid for type 'prompt': pending, claimed, archived` (was: `Unknown status 'active'; valid: <union of all types>`).

- **`dotmd hud` prompt filter is now config-driven.** Previously hud hardcoded `status === 'pending'` as the "actionable prompt" filter. It now derives the actionable set from `types.prompt.context.expanded` in your config, falling back to `['pending']` when no prompt type is configured. This means custom prompt vocabularies (e.g., adding `urgent: { context: 'expanded' }`) just work — those statuses surface in hud alongside `pending` without a code change.

  Default config behavior is unchanged: `types.prompt.context.expanded = ['pending']` in the defaults, so default-config consumers see the same hud output as before.

  Internal rename: `findPendingPrompts` → `findActionablePrompts`. Public `actionablePromptStatuses(config)` helper exported from `src/hud.mjs` for downstream tooling.

### Migration

- Run `dotmd check` after upgrading. Each new error names the type and lists the valid statuses for that type. Two common fixes:
  - **Per-file migration:** `dotmd migrate status <wrong> <right> <file>` rewrites just the named doc, leaving others alone.
  - **Whole-bucket rename** (if many files share the same mis-status): `dotmd migrate status <wrong> <right>` without file args.
- If your custom `types.doc.statuses` or `types.research.statuses` is missing `archived`, add it (see Common cause #1 above). The lenient validation previously hid this config gap.

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
