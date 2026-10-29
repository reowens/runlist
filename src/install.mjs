import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bold, dim, green, yellow } from './color.mjs';
import {
  CLAUDE_MARKETPLACE, CLAUDE_PLUGIN_ID, claudeMarketplaceRefusalHint, installOpencodePlugin, opencodeDetected,
  opencodeStatus, planClaudeInstall, removeOpencodePlugin,
} from './host-integration.mjs';
import { LEGACY_PLUGIN_ID, readInstalledPlugin, readInstalledPluginRecords } from './update.mjs';
import { executableName, which } from './util.mjs';
import { installationReport, formatInstallationReport, persistentCliOnPath, PERSISTENT_CLI_WARNING } from './installation.mjs';
import { codexStatus, installCodexPlugin, installedCodexStatus } from './codex-integration.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));

const CLAUDE_CODE_SETUP_URL = 'https://code.claude.com/docs/en/setup';
const HOSTS = ['claude', 'codex', 'opencode'];
const ALIASES = { 'claude-code': 'claude', claudecode: 'claude' };

function flagValue(argv, name) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

function hostStates() {
  const plugin = readInstalledPlugin();
  return {
    claude: {
      installed: Boolean(plugin),
      version: plugin?.version ?? null,
      id: plugin?.id ?? CLAUDE_PLUGIN_ID,
      marketplace: plugin?.marketplace ?? null,
      // false = record present, marketplace gone: Claude shows "failed to load".
      marketplaceRegistered: plugin ? plugin.marketplaceRegistered : null,
    },
    opencode: { ...opencodeStatus({ version: pkg.version }), detected: opencodeDetected() },
    codex: codexStatus({ version: pkg.version }),
  };
}

function reportStatus(json, config) {
  const states = hostStates(), installations = installationReport(config);
  if (json) {
    process.stdout.write(JSON.stringify({ cli: pkg.version, hosts: states, installations }, null, 2) + '\n');
    return;
  }
  process.stdout.write(formatInstallationReport(installations)+'\n');
  const { claude, codex, opencode } = states;
  process.stdout.write(`${bold('runlist host integrations')}  ${dim(`CLI ${pkg.version}`)}\n\n`);

  const claudeBroken = claude.installed && claude.marketplaceRegistered === false;
  const claudeState = !claude.installed ? yellow('not installed')
    : claudeBroken ? yellow(`${claude.version ?? 'installed'} — marketplace "${claude.marketplace}" not registered, plugin fails to load`)
    : green(claude.version ?? 'installed');
  process.stdout.write(`  claude    ${claudeState}\n`);
  process.stdout.write(`            ${dim(claude.installed ? claude.id : 'plugin: SessionStart primer, PreToolUse guard, workflow skill')}\n`);

  const codexState = codex.foreign ? yellow('unmanaged directory present')
    : !codex.exists ? yellow('not installed')
    : codex.stale ? yellow(`${codex.version} — behind CLI ${pkg.version}`)
    : green(codex.version);
  process.stdout.write(`  codex     ${codexState}\n`);
  process.stdout.write(`            ${dim(codex.plugin)}\n`);

  const ocState = opencode.foreign ? yellow('unmanaged file present')
    : !opencode.exists ? yellow('not installed')
    : opencode.stale ? yellow(`${opencode.version} — behind CLI ${pkg.version}`)
    : green(opencode.version);
  process.stdout.write(`  opencode  ${ocState}\n`);
  process.stdout.write(`            ${dim(opencode.path)}\n`);

  const todo = [];
  if (!claude.installed || claudeBroken) todo.push('runlist install claude');
  if (!codex.exists || codex.stale) todo.push('runlist install codex');
  if (!opencode.exists || opencode.stale) todo.push('runlist install opencode');
  if (todo.length) {
    process.stdout.write('\n');
    for (const cmd of todo) process.stdout.write(`Run ${bold(cmd)}\n`);
  }
  if (!opencode.exists) {
    process.stdout.write(dim('\nWithout the OpenCode integration, every session in one OpenCode process\n'));
    process.stdout.write(dim('shares one identity — so a session can release another session\'s plan —\n'));
    process.stdout.write(dim('and no session-start primer runs.\n'));
  }
}

