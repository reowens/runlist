# Runlist desktop

Optional semantic-search qualification uses an explicitly selected external-provider artifact; normal CLI publication and desktop builds do not require gmax. See [provider qualification](PROVIDER-QUALIFICATION.md) for inputs, isolated commands and evidence limits. gmax remains optional for users.

Runlist opens local Markdown checkouts in a normal macOS application. The app
bundles the existing document library, inline editor and Runlist engine. Its
system WebView communicates with a native controller, which owns a bundled Node
helper through private stdin/stdout pipes. There is no listening HTTP server,
runtime download, online account, telemetry, automatic updater or login daemon.

Desktop distribution is separate from the npm CLI. The checkout engine is
Runlist 0.94.0 and desktop protocol 1. The delivered desktop release is separately
versioned at 0.92.0-rc.1 and retains its 0.92.0 engine. Optional filing reports
are available from CLI 0.93.0, with hub-category inheritance corrected in 0.93.1.
Updating the CLI does not replace the delivered app's bundled engine. Stage
filters/groups and guarded Stage editing are delivered in the GUI; displaying
filing reports in the GUI remains separate work.
The optional product yardstick is a CLI 0.94.0 feature; GUI goal/assessment
controls are separate follow-up work and do not trigger a desktop rebuild.

## Current release and next steps

**Runlist 0.92.0-rc.1 is now installed locally and publicly available.** The personally signed app and
Mac installer
were both accepted by Apple, stapled and accepted by Gatekeeper. The previous app
is retained for rollback. Delivery record
contains receipts and paths. Additional testing stopped at the owner's direction;
controlled/native/broader-host evidence is incomplete follow-up, not claimed passed.
No app/window control or gmax/live work occurred. This latest instruction resumed
this specific Mac delivery; earlier stopped-release paragraphs are historical.

### Historical unsigned build and earlier packages

The retained unsigned snapshot, before signing and delivery, is Runlist 0.91.0-rc.3.
First-release steps 1–4 are complete for its selected 433-file snapshot: targeted
library refresh, preserved concurrent invalidations, reduced redundant editor
reads and clearer unsupported/experimental states. It passed 2,302 source tests
(one filesystem-case skip), 85 desktop checks, 57 packaged required-provider
checks, 56 network-denied packaged checks and 11 headless native controller checks.
Candidate evidence and source selection
record the exact bytes and 62 excluded concurrent changes. Its short allocation
profile is diagnostic; controlled performance and native acceptance remain open.
That retained snapshot is unsigned; the separately signed delivery described above
is now installed and publicly available. The earlier rc.2 full
performance failures remain historical evidence for that earlier payload.

An earlier unsigned Apple Silicon development package
includes the reviewed local-commit flow, configured hooks, noninteractive signing
and canonical one-shot clean-filter review. It passed **44 packaged engine checks**
with networking denied. Evidence records
source hashes, architecture/deployment targets, archive CRC/SHA-256 and aggregate
Mac/Linux ARM64 terminal checks. This local package is not installed, notarized
or signed for distribution. Windows/Linux x64 work and grepmax integration were
skipped for this task.

The older Apple-submitted GUI candidate is personally signed and passed
36 packaged engine checks and 11 native helper checks with networking denied.
Its existing app request is `cd008f6f-f635-4cd5-b3fe-3165ef45093f`; the last
recorded status was **In Progress** at **2026-10-07 00:03 UTC** (October 6,
17:03 PDT). **Apple checks and release continuation are stopped until the owner
explicitly resumes them.** This is recorded evidence, not a live status.

