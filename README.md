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

**New to Runlist? Start with the [beginner setup guide](GETTING_STARTED.md).**
It covers the terminal, asking an assistant to set up a project, agent plugins,
and the optional Runlist desktop app.

## Handoffs in 3 steps

The quickest way to get value from runlist: **save where you are, pick it up in
a later session.** A saved handoff (runlist calls it a *baton*) is a short
resume note kept in your project, so the next Claude session starts oriented
instead of from a blank page. There is no setup step.

1. **Install** (once, in a terminal):

   ```bash
   npm install -g runlist
   claude plugin marketplace add reowens/runlist
   claude plugin install runlist@runlist
   ```

   Terminal sessions, Claude Desktop's **Code** tab (local sessions) and VS Code
   read the same plugin settings, so one install covers them all. It covers
   every project because it installs at user scope, the default; a
   `--scope project` or `--scope local` install covers only that project. Start
   a new session afterwards, or run `/reload-plugins` in one that is already open.

   The `claude` command comes with the Claude Code CLI
   ([install it](https://code.claude.com/docs/en/setup)). If it is missing,
   `runlist install claude` prints these same commands and where to get it. In
   Claude Desktop, once the marketplace is registered, the **Code** tab → **+** →
   **Add plugins** browser lists runlist too (the menu item may read
   **Plugins** → **Browse plugins**; not available in cloud or WSL sessions).
2. **Stop with a handoff.** In a Claude Code session in your project's Git
   repository (terminal or Desktop's Code tab), say "baton" or "save where we
   are", or type `/runlist:baton`. The first handoff in a project also writes a small
   `runlist.config.mjs` and keeps handoffs in `docs/prompts/`.
3. **Pick it up next time.** In a new session, type `/runlist:pickup` or say "pick up
   where we left off".

After the first handoff, `git status` shows `runlist.config.mjs` and
`docs/prompts/` as untracked (just `docs/` when that folder is new). Commit the
config so everyone gets handoffs. Leave the prompts out of commits: the config
sets `promptTracking: 'untracked'`, which recommends that but does not ignore
them, so stage files by name rather than with `git add -A`. The local `.runlist/`
folder hides itself with its own `.gitignore`.

Planning is optional: when you want plans, docs and an index, run `runlist
setup` in the project (see the [beginner setup guide](GETTING_STARTED.md)). It
previews first, and your saved handoffs stay where they are.

Outside a Git repository the first handoff refuses, since there is no project
folder to put its config in (run `git init`, or `runlist setup` to configure
the folder). It also refuses in a home directory that is itself a repository.
A project that already has a runlist config works outside Git as before. In a
handoffs-only project runlist manages only the prompts in `docs/prompts/`: any
other Markdown there is left alone. Handoffs an older runlist saved in a root
`prompts/` folder move to `docs/prompts/` with the first handoff (it prints one
line saying so; `--dry-run` lists the moves), and anything else in `prompts/`
stays where it is.

### What baton-only mode does and doesn't do

Until you run `runlist setup`, a project whose config the first handoff wrote
uses runlist for handoffs only (its config says `mode: 'handoffs'`), and its
handoffs live in `docs/prompts/`.

What works:

- Saving: say "baton" or "save where we are", or type `/runlist:baton`.
- Picking up: `/runlist:pickup`, or `runlist use [<name>]` in a session, consumes a
  handoff (archives it and prints it).
- `runlist prompts` lists the saved handoffs; `runlist prompts show <name>`
  reads one without consuming it.
- `runlist check` checks the saved handoffs.

What says planning is off (`Planning is off in this project; runlist setup
turns it on`):

- Plan views such as `runlist plans`, `health`, `runlists`, `roadmap`,
  `modules` and `stale` print that line and exit successfully, as an empty
  dashboard would. With `--json` they print `{ "planning": false, … }`.
- Plan actions such as `runlist new plan`, `new doc`, `runlist runlist next`,
  `roadmap next`, `sync-status` and `bulk-tag` refuse with it.
- So does a command filtered to a type other than prompts (`--type plan`), and
  a file argument outside the prompt folder (`runlist show docs/plans/x.md`).

Other Markdown in the prompt folder is never listed, checked, searched or
changed. `runlist flag add` still accepts any file in the repository.

Plans an older runlist saved before there was a config don't stop the first
handoff from setting this up: they stay where they are, and the planning-off
line says how many `runlist setup` will bring in ("2 runlist documents saved
before setup are waiting for it.").

To turn planning on, run `runlist setup` in the project. It widens the
config's root from `docs/prompts` to `docs` and previews first: the config
before and after, and how many existing Markdown files under `docs/` planning
will start checking. Your saved handoffs stay where they are, and plans saved
before setup in `plans/` move to `docs/plans/`.

If a session hook says it found neither `runlist` nor `dotmd` on its PATH, either
runlist is not installed yet or the app is searching a different PATH than your
terminal. In a terminal, compare `command -v runlist` and `echo $PATH` with the
PATH the hook printed (on Windows, `where runlist`). If runlist is installed but
its folder is missing from the hook's PATH, add that folder, then
fully quit and reopen Claude Desktop. On macOS and Linux the folder is `npm prefix -g` plus
`/bin`, and it goes in your shell profile. On Windows it is the `npm prefix -g`
folder itself, and it goes in your user environment variables, because Claude
Desktop does not read PowerShell profiles (see Anthropic's
[Desktop troubleshooting](https://code.claude.com/docs/en/desktop#session-not-finding-installed-tools)).

This quick path uses Claude Code (the Code tab in Claude Desktop, or a terminal)
running on your own machine, because that is where the plugin's hooks and the
local `runlist` command live. For what Chat, Cowork, Codex and remote sessions
can run, see [Which assistant can run setup?](#which-assistant-can-run-setup).
The separate Runlist desktop app is optional and comes after this path:
`runlist desktop install` on a supported Mac.

## Install

```bash
npm install -g runlist      # global CLI; choose agent integration separately
npm install -D runlist      # project scripts via node_modules/.bin
npx runlist setup           # guided project setup without a permanent CLI install
```

`runlist` is the canonical executable, `rl` is its short convenience alias, and
`dotmd` remains supported during the compatibility window. All three invoke the
same CLI. The npm package is `runlist`; existing `dotmd-cli` installs should be
replaced with `runlist`. The Claude Code plugin is `runlist@runlist`. Legacy
`dotmd.config.*` files, `DOTMD_*` variables and `.dotmd/` state keep working.

Running from a source checkout, or replacing an old `dotmd-cli` install? See
[Checkout review and migration](#checkout-review-and-migration).

The optional desktop app is a separate download with the same Markdown engine; see
[desktop setup and validation](desktop/README.md). The delivered app includes
reviewed plan/doc/hub creation, ⌘/Ctrl+K navigation, on-demand local content
search, saved library views, checkout-wide recovery and reviewed local Git commits
for qualified macOS checkouts. Saving writes local Markdown; committing remains
a separate reviewed action. **Product goal** shows your written yardstick beside
a plan's delivery statement, with explicit Review/Apply for your assessment.
**Filing** shows where plans are homed and opens the supporting hub rows.
Stage filters, grouping and editing are included. Optional grepmax semantic
controls are experimental; live retrieval depends on a compatible external
provider. Local chat and push are deferred.

<!-- runlist:release:start -->
CLI and desktop release version: **0.99.2**.
[Mac installer and release notes](https://github.com/reowens/runlist/releases/tag/desktop-v0.99.2).
Normal product releases publish both components. Local app installation is separate from release acceptance.
<!-- runlist:release:end -->

The desktop app bundles the matching engine and runtime. Publishing a product
release now includes building, qualifying, signing/notarizing and publishing the
Mac installer. `runlist update` also updates an existing Mac app; installing the
npm package alone does not download an app onto a machine without one.
Earlier development packages and their qualification results are historical;
see the [desktop validation record](desktop/VALIDATION.md).

**Current desktop improvements:** the workspace uses quieter navigation, a clear
back-to-list action, readable text and fewer routine banners. Document pins and
record drafts persist locally; failed searches clear stale results and offer
Retry. File options, raw Markdown editing and advanced settings stay available
through their disclosures.

Read-only installation checks now explain the active source:

```bash
rl doctor --project --json  # CLI launcher/Node scope, source identity, project and desktop copies
rl install --json           # host copies plus the same installation report
rl update --check           # versions, source comparison and what an update replaces
rl doctor --prompts --json  # parent-link findings; no consumption or repair
```

Engine fingerprints cover shared source inputs, excluding private documents,
state, runtime binaries and the release version label. A matching fingerprint
compares engine code, not signatures, native rendering or runtime qualification.
Host source, cache and registry copies are labelled separately; a cache entry
alone does not prove which copy a running host has loaded. No package manager or
host command runs to produce the `doctor --project` installation report.

**0.98.1 is published and installed locally.** `runlist show` briefs a plan
(outline, open boxes and `--section` reads with line numbers), marks each
phase's tally and the active phase, groups open boxes by phase, and caps long
related-plan and link lists; `runlist use <doc>` briefs a doc over 500 lines.
The agent workflow says to read plans that way. The desktop app's own code is
unchanged from 0.96.1; it bundles the 0.98.1 engine. The Mac installer is signed, notarized and verified; installation
retained the previous app for rollback. Open it with `rl desktop`. See the
[release validation](desktop/VALIDATION.md#current-mac-release--2026-10-22)
for checks and evidence. Full-app dialog accessibility remains an open finding;
fresh/minimum-host and controlled whole-app performance qualification remain
follow-up work.

Optional installed-app diagnostics, separate from release acceptance:

```bash
node desktop/scripts/check-installed.mjs
```

The checker prints the installed version and selected test source. It uses this
checkout when its version and engine fingerprint match; otherwise it searches
local frozen sources under `desktop/releases/*/source`. For a snapshot stored
elsewhere, pass `--source /path/to/matching/source`. A missing match stops the
check before running tests. Tests use the installed helper/runtime with networking
denied and create no app window.

Parent-link diagnostics support a
bounded handoff reconciliation:
record completed results in durable plans before explicitly archiving the
selected prompts. Historical nested-archive origin recovery stays deferred until
a concrete case needs it.

Remaining product work:

1. Resolve full-app dialog accessibility and extend native offline, fresh/minimum-Mac
   installation/upgrade/recovery and whole-app performance qualification.
2. Finish the broader native-plan, identity/migration, history/verification,
   scoped-relationship and advanced settings/diagnostics contracts. Reviewed
   legacy plan status/archive operations already ship.
3. Qualify additional local-commit filter, hook, signing and platform profiles.
   Push remains deferred.
4. Deploy and qualify an exact optional grepmax provider against an existing
   index, after the separately recorded watcher/resource hold is resolved.
   Compatibility fixtures pass; successful live retrieval remains unverified.
   Local model chat remains deferred.
5. Complete post-release agent-workflow measurement and assess the installed
   OpenCode prompt-hook API. A Rust engine migration remains planned pending
   performance evidence.

The current Mac installer is linked in the release-version section above.
CLI and desktop include the optional product yardstick.
The supported desktop
release is Apple Silicon macOS 13.5 or newer. Broader platform work and
experimental semantic search remain separate follow-up work.

Maintainer release automation is POSIX-only because it uses Bash and POSIX
command-line tools. The published Node.js CLI remains cross-platform.

### Optional desktop GUI

The CLI works on its own. On an Apple Silicon Mac (macOS 13.5 or newer),
install the optional GUI and open it with:

```bash
runlist desktop install
runlist desktop
```

The installer downloads the GUI from Runlist's public GitHub Releases, checks
its SHA-256 digest, developer signature and Apple approval, then installs it
without opening it. The app bundles its runtime and reads local files through
private pipes, with no listening server. Choose your checkout folder in the app.
No checkout configuration is loaded by these CLI commands.

`runlist desktop install` selects the newest published Mac installer and
updates an older installed app after you quit it.
Windows, Linux and Intel Mac GUI downloads are not yet available through this
command. Current or newer installed apps are preserved. To use a downloaded signed
DMG, quit Runlist and run:

```bash
runlist desktop install --from /path/to/Runlist.dmg
```

Replacement keeps the previous app as a rollback copy. Add `--dry-run` to preview
an install or launch without network access, file changes or opening the app.
Use `runlist desktop --app /path/to/application` for a custom installation path.

### Checkout review and migration

For local CLI review, run this from the source checkout:

```bash
npm link --ignore-scripts
npm ls -g --depth=0 runlist   # shows the checkout path when linked
```

Now `rl`, `runlist`, and `dotmd` run directly from that checkout wherever this
Node installation is selected; source edits take effect immediately. npm globals
and links belong to each Node installation. If entering a repo switches Node
through NVM, link the checkout using that Node's npm too. Check
`command -v rl` and `npm ls -g --depth=0 runlist` inside the target repo.
A normal `npm install -g runlist` instead
installs a separate copy of the published package. Merely editing or pulling the
checkout does not update that copy. The version number alone cannot distinguish
an unreleased checkout from an installed release.

To leave local review and restore a released CLI, run
`npm install -g runlist@<version>` (replace `<version>` with the release wanted).
`rl update` also installs the published CLI, replacing the local link. Project
dependencies installed with `npm install -D` are separate again: project scripts
and `npx` can resolve those before the global CLI. Linking the CLI does not
rebuild the desktop app or refresh an agent plugin's installed files.

If you installed the old package globally, remove it before installing the new
one because both packages provide the same executable names:

```bash
npm uninstall -g dotmd-cli
npm install -g runlist
```

### Agent host setup

For project onboarding, start with [`runlist setup`](#quick-start). It preserves
existing configuration and installs a host integration only when selected.
The CLI alone does not load the workflow skill or hooks into your assistant.
You can also inspect or install an integration separately:

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

The Claude Code and Codex plugins include a discoverable **runlist-setup** skill
for requests such as “Claude, help me set up Runlist in this project,” including
projects with no Runlist config yet. The ordinary **runlist** skill handles the
ongoing plan/doc/prompt workflow. The setup skill is available only after its
plugin is installed and loaded; typing its name in an assistant without that
plugin does not install it. Use the terminal bootstrap below first.
Host hooks need a persistent `runlist` executable on that host's `PATH`; an
ephemeral `npx` run alone does not provide it.

### Which assistant can run setup?

Use a shell in the checkout you want to configure. These surfaces have different
execution environments:

- **Claude Code (the working path in Claude Desktop):** open the **Code** tab, or
  use a terminal session, with the intended checkout selected. A local Code
  session reads the same plugin settings as the terminal, and hooks fire there.
  Install the plugin with the [three-step quick path](#handoffs-in-3-steps) and
  start a new session. Desktop Code also supports cloud and SSH environments; those
  execute elsewhere. See
  [Claude Code desktop environments](https://code.claude.com/docs/en/desktop).
  Install and verify the plugin in that environment; follow the host's
  [plugin activation or reload result](https://code.claude.com/docs/en/discover-plugins).
- **Claude Desktop Chat:** a conversation alone does not provide Runlist's CLI
  or the Runlist Claude Code plugin. An assistant without a suitable shell can
  give you the terminal commands below, but cannot report them as executed.
  Desktop extensions and connectors are separate integrations; this plugin
  supplies no Desktop Chat execution bridge. See Anthropic's
  [connector and desktop-extension guidance](https://support.claude.com/en/articles/11725091-when-to-use-desktop-and-web-connectors).
- **Claude Cowork:** verify the actual workspace and shell first. Current
  sessions run in the cloud by default; legacy local sessions execute code in
  an isolated VM. Connected local-folder access does not establish that shell
  commands run on your Mac or PC. See the official
  [Cowork architecture](https://support.claude.com/en/articles/14479288-claude-cowork-architecture-overview).
- **Codex:** Local and Worktree sessions use your computer; Cloud uses a remote
  workspace. Choose the intended project and execution mode before setup. See
  the official [Codex environments documentation](https://learn.chatgpt.com/docs/environments/modes).

A successful `npm install` in a cloud, SSH, container, or Cowork shell installs
into that environment's npm scope. It does not prove that your local computer's
CLI, host plugin, or GUI was installed. Report the paths actually changed.
With no shell or checkout access, run the bootstrap in a local terminal yourself.
The optional [Runlist desktop GUI](#optional-desktop-gui) is installed separately
with `runlist desktop install` on supported Macs; `setup` never downloads it.

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
a handoff, a PreToolUse guard, the canonical workflow skill, and `/runlist:plans`,
`/runlist:docs`, `/runlist:prompts`, and `/runlist:baton` commands.

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

From CLI 0.93.2, Claude plugin updates cover each saved user, project and local
installation.
Project/local updates run from the recorded project folder. `update --check`
shows each scope separately, and an update verifies the fresh installation
records before reporting success. Missing project paths, unavailable folders
and managed scopes are reported rather than silently updating another scope.
The release workflow uses the same scope selection and verifies every entry
against the released version.

Updates also refresh already installed OpenCode and Codex integrations. After
upgrading the CLI, host installers run from the updated package so their version
and assets match. Codex verification checks the host's installed copy separately
from its marketplace source. Releases use these same checks and remain resumable
if an installed host fails to update. Uninstalled hosts are not added.

Restart the affected host sessions to load updated integrations; Claude Code also
supports `/reload-plugins`.

## Host health and selected repairs

Inspect Claude, Codex and OpenCode together before choosing a repair:

```bash
runlist doctor --hosts
runlist doctor --hosts --json
runlist update --check --json
```

These reports are offline: they read executable paths, registries and managed
assets without running host programs or importing the project's JavaScript
config. They work before project initialization and with a broken project config.
The report includes the CLI launcher, Node/npm scope, Claude profiles and shared
plugin stores, installed/catalog versions, source comparisons and reload steps.
Newer published versions are not queried by an offline check; it compares the
local files and saved catalogs. An online `runlist update` refreshes catalogs.

`missing`, `stale`, `foreign`, `current` and `unknown` are distinct. `current`
describes the reported files or catalog comparison; installed and loaded states
remain separate. Cached files never establish that a running session loaded the
skill or trusted its hooks. A local checkout can contain unreleased assets while
the published Claude catalog and installed plugin still match.

Host repairs are selected explicitly and previewed by default:

```bash
runlist doctor --hosts --repair codex
runlist doctor --hosts --repair codex --apply --dry-run
runlist doctor --hosts --repair codex --apply
```

Repeat `--repair` to select several hosts. In host mode, `--apply` requires named
repair targets; `--dry-run` always prevents execution. A selected repair can
install a missing integration or refresh managed content. Foreign/unreadable
content is preserved, independent host failures are reported separately, and
remaining source/activation checks stay visible. Host application upgrades
remain with each host's installer.
Already-current Claude/OpenCode files need no repair. Codex may still require
an installed-copy check even when its marketplace source is current. Blocked
repairs offer a safe preview or manual next step instead of an apply command
that would repeat the refusal. Saved enablement and live activation stay separate.

When Claude has multiple binaries or profiles, use the native binary shown in
the inventory and explicit absolute profile paths. Replace these placeholders
with the paths from your report:

```bash
runlist doctor --hosts --repair claude \
  --claude-config /absolute/profile --claude-bin /absolute/native/claude
runlist doctor --hosts --repair claude \
  --claude-config /absolute/profile --claude-bin /absolute/native/claude --apply
runlist update --host claude \
  --claude-config /absolute/profile --claude-bin /absolute/native/claude --dry-run
```

Repeat `--claude-config` for separate profiles. Shared physical plugin stores are
updated once, while each profile's enabled settings and each saved scope remain
visible. A wrapper can override `CLAUDE_CONFIG_DIR`; Runlist refuses ambiguous
targeting and asks for an explicit native binary. It does not infer an account
from the wrapper's filename or script contents.

`runlist update --host claude|codex|opencode` restricts the update to that installed
host integration and conflicts with `--cli-only`. Missing integrations remain
missing during update. Without a host selector, update retains its CLI and
installed-host workflow, refreshing official Claude catalogs before scoped
updates and checking managed asset contents even when versions match. The npm
scope and effects on local CLI links are reported; checkout sources and project
dependencies are preserved. Reload/restart the affected hosts and review their
hook trust settings after repairs or updates.

## Quick Start

From a terminal in your project, install the CLI using one of the scopes above,
then start guided setup:

```bash
cd /path/to/your/project
runlist setup                   # terminal: collect choices, preview, confirm
# Or bootstrap without a permanent CLI install:
npx runlist setup
```

An interactive terminal without `--yes`, `--json`, or `--dry-run` collects missing choices and asks you to
confirm the concrete preview. In a noninteractive shell, omitting `--yes` prints
a preview, writes nothing, and does not wait for input. `--dry-run` always
previews, even with `--yes`; `--json` requests a machine-readable report.

For deterministic setup, preview explicit options and then apply those same
options with `--yes`. This example chooses a relative docs root in a new project,
leaves prompts untracked, and installs no host integration:

```bash
runlist setup --docs-root docs --prompt-tracking untracked --host none --dry-run --json
runlist setup --docs-root docs --prompt-tracking untracked --host none --yes --json
```

`--yes` applies explicit options and defaults without asking more questions.
Fresh projects default to `docs/`, prompt tracking `untracked`, no ignore-file
edits, no host install, no first plan, and no document adoption. Existing config,
roots, JavaScript functions, and hooks are preserved; an existing prompt policy
is retained unless you explicitly select another. Changing an existing root
with `--docs-root` is refused with manual configuration guidance. Review and edit
that project's root export and dependent paths yourself; setup is not a generic
JavaScript config editor and does not move documents.

To include existing Markdown, select each file explicitly. For example, if
these two files exist inside your configured docs root:

```bash
runlist setup --adopt docs/notes/design.md --adopt docs/notes/constraints.md --dry-run
runlist setup --adopt docs/notes/design.md --adopt docs/notes/constraints.md --yes
```

Only the selected paths are considered for adoption. Review the proposed
frontmatter changes; setup never blanket-tags your existing docs. Other
untagged docs remain outstanding and may still appear in validation findings.
An `attention` result means setup applied the selected changes and project
validation still needs attention; it exits with status 1. Inspect the report's
completed actions and validation findings before retrying.

Optional choices can be combined in the same preview/apply pair:

- `--gitignore` explicitly requests missing ignore rules. Without it, ignore
  files are untouched. Selecting `tracked` does not remove existing ignore rules.
- `--host claude`, `--host codex`, or `--host opencode` selects the existing
  `runlist install` integration. The default is `--host none`. Host installation
  requires apply; a preview does not install anything. Check which host executable
  your shell resolves before applying, particularly with multiple Claude installs:
  in Bash/Zsh use `type -a runlist rl node npm claude` (PowerShell:
  `Get-Command runlist,rl,node,npm,claude -All`). Setup does not install or update
  the agent host itself.
- `--first-plan <slug>` also requires `--current-state <text>` and
  `--next-step <text>`. Supply your actual state and immediate action; do not use
  invented progress or placeholders. `current_state` is capped at 1,500 characters
  and `next_step` at 800; longer details belong in the plan body. For example,
  after replacing these illustrative values with your own:

  ```bash
  runlist setup --first-plan auth-refresh \
    --current-state "The existing login flow has no retry path." \
    --next-step "Reproduce a failed login and record the expected retry behavior." \
    --dry-run
  ```

Read setup's **completed**, **outstanding**, and **failed** results separately;
**notes** (JSON `notes`) is information, not remaining work.
Configuration written successfully does not mean every document passed checks
or that a running host loaded its plugin. Unselected untagged documents,
unavailable host tools, and required host reloads must remain visible. Address
the named failure, inspect what already completed, then preview a retry; do not
silence validation to make onboarding look complete. Use the existing commands
for follow-up inspection:

```bash
runlist plans                  # compact live plan dashboard
runlist check                  # schema, references, and lifecycle findings
runlist doctor                 # preview repairs; add --apply only for chosen repairs
runlist doctor --session        # identity in this shell, not proof of host activation
```

After a host install, follow its activation/trust instructions and verify the
skill and hooks in that host. Restart the session or reload plugins where
required; setup cannot certify a future session. For lower-level initialization
without onboarding, `runlist init` remains available.

New projects recommend leaving pending prompts untracked to reduce commit churn.
`runlist init` leaves `.gitignore` and other ignore files untouched by default.
Untracked does not mean ignored: `git add -A` can include these files. Inspect or
explicitly choose the policy in the CLI:

```bash
runlist config show
runlist config get promptTracking --json
runlist config get promptDirectory --json
runlist config set promptTracking tracked --dry-run
runlist config set promptTracking tracked
```

`untracked` warns when agents include pending prompts in Git operations;
`tracked` allows them; `local` denies them. Existing configs without a choice
keep `local` behavior until an explicit selection. Policy changes preserve the
prompt location and existing files and never stage, untrack, move or delete them.
They never change ignore files. To explicitly add ignore rules during setup,
preview `runlist init --gitignore --dry-run`, then run `runlist init --gitignore`.
This adds missing runtime-state rules and, unless `tracked` is selected, prompt
rules; it preserves unrelated rules. Selecting `tracked` does not remove rules
that already ignore prompts.

Runtime state in `.runlist/`, such as the parse cache, also remains unignored by
default and can be staged by `git add -A`. Review the selected files before
committing. The explicit ignore option covers `.runlist/` and `.dotmd/` (the
legacy state directory, still readable for compatibility).

`config show` also reports `root`, resolved `docsRoots`, `index.path`,
`archiveDir`, and the resolved `promptDirectory`. Sources distinguish configured
values, defaults, the legacy `readme` index alias, and derived paths. Only
`promptTracking` supports CLI writes; other keys return specific manual-edit
guidance. These commands import the trusted project's JavaScript config but do
not invoke document hooks. The GUI uses the same project configuration; it is
not required to inspect or choose prompt policy.

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
needs no installed Node, browser access link or listening server. CLI 0.92.0 provides the desktop commands below.
The GUI remains optional:

```bash
runlist desktop install                 # install the public Mac GUI
runlist desktop                         # open the installed GUI
runlist desktop install --from /path/to/Runlist.dmg  # install a local signed DMG
```

The installer currently supports Apple Silicon Macs. It verifies the published
download checksum, Runlist developer signature and Apple approval, and installs
without opening the app. An older installed app is updated after it has quit;
replacement keeps a rollback copy. `--dry-run` uses no network and
changes no files. The current Mac download replaces the withdrawn
installers. These commands ship
in [CLI 0.92.0](https://github.com/reowens/runlist/releases/tag/v0.92.0) and can also
be used from this checkout as `node bin/runlist.mjs desktop …`. Normal product releases keep GUI and CLI versions together; an npm install
does not add a GUI to a machine without one.

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
remain separate. Stop the server with Ctrl+C. CLI 0.92.0 also includes this explicitly launched browser-app command;
use `runlist app` from an installed CLI.

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
browser pins. Lost acknowledgements can be inspected and
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
0.92.0-rc.1 GUI includes the experimental semantic controls. An external provider
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

**Appearance** in the Workspace menu offers Light, Dark, and System. The browser remembers
your choice across reloads and shares it with other tabs at the same local app
address. System follows your OS appearance, including live changes. The theme
covers the library, inline editor, source, diffs, section tools, and templates.

**Details** provides a searchable heading outline, file information, and section
insertion. Command/Ctrl+Shift+J opens section search; Alt+Page Up/Down moves
between headings. Select a heading to jump to that section.

**Templates** in the sidebar opens doc and plan scaffolds and the prompt wrapper.
The editor also includes **Resume draft** and **Subagent draft**. All
support Markdown editing, an example preview, and a diff before saving. Template
drafts stay in browser storage. Saves use revision checks and write the repository's
`runlist.templates.json`. Document overrides are used by ordinary `runlist new`
commands; draft outlines are used by `runlist baton --template` and
`runlist baton --subagent --template`. Saving a draft outline does not change the
prompt wrapper or replace the repository's `templates.prompt.baton` instructions,
which are shown beside the outline. Existing documents are unaffected.
For document scaffolds, keep `{{title}}`, `{{body}}`, and the managed
`{{status}}`/`{{date}}` metadata placeholders; `{{version}}` is also available.
Authored complete bodies and explicit plan variants retain their existing CLI
behavior. JavaScript templates from `runlist.config.mjs` can be inspected without
executing them. Built-in types can receive a Markdown override; custom JavaScript
types remain editable in that config file. The template file can be committed
with Git; document pins and draft recovery remain local. The subagent outline keeps
`parent_prompt: {{parent_prompt}}`; the CLI fills it from `--parent` or
`RUNLIST_PARENT_PROMPT`. Resume outlines have no required placeholders.
Drafts use the `handoff:resume` and `handoff:subagent` keys inside `templates`;
repository document types named `resume` or `subagent` remain separate.
The installed desktop bundles its own engine: an npm link updates CLI and
`rl app`, while desktop changes need a new desktop build/install.

The renderer covers headings, paragraphs, lists/tasks, tables, quotes, fenced
code, and safe links. Authored HTML is displayed as text; unsupported syntax
remains available in Source. The optional `test/browser-app-smoke.mjs` exercises
real browser save/CLI readback, undo, reload recovery, conflict review, lost
acknowledgements, and narrow-screen layouts with Playwright supplied externally.

### Plan stages

Stages describe when a plan should ship. Status describes its progress. Each
repository owns its ordered vocabulary in `taxonomy.milestones`; existing string
lists remain valid, and entries can include a plain-English meaning:

```js
export const taxonomy = {
  milestones: [
    { word: 'beta', meaning: 'First customers are using it while it settles.' },
    { word: 'ga', meaning: 'Available to every customer who buys it.' },
    { word: 'later', meaning: 'Parked with no stage committed.' },
  ],
};
```

A plan selects a stage with `ships: beta`. Missing or blank `ships:` is **Unset**,
separate from an explicit `later`. Runlist never assigns a stage from status.
`check` reports stage coverage and rejects malformed or unknown configured values.

```bash
runlist plans --stage beta
runlist plans --stage @unset
runlist plans --group-by stage
```

Use `word:<name>` for a literal stage named `@unset` or beginning with `word:`.
In the GUI, Library → Plans can filter/group by Stage and save that view.
A plan's Stage dropdown changes the draft; review and save publishes it through
the existing revision, ownership and recovery guards. Other document metadata
stays protected. Semantic results retain relevance order when filtered by stage.
Plan stages are available in CLI 0.92.0 and GUI 0.92.0-rc.1.

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

Ordinary status changes, including `paused`, keep the document in its current
folder. Archiving still moves it into `archived/`. Repositories that want
status-based moves can opt in with `lifecycle.filedStatuses` (for example,
`{ paused: 'held' }`) or a rich status's `filed` setting. Existing files are
not relocated when this default changes.

For unfinished session work, save the handoff and release the owned plan in one
operation:

```bash
runlist baton @<draft-file>
```

Parent handoffs use `resume-<name>`. Delegated agents explicitly use
`runlist baton --subagent <task-slug> @<draft-file>` for `subagent-<task-slug>`.
Under a parent-owned plan, use a distinct task slug that does not resolve to a
plan. A child owning a dedicated plan can pass that plan with `--subagent`.
Existing prompts keep their names. See `runlist baton --help` for prefix and
replacement checks.

To associate a child handoff with its parent, use
`runlist baton --subagent review --parent resume-session-name @<review-draft-file>`.
This saves `parent_prompt: resume-session-name`; the parent can be saved later.
`rl prompts` collapses children into a `[+N subagent]` count on
the matching `resume-*` prompt's line. Use `rl prompts --verbose` to expand their names
and target plans. Existing `subagent-*`, `agent-*`
and `session-*` names also group when they share the parent's name stem (the
longest match wins). Children without a visible parent share a separate count.
Grouping preserves consumption order and the `[NEXT]` marker; JSON stays flat.

Handoffs have editable draft outlines:

```bash
rl baton --template > <draft-file>
rl baton --subagent --template --parent resume-session-name > <review-draft-file>
# Fill Task, State, Next, Evidence, and Boundaries, then save:
rl baton --subagent review @<review-draft-file>
```

The parent travels in the draft's frontmatter, so it need not be repeated on
save. A launcher can also pass `RUNLIST_PARENT_PROMPT=resume-session-name` into
the child's environment. An explicit `--parent` wins; replacement keeps an
existing link when no new parent is supplied. Unlinked legacy saves warn with
the repair command. Template generation reads the checkout's saved Markdown
settings without executing JavaScript configuration or writing session state.
The built-in resume outline covers current work, next action, decisions and
waiting items, durable evidence, and authorization boundaries. The child outline
adds its bounded task, completion state and explicit parent. **Templates** in the
current source edits both outlines; the prompt wrapper remains a separate setting.
With the default archive layout, reopening a consumed parent with
`rl prompts show docs/prompts/archived/resume-name.md`
also shows children still pending at its former live location. Older archives
that flattened nested folders may have lost that location; historical recovery
is not inferred from similar names.

Link existing children without rewriting their handoff, archiving it, or
changing its timestamps:

```bash
rl prompts link subagent-review subagent-checks --parent resume-session-name
```

The parent must already be a pending resume prompt. Use `--dry-run` to review
the links first. Showing or consuming a parent lists its pending child handoffs
and how to inspect them; each child stays pending until explicitly consumed or
archived. A completed child should name the result for the parent to record,
with commits, verification, and a durable repository record. A temporary
scratch path alone is not a durable handoff.

Baton refuses when a handoff for the same work is already pending, so one piece
of work never has two resume prompts. Inspect the pending handoff with
`runlist prompts show <slug>`. Keep it if current; if stale, pass `--replace`
with a new draft. Baton archives the previous text and refreshes the pending
prompt in the same operation as any plan release.

Repositories with a commit wrapper can export `batonCommitCommand(message, paths)`
from `runlist.config.mjs` and return an argv array such as
`['just', 'commit', message, ...paths]`. Baton quotes the printed command and
excludes session prompts from `paths`.

Saved prompts are handoff artifacts with a project-selected Git policy (see `runlist config get promptTracking`). Consume them with `runlist use`; inspect
without consuming via `runlist prompts show`. Consuming a baton prompt also claims
its plan; `runlist use --no-claim` reads and archives it without starting the plan.
Only an agent session consumes: Claude Code, Codex, OpenCode, or a shell with
`RUNLIST_SESSION_ID` set. In a plain terminal, `runlist use` prints the body and a
closing line naming the `runlist prompts use <path>` the session runs, and leaves
the prompt pending and its plan unclaimed. So `claude "$(runlist use)"` starts a
session that consumes the prompt itself, and a session that never starts takes
nothing.

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

## Hubs, Ordered Plans, And Roadmaps

A **hub** is a Markdown document that organizes related plans and supporting
docs. Older documentation and existing filenames also call these documents
**runlists**. Hub and runlist describe the same organizing document; they are
not two successive levels. **Runlist** is also the product name.

A hub can organize an area through prose and links (**coordination hub**) or
use a `runlist:` array for an explicit plan sequence (**ordered hub**, also
called a sprint runlist). Coordination hubs can also rank plans through linked
body rows or lists. A **roadmap** is an optional hub that collects other hubs and
rolls up their progress. These are hub shapes, not three containers every
project must create. A simple arrangement is:

```text
Repository
└── Roadmap hub (optional, collects hubs)
    └── Area or ordered hub
        ├── Supporting docs
        └── Plans (optionally ordered)
            └── Tasks
```

These are document relationships, not a required folder layout. Plans and
supporting docs can also stand alone. A plan's **stage** describes when
it should ship, and its **status** describes progress; neither adds a document
level. Hubs currently use `type: plan` with hub metadata, while supporting specs,
ADRs and reference material use `type: doc` or a configured document type.

Existing commands, fields, filenames and CLI labels retain `runlist` terminology.
The `runlist:` array declares the ordered plans **on the hub itself**. It does
not create a separate runlist document inside the hub. Scaffold an ordered hub
and its child plans together:

```bash
runlist new hub auth-revamp --runlist extract,rewrite,cleanup
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

For a prose-first area map, create a coordination hub:

```bash
runlist new hub platform-work
runlist runlists
```

`runlist new hub` defaults to a coordination hub; add `--runlist a,b,c` for an
ordered hub or `--roadmap` for a roadmap hub. The existing `new plan` forms with
`--coordination`, `--runlist` or `--roadmap` create the same respective shapes.

For progress across several hubs, create an optional roadmap hub:

```bash
runlist new hub platform-roadmap --roadmap
runlist roadmap platform-roadmap
runlist roadmap platform-roadmap next
```

Roadmaps roll up progress recursively and choose the first startable plan across
their child hubs. They can also link plans directly. Hubs, including roadmaps,
are held out of actionable plan counts so dashboards do not double-count their
children.

### Product Yardstick

Optional yardstick support is included from CLI 0.94.0. The separately installed
GUI 0.92.0-rc.1 retains its earlier engine; yardstick controls in the GUI are
follow-up work. From a source checkout, use `node bin/runlist.mjs` in place of
`runlist` below.

Write your description of the finished product in an ordinary Markdown document
and opt in from repository config:

```js
export const yardstick = 'docs/product-yardstick.md';
```

Runlist reads that document's body and shows it beside a plan's literal
`delivers:` text on pickup cards. It records your judgment; it does not generate
the goal, score plans or decide which ones belong. Unset assessments are
**not yet reviewed**. The goal file must stay inside the repository; an unset
or false config disables the feature.

```bash
runlist yardstick show
runlist yardstick show docs/plans/navigation.md --json
runlist yardstick mark docs/plans/navigation.md serves
runlist yardstick fold docs/plans/old-navigation.md --into docs/plans/navigation.md --reason "Combined into navigation work." --dry-run
runlist yardstick close docs/plans/unused-navigation.md --reason "No longer needed." --dry-run
runlist yardstick clear docs/plans/navigation.md
```

**Close and fold actually archive the plan**, retaining the owner reason and
replacement link when folded. Removing `--dry-run` applies the displayed action.
Writes respect plan ownership, and archive/reference updates remain one
transaction. Replacement links are repaired when their targets move, including
with custom reference-field lists. Clearing an assessment does not reopen or
unarchive a plan. Every write supports `--dry-run` and `--json`; `--no-index`
leaves generated-index refresh to the caller.

Assessments use flat `yardstick_disposition`, `yardstick_into`,
`yardstick_reason` and `yardstick_revision` fields in plan frontmatter. After
the goal body changes, older assessments remain recorded and are labeled
**Reviewed against an earlier goal**. Goal frontmatter date edits and line-ending
changes alone do not require reassessment. `runlist check` warns about malformed
assessment fields or closed/folded metadata on live plans, and never closes
them automatically. Goal reads and assessments require no semantic provider,
local model or server. GUI controls are implemented in the source checkout:
Product goal shows the saved statement, delivery and assessment, with reviewed
Serves/Clear/Close/Fold actions and retained recovery. Structured plans display
the comparison with an explanation when assessment changes are unavailable.
These controls are included in the public desktop package.
`runlist update` updates an existing Mac app alongside the CLI and integrations.

### Plan Homes And Filing Checks

This policy is available in CLI 0.93.0. From a source checkout, invoke the
commands below as `node bin/runlist.mjs …`. The bundled GUI
The desktop app also includes a read-only Filing view. The correction
for category inheritance from status-less hub indexes is included in CLI
0.93.1.

Repositories can enable the plan-home policy in `runlist.config.mjs`:

```js
export const filing = true;
// Or choose the category heading level (default: ###):
// export const filing = { categoryDepth: 3 };
```

A home is a table row in a live hub whose **first cell links to the plan** and
whose status cell contains a recognized plan status. Explicit managed status
markers also count. Links in prose, another row's commentary, frontmatter,
order lists, or tables without statuses are references. A numbered row with
the plan in its second cell is an execution order, not a filing home.

Categories come from `###` headings by default (`categoryDepth` accepts 2–6),
or from explicit first-cell hub index rows beneath those headings. These index
rows can categorize a hub without a status column; they do not establish a
plan home or a home for its children. Categories propagate through nested hub
indexes. A plan row's own category takes precedence over inherited categories.
Hub titles do not supply an inferred category, and competing inherited mappings
stay visible. A child with no own row can inherit a home through its explicit
`parent_plan:` chain; the report names the filed ancestor and its home rows.
A child's own row takes precedence. Missing, ambiguous or cyclic parent links
do not invent a home. Hubs and archived/terminal plans are excluded from the
executable-plan totals; closed hubs do not provide current homes.

```bash
runlist check                       # filing defect counts
runlist check --verbose             # affected plans and hub:line locations
runlist check --json                # filingCoverage, including inherited homes
runlist coverage                    # plan homes, categories and locations
runlist coverage --json             # same report under filing
```

The three findings are **unfiled**, **multiply filed** (multiple rows or
categories), and **filed under no category**. Findings can overlap. These are
warnings; Runlist does not choose homes or add/remove rows. An incomplete scan
is labeled and suppresses absence/uniqueness findings. Path/type-scoped output
keeps the full hub/ancestor evidence while reporting only selected plans.
The source checkout also includes a read-only Filing view: open it to scan,
filter 50-plan pages, and inspect exact hub rows in 20-row evidence pages. Saved
edits invalidate the report. This view is included in the public desktop package.
The policy is off when `filing` is unset, false, or `{ enabled: false }`.
It can replace a repository's older “any link counts” coverage script once
that repository enables it and retires its custom check.

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

## Read a plan or long document

```bash
runlist show docs/plans/shelf.md          # card, outline and open boxes with line numbers
runlist show shelf --section "Phase 2"    # one section (-s is the short form)
runlist show shelf -s "Phase 2" --from 80 # continue at a source line
runlist show shelf --all                 # every open box (default: first 30)
runlist show shelf --card                # card only
runlist show shelf --frontmatter         # frontmatter, with long values collapsed
runlist show shelf bins --json           # cards with structured brief data in card.brief
```

Read-only: nothing is claimed. `related` is what the frontmatter names
(`related_plans`, `related_docs`, `supports_plans`, `parent_plan`, `runlist` and
the configured reference fields), each with its title and status; `links` is
every other document the body links to. The text brief caps each related/link
list at eight entries; JSON retains the full lists.

Phase headings show checklist progress as `[done/total]`; `→` marks the active
phase. Contradictory phase markers are identified, and open boxes are grouped by
phase. Headings and boxes inside code fences are ignored. Read the outline first,
then one section at a time. Section reads stop at 500 lines or 60 KB and print
the continuation command with `--from` when needed.

`runlist use <doc>` also prints this brief for documents over 500 lines or 60 KB.
Use `runlist use <doc> --full` when the whole body is needed.

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

For a short recipe for one task, request focused help:

```bash
runlist new plan --help       # also: new doc, new prompt
runlist prompts show --help   # inspect without consuming
runlist baton --subagent --help
```

The parent command's help retains the complete options and examples.

Shell completion is generated from the same command registry:

```bash
eval "$(runlist completions bash)"
eval "$(runlist completions zsh)"
```

This README intentionally documents onboarding and concepts instead of
duplicating the complete command catalog.

## Configuration

Run `runlist setup` to create `runlist.config.mjs` (a legacy `dotmd.config.mjs` is still read). A minimal typed configuration:

`runlist config show|get|set` currently supports only `promptTracking`. It reports
the effective value, source and config path. Writes accept validated values,
preserve unrelated JavaScript and hooks, and refuse symlinks, computed or ambiguous exports
with instructions for a manual edit. Other settings are edited in the JavaScript
config; the GUI is optional.

```js
export const root = 'docs';
export const archiveDir = 'archived';
export const promptTracking = 'untracked';

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

## Development checks

See [VERIFYING.md](VERIFYING.md) for local checks, qualified Git toolchains,
and the explicit compatibility and desktop qualification workflows.

## License

MIT

The reviewed [protective parser/global Git/Codex hook error changes](../../platform/docs/plans/assets/p3-hook-error-review-20261029/README.md) are applied. [Application evidence](../../platform/docs/plans/assets/p3-hook-error-review-20261029/applied/README.md) records passing guard/global/fault checks and one corrected Codex sibling-prefix fixture awaiting a focused rerun under the test limit. Intentional observers, accepted filesystem profiles and ROBOT's shared settings symlink are preserved.
