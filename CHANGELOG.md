# Changelog

All notable changes to `dotmd-cli` are documented here. Older releases predate this file — see git tags and the GitHub Releases page for their notes.

## 0.76.3 — 2026-08-24

### Fixed

- **Per-phase file manifests and status records were counted as independent phases.** The section walker carries the nearest H2 ancestor and excludes phase-shaped rows below `Files` headings. Compound report headings are excluded while ambiguous bare words remain eligible as real phases.

## 0.76.2 — 2026-08-24

### Fixed

- **Phase headings marked with dotmd's lightweight `✓` success glyph were not read as shipped.** dotmd prints U+2713 CHECK MARK in its own success output, but the phase reader recognized only `✅`, `☑`, and `✔`. A trailing `✓` therefore left a phase unmarked, while a leading `✓` prevented the heading from entering the phase set at all. The shipped-marker and leading-decoration vocabularies now both accept `✓`, including emoji-presentation form. A table-driven regression keeps every status glyph aligned across both paths and locks glyph priority over incidental prose.

## 0.76.1 — 2026-08-17

### Fixed

- **`dotmd new doc <name> @body.md` re-wrapped a document that already had a shape.** The plan templates have had a full-body shortcut for a while — a body that already authors `## Section` headings is a complete document, so it is emitted verbatim instead of being nested in the scaffold's single slot. The `doc` template never got it. Passing a written document produced a second `# Title` beneath the scaffold's, the placeholder line `> One-line summary of what this doc covers.` sitting above the author's own opening, the whole document buried under `## Overview`, and the skeleton's `## Version History` / `## Related Documentation` appended after a document that had already ended. Found by using it: writing this release's own reference doc required hand-deleting the wrapper afterwards. `doc` now uses the same shortcut as `plan`. Section-content input (no `## ` heading) still flows into the scaffold slot, which is what most `new doc` calls rely on. One deliberate consequence: an authored body with no summary blockquote now gets an honest `check` warning instead of a placeholder that silenced it while saying nothing.

## 0.76.0 — 2026-08-17

### Added

- **An unequipped OpenCode session now says so, instead of working quietly wrong.** 0.75.0 shipped the fix and the installer but put every nudge on a surface you have to go looking for — `doctor`, `install`, the npm postinstall line. None of them reach a session that is running *right now* under a process-scoped identity, and that mode is silent by construction: `use`, `set` and `baton` all work, they just share one identity across every session in the OpenCode process, so a second session can release the first one's plans. dotmd now writes one line to stderr on whatever verb the session reaches for first, naming `dotmd install opencode`. Once per session per repo (a marker under the gitignored `.dotmd/`), stderr so a `--json` caller's stdout stays parseable, skipped for `install`/`doctor`/`update` (which report it themselves) and for the `hud`/`guard` hooks (which fire on every tool call and must stay silent), and off under `DOTMD_NO_HINTS=1`. Once the integration *is* installed, a still-coarse session is one that predates it, so the line switches to "restart OpenCode" rather than sending you to fix what is already fixed. A warning, not an error: failing closed would undo the fallback that unblocked OpenCode in the first place.

## 0.75.0 — 2026-08-17

### Added