The candidate is `desktop/releases/gui-workspace-20261006T234748Z/`. It remains
version 0.90.0, has no DMG submission yet, and has not replaced the older installed
app. Earlier accepted artifacts describe different source snapshots. See the
[validation record](VALIDATION.md#latest-gui-mac-candidate--2026-10-06).

Guarded local commits, qualified hooks/signing and one-shot clean-filter review
are implemented and retained in the latest development package. Broader filter,
signer and platform qualification remains open; push is deferred. The remaining
GUI source now includes optional existing-index grepmax semantic search in quick
navigation and the library. Real large-checkout inventory, absent-daemon handling,
adapter memory and bridge cleanup have terminal evidence; successful real-index
retrieval remains parked. The last authorized check saw gmax 0.26.65 ready but
lacking Runlist's document-search bridge and daemon capability. The owner now
reports a gmax watcher issue requiring a reboot; root cause and post-reboot
recovery are unverified. Preserve its host-safety hold. See the
watcher/search status and resume gates.
Compatibility source and package steps 1–4 pass against gmax 0.26.66, including
the actual private helper. Provider deployment, live qualification and watcher
recovery remain open.
The later release audit's source items 1–6 are now fixed and requalified:
worker RSS retirement, native-read draining, required generation fields, idle
MLX readiness, bounded partial coverage/freshness and ARM64-only Git writes.
The rebuilt external provider passes the current helper fixture on Node 22 and
bundled Node 24. These fixes are not installed. Frozen fresh-consumer results are historical;
the latest selected app passes the retained required-provider fixture. Provider
deployment, live qualification and hosted CI remain open.
The compatibility plan
separates contract/daemon/bridge and package fixtures from explicit deployment
and live qualification. Source work does not require starting a watcher.
Current source also includes reviewed New flag/New decision forms, canonical
Markdown review, persisted repository identity and exclusive recoverable creation.
These additions are retained in the delivered rc.3 source snapshot. See the
[creation evidence](VALIDATION.md#gui-native-record-creation--2026-10-07).
At that snapshot, native plan lifecycle, migration, settings/diagnostics and
stage/filing were follow-up work. Stage support has since been delivered as
described below; GUI filing reports remain unselected. Broader host qualification
remains open. Optional local-model chat remains deferred. The retained rc.3 app includes experimental semantic controls; older packages
predate the integration. These controls do not establish working live retrieval.
The local release and work runbook
records their scope and the gated release sequence for an explicit future resume.
That runbook and release artifacts are local repository files, excluded from Git.

## Plan stages

Library → Plans now supports repository-defined Stage filtering/grouping and
saved views. The plan Stage selector keeps its selection in the existing draft,
review, save and recovery flow. `ships:` metadata and `taxonomy.milestones` are
shared with CLI stage filters/checks; unset is separate from explicit Later and
never derived from status. Semantic results preserve relevance order. These
additions are included in the delivered 0.92.0-rc.1 app.

## Install and open

The new app is installed at `~/Applications/Runlist.app`. Open **Runlist** normally.
For another Apple Silicon Mac, use the [public Mac installer](https://github.com/reowens/runlist/releases/tag/desktop-v0.92.0-rc.1).

The versioned `Runlist-0.90.0-macOS-arm64.dmg` in `desktop/releases/` is an
**earlier accepted snapshot**. The usual DMG installation steps are:
Open the image, drag **Runlist** to **Applications**, and open **Runlist** normally.
Choose **Open Folder**, select a checkout, and review its configuration trust
prompt. **About Runlist** shows the version; the window shows the checkout path
and **Local files · This computer only**.

The latest delivered artifact is for Apple Silicon. Its runtime requires macOS 13.5 or
newer; verification has been performed on macOS 26.7. Earlier OS versions, Intel,
Windows and Linux have not been validated for this desktop release. A fresh-Mac
installation check remains part of release qualification.

Windows/Linux port implementation is now present in source: OS/architecture runtime
pins, guarded file locking, native clipboard/link adapters, platform menus and
helper environments, installer configuration, and a desktop CI workflow. Windows
native execution remains pending. Linux ARM64 has now passed native release
builds and terminal checks on the development Pi (Debian 13), including extracted
Debian/AppImage engines with networking disabled, plus actual Debian install,
QA revision upgrade, rollback, removal, reinstall and purge. Native-window and
fresh-host installation qualification remain open. The [gap check](VALIDATION.md#windows-and-linux-gap-check--2026-10-06)
records source fixes and remaining host checks. The published Node CLI's
cross-platform CI remains separate from desktop qualification.

The GUI needs no system Node installation. The optional CLI 0.92.0 shortcut is:

```sh
runlist desktop
runlist desktop --app /absolute/path/Runlist.app
runlist desktop install
runlist desktop install --from /absolute/path/Runlist.dmg
```

`desktop install` is an explicit optional GUI install, separate from opening it.
It currently supports Mac Apple Silicon, downloads an official Runlist GitHub
release DMG and checks its published SHA-256 plus the Runlist developer signature
and Apple approval before installing. `--from` uses a local signed DMG, without
a download. Existing installations are kept as-is unless `--from` explicitly
supplies a replacement; replacements require the app to be closed and retain a
rollback copy. Installation keeps Mac quarantine and never opens the app.
`--dry-run` uses no network, processes or file writes. The command does not load
checkout configuration or add a CLI runtime dependency. The [Mac GUI download](https://github.com/reowens/runlist/releases/download/desktop-v0.92.0-rc.1/Runlist-0.92.0-rc.1-macOS-arm64.dmg) is now public
in GitHub Releases and can be discovered by the published installer in
[CLI 0.92.0](https://github.com/reowens/runlist/releases/tag/v0.92.0). The GUI remains
separately versioned at 0.92.0-rc.1. Source-checkout invocations remain available
as `node bin/runlist.mjs desktop …`. Installing the npm CLI does not download
the GUI automatically.

The optional browser workflow remains `runlist app`; that explicitly starts a
loopback server. The desktop shortcut uses macOS LaunchServices or starts the Windows/Linux executable directly. Normal CLI
commands and the existing `$EDITOR` workflow remain available independently.

## Files, trust and recovery

Plans, hubs, documents, flags and decisions stay in their existing checkout
files. Saves require review and retain the shared engine's exact revisions,
claims, history, receipts and compensating undo. Save does not commit or push Git.
Repository template overrides stay in `runlist.templates.json`.

**Hubs** in the Library are the organizing documents older docs and filenames
call **runlists**. They collect plans and supporting docs; ordering their plans
does not require another container. A roadmap is an optional hub collecting
other hubs and rolling up their progress. Hubs currently use plan metadata,
but the Library separates them from executable plans. Stage and status are
labels on plans, not document levels. See the
[shared document model](../README.md#hubs-ordered-plans-and-roadmaps).

The current source adds **New…** for plans, docs and coordination hubs. Choose a
template, title, configured folder, filename and initial status, then preview the
rendered Markdown and validation messages before creating it. Creation is
exclusive: an existing file is never overwritten. Reviewed content and the
original operation ID are retained privately for inspection after interruption.
Saved Markdown template overrides are shared with `runlist new`. JavaScript
template functions are inspectable in Templates but are not executed for New
previews; New uses the built-in Markdown scaffold until an override is saved.

**⌘/Ctrl+K** opens documents, matching headings and actions. Search reads local
contents on demand without retaining a body index. The library's **Search
contents** option combines content matching with category, status, type, folder,
archive and sort filters. **Save view…** remembers that selection on this
computer. A query scans at most 128 MiB; files over 8 MiB or unavailable files
are skipped, with a partial/unavailable notice. Narrow the folder or filters for
large checkouts. Text/content search continues to work without gmax.

Current source adds **Semantic · gmax (experimental)** to quick navigation and the library, with
explicit **Search** and **Cancel**. It reuses an external compatible
`gmax mcp --existing-index-only` provider and a ready daemon/warm embedding worker.
It does not start services, watches, indexing or models, add a server, bundle gmax,
or store queries. Settings can discover the installation or save an external
Node/entry-file pair. Missing/older providers leave text search available; the
last checked installed 0.26.65 still lacks the required bridge/daemon contract.
Fresh isolated consumers of the distinct local gmax `0.26.68-runlist.1` candidate
pass on Node 22.12.0/24.21.0 with lifecycle scripts disabled and no checkout
dependency links. Required CI inputs and local commands are in
[provider qualification](PROVIDER-QUALIFICATION.md). This candidate is not deployed; its dense-only warm path avoids
hybrid/FTS, ColBERT inference and reranking.
Owner-reported watcher recovery is also pending; a ready daemon ping does not
verify it. Primary-store
retrieval is supported; external/secondary stores and local chat are deferred.
Results are top matches in relevance order; verified hashes gate section jumps.
Real-index relevance, large-checkout performance and native/platform qualification
remain open. This addition is retained in the unsigned local Runlist `0.91.0-rc.3` candidate,
and absent from the existing installed app and earlier packages.

**Recovery** brings together retained drafts, conflicts, interrupted saves,
creation reviews and status/record reviews for this checkout. Disk drafts remain
discoverable when renderer storage is lost or unreadable. Opening Recovery does
not publish or retry an operation. Resume to compare a stale draft or inspect the
original operation before an explicit retry. Missing files and corrupt entries
are reported and kept for manual inspection; the GUI does not recreate deleted
files automatically. Reviewed local path-limited Git commits are implemented on
the qualified platform/version combinations; Git Changes explains unavailable
commit support while keeping diff review usable. Push remains deferred. Save
writes the local document without committing or pushing.

The latest selected-source candidate is unsigned and separate from the older
personally signed Apple-submitted snapshot. The installed app still contains the
older snapshot. Apple/signing/distribution work remains stopped; see
[the validation record](VALIDATION.md#first-release-steps-14--2026-10-08).

JavaScript configuration and hooks are executable code. Trust grants that code
the permissions of your user, including possible file and network access.
The trust probe reads configuration without importing it. JavaScript syntax
parsing fingerprints literal imports, reexports, `require` calls and package
metadata within the checkout. Changed inspected dependencies require a new
trust decision. Dynamic or aliased loading and conditional package resolution
require confirmation on every opening. This inspection cannot establish every
file or service that arbitrary trusted code may access.

The native controller owns canonical checkout paths and opaque handles.
Renderer requests cannot choose an executable or supply actor identity. The
bundled window has explicitly scoped commands; remote pages have no native
capabilities. Markdown is sanitized, remote navigation is blocked, and an
explicitly clicked web or email link opens outside the privileged WebView.
These are application boundaries; the helper is not an OS sandbox.

Quit and window close preserve recoverable drafts before draining accepted
operations and retiring helpers. Pending reviews must be closed first. After a
crash, recover the retained draft or inspect an uncertain operation before an
explicit retry. Runlist never automatically replays an uncertain mutation.
Second launches use an OS file lock rather than a socket.

Local storage:

- `~/Library/Application Support/dev.reowens.runlist/`: recent checkout paths,
  remembered trust fingerprints and the instance lock.
- `~/Library/WebKit/dev.reowens.runlist/`: WebView preferences, pins, heading
  bookmarks, saved library views and additional editor recovery storage.
- Checkout `.runlist/editor/`: private drafts, before-images, source-operation
  creation and lifecycle receipts. Legacy checkouts can use `.dotmd/editor/`.
- Shared Markdown, templates and configured indexes remain in their established
  checkout locations. Private editor state must be ignored and untracked in Git.

Git is discovered through the helper's controlled OS-specific PATH. Windows
includes system and Git installation directories plus absolute user PATH entries;
Mac/Linux use selected system tool directories. Agent authority, Node loaders,
Git overrides and inherited credentials are excluded from the helper environment. Before writing private drafts, before-images or lifecycle receipts,
Runlist checks physical parent directories for `.git` directories and worktree
files, then uses Git to verify ignored and untracked storage. Missing or failed
Git in a checkout blocks these writes with `unsafe-local-state`; document reads
remain available. Genuine non-Git folders work without Git. Runlist does not
change ignore rules, the Git index or an installed Git executable automatically.

Desktop pins/preferences are separate from Safari's browser-local preferences.
No automatic preference migration is included. Keep recovery storage until
outstanding edits and uncertain operations are resolved.

## Updates, rollback and removal

Quit Runlist, keep the previous application if you want a rollback, and replace
the application with the newly verified app from its DMG. There is no automatic
update connection. An older application cannot undo Markdown changes or make
unknown future protocol/schema versions compatible; resolve outstanding
operations and review version compatibility before rolling back.

Move `Runlist.app` to Trash to uninstall. This leaves checkouts and recovery
storage intact. App preferences can be removed separately after recovery work is
resolved. Removing the desktop app does not uninstall the npm CLI.

## Build, sign and notarize

Build on an Apple Silicon Mac with Xcode command-line tools, Rust **1.95+**, Cargo and Node:

```sh
npm --prefix desktop ci
npm --prefix desktop run build
npm --prefix desktop test
RUNLIST_NOTARY_PROFILE=your-existing-personal-profile node desktop/scripts/sign.mjs
```

The build downloads the official runtime once into a build cache and verifies
its pinned SHA-256 from `runtime-lock.json`. `package-lock.json` and `Cargo.lock`
pin dependencies. Runlist source/assets and schema resources ship together;
private repository documents are not copied. Node's full notices, Acorn's MIT
license and Cargo dependency notices are included inside the application.
Acorn is isolated to the desktop project; the npm CLI still has zero runtime
dependencies.

The source now uses [Rust's portable nonblocking file lock](https://doc.rust-lang.org/std/fs/struct.File.html#method.try_lock)
and guarded Unix/Windows state-file opening. The instance lock stays file-based,
with no socket or PID-file expiry. Windows state files inherit the per-user app
directory's ACL; permissions, reparse-point behavior and full desktop startup
still require Windows-host qualification. The macOS-only reopen event is guarded.

The file/lock, helper-launching and navigation modules and their tests can be
compile-checked for Windows/Linux without
linking or launching a desktop app:

```sh
rustup target add --toolchain stable x86_64-pc-windows-gnu x86_64-unknown-linux-gnu
npm --prefix desktop run check:native:portable
cargo test --offline --lib --manifest-path desktop/src-tauri/Cargo.toml
```

The portable check uses the selected Rustup toolchain's exact compiler; override
`RUNLIST_PORTABILITY_TOOLCHAIN` to select another installed toolchain. It checks
those production modules, not the complete Tauri desktop or installers.

Signing requires explicit `RUNLIST_SIGN_IDENTITY` and `RUNLIST_SIGN_TEAM`
environment variables. Official downloads are verified against the pinned
release team by the CLI installer. The helper receives Node's required JIT entitlements; the
app does not disable library validation. Credentials stay in the existing
notarytool profile and are never copied into the repository or release bundle.
The signing script requires Apple's explicit **Accepted** result, staples and
validates both app and DMG, verifies Gatekeeper, and writes submission IDs and
the final DMG checksum to `release-manifest.json`.

## Windows/Linux builds in development

Build on the target host with Rust 1.95+, Cargo, Node, and Tauri's
[platform prerequisites](https://v2.tauri.app/start/prerequisites/).

```sh
npm ci --prefix desktop
npm --prefix desktop run build -- --ci
npm --prefix desktop run test:bundle
cargo test --locked --manifest-path desktop/src-tauri/Cargo.toml --lib
```

Windows defaults to a current-user NSIS installer with an offline WebView2
installer bundled at build time. Linux defaults to Debian and AppImage packages.
The build selects a checksum-pinned Node runtime for the host or an explicit
`--target` Rust triple; it never substitutes a Darwin runtime for another OS.
No Node installation or runtime download is needed by the installed app.

Use `runlist desktop --app /path/to/Runlist.AppImage` for an AppImage or custom
installation. Windows installation discovery checks the normal per-user and
Program Files Runlist locations. CLI launch previews do not execute configuration.

`.github/workflows/desktop.yml` defines Mac, Windows and Ubuntu builds, native
headless tests and packaged helper/frontend checks. It does not sign, publish,
launch an app or control a desktop. This workflow has not been run remotely for
these local changes. Linux ARM64 terminal evidence is recorded below; Linux x64,
Windows, Intel Mac and other Linux baselines still need separate host qualification.

On Linux, `npm --prefix desktop run test:linux-packages` extracts both installers,
checks ELF architecture and dependency resolution, compares every engine file with
the prepared payload, and runs the packaged helper/frontend tests. It never starts
Runlist or WebKit. Set `RUNLIST_NATIVE_TEST_BIN` to the compiled Rust library-test
executable to run native controller checks against each extracted engine as well.
Networking was disabled on the Pi with an isolated `unshare -Urn` namespace.

The AppImage build restores the checksum-pinned Node resource after linuxdeploy
rewrites ELF library paths, then rebuilds the image with the cached official
[AppImage output plugin](https://github.com/linuxdeploy/linuxdeploy-plugin-appimage#standalone-usage).
The final helper's bytes match the prepared runtime exactly. Linux artifacts are
unsigned development candidates, not supported release downloads.

For simultaneous Mac submissions, give each frozen build its own app and artifact
paths using `RUNLIST_SIGN_APP` and `RUNLIST_RELEASE_DIR`. Keep each submitted app
unchanged until its pipeline finishes stapling and packaging.

## Validation and memory

The latest desktop source checks pass **34** tests on both Mac and Linux, the prepared Mac helper/frontend
passes **25**, and macOS native checks pass **10** with networking denied and
without constructing an app or window. Production file/lock, helper-launching and navigation code also type-checks
for Windows and Linux. Linux Debian 13 ARM64 also passes **2,194 source checks** (one existing skip),
**34 desktop checks**, **26 packaged checks and ten native checks per installer**
with networking disabled. Actual Debian installation, QA revision upgrade, rollback,
removal, reinstall and purge also pass. Each of the four installed states passed
26 packaged checks and ten native checks offline; saved source, recoverable drafts,
receipts and user data survived. The Pi was restored to its initial uninstalled
state. This upgrade used the same engine in a QA package revision; a real version
upgrade and native-window checks remain open. See
[VALIDATION.md](VALIDATION.md#linux-arm64-terminal-qualification--2026-10-06).

The isolated containment/native-fix Mac build passed 29 desktop, 25 packaged checks
with networking denied, and seven native checks before personal signing. Apple
received it as `b2a840a4-01c3-46e4-8ab7-b479059c2211`; it is pending alongside the
earlier Git-guard request. Its source snapshot and release artifacts live in
`desktop/releases/containment-native-20261006/`. Windows/Linux adapter work made
after that snapshot is **not** in this submitted build. The installed app remains
the preceding accepted release.

The preceding installed build passed twenty-four JavaScript checks with networking
denied, covering trust,
authority, exact CRLF saves, conflicts, retries, undo, reviewed records/templates,
lifecycle workers, draft recovery, Quit gates and accessibility semantics.
The lifecycle worker uses the exact bundled executable with system-only PATH.

Document tabs support arrow/Home/End navigation with one active Tab stop and
named panels. Editor blocks expose multiline textbox and read-only states;
document regions and dialogs have accessible names. Three DOM regressions check
these behaviors. Native screen-reader results and the previously observed native
accessibility-tree omission remain unverified.

Run the terminal-only suite with `node desktop/scripts/check-installed.mjs`;
it uses the installed bundle's runtime and resources and creates no browser,
WebView or app window. `node desktop/scripts/inspect-bundle.mjs` verifies identity,
architecture, minimum-OS targets, runtime dependencies and signatures. Two native
controller tests also pass against the final packaged helper with networking
denied; reproduce using `cargo test --offline --lib headless_tests` in
`desktop/src-tauri`, with `RUNLIST_TEST_ENGINE` set to the installed
`Contents/Resources/engine` directory.

The earlier read-only 1,683-document platform workload peaked at 164.8 MiB helper RSS across
six refresh cycles, with a 3.5-second warm flag-refresh median (previous build:
6.4 seconds on this contended host). A heavier 5,001-file fixture with 4,500
unrelated decisions, 500 flags and a 2.4 MB document peaked at 192.9 MiB helper RSS.
Document/decision-link indexes and combined literal flag-path matching remove
unrelated corpus comparisons while preserving record semantics and output order.
These are engine measurements; full scans still take seconds.

Current release-audit item 13 adds terminal refresh/edit/switch and worker
measurements plus bounded editor undo storage. The 5,001-document edit workload
exposed helper RSS and latency failures beyond the older read-only evidence;
whole-window memory remains open. The frozen `0.91.0-rc.1` app predates these
memory fixes. See [memory qualification](MEMORY-QUALIFICATION.md) for budgets,
reproduction commands, results and remaining release gates.

Historical evidence on this Apple Silicon Mac used a 1,678-document library. The app,
checkout helper, WebContent, GPU and Networking process set measured 179.2 MiB
macOS footprint after opening the library and 134.2 MiB after settling idle;
each process sampled at 0.0% CPU. Summing individual lifetime footprint peaks
gave a 356.3 MiB upper bound, not a simultaneous whole-app peak. RSS and macOS
footprint measure different things and should not be compared interchangeably.

`scripts/measure-helper.mjs` performs six read-only refresh cycles plus a document
load using the packaged runtime, sampling RSS every 250 ms without forced GC:

```sh
node desktop/scripts/measure-helper.mjs /path/to/checkout
# Optionally measure the exact signed bundle instead of prepared resources:
RUNLIST_MEASURE_ENGINE=/path/Runlist.app/Contents/Resources/engine \
  node desktop/scripts/measure-helper.mjs /path/to/checkout docs/plans/large.md
# Optional CPU profiles; keep them local because they contain source paths:
RUNLIST_PROFILE_DIR=/tmp/runlist-cpu-profile \
  node desktop/scripts/measure-helper.mjs /path/to/checkout
```

See [validation evidence](VALIDATION.md) for the measured workload, limitations
and remaining release qualification. These measurements describe this host;
they are not a universal RAM guarantee.

The October 8 helper overlay passed its 256 MiB terminal RSS target at 227.88 MiB;
the actual 0.91.0-rc.2 package subsequently failed four component targets. Current
measurement uses an independent async observer, host telemetry and separate
repeat-open/after-save/draft timing. A quiet baseline was refused on this saturated
host; a full diagnostic remains unqualified, including a failed process scan.
Existing numerical targets are unchanged. See the
[measurement protocol](MEMORY-QUALIFICATION.md#measurement-method-and-host-admission--2026-10-08)
for the fixed multi-run baseline and evidence limits. The candidate is not installed;
owner-run native footprint and editing/quit checks remain deferred.
