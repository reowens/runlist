# runlist

CLI for managing Markdown documents with YAML frontmatter.

runlist (formerly dotmd) indexes, queries, validates, graphs, exports, and lifecycle-manages plans,
ADRs, RFCs, design docs, and other structured Markdown. It is built for
AI-assisted development workflows where documents need to remain current and
safe to mutate.

- Zero runtime dependencies
- Node.js 20 or newer
- Runtime support for Linux, macOS, and Windows
- Type-aware lifecycle rules for plans, docs, and saved prompts

## Install

```bash
npm install -g runlist      # global CLI and agent-host hooks
npm install -D runlist      # project scripts via node_modules/.bin
npx runlist init            # try it without installing
```

`runlist` is the canonical executable, `rl` is its short convenience alias, and
`dotmd` remains supported during the compatibility window. All three invoke the
same CLI. The npm package is `runlist`; existing `dotmd-cli` installs should be
replaced with `runlist`. The Claude Code plugin is `runlist@runlist`. Legacy
`dotmd.config.*` files, `DOTMD_*` variables and `.dotmd/` state keep working.

If you installed the old package globally, remove it before installing the new
one because both packages provide the same executable names:

```bash
npm uninstall -g dotmd-cli
npm install -g runlist
```

The desktop app is a separate build with the same Markdown engine; see
[desktop setup and validation](desktop/README.md). Current source includes
reviewed plan/doc/hub creation, ⌘/Ctrl+K navigation, on-demand local content
search, saved library views, checkout-wide recovery and reviewed local Git commits
for qualified macOS checkouts. Saving writes local Markdown; committing remains
a separate reviewed action. Current source also has optional grepmax semantic
search in quick navigation and the library; local chat and push are deferred. The installed signed app and release artifacts
have their own qualification snapshots.

