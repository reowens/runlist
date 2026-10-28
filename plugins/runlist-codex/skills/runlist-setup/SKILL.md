---
name: runlist-setup
description: Set up Runlist in a project, including before any Runlist config exists. Use when asked to install, initialize, onboard, or adopt existing project docs into Runlist. Use the runlist skill for ordinary plan, doc, and prompt work after setup.
---

# Runlist project setup

Turn the user's requested choices into a reviewed `runlist setup` preview and
apply the authorized changes. Ask only for missing preferences that affect the
requested outcome; honor explicit choices and authorization already given.

Inspect the actual shell, working directory, checkout, config, and executable
paths first. In Bash/Zsh, `type -a runlist rl node npm claude codex opencode`
reveals competing installations; use `Get-Command ... -All` in PowerShell.
Resolve aliases, Node/npm scope, and the intended Claude binary when several
copies exist. Do not install or update an agent host to resolve a path mismatch.

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
- A fresh project may choose `--docs-root <relative-path>`. Preserve existing
  configured roots, JavaScript, and hooks. If a different existing root is
  requested, explain setup's refusal and the manual config/path review needed;
  do not replace the config or move docs to force success.
- Adopt only user-selected files with repeatable `--adopt <path>`, previewing
  their frontmatter changes before apply. Never blanket-tag existing docs.
- Create a first plan only when requested: `--first-plan <slug>` requires
  meaningful, user-supplied `--current-state <text>` (cap 1,500 characters) and
  `--next-step <text>` (cap 800). Ask for missing facts; never invent progress,
  use placeholders, or disable validation. Keep longer detail in the plan body.
- Only explicit `--host claude|codex|opencode` plus apply authorizes the existing
  integration installer. Host `none` is the default. Setup never downloads the
  Runlist GUI. If requested separately, the supported Mac path is
  `runlist desktop install`, then `runlist desktop`; respect the execution location.

Report **completed**, **outstanding**, and **failed** separately, with paths and
concrete next actions. Keep pre-existing untagged docs, unavailable tools, and
host activation/trust/reload steps visible. Use `runlist check` and read-only
`runlist doctor` findings as follow-up evidence; do not silently run broad
repairs. CLI/plugin files present do not prove hooks or skills loaded in a
running or future host session. Once configured, route ongoing work to the
ordinary `runlist` workflow skill.
