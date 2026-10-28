import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import * as inventory from './agent-hosts.mjs';
import { shellQuote } from './util.mjs';
import { sanitizeTelemetryText } from './journal.mjs';
import { installationReport } from './installation.mjs';

const HOSTS = ['claude', 'codex', 'opencode'];
const valueFlags = new Set(['--repair', '--claude-config', '--claude-bin']);
const flags = new Set(['--hosts', '--json', '--apply', '--yes']);

export function hostDoctorOptions(argv, { dryRun = false } = {}) {
  const options = { repairs: [], claudeConfigDirs: [], claudeBin: undefined, json: false, apply: false, dryRun };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (flags.has(arg)) {
      if (arg === '--json') options.json = true;
      if (arg === '--apply' || arg === '--yes') options.apply = true;
      continue;
    }
    if (!valueFlags.has(arg) || !argv[i + 1] || argv[i + 1].startsWith('--')) {
      throw new Error(`Unsupported host diagnostic argument: ${arg}. Use doctor --hosts [--repair <host>] [--apply] [--json].`);
    }
    const value = argv[++i];
    if (arg === '--repair') {
      if (!HOSTS.includes(value)) throw new Error('--repair must name claude, codex, or opencode. Repeat it to select more hosts.');
      options.repairs.push(value);
    } else if (arg === '--claude-config') {
      if (!path.isAbsolute(value)) throw new Error('--claude-config requires an absolute profile directory.');
      options.claudeConfigDirs.push(path.resolve(value));
    } else {
      if (options.claudeBin) throw new Error('--claude-bin may be supplied once.');
      options.claudeBin = path.resolve(value);
    }
  }
  options.repairs = [...new Set(options.repairs)];
  options.claudeConfigDirs = [...new Set(options.claudeConfigDirs)];
  if (options.apply && !options.repairs.length) throw new Error('doctor --hosts --apply requires explicitly selected --repair <host> targets.');
  return options;
}

function commandFor(action, options) {
  const argv = ['runlist', 'doctor', '--hosts', '--repair', action.host, '--apply'];
  if (action.configDir) argv.push('--claude-config', action.configDir);
  if (options.claudeBin) argv.push('--claude-bin', options.claudeBin);
  return argv;
}

