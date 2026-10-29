# Get started with Runlist

Runlist manages Markdown plans, docs and saved prompts in a project folder.
If all you want is session handoffs (save where you are, pick it up next time),
you need no setup: install the CLI and plugin
([three-step quick path](README.md#handoffs-in-3-steps)) and say "baton" in a
Claude Code session in your project's Git repository. The first handoff writes a
handoffs-only `runlist.config.mjs` and keeps handoffs in `docs/prompts/` (outside Git, or in a home directory that is a
repository, it refuses; a project with a config works outside Git as before, and
other Markdown in the prompt folder is left alone). This guide covers setup, which turns on
planning: plans, docs and a generated index. The CLI works without a GUI. **Runlist desktop** is an optional document app;
**Claude Desktop** is a separate product that may host your assistant.

This guide tracks the repository source. npm installs the latest published
release, which may lag development. If your installed CLI lacks `setup` or
`config`, use the [source-review instructions](README.md#checkout-review-and-migration) to try the
current source, or wait for the next release. A matching version number alone
is not proof that an installed copy contains unreleased changes.

## 1. Choose where to install the CLI

Open a terminal on the computer where your project and assistant will run.
You need Node.js 20 or newer for the CLI. Check `node --version` and
`npm --version`, then install a persistent CLI:

```bash
npm install -g runlist
cd /path/to/your/project
runlist --version
```

`rl` is a short alias; `dotmd` is the legacy alias. They run the same CLI.
Global npm installations belong to the selected Node installation. Switching
Node versions can change which Runlist copy your shell finds.

Alternatively, install into the project with `npm install -D runlist` and use
`npx --no-install runlist setup` from that project. `npx runlist setup` can
bootstrap without a permanent installation. Agent hooks need a persistent
`runlist` executable on the PATH of the host process; an ephemeral npx run does
not provide that. npm installs neither agent integrations nor the desktop app.

## 2. Preview and apply project setup

Setup is for planning. In a project that already saved handoffs, setup turns
planning on: it rewrites the handoffs-only config's `mode`, widens its `root`
from `docs/prompts` to `docs`, adds `docs/plans/` and the index, and leaves the
saved prompts where they are. The preview shows the config before and after,
and counts the existing Markdown under `docs/` that planning will start
checking.

Prompts and plans that an older runlist saved before any config existed are
carried into the new folders when setup writes the first config, or turns
planning on in a project that saved handoffs, with their references and local
handoff/ownership state fixed. Foreign files stay put. Preview lists each move,
and `--no-carry-prompts` leaves these artifacts in place instead.

Run this inside the intended project folder:

```bash
runlist setup
```

In a terminal, choose the docs folder, prompt policy and optional actions, then
review and confirm the preview. A new project defaults to `docs/`, prompt policy
`untracked`, no ignore edits, no host install, no example plan and no adoption.
Existing projects retain their configured folders, hooks and prompt policy.

For a predictable preview without questions:

```bash
runlist setup --docs-root docs --prompt-tracking untracked --host none --dry-run --json
```

For a new project, apply those same choices with:

```bash
runlist setup --docs-root docs --prompt-tracking untracked --host none --yes --json
```

`--dry-run` always previews, even with `--yes`. Without `--yes`, noninteractive
setup previews without writing or waiting. `--json` also avoids interactive
questions. A different `--docs-root` is refused for an already configured
project; inspect the existing layout instead of moving its files automatically.

`untracked` recommends leaving saved prompts out of routine commits to reduce
churn. **It does not ignore them: `git add -A` can still stage prompts.**
(Runtime state in `.runlist/` hides itself with its own `.gitignore`.) Stage
intended files by path. `tracked` allows
prompt commits; `local` denies prompt Git operations through connected agent
guards, but cannot intercept arbitrary manual Git. Existing configs without
an explicit choice retain the legacy `local` policy.

No choice changes ignore files by default. To request ignore rules explicitly,
preview `runlist setup --gitignore --dry-run` and inspect the paths first.
Changing prompt policy does not move, stage, untrack or delete existing files.

## 3. Add your first plan or selected existing docs

Use your real current state and next action. For example:

```bash
runlist setup --first-plan text-export --current-state "Only JSON export works today." --next-step "Inspect the exporter and decide which fields belong in text output." --dry-run --json
```

After reviewing, rerun with `--yes` in place of `--dry-run`. This creates the
plan; it does not execute its next step. State is limited to 1,500 characters
and next step to 800; longer details belong in the plan body.

For an existing file inside your configured root, preview just that adoption:

```bash
runlist setup --adopt docs/notes/design.md --dry-run
```

Replace the path with a file that actually exists. Review its frontmatter diff,
then rerun with `--yes` to apply. Other docs are not adopted. Setup also previews
missing scaffold directories. Preview success does not mean the whole project
passes checks: apply runs a whole-project check and can return `attention`
(exit 1) after selected changes succeed because other documents still need work.
Read **completed**, **outstanding**, and **failed** before retrying. A **notes**
section, when present, is information (for example, why prompts stay untracked),
not work left to do.

### Ask your assistant instead

Copy this request and replace the project facts:

> Help me set up Runlist in this project. First check which computer and checkout
> your shell accesses and which Runlist CLI it selects. Use the current project
> layout, or docs/ for a new project. Leave prompts untracked to reduce commit
> churn, without editing ignore files. Make my first plan “text export”: today
> only JSON export works; next inspect the exporter and choose the text fields.
> Show me the setup preview first. Do not install an agent integration or GUI,
> adopt other docs, or start the plan work.

“Show me first” authorizes a preview. To execute the reviewed choices, ask the
assistant to apply them. If you already authorize preview and apply in your
request, it can complete both without another blanket confirmation. The
`runlist-setup` skill is discoverable only after its host plugin is installed
and loaded; an assistant without that plugin can follow this guide directly.

## 4. Connect your agent, if wanted

Project setup and agent installation are separate. Install only the integration
for the host you actually use:

| Host | Runlist command | Still to do |
| --- | --- | --- |
| Claude Code | `runlist install claude` | Review host trust/enablement; reload plugins or start a new session. |
| Codex | `runlist install codex` | Review hook trust and start a new thread. |
| OpenCode | `runlist install opencode` | Restart the host so it loads the generated integration. |

These commands install Runlist integrations, not the agent programs themselves.
See the [host setup reference](README.md#agent-host-setup) for account/profile
choices and host-specific activation. If multiple Claude copies exist, inspect
`runlist doctor --hosts` before repairs; preserve account wrappers and target
the intended profile rather than guessing a different native executable.
Claude's [plugin documentation](https://code.claude.com/docs/en/discover-plugins)
describes installation, trust and reload behavior.

For **Claude Desktop Chat**, this package supplies no Runlist execution bridge.
Use a local terminal when the conversation has no suitable shell. In **Cowork**,
inspect the actual shell and folder access. In **Claude Code on desktop**, choose
the intended project and execution environment; it can use a remote machine.
A successful npm install in a remote shell changes that remote environment,
not your laptop. See [Claude Code on desktop](https://code.claude.com/docs/en/desktop)
and the [host routes](README.md#which-assistant-can-run-setup).

### Save where you are, pick it up later

With the Claude Code plugin installed, stopping and resuming takes two phrases,
with or without setup. When you are done for now, say "baton" or "save where we
are" (or type `/runlist:baton`); the assistant writes a short resume note, called a
*baton*, into your project.
In the next session, type `/runlist:pickup` or say "pick up where we left off". The
[three-step quick path](README.md#handoffs-in-3-steps) has the install commands.

## 5. Inspect settings and verify what finished

```bash
runlist config show
runlist config get promptDirectory --json
runlist plans
runlist check
runlist doctor --hosts
```

Settings inspection reports the actual config file and effective roots, index,
archive directory, prompt location and prompt policy. Sources are `config`,
`default`, `legacy-readme` (the old index alias), `legacy-default` (old prompt
policy), or `derived` (resolved paths). No GUI is required. These commands import
your trusted project's JavaScript config; inspection does not invoke its hooks.

Only prompt policy supports CLI edits:

```bash
runlist config set promptTracking tracked --dry-run
runlist config set promptTracking tracked
```

Other `config set` keys give a specific manual-edit path instead of rewriting
JavaScript. CLI and GUI use the same project configuration; no second GUI policy
copy is needed. Markdown template content can also live in `runlist.templates.json`.

Before calling onboarding complete, verify:

- The CLI resolves in the intended terminal and host environment.
- The setup report lists the chosen project changes as completed.
- Unadopted documents and check findings are understood.
- The selected host's trust/reload steps are completed in a fresh session.
- Your Git staging matches the prompt policy you chose.

`doctor --hosts` is offline and read-only by default. Files present on disk do
not prove a running session loaded them. Repair previews require a named
`--repair <host>`; writes additionally require `--apply`. `update --check` is
also offline and does not query whether a newer version is published.
`runlist update` updates the CLI and existing integrations; it may also update
an existing Mac app. Use `runlist update --host claude` (or `codex`/`opencode`)
to restrict an integration update. Reload/trust remains a host step afterward.

## Optional: install Runlist desktop

The current native download is for Apple Silicon Macs running macOS 13.5 or
newer. To install without npm, open the
[desktop releases](https://github.com/reowens/runlist/releases?q=desktop), select
the desired Mac release, download its DMG, open it and copy Runlist to
Applications. The app bundles its engine and runtime; Node and the global CLI
are not required for this route. Choose your project folder in the app.

If you already have the CLI on a supported Mac, use `runlist desktop install`,
then `runlist desktop`. Preview the installer without downloading or changing
files with `runlist desktop install --dry-run`.

There is one npm CLI package and a separate native GUI download; no additional
GUI npm package is needed. CLI-only setup never downloads the GUI. Windows,
Linux and Intel Mac GUI installation is not offered by this installer. See
[desktop details](README.md#optional-desktop-gui).

## If something is unfinished

| Symptom | Next action |
| --- | --- |
| `runlist` is missing or an unexpected version runs | Check `type -a runlist rl node npm` in Bash/Zsh or `Get-Command runlist,rl,node,npm -All` in PowerShell; inspect the selected Node/npm scope. |
| `setup` or `config` is unknown | Your published copy may predate these source changes; see release availability at the top of this guide. |
| Setup exits 1 after writing files | Read completed actions and whole-project findings. Correct the named issue; do not erase the config or blindly rerun the first-plan command. |
| First plan already exists | Inspect it with `runlist show <path>` and omit `--first-plan` on later setup runs. |
| Existing root change is refused | Inspect `runlist config show`; review the root/index/template exports manually. Setup does not migrate existing files. |
| Plugin files exist but the skill is missing | Check enablement, host trust and reload in the actual host; offline doctor cannot attest loading. |
| Doctor cannot map a Claude wrapper to a profile | Use the listed explicit-target preview or resolve the account/profile choice; do not bypass the wrapper automatically. |
| Your assistant only has a remote shell | Run laptop setup in a laptop terminal; remote success does not install local software. |
