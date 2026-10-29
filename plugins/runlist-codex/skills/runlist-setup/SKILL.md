---
name: runlist-setup
description: Set up Runlist planning in a project, including before any Runlist config exists or after handoffs-only use. Use when asked to install, initialize, onboard, turn on planning, or adopt existing project docs into Runlist. Use the runlist skill for ordinary plan, doc, and prompt work after setup.
---

# Runlist project setup

Setup is for planning. Session handoffs need none: if the user only wants to
save where they are and pick it up later, do not run setup; the first
`runlist baton <slug> @<draft-file>` in a Git repository writes a handoffs-only
`runlist.config.mjs`. In a handoffs-only project (`runlist plans` says planning
is off), setup turns planning on: it rewrites that config's `mode` and `root`,
adds plans and an index, and keeps the saved prompts where they are.

Turn the user's requested choices into a reviewed `runlist setup` preview and
apply the authorized changes. Ask only for missing preferences that affect the
requested outcome; honor explicit choices and authorization already given.
For "show me first" or preview-only requests, return the preview without applying.

Inspect the actual shell, working directory, checkout, config, and executable
paths first. In Bash/Zsh, `type -a runlist rl node npm claude codex opencode`
reveals competing installations; use `Get-Command ... -All` in PowerShell.
Resolve aliases, Node/npm scope, and the intended Claude binary when several
copies exist. Do not install or update an agent host to resolve a path mismatch.
For the Runlist CLI, use the executable selected by the current shell unless
the user chose another; report its path. Several installed copies alone do not
require a new user decision.

With no suitable shell or checkout access, supply concrete terminal instructions
and leave execution outstanding. Bootstrap the CLI with `npm install -g runlist`
or the user's chosen project scope (`npm install -D runlist`, then
`npx runlist setup`); `npx runlist setup` is also an ephemeral bootstrap. Host
hooks still need a persistent CLI on their `PATH`. Execute installations only
within the authorized scope. A plugin skill is unavailable before that
plugin is installed and loaded; do not claim an unavailable skill was invoked.

Claude Desktop Chat, Cowork, and Claude Code are different execution surfaces.
Inspect the actual tools: Cowork may use a cloud sandbox or a local VM; Claude
Code and Codex may run locally or remotely. Local-folder access alone does not
prove the shell runs on the user's computer. A remote npm success affects that
environment, not a local CLI, host, or GUI. This plugin provides no Desktop Chat
execution bridge. If local setup is needed, give commands for a local terminal.

Use `runlist setup` rather than rebuilding onboarding from unrelated verbs:

- Preview with `runlist setup <explicit-options> --dry-run --json`; inspect the
  proposed paths, policy, adoption, host install, and findings. With no `--yes`,
  noninteractive setup previews without writing or waiting. An interactive
  terminal collects choices and confirms the concrete preview. `--dry-run`
  previews even when `--yes` is present.
- Apply the same reviewed options with `--yes` when covered by the user's
  authorization. Ask only about choices or side effects not already authorized;
  do not impose another blanket confirmation. `--yes` applies explicit flags and
  defaults; it does not license additional installations or repairs.
- Fresh defaults: relative `docs/` root, `--prompt-tracking untracked`, no ignore
  edits, `--host none`, no first plan, no adoption. `untracked` is not ignored:
  `git add -A` can include prompts. Alternatives are `tracked` and `local`.
  Preserve existing policy absent an explicit selection. `--gitignore` is opt-in.
  Requests to leave prompts out of routine commits or reduce commit churn select
  the `untracked` recommendation; use `local` for an explicit request to deny
  prompt Git operations through agent guards. Neither policy makes files ignored
  or prevents manual Git operations outside those guards.
- A fresh project may choose `--docs-root <relative-path>`. Preserve existing
  configured roots, JavaScript, and hooks. If a different existing root is
  requested, explain setup's refusal and the manual config/path review needed;
  do not replace the config or move docs to force success.
- Adopt only user-selected files with repeatable `--adopt <path>`, previewing
  their frontmatter changes before apply. Never blanket-tag existing docs.
- Fresh setup carries runlist prompts and plans saved before configuration,
  including archives, into the new folders by default. This finishes the
  scaffold rather than tagging existing documents: only valid runlist
  type/status files in the pre-config output folders qualify. Review each move;
  references and local handoff/ownership state move with it. Foreign files and
  destination collisions stay put and are reported. `--no-carry-prompts` opts
  out for both prompts and plans. Existing configured projects never carry over.
- Create a first plan only when requested: `--first-plan <slug>` requires
  meaningful, user-supplied `--current-state <text>` (cap 1,500 characters) and
  `--next-step <text>` (cap 800). Ask for missing facts; never invent progress,
  use placeholders, or disable validation. Keep longer detail in the plan body.
  Derive the slug from the requested plan title. The user's stated current state
  and next action are sufficient to preview that plan: save them as metadata.
  Creating a plan does not authorize executing its next action or inspecting a
  different checkout to prove the user's description. Include all requested
  plan fields in the preview and in any later apply command.
  For example, "first plan: text export; today only JSON works; next review the
  exporter" becomes `--first-plan text-export --current-state 'Only JSON export
  works' --next-step 'Review the exporter' --dry-run --json`. Those facts are
  already supplied; do not ask for them again or start the export work.
- Only explicit `--host claude|codex|opencode` plus apply authorizes the existing
  integration installer. Host `none` is the default. Setup never downloads the
  Runlist GUI. If requested separately, the supported Mac path is
  `runlist desktop install`, then `runlist desktop`; respect the execution location.

Report **completed**, **outstanding**, and **failed** separately, with paths and
concrete next actions. Setup's **notes** are information, not remaining work;
mention them without counting them as outstanding. Keep pre-existing untagged docs, unavailable tools, and
host activation/trust/reload steps visible. Use `runlist check` and read-only
`runlist doctor` findings as follow-up evidence; do not silently run broad
repairs. CLI/plugin files present do not prove hooks or skills loaded in a
running or future host session. Once configured, route ongoing work to the
ordinary `runlist` workflow skill.

Setup adoption also previews any missing project scaffold directories. A setup
preview validates proposed changes; it does not run the whole-project check that
apply runs. Existing document errors can therefore produce an `attention` result
and exit 1 after the selected changes apply successfully.