export function planHostRepairs(report, options) {
  const actions = [];
  for (const host of options.repairs) {
    const info = report.hosts[host], executable = report.executables[host]?.selected;
    if (host === 'claude') {
      const profiles = info.profiles.filter(profile => !options.claudeConfigDirs.length
        || options.claudeConfigDirs.some(dir => (profile.configDirs ?? [profile.configDir]).includes(dir)));
      for (const profile of profiles) {
        const configDir = options.claudeConfigDirs.find(dir => (profile.configDirs ?? [profile.configDir]).includes(dir)) ?? profile.configDir;
        const blocked = !executable ? 'Claude executable unavailable; install/select the intended host binary first.'
          : !profile.repair.targetable ? profile.repair.reason
            : !profile.installed && profiles.length > 1 && !options.claudeConfigDirs.length
              ? 'Select --claude-config explicitly to install into an additional missing profile.' : null;
        const action = { host, id: `claude:${profile.storeKey}`, configDir, storeKey: profile.storeKey,
          profileDirs: profile.configDirs ?? [profile.configDir], executable: executable?.path, kind: profile.installed ? 'update' : 'install',
          status: blocked ? 'blocked' : 'planned', reason: blocked,
          description: `${profile.installed ? 'Refresh installed' : 'Install missing'} Claude integration in ${configDir}; shared store updated once` };
        if (profile.state === 'current') {
          action.kind = 'none'; action.status = 'current';
          action.reason = null;
          action.description = `Claude files already match the registered catalog in ${configDir}; saved enablement and live loading are separate`;
          if (!executable) action.remedy = 'The Claude executable is unavailable; install/select the host separately to check activation.';
        }
        if (blocked && action.kind !== 'none') {
          const native = [...new Map((report.executables.claude.candidates ?? []).filter(candidate => candidate.kind.startsWith('native'))
            .map(candidate => [candidate.resolvedPath ?? candidate.path, candidate])).values()];
          const safeSource = profile.state !== 'foreign' && profile.registryState !== 'unreadable' && profile.knownMarketplacesState !== 'unreadable'
            && !profile.settings?.some(settings => settings.configDir === configDir && settings.state === 'unreadable');
          action.nextCommands = safeSource ? native.map(candidate => ['runlist', 'doctor', '--hosts', '--repair', 'claude', '--claude-config', configDir, '--claude-bin', candidate.path]) : [];
          action.remedy = action.nextCommands.length ? 'Preview with the intended native binary and profile below; these commands do not apply changes.'
            : 'Inspect the registry/marketplace/settings and intended profile with the host plugin manager; restore readable, managed records before retrying. No automatic replacement is offered.';
        } else if (action.kind !== 'none') action.command = commandFor(action, options);
        actions.push(action);
      }
      if (!profiles.length) actions.push({ host, id: 'claude:unresolved', status: 'blocked', reason: 'No selected Claude profile could be resolved.' });
    } else {
      const blocked = !executable ? `${host} executable unavailable; install the host separately first.`
        : !info.repair.targetable ? info.repair.reason : null;
      const action = { host, id: host, kind: info.state === 'missing' ? 'install' : 'update',
        status: blocked ? 'blocked' : 'planned', reason: blocked,
        description: `${info.state === 'missing' ? 'Install missing' : 'Refresh managed'} ${host} integration; preserve unmarked files` };
      if (host === 'opencode' && info.state === 'current') {
        action.kind = 'none'; action.status = 'current'; action.reason = null;
        action.description = 'OpenCode generated file already matches this CLI candidate; no file repair is needed. Live loading remains unknown.';
      }
      if (host === 'codex' && info.state === 'current') action.description = 'Verify the installed Codex copy; the marketplace source already matches this CLI candidate';
      if (action.status === 'blocked') action.remedy = 'Keep the unmarked/unreadable content. Inspect it and use the host plugin manager or move your own file aside before explicitly installing a managed integration; nothing is overwritten automatically.';
      else if (action.kind !== 'none') action.command = commandFor(action, options);
      actions.push(action);
    }
  }
  return actions;
}

function runRepair(action, { options, config, env }) {
  // Reuse the existing verbs in a fresh process without importing project JS.
  // User values travel on stdin as data, never interpolated into shell code.
  const script = `import { readFileSync } from 'node:fs';
    import { runInstall } from ${JSON.stringify(new URL('./install.mjs', import.meta.url).href)};
    import { runUpdate } from ${JSON.stringify(new URL('./update.mjs', import.meta.url).href)};
    const request = JSON.parse(readFileSync(0, 'utf8'));
    if (request.kind === 'install') await runInstall([request.host], request.config, { claudeBin: request.claudeBin });
    else await runUpdate(request.argv, request.config);`;
  const argv = ['--host', action.host];
  if (action.configDir) argv.push('--claude-config', action.configDir);
  if (options.claudeBin) argv.push('--claude-bin', options.claudeBin);
  return spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: config.repoRoot, input: JSON.stringify({ kind: action.kind, host: action.host, argv,
      config: { repoRoot: config.repoRoot }, claudeBin: action.host === 'claude' ? options.claudeBin ?? action.executable : undefined }),
    encoding: 'utf8', timeout: 180_000, maxBuffer: 4 * 1024 * 1024,
    env: { ...env, ...(action.configDir ? { CLAUDE_CONFIG_DIR: action.configDir } : {}), RUNLIST_JOURNAL: '0', DOTMD_JOURNAL: '0' },
  });
}

function targetState(report, action) {
  if (action.host !== 'claude') return report.hosts[action.host].state;
  return report.hosts.claude.profiles.find(profile => (profile.configDirs ?? [profile.configDir]).includes(action.configDir))?.state ?? 'unknown';
}