The delivered Apple Silicon GUI is **0.91.0-rc.3**, personally signed, accepted
by Apple and installed at `~/Applications/Runlist.app`, with rollback retained.
Its [public Mac installer](https://github.com/reowens/runlist/releases/tag/desktop-v0.91.0-rc.3)
is separate from [CLI 0.91.0](https://github.com/reowens/runlist/releases/tag/v0.91.0),
which now includes `runlist desktop install`. No further Apple checks are selected.
The earlier development snapshots and qualification notes below are historical;
see the current release record.

A newer unsigned Mac development package includes guarded local
commits, configured hooks, noninteractive signing and one-shot clean-filter review.
Its bundled engine passed **44 checks with networking denied**; source qualification
covers 49 commit/read cases on each existing Mac/Linux ARM64 matrix, with passing
focused corrections recorded in the package evidence. It has not
been installed, signed for distribution or submitted to Apple. The earlier
Apple request is unchanged and its checks remain stopped.

The remaining work, in order:

1. Expand local-commit qualification to process filters, broader clean-filter
   command profiles, Windows, Linux x64/other Git versions and additional signing profiles.
   Configured commit hooks and noninteractive SSH/OpenPGP signing are supported
   in current source on the qualified macOS/Linux combinations. Push is deferred.
2. Optional grepmax live retrieval/coverage qualification is parked: the owner
   reports a watcher issue requiring a reboot. The last check saw gmax 0.26.65
   ready, but its installed bridge/daemon lacked Runlist's required document-search
   contract. Watcher recovery and compatibility must be verified before live
   qualification resumes; preserve the existing safety hold. See the
   current status and resume gates.
   The compatibility plan
   now has steps 1–4 passing against gmax 0.26.66 source and an extracted local
   npm candidate, including the actual private helper. Deployment and live
   checks remain separate gates.
   Large-checkout inventory,
   unavailable-state memory/latency and bridge cleanup have terminal evidence.
   The GUI/backend and guarded protocol fixtures are implemented; installed
   artifacts do not include this change. Optional local model chat follows later.
3. Complete native plan lifecycle, legacy migration,
   settings/diagnostics, and stage/filing integration.
4. Finish platform qualification: a terminal-ready Windows host, Linux x64 and
   older distributions, real-version upgrades, fresh/minimum-version and Intel
   Macs, plus native rendering, focus, accessibility and whole-window memory.

Mac GUI delivery and CLI 0.91.0 publication are complete. The supported desktop
release is Apple Silicon macOS 13.5 or newer. Broader platform work and
experimental semantic search remain separate follow-up work.

Maintainer release automation is POSIX-only because it uses Bash and POSIX
command-line tools. The published Node.js CLI remains cross-platform.

### Optional desktop GUI

The CLI works on its own. To install the optional GUI on an Apple Silicon Mac
(macOS 13.5 or newer), run:

```bash
runlist desktop install
runlist desktop
```

The installer downloads the GUI from Runlist's public GitHub Releases, checks
its SHA-256 digest, developer signature and Apple approval, then installs it
without opening it. The app bundles its runtime and reads local files through
private pipes, with no listening server. Choose your checkout folder in the app.
No checkout configuration is loaded by these CLI commands.

The GUI is versioned separately: the current Mac installer is
[Runlist 0.91.0-rc.3](https://github.com/reowens/runlist/releases/tag/desktop-v0.91.0-rc.3).
Windows, Linux and Intel Mac GUI downloads are not yet available through this
command. An existing app is kept as-is. To replace it using a downloaded signed
DMG, quit Runlist and run:

```bash
runlist desktop install --from /path/to/Runlist.dmg
```

Replacement keeps the previous app as a rollback copy. Add `--dry-run` to preview
an install or launch without network access, file changes or opening the app.
Use `runlist desktop --app /path/to/application` for a custom installation path.

### Agent host setup

The CLI alone gives an agent no orientation and no session identity. Install the
integration for whichever host you run:

```bash
runlist install             # what's installed for each host
runlist install claude      # Claude Code plugin (marketplace + plugin)
runlist install codex       # Codex skill and hooks (personal marketplace)
runlist install opencode    # OpenCode plugin (one auto-discovered file)
runlist doctor --session    # what identity runlist sees here, and from where
```

The integrations are one-time and global. Codex exports `CODEX_THREAD_ID` to
every tool shell, so its identity works without the plugin; the plugin adds a
workflow skill, session orientation, and the tool guard.

### Codex Plugin

`runlist install codex` copies the plugin included in the npm package into the
personal Codex marketplace and runs `codex plugin add runlist-codex@personal`.
Codex asks you to review and trust plugin hooks separately. Start a new thread
after installation so the skill and SessionStart primer load. The hooks use
the globally installed `runlist` CLI; a missing CLI produces one install hint
and otherwise leaves tool calls alone. `CODEX_THREAD_ID` stays the ownership
source. The CLI refuses to overwrite a plugin directory it did not generate.

Direct prompt reads warn by default in Codex and Claude. A repository can set
`export const guard = { promptReads: 'deny' };` to block reads of existing
pending prompts; `runlist prompts show` remains the read-only inspection verb.

### Claude Code Plugin

`runlist install claude` runs the two steps below for you. From inside a session:

```text
/plugin marketplace add reowens/runlist
/plugin install runlist@runlist
```

Existing `dotmd@dotmd` installs can be migrated with `runlist install claude`
or `runlist update --plugin-only`. The command installs `runlist@runlist` and
then uninstalls the old plugin, so its hooks do not run twice.

The plugin provides SessionStart and SubagentStart orientation, a
UserPromptSubmit hint that gives the exact `runlist baton` form when you ask for
a handoff, a PreToolUse guard, the canonical workflow skill, and `/plans`,
`/docs`, `/prompts`, and `/baton` commands.

### OpenCode Plugin

`runlist install opencode` writes one plugin file into OpenCode's global config
directory, where OpenCode auto-discovers it — no `opencode.json` edit. It
supplies the two things the CLI cannot get on its own:

- **Per-session plan ownership.** OpenCode exports no session id to a tool
  shell. Without the plugin, runlist falls back to `OPENCODE_PID`, which names the
  OpenCode *process* — so every session in one OpenCode instance shares an
  identity and can release the others' in-session plans.
- **A session-start briefing**, the equivalent of Claude Code's SessionStart
  hook. OpenCode's Claude Code compatibility covers skills and the system
  prompt, not hooks, so nothing else runs `runlist hud`.
- **Prompt-read guardrails.** Recognized reads are checked before execution so
  the opt-in strict policy can stop them. Default warnings are attached to the
  result because OpenCode's before hook cannot return model context.

Restart OpenCode after installing. The generated file is `runlist.js` and is
version-stamped (`runlist-generated:`). `runlist install opencode` migrates a
generated `dotmd.js` from older releases; an unmarked file is treated as
hand-authored and is never overwritten.

The plugin requires a global CLI install because its hooks resolve `runlist` (or `dotmd`) from
`PATH`. A project devDependency is useful for npm scripts but does not put the
CLI on the hook's `PATH`.

Keep the CLI and plugin aligned with:

```bash
runlist update
runlist update --check
runlist update --cli-only
runlist update --plugin-only
```

Restart Claude Code, or run `/reload-plugins`, after a plugin update.

## Quick Start

```bash
runlist init                    # create config, docs/, and the generated index
runlist new plan auth-refresh  # scaffold a typed document
runlist plans                  # compact live plan dashboard
runlist briefing               # comprehensive active-work view
runlist check                  # validate schema, references, and lifecycle shape
runlist doctor                 # preview repairs; add --apply to write
```

`runlist plans` is the compact orientation view. `runlist briefing` lists live
plans with next steps and grows with the corpus. `runlist context` is the fuller
human/LLM briefing, while `runlist agent-context` emits bounded structured JSON for
agent integrations. Its default response is capped at 16,384 UTF-8 bytes,
including JSON formatting and the final newline. Each collection reports
`total`, `shown`, and `truncated`; `budget` reports emitted bytes. Claims, the
next pending prompt, and the first plan action are retained. If protected
information cannot fit, the command reports the required budget rather than
silently dropping it.

```bash
runlist agent-context --sections plans,prompts,counts --max-bytes 8192
runlist context --json --compact --sections plans,issues
```

Available sections are `statusVocabulary`, `counts`, `prompts`, `plans`, and
`issues`. Section selection is explicit in the response's scope. Passive
context reads continue to skip custom side effects and expensive Git history.

The developing native record format is specified by
[runlist-record-v1.schema.json](assets/schemas/runlist-record-v1.schema.json).
It uses flat frontmatter for identity and lifecycle fields, a literal
`record_data` block containing nested JSON, and native Markdown for narrative
and anchored plan tasks. The read-only parser in `src/native-record.mjs`
preserves original source, validates metadata and relationships, and rejects
ambiguous keys, unsupported versions, incomplete resolution evidence, and
invalid ruling provenance. Existing CLI writers and migration do not yet use
this format; ordinary legacy documents and flag logs remain unchanged.

The local source-editing core in `src/source-editor.mjs` provides authenticated
actor attribution, exact revision saves, durable retry/repair receipts, private
draft recovery, and compensating undo. It preserves frontmatter and lifecycle
history, respects CLI claims, and reports conflicts with the current source.
The [source editing contract](assets/contracts/source-editing-v1.md) describes
the API and trusted host responsibilities. The local browser adapter below
uses that core; managed record domain writers remain upcoming work.

Runlist also has a [macOS desktop application](desktop/README.md) built from this
source checkout. Install `Runlist.app`, open it normally, and choose a trusted
checkout. It bundles its runtime and uses private pipes; normal desktop work
needs no installed Node, browser access link or listening server. CLI 0.91.0 provides the desktop commands below.
The GUI remains optional:

```bash
runlist desktop install                 # download and install the Mac GUI
runlist desktop                         # open the installed GUI
runlist desktop install --from /path/to/Runlist.dmg  # install a local signed DMG
```

The installer currently supports Apple Silicon Macs. It verifies the published
download checksum, Runlist developer signature and Apple approval, and installs
without opening the app. An existing app is kept unless `--from` supplies a
replacement; replacement keeps a rollback copy. `--dry-run` uses no network and
changes no files. The [Mac GUI download](https://github.com/reowens/runlist/releases/download/desktop-v0.91.0-rc.3/Runlist-0.91.0-rc.3-macOS-arm64.dmg) is now public in Runlist's GitHub
releases; `--from` also works with a local approved installer. These commands ship
in [CLI 0.91.0](https://github.com/reowens/runlist/releases/tag/v0.91.0) and can also
be used from this checkout as `node bin/runlist.mjs desktop …`. The GUI remains
separately versioned at **0.91.0-rc.3**; npm installation does not download it.

The optional browser document app is available from this source checkout (unreleased):

```bash
node bin/runlist.mjs app docs/plans/my-plan.md --port 5173
```

Open the local access link printed in the terminal. The app homes existing
hubs, plans and documents in the selected checkout, edits the document inline, exposes source, reviews a
diff before saving, keeps private recovery drafts, reports intervening edits,
and undoes a save through a new revision-checked operation. Related legacy
flags retain their original observation beside their current location; missing
observed revisions are explicit. Browser sessions identify as the local human
and respect agent claims. Save writes the Markdown file; Git commit and sharing
remain separate. Stop the server with Ctrl+C. The published 0.91.0 CLI does not include the browser-app command;
use this source-checkout invocation.

Click headings, paragraphs, list items, quotes, or code to edit them in place.
Enter creates the next block; an empty list item exits the list. Type `/` in an
empty paragraph or use the `+` beside a block to choose a heading, list, task,
quote, code block, or divider. Task checkboxes are interactive. Select text for
bold, italic, code, strikethrough, and links; Command/Ctrl+B and +I also work.
Command/Ctrl+Z undoes draft edits, while **Undo save** reverses a published save.
Private drafts save automatically; **Review changes → Save changes** publishes
them to Markdown. Managed lifecycle history stays read only. Tables and complex
blocks offer a local Markdown editor; **Edit Markdown** opens the full body as a
fallback. Untouched blocks, comments, and line endings retain their source.

The sidebar provides **All documents**, **Hubs**, **Plans**, **Docs**, **Flags**, **Decisions**, **Changes**, pins, recents,
and templates. Selecting a category opens its searchable results in the main
area, with type, status, location, sort and archive controls. Opened documents
have a **← Library** action; returning to the library retains unsaved drafts.
On narrow screens, **Navigation** opens the sidebar. Search spans the
whole configured library; only 50 result rows are returned/rendered per page.
Header metadata is cached and unchanged files are reused on refresh; Refresh
explicitly picks up external additions, removals, moves and metadata edits.
Discovery reads headers in 4 KiB chunks, up to 128 KiB when needed, and detaches
cached metadata from source buffers. Record refreshes process one document at a
time, retain decision fragments and flag connection paths, and load linked record
bodies when opened. To measure a read-only workload on your checkout, run
`node scripts/measure-app-memory.mjs /path/to/checkout`; adding `--expose-gc`
before the script also measures retained heap after collection.
Pinned/recent documents remain browser-local and reachable outside the current
results. Hub members, parent hubs and related documents remain navigable through
Connections and preview links, including documents on another page. Membership
uses the CLI's hub/order definition and parent back-pointers, rather than treating
every citation as a child. Configured non-plan narratives use the same reviewed
source save; untyped or unsupported formats open read only. Private prompts,
excluded corpora and generated indexes stay outside the library.


**Changes** reviews saved Markdown against the local Git HEAD, with 100-row
pages, search, archive inclusion and whole-file selection. Open it from the
sidebar, quick navigation or **Saved Git changes** in a document review.
Plans, hubs and other documents use the same configured-root and private-path
policy. Additions, modifications, deletions and renames include both safe rename
paths; partially staged files and ignored local-only files explain why selection
is blocked. Unrelated staging is counted without exposing unrelated source.
Refresh retains selection and the diff; navigation preserves unsaved drafts, and
**Return to draft** resumes the current editor without saving it. Git inspection
runs on demand with bounded asynchronous output and no optional index locks.
**Review local commit** opens a separate message and exact Git-content review.
Open each selected file before **Commit locally** becomes available. The review
uses the actual Git tree, including ordinary EOL normalization, and authorizes
both paths of a rename. The commit guard checks the actual commit’s tree, parent,
message, destination branch, saved files, effective Git configuration/attributes
and owned final-index generation before ref publication. Unrelated staging stays
staged. Selected partial staging and ignored/private files are never replaced or
force-added. Runlist initiates no fetch, push or credential operation.

The writable gate supports Apple Silicon macOS with Git 2.54.0 or 2.55.0 and Linux ARM64 with
Git 2.47.3. Linux was qualified through terminal fixtures on the dev Pi:
Debian 13.5, glibc 2.41 and the pinned Node 24.21.0 helper runtime; the initial
baseline passed 19 commit/recovery and 20 native-helper checks with external networking
disabled. Linux x64, other Linux Git versions and Windows remain unqualified.
See Linux commit evidence.
Both gates require an existing named branch, SHA-1 objects and a plain v2/v3
index (at most 2 MiB; only the ordinary TREE extension).
One-shot clean filters with a regular executable and literal arguments are supported,
including a standalone `%f` filename argument and quoted paths. Process filters,
shell expressions/builtins/globbing, working-tree encoding, sparse/split/fsmonitor/extended
indexes, unsupported signing profiles and other platforms/versions still require Git.
These settings are refused before execution, never bypassed. Opening Changes or
its saved-file diff disables executable filters: filtered candidates may be
unchanged in Git. **Review exact Git content** explicitly applies the configured
clean filter in two private indexes and displays the resulting canonical blobs.
Different outputs, partial staging, changed config/attributes/executable/literal
file arguments or a final tree/index mismatch block the commit. Saved Markdown
remains unchanged; unrelated staging is preserved. Git retains required/optional
filter-failure behavior. Executables and referenced file arguments have a 16 MiB
inspection bound; the existing 1 MiB combined review bound still applies.
Filters are trusted checkout code with their own side effects and indirect
dependencies; Runlist does not sandbox or undo those effects. A filtered private
Git step that exceeds its time/output limits stops its owned process group and
retains failure evidence. The read-only view remains independent of the write gate.

Configured commit hooks run at their original paths with Git's arguments, stdin,
working directory and index/editor context, including relative or absolute
`core.hooksPath`. Preview and private index preparation never execute them.
The review lists the enabled hooks, signing format and clean-filter names. Changed hook generations,
hook rejection or unreviewed tree/message/index changes block publication.
Post-commit failures retain the known commit; they never trigger another commit.
Hooks are trusted checkout code and can perform their own side effects; Runlist
preserves those effects and retained evidence rather than claiming to sandbox or
undo them. Each hook has a 10-second bound within the existing job limits.

Required signing supports local Ed25519 OpenSSH private-key files through
`ssh-keygen`, and OpenPGP through GnuPG with an explicit full signing fingerprint
and a ready agent. SSH agents/hardware, X.509, custom signer commands and
conflicting OpenPGP program aliases remain unqualified. SSH askpass is disabled;
GnuPG uses batch/no-tty, error-only pinentry and no agent autostart or automatic
key retrieval. Encrypted SSH keys and unavailable GPG agents fail without an
unsigned fallback. The guard verifies the actual signature against the selected
key before ref publication, alongside the reviewed content and staging checks.
Private keys/passphrases are never stored in receipts. See
hook and signing evidence.

Commit jobs return promptly and survive renderer/helper disconnect. **Recovery**
finds private human/checkout-bound disk receipts even without browser storage.
**Inspect outcome** checks retained evidence; **Recover owned staging** restores
only a proven owned generation after its process group has stopped. Foreign or
unverified locks/indexes are preserved. An uncertain publication is never retried;
an explicit note can acknowledge fresh inspected ref/index evidence without
replaying or undoing a commit. Closing a review preserves its receipt and message
draft. Bounds include a 1 MiB combined review, 8 KiB message, 30-minute review
expiry, bounded Git command/job deadlines and 500 retained operations. Private
receipt storage must be ignored, untracked and free of symlinks.

This source work has not replaced the installed desktop app. Native visual/focus
checks, broader Git compatibility and platform qualification remain separate;
Apple status checks remain stopped.

**Flags** is the triage queue, with search, severity/status filters, source and
hub filters, and 50-row pages. Open a flag for its original observation, current
evidence and append-only history. Accept, reject or resolve with a reason, review,
then confirm. Accept keeps the flag open; reject closes it; resolve records that
it was addressed.

**Decisions** brings existing plan sections and registers into one queue. Linked
register/plan records collapse using the CLI parser's scope rules. Each record
shows its source, connected work, blocking items, question and recorded outcomes.
Review a hold, ruling, closure or reopening before saving. A ruling requires a
selected answer and a reason; the app records the authenticated human and date.
Earlier outcomes and original text remain in the source. Reviewed requests are
retained in browser storage so a reload or lost acknowledgement can retry the
same operation without duplicating it. External edits and claims are checked
again on save. Native v1 records also support reviewed actions. Flag accept,
reject, manual resolution and reopening retain original evidence and history.
Native decision rulings select an existing option ID; changed rulings explicitly
supersede their predecessor, and reopening or holding a ruled decision records
a withdrawal. Human authority is required to record or withdraw rulings.
Duplicate native IDs and invalid records remain read only in the queue.

**New flag** and **New decision** are available in their queues, the New dialog
and quick actions in current source. A flag asks for a finding, severity and
context; it starts open and unreviewed. A decision asks for a question and two to
twelve described alternatives, with optional benefits, costs, risks and follow-up.
It starts open, without a ruling. Review the canonical fields and exact Markdown,
then explicitly confirm creation. The authenticated local human owns the creation
event. Retained operation IDs, exclusive writes and Recovery protect against
duplicate retries, conflicting files and interrupted publication.

The first record also reviews `runlist.records.json`, containing schema 1, a
stable `repositoryId`, a root under the configured document roots and
`shared: false`. The default root is `<catch-all document root>/records`; each
record lives in its `flags/` or `decisions/` folder. A single existing native
repository identity is reused; multiple identities require explicit selection.
Alternatively, set `export const records = { schema: 1, repositoryId:
'repo:<UUID-v4>', root: 'docs/records', shared: false }` in `runlist.config.mjs`.
If both settings sources exist, they must agree. `shared: true` requires a working
Git checkout and a trackable destination; ignored files produce an error without
changing ignore rules or force-adding anything. To share the identity across
clones, include its configuration in your own Git commit; the GUI's managed-doc
selection does not include the root-level JSON file. Existing records and custom
configuration source are preserved. This feature is source-only and has not
replaced the installed desktop app. See the
creation work item.

The companion CLI uses the same native action preparation and editing core:

```bash
node bin/runlist.mjs record docs/flags/finding.md resolve --note "Manually verified the fix"
node bin/runlist.mjs record docs/decisions/choice.md ruled --option option:<uuid> --note "Fits the work"
```

Add `--dry-run` to inspect the prepared source, `--expected-revision sha256:<hash>`
to check an earlier read, or `--json` for a durable receipt. Legacy migration,
automated resolution proofs and agent recommendation editing
remain separate work.

**Change status** opens a lifecycle review for configured documents and plans.
The application uses the CLI engine for status validation, filing/archive moves,
reference repairs, history and index updates. The review checks source, claims,
configuration and destination again before publishing. Save or discard drafts
first. Claimed sources and native plan lifecycle operations are unavailable;
native flags and decisions use their domain actions instead. Moves retain
browser pins and heading bookmarks. Lost acknowledgements can be inspected and
retried through the retained operation ID. An interrupted runner stays uncertain
until inspected; acknowledging its outcome records that uncertainty without
replaying the operation. Retained CLI transactions must be repaired first.

**Semantic · gmax** is an optional search mode in ⌘/Ctrl+K and the library.
Type a natural-language query, then press **Search**; semantic queries do not run
on each keystroke. Results use relevance order over plans, hubs and other configured
Markdown roots. Section links are offered only when the indexed byte hash matches
the current file; changed sources open at the document. Library results are bounded
**top matches**, with no claim of full-corpus totals or pagination.

Runlist does not depend on, bundle or install grepmax, copy its index, start its
services, refresh its index, download/load models, or fall back to cloud search.
It requires an external gmax provider supporting `mcp --existing-index-only` and
a compatible already-running daemon with a warm embedding worker. The last
authorized check on October 7 at 21:36 UTC saw installed gmax 0.26.65 and a ready daemon,
but the installed document bridge and required daemon capability were absent.
Runlist's guarded probe returned `tool_unavailable`; the source bridge had
previously returned `unsupported_daemon` against 0.26.59. A ready ping alone
does not establish working semantic retrieval or watcher health.
Authorized steps 1–4 of the
compatibility plan
restore and qualify the bridge in gmax 0.26.66 source and an extracted npm
candidate. The first slice uses warm-only dense retrieval, with no hybrid/FTS,
ColBERT inference or reranking. Package/private-helper fixtures pass on Node
22.23.1 and 26.8.1; checkout dependencies were reused, not freshly installed.
This candidate is not deployed. Installation, matching-daemon negotiation and
live relevance/runtime-memory checks remain separate.
The release audit's source items 1–6 are now fixed: oversized-worker retirement
without replacement, native-read lifetime, required generations, idle MLX
readiness, bounded coverage/freshness metadata and the ARM64 Git write gate.
Rebuilt provider/private-helper fixtures pass on Node 22 and bundled Node 24.
Fresh isolated consumers now pass on Node 22.12.0 and 24.21.0 against the distinct
local gmax `0.26.68-runlist.1` candidate, with lifecycle scripts disabled and no
checkout dependency links. An unsigned Runlist `0.91.0-rc.1` Mac ARM64 candidate
contains that historical source snapshot. Separate optional provider qualification
is documented in [provider qualification](desktop/PROVIDER-QUALIFICATION.md); it
requires an exact accessible artifact URL/hash when explicitly invoked. Normal
CLI publication and desktop builds do not require that provider job. These results
do not establish deployment, live retrieval, watcher recovery or native-window
acceptance.
Ordinary text/content search works without gmax. Primary local stores are supported
by this first contract; external/secondary stores remain unavailable in Semantic mode.

**Settings → Semantic search** detects an external installation or lets you save
absolute paths to its Node executable and `grepmax/dist/bin.js`. These tool settings
stay in the user's Runlist configuration directory, outside the checkout; a changed
saved installation must be selected again. No queries/snippets are saved by Runlist,
and this gmax mode suppresses query logging without changing global gmax settings.
See the integration plan for
qualification limits. Older frozen packages omitted these additions; the delivered
0.91.0-rc.3 GUI includes the experimental semantic controls. An external provider
and live-search qualification remain separate.

Terminal checks on the real platform checkout covered 2,757 library documents.
The source engine harness and transient bridge sampled at 97.5 MiB and 81.7 MiB
peak RSS respectively; requests safely reported the absent daemon in 0.7–0.9 seconds.
These measure the unavailable path, not successful semantic queries or whole-app
memory. See [qualification evidence](desktop/VALIDATION.md#optional-gmax-real-checkout-probes--2026-10-07).
The absent-daemon and memory-pressure findings above are historical. The owner
now reports a gmax watcher problem requiring a reboot; its cause and post-reboot
recovery are unverified. Live qualification remains parked for watcher recovery
and the external contract gap. Preserve the host-safety hold; neither service
startup nor model headroom has been qualified. See the
watcher/search status.
Ordinary text/content search remains available; gmax is optional. Installing
current Runlist alone does not provide the missing external gmax contract.

**Settings** in the sidebar saves browser defaults for appearance, document order,
archive visibility and the records view. It links to the editable templates and
shows loaded document roots, exclusions, status rules and where changes live.
Repository configuration remains editable in its source or through the CLI;
this panel displays its effective rules.

**Appearance** in the header offers Light, Dark, and System. The browser remembers
your choice across reloads and shares it with other tabs at the same local app
address. System follows your OS appearance, including live changes. The theme
covers the library, inline editor, source, diffs, section tools, and templates.

**Sections** provides a searchable heading outline, heading bookmarks, and section
insertion. Command/Ctrl+Shift+J focuses section search; Alt+Page Up/Down moves
between headings. Stars save bookmarks for this checkout and file in the current
browser. Inline heading renames update their bookmarks; removed or unmatched
headings stay visible as unavailable bookmarks.

**Templates** in the sidebar opens the doc, plan, and prompt scaffolds with
Markdown editing, an example preview, and a diff before saving. Template drafts
stay in browser storage. Saves use revision checks and write the repository's
`runlist.templates.json`; ordinary `runlist new` commands consume these overrides.
Existing documents are unaffected. Keep `{{title}}`, `{{body}}`, and the managed
`{{status}}`/`{{date}}` metadata placeholders; `{{version}}` is also available.
Authored complete bodies and explicit plan variants retain their existing CLI
behavior. JavaScript templates from `runlist.config.mjs` can be inspected without
executing them. Built-in types can receive a Markdown override; custom JavaScript
types remain editable in that config file. The template file can be committed
with Git; bookmarks and draft recovery remain local.

The renderer covers headings, paragraphs, lists/tasks, tables, quotes, fenced
code, and safe links. Authored HTML is displayed as text; unsupported syntax
remains available in Source. The optional `test/browser-app-smoke.mjs` exercises
real browser save/CLI readback, undo, reload recovery, conflict review, lost
acknowledgements, and narrow-screen layouts with Playwright supplied externally.

## Core Workflow

```bash
runlist plans
runlist use docs/plans/auth-refresh.md
runlist set awaiting docs/plans/auth-refresh.md --note "Need API owner decision"
runlist set active docs/plans/auth-refresh.md --note "Decision received"
runlist archive docs/plans/auth-refresh.md --note "Shipped and verified"
```

Use `runlist set <status> [<file>]` for lifecycle changes rather than editing a
`status:` line. It validates the status for the document type, updates history,
runs lifecycle hooks, repairs references after moves, and synchronizes the
index.

For unfinished session work, save the handoff and release the owned plan in one
operation:

```bash
runlist baton @/tmp/resume.md
```

Baton refuses when a handoff for the same work is already pending, so one piece
of work never has two resume prompts. Inspect the pending handoff with
`runlist prompts show <slug>`. Keep it if current; if stale, pass `--replace`
with a new draft. Baton archives the previous text and refreshes the pending
prompt in the same operation as any plan release.

Repositories with a commit wrapper can export `batonCommitCommand(message, paths)`
from `runlist.config.mjs` and return an argv array such as
`['just', 'commit', message, ...paths]`. Baton quotes the printed command and
excludes session prompts from `paths`.

Saved prompts are local session state. Consume them with `runlist use`; inspect
without consuming via `runlist prompts show`. Consuming a baton prompt also claims
its plan; `runlist use --no-claim` reads and archives it without starting the plan.

New plans are created `planned`; `runlist use` starts one, and
`runlist new plan <name> --status <status>` sets a different starting status.

## Document Format

```markdown
---
type: plan
status: active
updated: 2026-07-13
modules:
  - auth
surfaces:
  - backend
current_state: Token validation is complete.
next_step: Wire refresh rotation into middleware.
related_docs:
  - ./auth-design.md
---

# Auth Refresh

- [x] Validate tokens
- [ ] Rotate refresh tokens
```

`status` is the only universally required field. A `type` enables type-specific
statuses, validation, templates, and briefing behavior. Explicit frontmatter
wins, but runlist can also derive titles, summaries, state, next steps, checklist
progress, and Markdown links from the body.

Use plural `modules:` and `surfaces:` arrays. The old singular keys remain
readable for compatibility and can be migrated with `runlist lint --fix`.

### Built-In Types

| Type | Purpose | Default statuses |
|---|---|---|
| `plan` | Executable work | `in-session`, `active`, `planned`, `blocked`, `partial`, `paused`, `awaiting`, `queued-after`, `archived` |
| `doc` | Specs, ADRs, audits, and reference material | `draft`, `active`, `review`, `reference`, `deprecated`, `archived` |
| `prompt` | Saved future-session instructions | `pending`, `archived` |

Status definitions can be customized per type. Rich status objects co-locate
display, staleness, validation, terminal, and archive behavior in one place.

## Runlists And Roadmaps

A sprint runlist is an ordered `runlist:` array on a hub plan. Scaffold a hub
and children together:

```bash
runlist new plan auth-revamp --runlist extract,rewrite,cleanup
runlist runlist auth-revamp
runlist runlist next auth-revamp
```

Mutate the structure through the CLI so the array, child `parent_plan` refs, and
body order list remain synchronized:

```bash
runlist runlist add auth-revamp docs/plans/existing-plan.md
runlist runlist add auth-revamp follow-up
runlist runlist reorder auth-revamp follow-up --before cleanup
runlist runlist remove auth-revamp extract --clear-parent
```

Archived children count as complete. Parked children (`blocked`, `partial`,
`paused`, `awaiting`, and `queued-after`) are skipped when choosing the next
pickup but do not count as done.

For a larger prose-first domain map, create a coordination runlist:

```bash
runlist new plan platform-work --coordination
runlist runlists
```

`runlist new hub platform-work` makes the same coordination hub; add
`--runlist a,b,c` or `--roadmap` for the other two shapes.

For progress across several runlists, create a roadmap:

```bash
runlist new plan platform-roadmap --roadmap
runlist roadmap platform-roadmap
runlist roadmap platform-roadmap next
```

Roadmaps roll up progress recursively and choose the first startable plan across
their child runlists. Runlists and roadmaps are held out of actionable plan
counts so dashboards do not double-count their children.

## Decisions

A decision is an entry in its plan, not a document of its own. Write the record
(the situation, what exists today, what each answer leaves in place) to a file
and add it:

```bash
runlist new decision auth-revamp --question "Which token store?" @record.md
```

It takes the next id (`D1`, `D2`, …) that no decision item in that plan uses,
lands at the end of the plan's top-level decisions section (created before
`## Version History` when there is none) with a `Disposition: OPEN.` line, and
refuses an empty record. `--disposition held` parks it instead.

A corpus that indexes its decisions in one register numbers them in one
sequence. Name the register, and the id follows the highest the register or the
plan uses, and the register gets the entry's row in the same locked write:

```js
export const decisions = {
  section: 'Decisions',
  prefix: 'D',
  register: { file: 'docs/plans/register.md', statusLine: 'waiting on you:' },
};
```

The register block is the fenced block whose first line carries `statusLine`.
The row is the question plus `--answers` (what each answer leaves in place),
which is required when a register is configured.

`runlist decisions --json` gives each open or held decision its `question`,
its document's `docTitle`, and `blocks`: what its record says it blocks or
gates, then every unticked checklist item and frontmatter blocker that names
its id, alone or inside a written range (`A2 to A12`). In another document the
id has to sit beside a link to the decision's document.

Record an outcome in an existing legacy decision with the same source operation
used by the app:

```sh
runlist decision docs/plans/work.md D1 --disposition held --note "Need evidence"
runlist decision docs/plans/work.md D1 --disposition ruled --choice "Blue bin" --note "Fits the shelf"
```

`--dry-run` prints prepared source. `--expected-revision sha256:<hash>` checks a
previous read; `--json` returns the operation receipt. Human rulings require a
human CLI context. Agent sessions may record open, held or closed outcomes.
The source editor retains receipts and checks claims and exact source revisions.

## Flags

A flag is something someone found that the person should know about when they
come back: a plan that contradicts another, a decision open in one place and
ruled in another, a citation that no longer says what it claims. Any session,
person or check can add one, and no model is needed:

```bash
runlist flag add docs/plans/auth.md:42 "says tokens expire in 1h; the spec says 24h" --severity problem
runlist flags                 # open flags, problems first, newest first
runlist flag accept F3 --note "real, owner agrees"
runlist flag reject F4        # not a problem; closed
runlist flag resolve F3       # fixed
runlist check --flag          # the check's errors become flags, attributed to it
```

Each flag keeps the text of the line it points at, so the list says when that
line has moved or changed since. A repeat of an open flag on the same place is
merged. The log is append-only, `.runlist/flags.jsonl` by default
(`export const flags = { file }` moves it), and triage is recorded as events
beside the flag, never over it. Every session start shows a count and the top
open flags.

## Local model

Summaries (`--summarize`, `runlist summary`, `runlist diff --summarize`) and
lint's status inference use one local model server, Ollama by default or any
OpenAI-compatible server. runlist never starts it or pulls a model on its own:

```bash
runlist model                 # server, model, cap, free memory, what is loaded
runlist model start           # ollama serve, one model and one request at a time
runlist model measure         # record each pulled candidate's peak memory and speed here
runlist model use qwen3.5:9b  # name a model; `auto` picks the first measured one under the cap
runlist model cap 8           # most memory a model may take; `auto` is a quarter of the machine
runlist model stop            # unload it now
```

The model unloads after 5 idle minutes. Before it loads, the memory free right
now must hold it plus 1.5 GB with memory pressure normal, or the command goes
on without it. On an 8 GB machine the cap is 2 GB and model features stay off;
point `RUNLIST_MODEL_ENDPOINT` at a server on a bigger machine instead. Settings
are per machine in `~/.runlist/model.json`.

`runlist model status --json` leads with a one-line reading for dashboards,
`running`, `name` (the model loaded now, else the one runlist would load) and
`memoryMb` (what it holds, null when nothing is loaded), followed by the full
detail.

## One document's card

```bash
runlist show docs/plans/shelf.md          # title, status, next step, blockers, checklist, related, links
runlist show shelf bins --json            # [{ path, title, status, nextStep, blockers, checklist,
                                          #    related: [{ field, path, title, status }], links: [...] }]
```

Read-only: nothing is claimed. `related` is what the frontmatter names
(`related_plans`, `related_docs`, `supports_plans`, `parent_plan`, `runlist` and
the configured reference fields), each with its title and status; `links` is
every other document the body links to.

## Failed commands

Every runlist command that fails, by an error or a non-zero exit, appends one
line to `~/.claude/logs/runlist-errors.log` (`RUNLIST_ERROR_LOG_DIR` moves it)
with the time, the command with secrets redacted, and the error's one-line
message. It rotates at 5 MB, a new runlist version, or 30 days of active
history, retaining up to eight numbered backups for 30 days. Readers include
the retained backups. Dry runs and the session-start `hud` are never logged.

```bash
runlist errors                # the newest 20 failures, newest first
runlist errors --limit 50     # the newest N
runlist errors --json         # [{ at, command, message, repo, exit }]
runlist errors --by-family --json  # validation, unknown-command, conflicts, exceptions
```

Validation findings remain non-zero results and remain in the raw chronological
view. Grouping distinguishes those findings from command errors and unexpected
exceptions. Failed `xref --check` entries include the first finding's file,
line, and message.

The repository invocation journal remains opt-in through
`export const journal = true;` in config or `RUNLIST_JOURNAL=1`. It uses the same retention policy.
Top-level and per-command help calls record their topic and outcome without
authored arguments. Use `runlist journal --help-topics --json` to see topic,
session, version, and retained invocation counts. These denominators cover the
retained opt-in window; passive context, HUD, dry runs, disabled journaling,
and pruned history are excluded. They are not machine-wide usage rates.

## Safety Model

- Mutation commands support `--dry-run` / `-n`.
- Managed writes are confined to configured document roots.
- Lifecycle and multi-file moves use atomic, conflict-aware mutation paths.
- Session ownership is durable local state, not inferred from telemetry.
- Passive orientation commands do not mutate repository state.
- Repository paths in machine and human output use stable slash-normalized
  identities across supported operating systems.

## Command Reference

The CLI is the source of truth for command syntax and options:

```bash
runlist --help
runlist help all
runlist help statuses
runlist <command> --help
```

Shell completion is generated from the same command registry:

```bash
eval "$(runlist completions bash)"
eval "$(runlist completions zsh)"
```

This README intentionally documents onboarding and concepts instead of
duplicating the complete command catalog.

## Configuration

Run `runlist init` to create `runlist.config.mjs` (a legacy `dotmd.config.mjs` is still read). A minimal typed configuration:

```js
export const root = 'docs';
export const archiveDir = 'archived';

export const types = {
  plan: {
    statuses: {
      'in-session': { context: 'expanded', staleDays: 1 },
      active: { context: 'expanded', staleDays: 14 },
      planned: { context: 'listed', staleDays: 30 },
      archived: {
        context: 'counted',
        archive: true,
        terminal: true,
        skipStale: true,
        skipWarnings: true,
      },
    },
  },
};
```

### Code references

Archive and rename repair every reference inside the doc roots. `codeRoots`
extends that to source files that cite a document by its repo-relative path in
a comment, a docstring or a string literal:

```js
export const codeRoots = ['packages', 'scripts', 'services'];
export const codeRefsUntouched = ['scripts/guards/plan-baseline.json'];
```

`runlist refs <old> <new>` reports every citation by file and line and writes
only on `--fix`; `runlist refs repair` does the same for every archived
document still cited at its previous path. Archive and rename print the count
afterwards and take `--fix-refs`. Only the full repo-relative path matches,
never a bare basename, and only that segment is replaced, so a trailing `§` or
`#` anchor survives. A citation inside a string literal waits for `--strings`,
a file in `codeRefsUntouched` is never written, and with no `codeRoots` set
nothing is scanned.

Configuration supports multiple roots, custom types and templates, taxonomy,
reference fields, presets, rendering, lifecycle hooks, validation hooks, and
AI summarization hooks. See [`runlist.config.example.mjs`](runlist.config.example.mjs)
for the complete annotated reference.

## Hooks

Functions exported from `runlist.config.mjs` are detected as hooks. They can add
validation, customize rendering and summaries, or react to lifecycle events.
Hooks receive the resolved config and command context; mutation hooks participate
in the command's dry-run and failure contracts.

## License

MIT