- **`dotmd install` — agent-host integration as a first-class verb.** The CLI on its own gives an agent no orientation and no session identity, and until now the only way to get either was knowledge that lived outside the tool: two slash commands in the README for Claude Code, and nothing at all for OpenCode. `dotmd install` reports what each host has and installs what it doesn't. `dotmd install claude` drives `claude plugin marketplace add` + `claude plugin install` — the FIRST install, which no dotmd command could do before (`dotmd update` deliberately skips the plugin step when nothing is installed, and the README's slash commands only work from inside a session). `dotmd install opencode` writes one auto-discovered plugin file into OpenCode's global config dir; OpenCode globs `{plugin,plugins}/*.{ts,js}` there, so no `opencode.json` edit is needed. Global rather than per-repo on purpose — dotmd retired per-repo generated scaffolding once already, and one file that `dotmd update` refreshes cannot drift the way a copy in every repo does. The generated file is version-stamped, and a `dotmd.js` without that stamp is treated as hand-authored: never overwritten, never removed, without `--force`.
- **An OpenCode plugin, giving OpenCode sessions per-session ownership and a session-start briefing.** OpenCode's `shell.env` hook is the only place a tool shell can learn the real session id, so the plugin sets `DOTMD_SESSION_ID` from it and records the OpenCode server process as the claim's owner — which also makes `dotmd doctor --claims` able to judge an OpenCode claim live or dead instead of `unverifiable` forever. It also runs `dotmd hud` into the system prompt at session start, the equivalent of Claude Code's SessionStart hook: OpenCode's Claude Code compatibility covers skills and the system prompt but **not** hooks, so before this an OpenCode user got the bare CLI with no primer, no guard and no skill. Identity rides the stable `shell.env` hook and priming rides `experimental.chat.system.transform`, so if OpenCode renames the experimental one the briefing stops and ownership keeps working.
- **`dotmd doctor --session` — what identity dotmd resolved, and from where.** Reports the id, the environment variable it came from, and whether that variable names *this* session or something coarser its siblings share (a host process, a terminal — sessions sharing an id can release each other's plans), plus whether the current host's integration is installed. This is the diagnostic whose absence let the OpenCode bug below go unnoticed: there was no way to ask what dotmd saw short of running a verb and watching it fail. `dotmd doctor` also appends a one-line nudge when the identity is degraded, and `npm i -g dotmd-cli` mentions the OpenCode integration when `opencode` is on PATH. None of these install anything — writing outside the repo stays behind the explicit verb.

### Fixed

- **Every OpenCode session failed closed on `dotmd use`.** The session-identity resolver looked for `OPENCODE_SESSION_ID` / `OPENCODE_SESSION`, and OpenCode sets neither — it sets no session-id variable at all. So a host the help text advertised as "recognized automatically" hit `No authoritative session identity` on a verb as ordinary as consuming a saved prompt, and the only way through was to set `DOTMD_SESSION_ID` by hand in every shell. The names were never verified against OpenCode, and nothing could have caught that: the test asserted dotmd honors `OPENCODE_SESSION_ID` when it is set, which stays true whether or not anything sets it. The resolver now falls back to `OPENCODE_PID` (namespaced as `opencode:<pid>`), which OpenCode's CLI middleware does set on the process every tool shell inherits, and records it as the claim's owning process so an OpenCode claim can be judged live or dead like a Claude Code one instead of reading `unverifiable` forever. It ranks below the session-scoped names and above `TERM_SESSION_ID`: one OpenCode process can host more than one session, but a terminal id is shared by every agent ever run in that window. For exact per-session identity, an OpenCode plugin can set `DOTMD_SESSION_ID` from its `shell.env` hook, which receives the real `sessionID`.
- **The candidate list was maintained twice.** `currentSessionId` (journal attribution) and `authoritativeSessionId` (plan ownership) each carried their own copy, and they had already drifted — the journal copy never learned the OpenCode names at all. Both now read one list in `util.mjs`.

## 0.74.6 — 2026-08-17

### Changed

- **The `docs/` planning tree is no longer tracked in git.** dotmd is developed by running it against a large private corpus, so its own plans, prompts and audits accumulate consumer detail as a matter of course — that is what makes them useful planning documents and what makes them unpublishable from a public repo. 104 files left the index and stayed on disk. `docs/` keeps its normal path, so `repoRoot` containment and every config default are untouched, and every dotmd verb still works. Nothing user-facing changes: the npm tarball never contained `docs/`. Chosen over a private nested repo (two repos to commit in for one change), over making the whole repo private (losing public source presence costs more than the history is worth for a published package), and over git-crypt (a fresh clone without the filter configured commits plaintext silently — the wrong failure mode for the thing whose job is not leaking).

### Added

- **A guard against private names reaching public test fixtures.** dotmd is developed by running it against a large private corpus, and this is a public repo — so measuring the tool produces real module names, and writing a fixture from what you just measured publishes them. A denylist of private names cannot live here, since publishing the list *is* the leak. `test/fixture-vocabulary.test.mjs` inverts that: it asserts every `module:`/`modules:` value in `test/` comes from a declared allowlist of neutral words, which is safe to publish precisely because those words carry no information — and unlike a denylist it catches a name nobody had yet identified as private, the first time anyone writes it. It runs on every `npm test`, so it gates releases with no external setup. `CLAUDE.md` states the rule it enforces: preserve the shape, replace the words; aggregates are evidence, anything identifying a single plan, module, product or repository is not.

### Fixed

- **`dotmd baton` produced saved prompts that `dotmd use` refused to open.** Baton stamps a `plan:` link on the prompt and parks the plan in the same call, but only `active` and `planned` are startable — so parking as `paused`, `awaiting`, `partial`, `blocked` or `queued-after` (four of which baton's own error message recommends) created a prompt that could never be consumed. Five of seven release statuses were broken. Nothing detected it: `check` and `doctor` were both silent, while the SessionStart hud kept telling every new session to run the one command guaranteed to fail. `dotmd use` now always delivers the body and archives the prompt, skipping only the claim, and prints why: `→ Not claimed: docs/plans/x.md is blocked — dotmd set active docs/plans/x.md to unpark it`. The unpark hint names a status the repo actually configures as startable rather than hardcoding `active`. Same change covers the other unclaimable cases — a plan another session holds, one already closed, a malformed or missing link — none of which is a reason to withhold a body the prompt exists to carry.
- **A release status that files the plan elsewhere left the prompt's link stale on arrival.** `paused` files a plan into `docs/plans/held/` (`lifecycle.filedStatuses`), but the prompt is created inside that same transaction and so recorded the pre-move path. `plan` is deliberately not a `referenceFields` entry, so the move's own reference rewrite never covered it and nothing validated it. Baton now repoints the link after the move.

## 0.74.4 — 2026-08-16

### Fixed

- **A status marked quiet by one type silenced that status name for every other
  type.** `skipWarnings` (and `quiet:`) are declared per type, but the derived
  `lifecycle.skipWarningsFor` was a flat union of status *names* with no type
  qualifier — so a config declaring `journey.active: { skipWarnings: true }`
  suppressed surface, summary, deprecation and reference warnings on every
  `active` **plan** in the repo. Statuses are type-scoped everywhere else
  (`typeStatuses`, `isValidStatus`), and now the suppression that reads them is
  too: a type that declares rich statuses answers for its own statuses, including
  answering "not quiet" for a name another type marked quiet. A type that
  declares none, an untyped doc, and an explicit repo-wide
  `lifecycle.skipWarningsFor` all keep reading the flat set, so array-form
  configs are unchanged. Expect previously-hidden warnings to appear on the
  affected statuses — in one repo this took a `check` from 13 warnings to 192,
  nearly all of them auto-fixable with `dotmd doctor --frontmatter-fix`.
  `dotmd statuses` reports `skipWarnings` per type for the same reason.

## 0.74.5 — 2026-08-16

### Fixed

- **A link whose text was a code span was invisible to every body-link reader.**
  `extractBodyLinks` deleted inline code before matching links, so the commonest
  idiom in a plan hub — ``[`plan.md`](plan.md)`` — collapsed to `[](plan.md)` and
  failed the regex for having empty text. One real hub reported **1 link out of
  hundreds**. Since that list is what validates body links, none of those links
  were ever checked for breakage either; fixing it surfaced 7 long-dead links in
  a single repo. Inline code is now masked to same-length filler instead of
  deleted, so a link inside code (`` `[fake](x.md)` ``) still doesn't count.
- **A hub's descriptive prose was read as a membership claim.** A body section
  was parsed as a link *list* — every `.md` link in it is a ranked child — purely
  because its heading matched a name like `Runlist`. Sections written as tables
  then ranked each row's commentary: a row about plan A whose prose said "A
  spawned B and C" claimed B and C for the hub, and warned them for not naming it
  as parent. Now the shape decides, not the heading: a table row contributes its
  first link, and a list line contributes its first link, so an item's commentary
  is no longer a claim. This removed 11 false membership warnings in one repo.
- **A plan that declared its `execution_mode` was still nudged to change it.**
  The `*-runlist` slug heuristic skipped only `coordination` and `roadmap`, so a
  plan that had explicitly answered — `implementation` — was told to relabel
  itself a coordination hub. The field is canonical and the slug is only a
  fallback for hubs predating it, so any explicit `execution_mode` now ends the
  nudge. It misfired on exactly one population: plans *about* runlists, whose
  slug contains the word while the document is ordinary work.

## 0.74.3 — 2026-08-13

### Fixed

- **`dotmd new` ignored `--root` as soon as the name contained a slash.** A
  directory prefix switched resolution to repo-relative and discarded the root
  the flag had just chosen — so `dotmd new doc prospects/kim --root docs` died
  with "outside every configured root", and the one flag that error advertises
  could not fix it. `--root` now applies to a nested name (`docs/prospects/kim.md`),
  while a prefix that is already a full repo path stays where it points rather
  than nesting under the root twice. Without `--root`, a prefix pointing outside
  every root is still an error — which root is genuinely ambiguous — but the
  message names the flag, shows where it would land, and lists the roots.
- **A type with no root of its own landed in whichever root was listed first.**
  For a project listing `docs/plans` before `docs`, that put every `doc` in the
  plans root. When one configured root contains the others it is structurally
  the catch-all, so it wins now; projects with a single root, or with flat
  sibling roots and no container among them, are unaffected.
- **The `Root:` line named the root resolution started from**, not the one the
  file landed in — reporting `Root: plans` while writing `docs/prospects/`.

## 0.74.2 — 2026-08-13

### Added

- **A plan claim can now tell you whether its owner still exists.** Claims record
  the process that owns the *session* (`CLAUDE_PID`, or `DOTMD_SESSION_PID` to set
  it explicitly) rather than the `dotmd` process, which exits within the second
  and so could never say anything about whether the session outlived it. That
  makes the liveness check dotmd already uses for transaction owners apply to
  claims: `set`, `archive`, `baton`, and `rename` now reclaim a plan whose owning
  process is **provably** gone, instead of refusing forever. Provably is the same
  bar a forced hook-delivery takeover uses — a probe that came back `ESRCH` on
  this host, or a pid whose process start-identity no longer matches. A reused
  pid reads live, another machine's claim reads unverifiable, and a record
  written before this release has no owner to probe; all three keep refusing and
  leave the takeover to an explicit `--force`.
- **`dotmd doctor --claims`** — the counterpart to `--transactions`, for the
  wedge that hits one plan rather than the whole repo. Reports every claim with
  its age, session, and owner liveness. `--apply` releases the ones whose process
  is provably gone (their plans return to `active`). Claims dotmd cannot judge
  are never released by `--apply` alone — "I can't see the owner" is not evidence
  the owner left — and need `--older-than 24h`, which is you supplying the
  judgement dotmd doesn't have, as a policy rather than a guess.

  Existing records pre-date the owner field, so they all read `unverifiable`:
  clearing a repo wedged before this release is a one-time
  `dotmd doctor --claims --apply --older-than 24h`.

### Fixed

- **`doctor --claims --apply` could not run from a shell with no session identity
  of its own.** It released through `dotmd set active`, which demands an
  *authoritative* session id — so the command that exists to unwedge a repo whose
  sessions are gone refused to work from a bare login shell, a cron job, or a
  container, which is exactly where you reach for it. Releasing a claim stamps
  the id in as provenance and takes nothing, so the repair now supplies its own
  operator identity when the shell has none.
- **`@-` discarded a body that was already on stdin.** `@path` reads a file and
  `-` reads stdin, so `@-` is the natural composition of the two spellings dotmd
  documents — and it took the `@` branch, hunted for a file literally named `-`,
  and died with `Body file not found: -` while a valid heredoc sat unread. It
  happened three times in one repo's session history, each time on a `dotmd
  baton` whose resume draft was piped in and then thrown away. `@-` now means
  stdin. A file genuinely named `-` is spelled `./-`, per the usual convention,
  and still reads as a file.
- **`doctor --claims --apply` could not clear a claim whose plan had been
  deleted.** The release routes through `dotmd set active`, which needs a file to
  write the status into, so an orphaned record failed with `File not found` and
  survived every sweep — two of fourteen claims in the repo this feature was
  built for. Those records also poison the path they name: the record key is a
  hash of it, so a plan later created there was born owned by a session long
  gone. Such a claim is now released from its own record (re-checking under the
  lock that the plan really is missing, since that is the whole justification for
  skipping the status write), and the report says `released (plan no longer
  exists)` rather than promising a plan that is `active again`.
- **"Plan is busy in another session" was a dead end.** The refusal printed an
  opaque session UUID and stopped — no indication of how long the claim had been
  held, and no mention of `--force`, which every command that hits it accepts.
  Since nothing expires a session claim, an owner three days dead looked exactly
  like a colleague mid-edit. A survey of real sessions in a busy repo found 16 of
  these against 7 plans, every owner long gone, and not one recovered: agents
  re-ran the same command with the plan addressed differently (path, then slug),
  reading "busy" as "you named the plan wrong". The message now carries the claim
  age and the recovery verb:

  ```
  Plan is busy in another session: docs/plans/guard-estate-audit.md
    held by session 8a6d80ee-… since 2026-08-10T00:11:41.322Z (3d ago)
    If that session is gone, re-run this command with --force to take the plan over.
  ```

  `rename` gets its own recovery line, because a rename carries the claim to the
  new path rather than ending it and so has no `--force` of its own — it names
  `dotmd set <status> <plan> --force` instead.

## 0.74.1 — 2026-08-12

### Fixed

- **A forced takeover could end up owning a plan the file no longer calls
  in-session.** An `adopt`-shaped claim (`dotmd use --force` on a plan that is
  already `in-session`, or adopting an unowned legacy one) renders no new plan
  content, so its mutation set held only the ownership record — it neither
  locked nor compare-and-swapped the plan file its decision came from. A
  concurrent `dotmd set active` landing in that window won the status write while
  the claim still took ownership, leaving a record owning a plan whose
  frontmatter said `active`. The claim now carries the plan file as a read-only
  **guard**, so it is refused if the plan changed after the claim was prepared.
  This was the cause of the `pickup-ownership` race test failing intermittently
  on CI (3 of the last 8 runs on `main`, across four different Node legs): the
  test was right and the product was racy, not the other way round.
- `mutateFileSet` and `moveFileAtomic` accept `guards` — read-only participants
  that take part in locking and in the same compare-and-swap as `updates` but are
  never written. They express "this mutation is only valid while that file still
  says what I read", which a no-op update would fake at the cost of rewriting
  bytes and reporting the file as changed. A guard conflict is detected before
  anything is created, so it leaves the tree byte-identical — not even an empty
  directory behind — and, in the move path, before the transaction manifest
  exists, so it can never leave a transaction to recover from.

## 0.74.0 — 2026-08-12

### Added

- **Membership drift is now checked in both directions.** A hub's list of
  children and the plans that claim it via `parent_plan:` are two halves of one
  relationship, and either half can go stale alone. dotmd already warned when a
  `runlist:` child lacked the back-ref; these are the two arrows it didn't cover.
  - A plan sets `parent_plan: <hub>` and the hub references it **nowhere** — no
    reference field, no body link → warning on the **hub**. A membership only
    one side records is invisible to every hub view (fold, rollup, next-pickup),
    since all of them read the hub's half.
  - A hub's **body order** (`## Ranked queue` / `## Order of operations` — the
    list `dotmd runlist next` walks) ranks a plan that carries no `parent_plan:`
    at all → warning on the **child**, the file that needs the edit. This is the
    existing `runlist:` back-pointer finding extended to the body-order hubs it
    couldn't see; children already covered there are skipped, so one missing
    back-ref is never reported twice.
- Membership is deliberately **not** inferred from an ordinary body table. Rowing
  a plan somewhere in a hub's body says "related", not "this hub owns you" — the
  same pointer-row principle the status guard uses.
- A ranked plan whose `parent_plan:` names a **different** hub is deliberately
  silent. Measured against a real estate: an aggregator hub ranking plans owned
  by other programs is legitimate and common, and demanding exclusivity would
  fire on every such row with no fix that doesn't break the other hub's claim.
  Only the unambiguous half — a ranked plan claiming no parent at all — warns.

## 0.73.0 — 2026-08-12

### Added

- **Hub status drift is now a check.** A runlist / coordination / roadmap hub
  rows its children in a table and prints each child's status by hand, and
  nothing kept that word honest: the child goes `archived`, the hub still says
  `active`, and every later reader plans against a status that stopped being
  true. `dotmd check` now reads the status beside each row's link and compares it
  with the plan's real status. Everything it needs was already owned by dotmd —
  the vocabulary comes from `types.<type>.statuses` resolved against the
  *child's* own type, the link goes through `resolveRefPath`, the status comes
  from the index, and a child under the archive dir counts as archived whatever
  its frontmatter says.
- `dotmd sync-status [<hub>...] [--adopt] [--dry-run] [--json]` rewrites the rows
  that drifted. Case is preserved (`Active` stays capitalized) and nothing else
  in the cell is touched — the prose beside the status is why the row exists.
  `dotmd check --fix` and `dotmd doctor` rewrite status tokens too; only
  `--adopt` **adds** `<!--s-->…<!--/s-->` markers, because wrapping a word is a
  content edit to prose the user wrote.
- Detection is positional and needs no adoption pass: strip HTML comments, take
  the cell's leading token, match the vocabulary. Measured against 472 already-
  marked rows in a real estate, that agrees with the marked span 96% of the time
  and picks a wrong token zero times — every miss leaves a leading word outside
  the vocabulary, so it declines rather than rewriting confidently. A
  `<!--s-->active<!--/s-->` marker pins the remaining 4% (a status sitting behind
  a bolded headline).
- Drift **warns** when the token was inferred and **errors** when it sits in a
  marker, instead of adding a config knob: `dotmd check` exits 0 on warnings and
  1 on errors, so a positional match nudges while a marked span — the author
  declaring dotmd owns that word — fails the check. No repo that never asked for
  this starts failing builds over an inference.
- A row with no readable status is split three ways, not lumped together: a
  table with **no status column** is a pointer row and stays silent; a row under
  a `Status`/`State` column whose cell holds no readable status **warns** (that
  row opts out of the invariant invisibly, and it is where real drift hides); a
  readable token is compared. Collapsing those floods correct hubs with false
  positives.

## 0.72.1 — 2026-08-12

### Added

- `dotmd init` now leaves a committable file in each type subdirectory: a sample
  `docs/plans/example-plan.md` (status `planned`, and it says how to delete
  itself) and `docs/prompts/.gitkeep`. Git cannot track an empty directory, so
  both scaffolded dirs previously existed only on the machine that ran init and
  vanished for the next clone. Only ever written into a genuinely empty dir —
  re-running init over a real estate never seeds a sample, and deleting the
  sample sticks.
- `dotmd init` adds `<docs>/prompts/*.md` to `.gitignore` alongside `.dotmd/`.
  The live saved-prompt queue is session-local by design and the workflow docs
  said never to commit it, but nothing enforced that — a plain `git add -A` from
  any session swept the queue into the repo. The single `*` stops at the
  directory on purpose: `prompts/archived/` is the committed historical record
  and stays tracked.

### Fixed

- `dotmd use` claims a resume prompt's linked plan when the `plan:` link is
  written doc-relative (`../plans/x.md` from `docs/prompts/`), not only when it
  is repo-root-relative. `plan` is not a `referenceFields` entry, so nothing
  validates or rewrites it — `dotmd check` reported a clean estate while
  consumption died with "Linked plan is missing" against a plan that was plainly
  there, stranding the handoff. The link now resolves through `resolveRefPath`,
  the same resolver validation uses, which accepts both forms.
- `dotmd init` renders the document index against what it just scaffolded
  instead of shipping a "no docs yet" placeholder that the sample plan
  immediately contradicted. A fresh init is now warning-free on first `check`.

## 0.72.0 — 2026-08-12

### Added

- `minDocs` config key (and `dotmd check --min-docs <n>`) puts a floor under the
  scan surface. Every other check asks "is this doc wrong?"; none could ask "did
  we look at anything?" — so a broken root or an over-eager exclude reported zero
  errors, output byte-identical to a clean estate. Off unless configured, and
  skipped for path-scoped checks, which are deliberate subsets. Deliberately an
  error rather than a warning: a warning exits 0, which is the outcome the floor
  exists to prevent.

### Changed

- `dotmd grep` / `query --body` excerpts hide HTML comments, which render as
  nothing but were shown raw. Matching still runs against the raw line, so a term
  that only occurs inside a comment is never lost — the raw line is shown when
  stripping would hide the match.
- Repo-level check errors (those with no owning document) no longer render as
  `undefined: <message>`.

## 0.71.4 — 2026-08-05

### Fixed

- Moving a document now updates links that spell its name in a different case
  (`[x](CASING.MD)` for `casing.md`), where the filesystem folds case — macOS
  and Windows. `realpath` resolves symlinks but not case, so the rewriter's
  exact compare never matched those links, while validation (which resolves
  with `existsSync`) considered them perfectly valid: `dotmd check` called such
  a link fine, the move silently left it pointing at the old path, and only then
  did check call it broken. The tie-break is the inode rather than a guess about
  the filesystem — same device and inode means the two spellings are one file,
  which is only true where the filesystem itself folds case. A case-sensitive
  filesystem is unaffected: `Foo.md` and `foo.md` are separate inodes and stay
  separate, and two documents that differ only by case are never guessed
  between. Verified by running the suite on a case-sensitive APFS volume.

### Changed

- The reference rewrite that runs on every move got ~6× faster, which takes a
  status change in a 2,000-doc repo from 3.8s to 2.6s. Two changes, both
  measured against a real corpus and both asserted to produce a byte-identical
  rewrite set:
  - Resolving one reference cost two `realpath` walks, and the
    repository-relative spelling usually does not exist — so it climbed the tree
    doing a `realpath` per ancestor. Over a corpus-wide sweep that was tens of
    thousands of syscalls across a few hundred distinct paths. Resolution is now
    memoized on the identity set, so the memo is scoped to one sweep and cannot
    outlive a mutation.
  - A document that never names the moved file cannot reference it, so the
    fence-aware CommonMark walk is skipped for those — in practice ~99% of the
    corpus. The check mirrors the resolver: case-folded, with the same backslash
    escapes unwound, and aware of every name a symlinked document answers to. A
    repo that symlinks docs at all falls back to the full walk.

## 0.71.3 — 2026-08-05

### Fixed

- A move (`dotmd set`, `archive`, `rename`) no longer loses a race with ordinary
  Git activity and wedges the repo behind it. Three defects compounded, all
  reproduced against a 3,900-doc repo with a concurrent `git status` loop:
  - **Locking flushed once per lock.** Acquiring a lock cost a full directory
    flush (~6 ms on APFS), and a reference sweep locks every doc in the repo — 66
    seconds of lock cycle for 3,871 docs, all of it sitting between the move's
    Git index snapshot and its publication. Mutual exclusion comes from `mkdir`
    being atomic, which needs no flush, so the set is flushed once. Same lock
    cycle now takes 2.4 s, and the whole `set` went 39–53 s → 3.7 s.
  - **The index CAS compared against a stale snapshot.** It was captured before
    the content phase, so anything that rewrote `.git/index` meanwhile — a bare
    `git status` rewrites it to refresh its stat cache — failed the move. Staging
    now re-bases on the generation current at staging time (nothing of ours has
    reached the index yet, so our staging belongs on top of the peer's, exactly
    what `git mv` produces), and a publication that provably lost the race is
    retried on a fresh generation. A refused `git add` is still not retried.
  - **A clean rollback was recorded as a failed one.** When staging failed before
    `.git/index` was replaced there was nothing of ours to restore, but the
    index differing from our snapshot was read as a failed rollback — as was a
    peer's `.git/index.lock` during scratch-state cleanup. Either retained the
    transaction as `failed-manual`, and a retained transaction refuses **every**
    later mutation in the repo until `dotmd doctor --transactions --apply` clears
    it. Both are now recognized for what they are: the move fails, the rollback
    completes, the peer's staging is preserved untouched, and re-running works.

## 0.71.2 — 2026-08-05

### Fixed

- `dotmd archive` works again in a repo that gitignores its docs root while
  force-tracking the docs inside it (`docs/` in `.gitignore` plus `git add -f`).
  Staging the destination used a bare `git add`, which applies ignore rules to
  the new path even though the content came from a tracked file; that failed the
  transaction and rolled the whole move back, so the plan never moved and every
  later archive hit the same wall. `git mv` permits exactly this relocation —
  ignore patterns govern new *untracked* paths, not the relocation of content
  git already tracks — so the destination is now force-staged when the source
  was tracked. An untracked source stays subject to the ignore and is still
  moved without being forced into the index.
- The release's global-CLI sync no longer misidentifies a second Node prefix.
  `npm version` exports its resolved config as `npm_config_*`, and a child npm
  lets those inherited values override its own npmrc — so asking a sibling npm
  for its global prefix returned the release shell's prefix. With Homebrew
  alongside NVM, the second copy looked unmanaged, was skipped as
  "tool-managed", and then failed the release as stale; `npm run release:resume`
  inherited the same variables and could not recover it either. Sibling npm
  spawns now run with those variables stripped.

## 0.71.1 — 2026-08-05

### Changed

- The plugin skill and `/prompts` command teach `dotmd prompts show --all`. The
  skill previously described triage only as `dotmd prompts show <file>`, one file
  at a time — which is what sent sessions to `Read` per file in the first place.
- The skill documents `dotmd doctor --transactions` under a "when mutations
  refuse repo-wide" heading, so a wedged repo has a route out from the agent side
  rather than only from the error text.
- `@/tmp/baton.md` and `@/tmp/my-draft.md` join the recognized body placeholders,
  matching the example paths the `/baton` command and the placeholder error
  themselves print. A real file at either path still wins.

## 0.71.0 — 2026-08-05

### Fixed

- A transaction that could not acquire its path locks during recovery is no
  longer marked `failed-manual`. Recovery runs at the top of every move and
  sweeps every manifest in the repo, so contention on an unrelated transaction —
  typically a second session recovering the same one — was being recorded as
  damage. Because a `failed-manual` manifest makes *every* later mutation refuse,
  one transient 2s lock timeout could brick `set`, `archive`, `use`, `baton`, and
  `rename` repo-wide, and the error named a file the failing command never
  touched. Lock contention now defers the transaction, which stays recoverable.
- `dotmd baton <slug> @draft` (and other unsubstituted placeholders such as
  `@<draft-file>` or a copied `@/tmp/draft.md`) now says the argument is a
  placeholder and shows the three real body-input forms, instead of failing with
  a bare `Body file not found: draft`. The wrap-up nudge and the `baton`
  signature no longer render the placeholder as a runnable path — that nudge was
  the copy source for the failures. A real file by one of those names still wins.
- `npm pack --json` is read in both the npm 10 (array) and npm 11 (object)
  shapes, so the packaging test no longer fails — and no longer blocks releases —
  on newer npm.

### Added

- `dotmd doctor --transactions` reports pending mutation transactions: status,
  owner liveness, and each participant's current generation. `--apply` clears the
  transactions whose canonical files already agree on one generation, touching no
  document content; anything ambiguous is reported for manual review. Previously
  a wedged transaction had no CLI surface at all — the only guidance was to
  hand-restore generations and delete the manifest. The repair message now points
  here.
- `dotmd prompts show` accepts several prompts, plus `--all` (the whole pending
  queue) and `--limit N`. Triaging a backlog previously had no bulk affordance,
  so sessions fell back to `Read` file by file — 149 guard events, including
  single sessions sweeping 25-28 prompts. The `read-prompt` guard now names
  `--all`. Single-prompt output is unchanged.

## 0.70.4 — 2026-07-29

### Fixed

- Publishing a mutation on Windows now retries a rename that fails with
  `EPERM`/`EBUSY`/`EACCES` because another process holds the file open — an
  editor, an antivirus scanner, the search indexer, or a concurrent `git`. The
  path lock only serializes other dotmd processes, so these holders could
  previously abort a mutation that had acquired the lock correctly. The retry
  covers the document publish, the transactional-move source backup and target
  publish, exclusive creation, the transaction manifest, the staged `.git/index`
  publish, and `dotmd.config.mjs` rewrites. POSIX behaviour is unchanged: a
  rename there never fails this way, so the codes still surface immediately.
- The Git literal-pathspec regression test no longer uses a fixture filename
  that cannot exist on NTFS, which had failed every Windows CI run since 0.70.1.

## 0.70.3 — 2026-07-14

### Fixed

- Consuming a saved prompt no longer scans and locks the entire managed corpus
  to rewrite inbound references to that session-local, gitignored prompt.

## 0.70.2 — 2026-07-14

### Fixed

- `dotmd use` now tolerates an accidentally duplicated `dotmd use` command
  prefix before the document path.

## 0.70.1 — 2026-07-14

### Fixed

- Basic read and lookup commands no longer perform the bounded 10,000-commit
  Git/frontmatter drift scan on every index build. `check` and `doctor` retain
  that validation, while explicit Git filters and `touch --git` continue to
  request metadata directly.
- `doctor --apply` now includes long-frontmatter repair, and preview closeout
  counts match the fixers while manual actions include the validation reason.
- Singular metadata migrations, including populated block-form values, are
  classified as fixable only when `lint --fix` can perform the migration.
- `touch --git` accepts multiple explicit files and date synchronization now
  converges across consecutive and multi-file metadata-only commits by ignoring
  commits that changed only the top-level `updated:` line.
- Bounded Git metadata scans count only relevant history, skip statuses excluded
  from staleness checks, and retain enough per-file history to resolve metadata-
  only commits without another full history walk.

## 0.70.0 — 2026-07-14

### Added

- **Atomic lifecycle and multi-file mutation contracts.** Managed writes use
  bounded locks, snapshot conflict detection, atomic replacement, durable
  ownership, transactional moves, and recoverable completion for index and hook
  side effects.
- **Agent-context v1 and centralized command schema.** Passive machine context
  is versioned, bounded, type-aware, and configuration-derived, while command
  grammar now drives validation, help, and completion ownership from one source.
- **Cross-platform CI.** The full suite now runs on Ubuntu Node 20/22/24, macOS
  Node 22, and Windows Node 22.

### Changed

- Git-derived document dates are scoped and bounded with explicit degradation
  metadata instead of silently dropping all history after an oversized scan.
- Human and machine path output uses stable repository-relative identities
  across supported operating systems.
- README is a concise onboarding and concepts guide; complete command syntax
  remains generated by `dotmd help all`.

### Fixed

- Dry-run and passive context paths suppress repository, journal, hook, and
  generated-index writes.
- Guard input handling is bounded and redacted, with fail-closed behavior only
  where the command contract requires it.
- `dotmd use <file>.md` now resolves shell-expanded basenames from a nested
  current directory directly and uses a non-validating prompt lookup, avoiding
  a full Git/history/validation scan before starting the plan.

### Removed

- **Removed the unsupported Notion import/export/sync integration.** The shipped implementation targeted a retired SDK contract and had no API-level compatibility coverage, so the command, config surface, completion entries, package keyword, implementation, and optional dependencies have been removed rather than advertised as functional. Restoration requires data-source API mocks, stable `notion_id` identity, YAML-safe serialization, an explicit conflict policy, partial-failure reporting, and a live workspace smoke test.

## 0.69.0 — 2026-07-09

### Added

- **Prompt consumption now claims its linked plan.** Baton stamps the resume
  prompt with the plan reference, and `dotmd use` atomically consumes the prompt
  and claims a startable target for the receiving session.

### Fixed

- Baton no longer adopts another session's sole in-session plan.
- `lint --fix` removes empty deprecated singular keys cleanly.
- Post-version automation refreshes and verifies the Claude Code plugin.

## 0.68.0 — 2026-06-29

### Added

- **Baton-less session exit nudge.** Releasing an in-session plan without a
  saved handoff now points agents to `dotmd baton`, closing the last unguarded
  step in the resume loop.

## 0.67.0 — 2026-06-29

### Added

- **Roadmaps above runlists.** `dotmd roadmap` and `dotmd roadmaps` recursively
  roll up progress across child runlists, expose each child's next pickup, and
  support cross-runlist `roadmap next` selection.
- `dotmd new plan <name> --roadmap` scaffolds a roadmap hub.

### Fixed

- Roadmap hubs are classified separately from coordination runlists and held
  out of actionable plan counts.

## 0.66.0 — 2026-06-29

### Added

- **Canonical workflow drift guard.** `dotmd check` and `dotmd doctor --project`
  compare the marked workflow contract in `CLAUDE.md` and the plugin skill so
  the two agent-facing surfaces cannot silently diverge.

## 0.65.1 — 2026-06-29

### Fixed

- Runlist next-pickup selection skips parked children as well as archived ones.
  Parked work remains visible and does not count as complete.

## 0.65.0 — 2026-06-29

### Added

- **Runlist mutation verbs.** `runlist add`, `remove`, and `reorder` keep the
  hub array, child `parent_plan` references, and body order list synchronized.
- Existing plans can be attached by path or slug, while bare slugs scaffold a
  planned child stub.

### Changed

- Runlist hubs are held out of headline leaf-plan counts, with a discoverability
  footer when status filters hide them.

## 0.64.3 — 2026-06-29

### Fixed

- Frontmatter mutation preserves CRLF files, rejects Windows-sensitive guard
  edge cases correctly, and has direct coverage across mutation paths.

## 0.64.2 — 2026-06-28

### Added

- `dotmd update` is surfaced in onboarding and command help.
- Brownfield config generation emits the detected modules taxonomy.

## 0.64.1 — 2026-06-28

### Added

- `dotmd new plan --lite` and `--audit` provide minimal and findings-oriented
  plan body variants without replacing the default full plan template.

## 0.64.0 — 2026-06-28

### Added

- `dotmd new plan --runlist` scaffolds a sprint hub and ordered child plans.
- `dotmd new plan --coordination` scaffolds a prose-first coordination hub.

### Fixed

- Dispatcher flag ownership, plugin release packaging, archive semantics,
  moved-file reference repair, onboarding guidance, and completion/help drift
  were hardened together.

## 0.63.0 — 2026-06-28

### Added

- Coordination hubs can derive pickup order from linked ranked-queue body rows.

### Fixed

- Status and archive moves repair inbound repository-relative frontmatter
  references consistently.

## 0.62.0 — 2026-06-28

### Added

- **Runlist-aware dashboards.** `plans`, `briefing`, and `health` fold sprint
  children, separate coordination hubs from leaf counts, and expose next pickup.
- `dotmd runlists` adds a dedicated coordination dashboard with sorting and
  shared hub labels.

## 0.61.0 — 2026-06-11

### Added

- **`dotmd baton` — the one-command handoff.** Saves the resume prompt
  (`resume-<plan-slug>`, collision-safe `-2`, `-3`, …), releases the plan with a
  single status flip (`in-session → active` by default; `--status`/`--note` to
  override), and prints the exact `git commit` for the plan's frontmatter change
  — prompt explicitly kept out of the pathspec. Resolves *this session's* plan
  via the journal, falling back to the only in-session plan. Body via `@path`,
  stdin, or `--message`; refuses to mutate anything until the body is secured.
  The plugin's `/baton` command is now a thin wrapper around it instead of a
  three-step choreography (real-world sessions kept expanding those steps into
  repo triage).
- **Baton slug mode — "save a resume prompt" works with no plan claimed.**
  `dotmd baton <slug> @draft` saves `resume-<slug>` and touches nothing else:
  no status changes, no commit hint, no plan required. Bare words that resolve
  to a plan still engage plan mode; path-looking args still die on typos so a
  mistyped plan path can never silently become a prompt name. `--status`/
  `--note` are ignored with a warning in slug mode.
- **`dotmd prompts show <file>` (alias `peek`)** — read-only peek at a saved
  prompt without consuming it. The sanctioned triage path; the guard's
  cat/read-prompt warnings now point at it instead of nudging `dotmd use`
  (which, run on a prompt you just saved, destroyed the handoff).
- **`dotmd hud --json` exposes `.owned`** — the journal-attributed in-session
  plan for this session (`{ path, title, via }`, null when unattributable).
  The help text previously documented this field but it never existed.
- **`dotmd doctor --project` workflow-drift checks** — flags docs without a
  frontmatter block (every status verb dies on those mid-handoff) and a plan
  status vocab missing `in-session`/`active` (breaks `dotmd use`/`baton`).

### Fixed

- **SessionStart hook announces queued handoffs again.** The 0.50.0 "primer
  only" scrub also suppressed pending prompts, which broke the last link of
  the handoff loop: batons saved resume prompts that no next session was ever
  told about, so pickup only happened when an agent spontaneously ran
  `briefing`. `dotmd hud` now prints two *instruction* lines when they apply —
  `N pending prompts — start by running dotmd use …` (names the oldest;
  output stays O(1) in queue size) and `in-session (yours): <plan>` when the
  journal attributes an in-session plan to this sid (the post-compaction
  resume case; the single-in-session fallback deliberately does NOT print, as
  that plan likely belongs to another live session). Passive state (error
  counts, journal chatter) stays suppressed as designed.
- **Guard false positives that poisoned legitimate commits.** `commit-prompt`
  now evaluates per shell segment and ignores prose strings: a prompt path in a
  sibling command (`dotmd check docs/prompts/x.md; git commit -- docs/plans/y.md`)
  or inside a quoted commit message no longer denies the commit. `cat-prompt`
  strips heredoc bodies, so the canonical `cat <<'EOF' | dotmd new prompt …`
  flow is no longer scolded when the draft mentions a prompt path.
- **~2s of dead latency on every guarded tool call.** The guard's stdin
  fallback timer was never unref'd, so the hook process lingered the full 2s
  after answering. Now exits as soon as the verdict is written (~40ms).
- **PreToolUse fast path in the plugin hook wrapper.** Payloads that can't
  possibly match a guard rule (no `.md`, or no `prompts/`/`status` token) get
  the no-opinion reply straight from `sh` (~5ms) without booting Node.
- **Frontmatter length caps taught upfront; over-cap warnings are
  self-resolving.** `dotmd new plan` now states the field contract at creation
  (current_state = 2-4 sentences / cap 1500; next_step = 1-2 sentences / cap
  800; detail in the body), and the cap warnings prescribe the one mechanical
  fix (`dotmd doctor --frontmatter-fix`) while explicitly forbidding the
  hand-trim / re-check spiral sessions kept falling into.
- **`updateFrontmatter` error names the remedy.** "has no frontmatter block"
  now appends the `dotmd bulk-tag …` retrofit command — sessions hitting it
  mid-closeout previously just retried other verbs.

## 0.50.2 — 2026-05-30

### Fixed

- **`/baton` no longer nudges agents to commit ignored resume prompts.** The
  generated handoff command now calls out `docs/prompts/` as local session
  state that is often gitignored, so agents save the prompt for the next
  `dotmd hud` pickup without trying to force it into git.

## 0.50.1 — 2026-05-29

### Fixed

- **`dotmd doctor` fix-prescriptions now say `--apply`.** Since 0.37.0, bare
  `dotmd doctor` previews by default and writes nothing. But the `dotmd check`
  summary footer (`src/render.mjs`) and the generated `.claude/commands` agent
  briefing (`src/claude-commands.mjs`) still told agents to run bare
  `dotmd doctor` to "auto-fix" — so following the prescription changed nothing
  and looped. Both now prescribe `dotmd doctor --apply` and note that bare
  `doctor` previews only. (Agent-UX meta-pattern sweep M1+M2 — a recurrence of
  the A1 "Run X where running X doesn't fix it" footgun.)
- **Runlist back-pointer warning honors the `>` one-way prefix.** A `runlist:`
  entry prefixed with `>` (e.g. `- "> child.md"`) now opts that child out of the
  `parent_plan:` back-pointer requirement, mirroring the per-ref escape hatch
  the bidirectional reciprocity check already honors. Lets a hub order a child
  it doesn't own without nagging the child to add a back-link. (Sweep M5.)

## 0.50.0 — 2026-05-29

### Changed

- **`dotmd hud` (SessionStart hook) emits only the command primer.** The hook no
  longer prints operational state (held / prompts / stuck / `errors: N`), the
  slash-command refresh notice, or the journal sections (previous-self / fleet /
  recent-rejections) — those nudged agents into phantom follow-up work (e.g.
  `errors: 1 (run dotmd check)`). It now purely teaches the verb set.
  `dotmd hud --json` still exposes the full structured shape, and the
  slash-command self-heal still runs silently.
- **Generated live index sections are status-only by default.** README/docs
  indexes no longer mirror volatile `current_state` text for live docs, which
  avoids recurring stale generated-block review noise. Set
  `index.snapshot: 'state'` to keep the previous `Status Snapshot` table for
  live sections; archived highlights still show historical snapshots.
- **Prompt shelving is now prompt holding.** `dotmd prompts hold <prompt>` is
  the canonical "saved but not next" verb. It writes `status: held` and moves
  the file under `docs/prompts/held/`; `dotmd prompts unhold <prompt>` moves it
  back to `docs/prompts/`. The old `shelve` / `unshelve` spellings remain as
  compatibility aliases and write the canonical `held` status.
- **Filed statuses now live under the document type folder.** A filed plan
  status moves into `docs/plans/<bucket>/` and filed prompts move into
  `docs/prompts/<bucket>/`, rather than using a root-level bucket. The default
  `paused` plan status now files to `docs/plans/held/`, matching the prompt
  hold primitive.

### Fixed

- **Top-level `dotmd use <prompt-slug>` now resolves prompt slugs reliably.**
  `dotmd use resume-foo` and `dotmd use resume-foo.md` now share the same
  basename / substring resolver as `dotmd prompts use`, then consume and
  archive the prompt atomically.
- **Prompt consumption now reports and respects the actual archived path.**
  `dotmd use` / `dotmd prompts use` no longer prints `Consumed:` with the
  stale pre-move path after archiving. Prompt consumption also refuses files
  physically under an `archived/` directory even when their frontmatter drifted
  back to `status: pending`, so archived prompts cannot leak their body again.
  Lifecycle commands now share the same archive-path predicate for archive,
  status, set, and bulk archive flows.

## 0.49.3 — 2026-05-29

### Fixed

- **`dotmd new` rejects auto-piped/heredoc bodies on templates that do not
  accept body input.** The fail-fast guard already caught explicit inline,
  `--body`, `@path`, and `-` body sources, but bare piped stdin was only probed
  for body-accepting templates. In projects with a custom `templates.plan` that
  drops `ctx.bodyInput`, `dotmd new plan foo <<EOF` could still scaffold the
  placeholder plan and lose the body. Piped stdin is now probed for every
  template so non-body templates reject it instead of silently discarding it.

## 0.49.2 — 2026-05-29

### Changed

- **`dotmd ship` stages `CHANGELOG.md`.** Release changelog edits are now
  included in the ship allowlist, matching README and CLAUDE release-doc
  handling.

### Fixed

- **`dotmd new` preserves inline bodies that start with frontmatter.** A quoted
  positional body beginning with `---` was being mistaken for a dash-prefixed
  flag and dropped before scaffold/frontmatter merge. Those bodies now flow
  through the same merge path as `@path` and stdin input, so fields like
  `current_state` and `next_step` land in frontmatter and the scoped body is
  preserved.

## 0.49.1 — 2026-05-28

### Changed

- **Journal and error logs rotate on dotmd version change.** The active
  `.dotmd/journal.jsonl` and global `dotmd-errors.log` now start fresh when
  the installed dotmd version changes, with the previous log preserved as `.1`
  for up to 30 days. Stale backups are pruned lazily on write. This keeps
  `hud`, repeat-failure hints, and post-upgrade analysis focused on
  current-version behavior instead of stale pre-upgrade failures.

## 0.49.0 — 2026-05-28

Agent-usability release from issues #14 and #15. Focus: make the command
surface easier for short-lived coding agents to discover, script, and recover
from.

### Added

- **`dotmd finish` aliases `dotmd release`.** Existing agent docs and closeout loops that say `finish` now route to the same implementation as `release` / `unpickup`.
- **`dotmd agent-context` and `dotmd context --json --compact`.** Both emit bounded JSON for agents instead of the larger full-context shape.
- **`dotmd self-check`.** Alias for `dotmd doctor --project`, intended for quick project/version skew diagnostics.
- **`dotmd prompts list` highlights the next prompt.** Pending prompts sort with the next item first and mark it as `[NEXT]`.

### Changed

- **Top-level help surfaces prompt and lifecycle commands.** Initial help now includes `prompts`; `help all` lists `pickup`, `release`, and `unpickup`.
- **Text `hud` shows compact actionable state.** When there is something to act on, `hud` prints one bounded state line for held plans, pending prompts, stuck leases, and validation errors.
- **Unknown flags fail non-zero on agent-facing commands.** Typos such as `dotmd plans --zzznotaflag` now fail instead of being silently ignored.
- **`check` / `doctor` output separates fixable and manual work.** The text output gives clearer remediation guidance for agent loops.
- **Glossary diagnostics warn on config drift.** A missing configured glossary section now points at likely recovery paths.

### Fixed

- **Dead same-host pid leases are reclaimable.** `release --stale`, `hud`, and pickup scrub now treat a lease held by another session with a dead same-host pid as stuck even if it is younger than the 4-hour age threshold. Same-session reattach still ignores the old command pid, so an agent does not immediately clear its own fresh lease.
- **Runlist body links can act as transient runlists.** `dotmd runlist <hub>` now understands markdown links in ordered body sections when no `runlist:` frontmatter exists.
- **`--takeover` keeps takeover history.** Explicit takeover bypasses the opportunistic dead-pid scrub so `takenOverFrom` is still recorded.

### Tests

1068 passing at release.

## 0.39.5 — 2026-05-26

Sprint 3 of agent-DX work from issue #10. Three findings — `dotmd doctor --frontmatter-fix` (#7), deterministic archive-collision paths (#6), and `dotmd archive --closeout-template` (#5). One behavior change: archive collisions now use a numeric suffix instead of a UTC timestamp; the rest is opt-in.

### Added

- **`dotmd doctor --frontmatter-fix`. (Issue #10 finding #7.)** `dotmd check` flags `current_state >500` / `next_step >300` warnings but offered no auto-fix — the only path was hand-editing every plan. This sub-mode truncates the offending field at the nearest sentence boundary under the target (300 / 200) and moves the overflow into a `## Current State` / `## Next Step` body section (placed above the first H2 if absent, appended otherwise). Plans only; uses a folded YAML block scalar (`key: >`) so the rewrite is safe regardless of colons / quotes / leading dashes in the value. Writes by default; honors `--dry-run`.
- **`dotmd archive --closeout-template`. (Issue #10 finding #5.)** CLAUDE.md says the closeout workflow is "write a `## Closeout` section, then archive" — but the CLI offered no scaffold, just a post-hoc warning. The new opt-in flag injects a small bullet skeleton (Outcomes / Key commits / Deferrals) into the plan body before the archive move. Idempotent: if `## Closeout` is already present, the flag is a no-op. Placed just before `## Version History` if present (so the closeout reads as content, not appendix), else at end of body. Honors `--dry-run`.

### Changed

- **Archive-collision paths are now deterministic. (Issue #10 finding #6.)** Re-archiving a file with the same basename used to produce `foo-20260526T224855Z.md` — non-deterministic, hard to cross-reference. Now: `foo.md`, `foo-2.md`, `foo-3.md`, … — readable, sortable, predictable. Especially helpful for `dotmd prompts use` where agents commonly reuse slugs like `resume-<plan>`. Affects both `dotmd archive` (plans) and `dotmd prompts use` (prompts), since both flow through `uniqueArchiveTarget` in `src/lifecycle.mjs`.

### Tests

10 new + 1 rewritten (5 frontmatter-fix in `test/doctor.test.mjs`, 5 closeout-template in `test/lifecycle.test.mjs`, the archive-collision test rewritten for the new shape and extended with a third collision). 935 → 945 passing.

## 0.39.4 — 2026-05-26

Sprint 2 of agent-DX work from issue #10. Three pure-additive findings — `dotmd help statuses` aggregator (#10), `prompts list --verbose` target ref (#8), and pickup error affordance + archive dry-run completeness (#1 + #11). No behavior change for callers who don't opt in.

### Added

- **`dotmd help statuses` — single-source-of-truth status reference. (Issue #10 finding #10.)** Original report: "to piece together the full plan-status vocab I had to read `dotmd new --help`, `dotmd plans --help`, and the body of `dotmd plans list --help`." Now one help topic prints the full vocabulary for every doc type (plan / doc / prompt), each status's unstuck-action one-liner, and the canonical transition commands. Cross-referenced from `status --help` and `plans --help`; surfaced under Setup in `dotmd --help`. Pure docs surface — no behavior change.
- **`dotmd prompts list --verbose` appends the target plan ref. (Issue #10 finding #8.)** Reported friction: `prompts list` showed slugs and statuses but not where each prompt pointed. Agents had to either `cat` the file or run `prompts use <slug>` (destructive — archives) just to see the target. Verbose mode now renders `→ docs/plans/<target>.md` per row. Target resolution order: (1) frontmatter `related_plans[0]`, (2) frontmatter `parent_plan`, (3) first body markdown link to a `.md` file (resolved relative to the prompt's location). All three sources are already in the index (`refFields`, `bodyLinks`) — no extra disk reads. Falls through to `(no target plan)` when none match.
- **`dotmd pickup` rejection includes the recovery command. (Issue #10 finding #1.)** Picking up a plan in `partial` / `paused` / `awaiting` / `blocked` / `queued-after` used to die with just `"Cannot pick up a plan with status 'X'. Must be active or planned."` — no path forward except editing YAML by hand. Now appends `Recover with: dotmd status <file> active && dotmd pickup <file>`, reusing the exact repo-relative path the agent passed in. Deferred the `--from <status>` flag pending real-world demand — the hint is the cheaper fix.

### Fixed

- **`archive --dry-run` previews lease release + onArchive hook fire. (Issue #10 finding #11.)** Previously the dry-run block listed frontmatter update, file move, index regen, and ref-update count — but silently omitted two side effects that the real run performs: releasing the in-session lease (if held) and firing the `onArchive` hook (if configured). Both now appear as `[dry-run] Would release in-session lease: <path>` and `[dry-run] Would fire hook: onArchive` when applicable.
- **`prompts {next,use} --dry-run` previews the body. (Issue #10 finding #11.)** The previous dry-run announced the intent (`Would emit body and archive: …`) but never showed *what* body would be emitted, defeating the point of preview. Body now renders to stderr inside a fenced preview block with byte / line counts. Stdout stays empty in dry-run mode so existing piping contracts (`$(dotmd prompts use foo)` etc.) aren't surprised by dry-run output.

### Tests

7 new across `test/integration.test.mjs` (2 — help statuses, unknown-topic error), `test/prompts.test.mjs` (4 — verbose target from related_plans, verbose target from body link, verbose orphan marker, dry-run body preview), `test/lifecycle.test.mjs` (2 — pickup recovery hint, archive dry-run hook preview). 927 → 935 passing.

## 0.39.3 — 2026-05-26

Sprint 1 of agent-DX work from issue #10. Three additive findings — `--no-index` (#3), `--show-files` (#9), and the `blocked_by` / prompt-body docs (#2 + #4). No behavior change for callers who don't opt in.

### Added

- **`--no-index` flag on every lifecycle verb. (Issue #10 finding #3.)** Concurrent-session repos hit a path-limited-commit problem: `dotmd archive` / `dotmd status` / `dotmd pickup` / `dotmd release` / `dotmd prompts use` / `dotmd prompts archive` / `dotmd bulk archive` all regenerate `docs/plans/README.md` in place. When other agents have uncommitted edits to the index, `git add <plan> <index>` pulls in their lines too. Reframed from the original "incremental regen" proposal: tracing the scenario showed that whether you patch incrementally or regen fully, the working tree still contains every agent's filesystem state — patching alone doesn't fix co-mingling. The actual fix is letting the caller skip the regen and refresh later (commit hook or separate `dotmd index`). With `--no-index`, each affected verb emits a one-line stderr notice (`(index not regenerated — run \`dotmd index\` to refresh)`) and leaves `README.md` byte-identical. Bonus: `runBulkArchive` now always defers index regen internally and runs ONE regen at the end (going from N regens to 1 on a bulk of N plans); `--no-index` skips even that final one.
- **`--show-files` flag on lifecycle/mutation verbs (archive, status, pickup, release, bulk archive, prompts use/archive, new). (Issue #10 finding #9.)** Agents doing path-limited commits had to guess which files each verb modified. Now appends a trailing `files: a b c …` line to stderr — repo-relative, deduped, sorted, space-separated, parseable. Default off so existing output stays stable. The footer respects `--no-index`: if the index regen was skipped, the index path is NOT in the footer.
- **`blocked_by:` accepted as an alias for `blockers:`. (Issue #10 finding #2.)** Agents reaching for the JIRA/Linear-style name now get the same indexed field; both names populate `doc.blockers` via `mergeUniqueStrings` (de-duped if both set). `dotmd unblocks --help` documents the frontmatter shape and names both aliases. Validation now checks the YAML-list shape for either.

### Docs

- **CLAUDE.md prompt section calls out all four body-input modes. (Issue #10 finding #4.)** The previous example only showed heredoc, leading the issue's reporting agent to conclude `dotmd new prompt` body input was "awkward" — when really `-` / `@path` / `--message` / inline all work for every body-accepting type. The expanded example demos all four with a note that heredoc is brittle for content with backticks.

### Internal

- `runArchive` now returns `{ touched }` so `runBulkArchive` can collect and emit a single `--show-files` footer at the end (matches the deferred-index-regen pattern).
- `updateRefsAfterMove` returns `{ count, paths }` instead of a bare count — needed so the `--show-files` footer can name the ref-updated files, not just count them.

### Tests

11 new across `test/lifecycle.test.mjs` (4 for --no-index, 5 for --show-files) and `test/index.test.mjs` (2 for blocked_by alias). 916 → 927 passing.

## 0.39.2 — 2026-05-26

### Fixed

- **`dotmd new <type>` for config overrides of built-in types: smart-inherit + honest error message.** A project that overrides `templates.plan` (or `templates.doc` / `templates.prompt`) in `dotmd.config.mjs` previously hit a contradictory error when piping body via `-` / `@path` / `--message`: `\`plan\` template does not accept body input … Templates that accept body input: doc, plan, prompt.` The hint computed from `BUILTIN_TEMPLATES` listed `plan` as accepting body even though the override was the one being rejected — agents had no way to self-fix without spelunking the config. Two changes: (a) `resolveTemplate` now shallow-merges the built-in under the override so missing fields (`description`, `dir`, `targetRoot`, `defaultStatus`, `frontmatter`, `body`, `acceptsBody`, `requiresBody`) inherit cleanly. Pure-metadata overrides (e.g., a project-branded `description` only) just work. (b) When an override supplies its own `body` fn without declaring `acceptsBody`/`requiresBody`, dotmd detects whether the fn references `bodyInput` — if so, body-acceptance is inherited from the built-in (body-aware overrides "just work"); if not, the inherited acceptance is stripped so the fail-fast guard still fires on silent body-discard. The error message itself is rewritten to compute the "accepting" list from the resolved template set (no more self-contradiction) and, when the offending name is a built-in override, calls that out by name with a concrete two-step fix — `acceptsBody: true` + `\${ctx?.bodyInput?.trim() ?? ''}` interpolation — and names the `dotmd.config.mjs` path the agent has to edit. 3 new tests; 916 passing.

## 0.38.0 — 2026-05-26

Agent workflow improvements: lease warnings, a shelved prompt status, and an opt-in command journal. All changes are additive.

### Added

- **`dotmd check` warns when an `in-session` plan has no live lease.** Missing and stale leases now produce distinct warnings with commands to release or re-queue the plan.
- **`shelved` prompt status: pending lifecycle gets a "saved but not next" bucket.** Shelved prompts are hidden from the pending dashboard and next-prompt selection. `dotmd prompts shelve <file-or-slug>` and `unshelve` change the status without moving files.
- **`dotmd journal` + opt-in `.dotmd/journal.jsonl`. (F17a — P2 agent observability.)** dotmd's primary user is Claude (per memory), but there was no usage signal: failed invocations (wrong arity, typoed argv), retries, cross-session activity. Every dotmd UX decision was informed by guesswork or one-shot audit snapshots. F17a is the foundation: every CLI invocation now appends one JSONL line — `{ts, sid, pid, argv, exit, ms, v, err?}` — to `.dotmd/journal.jsonl` when enabled via `DOTMD_JOURNAL=1` (env) or `journal: true` (config). Default-off keeps the surface clean for non-agent users. New `dotmd journal` reader supports `--tail N` (default 20), `--errors`, `--session <id>`, `--since <iso>`, `--by-command` (group + median ms + error rate), `--json` (raw array dump). Atomic concurrent writes via `appendFileSync` with `O_APPEND` (entries are well under `PIPE_BUF`). Lazy rotation to `.dotmd/journal.jsonl.1` at >5MB or oldest entry >30 days. F17b (hud reads journal) and F17c (`die()` self-correcting hints) are downstream — held for ~1 week of real journal data to shape the render.

### Tests

19 new regression tests: 4 in `test/validate.test.mjs` (F11 lease scenarios — no-lease, fresh, stale, non-in-session regression), 6 in `test/prompts.test.mjs` (F14 — list inclusion, `next` skip, empty-queue, shelve/unshelve, hud suppression), 9 in `test/journal.test.mjs` (F17a — opt-in default, env enable, config enable, concurrent atomicity, rotation, reader `--tail`/`--errors`/disabled-state). Total: 886 → 905.

## 0.37.0 — 2026-05-26

Safety and output improvements: doctor reports by default and repeated auto-fixable warnings are grouped into bulk-fix hints.

### Changed

- **`dotmd doctor` previews by default; `--apply` (alias `--yes`) writes. (F4 — P2 safety.)** The auto-fix pass (refs, lint, dates, index regen, Claude command refresh) used to mutate on first invocation — the audit found this surface was too low for a multi-step batch operation on a 1k+ doc repo (three files were rewritten before the auditor noticed and reverted). Now: bare `dotmd doctor` runs the same pipeline as a dry-run preview and prints a banner naming the flag — `dotmd doctor [preview — run with --apply to write]`. When mutation is desired, `--apply` (or `--yes`) flips back to write mode and the banner reads `[applying changes]`. If both `--apply` and `--dry-run` are passed, `--dry-run` wins (explicit safety prevails over explicit intent). Sub-modes — `--statuses`, `--migrate-template`, `--migrate-prompts` — keep their existing "write unless `--dry-run`" contracts because they're explicit one-shots the user opted into. **This is a behavior break for any scripted callers of plain `dotmd doctor`** — add `--apply` to scripts to preserve the old behavior. Mirrors `dotmd archive`'s safe pattern.

### Added

- **`dotmd check` collapses high-frequency auto-fixable warnings into one-line bulk-fix hints.** Categories with three or more findings name the applicable bulk repair command; smaller groups retain individual paths. Categories shipped:
  - `updated-behind-git` → `dotmd touch --git`
  - singular `module:` deprecation (F18) → `dotmd lint --fix`
  - singular `surface:` deprecation (F18) → `dotmd lint --fix`
  Structural warnings (missing title, broken body links, ref reciprocity, etc.) always pass through per-doc — location matters for those. `dotmd check --no-collapse` opts every warning back to per-doc rendering. `dotmd check --json` is unchanged regardless of collapse — JSON consumers see the full per-doc warning list and the collapse is purely a text-render concern. `dotmd doctor`'s step-6 remaining-issues view inherits the collapse for free.

### Tests

Added 15 regression tests across `test/check-collapse.test.mjs` (5 unit + 6 CLI) and `test/doctor.test.mjs` (4 F4 cases). Total: 871 → 886.

## 0.36.3 — 2026-05-26

Singular `module:` and `surface:` fields are deprecated in favor of `modules:` and `surfaces:` arrays. Readers continue to merge both forms for compatibility.

### Deprecated

- **Singular `module:` / `surface:` frontmatter keys.** Every singular use now emits a `dotmd check` warning with the exact migration target inlined: `\`module:\` (singular) is deprecated — use \`modules: ["foo"]\`. Run \`dotmd lint --fix\` to migrate.` When both singular and plural are set, the target shows the merged deduped list. Suppressed for archived/terminal docs (same noise-control rule as F2). The reader still merges singular into plural transparently — existing corpora keep working. Removing the reader-side merge is reserved for a future major bump.

### Changed

- **`dotmd lint --fix` now migrates ALL singular `module:` / `surface:` use, not just comma-containing values.** The 0.34.0 lint pass only rewrote `surface: a, b` (multi-value strings); single-value singular keys stayed. F18 generalizes the migration: any singular use becomes a plural array, merging with any existing plural list and deduping. Internal fix type renamed `split-to-array` → `singular-to-plural` and now covers both `module`/`modules` and `surface`/`surfaces`.
- **F3-era divergence-only warning is subsumed.** The previous "Both `module` and `modules` set with different values" warning was a noise-control compromise that only fired on divergence. F18 replaces it with a universal singular-use warning, so the message is consistent regardless of whether plural is also set.
- **`modules`-required error no longer advertises the singular form.** The "Accepts singular `module:` or plural `modules:` list" hint in the `dotmd check` error message is gone — error messages shouldn't document a deprecated path.

### Tests

8 new regression tests across `test/validate.test.mjs` (5) and `test/lint.test.mjs` (3); 4 F3-era tests updated to assert the new universal-warning behavior. Total: 863 → 871.

## 0.36.2 — 2026-05-26

Output and diagnostic improvements with no schema changes or breaking behavior.

### Added

- **`dotmd query` and `dotmd plans` show "N of M (use --all)" when truncated.** Previously the text renderer dropped the `_totalBeforeLimit` value that the JSON output already exposed, so a query returning 20 of 125 docs printed `results: 20` with no hint that more existed. Now: `results: 20 of 125 (use --all to see all)`. The same fix lifts the existing "N more plans" footer out of `dotmd plans`' triage-only branch — it now renders for `--sort status` and `--group module/surface/owner` views too. (Audit findings F7, F9.)
- **Config-load warning when a rich-status definition has contradictory flags.** A status configured with both `skipStale: true` and `staleDays: 60` silently dropped the number — the boolean won. Same for `skipWarnings: true` paired with `requiresModule: true` (the module requirement could never fire). `normalizeRichStatuses` now emits a `warn()` at load time naming the type, status, and conflicting fields. Catches dead config that would otherwise stay invisible. (Audit finding F8.)
- **`config.context.staleTailLimit` (default 8).** Caps stale slug lists in `dotmd context` and `dotmd hud`, then points to `dotmd stale` for the full list.

### Fixed

- **`dotmd glossary` differentiates "section not found" from "section found but no entries."** The diagnostic explains whether to add the heading or supply a recognizable glossary table. `dotmd glossary --list` uses the same distinction.

### Tests

Added 16 regression tests across `test/glossary.test.mjs` (4), `test/query.test.mjs` (6), `test/render.test.mjs` (4), `test/config.test.mjs` (3) — totals went 847 → 863.

## 0.36.1 — 2026-05-26

Two small polish items from the agent-UX audit's A2/A3 deferred list.

### Added

- **`Did you mean: …?` on `dotmd status <file> <unknown-status>`.** Same `suggestCandidates` helper that powers ref-resolution and module-name hints, now wired into the status validator. A typo like `dotmd status foo.md planed` (one letter off `planned`) now ends with `Did you mean: planned?` instead of leaving the agent to scan the full `Valid: …` list. Falls back silently when nothing in the per-type/per-root status set is close (no `Did you mean: (none)`). Closes the A3 follow-up listed in `docs/agent-ux-audit.md` Deferred.

### Fixed

- **`dotmd new plan <name> "<full-body>"` no longer leaves a duplicate empty scaffold below the inserted body.** When the inline/`@path`/`-`/`--message` body input already authors `## Section` headings (i.e. the agent wrote a complete plan body start-to-finish), the plan template now short-circuits the scaffold ladder and emits only the title + the user's body. Previously, the body got slotted into `## Problem` while the scaffold's later `## Goals`, `## Non-Goals`, `## Phases`, etc. still rendered empty below, leaving a confusing duplicated outline. Single-section bodies (no `## ` heading) still land under `## Problem` as before — the contract widens, doesn't change. Closes the A2 polish item from `docs/agent-ux-audit.md` Deferred (discovered while drafting the A4 plan itself).

## 0.36.0 — 2026-05-26

Two read-only commands for organizing and inspecting document collections, without a schema change or migration.

### Added

- **`dotmd modules` — module dashboard.** One row per module discovered in plan frontmatter, with dynamic status columns (only statuses with ≥1 plan render — auto-handles default and custom vocabularies). Sort modes: `total` (default), `stale`, `age`, `nextstep`, and `cleanup` — the last is a triage rank `(stale × avgAge) / max(total, 1)` for "which module is rotting hardest right now?" Defaults to `--type plan`; `--type doc` works but column set may look different. `--limit 20` (default) / `--all`. `--json` includes `_totalUnique` so callers can detect multi-module double-counting (a plan with `modules: [a, b]` counts in both rows — intentional). `(none)` is a literal row for unmoduled plans. Falls back to a stacked render when the table doesn't fit the terminal width.
- **`dotmd module <name>` — per-module deep view.** Plans grouped by status, ordered by `config.statusOrder`, stale flag inline. `--sort status` (default) / `updated` / `age`. Unknown module name exits with `Module 'foo' not found. Did you mean: …?` (substring-first, Levenshtein ≤3 fallback). `--json` for tooling.
- **`dotmd stale --group module`** documented (existing `query --group` mechanism, now called out in `dotmd stale --help` as the canonical triage view).

The dashboard composes existing primitives (`modules: []`, `isStale`, `daysSinceUpdate`, `hasNextStep`, `statusOrder`, `lifecycle.skipStaleFor`, `lifecycle.terminalStatuses`) — no new config knobs. Workflow: `dotmd modules --sort cleanup` → walk the top row → `dotmd module <name>` → triage/archive → next.

## 0.35.0 — 2026-05-26

One agent-UX fix from the audit doc (`docs/agent-ux-audit.md` § A4). Additive — no breaking change, no config migration.

### Added

- **Per-ref `>` prefix marks a single ref as one-way.** `referenceFields.bidirectional` is per-field, all-or-nothing — so a `related_docs: docs/audit-doc.md` pointing at a parent audit always tripped the `does not reference back` warning, and the only escape hatch (moving the whole field to `unidirectional`) gave up legitimate sibling-cross-ref reciprocity checks. The opt-out now lives on the ref itself: prefix the value with `>` in frontmatter and `dotmd check` skips reciprocity for that one entry while keeping the field bidirectional everywhere else. The prefix is stripped before path resolution, so refs still resolve. Works on any ref field (bidirectional or unidirectional). Example:
  ```yaml
  related_docs:
    - docs/sibling-design.md            # bidirectional (default for the field)
    - "> docs/audit-example-project.md" # one-way upstream — no back-ref expected
  ```
  Retired 7 false-positive warnings in this repo's own corpus (leaf plans/docs referencing parent audit docs and archived siblings). (Audit finding A4.)

## 0.34.0 — 2026-05-25

Three agent-UX fixes bundled from the audit doc (`docs/agent-ux-audit.md` § A1–A3). Each one shaves a tool round-trip off a routine flow — the cost-of-friction multiplier on an agent is much higher than on a human at a terminal, so defaults and error messages designed for tool-using consumers matter disproportionately. One breaking change in `dotmd index`'s default (call-out below).

### Changed (breaking)

- **`dotmd index` writes by default.** Previously, `dotmd index` (no flag) printed the regenerated block to stdout and required `--write` to actually update the configured index file — so `dotmd check`'s `Generated index block is stale. Run \`dotmd index\`` error pointed at a command that didn't fix the error. Now the default writes (the call site that always wanted the write), and the new `--print` flag preserves the old stdout-only behavior for debugging or scripting. The stale-index error message is now self-consistent. **Migration:** any script that was parsing `dotmd index`'s stdout should switch to `dotmd index --print`. `--write` is no longer documented but is accepted as a silent no-op so existing scripts that pass it explicitly keep working. (Audit finding A1.)

### Added

- **`dotmd new plan <name> "<body>"` accepts a body argument.** Mirrors the `doc` and `prompt` shape — the inline/`--message`/`-`/`@path` body input now lands under the plan's `## Problem` section instead of being rejected with an error pointing at "set `acceptsBody: true` on your custom plan template" (which didn't apply, because the built-in plan template was the one rejecting body input). All built-in templates (`doc`, `plan`, `prompt`) now consume body input; custom templates that opt out still get the fail-fast error. (Audit finding A2.)

- **`Did you mean: ...?` suggestions on unresolved refs, glossary misses, and unknown `--module` values.** Three sites that previously left the agent guessing now name plausible candidates from the index:
  - `dotmd check` ref-resolution errors (`related_plans entry \`foo.md\` does not resolve to an existing file.`) now append up to three close candidates, filtered by inferred ref-field type — a `related_plans` typo suggests plans, `related_docs` suggests docs.
  - `dotmd glossary <term>` no-match output (`No glossary match for "Widgit".`) now appends close glossary-term candidates.
  - `dotmd query --module <name>` (and the `plans` / `prompts` presets) now appends a `No module \`<name>\` in index. Did you mean: ...?` line when the value doesn't exist anywhere in the index. Combination misses where the module exists are not flagged.
  Ranking is substring-first, Levenshtein distance ≤3 second, top 3, deduped. No close match → no suggestion line (no `Did you mean: (none)`). Helper lives at `src/util.mjs:suggestCandidates`. (Audit finding A3.)

## 0.33.0 — 2026-05-25

Two paired additions that close the agent-side session-handoff loop. `/baton` is the canonical wrap-up verb (status-update the in-flight plan, save a lean handoff prompt, release the lease) — replacing the prose-only "Resume prompts" section in CLAUDE.md that agents followed inconsistently. `.claude/commands/*.md` self-heal on dotmd upgrade so any future tweak to baton's wording (or to `plans.md` / `docs.md`) propagates to every project on the next session, not on whenever the user remembers to run `dotmd doctor`.

### Added

- **`/baton` slash command — one verb wraps the session-handoff flow.** Scaffolded into `.claude/commands/baton.md` alongside the existing `plans.md` and `docs.md` templates. Body is ~13 lines: (1) update the in-flight plan's `current_state` / `next_step` and transition status with `dotmd status` or `dotmd archive`; (2) save ONE lean handoff prompt via `dotmd new prompt resume-<plan-slug>` (~10-20 lines per the prompt-leanness convention); (3) `dotmd release` the lease. Leans on Claude's judgment for the prompt's shape rather than prescribing a 50-line template. Adds zero CLI surface — composes existing verbs (`plans`, `status`, `archive`, `new`, `release`, `hud`) all already in `KNOWN_COMMANDS`, so the regression test that asserts every `dotmd <verb>` reference in generated templates resolves continues to cover the new file automatically. (See `docs/plans/baton-slash-command.md`.)

- **`.claude/commands/*.md` self-heal on `dotmd` upgrade.** Before this, `scaffoldClaudeCommands` already wrote banner-versioned files (`<!-- dotmd-generated: X -->`) and refused to touch files without a banner (user-managed) — but the only refresh triggers were `dotmd init` (one-time) and `dotmd doctor` (manual). After a `dotmd-cli` upgrade, every project's slash-command bodies stayed frozen at the installed version's wording until the user remembered to run `doctor`. Now `runHud` — already wired as a SessionStart hook — calls `refreshStaleSlashCommands` after building the HUD, silently regens any file whose banner is older than the current `pkg.version`, and surfaces a single dim line: `↻ slash commands refreshed (vX → vY): foo.md, bar.md`. Wrapped in try/catch so a broken scaffolder can never kill the hook (would block every session). Skipped in `--json` mode to keep the structured shape stable for programmatic callers. Files without the banner remain user-managed and are still ignored — the existing `skipped` rule is the documented escape hatch. The `.claude/settings.json` hook line itself never changes shape; the static `"command": "dotmd hud"` keeps working across all future dotmd versions because the binary upgrade carries the new behavior. (See `docs/plans/slash-commands-self-heal.md`.)

## 0.32.1 — 2026-05-24

Three correctness fixes for repositories with multiple document roots and customized configurations. No API changes.

### Fixed

- **`dotmd graph` and lifecycle ref-rewrite resolve repo-relative refs correctly.** Graph, archive and rename now use the shared `resolveRefPath` resolver before falling back to document-relative resolution, avoiding doubled roots and missed reference rewrites.

- **`Unknown surface`, `body link does not resolve`, and ref-field "does not resolve" validators honor `skipWarningsFor` and `terminalStatuses`.** Quiet statuses suppress the relevant warnings; terminal records may retain references to documents that no longer exist.

- **Conflicting singular/plural metadata warns only when values diverge.** A singular `module` or `surface` already present in its plural array is consistent and does not warn. Compatibility merging is unchanged.

## 0.32.0 — 2026-05-24

Closes the four remaining gmax-audit enhancements (B, D, E, A) — design choices that the 0.31.4 bug-fix sweep deliberately deferred. Headlined by the new `dotmd bulk-tag` command, which closes the brownfield onboarding gap that 0.31.4's "Untagged" surfacing exposed but didn't solve.

### Added

- **`dotmd bulk-tag` — tag pre-existing untagged markdown in one shot.** `dotmd init` on a brownfield repo already counted pre-existing `.md` files (`scanExistingDocs` in `src/init.mjs`) but did nothing with them — the user had to hand-write `type:` + `status:` frontmatter on every file before they showed up in `dotmd list`, `query`, or `briefing`. The audit called this out as the bounce-risk: "init counts them, then leaves the user to do N edit-saves by hand." The new `dotmd bulk-tag` command scans the docs tree, picks up files missing `type:` or `status:` (or with no frontmatter block at all), infers the type from the file's subdir (`docs/plans/foo.md` → `type: plan`, `docs/prompts/bar.md` → `type: prompt`, anything else → `type: doc`), and writes the minimal frontmatter. Already-tagged files and archived files are skipped. Existing frontmatter fields are preserved verbatim — bulk-tag only fills in what's missing. Defaults lean conservative (`draft`/`planned`/`pending`) so the active list doesn't get polluted without consent; override per-run with `--type` / `--status`. Standard `--dry-run` and `--json` support. Sibling helper `writeFrontmatter()` in `src/lifecycle.mjs` handles the "no `---` block exists yet" branch that `updateFrontmatter()` throws on. (gmax audit enhancement A.)

- **`dotmd init` hints at `dotmd bulk-tag` when untagged files are detected.** Closes the loop: `scanExistingDocs` now tracks an aggregate `untaggedCount` (files with no frontmatter + files whose block is missing `type:` or `status:`). When > 0, init emits a single yellow `hint` line pointing at `dotmd bulk-tag --dry-run`. Init's job stays discovery — the per-file detail lives in bulk-tag's own output. Quiet on clean repos so re-running init doesn't nag. (gmax audit enhancement A — init wiring.)

- **`dotmd init` prints a paste-ready SessionStart hook snippet when unwired.** Init already called `dotmd hud` "the ideal SessionStart hook" but stopped short of helping the user wire it. Now, when `.claude/` exists and detection finds no `dotmd hud` SessionStart hook in either the project's `settings.json` / `settings.local.json` or the user-global `~/.claude/settings.json`, init prints a paste-ready JSON snippet plus a merge note so existing settings files don't get blown away. When the hook is already wired, prints a quiet `exists` line naming the settings file that wired it. Detection-only — no file mutation. The `~/.claude/settings.json` fallback exists because Claude Code merges user-global hooks into every project: if `dotmd hud` is wired globally, every project picks it up and a per-project snippet becomes noise. (gmax audit enhancement E.)

- **Body-scraped `current_state` values render with an `(auto)` prefix.** For non-terminal docs without explicit `current_state:` in frontmatter, the index layer scrapes a status snapshot from the body (via `extractStatusSnapshot`). That scrape happened silently — readers couldn't tell whether `Active: Phase 2 underway` was canonical frontmatter or a best-effort string lifted from a body bullet, and therefore couldn't tell that adding `current_state:` to frontmatter would override it. Index now tracks origin (`currentStateOrigin: 'frontmatter' | 'body' | null`) and render layers (`formatSnapshot`, verbose list, `dotmd query`) prefix `(auto) ` when origin is `body`. The data field stays unprefixed so JSON consumers see the raw value plus the new `currentStateOrigin` field. (gmax audit enhancement D.)

- **`dotmd init` shows a copy-pasteable command alongside the `!docs/` gitignore hint.** The existing 0.31.4 notice told the user to add `!docs/` to `.gitignore` but made them edit the file by hand. Adds one extra line — `echo '!docs/' >> .gitignore` — so the fix is a paste away. Pure additive; the prescriptive hint and warning text stay put. (gmax audit enhancement B.)

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
- **`dotmd unpickup [<file>]`.** Releases in-session leases and flips frontmatter back to the recorded prior status. With no args, releases every lease owned by the current session — the form intended for a Claude Code `SessionEnd` hook. Flags: `--to <status>` (override target), `--all` (release every lease), `--stale` (release leases stale under the then-current lease rule), `--force` (override cross-session refusal), `--json`, `--dry-run`. Manual-edit fallback: if the plan's status is `in-session` but no lease exists, `--to <status>` flips it anyway with a warning. Calls a new `hooks.onUnpickup` config callback on each release.
- **`dotmd pickup --takeover`.** Force-claim a plan held by another session (typical use: the prior holder crashed or the lease is stale). Records `takenOverFrom: { session, pid, pickedUpAt }` on the new lease for an audit trail.
- **`dotmd briefing` surfaces stuck leases.** When `findStaleLeases` returns non-empty, the briefing prints a stuck in-session hint with the stale count and release command.
- **Correction:** 0.17.0 documented dead-pid reclamation too broadly. Current behavior as of 0.49.0 is dead same-host pid or age over 4 hours; historical 0.17.x builds primarily used age-based staleness.
- **`dotmd init` ensures `.dotmd/` is gitignored.** Creates `.gitignore` if missing, appends `.dotmd/` if absent, and is idempotent on re-run.
- **README "Session leases & unpickup" section** documenting the lease semantics, the session-id resolution order, the `SessionEnd` hook recipe for `~/.claude/settings.json`, and the takeover workflow.

### Changed

- `dotmd pickup` no longer hard-rejects a plan whose status is already `in-session`. It defers the decision to the lease layer: same session → silent re-attach (prints body, no frontmatter rewrite); different session, live pid → refuses with `Held by <host>/<session> …`; different session, stale by the then-current lease rule → suggests `--takeover`.
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