function installCodex(argv, dryRun, json, prerequisites) {
  if (argv.includes('--remove')) {
    process.stderr.write('Codex removal is managed by `codex plugin remove`; the personal marketplace source is left available.\n');
    process.exitCode = 1;
    return;
  }
  const result = { ...installCodexPlugin({ version: pkg.version, dryRun }), ...prerequisites };
  if (result.action === 'refused') {
    if (json) process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    else process.stderr.write(`refused: ${result.reason}\n`);
    process.exitCode = 1;
    return;
  }
  if (!json) {
    const action = dryRun ? ({ installed: 'Would install', updated: 'Would update', current: 'Already current' }[result.action] ?? result.action) : result.action;
    process.stdout.write(`${dryRun ? '[dry-run] ' : ''}${action} codex integration (${pkg.version}) at ${result.plugin}\n`);
  }
  if (dryRun) {
    if (json) process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    return;
  }
  const selector = `runlist-codex@${result.marketplaceName}`;
  if (!which('codex')) {
    if (json) process.stdout.write(JSON.stringify({ ...result, pluginAdd: 'codex-cli-unavailable' }, null, 2) + '\n');
    else process.stdout.write(`Install in Codex with: codex plugin add ${selector}\n`);
    return;
  }
  const added = spawnSync(executableName('codex'), ['plugin', 'add', selector], {
    stdio: json ? 'pipe' : 'inherit', encoding: json ? 'utf8' : undefined,
    shell: process.platform === 'win32',
  });
  const installed = added.status === 0 ? installedCodexStatus() : { ok: false, reason: added.error?.message ?? `codex plugin add exited ${added.status ?? '?'}` };
  const verified = installed.ok && installed.version === pkg.version;
  if (json) process.stdout.write(JSON.stringify({ ...result, pluginAdd: verified ? 'installed' : 'failed', pluginAddExit: added.status,
    installedVersion: installed.version ?? null, ...(!verified ? { reason: installed.reason ?? `Codex has ${installed.version}, expected ${pkg.version}` } : {}) }, null, 2) + '\n');
  if (!verified) {
    process.stderr.write(`Codex plugin installation is unverified: ${installed.reason ?? `has ${installed.version}, expected ${pkg.version}`}. Retry: codex plugin add ${selector}\n`);
    process.exitCode = 1;
  } else if (!json) {
    process.stdout.write('Start a new Codex thread and review/trust the plugin hooks to enable the primer and guard.\n');
  }
}

function installClaude(argv, dryRun, json, opts = {}, prerequisites = {}) {
  const remove = argv.includes('--remove');
  const steps = planClaudeInstall({ installed: readInstalledPlugin(), legacyInstalled: readInstalledPluginRecords({ id: LEGACY_PLUGIN_ID, ...(process.env.CLAUDE_CONFIG_DIR ? { configDir: process.env.CLAUDE_CONFIG_DIR } : {}) }), hasClaude: opts.claudeBin || which('claude'), remove });
  if (json) {
    process.stdout.write(JSON.stringify({ host: 'claude', dryRun, steps, ...prerequisites }, null, 2) + '\n');
    return;
  }
  let ran = false;
  for (const step of steps) {
    if (step.kind === 'skip') { process.stdout.write(`${dim('skip:')} ${step.reason}\n`); continue; }
    if (step.kind === 'refusal') {
      process.stdout.write(yellow(`${step.reason}\n`));
      if (!dryRun) process.exitCode = 1;
      continue;
    }
    if (step.kind === 'manual') {
      if (step.lines.some(line => line.startsWith('/plugin install'))) {
        // Newcomers mostly land here from Claude Desktop with no `claude` command, so lead with
        // the documented terminal form. Desktop's plugin browser only lists marketplaces that are
        // already registered, so it is where to find runlist afterwards, not where to add it.
        process.stdout.write(`${step.reason ? `${step.reason}. ` : ''}${yellow('The claude CLI is not on PATH.')} Install the Claude Code CLI (${CLAUDE_CODE_SETUP_URL}), then run in a terminal:\n`);
        for (const line of step.lines) process.stdout.write(`  ${bold(line.replace(/^\/plugin /, 'claude plugin '))}\n`);
        process.stdout.write('Or run these from inside a Claude Code session:\n');
        for (const line of step.lines) process.stdout.write(`  ${bold(line)}\n`);
        process.stdout.write(dim('Claude Desktop\'s Code tab reads the same plugin settings as the terminal. Once the marketplace is added, runlist appears under Code tab → + → Add plugins.\n'));
        continue;
      }
      process.stdout.write(`${yellow(step.reason ?? 'claude CLI not on PATH')} — run these from a Claude Code session:\n`);
      for (const line of step.lines) process.stdout.write(`  ${bold(line)}\n`);
      continue;
    }
    if (step.reason) process.stdout.write(`${step.reason}\n`);
    if (dryRun) { process.stdout.write(dim(`[dry-run] Would run: ${step.cmd.join(' ')}${step.cwd ? ` (in ${step.cwd})` : ''}\n`)); continue; }
    process.stdout.write(dim(`$ ${step.cmd.join(' ')}${step.cwd ? ` (in ${step.cwd})` : ''}\n`));
    const result = spawnSync(opts.claudeBin || executableName(step.cmd[0]), step.cmd.slice(1), {
      stdio: 'inherit', shell: process.platform === 'win32' && !opts.claudeBin,
      ...(step.cwd ? { cwd: step.cwd } : {}),
    });
    ran = true;
    if (result.status !== 0) {
      process.stdout.write(yellow(`(claude exited ${result.status ?? '?'})\n`));
      // Each later step here depends on this one (the plugin resolves through
      // the marketplace), so unlike `update` there is nothing independent left.
      if (step.step === 'marketplace' || step.cmd.includes('marketplace')) {
        for (const line of claudeMarketplaceRefusalHint(readInstalledPlugin()?.marketplace)) process.stdout.write(yellow(`${line}\n`));
      }
      process.exitCode = 1;
      return;
    }
  }
  if (ran && !remove && !process.exitCode) process.stdout.write(green('\n✓ restart Claude Code (or /reload-plugins) to apply.\n'));
}

