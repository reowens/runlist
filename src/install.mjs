import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bold, dim, green, yellow } from './color.mjs';
import {
  CLAUDE_MARKETPLACE, CLAUDE_PLUGIN_ID, claudeMarketplaceRefusalHint, installOpencodePlugin, opencodeDetected,
  opencodeStatus, planClaudeInstall, removeOpencodePlugin,
} from './host-integration.mjs';
import { readInstalledPlugin } from './update.mjs';
import { executableName, which } from './util.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));

const HOSTS = ['claude', 'opencode'];
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
  };
}

function reportStatus(json) {
  const states = hostStates();
  if (json) {
    process.stdout.write(JSON.stringify({ cli: pkg.version, hosts: states }, null, 2) + '\n');
    return;
  }
  const { claude, opencode } = states;
  process.stdout.write(`${bold('runlist host integrations')}  ${dim(`CLI ${pkg.version}`)}\n\n`);

  const claudeBroken = claude.installed && claude.marketplaceRegistered === false;
  const claudeState = !claude.installed ? yellow('not installed')
    : claudeBroken ? yellow(`${claude.version ?? 'installed'} — marketplace "${claude.marketplace}" not registered, plugin fails to load`)
    : green(claude.version ?? 'installed');
  process.stdout.write(`  claude    ${claudeState}\n`);
  process.stdout.write(`            ${dim(claude.installed ? claude.id : 'plugin: SessionStart primer, PreToolUse guard, workflow skill')}\n`);

  const ocState = opencode.foreign ? yellow('unmanaged file present')
    : !opencode.exists ? yellow('not installed')
    : opencode.stale ? yellow(`${opencode.version} — behind CLI ${pkg.version}`)
    : green(opencode.version);
  process.stdout.write(`  opencode  ${ocState}\n`);
  process.stdout.write(`            ${dim(opencode.path)}\n`);

  const todo = [];
  if (!claude.installed || claudeBroken) todo.push('runlist install claude');
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

function installClaude(argv, dryRun, json) {
  const remove = argv.includes('--remove');
  const steps = planClaudeInstall({ installed: readInstalledPlugin(), hasClaude: which('claude'), remove });
  if (json) {
    process.stdout.write(JSON.stringify({ host: 'claude', dryRun, steps }, null, 2) + '\n');
    return;
  }
  let ran = false;
  for (const step of steps) {
    if (step.kind === 'skip') { process.stdout.write(`${dim('skip:')} ${step.reason}\n`); continue; }
    if (step.kind === 'manual') {
      process.stdout.write(`${yellow(step.reason ?? 'claude CLI not on PATH')} — run these from a Claude Code session:\n`);
      for (const line of step.lines) process.stdout.write(`  ${bold(line)}\n`);
      continue;
    }
    if (step.reason) process.stdout.write(`${step.reason}\n`);
    if (dryRun) { process.stdout.write(dim(`[dry-run] Would run: ${step.cmd.join(' ')}\n`)); continue; }
    process.stdout.write(dim(`$ ${step.cmd.join(' ')}\n`));
    const result = spawnSync(executableName(step.cmd[0]), step.cmd.slice(1), {
      stdio: 'inherit', shell: process.platform === 'win32',
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
  if (ran && !remove) process.stdout.write(green('\n✓ restart Claude Code (or /reload-plugins) to apply.\n'));
}

function installOpencode(argv, dryRun, json) {
  const force = argv.includes('--force');
  const dir = flagValue(argv, '--path');
  const result = argv.includes('--remove')
    ? removeOpencodePlugin({ dryRun, force, dir })
    : installOpencodePlugin({ version: pkg.version, dryRun, force, dir });

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
      process.stdout.write(`${prefix}${green('✓')} ${result.action} opencode integration (${pkg.version})\n${dim(result.path)}\n`);
      if (dryRun) return result;
      process.stdout.write('\nRestart OpenCode to apply. New sessions then get:\n');
      process.stdout.write(`  ${dim('·')} a per-session ownership identity (one session can no longer release another's plan)\n`);
      process.stdout.write(`  ${dim('·')} the ${bold('runlist hud')} primer at session start, like Claude Code's SessionStart hook\n`);
      process.stdout.write(dim('\nPlans already in-session were claimed under the old process-scoped identity;\n'));
      process.stdout.write(dim('close them before restarting, or reclaim with --force afterwards.\n'));
      return result;
  }
}

export function runInstall(argv, _config, opts = {}) {
  const json = argv.includes('--json');
  const requested = argv.find(a => !a.startsWith('-'));

  if (!requested) { reportStatus(json); return; }
  const host = ALIASES[requested] ?? requested;
  if (!HOSTS.includes(host)) {
    process.stderr.write(`Unknown host "${requested}". Known: ${HOSTS.join(', ')}\n`);
    process.exitCode = 1;
    return;
  }

  const dryRun = Boolean(opts.dryRun);
  if (host === 'claude') { installClaude(argv, dryRun, json); return; }
  installOpencode(argv, dryRun, json);
}
