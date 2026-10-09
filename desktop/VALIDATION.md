# Desktop validation

**Delivered GUI is 0.94.0-rc.1**, published and installed on 2026-10-09. Source commit
05af6b7 was frozen into a 455-file snapshot. The current app/DMG are personally
signed, Apple accepted/stapled and Gatekeeper accepted; the secure installer
preserved quarantine and saved the previous 0.92.0-rc.1 app for rollback.

Six focused packaged and six installed checks passed with networking denied,
covering the yardstick/Filing controls, recovery, private helper, source-row
navigation and review/quit guards. Resource/snapshot hashes matched; static
architecture, deployment, bundle identity and version checks passed.
Evidence is retained at `desktop/releases/yardstick-filing-20261009/`.
Global CLI remains 0.94.0; [public GUI 0.94.0-rc.1](https://github.com/reowens/runlist/releases/tag/desktop-v0.94.0-rc.1)
is available, with source/docs pushed and exact GitHub installer digest verified.
The CLI download resolver selects this new installer. No app/WebView/window
control, live gmax/model, npm release or new native visual acceptance claim occurred. Local delivery is complete; Apple requests are accepted
and must not be repeatedly polled. The README and delivery records now distinguish
this release from earlier snapshots and deferred work. Broader/native tests below
remain historical; they add no requirement to the completed delivery.

## Earlier installed snapshot — 2026-10-06

The updated Apple Silicon app and DMG are signed with **Developer ID Application:
Robert Owens (7GSPYYN5X8)**, accepted by Apple, stapled, and accepted by Gatekeeper.
The app is installed at `~/Applications/Runlist.app`. The replacement used file
operations only, retained quarantine, and preserved the previous app for rollback.
No application or browser was launched, raised, controlled or stopped during this
follow-up. No public release or npm publication was performed.

## Artifact evidence

- Runlist/engine: **0.90.0**; desktop protocol: **1**.
- Architecture: **arm64**; bundled official Node: **24.21.0**.
- Declared minimum macOS: **13.5**, matching both Mach-O deployment targets.
- App: **127.46 MiB**; compressed DMG: **45.42 MiB**.
- App submission: `79715dfb-3e9f-4be4-8726-50dd82475574` — **Accepted**.
- DMG submission: `f56e30dd-550f-49d3-8087-54cc1bd9a073` — **Accepted**.
- DMG SHA-256: `b217a05cd10a76204ca2eb0a62ce10c63e9f5f952e3178f9d2a23f376f95eac8`.
- Deep/strict signature verification, app/DMG stapled-ticket validation and
  Gatekeeper assessment passed. The installed replacement also passed Gatekeeper.
  No warning bypass or certificate trust change was used.
- The configured notarization profile was used without Keychain Access UI.

`desktop/releases/release-manifest.json` records this build. Aggregate workload
logs, installed tests and compatibility inspection are retained locally under
`desktop/releases/qualification-2026-10-06/`. The previous release manifest/DMG
are under `desktop/releases/prior-performance-release/`; the previous installed
app is retained under `desktop/releases/replaced-performance-Runlist.app`.
Release evidence and private planning documents are excluded from Git.

Runtime, npm and Cargo locks pin build inputs. Dependency notices ship in the app.
The changed source/frontend files were checked against packaged copies before
signing. Linkedom is a desktop test dependency and does not ship in the helper.

## Functional and security checks

- Final source suite after the private-state fix: **2,189 passed, one existing skip**.
- Updated bundle: **25 JavaScript tests passed** with networking denied, using
  the rebuilt bundled executable, helper and frontend resources. Worker PATH
  contains only system directories; a fixture confirms the worker's executable
  is the exact bundled `RunlistHelper`.
- **Two native Rust shutdown tests passed** against the final packaged helper
  with networking denied, without constructing a Tauri application or window.
  Closing refuses new requests; EOF drains an accepted save, reaps the child,
  rejects later calls and leaves its receipt readable after helper restart.
- Trust probes cover literal dependencies, escapes/comments, changed imports,
  dynamic loading and symlink escapes. Authority checks cover inactive handles,
  isolated agent environment, forged actors, traversal, private prompt exclusion,
  incompatible versions and oversized frames. Checkout stdout is separated from
  protocol responses.
- Reviewed native decisions/flags, templates, Settings, lifecycle workers, exact
  CRLF saves, stale revisions, preserved metadata/history, undo and retry receipts
  pass through the packaged engine.
- Six headless frontend tests execute the real recovery, draft persistence and
  desktop transport handlers with DOM/presentation doubles and an installed-helper
  bridge. They cover new-renderer CRLF/Unicode recovery, uncertain operation IDs
  without replay, external edit conflicts, busy/review Quit gates, local fallback
  when disk recovery fails and blocked Quit when both recovery stores fail.
- Three additional DOM tests execute the shipped tab controller and block editor.
  Panels/dialogs have resolvable names and relationships, tabs have one active Tab
  stop with arrow/Home/End navigation, and blocks expose named multiline textboxes,
  heading levels and read-only state. Locked history and source bytes are preserved.
- Decision regressions retain ranges, link proximity, ID boundaries, duplicate
  links, register pairing and output order. A 4,500-record shared-ID fixture keeps
  unrelated decisions separate. Flag path tests retain same-offset prefixes and
  different-offset overlaps, including punctuation in literal filenames.

The earlier native-window journeys covered editing, reviewed saves/undo,
templates, records, trust/switching and crash recovery. The owner subsequently
prohibited computer use. A brief prior check found main-editor/dialog content
missing from the native accessibility tree. This follow-up fixes definite source
semantics and verifies them in a DOM; it does **not** establish that the native
accessibility-tree omission or screen-reader behavior is resolved. The prior
unpublished test draft remains on disk; this follow-up does not publish it.

Tauri capabilities are scoped to bundled resources and explicit domain commands;
remote navigation is rejected and CSP restricts native IPC. The instance lock is
`flock`, without a socket. Earlier attributed app/helper/WebKit processes had no
TCP/UDP sockets. Normal engine operations pass with networking denied. Final-build
whole-window offline and renderer-termination journeys remain unverified. Trusted
checkout code and explicitly opened external links can use the network; the
helper is not an OS sandbox.

## Memory and latency

Host: **Apple M4 Pro, 48 GiB RAM, macOS 26.7**. No measurement forced GC.
The packaged helper ran six read-only library/flag/decision refresh cycles,
followed by document loads, with RSS sampled every 250 ms. Its production V8
limits remain a 256 MiB old generation and 4 MiB semispaces.

CPU profiles identified corpus-wide open-work comparisons and repeated flag-path
searches. Open work, decision peer links and collapsed rows now use indexes;
flag source paths share a literal matcher that preserves overlapping matches.
Final full scans still take seconds and are reported as engine timings.

The platform run returned **1,683 documents**: 37 hubs, 649 plans and 997 other
documents, with 192 flags and 84 open/held decisions. The live corpus changed from
1,011 to 1,012 total decisions between baseline and updated runs. The heavier
synthetic corpus has **5,001 files**, including 500 archived plans, **4,500
unrelated D1 decisions**, 500 flags and a **2,400,076-byte** Unicode document.
Its default visible library returns 4,501 documents.

| Packaged helper workload | Platform, previous build | Platform, updated build | Heavier synthetic, updated |
| --- | ---: | ---: | ---: |
| Sampled peak RSS | 170.2 MiB | 164.8 MiB | 192.9 MiB |
| RSS after cycle 6 | 167.8 MiB | 155.2 MiB | 177.5 MiB |
| Heap used after cycle 6 | 37.5 MiB | 24.4 MiB | 41.0 MiB |
| Warm library median | 305 ms | 131 ms | 78 ms |
| Warm flag refresh median | 6,370 ms | 3,529 ms | 1,327 ms |
| Warm flag refresh range | 4,519–13,009 ms | 2,578–5,990 ms | 1,195–2,033 ms |
| Warm decision query median | 19 ms | 15 ms | 17 ms |
| Document load | 106 ms / 102,556 bytes | 68 ms / 102,556 bytes | 253 ms / 2,400,076 bytes |

Warm medians use cycles 2–6. The host was heavily contended and the platform was
live, so the paired timings are directional evidence, not a controlled percentage
speedup. An earlier profile pair, before the shared-ID optimization, measured
7,112 → 5,278 ms warm flag medians. A contended intermediate synthetic run exceeded
the 75-second request deadline; the final indexed build completed all six cycles.
An isolated shared-ID analysis/row assembly completed 4,500 records in 115 ms.

Both final workloads stayed below the existing **256 MiB platform-helper budget**.
Retained heap oscillated across cycles rather than growing continuously. This
establishes bounds for these runs, not an unlimited-corpus memory guarantee.
The new decision-heavy fixture uses more RSS than the older lighter fixture
(99.9 MiB peak and a provisional 160 MiB target); it is a different workload and
is not counted as passing that earlier 160 MiB target.

Historical whole-app evidence: the attributed app, helper, WebContent, GPU and
Networking set measured **179.2 MiB macOS footprint** after opening the earlier
1,678-document library, **134.2 MiB** settled idle and 0.0% sampled idle CPU. Their
individual lifetime footprint peaks summed to a **356.3 MiB upper bound**, not a
simultaneous whole-app peak. These figures are from the earlier native build and
are not replaced by the updated helper's RSS. Final-build large-document WebView
rendering, simultaneous whole-app peaks and a matched complete Safari/backend
comparison remain unmeasured. The current window and checkout were left alone.

## Accessibility and host compatibility

`inspect-bundle.mjs` verifies app/engine identity and protocol, architecture,
deployment targets, system-library dependencies, bundled runtime version and
deep/strict signatures without opening the app.

| Qualification | Evidence | Status |
| --- | --- | --- |
| macOS 26.7, Apple Silicon | Installed 24 JS + 2 native checks; signed/stapled app/DMG; system PATH and network denial | Verified terminal behavior |
| No installed Node/Homebrew needed for helper/workers | Exact bundled executable and system-only PATH used | Verified execution path; fresh host still needed |
| macOS 13.5 minimum | App and helper Mach-O targets both 13.5; 14 app and 4 helper dependencies are system libraries | Static compatibility only; OS not exercised |
| Fresh supported Mac | No fresh host available in this session | Unverified |
| Native accessibility / VoiceOver | Source semantics and three DOM checks pass; prior native-tree omission recorded | Native result unverified |
| Intel macOS | No signed Intel build or Intel-host results | Not qualified |
| Windows/Linux | Confirmed compile/runtime/platform gaps; no installers or native-host results | Unsupported; implementation needed |

The current artifact is Apple Silicon only. Deployment metadata does not establish
runtime behavior on an older OS. DOM tests do not establish WebView rendering,
macOS accessibility-tree exposure or screen-reader usability.

## Private editor state guard fix — 2026-10-06

The fixed Mac app is rebuilt, signed and tested; Apple notarization is pending.
The artifact evidence above still identifies the previous installed release until
acceptance and file-only replacement complete.

Git discovery failure can no longer bypass private editor storage checks in a
checkout. Narrative drafts/saves/undo/settlement and lifecycle receipt storage
use the same guard. It inspects physical ancestors for `.git` markers (directories
and worktree files), does not suppress filesystem inspection errors, and checks
explicit Git context. Missing/broken Git or a false/unexpected discovery response
in that context returns `unsafe-local-state` before storing private state or
changing source. Reads and existing recovery inspection remain available.

Git is resolved through the process PATH; the desktop helper supplies macOS system
directories. Runlist does not install Git or change ignore/index state. With Git
available, private storage must still pass both ignored and untracked checks on
every storage operation. An ordinary non-Git folder remains editable without Git.

Six source regressions exercise missing Git with ignored and unignored storage,
installed Git with broken configuration, an ancestor checkout, a real linked
worktree with a `.git` file, broken worktree markers/explicit Git context, and
successful non-Git writes without Git. The real-worktree fixture also verifies
that a later Git failure preserves existing receipts and source. Rejected fixtures
assert both unchanged Markdown and absence of new editor storage. Lifecycle
commit attempts use the same fixtures and fail before receipt creation.

The packaged-helper fixture reads the document with Git removed from PATH, then
rejects private draft, save and lifecycle commit requests without creating editor
state. Tests use private pipes with networking denied, never an application window.
The earlier failing audit probe remains retained for comparison; final fix logs,
source hashes and artifact verification are recorded separately under
`desktop/releases/qualification-2026-10-06/git-guard-fix/`.

## Windows containment and native compile-blocker fixes — 2026-10-06

The owner requested the next two fixes while the Git-guard Mac package is in
Apple's queue. These changes are **source-only follow-up work**: the submitted
app/ZIP and installed app were not rebuilt or changed. The current notarization
submission contains the earlier Git-guard fix, not the changes in this section.

`src/path-containment.mjs` supplies the same component-aware guard to configuration
trust and lifecycle root selection. It rejects Windows parent/sibling-prefix,
other-drive and other-UNC-share paths, with semantic coverage for extended Windows
namespaces and POSIX filenames containing literal backslashes. Relative/ambiguous
paths do not grant authority. Lifecycle selects the deepest containing root and
normalizes its status-map key to the slash format produced by configuration;
configured type status rules still take precedence.

Trust discovery checks both the original import lookup paths and canonical files.
Symlink/junction ancestors are rejected, including internal aliases that Node's
resolver could otherwise canonicalize/cache and later fail to notice retargeting.
Actual filesystem fixtures reject escaping imports and linked parents while
retaining exact-source fingerprint changes for valid nested imports. Mac symlink
fixtures and Win32 path semantics are verified here; Windows-native junction,
per-directory case and Node/Rust canonical namespace identity still need a host.

`native_files.rs` replaces unconditional Unix traits/flags/raw `flock` in startup
and preference storage. [Rust's `File::try_lock`](https://doc.rust-lang.org/std/fs/struct.File.html#method.try_lock)
provides the nonblocking exclusive file lock, requiring Rust 1.89+ (declared in
Cargo.toml). Only `WouldBlock` means an existing instance; other errors propagate.
The file handle owns the lock until close; no socket, lock-file deletion or
PID/time-based lease is introduced. Unix opening preserves mode 0600, no-follow
and close-on-exec flags. Windows opening uses
[`FILE_FLAG_OPEN_REPARSE_POINT`](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-createfilew),
rejects reparse points by handle metadata and omits delete sharing. Windows files
inherit the per-user app directory ACL; native ACL/antivirus/filesystem behavior
remains unqualified. Preference storage validates a regular file before truncating,
flushes it and closes its temporary handle before replacement. The `Reopen` event
match arm is compiled only on macOS.

Verification: **2,194 source tests passed, one existing skip**; **34 focused editing,
lifecycle and path tests passed**; **29 desktop JavaScript tests passed**. The full
macOS desktop library compiled, and **seven native tests passed with networking
denied** without creating a Tauri app/window. They cover a real second-process
lock, release on close, persistent lock-file retention, no initial truncation,
open errors, private Unix creation, symlink rejection, preference replacement and
helper shutdown. Sandbox fixtures use a counter as well as time to remain unique
when clock precision is restricted.

`npm --prefix desktop run check:native:portable` compiled the production file/lock
module **and its test code** for `x86_64-pc-windows-gnu` and
`x86_64-unknown-linux-gnu` with Rust **1.95.0**. This is cross-target type checking,
not execution or linking of the full desktop. The script pins the compiler path
to its selected Rustup toolchain so a Homebrew compiler cannot silently use the
wrong sysroot. Both target standard libraries were added by terminal; no VM,
container, application or browser was started. No complete Windows/Linux desktop
build, installer or native-host result is claimed. Logs/hashes are retained under
`desktop/releases/qualification-2026-10-06/containment-native-fixes/`.

## Isolated follow-up submission and Windows/Linux implementation — 2026-10-06

A frozen copy of the tested containment/native-file changes was built separately
from the app already waiting on Apple. Before signing it passed **29 desktop**,
**25 packaged tests with networking denied**, and **seven native** tests.
Personal Developer ID signing and strict verification passed. Apple received the
app ZIP at **2026-10-06T21:57:40.681Z**, request
**`b2a840a4-01c3-46e4-8ab7-b479059c2211`**. Source hashes, build/test/sign logs and
artifacts are retained under `desktop/releases/containment-native-20261006/`.

The original Git-guard app request **`fb9ed2b0-8698-46e2-aef3-9c1c771b8528`** has
now been **Accepted** and its app stapled/validated with Gatekeeper acceptance.
Its DMG submission is **`0c86f31e-ef28-4a54-9ef1-67d7efd7d671`**, still processing
at this update. The isolated follow-up request is also still processing. Neither
flow installs or launches an app. The installed app remains the preceding release.

After freezing that app, working source gained Windows/Linux runtime preparation,
OS-specific helper environment and console suppression, production asset/link
policies, native clipboard/opener adapters, CLI launch discovery, portable worker
identity and directory syncing, platform menus, installer configs and desktop CI.
These newer adapter changes are **not** in either submitted app.

Verification: **2,194 source tests pass with one existing skip**; final worker-identity
changes also have focused lifecycle/path and desktop coverage. Desktop source
checks pass **33**; prepared Mac helper/frontend checks pass **25**; Mac native
checks pass **10**; prepared/native Mac checks also pass with networking denied.
`cargo check --offline --locked` passes. Actual production
file/lock, helper-launching and navigation modules/tests type-check for Windows
GNU x64 and Linux GNU x64 with Rust **1.95.0**. This does not link or execute the
full desktop on those targets. Windows x64 PE and Linux x64 ELF runtime headers,
architecture and pinned official archive hashes were inspected without execution.

The [Node checksum file](https://nodejs.org/dist/v24.21.0/SHASUMS256.txt) supplies
the new runtime pins. Official Tauri [clipboard](https://v2.tauri.app/plugin/clipboard/)
and [opener](https://v2.tauri.app/plugin/opener/) adapters are used only through
Runlist's scoped commands. Windows uses the documented
[offline WebView2 installer mode](https://v2.tauri.app/distribute/windows-installer/#offline-installer).
The current dependencies require Rust **1.95+**.

Evidence is retained under `desktop/releases/qualification-2026-10-06/platform-port/`.
An initial native check overlapped Windows resource preparation and correctly
reported a missing Mac helper; final checks use a sealed Mac resource copy and
pass. No application, WebView, browser, clipboard or opener was exercised through
computer use. The desktop CI definition is local and has not run remotely.
Full Windows/Linux builds, installed offline behavior, ACL/junction/namespace
checks, native clipboard/menu/focus and signed release qualification remain open.

## Linux ARM64 terminal qualification — 2026-10-06

The owner selected the development Pi for Linux and postponed Windows until the
Parallels VM is ready for terminal access. SSH confirmed Debian 13.5 ARM64,
Linux 6.18.34, glibc 2.41 and Git 2.47.3. Rust 1.95.0 was installed only inside
`~/runlist-qualification-20261006/toolchain`; the existing Node installation was
preserved. GTK/WebKit build prerequisites were installed through apt. Source-only
snapshots excluded private docs, prompts, credentials and Mac release artifacts.

The full native release build produced `Runlist_0.90.0_arm64.deb` and
`Runlist_0.90.0_aarch64.AppImage`. Debian's `dpkg --dry-run --install` passed;
dependencies are `libwebkit2gtk-4.1-0` and `libgtk-3-0`. Installers were extracted
into temporary directories during the initial build qualification. Actual Debian
package installation was subsequently qualified below; no app was launched.
Both ELF architectures and dynamic-library resolution were verified. Every
extracted engine file, including the bundled Node executable, matches preparation.

Linux checks: **2,194 source passes / one existing skip**, **34 desktop passes**,
and **ten native library passes**. Each extracted installer engine passed
**26 JavaScript/helper/frontend checks and ten native controller checks** inside
an isolated network namespace (`unshare -Urn`, loopback down, no routes).
Coverage includes real Git discovery and ignored/untracked save history,
read-only failure without Git, draft recovery after SIGKILL, receipt replay,
stale-save rejection, lifecycle worker/runtime identity, private file creation,
symlink rejection, instance-lock contention/release, preferences replacement and
accepted-write draining/reaping. `/proc` checks reject owned TCP/UDP sockets and
Unix listeners; Node's unnamed connected Unix stdio streams are allowed.
No WebView, clipboard, opener or native menu was invoked.

The AppImage check caught linuxdeploy rewriting the Node resource's ELF RPATH.
`scripts/appimage-runtime.mjs` restores the original verified runtime after
library deployment and uses the cached official
[standalone AppImage output plugin](https://github.com/linuxdeploy/linuxdeploy-plugin-appimage#standalone-usage)
to rebuild the image. The build wrapper applies this automatically to newly
built AppImages. A deliberately patched helper exercises the repair path;
strict installer inventory checks reject any altered engine resource.

Initial harness failures are retained: source tests overlapped runtime
preparation (ENOENT/ETXTBSY), and a partial snapshot omitted plugin/changelog test
inputs. The corrected complete snapshot uses a separate immutable test runtime
and passes the full suite. A first socket assertion incorrectly counted private
Unix stdio streams; the final check distinguishes listeners/network sockets.
The original AppImage mismatch remains recorded alongside the passing repair.
Evidence, host/toolchain metadata, source hashes, logs and artifacts are retained
under `desktop/releases/qualification-2026-10-06/native-hosts/`.

### Actual Debian install lifecycle

The owner subsequently authorized terminal-only system installation on the same Pi.
The original package SHA-256 was checked before installation; the host had no
existing Runlist package or conflicting package-owned paths. Its control archive
contains no maintainer scripts. Actual `dpkg` mutations ran with networking
unavailable (`sudo -n unshare --net dpkg ...`).

| Step | Result |
| --- | --- |
| Install 0.90.0 | Package integrity, executable and desktop metadata verified |
| Upgrade to 0.90.0+qualification.1 | Replaced desktop metadata and installed a QA marker |
| Roll back to 0.90.0 | Original metadata restored and QA marker removed |
| Remove | All package files removed; user data and checkout retained |
| Reinstall 0.90.0 | Draft and committed save receipt reopened successfully |
| Purge | Package files removed; original user-data baseline restored |

The upgraded package is **QA-only**, with the same native application and engine.
It exercises package replacement, added-file removal and downgrade mechanics;
it does not qualify migration between different application versions and must
not be distributed as a product release.

Each of the four installed states passed **26 packaged JavaScript checks and ten
native controller checks** using `/usr/lib/Runlist/engine`. Helper tests ran in
UID-preserving offline namespaces (`unshare --user --map-current-user --net`).
A real CRLF Markdown save, committed before-image/receipt and unpublished recovery
draft remained exact across all six stages. Unique sentinels in Runlist's user
config/data/cache directories retained their contents, modes and ownership.
Existing user data was never overwritten. Only test sentinels were removed during
cleanup; the Pi returned to its initial state with Runlist uninstalled. The
synthetic checkout remains in the qualification directory for audit.

Reports, full command output and the one-run harness are retained under
`desktop/releases/qualification-2026-10-06/native-hosts/install-lifecycle/`.
The QA package remains on the Pi in the corresponding directory. No Runlist
window, WebView, clipboard, opener or native menu was invoked.

This qualifies terminal builds, extracted installer backends and Debian package
lifecycle on this Debian 13 ARM64 host with build prerequisites already installed.
Linux x64/older distributions, fresh-host dependency installation, a real version
upgrade, AppImage desktop integration, native UI/accessibility/clipboard/focus,
whole-app memory and public release signing remain open. Windows remains pending; both
`prlctl start` and `exec` were denied by the installed Parallels edition, and the
owner directed Linux work first. No GUI access or GitHub source upload occurred.

## Windows and Linux gap check — 2026-10-06

**Windows/Linux are not yet qualified for supported desktop releases.** The
following initial gap audit predates the source fixes and Linux ARM64 terminal
evidence above. At the audit, implementation and packaging were also missing. The existing published
Node CLI is separate: [.github/workflows/ci.yml](../.github/workflows/ci.yml) configures
Linux, macOS and Windows source-suite jobs, but does not install/build/package the
desktop or run `desktop/test/`. At that initial audit, no Windows/Linux desktop
results or installers existed. The optional browser adapter has not been qualified on those
hosts for this new editing/lifecycle work either.

This check inspected current source, the locked Tauri 2.12.1/Muda 0.20.0 sources,
Tauri distribution documentation and the exact Node 24.21.0 support table. It used
terminal-only Win32 path/URL/executable predicates and an isolated real source-editor
fixture. No app, browser, VM or container was started. At the initial audit only
Darwin/wasm Rust targets were installed and the configured Docker daemon was
unavailable. Later file/lock cross-target checks are recorded above; no complete
Windows/Linux desktop compile/run was claimed by that initial probe. Aggregate probe evidence is retained locally in
`desktop/releases/qualification-2026-10-06/platform-gap-probes.json`.

### Confirmed blockers and findings

| Priority | Gap | Evidence and effect | Required work |
| --- | --- | --- | --- |
| Resolved P0 | Private state guard failed open without Git; affected all platforms | The original isolated real-Git fixture stored an unignored draft when Git was removed from PATH. That audit remains recorded in `platform-gap-probes.json`. [source-editor.mjs](../src/source-editor.mjs) now shares `assertPrivateEditorStorage()` with [app-lifecycle.mjs](../src/app-lifecycle.mjs). | Fixed: physical ancestor `.git` directories/worktree files and explicit Git context are inspected; failed discovery in a checkout rejects writes. Per-write ignored/untracked verification remains required. Six source regressions and the packaged-helper rejection fixture cover the fix; see the private-state section below. |
| Resolved P0 in source | Windows path containment | The initial actual predicate accepted `..\outside` because it checked only `../`. The shared guard now uses the platform separator and rejects drive/share/sibling escapes; trust also inspects original import parents and canonical files. | Four semantic path tests, four actual trust fixtures and lifecycle root selection pass. Native Windows case/namespace/junction identity remains host qualification under the P2 row; the isolated follow-up Mac submission now includes this fix. |
| Resolved targeted P0 blockers in source | Unconditional Unix file APIs and macOS-only event | Startup/preferences now use guarded Unix/Windows file opening and portable `File::try_lock`; `RunEvent::Reopen` is macOS-only at compilation. | Full macOS library compiles/seven offline native tests pass; file/lock module and tests type-check for Windows/Linux. Full target desktop linking/startup, Windows ACLs and other platform/packaging gaps still require implementation/qualification. |
| Resolved P0 in source | Target runtime selection | OS/architecture pins now cover Darwin, Windows and Linux x64/arm64. Preparation supports Windows ZIP/node.exe layout and rejects unknown targets. | Windows x64 PE and Linux x64 ELF headers/architecture and official archive checksums were verified on this Mac without executing those binaries. Each target still needs native execution. |
| Resolved P0 in source | Windows asset origin | Native navigation accepts only the configured platform asset origin; renderer links compare the current exact origin. Remote/lookalike/credential/port URLs remain denied for asset navigation. | Production origin is explicitly HTTP for Windows custom-protocol assets; no listening server. Rust and renderer policy tests pass; native Windows WebView routing needs host execution. |
| Implemented in source; host checks pending | Native clipboard, opener and launcher | Official Tauri clipboard/opener adapters replace fixed macOS commands. Custom scoped commands retain size/scheme validation; direct plugin capabilities are not granted, and automatic JS link opening is disabled. CLI launch planning supports Windows installations and Linux explicit AppImage paths. | Mac library compiles and launcher/link-policy checks pass without invoking clipboard, opener or a window. Actual clipboard, native link opening and launch behavior need Windows/Linux host qualification. |
| Implemented in source; host checks pending | Helper environment and console behavior | Native helper spawning uses an OS-specific executable and allowlisted environment, Windows system/Git/absolute tool paths, CREATE_NO_WINDOW, and quiet lifecycle forks. Node loaders, agent identity, Git overrides and inherited credentials are excluded. | Production launcher and tests type-check for Windows/Linux. Actual Git discovery, environment and console visibility remain host checks. |
| Resolved in source | Worker memory limits and process identity | Shared bundled-runtime identification handles Windows separators/.exe and ordinary Unix names. Both lifecycle V8 limits and RunlistLifecycle identification use it. | A Windows-path regression plus bundled Mac lifecycle execution pass; retain actual Windows process-label/memory qualification. |
| Implemented in source; host checks pending | Lifecycle filesystem assumptions | Component containment and normalized status labels are fixed; receipt directory syncing now tolerates unsupported-directory errors like the source editor while propagating unexpected failures. | Mac lifecycle commit/recovery checks pass. Windows ACLs, directory handles, sharing violations and real durability still need native host checks. |
| Configuration implemented; artifacts pending | Installers, icons and release verification | Windows NSIS current-user configuration and .ico icon, Linux Debian/AppImage targets and portable prepared-bundle verification are present. Mac signing supports isolated app/artifact paths. | Produce and qualify Windows/Linux installers, signing/identity manifests, installation/uninstall/update/rollback. Mac artifact tools remain Mac-specific. No Windows/Linux installer was built here. |
| Policy/configuration implemented; host checks pending | WebView/dependency and offline installation policy | Windows configuration bundles an offline WebView2 installer during build. Linux CI uses Ubuntu 22.04/WebKitGTK 4.1 dependencies as a candidate baseline. | Validate offline installation and actual Linux package dependencies/minimum supported distribution on hosts. These are development configurations, not published compatibility guarantees. |
| Workflow implemented; execution pending | Desktop CI and host qualification | `.github/workflows/desktop.yml` defines Mac/Windows/Ubuntu Rust 1.95 build, native tests, installer packaging and prepared helper/frontend checks. It signs/publishes nothing and opens no window. | Workflow has not run remotely for these local changes. Real installed resources, offline/no-listener checks, recovery and memory attribution still require each target host. |
| Partly implemented; host checks pending | Menus, path identity and user-facing OS copy | Mac-only Hide/Hide Others/Show All are gated; non-Mac Undo/Redo use allowlisted editor events. Trust/notices use platform-neutral language. Dunce canonicalization avoids ordinary Windows extended-prefix mismatches in native probe checks. | Qualify actual menus/focus, case/UNC/extended-length/junction aliases and ACLs on Windows, and complete OS-specific storage/uninstall documentation after installers exist. |

### Framework/runtime requirements checked against primary sources

Tauri's [configuration reference](https://v2.tauri.app/reference/config/#usehttpsscheme)
defines Windows/Android custom-protocol origins as `http://<scheme>.localhost`
(default) or HTTPS when configured, versus `<scheme>://localhost` on macOS/Linux.
Changing this setting also changes the renderer's storage origin, so it must be
chosen before shipping recovery/preferences rather than changed casually later.

The [Windows installer guide](https://v2.tauri.app/distribute/windows-installer/)
documents NSIS/MSI and WebView2 installation modes. Default download/embed
bootstrappers need internet; an offline installer is available but adds substantial
package size. Reusing an installed runtime and handling a missing runtime need an
explicit policy. [Windows signing](https://v2.tauri.app/distribute/sign/windows/)
is a separate signing identity/workflow; Apple's Developer ID is not a Windows
release credential, and signing does not guarantee absence of SmartScreen warnings.

Tauri's [Linux prerequisites](https://v2.tauri.app/start/prerequisites/) require
WebKitGTK/GTK build libraries. Its [AppImage guidance](https://v2.tauri.app/distribute/appimage/)
says to build on the oldest intended base with WebKitGTK 4.1; Ubuntu 22.04 and
Debian 12 are examples. An AppImage is not a promise of universal Linux compatibility.
The exact [Node 24.21.0 support table](https://github.com/nodejs/node/blob/v24.21.0/BUILDING.md)
requires Linux kernel >=4.18/glibc >=2.28 for tier-1 x64/arm64 binaries; Windows
x64/arm64 have their own vendor-supported OS requirements. Tauri and bundled Node
constraints both matter. [Rust canonicalize](https://doc.rust-lang.org/std/fs/fn.canonicalize.html)
documents Windows extended-length path conversion.

### Concrete delivery order

1. Git private-state discovery, Windows lexical containment/root selection and the
   targeted native file/event compile blockers are fixed in source. Finish the
   pending Git-guard Mac release, then build a separate follow-up for these changes.
   Windows canonical identity and native junction/case/ACL checks remain required.
2. Finish platform adapters for menus, clipboard/opener, helper executable/environment,
   quiet child spawning and lifecycle filesystem operations; retain private pipe IPC.
3. Add an OS/architecture runtime manifest and target-aware preparation with pinned
   checksums; build Windows x64 and one selected Linux x64 baseline first. ARM64
   packages and additional Linux formats follow independent qualification.
4. Add Windows installer/WebView2/signing configuration and Linux package dependencies,
   identity, install/remove/update/rollback docs and per-platform inspection.
5. Add native-host desktop build and headless installed-bundle CI, then obtain
   separately permitted fresh-host, WebView/accessibility/offline and process-memory
   evidence. Source/DOM fixtures must not be reported as native-window coverage.

A cross-platform port is feasible with the existing shared Markdown engine and
Tauri architecture, but neither Windows nor Linux is a working desktop product
from this checkout. The only existing desktop artifact is Apple Silicon macOS, subject to
the earlier qualification matrix. The initial audit changed documentation and handoff
state only; the subsequent private-state fix changes the shared engine and Mac artifact.
Computer use remains prohibited.

## GUI creation, search and recovery — 2026-10-06

This work changes source and prepared resources only. The installed Mac app,
previous Apple submissions, Linux packages and earlier offline install-lifecycle
reports retain their own snapshots. No application, browser, WebView, clipboard,
opener or OS input was launched or controlled. No model, Git commit/push or
remote publication was initiated.

The shared service and interface now implement:

- Reviewed plan/doc/coordination-hub creation, configured roots/statuses, pure
  CLI scaffold/Markdown-override rendering, validation, exact preview and
  exclusive publication. Private receipts preserve the original operation ID.
  Duplicate clicks/retries, destination collisions and template/config changes
  cannot overwrite another file. JavaScript template functions are not called
  by the preview renderer.
- ⌘/Ctrl+K document/heading/action navigation, on-demand streaming text search,
  library content filters and locally saved library views. Search is limited to
  8 MiB per file and 128 MiB per query, with partial/unavailable notices and
  bounded detached snippets. Fresh metadata excludes documents changed to
  private prompts after the library cache was populated. Headings in code fences
  or comments do not become navigation results.
- Checkout-wide recovery from renderer and private disk state, including stale
  drafts, original pending save/undo IDs, creation/status/record reviews and
  prepared source operations. Disk drafts remain visible after renderer-storage
  loss or read failure. Listing never publishes, settles or retries a mutation.
  Missing files and corrupt entries remain retained for manual inspection.

| Verification | Result |
| --- | --- |
| Full source suite | 2,205 passed; one existing skip |
| Latest search/creation/recovery and retained-memory checks | 12 passed |
| Identity/lifecycle/record and workspace focused checks | 32 passed |
| Desktop suite | 44 passed |
| Prepared-runtime/helper/frontend checks | 36 passed |
| Native library/headless helper checks, offline Cargo | 11 passed |
| Source-to-prepared resource hashes | All 131 files matched; frontend dist also matched |

The full source run preceded the last search string-detachment and heading
change; the subsequent focused 12 checks qualify those changes. The desktop
and prepared suites cover the final frontend state. Workspace controller DOM
fixtures use the selected source/prepared frontend with the source checkout
service; private-pipe helper and native controller tests separately exercise
the prepared backend. These new Mac checks did not run in a network-denied
namespace; Cargo used its offline mode. They do not extend the earlier Linux
installer/offline qualification to this snapshot.

The first source run exposed five older tests that expected forged actor fields
to be ignored. They now require rejection with no write before testing a valid
trusted-human operation. A bundle run also caught resources copied before the
last recovery fix; the refreshed bundle then passed all 36 checks. Evidence,
command logs and current resource hashes are retained locally under
`desktop/releases/qualification-2026-10-06/gui-workspace/verification.json`.

Native rendering, layout at target window sizes, focus, accessibility and
clipboard remain open host checks. DOM primitives and source theme/responsive
rules are not native-window evidence. The owner prohibits computer use, so no
screen automation was attempted. GUI grepmax semantic search/later local chat
and reviewed Git commit/separate explicit push are planned work items, not
implemented features or permission to start models or publish changes.

## Latest GUI Mac candidate — 2026-10-06

Previously recorded Apple info confirmed the earlier requests are **Accepted**: original DMG
`0c86f31e-ef28-4a54-9ef1-67d7efd7d671`, isolated app
`b2a840a4-01c3-46e4-8ab7-b479059c2211` and its DMG
`5e7fd677-84d1-45fb-b7a1-6db74268cc7e`. Their completed manifests/signing logs
were already on disk. The older pending observations are historical snapshots;
those requests no longer block a new candidate.

A separate current **0.90.0 Apple Silicon GUI candidate** was built offline
in `desktop/releases/gui-workspace-20261006T234748Z/`, with a saved 221-file source/dependency/documentation snapshot
and uniquely dated artifact filenames. This includes the latest GUI creation,
quick/content search, saved views and Recovery, plus current platform adapters.
It is not a public version release or a new Windows/Linux qualification.

- The release Developer ID and configured notarization profile were used
  without Keychain Access UI.
- App bundle: **128.62 MiB**. Deep/strict signature and team checks pass.
  App/helper are arm64, declare macOS 13.5, and link only system libraries;
  bundled runtime remains Node 24.21.0. Older/fresh hosts remain untested.
- **135 packaged source files** match the frozen snapshot; frontend dist also
  matched. No private checkouts/documents, prompt or test files were packaged.
- Signed payload: **36 packaged checks and 11 native helper checks pass with
  networking denied**. No app, WebView, window, clipboard or opener was invoked.
  DOM tests do not qualify native rendering, focus or accessibility.
- **448 prior submitted/installed files** were hashed and verified unchanged
  after the new build/signing steps. The installed application was not replaced.
- New app request: **`cd008f6f-f635-4cd5-b3fe-3165ef45093f`**, uploaded at
  **2026-10-06T23:55:39.829Z**; last recorded status **In Progress** at
  **2026-10-07 00:03 UTC** (October 6, 17:03 PDT). Apple checks are stopped;
  this is not a live status.
  A bounded CLI wait timed out while Apple continued processing; this is neither
  cancellation nor rejection. The DMG is not yet created/submitted for this
  candidate because it will contain the accepted, stapled app.

`desktop/releases/gui-workspace-20261006T234748Z/artifacts/release-manifest.json` saves the request immediately after
upload. `evidence/verification.json`, source snapshot, build/signature inspection
and network-denied test logs retain the concrete evidence. The candidate README
contains terminal commands for an explicit future resume. Do not run those
commands, inspect Apple status or continue installation while the stop instruction
is in effect. The local release runbook
and plan handoffs record this instruction. When explicitly resumed, the prepared
steps check fresh Apple info,
staple/validate the app after acceptance, create/submit a separate signed DMG,
then require both Accepted, valid tickets/signatures and Gatekeeper before a
file-only installed-app replacement. Installation refuses a running Runlist or
a changed installed baseline, preserves quarantine and retains the current app
under `rollback/Runlist.app`. No background installer is running.

## Reproduction and next work

```sh
node desktop/scripts/check-installed.mjs
node desktop/scripts/inspect-bundle.mjs
RUNLIST_MEASURE_ENGINE="$HOME/Applications/Runlist.app/Contents/Resources/engine" \
  node desktop/scripts/measure-helper.mjs /path/to/checkout docs/plans/large.md
# Optional CPU profile; keep profiles local because they include source paths:
RUNLIST_PROFILE_DIR=/tmp/runlist-cpu-profile \
  node desktop/scripts/measure-helper.mjs /path/to/checkout
cd desktop/src-tauri
RUNLIST_TEST_ENGINE="$HOME/Applications/Runlist.app/Contents/Resources/engine" \
  cargo test --offline --lib headless_tests
```

Memory/latency changes and accessibility semantics have terminal evidence for
their recorded source/build snapshots. Native accessibility exposure and
whole-window behavior remain unqualified. The desktop plan remains
partial for fresh-host/minimum-OS evidence, native accessibility exposure,
final whole-window offline/peak behavior, Intel support and prepublication review.

The shared Git/private-state guard is already fixed and tested. The current
source also contains platform adapters and packaging; the earlier delivery-order
section is the historical audit sequence, not an unimplemented port checklist.
Linux ARM64 terminal/lifecycle evidence applies to its earlier snapshot.

Next planned GUI work is reviewed Git commit with a separate push, then existing-index
grepmax search, followed by native records/lifecycle, migration,
settings/diagnostics and stage/filing. These entries do not execute those tasks.
Apple checks and release continuation remain stopped. If explicitly resumed,
finish the existing GUI app request, its separate DMG and both validation gates
before file-only installation and installed-engine checks. Public distribution
and npm publication remain separate. See the local runbook.

**Computer use remains prohibited.** Do not launch, raise or control apps/browsers,
use Keychain Access, or reuse earlier permission for window testing. Obtain host
results through permitted fixtures or supplied evidence; do not turn these open
checks into another request for screen automation.

## Clean-filter development package — 2026-10-07

Owner requested selected clean-filter review, then local GUI packaging, with additional Windows/Linux x64 qualification skipped and work stopping before grepmax integration.

Candidate: `desktop/releases/clean-filters-20261007T032551Z/`. Development ZIP; verification; artifact checksum; static bundle inspection.

- Runlist **0.90.0**, protocol **1**, Mac ARM64, pinned Node **24.21.0**; both executable deployment targets and declared minimum macOS **13.5** agree. Native/runtime dependencies are system libraries.
- Frozen source: **326 files**; **146 packaged engine source files** matched the snapshot. Archive CRC and SHA-256 passed. ZIP: **42,607,418 bytes**; SHA-256 `444f6e4b38eea6dd86eaaeb34c61b0923d76b1cb9c1c5e57de96fdf57cd75783`.
- Offline/locked native release build passed with **`--no-sign`** and Apple/signing environment removed. The unsigned app is a local development candidate, not an approved release download. No personal signing, Keychain, Apple submission/status check or installed-app replacement occurred.
- **44 packaged engine/helper/DOM/accessibility checks passed with networking denied**, including canonical filtered content, configured pre-commit hook, synthetic SSH signing, helper EOF/restart, unchanged saved Markdown, one known commit and forged/repeated action refusal. No app/WebView/browser was opened.
- Source terminal coverage: **49 unique commit/read cases on Mac and Linux ARM64**, **44 source desktop cases on each** and **nine new filter cases**. These are aggregate final coverage. Initial batches and corrected focused reruns are retained: unnormalized staged rename refused correctly; a dependency fixture needed explicit recovery before a new review; Mac's 5,000-document inspection timed out under concurrent load and passed in **3.78 seconds** after the build finished. There is no all-initial-batches-passed claim.
- Supported clean profile: one-shot regular executable, literal arguments/quoted paths and optional standalone `%f`; executable and literal-file generations are captured. Private review computes canonical blobs twice and rejects unstable output or partial staging. Actual commit tree/index guards refuse later drift. Process filters, shell expressions/builtins/globs and working-tree encoding remain gated. Trusted driver side effects/indirect dependencies are not sandboxed or undone.

The existing Apple-submitted GUI candidate, accepted installed app, frozen release files and personal-account selection remain unchanged. Apple checks stay stopped. Native visual qualification and broader Windows/Linux x64/Git/signing/filter support remain outstanding; grepmax work was not started.


## Optional gmax semantic integration — source qualification, 2026-10-07

Owner requested implementation after scoping and confirming gmax remains optional.
Source now includes explicit Semantic submission in Cmd/Ctrl+K and the library,
external tool discovery/settings, typed start/result/cancel jobs, current-source
reauthorization, byte-hash-gated section jumps and bounded relevance/top-match results.
Neither Runlist package adds gmax, MCP SDK or model dependencies. The external gmax
source adds `mcp --existing-index-only`, typed project/coverage responses and an
`existingIndexOnlySearch: 1` daemon capability. It disables watch leases, registration,
indexing, store fallback, worker/model startup, reranking and per-client query logging.

Passing aggregate source coverage (with focused reruns after the final cleanup changes):

- **95 gmax cases** across document contract, worker host-safety/resilience,
  orchestrator backend, daemon transport/search/read verbs and MCP protocol/SDK.
  gmax source and test TypeScript checks pass; targeted Biome checks pass.
- **26 Runlist engine/client cases**, including 14 semantic authorization/transport/
  concurrency/deadline cases and existing workspace/memory checks.
- **44 desktop helper/DOM cases**, including four new Semantic quick-navigation/
  library cases. Final helper EOF/shutdown, diagnostics, reserved protocol, schemas
  and creation checks were rerun after asynchronous bridge cleanup was added.
- **One actual provider/client qualification test** using the newly built gmax
  source against a fixture daemon, including cancellation while a search is pending.
  The child cannot spawn background work, listen, download, or create fallback
  directories; only its fixture daemon socket is allowed. It creates no index,
  cache, watcher lease, query log or models, including with global query logging on.
  Owned bridge cleanup completes; the fixture daemon remains under the test owner.

Representative commands:

```sh
node --import ./test/setup-env.mjs --test test/app-semantic-search.test.mjs test/semantic-search-client.test.mjs test/app-workspace.test.mjs test/app-memory.test.mjs
node --test desktop/test/accessibility.test.mjs desktop/test/helper.test.mjs desktop/test/platform.test.mjs desktop/test/workspace-ui.test.mjs
RUNLIST_GMAX_QUALIFICATION_ENTRY=/absolute/path/to/gmax/dist/bin.js node --import ./test/setup-env.mjs --test desktop/test/semantic-gmax-contract.test.mjs
```

In the external gmax checkout, build with its local TypeScript compiler and run
`tests/document-search-contract.test.ts`, `tests/worker-pool-host-safety.test.ts`,
`tests/worker-pool-resilience.test.ts`, `tests/orchestrator-embedding-backend.test.ts`,
`tests/daemon-client.test.ts`, `tests/daemon-search-diagnostics.test.ts`,
`tests/ipc-read-verbs.test.ts`, `tests/mcp-protocol.test.ts` and
`tests/mcp-sdk-v2.test.ts`. These worker tests use fake child processes, not models.

Qualification is source/fixture-only. No real user index was queried/reindexed,
shared service restarted, model loaded, installed gmax/app changed, release package
built, signing/notarization attempted, repository committed/pushed, or window/browser
opened. At that fixture qualification, installed gmax 0.26.56 predated the new
contract and was refused safely. Later release checks are recorded below.
Primary stores are supported by the first contract; secondary/external stores remain
unavailable. Real-index relevance/coverage, large-platform memory/latency, native
rendering/accessibility and Windows/Linux semantic runtime qualification remain open.
The existing packages and Apple evidence above describe their frozen snapshots;
Apple checks and release continuation remain stopped.


## Optional gmax real-checkout probes — 2026-10-07

The owner requested the next qualification task. The primary gmax registry records
Runlist at 4,284 chunks and platform at 460,933 chunks. The primary daemon socket
is absent (ENOENT); an existing registry/index does not establish a ready runtime
or Markdown coverage. No daemon or model was started to make the probes pass.

Added `scripts/qualify-semantic-search.mjs`, a terminal harness using the actual
Runlist library/semantic engine and an explicitly selected external gmax entry.
It saves tool settings only in a temporary directory and removes them afterward.
The bridge is guarded against filesystem writes, background processes, listeners,
HTTP/fetch and non-daemon socket connections. Reports contain aggregate counts and
metrics, without document bodies, query text, raw diagnostics or returned paths.
There is no Runlist HTTP server or application window in this workload.

The initial probes exposed general CLI startup overhead. The external gmax source
now routes the exact `mcp --existing-index-only` invocation directly into its typed
provider, before loading the general CLI/search/store/native embedding dependencies.
The existing guarded cross-repository test now refuses those heavy imports as well
as startup/download/fallback operations, while still exercising verified pointers
and pending-search cancellation against its owned fixture daemon.

Final measurements on macOS ARM64; parent Node 26.8.1, external bridge Node as shown:

| Measurement | Runlist checkout / Node 26.8.1 | Platform / Node 26.8.1 | Platform / Node 22.23.1 |
| --- | --- | --- | --- |
| Authorized library documents, including archive | 83 | 2,757 | 2,757 |
| Plans / hubs / other documents | 70 / 5 / 8 | 1,691 / 44 / 1,022 | 1,691 / 44 / 1,022 |
| Initial library scan | 0.1 s | 1.0 s | 2.6 s |
| Library header bytes read | 322,263 | 11,257,110 | 11,257,110 |
| Semantic unavailable response, three cycles | 387–701 ms | 727–867 ms | 775–1,578 ms |
| Warm metadata text search, three cycles | 0–3 ms | 3–5 ms | 4–6 ms |
| Sampled parent peak RSS | 63.3 MiB | 97.5 MiB | 97.6 MiB |
| Sampled transient bridge peak RSS | 78.5 MiB | 81.7 MiB | 78.4 MiB |
| Parent RSS / heap used after explicit GC | 61.0 / 7.9 MiB | 96.6 / 11.3 MiB | 97.5 / 11.4 MiB |
| Bridges started / remaining after requests | 3 / 0 | 3 / 0 | 3 / 0 |
| Guard violations / unavailable state | 0 / daemon_unavailable | 0 / daemon_unavailable | 0 / daemon_unavailable |

The cold library cache is empty at process start; filesystem cache is uncontrolled.
The contended initial platform scan took 9.2 seconds; timing differences between
runs or Node versions are not a controlled speedup claim. RSS is sampled every
100 ms and can miss brief peaks. The parent is a source engine harness, not the
complete helper or native app. Parent/bridge peaks are separate lifetime samples;
there is no measured daemon/model/GPU/WebView cost and no simultaneous whole-app
peak. Metadata text search is the library fallback, not a full-body search benchmark.

Reproduce with an explicit built provider and compatible external Node:

```sh
node --expose-gc scripts/qualify-semantic-search.mjs /absolute/checkout /absolute/gmax/dist/bin.js /absolute/node
```

All nine final requests correctly refused the absent daemon, kept metadata text
search usable and reaped their owned bridges. Successful real-index retrieval,
Markdown coverage, relevance, verified live citations and daemon/runtime memory
remain **unqualified**. Those require a compatible daemon with an already-warm
query worker; this harness does not start one, reindex, load a model or relax host
admission. No installed provider/app, source checkout documents, release package,
signing/notary request or application window was changed by these probes.

Final focused checks: 14 Runlist semantic engine/client cases and the guarded
actual-provider fixture pass. Both gmax TypeScript checks and targeted Biome pass.
The gmax store/contract aggregate initially had 17 passes and one failure: the
existing secondary-store notice test read the real persistent host safety stop
and received its higher-priority refusal instead of the fixture's expected notice.
The host hold was preserved; no safety file or admission gate was changed. The
affected entry-point routing tests pass separately (9 cases; the host-dependent
notice case excluded), and all 8 document contract cases pass. This focused rerun
does not count the broader aggregate as passing.

### Historical owner-confirmed memory-pressure blocker

After these probes, the owner confirmed that memory pressure is too high for
gmax to start. Live retrieval qualification is parked until resources permit a
compatible external daemon and warm query worker under normal host admission,
and the owner resumes the task. Preserve the existing safety hold; this update
adds no startup, recovery, tuning or model-loading work.

This records the earlier resource constraint. Later ready-daemon release checks
and the new owner-reported watcher/reboot blocker are recorded in
[the restoration section](#gmax-restoration-and-watcher-blocker--2026-10-07).
Daemon liveness did not qualify watcher recovery or model headroom.

The measurements above cover the unavailable path only. They exclude running
daemon/model memory and do not establish startup headroom. Ordinary Runlist
text/content search remains available without the optional gmax integration.

## GUI native record creation — 2026-10-07

Current source adds reviewed New flag/New decision actions to their queues, the
New dialog and quick actions. Flags record a finding, severity and context and
start open/unreviewed. Decisions record a question and two to twelve described
alternatives, with optional typed consequences, and start open without a ruling.
Canonical finding/question fields supply queue, library and document titles.
Native records validate through the v1 domain parser rather than legacy document
status vocabularies.

The helper supplies human authority and stable record/option/history IDs. The
first review includes `runlist.records.json` with repository identity, managed
root and `shared: false`, unless explicit settings already exist. A unique
existing native repository ID is adopted; mixed identities require explicit
configuration. Settings sources must agree. Shared creation checks Git ignore
policy again at confirmation without staging or changing ignore rules. Invalid
record settings leave ordinary document creation usable.

Publication uses existing exclusive creation, private same-ID receipts and
checkout/actor guards. A prepared operation interrupted after metadata creation
can finish with its original identity. Conflicting destinations or changed
settings are preserved, committed retries retain later edits, and discard writes
neither file. The renderer retains alternatives/context, supports disk-review
recovery, suppresses late checkout replies and requires explicit confirmation.
Existing plan/doc creation receipts remain compatible.

Terminal source checks pass:

```sh
node --import ./test/setup-env.mjs --test test/app-record-create.test.mjs test/app-workspace.test.mjs
node --import ./test/setup-env.mjs --test test/native-record.test.mjs test/native-action.test.mjs test/app-library.test.mjs test/app-semantic-search.test.mjs
node --import ./test/setup-env.mjs --test test/index.test.mjs test/validate.test.mjs test/parse-cache.test.mjs
node --test desktop/test/workspace-ui.test.mjs desktop/test/accessibility.test.mjs desktop/test/helper.test.mjs
```

The first command passes 21 cases, including nine new native creation cases and
retained pre-feature document reviews. The native/library/semantic regression
group passed 25 cases as part of the earlier 45-case source aggregate. The
index/validation/cache group passed 116 cases. The desktop source group passed
45 cases, including private-pipe creation and four native creation/list/checkout
DOM regressions. Subsequent focused DOM reruns also passed. DOM checks cover
forms, disabled hidden controls, escaped review content, explicit publication,
retained drafts and navigation semantics; they do not qualify native rendering,
focus or accessibility behavior.

Tests used temporary synthetic checkouts and the source helper/current Node.
No Runlist server or window, browser, Keychain UI, installed app, release build,
signing/notary task, real source Git mutation or semantic model/runtime was
started or changed. Existing package test counts above describe their frozen
snapshots; these new source changes are absent from installed/frozen artifacts.
At the time of this creation work, live gmax qualification remained parked and
its memory-pressure safety hold was unchanged. See the later restoration/watcher
record below for current qualification blockers.

## gmax restoration and watcher blocker — 2026-10-07

The owner restored/released/installed gmax externally and requested bounded
rechecks. Around 08:10–08:11 UTC, installed gmax 0.26.59 and daemon PID 19231
were present; ping returned `ok: true`, `ready: true`. The installed provider
probe returned `tool_unavailable`, and the separately built external source
provider returned `unsupported_daemon`. No query delivered semantic results.

At **08:58 UTC**, the installed package and ready daemon both reported
**0.26.61**; daemon PID was 92848. Advertised capabilities were
`exclusiveGenerationRebuild`, `readVerbs`, `searchDiagnostics`, `perFileSearch`
and `watchLeases`. `existingIndexOnlySearch` was absent. The installed package
lacked `lib/mcp/document-search.js` and the checked CLI entry did not provide
the `mcp --existing-index-only` dispatch required by current Runlist source.
No deployment or service restart was performed by this agent.

The guarded installed-provider recheck began at **08:58:29.766 UTC** using
source Node 26.8.1 and external Node 22.23.1:

| Measurement | Observed result |
| --- | --- |
| Authorized Runlist documents | 84: 71 plans, 5 hubs, 8 other documents |
| Initial library scan | 21 ms, 326,158 header bytes |
| One semantic request | `tool_unavailable`, 466 ms, zero documents/sections |
| Metadata text fallback | 76 matches; reported elapsed time rounded to 0 ms |
| Sampled parent/bridge peak RSS | 63.6 / 112.3 MiB |
| Bridges started / remaining | 1 / 0 |
| Guard violations | 0 |

This is unavailable-path evidence, not successful retrieval, corpus coverage,
relevance or current-citation qualification. RSS samples are separate process
lifetime peaks and exclude running daemon/model/GPU/WebView memory; they are
not a simultaneous whole-app peak or a model-startup headroom measurement.
Text fallback is metadata search, not a full-body text-search benchmark.

The earlier restored-session project inventory listed Runlist at 4,284 chunks,
while a scoped `index_status` reported zero chunks/files and `watcher: not_running`.
That discrepancy remains unresolved; it does not prove index loss or identify
the subsequent watcher issue's cause. No index repair or reindex followed.

**Owner-reported blocker:** the gmax watcher problem is now requiring a host
reboot. Record this as the owner's operational report, not a verified root cause,
proof that reboot is the only recovery, or a successful post-reboot result.
No runtime checks were made after that report in this documentation turn. The
ready-daemon observations above do not establish watcher health, freshness,
working embeddings or restored host admission. Preserve the existing safety hold.

Live qualification remains parked for owner-managed watcher recovery and the
supported deployed contract. After recovery and explicit resume, use bounded
read-only readiness/coverage checks before live queries against an already-ready
compatible worker under normal admission. Do not acquire/renew watch leases,
start/restart services, reboot, repair/reindex, warm up or load models to pass a
check. Runlist's ordinary text/content search remains available without gmax.

The later local Runlist install discussion did not result in a GUI or CLI install;
those targets remained unresolved. Installing Runlist does not supply the missing
external gmax interface. No app/window/browser, Keychain UI, Apple/notary check,
release action, real source Git mutation or runtime recovery occurred in this
documentation update. See the status and resume record.

### 0.26.65 authorized recheck — 2026-10-07 21:36 UTC

Installed gmax and daemon both reported 0.26.65, daemon PID 30626, with
`ok: true`, `ready: true`. The document bridge and `existingIndexOnlySearch`
capability remained absent. A read-only index-health tool returned store-wide
530,809 chunks and 30,174 files with current embedding metadata. Watcher status
was `not_running`; maintenance was skipped under host containment because disk
recovery was pending. A stopped watcher alone does not prove a fault, and the
owner-reported reboot/recovery issue remains unverified.

The guarded source probe began at 21:36:43.334 UTC: 85 authorized documents,
24 ms inventory scan, `tool_unavailable` in 257 ms, metadata text fallback 76
matches, sampled parent/bridge peak RSS 63.4/109.5 MiB, one started/zero remaining
bridges and zero guard violations. These unavailable-path samples exclude
running daemon/model/WebView costs and do not qualify live retrieval or startup
headroom. No watch lease, service startup, reindex or model load was performed.

The subsequent planning turn inspected current gmax 0.26.65 source and found the
earlier restricted provider and contract tests absent. Its normal MCP/pool/query
paths include watch/store fallback, lazy worker spawning and model initialization;
the paused daemon can return keyword fallback. A dedicated enforced warm-only
path and packaged interoperability must be qualified. See
the compatibility plan.
This source inspection ran no application tests, build, runtime probe, package
install, daemon restart or model. Historical test counts above remain historical.

### gmax compatibility steps 1–4 — 2026-10-07

The owner authorized “go on 1-4.” External gmax source advanced to 0.26.66 during
implementation; the candidate uses that version without changing the installed
tool. Dedicated early stdio dispatch, contract specification, bounded document
status/dense search, per-request generation/read-only admission and existing warm
worker enforcement are implemented. Worker execution rechecks its fingerprint
and newly applied host hold. No normal MCP/watch/client-store/model fallback,
FTS/ColBERT/rerank work or query-text logging is used on this path.

Verification:

- 140 focused gmax tests across 11 files plus five worker-process/redaction cases
  pass using `scripts/document-search-fixture.config.mts`. That config bypasses
  the normal grammar-download global setup. Source and test TypeScript checks
  and changed-file Biome checks pass. Synthetic native vectors exercise literal
  prefixes containing quotes/percent/underscore and verify unchanged row counts.
- 14 Runlist engine/client cases pass. 45 helper/workspace/accessibility cases
  passed in aggregate; eight headless cases initially failed because their mock
  omitted the existing `nativeContent` export. The test mock was corrected and
  all eight passed on focused rerun: 53 helper/DOM passes, no app UI change.
- The actual extracted bridge passes its packaged consumer/import guard and
  Runlist/private-helper fixture on Node 22.23.1 and 26.8.1. Cases include current
  byte hashes and full-source/frontmatter section mapping, forbidden handles,
  bounded coverage/prefixes/query, ancestor scope, UTF-8 split frames,
  unsupported/missing/cold/generation/oversized failures, cancellation and owned
  child/socket cleanup. Global query logging is enabled in the fixture while no
  log/index/cache/watch/model directory is created by the bridge.
- `scripts/build-document-search-candidate.cjs` builds an isolated payload and
  packs with lifecycle scripts disabled, preserving checkout `dist`. The regular
  gmax consumer audit now requires the bridge/handler/docs and executes the
  packaged contract fixture, preventing a source-only packaging omission.

Local archive and machine-readable evidence:
`.runlist/qualification/gmax-document-search-20261007/grepmax-0.26.66.tgz`,
`pack.json`, `SHA256SUMS`, `verification.json`.
SHA-256: `411ddf753d0728cb809e32af0d9f25d43e07612b7075e77230d44c1f10e7330c`.
The extracted package reuses checkout `node_modules` through a fixture-only
symlink. Fresh dependency resolution/installation, native Windows/Linux semantics,
real-index retrieval, whole-app memory and installed daemon compatibility are
**not** established. The artifact is a candidate with the existing source version,
not a published release or local deployment.

Reproduction from the respective repository roots:

```sh
# gmax: isolated compile/package, with a new absolute output directory
node scripts/build-document-search-candidate.cjs /absolute/new/candidate
node scripts/audit-document-search.cjs /absolute/extracted/package
# Runlist: explicit candidate, fixture daemon/home only
RUNLIST_GMAX_QUALIFICATION_ENTRY=/absolute/extracted/package/dist/bin.js node --test desktop/test/semantic-gmax-contract.test.mjs
```

No real daemon query/start/restart, live index read/mutation, watcher recovery,
host reboot, model load/warmup, containment change, local app/tool installation,
computer use, Apple/notary action or real source Git staging/commit/push occurred.
Steps 5–6 of the compatibility plan
remain separate explicit deployment and live-qualification gates.

## Release-audit fixes 1–6 — 2026-10-07

Owner selected “do 1-6 now.” Current source fixes worker RSS retirement without restricted-path replacement, native-read shared ownership through actual settlement, mandatory generations across daemon/bridge/client/status-retrieval, idle MLX readiness with response identity validation, bounded metadata/partial coverage and the Apple Silicon/Linux ARM64 Git write gate.

Verification: 177 gmax cases in 14 files; strengthened retirement/actual-close assertions passed in their 32-case file. Runlist targeted engine/client/read-only Git/creation/memory: 38 passes; architecture/service gates: two passes. Desktop: 61 passes, one opt-in provider skip; that extracted-provider/current-helper fixture separately passed on Node 22.23.1 and bundled Node 24.21.0. Source/test TypeScript, changed TypeScript Biome, package contract/import audit and whitespace checks passed. The existing process-budget fixture now injects its intended strict policy with synthetic measurements after an initial inherited-policy failure; no host policy changed.

The external checkout independently advanced to released gmax 0.26.67. Additional integration fixes remain local. Private rebuilt tarball SHA-256: `285e2cdd5f9f706743678b1e3f26c71d52344848210d8ddc70174b78165192ea`. Archive, source/compiled hashes and logs: `.runlist/qualification/new-work-release-gap-fixes-20261007/`. Extracted fixtures reused checkout dependencies, so fresh-consumer qualification remains open. No current app package, native window or live index was qualified, and no installed provider/app, daemon/watcher/model, containment/host settings or Apple state changed.

The updated release inventory marks 1–6 complete and leaves 7–28 open. If native code fails to settle despite its deadline, teardown stays blocked safely; the caller remains bounded, and this does not establish forced native cancellation. Signing, installation, publication and real source Git operations remain separate.

## Release-audit items 7–10 qualified — 2026-10-07

Owner selected “do 7-10 now.” The selected local candidate versions are **Runlist 0.91.0-rc.1** and **gmax 0.26.68-runlist.1**. Candidate-only version changes, source inventories/hashes, base revisions and lockfiles are recorded; original checkout versions and Git staging remain unchanged. The optimized Mac ARM64 app was built with pinned Rust 1.95.0, Node 24.21.0 and `--no-sign`. It is an unsigned local prerelease candidate, not an installed update, final Apple payload or published release.

Fresh independent provider consumers pass with strict engine checks and lifecycle scripts disabled on **Node 22.12.0 and 24.21.0**. Canonical Lance preparation verifies exact JS/native pins, dependency coverage, licenses and provenance. The actual provider/private-helper fixture and **54 packaged checks** pass on each selected external Node, with the private helper running the bundled Node 24; no provider skip occurs. Native ABI qualification uses a bounded 2 MiB Session and forbids store connection. An ordinary native-store attempt refused current host pressure; no admission/policy bypass followed. Live retrieval and normal admission remain unqualified.

Current frozen Runlist qualification: **2,286 source tests passed, 1 skipped, 0 failed** on Node 24.21.0; **62 desktop source tests passed, 0 skipped** with the required actual provider; **11 native tests passed**; **53 packaged helper/frontend checks passed with network denied**. Frozen source/resource hashes match across **150 engine files** and **22 frontend files**; the bundled runtime matches its pinned extracted Node; both binaries are ARM64 with declared macOS 13.5 minimum. CLI inventory contains **155 files**, with private planning/prompt/receipt/state directories excluded. App/archive exclusion and archive CRC checks pass. These are terminal/headless checks on this Apple Silicon host, not native-window or fresh/minimum-host acceptance.

Desktop and npm publication workflows now require the exact-provider job. Missing URL/hash, wrong checksum, missing required fixture, engine/install or test failures refuse. YAML/job dependency checks and local equivalents pass. No hosted job was run or source uploaded; its repository artifact URL/hash variables remain unconfigured and block until an accessible exact provider artifact is selected. gmax remains optional and absent from Runlist runtime dependencies.

Qualification exposed fixture assumptions, corrected without changing product behavior: a literal 0.90.0 prompt-version assertion, arbitrary linked-decision representative order, an immediate native release probe during concurrent child spawning, conflated external Node/bundled RunlistHelper and case-preserving paths. Initial failures and corrected runs are retained; final full source, desktop and fresh packaged checks pass. The lock probe still requires immediate refusal while held and bounds eventual release to two seconds, consistent with [std File lock lifetime](https://doc.rust-lang.org/std/fs/struct.File.html#method.try_lock); the initial transient mechanism is an inference, not proof of a production lock defect.

Candidate/evidence directory: `desktop/releases/current-work-20261007/runlist/`. Provider source/tarball, runtime checksum, fresh locks, compiled hashes and consumer results: `.runlist/qualification/release-candidates-20261007/`. App archive SHA-256: `94f747f691acce1655d6ad4a8ad45dbecbd45f25e3e2a3ce3717d096ff08580b`; CLI tarball: `3afe546dbca5ad8bb5ac2fdcc32e10e5564bcda3baa30488108e505cb69c951e`; provider tarball: `8a1f5f4a400e25f78c181f4afea9afd20ac524a1f50353d36f6c233ea9216c6d`.

Items **11-28 remain open**. No installed-app/provider replacement, real daemon/index query/restart, watcher/recovery/reindex/reboot/model work, host tuning, containment clearing, computer use, Keychain, Apple checking/signing/submission, real source Git staging/commit/push or publication occurred. Preserve older candidates and the last authorized live observation; these results do not supersede it.

## Release-audit item 13: terminal memory — 2026-10-07

Owner selected item 13 while the gmax repo is busy. **Item 13 remains partial**:
source fixes and terminal measurements are complete, but measured helper gates
fail and current native/WebView evidence is unavailable. gmax items 11-12 are
held. No gmax source/runtime/index/model/watch work, host tuning, computer use,
Apple work, installed replacement, real source Git commit/push or publication
occurred. Lifecycle and Git operations below ran only in disposable fixtures.

Host: Apple M4 Pro, 48 GiB, macOS 26.7; measurement and private-helper runtime
Node 24.21.0. The frozen Runlist `0.91.0-rc.1` app is unchanged. An isolated copy
of its **164 engine files** differs only at `src/source-editor.mjs`; full
baseline/overlay hashes verify this. Its production helper limits remain
256 MiB old space / 4 MiB semispaces. A smaller-heap smoke experiment also failed
RSS, and no production setting was changed. The frontend fix is tested from
current source separately; these fixes are not inside the frozen app.

Source changes: undo snapshots share immutable text while copying mutable flat
block objects; common single-block comparisons avoid two complete source joins;
combined undo/redo history is limited to 100 entries and a conservative 32 MiB
estimate, retaining the nearest action if individually oversized. Small-document
history still supports 100 actions. The measured large fixture retains four.
Source validation uses native Unicode scalar validation instead of allocating
UTF-8 round-trip copies, preserving NUL/8 MiB restrictions, revision bytes,
exact disk-byte validation, locks and durable receipts.

| Exact workload | Result | Interpretation |
| --- | --- | --- |
| Frozen helper, platform: 2,758 total documents, ten read-only refresh/switch cycles | 199.88 MiB peak RSS; handshake 102.50 ms; idle CPU 0.20%; warm open P95 120.43 ms; clean exit 8.49 ms | Helper budgets passed; archive-inclusive inventory, not 2,758 active documents |
| Source-editor overlay, same platform workload | 166.27 MiB peak RSS; handshake 142.71 ms; idle CPU 0.00%; warm open P95 60.81 ms; clean exit 11.72 ms | Budgets passed for this run; host/corpus contention prevents a controlled improvement claim |
| Frozen helper, 5,001-file refresh/edit/draft/save/restore/switch workload | 384.67 MiB peak RSS; small open P95 466.18 ms; small save P95 1,094.91 ms | Fails 256 MiB RSS, 250 ms small-open and 1,000 ms small-save gates |
| Source-editor overlay, same workload without tree sampling | 380.00 MiB peak RSS; small open P95 308.61 ms; large save P95 1,200.31 ms | RSS and small-open gates still fail; not evidence that backend memory is fixed |
| Final overlay, ten 5,001-file cycles plus lifecycle/Git workers; 50 ms owned-tree sampling | Helper and sampled summed tree peak 327.94 MiB; small open P95 483.40 ms; large open P95 2,465.40 ms; large save P95 15,902.30 ms | Fails RSS, small/large open and large-save gates; tree/idle/startup/cleanup gates pass |
| Old block editor in Node/linkedom, 2,151,066-byte body | Stopped after 14 edits at 235.64 MiB heap used; sampled peak RSS 435.89 MiB | Hit the 220 MiB heap fixture safety ceiling; no native renderer claim |
| Fixed block editor, same body and 120 separate undo actions | Completed all 120; sampled peak RSS 325.22 MiB; peak heap 176.35 MiB; edit P95 4.59 ms | Component stress passes; callback omits full-app dirty/diff/recovery work and native paint |

The synthetic inventory is 5,001 files including 500 archived plans. Its visible
library is 4,501 documents: 100 hubs, 3,901 plans and 500 other docs. It has 500
flags and 4,000 scanned legacy decisions; the large file is **2,151,100 bytes**
including frontmatter. Cycles 2-10 provide warm timing samples. Earlier helper
reports named archive-inclusive counts `visibleCounts`; the final worker report
separates `countsIncludingArchived` and actual `visibleCounts`.

Final worker run: 2026-10-08 00:24:01–00:29:08 UTC (October 7 local time).
Ancestry, operation phase and executable identity establish the owned workers.
Lifecycle preview/commit reached committed state; Git preview reached reviewed
state and the selected-path commit reached committed state. Sampled lifecycle
worker peak was **67.13 MiB**; Git preview/commit worker peaks were **63.16/64.84
MiB**. These are separate lifetime peaks, not additive whole-app peaks. Helper
idle CPU was **0.20%** over five seconds; EOF drained accepted work and exited in
**68.70 ms**, with zero pending requests or remaining observed descendants.
Native window quit/renderer cleanup is still unmeasured.

RSS, macOS footprint, independently sampled peaks and Node heap are different
metrics. Compression, host contention and the process-tree sampler affect
residency and timings. No GC was forced in these measurement runs. The synthetic
warm heap delta was -18.85 MiB in the final worker run and oscillated across
cycles; that does not prove absence of a leak. The platform is a live read-only
corpus. No external daemon/model/GPU memory or startup headroom was measured.
No Runlist native process was running at initial inventory; unrelated WebKit
processes were not attributed to Runlist or included.

Regression evidence: **69 desktop passes, 1 deliberate actual-provider skip,
0 failures**; **65 targeted source passes** for editing, app actions/workspaces,
creation, native records/actions and retained-memory guards; **21 source-editor
passes on minimum Node 22.12.0**; **53 isolated overlay packaged passes,
0 skips/failures**. The overlay suite ran from the frozen 0.91.0-rc.1 test root
so protocol versions matched; it did not repeat actual-provider or OS network-denied
qualification. Tests cover exact Unicode/CRLF/managed-history
preservation, undo/redo/branching, typing groups, small/large history bounds,
oversized nearest-action retention, raw-boundary no-op behavior, process-tree
attribution and CPU-time parsing. gmax provider qualification was not selected
or repeated while its repo is busy.

Local evidence: `.runlist/qualification/memory-20261007/verification.json`,
`optimized-engine-manifest.json`, `packaged-baseline.json`, `helper-final.json`,
`worker-final.json`, `editor-baseline-bounded.json`, `editor-qualified.json` and
logs. Failed/intermediate smoke runs remain historical evidence. The final
measurement harness streams runtime hashing through a bounded buffer and checks
worker identity as well as ancestry/phase; the retained full worker report's
observations pass this stricter attribution check. The report predates that
hashing-only instrumentation refinement. No five-minute workload was repeated
solely for the refinement.

At the October 7 checkpoint, remaining work was to reduce helper transient allocation on large-document drafts/saves;
resolve the failed open/save latency budgets on a representative shipping host;
measure attributed native core/helper/workers/WebContent/GPU/Networking together
through repeated edit/switch/quit cycles and full application callbacks. Provisional
native targets are 256 MiB settled / 512 MiB peak physical footprint, 1% idle CPU,
and small/large edit-to-frame P95 100/250 ms; they are **unverified targets**, not
release claims. Re-freeze/rebuild a current candidate once source fixes and these
gates qualify. Keep gmax deployment/live work held and Apple/computer use stopped.

See [memory qualification](MEMORY-QUALIFICATION.md) for complete gates and commands.

## Helper allocation follow-up — 2026-10-08

Owner selected allocation profiling/reduction within item 13. **The helper
allocation subtask is qualified; item 13 remains partial** for current native
core/WebView footprint and full-application edit-to-frame/quit evidence. Gmax
11-12 remain held. The installed app and frozen `0.91.0-rc.1` candidate are
unchanged; this is an isolated engine overlay, not a replacement app.

Request framing joins byte chunks once per complete line. Receipt discovery
keeps at most 256 validated terminal metadata entries, hashes every reused
receipt's complete bytes through a 64 KiB buffer, and verifies a stable file
generation. A changed/new receipt receives full schema and source-revision
validation. Prepared receipts retain full-body recovery; replay, inspection,
undo, actor/authority/claim checks and durable publication retain their prior
contracts. Timestamp-only reuse and retained source-body caching are not used.
The bundle preparation list includes the new chunk framer.

| Exact current overlay workload | Measured result | Gate |
| --- | --- | --- |
| Ten 5,001-document cycles; 2,151,100-byte Unicode file; drafts/saves/restores, library/record refresh and lifecycle/Git jobs; 50 ms owned-tree sampling | Helper peak 227.88 MiB; tree peak 255.55 MiB | Pass: 256 / 512 MiB |
| Same run, warm small / large open P95 | 130.60 / 607.45 ms | Pass: 250 / 1,500 ms |
| Same run, warm small / large save P95 | 415.77 / 2,799.55 ms | Pass: 1,000 / 3,000 ms |
| Same run, handshake / library P95 / flag refresh P95 | 1,068.24 / 186.22 / 1,591.03 ms | Pass: 2,000 / 2,000 / 15,000 ms |
| Same run, idle / EOF cleanup | 0.00% over five seconds / 56.58 ms; zero pending or observed remaining children | Pass: 1% / 2,000 ms |
| Fresh-helper restart with 80 retained receipts, including 20 large receipts; 101 docs, three edit cycles and fixture workers | 184.05 MiB helper / 253.44 MiB tree peak; 101.98 ms cleanup, zero pending/remaining children | Helper memory and cleanup pass; smaller corpus checks cold receipt validation |

Full run: **2026-10-08 20:46:29–20:48:46 UTC**, Apple M4 Pro / 48 GiB /
macOS 26.7, bundled Node 24.21.0. All 14 terminal checks passed. Warm heap delta
was +0.41 MiB without forced GC; that is diagnostic, not leak proof. Production
V8 limits remain 256 MiB old space / 4 MiB semispaces. Summed RSS is not macOS
footprint; compression, host activity and sampling affect results. This run does
not establish universal latency or headroom. The historical failures remain
above, including this follow-up's framing-only intermediate at 270.52 MiB and
3,752.45 ms large-save P95 in local evidence.

Fixture-only in-process allocation profiles include normally collected objects,
open no debug network port, and do not qualify release budgets. Matched
three-cycle 101-document diagnostics recorded Buffer.concat allocation of
625.06 MiB before and 24.80 MiB after; sampled receipt readState allocations were
826.08 / 122.34 MiB. These are allocation totals/estimates, not retained memory
or a controlled performance percentage. Other allocation paths remain visible
in the profiles; they were not changed after the selected memory gate passed.

The new fragmented large Unicode/CRLF test identified per-chunk UTF-8 decoding
in terminal clients. Those clients now use stream decoding, and the workload
compares each opened fixture to exact disk text before drafting. Rust already
reads complete UTF-8 lines. The final stress/restart results use the corrected
clients; earlier reports remain historical. The first Unicode fixture and a
symlink-error assertion failed, were corrected, and their logs are preserved.

Final regression evidence: **75 desktop passes, 1 deliberate actual-provider
skip, 0 failures**; **68 targeted source passes**; **32 source/editor/framing/
harness passes on minimum Node 22.12.0**; **54 isolated-overlay packaged passes,
0 skips/failures**. Checks include single-join allocation, fragmented multibyte
input, per-frame boundaries/oversize/EOF behavior, exact draft/save/receipt bytes,
same-size receipt corruption with restored mtime, terminal-to-prepared recovery,
symlink refusal and existing authority/claim/undo/private-storage invariants.
The packaged suite used an isolated updated test root at the engine's 0.91.0-rc.1
version. Actual-provider and OS network-denied qualification were not repeated.

Local evidence: `.runlist/qualification/helper-memory-20261008/` includes
`full-optimized.json`, `restart-memory.json`, allocation profiles/summary,
`engine-manifest.json`, final test logs and `verification.json`. All 165 engine
files are hashed; only source-editor, helper and the added line-framer differ
from the frozen engine. No native window, browser/computer use, gmax contact,
watcher/model startup, host tuning, installation, Apple/Keychain/signing,
real source Git staging/commit/push or publication occurred. Fixture Git writes
were confined to disposable corpora. A new package and selected shipping-host/
native acceptance remain separately selectable work.

## Packaged candidate and pending native acceptance — 2026-10-08

Owner selected the next steps 1 then 2: build/hash/check a new local candidate,
then owner-run native memory, editing responsiveness and quit checks. Runlist
**0.91.0-rc.2** is built in `desktop/releases/helper-memory-20261008/runlist/`
with `--no-sign`, without installing, opening or controlling the app.

The isolated snapshot contains 429 verified source files; all 165 engine files
are hashed and source-backed resources match it. The 22 frontend build inputs
include the bounded undo fix. Native/helper binaries are ARM64, target macOS
13.5, use system libraries, and the bundled Node 24.21.0 bytes match the pinned
runtime. ZIP CRC/private-state exclusion pass; older candidate archive is
unchanged. ZIP SHA-256:
`8e7fcf1d1b3220456bb22281c690208a07b7901362eb746b46e40d940bf21f0b`.

Network-denied checks: **54 packaged helper/frontend passes** and **11 native
controller/process passes**, zero failures/skips. These native tests construct
no window/WebView. The full ten-cycle 5,001-document packaged stress run failed
four gates: **268.33 MiB RSS > 256**, small-open P95 **383.57 ms > 250**,
large-open **2,005.38 ms > 1,500**, large-save **4,234.42 ms > 3,000**.
Owned-tree peak **278.06 MiB**, idle **0.00%**, and EOF cleanup **56.03 ms**
with zero pending or observed remaining descendants pass. The earlier 227.88
MiB overlay run remains separate evidence. No threshold, heap setting or host
policy was changed, and no GC was forced.

The first combined offline memory run was incomplete: macOS denied ps sampling
after edit/worker cycles. Its report/log are preserved. Final memory sampling
was outside that sandbox; independent packaged/native suites establish offline
evidence. Engine comparison differs only in version/bundle metadata and the
block editor, which the helper workload does not load. The different memory/
latency outcome remains unexplained; neither a regression cause nor host
contention is proved. Keep the candidate unqualified rather than retrying until
one pass or substituting older results.

The owner-run procedure and 5,001-document fixture are in
`native-acceptance/README.md` and `native-acceptance/corpus` beside the candidate.
`native-acceptance/results.json` is deferred-owner-unavailable. The owner
responded “I can’t run the native checks now.” The candidate and fixture remain
ready for a later owner-run check. No native footprint, interaction, WebKit
attribution, native quit or paint evidence has arrived. Automated computer use remains prohibited; input-to-paint P95 needs
a separate valid method and cannot be inferred from subjective responsiveness.

Evidence: candidate `README.md`, `verification.json`, `artifact-manifest.json`,
`bundle-static.json`, `packaged-memory.json` and test logs. Installed app, older
candidates and original checkout version are preserved. Gmax 11-12 remain held
while its repo is busy; Apple/Keychain/signing, deployment and actual repository
staging/commit/push were not resumed.



## Measurement method and contended-host evidence — 2026-10-08

Owner selected correcting the measurement method and collecting host evidence
before changing numerical targets. The harness now uses an independent Worker
with async non-overlapping process commands, bounded command/sample storage,
reported actual cadence and host CPU/swap/compression/power/thermal-warning
telemetry. Helper requests and failures close both helper and observer.

The runner distinguishes immediate repeat opens, opens after refresh or save
invalidation, small/large saved opens, durable save/restore and draft
preservation/discard. Idle CPU uses a 15-second interval. Existing targets
are unchanged; draft budgets remain explicitly uncalibrated. Baseline admission
is a declared provisional macOS policy (CPU-busy P95 <=20%, swap traffic <=1 MiB/s,
known stable AC power mode, no reported thermal warning, adequate telemetry).
Warning absence does not measure actual ProcessInfo thermal state. Linux CPU/swap
diagnostics do not qualify its power/thermal baseline; Windows remains unqualified.

A fixed six-run, 20-cycle, fresh-helper/fresh-corpus series yields 114 warm large
and 342 small observations. At least 100 samples per gated warm operation, all
planned runs, suitable host conditions and adequate sampler cadence are required
for component baseline qualification. Ordinary-load/diagnostic profiles cannot
qualify it. Inconclusive baseline admission exits 2; adequately measured target
failures exit 1. There is no retry-until-pass behavior or host tuning.

A 101-document, three-cycle rc.2 fixture passed all observed component targets
and worker/cleanup checks. It remains a short diagnostic, not baseline evidence.
The intended controlled series was refused at **100% CPU busy** before a corpus
or helper was started; all six runs remain unexecuted.

A separate 5,001-document, ten-cycle diagnostic completed at
2026-10-08T21:46:11.769Z under **100% CPU-busy P95**. It recorded **257.75 MiB
helper RSS**, **155.70 MiB settled RSS**, **331.00 MiB owned-tree RSS**,
**0.07% idle helper CPU**, and **49.29 ms cleanup**, with zero pending requests or
remaining observed descendants. Small-open P95 **407.89 ms** and large-save P95
**4442.37 ms** exceeded unchanged targets. Immediate repeat small opens measured
**9.39 ms P95**; small opens after save invalidation measured **425.45 ms P95**
from 18 samples. Large open P95 was **717.93 ms**, large repeat open **492.16 ms**,
and small/large draft-write P95 **101.44/1042.13 ms**. Those tails remain diagnostic.

One process command failed; observed sampler-gap P95 was **194.08 ms** against
a requested 50 ms, with a **9503.15 ms** maximum gap. Memory peaks may therefore
be underestimated. This is neither a quiet baseline nor evidence that historical
failures were caused by the old sampler. Additional repeat reads, new observation
and longer idle change the workload; no controlled speedup is claimed.

All **11 focused observation/coverage/cleanup/parser checks** pass on bundled
Node **24.21.0**, minimum Node **22.12.0**, and the current Node **26.8.1** client.
Existing report paths are refused before observer/helper startup; a real CLI
check verified original report bytes stayed unchanged. The exact script hashes for the field reports are preserved
in `.runlist/qualification/measurement-method-20261008/measured-harness/`; later
failure-detail and classification/cold-reporting fixes have final focused coverage.
Raw reports/logs are preserved separately. The field timing client was Node
26.8.1 while the measured helper was bundled Node 24.21.0; the reports record
both. Future controlled runs should use bundled Node for both client and helper
and keep the client version fixed. No package rebuild or installed-app change
occurred. Native memory/painting/edit/quit evidence remains owner-deferred;
gmax items 11–12 and all Apple/app automation work remain held.

## First-release steps 1–4 — 2026-10-08

Selected-source **0.91.0-rc.3** is built locally for Apple Silicon/macOS 13.5+,
with pinned Rust 1.95.0, bundled Node 24.21.0, offline cached dependencies and
`--no-sign`. The candidate record
and `verification.json` retain source selection, logs, corrected initial fixture/
archive-metadata failures and exact artifact hashes. The snapshot has 433 files,
28 selected overlays and 62 excluded concurrent changes; the excluded live files,
installed app and older rc.2 artifacts were verified unchanged.

- Full source: **2,302 passed, 1 filesystem-case skip, 0 failed**.
- Desktop with required provider: **85 passed, no skips/failures**.
- Packaged required-provider fixture: **57 passed, no skips/failures**.
- Packaged network-denied checks: **56 passed**.
- Headless native controller/network-denied checks: **11 passed**, no window or WebView.
- Source/resource/frontend/runtime hashes, ARM64/macOS-13.5 targets, private-state
  exclusions, ZIP CRC and archive/app inventory match pass.

The exact retained `0.26.68-runlist.1` provider artifact and previously qualified
consumer were required in isolated synthetic fixtures. No fresh consumer install,
real daemon/index/model/watch contact, provider deployment or live readiness is
claimed. gmax remains optional at runtime; the fixture gate remains required.

ZIP SHA-256: `95b54fd91af2b8bf57ad3bef5161b9c11ccbf60b56db386efbd14e3ca030d1f8`.
The candidate includes targeted document metadata refresh, invalidation race fixes,
reduced redundant editor-route reads and explicit unsupported/experimental states.
See the central completion record.

A 101-document/three-cycle allocation diagnostic passed observed targets, but
profiling, insufficient samples and host conditions prevent release qualification.
It does not supersede the older rc.2 full stress failures with a comparable pass.
The fixed 5,001-document performance series, native whole-app/edit/accessibility
checks, fresh/minimum-host installation/upgrade/rollback, hosted CI and final
distribution remain open. Numerical gates were unchanged. No installation,
upload, publication, real source Git mutation, computer use or Apple work occurred.
## Mac delivery installed — 2026-10-08

The owner directed release and then explicitly stopped additional testing. The existing selected and tested **0.91.0-rc.3** build has now been delivered as a personally signed, Apple-notarized Mac app and installer. No new feature or performance/native testing was added after that stop. The signed-copy offline run already in progress completed; no further functional suite was started. Its prior tests remain evidence rather than prerequisites being expanded after the owner's direction.

- Installed app: `~/Applications/Runlist.app`. File-only replacement preserved existing quarantine; no launch, window control, app-data modification or process termination occurred.
- Prior app retained at `desktop/releases/mac-delivery-20261008-rc3/rollback/Runlist.app`.
- App and DMG requests: **Accepted** for these new payloads. App/DMG tickets were stapled and verified; Gatekeeper accepted both. The configured release identity and notarization profile were used through terminal tools, without Keychain Access/computer use. Submission IDs are retained in local release evidence.
- Installer: `desktop/releases/mac-delivery-20261008-rc3/Runlist-0.91.0-rc.3-macOS-arm64.dmg`; final SHA-256 `82a6c6f8b34d38dd31bbe185f31281e1a5b4ed67c5bff8ce509f9a9f622f581a`. Release manifest, requests, signing/Apple/install logs and rollback are retained in that directory.

The unsigned reference, source selection, concurrent CLI work and earlier artifacts remain separate. The current release is Apple Silicon/macOS 13.5+, retaining explicit experimental semantic controls and qualified-platform Git refusals. It is installed locally and has a distributable notarized installer; no GitHub/npm publication or broad platform support is claimed. Controlled performance, native-window/accessibility and broader fresh-host/CI evidence remain incomplete follow-up; they were not silently marked passed or made new conditions of this owner-directed delivery. Future backlog requires owner selection. gmax/live work and computer use remain held. Historical stopped-release instructions apply to their earlier payloads; the latest owner direction resumed this specific delivery.