function installOpencode(argv, dryRun, json, prerequisites) {
  const force = argv.includes('--force');
  const dir = flagValue(argv, '--path');
  const result = { ...(argv.includes('--remove')
    ? removeOpencodePlugin({ dryRun, force, dir })
    : installOpencodePlugin({ version: pkg.version, dryRun, force, dir })), ...prerequisites };

  if (json) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    if (result.action === 'refused') process.exitCode = 1;
    return result;
  }

  const prefix = dryRun ? dim('[dry-run] ') : '';
  switch (result.action) {
    case 'refused':
      process.stderr.write(`${result.path}\n  refused: ${result.reason}\n  Pass --force to overwrite it.\n`);
      process.exitCode = 1;
      return result;
    case 'current':
      process.stdout.write(`${green('✓')} opencode integration already current (${result.version})\n${dim(result.path)}\n`);
      return result;
    case 'absent':
      process.stdout.write(`${dim('nothing to remove:')} ${result.path}\n`);
      return result;
    case 'removed':
      process.stdout.write(`${prefix}removed ${result.path}\n`);
      process.stdout.write(dim('Restart OpenCode to apply. Sessions fall back to a process-scoped identity.\n'));
      return result;
    default:
      process.stdout.write(`${prefix}${dryRun ? ({ installed: 'Would install', updated: 'Would update' }[result.action] ?? result.action) : `${green('✓')} ${result.action}`} opencode integration (${pkg.version})\n${dim(result.path)}\n`);
      if (dryRun) return result;
      process.stdout.write('\nRestart OpenCode to apply. New sessions then get:\n');
      process.stdout.write(`  ${dim('·')} a per-session ownership identity (one session can no longer release another's plan)\n`);
      process.stdout.write(`  ${dim('·')} the ${bold('runlist hud')} primer at session start, like Claude Code's SessionStart hook\n`);
      process.stdout.write(dim('\nIf plans were claimed under a previous process-scoped identity, close them before restarting or explicitly reclaim them afterwards.\n'));
      return result;
  }
}

export function runInstall(argv, _config, opts = {}) {
  const json = argv.includes('--json');
  const requested = argv.find(a => !a.startsWith('-'));

  if (!requested) { reportStatus(json, _config); return; }
  const host = ALIASES[requested] ?? requested;
  if (!HOSTS.includes(host)) {
    process.stderr.write(`Unknown host "${requested}". Known: ${HOSTS.join(', ')}\n`);
    process.exitCode = 1;
    return;
  }

  const dryRun = Boolean(opts.dryRun);
  const persistentCliMissing = !argv.includes('--remove') && !persistentCliOnPath().available;
  const prerequisites = persistentCliMissing ? { persistentCliMissing: true } : {};
  if (persistentCliMissing && !json) process.stderr.write(`Warning: ${PERSISTENT_CLI_WARNING}\n`);
  if (host === 'claude') { installClaude(argv, dryRun, json, opts, prerequisites); return; }
  if (host === 'codex') { installCodex(argv, dryRun, json, prerequisites); return; }
  installOpencode(argv, dryRun, json, prerequisites);
}