function render(report, out, json) {
  if (json) { out.write(`${JSON.stringify(report, null, 2)}\n`); return; }
  const { cli, node, updateEffect } = report.runtime;
  out.write(`CLI launcher: ${cli.launcher?.path ?? 'unknown'} → ${cli.launcher?.resolvedPath ?? 'unknown'}\n`);
  out.write(`Node: ${node.version} · ${node.path} · prefix ${node.prefix}\nnpm on PATH: ${node.npm ?? 'not found'}\n`);
  out.write(`Update scope: ${updateEffect}\n\n`);
  const format = inventory.formatAgentHostReport;
  if (format) out.write(format(report));
  else {
    out.write(`runlist host health — CLI ${report.candidate.version ?? 'unknown'} (${report.candidate.kind})\n`);
    for (const host of HOSTS) out.write(`${host}: ${report.hosts[host].state}; live loading unknown\n`);
  }
  if (!report.repairs.selectedHosts.length) {
    out.write('\nRepairs are explicit: runlist doctor --hosts --repair <host> previews; add --apply to execute.\n');
    return;
  }
  out.write(`\nRepairs: ${report.repairs.mode}\n`);
  for (const action of report.repairs.actions) {
    out.write(`  ${action.status}: ${action.description ?? action.id}${action.reason ? ` — ${action.reason}` : ''}\n`);
    if (action.command) out.write(`    ${action.command.map(shellQuote).join(' ')}\n`);
    if (action.remedy) out.write(`    ${action.remedy}\n`);
    for (const command of action.nextCommands ?? []) out.write(`    ${command.map(shellQuote).join(' ')}\n`);
  }
  for (const item of report.repairs.outstanding) out.write(`  Outstanding: ${item}\n`);
  if (report.repairs.failed.length) out.write(`Failed repairs: ${report.repairs.failed.length}; completed: ${report.repairs.completed.length}. Other selected hosts were still attempted.\n`);
}

export async function runDoctorHosts(argv, config = { repoRoot: process.cwd() }, opts = {}) {
  const options = hostDoctorOptions(argv, opts), env = opts.env ?? process.env;
  const reportOptions = { home: opts.home ?? os.homedir(), env, ...(opts.root ? { root: opts.root } : {}),
    claudeConfigDirs: options.claudeConfigDirs, claudeBin: options.claudeBin };
  const read = opts.inventory ?? inventory.agentHostReport;
  const before = read(config, reportOptions);
  const installation = installationReport(config, reportOptions);
  const runtime = { cli: installation.cli, node: installation.node, project: installation.project, updateEffect: installation.updateEffect };
  const actions = planHostRepairs(before, options);
  const repairs = { mode: options.apply && !options.dryRun ? 'apply' : options.repairs.length ? 'preview' : 'none',
    selectedHosts: options.repairs, actions, completed: [], failed: [], outstanding: [] };
  let report = { ...before, runtime, repairs };
  let attempted = false;
  if (repairs.mode === 'apply') {
    for (const action of actions) {
      if (action.status === 'blocked') { repairs.failed.push({ id: action.id, reason: action.reason }); continue; }
      if (action.kind === 'none') { repairs.completed.push({ id: action.id, host: action.host, sourceState: 'current', action: 'no change needed', installedOrLoaded: 'not attested by filesystem inventory' }); continue; }
      try {
        attempted = true;
        const result = await (opts.run ?? runRepair)(action, { options, config, env });
        action.output = sanitizeTelemetryText(`${result.stdout ?? ''}${result.stderr ?? ''}${result.error?.message ?? ''}`);
        if (result.status !== 0) throw new Error(`Repair command exited ${result.status ?? 'unknown'}${result.error ? `: ${result.error.message}` : ''}`);
        const after = read(config, reportOptions), state = targetState(after, action);
        action.sourceState = state;
        if (['missing', 'stale', 'foreign'].includes(state)) throw new Error(`Repair command exited successfully but source state remains ${state}.`);
        action.status = 'completed';
        repairs.completed.push({ id: action.id, host: action.host, sourceState: state, installedOrLoaded: 'not attested by filesystem inventory' });
        if (state === 'unknown') repairs.outstanding.push(`${action.host}: command completed but source parity remains unknown; inspect the host's installed copy.`);
      } catch (error) { action.status = 'failed'; action.reason = error.message; repairs.failed.push({ id: action.id, reason: error.message }); }
    }
    report = { ...read(config, reportOptions), readOnly: !attempted, runtime, repairs };
    if (repairs.failed.length) process.exitCode = 1;
    for (const host of options.repairs) repairs.outstanding.push(...(report.hosts[host].requirements ?? [`Restart/reload ${host}; live activation remains unknown.`]));
  }
  render(report, opts.out ?? process.stdout, options.json);
  return report;
}
